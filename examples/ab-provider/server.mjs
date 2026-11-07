#!/usr/bin/env node
/**
 * Example *external* experiment provider — NOT part of the app.
 *
 * The site (Rust backend + React front-ends) only provides the testing
 * grounds: an assignment hook, an exposure log and an event log. Deciding
 * which variant a visitor gets, and deciding whether a variant won, belongs
 * to a system like this one. This file is a deliberately dumb stand-in so you
 * can see the closed loop work end to end.
 *
 *   node examples/ab-provider/server.mjs          # listens on :9100
 *   AB_PROVIDER=http AB_HTTP_URL=http://127.0.0.1:9100/assign npm run serve
 *
 * Then:
 *   GET  /assign?visitor=..&unit=..   -> {"variant": "v2"}
 *   GET  /report                      -> per-variant exposures, conversions, rate
 *   POST /rollout  {"weights": {"v2": 1}}
 *
 * Assignments are sticky per (visitor, unit) and stored in memory. The report
 * pulls raw counts from the site's /api/ab/stats and computes a simple rate;
 * it does not do significance testing — plug in your own analysis.
 */
import http from "node:http";

const PORT = Number(process.env.PORT ?? 9100);
const SITE = process.env.SITE ?? "http://127.0.0.1:8080";
const CONVERSION_EVENTS = (process.env.CONVERSION_EVENTS ?? "purchase").split(",");

let weights = { v2: 1 };
const sticky = new Map();

function pick(visitor, unit) {
  const key = `${visitor}:${unit}`;
  if (sticky.has(key)) return sticky.get(key);
  // Deterministic hash so restarts keep the same split.
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const r = (h % 10000) / 10000;
  let acc = 0;
  let chosen = Object.keys(weights)[0];
  for (const [v, w] of Object.entries(weights)) {
    acc += w;
    if (r < acc) {
      chosen = v;
      break;
    }
  }
  sticky.set(key, chosen);
  return chosen;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/assign") {
    const visitor = url.searchParams.get("visitor") ?? "";
    const unit = url.searchParams.get("unit") ?? "home";
    if (!visitor) return json(res, 400, { error: "visitor required" });
    return json(res, 200, { variant: pick(visitor, unit) });
  }

  if (url.pathname === "/rollout" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const next = JSON.parse(body).weights;
      const total = Object.values(next).reduce((a, b) => a + b, 0);
      if (Math.abs(total - 1) > 0.001) return json(res, 400, { error: "weights must sum to 1" });
      weights = next;
      sticky.clear();
      return json(res, 200, { weights });
    } catch {
      return json(res, 400, { error: "invalid JSON" });
    }
  }

  if (url.pathname === "/report") {
    const stats = await fetch(`${SITE}/api/ab/stats`).then((r) => r.json());
    const variants = Object.keys(weights);
    const rows = variants.map((v) => {
      const events = stats.variants[v] ?? {};
      const exposures = events.exposure ?? 0;
      const conversions = CONVERSION_EVENTS.reduce((n, e) => n + (events[e] ?? 0), 0);
      return {
        variant: v,
        weight: weights[v],
        exposures,
        conversions,
        rate: exposures ? +(conversions / exposures).toFixed(4) : null,
      };
    });
    return json(res, 200, { site: stats.site, conversion_events: CONVERSION_EVENTS, rows });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`example A/B provider on http://127.0.0.1:${PORT} (site: ${SITE})`);
});
