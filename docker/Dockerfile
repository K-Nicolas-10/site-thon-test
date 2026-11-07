# ---------------------------------------------------------------------------
# One image, two build stages, one small runtime.
#
#   stage 1 (web)     Node builds the React front-end into /app/frontend
#   stage 2 (rust)    Cargo builds the release binary
#   stage 3 (runtime) Debian slim + the binary + the built front-end
#
# The runtime serves the shop at `/` and the API at `/api/*`.
# ---------------------------------------------------------------------------

# --- stage 1: front-end ----------------------------------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /app

# Install from the lockfile first so dependency layers cache well.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontends/v2/package.json frontends/v2/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY frontends/ frontends/
RUN npm run build

# --- stage 2: backend ------------------------------------------------------
FROM rust:1-bookworm AS rust
WORKDIR /src

# Cache the dependency graph separately from the source.
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src

COPY backend/src ./src
# Touch so cargo does not reuse the dummy binary.
RUN touch src/main.rs && cargo build --release --locked

# --- stage 3: runtime ------------------------------------------------------
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home stride

WORKDIR /app
COPY --from=rust /src/target/release/stride-backend /usr/local/bin/stride-backend
COPY --from=web /app/frontend /app/frontend

RUN mkdir -p /app/data && chown -R stride:stride /app
USER stride

ENV PORT=8080 \
    FRONTEND_DIR=/app/frontend \
    DATA_DIR=/app/data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# Bind to all interfaces inside the container (the binary defaults to
# 127.0.0.1, which is right for local use but unreachable from outside).
ENV BIND_ADDR=0.0.0.0
ENTRYPOINT ["stride-backend"]
