//! MySQL → PostgreSQL one-time bulk migration wizard.
//!
//! Isolated module, purely additive — reuses `connection::ConnectionConfig`
//! for both endpoints, but owns its own schema introspection (needs the raw
//! `EXTRA` column for auto-increment detection, which the shared schema tree
//! folds into a generic `has_default` flag) and its own bulk loader.
//!
//! Design, in one pass:
//!  - Type mapping and value conversion live in `mysql_pg_types` (pure, unit
//!    tested). This module is the I/O/orchestration layer on top of it.
//!  - The target DDL preview (`pg_migrate_plan_tables`) is user-editable
//!    before `pg_migrate_run`. Rather than trusting an echoed structured
//!    plan back from the frontend, `pg_migrate_run` re-derives the source
//!    column plan from the live MySQL schema, runs the (possibly edited)
//!    DDL text as-is, then introspects the *actual* resulting Postgres
//!    columns and loads only the source columns that still have a
//!    same-named match there. This means a user can freely retype/rename/
//!    drop columns in the preview without the loader falling out of sync.
//!  - Rows stream straight from a MySQL cursor into a Postgres `COPY ...
//!    FROM STDIN` (text format) sink — no intermediate buffering of more
//!    than one write-chunk's worth of rows. Text format (not binary) trades
//!    a little throughput for a lot of correctness: every value's Postgres
//!    text representation is parsed by Postgres's own per-type input
//!    functions instead of us hand-rolling the wire binary encoding for
//!    numeric/date/array/jsonb.
//!  - Postgres's `COPY` is all-or-nothing: a failed or cancelled table is
//!    left with zero rows (nothing partially committed), so a table is
//!    always safe to retry from scratch. Primary key/unique constraints,
//!    auto-increment sequences, and `ANALYZE` are deferred until *after* the
//!    data load (see `mysql_pg_types::build_post_load_sql`) — building an
//!    index while streaming millions of rows in is the dominant cost on big
//!    tables.
//!  - Foreign keys, views, triggers, and ongoing/CDC sync are explicitly out
//!    of scope for v1 — surfaced as a warning, not silently dropped.

use bytes::Bytes;
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_postgres::NoTls;
use mysql_async::prelude::*;
use tokio_util::sync::CancellationToken;

use super::connection::{normalize_host, ConnectionConfig};
use super::error::{from_mysql, from_postgres, DbError, ErrorKind};
use super::mysql_pg_types::{
    build_create_table_sql, build_post_load_sql, escape_copy_field, map_to_postgres,
    mysql_value_to_pg_text, parse_mysql_column_type, PgColumnPlan,
};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// How often (in rows) a progress event fires during a table's COPY — often
/// enough for a responsive progress bar, rare enough not to flood the IPC
/// channel on a multi-million-row table.
const PROGRESS_EVERY: u64 = 2_000;
/// Rows are buffered into one text blob and flushed to the COPY stream once
/// it reaches this size, instead of one `Sink::send` per row.
const FLUSH_THRESHOLD: usize = 64 * 1024;

/// Tracks in-flight migrations by id so `pg_migrate_cancel` can signal them.
/// Same shape as `s3::TransferRegistry` / `query::QueryRegistry`.
#[derive(Clone)]
pub struct MigrationRegistry(pub Arc<Mutex<HashMap<String, CancellationToken>>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlanView {
    pub name: String,
    pub mysql_type: String,
    pub pg_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMigrationPlan {
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<ColumnPlanView>,
    /// User-editable DDL preview. Columns only — see module doc for why
    /// PK/indexes/sequences are applied after the bulk load instead.
    pub create_table_sql: String,
    /// Statements run once this table's data has fully loaded.
    pub post_load_sql: Vec<String>,
    pub warnings: Vec<String>,
    pub row_count_estimate: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRunInput {
    pub schema: Option<String>,
    pub table: String,
    /// The (possibly user-edited) `CREATE TABLE` statement to run against
    /// the target before loading data.
    pub create_table_sql: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRunResult {
    pub schema: Option<String>,
    pub table: String,
    pub rows_migrated: u64,
    pub warnings: Vec<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRunSummary {
    pub tables: Vec<TableRunResult>,
    pub total_rows: u64,
    pub duration_ms: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgress {
    pub migration_id: String,
    pub schema: Option<String>,
    pub table: String,
    pub rows_done: u64,
    pub rows_total: Option<u64>,
    /// "creating" | "copying" | "finalizing" | "done" | "error"
    pub phase: String,
}

fn emit_progress(app: &AppHandle, evt: MigrationProgress) {
    let _ = app.emit("migration_progress", &evt);
}

struct MysqlColumnInfo {
    name: String,
    column_type: String,
    nullable: bool,
    is_primary_key: bool,
    is_auto_increment: bool,
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

async fn mysql_connect(config: &ConnectionConfig) -> Result<(mysql_async::Conn, mysql_async::Pool), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.or_else(|| super::engine::default_port(&config.engine)).unwrap_or(3306);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let pass = config.password.clone().unwrap_or_default();

    let opts = super::query::mysql_opts(host.clone(), port, user, pass, db);
    let pool = mysql_async::Pool::new(opts);
    match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => Ok((c, pool)),
        Ok(Err(e)) => {
            let mut d: DbError = from_mysql(e, None).into();
            d.kind = ErrorKind::Connection;
            Err(d.to_json_string())
        }
        Err(_) => Err(DbError::connection(format!(
            "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
            CONNECT_TIMEOUT.as_secs(), host, port
        ))
        .to_json_string()),
    }
}

async fn pg_connect(config: &ConnectionConfig) -> Result<(tokio_postgres::Client, tokio::task::JoinHandle<()>), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.or_else(|| super::engine::default_port(&config.engine)).unwrap_or(5432);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
    let db = config
        .scope_database
        .clone()
        .filter(|d| !d.is_empty())
        .or_else(|| config.database.clone())
        .unwrap_or_else(|| "postgres".to_string());
    let pass = config.password.clone().unwrap_or_default();

    let conn_str = format!("host={} port={} user={} dbname={} password={}", host, port, user, db, pass);
    let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(&conn_str, NoTls)).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let mut d = from_postgres(e, None);
            d.kind = ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => {
            return Err(DbError::connection(format!(
                "PostgreSQL connection timed out after {}s — check that the server is running on {}:{}",
                CONNECT_TIMEOUT.as_secs(), host, port
            ))
            .to_json_string())
        }
    };
    let task = tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error (migration): {}", e);
        }
    });
    Ok((client, task))
}

fn mysql_table_ident(schema: Option<&str>, table: &str) -> String {
    let q = |s: &str| format!("`{}`", s.replace('`', "``"));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    }
}

fn pg_table_ident(schema: Option<&str>, table: &str) -> String {
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    }
}

/// Read a MySQL table's columns straight from `information_schema`,
/// including `EXTRA` (for auto-increment detection) which the shared schema
/// tree (`connection::fetch_schema_tree_impl`) doesn't expose separately.
async fn fetch_mysql_columns(config: &ConnectionConfig, t: &TableRef) -> Result<Vec<MysqlColumnInfo>, String> {
    let (mut conn, pool) = mysql_connect(config).await?;
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let schema_filter = t.schema.clone().or(db);

    let sql = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, c.EXTRA \
               FROM information_schema.COLUMNS c \
               WHERE c.TABLE_NAME = ? \
                 AND COALESCE(c.TABLE_SCHEMA, DATABASE()) = COALESCE(?, DATABASE()) \
               ORDER BY c.ORDINAL_POSITION";
    let rows: Vec<(String, String, String, String, String)> = conn
        .exec(sql, (t.table.clone(), schema_filter))
        .await
        .map_err(|e| from_mysql(e, Some(sql)).0.to_json_string())?;

    drop(conn);
    let _ = pool.disconnect().await;

    Ok(rows
        .into_iter()
        .map(|(name, column_type, is_nullable, column_key, extra)| MysqlColumnInfo {
            name,
            column_type,
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            is_primary_key: column_key == "PRI",
            is_auto_increment: extra.to_lowercase().contains("auto_increment"),
        })
        .collect())
}

async fn fetch_mysql_row_estimate(config: &ConnectionConfig, t: &TableRef) -> Option<u64> {
    let (mut conn, pool) = mysql_connect(config).await.ok()?;
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let schema_filter = t.schema.clone().or(db);
    let sql = "SELECT COALESCE(TABLE_ROWS, 0) FROM information_schema.TABLES \
               WHERE TABLE_NAME = ? AND COALESCE(TABLE_SCHEMA, DATABASE()) = COALESCE(?, DATABASE())";
    let result: Option<(u64,)> = conn.exec_first(sql, (t.table.clone(), schema_filter)).await.ok()?;
    drop(conn);
    let _ = pool.disconnect().await;
    result.map(|(n,)| n)
}

async fn fetch_pg_columns(client: &tokio_postgres::Client, schema: Option<&str>, table: &str) -> Result<Vec<String>, String> {
    let sql = "SELECT column_name FROM information_schema.columns \
               WHERE table_name = $1 AND table_schema = COALESCE($2, 'public') \
               ORDER BY ordinal_position";
    let schema_owned = schema.map(|s| s.to_string());
    let rows = client
        .query(sql, &[&table, &schema_owned])
        .await
        .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

/// Split a SQL script on top-level semicolons, respecting single-quoted
/// string literals (with standard `''` escaping) — mirrors
/// `src/core/backup/backupSql.ts`'s `splitSqlStatements` so the DDL preview
/// can contain more than one statement (e.g. a user-added `COMMENT ON`).
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        current.push(ch);
        if ch == '\'' {
            if in_string && chars.get(i + 1) == Some(&'\'') {
                current.push('\'');
                i += 2;
                continue;
            }
            in_string = !in_string;
        } else if ch == ';' && !in_string {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                statements.push(trimmed);
            }
            current.clear();
        }
        i += 1;
    }
    let tail = current.trim().to_string();
    if !tail.is_empty() {
        statements.push(tail);
    }
    statements
}

fn expected_pg_confirm_token(target: &ConnectionConfig) -> String {
    target
        .scope_database
        .clone()
        .filter(|d| !d.is_empty())
        .or_else(|| target.database.clone())
        .unwrap_or_else(|| target.name.clone())
}

// ---------------------------------------------------------------------------
// Plan (dry run)
// ---------------------------------------------------------------------------

async fn plan_one_table(source: &ConnectionConfig, t: &TableRef) -> Result<TableMigrationPlan, String> {
    let cols = fetch_mysql_columns(source, t).await?;
    if cols.is_empty() {
        return Err(DbError::app(format!("Table `{}` has no columns (or doesn't exist).", t.table)).to_json_string());
    }

    let mut plans: Vec<PgColumnPlan> = Vec::new();
    let mut warnings = Vec::new();
    for c in &cols {
        let shape = parse_mysql_column_type(&c.column_type);
        let plan = map_to_postgres(&c.name, &shape, c.nullable, c.is_primary_key, c.is_auto_increment);
        if let Some(w) = &plan.warning {
            warnings.push(w.clone());
        }
        plans.push(plan);
    }
    warnings.push(
        "Foreign keys are not migrated automatically — add them manually on the target after migration.".to_string(),
    );

    let create_table_sql = build_create_table_sql(t.schema.as_deref(), &t.table, &plans);
    let post_load_sql = build_post_load_sql(t.schema.as_deref(), &t.table, &plans);
    let row_count_estimate = fetch_mysql_row_estimate(source, t).await;

    let columns = plans
        .iter()
        .zip(cols.iter())
        .map(|(p, c)| ColumnPlanView {
            name: p.name.clone(),
            mysql_type: c.column_type.clone(),
            pg_type: p.pg_type.clone(),
            nullable: p.nullable,
            is_primary_key: p.is_primary_key,
            is_auto_increment: p.is_auto_increment,
        })
        .collect();

    Ok(TableMigrationPlan {
        schema: t.schema.clone(),
        table: t.table.clone(),
        columns,
        create_table_sql,
        post_load_sql,
        warnings,
        row_count_estimate,
    })
}

fn require_mysql_source(config: &ConnectionConfig) -> Result<(), String> {
    if super::engine::engine_family(&config.engine) != super::engine::EngineFamily::Mysql {
        return Err(DbError::app("The migration source must be a MySQL-family connection.").to_json_string());
    }
    Ok(())
}

fn require_postgres_target(config: &ConnectionConfig) -> Result<(), String> {
    if super::engine::engine_family(&config.engine) != super::engine::EngineFamily::Postgres {
        return Err(DbError::app("The migration target must be a PostgreSQL-family connection.").to_json_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn pg_migrate_plan_tables(
    source: ConnectionConfig,
    target: ConnectionConfig,
    tables: Vec<TableRef>,
) -> Result<Vec<TableMigrationPlan>, String> {
    require_mysql_source(&source)?;
    require_postgres_target(&target)?;

    let mut plans = Vec::new();
    for t in &tables {
        plans.push(plan_one_table(&source, t).await?);
    }
    Ok(plans)
}

// ---------------------------------------------------------------------------
// Run (the actual migration)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pg_migrate_run(
    migration_id: String,
    source: ConnectionConfig,
    target: ConnectionConfig,
    tables: Vec<TableRunInput>,
    confirm_token: String,
    app: AppHandle,
    registry: State<'_, MigrationRegistry>,
) -> Result<MigrationRunSummary, String> {
    require_mysql_source(&source)?;
    require_postgres_target(&target)?;

    let expected = expected_pg_confirm_token(&target);
    if !expected.eq_ignore_ascii_case(confirm_token.trim()) {
        return Err(DbError::app(format!(
            "Confirmation token does not match the target database name (\"{}\"). Migration aborted — nothing was written.",
            expected
        ))
        .to_json_string());
    }

    let token = CancellationToken::new();
    {
        let mut map = registry.0.lock().await;
        map.insert(migration_id.clone(), token.clone());
    }

    let start = Instant::now();
    let mut results = Vec::new();
    let mut total_rows: u64 = 0;
    let mut cancelled = false;

    for t in &tables {
        if token.is_cancelled() {
            cancelled = true;
            break;
        }
        let table_start = Instant::now();
        emit_progress(&app, MigrationProgress {
            migration_id: migration_id.clone(),
            schema: t.schema.clone(),
            table: t.table.clone(),
            rows_done: 0,
            rows_total: None,
            phase: "creating".to_string(),
        });

        match migrate_one_table(&source, &target, t, &app, &migration_id, &token).await {
            Ok((rows, warnings)) => {
                total_rows += rows;
                emit_progress(&app, MigrationProgress {
                    migration_id: migration_id.clone(),
                    schema: t.schema.clone(),
                    table: t.table.clone(),
                    rows_done: rows,
                    rows_total: Some(rows),
                    phase: "done".to_string(),
                });
                results.push(TableRunResult {
                    schema: t.schema.clone(),
                    table: t.table.clone(),
                    rows_migrated: rows,
                    warnings,
                    error: None,
                    duration_ms: table_start.elapsed().as_millis() as u64,
                });
            }
            Err(e) => {
                emit_progress(&app, MigrationProgress {
                    migration_id: migration_id.clone(),
                    schema: t.schema.clone(),
                    table: t.table.clone(),
                    rows_done: 0,
                    rows_total: None,
                    phase: "error".to_string(),
                });
                // One bad table doesn't block the rest — mirrors
                // apply_schema_sync's per-statement error collection.
                results.push(TableRunResult {
                    schema: t.schema.clone(),
                    table: t.table.clone(),
                    rows_migrated: 0,
                    warnings: Vec::new(),
                    error: Some(e),
                    duration_ms: table_start.elapsed().as_millis() as u64,
                });
            }
        }
    }

    {
        let mut map = registry.0.lock().await;
        map.remove(&migration_id);
    }

    Ok(MigrationRunSummary {
        tables: results,
        total_rows,
        duration_ms: start.elapsed().as_millis() as u64,
        cancelled,
    })
}

#[tauri::command]
pub async fn pg_migrate_cancel(migration_id: String, registry: State<'_, MigrationRegistry>) -> Result<(), String> {
    let map = registry.0.lock().await;
    if let Some(token) = map.get(&migration_id) {
        token.cancel();
    }
    Ok(())
}

/// The full per-table pipeline: create the target table from the (possibly
/// edited) DDL, stream rows from MySQL into a Postgres `COPY`, then run the
/// deferred post-load statements. Returns `(rows_migrated, warnings)`.
async fn migrate_one_table(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    t: &TableRunInput,
    app: &AppHandle,
    migration_id: &str,
    token: &CancellationToken,
) -> Result<(u64, Vec<String>), String> {
    let tref = TableRef { schema: t.schema.clone(), table: t.table.clone() };
    let mysql_cols = fetch_mysql_columns(source, &tref).await?;
    if mysql_cols.is_empty() {
        return Err(format!("Table `{}` has no columns on the source.", t.table));
    }

    let mut plans: Vec<PgColumnPlan> = Vec::new();
    let mut warnings = Vec::new();
    for c in &mysql_cols {
        let shape = parse_mysql_column_type(&c.column_type);
        let p = map_to_postgres(&c.name, &shape, c.nullable, c.is_primary_key, c.is_auto_increment);
        if let Some(w) = &p.warning {
            warnings.push(w.clone());
        }
        plans.push(p);
    }

    let (pg_client, pg_conn_task) = pg_connect(target).await?;

    for stmt in split_sql_statements(&t.create_table_sql) {
        pg_client
            .execute(&stmt, &[])
            .await
            .map_err(|e| from_postgres(e, Some(&stmt)).to_json_string())?;
    }

    // Load only the source columns that still have a same-named match on the
    // real target table — respects whatever edits the user made to the DDL
    // preview (retyped/renamed/dropped columns) without the loader needing
    // to understand the edit itself.
    let target_cols = fetch_pg_columns(&pg_client, t.schema.as_deref(), &t.table).await?;
    let load_cols: Vec<&PgColumnPlan> = plans
        .iter()
        .filter(|p| target_cols.iter().any(|tc| tc.eq_ignore_ascii_case(&p.name)))
        .collect();
    if load_cols.is_empty() {
        return Err(format!(
            "None of the source columns for `{}` match the target table's columns — nothing to load.",
            t.table
        ));
    }

    let mysql_ident = mysql_table_ident(t.schema.as_deref(), &t.table);
    let select_cols = load_cols
        .iter()
        .map(|c| format!("`{}`", c.name.replace('`', "``")))
        .collect::<Vec<_>>()
        .join(", ");
    let select_sql = format!("SELECT {} FROM {}", select_cols, mysql_ident);

    let pg_ident = pg_table_ident(t.schema.as_deref(), &t.table);
    let copy_cols = load_cols
        .iter()
        .map(|c| format!("\"{}\"", c.name.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(", ");
    let copy_sql = format!("COPY {} ({}) FROM STDIN", pg_ident, copy_cols);

    let sink = pg_client
        .copy_in(&copy_sql)
        .await
        .map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;
    // `CopyInSink` is self-referential (not `Unpin`) — pin it once so
    // `SinkExt::send`/`close` (which require `Unpin`) can be called on it
    // repeatedly below.
    tokio::pin!(sink);

    let (mut mysql_conn, mysql_pool) = mysql_connect(source).await?;
    let mut result_stream = mysql_conn
        .query_iter(&select_sql)
        .await
        .map_err(|e| from_mysql(e, Some(&select_sql)).0.to_json_string())?;

    let mut rows_done: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_THRESHOLD + 4096);
    let mut warned_notes: HashSet<(usize, &'static str)> = HashSet::new();
    let mut failure: Option<String> = None;

    'rows: loop {
        if token.is_cancelled() {
            failure = Some("Cancelled by user".to_string());
            break;
        }
        let row = match result_stream.next().await {
            Ok(Some(r)) => r,
            Ok(None) => break,
            Err(e) => {
                failure = Some(from_mysql(e, Some(&select_sql)).0.to_json_string());
                break;
            }
        };

        for (i, plan) in load_cols.iter().enumerate() {
            if i > 0 {
                buf.push(b'\t');
            }
            match row.as_ref(i) {
                None => buf.extend_from_slice(b"\\N"),
                Some(v) => {
                    let (text, note) = mysql_value_to_pg_text(v, plan);
                    if let Some(n) = note {
                        let tag = match n {
                            super::mysql_pg_types::ConversionNote::ZeroDate => "zero_date",
                            super::mysql_pg_types::ConversionNote::TimeOutOfRange => "time_range",
                        };
                        if warned_notes.insert((i, tag)) {
                            warnings.push(format!("`{}` {}", plan.name, n.message()));
                        }
                    }
                    match text {
                        None => buf.extend_from_slice(b"\\N"),
                        Some(t) => buf.extend_from_slice(&escape_copy_field(&t)),
                    }
                }
            }
        }
        buf.push(b'\n');
        rows_done += 1;

        if buf.len() >= FLUSH_THRESHOLD {
            let chunk = std::mem::replace(&mut buf, Vec::with_capacity(FLUSH_THRESHOLD + 4096));
            if let Err(e) = sink.send(Bytes::from(chunk)).await {
                failure = Some(from_postgres(e, Some(&copy_sql)).to_json_string());
                break 'rows;
            }
        }
        if rows_done % PROGRESS_EVERY == 0 {
            emit_progress(app, MigrationProgress {
                migration_id: migration_id.to_string(),
                schema: t.schema.clone(),
                table: t.table.clone(),
                rows_done,
                rows_total: None,
                phase: "copying".to_string(),
            });
        }
    }

    if failure.is_none() && !buf.is_empty() {
        if let Err(e) = sink.send(Bytes::from(buf)).await {
            failure = Some(from_postgres(e, Some(&copy_sql)).to_json_string());
        }
    }

    drop(result_stream);
    drop(mysql_conn);
    let _ = mysql_pool.disconnect().await;

    if let Some(err) = failure {
        // Dropping the sink without closing it aborts the COPY — Postgres
        // rolls back everything sent so far, so this table is left empty
        // rather than half-loaded, and is always safe to retry.
        drop(sink);
        drop(pg_client);
        drop(pg_conn_task);
        return Err(err);
    }

    sink.close().await.map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;

    emit_progress(app, MigrationProgress {
        migration_id: migration_id.to_string(),
        schema: t.schema.clone(),
        table: t.table.clone(),
        rows_done,
        rows_total: Some(rows_done),
        phase: "finalizing".to_string(),
    });
    for stmt in build_post_load_sql(t.schema.as_deref(), &t.table, &plans) {
        if let Err(e) = pg_client.execute(&stmt, &[]).await {
            warnings.push(format!(
                "Post-load step failed (data is intact): {} — {}",
                stmt,
                from_postgres(e, Some(&stmt)).message
            ));
        }
    }

    drop(pg_client);
    drop(pg_conn_task);

    Ok((rows_done, warnings))
}
