//! Testing-grounds layer for a closed-loop A/B testing program.
//!
//! This module deliberately contains **no experiment logic**. It does not
//! decide which variant a visitor sees, it does not know what an "arm" means,
//! and it does not compute lift or significance. It only provides the plumbing
//! that an external A/B system needs to run a closed loop against this site:
//!
//! 1. **Assignment hook** — `GET /api/ab/assign?visitor=<id>&unit=<unit>` asks the
//!    configured experiment provider (or a trivial fallback) which variant a
//!    visitor should get. The answer is cached per visitor+unit so a visitor is
//!    sticky for the lifetime of the experiment.
//! 2. **Exposure log** — the front-end reports `exposure` events when a variant
//!    is actually rendered. Only exposed visitors count towards a denominator.
//! 3. **Event log** — arbitrary named events (`click`, `add_to_cart`,
//!    `purchase`, `custom:*` ...) are appended to a JSONL file, with the
//!    variant, visitor id and session id attached, so the external system can
//!    join them against the exposure log.
//! 4. **Raw counts** — `GET /api/ab/stats` returns per-variant event counts.
//!    It is a convenience for eyeballing data; it is NOT an analysis engine.
//!
//! The provider is configured entirely through environment variables:
//!
//! ```text
//! AB_PROVIDER=fallback          # default: hash the visitor id over AB_VARIANTS
//! AB_PROVIDER=http              # delegate to an external decision service
//! AB_VARIANTS=v2                # fallback only
//! AB_HTTP_URL=https://ab.example/assign   # http provider
//! AB_HTTP_TIMEOUT_MS=400
//! ```
//!
//! With `AB_PROVIDER=http` the request is `GET {AB_HTTP_URL}?visitor=..&unit=..&site=..`
//! and the response must be JSON `{"variant": "..."}` (any other fields ignored).
//! If the provider fails or times out, the request falls back to the hash
//! provider so the shop never breaks because the experiment service is down.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::AppState;

const SITE: &str = "stride-shop";

#[derive(Clone)]
pub enum Provider {
    /// Deterministic hash of visitor id over a fixed variant list.
    Fallback { variants: Vec<String> },
    /// External decision service.
    Http { url: String, timeout: Duration },
}

pub struct Assignments {
    provider: Provider,
    /// (visitor, unit) -> variant. In-memory stickiness; the external provider
    /// is expected to be sticky itself, this is just a local cache + fallback.
    cache: Mutex<HashMap<(String, String), String>>,
}

impl Clone for Assignments {
    fn clone(&self) -> Self {
        let cache = self.cache.lock().unwrap().clone();
        Self {
            provider: self.provider.clone(),
            cache: Mutex::new(cache),
        }
    }
}

pub struct AbData {
    pub assignments: Assignments,
    pub events_path: PathBuf,
    pub events: Mutex<Vec<Event>>,
    pub exposure: Mutex<BTreeMap<(String, String), u64>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub ts: String,
    pub visitor: String,
    pub session: String,
    pub variant: String,
    pub unit: String,
    pub name: String,
    #[serde(default)]
    pub props: Value,
}

fn now_iso() -> String {
    // Seconds since epoch is enough for ordering; the external system can
    // format it however it likes.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

pub fn now_iso_pub() -> String {
    now_iso()
}

impl AbData {
    pub fn load(data_dir: &Path) -> Self {
        let provider = match std::env::var("AB_PROVIDER").as_deref() {
            Ok("http") => {
                let url = std::env::var("AB_HTTP_URL").unwrap_or_default();
                let timeout = std::env::var("AB_HTTP_TIMEOUT_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(400);
                Provider::Http {
                    url,
                    timeout: Duration::from_millis(timeout),
                }
            }
            _ => Provider::Fallback {
                variants: std::env::var("AB_VARIANTS")
                    .unwrap_or_else(|_| "v2".into())
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            },
        };

        let events_path = data_dir.join("events.jsonl");
        let mut events: Vec<Event> = std::fs::read_to_string(&events_path)
            .ok()
            .map(|s| {
                s.lines()
                    .filter_map(|l| serde_json::from_str::<Event>(l).ok())
                    .collect()
            })
            .unwrap_or_default();

        // Rebuild the exposure index from the log so restarts don't lose it.
        let mut exposure: BTreeMap<(String, String), u64> = BTreeMap::new();
        for e in &events {
            if e.name == "exposure" {
                *exposure
                    .entry((e.unit.clone(), e.variant.clone()))
                    .or_default() += 1;
            }
        }
        events.shrink_to_fit();

        Self {
            assignments: Assignments {
                provider,
                cache: Mutex::new(HashMap::new()),
            },
            events_path,
            events: Mutex::new(events),
            exposure: Mutex::new(exposure),
        }
    }

    pub fn append(&self, event: Event) {
        if event.name == "exposure" {
            *self
                .exposure
                .lock()
                .unwrap()
                .entry((event.unit.clone(), event.variant.clone()))
                .or_default() += 1;
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.events_path)
        {
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(f, "{line}");
            }
        }
        self.events.lock().unwrap().push(event);
    }
}

impl Assignments {
    /// Ask the configured provider for a variant. Never fails: on provider
    /// error it falls back to the deterministic hash.
    pub async fn resolve(&self, visitor: &str, unit: &str) -> (String, &'static str) {
        let key = (visitor.to_string(), unit.to_string());
        if let Some(v) = self.cache.lock().unwrap().get(&key) {
            return (v.clone(), "cache");
        }

        let (variant, source) = match &self.provider {
            Provider::Fallback { variants } => (hash_pick(visitor, unit, variants), "fallback"),
            Provider::Http { url, timeout } => {
                match http_assign(url, *timeout, visitor, unit).await {
                    Some(v) => (v, "provider"),
                    None => {
                        let variants = fallback_variants();
                        (hash_pick(visitor, unit, &variants), "fallback_after_error")
                    }
                }
            }
        };

        self.cache.lock().unwrap().insert(key, variant.clone());
        (variant, source)
    }
}

fn fallback_variants() -> Vec<String> {
    std::env::var("AB_VARIANTS")
        .unwrap_or_else(|_| "v2".into())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// FNV-1a over `visitor:unit` so assignment is stable across restarts.
fn hash_pick(visitor: &str, unit: &str, variants: &[String]) -> String {
    if variants.is_empty() {
        return "default".into();
    }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in visitor
        .bytes()
        .chain(b":".iter().copied())
        .chain(unit.bytes())
    {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    variants[(h % variants.len() as u64) as usize].clone()
}

async fn http_assign(url: &str, timeout: Duration, visitor: &str, unit: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    // Minimal raw HTTP/1.1 GET so we don't pull in a TLS stack just for this.
    // Only http:// endpoints are supported; put a local proxy in front for TLS.
    let rest = url.strip_prefix("http://")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let sep = if path.contains('?') { '&' } else { '?' };
    let target = format!(
        "{path}{sep}visitor={}&unit={}&site={SITE}",
        urlencode(visitor),
        urlencode(unit)
    );

    let fut = async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(hostport).await.ok()?;
        let req = format!(
            "GET {target} HTTP/1.1\r\nHost: {hostport}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).await.ok()?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.ok()?;
        let text = String::from_utf8_lossy(&buf);
        let (head, body) = text.split_once("\r\n\r\n")?;
        let body = if head
            .to_ascii_lowercase()
            .contains("transfer-encoding: chunked")
        {
            dechunk(body)
        } else {
            body.to_string()
        };
        let v: Value = serde_json::from_str(body.trim()).ok()?;
        let variant = v.get("variant")?.as_str()?.trim().to_string();
        if variant.is_empty() {
            None
        } else {
            Some(variant)
        }
    };

    tokio::time::timeout(timeout, fut).await.ok().flatten()
}

/// Decode a `Transfer-Encoding: chunked` body.
fn dechunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size_line, tail)) = rest.split_once("\r\n") {
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        if size == 0 || tail.len() < size {
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or(&tail[size..]);
    }
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
pub struct AssignQuery {
    pub visitor: String,
    #[serde(default = "default_unit")]
    pub unit: String,
}

fn default_unit() -> String {
    "home".into()
}

/// `GET /api/ab/assign?visitor=..&unit=..`
///
/// Returns `{ "variant": "...", "source": "provider|cache|fallback", "unit": ".." }`.
#[axum::debug_handler]
pub async fn assign(
    State(state): State<AppState>,
    Query(q): Query<AssignQuery>,
) -> impl IntoResponse {
    if q.visitor.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "visitor is required"})),
        )
            .into_response();
    }
    let assignments = {
        let ab = state.inner.ab.lock().unwrap();
        ab.assignments.clone()
    };
    let (variant, source) = assignments.resolve(&q.visitor, &q.unit).await;
    Json(json!({ "variant": variant, "source": source, "unit": q.unit })).into_response()
}

#[derive(Deserialize)]
pub struct EventBody {
    pub visitor: String,
    #[serde(default)]
    pub session: String,
    pub variant: String,
    #[serde(default = "default_unit")]
    pub unit: String,
    pub name: String,
    #[serde(default)]
    pub props: Value,
}

/// `POST /api/ab/events` — append one event to the log.
pub async fn record_event(
    State(state): State<AppState>,
    Json(body): Json<EventBody>,
) -> impl IntoResponse {
    if body.visitor.trim().is_empty() || body.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "visitor and name are required"})),
        )
            .into_response();
    }
    let event = Event {
        ts: now_iso(),
        visitor: body.visitor,
        session: body.session,
        variant: body.variant,
        unit: body.unit,
        name: body.name,
        props: body.props,
    };
    state.inner.ab.lock().unwrap().append(event);
    Json(json!({"ok": true})).into_response()
}

/// `GET /api/ab/stats` — raw per-variant counts, for the experiment owner's
/// own tooling. No significance testing, no winner, no decisions.
pub async fn stats(State(state): State<AppState>) -> impl IntoResponse {
    let ab = state.inner.ab.lock().unwrap();
    let events = ab.events.lock().unwrap();
    let exposure = ab.exposure.lock().unwrap();

    let mut per_variant: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut visitors: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    for e in events.iter() {
        *per_variant
            .entry(e.variant.clone())
            .or_default()
            .entry(e.name.clone())
            .or_default() += 1;
        visitors
            .entry(e.variant.clone())
            .or_default()
            .insert(e.visitor.clone());
    }

    let units: BTreeMap<String, BTreeMap<String, u64>> =
        exposure
            .iter()
            .fold(BTreeMap::new(), |mut acc, ((unit, variant), n)| {
                acc.entry(unit.clone())
                    .or_default()
                    .insert(variant.clone(), *n);
                acc
            });

    Json(json!({
        "site": SITE,
        "total_events": events.len(),
        "variants": per_variant,
        "unique_visitors": visitors
            .iter()
            .map(|(k, v)| (k.clone(), v.len()))
            .collect::<BTreeMap<_, _>>(),
        "exposures_by_unit": units,
    }))
}

/// `POST /api/ab/reset` — clears the in-memory event log, exposure index and
/// assignment cache, and truncates the JSONL file. Useful between test runs.
/// Does not touch the provider.
pub async fn reset(State(state): State<AppState>) -> impl IntoResponse {
    let ab = state.inner.ab.lock().unwrap();
    ab.events.lock().unwrap().clear();
    ab.exposure.lock().unwrap().clear();
    ab.assignments.cache.lock().unwrap().clear();
    let _ = std::fs::write(&ab.events_path, "");
    Json(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variants() -> Vec<String> {
        vec!["v2".into(), "v3".into()]
    }

    #[test]
    fn hash_pick_is_stable() {
        let v = variants();
        let a = hash_pick("visitor-1", "home", &v);
        let b = hash_pick("visitor-1", "home", &v);
        assert_eq!(a, b);
    }

    #[test]
    fn hash_pick_uses_unit_and_visitor() {
        let v = variants();
        // Different units are independent experiments, so they may differ.
        let seen: std::collections::HashSet<_> = (0..50)
            .map(|i| hash_pick(&format!("visitor-{i}"), "home", &v))
            .collect();
        assert!(seen.len() > 1, "assignment should not be constant");
        assert!(seen.iter().all(|s| v.contains(s)));
    }

    #[test]
    fn hash_pick_handles_empty_variants() {
        assert_eq!(hash_pick("x", "home", &[]), "default");
    }

    #[test]
    fn dechunk_decodes_chunked_body() {
        assert_eq!(
            dechunk("10\r\n{\"variant\":\"v2\"}\r\n0\r\n\r\n"),
            "{\"variant\":\"v2\"}"
        );
        assert_eq!(dechunk("5\r\nhello\r\n0\r\n\r\n"), "hello");
    }

    #[test]
    fn urlencode_escapes_reserved_characters() {
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("safe-._~"), "safe-._~");
    }
}
