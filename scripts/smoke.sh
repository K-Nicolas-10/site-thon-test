#!/usr/bin/env bash
# Smoke test for the shop API.
# Assumes the backend is running (npm run serve).
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8080}"
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "ok   $label"
  else
    echo "FAIL $label — expected '$expected', got: $actual"
    fail=1
  fi
}

check "health" "ok" "$(curl -s "$BASE/api/health")"

check "serves the site at /" "200" "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")"
check "serves assets" "200" "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/assets/$(ls frontend/assets | grep '\.js$' | head -1)")"
check "old variant prefix is gone" "404" "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/v2/")"

check "the old A/B API is gone" "404" "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/ab/stats")"

check "products" '"products"' "$(curl -s "$BASE/api/products")"
check "product by slug" 'trailhead-mid-gtx' "$(curl -s "$BASE/api/products/trailhead-mid-gtx")"

SID="smoke-$$"
check "add to cart" '"count":2' "$(curl -s -X POST "$BASE/api/cart" \
  -H 'content-type: application/json' -d "{\"sid\":\"$SID\",\"product_id\":\"2\",\"qty\":2}")"
check "update cart" '"qty":1' "$(curl -s -X PATCH "$BASE/api/cart/2" \
  -H 'content-type: application/json' -d "{\"sid\":\"$SID\",\"qty\":1}")"
check "checkout" '"order"' "$(curl -s -X POST "$BASE/api/checkout" \
  -H 'content-type: application/json' -d "{\"sid\":\"$SID\",\"email\":\"smoke@example.com\"}")"
check "empty cart rejected" "cart is empty" "$(curl -s -X POST "$BASE/api/checkout" \
  -H 'content-type: application/json' -d "{\"sid\":\"$SID\",\"email\":\"smoke@example.com\"}")"

check "config" '"ingest_url"' "$(curl -s "$BASE/api/config")"
check "webhook for an unknown order" "404" "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/webhooks/payment" \
  -H 'content-type: application/json' -d '{"type":"payment.succeeded","order_id":"nope"}')"

exit "$fail"
