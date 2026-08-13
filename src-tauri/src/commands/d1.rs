//! Cloudflare D1 REST API client.
//!
//! D1 databases are queried over HTTPS via the Cloudflare REST API — there is
//! no direct TCP driver. Each query is a POST to
//! `/accounts/{account_id}/d1/database/{database_id}/query` with a bearer
//! token and a JSON body `{ "sql": "..." }`.

use serde::{Deserialize, Serialize};
use std::time::Instant;

use super::connection::ConnectionConfig;
use super::error::DbError;

const D1_API_BASE: &str = "https://api.cloudflare.com/client/v4/accounts";

/// Build the D1 query endpoint URL from the connection config.
fn d1_query_url(config: &ConnectionConfig) -> Result<String, String> {
    let account = config.cf_account_id.as_deref().ok_or("Missing Cloudflare Account ID")?;
    let db = config.cf_database_id.as_deref().ok_or("Missing D1 Database ID")?;
    Ok(format!("{}/{}/d1/database/{}/query", D1_API_BASE, account, db))
}

/// D1 REST API success envelope. `messages` is part of the API response but
/// not consumed by the app — it's kept for schema completeness.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct D1Envelope<T> {
    success: bool,
    errors: Option<Vec<serde_json::Value>>,
    result: Option<T>,
    messages: Option<Vec<serde_json::Value>>,
}

/// One result object inside the `result` array (D1 returns one per statement).
#[derive(Debug, Deserialize)]
struct D1QueryResult {
    success: bool,
    results: Vec<serde_json::Value>,
    meta: Option<D1Meta>,
}

/// D1 per-statement metadata. Deserialized for completeness; only `changes`
/// is currently surfaced to the frontend. The rest are kept for future use.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct D1Meta {
    changes: Option<u64>,
    duration: Option<f64>,
    last_row_id: Option<serde_json::Value>,
    rows_read: Option<u64>,
    rows_written: Option<u64>,
}

/// Strongly-typed query result returned to the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct D1Result {
    pub columns: Vec<D1Column>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub execution_time_ms: u64,
    pub affected_rows: u64,
    pub status_message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct D1Column {
    pub name: String,
    pub data_type: String,
}

fn extract_table_name_from_select(sql: &str) -> Option<String> {
    let sql_trimmed = sql.trim();
    if !sql_trimmed.to_uppercase().starts_with("SELECT") {
        return None;
    }

    let uppercase_sql = sql_trimmed.to_uppercase();
    let from_idx = uppercase_sql.find(" FROM ")?;
    let after_from = sql_trimmed[from_idx + 6..].trim();

    // Get the table token after FROM
    let token = after_from
        .split_whitespace()
        .next()?
        .trim_end_matches(';');

    // Handle qualified names like "main"."users" or main.users
    let name_part = if let Some(dot_idx) = token.rfind('.') {
        &token[dot_idx + 1..]
    } else {
        token
    };

    let cleaned = name_part.trim_matches(|c| c == '"' || c == '`' || c == '\'');
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn fetch_d1_columns_via_pragma<'a>(
    config: &'a ConnectionConfig,
    tname: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<D1Column>> + Send + 'a>> {
    Box::pin(async move {
        let pragma_sql = format!("PRAGMA table_info(\"{}\");", tname.replace('"', "''"));
        let mut cols = Vec::new();
        if let Ok(cols_res) = run_d1_query(config, &pragma_sql).await {
            // `col_row` values come from a `serde_json::Map` (no `preserve_order`
            // feature enabled), which iterates keys alphabetically rather than in
            // PRAGMA's declared column order (cid, name, type, notnull,
            // dflt_value, pk). Indexing by a fixed position (e.g. `.get(1)` for
            // "name") silently landed on the wrong field — usually
            // `dflt_value`, which is NULL for most columns, so every column
            // without a default got dropped and empty tables ended up with no
            // header at all. Resolve "name"/"type" by looking up their actual
            // position in `cols_res.columns`, which was built from the exact
            // same per-row key iteration and is therefore guaranteed consistent
            // with `col_row`'s value order.
            let name_idx = cols_res.columns.iter().position(|c| c.name == "name");
            let type_idx = cols_res.columns.iter().position(|c| c.name == "type");
            if let (Some(name_idx), Some(type_idx)) = (name_idx, type_idx) {
                for col_row in &cols_res.rows {
                    if let Some(col_name) = col_row.get(name_idx).and_then(|v| v.as_str()) {
                        let col_type = col_row.get(type_idx).and_then(|v| v.as_str()).unwrap_or("TEXT");
                        cols.push(D1Column {
                            name: col_name.to_string(),
                            data_type: col_type.to_string(),
                        });
                    }
                }
            }
        }
        cols
    })
}

/// Run one or more SQL statements against the D1 database and return the
/// first statement's result set (the app sends one statement at a time).
pub async fn run_d1_query(config: &ConnectionConfig, sql: &str) -> Result<D1Result, String> {
    let start = Instant::now();
    let url = d1_query_url(config)?;
    let token = config.cf_api_token.as_deref().ok_or("Missing Cloudflare API token")?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let body = serde_json::json!({ "sql": sql });

    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| DbError::connection(format!("D1 request failed: {}", e)).to_json_string())?;

    let status = resp.status();
    let envelope: D1Envelope<Vec<D1QueryResult>> = if status.is_success() {
        resp.json().await.map_err(|e| {
            DbError::app(format!("Failed to parse D1 response: {}", e)).to_json_string()
        })?
    } else {
        let text = resp.text().await.unwrap_or_default();
        let formatted_err = if let Ok(envelope) = serde_json::from_str::<D1Envelope<serde_json::Value>>(&text) {
            envelope
                .errors
                .and_then(|e| {
                    e.first().map(|v| {
                        let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("D1 query error");
                        let code = v.get("code").and_then(|c| c.as_i64());
                        if let Some(c) = code {
                            format!("D1 API error: {} (code {})", msg, c)
                        } else {
                            format!("D1 API error: {}", msg)
                        }
                    })
                })
                .unwrap_or_else(|| format!("D1 API error ({}): {}", status, text))
        } else {
            format!("D1 API error ({}): {}", status, text)
        };
        return Err(DbError::connection(formatted_err).to_json_string());
    };

    if !envelope.success {
        let msg = envelope
            .errors
            .and_then(|e| e.first().and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from)))
            .unwrap_or_else(|| "D1 query failed (no error detail)".to_string());
        return Err(DbError::app(msg).to_json_string());
    }

    let results = envelope.result.unwrap_or_default();
    let first = results.into_iter().next();

    let (mut columns, rows, affected, status_msg) = match first {
        Some(r) => {
            // Infer columns from the first row's keys (D1 returns JSON objects).
            let columns = r
                .results
                .first()
                .and_then(|row| row.as_object())
                .map(|obj| {
                    obj.keys()
                        .map(|k| D1Column {
                            name: k.clone(),
                            data_type: "TEXT".to_string(),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            let rows = r
                .results
                .into_iter()
                .map(|row| {
                    row.as_object()
                        .map(|obj| obj.values().cloned().collect())
                        .unwrap_or_default()
                })
                .collect();

            let affected = r.meta.as_ref().and_then(|m| m.changes).unwrap_or(0);
            let status_msg = if r.success { "OK".to_string() } else { "FAILED".to_string() };
            (columns, rows, affected, status_msg)
        }
        None => (vec![], vec![], 0, "OK".to_string()),
    };

    // If query returned 0 rows, infer columns from PRAGMA table_info for SELECT queries
    if columns.is_empty() {
        if let Some(tname) = extract_table_name_from_select(sql) {
            columns = fetch_d1_columns_via_pragma(config, &tname).await;
        }
    }

    let execution_time_ms = start.elapsed().as_millis() as u64;

    Ok(D1Result {
        columns,
        rows,
        execution_time_ms,
        affected_rows: affected,
        status_message: status_msg,
    })
}

/// Test connectivity by running a trivial query.
pub async fn test_d1(config: &ConnectionConfig) -> Result<(String, u64), String> {
    let start = Instant::now();
    run_d1_query(config, "SELECT 1 AS ok;").await?;
    let latency = start.elapsed().as_millis() as u64;
    Ok(("Cloudflare D1 connection successful.".to_string(), latency))
}

/// Fetch the schema tree (D1 uses SQLite's `sqlite_master` + `PRAGMA`).
pub async fn fetch_d1_schema(config: &ConnectionConfig) -> Result<Vec<super::connection::SchemaNode>, String> {
    use super::connection::SchemaNode;

    // List all tables and views. D1 supports querying sqlite_master via REST API.
    // Filter out internal SQLite system tables (sqlite_%) and Cloudflare system tables (_cf_%).
    let tables_result = run_d1_query(
        config,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;",
    )
    .await
    .map_err(|e| format!("D1 schema query failed: {}", e))?;

    // If no tables found, return early with an informative empty schema.
    if tables_result.rows.is_empty() {
        return Ok(vec![SchemaNode {
            name: "main".to_string(),
            node_type: "schema".to_string(),
            data_type: None,
            row_count: None,
            size_bytes: None,
            is_primary_key: None,
            is_foreign_key: None,
            is_nullable: None,
            has_default: None,
            children: vec![],
        }]);
    }

    let mut table_nodes: Vec<SchemaNode> = Vec::new();

    for row in &tables_result.rows {
        let tname = row.first().and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
        let ttype = row.get(1).and_then(|v| v.as_str()).unwrap_or("table").to_string();

        // Fetch columns for this table using PRAGMA table_info.
        // D1 REST API supports PRAGMA statements.
        let cols_result = run_d1_query(config, &format!("PRAGMA table_info(\"{}\");", tname.replace('"', "''"))).await;

        let mut col_nodes: Vec<SchemaNode> = Vec::new();
        if let Ok(cols) = &cols_result {
            // PRAGMA table_info returns objects keyed cid/name/type/notnull/
            // dflt_value/pk. `run_d1_query` turns each row object into a
            // positional array via `obj.values()` on a `serde_json::Map`
            // WITHOUT the `preserve_order` feature — so values come out sorted
            // ALPHABETICALLY by key (cid, dflt_value, name, notnull, pk, type),
            // not in PRAGMA's declared order. A fixed index like `.get(1)` for
            // "name" silently landed on "dflt_value" instead (NULL for most
            // columns → empty name), and `.get(2)` for "type" landed on the
            // real column name — exactly the "name missing, shows up in the
            // type slot" symptom. `cols.columns` was built from the same
            // per-row key iteration, so looking up each field's position by
            // name there is guaranteed consistent with `col_row`'s value order.
            let idx = |field: &str| cols.columns.iter().position(|c| c.name == field);
            let (name_i, type_i, notnull_i, dflt_i, pk_i) =
                (idx("name"), idx("type"), idx("notnull"), idx("dflt_value"), idx("pk"));

            for col_row in &cols.rows {
                let col_name = name_i.and_then(|i| col_row.get(i)).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let col_type = type_i.and_then(|i| col_row.get(i)).and_then(|v| v.as_str()).unwrap_or("TEXT").to_string();
                let not_null = notnull_i.and_then(|i| col_row.get(i)).and_then(|v| v.as_i64()).unwrap_or(0) == 1;
                let pk_val = pk_i.and_then(|i| col_row.get(i)).and_then(|v| v.as_i64()).unwrap_or(0);
                let has_default = dflt_i.and_then(|i| col_row.get(i)).map(|v| !v.is_null()).unwrap_or(false);

                col_nodes.push(SchemaNode {
                    name: col_name,
                    node_type: "column".to_string(),
                    data_type: Some(col_type),
                    row_count: None,
                    size_bytes: None,
                    is_primary_key: Some(pk_val > 0),
                    is_foreign_key: Some(false),
                    is_nullable: Some(!not_null),
                    has_default: Some(has_default),
                    children: vec![],
                });
            }
        }

        // Try to get row count.
        let count_result = run_d1_query(config, &format!("SELECT COUNT(*) AS cnt FROM \"{}\";", tname.replace('"', "''"))).await;
        let row_count = count_result
            .ok()
            .and_then(|r| r.rows.first().and_then(|row| row.first()).and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_i64().map(|i| i as u64))
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            }));

        table_nodes.push(SchemaNode {
            name: tname,
            node_type: ttype,
            data_type: None,
            row_count,
            size_bytes: None,
            is_primary_key: None,
            is_foreign_key: None,
            is_nullable: None,
            has_default: None,
            children: col_nodes,
        });
    }

    // Wrap in a single "main" schema group (D1 has no schemas).
    Ok(vec![SchemaNode {
        name: "main".to_string(),
        node_type: "schema".to_string(),
        data_type: None,
        row_count: None,
        size_bytes: None,
        is_primary_key: None,
        is_foreign_key: None,
        is_nullable: None,
        has_default: None,
        children: table_nodes,
    }])
}
