//! Repair preview + execution.
//!
//! Safety model (spec sections 6–9): every repair flows through
//! **preview → confirm → execute → verify → result**. The backend never
//! auto-applies a destructive operation — `preview_repair` only *generates*
//! SQL, and `execute_repair` runs exactly the SQL the user confirmed.
//!
//! `execute_repair` is cancellation-aware via the shared `QueryRegistry`:
//! long-running REINDEX / OPTIMIZE TABLE can be aborted like a normal query.

use std::time::Instant;

use mysql_async::prelude::*;
use tokio_util::sync::CancellationToken;

use super::super::connection::ConnectionConfig;
use super::super::error::{from_duckdb, from_postgres};
use super::super::query::QueryRegistry;
use super::connection::{engine_key, open_duckdb_rw, open_sqlite_rw};
use super::metrics::connect_pg;
use super::{RepairPlan, RepairRequest, RepairResult, RiskLevel};

// ───────────────────────── Preview ─────────────────────────

#[tauri::command]
pub async fn preview_repair(
    config: ConnectionConfig,
    request: RepairRequest,
) -> Result<RepairPlan, String> {
    let engine = engine_key(&config);
    let action = request.repair_action.as_str();
    let affected = request.affected_objects.clone();

    match (engine.as_str(), action) {
        ("postgres" | "postgresql" | "cockroachdb" | "yugabytedb", "postgres.seq_sync") => {
            let seq = request.details.get("sequence").cloned().unwrap_or_default();
            let col = request.details.get("column").cloned().unwrap_or_default();
            if seq.is_empty() || col.is_empty() {
                return Err("Missing sequence or column for seq_sync.".to_string());
            }
            let (tbl, colname) = split_qualified(&col);
            let sql = format!(
                "SELECT setval('{}', COALESCE((SELECT MAX(\"{}\") FROM {}), 1), true);",
                seq, colname.replace('"', "\"\""), tbl
            );
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: format!("Synchronize sequence {}", seq),
                sql: vec![sql],
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: Some(format!("SELECT last_value FROM {}", seq)),
            })
        }
        ("postgres" | "postgresql" | "cockroachdb" | "yugabytedb", "postgres.analyze_table") => {
            let sql: Vec<String> = affected.iter().map(|t| format!("ANALYZE {};", t)).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "ANALYZE tables (refresh planner statistics)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("postgres" | "postgresql" | "cockroachdb" | "yugabytedb", "postgres.vacuum_table") => {
            let sql: Vec<String> = affected.iter().map(|t| format!("VACUUM (ANALYZE) {};", t)).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "VACUUM (ANALYZE) tables (reclaim dead tuples)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("postgres" | "postgresql" | "cockroachdb" | "yugabytedb", "postgres.reindex") => {
            // REINDEX is non-destructive (rebuilds a broken/invalid index in place).
            let sql: Vec<String> = affected.iter().map(|i| format!("REINDEX INDEX {};", i)).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "REINDEX invalid indexes".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("postgres" | "postgresql" | "cockroachdb" | "yugabytedb", "postgres.drop_index") => {
            // Destructive — requires backup recommendation and stronger confirmation.
            let sql: Vec<String> = affected.iter().map(|i| format!("DROP INDEX {};", i)).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "DROP redundant/unused indexes (destructive)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Dangerous,
                estimated_affected_rows: None,
                requires_backup: true,
                verification_sql: None,
            })
        }
        ("mysql" | "mariadb" | "tidb" | "planetscale", "mysql.optimize_table") => {
            let sql: Vec<String> = affected.iter().map(|t| format!("OPTIMIZE TABLE {};", t)).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "OPTIMIZE TABLE (reclaim fragmented space)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("mssql" | "sqlserver", "mssql.reorganize_index") => {
            let sql: Vec<String> = affected.iter().map(|a| {
                let (schema, table, index) = split_schema_table_index(a);
                format!("ALTER INDEX [{}] ON [{}].[{}] REORGANIZE;", index.replace(']', "]]"), schema.replace(']', "]]"), table.replace(']', "]]"))
            }).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "REORGANIZE index (online, in-place defragmentation)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("mssql" | "sqlserver", "mssql.rebuild_index") => {
            let sql: Vec<String> = affected.iter().map(|a| {
                let (schema, table, index) = split_schema_table_index(a);
                format!("ALTER INDEX [{}] ON [{}].[{}] REBUILD;", index.replace(']', "]]"), schema.replace(']', "]]"), table.replace(']', "]]"))
            }).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "REBUILD index (reclaims more space; heavier than REORGANIZE)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("sqlite", "sqlite.vacuum") => {
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "VACUUM (rebuild database file, reclaim free pages)".to_string(),
                sql: vec!["VACUUM;".to_string()],
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("sqlite", "sqlite.reindex") => {
            let sql: Vec<String> = affected.iter().map(|i| format!("REINDEX \"{}\";", i.replace('"', "\"\""))).collect();
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "REINDEX (rebuild indexes)".to_string(),
                sql,
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("duckdb", "duckdb.checkpoint") => {
            // CHECKPOINT compacts the WAL into the main DB file — DuckDB's
            // closest equivalent to VACUUM.
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "CHECKPOINT (compact WAL into the database file)".to_string(),
                sql: vec!["CHECKPOINT;".to_string()],
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        ("duckdb", "duckdb.analyze") => {
            Ok(RepairPlan {
                diagnostic_id: request.diagnostic_id,
                title: "ANALYZE (refresh planner statistics)".to_string(),
                sql: vec!["ANALYZE;".to_string()],
                affected_objects: affected,
                risk_level: RiskLevel::Safe,
                estimated_affected_rows: None,
                requires_backup: false,
                verification_sql: None,
            })
        }
        _ => Err(format!("No repair preview available for action '{}' on engine '{}'.", action, engine)),
    }
}

/// Split a `schema.table.index` reference (as produced by `diagnose_mssql`)
/// into its three parts. Falls back to `("dbo", qualified, qualified)` if the
/// string doesn't have exactly two dots — defensive, shouldn't happen since
/// the caller always builds this string itself.
fn split_schema_table_index(qualified: &str) -> (String, String, String) {
    let parts: Vec<&str> = qualified.split('.').collect();
    if parts.len() == 3 {
        (parts[0].to_string(), parts[1].to_string(), parts[2].to_string())
    } else {
        ("dbo".to_string(), qualified.to_string(), qualified.to_string())
    }
}

/// Split a `schema.table.column` or `table.column` reference into a
/// FROM-target (`schema.table` or `table`) and a bare column name.
fn split_qualified(qualified: &str) -> (String, String) {
    let parts: Vec<&str> = qualified.rsplitn(2, '.').collect();
    if parts.len() == 2 {
        (parts[1].to_string(), parts[0].to_string())
    } else {
        (parts[0].to_string(), parts[0].to_string())
    }
}

// ───────────────────────── Execute ─────────────────────────

#[tauri::command]
pub async fn execute_repair(
    config: ConnectionConfig,
    plan: RepairPlan,
    registry: tauri::State<'_, QueryRegistry>,
) -> Result<RepairResult, String> {
    let exec_id = format!("repair_{}", plan.diagnostic_id);
    let token = CancellationToken::new();
    registry.lock().await.insert(exec_id.clone(), token.clone());

    let run_fut = run_repair(config, plan);
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err("Repair cancelled by user.".to_string()),
        res = run_fut => res,
    };

    registry.lock().await.remove(&exec_id);
    result
}

async fn run_repair(config: ConnectionConfig, plan: RepairPlan) -> Result<RepairResult, String> {
    let start = Instant::now();
    let engine = engine_key(&config);
    let sqls = plan.sql.clone();
    let mut affected_total: u64 = 0;
    let mut last_err: Option<String> = None;

    let exec_result: Result<RepairResult, String> = match super::super::engine::engine_family(&engine) {
        super::super::engine::EngineFamily::Postgres => {
            let client = connect_pg(&config).await?;
            for stmt in &sqls {
                match client.execute(stmt, &[]).await {
                    Ok(n) => affected_total = affected_total.saturating_add(n),
                    Err(e) => { last_err = Some(from_postgres(e, Some(stmt)).to_json_string()); break; }
                }
            }
            // Optional verification.
            let mut verification: Option<String> = None;
            if last_err.is_none() {
                if let Some(v) = &plan.verification_sql {
                    if let Ok(Some(row)) = client.query_opt(v, &[]).await {
                        let val: Option<String> = row.get(0);
                        verification = val.or_else(|| Some("(no value)".to_string()));
                    }
                }
            }
            finish_ok(plan, sqls, affected_total, start, last_err, verification)
        }
        super::super::engine::EngineFamily::Mysql => {
            let (pool, mut conn) = super::connection::connect_mysql(&config).await?;
            for stmt in &sqls {
                if let Err(e) = conn.query_drop(stmt).await {
                    last_err = Some(e.to_string());
                    break;
                }
            }
            drop(conn);
            let _ = pool.disconnect().await;
            finish_ok(plan, sqls, affected_total, start, last_err, None)
        }
        super::super::engine::EngineFamily::Sqlite => {
            // SQLite must run on a blocking thread; run_repair is async so spawn_blocking.
            let cfg = config.clone();
            let stmts = sqls.clone();
            let res: Result<(), String> = tokio::task::spawn_blocking(move || {
                let conn = open_sqlite_rw(&cfg)?;
                for s in &stmts {
                    if let Err(e) = conn.execute(s, []) {
                        return Err(e.to_string());
                    }
                }
                Ok(())
            }).await.map_err(|e| e.to_string())?;
            if let Err(e) = res { last_err = Some(e); }
            finish_ok(plan, sqls, affected_total, start, last_err, None)
        }
        super::super::engine::EngineFamily::Duckdb => {
            let cfg = config.clone();
            let stmts = sqls.clone();
            let res: Result<(), String> = tokio::task::spawn_blocking(move || {
                let conn = open_duckdb_rw(&cfg)?;
                for s in &stmts {
                    if let Err(e) = conn.execute(s, duckdb::params![]) {
                        return Err(from_duckdb(e, Some(s)).to_json_string());
                    }
                }
                Ok(())
            }).await.map_err(|e| e.to_string())?;
            if let Err(e) = res { last_err = Some(e); }
            finish_ok(plan, sqls, affected_total, start, last_err, None)
        }
        super::super::engine::EngineFamily::Mssql => {
            for stmt in &sqls {
                match super::super::mssql::run_mssql_query(&config, stmt).await {
                    Ok(res) => affected_total = affected_total.saturating_add(res.affected_rows),
                    Err(e) => { last_err = Some(e); break; }
                }
            }
            let mut verification: Option<String> = None;
            if last_err.is_none() {
                if let Some(v) = &plan.verification_sql {
                    if let Ok(res) = super::super::mssql::run_mssql_query(&config, v).await {
                        verification = res.rows.first().and_then(|r| r.first()).map(|c| c.to_string());
                    }
                }
            }
            finish_ok(plan, sqls, affected_total, start, last_err, verification)
        }
    };
    exec_result
}

/// Build the final `RepairResult` (Ok or with an error field).
fn finish_ok(
    plan: RepairPlan,
    sqls: Vec<String>,
    affected_total: u64,
    start: Instant,
    last_err: Option<String>,
    verification: Option<String>,
) -> Result<RepairResult, String> {
    let duration_ms = start.elapsed().as_millis() as u64;
    let success = last_err.is_none();
    Ok(RepairResult {
        diagnostic_id: plan.diagnostic_id,
        success,
        executed_sql: sqls,
        affected_rows: affected_total,
        duration_ms,
        error: last_err,
        verification,
    })
}

// ───────────────────────── Tests ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn req(action: &str, details: &[(&str, &str)], affected: &[&str]) -> RepairRequest {
        let mut d = HashMap::new();
        for (k, v) in details { d.insert((*k).to_string(), (*v).to_string()); }
        RepairRequest {
            diagnostic_id: "d1".to_string(),
            repair_action: action.to_string(),
            affected_objects: affected.iter().map(|s| s.to_string()).collect(),
            details: d,
        }
    }

    fn pg_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None, name: "pg".to_string(), engine: "postgres".to_string(),
            host: Some("127.0.0.1".to_string()), port: Some(5432),
            database: Some("db".to_string()), username: Some("u".to_string()),
            password: Some("p".to_string()), ssl_mode: None, file_path: None,
            cf_account_id: None, cf_api_token: None, cf_database_id: None,
            scope_database: None, include_system_schemas: None,
            redis_db_index: None, ssh: None,
        mongo_auth_source: None, mongo_replica_set: None, mongo_connection_string: None,
        }
    }

    #[tokio::test]
    async fn seq_sync_generates_setval_and_is_safe() {
        let plan = preview_repair(pg_config(), req("postgres.seq_sync", &[("sequence", "public.users_id_seq"), ("column", "public.users.id")], &["public.users.id"])).await.unwrap();
        assert!(plan.sql[0].contains("SELECT setval('public.users_id_seq'"));
        assert!(plan.sql[0].contains("MAX(\"id\") FROM public.users"));
        assert_eq!(plan.risk_level, RiskLevel::Safe);
        assert!(!plan.requires_backup);
        assert!(plan.verification_sql.unwrap().contains("last_value"));
    }

    #[tokio::test]
    async fn drop_index_is_dangerous_and_requires_backup() {
        let plan = preview_repair(pg_config(), req("postgres.drop_index", &[], &["public.idx_orders_created_at"])).await.unwrap();
        assert_eq!(plan.risk_level, RiskLevel::Dangerous);
        assert!(plan.requires_backup);
        assert!(plan.sql[0].starts_with("DROP INDEX"));
    }

    #[tokio::test]
    async fn analyze_generates_one_stmt_per_table() {
        let plan = preview_repair(pg_config(), req("postgres.analyze_table", &[], &["public.orders", "public.users"])).await.unwrap();
        assert_eq!(plan.sql.len(), 2);
        assert!(plan.sql.iter().all(|s| s.starts_with("ANALYZE")));
    }

    #[tokio::test]
    async fn sqlite_vacuum_is_a_single_statement() {
        let cfg = ConnectionConfig {
            id: None, name: "s".to_string(), engine: "sqlite".to_string(),
            host: None, port: None, database: None, username: None, password: None,
            ssl_mode: None, file_path: Some("/tmp/x.db".to_string()),
            cf_account_id: None, cf_api_token: None, cf_database_id: None,
            scope_database: None, include_system_schemas: None,
            redis_db_index: None, ssh: None,
        mongo_auth_source: None, mongo_replica_set: None, mongo_connection_string: None,
        };
        let plan = preview_repair(cfg, req("sqlite.vacuum", &[], &[])).await.unwrap();
        assert_eq!(plan.sql, vec!["VACUUM;".to_string()]);
        assert_eq!(plan.risk_level, RiskLevel::Safe);
    }

    #[test]
    fn split_qualified_handles_schema() {
        let (tbl, col) = split_qualified("public.users.id");
        assert_eq!(tbl, "public.users");
        assert_eq!(col, "id");
        let (tbl, col) = split_qualified("users.id");
        assert_eq!(tbl, "users");
        assert_eq!(col, "id");
    }
}
