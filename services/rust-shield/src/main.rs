use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use once_cell::sync::Lazy;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT_ENCODING, CONNECTION, CONTENT_LENGTH, HOST,
    LOCATION, TRANSFER_ENCODING,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    env,
    hash::{Hash, Hasher},
    io::{Read, Write},
    net::{IpAddr, SocketAddr, TcpStream},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Notify, RwLock, Semaphore},
    time::timeout,
};
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
    pending: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    blocked_origins: Arc<RwLock<HashMap<String, BlockedOrigin>>>,
    host_limits: Arc<RwLock<HashMap<String, Arc<Semaphore>>>>,
    stats: Arc<Stats>,
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
    default_max_redirects: usize,
    allow_private: bool,
    stale_refresh: bool,
    singleflight_wait_ms: u64,
    host_concurrency: usize,
    blocked_ttl_ms: u64,
}

#[derive(Default)]
struct Stats {
    total_fetches: AtomicU64,
    cache_hits: AtomicU64,
    cache_stale: AtomicU64,
    cache_misses: AtomicU64,
    cache_writes: AtomicU64,
    network_fetches: AtomicU64,
    singleflight_waits: AtomicU64,
    stale_refreshes: AtomicU64,
    blocked: AtomicU64,
    origin_circuit_skips: AtomicU64,
    errors: AtomicU64,
    warmup_batches: AtomicU64,
    warmup_urls: AtomicU64,
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

#[derive(Clone, Serialize, Deserialize)]
struct BatchFetchRequest {
    requests: Vec<FetchRequest>,
    #[serde(default)]
    concurrency: Option<usize>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ClearCacheRequest {
    #[serde(default)]
    all: Option<bool>,
    #[serde(default)]
    cookies: Option<bool>,
    #[serde(default)]
    circuits: Option<bool>,
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

#[derive(Clone, Serialize)]
struct BatchFetchResponse {
    ok: bool,
    total: usize,
    ms: u128,
    results: Vec<BatchFetchItem>,
}

#[derive(Clone, Serialize)]
struct BatchFetchItem {
    url: String,
    ok: bool,
    status: u16,
    response: Option<FetchResponse>,
    error: Option<String>,
}

#[derive(Clone)]
struct CacheEntry {
    response: FetchResponse,
    expires_at: Instant,
    stale_until: Instant,
    created_at: Instant,
}

#[derive(Clone)]
struct BlockedOrigin {
    until: Instant,
    reason: String,
}

#[derive(Clone)]
struct FetchPlan {
    method: String,
    parsed: Url,
    body: Option<String>,
    headers: HeaderMap,
    provider: Option<String>,
    cache_key: String,
    cache_enabled: bool,
    timeout_ms: u64,
    cache_ttl_ms: Option<u64>,
    stale_ttl_ms: Option<u64>,
    max_redirects: usize,
    original_origin: String,
    has_cookie: bool,
}

enum CacheLookup {
    Fresh(FetchResponse),
    Stale(FetchResponse),
}

enum InflightSlot {
    Owner(Arc<Notify>),
    Waiter(Arc<Notify>),
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
        default_max_redirects: env_usize("RUST_SHIELD_MAX_REDIRECTS", 8).min(20),
        allow_private: env_bool("RUST_SHIELD_ALLOW_PRIVATE", false),
        stale_refresh: env_bool("RUST_SHIELD_STALE_REFRESH", true),
        singleflight_wait_ms: env_u64("RUST_SHIELD_SINGLEFLIGHT_WAIT_MS", 4500).clamp(500, 30_000),
        host_concurrency: env_usize("RUST_SHIELD_HOST_CONCURRENCY", 8).clamp(1, 64),
        blocked_ttl_ms: env_u64("RUST_SHIELD_BLOCKED_TTL_MS", 120_000).clamp(5_000, 900_000),
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
        // Redirects are followed manually so per-request max_redirects is actually respected.
        .redirect(reqwest::redirect::Policy::none())
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
        pending: Arc::new(Mutex::new(HashMap::new())),
        blocked_origins: Arc::new(RwLock::new(HashMap::new())),
        host_limits: Arc::new(RwLock::new(HashMap::new())),
        stats: Arc::new(Stats::default()),
        cfg: cfg.clone(),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/readyz", get(health))
        .route("/stats", get(stats_route))
        .route("/fetch", post(fetch_route))
        .route("/fetch_batch", post(fetch_batch_route))
        .route("/warmup", post(warmup_route))
        .route("/cache/clear", post(cache_clear_route))
        .with_state(state);

    let listener = TcpListener::bind(&cfg.bind).await?;
    info!(
        bind = %cfg.bind,
        cache_max = cfg.cache_max_entries,
        timeout_ms = cfg.default_timeout_ms,
        max_redirects = cfg.default_max_redirects,
        host_concurrency = cfg.host_concurrency,
        stale_refresh = cfg.stale_refresh,
        "Rust Shield online"
    );
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
    let circuit_origins = state.blocked_origins.read().await.len();
    Json(serde_json::json!({
        "ok": true,
        "service": "rust-shield",
        "cache_entries": cache_entries,
        "cookie_origins": cookie_origins,
        "circuit_origins": circuit_origins,
        "timeout_ms": state.cfg.default_timeout_ms,
        "max_body_bytes": state.cfg.max_body_bytes,
        "host_concurrency": state.cfg.host_concurrency,
        "stale_refresh": state.cfg.stale_refresh
    }))
}

async fn stats_route(State(state): State<AppState>) -> impl IntoResponse {
    Json(build_stats_json(&state).await)
}

async fn cache_clear_route(State(state): State<AppState>, Json(req): Json<ClearCacheRequest>) -> impl IntoResponse {
    let clear_all = req.all.unwrap_or(true);
    let clear_cookies = req.cookies.unwrap_or(false);
    let clear_circuits = req.circuits.unwrap_or(true);

    let mut cleared_cache = 0_usize;
    let mut cleared_cookies = 0_usize;
    let mut cleared_circuits = 0_usize;

    if clear_all {
        let mut cache = state.cache.write().await;
        cleared_cache = cache.len();
        cache.clear();
    }
    if clear_cookies {
        let mut cookies = state.cookies.write().await;
        cleared_cookies = cookies.len();
        cookies.clear();
    }
    if clear_circuits {
        let mut circuits = state.blocked_origins.write().await;
        cleared_circuits = circuits.len();
        circuits.clear();
    }

    Json(serde_json::json!({
        "ok": true,
        "cleared_cache": cleared_cache,
        "cleared_cookies": cleared_cookies,
        "cleared_circuits": cleared_circuits
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

async fn fetch_batch_route(State(state): State<AppState>, Json(req): Json<BatchFetchRequest>) -> impl IntoResponse {
    let started = Instant::now();
    let requests = req.requests.into_iter().take(64).collect::<Vec<_>>();
    let concurrency = req
        .concurrency
        .unwrap_or_else(|| env_usize("RUST_SHIELD_BATCH_CONCURRENCY", 6))
        .clamp(1, 16);
    let mut results = Vec::new();

    for chunk in requests.chunks(concurrency) {
        let mut handles = Vec::with_capacity(chunk.len());
        for item in chunk.iter().cloned() {
            let state_for_task = state.clone();
            handles.push(tokio::spawn(async move {
                let url = item.url.clone();
                match fetch_inner(state_for_task, item).await {
                    Ok(resp) => BatchFetchItem {
                        url,
                        ok: resp.ok,
                        status: resp.status,
                        response: Some(resp),
                        error: None,
                    },
                    Err((status, msg)) => BatchFetchItem {
                        url,
                        ok: false,
                        status: status.as_u16(),
                        response: None,
                        error: Some(msg),
                    },
                }
            }));
        }
        for handle in handles {
            match handle.await {
                Ok(item) => results.push(item),
                Err(err) => results.push(BatchFetchItem {
                    url: String::new(),
                    ok: false,
                    status: 500,
                    response: None,
                    error: Some(format!("join:{err}")),
                }),
            }
        }
    }

    Json(BatchFetchResponse {
        ok: results.iter().any(|item| item.ok) || results.is_empty(),
        total: results.len(),
        ms: started.elapsed().as_millis(),
        results,
    })
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

    state.stats.warmup_batches.fetch_add(1, Ordering::Relaxed);
    state.stats.warmup_urls.fetch_add(urls.len() as u64, Ordering::Relaxed);

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
                Err(err) => warn!(error = %err, "warmup worker join failed"),
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

async fn fetch_inner(state: AppState, req: FetchRequest) -> Result<FetchResponse, (StatusCode, String)> {
    state.stats.total_fetches.fetch_add(1, Ordering::Relaxed);
    let started = Instant::now();
    let plan = build_fetch_plan(&state, req).await?;

    if plan.cache_enabled {
        if let Some(cached) = read_cache(&state, &plan.cache_key).await {
            match cached {
                CacheLookup::Fresh(resp) => {
                    state.stats.cache_hits.fetch_add(1, Ordering::Relaxed);
                    return Ok(resp);
                }
                CacheLookup::Stale(resp) => {
                    state.stats.cache_stale.fetch_add(1, Ordering::Relaxed);
                    if state.cfg.stale_refresh {
                        spawn_stale_refresh(state.clone(), plan.clone());
                    }
                    return Ok(resp);
                }
            }
        }
        state.stats.cache_misses.fetch_add(1, Ordering::Relaxed);

        loop {
            match acquire_inflight(&state, &plan.cache_key).await {
                InflightSlot::Owner(notify) => {
                    let result = execute_and_cache(state.clone(), plan.clone(), started).await;
                    finish_inflight(&state, &plan.cache_key, notify).await;
                    return result;
                }
                InflightSlot::Waiter(notify) => {
                    state.stats.singleflight_waits.fetch_add(1, Ordering::Relaxed);
                    let _ = timeout(Duration::from_millis(state.cfg.singleflight_wait_ms), notify.notified()).await;
                    if let Some(cached) = read_cache(&state, &plan.cache_key).await {
                        match cached {
                            CacheLookup::Fresh(resp) | CacheLookup::Stale(resp) => return Ok(resp),
                        }
                    }
                    // Owner failed or did not cache. One waiter becomes the next owner.
                    continue;
                }
            }
        }
    }

    execute_and_cache(state, plan, started).await
}

async fn build_fetch_plan(state: &AppState, req: FetchRequest) -> Result<FetchPlan, (StatusCode, String)> {
    let method = req.method.trim().to_ascii_uppercase();
    if method != "GET" && method != "POST" && method != "HEAD" {
        return Err((StatusCode::BAD_REQUEST, "unsupported_method".to_string()));
    }

    let parsed = Url::parse(req.url.trim()).map_err(|_| (StatusCode::BAD_REQUEST, "invalid_url".to_string()))?;
    validate_target_url(&parsed, state)?;

    let cache_enabled = req.cache.unwrap_or(true) && method == "GET";
    let cache_key = req.cache_key.clone().unwrap_or_else(|| make_cache_key(&method, parsed.as_str(), req.body.as_deref().unwrap_or(""), &req.headers));
    let timeout_ms = req.timeout_ms.unwrap_or(state.cfg.default_timeout_ms).clamp(350, 10_000);
    let mut headers = sanitize_headers(&req.headers);
    apply_default_headers(&mut headers, &parsed, state).await;
    let has_cookie = has_cookie_header(&headers);

    Ok(FetchPlan {
        method,
        original_origin: origin_key(parsed.as_str()),
        parsed,
        body: req.body,
        headers,
        provider: req.provider,
        cache_key,
        cache_enabled,
        timeout_ms,
        cache_ttl_ms: req.cache_ttl_ms,
        stale_ttl_ms: req.stale_ttl_ms,
        max_redirects: req.max_redirects.unwrap_or(state.cfg.default_max_redirects).min(20),
        has_cookie,
    })
}

fn spawn_stale_refresh(state: AppState, plan: FetchPlan) {
    let cache_key = plan.cache_key.clone();
    tokio::spawn(async move {
        match acquire_inflight(&state, &cache_key).await {
            InflightSlot::Waiter(_) => return,
            InflightSlot::Owner(notify) => {
                state.stats.stale_refreshes.fetch_add(1, Ordering::Relaxed);
                let started = Instant::now();
                let result = execute_and_cache(state.clone(), plan, started).await;
                if let Err((status, msg)) = &result {
                    debug!(status = status.as_u16(), error = %msg, "stale refresh failed");
                }
                finish_inflight(&state, &cache_key, notify).await;
            }
        }
    });
}

async fn acquire_inflight(state: &AppState, key: &str) -> InflightSlot {
    let mut pending = state.pending.lock().await;
    if let Some(existing) = pending.get(key) {
        return InflightSlot::Waiter(existing.clone());
    }
    let notify = Arc::new(Notify::new());
    pending.insert(key.to_string(), notify.clone());
    InflightSlot::Owner(notify)
}

async fn finish_inflight(state: &AppState, key: &str, notify: Arc<Notify>) {
    let mut pending = state.pending.lock().await;
    pending.remove(key);
    notify.notify_waiters();
}

async fn execute_and_cache(state: AppState, plan: FetchPlan, started: Instant) -> Result<FetchResponse, (StatusCode, String)> {
    if let Some(resp) = check_origin_circuit(&state, &plan, started).await {
        return Ok(resp);
    }

    let resp = execute_network_fetch(state.clone(), plan.clone(), started).await;
    match resp {
        Ok(response) => {
            if response.blocked {
                state.stats.blocked.fetch_add(1, Ordering::Relaxed);
                if let Some(reason) = &response.blocked_reason {
                    mark_origin_blocked(&state, &plan.original_origin, reason).await;
                }
            }
            if plan.cache_enabled && response.ok && !response.blocked {
                write_cache(&state, plan.cache_key, response.clone(), plan.cache_ttl_ms, plan.stale_ttl_ms).await;
            }
            Ok(response)
        }
        Err(err) => {
            state.stats.errors.fetch_add(1, Ordering::Relaxed);
            Err(err)
        }
    }
}

async fn execute_network_fetch(state: AppState, plan: FetchPlan, started: Instant) -> Result<FetchResponse, (StatusCode, String)> {
    state.stats.network_fetches.fetch_add(1, Ordering::Relaxed);
    let semaphore = get_host_semaphore(&state, &plan.original_origin).await;
    let _permit = semaphore
        .acquire_owned()
        .await
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "host_limiter_closed".to_string()))?;

    let mut current_url = plan.parsed.clone();
    let mut method = plan.method.clone();
    let mut body = plan.body.clone();
    let mut redirects = 0_usize;

    loop {
        validate_target_url(&current_url, &state)?;
        let headers = headers_for_request(&state, &plan, &current_url).await;
        let mut builder = match method.as_str() {
            "POST" => state.client.post(current_url.as_str()).body(body.clone().unwrap_or_default()),
            "HEAD" => state.client.head(current_url.as_str()),
            _ => state.client.get(current_url.as_str()),
        }
        .headers(headers)
        .timeout(Duration::from_millis(plan.timeout_ms));

        if let Some(provider) = &plan.provider {
            builder = builder.header("x-rust-shield-provider", provider.as_str());
        }

        let response = timeout(Duration::from_millis(plan.timeout_ms + 250), builder.send())
            .await
            .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "rust_timeout".to_string()))?
            .map_err(|err| (StatusCode::BAD_GATEWAY, format!("transport:{err}")))?;

        let status = response.status().as_u16();
        let final_url = response.url().to_string();
        store_response_cookies(&state, &final_url, response.headers()).await;

        if is_redirect_status(status) {
            let Some(location) = response.headers().get(LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string) else {
                return response_to_fetch_response(response, started, "miss".to_string()).await;
            };
            if redirects >= plan.max_redirects {
                return Err((StatusCode::TOO_MANY_REQUESTS, format!("too_many_redirects:{}", plan.max_redirects)));
            }
            let next_url = response
                .url()
                .join(&location)
                .map_err(|_| (StatusCode::BAD_GATEWAY, "invalid_redirect".to_string()))?;
            validate_target_url(&next_url, &state)?;
            redirects += 1;
            if status == 303 || ((status == 301 || status == 302) && method == "POST") {
                method = "GET".to_string();
                body = None;
            }
            current_url = next_url;
            continue;
        }

        return response_to_fetch_response(response, started, "miss".to_string()).await;
    }
}

async fn response_to_fetch_response(response: reqwest::Response, started: Instant, cache: String) -> Result<FetchResponse, (StatusCode, String)> {
    let final_url = response.url().to_string();
    let status = response.status().as_u16();
    let resp_headers = response_headers_to_map(response.headers());

    if let Some(len) = response.content_length() {
        let max_body_bytes = env_u64("RUST_SHIELD_MAX_BODY_BYTES", 2_500_000);
        if len > max_body_bytes {
            return Err((StatusCode::PAYLOAD_TOO_LARGE, format!("body_too_large:{len}")));
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|err| (StatusCode::BAD_GATEWAY, format!("body:{err}")))?;
    let max_body_bytes = env_u64("RUST_SHIELD_MAX_BODY_BYTES", 2_500_000);
    if bytes.len() as u64 > max_body_bytes {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, format!("body_too_large:{}", bytes.len())));
    }

    let body = String::from_utf8_lossy(&bytes).to_string();
    let blocked_reason = detect_blocked(&body, status);
    let blocked = blocked_reason.is_some();
    let ok = status < 500 && !blocked;

    let resp = FetchResponse {
        ok,
        status,
        url: final_url,
        headers: resp_headers,
        bytes: bytes.len(),
        body,
        blocked,
        blocked_reason,
        cache,
        via: "rust-shield".to_string(),
        ms: started.elapsed().as_millis(),
    };

    debug!(url = %resp.url, status = resp.status, bytes = resp.bytes, blocked = resp.blocked, cache = %resp.cache, ms = resp.ms, "fetch done");
    Ok(resp)
}

async fn headers_for_request(state: &AppState, plan: &FetchPlan, url: &Url) -> HeaderMap {
    let mut headers = plan.headers.clone();
    let current_origin = origin_key(url.as_str());

    // Do not leak a session cookie to a redirected foreign origin.
    if current_origin != plan.original_origin {
        headers.remove("cookie");
        headers.remove("Cookie");
    }

    if !headers.contains_key("cookie") {
        if let Some(cookie) = state.cookies.read().await.get(&current_origin).cloned() {
            if let Ok(v) = HeaderValue::from_str(&cookie) {
                let _ = headers.insert("cookie", v);
            }
        }
    }

    if let Ok(v) = HeaderValue::from_str(&current_origin) {
        let _ = headers.insert("referer", v);
    }

    headers
}

async fn get_host_semaphore(state: &AppState, origin: &str) -> Arc<Semaphore> {
    if let Some(existing) = state.host_limits.read().await.get(origin).cloned() {
        return existing;
    }
    let mut limits = state.host_limits.write().await;
    limits
        .entry(origin.to_string())
        .or_insert_with(|| Arc::new(Semaphore::new(state.cfg.host_concurrency)))
        .clone()
}

async fn check_origin_circuit(state: &AppState, plan: &FetchPlan, started: Instant) -> Option<FetchResponse> {
    if plan.has_cookie {
        return None;
    }

    let now = Instant::now();
    let mut circuits = state.blocked_origins.write().await;
    let Some(blocked) = circuits.get(&plan.original_origin).cloned() else { return None; };
    if now > blocked.until {
        circuits.remove(&plan.original_origin);
        return None;
    }

    state.stats.origin_circuit_skips.fetch_add(1, Ordering::Relaxed);
    Some(FetchResponse {
        ok: false,
        status: 0,
        url: plan.parsed.as_str().to_string(),
        headers: HashMap::new(),
        body: String::new(),
        bytes: 0,
        blocked: true,
        blocked_reason: Some(format!("origin_circuit_open:{}", blocked.reason)),
        cache: "circuit".to_string(),
        via: "rust-shield".to_string(),
        ms: started.elapsed().as_millis(),
    })
}

async fn mark_origin_blocked(state: &AppState, origin: &str, reason: &str) {
    if origin.is_empty() {
        return;
    }
    let until = Instant::now() + Duration::from_millis(state.cfg.blocked_ttl_ms);
    state.blocked_origins.write().await.insert(origin.to_string(), BlockedOrigin {
        until,
        reason: reason.to_string(),
    });
}

async fn read_cache(state: &AppState, key: &str) -> Option<CacheLookup> {
    let now = Instant::now();
    let mut cache = state.cache.write().await;
    let Some(entry) = cache.get_mut(key) else { return None; };
    if now <= entry.expires_at {
        let mut resp = entry.response.clone();
        resp.cache = "hit".to_string();
        resp.ms = 0;
        return Some(CacheLookup::Fresh(resp));
    }
    if now <= entry.stale_until {
        let mut resp = entry.response.clone();
        resp.cache = "stale".to_string();
        resp.ms = 0;
        return Some(CacheLookup::Stale(resp));
    }
    cache.remove(key);
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
    state.stats.cache_writes.fetch_add(1, Ordering::Relaxed);
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
        if let Some(v) = headers.get(header).or_else(|| headers.get(&header.to_ascii_lowercase())).or_else(|| headers.get(&to_title_case_header(header))) {
            header.hash(&mut h);
            v.hash(&mut h);
        }
    }
    format!("{}:{:x}", method, h.finish())
}

fn to_title_case_header(value: &str) -> String {
    value
        .split('-')
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn origin_key(value: &str) -> String {
    Url::parse(value)
        .ok()
        .map(|u| format!("{}://{}", u.scheme(), u.host_str().unwrap_or_default()))
        .unwrap_or_default()
}

fn validate_target_url(url: &Url, state: &AppState) -> Result<(), (StatusCode, String)> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err((StatusCode::BAD_REQUEST, "unsupported_scheme".to_string()));
    }
    if !state.cfg.allow_private && is_private_target(url) {
        return Err((StatusCode::FORBIDDEN, "private_target_blocked".to_string()));
    }
    Ok(())
}

fn has_cookie_header(headers: &HeaderMap) -> bool {
    headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

fn is_redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
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
    let lower = body.chars().take(250_000).collect::<String>().to_ascii_lowercase();
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

async fn build_stats_json(state: &AppState) -> serde_json::Value {
    let cache_entries = state.cache.read().await.len();
    let cookie_origins = state.cookies.read().await.len();
    let circuit_origins = state.blocked_origins.read().await.len();
    let pending = state.pending.lock().await.len();

    serde_json::json!({
        "ok": true,
        "service": "rust-shield",
        "cache_entries": cache_entries,
        "cookie_origins": cookie_origins,
        "circuit_origins": circuit_origins,
        "pending": pending,
        "stats": {
            "total_fetches": state.stats.total_fetches.load(Ordering::Relaxed),
            "cache_hits": state.stats.cache_hits.load(Ordering::Relaxed),
            "cache_stale": state.stats.cache_stale.load(Ordering::Relaxed),
            "cache_misses": state.stats.cache_misses.load(Ordering::Relaxed),
            "cache_writes": state.stats.cache_writes.load(Ordering::Relaxed),
            "network_fetches": state.stats.network_fetches.load(Ordering::Relaxed),
            "singleflight_waits": state.stats.singleflight_waits.load(Ordering::Relaxed),
            "stale_refreshes": state.stats.stale_refreshes.load(Ordering::Relaxed),
            "blocked": state.stats.blocked.load(Ordering::Relaxed),
            "origin_circuit_skips": state.stats.origin_circuit_skips.load(Ordering::Relaxed),
            "errors": state.stats.errors.load(Ordering::Relaxed),
            "warmup_batches": state.stats.warmup_batches.load(Ordering::Relaxed),
            "warmup_urls": state.stats.warmup_urls.load(Ordering::Relaxed)
        },
        "config": {
            "timeout_ms": state.cfg.default_timeout_ms,
            "max_body_bytes": state.cfg.max_body_bytes,
            "cache_max_entries": state.cfg.cache_max_entries,
            "max_redirects": state.cfg.default_max_redirects,
            "host_concurrency": state.cfg.host_concurrency,
            "stale_refresh": state.cfg.stale_refresh,
            "blocked_ttl_ms": state.cfg.blocked_ttl_ms
        }
    })
}
