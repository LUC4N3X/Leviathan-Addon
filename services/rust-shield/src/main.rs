use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use once_cell::sync::Lazy;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONNECTION, CONTENT_LENGTH, HOST, TRANSFER_ENCODING};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    env,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::{watch, Mutex, RwLock}, time::timeout};
use tracing::{debug, info, warn};
use url::Url;

static DEFAULT_UA: Lazy<String> = Lazy::new(|| {
    env::var("RUST_SHIELD_USER_AGENT").unwrap_or_else(|_| {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36".to_string()
    })
});

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    cache: Arc<RwLock<HashMap<String, CacheEntry>>>,
    cookies: Arc<RwLock<HashMap<String, String>>>,
    inflight: Arc<Mutex<HashMap<String, FlightEntry>>>,
    cfg: Config,
}

#[derive(Clone)]
struct Config {
    bind: String,
    cache_max_entries: usize,
    default_timeout_ms: u64,
    max_body_bytes: u64,
    default_cache_ttl_ms: u64,
    default_stale_ttl_ms: u64,
    allow_private: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct FetchRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    cache_key: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cache_ttl_ms: Option<u64>,
    #[serde(default)]
    stale_ttl_ms: Option<u64>,
    #[serde(default)]
    cache: Option<bool>,
    #[serde(default)]
    max_redirects: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
struct WarmupRequest {
    urls: Vec<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    cache_ttl_ms: Option<u64>,
    #[serde(default)]
    stale_ttl_ms: Option<u64>,
    #[serde(default)]
    concurrency: Option<usize>,
}

#[derive(Clone, Serialize)]
struct FetchResponse {
    ok: bool,
    status: u16,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    bytes: usize,
    blocked: bool,
    blocked_reason: Option<String>,
    cache: String,
    via: String,
    ms: u128,
}

#[derive(Clone, Serialize)]
struct WarmupResponse {
    ok: bool,
    total: usize,
    warmed: usize,
    blocked: usize,
    ms: u128,
    results: Vec<WarmupItem>,
}

#[derive(Clone, Serialize)]
struct WarmupItem {
    url: String,
    ok: bool,
    status: u16,
    blocked: bool,
    cache: String,
    ms: u128,
}

#[derive(Clone)]
struct CacheEntry {
    response: FetchResponse,
    expires_at: Instant,
    stale_until: Instant,
    created_at: Instant,
}

type FlightResult = Result<FetchResponse, (StatusCode, String)>;

#[derive(Clone)]
struct FlightEntry {
    sender: watch::Sender<Option<FlightResult>>,
}

enum SingleflightRole {
    Leader(FlightEntry),
    Waiter(FlightEntry),
}

fn default_method() -> String {
    "GET".to_string()
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name).ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(fallback)
}

fn env_usize(name: &str, fallback: usize) -> usize {
    env::var(name).ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(fallback)
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name).ok().map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn load_config() -> Config {
    Config {
        bind: env::var("RUST_SHIELD_BIND").unwrap_or_else(|_| "0.0.0.0:8787".to_string()),
        cache_max_entries: env_usize("RUST_SHIELD_CACHE_MAX", 2000),
        default_timeout_ms: env_u64("RUST_SHIELD_TIMEOUT_MS", 1800),
        max_body_bytes: env_u64("RUST_SHIELD_MAX_BODY_BYTES", 2_500_000),
        default_cache_ttl_ms: env_u64("RUST_SHIELD_CACHE_TTL_MS", 1_200_000),
        default_stale_ttl_ms: env_u64("RUST_SHIELD_STALE_TTL_MS", 3_600_000),
        allow_private: env_bool("RUST_SHIELD_ALLOW_PRIVATE", false),
    }
}

fn build_client(cfg: &Config) -> anyhow::Result<reqwest::Client> {
    let connect_timeout = Duration::from_millis(env_u64("RUST_SHIELD_CONNECT_TIMEOUT_MS", 900));
    let request_timeout = Duration::from_millis(env_u64("RUST_SHIELD_CLIENT_TIMEOUT_MS", cfg.default_timeout_ms + 600));
    let pool_idle = env_usize("RUST_SHIELD_POOL_MAX_IDLE_PER_HOST", 64);

    Ok(reqwest::Client::builder()
        .user_agent(DEFAULT_UA.as_str())
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .pool_idle_timeout(Duration::from_secs(env_u64("RUST_SHIELD_POOL_IDLE_SECS", 90)))
        .pool_max_idle_per_host(pool_idle)
        .tcp_nodelay(true)
        .redirect(reqwest::redirect::Policy::limited(env_usize("RUST_SHIELD_MAX_REDIRECTS", 8)))
        .build()?)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(if run_healthcheck() { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_| "info,rust_shield=info".to_string()))
        .compact()
        .init();

    let cfg = load_config();
    let client = build_client(&cfg)?;
    let state = AppState {
        client,
        cache: Arc::new(RwLock::new(HashMap::new())),
        cookies: Arc::new(RwLock::new(HashMap::new())),
        inflight: Arc::new(Mutex::new(HashMap::new())),
        cfg: cfg.clone(),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/readyz", get(health))
        .route("/fetch", post(fetch_route))
        .route("/warmup", post(warmup_route))
        .with_state(state);

    let listener = TcpListener::bind(&cfg.bind).await?;
    info!(bind = %cfg.bind, cache_max = cfg.cache_max_entries, timeout_ms = cfg.default_timeout_ms, "Rust Shield online");
    axum::serve(listener, app).await?;
    Ok(())
}

fn run_healthcheck() -> bool {
    let bind = env::var("RUST_SHIELD_BIND").unwrap_or_else(|_| "0.0.0.0:8787".to_string());
    let port = bind.rsplit(':').next().and_then(|v| v.parse::<u16>().ok()).unwrap_or(8787);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0_u8; 128];
    match stream.read(&mut buf) {
        Ok(n) => std::str::from_utf8(&buf[..n]).map(|s| s.contains("200 OK")).unwrap_or(false),
        Err(_) => false,
    }
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let cache_entries = state.cache.read().await.len();
    let cookie_origins = state.cookies.read().await.len();
    let inflight_requests = state.inflight.lock().await.len();
    Json(serde_json::json!({
        "ok": true,
        "service": "rust-shield",
        "cache_entries": cache_entries,
        "cookie_origins": cookie_origins,
        "inflight_requests": inflight_requests,
        "timeout_ms": state.cfg.default_timeout_ms,
        "max_body_bytes": state.cfg.max_body_bytes
    }))
}

async fn fetch_route(State(state): State<AppState>, Json(req): Json<FetchRequest>) -> impl IntoResponse {
    match fetch_inner(state, req).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err((status, msg)) => (
            status,
            Json(serde_json::json!({
                "ok": false,
                "status": status.as_u16(),
                "url": "",
                "headers": {},
                "body": "",
                "bytes": 0,
                "blocked": false,
                "blocked_reason": msg,
                "cache": "error",
                "via": "rust-shield",
                "ms": 0
            })),
        )
            .into_response(),
    }
}

async fn warmup_route(State(state): State<AppState>, Json(req): Json<WarmupRequest>) -> impl IntoResponse {
    let started = Instant::now();
    let mut results = Vec::new();
    let mut warmed = 0;
    let mut blocked = 0;
    let urls = req.urls.into_iter().filter(|u| !u.trim().is_empty()).take(64).collect::<Vec<_>>();
    let concurrency = req
        .concurrency
        .unwrap_or_else(|| env_usize("RUST_SHIELD_WARMUP_CONCURRENCY", 4))
        .clamp(1, 16);

    for chunk in urls.chunks(concurrency) {
        let mut handles = Vec::with_capacity(chunk.len());
        for url in chunk.iter().cloned() {
            let state_for_task = state.clone();
            let headers = req.headers.clone();
            let provider = req.provider.clone();
            let timeout_ms = req.timeout_ms;
            let cache_ttl_ms = req.cache_ttl_ms;
            let stale_ttl_ms = req.stale_ttl_ms;

            handles.push(tokio::spawn(async move {
                let item_started = Instant::now();
                let fetch_req = FetchRequest {
                    url: url.clone(),
                    method: "GET".to_string(),
                    body: None,
                    headers,
                    provider,
                    cache_key: None,
                    timeout_ms,
                    cache_ttl_ms,
                    stale_ttl_ms,
                    cache: Some(true),
                    max_redirects: None,
                };

                match fetch_inner(state_for_task, fetch_req).await {
                    Ok(resp) => {
                        let warmed_inc = if resp.ok && !resp.blocked { 1 } else { 0 };
                        let blocked_inc = if resp.blocked { 1 } else { 0 };
                        (WarmupItem {
                            url: resp.url,
                            ok: resp.ok,
                            status: resp.status,
                            blocked: resp.blocked,
                            cache: resp.cache,
                            ms: item_started.elapsed().as_millis(),
                        }, warmed_inc, blocked_inc)
                    }
                    Err((status, msg)) => {
                        warn!(url = %url, status = status.as_u16(), error = %msg, "warmup item failed");
                        (WarmupItem {
                            url,
                            ok: false,
                            status: status.as_u16(),
                            blocked: false,
                            cache: "error".to_string(),
                            ms: item_started.elapsed().as_millis(),
                        }, 0, 0)
                    }
                }
            }));
        }

        for handle in handles {
            match handle.await {
                Ok((item, warmed_inc, blocked_inc)) => {
                    warmed += warmed_inc;
                    blocked += blocked_inc;
                    results.push(item);
                }
                Err(err) => {
                    warn!(error = %err, "warmup worker join failed");
                }
            }
        }
    }

    Json(WarmupResponse {
        ok: warmed > 0 || results.is_empty(),
        total: results.len(),
        warmed,
        blocked,
        ms: started.elapsed().as_millis(),
        results,
    })
}

async fn fetch_inner(state: AppState, req: FetchRequest) -> FlightResult {
    let started = Instant::now();
    let method = req.method.trim().to_ascii_uppercase();
    if method != "GET" && method != "POST" && method != "HEAD" {
        return Err((StatusCode::BAD_REQUEST, "unsupported_method".to_string()));
    }

    let parsed = Url::parse(req.url.trim()).map_err(|_| (StatusCode::BAD_REQUEST, "invalid_url".to_string()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err((StatusCode::BAD_REQUEST, "unsupported_scheme".to_string()));
    }
    if !state.cfg.allow_private && is_private_target(&parsed) {
        return Err((StatusCode::FORBIDDEN, "private_target_blocked".to_string()));
    }

    let cache_enabled = req.cache.unwrap_or(true) && method == "GET";
    let cache_key = req.cache_key.clone().unwrap_or_else(|| make_cache_key(&method, parsed.as_str(), req.body.as_deref().unwrap_or(""), &req.headers));
    if cache_enabled {
        if let Some(resp) = read_cache(&state, &cache_key).await {
            return Ok(resp);
        }
    }

    let timeout_ms = req.timeout_ms.unwrap_or(state.cfg.default_timeout_ms).clamp(350, 10_000);

    if cache_enabled {
        match begin_singleflight(&state, &cache_key).await {
            SingleflightRole::Waiter(entry) => {
                debug!(url = %parsed.as_str(), key = %cache_key, "singleflight wait");
                return wait_singleflight_result(entry, timeout_ms, started).await;
            }
            SingleflightRole::Leader(entry) => {
                debug!(url = %parsed.as_str(), key = %cache_key, "singleflight leader");
                let result = fetch_uncached(state.clone(), req, parsed, method, cache_key.clone(), cache_enabled, timeout_ms, started).await;
                finish_singleflight(&state, &cache_key, &entry, result.clone()).await;
                return result;
            }
        }
    }

    fetch_uncached(state, req, parsed, method, cache_key, cache_enabled, timeout_ms, started).await
}

async fn fetch_uncached(
    state: AppState,
    req: FetchRequest,
    parsed: Url,
    method: String,
    cache_key: String,
    cache_enabled: bool,
    timeout_ms: u64,
    started: Instant,
) -> FlightResult {
    let mut headers = sanitize_headers(&req.headers);
    apply_default_headers(&mut headers, &parsed, &state).await;

    let builder = match method.as_str() {
        "POST" => state.client.post(parsed.as_str()).body(req.body.unwrap_or_default()),
        "HEAD" => state.client.head(parsed.as_str()),
        _ => state.client.get(parsed.as_str()),
    }
    .headers(headers)
    .timeout(Duration::from_millis(timeout_ms));

    let response = timeout(Duration::from_millis(timeout_ms + 250), builder.send())
        .await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "rust_timeout".to_string()))?
        .map_err(|err| (StatusCode::BAD_GATEWAY, format!("transport:{}", err)))?;

    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let resp_headers = response_headers_to_map(response.headers());
    store_response_cookies(&state, &final_url, response.headers()).await;

    if let Some(len) = response.content_length() {
        if len > state.cfg.max_body_bytes {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, format!("body_too_large:{len}")));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| (StatusCode::BAD_GATEWAY, format!("body:{}", err)))?;
    if bytes.len() as u64 > state.cfg.max_body_bytes {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, format!("body_too_large:{}", bytes.len())));
    }

    let body = String::from_utf8_lossy(&bytes).to_string();
    let blocked_reason = detect_blocked(&body, status);
    let blocked = blocked_reason.is_some();
    let resp = FetchResponse {
        ok: status < 500 && !blocked,
        status,
        url: final_url,
        headers: resp_headers,
        bytes: body.len(),
        body,
        blocked,
        blocked_reason,
        cache: "miss".to_string(),
        via: "rust-shield".to_string(),
        ms: started.elapsed().as_millis(),
    };

    if cache_enabled && resp.ok && !resp.blocked {
        write_cache(&state, cache_key, resp.clone(), req.cache_ttl_ms, req.stale_ttl_ms).await;
    }

    debug!(url = %resp.url, status = resp.status, bytes = resp.bytes, blocked = resp.blocked, ms = resp.ms, "fetch done");
    Ok(resp)
}

async fn begin_singleflight(state: &AppState, key: &str) -> SingleflightRole {
    let mut inflight = state.inflight.lock().await;
    if let Some(entry) = inflight.get(key) {
        return SingleflightRole::Waiter(entry.clone());
    }

    let (sender, _receiver) = watch::channel(None);
    let entry = FlightEntry { sender };
    inflight.insert(key.to_string(), entry.clone());
    SingleflightRole::Leader(entry)
}

async fn finish_singleflight(state: &AppState, key: &str, entry: &FlightEntry, result: FlightResult) {
    let _ = entry.sender.send(Some(result));
    let mut inflight = state.inflight.lock().await;
    inflight.remove(key);
}

async fn wait_singleflight_result(entry: FlightEntry, timeout_ms: u64, started: Instant) -> FlightResult {
    let mut receiver = entry.sender.subscribe();
    if let Some(result) = receiver.borrow().clone() {
        return mark_singleflight_shared(result, started);
    }

    let wait_budget = Duration::from_millis((timeout_ms + 750).clamp(750, 11_000));
    let result = timeout(wait_budget, async {
        loop {
            if receiver.changed().await.is_err() {
                return None;
            }
            if let Some(result) = receiver.borrow().clone() {
                return Some(result);
            }
        }
    })
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "singleflight_timeout".to_string()))?
    .ok_or_else(|| (StatusCode::BAD_GATEWAY, "singleflight_closed".to_string()))?;

    mark_singleflight_shared(result, started)
}

fn mark_singleflight_shared(result: FlightResult, started: Instant) -> FlightResult {
    result.map(|mut resp| {
        if resp.cache == "miss" {
            resp.cache = "shared".to_string();
        }
        resp.ms = started.elapsed().as_millis();
        resp
    })
}

async fn read_cache(state: &AppState, key: &str) -> Option<FetchResponse> {
    let now = Instant::now();
    {
        let cache = state.cache.read().await;
        let Some(entry) = cache.get(key) else { return None; };
        if now <= entry.expires_at {
            let mut resp = entry.response.clone();
            resp.cache = "hit".to_string();
            resp.ms = 0;
            return Some(resp);
        }
        if now <= entry.stale_until {
            let mut resp = entry.response.clone();
            resp.cache = "stale".to_string();
            resp.ms = 0;
            return Some(resp);
        }
    }
    // Entry is past its stale window: escalate to a write lock to evict it,
    // re-checking under the lock since another task may have refreshed it.
    let mut cache = state.cache.write().await;
    if let Some(entry) = cache.get(key) {
        if Instant::now() > entry.stale_until {
            cache.remove(key);
        }
    }
    None
}

async fn write_cache(state: &AppState, key: String, resp: FetchResponse, ttl_ms: Option<u64>, stale_ms: Option<u64>) {
    let ttl = ttl_ms.unwrap_or(state.cfg.default_cache_ttl_ms).clamp(5_000, 86_400_000);
    let stale = stale_ms.unwrap_or(state.cfg.default_stale_ttl_ms).clamp(ttl, 172_800_000);
    let now = Instant::now();
    let mut cache = state.cache.write().await;
    if cache.len() >= state.cfg.cache_max_entries {
        prune_cache(&mut cache, state.cfg.cache_max_entries.saturating_sub(1));
    }
    cache.insert(key, CacheEntry {
        response: resp,
        expires_at: now + Duration::from_millis(ttl),
        stale_until: now + Duration::from_millis(stale),
        created_at: now,
    });
}

fn prune_cache(cache: &mut HashMap<String, CacheEntry>, target_len: usize) {
    let now = Instant::now();
    cache.retain(|_, entry| entry.stale_until > now);
    if cache.len() <= target_len { return; }
    let mut oldest = cache
        .iter()
        .map(|(key, entry)| (key.clone(), entry.created_at))
        .collect::<Vec<_>>();
    oldest.sort_by_key(|(_, created)| *created);
    for (key, _) in oldest.into_iter().take(cache.len().saturating_sub(target_len)) {
        cache.remove(&key);
    }
}

fn sanitize_headers(input: &HashMap<String, String>) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in input {
        let lower = name.trim().to_ascii_lowercase();
        if lower.is_empty() || matches!(lower.as_str(), "host" | "connection" | "content-length" | "transfer-encoding") {
            continue;
        }
        let Ok(header_name) = HeaderName::from_bytes(lower.as_bytes()) else { continue; };
        let Ok(header_value) = HeaderValue::from_str(value.trim()) else { continue; };
        out.insert(header_name, header_value);
    }
    out.remove(HOST);
    out.remove(CONNECTION);
    out.remove(CONTENT_LENGTH);
    out.remove(TRANSFER_ENCODING);
    out
}

async fn apply_default_headers(headers: &mut HeaderMap, url: &Url, state: &AppState) {
    if !headers.contains_key("user-agent") {
        let _ = headers.insert("user-agent", HeaderValue::from_str(DEFAULT_UA.as_str()).unwrap());
    }
    if !headers.contains_key("accept") {
        let _ = headers.insert("accept", HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"));
    }
    if !headers.contains_key("accept-language") {
        let _ = headers.insert("accept-language", HeaderValue::from_static("it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7"));
    }
    if !headers.contains_key(ACCEPT_ENCODING) {
        let _ = headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip, br, zstd, deflate"));
    }
    if !headers.contains_key("referer") {
        let origin = format!("{}://{}/", url.scheme(), url.host_str().unwrap_or_default());
        if let Ok(v) = HeaderValue::from_str(&origin) {
            let _ = headers.insert("referer", v);
        }
    }
    if !headers.contains_key("cookie") {
        let origin = origin_key(url.as_str());
        if let Some(cookie) = state.cookies.read().await.get(&origin).cloned() {
            if let Ok(v) = HeaderValue::from_str(&cookie) {
                let _ = headers.insert("cookie", v);
            }
        }
    }
}

fn response_headers_to_map(headers: &HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in headers.iter() {
        if name.as_str().eq_ignore_ascii_case("set-cookie") {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out.insert(name.as_str().to_string(), v.to_string());
        }
    }
    let set_cookies = headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>();
    if !set_cookies.is_empty() {
        out.insert("set-cookie".to_string(), set_cookies.join("\n"));
    }
    out
}

async fn store_response_cookies(state: &AppState, url: &str, headers: &HeaderMap) {
    let set_cookies = headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>();
    if set_cookies.is_empty() { return; }
    let origin = origin_key(url);
    let mut jar = state.cookies.write().await;
    let current = jar.get(&origin).cloned().unwrap_or_default();
    let merged = merge_cookie_headers(&current, &set_cookies);
    if !merged.is_empty() {
        jar.insert(origin, merged);
    }
}

fn merge_cookie_headers(current: &str, set_cookies: &[&str]) -> String {
    let mut map: HashMap<String, String> = HashMap::new();
    for pair in current.split(';') {
        let p = pair.trim();
        if let Some((k, v)) = p.split_once('=') {
            if !k.trim().is_empty() { map.insert(k.trim().to_string(), v.trim().to_string()); }
        }
    }
    for raw in set_cookies {
        let first = raw.split(';').next().unwrap_or("").trim();
        if let Some((k, v)) = first.split_once('=') {
            if !k.trim().is_empty() { map.insert(k.trim().to_string(), v.trim().to_string()); }
        }
    }
    let mut keys = map.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    keys.into_iter().filter_map(|k| map.get(&k).map(|v| format!("{k}={v}"))).collect::<Vec<_>>().join("; ")
}

fn make_cache_key(method: &str, url: &str, body: &str, headers: &HashMap<String, String>) -> String {
    let mut h = DefaultHasher::new();
    method.hash(&mut h);
    url.hash(&mut h);
    body.hash(&mut h);
    for header in ["user-agent", "accept-language", "cookie"] {
        if let Some(v) = headers.get(header).or_else(|| headers.get(&header.to_ascii_lowercase())) {
            header.hash(&mut h);
            v.hash(&mut h);
        }
    }
    format!("{}:{:x}", method, h.finish())
}

fn origin_key(value: &str) -> String {
    Url::parse(value)
        .ok()
        .map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default()))
        .unwrap_or_default()
}

fn is_private_target(url: &Url) -> bool {
    let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else { return true; };
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "::1") || host.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_broadcast() || v4.is_documentation() || v4.octets()[0] == 0,
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local() || v6.is_unspecified(),
        };
    }
    false
}

fn detect_blocked(body: &str, status: u16) -> Option<String> {
    if matches!(status, 403 | 429 | 503 | 520 | 521 | 522 | 523 | 524) {
        return Some(format!("status_{status}"));
    }
    let lower: String = body.chars().take(250_000).map(|c| c.to_ascii_lowercase()).collect();
    let signals = [
        "turnstile.cloudflare.com",
        "cf-turnstile",
        "cf_chl_",
        "__cf_chl_",
        "cf-browser-verification",
        "cf_captcha_kind",
        "cf_clearance",
        "challenge-platform",
        "challenge-form",
        "cf-challenge",
        "g-recaptcha",
        "h-captcha",
        "hcaptcha.com",
        "checking if the site connection is secure",
        "verify you are human",
        "verifica di essere umano",
        "verifica che sei umano",
        "verifica che tu sia umano",
        "just a moment",
        "un momento",
        "cloudflare ray id",
    ];
    let mut score = 0;
    for token in signals {
        if lower.contains(token) { score += 2; }
    }
    if lower.contains("cloudflare") && (lower.contains("captcha") || lower.contains("challenge") || lower.contains("turnstile")) {
        score += 4;
    }
    if lower.contains("<title>just a moment") || lower.contains("<title>attention required") || lower.contains("<title>checking") {
        score += 4;
    }
    if score >= 3 { Some("challenge_detected".to_string()) } else { None }
}
