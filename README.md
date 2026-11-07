# Stride — a shop and a testing ground for closed-loop A/B experiments

Stride sells **footwear, headwear and accessories**. It is a small, complete storefront — browse,
filter, add to cart, check out — with one unusual property: it is built to be the *subject* of
experiments rather than to run them.

The application does **not** decide which variant a visitor sees, does not pick a winner, and does
not compute lift. It provides the plumbing an external experimentation program needs to run a
closed loop against real shopping behaviour:

```
                 ┌──────────────────────────────────────────────┐
   visitor ─────▶│  React front-end (served at /)               │
                 │  1. asks which variant it is                 │
                 │  2. renders, reports "exposure"              │
                 │  3. reports clicks / carts / purchases       │
                 └───────────────┬──────────────────────────────┘
                                 │  /api/ab/*
                 ┌───────────────▼──────────────────────────────┐
                 │  Rust backend — testing grounds              │
                 │  assignment hook · event log · raw counts    │
                 │  (no experiment logic of its own)            │
                 └───────────────┬──────────────────────────────┘
                                 │  assign / events.jsonl / stats
                 ┌───────────────▼──────────────────────────────┐
                 │  your experiment platform (external)         │
                 │  decides assignment, analyses, decides next  │
                 └──────────────────────────────────────────────┘
```

---

## Contents

- [Quick start](#quick-start)
- [What the site does](#what-the-site-does)
- [Architecture](#architecture)
- [The testing grounds](#the-testing-grounds)
- [HTTP API reference](#http-api-reference)
- [Configuration](#configuration)
- [Development](#development)
- [Testing](#testing)
- [CI/CD](#cicd)
- [Deployment](#deployment)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requirements: **Rust** (via [rustup](https://rustup.rs)) and **Node 22+**.

```bash
npm install
npm run build        # builds the React front-end into ./frontend
npm run serve        # compiles and starts the Rust backend on http://127.0.0.1:8080
```

Open <http://127.0.0.1:8080/>. The shop is served at the root — there is no variant index and no
`/v2/` prefix.

Or run the container:

```bash
docker build -f docker/Dockerfile -t stride .
docker run --rm -p 8080:8080 stride
```

---

## What the site does

The storefront is a single React app with three views, all client-side:

| View | What happens |
| --- | --- |
| **Landing** | A three-step wizard: pick a category → pick a size → see matching products. A "skip" link bypasses it. Below that, a "Why Stride" section. |
| **Product** | A product page with description, materials, care, delivery info, size and colour pickers, price and an *Add to cart* button. |
| **Bag** | Cart lines with quantity controls, a subtotal, shipping (free over $75), an email field and *Place order*. |

The cart is reachable from a small **Bag (n)** link in the footer. That placement is deliberate:
the front-end is tuned to be *just below middle* — functional and shippable, but with the kind of
friction an experiment program exists to measure. It is a realistic subject, not a polished
showcase.

### Catalogue

Twelve products across three categories, defined in `backend/src/catalog.rs`:

- **Footwear** — Trailhead Mid GTX, Drift Runner 2, Pier Canvas Low, Harbour Chelsea
- **Headwear** — Summit 6-Panel Cap, Ridgeline Beanie, Field Bucket Hat
- **Accessories** — Carabiner Keyring, Trail Sock 3-Pack, Everyday Tote, Insulated Bottle 750, Cord Lace Set

Each product has a name, slug, category, price (and optional compare-at price), short and long
descriptions, materials, sizes, colours, rating, review count, stock status and a two-colour
gradient used as its image placeholder.

### Checkout

Checkout is simulated. `POST /api/checkout` validates the cart, builds an order, empties the cart
and returns an order reference (`ST-######`). **No payment is taken and nothing ships.** The
front-end reports a `purchase` event at that moment — that is the conversion the testing grounds
record.

### State

Carts and orders live in memory and are lost on restart. The only persisted state is the A/B event
log (`data/events.jsonl`). This is intentional: the shop is a test fixture, not a production
commerce system.

---

## Architecture

### Backend — Rust

`axum` on Tokio, single binary, no database.

| Module | Responsibility |
| --- | --- |
| `src/main.rs` | Router, static file serving, graceful shutdown, bind address |
| `src/api.rs` | Products, cart, checkout, orders |
| `src/catalog.rs` | The product catalogue (static data) |
| `src/state.rs` | Shared app state: catalogue, carts, orders, testing grounds |
| `src/ab.rs` | **Testing grounds only** — assignment hook, event log, raw counts |

The server does two jobs:

1. **API** under `/api/*` (JSON).
2. **Static hosting** of the built front-end at `/`, with correct content types.

It deliberately has no SPA fallback: the app has no client-side routes, so unknown paths return a
real `404` rather than quietly serving `index.html`. That is what makes `/v2/` return 404.

### Front-end — React

React 19 + Vite 8, TypeScript, no UI framework and no CSS framework — plain CSS with a small
design-token set.

```
frontends/v2/          the app (views, styles)
shared/src/api.ts      typed API client + money/session helpers
shared/src/cart.tsx    cart context (add / update / remove)
shared/src/ab.tsx      the testing-grounds client (assign, exposure, events)
```

`shared/` is consumed as TypeScript source via a Vite alias, so the app and the harness stay in one
place and typecheck together.

### Data flow for a single visit

1. App mounts → `GET /api/ab/assign?visitor=…&unit=home`.
2. Backend asks the configured provider (or hashes the visitor id) → `{ "variant": "v2" }`.
3. App renders and fires an `exposure` event with the variant, visitor and session ids.
4. Every meaningful interaction fires an event: `click` (with an element name), `add_to_cart`,
   `remove_from_cart`, `purchase`, `newsletter_signup`.
5. Your platform reads `data/events.jsonl` or `GET /api/ab/stats` and closes the loop.

If the testing grounds are unavailable, the shop still works — events are simply dropped.

---

## The testing grounds

This is the part that exists for the experiment program. It contains **no experiment logic**: no
split decisions beyond a fallback, no significance testing, no winner selection.

### Assignment hook

`GET /api/ab/assign?visitor=<id>&unit=<unit>`

- `visitor` — a stable id the front-end keeps in `localStorage`.
- `unit` — the unit under test (default `home`). Different units are independent experiments.

The backend delegates to a **provider**:

| `AB_PROVIDER` | Behaviour |
| --- | --- |
| `fallback` (default) | FNV-1a hash of `visitor:unit` over `AB_VARIANTS`. Deterministic, sticky, no external dependency. |
| `http` | `GET {AB_HTTP_URL}?visitor=…&unit=…&site=stride-shop`, expects `{"variant": "..."}`. On timeout or error it falls back to the hash provider so the shop never breaks. |

Assignments are cached in memory per `(visitor, unit)`. The response includes `source`, which is
one of `provider`, `cache`, `fallback`, or `fallback_after_error` — useful for spotting a broken
provider in production.

### Exposure and events

`POST /api/ab/events`

```json
{
  "visitor": "6f1c…",
  "session": "9a02…",
  "variant": "v2",
  "unit": "home",
  "name": "purchase",
  "props": { "order_id": "ST-123456", "value_cents": 18900, "items": 1 }
}
```

Events are appended to `data/events.jsonl` (one JSON object per line, with a `ts` field) and kept
in memory. Exposure events also maintain a per-`(unit, variant)` counter that is rebuilt from the
log on restart.

Standard event names the front-end emits:

| Event | When | Useful props |
| --- | --- | --- |
| `exposure` | app mounted with an assignment | `path`, `source` |
| `click` | a tracked UI element | `element`, plus context |
| `add_to_cart` | item added | `product_id`, `qty`, `size`, `color` |
| `remove_from_cart` | item removed | `product_id` |
| `purchase` | checkout completed | `order_id`, `value_cents`, `items` |

Anything else is accepted — the log does not validate event names, so new events can be added
without touching the backend.

### Raw counts

`GET /api/ab/stats` returns per-variant event counts, unique visitors and exposures by unit. It is
a convenience for eyeballing data, **not** an analysis engine.

### Reset

`POST /api/ab/reset` clears the in-memory log, exposure index and assignment cache, and truncates
`events.jsonl`. Useful between test runs. It does not touch the provider.

### Reference provider

`examples/ab-provider/server.mjs` is a deliberately dumb external provider so you can see the loop
work end to end. It is **not** part of the app.

```bash
node examples/ab-provider/server.mjs                       # :9100
AB_PROVIDER=http AB_HTTP_URL=http://127.0.0.1:9100/assign npm run serve
```

| Endpoint | Purpose |
| --- | --- |
| `GET /assign?visitor=&unit=` | sticky assignment by weight |
| `POST /rollout {"weights": {"v2": 1}}` | change the split (weights must sum to 1) |
| `GET /report` | pulls `/api/ab/stats` and computes a plain conversion rate |

### Forcing a variant while testing

The site renders one front-end, but the reported assignment can be pinned with `?force=v2` on any
URL. The override is tagged `source: "override"` on the exposure event so QA traffic can be
filtered out.

---

## HTTP API reference

All endpoints are JSON. Errors are `{"error": "..."}` with a 4xx status.

### Shop

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `ok` (plain text) |
| `GET` | `/api/products` | `?category=footwear&q=boot` | `{ products: [...] }` |
| `GET` | `/api/products/{id-or-slug}` | — | `{ product: {...} }` |
| `GET` | `/api/cart` | `?sid=` | cart |
| `POST` | `/api/cart` | `{ sid, product_id, qty }` | cart |
| `PATCH` | `/api/cart/{product_id}` | `{ sid, qty }` (`qty: 0` removes) | cart |
| `DELETE` | `/api/cart/{product_id}` | `?sid=` | cart |
| `POST` | `/api/checkout` | `{ sid, email }` | `{ order: {...} }` |
| `GET` | `/api/orders/{id}` | — | `{ order: {...} }` |

A cart looks like:

```json
{
  "lines": [
    {
      "product_id": "2",
      "name": "Drift Runner 2",
      "slug": "drift-runner-2",
      "price_cents": 12900,
      "qty": 2,
      "line_total_cents": 25800,
      "swatch": ["#cfd6e0", "#8a9bb0"]
    }
  ],
  "count": 2,
  "subtotal_cents": 25800,
  "shipping_cents": 0
}
```

Shipping is free over $75 (7500 cents), otherwise $4.90.

### Testing grounds

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/ab/assign` | `?visitor=&unit=` | `{ variant, source, unit }` |
| `POST` | `/api/ab/events` | event object | `{ ok: true }` |
| `GET` | `/api/ab/stats` | — | counts per variant |
| `POST` | `/api/ab/reset` | — | `{ ok: true }` |

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `BIND_ADDR` | `127.0.0.1` | Interface to bind (`0.0.0.0` in the container) |
| `FRONTEND_DIR` | `frontend` | Where the built front-end lives |
| `DATA_DIR` | `data` | Where `events.jsonl` is written |
| `AB_PROVIDER` | `fallback` | `fallback` or `http` |
| `AB_VARIANTS` | `v2` | Variant names for the fallback provider |
| `AB_HTTP_URL` | — | Assignment endpoint for `AB_PROVIDER=http` (plain HTTP only) |
| `AB_HTTP_TIMEOUT_MS` | `400` | Provider timeout before falling back |
| `RUST_LOG` | `stride_backend=info` | Log filter |

`npm run serve` goes through `scripts/serve.mjs`, which finds `cargo` even when npm's `/bin/sh` has
not sourced `~/.cargo/env`, and points `FRONTEND_DIR` / `DATA_DIR` at the repo root.

---

## Development

```bash
npm run dev                 # build then serve
npm run dev -w @stride/v2   # Vite dev server on :5175, /api proxied to :8080
```

The Vite dev server proxies `/api` to `http://127.0.0.1:8080`, so run the backend alongside it:

```bash
npm run serve               # in one terminal
npm run dev -w @stride/v2   # in another
```

### Scripts

| Command | Does |
| --- | --- |
| `npm run build` | Production build of the front-end into `frontend/` |
| `npm run typecheck` | `tsc --noEmit` over the app and shared code |
| `npm run serve` | Build and run the backend (debug) |
| `npm run serve:release` | Build and run the backend (release) |
| `npm test` | Start the server, run the smoke test, stop it |

---

## Testing

### Unit tests

```bash
cargo test --manifest-path backend/Cargo.toml
```

Covers the assignment hash (stability, distribution, empty variant list), chunked HTTP decoding for
the provider client, and URL encoding.

### Smoke test

```bash
npm test                    # starts and stops the server itself
scripts/smoke.sh            # against an already-running server
```

Checks health, static serving at `/`, asset loading, that `/v2/` is gone, assignment stickiness,
event logging, the product API, and the full cart → checkout flow including the empty-cart
rejection.

### CI

Every push and pull request runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
the TypeScript typecheck, the production build, and the smoke test against a real server.

---

## CI/CD

Two workflows in `.github/workflows/`.

### `ci.yml` — on every push to `main` and every pull request

| Job | What it proves |
| --- | --- |
| **Backend (Rust)** | Code is formatted, clippy-clean with warnings as errors, tests pass, release build succeeds |
| **Front-end (React)** | TypeScript typechecks and the production build succeeds; build output is uploaded as an artifact |
| **Smoke test** | Both halves build, the real server starts, and the real API and pages respond correctly |

`smoke` depends on the other two, so a green run means the whole stack works together.

### `release.yml` — on push to `main`, tags, or manual dispatch

1. Builds the multi-stage image (`docker/Dockerfile`).
2. Pushes it to **GitHub Container Registry** at `ghcr.io/<owner>/<repo>` with tags for the branch,
   the semver version (on tags), the short SHA, and `latest` on the default branch.
3. On a `v*` tag, cuts a GitHub release with generated notes and the image reference.

To release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Then:

```bash
docker run --rm -p 8080:8080 ghcr.io/k-nicolas-10/site-thon-test:0.1.0
```

### Caching

CI uses `Swatinem/rust-cache` for Cargo and the npm cache keyed on the lockfile. The image build
uses GitHub Actions cache (`type=gha`) so unchanged layers are reused between runs.

---

## Deployment

### Container

The image is a three-stage build: Node builds the front-end, Rust builds the release binary, and a
slim Debian runtime carries only the binary and the built assets. It runs as a non-root user
(`stride`, uid 10001), exposes `8080`, and has a `HEALTHCHECK` against `/api/health`.

```bash
docker build -f docker/Dockerfile -t stride .
docker run --rm -p 8080:8080 stride
```

Mount `data/` if you want the event log to survive container replacement:

```bash
docker run --rm -p 8080:8080 -v "$PWD/data:/app/data" stride
```

### Behind a reverse proxy

The server speaks plain HTTP and binds `127.0.0.1` by default. In a container it binds `0.0.0.0`
via `BIND_ADDR`. Terminate TLS at your proxy and forward to port 8080.

### Notes

- Carts and orders are in memory — run a single instance, or accept that carts are per-instance.
- The event log is append-only JSONL. For real volume, ship it to your experiment platform or
  replace the sink in `src/ab.rs`.
- There is no authentication and no payment integration. Do not expose it as a real store.

---

## Project layout

```
backend/                 Rust backend (axum)
  src/main.rs            router, static serving, shutdown
  src/api.rs             products, cart, checkout, orders
  src/catalog.rs         the catalogue
  src/state.rs           shared state
  src/ab.rs              testing grounds (no experiment logic)
frontends/v2/            the React app, built to frontend/ and served at /
  src/App.tsx            views: landing wizard, product, bag
  src/styles.css         design tokens and layout
shared/src/              API client, cart context, A/B harness
scripts/serve.mjs        finds cargo, sets paths, starts the backend
scripts/smoke.sh         end-to-end API checks
examples/ab-provider/    reference external decision service (not part of the app)
docker/Dockerfile        multi-stage image
.github/workflows/       ci.yml, release.yml
```

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `error: cargo was not found` | Rust not installed, or not on `PATH` | `curl https://sh.rustup.rs -sSf \| sh`, then a new shell |
| `error: 127.0.0.1:8080 is already in use` | another server is running | `pkill -f stride-backend`, or `PORT=8081 npm run serve` |
| `Not found. The shop lives at /` | front-end not built | `npm run build` |
| `/v2/` returns 404 | expected — the shop is at `/` | use `/` |
| Blank page, no console errors | assets 404 after a rebuild | hard-reload; asset filenames are content-hashed |
| `source: "fallback_after_error"` on assignment | provider unreachable or slow | check `AB_HTTP_URL`, raise `AB_HTTP_TIMEOUT_MS` |
