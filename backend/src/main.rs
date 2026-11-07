mod api;
mod catalog;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "stride_backend=info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let frontend_dir = std::env::var("FRONTEND_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("frontend"));

    let state = AppState::new(frontend_dir.clone());

    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/config", get(api::config))
        .route("/webhooks/payment", post(api::payment_webhook))
        // Shop endpoints.
        .route("/products", get(api::products))
        .route("/products/{id}", get(api::product))
        .route("/cart", get(api::cart).post(api::cart_add))
        .route(
            "/cart/{product_id}",
            axum::routing::patch(api::cart_update).delete(api::cart_remove),
        )
        .route("/checkout", post(api::checkout))
        .route("/orders/{id}", get(api::order));

    let app = Router::new()
        .nest("/api", api)
        .fallback(get(static_files))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = match std::env::var("BIND_ADDR") {
        Ok(ip) => format!("{ip}:{port}")
            .parse()
            .unwrap_or_else(|e| panic!("invalid BIND_ADDR: {e}")),
        Err(_) => SocketAddr::from(([127, 0, 0, 1], port)),
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!(
                "error: {addr} is already in use.\n\
                 Another copy of the server is probably still running. Stop it with:\n\
                 \n    pkill -f stride-backend\n\
                 \n...or start this one on another port:\n\
                 \n    PORT=8081 npm run serve"
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("error: could not bind {addr}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("stride backend listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Serves the front-end from `frontend/` at the site root.
///
/// The site is served at the root (`/`), not under a variant prefix. The edge
/// proxy in front decides the variant and injects it into this HTML.
async fn static_files(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::OriginalUri(uri): axum::extract::OriginalUri,
) -> axum::response::Response {
    use axum::response::IntoResponse;

    let path = uri.path().trim_start_matches('/');

    // Never let a request escape the frontend directory.
    if path.split('/').any(|seg| seg == "..") {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    }

    let file = if path.is_empty() {
        state.frontend_dir.join("index.html")
    } else {
        state.frontend_dir.join(path)
    };
    if file.is_file() {
        if let Ok(bytes) = tokio::fs::read(&file).await {
            return (
                [(axum::http::header::CONTENT_TYPE, content_type(&file))],
                bytes,
            )
                .into_response();
        }
    }
    (
        axum::http::StatusCode::NOT_FOUND,
        "Not found. The shop lives at / — build it with npm run build (see README).",
    )
        .into_response()
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}
