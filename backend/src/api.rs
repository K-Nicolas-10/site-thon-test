use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::catalog::Product;
use crate::state::{AppState, Cart, CartLine, Order, OrderItem};

#[derive(Deserialize)]
pub struct ProductQuery {
    category: Option<String>,
    q: Option<String>,
}

pub async fn products(
    State(state): State<AppState>,
    Query(q): Query<ProductQuery>,
) -> impl IntoResponse {
    let needle = q.q.map(|s| s.to_lowercase());
    let cat = q.category.map(|s| s.to_lowercase());
    let items: Vec<&Product> = state
        .inner
        .catalog
        .iter()
        .filter(|p| match &cat {
            Some(c) => format!("{:?}", p.category).to_lowercase() == *c,
            None => true,
        })
        .filter(|p| match &needle {
            Some(n) => {
                p.name.to_lowercase().contains(n)
                    || p.short.to_lowercase().contains(n)
                    || p.description.to_lowercase().contains(n)
            }
            None => true,
        })
        .collect();
    Json(json!({ "products": items }))
}

pub async fn product(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match state
        .inner
        .catalog
        .iter()
        .find(|p| p.id == id || p.slug == id)
    {
        Some(p) => Json(json!({ "product": p })).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no such product"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct CartQuery {
    #[serde(default)]
    pub sid: String,
}

pub async fn cart(State(state): State<AppState>, Query(q): Query<CartQuery>) -> impl IntoResponse {
    let cart = state
        .inner
        .carts
        .lock()
        .unwrap()
        .get(&q.sid)
        .cloned()
        .unwrap_or_default();
    Json(cart_view(&state, &cart))
}

#[derive(Deserialize)]
pub struct AddBody {
    pub sid: String,
    pub product_id: String,
    #[serde(default = "one")]
    pub qty: u32,
}

fn one() -> u32 {
    1
}

pub async fn cart_add(State(state): State<AppState>, Json(b): Json<AddBody>) -> impl IntoResponse {
    if state.inner.catalog.iter().all(|p| p.id != b.product_id) {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no such product"})),
        )
            .into_response();
    }
    let mut carts = state.inner.carts.lock().unwrap();
    let cart = carts.entry(b.sid.clone()).or_default();
    match cart.lines.iter_mut().find(|l| l.product_id == b.product_id) {
        Some(l) => l.qty = (l.qty + b.qty.max(1)).min(99),
        None => cart.lines.push(CartLine {
            product_id: b.product_id,
            qty: b.qty.clamp(1, 99),
        }),
    }
    let cart = cart.clone();
    drop(carts);
    Json(cart_view(&state, &cart)).into_response()
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub sid: String,
    pub qty: u32,
}

pub async fn cart_update(
    State(state): State<AppState>,
    Path(product_id): Path<String>,
    Json(b): Json<UpdateBody>,
) -> impl IntoResponse {
    let mut carts = state.inner.carts.lock().unwrap();
    let cart = carts.entry(b.sid.clone()).or_default();
    if b.qty == 0 {
        cart.lines.retain(|l| l.product_id != product_id);
    } else if let Some(l) = cart.lines.iter_mut().find(|l| l.product_id == product_id) {
        l.qty = b.qty.min(99);
    }
    let cart = cart.clone();
    drop(carts);
    Json(cart_view(&state, &cart))
}

pub async fn cart_remove(
    State(state): State<AppState>,
    Path(product_id): Path<String>,
    Query(q): Query<CartQuery>,
) -> impl IntoResponse {
    let mut carts = state.inner.carts.lock().unwrap();
    let cart = carts.entry(q.sid.clone()).or_default();
    cart.lines.retain(|l| l.product_id != product_id);
    let cart = cart.clone();
    drop(carts);
    Json(cart_view(&state, &cart))
}

#[derive(Deserialize)]
pub struct CheckoutBody {
    pub sid: String,
    #[serde(default)]
    pub email: String,
}

pub async fn checkout(
    State(state): State<AppState>,
    Json(b): Json<CheckoutBody>,
) -> impl IntoResponse {
    let cart = state
        .inner
        .carts
        .lock()
        .unwrap()
        .remove(&b.sid)
        .unwrap_or_default();

    if cart.lines.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "cart is empty"})),
        )
            .into_response();
    }

    let items: Vec<OrderItem> = cart
        .lines
        .iter()
        .filter_map(|l| {
            state
                .inner
                .catalog
                .iter()
                .find(|p| p.id == l.product_id)
                .map(|p| OrderItem {
                    product_id: p.id.clone(),
                    name: p.name.clone(),
                    qty: l.qty,
                    unit_price_cents: p.price_cents,
                })
        })
        .collect();
    let total = items
        .iter()
        .map(|i| i.unit_price_cents * i.qty as u64)
        .sum();

    // Without a payment provider, checkout stays simulated and paid on the spot.
    let payment_url = std::env::var("PAYMENT_URL").ok().filter(|u| !u.is_empty());
    let order = Order {
        id: format!("ST-{:06}", rand_id()),
        items,
        total_cents: total,
        status: if payment_url.is_some() {
            "pending"
        } else {
            "paid"
        }
        .into(),
        email: b.email,
        created_at: now_secs(),
    };
    // Stored before charging: the webhook can arrive before the charge call returns.
    state.inner.orders.lock().unwrap().push(order.clone());

    if let Some(url) = payment_url {
        if let Err(e) = charge(&url, &order).await {
            tracing::warn!("charge failed for {}: {e}", order.id);
            state
                .inner
                .orders
                .lock()
                .unwrap()
                .retain(|o| o.id != order.id);
            // Nothing was charged, so the visitor keeps their bag and can retry.
            state.inner.carts.lock().unwrap().insert(b.sid, cart);
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({"error": "payment provider unavailable"})),
            )
                .into_response();
        }
    }
    Json(json!({ "order": order })).into_response()
}

/// `POST {PAYMENT_URL}/charges`. The provider later calls `PUBLIC_WEBHOOK_URL`.
///
/// shortcut: plain HTTP over a raw socket, because the only provider is the QA mock; use a real
/// client with TLS before integrating a real one.
async fn charge(payment_url: &str, order: &Order) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let webhook_url = std::env::var("PUBLIC_WEBHOOK_URL")
        .map_err(|_| "PUBLIC_WEBHOOK_URL must be set with PAYMENT_URL".to_string())?;
    let hostport = payment_url
        .strip_prefix("http://")
        .ok_or("PAYMENT_URL must be http://host:port")?
        .trim_end_matches('/');
    let body = json!({
        "order_id": order.id,
        "amount": order.total_cents,
        "currency": "USD",
        "webhook_url": webhook_url,
    })
    .to_string();
    let request = format!(
        "POST /charges HTTP/1.1\r\nHost: {hostport}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );

    let exchange = async {
        let mut stream = tokio::net::TcpStream::connect(hostport).await?;
        stream.write_all(request.as_bytes()).await?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await?;
        Ok::<_, std::io::Error>(response)
    };
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), exchange)
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let response = String::from_utf8_lossy(&response);
    if is_success(&response) {
        Ok(())
    } else {
        Err(response.lines().next().unwrap_or("no response").to_string())
    }
}

fn is_success(response: &str) -> bool {
    response
        .split_whitespace()
        .nth(1)
        .is_some_and(|code| code.starts_with('2'))
}

#[derive(Deserialize)]
pub struct PaymentEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub order_id: String,
}

/// `POST /api/webhooks/payment`: the provider confirms an order (ADR 0001, D-28).
///
/// shortcut: unsigned, so anyone can mark an order paid; verify a signature before taking real payments.
pub async fn payment_webhook(
    State(state): State<AppState>,
    Json(event): Json<PaymentEvent>,
) -> impl IntoResponse {
    let mut orders = state.inner.orders.lock().unwrap();
    let Some(order) = orders.iter_mut().find(|o| o.id == event.order_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no such order"})),
        )
            .into_response();
    };
    if event.kind == "payment.succeeded" {
        order.status = "paid".into();
    }
    Json(json!({"ok": true})).into_response()
}

/// `GET /api/config`: where the browser sends its session record. Read at runtime so rotating the
/// ingest token needs no rebuild; the token is a public write credential by design (ADR 0001, D-03).
pub async fn config() -> impl IntoResponse {
    Json(json!({ "ingest_url": std::env::var("INGEST_URL").ok().filter(|u| !u.is_empty()) }))
}

pub async fn order(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    match state
        .inner
        .orders
        .lock()
        .unwrap()
        .iter()
        .find(|o| o.id == id)
    {
        Some(o) => Json(json!({ "order": o })).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no such order"})),
        )
            .into_response(),
    }
}

fn now_secs() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        .to_string()
}

fn rand_id() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos % 1_000_000
}

fn cart_view(state: &AppState, cart: &Cart) -> serde_json::Value {
    let lines: Vec<serde_json::Value> = cart
        .lines
        .iter()
        .filter_map(|l| {
            state
                .inner
                .catalog
                .iter()
                .find(|p| p.id == l.product_id)
                .map(|p| {
                    json!({
                        "product_id": p.id,
                        "name": p.name,
                        "slug": p.slug,
                        "price_cents": p.price_cents,
                        "qty": l.qty,
                        "line_total_cents": p.price_cents * l.qty as u64,
                        "swatch": p.swatch,
                    })
                })
        })
        .collect();
    let subtotal: u64 = cart
        .lines
        .iter()
        .filter_map(|l| {
            state
                .inner
                .catalog
                .iter()
                .find(|p| p.id == l.product_id)
                .map(|p| p.price_cents * l.qty as u64)
        })
        .sum();
    json!({
        "lines": lines,
        "count": cart.lines.iter().map(|l| l.qty).sum::<u32>(),
        "subtotal_cents": subtotal,
        "shipping_cents": if subtotal == 0 || subtotal >= 7500 { 0 } else { 490 },
    })
}

#[cfg(test)]
mod tests {
    use super::is_success;

    #[test]
    fn is_success_reads_the_status_line() {
        assert!(is_success("HTTP/1.1 201 Created\r\n\r\n{}"));
        assert!(!is_success("HTTP/1.1 500 Internal Server Error\r\n\r\n"));
        assert!(!is_success(""));
    }
}
