//! Overview + live statistics + table/index/activity metrics.
//!
//! Every field that an engine does not reliably expose is returned as `None`
//! so the frontend renders an "unsupported" panel instead of a fabricated
//! value. Counts use metadata tables / catalogs — never full table scans.

use std::collections::HashMap;
use std::time::Instant;

use mysql_async::prelude::*;
use rusqlite::OpenFlags;
use serde::Serialize;

use mongodb::bson::{doc, Bson};

use super::super::connection::{normalize_host, ConnectionConfig};
use super::connection::{engine_key, open_duckdb, open_sqlite, CONNECT_TIMEOUT};
use super::super::error::{from_duckdb, from_postgres};
use super::{
    ActivityRow, ActivitySnapshot, AutoIncrementMeta, DatabaseOverview, DatabaseStatistics,
    IndexStat, TableStat,
};

// ───────────────────────── helpers ─────────────────────────

fn quote_pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Parse a `serde_json::Value` cell (from D1) into a u64, tolerating strings.
fn json_to_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// ───────────────────────── Overview ─────────────────────────

#[tauri::command]
pub async fn get_database_overview(
    config: ConnectionConfig,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let start = Instant::now();
    let engine = engine_key(&config);

    // D1 reuses SQLite SQL over REST — short-circuit before family dispatch so
    // it hits the D1 REST helpers, not the local-SQLite ones.
    if engine == "cloudflare-d1" || engine == "d1" {
        return overview_d1(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await;
    }
    // Mongo/Redis have no `engine_family()` arm — they aren't SQL wire
    // protocols at all — so they're dispatched here the same way, mirroring
    // the D1 short-circuit above and `commands::connection`'s existing
    // `if engine == "mongodb"`/`"redis"` checks.
    if engine == "mongodb" {
        return overview_mongo(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await;
    }
    if engine == "redis" {
        return overview_redis(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await;
    }

    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Sqlite => overview_sqlite(&config, &engine, start, last_diagnostic_time, last_maintenance_time),
        super::super::engine::EngineFamily::Postgres => {
            overview_postgres(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await
        }
        super::super::engine::EngineFamily::Mysql => {
            overview_mysql(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await
        }
        super::super::engine::EngineFamily::Duckdb => {
            overview_duckdb(&config, &engine, start, last_diagnostic_time, last_maintenance_time)
        }
        super::super::engine::EngineFamily::Mssql => {
            overview_mssql(&config, &engine, start, last_diagnostic_time, last_maintenance_time).await
        }
    }
}

fn common_overview(engine: &str, latency_ms: u64, last_diagnostic_time: Option<u64>, last_maintenance_time: Option<u64>) -> DatabaseOverview {
    DatabaseOverview {
        engine: engine.to_string(),
        version: None,
        database_name: None,
        host: None,
        port: None,
        connection_status: "Connected".to_string(),
        latency_ms,
        size_bytes: 0,
        schema_count: 0,
        table_count: 0,
        view_count: 0,
        index_count: 0,
        sequence_count: 0,
        constraint_count: 0,
        row_count: None,
        last_diagnostic_time,
        last_maintenance_time,
        uptime_seconds: None,
        server_time: None,
        memory_used_bytes: None,
        memory_limit_bytes: None,
        connections_current: None,
        connections_available: None,
        ops_per_second: None,
        hit_ratio: None,
        redis_info: None,
        journal_mode: None,
        auto_vacuum: None,
    }
}

fn overview_sqlite(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("SQLite database file path is required.".to_string());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    let conn = rusqlite::Connection::open_with_flags(&path, flags).map_err(|e| e.to_string())?;

    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap_or_else(|_| "3.x".to_string());

    let table_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], |r| r.get(0))
        .unwrap_or(0);
    let view_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='view'", [], |r| r.get(0))
        .unwrap_or(0);
    let index_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql IS NOT NULL", [], |r| r.get(0))
        .unwrap_or(0);

    // Page-count based size estimate.
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(4096);
    let size_bytes = (page_count * page_size) as u64;

    let journal_mode: Option<String> = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).ok();
    let auto_vacuum: Option<String> = conn
        .query_row("PRAGMA auto_vacuum", [], |r: &rusqlite::Row| r.get::<_, i64>(0))
        .ok()
        .map(|v| match v {
            1 => "full".to_string(),
            2 => "incremental".to_string(),
            _ => "none".to_string(),
        });

    let mut row_count: Option<u64> = None;
    if let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'") {
        let names: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0)).ok()
            .map(|it| it.filter_map(|r| r.ok()).collect()).unwrap_or_default();
        let mut total = 0u64;
        let mut ok = false;
        for name in &names {
            if let Ok(c) = conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", name), [], |r| r.get::<_, i64>(0)) {
                total = total.saturating_add(c as u64);
                ok = true;
            }
        }
        if ok {
            row_count = Some(total);
        }
    }

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = Some(format!("SQLite {}", version));
    ov.database_name = Some(path);
    ov.size_bytes = size_bytes;
    ov.table_count = table_count as u64;
    ov.view_count = view_count as u64;
    ov.index_count = index_count as u64;
    ov.sequence_count = 0; // SQLite has no sequences
    ov.constraint_count = 0; // Aggregated below cheaply is unreliable; leave 0
    ov.row_count = row_count;
    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    ov.journal_mode = journal_mode;
    ov.auto_vacuum = auto_vacuum;
    Ok(ov)
}

fn overview_duckdb(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let path = config.file_path.clone().unwrap_or_default();
    let conn = open_duckdb(config)?;

    let version: String = conn
        .query_row("SELECT version()", [], |r| r.get(0))
        .unwrap_or_else(|_| "DuckDB".to_string());

    let table_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE schema_name NOT IN ('information_schema','pg_catalog') AND NOT internal",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let view_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_views() WHERE schema_name NOT IN ('information_schema','pg_catalog') AND NOT internal",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let index_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_indexes() WHERE schema_name NOT IN ('information_schema','pg_catalog')",
            [], |r| r.get(0),
        )
        .unwrap_or(0);

    // pragma_database_size() exposes a parsed database_size_bytes via the
    // total/used/free block counts; fall back to 0 if unavailable.
    let size_bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(total_blocks, 0) * COALESCE(block_size, 0) FROM pragma_database_size()",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let db_name: String = conn
        .query_row("SELECT database_name FROM pragma_database_size()", [], |r| r.get(0))
        .unwrap_or_else(|_| "duckdb".to_string());

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = Some(version);
    ov.database_name = Some(if path.is_empty() { db_name } else { path });
    ov.size_bytes = size_bytes as u64;
    ov.table_count = table_count as u64;
    ov.view_count = view_count as u64;
    ov.index_count = index_count as u64;
    ov.sequence_count = 0; // DuckDB has no sequences
    ov.constraint_count = 0;
    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    Ok(ov)
}

/// Thin re-export so existing callers in this module (and `diagnostics`/`repair`)
/// keep working. Delegates to the shared `connection::connect_postgres`, which
/// returns a structured `DbError` JSON string instead of the driver's bare
/// (and famously unhelpful — see `commands::error`) `"db error"` message.
pub async fn connect_pg(config: &ConnectionConfig) -> Result<tokio_postgres::Client, String> {
    super::connection::connect_postgres(config).await
}

async fn overview_postgres(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let client = connect_pg(config).await?;
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(5432);

    let version: String = client.query_one("SELECT version()", &[]).await.map(|r| r.get(0)).unwrap_or_default();
    let db_name: String = client.query_one("SELECT current_database()", &[]).await.map(|r| r.get(0)).unwrap_or_default();

    let row = client.query_one(
        "SELECT
            pg_database_size(current_database())::bigint AS size,
            (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')) AS schemas,
            (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') AND table_type='BASE TABLE') AS tables,
            (SELECT COUNT(*) FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')) AS views,
            (SELECT COUNT(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')) AS indexes,
            (SELECT COUNT(*) FROM information_schema.sequences WHERE sequence_schema NOT IN ('pg_catalog','information_schema','pg_toast')) AS seqs,
            (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')) AS constr,
            (SELECT GREATEST(0, SUM(reltuples)::bigint) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')) AS rows",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;

    let size_bytes: i64 = row.get(0);
    let schemas: i64 = row.get(1);
    let tables: i64 = row.get(2);
    let views: i64 = row.get(3);
    let indexes: i64 = row.get(4);
    let seqs: i64 = row.get(5);
    let constr: i64 = row.get(6);
    let rows: i64 = row.get(7);

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = Some(version);
    ov.database_name = Some(db_name);
    ov.host = Some(host);
    ov.port = Some(port);
    ov.size_bytes = size_bytes as u64;
    ov.schema_count = schemas as u64;
    ov.table_count = tables as u64;
    ov.view_count = views as u64;
    ov.index_count = indexes as u64;
    ov.sequence_count = seqs as u64;
    ov.constraint_count = constr as u64;
    ov.row_count = Some(rows as u64);

    // Server time + uptime (best-effort — some managed PG instances restrict
    // pg_postmaster_start_time).
    if let Ok(r) = client.query_one("SELECT now()::text", &[]).await {
        ov.server_time = Some(r.get::<_, String>(0));
    }
    if let Ok(r) = client.query_one(
        "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint",
        &[],
    ).await {
        let secs: i64 = r.get(0);
        ov.uptime_seconds = Some(secs as u64);
    }

    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    Ok(ov)
}

async fn overview_mysql(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default().ip_or_hostname(host.clone()).tcp_port(port).user(Some(user)).pass(Some(pass)).db_name(db).into();
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => { let _ = pool.disconnect().await; return Err(e.to_string()); }
        Err(_) => { let _ = pool.disconnect().await; return Err(format!("MySQL connection timed out after {}s", CONNECT_TIMEOUT.as_secs())); }
    };

    let version: Option<String> = conn.query_first("SELECT VERSION()").await.ok().flatten();
    // DATABASE() can return NULL when no database is selected — handle via
    // Option<Option<String>> to avoid a FromRow panic on NULL.
    let db_name: Option<String> = conn.query_first("SELECT IFNULL(DATABASE(), '')").await.ok().flatten().filter(|s: &String| !s.is_empty());

    // Scope counts to the current database (MySQL has many system DBs).
    let count_sql = "SELECT
        COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS size,
        COUNT(DISTINCT CASE WHEN t.TABLE_TYPE='BASE TABLE' THEN t.TABLE_NAME END) AS tables,
        COUNT(DISTINCT CASE WHEN t.TABLE_TYPE='VIEW' THEN t.TABLE_NAME END) AS views,
        COUNT(DISTINCT s.INDEX_NAME) AS indexes,
        COALESCE(SUM(t.TABLE_ROWS), 0) AS rows
      FROM information_schema.TABLES t
      LEFT JOIN information_schema.STATISTICS s
        ON s.TABLE_SCHEMA = t.TABLE_SCHEMA AND s.TABLE_NAME = t.TABLE_NAME
      WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_SCHEMA NOT IN ('information_schema','mysql','performance_schema','sys')";
    let row: Option<(f64, i64, i64, i64, i64)> = conn.query_first(count_sql).await.ok().flatten();
    let mut schemas: i64 = 1;
    if let Some(q) = conn.query_first::<i64, _>("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys')").await.ok().flatten() {
        schemas = q;
    }
    let constraint_count: i64 = conn.query_first("SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE()").await.ok().flatten().unwrap_or(0);

    // Server time + uptime.
    let server_time: Option<String> = conn.query_first("SELECT NOW()").await.ok().flatten();
    let uptime: Option<i64> = {
        let row: Option<(String, String)> = conn.query_first("SHOW GLOBAL STATUS WHERE Variable_name = 'Uptime'").await.ok().flatten();
        row.and_then(|(_, val)| val.parse::<i64>().ok())
    };

    drop(conn);
    let _ = pool.disconnect().await;

    let (size_bytes, tables, views, indexes, rows) = row.unwrap_or((0.0, 0, 0, 0, 0));

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = version;
    ov.database_name = db_name;
    ov.host = Some(host);
    ov.port = Some(port);
    ov.size_bytes = size_bytes as u64;
    ov.schema_count = schemas as u64;
    ov.table_count = tables as u64;
    ov.view_count = views as u64;
    ov.index_count = indexes as u64;
    ov.sequence_count = 0; // MySQL has no standalone sequences (auto_increment is column-level)
    ov.constraint_count = constraint_count as u64;
    ov.row_count = Some(rows as u64);
    ov.server_time = server_time;
    ov.uptime_seconds = uptime.map(|u| u as u64);
    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    Ok(ov)
}

/// SQL Server overview. Mirrors `overview_mysql`'s scoping: `schema_count` is
/// the number of user databases visible on the *server* (SQL Server's group
/// node = a database, like MySQL); everything else (tables/views/indexes/
/// size/rows) is scoped to the *currently connected* database.
async fn overview_mssql(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(1433);

    let version_res = super::super::mssql::run_mssql_query(config, "SELECT @@VERSION AS v, DB_NAME() AS db, SYSDATETIME() AS now_ts;").await?;
    let version = version_res.rows.first().and_then(|r| r.first()).and_then(|v| v.as_str()).map(|s| s.lines().next().unwrap_or(s).trim().to_string());
    let db_name = version_res.rows.first().and_then(|r| r.get(1)).and_then(|v| v.as_str()).map(|s| s.to_string());
    let server_time = version_res.rows.first().and_then(|r| r.get(2)).and_then(|v| v.as_str()).map(|s| s.to_string());

    let count_res = super::super::mssql::run_mssql_query(config, "
        SELECT
            (SELECT COUNT(*) FROM sys.tables) AS tables,
            (SELECT COUNT(*) FROM sys.views) AS views,
            (SELECT COUNT(*) FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE i.index_id > 0) AS indexes,
            (SELECT COUNT(*) FROM sys.sequences) AS sequences,
            (SELECT COUNT(*) FROM sys.objects WHERE type IN ('PK','F','UQ','C')) AS constraints,
            (SELECT COALESCE(SUM(size), 0) * 8 * 1024 FROM sys.master_files WHERE database_id = DB_ID()) AS size_bytes,
            (SELECT COALESCE(SUM(p.rows), 0) FROM sys.partitions p JOIN sys.tables t2 ON t2.object_id = p.object_id WHERE p.index_id IN (0, 1)) AS row_count,
            (SELECT COUNT(*) FROM sys.databases WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb')) AS schemas,
            (SELECT DATEDIFF(SECOND, sqlserver_start_time, GETDATE()) FROM sys.dm_os_sys_info) AS uptime;
    ").await?;
    let row = count_res.rows.first();
    let get = |i: usize| row.and_then(|r| r.get(i));

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = version;
    ov.database_name = db_name;
    ov.host = Some(host);
    ov.port = Some(port);
    ov.table_count = get(0).and_then(json_to_u64).unwrap_or(0);
    ov.view_count = get(1).and_then(json_to_u64).unwrap_or(0);
    ov.index_count = get(2).and_then(json_to_u64).unwrap_or(0);
    ov.sequence_count = get(3).and_then(json_to_u64).unwrap_or(0);
    ov.constraint_count = get(4).and_then(json_to_u64).unwrap_or(0);
    ov.size_bytes = get(5).and_then(json_to_u64).unwrap_or(0);
    ov.row_count = get(6).and_then(json_to_u64);
    ov.schema_count = get(7).and_then(json_to_u64).unwrap_or(0);
    ov.uptime_seconds = get(8).and_then(json_to_u64);
    ov.server_time = server_time;
    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    Ok(ov)
}

async fn overview_d1(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    // D1 introspection reuses the schema SQL helper from the existing d1 module.
    let count_res = super::super::d1::run_d1_query(
        config,
        "SELECT
            (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%') AS tables,
            (SELECT COUNT(*) FROM sqlite_master WHERE type='view') AS views,
            (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql IS NOT NULL) AS indexes",
    ).await?;
    let tables = count_res.rows.first().and_then(|r| r.first()).and_then(json_to_u64).unwrap_or(0);
    let views = count_res.rows.first().and_then(|r| r.get(1)).and_then(json_to_u64).unwrap_or(0);
    let indexes = count_res.rows.first().and_then(|r| r.get(2)).and_then(json_to_u64).unwrap_or(0);

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.version = Some("Cloudflare D1".to_string());
    ov.database_name = config.cf_database_id.clone();
    ov.table_count = tables;
    ov.view_count = views;
    ov.index_count = indexes;
    ov.last_diagnostic_time = last_diagnostic_time;
    ov.last_maintenance_time = last_maintenance_time;
    Ok(ov)
}

/// MongoDB overview. Reuses `commands::mongo`'s connection/dbStats helpers
/// rather than duplicating BSON plumbing — see that module's doc comment for
/// why Mongo isn't folded into `EngineFamily`. `databases`/`collections`/
/// `indexes` map onto the existing `schema_count`/`table_count`/`index_count`
/// fields (Mongo's own hierarchy happens to line up with the SQL-shaped
/// struct); `size_bytes`/`row_count` are `storageSize`/`objects` summed
/// across every non-system database via `dbStats`.
///
/// Every privileged call (`serverStatus`, `buildInfo`) is wrapped in its own
/// `if let Ok(..)` — a restricted user missing one of these still gets a
/// usable overview with the fields it *can* read, rather than a hard error.
async fn overview_mongo(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    use super::super::mongo;

    let client = mongo::open_client(config).await.map_err(|e| e.to_json_string())?;
    let admin = client.database("admin");

    // Ping first, both to confirm the connection is actually usable and to
    // measure latency the same way every other engine's overview does
    // (`start` covers connect + this round trip, matching `overview_postgres`).
    admin
        .run_command(doc! { "ping": 1 })
        .await
        .map_err(|e| mongo::MongoError::from(e).to_json_string())?;

    let mut ov = common_overview(engine, start.elapsed().as_millis() as u64, last_diagnostic_time, last_maintenance_time);
    ov.database_name = config.database.clone();
    ov.host = config.host.clone();
    ov.port = config.port.or(Some(27017));

    if let Ok(build_info) = admin.run_command(doc! { "buildInfo": 1 }).await {
        if let Some(Bson::String(v)) = build_info.get("version") {
            ov.version = Some(v.clone());
        }
    }

    // Permission-tolerant: a restricted user commonly lacks `serverStatus`.
    if let Ok(status) = admin.run_command(doc! { "serverStatus": 1 }).await {
        ov.uptime_seconds = Some(mongo::bson_num_as_u64(&status, "uptime"));
        if let Some(Bson::Document(connections)) = status.get("connections") {
            ov.connections_current = Some(mongo::bson_num_as_u64(connections, "current"));
            ov.connections_available = Some(mongo::bson_num_as_u64(connections, "available"));
        }
        if let Some(Bson::Document(mem)) = status.get("mem") {
            // `mem.resident` is reported in MB.
            ov.memory_used_bytes = Some(mongo::bson_num_as_u64(mem, "resident") * 1024 * 1024);
        }
    }

    let databases = client.list_databases().await.map_err(|e| mongo::MongoError::from(e).to_json_string())?;
    let (mut schema_count, mut table_count, mut index_count, mut size_bytes, mut row_count) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for db in &databases {
        if mongo::SYSTEM_DATABASES.contains(&db.name.as_str()) {
            continue;
        }
        schema_count += 1;
        // A single database's `dbStats` failing (rare — permission scoped
        // per-db is unusual but possible) shouldn't blank the whole overview.
        if let Ok(stats) = mongo::database_stats_for(&client, &db.name).await {
            table_count += stats.collections;
            index_count += stats.indexes;
            size_bytes += stats.storage_size;
            row_count += stats.objects;
        }
    }
    ov.schema_count = schema_count;
    ov.table_count = table_count;
    ov.index_count = index_count;
    ov.size_bytes = size_bytes;
    ov.row_count = Some(row_count);

    Ok(ov)
}

/// Redis overview. A single `INFO` round trip (`redis::fetch_info_text`) feeds
/// every `parse_info_*` pure parser — see that module's doc comment for why
/// the underlying structs stay local to `commands::redis` rather than
/// returning this module's wire types directly (this function does that
/// conversion). Unlike Postgres/MySQL/Mongo, Redis genuinely has no
/// schema/table/index concept, so `schema_count`/`table_count`/`index_count`
/// stay at `common_overview`'s zero defaults — the frontend's `overviewTiles`
/// reads `redisInfo`/`memoryUsedBytes`/`opsPerSecond`/`hitRatio` instead.
async fn overview_redis(
    config: &ConnectionConfig,
    engine: &str,
    start: Instant,
    last_diagnostic_time: Option<u64>,
    last_maintenance_time: Option<u64>,
) -> Result<DatabaseOverview, String> {
    use super::super::redis as redis_mod;

    let info = redis_mod::fetch_info_text(config).await.map_err(|e| e.to_json_string())?;
    let latency_ms = start.elapsed().as_millis() as u64;

    let memory = redis_mod::parse_info_memory(&info);
    let stats = redis_mod::parse_info_stats(&info);
    let clients = redis_mod::parse_info_clients(&info);
    let replication = redis_mod::parse_info_replication(&info);
    let persistence = redis_mod::parse_info_persistence(&info);
    let keyspace = redis_mod::parse_keyspace_info(&info);

    let mut ov = common_overview(engine, latency_ms, last_diagnostic_time, last_maintenance_time);
    ov.host = config.host.clone();
    ov.port = config.port.or(Some(6379));
    ov.memory_used_bytes = Some(memory.used_memory);
    ov.memory_limit_bytes = if memory.maxmemory > 0 { Some(memory.maxmemory) } else { None };
    ov.connections_current = Some(clients.connected_clients);
    ov.ops_per_second = Some(stats.instantaneous_ops_per_sec as f64);
    let total_lookups = stats.keyspace_hits + stats.keyspace_misses;
    ov.hit_ratio = if total_lookups > 0 { Some(stats.keyspace_hits as f64 / total_lookups as f64) } else { None };
    ov.redis_info = Some(super::RedisInfo {
        keyspace: keyspace
            .into_iter()
            .map(|db| super::RedisKeyspaceDb { db_index: db.db_index as u32, keys: db.keys, expires: db.expires })
            .collect(),
        replication: super::RedisReplicationInfo {
            role: replication.role,
            connected_slaves: replication.connected_slaves,
            master_repl_offset: replication.master_repl_offset,
        },
        persistence: super::RedisPersistenceInfo {
            aof_enabled: persistence.aof_enabled,
            rdb_last_save_time: persistence.rdb_last_save_time,
            rdb_changes_since_last_save: persistence.rdb_changes_since_last_save,
            rdb_last_bgsave_status: persistence.rdb_last_bgsave_status,
            aof_current_size_bytes: persistence.aof_current_size_bytes,
            aof_rewrite_in_progress: persistence.aof_rewrite_in_progress,
        },
        detail: super::RedisDetail {
            memory_rss_bytes: memory.used_memory_rss,
            memory_peak_bytes: memory.used_memory_peak,
            memory_fragmentation_ratio: memory.mem_fragmentation_ratio,
            blocked_clients: clients.blocked_clients,
            max_clients: clients.maxclients,
            expired_keys: stats.expired_keys,
            evicted_keys: stats.evicted_keys,
            rejected_connections: stats.rejected_connections,
        },
    });

    Ok(ov)
}

// ───────────────────────── Statistics ─────────────────────────

#[tauri::command]
pub async fn get_database_statistics(config: ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let engine = engine_key(&config);
    if engine == "cloudflare-d1" || engine == "d1" {
        return stats_d1(&config).await;
    }
    // Mongo/Redis have no `engine_family()` arm — same short-circuit as
    // `get_database_overview` above. Without this they fell into the SQLite
    // arm below and errored "SQLite database file path is required" on every
    // Health tab that calls this (Overview + Monitoring both do).
    if engine == "mongodb" {
        return stats_mongo(&config).await;
    }
    if engine == "redis" {
        return stats_redis(&config).await;
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => stats_postgres(&config).await,
        super::super::engine::EngineFamily::Mysql => stats_mysql(&config).await,
        super::super::engine::EngineFamily::Sqlite => stats_sqlite(&config),
        super::super::engine::EngineFamily::Duckdb => stats_duckdb(&config),
        super::super::engine::EngineFamily::Mssql => stats_mssql(&config).await,
    }
}

/// Mongo statistics: `serverStatus` for connection counts, `dbStats` (summed
/// across every non-system database) for size/collection/index/document
/// counts — the same two round trips `overview_mongo` above already makes,
/// just reshaped into `DatabaseStatistics`.
async fn stats_mongo(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    use super::super::mongo;

    let client = mongo::open_client(config).await.map_err(|e| e.to_json_string())?;
    let admin = client.database("admin");

    let mut s = empty_stats();

    if let Ok(status) = admin.run_command(doc! { "serverStatus": 1 }).await {
        if let Some(Bson::Document(connections)) = status.get("connections") {
            s.connection_count = Some(mongo::bson_num_as_u64(connections, "current"));
            s.max_connections = Some(mongo::bson_num_as_u64(connections, "available") + mongo::bson_num_as_u64(connections, "current"));
        }
        if let Some(Bson::Document(global_lock)) = status.get("globalLock") {
            if let Some(Bson::Document(active_clients)) = global_lock.get("activeClients") {
                s.active_queries = Some(mongo::bson_num_as_u64(active_clients, "readers") + mongo::bson_num_as_u64(active_clients, "writers"));
            }
        }
    }

    let databases = client.list_databases().await.map_err(|e| mongo::MongoError::from(e).to_json_string())?;
    let (mut schema_count, mut table_count, mut index_count, mut size_bytes, mut row_count) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for db in &databases {
        if mongo::SYSTEM_DATABASES.contains(&db.name.as_str()) {
            continue;
        }
        schema_count += 1;
        if let Ok(stats) = mongo::database_stats_for(&client, &db.name).await {
            table_count += stats.collections;
            index_count += stats.indexes;
            size_bytes += stats.storage_size;
            row_count += stats.objects;
        }
    }
    s.schema_count = schema_count;
    s.table_count = table_count;
    s.index_count = index_count;
    s.size_bytes = size_bytes;
    s.row_count = Some(row_count);

    Ok(s)
}

/// Redis statistics from a single `INFO` round trip — same parsers
/// `overview_redis` uses. Redis has no schema/table/index concept, so
/// `schema_count`/`row_count` are repurposed as "non-empty logical DBs" /
/// "total keys across them" (mirrors how `overview_redis` repurposes the
/// generic overview tiles via `redis_info` instead).
async fn stats_redis(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    use super::super::redis as redis_mod;

    let info = redis_mod::fetch_info_text(config).await.map_err(|e| e.to_json_string())?;
    let memory = redis_mod::parse_info_memory(&info);
    let clients = redis_mod::parse_info_clients(&info);
    let keyspace = redis_mod::parse_keyspace_info(&info);

    let mut s = empty_stats();
    s.size_bytes = memory.used_memory;
    s.schema_count = keyspace.len() as u64;
    s.row_count = Some(keyspace.iter().map(|db| db.keys).sum());
    s.connection_count = Some(clients.connected_clients);
    s.max_connections = if clients.maxclients > 0 { Some(clients.maxclients) } else { None };
    Ok(s)
}

fn empty_stats() -> DatabaseStatistics {
    DatabaseStatistics {
        size_bytes: 0,
        table_count: 0,
        index_count: 0,
        row_count: None,
        schema_count: 0,
        connection_count: None,
        max_connections: None,
        active_queries: None,
        idle_connections: None,
        transaction_count: None,
        cache_hit_ratio: None,
        avg_query_latency_ms: None,
        lock_count: None,
        blocking_queries: None,
        long_running_queries: None,
        slow_query_count: None,
    }
}

async fn stats_postgres(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let client = connect_pg(config).await?;
    let row = client.query_one(
        "SELECT
            pg_database_size(current_database())::bigint,
            (SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')),
            (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast') AND table_type='BASE TABLE'),
            (SELECT COUNT(*) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')),
            (SELECT GREATEST(0, SUM(reltuples)::bigint) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')),
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
            (SELECT setting::bigint FROM pg_settings WHERE name='max_connections'),
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'),
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle'),
            CASE WHEN (blks_hit + blks_read) > 0 THEN blks_hit::float8 / (blks_hit + blks_read) ELSE NULL END,
            (SELECT count(*) FROM pg_locks WHERE locktype = 'transactionid'),
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND now() - query_start > interval '1 minute' AND state <> 'idle'),
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event IS NOT NULL)
        FROM pg_stat_database WHERE datname = current_database()",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;

    let mut s = empty_stats();
    s.size_bytes = row.get::<_, i64>(0) as u64;
    s.schema_count = row.get::<_, i64>(1) as u64;
    s.table_count = row.get::<_, i64>(2) as u64;
    s.index_count = row.get::<_, i64>(3) as u64;
    s.row_count = Some(row.get::<_, i64>(4) as u64);
    s.connection_count = Some(row.get::<_, i64>(5) as u64);
    s.max_connections = Some(row.get::<_, i64>(6) as u64);
    s.active_queries = Some(row.get::<_, i64>(7) as u64);
    s.idle_connections = Some(row.get::<_, i64>(8) as u64);
    let hit: Option<f64> = row.get(9);
    s.cache_hit_ratio = hit;
    s.lock_count = Some(row.get::<_, i64>(10) as u64);
    s.long_running_queries = Some(row.get::<_, i64>(11) as u64);
    s.blocking_queries = Some(row.get::<_, i64>(12) as u64);
    Ok(s)
}

async fn stats_mysql(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default().ip_or_hostname(host).tcp_port(port).user(Some(user)).pass(Some(pass)).db_name(db).into();
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => { let _ = pool.disconnect().await; return Err(e.to_string()); }
        Err(_) => { let _ = pool.disconnect().await; return Err(format!("MySQL connection timed out after {}s", CONNECT_TIMEOUT.as_secs())); }
    };

    let size_row: Option<(f64, f64)> = conn.query_first("SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0), COALESCE(SUM(TABLE_ROWS),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()").await.ok().flatten();
    let threads: Option<(i64, i64, i64)> = conn.query_first("SELECT (SELECT COUNT(*) FROM information_schema.PROCESSLIST), (SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND='Query'), (SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND='Sleep')").await.ok().flatten();
    let max_conn: Option<i64> = conn.query_first("SELECT @@max_connections").await.ok().flatten();
    let slow_row: Option<(String, String)> = conn.query_first("SHOW GLOBAL STATUS LIKE 'Slow_queries'").await.ok().flatten();
    let slow: Option<i64> = slow_row.and_then(|(_, v)| v.parse().ok());

    drop(conn);
    let _ = pool.disconnect().await;

    let mut s = empty_stats();
    if let Some((sz, rows)) = size_row {
        s.size_bytes = sz as u64;
        s.row_count = Some(rows as u64);
    }
    if let Some((total, active, idle)) = threads {
        s.connection_count = Some(total as u64);
        s.active_queries = Some(active as u64);
        s.idle_connections = Some(idle as u64);
    }
    s.max_connections = max_conn.map(|v| v as u64);
    s.slow_query_count = slow.map(|v| v as u64);
    Ok(s)
}

async fn stats_mssql(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let res = super::super::mssql::run_mssql_query(config, "
        SELECT
            (SELECT COALESCE(SUM(size), 0) * 8 * 1024 FROM sys.master_files WHERE database_id = DB_ID()) AS size_bytes,
            (SELECT COUNT(*) FROM sys.tables) AS tables,
            (SELECT COUNT(*) FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE i.index_id > 0) AS indexes,
            (SELECT COALESCE(SUM(p.rows), 0) FROM sys.partitions p JOIN sys.tables t2 ON t2.object_id = p.object_id WHERE p.index_id IN (0, 1)) AS row_count,
            (SELECT COUNT(DISTINCT s.schema_id) FROM sys.tables t3 JOIN sys.schemas s ON s.schema_id = t3.schema_id) AS schemas,
            (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS connections,
            (SELECT CAST(@@MAX_CONNECTIONS AS BIGINT)) AS max_connections,
            (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id <> @@SPID) AS active_queries,
            (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1 AND status = 'sleeping') AS idle,
            (SELECT COUNT(*) FROM sys.dm_tran_active_transactions) AS transactions,
            (SELECT COUNT(*) FROM sys.dm_tran_locks) AS locks,
            (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE blocking_session_id <> 0) AS blocking,
            (SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id <> @@SPID AND DATEDIFF(SECOND, start_time, GETDATE()) > 60) AS long_running,
            (SELECT CAST(a.cntr_value AS FLOAT) / NULLIF(b.cntr_value, 0)
             FROM sys.dm_os_performance_counters a, sys.dm_os_performance_counters b
             WHERE a.counter_name = 'Buffer cache hit ratio' AND b.counter_name = 'Buffer cache hit ratio base') AS cache_hit_ratio;
    ").await?;
    let row = res.rows.first();
    let get = |i: usize| row.and_then(|r| r.get(i));

    let mut s = empty_stats();
    s.size_bytes = get(0).and_then(json_to_u64).unwrap_or(0);
    s.table_count = get(1).and_then(json_to_u64).unwrap_or(0);
    s.index_count = get(2).and_then(json_to_u64).unwrap_or(0);
    s.row_count = get(3).and_then(json_to_u64);
    s.schema_count = get(4).and_then(json_to_u64).unwrap_or(0);
    s.connection_count = get(5).and_then(json_to_u64);
    s.max_connections = get(6).and_then(json_to_u64);
    s.active_queries = get(7).and_then(json_to_u64);
    s.idle_connections = get(8).and_then(json_to_u64);
    s.transaction_count = get(9).and_then(json_to_u64);
    s.lock_count = get(10).and_then(json_to_u64);
    s.blocking_queries = get(11).and_then(json_to_u64);
    s.long_running_queries = get(12).and_then(json_to_u64);
    s.cache_hit_ratio = get(13).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
    Ok(s)
}

fn stats_sqlite(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let conn = open_sqlite(config)?;
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(4096);
    let tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'", [], |r| r.get(0)).unwrap_or(0);
    let indexes: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql IS NOT NULL", [], |r| r.get(0)).unwrap_or(0);

    let mut s = empty_stats();
    s.size_bytes = (page_count * page_size) as u64;
    s.schema_count = 1;
    s.table_count = tables as u64;
    s.index_count = indexes as u64;
    Ok(s)
}

fn stats_duckdb(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let conn = open_duckdb(config)?;

    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE schema_name NOT IN ('information_schema','pg_catalog') AND NOT internal",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let indexes: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_indexes() WHERE schema_name NOT IN ('information_schema','pg_catalog')",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    // Sum of estimated row counts across user tables.
    let total_rows: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(estimated_size), 0) FROM duckdb_tables() WHERE NOT internal AND schema_name NOT IN ('information_schema','pg_catalog')",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let size_bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(total_blocks, 0) * COALESCE(block_size, 0) FROM pragma_database_size()",
            [], |r| r.get(0),
        )
        .unwrap_or(0);

    let mut s = empty_stats();
    s.size_bytes = size_bytes as u64;
    s.schema_count = 1; // DuckDB is effectively single-schema from a stats standpoint
    s.table_count = tables as u64;
    s.index_count = indexes as u64;
    s.row_count = Some(total_rows as u64);
    Ok(s)
}

async fn stats_d1(config: &ConnectionConfig) -> Result<DatabaseStatistics, String> {
    let res = super::super::d1::run_d1_query(config, "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'), (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND sql IS NOT NULL)").await?;
    let tables = res.rows.first().and_then(|r| r.first()).and_then(json_to_u64).unwrap_or(0);
    let indexes = res.rows.first().and_then(|r| r.get(1)).and_then(json_to_u64).unwrap_or(0);
    let mut s = empty_stats();
    s.schema_count = 1;
    s.table_count = tables;
    s.index_count = indexes;
    Ok(s)
}

// ───────────────────────── Table statistics ─────────────────────────

#[tauri::command]
pub async fn get_table_statistics(
    config: ConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<TableStat, String> {
    let engine = engine_key(&config);
    if engine == "cloudflare-d1" || engine == "d1" {
        return table_stats_d1(&config, table).await;
    }
    // Mongo/Redis have no `engine_family()` arm — same short-circuit as
    // `get_database_overview`/`get_database_statistics`/`get_activity`
    // above. This function isn't on the Monitoring tab's default load path
    // today, but would hit the same "SQLite database file path is
    // required" bug the moment anything calls it for these engines. Report
    // "unsupported" (all-`None`) rather than erroring, same convention as
    // `get_activity`'s `supported: false` for engines without a metric yet.
    if engine == "mongodb" || engine == "redis" {
        return Ok(TableStat {
            schema,
            name: table,
            row_count: None,
            data_size_bytes: None,
            index_size_bytes: None,
            total_size_bytes: None,
            index_count: None,
            foreign_key_count: None,
            last_analyzed_ms: None,
        });
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => table_stats_pg(&config, schema, table).await,
        super::super::engine::EngineFamily::Mysql => table_stats_mysql(&config, table).await,
        super::super::engine::EngineFamily::Sqlite => table_stats_sqlite(&config, table),
        super::super::engine::EngineFamily::Duckdb => table_stats_duckdb(&config, schema, table),
        super::super::engine::EngineFamily::Mssql => table_stats_mssql(&config, schema, table).await,
    }
}

async fn table_stats_mssql(config: &ConnectionConfig, schema: Option<String>, table: String) -> Result<TableStat, String> {
    let tbl = table.replace('\'', "''");
    let schema_filter = match &schema {
        Some(s) => format!("AND s.name = '{}'", s.replace('\'', "''")),
        None => String::new(),
    };
    let sql = format!("
        SELECT
            COALESCE(SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END), 0) AS row_count,
            COALESCE(SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.used_page_count ELSE 0 END), 0) * 8 * 1024 AS data_bytes,
            COALESCE(SUM(CASE WHEN ps.index_id > 1 THEN ps.used_page_count ELSE 0 END), 0) * 8 * 1024 AS index_bytes,
            (SELECT COUNT(*) FROM sys.indexes i WHERE i.object_id = t.object_id AND i.index_id > 0) AS index_count,
            (SELECT COUNT(*) FROM sys.foreign_keys fk WHERE fk.parent_object_id = t.object_id) AS fk_count
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.dm_db_partition_stats ps ON ps.object_id = t.object_id
        WHERE t.name = '{}' {}
        GROUP BY t.object_id;
    ", tbl, schema_filter);
    let res = super::super::mssql::run_mssql_query(config, &sql).await?;
    let row = res.rows.first();
    let get = |i: usize| row.and_then(|r| r.get(i));
    let data_bytes = get(1).and_then(json_to_u64).unwrap_or(0);
    let index_bytes = get(2).and_then(json_to_u64).unwrap_or(0);
    Ok(TableStat {
        schema,
        name: table,
        row_count: get(0).and_then(json_to_u64),
        data_size_bytes: Some(data_bytes),
        index_size_bytes: Some(index_bytes),
        total_size_bytes: Some(data_bytes + index_bytes),
        index_count: get(3).and_then(json_to_u64),
        foreign_key_count: get(4).and_then(json_to_u64),
        last_analyzed_ms: None,
    })
}

async fn table_stats_pg(config: &ConnectionConfig, schema: Option<String>, table: String) -> Result<TableStat, String> {
    let client = connect_pg(config).await?;
    let sch = schema.unwrap_or_else(|| "public".to_string());
    let q = "SELECT
        c.reltuples::bigint AS rows,
        pg_relation_size(c.oid) AS data_size,
        pg_indexes_size(c.oid) AS index_size,
        pg_total_relation_size(c.oid) AS total_size,
        (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid) AS indexes,
        (SELECT count(*) FROM pg_constraint con WHERE con.conrelid = c.oid AND con.contype = 'f') AS fks,
        st.last_analyze
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'";
    let row = client.query_one(q, &[&sch, &table]).await.map_err(|e| from_postgres(e, Some(q)).to_json_string())?;
    let rows: i64 = row.get(0);
    let data_size: i64 = row.get(1);
    let index_size: i64 = row.get(2);
    let total: i64 = row.get(3);
    let indexes: i64 = row.get(4);
    let fks: i64 = row.get(5);
    let last_analyze: Option<String> = row.get(6);
    let last_analyzed_ms = last_analyze
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
        .and_then(|t| t.timestamp_millis().try_into().ok());
    Ok(TableStat {
        schema: Some(sch),
        name: table,
        row_count: Some(rows as u64),
        data_size_bytes: Some(data_size as u64),
        index_size_bytes: Some(index_size as u64),
        total_size_bytes: Some(total as u64),
        index_count: Some(indexes as u64),
        foreign_key_count: Some(fks as u64),
        last_analyzed_ms,
    })
}

async fn table_stats_mysql(config: &ConnectionConfig, table: String) -> Result<TableStat, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default().ip_or_hostname(host).tcp_port(port).user(Some(user)).pass(Some(pass)).db_name(db).into();
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => { let _ = pool.disconnect().await; return Err(e.to_string()); }
        Err(_) => { let _ = pool.disconnect().await; return Err(format!("MySQL connection timed out after {}s", CONNECT_TIMEOUT.as_secs())); }
    };
    let q = format!("SELECT TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_LENGTH+INDEX_LENGTH FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}'", table.replace('\'', "''"));
    let row: Option<(i64, i64, i64, i64)> = conn.query_first(q).await.ok().flatten();
    let fk_count: i64 = conn.query_first(format!("SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='{}' AND REFERENCED_TABLE_NAME IS NOT NULL", table.replace('\'', "''"))).await.ok().flatten().unwrap_or(0);
    drop(conn);
    let _ = pool.disconnect().await;
    let (rows, data_len, idx_len, total) = row.unwrap_or((0, 0, 0, 0));
    Ok(TableStat {
        schema: None,
        name: table,
        row_count: Some(rows as u64),
        data_size_bytes: Some(data_len as u64),
        index_size_bytes: Some(idx_len as u64),
        total_size_bytes: Some(total as u64),
        index_count: None,
        foreign_key_count: Some(fk_count as u64),
        last_analyzed_ms: None,
    })
}

fn table_stats_sqlite(config: &ConnectionConfig, table: String) -> Result<TableStat, String> {
    let conn = open_sqlite(config)?;
    let rows: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM \"{}\"", table), [], |r| r.get(0)).unwrap_or(0);
    let mut index_count = 0u64;
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA index_list(\"{}\")", table)) {
        index_count = stmt.query_count().unwrap_or(0) as u64;
    }
    Ok(TableStat {
        schema: None,
        name: table,
        row_count: Some(rows as u64),
        data_size_bytes: None, // SQLite doesn't expose per-table sizes cheaply
        index_size_bytes: None,
        total_size_bytes: None,
        index_count: Some(index_count),
        foreign_key_count: None,
        last_analyzed_ms: None,
    })
}

fn table_stats_duckdb(config: &ConnectionConfig, schema: Option<String>, table: String) -> Result<TableStat, String> {
    let conn = open_duckdb(config)?;
    let sch = schema.unwrap_or_else(|| "main".to_string());

    // Exact row count. DuckDB COUNT(*) is fully vectorized and cheap on the
    // read-only connection.
    let qt = format!(
        "\"{}\".\"{}\"",
        sch.replace('"', "\"\""),
        table.replace('"', "\"\"")
    );
    let rows: i64 = conn
        .query_row(&format!("SELECT count(*) FROM {}", qt), [], |r| r.get(0))
        .unwrap_or(0);

    let index_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_indexes() WHERE schema_name = ? AND table_name = ?",
            [&sch, &table], |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(TableStat {
        schema: Some(sch),
        name: table,
        row_count: Some(rows as u64),
        data_size_bytes: None,
        index_size_bytes: None,
        total_size_bytes: None,
        index_count: Some(index_count as u64),
        foreign_key_count: None,
        last_analyzed_ms: None,
    })
}

async fn table_stats_d1(config: &ConnectionConfig, table: String) -> Result<TableStat, String> {
    let safe = table.replace('"', "\"\"");
    let res = super::super::d1::run_d1_query(config, &format!("SELECT COUNT(*) AS c FROM \"{}\"", safe)).await?;
    let rows = res.rows.first().and_then(|r| r.first()).and_then(json_to_u64);
    Ok(TableStat {
        schema: None,
        name: table,
        row_count: rows,
        data_size_bytes: None,
        index_size_bytes: None,
        total_size_bytes: None,
        index_count: None,
        foreign_key_count: None,
        last_analyzed_ms: None,
    })
}

// ───────────────────────── Index statistics ─────────────────────────

#[tauri::command]
pub async fn get_index_statistics(
    config: ConnectionConfig,
    schema: Option<String>,
    table: Option<String>,
) -> Result<Vec<IndexStat>, String> {
    let engine = engine_key(&config);
    if engine == "cloudflare-d1" || engine == "d1" {
        return index_stats_d1(&config, table).await;
    }
    // Mongo/Redis have no `engine_family()` arm — without this short-circuit
    // they fell into the SQLite arm below and called `open_sqlite`, which
    // errors "SQLite database file path is required" (this is the exact bug
    // the Monitoring tab's Index Statistics table hits, since it always
    // calls this on mount). Reported empty for now — same "unsupported,
    // don't fabricate" convention as MySQL below — real per-collection Mongo
    // index stats (`mongo_list_indexes`) would be a follow-up, not needed to
    // stop the error.
    if engine == "mongodb" || engine == "redis" {
        return Ok(vec![]);
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => index_stats_pg(&config, schema, table).await,
        // MySQL/MariaDB index stats are exposed but less rich; return unsupported gracefully.
        super::super::engine::EngineFamily::Mysql => Ok(vec![]),
        super::super::engine::EngineFamily::Sqlite => index_stats_sqlite(&config, table),
        super::super::engine::EngineFamily::Duckdb => index_stats_duckdb(&config, schema, table),
        super::super::engine::EngineFamily::Mssql => index_stats_mssql(&config, schema, table).await,
    }
}

async fn index_stats_mssql(config: &ConnectionConfig, schema: Option<String>, table: Option<String>) -> Result<Vec<IndexStat>, String> {
    let mut filters = String::new();
    if let Some(s) = &schema {
        filters.push_str(&format!(" AND sch.name = '{}'", s.replace('\'', "''")));
    }
    if let Some(t) = &table {
        filters.push_str(&format!(" AND t.name = '{}'", t.replace('\'', "''")));
    }

    // One row per index: identity + type + usage counters.
    let idx_sql = format!("
        SELECT sch.name, t.name, i.name, i.type_desc, i.is_primary_key, i.is_unique,
               COALESCE(ius.user_seeks, 0) + COALESCE(ius.user_scans, 0) + COALESCE(ius.user_lookups, 0) AS scans,
               COALESCE(ius.user_seeks, 0) AS reads,
               COALESCE(ius.user_updates, 0) AS writes,
               (SELECT COALESCE(SUM(ps.used_page_count), 0) * 8 * 1024 FROM sys.dm_db_partition_stats ps WHERE ps.object_id = i.object_id AND ps.index_id = i.index_id) AS size_bytes
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas sch ON sch.schema_id = t.schema_id
        LEFT JOIN sys.dm_db_index_usage_stats ius ON ius.object_id = i.object_id AND ius.index_id = i.index_id AND ius.database_id = DB_ID()
        WHERE i.index_id > 0 {}
        ORDER BY sch.name, t.name, i.name;
    ", filters);
    let idx_res = super::super::mssql::run_mssql_query(config, &idx_sql).await?;

    // One row per (index, column), to assemble the column list per index.
    let col_sql = format!("
        SELECT sch.name, t.name, i.name, c.name
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.schemas sch ON sch.schema_id = t.schema_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.index_id > 0 {}
        ORDER BY sch.name, t.name, i.name, ic.key_ordinal;
    ", filters);
    let col_res = super::super::mssql::run_mssql_query(config, &col_sql).await?;

    let mut columns_by_index: HashMap<(String, String, String), Vec<String>> = HashMap::new();
    for r in &col_res.rows {
        let (Some(s), Some(t), Some(i), Some(c)) = (
            r.first().and_then(|v| v.as_str()),
            r.get(1).and_then(|v| v.as_str()),
            r.get(2).and_then(|v| v.as_str()),
            r.get(3).and_then(|v| v.as_str()),
        ) else { continue };
        columns_by_index.entry((s.to_string(), t.to_string(), i.to_string())).or_default().push(c.to_string());
    }

    let mut out = Vec::new();
    for r in &idx_res.rows {
        let (Some(s), Some(t), Some(i)) = (
            r.first().and_then(|v| v.as_str()),
            r.get(1).and_then(|v| v.as_str()),
            r.get(2).and_then(|v| v.as_str()),
        ) else { continue };
        let is_pk = r.get(4).and_then(|v| v.as_bool()).unwrap_or(false);
        let is_unique = r.get(5).and_then(|v| v.as_bool()).unwrap_or(false);
        out.push(IndexStat {
            schema: Some(s.to_string()),
            table: t.to_string(),
            name: i.to_string(),
            index_type: r.get(3).and_then(|v| v.as_str()).map(|s| s.to_lowercase()),
            columns: columns_by_index.get(&(s.to_string(), t.to_string(), i.to_string())).cloned().unwrap_or_default(),
            size_bytes: r.get(9).and_then(json_to_u64),
            scans: r.get(6).and_then(json_to_u64),
            reads: r.get(7).and_then(json_to_u64),
            writes: r.get(8).and_then(json_to_u64),
            status: if is_pk { "primary".to_string() } else if is_unique { "unique".to_string() } else { "valid".to_string() },
        });
    }
    Ok(out)
}

async fn index_stats_pg(config: &ConnectionConfig, schema: Option<String>, table: Option<String>) -> Result<Vec<IndexStat>, String> {
    let client = connect_pg(config).await?;
    let q = "SELECT
        n.nspname, t.relname AS tbl, i.relname AS idx,
        pg_get_indexdef(c.indexrelid) AS def,
        c.idx_scan, c.idx_tup_read, c.idx_tup_fetch,
        pg_relation_size(c.indexrelid) AS sz,
        x.indisvalid
      FROM pg_index x
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      LEFT JOIN pg_stat_user_indexes c ON c.indexrelid = i.oid
      WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')";
    let rows = match (&schema, &table) {
        (Some(s), Some(t)) => client.query(&format!("{} AND n.nspname=$1 AND t.relname=$2", q), &[s, t]).await,
        (Some(s), None) => client.query(&format!("{} AND n.nspname=$1", q), &[s]).await,
        _ => client.query(q, &[]).await,
    }.map_err(|e| from_postgres(e, Some(q)).to_json_string())?;

    let mut out = Vec::new();
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let idx: String = r.get(2);
        let def: String = r.get(3);
        let scan: Option<i64> = r.get(4);
        let reads: Option<i64> = r.get(5);
        let sz: i64 = r.get(7);
        let valid: bool = r.get(8);
        out.push(IndexStat {
            schema: Some(sch),
            table: tbl,
            name: idx,
            index_type: Some("btree".to_string()),
            columns: parse_pg_index_columns(&def),
            size_bytes: Some(sz as u64),
            scans: scan.map(|v| v as u64),
            reads: reads.map(|v| v as u64),
            writes: None,
            status: if valid { "valid".to_string() } else { "invalid".to_string() },
        });
    }
    Ok(out)
}

/// Best-effort column extraction from a `pg_get_indexdef(...)` string, e.g.
/// `CREATE INDEX idx_x ON public.tbl USING btree (a, b DESC)` → `["a","b"]`.
fn parse_pg_index_columns(def: &str) -> Vec<String> {
    let after = match def.rfind('(') {
        Some(i) => &def[i + 1..],
        None => return vec![],
    };
    let inside = match after.find(')') {
        Some(j) => &after[..j],
        None => after,
    };
    inside.split(',').map(|c| c.trim().split_whitespace().next().unwrap_or("").to_string()).filter(|s| !s.is_empty()).collect()
}

fn index_stats_sqlite(config: &ConnectionConfig, table: Option<String>) -> Result<Vec<IndexStat>, String> {
    let conn = open_sqlite(config)?;
    let tables: Vec<String> = match &table {
        Some(t) => vec![t.clone()],
        None => {
            let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").map_err(|e| e.to_string())?;
            stmt.query_map([], |r| r.get::<_, String>(0)).ok().map(|it| it.filter_map(|r| r.ok()).collect()).unwrap_or_default()
        }
    };
    let mut out = Vec::new();
    for t in tables {
        let mut stmt = match conn.prepare(&format!("PRAGMA index_list(\"{}\")", t)) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rows = stmt.query_map([], |r| {
            // seq, name, unique, origin, partial
            let name: String = r.get(1)?;
            let origin: String = r.get::<_, String>(3).unwrap_or_else(|_| "c".to_string());
            Ok((name, origin))
        });
        if let Ok(rows) = rows {
            for row in rows {
                if let Ok((idx_name, origin)) = row {
                    let mut cols_stmt = match conn.prepare(&format!("PRAGMA index_info(\"{}\")", idx_name)) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let cols: Vec<String> = cols_stmt.query_map([], |r| r.get::<_, String>(2)).ok()
                        .map(|it| it.filter_map(|r| r.ok()).collect()).unwrap_or_default();
                    out.push(IndexStat {
                        schema: None,
                        table: t.clone(),
                        name: idx_name,
                        index_type: Some(origin_label(&origin)),
                        columns: cols,
                        size_bytes: None,
                        scans: None,
                        reads: None,
                        writes: None,
                        status: "valid".to_string(),
                    });
                }
            }
        }
    }
    Ok(out)
}

fn origin_label(origin: &str) -> String {
    match origin {
        "pk" => "primary key".to_string(),
        "u" => "unique".to_string(),
        _ => "index".to_string(),
    }
}

fn index_stats_duckdb(
    config: &ConnectionConfig,
    schema: Option<String>,
    table: Option<String>,
) -> Result<Vec<IndexStat>, String> {
    let conn = open_duckdb(config)?;

    // Build the WHERE clause defensively; duckdb_indexes exposes
    // database_name, schema_name, table_name, index_name (plus index_oid and
    // SQL-generated flag). We restrict to user schemas.
    let mut sql = String::from(
        "SELECT database_name, schema_name, table_name, index_name
         FROM duckdb_indexes()
         WHERE schema_name NOT IN ('information_schema','pg_catalog')",
    );
    let mut params: Vec<String> = Vec::new();
    match (&schema, &table) {
        (Some(s), Some(t)) => {
            sql.push_str(" AND schema_name = ? AND table_name = ?");
            params.push(s.clone());
            params.push(t.clone());
        }
        (Some(s), None) => {
            sql.push_str(" AND schema_name = ?");
            params.push(s.clone());
        }
        (None, Some(t)) => {
            sql.push_str(" AND table_name = ?");
            params.push(t.clone());
        }
        (None, None) => {}
    }

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(e) => return Err(from_duckdb(e, Some(&sql)).to_json_string()),
    };
    let params_ref: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p as &dyn duckdb::ToSql).collect();
    let rows = match stmt.query_map(params_ref.as_slice(), |r| {
        let schema_name: String = r.get(1)?;
        let table_name: String = r.get(2)?;
        let index_name: String = r.get(3)?;
        Ok((schema_name, table_name, index_name))
    }) {
        Ok(it) => it,
        Err(e) => return Err(from_duckdb(e, Some(&sql)).to_json_string()),
    };

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (sch, tbl, idx) = row;
        out.push(IndexStat {
            schema: Some(sch),
            table: tbl,
            name: idx,
            index_type: Some("index".to_string()),
            columns: Vec::new(),
            size_bytes: None,
            scans: None,
            reads: None,
            writes: None,
            status: "valid".to_string(),
        });
    }
    Ok(out)
}

async fn index_stats_d1(config: &ConnectionConfig, table: Option<String>) -> Result<Vec<IndexStat>, String> {
    // D1 supports the same sqlite_master + PRAGMA introspection over REST.
    // Reuse sqlite-style logic via the REST query helper.
    let tables: Vec<String> = match &table {
        Some(t) => vec![t.clone()],
        None => {
            let res = super::super::d1::run_d1_query(config, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").await?;
            res.rows.into_iter().filter_map(|r| r.first().and_then(|v| v.as_str().map(|s| s.to_string()))).collect()
        }
    };
    let mut out = Vec::new();
    for t in tables {
        let res = super::super::d1::run_d1_query(config, &format!("PRAGMA index_list(\"{}\")", t)).await?;
        for row in res.rows {
            let idx_name = row.get(1).and_then(|v| v.as_str()).map(|s| s.to_string());
            if let Some(name) = idx_name {
                let info = super::super::d1::run_d1_query(config, &format!("PRAGMA index_info(\"{}\")", name)).await?;
                let cols: Vec<String> = info.rows.into_iter().filter_map(|r| r.get(2).and_then(|v| v.as_str().map(|s| s.to_string()))).collect();
                out.push(IndexStat {
                    schema: None,
                    table: t.clone(),
                    name,
                    index_type: Some("index".to_string()),
                    columns: cols,
                    size_bytes: None,
                    scans: None,
                    reads: None,
                    writes: None,
                    status: "valid".to_string(),
                });
            }
        }
    }
    Ok(out)
}

// ───────────────────────── Activity ─────────────────────────

#[tauri::command]
pub async fn get_activity(config: ConnectionConfig) -> Result<ActivitySnapshot, String> {
    let engine = engine_key(&config);
    // Mongo/Redis have no `engine_family()` arm — same short-circuit as
    // `get_database_overview`/`get_database_statistics` above. Without this
    // they fell into the SQLite arm and errored "SQLite database file path
    // is required" instead of showing (or gracefully hiding) activity.
    if engine == "mongodb" {
        return activity_mongo(&config).await;
    }
    if engine == "redis" {
        // `CLIENT LIST` parsing (for a real per-connection activity feed)
        // isn't implemented yet — report "not supported" honestly rather
        // than fabricate rows, same convention as the SQLite/DuckDB arms
        // below. Overview/Statistics already show Redis's live ops/sec and
        // connection count via `redis_info`.
        return Ok(ActivitySnapshot { rows: None, supported: false });
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => activity_pg(&config).await,
        super::super::engine::EngineFamily::Mysql => activity_mysql(&config).await,
        super::super::engine::EngineFamily::Sqlite => Ok(ActivitySnapshot { rows: None, supported: false }),
        // DuckDB is embedded/single-process — no concurrent activity to report.
        super::super::engine::EngineFamily::Duckdb => Ok(ActivitySnapshot { rows: None, supported: false }),
        super::super::engine::EngineFamily::Mssql => activity_mssql(&config).await,
    }
}

/// Mongo's `currentOp` admin command — the equivalent of `pg_stat_activity`/
/// `information_schema.PROCESSLIST`. Filters to genuinely active operations
/// (`active: true`) the same way `activity_pg`/`activity_mysql` only report
/// non-idle sessions.
async fn activity_mongo(config: &ConnectionConfig) -> Result<ActivitySnapshot, String> {
    use super::super::mongo;

    let client = mongo::open_client(config).await.map_err(|e| e.to_json_string())?;
    let admin = client.database("admin");
    let result = admin
        .run_command(doc! { "currentOp": 1, "active": true })
        .await
        .map_err(|e| mongo::MongoError::from(e).to_json_string())?;

    let mut out = Vec::new();
    if let Some(Bson::Array(inprog)) = result.get("inprog") {
        for op in inprog {
            let Bson::Document(op) = op else { continue };
            let pid = op
                .get("opid")
                .map(|v| match v {
                    Bson::Int32(n) => n.to_string(),
                    Bson::Int64(n) => n.to_string(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let secs = mongo::bson_num_as_u64(op, "secs_running") as f64;
            let state = op.get_str("op").unwrap_or("op").to_string();
            let ns = op.get_str("ns").ok().map(|s| s.to_string());
            let query = op
                .get("command")
                .map(|c| c.to_string())
                .or(ns.clone());
            out.push(ActivityRow {
                pid,
                duration_label: format_duration(secs),
                duration_seconds: Some(secs),
                state,
                query,
            });
        }
    }
    Ok(ActivitySnapshot { rows: Some(out), supported: true })
}

async fn activity_mssql(config: &ConnectionConfig) -> Result<ActivitySnapshot, String> {
    let res = super::super::mssql::run_mssql_query(config, "
        SELECT s.session_id,
               DATEDIFF_BIG(SECOND, s.last_request_start_time, GETDATE()) AS secs,
               s.status,
               t.text
        FROM sys.dm_exec_sessions s
        LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id
        OUTER APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
        WHERE s.is_user_process = 1 AND s.session_id <> @@SPID
        ORDER BY secs DESC;
    ").await?;

    let mut out = Vec::new();
    for r in &res.rows {
        let pid = r.first().map(|v| v.to_string()).unwrap_or_default();
        let secs = r.get(1).and_then(|v| v.as_f64());
        let state = r.get(2).and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        let query = r.get(3).and_then(|v| v.as_str()).map(|s| s.to_string());
        out.push(ActivityRow {
            pid,
            duration_label: format_duration(secs.unwrap_or(0.0)),
            duration_seconds: secs,
            state,
            query,
        });
    }
    Ok(ActivitySnapshot { rows: Some(out), supported: true })
}

async fn activity_pg(config: &ConnectionConfig) -> Result<ActivitySnapshot, String> {
    let client = connect_pg(config).await?;
    let rows = client.query(
        "SELECT pid, COALESCE(EXTRACT(EPOCH FROM (now() - COALESCE(query_start, state_change, backend_start)))::float8, 0), state, query
         FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY query_start DESC NULLS LAST",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;

    let mut out = Vec::new();
    for r in rows {
        let pid: i32 = r.get(0);
        let secs: f64 = r.get(1);
        let state: String = r.get::<_, Option<String>>(2).unwrap_or_else(|| "unknown".to_string());
        let query: Option<String> = r.get(3);
        out.push(ActivityRow {
            pid: pid.to_string(),
            duration_label: format_duration(secs),
            duration_seconds: Some(secs),
            state: state_or_empty(&state),
            query,
        });
    }
    Ok(ActivitySnapshot { rows: Some(out), supported: true })
}

async fn activity_mysql(config: &ConnectionConfig) -> Result<ActivitySnapshot, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default().ip_or_hostname(host).tcp_port(port).user(Some(user)).pass(Some(pass)).db_name(db).into();
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => { let _ = pool.disconnect().await; return Err(e.to_string()); }
        Err(_) => { let _ = pool.disconnect().await; return Err(format!("MySQL connection timed out after {}s", CONNECT_TIMEOUT.as_secs())); }
    };
    let rows: Vec<(i64, u64, String, Option<String>)> = conn.query("SELECT ID, TIME, COALESCE(STATE, COMMAND), INFO FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID()").await.map_err(|e| e.to_string())?;
    drop(conn);
    let _ = pool.disconnect().await;

    let mut out = Vec::new();
    for (id, secs, state, info) in rows {
        let secs_f = secs as f64;
        out.push(ActivityRow {
            pid: id.to_string(),
            duration_label: format_duration(secs_f),
            duration_seconds: Some(secs_f),
            state,
            query: info,
        });
    }
    Ok(ActivitySnapshot { rows: Some(out), supported: true })
}

fn state_or_empty(s: &str) -> String {
    if s.is_empty() { "active".to_string() } else { s.to_string() }
}

// ───────────────────────── Auto-increment metadata ─────────────────────────

/// Resolve the auto-increment / identity / sequence-backed column for a table
/// and its current value, so the UI can show "Current maximum ID" and compute
/// the right reset SQL. Returns an error string when the table has no
/// compatible auto-increment column.
#[tauri::command]
pub async fn get_table_auto_increment(
    config: ConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<Option<AutoIncrementMeta>, String> {
    let engine = engine_key(&config);
    if engine == "cloudflare-d1" || engine == "d1" {
        return auto_inc_d1(&config, &table).await;
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => auto_inc_postgres(&config, schema, table).await,
        super::super::engine::EngineFamily::Mysql => auto_inc_mysql(&config, table).await,
        super::super::engine::EngineFamily::Sqlite => auto_inc_sqlite(&config, &table),
        // DuckDB has no auto-increment / sequence concept.
        super::super::engine::EngineFamily::Duckdb => Ok(None),
        super::super::engine::EngineFamily::Mssql => auto_inc_mssql(&config, schema, table).await,
    }
}

async fn auto_inc_mssql(config: &ConnectionConfig, schema: Option<String>, table: String) -> Result<Option<AutoIncrementMeta>, String> {
    let tbl = table.replace('\'', "''");
    let schema_filter = match &schema {
        Some(s) => format!("AND sch.name = '{}'", s.replace('\'', "''")),
        None => String::new(),
    };
    let col_sql = format!("
        SELECT c.name, sch.name
        FROM sys.identity_columns c
        JOIN sys.tables t ON t.object_id = c.object_id
        JOIN sys.schemas sch ON sch.schema_id = t.schema_id
        WHERE t.name = '{}' {};
    ", tbl, schema_filter);
    let col_res = super::super::mssql::run_mssql_query(config, &col_sql).await?;
    let Some(row) = col_res.rows.first() else { return Ok(None) };
    let Some(column_name) = row.first().and_then(|v| v.as_str()).map(|s| s.to_string()) else { return Ok(None) };
    let resolved_schema = row.get(1).and_then(|v| v.as_str()).unwrap_or("dbo").to_string();

    let obj_ref = format!("{}.{}", resolved_schema.replace('\'', "''"), tbl).replace('\'', "''");
    let ident_ident = format!("[{}].[{}]", resolved_schema.replace(']', "]]"), table.replace(']', "]]"));
    let col_ident = format!("[{}]", column_name.replace(']', "]]"));
    let value_sql = format!(
        "SELECT IDENT_CURRENT('{}') AS current_value, (SELECT MAX({}) FROM {}) AS current_max;",
        obj_ref, col_ident, ident_ident
    );
    let value_res = super::super::mssql::run_mssql_query(config, &value_sql).await?;
    let vrow = value_res.rows.first();
    let current_value = vrow.and_then(|r| r.first()).and_then(|v| v.as_f64()).map(|f| f as i64);
    let current_max = vrow.and_then(|r| r.get(1)).and_then(|v| v.as_f64()).map(|f| f as i64);

    Ok(Some(AutoIncrementMeta {
        column_name,
        current_max,
        current_value,
        sequence_name: None,
    }))
}

/// Find the integer PK column from a list of `(name, data_type, is_pk, has_default)`.
/// Mirrors the frontend `detectAutoIncrementColumn` heuristic. Pure (unit-tested).
fn find_identity_column(
    columns: &[(String, String, bool, bool)],
    sqlite_family: bool,
) -> Option<String> {
    let is_int = |t: &str| {
        let dt = t.to_lowercase();
        dt.contains("int") || dt.contains("serial") || dt == "int4" || dt == "int8" || dt == "integer"
    };
    for (name, dtype, is_pk, has_default) in columns {
        if !is_pk || !is_int(dtype) {
            continue;
        }
        if sqlite_family {
            return Some(name.clone());
        }
        if *has_default {
            return Some(name.clone());
        }
    }
    None
}

async fn auto_inc_postgres(
    config: &ConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<Option<AutoIncrementMeta>, String> {
    let client = connect_pg(config).await?;
    let sch = schema.unwrap_or_else(|| "public".to_string());

    // Find the identity / sequence-backed PK column.
    let rows = client.query(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS dtype,
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS is_pk,
                a.atthasdef OR a.attidentity IN ('a', 'd') AS has_default
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
        &[&sch, &table],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;

    let cols: Vec<(String, String, bool, bool)> = rows
        .into_iter()
        .map(|r| {
            let name: String = r.get(0);
            let dtype: String = r.get(1);
            let is_pk: bool = r.get(2);
            let has_default: bool = r.get(3);
            (name, dtype, is_pk, has_default)
        })
        .collect();

    let column_name = match find_identity_column(&cols, false) {
        Some(c) => c,
        None => return Ok(None),
    };

    // Resolve the owned sequence name via pg_depend.
    let seq_row = client.query_opt(
        "SELECT ns.nspname || '.' || seq.relname
         FROM pg_class seq
         JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype IN ('a','i')
         JOIN pg_class tbl ON tbl.oid = dep.refobjid
         JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
         JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
         JOIN pg_namespace ns ON ns.oid = seq.relnamespace
         WHERE tn.nspname = $1 AND tbl.relname = $2 AND att.attname = $3 AND seq.relkind = 'S'",
        &[&sch, &table, &column_name],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    let sequence_name: Option<String> = seq_row.map(|r| r.get(0));

    // Current MAX(column).
    let qt = format!("{}.{}", quote_pg_ident(&sch), quote_pg_ident(&table));
    let max_sql = format!("SELECT COALESCE(MAX({}), 0)::bigint FROM {}", quote_pg_ident(&column_name), qt);
    let current_max: Option<i64> = client.query_opt(&max_sql, &[]).await.ok().flatten().map(|r| r.get(0));

    // Current sequence last_value, when we have a sequence.
    let current_value = if let Some(ref seq) = sequence_name {
        let lv_sql = format!("SELECT last_value::bigint FROM {}", seq);
        client.query_opt(&lv_sql, &[]).await.ok().flatten().map(|r| r.get(0))
    } else {
        None
    };

    Ok(Some(AutoIncrementMeta {
        column_name,
        current_max,
        current_value,
        sequence_name,
    }))
}

async fn auto_inc_mysql(config: &ConnectionConfig, table: String) -> Result<Option<AutoIncrementMeta>, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();
    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default().ip_or_hostname(host).tcp_port(port).user(Some(user)).pass(Some(pass)).db_name(db).into();
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => { let _ = pool.disconnect().await; return Err(e.to_string()); }
        Err(_) => { let _ = pool.disconnect().await; return Err(format!("MySQL connection timed out after {}s", CONNECT_TIMEOUT.as_secs())); }
    };

    // Find the AUTO_INCREMENT column (the PK integer with auto_increment extra).
    let col_row: Option<(String,)> = conn.query_first(format!(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' AND EXTRA LIKE '%auto_increment%'",
        table.replace('\'', "''")
    )).await.ok().flatten();
    let column_name = match col_row {
        Some((name,)) => name,
        None => { drop(conn); let _ = pool.disconnect().await; return Ok(None); }
    };

    // Current AUTO_INCREMENT value + MAX(column).
    let ai: Option<i64> = conn.query_first("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'x'".replace('x', &table.replace('\'', "''"))).await.ok().flatten();
    let max_val: Option<i64> = conn.query_first(format!("SELECT MAX(`{}`) FROM `{}`", column_name.replace('`', "``"), table.replace('`', "``"))).await.ok().flatten();

    drop(conn);
    let _ = pool.disconnect().await;
    Ok(Some(AutoIncrementMeta {
        column_name,
        current_max: max_val,
        current_value: ai,
        sequence_name: None,
    }))
}

fn auto_inc_sqlite(config: &ConnectionConfig, table: &str) -> Result<Option<AutoIncrementMeta>, String> {
    let conn = open_sqlite(config)?;
    // The INTEGER PRIMARY KEY column is the rowid alias (auto-incrementing).
    let pk_col: Option<String> = (|| {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""))).ok()?;
        let rows = stmt.query_map([], |r| {
            let name: String = r.get(1)?;
            let dtype: String = r.get(2)?;
            let pk: i32 = r.get(5)?;
            Ok((name, dtype, pk))
        }).ok()?;
        for row in rows.flatten() {
            if row.2 > 0 && row.1.to_lowercase().contains("int") {
                return Some(row.0);
            }
        }
        None
    })();

    let column_name = match pk_col {
        Some(c) => c,
        None => return Ok(None),
    };

    // MAX(column).
    let current_max: Option<i64> = conn.query_row(
        &format!("SELECT MAX(\"{}\") FROM \"{}\"", column_name.replace('"', "\"\""), table.replace('"', "\"\"")),
        [], |r| r.get(0),
    ).ok();

    // sqlite_sequence stores the last issued value (only present for AUTOINCREMENT tables).
    let current_value: Option<i64> = conn.query_row(
        &format!("SELECT seq FROM sqlite_sequence WHERE name = '{}'", table.replace('\'', "''")),
        [], |r| r.get(0),
    ).ok();

    Ok(Some(AutoIncrementMeta {
        column_name,
        current_max,
        current_value,
        sequence_name: None,
    }))
}

async fn auto_inc_d1(config: &ConnectionConfig, table: &str) -> Result<Option<AutoIncrementMeta>, String> {
    let safe = table.replace('"', "\"\"");
    // PRAGMA table_info to find the INTEGER PRIMARY KEY.
    let res = super::super::d1::run_d1_query(config, &format!("PRAGMA table_info(\"{}\")", safe)).await?;
    let mut column_name: Option<String> = None;
    for row in res.rows {
        let pk = row.get(5).and_then(|v| v.as_i64()).unwrap_or(0);
        let dtype = row.get(2).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if pk > 0 && dtype.contains("int") {
            column_name = row.get(1).and_then(|v| v.as_str()).map(|s| s.to_string());
            break;
        }
    }
    let column_name = match column_name {
        Some(c) => c,
        None => return Ok(None),
    };

    // MAX(column).
    let max_res = super::super::d1::run_d1_query(config, &format!("SELECT MAX(\"{}\") AS m FROM \"{}\"", column_name, safe)).await?;
    let current_max = max_res.rows.first().and_then(|r| r.first()).and_then(|v| v.as_i64());

    // sqlite_sequence last value.
    let seq_res = super::super::d1::run_d1_query(config, &format!("SELECT seq FROM sqlite_sequence WHERE name = '{}'", table.replace('\'', "''"))).await?;
    let current_value = seq_res.rows.first().and_then(|r| r.first()).and_then(|v| v.as_i64());

    Ok(Some(AutoIncrementMeta {
        column_name,
        current_max,
        current_value,
        sequence_name: None,
    }))
}

/// Format a number of seconds as a short human label (e.g. "2.4s", "4m 21s").
pub fn format_duration(secs: f64) -> String {
    if secs < 60.0 {
        format!("{:.1}s", secs)
    } else if secs < 3600.0 {
        let m = (secs / 60.0).floor() as u64;
        let s = (secs % 60.0).round() as u64;
        format!("{}m {}s", m, s)
    } else {
        let h = (secs / 3600.0).floor() as u64;
        let m = ((secs % 3600.0) / 60.0).round() as u64;
        format!("{}h {}m", h, m)
    }
}

// Small helper to keep query_count-style usage ergonomic.
trait QueryCountExt {
    fn query_count(&mut self) -> rusqlite::Result<usize>;
}
impl QueryCountExt for rusqlite::Statement<'_> {
    fn query_count(&mut self) -> rusqlite::Result<usize> {
        let mut n = 0;
        let mut it = self.query([])?;
        while it.next()?.is_some() { n += 1; }
        Ok(n)
    }
}

// A tiny zero-sized struct to keep the serde derive import used in some paths.
#[derive(Serialize)]
struct _KeepSerde;
#[allow(dead_code)]
fn _keep_hashmap(_m: &HashMap<String, String>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<(String, String, bool, bool)> {
        vec![
            ("id".to_string(), "integer".to_string(), true, true),
            ("name".to_string(), "text".to_string(), false, false),
        ]
    }

    #[test]
    fn find_identity_column_postgres() {
        // PK int with default → found.
        assert_eq!(find_identity_column(&cols(), false), Some("id".to_string()));
    }

    #[test]
    fn find_identity_column_postgres_without_default() {
        // No default → not an identity for non-sqlite engines.
        let mut c = cols();
        c[0].3 = false;
        assert_eq!(find_identity_column(&c, false), None);
    }

    #[test]
    fn find_identity_column_sqlite_any_int_pk() {
        // SQLite: any INTEGER PRIMARY KEY is a rowid alias, default not required.
        let mut c = cols();
        c[0].3 = false;
        assert_eq!(find_identity_column(&c, true), Some("id".to_string()));
    }

    #[test]
    fn find_identity_column_skips_non_integer_pk() {
        let c = vec![("id".to_string(), "uuid".to_string(), true, true)];
        assert_eq!(find_identity_column(&c, false), None);
    }

    #[test]
    fn find_identity_column_empty() {
        assert_eq!(find_identity_column(&[], false), None);
    }

    // ─── Live integration tests ─────────────────────────────────────────────
    // Require real Mongo/Redis servers from the repo's `docker-compose.yml`
    // (`docker compose up -d mongo` / `redis`), seeded per
    // `scripts/test-mongo-docker.sh`. Excluded from the default `cargo test`
    // run — run via `cargo test -- --ignored --test-threads=1`, matching the
    // `commands::mongo`/`commands::redis` live-test convention.

    fn mongo_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            name: "test".into(),
            engine: "mongodb".into(),
            host: Some("localhost".into()),
            port: Some(27017),
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

    fn redis_config() -> ConnectionConfig {
        ConnectionConfig { engine: "redis".into(), port: Some(6379), ..mongo_config() }
    }

    #[tokio::test]
    #[ignore]
    async fn live_overview_mongo_reflects_seeded_database() {
        let cfg = mongo_config();
        let ov = overview_mongo(&cfg, "mongodb", Instant::now(), None, None).await.unwrap();
        assert_eq!(ov.connection_status, "Connected");
        assert!(ov.version.is_some(), "buildInfo should report a version");
        assert!(ov.schema_count >= 1, "expected at least the seeded rdsql_test database");
        assert!(ov.table_count >= 1, "expected at least the seeded widgets collection");
        // serverStatus fields — best-effort, but a local unrestricted user has
        // the privilege, so these should be populated in this environment.
        assert!(ov.connections_current.is_some());
        assert!(ov.uptime_seconds.is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn live_overview_redis_reports_memory_and_clients() {
        let cfg = redis_config();
        let ov = overview_redis(&cfg, "redis", Instant::now(), None, None).await.unwrap();
        assert!(ov.memory_used_bytes.unwrap_or(0) > 0);
        assert!(ov.connections_current.unwrap_or(0) >= 1, "this connection itself should count as a client");
        let info = ov.redis_info.expect("redis_info should be populated");
        assert_eq!(info.replication.role, "master");
    }
}
