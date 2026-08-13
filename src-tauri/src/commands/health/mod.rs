//! Database Health, Diagnostics, Repair & Monitoring.
//!
//! This module adds a lightweight, engine-aware database administration layer
//! to RDSQL: an overview/dashboard, a diagnostic engine, a safe preview→confirm
//! repair center, and live + historical monitoring.
//!
//! Architecture follows the existing RDSQL pattern: there is **no** connection
//! pool or trait abstraction. Each public command dispatches on
//! `config.engine` via a `match`, reusing the same per-driver connect helpers
//! used by `commands::query` and `commands::connection`. The wire types below
//! are shared across all health commands and mirror the frontend TS types in
//! `src/core/domain/health.ts`.

pub mod connection;
pub mod diagnostics;
pub mod metrics;
pub mod repair;
pub mod score;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ───────────────────────── Severity / categories ─────────────────────────

/// Diagnostic severity. Serialized as lowercase to match the frontend union.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

/// Logical group a diagnostic check belongs to.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticCategory {
    Connection,
    Schema,
    Tables,
    Indexes,
    Constraints,
    ForeignKeys,
    Performance,
    Storage,
    Maintenance,
    Replication,
}

/// Risk classification for a generated repair plan. `Dangerous` operations
/// (DROP INDEX, DELETE, table rebuilds, schema changes) require a stronger
/// confirmation in the UI and a backup recommendation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    Safe,
    Dangerous,
}

// ───────────────────────── Diagnostics ─────────────────────────

/// One finding produced by a diagnostic check. `details` carries free-form,
/// human-readable key/value pairs (e.g. `current: 9842`, `max: 9917`) for the
/// UI to render verbatim. Never put credentials here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticResult {
    pub id: String,
    pub category: DiagnosticCategory,
    pub severity: Severity,
    pub title: String,
    pub description: String,
    pub affected_objects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommendation: Option<String>,
    pub can_auto_repair: bool,
    /// Stable key (e.g. `postgres.seq_sync`) the repair layer uses to generate
    /// the right SQL. Only set when `can_auto_repair` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_action: Option<String>,
    /// Free-form details for the UI (current/max values, sizes, …). No secrets.
    #[serde(skip_serializing_if = "HashMap::is_empty", default)]
    pub details: HashMap<String, String>,
}

/// Which check groups a `run_diagnostics` call should execute. The frontend
/// passes `heavy: false` during automatic health refresh and `heavy: true` for
/// an explicit "Run Diagnose".
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticOptions {
    /// When false, skip expensive checks (integrity scans, bloat analysis,
    /// corruption checks). Lightweight metadata checks still run.
    #[serde(default)]
    pub heavy: bool,
}

// ───────────────────────── Repair ─────────────────────────

/// A previewed, ready-to-execute repair. Built by the backend from a
/// `DiagnosticResult`; the frontend shows `sql` to the user before executing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPlan {
    pub diagnostic_id: String,
    pub title: String,
    /// Each statement is executed separately, in order.
    pub sql: Vec<String>,
    pub affected_objects: Vec<String>,
    pub risk_level: RiskLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_affected_rows: Option<u64>,
    pub requires_backup: bool,
    /// Optional verification SQL run after the repair to confirm it worked.
    /// Its first-row, first-column scalar result is returned to the UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_sql: Option<String>,
}

/// Payload sent by the frontend to preview a repair. Carries the diagnostic
/// and any engine-specific context (e.g. resolved sequence name, schema/table)
/// needed to generate SQL without re-querying.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepairRequest {
    pub diagnostic_id: String,
    pub repair_action: String,
    pub affected_objects: Vec<String>,
    #[serde(default)]
    pub details: HashMap<String, String>,
}

/// Outcome of an executed repair.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairResult {
    pub diagnostic_id: String,
    pub success: bool,
    pub executed_sql: Vec<String>,
    pub affected_rows: u64,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// First-cell of the verification query, rendered as a string for the UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
}

// ───────────────────────── Overview / Health report ─────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseOverview {
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub database_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub connection_status: String,
    pub latency_ms: u64,
    pub size_bytes: u64,
    pub schema_count: u64,
    pub table_count: u64,
    pub view_count: u64,
    pub index_count: u64,
    pub sequence_count: u64,
    pub constraint_count: u64,
    /// Estimated row count across all tables, when cheap to compute.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    /// Epoch millis of the last diagnostic run (tracked client-side).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_diagnostic_time: Option<u64>,
    /// Epoch millis of the last successful repair (tracked client-side).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_maintenance_time: Option<u64>,
    /// Server uptime in seconds (when available — MySQL/Postgres).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
    /// Server-side current timestamp in ISO 8601 (when available).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_time: Option<String>,
    /// Resident memory in use (Mongo `serverStatus.mem.resident`, Redis `used_memory`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_used_bytes: Option<u64>,
    /// Configured memory cap, when the engine enforces one (Redis `maxmemory`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_limit_bytes: Option<u64>,
    /// Live client/connection count (Mongo `connections.current`, Redis `connected_clients`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections_current: Option<u64>,
    /// Remaining connection headroom (Mongo `connections.available`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connections_available: Option<u64>,
    /// Operations/commands per second. Only populated where the engine exposes
    /// a server-computed rate directly (Redis `instantaneous_ops_per_sec`) —
    /// deriving one from cumulative counters would need cross-call state this
    /// module deliberately doesn't keep (see module doc: no connection pool).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops_per_second: Option<f64>,
    /// 0.0–1.0 cache/keyspace hit ratio (Redis `keyspace_hits`/`(hits+misses)`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_ratio: Option<f64>,
    /// Redis-only keyspace/replication/persistence snapshot. `None` for every
    /// other engine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redis_info: Option<RedisInfo>,
    /// SQLite-only: `PRAGMA journal_mode` (`delete`, `wal`, `memory`, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_mode: Option<String>,
    /// SQLite-only: `PRAGMA auto_vacuum`, mapped to its label (`none`, `full`,
    /// `incremental`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_vacuum: Option<String>,
}

/// Per-logical-database key counts, parsed from Redis `INFO keyspace`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyspaceDb {
    pub db_index: u32,
    pub keys: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisReplicationInfo {
    pub role: String,
    pub connected_slaves: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_repl_offset: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisPersistenceInfo {
    pub aof_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rdb_last_save_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rdb_changes_since_last_save: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rdb_last_bgsave_status: Option<String>,
    /// Only populated when `aof_enabled` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aof_current_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aof_rewrite_in_progress: Option<bool>,
}

/// The subset of Redis `INFO memory`/`stats`/`clients` that don't already
/// have a home on `DatabaseOverview` (which carries `memoryUsedBytes`/
/// `memoryLimitBytes`/`hitRatio` for the shared overview tiles) — these back
/// the spec's Redis "Memory"/"Performance"/"Clients" detail sections.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisDetail {
    pub memory_rss_bytes: u64,
    pub memory_peak_bytes: u64,
    pub memory_fragmentation_ratio: f64,
    pub blocked_clients: u64,
    pub max_clients: u64,
    pub expired_keys: u64,
    pub evicted_keys: u64,
    pub rejected_connections: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisInfo {
    pub keyspace: Vec<RedisKeyspaceDb>,
    pub replication: RedisReplicationInfo,
    pub persistence: RedisPersistenceInfo,
    pub detail: RedisDetail,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IssueCounts {
    pub info: u64,
    pub warning: u64,
    pub critical: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deduction {
    pub points: u8,
    pub reason: String,
    pub diagnostic_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub category: DiagnosticCategory,
    /// 0–100 for this category.
    pub score: u8,
    pub deductions: Vec<Deduction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Overall 0–100 score.
    pub score: u8,
    /// Roll-up severity derived from the worst issue.
    pub severity: Severity,
    pub breakdown: Vec<ScoreBreakdown>,
    pub issue_counts: IssueCounts,
    pub results: Vec<DiagnosticResult>,
}

// ───────────────────────── Statistics / monitoring ─────────────────────────

/// A single live metric. `None` means "not provided by this engine" — the UI
/// renders an "unsupported" state rather than a fake value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStatistics {
    pub size_bytes: u64,
    pub table_count: u64,
    pub index_count: u64,
    /// Estimated total rows across tables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    pub schema_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_queries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_connections: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_count: Option<u64>,
    /// 0.0–1.0
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_hit_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_query_latency_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_queries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_running_queries: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slow_query_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStat {
    pub schema: Option<String>,
    pub name: String,
    pub row_count: Option<u64>,
    pub data_size_bytes: Option<u64>,
    pub index_size_bytes: Option<u64>,
    pub total_size_bytes: Option<u64>,
    pub index_count: Option<u64>,
    pub foreign_key_count: Option<u64>,
    /// Human-readable "X ago" is computed client-side; this is epoch millis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_analyzed_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStat {
    pub schema: Option<String>,
    pub table: String,
    pub name: String,
    /// btree, hash, gist, … (engine-dependent spelling).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_type: Option<String>,
    pub columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scans: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reads: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writes: Option<u64>,
    /// `valid` | `invalid` | `unknown`.
    pub status: String,
}

/// One row of the activity monitor (a running session/query).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub pid: String,
    /// Human-readable duration label computed backend-side (e.g. "2.4s").
    pub duration_label: String,
    /// Raw duration in seconds, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    /// `None` when the engine does not expose activity (SQLite/D1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<Vec<ActivityRow>>,
    pub supported: bool,
}

/// Auto-increment / sequence metadata for a table, used by the "Reset Auto
/// Increment" action to show the current max and compute the right SQL.
/// `None` fields mean "not applicable / unknown for this engine".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoIncrementMeta {
    /// The auto-incrementing / identity / sequence-backed column name.
    pub column_name: String,
    /// Current MAX(column) across rows, or null when the table is empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_max: Option<i64>,
    /// The next value the auto-increment/sequence would yield, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<i64>,
    /// Postgres sequence name (schema-qualified), when applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence_name: Option<String>,
}

