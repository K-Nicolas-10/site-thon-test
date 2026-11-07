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
    let mut carts = state.inner.carts.lock().unwrap();
    let cart = carts.remove(&b.sid).unwrap_or_default();
    drop(carts);

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

    let order = Order {
        id: format!("ST-{:06}", rand_id()),
        items,
        total_cents: total,
        email: b.email,
        created_at: crate::ab::now_iso_pub(),
    };
    state.inner.orders.lock().unwrap().push(order.clone());
    Json(json!({ "order": order })).into_response()
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
