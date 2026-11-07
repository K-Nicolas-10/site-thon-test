/**
 * The session beacon and component manifest emitter (ADR 0001, D-14, D-20).
 *
 * Builds one canonical `session_end` record per page load, joining X_u (context), M_v (every
 * [data-component] rendered, with its data-* tags) and T_u (interaction telemetry), and sends it
 * with sendBeacon on pagehide. Nothing is sent without an edge-minted session (D-34) or a configured
 * ingest URL, so local dev and QA traffic never reach the bandit.
 *
 * shortcut: a full reload ends the session early, and the console learns from a session's first
 * record only. The shop is a single page, so reloads are rare; persist this state per session if not.
 */
import { detectOs, variant } from "./variant";

const RAGE_WINDOW_MS = 1000;
const RAGE_CLICKS = 3;
// sendBeacon rejects bodies over 64 KB.
const MAX_EVENTS = 200;
// Data attributes that are not M_v tags. An order id must not become a component tag.
const NOT_TAGS = new Set(["component", "slot", "testid", "orderId"]);

const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);

const funnel: string[] = [];
const events: { t: number; kind: string; target: string; count?: number }[] = [];
const manifest = new Map<string, Record<string, string>>();
const recentClicks = new Map<string, number[]>();
const rageClicks = new Map<string, number>();
const fieldDwell: Record<string, number> = {};

let exitStep: string | null = null;
let lastComponent: string | null = null;
let focused: { name: string; at: number } | null = null;
let scrollDepth = 0;
let orderValue: number | null = null;
let ingestUrl: string | null = null;
let sent = false;

/** Record an event on the session's timeline. */
export function track(kind: string, target: string): void {
  if (events.length < MAX_EVENTS) events.push({ t: elapsed(), kind, target });
}

/** Record that the visitor is now on a funnel step: landing, product, cart, shipping, payment or confirmation. */
export function step(name: string): void {
  if (exitStep === name) return;
  exitStep = name;
  lastComponent = null; // what they touched on the previous step is off screen now
  if (!funnel.includes(name)) funnel.push(name);
  track("step", name);
}

/** The binary reward (D-36); the order value is display-only. */
export function markConverted(value: number): void {
  orderValue = value;
}

function scanManifest(): void {
  document.querySelectorAll<HTMLElement>("[data-component]").forEach((el) => {
    const { component, slot } = el.dataset;
    if (!component) return;
    const tags = Object.entries(el.dataset)
      .filter(([key]) => !NOT_TAGS.has(key))
      .map(([key, value]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), value ?? ""]);
    manifest.set(component, { id: slot ?? component, component, ...Object.fromEntries(tags) });
  });
}

function componentOf(target: EventTarget | Element | null): string | null {
  return target instanceof Element
    ? (target.closest<HTMLElement>("[data-component]")?.dataset.component ?? null)
    : null;
}

function onClick(event: MouseEvent): void {
  const component = componentOf(event.target);
  if (!component) return;
  lastComponent = component;
  const now = performance.now();
  const recent = (recentClicks.get(component) ?? []).filter((t) => now - t < RAGE_WINDOW_MS);
  recent.push(now);
  recentClicks.set(component, recent);
  if (recent.length === RAGE_CLICKS) {
    rageClicks.set(component, (rageClicks.get(component) ?? 0) + RAGE_CLICKS);
  } else if (recent.length > RAGE_CLICKS) {
    rageClicks.set(component, (rageClicks.get(component) ?? 0) + 1);
  }
}

function onFocusIn(event: FocusEvent): void {
  endFieldDwell(); // a focused input removed from the page never fires focusout
  const name = event.target instanceof Element ? event.target.getAttribute("name") : null;
  if (name) focused = { name, at: performance.now() };
  lastComponent = componentOf(event.target) ?? lastComponent;
}

function endFieldDwell(): void {
  if (!focused) return;
  const spent = Math.round(performance.now() - focused.at);
  fieldDwell[focused.name] = (fieldDwell[focused.name] ?? 0) + spent;
  focused = null;
}

function onScroll(): void {
  const reached = (scrollY + innerHeight) / document.documentElement.scrollHeight;
  scrollDepth = Math.max(scrollDepth, Math.min(reached, 1));
}

function browser(): string {
  const ua = navigator.userAgent;
  const name = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "other";
  return ua.includes("Mobi") ? `${name} Mobile` : name;
}

const utm = new URLSearchParams(location.search);
const context = {
  os: detectOs(),
  device: navigator.userAgent.includes("Mobi") ? "mobile" : "desktop",
  browser: browser(),
  viewport: { width: innerWidth, height: innerHeight },
  geo: variant.country ? { country: variant.country } : undefined,
  utm: {
    source: utm.get("utm_source"),
    medium: utm.get("utm_medium"),
    campaign: utm.get("utm_campaign"),
  },
  referrer: document.referrer || null,
  locale: navigator.language,
  // The vector the proxy scored, so learning uses exactly that one (D-30).
  features: variant.features,
};

function sessionRecord() {
  endFieldDwell();
  onScroll(); // a visitor who never scrolled still saw the first screen
  const converted = orderValue !== null;
  // What the visitor last touched; otherwise what they were looking at when they left.
  const exitComponent =
    lastComponent ?? componentOf(document.elementFromPoint(innerWidth / 2, innerHeight / 3));
  return {
    type: "session_end",
    session_id: variant.session_id,
    variant_id: variant.variant_id,
    decision_id: variant.decision_id,
    context,
    manifest: { variant_id: variant.variant_id, components: [...manifest.values()] },
    telemetry: {
      duration_ms: elapsed(),
      scroll_depth: Math.round(scrollDepth * 100) / 100,
      funnel_reached: funnel,
      converted,
      order_value: orderValue,
      exit_step: converted ? null : exitStep,
      exit_component: converted ? null : exitComponent,
      rage_clicks: [...rageClicks].map(([component, count]) => ({ component, count })),
      field_dwell_ms: fieldDwell,
      events,
    },
  };
}

function send(): void {
  if (sent || !variant.session_id || !ingestUrl) return;
  sent = true;
  scanManifest();
  navigator.sendBeacon(ingestUrl, JSON.stringify(sessionRecord()));
}

/** Start collecting. A failure here only loses telemetry; the shop keeps working. */
export function startBeacon(): void {
  fetch("/api/config")
    .then((response) => response.json())
    .then((config: { ingest_url: string | null }) => {
      ingestUrl = config.ingest_url;
    })
    .catch(() => {});
  new MutationObserver(scanManifest).observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", onClick, true);
  document.addEventListener("focusin", onFocusIn);
  document.addEventListener("focusout", endFieldDwell);
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("pagehide", send);
}
