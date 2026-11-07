/**
 * Variant config loader (ADR 0001, D-20, D-24): reads what the edge proxy injected as
 * window.__VARIANT__ and selects this visitor's cohort. The proxy decides the variant; this file
 * only applies it, and never mints a session, variant or decision id (D-34).
 */
import baseline from "../../src/variants/storefront-baseline-v1.json";

export interface Cohort {
  match?: { os?: string; viewport_bucket?: string };
  slots: Record<string, string>;
  catalog_filter?: { category?: string; price_tier?: string };
}

interface VariantConfig {
  cohorts?: Cohort[];
}

interface InjectedVariant {
  session_id: string | null;
  variant_id: string | null;
  decision_id: string | null;
  config: VariantConfig;
  features: number[];
  /** ISO code from the proxy's geo headers. Absent when it has none. */
  country?: string;
}

declare global {
  interface Window {
    __VARIANT__?: InjectedVariant;
  }
}

/** Without the proxy (local dev) there is no session, and the baseline renders. */
export const variant: InjectedVariant = window.__VARIANT__ ?? {
  session_id: null,
  variant_id: null,
  decision_id: null,
  config: {},
  features: [],
};

/** The same labels the edge proxy scores on, so X_u and the features agree. */
export function detectOs(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Android")) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Macintosh")) return "macOS";
  return "other";
}

function viewportBucket(): string {
  if (innerWidth < 400) return "<400";
  return innerWidth < 768 ? "400-767" : ">=768";
}

function selectCohort(config: VariantConfig): Cohort {
  const base: Cohort = baseline.cohorts[0];
  const matches = (wanted: string | undefined, actual: string) =>
    !wanted || wanted === "any" || wanted === actual;
  const selected = config.cohorts?.find(
    (c) => matches(c.match?.os, detectOs()) && matches(c.match?.viewport_bucket, viewportBucket()),
  );
  return { ...base, ...selected, slots: { ...base.slots, ...selected?.slots } };
}

/** Selected once per page load, so a resize can't swap components mid-session. */
export const cohort = selectCohort(variant.config);

export function priceTier(cents: number): string {
  if (cents < 5000) return "low";
  return cents < 12000 ? "mid" : "premium";
}

/** Whether this cohort's catalog filter lets a product through. */
export function inCatalog(product: { category: string; price_cents: number }): boolean {
  const { category = "any", price_tier = "any" } = cohort.catalog_filter ?? {};
  return (
    (category === "any" || product.category === category) &&
    (price_tier === "any" || priceTier(product.price_cents) === price_tier)
  );
}
