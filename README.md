# Stride — the storefront of a self-evolving frontend

Stride sells **footwear, headwear and accessories**. It is a small, complete storefront — browse,
filter, add to cart, check out — with one unusual property: it is built to be the *subject* of
experiments rather than to run them.

The application does **not** decide which variant a visitor sees, does not pick a winner, and does
not compute lift. It is the storefront in the closed loop described by the console's
[ADR 0001](https://github.com/bmardale/hackathon/blob/main/docs/decisions/0001-self-evolving-frontend-architecture.md):

```
                 ┌──────────────────────────────────────────────┐
   visitor ─────▶│  edge proxy (console repo)                   │
                 │  mints the session, picks the arm, injects   │
                 │  window.__VARIANT__ into the HTML            │
                 └───────────────┬──────────────────────────────┘
                                 │  proxied request
                 ┌───────────────▼──────────────────────────────┐
                 │  this repo: Rust backend + React front-end   │
                 │  1. renders the cohort the config selects    │
                 │  2. tags what it renders with data-component │
                 │  3. reports one session_end on pagehide      │
                 └───────────────┬──────────────────────────────┘
                                 │  POST /api/ingest/{token}
                 ┌───────────────▼──────────────────────────────┐
                 │  console (Laravel, external)                 │
                 │  attributes, briefs an agent, runs QA, learns│
                 └──────────────────────────────────────────────┘
```

---

## Contents

- [Quick start](#quick-start)
- [What the site does](#what-the-site-does)
- [Architecture](#architecture)
- [The console contract](#the-console-contract)
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
| **Landing** | A hero, then a three-step wizard: pick a category → pick a size → see matching products. A "skip" link bypasses it. Below that, a one-click *Checkout* for the bag or today's pick, and a "Why Stride" section. |
| **Product** | A product page with description, materials, care, delivery info, size and colour pickers, price and an *Add to cart* button. |
| **Bag** | Cart lines with quantity controls, a subtotal, shipping (free over $75), a three-step shipping selector, an email field and *Place order*. |
| **Confirmation** | The order reference, once the order is paid. |

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
and returns an order reference (`ST-######`). **No payment is taken and nothing ships.**

With `PAYMENT_URL` set, the order starts `pending`, the backend charges that provider, and the order
becomes `paid` when the provider calls `POST /api/webhooks/payment`. The front-end waits for `paid`
before it confirms the order and counts the conversion. Without it, the order is paid on the spot.

### State

Carts and orders live in memory and are lost on restart. This is intentional: the shop is a test
fixture, not a production commerce system.

---

## Architecture

### Backend — Rust

`axum` on Tokio, single binary, no database.

| Module | Responsibility |
| --- | --- |
| `src/main.rs` | Router, static file serving, graceful shutdown, bind address |
| `src/api.rs` | Products, cart, checkout, orders |
| `src/catalog.rs` | The product catalogue (static data) |
| `src/state.rs` | Shared app state: catalogue, carts, orders |

The server does two jobs:

1. **API** under `/api/*` (JSON).
2. **Static hosting** of the built front-end at `/`, with correct content types.

It deliberately has no SPA fallback: the app has no client-side routes, so unknown paths return a
real `404` rather than quietly serving `index.html`. That is what makes `/v2/` return 404.

### Front-end — React

React 19 + Vite 8, TypeScript, no UI framework and no CSS framework — plain CSS with a small
design-token set.

```
frontends/v2/            the Vite entry point
src/components/          views, slot components, the registry and the CSS
src/variants/            variant configs
shared/src/api.ts        typed API client + money/session helpers
shared/src/cart.tsx      cart context (add / update / remove)
shared/src/variant.ts    reads window.__VARIANT__, selects the cohort
shared/src/beacon.ts     component manifest + session_end beacon
```

`shared/` is consumed as TypeScript source via a Vite alias, so the app and its plumbing stay in one
place and typecheck together.

### Data flow for a single visit

1. The edge proxy mints the session, picks an arm and injects `window.__VARIANT__` into the HTML.
2. The app selects the first cohort of the config that matches the visitor's OS and viewport, and
   fills the `hero`, `finder` and `shipping` slots from the registry.
3. The beacon collects the manifest and the telemetry while the visitor shops.
4. On `pagehide`, it sends one `session_end` record to the console.

Without the proxy (`npm run serve`), the baseline renders and nothing is sent. If the console is
unreachable, the shop still works: the record is simply dropped.

---

## The console contract

What ADR 0001 requires of the storefront (D-14, D-20, D-24, D-28, D-34, D-35, D-37).

### Variant config

`variant-config.schema.json` at the repo root is the contract; the console fetches it on every run.
The first cohort that matches wins, and a slot it omits keeps the baseline's component:

```json
{
  "variant_id": "android-hero-v1",
  "cohorts": [
    {
      "match": { "os": "Android", "viewport_bucket": "any" },
      "slots": { "hero": "Hero_Android_Ecosystem" },
      "catalog_filter": { "category": "any", "price_tier": "mid" }
    }
  ]
}
```

A name that isn't in `src/components/registry.ts` throws during render, so QA fails it loudly.

### Where the agent may work

The console's coding agent can only change `src/components/**`, `src/variants/**` and `qa/**`, which
is why the views and the CSS live there. A new component must be registered, tagged with
`data-component` and `data-*` tags, and accept its slot's props (see `registry.ts`).

### Session record

The beacon sends the canonical record of D-14: `session_id`, `variant_id` and `decision_id` echoed
from the proxy (never generated here), `context` (X_u, with the scored `features`), `manifest` (M_v)
and `telemetry` (T_u). `context.geo.country` comes from the proxy too, because the browser can't
know it. Funnel steps are `landing`, `product`, `cart`, `shipping`, `payment` and
`confirmation`. Input `name`s start with their step (`shipping_zip`), because attribution groups
field dwell by that prefix.

Set `INGEST_URL` to `https://<console>/api/ingest/<token>` to turn it on. The browser reads it from
`GET /api/config`, so rotating the token needs no rebuild.

### Running behind the edge proxy

Point the proxy's `EDGE_UPSTREAM` at this server and send visitors to the proxy. No change is needed
here: the server's HTML has a `</head>` to inject before and isn't compressed.

### QA

`qa/compose.yaml` is the stack the console's QA runner brings up, with the edge proxy and its
Playwright gates layered on top. The gates need one button named **Checkout** on the landing page
that reaches `[data-testid=confirmation]` with a `data-order-id`, and a webhook recorded for that
order by the payment mock.

---

## HTTP API reference

All endpoints are JSON. Errors are `{"error": "..."}` with a 4xx status.

### Shop

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `ok` (plain text) |
| `GET` | `/api/config` | — | `{ ingest_url }` (`null` when unset) |
| `POST` | `/api/webhooks/payment` | `{ type, order_id }` | `{ ok: true }`; `payment.succeeded` marks the order paid |
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

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `BIND_ADDR` | `127.0.0.1` | Interface to bind (`0.0.0.0` in the container) |
| `FRONTEND_DIR` | `frontend` | Where the built front-end lives |
| `INGEST_URL` | — | The console's `/api/ingest/{token}` URL. Unset means no session records are sent |
| `PAYMENT_URL` | — | Payment provider as `http://host:port` (plain HTTP only). Unset means orders are paid on the spot |
| `PUBLIC_WEBHOOK_URL` | — | Where the provider sends its webhook. Required with `PAYMENT_URL` |
| `RUST_LOG` | `stride_backend=info` | Log filter |

`npm run serve` goes through `scripts/serve.mjs`, which finds `cargo` even when npm's `/bin/sh` has
not sourced `~/.cargo/env`, and points `FRONTEND_DIR` at the repo root.

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

Covers reading the payment provider's response.

### Smoke test

```bash
npm test                    # starts and stops the server itself
scripts/smoke.sh            # against an already-running server
```

Checks health, static serving at `/`, asset loading, that `/v2/` and `/api/ab` are gone, the product
API, the full cart → checkout flow including the empty-cart rejection, the runtime config and the
webhook's unknown-order rejection.

### Browser suite

```bash
docker compose -f qa/compose.yaml run --build --rm e2e
docker compose -f qa/compose.yaml --profile e2e down --volumes
```

Runs `qa/storefront.spec.ts` against the QA stack at 360×780 and 1440×900: both checkout paths
including the payment webhook, cohort selection, catalog filters, and the session record. It stands
in for the edge proxy by setting `window.__VARIANT__` itself.

### CI

Every push and pull request runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`,
the TypeScript typecheck, the production build, the smoke test against a real server, and the
browser suite.

---

## CI/CD

Two workflows in `.github/workflows/`.

### `ci.yml` — on every push to `main` and every pull request

| Job | What it proves |
| --- | --- |
| **Backend (Rust)** | Code is formatted, clippy-clean with warnings as errors, tests pass, release build succeeds |
| **Front-end (React)** | TypeScript typechecks and the production build succeeds; build output is uploaded as an artifact |
| **Smoke test** | Both halves build, the real server starts, and the real API and pages respond correctly |
| **QA stack** | The stack the console's QA runner uses comes up, and the browser suite passes against it |

`smoke` and `qa` depend on the other two, so a green run means the whole stack works together.

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

### Behind a reverse proxy

The server speaks plain HTTP and binds `127.0.0.1` by default. In a container it binds `0.0.0.0`
via `BIND_ADDR`. Terminate TLS at your proxy and forward to port 8080.

### Notes

- Carts and orders are in memory — run a single instance, or accept that carts are per-instance.
- There is no authentication and no real payment integration, and the payment webhook is unsigned.
  Do not expose it as a real store.

---

## Project layout

```
backend/                 Rust backend (axum)
  src/main.rs            router, static serving, shutdown
  src/api.rs             products, cart, checkout, orders
  src/catalog.rs         the catalogue
  src/state.rs           shared state
frontends/v2/            Vite entry point, built to frontend/ and served at /
src/components/          views, slot components, registry.ts, styles.css
src/variants/            variant configs, including the baseline
variant-config.schema.json  the config contract the console validates against
shared/src/              API client, cart context, variant loader, beacon
qa/                      QA stack (compose.yaml), payment mock, Playwright suite
scripts/serve.mjs        finds cargo, sets paths, starts the backend
scripts/smoke.sh         end-to-end API checks
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
