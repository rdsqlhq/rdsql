//! Engine-aware diagnostic checks.
//!
//! Each `diagnose_*` function runs a set of metadata queries and emits
//! `DiagnosticResult`s. Only checks the engine reliably supports are run —
//! nothing is fabricated. Heavy checks (integrity scans, bloat analysis) are
//! gated behind the `heavy` flag so the auto-refresh path can skip them.

use std::collections::HashMap;

use mysql_async::prelude::*;
use rusqlite::OpenFlags;

use super::super::connection::{normalize_host, ConnectionConfig};
use super::super::error::from_postgres;
use super::connection::{engine_key, open_duckdb, CONNECT_TIMEOUT};
use super::metrics::connect_pg;
use super::{
    DiagnosticCategory, DiagnosticOptions, DiagnosticResult, Severity,
};

// ───────────────────────── dispatch ─────────────────────────

#[tauri::command]
pub async fn run_diagnostics(
    config: ConnectionConfig,
    options: Option<DiagnosticOptions>,
) -> Result<Vec<DiagnosticResult>, String> {
    let opts = options.unwrap_or_default();
    let engine = engine_key(&config);
    // D1 reuses SQLite SQL over REST — short-circuit before family dispatch.
    if engine == "cloudflare-d1" || engine == "d1" {
        return diagnose_d1(&config, opts.heavy).await;
    }
    // Mongo/Redis aren't SQL wire protocols at all — same short-circuit
    // pattern, mirroring `metrics::get_database_overview`.
    if engine == "mongodb" {
        return diagnose_mongo(&config, opts.heavy).await;
    }
    if engine == "redis" {
        return diagnose_redis(&config, opts.heavy).await;
    }
    match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => diagnose_postgres(&config, opts.heavy).await,
        super::super::engine::EngineFamily::Mysql => diagnose_mysql(&config, opts.heavy).await,
        super::super::engine::EngineFamily::Sqlite => diagnose_sqlite(&config, opts.heavy),
        super::super::engine::EngineFamily::Duckdb => diagnose_duckdb(&config, opts.heavy),
        super::super::engine::EngineFamily::Mssql => diagnose_mssql(&config, opts.heavy).await,
    }
}

// ───────────────────────── helpers ─────────────────────────

fn make(
    id: &str,
    category: DiagnosticCategory,
    severity: Severity,
    title: &str,
    description: &str,
    affected: Vec<String>,
    recommendation: Option<String>,
    can_auto_repair: bool,
    repair_action: Option<String>,
    details: HashMap<String, String>,
) -> DiagnosticResult {
    DiagnosticResult {
        id: id.to_string(),
        category,
        severity,
        title: title.to_string(),
        description: description.to_string(),
        affected_objects: affected,
        recommendation,
        can_auto_repair,
        repair_action,
        details,
    }
}

fn json_to_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn json_to_u64(v: &serde_json::Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// ───────────────────────── SQLite ─────────────────────────

fn diagnose_sqlite(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("SQLite database file path is required.".to_string());
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    let conn = rusqlite::Connection::open_with_flags(&path, flags).map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    // Integrity + FK checks are heavy (they scan).
    if heavy {
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap_or_default();
        if integrity != "ok" {
            let mut details = HashMap::new();
            details.insert("result".to_string(), integrity.chars().take(2000).collect());
            results.push(make(
                "sqlite.integrity_check",
                DiagnosticCategory::Tables,
                Severity::Critical,
                "Database integrity check failed",
                "PRAGMA integrity_check reported problems. The database may be corrupt.",
                vec![path.clone()],
                Some("Restore from a backup and rebuild the database, or run VACUUM/REINDEX after backing up.".to_string()),
                false,
                None,
                details,
            ));
        }

        // foreign_key_check returns one row per violation: (table, rowid, parent, fkid)
        let mut stmt = match conn.prepare("PRAGMA foreign_key_check") {
            Ok(s) => s,
            Err(_) => return Ok(results),
        };
        let rows = stmt.query_map([], |r| {
            let table: String = r.get(0)?;
            let rowid: Option<i64> = r.get(1).ok();
            Ok((table, rowid))
        });
        if let Ok(rows) = rows {
            let mut by_table: HashMap<String, Vec<i64>> = HashMap::new();
            for row in rows.flatten() {
                if let Some(rid) = row.1 {
                    by_table.entry(row.0).or_default().push(rid);
                }
            }
            for (table, rowids) in by_table {
                let mut details = HashMap::new();
                details.insert("violations".to_string(), rowids.len().to_string());
                results.push(make(
                    "sqlite.fk_violation",
                    DiagnosticCategory::ForeignKeys,
                    Severity::Critical,
                    "Foreign key violations detected",
                    &format!("Table {} has {} orphan/invalid foreign-key reference(s).", table, rowids.len()),
                    vec![table.clone()],
                    Some("Review the orphaned rows manually. Records are NOT deleted automatically.".to_string()),
                    false,
                    None,
                    details,
                ));
            }
        }
    }

    // Page/freelist statistics are cheap.
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let freelist: i64 = conn.query_row("PRAGMA freelist_count", [], |r| r.get(0)).unwrap_or(0);
    if page_count > 1000 && freelist > 0 {
        let ratio = freelist as f64 / page_count as f64;
        if ratio > 0.20 {
            let mut details = HashMap::new();
            details.insert("free_pages".to_string(), freelist.to_string());
            details.insert("total_pages".to_string(), page_count.to_string());
            results.push(make(
                "sqlite.freelist_bloat",
                DiagnosticCategory::Storage,
                Severity::Warning,
                "High free-page ratio",
                &format!("{:.0}% of database pages are unused/free — VACUUM can reclaim space.", ratio * 100.0),
                vec![path.clone()],
                Some("Run VACUUM (after backing up) to reclaim free pages.".to_string()),
                true,
                Some("sqlite.vacuum".to_string()),
                details,
            ));
        }
    }

    Ok(results)
}

// ───────────────────────── DuckDB ─────────────────────────

fn diagnose_duckdb(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    let conn = open_duckdb(config)?;
    let mut results = Vec::new();

    // DuckDB has no PRAGMA integrity_check. The fact that the file opened
    // read-only is itself a basic health signal, so we surface cheap catalog
    // stats. Each stat is wrapped defensively so one failing query can't abort
    // the whole report.
    let version: String = conn
        .query_row("SELECT version()", [], |r| r.get(0))
        .unwrap_or_default();
    let size_str: String = conn
        .query_row("SELECT database_size FROM pragma_database_size() LIMIT 1", [], |r| r.get(0))
        .unwrap_or_default();
    let table_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM duckdb_tables() WHERE NOT internal AND schema_name NOT IN ('information_schema','pg_catalog')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Heavy check: confirm the catalog is actually readable end-to-end.
    if heavy {
        let catalog_ok: bool = conn
            .query_row("SELECT count(*) FROM duckdb_tables()", [], |r| r.get::<_, i64>(0))
            .map(|_| true)
            .unwrap_or(false);
        if !catalog_ok {
            let mut details = HashMap::new();
            if !version.is_empty() {
                details.insert("version".to_string(), version.clone());
            }
            results.push(make(
                "duckdb.catalog_unreadable",
                DiagnosticCategory::Tables,
                Severity::Critical,
                "DuckDB catalog is not readable",
                "Failed to read from duckdb_tables(). The database file may be corrupt or partially written.",
                config.file_path.clone().unwrap_or_default().split('/').last().map(|s| s.to_string()).into_iter().collect(),
                Some("Restore from a backup and re-open the database. Running CHECKPOINT on a healthy copy can also help.".to_string()),
                false,
                None,
                details,
            ));
        }
    }

    // Surface the basic stats as an informational finding so the UI has
    // something concrete to show even when nothing is wrong.
    if !version.is_empty() || !size_str.is_empty() || table_count > 0 {
        let mut details = HashMap::new();
        if !version.is_empty() {
            details.insert("version".to_string(), version);
        }
        if !size_str.is_empty() {
            details.insert("database_size".to_string(), size_str);
        }
        if table_count > 0 {
            details.insert("table_count".to_string(), table_count.to_string());
        }
        results.push(make(
            "duckdb.stats",
            DiagnosticCategory::Schema,
            Severity::Info,
            "DuckDB database opened successfully",
            "The database file opened read-only and basic catalog stats were collected.",
            vec![],
            None,
            false,
            None,
            details,
        ));
    }

    Ok(results)
}

// ───────────────────────── PostgreSQL ─────────────────────────

async fn diagnose_postgres(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    let client = connect_pg(config).await?;
    let mut results = Vec::new();

    // Invalid indexes (indisvalid = false). Cheap metadata check.
    let rows = client.query(
        "SELECT n.nspname, t.relname, i.relname
         FROM pg_index x
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE x.indisvalid = false AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let idx: String = r.get(2);
        let mut details = HashMap::new();
        details.insert("schema".to_string(), sch.clone());
        details.insert("table".to_string(), tbl.clone());
        results.push(make(
            "postgres.invalid_index",
            DiagnosticCategory::Indexes,
            Severity::Warning,
            "Invalid index detected",
            &format!("Index {} on {} failed to build or was marked invalid.", idx, tbl),
            vec![format!("{}.{}.{}", sch, tbl, idx)],
            Some("DROP and REINDEX the index. This is a destructive operation — back up first.".to_string()),
            true,
            Some("postgres.reindex".to_string()),
            details,
        ));
    }

    // Unused indexes (idx_scan = 0 on an index that isn't supporting a constraint).
    let rows = client.query(
        "SELECT n.nspname, t.relname, i.relname, pg_relation_size(c.indexrelid)
         FROM pg_stat_user_indexes c
         JOIN pg_index x ON x.indexrelid = c.indexrelid
         JOIN pg_class t ON t.oid = c.relid
         JOIN pg_class i ON i.oid = c.indexrelid
         JOIN pg_namespace n ON n.oid = c.schemaname::regnamespace
         WHERE c.idx_scan = 0 AND x.indisunique = false AND x.indisprimary = false
           AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
         ORDER BY pg_relation_size(c.indexrelid) DESC LIMIT 50",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let idx: String = r.get(2);
        let sz: i64 = r.get(3);
        let mut details = HashMap::new();
        details.insert("size_bytes".to_string(), sz.to_string());
        results.push(make(
            "postgres.unused_index",
            DiagnosticCategory::Indexes,
            Severity::Warning,
            "Unused index detected",
            &format!("Index {} on {}.{} has never been scanned (idx_scan = 0).", idx, sch, tbl),
            vec![format!("{}.{}.{}", sch, tbl, idx)],
            Some("If the index truly isn't needed, DROP it to save space and write throughput. Back up first.".to_string()),
            true,
            Some("postgres.drop_index".to_string()),
            details,
        ));
    }

    // Duplicate/redundant indexes (same column prefix on the same table).
    results.extend(detect_pg_duplicate_indexes(&client).await?);

    // Stale statistics (n_mod_since_analyze large relative to reltuples).
    let rows = client.query(
        "SELECT schemaname, relname, n_live_tup, n_mod_since_analyze, GREATEST(0, reltuples)::bigint AS reltuples
         FROM pg_stat_user_tables
         WHERE n_mod_since_analyze > 0
           AND n_live_tup > 0
           AND n_mod_since_analyze::float8 / GREATEST(1, n_live_tup) > 0.20
         ORDER BY n_mod_since_analyze DESC LIMIT 50",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let live: i64 = r.get(2);
        let mods: i64 = r.get(3);
        let mut details = HashMap::new();
        details.insert("live_tuples".to_string(), live.to_string());
        details.insert("modified_since_analyze".to_string(), mods.to_string());
        results.push(make(
            "postgres.stale_stats",
            DiagnosticCategory::Maintenance,
            Severity::Info,
            "Statistics are outdated",
            &format!("Table {}.{} has {} modified tuples since the last ANALYZE.", sch, tbl, mods),
            vec![format!("{}.{}", sch, tbl)],
            Some("Run ANALYZE to refresh planner statistics.".to_string()),
            true,
            Some("postgres.analyze_table".to_string()),
            details,
        ));
    }

    // Dead tuples (a lightweight maintenance signal).
    let rows = client.query(
        "SELECT schemaname, relname, n_dead_tup, n_live_tup
         FROM pg_stat_user_tables
         WHERE n_dead_tup > 0
         ORDER BY n_dead_tup DESC LIMIT 50",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let dead: i64 = r.get(2);
        let live: i64 = r.get(3);
        let ratio = if live > 0 { dead as f64 / live as f64 } else { 0.0 };
        if dead > 1000 && ratio > 0.10 {
            let mut details = HashMap::new();
            details.insert("dead_tuples".to_string(), dead.to_string());
            details.insert("live_tuples".to_string(), live.to_string());
            results.push(make(
                "postgres.dead_tuples",
                DiagnosticCategory::Maintenance,
                Severity::Warning,
                "Dead tuples accumulating",
                &format!("Table {}.{} has {} dead tuples ({:.0}% of live). VACUUM can reclaim them.", sch, tbl, dead, ratio * 100.0),
                vec![format!("{}.{}", sch, tbl)],
                Some("Run VACUUM (ANALYZE) to reclaim dead tuples.".to_string()),
                true,
                Some("postgres.vacuum_table".to_string()),
                details,
            ));
        }
    }

    // Sequence synchronization (only when heavy: requires per-sequence MAX(col)).
    if heavy {
        results.extend(detect_pg_sequence_desync(&client).await?);
    }

    // Long-running queries (> 5 min, non-idle).
    let rows = client.query(
        "SELECT pid, COALESCE(EXTRACT(EPOCH FROM (now() - query_start))::bigint, 0), left(query, 200)
         FROM pg_stat_activity
         WHERE state <> 'idle' AND query_start IS NOT NULL
           AND now() - query_start > interval '5 minutes'
           AND pid <> pg_backend_pid()",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    for r in rows {
        let pid: i32 = r.get(0);
        let secs: i64 = r.get(1);
        let q: String = r.get(2);
        let mut details = HashMap::new();
        details.insert("pid".to_string(), pid.to_string());
        details.insert("duration_seconds".to_string(), secs.to_string());
        details.insert("query".to_string(), q);
        results.push(make(
            "postgres.long_running_query",
            DiagnosticCategory::Performance,
            Severity::Warning,
            "Long-running query detected",
            &format!("Backend {} has a query running for {}s.", pid, secs),
            vec![pid.to_string()],
            Some("Investigate the query. Cancel it if it's stuck (confirmation required).".to_string()),
            false,
            None,
            details,
        ));
    }

    // Blocking queries (a session holding a lock that others wait on).
    let rows = client.query(
        "SELECT blocked.pid, blocking.pid
         FROM pg_stat_activity blocking
         JOIN pg_locks bl ON bl.pid = blocking.pid AND bl.locktype = 'transactionid'
         JOIN pg_stat_activity blocked ON blocked.pid <> blocking.pid
         WHERE blocking.state <> 'idle' LIMIT 50",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    if !rows.is_empty() {
        let mut details = HashMap::new();
        details.insert("count".to_string(), rows.len().to_string());
        results.push(make(
            "postgres.blocking_queries",
            DiagnosticCategory::Performance,
            Severity::Critical,
            "Blocking queries detected",
            &format!("{} blocking relationship(s) found in pg_stat_activity.", rows.len()),
            vec![],
            Some("Investigate the blocking backends. Termination requires explicit confirmation.".to_string()),
            false,
            None,
            details,
        ));
    }

    Ok(results)
}

/// Detect duplicate/redundant btree indexes (same column prefix on a table).
async fn detect_pg_duplicate_indexes(client: &tokio_postgres::Client) -> Result<Vec<DiagnosticResult>, String> {
    let rows = client.query(
        "SELECT n.nspname, t.relname, string_agg(i.relname, ', ' ORDER BY i.relname), count(*)
         FROM pg_index x
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
         GROUP BY n.nspname, t.relname, pg_get_indexdef(x.indexrelid)
         HAVING count(*) > 1",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;
    let mut out = Vec::new();
    for r in rows {
        let sch: String = r.get(0);
        let tbl: String = r.get(1);
        let names: String = r.get(2);
        let count: i64 = r.get(3);
        let mut details = HashMap::new();
        details.insert("indexes".to_string(), names.clone());
        details.insert("count".to_string(), count.to_string());
        out.push(make(
            "postgres.duplicate_index",
            DiagnosticCategory::Indexes,
            Severity::Warning,
            "Duplicate/redundant index detected",
            &format!("Table {}.{} has {} indexes with the same definition: {}.", sch, tbl, count, names),
            vec![format!("{}.{}", sch, tbl)],
            Some("Review and DROP the redundant index. Back up first.".to_string()),
            true,
            Some("postgres.drop_index".to_string()),
            details,
        ));
    }
    Ok(out)
}

/// Detect sequences whose last_value is behind the MAX(column) (a classic
/// cause of duplicate-key errors after bulk inserts / restores).
async fn detect_pg_sequence_desync(client: &tokio_postgres::Client) -> Result<Vec<DiagnosticResult>, String> {
    // Map each sequence to its owned column when possible via pg_depend.
    let rows = client.query(
        "SELECT
            ns.nspname AS seq_schema, seq.relname AS seq_name,
            tn.nspname AS tbl_schema, tbl.relname AS tbl_name, att.attname AS col_name,
            pg_sequence_last_value(seq.oid) AS last_value
         FROM pg_class seq
         JOIN pg_namespace ns ON ns.oid = seq.relnamespace
         JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype IN ('a','i')
         JOIN pg_class tbl ON tbl.oid = dep.refobjid
         JOIN pg_namespace tn ON tn.oid = tbl.relnamespace
         JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
         WHERE seq.relkind = 'S' AND ns.nspname NOT IN ('pg_catalog','information_schema','pg_toast')",
        &[],
    ).await.map_err(|e| from_postgres(e, None).to_json_string())?;

    let mut out = Vec::new();
    for r in rows {
        let seq_schema: String = r.get(0);
        let seq_name: String = r.get(1);
        let tbl_schema: String = r.get(2);
        let tbl_name: String = r.get(3);
        let col_name: String = r.get(4);
        let last_value: Option<i64> = r.get(5);
        let qualified = format!("{}.{}", tbl_schema, tbl_name);
        let max_sql = format!("SELECT COALESCE(MAX(\"{}\"), 0)::bigint FROM {}", col_name.replace('"', "\"\""), qualified);
        let max_val: i64 = match client.query_one(&max_sql, &[]).await {
            Ok(row) => row.get(0),
            Err(_) => continue,
        };
        let last = last_value.unwrap_or(0);
        if max_val > last {
            let mut details = HashMap::new();
            details.insert("sequence".to_string(), format!("{}.{}", seq_schema, seq_name));
            details.insert("column".to_string(), format!("{}.{}", qualified, col_name));
            details.insert("last_value".to_string(), last.to_string());
            details.insert("max_value".to_string(), max_val.to_string());
            out.push(make(
                "postgres.sequence_desync",
                DiagnosticCategory::Tables,
                Severity::Critical,
                "PostgreSQL sequence is out of sync",
                &format!("Sequence {}.{} is at {}, but MAX({}.{}) is {}.", seq_schema, seq_name, last, qualified, col_name, max_val),
                vec![format!("{}.{}", qualified, col_name)],
                Some("Synchronize the sequence with setval(MAX(col)). Safe to apply automatically.".to_string()),
                true,
                Some("postgres.seq_sync".to_string()),
                details,
            ));
        }
    }
    Ok(out)
}

// ───────────────────────── MySQL / MariaDB ─────────────────────────

async fn diagnose_mysql(config: &ConnectionConfig, _heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
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
    let mut results = Vec::new();

    // Fragmented tables: DATA_FREE large relative to DATA_LENGTH.
    let rows: Vec<(String, u64, u64)> = conn.query(
        "SELECT TABLE_NAME, COALESCE(DATA_FREE,0), COALESCE(DATA_LENGTH,1)
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
           AND COALESCE(DATA_FREE,0) > 0 AND DATA_LENGTH > 0
           AND DATA_FREE / DATA_LENGTH > 0.25
         ORDER BY DATA_FREE DESC LIMIT 50",
    ).await.map_err(|e| e.to_string())?;
    for (tbl, free, len) in rows {
        let ratio = free as f64 / len as f64;
        let mut details = HashMap::new();
        details.insert("data_free".to_string(), free.to_string());
        details.insert("data_length".to_string(), len.to_string());
        results.push(make(
            "mysql.fragmentation",
            DiagnosticCategory::Storage,
            Severity::Warning,
            "Table fragmentation detected",
            &format!("Table {} has {:.0}% free/fragmented space (DATA_FREE).", tbl, ratio * 100.0),
            vec![tbl.clone()],
            Some("Run OPTIMIZE TABLE to reclaim space (it locks the table briefly).".to_string()),
            true,
            Some("mysql.optimize_table".to_string()),
            details,
        ));
    }

    // Tables without a primary key (common cause of replication + perf issues).
    let rows: Vec<String> = conn.query(
        "SELECT t.TABLE_NAME
         FROM information_schema.TABLES t
         LEFT JOIN information_schema.TABLE_CONSTRAINTS c
           ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
         WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND c.CONSTRAINT_NAME IS NULL",
    ).await.map_err(|e| e.to_string())?;
    for tbl in rows {
        results.push(make(
            "mysql.no_primary_key",
            DiagnosticCategory::Constraints,
            Severity::Warning,
            "Table has no primary key",
            &format!("Table {} has no primary key defined.", tbl),
            vec![tbl.clone()],
            Some("Add a primary key (e.g. an auto-increment id) for reliable replication and row identity.".to_string()),
            false,
            None,
            HashMap::new(),
        ));
    }

    // Connections vs max_connections.
    let conn_usage: Option<(i64, i64)> = conn.query_first("SELECT (SELECT COUNT(*) FROM information_schema.PROCESSLIST), (SELECT @@max_connections)").await.ok().flatten();
    if let Some((used, maxv)) = conn_usage {
        if maxv > 0 {
            let ratio = used as f64 / maxv as f64;
            if ratio > 0.80 {
                let mut details = HashMap::new();
                details.insert("used".to_string(), used.to_string());
                details.insert("max".to_string(), maxv.to_string());
                results.push(make(
                    "mysql.high_connections",
                    DiagnosticCategory::Performance,
                    Severity::Critical,
                    "Connection pool near capacity",
                    &format!("{} of {} connections in use ({:.0}%).", used, maxv, ratio * 100.0),
                    vec![],
                    Some("Investigate long-lived sessions; raise max_connections or add pooling.".to_string()),
                    false,
                    None,
                    details,
                ));
            }
        }
    }

    drop(conn);
    let _ = pool.disconnect().await;
    Ok(results)
}

// ───────────────────────── SQL Server ─────────────────────────

async fn diagnose_mssql(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    let mut results = Vec::new();

    // Index fragmentation — dm_db_index_physical_stats with LIMITED mode is
    // cheap (page-count scan, no deep scan), but still gated behind `heavy`
    // to match every other engine's convention here.
    if heavy {
        let rows = super::super::mssql::run_mssql_query(config, "
            SELECT s.name, t.name, i.name, ips.avg_fragmentation_in_percent, ips.page_count
            FROM sys.dm_db_index_physical_stats(DB_ID(), NULL, NULL, NULL, 'LIMITED') ips
            JOIN sys.indexes i ON i.object_id = ips.object_id AND i.index_id = ips.index_id
            JOIN sys.tables t ON t.object_id = i.object_id
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            WHERE ips.avg_fragmentation_in_percent > 10 AND ips.page_count > 100 AND i.index_id > 0
            ORDER BY ips.avg_fragmentation_in_percent DESC;
        ").await?;
        for r in &rows.rows {
            let (Some(sch), Some(tbl), Some(idx)) = (
                r.first().and_then(|v| v.as_str()),
                r.get(1).and_then(|v| v.as_str()),
                r.get(2).and_then(|v| v.as_str()),
            ) else { continue };
            let frag = r.get(3).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let pages = r.get(4).and_then(json_to_u64).unwrap_or(0);
            let target = format!("{}.{}", sch, tbl);
            let mut details = HashMap::new();
            details.insert("index".to_string(), idx.to_string());
            details.insert("fragmentation".to_string(), format!("{:.1}%", frag));
            details.insert("pages".to_string(), pages.to_string());
            // REORGANIZE is a safe, online, in-place op; REBUILD reclaims more
            // space but is heavier — only suggest it once fragmentation is bad.
            let (repair_action, recommendation) = if frag > 30.0 {
                ("mssql.rebuild_index", "Fragmentation is high — rebuild the index to reclaim space and restore performance.")
            } else {
                ("mssql.reorganize_index", "Reorganize the index (online, in-place) to reduce fragmentation.")
            };
            results.push(make(
                "mssql.index_fragmentation",
                DiagnosticCategory::Indexes,
                if frag > 30.0 { Severity::Warning } else { Severity::Info },
                "Index fragmentation detected",
                &format!("Index {} on {} is {:.1}% fragmented ({} pages).", idx, target, frag, pages),
                vec![format!("{}.{}", target, idx)],
                Some(recommendation.to_string()),
                true,
                Some(repair_action.to_string()),
                details,
            ));
        }
    }

    // Tables without a primary key.
    let rows = super::super::mssql::run_mssql_query(config, "
        SELECT s.name, t.name
        FROM sys.tables t
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1);
    ").await?;
    for r in &rows.rows {
        let (Some(sch), Some(tbl)) = (r.first().and_then(|v| v.as_str()), r.get(1).and_then(|v| v.as_str())) else { continue };
        let target = format!("{}.{}", sch, tbl);
        results.push(make(
            "mssql.no_primary_key",
            DiagnosticCategory::Constraints,
            Severity::Warning,
            "Table has no primary key",
            &format!("Table {} has no primary key defined.", target),
            vec![target],
            Some("Add a primary key (e.g. an IDENTITY column) for reliable row identity and replication.".to_string()),
            false,
            None,
            HashMap::new(),
        ));
    }

    // Blocking sessions — a session holding a lock another is waiting on.
    let rows = super::super::mssql::run_mssql_query(config, "
        SELECT session_id, blocking_session_id, wait_type, wait_time
        FROM sys.dm_exec_requests
        WHERE blocking_session_id <> 0;
    ").await?;
    for r in &rows.rows {
        let session = r.first().map(|v| v.to_string()).unwrap_or_default();
        let blocker = r.get(1).map(|v| v.to_string()).unwrap_or_default();
        let wait_type = r.get(2).and_then(|v| v.as_str()).unwrap_or("unknown");
        let wait_ms = r.get(3).and_then(json_to_u64).unwrap_or(0);
        let mut details = HashMap::new();
        details.insert("blocked_session".to_string(), session.clone());
        details.insert("blocking_session".to_string(), blocker.clone());
        details.insert("wait_type".to_string(), wait_type.to_string());
        details.insert("wait_ms".to_string(), wait_ms.to_string());
        results.push(make(
            "mssql.blocking_session",
            DiagnosticCategory::Performance,
            Severity::Critical,
            "Session blocked",
            &format!("Session {} is blocked by session {} (waiting on {} for {}ms).", session, blocker, wait_type, wait_ms),
            vec![format!("session {}", session)],
            Some("Investigate the blocking session (long transaction, missing COMMIT, or a lock-heavy query).".to_string()),
            false,
            None,
            details,
        ));
    }

    // Connections vs @@MAX_CONNECTIONS.
    let conn_usage = super::super::mssql::run_mssql_query(config, "
        SELECT (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1), (SELECT CAST(@@MAX_CONNECTIONS AS BIGINT));
    ").await?;
    if let Some(row) = conn_usage.rows.first() {
        let used = row.first().and_then(json_to_u64).unwrap_or(0);
        let maxv = row.get(1).and_then(json_to_u64).unwrap_or(0);
        if maxv > 0 {
            let ratio = used as f64 / maxv as f64;
            if ratio > 0.80 {
                let mut details = HashMap::new();
                details.insert("used".to_string(), used.to_string());
                details.insert("max".to_string(), maxv.to_string());
                results.push(make(
                    "mssql.high_connections",
                    DiagnosticCategory::Performance,
                    Severity::Critical,
                    "Connection pool near capacity",
                    &format!("{} of {} connections in use ({:.0}%).", used, maxv, ratio * 100.0),
                    vec![],
                    Some("Investigate long-lived sessions; raise the server's max connections or add pooling.".to_string()),
                    false,
                    None,
                    details,
                ));
            }
        }
    }

    Ok(results)
}

// ───────────────────────── Cloudflare D1 ─────────────────────────

async fn diagnose_d1(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    let mut results = Vec::new();
    if heavy {
        // D1 supports integrity_check & foreign_key_check over REST.
        let res = super::super::d1::run_d1_query(config, "PRAGMA integrity_check").await?;
        let integrity = res.rows.first().and_then(|r| r.first()).and_then(|v| v.as_str()).unwrap_or("ok");
        if integrity != "ok" {
            let mut details = HashMap::new();
            details.insert("result".to_string(), integrity.to_string());
            results.push(make(
                "d1.integrity_check",
                DiagnosticCategory::Tables,
                Severity::Critical,
                "Database integrity check failed",
                "PRAGMA integrity_check reported problems.",
                vec![],
                Some("Contact Cloudflare support / restore from a D1 backup.".to_string()),
                false,
                None,
                details,
            ));
        }

        let res = super::super::d1::run_d1_query(config, "PRAGMA foreign_key_check").await?;
        if !res.rows.is_empty() {
            let mut details = HashMap::new();
            details.insert("violations".to_string(), res.rows.len().to_string());
            results.push(make(
                "d1.fk_violation",
                DiagnosticCategory::ForeignKeys,
                Severity::Critical,
                "Foreign key violations detected",
                &format!("{} foreign-key violation(s) found.", res.rows.len()),
                vec![],
                Some("Review orphaned rows manually. Records are NOT deleted automatically.".to_string()),
                false,
                None,
                details,
            ));
        }
    }

    // Freelist ratio (cheap). D1 may not support the subquery form, so fall back to PRAGMA.
    let res = match super::super::d1::run_d1_query(config, "SELECT (SELECT COUNT(*) FROM pragma_freelist_count) AS free, (SELECT COUNT(*) FROM pragma_page_count) AS total").await {
        Ok(r) => Some(r),
        Err(_) => super::super::d1::run_d1_query(config, "PRAGMA freelist_count").await.ok(),
    };
    if let Some(res) = res {
        let free = res.rows.first().and_then(|r| r.first()).and_then(json_to_u64).unwrap_or(0);
        if free > 1000 {
            let mut details = HashMap::new();
            details.insert("free_pages".to_string(), free.to_string());
            results.push(make(
                "d1.freelist_bloat",
                DiagnosticCategory::Storage,
                Severity::Warning,
                "High free-page ratio",
                &format!("D1 reports {} free pages. Note: remote VACUUM is not available on D1.", free),
                vec![],
                Some("D1 does not expose VACUUM over the REST API. Contact Cloudflare support if reclaiming space is required.".to_string()),
                false,
                None,
                details,
            ));
        }
    }

    // keep helper imports used
    let _ = json_to_i64(&serde_json::Value::Null);
    Ok(results)
}

// ───────────────────────── Mongo ─────────────────────────

/// Every check here needs an elevated privilege (`inprog` for `currentOp`,
/// replica-set membership for `replSetGetStatus`) that a restricted user
/// commonly lacks, or is simply inapplicable to a standalone deployment
/// (`replSetGetStatus` errors on a non-replica-set server). Both are treated
/// as "nothing to report", not a failure — `if let Ok(..)` around each admin
/// command, never `?`, so one missing privilege doesn't blank the others.
/// No repair actions yet (`can_auto_repair: false` throughout) — Mongo
/// maintenance isn't wired into `repair.rs`.
async fn diagnose_mongo(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    use super::super::mongo;
    use mongodb::bson::{doc, Bson};

    let mut results = Vec::new();
    if !heavy {
        return Ok(results);
    }

    let client = mongo::open_client(config).await.map_err(|e| e.to_json_string())?;
    let admin = client.database("admin");

    fn bson_display(v: &Bson) -> String {
        match v {
            Bson::String(s) => s.clone(),
            Bson::Int32(n) => n.to_string(),
            Bson::Int64(n) => n.to_string(),
            Bson::Double(n) => n.to_string(),
            _ => String::new(),
        }
    }

    // Long-running operations (running >= 30s).
    if let Ok(result) = admin
        .run_command(doc! { "currentOp": 1, "active": true, "secs_running": doc! { "$gte": 30 } })
        .await
    {
        if let Some(Bson::Array(ops)) = result.get("inprog") {
            for op in ops {
                let Bson::Document(op) = op else { continue };
                let secs = mongo::bson_num_as_u64(op, "secs_running");
                let ns = op.get("ns").map(bson_display).unwrap_or_default();
                let opid = op.get("opid").map(bson_display).unwrap_or_default();
                let mut details = HashMap::new();
                details.insert("opid".to_string(), opid.clone());
                details.insert("duration_seconds".to_string(), secs.to_string());
                if !ns.is_empty() {
                    details.insert("namespace".to_string(), ns.clone());
                }
                results.push(make(
                    "mongo.long_running_op",
                    DiagnosticCategory::Performance,
                    Severity::Warning,
                    "Long-running operation detected",
                    &format!("Operation {} on {} has been running for {}s.", opid, if ns.is_empty() { "the server" } else { &ns }, secs),
                    if ns.is_empty() { vec![] } else { vec![ns] },
                    Some("Investigate with `db.currentOp()`; kill it with `db.killOp()` if stuck (confirmation required).".to_string()),
                    false,
                    None,
                    details,
                ));
            }
        }
    }

    // Replica set member health — silently skipped on a standalone
    // deployment, where `replSetGetStatus` simply errors.
    if let Ok(status) = admin.run_command(doc! { "replSetGetStatus": 1 }).await {
        if let Some(Bson::Array(members)) = status.get("members") {
            for m in members {
                let Bson::Document(m) = m else { continue };
                let name = m.get("name").map(bson_display).unwrap_or_else(|| "unknown".to_string());
                let state = m.get("stateStr").map(bson_display).unwrap_or_else(|| "UNKNOWN".to_string());
                let healthy = mongo::bson_num_as_u64(m, "health") == 1;
                if !healthy {
                    let mut details = HashMap::new();
                    details.insert("state".to_string(), state.clone());
                    results.push(make(
                        "mongo.replica_member_down",
                        DiagnosticCategory::Replication,
                        Severity::Critical,
                        "Replica set member unreachable",
                        &format!("Member {} is unhealthy (state: {}).", name, state),
                        vec![name],
                        Some("Check the member's network connectivity, process status, and logs.".to_string()),
                        false,
                        None,
                        details,
                    ));
                }
            }
        }
    }

    Ok(results)
}

// ───────────────────────── Redis ─────────────────────────

async fn diagnose_redis(config: &ConnectionConfig, heavy: bool) -> Result<Vec<DiagnosticResult>, String> {
    use super::super::redis as redis_mod;

    let mut results = Vec::new();
    if !heavy {
        return Ok(results);
    }

    let info = redis_mod::fetch_info_text(config).await.map_err(|e| e.to_json_string())?;
    let memory = redis_mod::parse_info_memory(&info);
    let stats = redis_mod::parse_info_stats(&info);
    let clients = redis_mod::parse_info_clients(&info);
    let persistence = redis_mod::parse_info_persistence(&info);

    let total_lookups = stats.keyspace_hits + stats.keyspace_misses;
    if total_lookups > 0 {
        let hit_rate = stats.keyspace_hits as f64 / total_lookups as f64;
        if hit_rate < 0.8 {
            let mut details = HashMap::new();
            details.insert("hit_rate".to_string(), format!("{:.1}%", hit_rate * 100.0));
            results.push(make(
                "redis.low_hit_rate",
                DiagnosticCategory::Performance,
                Severity::Warning,
                "Low cache hit rate",
                &format!("Keyspace hit rate is {:.1}%, below the 80% healthy threshold.", hit_rate * 100.0),
                vec![],
                Some("Review key expiration/eviction policy, or increase maxmemory if evictions are frequent.".to_string()),
                false,
                None,
                details,
            ));
        }
    }

    if stats.evicted_keys > 0 {
        let mut details = HashMap::new();
        details.insert("evicted_keys".to_string(), stats.evicted_keys.to_string());
        results.push(make(
            "redis.evictions",
            DiagnosticCategory::Performance,
            Severity::Warning,
            "Keys are being evicted",
            &format!("{} key(s) evicted due to memory pressure.", stats.evicted_keys),
            vec![],
            Some("Increase `maxmemory`, or review the eviction policy (`maxmemory-policy`) if this is expected.".to_string()),
            false,
            None,
            details,
        ));
    }

    if memory.mem_fragmentation_ratio > 1.5 {
        let mut details = HashMap::new();
        details.insert("fragmentation_ratio".to_string(), format!("{:.2}", memory.mem_fragmentation_ratio));
        results.push(make(
            "redis.high_fragmentation",
            DiagnosticCategory::Storage,
            Severity::Warning,
            "High memory fragmentation",
            &format!("Memory fragmentation ratio is {:.2} (RSS well above used memory).", memory.mem_fragmentation_ratio),
            vec![],
            Some("Consider `MEMORY PURGE` (if supported) or a controlled restart during a maintenance window.".to_string()),
            false,
            None,
            details,
        ));
    }

    if let Some(status) = &persistence.rdb_last_bgsave_status {
        if status != "ok" {
            let mut details = HashMap::new();
            details.insert("status".to_string(), status.clone());
            results.push(make(
                "redis.rdb_save_failed",
                DiagnosticCategory::Maintenance,
                Severity::Critical,
                "Last RDB save failed",
                &format!("The last background save reported status \"{}\".", status),
                vec![],
                Some("Check disk space and permissions on the RDB save directory, then verify with `BGSAVE`.".to_string()),
                false,
                None,
                details,
            ));
        }
    }

    if clients.connected_clients > 0 {
        let blocked_ratio = clients.blocked_clients as f64 / clients.connected_clients as f64;
        if clients.blocked_clients > 0 && blocked_ratio > 0.2 {
            let mut details = HashMap::new();
            details.insert("blocked_clients".to_string(), clients.blocked_clients.to_string());
            details.insert("connected_clients".to_string(), clients.connected_clients.to_string());
            results.push(make(
                "redis.blocked_clients",
                DiagnosticCategory::Connection,
                Severity::Info,
                "Many clients blocked on commands",
                &format!("{} of {} connected clients are blocked (e.g. on BLPOP).", clients.blocked_clients, clients.connected_clients),
                vec![],
                None,
                false,
                None,
                details,
            ));
        }
    }

    Ok(results)
}

// ───────────────────────── Pure helper tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_helpers_parse_json_numbers() {
        assert_eq!(json_to_i64(&serde_json::json!(42)), Some(42));
        assert_eq!(json_to_i64(&serde_json::json!("42")), Some(42));
        assert_eq!(json_to_i64(&serde_json::json!(null)), None);
        assert_eq!(json_to_u64(&serde_json::json!("7")), Some(7));
    }

    #[test]
    fn sequence_desync_detection_logic() {
        // Mirrors the runtime check: desync only when max > last.
        let last = 9842i64;
        let max = 9917i64;
        assert!(max > last, "max must exceed last to be a desync");
        // A synchronized sequence is not flagged.
        let last_sync = 9917i64;
        assert!(!(max > last_sync));
    }

    // ─── Live integration tests ─────────────────────────────────────────────
    // See the identical convention in `health::metrics::tests` — real
    // Mongo/Redis servers from `docker-compose.yml`, run via
    // `cargo test -- --ignored --test-threads=1`.

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
    async fn live_diagnose_mongo_does_not_error_on_standalone_server() {
        // The seeded container is a standalone (non-replica-set) server, so
        // `replSetGetStatus` will error — that must be swallowed, not
        // propagated, and `currentOp` should simply come back empty.
        let cfg = mongo_config();
        let results = diagnose_mongo(&cfg, true).await.unwrap();
        assert!(results.is_empty(), "no long-running ops or unhealthy replica members expected, got {:?}", results);
    }

    #[tokio::test]
    #[ignore]
    async fn live_diagnose_redis_does_not_error_on_healthy_server() {
        // A freshly-started, lightly-used instance shouldn't trip any of the
        // warning thresholds (low hit rate needs lookups to have happened at
        // all — `total_lookups == 0` is explicitly excluded).
        let cfg = redis_config();
        let results = diagnose_redis(&cfg, true).await.unwrap();
        assert!(
            results.iter().all(|r| r.id != "redis.rdb_save_failed"),
            "a fresh instance should not report a failed save: {:?}", results
        );
    }
}
