//! Redis / Valkey key-value store.
//!
//! Isolated, additive module — no other command or subsystem depends on it,
//! mirroring `commands::s3`. Unlike S3 (which has its own parallel config
//! type), Redis reuses the shared `super::connection::ConnectionConfig`:
//! host/port/username/password already cover Redis's connection needs, and
//! Redis still belongs in the same connection list/modal as the SQL engines
//! (see `commands::connection::test_connection`/`fetch_schema_tree_impl`,
//! which short-circuit for `engine == "redis"` before the SQL family match —
//! the same pattern already used for D1/DuckDB).
//!
//! What *is* isolated is everything about the data model: Redis has no
//! schema/columns, so results here are `RedisValueDto`/`RedisKeyDetail`, not
//! `SchemaNode`/`QueryResultData`. Every command builds a transient
//! connection per call (no pooling) — consistent with `commands::s3` and fine
//! here because each command is a single round trip (or a couple, for
//! type+ttl+value), with pagination driven by a client-held cursor.

use std::collections::HashSet;

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use redis::aio::MultiplexedConnection;
use serde::Serialize;

use super::connection::{normalize_host, ConnectionConfig};

/// Bound how long we'll wait on the initial TCP/auth handshake — mirrors
/// `commands::connection::CONNECT_TIMEOUT`.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Collections (list/set/zset) are capped at this many elements per fetch so
/// a huge production key can't stall the UI or blow up the IPC payload.
/// `truncated` on the DTO tells the frontend more exist.
const MAX_COLLECTION_ITEMS: isize = 1000;

// ─── Error model ────────────────────────────────────────────────────────────

/// Redis error kind — mirrored on the frontend as `RedisErrorKind`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RedisErrorKind {
    Auth,
    NotFound,
    Network,
    Timeout,
    Config,
    Unknown,
}

/// A normalized Redis error. Serialized to JSON for the command boundary,
/// mirroring `commands::s3::StorageError` (Redis gets its own error type for
/// the same reason S3 does — a structurally different subsystem shouldn't be
/// forced through `commands::error::DbError`).
#[derive(Debug, Clone, Serialize)]
pub struct RedisError {
    pub kind: RedisErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl RedisError {
    pub fn new(kind: RedisErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), hint: None }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| "{\"kind\":\"unknown\",\"message\":\"redis error\"}".to_string())
    }
}

/// Classify the redis crate's own error type by message text rather than by
/// matching its `ErrorKind` enum directly — text-based classification (same
/// approach as `commands::s3::classify_message`) is far less likely to break
/// across `redis` crate version bumps than pattern-matching an enum that
/// crate isn't ours to keep stable.
impl From<redis::RedisError> for RedisError {
    fn from(err: redis::RedisError) -> Self {
        let raw = err.to_string();
        let lower = raw.to_lowercase();
        let kind = if lower.contains("timed out") || lower.contains("timeout") {
            RedisErrorKind::Timeout
        } else if lower.contains("noauth")
            || lower.contains("wrongpass")
            || lower.contains("invalid password")
            || lower.contains("authentication")
            || lower.contains("noperm")
        {
            RedisErrorKind::Auth
        } else if lower.contains("connection refused")
            || lower.contains("dns")
            || lower.contains("unreachable")
            || lower.contains("broken pipe")
            || lower.contains("os error")
        {
            RedisErrorKind::Network
        } else {
            RedisErrorKind::Unknown
        };
        RedisError::new(kind, raw)
    }
}

/// Convenience for `.map_err(err_str)` at the `#[tauri::command]` boundary.
fn err_str(e: redis::RedisError) -> String {
    RedisError::from(e).to_json_string()
}

// ─── Connection ─────────────────────────────────────────────────────────────

/// Build a `redis[s]://` URL from the shared `ConnectionConfig`. Credentials
/// are percent-encoded so passwords containing `@`, `:`, `/`, etc. don't
/// corrupt the URL — `redis-rs` has no builder for `ConnectionInfo` that
/// bypasses URL parsing (its fields are crate-private), so a correctly
/// encoded URL string is the supported way in.
fn build_url(config: &ConnectionConfig) -> Result<String, RedisError> {
    let host = normalize_host(config.host.clone());
    if host.trim().is_empty() {
        return Err(RedisError::new(RedisErrorKind::Config, "Host is required."));
    }
    let port = config.port.unwrap_or(6379);
    let db = config.redis_db_index.unwrap_or(0);

    // `ssl_mode` is the same generic field Postgres/MySQL use; any value
    // other than empty/"disable" turns on TLS (`rediss://`) for Redis.
    let use_tls = config
        .ssl_mode
        .as_deref()
        .map(|m| !m.trim().is_empty() && !m.eq_ignore_ascii_case("disable"))
        .unwrap_or(false);
    let scheme = if use_tls { "rediss" } else { "redis" };

    let password = config.password.as_deref().unwrap_or("");
    let username = config.username.as_deref().unwrap_or("");
    let userinfo = if password.is_empty() {
        String::new()
    } else if username.is_empty() {
        format!(":{}@", utf8_percent_encode(password, NON_ALPHANUMERIC))
    } else {
        format!(
            "{}:{}@",
            utf8_percent_encode(username, NON_ALPHANUMERIC),
            utf8_percent_encode(password, NON_ALPHANUMERIC)
        )
    };

    Ok(format!("{scheme}://{userinfo}{host}:{port}/{db}"))
}

/// Open a transient async connection for the duration of one command.
async fn open_connection(config: &ConnectionConfig) -> Result<MultiplexedConnection, RedisError> {
    // Resolve an SSH tunnel (if configured) before building the URL — reuse
    // `build_url`'s credential/TLS/db-index logic unchanged by handing it an
    // effective config pointing at the tunnel's local forward address.
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(6379);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port)
        .await
        .map_err(|message| RedisError::new(RedisErrorKind::Network, message))?;
    let mut effective_config = config.clone();
    effective_config.host = Some(host);
    effective_config.port = Some(port);

    let url = build_url(&effective_config)?;
    let client = redis::Client::open(url).map_err(RedisError::from)?;
    tokio::time::timeout(CONNECT_TIMEOUT, client.get_multiplexed_async_connection())
        .await
        .map_err(|_| RedisError::new(RedisErrorKind::Timeout, "Connection to Redis timed out."))?
        .map_err(RedisError::from)
}

// ─── Result shapes (serde camelCase for the TS boundary) ──────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisTestResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

/// One key from a `SCAN` page, enriched with its `TYPE`/`PTTL` (fetched via a
/// single pipelined round trip for the whole page — see `fetch_type_ttl_batch`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyEntry {
    pub key: String,
    pub key_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisScanResult {
    pub entries: Vec<RedisKeyEntry>,
    pub cursor: u64,
    pub done: bool,
}

/// Per-database key counts, parsed from `INFO keyspace`'s `# Keyspace`
/// section (`db0:keys=12482,expires=100,avg_ttl=0`). Redis omits a db's line
/// entirely once it has zero keys — callers fill in `0` for any DB index not
/// present in the returned list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RedisDbInfo {
    pub db_index: u8,
    pub keys: u64,
    pub expires: u64,
}

/// Pure text parser (no I/O) so it's unit-testable without a live server.
pub(crate) fn parse_keyspace_info(info: &str) -> Vec<RedisDbInfo> {
    let mut out = Vec::new();
    for line in info.lines() {
        let Some(rest) = line.strip_prefix("db") else { continue };
        let Some((idx_str, fields)) = rest.split_once(':') else { continue };
        let Ok(db_index) = idx_str.parse::<u8>() else { continue };
        let mut keys = 0u64;
        let mut expires = 0u64;
        for field in fields.trim().split(',') {
            if let Some(v) = field.strip_prefix("keys=") {
                keys = v.parse().unwrap_or(0);
            } else if let Some(v) = field.strip_prefix("expires=") {
                expires = v.parse().unwrap_or(0);
            }
        }
        out.push(RedisDbInfo { db_index, keys, expires });
    }
    out
}

// ─── Health overview / diagnostics support ─────────────────────────────────
//
// The Health module (`commands::health::metrics`/`diagnostics`) needs more
// of `INFO` than the keyspace count above — memory, stats, clients,
// replication, persistence. Rather than issue five separate `INFO <section>`
// round trips, `fetch_info_text` pulls the whole report once and every
// `parse_info_*` below is a pure function over that same text (mirroring
// `parse_keyspace_info`'s "no I/O, unit-testable on a static fixture" shape).
// These stay local to this module rather than returning `health::mod.rs`
// types — this module is deliberately isolated (see the module doc); the
// health layer converts into its own wire types.

/// One `INFO` round trip covering every section (no section argument).
pub(crate) async fn fetch_info_text(config: &ConnectionConfig) -> Result<String, RedisError> {
    let mut conn = open_connection(config).await?;
    redis::cmd("INFO").query_async(&mut conn).await.map_err(RedisError::from)
}

/// Flatten every `key:value` line across all sections into a lookup map.
/// Redis field names are unique across sections in practice, so this is
/// simpler than tracking section boundaries for callers that only want a
/// handful of fields from a handful of sections.
fn info_fields(info: &str) -> std::collections::HashMap<&str, &str> {
    info.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim(), v.trim()))
        .collect()
}

fn field_u64(fields: &std::collections::HashMap<&str, &str>, key: &str) -> u64 {
    fields.get(key).and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RedisMemoryInfo {
    pub used_memory: u64,
    pub used_memory_rss: u64,
    pub used_memory_peak: u64,
    pub maxmemory: u64,
    pub mem_fragmentation_ratio: f64,
}

pub(crate) fn parse_info_memory(info: &str) -> RedisMemoryInfo {
    let f = info_fields(info);
    RedisMemoryInfo {
        used_memory: field_u64(&f, "used_memory"),
        used_memory_rss: field_u64(&f, "used_memory_rss"),
        used_memory_peak: field_u64(&f, "used_memory_peak"),
        maxmemory: field_u64(&f, "maxmemory"),
        mem_fragmentation_ratio: f.get("mem_fragmentation_ratio").and_then(|v| v.parse().ok()).unwrap_or(1.0),
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RedisStatsInfo {
    pub instantaneous_ops_per_sec: u64,
    pub keyspace_hits: u64,
    pub keyspace_misses: u64,
    pub expired_keys: u64,
    pub evicted_keys: u64,
    pub rejected_connections: u64,
}

pub(crate) fn parse_info_stats(info: &str) -> RedisStatsInfo {
    let f = info_fields(info);
    RedisStatsInfo {
        instantaneous_ops_per_sec: field_u64(&f, "instantaneous_ops_per_sec"),
        keyspace_hits: field_u64(&f, "keyspace_hits"),
        keyspace_misses: field_u64(&f, "keyspace_misses"),
        expired_keys: field_u64(&f, "expired_keys"),
        evicted_keys: field_u64(&f, "evicted_keys"),
        rejected_connections: field_u64(&f, "rejected_connections"),
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RedisClientsInfo {
    pub connected_clients: u64,
    pub blocked_clients: u64,
    pub maxclients: u64,
}

pub(crate) fn parse_info_clients(info: &str) -> RedisClientsInfo {
    let f = info_fields(info);
    RedisClientsInfo {
        connected_clients: field_u64(&f, "connected_clients"),
        blocked_clients: field_u64(&f, "blocked_clients"),
        maxclients: field_u64(&f, "maxclients"),
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RedisReplicationInfo {
    pub role: String,
    pub connected_slaves: u64,
    pub master_repl_offset: Option<u64>,
}

pub(crate) fn parse_info_replication(info: &str) -> RedisReplicationInfo {
    let f = info_fields(info);
    RedisReplicationInfo {
        role: f.get("role").map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string()),
        connected_slaves: field_u64(&f, "connected_slaves"),
        master_repl_offset: f.get("master_repl_offset").and_then(|v| v.parse().ok()),
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RedisPersistenceInfo {
    pub aof_enabled: bool,
    pub rdb_last_save_time: Option<u64>,
    pub rdb_changes_since_last_save: Option<u64>,
    pub rdb_last_bgsave_status: Option<String>,
    /// Only populated when `aof_enabled` is true — showing an AOF size for a
    /// deployment that doesn't use AOF would be a fabricated metric.
    pub aof_current_size_bytes: Option<u64>,
    pub aof_rewrite_in_progress: Option<bool>,
}

pub(crate) fn parse_info_persistence(info: &str) -> RedisPersistenceInfo {
    let f = info_fields(info);
    let aof_enabled = f.get("aof_enabled").map(|v| *v == "1").unwrap_or(false);
    RedisPersistenceInfo {
        aof_enabled,
        rdb_last_save_time: f.get("rdb_last_save_time").and_then(|v| v.parse().ok()),
        rdb_changes_since_last_save: f.get("rdb_changes_since_last_save").and_then(|v| v.parse().ok()),
        rdb_last_bgsave_status: f.get("rdb_last_bgsave_status").map(|s| s.to_string()),
        aof_current_size_bytes: if aof_enabled { f.get("aof_current_size").and_then(|v| v.parse().ok()) } else { None },
        aof_rewrite_in_progress: if aof_enabled { f.get("aof_rewrite_in_progress").map(|v| *v == "1") } else { None },
    }
}

/// Pipeline `TYPE`+`PTTL` for a whole `SCAN` page in one round trip — avoids
/// N sequential calls just to show Type/TTL columns in the key browser.
/// Non-atomic (no `MULTI`/`EXEC`): this only needs the round-trip batching,
/// not transactional isolation, across a set of already-independent reads.
async fn fetch_type_ttl_batch(
    conn: &mut MultiplexedConnection,
    keys: &[String],
) -> Result<Vec<(String, Option<i64>)>, RedisError> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for key in keys {
        pipe.cmd("TYPE").arg(key);
        pipe.cmd("PTTL").arg(key);
    }
    let raw: Vec<redis::Value> = pipe.query_async(conn).await?;
    let mut out = Vec::with_capacity(keys.len());
    for chunk in raw.chunks(2) {
        let (Some(type_val), Some(ttl_val)) = (chunk.first(), chunk.get(1)) else { continue };
        let key_type: String = redis::from_redis_value(type_val.clone()).unwrap_or_else(|_| "none".to_string());
        let ttl_ms: i64 = redis::from_redis_value(ttl_val.clone()).unwrap_or(-1);
        out.push((key_type, if ttl_ms >= 0 { Some(ttl_ms) } else { None }));
    }
    Ok(out)
}

/// A key's value, tagged by `valueType` so the frontend can pick the right
/// viewer without a second round trip. Deliberately separate from
/// `QueryResultData` — none of these shapes are tabular.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "valueType")]
pub enum RedisValueDto {
    #[serde(rename = "string")]
    String { value: String },
    #[serde(rename = "hash")]
    Hash { entries: Vec<(String, String)> },
    #[serde(rename = "list")]
    List { items: Vec<String>, truncated: bool },
    #[serde(rename = "set")]
    Set { members: Vec<String>, truncated: bool },
    #[serde(rename = "zset")]
    ZSet { members: Vec<(String, f64)>, truncated: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyDetail {
    pub key: String,
    pub key_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<i64>,
    /// `MEMORY USAGE key` — a single, on-demand call for the selected key
    /// only (never run over a whole key list). `None` when the server
    /// doesn't support the command (older Redis, some compatible proxies).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<i64>,
    /// `OBJECT ENCODING key` — same on-demand, tolerate-unsupported rule.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    pub value: RedisValueDto,
}

/// Fetch a key's value given its already-known `TYPE`. Streams and
/// module-backed types aren't browsable yet — surfaced as a clear error
/// rather than a silent empty view.
async fn fetch_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    key_type: &str,
) -> Result<RedisValueDto, RedisError> {
    match key_type {
        "string" => {
            let value: String = redis::cmd("GET").arg(key).query_async(conn).await?;
            Ok(RedisValueDto::String { value })
        }
        "hash" => {
            let flat: Vec<String> = redis::cmd("HGETALL").arg(key).query_async(conn).await?;
            let mut entries: Vec<(String, String)> = flat
                .chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| (c[0].clone(), c[1].clone()))
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(RedisValueDto::Hash { entries })
        }
        "list" => {
            let len: isize = redis::cmd("LLEN").arg(key).query_async(conn).await?;
            let cap = len.min(MAX_COLLECTION_ITEMS);
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg((cap - 1).max(0))
                .query_async(conn)
                .await?;
            Ok(RedisValueDto::List { items, truncated: len > MAX_COLLECTION_ITEMS })
        }
        "set" => {
            let mut members: Vec<String> = redis::cmd("SMEMBERS").arg(key).query_async(conn).await?;
            let deduped: HashSet<&String> = members.iter().collect();
            let truncated = deduped.len() as isize > MAX_COLLECTION_ITEMS;
            members.sort();
            members.truncate(MAX_COLLECTION_ITEMS as usize);
            Ok(RedisValueDto::Set { members, truncated })
        }
        "zset" => {
            let len: isize = redis::cmd("ZCARD").arg(key).query_async(conn).await?;
            let cap = len.min(MAX_COLLECTION_ITEMS);
            let flat: Vec<String> = redis::cmd("ZRANGE")
                .arg(key)
                .arg(0)
                .arg((cap - 1).max(0))
                .arg("WITHSCORES")
                .query_async(conn)
                .await?;
            let members: Vec<(String, f64)> = flat
                .chunks(2)
                .filter(|c| c.len() == 2)
                .map(|c| (c[0].clone(), c[1].parse::<f64>().unwrap_or(0.0)))
                .collect();
            Ok(RedisValueDto::ZSet { members, truncated: len > MAX_COLLECTION_ITEMS })
        }
        other => Err(RedisError::new(
            RedisErrorKind::Unknown,
            format!(
                "Unsupported Redis value type '{other}'. Streams and module-backed types aren't browsable yet."
            ),
        )),
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Shared by the `#[tauri::command]` wrapper below and
/// `commands::connection::test_connection`'s short-circuit for
/// `engine == "redis"`, which needs a plain `RedisError` (with a readable
/// `.message`) rather than the JSON-encoded string the command boundary uses.
pub(crate) async fn test_connection_impl(config: &ConnectionConfig) -> Result<RedisTestResult, RedisError> {
    let started = std::time::Instant::now();
    let mut conn = open_connection(config).await?;
    let pong: String = redis::cmd("PING").query_async(&mut conn).await?;
    Ok(RedisTestResult {
        success: pong.eq_ignore_ascii_case("PONG"),
        message: format!(
            "Connected to Redis at {}:{}.",
            normalize_host(config.host.clone()),
            config.port.unwrap_or(6379)
        ),
        latency_ms: Some(started.elapsed().as_millis() as u64),
    })
}

#[tauri::command]
pub async fn redis_test_connection(config: ConnectionConfig) -> Result<RedisTestResult, String> {
    test_connection_impl(&config).await.map_err(|e| e.to_json_string())
}

/// `SCAN` with a client-held cursor — never `KEYS *`, which blocks the server
/// on large keyspaces. `cursor: 0` starts a new scan; `done` is true once the
/// server returns cursor `0` again (Redis's own end-of-scan signal). Each
/// page's Type/TTL is fetched via one pipelined round trip
/// (`fetch_type_ttl_batch`), not per-key calls.
#[tauri::command]
pub async fn redis_scan_keys(
    config: ConnectionConfig,
    cursor: u64,
    pattern: Option<String>,
    count: Option<u32>,
) -> Result<RedisScanResult, String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    let match_pattern = pattern
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "*".to_string());
    let batch = count.unwrap_or(200).clamp(1, 1000);

    let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&match_pattern)
        .arg("COUNT")
        .arg(batch)
        .query_async(&mut conn)
        .await
        .map_err(err_str)?;

    let meta = fetch_type_ttl_batch(&mut conn, &keys).await.map_err(|e| e.to_json_string())?;
    let entries = keys
        .into_iter()
        .zip(meta)
        .map(|(key, (key_type, ttl_ms))| RedisKeyEntry { key, key_type, ttl_ms })
        .collect();

    Ok(RedisScanResult { entries, cursor: next_cursor, done: next_cursor == 0 })
}

/// Per-database key counts for the Explorer's "Databases" tree and the key
/// browser's header count — one `INFO keyspace` call, no `DBSIZE`/scan needed.
#[tauri::command]
pub async fn redis_keyspace_info(config: ConnectionConfig) -> Result<Vec<RedisDbInfo>, String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    let info: String = redis::cmd("INFO")
        .arg("keyspace")
        .query_async(&mut conn)
        .await
        .map_err(err_str)?;
    Ok(parse_keyspace_info(&info))
}

#[tauri::command]
pub async fn redis_get_key_detail(config: ConnectionConfig, key: String) -> Result<RedisKeyDetail, String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;

    let key_type: String = redis::cmd("TYPE").arg(&key).query_async(&mut conn).await.map_err(err_str)?;
    if key_type == "none" {
        return Err(RedisError::new(
            RedisErrorKind::NotFound,
            format!("Key '{key}' no longer exists."),
        )
        .to_json_string());
    }

    let ttl_ms: i64 = redis::cmd("PTTL").arg(&key).query_async(&mut conn).await.map_err(err_str)?;
    let ttl_ms = if ttl_ms >= 0 { Some(ttl_ms) } else { None };

    // Single-key, on-demand only (never run over a whole key list — see the
    // module's performance notes). Tolerate the server not supporting either
    // command (older Redis, some compatible proxies) by falling back to
    // `None` rather than failing the whole detail fetch.
    let memory_bytes: Option<i64> = redis::cmd("MEMORY")
        .arg("USAGE")
        .arg(&key)
        .query_async::<i64>(&mut conn)
        .await
        .ok();
    let encoding: Option<String> = redis::cmd("OBJECT")
        .arg("ENCODING")
        .arg(&key)
        .query_async::<String>(&mut conn)
        .await
        .ok();

    let value = fetch_value(&mut conn, &key, &key_type)
        .await
        .map_err(|e| e.to_json_string())?;

    Ok(RedisKeyDetail { key, key_type, ttl_ms, memory_bytes, encoding, value })
}

#[tauri::command]
/// `KEEPTTL` (Redis 6.0+) so editing a string's value doesn't silently clear
/// its expiry — plain `SET` always drops any existing TTL, which would be a
/// surprising side effect of what looks like a value-only edit in the UI.
pub async fn redis_set_string_value(config: ConnectionConfig, key: String, value: String) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("SET").arg(&key).arg(&value).arg("KEEPTTL").exec_async(&mut conn).await.map_err(err_str)
}

#[tauri::command]
pub async fn redis_set_hash_field(
    config: ConnectionConfig,
    key: String,
    field: String,
    value: String,
) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("HSET")
        .arg(&key)
        .arg(&field)
        .arg(&value)
        .exec_async(&mut conn)
        .await
        .map_err(err_str)
}

/// Used by the "+ New Key" dialog to create a non-empty List key — not a
/// general list editor yet (that's a later phase's inline LPUSH/RPUSH/
/// LPOP/RPOP actions).
#[tauri::command]
pub async fn redis_list_push(config: ConnectionConfig, key: String, value: String, left: bool) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    let cmd_name = if left { "LPUSH" } else { "RPUSH" };
    redis::cmd(cmd_name).arg(&key).arg(&value).exec_async(&mut conn).await.map_err(err_str)
}

/// Used by the "+ New Key" dialog to create a non-empty Set key.
#[tauri::command]
pub async fn redis_set_add(config: ConnectionConfig, key: String, member: String) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("SADD").arg(&key).arg(&member).exec_async(&mut conn).await.map_err(err_str)
}

/// Used by the "+ New Key" dialog to create a non-empty Sorted Set key.
#[tauri::command]
pub async fn redis_zset_add(config: ConnectionConfig, key: String, member: String, score: f64) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("ZADD").arg(&key).arg(score).arg(&member).exec_async(&mut conn).await.map_err(err_str)
}

#[tauri::command]
pub async fn redis_delete_hash_field(config: ConnectionConfig, key: String, field: String) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("HDEL").arg(&key).arg(&field).exec_async(&mut conn).await.map_err(err_str)
}

#[tauri::command]
pub async fn redis_delete_key(config: ConnectionConfig, key: String) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    redis::cmd("DEL").arg(&key).exec_async(&mut conn).await.map_err(err_str)
}

/// `ttl_seconds: None` (or `<= 0`) persists the key (removes its TTL);
/// `Some(secs)` sets a new expiry.
#[tauri::command]
pub async fn redis_set_ttl(config: ConnectionConfig, key: String, ttl_seconds: Option<i64>) -> Result<(), String> {
    let mut conn = open_connection(&config).await.map_err(|e| e.to_json_string())?;
    match ttl_seconds {
        Some(secs) if secs > 0 => {
            redis::cmd("EXPIRE").arg(&key).arg(secs).exec_async(&mut conn).await.map_err(err_str)
        }
        _ => redis::cmd("PERSIST").arg(&key).exec_async(&mut conn).await.map_err(err_str),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            name: "test".into(),
            engine: "redis".into(),
            host: Some("localhost".into()),
            port: Some(6379),
            database: None,
            username: None,
            password: None,
            ssl_mode: None,
            file_path: None,
            cf_account_id: None,
            cf_api_token: None,
            cf_database_id: None,
            scope_database: None,
            include_system_schemas: None,
            redis_db_index: None,
            ssh: None,
            mongo_auth_source: None,
            mongo_replica_set: None,
            mongo_connection_string: None,
        }
    }

    #[test]
    fn build_url_plain() {
        let url = build_url(&base_config()).unwrap();
        assert_eq!(url, "redis://127.0.0.1:6379/0");
    }

    #[test]
    fn build_url_with_password_only() {
        let mut cfg = base_config();
        cfg.password = Some("p@ss/word".into());
        let url = build_url(&cfg).unwrap();
        assert!(url.starts_with("redis://:"));
        assert!(url.contains("@127.0.0.1:6379/0"));
        assert!(!url.contains('@') || url.matches('@').count() == 1);
    }

    #[test]
    fn build_url_with_user_and_tls() {
        let mut cfg = base_config();
        cfg.username = Some("app".into());
        cfg.password = Some("secret".into());
        cfg.ssl_mode = Some("require".into());
        cfg.redis_db_index = Some(3);
        let url = build_url(&cfg).unwrap();
        assert_eq!(url, "rediss://app:secret@127.0.0.1:6379/3");
    }

    #[test]
    fn build_url_rejects_empty_host() {
        let mut cfg = base_config();
        // An explicit empty string (as opposed to `None`, which
        // `normalize_host` defaults to the loopback address) is rejected.
        cfg.host = Some("".into());
        assert!(matches!(build_url(&cfg), Err(e) if matches!(e.kind, RedisErrorKind::Config)));
    }

    #[test]
    fn parse_keyspace_info_multiple_dbs() {
        let info = "# Keyspace\r\ndb0:keys=12482,expires=100,avg_ttl=0\r\ndb3:keys=4,expires=0,avg_ttl=0\r\n";
        let dbs = parse_keyspace_info(info);
        assert_eq!(dbs.len(), 2);
        assert_eq!(dbs[0], RedisDbInfo { db_index: 0, keys: 12482, expires: 100 });
        assert_eq!(dbs[1], RedisDbInfo { db_index: 3, keys: 4, expires: 0 });
    }

    #[test]
    fn parse_keyspace_info_empty_keyspace() {
        // No db lines at all — every logical DB is empty.
        let info = "# Keyspace\r\n";
        assert!(parse_keyspace_info(info).is_empty());
    }

    #[test]
    fn parse_keyspace_info_ignores_other_sections() {
        let info = "# Server\r\nredis_version:7.4.1\r\n# Keyspace\r\ndb0:keys=1,expires=0,avg_ttl=0\r\n";
        let dbs = parse_keyspace_info(info);
        assert_eq!(dbs, vec![RedisDbInfo { db_index: 0, keys: 1, expires: 0 }]);
    }

    // ─── INFO section parsers (Health overview/diagnostics) ────────────────

    const SAMPLE_INFO: &str = "\
# Server\r\nredis_version:7.4.1\r\n\
# Clients\r\nconnected_clients:12\r\nblocked_clients:2\r\nmaxclients:10000\r\n\
# Memory\r\nused_memory:1048576\r\nused_memory_rss:2097152\r\nused_memory_peak:3145728\r\nmaxmemory:0\r\nmem_fragmentation_ratio:2.00\r\n\
# Stats\r\ninstantaneous_ops_per_sec:842\r\nkeyspace_hits:900\r\nkeyspace_misses:100\r\nexpired_keys:5\r\nevicted_keys:3\r\nrejected_connections:0\r\n\
# Replication\r\nrole:master\r\nconnected_slaves:1\r\nmaster_repl_offset:12345\r\n\
# Persistence\r\naof_enabled:0\r\nrdb_changes_since_last_save:10\r\nrdb_last_save_time:1700000000\r\nrdb_last_bgsave_status:ok\r\naof_current_size:999\r\naof_rewrite_in_progress:0\r\n\
# Keyspace\r\ndb0:keys=5,expires=1,avg_ttl=0\r\n";

    #[test]
    fn parse_info_memory_reads_fields() {
        let m = parse_info_memory(SAMPLE_INFO);
        assert_eq!(m.used_memory, 1_048_576);
        assert_eq!(m.used_memory_rss, 2_097_152);
        assert_eq!(m.maxmemory, 0);
        assert_eq!(m.mem_fragmentation_ratio, 2.0);
    }

    #[test]
    fn parse_info_stats_reads_fields() {
        let s = parse_info_stats(SAMPLE_INFO);
        assert_eq!(s.instantaneous_ops_per_sec, 842);
        assert_eq!(s.keyspace_hits, 900);
        assert_eq!(s.keyspace_misses, 100);
        assert_eq!(s.evicted_keys, 3);
    }

    #[test]
    fn parse_info_clients_reads_fields() {
        let c = parse_info_clients(SAMPLE_INFO);
        assert_eq!(c.connected_clients, 12);
        assert_eq!(c.blocked_clients, 2);
        assert_eq!(c.maxclients, 10000);
    }

    #[test]
    fn parse_info_replication_reads_fields() {
        let r = parse_info_replication(SAMPLE_INFO);
        assert_eq!(r.role, "master");
        assert_eq!(r.connected_slaves, 1);
        assert_eq!(r.master_repl_offset, Some(12345));
    }

    #[test]
    fn parse_info_persistence_hides_aof_fields_when_disabled() {
        let p = parse_info_persistence(SAMPLE_INFO);
        assert!(!p.aof_enabled);
        assert_eq!(p.rdb_last_bgsave_status, Some("ok".to_string()));
        assert_eq!(p.rdb_changes_since_last_save, Some(10));
        // AOF is disabled in the fixture — its fields must not be surfaced
        // even though `aof_current_size`/`aof_rewrite_in_progress` are present
        // in the raw text (Redis still reports stale/zero values for them).
        assert_eq!(p.aof_current_size_bytes, None);
        assert_eq!(p.aof_rewrite_in_progress, None);
    }

    #[test]
    fn parse_info_persistence_surfaces_aof_fields_when_enabled() {
        let info = SAMPLE_INFO.replace("aof_enabled:0", "aof_enabled:1");
        let p = parse_info_persistence(&info);
        assert!(p.aof_enabled);
        assert_eq!(p.aof_current_size_bytes, Some(999));
        assert_eq!(p.aof_rewrite_in_progress, Some(false));
    }

    // ─── Live integration tests ─────────────────────────────────────────────
    // Require real Redis servers from the repo's `docker-compose.yml`
    // (`docker compose up -d redis redis-auth`) seeded per
    // `scripts/test-redis-docker.sh`. Excluded from the default `cargo test`
    // run — no live-server dependency belongs in the normal suite — run via
    // `cargo test -- --ignored --test-threads=1` (the script does this for
    // you). `--test-threads=1` matters: these tests share one live, mutable
    // keyset, so running them concurrently races on shared keys.

    #[tokio::test]
    #[ignore]
    async fn live_scan_and_value_types() {
        let cfg = base_config(); // localhost:6379, no auth

        let ping = test_connection_impl(&cfg).await.expect("ping should succeed");
        assert!(ping.success, "ping should succeed: {:?}", ping);

        let scan = redis_scan_keys(cfg.clone(), 0, None, None).await.unwrap();
        assert_eq!(scan.entries.len(), 5, "expected 5 seeded keys, got {:?}", scan.entries);
        assert!(scan.done);
        let greeting_entry = scan.entries.iter().find(|e| e.key == "greeting").expect("greeting should be scanned");
        assert_eq!(greeting_entry.key_type, "string");
        assert!(greeting_entry.ttl_ms.is_some(), "greeting is seeded with a TTL");
        let mylist_entry = scan.entries.iter().find(|e| e.key == "mylist").expect("mylist should be scanned");
        assert_eq!(mylist_entry.key_type, "list");
        assert!(mylist_entry.ttl_ms.is_none(), "mylist is seeded with no TTL");

        let s = redis_get_key_detail(cfg.clone(), "greeting".into()).await.unwrap();
        assert_eq!(s.key_type, "string");
        assert!(s.ttl_ms.is_some());
        assert!(matches!(s.value, RedisValueDto::String { ref value } if value == "hello world"));

        let h = redis_get_key_detail(cfg.clone(), "user:1".into()).await.unwrap();
        assert!(matches!(h.value, RedisValueDto::Hash { ref entries } if entries.contains(&("name".to_string(), "Ada".to_string()))));

        let l = redis_get_key_detail(cfg.clone(), "mylist".into()).await.unwrap();
        assert!(matches!(l.value, RedisValueDto::List { ref items, .. } if items == &vec!["a".to_string(), "b".to_string(), "c".to_string()]));

        let st = redis_get_key_detail(cfg.clone(), "myset".into()).await.unwrap();
        assert!(matches!(st.value, RedisValueDto::Set { ref members, .. } if members.len() == 3));

        let z = redis_get_key_detail(cfg.clone(), "myzset".into()).await.unwrap();
        assert!(matches!(z.value, RedisValueDto::ZSet { ref members, .. } if members == &vec![("alice".to_string(), 1.0), ("bob".to_string(), 2.0)]));

        // Pattern filtering.
        let filtered = redis_scan_keys(cfg.clone(), 0, Some("user:*".into()), None).await.unwrap();
        assert_eq!(filtered.entries.iter().map(|e| e.key.clone()).collect::<Vec<_>>(), vec!["user:1".to_string()]);

        // Error path: unknown key.
        let err = redis_get_key_detail(cfg.clone(), "nope-not-here".into()).await;
        assert!(err.is_err());

        // MEMORY USAGE / OBJECT ENCODING are populated for a real key
        // (specific values are server/version-dependent, so just assert
        // they came back rather than pinning exact numbers).
        assert!(s.memory_bytes.is_some(), "memory_bytes should be populated for an existing key");
        assert!(s.encoding.is_some(), "encoding should be populated for an existing key");
    }

    #[tokio::test]
    #[ignore]
    async fn live_keyspace_info_and_new_collection_writes() {
        let cfg = base_config();

        let dbs = redis_keyspace_info(cfg.clone()).await.unwrap();
        let db0 = dbs.iter().find(|d| d.db_index == 0).expect("db0 should have the 5 seeded keys");
        assert!(db0.keys >= 5, "expected at least the 5 seeded keys in db0, got {}", db0.keys);

        // List/Set/ZSet creation writes — used by the "+ New Key" dialog.
        // Each mutates a throwaway key so the fixed seed set stays intact.
        redis_list_push(cfg.clone(), "scratch:list".into(), "first".into(), false).await.unwrap();
        let l = redis_get_key_detail(cfg.clone(), "scratch:list".into()).await.unwrap();
        assert!(matches!(l.value, RedisValueDto::List { ref items, .. } if items == &vec!["first".to_string()]));

        redis_set_add(cfg.clone(), "scratch:set".into(), "member-a".into()).await.unwrap();
        let s = redis_get_key_detail(cfg.clone(), "scratch:set".into()).await.unwrap();
        assert!(matches!(s.value, RedisValueDto::Set { ref members, .. } if members == &vec!["member-a".to_string()]));

        redis_zset_add(cfg.clone(), "scratch:zset".into(), "member-a".into(), 4.5).await.unwrap();
        let z = redis_get_key_detail(cfg.clone(), "scratch:zset".into()).await.unwrap();
        assert!(matches!(z.value, RedisValueDto::ZSet { ref members, .. } if members == &vec![("member-a".to_string(), 4.5)]));

        redis_delete_key(cfg.clone(), "scratch:list".into()).await.unwrap();
        redis_delete_key(cfg.clone(), "scratch:set".into()).await.unwrap();
        redis_delete_key(cfg.clone(), "scratch:zset".into()).await.unwrap();
    }

    #[tokio::test]
    #[ignore]
    async fn live_write_path_string_hash_ttl_delete() {
        let cfg = base_config();

        redis_set_string_value(cfg.clone(), "greeting".into(), "updated".into()).await.unwrap();
        let s2 = redis_get_key_detail(cfg.clone(), "greeting".into()).await.unwrap();
        assert!(matches!(s2.value, RedisValueDto::String { ref value } if value == "updated"));
        // Restore, so the seed data is stable across repeated runs of this test.
        redis_set_string_value(cfg.clone(), "greeting".into(), "hello world".into()).await.unwrap();

        redis_set_hash_field(cfg.clone(), "user:1".into(), "role".into(), "admin".into()).await.unwrap();
        let h2 = redis_get_key_detail(cfg.clone(), "user:1".into()).await.unwrap();
        assert!(matches!(h2.value, RedisValueDto::Hash { ref entries } if entries.contains(&("role".to_string(), "admin".to_string()))));

        redis_delete_hash_field(cfg.clone(), "user:1".into(), "role".into()).await.unwrap();
        let h3 = redis_get_key_detail(cfg.clone(), "user:1".into()).await.unwrap();
        assert!(matches!(h3.value, RedisValueDto::Hash { ref entries } if !entries.iter().any(|(f, _)| f == "role")));

        redis_set_ttl(cfg.clone(), "mylist".into(), Some(120)).await.unwrap();
        let l2 = redis_get_key_detail(cfg.clone(), "mylist".into()).await.unwrap();
        assert!(l2.ttl_ms.unwrap() <= 120_000 && l2.ttl_ms.unwrap() > 0);

        redis_set_ttl(cfg.clone(), "mylist".into(), None).await.unwrap();
        let l3 = redis_get_key_detail(cfg.clone(), "mylist".into()).await.unwrap();
        assert!(l3.ttl_ms.is_none());

        // Delete a throwaway key created solely for this assertion, so the
        // fixed 5-key seed set stays intact for `live_scan_and_value_types`.
        redis_set_string_value(cfg.clone(), "scratch:delete-me".into(), "x".into()).await.unwrap();
        redis_delete_key(cfg.clone(), "scratch:delete-me".into()).await.unwrap();
        let deleted = redis_get_key_detail(cfg.clone(), "scratch:delete-me".into()).await;
        assert!(deleted.is_err());
    }

    #[tokio::test]
    #[ignore]
    async fn live_auth_required_server() {
        let mut cfg = base_config();
        cfg.port = Some(6380);

        // No credentials — the server requires a password, so this must fail
        // with an Auth-classified error, not hang or silently succeed.
        let unauthed = test_connection_impl(&cfg).await;
        assert!(unauthed.is_err(), "expected auth failure without a password");

        // Correct password (and exercising the plain-password userinfo path
        // in build_url, no ACL username).
        cfg.password = Some("rdSQL_dev_Passw0rd!".into());
        let authed = test_connection_impl(&cfg).await.expect("ping should succeed with the right password");
        assert!(authed.success);

        // Wrong password — must fail, not silently connect.
        cfg.password = Some("wrong-password".into());
        let wrong = test_connection_impl(&cfg).await;
        assert!(wrong.is_err(), "expected auth failure with a wrong password");
    }
}
