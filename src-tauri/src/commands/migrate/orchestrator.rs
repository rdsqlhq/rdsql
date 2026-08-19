//! Engine-agnostic migration orchestration: schema planning, the four
//! supported source→target pipelines, progress/cancel, and the Tauri
//! command surface.
//!
//! Supported directions (source family × target family): MySQL/PostgreSQL/
//! SQL Server as a source; PostgreSQL/MySQL as a target; source family must
//! differ from target family (same-engine sync is Compare & Sync's job).
//! SQL Server is source-only for now — no `target_sqlserver.rs` exists yet
//! (tiberius does expose a native bulk-insert primitive, `Client::
//! bulk_insert`/`BulkLoadRequest`, whenever it's wanted).
//!
//! Each of the four pipeline functions below (`run_mysql_to_postgres` etc.)
//! is a small, engine-pair-specific glue function — not because the type
//! system wasn't generalized, but because Rust's ownership rules make a
//! fully generic "any source cursor feeding any target writer" loop
//! impractical without unsafe self-referential structs or `async-trait`
//! object overhead: `mysql_async`'s query cursor borrows `&mut Conn` for
//! its own lifetime, so a MySQL connection and its cursor must live in the
//! same stack frame. What IS fully shared across all four pipelines — and
//! what actually would have multiplied into real duplicated logic without
//! this module's design — is the type mapping, DDL generation, and value
//! rendering, all delegated to `canonical.rs`/`source_*.rs`/`target_*.rs`.
//!
//! Streaming notes: the MySQL source (`mysql_async::Conn::query_iter`) and
//! the Postgres target (`COPY ... FROM STDIN`) both genuinely stream —
//! never more than one row/write-chunk is buffered. The Postgres source and
//! SQL Server source currently read a table's full result set into memory
//! (`Client::query`/`into_first_result`) rather than an incrementally
//! streamed cursor — a deliberate, documented v1 limitation (safer to ship
//! than an unverified streaming API guess) rather than a silent gap; fine
//! for small-to-medium tables, worth revisiting for very large ones.

use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::canonical::{split_sql_statements, CanonicalColumn, CanonicalValue, ConversionNote, TableRef};
use super::{source_mssql, source_mysql, source_postgres, target_mysql, target_postgres};
use crate::commands::connection::ConnectionConfig;
use crate::commands::engine::{engine_family, EngineFamily};
use crate::commands::error::{from_mysql, from_postgres, from_tiberius, DbError};

/// Rows are buffered into one text blob and flushed to the Postgres `COPY`
/// stream once it reaches this size, instead of one `Sink::send` per row.
const FLUSH_THRESHOLD: usize = 64 * 1024;
/// How often (in rows) a progress event fires — often enough for a
/// responsive progress bar, rare enough not to flood the IPC channel.
const PROGRESS_EVERY: u64 = 2_000;
/// MySQL-target multi-row `INSERT` batches flush at this row count — a
/// simple, safe heuristic that stays well under any realistic
/// `max_allowed_packet` without needing to measure serialized SQL size.
const MYSQL_BATCH_ROWS: usize = 500;

/// Tracks in-flight migrations by id so `db_migrate_cancel` can signal
/// them. Same shape as `s3::TransferRegistry`/`query::QueryRegistry`.
#[derive(Clone)]
pub struct MigrationRegistry(pub Arc<Mutex<HashMap<String, CancellationToken>>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlanView {
    pub name: String,
    pub native_type: String,
    pub target_type: String,
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
    /// User-editable DDL preview. See `orchestrator`'s design note: target
    /// tables are always created unqualified (no schema prefix) in whatever
    /// database the target connection already points at — mirroring
    /// `stripSchemaQualifiers`'s rationale in `src/core/backup/backupSql.ts`
    /// ("restoring into whatever database the executing connection is
    /// already pointed at").
    pub create_table_sql: String,
    pub post_load_sql: Vec<String>,
    pub warnings: Vec<String>,
    pub row_count_estimate: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRunInput {
    pub schema: Option<String>,
    pub table: String,
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

fn emit_progress(
    app: &AppHandle,
    migration_id: &str,
    schema: &Option<String>,
    table: &str,
    rows_done: u64,
    rows_total: Option<u64>,
    phase: &str,
) {
    let _ = app.emit(
        "migration_progress",
        &MigrationProgress {
            migration_id: migration_id.to_string(),
            schema: schema.clone(),
            table: table.to_string(),
            rows_done,
            rows_total,
            phase: phase.to_string(),
        },
    );
}

fn require_supported_source(config: &ConnectionConfig) -> Result<EngineFamily, String> {
    let fam = engine_family(&config.engine);
    match fam {
        EngineFamily::Mysql | EngineFamily::Postgres | EngineFamily::Mssql => Ok(fam),
        _ => Err(DbError::app("The migration source must be a MySQL, PostgreSQL, or SQL Server connection.").to_json_string()),
    }
}

fn require_supported_target(config: &ConnectionConfig) -> Result<EngineFamily, String> {
    let fam = engine_family(&config.engine);
    match fam {
        EngineFamily::Mysql | EngineFamily::Postgres => Ok(fam),
        _ => Err(DbError::app("The migration target must be a MySQL or PostgreSQL connection.").to_json_string()),
    }
}

fn require_cross_engine(source_fam: EngineFamily, target_fam: EngineFamily) -> Result<(), String> {
    if source_fam == target_fam {
        return Err(DbError::app(
            "Source and target are the same engine family — use Compare & Sync for same-engine synchronization instead.",
        )
        .to_json_string());
    }
    Ok(())
}

fn expected_confirm_token(target: &ConnectionConfig) -> String {
    target
        .scope_database
        .clone()
        .filter(|d| !d.is_empty())
        .or_else(|| target.database.clone())
        .unwrap_or_else(|| target.name.clone())
}

fn target_type_label(fam: EngineFamily, col: &CanonicalColumn) -> String {
    match fam {
        EngineFamily::Postgres => target_postgres::canonical_to_postgres_type(col).0,
        EngineFamily::Mysql => target_mysql::canonical_to_mysql_type(&col.ty),
        _ => col.native_type.clone(),
    }
}

fn build_target_ddl(fam: EngineFamily, table: &str, columns: &[CanonicalColumn]) -> (String, Vec<String>) {
    match fam {
        EngineFamily::Postgres => (
            target_postgres::build_create_table_sql(None, table, columns),
            target_postgres::build_post_load_sql(None, table, columns),
        ),
        EngineFamily::Mysql => (target_mysql::build_create_table_sql(None, table, columns), Vec::new()),
        _ => unreachable!("validated by require_supported_target"),
    }
}

async fn fetch_source_columns(fam: EngineFamily, config: &ConnectionConfig, t: &TableRef) -> Result<Vec<CanonicalColumn>, String> {
    match fam {
        EngineFamily::Mysql => source_mysql::fetch_columns(config, t).await,
        EngineFamily::Postgres => source_postgres::fetch_columns(config, t).await,
        EngineFamily::Mssql => source_mssql::fetch_columns(config, t).await,
        _ => unreachable!("validated by require_supported_source"),
    }
}

async fn fetch_source_row_estimate(fam: EngineFamily, config: &ConnectionConfig, t: &TableRef) -> Option<u64> {
    match fam {
        EngineFamily::Mysql => source_mysql::fetch_row_estimate(config, t).await,
        EngineFamily::Postgres => source_postgres::fetch_row_estimate(config, t).await,
        EngineFamily::Mssql => source_mssql::fetch_row_estimate(config, t).await,
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Plan (dry run)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_migrate_plan_tables(
    source: ConnectionConfig,
    target: ConnectionConfig,
    tables: Vec<TableRef>,
) -> Result<Vec<TableMigrationPlan>, String> {
    let source_fam = require_supported_source(&source)?;
    let target_fam = require_supported_target(&target)?;
    require_cross_engine(source_fam, target_fam)?;

    let mut plans = Vec::new();
    for t in &tables {
        plans.push(plan_one_table(source_fam, &source, target_fam, t).await?);
    }
    Ok(plans)
}

async fn plan_one_table(
    source_fam: EngineFamily,
    source: &ConnectionConfig,
    target_fam: EngineFamily,
    t: &TableRef,
) -> Result<TableMigrationPlan, String> {
    let columns = fetch_source_columns(source_fam, source, t).await?;
    if columns.is_empty() {
        return Err(DbError::app(format!("Table `{}` has no columns (or doesn't exist).", t.table)).to_json_string());
    }

    let mut warnings: Vec<String> = columns.iter().filter_map(|c| c.warning.clone()).collect();
    warnings.push("Foreign keys are not migrated automatically — add them manually on the target after migration.".to_string());

    let (create_table_sql, post_load_sql) = build_target_ddl(target_fam, &t.table, &columns);
    let row_count_estimate = fetch_source_row_estimate(source_fam, source, t).await;

    let column_views = columns
        .iter()
        .map(|c| ColumnPlanView {
            name: c.name.clone(),
            native_type: c.native_type.clone(),
            target_type: target_type_label(target_fam, c),
            nullable: c.nullable,
            is_primary_key: c.is_primary_key,
            is_auto_increment: c.is_auto_increment,
        })
        .collect();

    Ok(TableMigrationPlan {
        schema: t.schema.clone(),
        table: t.table.clone(),
        columns: column_views,
        create_table_sql,
        post_load_sql,
        warnings,
        row_count_estimate,
    })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn db_migrate_run(
    migration_id: String,
    source: ConnectionConfig,
    target: ConnectionConfig,
    tables: Vec<TableRunInput>,
    confirm_token: String,
    app: AppHandle,
    registry: State<'_, MigrationRegistry>,
) -> Result<MigrationRunSummary, String> {
    let source_fam = require_supported_source(&source)?;
    let target_fam = require_supported_target(&target)?;
    require_cross_engine(source_fam, target_fam)?;

    let expected = expected_confirm_token(&target);
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
        emit_progress(&app, &migration_id, &t.schema, &t.table, 0, None, "creating");

        let outcome = match (source_fam, target_fam) {
            (EngineFamily::Mysql, EngineFamily::Postgres) => run_mysql_to_postgres(&source, &target, t, &app, &migration_id, &token).await,
            (EngineFamily::Postgres, EngineFamily::Mysql) => run_postgres_to_mysql(&source, &target, t, &app, &migration_id, &token).await,
            (EngineFamily::Mssql, EngineFamily::Postgres) => run_mssql_to_postgres(&source, &target, t, &app, &migration_id, &token).await,
            (EngineFamily::Mssql, EngineFamily::Mysql) => run_mssql_to_mysql(&source, &target, t, &app, &migration_id, &token).await,
            _ => Err("Unsupported source/target combination.".to_string()),
        };

        match outcome {
            Ok((rows, warnings)) => {
                total_rows += rows;
                emit_progress(&app, &migration_id, &t.schema, &t.table, rows, Some(rows), "done");
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
                emit_progress(&app, &migration_id, &t.schema, &t.table, 0, None, "error");
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

    Ok(MigrationRunSummary { tables: results, total_rows, duration_ms: start.elapsed().as_millis() as u64, cancelled })
}

#[tauri::command]
pub async fn db_migrate_cancel(migration_id: String, registry: State<'_, MigrationRegistry>) -> Result<(), String> {
    let map = registry.0.lock().await;
    if let Some(token) = map.get(&migration_id) {
        token.cancel();
    }
    Ok(())
}

async fn fetch_mysql_target_columns(conn: &mut mysql_async::Conn, table: &str) -> Result<Vec<String>, String> {
    use mysql_async::prelude::*;
    let sql = "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
               WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION";
    conn.exec(sql, (table.to_string(),)).await.map_err(|e| from_mysql(e, Some(sql)).0.to_json_string())
}

// ---------------------------------------------------------------------------
// Pipeline: MySQL → PostgreSQL
// ---------------------------------------------------------------------------

async fn run_mysql_to_postgres(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    t: &TableRunInput,
    app: &AppHandle,
    migration_id: &str,
    token: &CancellationToken,
) -> Result<(u64, Vec<String>), String> {
    use mysql_async::prelude::*;

    let tref = TableRef { schema: t.schema.clone(), table: t.table.clone() };
    let columns = source_mysql::fetch_columns(source, &tref).await?;
    if columns.is_empty() {
        return Err(format!("Table `{}` has no columns on the source.", t.table));
    }
    let mut warnings: Vec<String> = columns.iter().filter_map(|c| c.warning.clone()).collect();

    let (pg_client, pg_task) = target_postgres::connect(target).await?;
    for stmt in split_sql_statements(&t.create_table_sql) {
        pg_client.execute(&stmt, &[]).await.map_err(|e| from_postgres(e, Some(&stmt)).to_json_string())?;
    }
    let existing = target_postgres::fetch_existing_columns(&pg_client, None, &t.table).await?;
    let load_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| existing.iter().any(|e| e.eq_ignore_ascii_case(&c.name))).collect();
    if load_cols.is_empty() {
        return Err(format!("None of the source columns for `{}` match the target table's columns — nothing to load.", t.table));
    }

    let select_cols: Vec<String> = load_cols.iter().map(|c| c.name.clone()).collect();
    let select_sql = source_mysql::select_sql(&tref, &select_cols);
    let copy_cols = load_cols.iter().map(|c| target_postgres::quote_ident(&c.name)).collect::<Vec<_>>().join(", ");
    let copy_sql = format!("COPY {} ({}) FROM STDIN", target_postgres::qualify_table(None, &t.table), copy_cols);

    let sink = pg_client.copy_in(&copy_sql).await.map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;
    tokio::pin!(sink);

    let (mut mysql_conn, mysql_pool) = source_mysql::connect(source).await?;
    let mut result_stream = mysql_conn.query_iter(&select_sql).await.map_err(|e| from_mysql(e, Some(&select_sql)).0.to_json_string())?;

    let mut rows_done: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_THRESHOLD + 4096);
    let mut warned: HashSet<(usize, ConversionNote)> = HashSet::new();
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
        for (i, col) in load_cols.iter().enumerate() {
            if i > 0 {
                buf.push(b'\t');
            }
            let (canonical, note) = match row.as_ref(i) {
                None => (CanonicalValue::Null, None),
                Some(v) => source_mysql::mysql_value_to_canonical(v, &col.ty),
            };
            if let Some(n) = note {
                if warned.insert((i, n)) {
                    warnings.push(format!("`{}` {}", col.name, n.message()));
                }
            }
            match target_postgres::canonical_value_to_pg_text(&canonical) {
                None => buf.extend_from_slice(b"\\N"),
                Some(text) => buf.extend_from_slice(&target_postgres::escape_copy_field(&text)),
            }
        }
        buf.push(b'\n');
        rows_done += 1;

        if buf.len() >= FLUSH_THRESHOLD {
            let chunk = std::mem::replace(&mut buf, Vec::with_capacity(FLUSH_THRESHOLD + 4096));
            if let Err(e) = sink.send(bytes::Bytes::from(chunk)).await {
                failure = Some(from_postgres(e, Some(&copy_sql)).to_json_string());
                break 'rows;
            }
        }
        if rows_done % PROGRESS_EVERY == 0 {
            emit_progress(app, migration_id, &t.schema, &t.table, rows_done, None, "copying");
        }
    }

    if failure.is_none() && !buf.is_empty() {
        if let Err(e) = sink.send(bytes::Bytes::from(buf)).await {
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
        drop(pg_task);
        return Err(err);
    }

    sink.close().await.map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;

    emit_progress(app, migration_id, &t.schema, &t.table, rows_done, Some(rows_done), "finalizing");
    for stmt in target_postgres::build_post_load_sql(None, &t.table, &columns) {
        if let Err(e) = pg_client.execute(&stmt, &[]).await {
            warnings.push(format!("Post-load step failed (data is intact): {} — {}", stmt, from_postgres(e, Some(&stmt)).message));
        }
    }

    drop(pg_client);
    drop(pg_task);
    Ok((rows_done, warnings))
}

// ---------------------------------------------------------------------------
// Pipeline: SQL Server → PostgreSQL
// ---------------------------------------------------------------------------

async fn run_mssql_to_postgres(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    t: &TableRunInput,
    app: &AppHandle,
    migration_id: &str,
    token: &CancellationToken,
) -> Result<(u64, Vec<String>), String> {
    let tref = TableRef { schema: t.schema.clone(), table: t.table.clone() };
    let columns = source_mssql::fetch_columns(source, &tref).await?;
    if columns.is_empty() {
        return Err(format!("Table `{}` has no columns on the source.", t.table));
    }
    let mut warnings: Vec<String> = columns.iter().filter_map(|c| c.warning.clone()).collect();

    let (pg_client, pg_task) = target_postgres::connect(target).await?;
    for stmt in split_sql_statements(&t.create_table_sql) {
        pg_client.execute(&stmt, &[]).await.map_err(|e| from_postgres(e, Some(&stmt)).to_json_string())?;
    }
    let existing = target_postgres::fetch_existing_columns(&pg_client, None, &t.table).await?;
    let load_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| existing.iter().any(|e| e.eq_ignore_ascii_case(&c.name))).collect();
    if load_cols.is_empty() {
        return Err(format!("None of the source columns for `{}` match the target table's columns — nothing to load.", t.table));
    }

    let select_cols: Vec<String> = load_cols.iter().map(|c| c.name.clone()).collect();
    let select_sql = source_mssql::select_sql(&tref, &select_cols);
    let copy_cols = load_cols.iter().map(|c| target_postgres::quote_ident(&c.name)).collect::<Vec<_>>().join(", ");
    let copy_sql = format!("COPY {} ({}) FROM STDIN", target_postgres::qualify_table(None, &t.table), copy_cols);

    let sink = pg_client.copy_in(&copy_sql).await.map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;
    tokio::pin!(sink);

    let mut mssql_client = source_mssql::connect(source, t.schema.as_deref()).await?;
    let rows = mssql_client
        .query(&select_sql, &[])
        .await
        .map_err(|e| from_tiberius(e, Some(&select_sql)).to_json_string())?
        .into_first_result()
        .await
        .map_err(|e| from_tiberius(e, Some(&select_sql)).to_json_string())?;

    let mut rows_done: u64 = 0;
    let mut buf: Vec<u8> = Vec::with_capacity(FLUSH_THRESHOLD + 4096);
    let mut warned: HashSet<(usize, ConversionNote)> = HashSet::new();
    let mut failure: Option<String> = None;

    for row in &rows {
        if token.is_cancelled() {
            failure = Some("Cancelled by user".to_string());
            break;
        }
        for (i, col) in load_cols.iter().enumerate() {
            if i > 0 {
                buf.push(b'\t');
            }
            let (canonical, note) = match row.cells().nth(i) {
                Some((_, data)) => source_mssql::tiberius_value_to_canonical(data, &col.ty),
                None => (CanonicalValue::Null, None),
            };
            if let Some(n) = note {
                if warned.insert((i, n)) {
                    warnings.push(format!("`{}` {}", col.name, n.message()));
                }
            }
            match target_postgres::canonical_value_to_pg_text(&canonical) {
                None => buf.extend_from_slice(b"\\N"),
                Some(text) => buf.extend_from_slice(&target_postgres::escape_copy_field(&text)),
            }
        }
        buf.push(b'\n');
        rows_done += 1;

        if buf.len() >= FLUSH_THRESHOLD {
            let chunk = std::mem::replace(&mut buf, Vec::with_capacity(FLUSH_THRESHOLD + 4096));
            if let Err(e) = sink.send(bytes::Bytes::from(chunk)).await {
                failure = Some(from_postgres(e, Some(&copy_sql)).to_json_string());
                break;
            }
        }
        if rows_done % PROGRESS_EVERY == 0 {
            emit_progress(app, migration_id, &t.schema, &t.table, rows_done, None, "copying");
        }
    }

    if failure.is_none() && !buf.is_empty() {
        if let Err(e) = sink.send(bytes::Bytes::from(buf)).await {
            failure = Some(from_postgres(e, Some(&copy_sql)).to_json_string());
        }
    }

    if let Some(err) = failure {
        drop(sink);
        drop(pg_client);
        drop(pg_task);
        return Err(err);
    }

    sink.close().await.map_err(|e| from_postgres(e, Some(&copy_sql)).to_json_string())?;

    emit_progress(app, migration_id, &t.schema, &t.table, rows_done, Some(rows_done), "finalizing");
    for stmt in target_postgres::build_post_load_sql(None, &t.table, &columns) {
        if let Err(e) = pg_client.execute(&stmt, &[]).await {
            warnings.push(format!("Post-load step failed (data is intact): {} — {}", stmt, from_postgres(e, Some(&stmt)).message));
        }
    }

    drop(pg_client);
    drop(pg_task);
    Ok((rows_done, warnings))
}

// ---------------------------------------------------------------------------
// Pipeline: PostgreSQL → MySQL
// ---------------------------------------------------------------------------

async fn run_postgres_to_mysql(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    t: &TableRunInput,
    app: &AppHandle,
    migration_id: &str,
    token: &CancellationToken,
) -> Result<(u64, Vec<String>), String> {
    use mysql_async::prelude::*;

    let tref = TableRef { schema: t.schema.clone(), table: t.table.clone() };
    let columns = source_postgres::fetch_columns(source, &tref).await?;
    if columns.is_empty() {
        return Err(format!("Table `{}` has no columns on the source.", t.table));
    }
    let mut warnings: Vec<String> = columns.iter().filter_map(|c| c.warning.clone()).collect();

    let (mut mysql_conn, mysql_pool) = source_mysql::connect(target).await?;
    for stmt in split_sql_statements(&t.create_table_sql) {
        mysql_conn.query_drop(&stmt).await.map_err(|e| from_mysql(e, Some(&stmt)).0.to_json_string())?;
    }
    let existing = fetch_mysql_target_columns(&mut mysql_conn, &t.table).await?;
    let load_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| existing.iter().any(|e| e.eq_ignore_ascii_case(&c.name))).collect();
    if load_cols.is_empty() {
        return Err(format!("None of the source columns for `{}` match the target table's columns — nothing to load.", t.table));
    }
    let col_names: Vec<String> = load_cols.iter().map(|c| c.name.clone()).collect();

    let select_sql = source_postgres::select_sql(&tref, &col_names);
    let (pg_client, pg_task) = source_postgres::connect(source).await?;
    let rows = pg_client.query(&select_sql, &[]).await.map_err(|e| from_postgres(e, Some(&select_sql)).to_json_string())?;
    drop(pg_client);
    pg_task.abort();

    mysql_conn.query_drop("START TRANSACTION").await.map_err(|e| from_mysql(e, None).0.to_json_string())?;

    let mut rows_done: u64 = 0;
    let mut batch: Vec<Vec<CanonicalValue>> = Vec::with_capacity(MYSQL_BATCH_ROWS);
    let mut warned: HashSet<(usize, ConversionNote)> = HashSet::new();
    let mut failure: Option<String> = None;

    for row in &rows {
        if token.is_cancelled() {
            failure = Some("Cancelled by user".to_string());
            break;
        }
        let mut values = Vec::with_capacity(load_cols.len());
        for (i, col) in load_cols.iter().enumerate() {
            let text: Option<String> = row.get(i);
            let (canonical, note) = source_postgres::postgres_text_to_canonical(text.as_deref(), &col.ty);
            if let Some(n) = note {
                if warned.insert((i, n)) {
                    warnings.push(format!("`{}` {}", col.name, n.message()));
                }
            }
            values.push(canonical);
        }
        batch.push(values);
        rows_done += 1;

        if batch.len() >= MYSQL_BATCH_ROWS {
            let sql = target_mysql::insert_batch_sql(None, &t.table, &col_names, &batch);
            if let Err(e) = mysql_conn.query_drop(&sql).await {
                failure = Some(from_mysql(e, Some(&sql)).0.to_json_string());
                break;
            }
            batch.clear();
        }
        if rows_done % PROGRESS_EVERY == 0 {
            emit_progress(app, migration_id, &t.schema, &t.table, rows_done, None, "copying");
        }
    }

    if failure.is_none() && !batch.is_empty() {
        let sql = target_mysql::insert_batch_sql(None, &t.table, &col_names, &batch);
        if let Err(e) = mysql_conn.query_drop(&sql).await {
            failure = Some(from_mysql(e, Some(&sql)).0.to_json_string());
        }
    }

    if let Some(err) = failure {
        // Roll back everything sent so far for this table — same
        // all-or-nothing guarantee the Postgres target gets from `COPY`.
        let _ = mysql_conn.query_drop("ROLLBACK").await;
        drop(mysql_conn);
        let _ = mysql_pool.disconnect().await;
        return Err(err);
    }

    mysql_conn.query_drop("COMMIT").await.map_err(|e| from_mysql(e, None).0.to_json_string())?;
    drop(mysql_conn);
    let _ = mysql_pool.disconnect().await;

    Ok((rows_done, warnings))
}

// ---------------------------------------------------------------------------
// Pipeline: SQL Server → MySQL
// ---------------------------------------------------------------------------

async fn run_mssql_to_mysql(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    t: &TableRunInput,
    app: &AppHandle,
    migration_id: &str,
    token: &CancellationToken,
) -> Result<(u64, Vec<String>), String> {
    use mysql_async::prelude::*;

    let tref = TableRef { schema: t.schema.clone(), table: t.table.clone() };
    let columns = source_mssql::fetch_columns(source, &tref).await?;
    if columns.is_empty() {
        return Err(format!("Table `{}` has no columns on the source.", t.table));
    }
    let mut warnings: Vec<String> = columns.iter().filter_map(|c| c.warning.clone()).collect();

    let (mut mysql_conn, mysql_pool) = source_mysql::connect(target).await?;
    for stmt in split_sql_statements(&t.create_table_sql) {
        mysql_conn.query_drop(&stmt).await.map_err(|e| from_mysql(e, Some(&stmt)).0.to_json_string())?;
    }
    let existing = fetch_mysql_target_columns(&mut mysql_conn, &t.table).await?;
    let load_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| existing.iter().any(|e| e.eq_ignore_ascii_case(&c.name))).collect();
    if load_cols.is_empty() {
        return Err(format!("None of the source columns for `{}` match the target table's columns — nothing to load.", t.table));
    }
    let col_names: Vec<String> = load_cols.iter().map(|c| c.name.clone()).collect();

    let select_sql = source_mssql::select_sql(&tref, &col_names);
    let mut mssql_client = source_mssql::connect(source, t.schema.as_deref()).await?;
    let rows = mssql_client
        .query(&select_sql, &[])
        .await
        .map_err(|e| from_tiberius(e, Some(&select_sql)).to_json_string())?
        .into_first_result()
        .await
        .map_err(|e| from_tiberius(e, Some(&select_sql)).to_json_string())?;

    mysql_conn.query_drop("START TRANSACTION").await.map_err(|e| from_mysql(e, None).0.to_json_string())?;

    let mut rows_done: u64 = 0;
    let mut batch: Vec<Vec<CanonicalValue>> = Vec::with_capacity(MYSQL_BATCH_ROWS);
    let mut warned: HashSet<(usize, ConversionNote)> = HashSet::new();
    let mut failure: Option<String> = None;

    for row in &rows {
        if token.is_cancelled() {
            failure = Some("Cancelled by user".to_string());
            break;
        }
        let mut values = Vec::with_capacity(load_cols.len());
        for (i, col) in load_cols.iter().enumerate() {
            let (canonical, note) = match row.cells().nth(i) {
                Some((_, data)) => source_mssql::tiberius_value_to_canonical(data, &col.ty),
                None => (CanonicalValue::Null, None),
            };
            if let Some(n) = note {
                if warned.insert((i, n)) {
                    warnings.push(format!("`{}` {}", col.name, n.message()));
                }
            }
            values.push(canonical);
        }
        batch.push(values);
        rows_done += 1;

        if batch.len() >= MYSQL_BATCH_ROWS {
            let sql = target_mysql::insert_batch_sql(None, &t.table, &col_names, &batch);
            if let Err(e) = mysql_conn.query_drop(&sql).await {
                failure = Some(from_mysql(e, Some(&sql)).0.to_json_string());
                break;
            }
            batch.clear();
        }
        if rows_done % PROGRESS_EVERY == 0 {
            emit_progress(app, migration_id, &t.schema, &t.table, rows_done, None, "copying");
        }
    }

    if failure.is_none() && !batch.is_empty() {
        let sql = target_mysql::insert_batch_sql(None, &t.table, &col_names, &batch);
        if let Err(e) = mysql_conn.query_drop(&sql).await {
            failure = Some(from_mysql(e, Some(&sql)).0.to_json_string());
        }
    }

    if let Some(err) = failure {
        let _ = mysql_conn.query_drop("ROLLBACK").await;
        drop(mysql_conn);
        let _ = mysql_pool.disconnect().await;
        return Err(err);
    }

    mysql_conn.query_drop("COMMIT").await.map_err(|e| from_mysql(e, None).0.to_json_string())?;
    drop(mysql_conn);
    let _ = mysql_pool.disconnect().await;

    Ok((rows_done, warnings))
}
