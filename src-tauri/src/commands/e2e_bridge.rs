//! Stand-in for Tauri IPC used by the end-to-end suite in `e2e/`.
//!
//! The e2e tests render the real React modals in jsdom and route their
//! `invoke()` calls here, so a backup or restore runs the same Rust driver
//! code the app does, against real servers. Requests arrive as JSON lines on
//! stdin (`{"id", "cmd", "args"}`) and each answer is printed as one line
//! prefixed with `@@` (`{"id", "ok"}` or `{"id", "err"}`), so cargo's own
//! output can be told apart. Only the commands backup, restore and the
//! migration wizard use exist.
//!
//! Ignored, so `cargo test` skips it; e2e/backup/bridge.ts starts it with
//! `cargo test --lib e2e_bridge -- --ignored --nocapture`.
use super::connection::{fetch_schema_tree_impl, ConnectionConfig};
use super::query::Session;
use std::collections::HashMap;
use std::io::BufRead;

#[test]
#[ignore]
fn e2e_bridge() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let mut sessions: HashMap<String, Session> = HashMap::new();
    let mut next = 1u64;
    println!("@@{{\"ready\":true}}");
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() { continue; }
        let req: serde_json::Value = serde_json::from_str(&line).unwrap();
        let id = req["id"].clone();
        let cmd = req["cmd"].as_str().unwrap_or("").to_string();
        let a = &req["args"];
        let res: Result<serde_json::Value, String> = rt.block_on(async {
            match cmd.as_str() {
                "fetch_schema_tree" => {
                    let c: ConnectionConfig = serde_json::from_value(a["config"].clone()).map_err(|e| e.to_string())?;
                    Ok(serde_json::to_value(fetch_schema_tree_impl(c).await?).unwrap())
                }
                "execute_query" => {
                    let c: ConnectionConfig = serde_json::from_value(a["request"]["config"].clone()).map_err(|e| e.to_string())?;
                    let sql = a["request"]["sql"].as_str().unwrap_or("").trim().to_string();
                    let mut s = Session::open(&c).await?;
                    let r = s.run(&sql, None).await.map(|(r, _)| r);
                    s.close().await;
                    Ok(serde_json::to_value(r?).unwrap())
                }
                "session_open" => {
                    let c: ConnectionConfig = serde_json::from_value(a["config"].clone()).map_err(|e| e.to_string())?;
                    let s = Session::open(&c).await?;
                    let sid = format!("s{}", next); next += 1;
                    sessions.insert(sid.clone(), s);
                    Ok(serde_json::json!(sid))
                }
                "session_execute" => {
                    let sid = a["sessionId"].as_str().unwrap_or("");
                    let s = sessions.get_mut(sid).ok_or("The database session has ended.")?;
                    let sql = a["sql"].as_str().unwrap_or("").trim().to_string();
                    Ok(serde_json::to_value(s.run(&sql, None).await?.0).unwrap())
                }
                "session_close" => {
                    if let Some(s) = sessions.remove(a["sessionId"].as_str().unwrap_or("")) { s.close().await; }
                    Ok(serde_json::Value::Null)
                }
                "db_migrate_plan_tables" => {
                    let source: ConnectionConfig = serde_json::from_value(a["source"].clone()).map_err(|e| e.to_string())?;
                    let target: ConnectionConfig = serde_json::from_value(a["target"].clone()).map_err(|e| e.to_string())?;
                    let tables = serde_json::from_value(a["tables"].clone()).map_err(|e| e.to_string())?;
                    Ok(serde_json::to_value(super::migrate::orchestrator::db_migrate_plan_tables(source, target, tables).await?).unwrap())
                }
                "db_migrate_run" => {
                    let source: ConnectionConfig = serde_json::from_value(a["source"].clone()).map_err(|e| e.to_string())?;
                    let target: ConnectionConfig = serde_json::from_value(a["target"].clone()).map_err(|e| e.to_string())?;
                    let tables: Vec<super::migrate::orchestrator::TableRunInput> =
                        serde_json::from_value(a["tables"].clone()).map_err(|e| e.to_string())?;
                    let token = tokio_util::sync::CancellationToken::new();
                    let summary = super::migrate::orchestrator::run_migration(
                        a["migrationId"].as_str().unwrap_or("e2e"),
                        &source,
                        &target,
                        &tables,
                        a["confirmToken"].as_str().unwrap_or(""),
                        &token,
                        &|_| {},
                    )
                    .await?;
                    Ok(serde_json::to_value(summary).unwrap())
                }
                other => Err(format!("bridge: unknown command {}", other)),
            }
        });
        let out = match res {
            Ok(v) => serde_json::json!({"id": id, "ok": v}),
            Err(e) => serde_json::json!({"id": id, "err": e}),
        };
        println!("@@{}", out);
    }
}
