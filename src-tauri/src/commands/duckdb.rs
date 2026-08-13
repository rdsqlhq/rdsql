//! DuckDB embedded engine — connection test, query execution, and schema
//! introspection via the `duckdb` crate.
//!
//! DuckDB is an embedded analytical database (like SQLite is embedded OLTP).
//! It ships its own C++ core which the `bundled` feature compiles from source.
//! The crate's API deliberately mirrors `rusqlite`, so the structure here
//! (open → prepare → query_map / execute) follows the SQLite path closely.
//!
//! Unlike SQLite, DuckDB exposes a SQL-standard `information_schema` for
//! catalog introspection and has a rich type system (LIST, STRUCT, MAP,
//! DECIMAL, TIMESTAMP, INTERVAL) — the cell→JSON converter below handles all
//! of them defensively, falling back to a string rendering for anything exotic.

use std::time::Instant;

use duckdb::{params, Connection};

use super::connection::{ConnectionConfig, ConnectionTestResult, SchemaNode};
use super::error::{from_duckdb, DbError};
use super::query::{QueryColumn, QueryResult};

/// Open a read/write DuckDB connection to the file path on `config`.
pub fn open(config: &ConnectionConfig) -> Result<Connection, String> {
    let path = config.file_path.as_deref().unwrap_or("").trim();
    if path.is_empty() {
        return Err(DbError::app("DuckDB file path is empty. Set a database file in the connection.").to_json_string());
    }
    Connection::open(path).map_err(|e| from_duckdb(e, None).to_json_string())
}

/// Connection test: open the file and read the DuckDB version string.
pub async fn test_duckdb(config: &ConnectionConfig) -> Result<ConnectionTestResult, String> {
    let start = Instant::now();
    let path = config.file_path.as_deref().unwrap_or("").trim();
    if path.is_empty() {
        return Ok(ConnectionTestResult {
            success: false,
            message: "DuckDB file path cannot be empty".to_string(),
            latency_ms: 0,
            server_version: None,
        });
    }

    match Connection::open(path) {
        Ok(conn) => {
            let version: String = conn
                .query_row("SELECT version()", [], |row| row.get(0))
                .unwrap_or_else(|_| "unknown".to_string());
            let latency = start.elapsed().as_millis() as u64;
            Ok(ConnectionTestResult {
                success: true,
                message: format!("Connected to DuckDB {}", version),
                latency_ms: latency,
                server_version: Some(format!("DuckDB {}", version)),
            })
        }
        Err(err) => {
            let e = from_duckdb(err, None);
            Ok(ConnectionTestResult {
                success: false,
                message: format!("Failed to open DuckDB database: {}", e.message),
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            })
        }
    }
}

/// DuckDB read-statement keyword prefixes. DuckDB is richer than SQLite here —
/// it supports `WITH`, `SHOW`, `DESCRIBE`, `SUMMARIZE`, `CALL`, `VALUES`,
/// `TABLE`, `EXPLAIN`, and `PRAGMA` as read-only entry points.
fn is_read_query(sql: &str) -> bool {
    let upper = sql.trim_start().to_uppercase();
    const READ_PREFIXES: &[&str] = &[
        "SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "SUMMARIZE", "CALL",
        "VALUES", "TABLE", "EXPLAIN", "PRAGMA",
    ];
    READ_PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// Convert a `duckdb::types::Value` into a JSON value. Handles all primitive
/// and composite types; falls back to a debug string for anything unhandled
/// (the `duckdb::types::Value` enum does not implement `Display`).
pub fn duckdb_value_to_json(val: duckdb::types::Value) -> serde_json::Value {
    use duckdb::types::Value;
    match val {
        Value::Null => serde_json::Value::Null,
        Value::Boolean(b) => serde_json::json!(b),
        // All integer widths collapse to i64 (or string for >i64::MAX).
        Value::TinyInt(n) => serde_json::json!(n as i64),
        Value::SmallInt(n) => serde_json::json!(n as i64),
        Value::Int(n) => serde_json::json!(n),
        Value::BigInt(n) => serde_json::json!(n),
        Value::UTinyInt(n) => serde_json::json!(n as u64),
        Value::USmallInt(n) => serde_json::json!(n as u64),
        Value::UInt(n) => serde_json::json!(n as u64),
        Value::UBigInt(n) => serde_json::json!(n),
        Value::HugeInt(n) => {
            // i128 may overflow JSON's safe integer range — emit as string.
            serde_json::json!(n.to_string())
        }
        Value::UHugeInt(n) => serde_json::json!(n.to_string()),
        Value::Float(f) => serde_json::json!(f),
        Value::Double(f) => serde_json::json!(f),
        // Preserve precision by emitting decimals as strings (Decimal impl Display).
        Value::Decimal(d) => serde_json::json!(d.to_string()),
        Value::Text(s) => serde_json::json!(s),
        Value::Blob(b) => serde_json::json!(format!("<blob {} bytes>", b.len())),
        Value::Geometry(b) => serde_json::json!(format!("<geometry {} bytes>", b.len())),
        // Temporal types carry raw integer payloads; render a best-effort string.
        // `chrono` feature lets us convert Date32/Timestamp to proper types.
        Value::Date32(days) => {
            // Days since epoch 1970-01-01.
            if let Some(date) = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).map(|d| d + chrono::Duration::days(days as i64)) {
                serde_json::json!(date.format("%Y-%m-%d").to_string())
            } else {
                serde_json::json!(format!("date {}", days))
            }
        }
        Value::Timestamp(_unit, micros) => {
            // Best-effort: micros since epoch.
            if let Some(ts) = chrono::DateTime::<chrono::Utc>::from_timestamp_micros(micros) {
                serde_json::json!(ts.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            } else {
                serde_json::json!(format!("timestamp {}", micros))
            }
        }
        Value::Time64(_unit, nanos) => {
            // Nanoseconds since midnight.
            let secs = nanos / 1_000_000_000;
            let h = (secs / 3600) % 24;
            let m = (secs / 60) % 60;
            let s = secs % 60;
            serde_json::json!(format!("{:02}:{:02}:{:02}", h, m, s))
        }
        Value::Interval { months, days, nanos } => {
            serde_json::json!(format!("{} months {} days {} nanos", months, days, nanos))
        }
        Value::List(items) | Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(duckdb_value_to_json).collect())
        }
        Value::Struct(map) => {
            let mut obj = serde_json::Map::new();
            // OrderedMap exposes .keys() + .get(); reconstruct by borrowing.
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if let Some(v) = map.get(&k) {
                    obj.insert(k, duckdb_value_to_json(v.clone()));
                }
            }
            serde_json::Value::Object(obj)
        }
        Value::Map(map) => {
            let mut obj = serde_json::Map::new();
            // Keys are Values themselves; borrow-iterate via .iter().
            let entries: Vec<(duckdb::types::Value, duckdb::types::Value)> =
                map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (k, v) in entries {
                let key = duckdb_value_to_json(k).to_string();
                obj.insert(key, duckdb_value_to_json(v));
            }
            serde_json::Value::Object(obj)
        }
        Value::Enum(s) => serde_json::json!(s),
        Value::Union(inner) => duckdb_value_to_json(*inner),
        // Catch-all: debug-format so we never panic on a new variant.
        other => serde_json::json!(format!("{:?}", other)),
    }
}

/// Execute a SQL statement against a DuckDB file and return the result set.
pub fn run_duckdb_query(config: &ConnectionConfig, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let conn = open(config)?;

    if is_read_query(sql) {
        let mut stmt = conn.prepare(sql).map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;

        // DuckDB requires explicit execution before column metadata
        // (column_count / column_name / column_type) is available.
        stmt.execute([]).map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;
        let col_count = stmt.column_count();

        // Collect rows first (ends the mutable borrow of stmt).
        let mut rows_data: Vec<Vec<serde_json::Value>> = Vec::new();
        let rows_iter = stmt
            .query_map([], |row| {
                let mut vals = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let v: duckdb::types::Value = row.get(i).unwrap_or(duckdb::types::Value::Null);
                    vals.push(v);
                }
                Ok(vals)
            })
            .map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;

        for row in rows_iter {
            let vals = row.map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;
            rows_data.push(vals.into_iter().map(duckdb_value_to_json).collect());
        }

        // Now column metadata is available — build QueryColumn list.
        let columns: Vec<QueryColumn> = (0..col_count)
            .map(|i| {
                let name = stmt.column_name(i).map(|s| s.to_string()).unwrap_or_default();
                let ty = format!("{:?}", stmt.column_type(i)).to_uppercase();
                QueryColumn { name, data_type: ty }
            })
            .collect();

        let elapsed = start.elapsed().as_millis() as u64;
        let count = rows_data.len() as u64;
        Ok(QueryResult {
            columns,
            rows: rows_data,
            execution_time_ms: elapsed,
            affected_rows: count,
            status_message: format!("Query executed successfully ({})", config.file_path.as_deref().unwrap_or("")),
        })
    } else {
        let affected = conn.execute(sql, params![]).map_err(|e| from_duckdb(e, Some(sql)).to_json_string())? as u64;
        let elapsed = start.elapsed().as_millis() as u64;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            execution_time_ms: elapsed,
            affected_rows: affected,
            status_message: format!("OK, {} rows affected", affected),
        })
    }
}

#[derive(Debug)]
struct TableCols {
    name: String,
    is_view: bool,
    columns: Vec<RawCol>,
}

#[derive(Debug)]
struct RawCol {
    name: String,
    data_type: String,
    is_nullable: bool,
    has_default: bool,
}

/// Quote a DuckDB identifier (double-quote, escape embedded quotes).
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Build the schema tree for a DuckDB file. DuckDB supports real schemas
/// (`main`, `information_schema`, `pg_catalog`, …) — we surface user schemas
/// (excluding the system ones) as top-level `schema` nodes with `table`,
/// `view`, and `column` children.
pub fn fetch_duckdb_schema(config: &ConnectionConfig) -> Result<Vec<SchemaNode>, String> {
    let conn = open(config)?;

    // ── Tables + views + columns in one pass via information_schema. ──
    // DuckDB's information_schema.columns joins cleanly to .tables for type/nullability.
    let mut stmt = conn
        .prepare(
            "SELECT t.table_schema, t.table_name, t.table_type,
                    c.column_name, c.data_type, c.is_nullable, c.column_default
             FROM information_schema.tables t
             JOIN information_schema.columns c
               ON c.table_schema = t.table_schema AND c.table_name = t.table_name
             WHERE t.table_schema NOT IN ('information_schema', 'pg_catalog', 'main')
                OR t.table_schema = 'main'
             ORDER BY t.table_schema, t.table_name, c.ordinal_position",
        )
        .map_err(|e| from_duckdb(e, None).to_json_string())?;

    // Collect raw rows first so we can group by schema/table.
    #[derive(Debug)]
    struct Row {
        schema: String,
        table: String,
        table_type: String,
        col_name: String,
        col_type: String,
        nullable: String,
        default: Option<String>,
    }

    let rows = stmt
        .query_map([], |r| {
            Ok(Row {
                schema: r.get::<_, String>(0)?,
                table: r.get::<_, String>(1)?,
                table_type: r.get::<_, String>(2)?,
                col_name: r.get::<_, String>(3)?,
                col_type: r.get::<_, String>(4)?,
                nullable: r.get::<_, String>(5)?,
                default: r.get::<_, Option<String>>(6)?,
            })
        })
        .map_err(|e| from_duckdb(e, None).to_json_string())?;

    use std::collections::BTreeMap;
    let mut schemas: BTreeMap<String, Vec<TableCols>> = BTreeMap::new();
    for row in rows {
        let row = row.map_err(|e| from_duckdb(e, None).to_json_string())?;
        let is_view = row.table_type.eq_ignore_ascii_case("VIEW");
        let tables = schemas.entry(row.schema.clone()).or_default();

        // Find or create the table entry.
        let idx = tables.iter().position(|t| t.name == row.table && t.is_view == is_view);
        let idx = match idx {
            Some(i) => i,
            None => {
                tables.push(TableCols { name: row.table.clone(), is_view, columns: vec![] });
                tables.len() - 1
            }
        };

        let has_default = row.default.is_some();
        tables[idx].columns.push(RawCol {
            name: row.col_name,
            data_type: row.col_type,
            is_nullable: row.nullable.eq_ignore_ascii_case("YES"),
            has_default,
            // PK detection is done separately via the pk_columns HashSet below.
        });
    }

    // ── Primary-key detection via duckdb_constraints (best-effort). ──
    // DuckDB doesn't expose PK columns in information_schema reliably, so we
    // look them up via the catalog. This is best-effort — failures are silent.
    let pk_columns: std::collections::HashSet<(String, String, String)> = {
        let mut set = std::collections::HashSet::new();
        if let Ok(mut s) = conn.prepare(
            "SELECT kc.table_schema, kc.table_name, kc.column_name
             FROM information_schema.key_column_usage kc
             JOIN information_schema.table_constraints tc
               ON tc.constraint_name = kc.constraint_name
              AND tc.table_schema = kc.table_schema
              AND tc.table_name = kc.table_name
             WHERE tc.constraint_type = 'PRIMARY KEY'",
        ) {
            if let Ok(rows) = s.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            }) {
                for row in rows.flatten() {
                    set.insert(row);
                }
            }
        }
        set
    };

    // ── Row counts (exact, per table). ──
    // DuckDB has no cheap metadata estimate that's reliable, so COUNT(*) it is.
    let mut row_counts: std::collections::HashMap<(String, String), u64> = std::collections::HashMap::new();
    for (schema_name, tables) in &schemas {
        for t in tables {
            let qualified = format!("{}.{}", quote_ident(schema_name), quote_ident(&t.name));
            if let Ok(count) = conn.query_row::<i64, _, _>(&format!("SELECT count(*) FROM {}", qualified), [], |r| r.get(0)) {
                row_counts.insert((schema_name.clone(), t.name.clone()), count.max(0) as u64);
            }
        }
    }

    // ── Assemble SchemaNode tree. ──
    let mut nodes: Vec<SchemaNode> = Vec::new();
    for (schema_name, tables) in schemas {
        let mut table_nodes: Vec<SchemaNode> = Vec::new();
        for t in tables {
            let node_type = if t.is_view { "view" } else { "table" };
            let count = row_counts
                .get(&(schema_name.clone(), t.name.clone()))
                .copied();
            let children: Vec<SchemaNode> = t
                .columns
                .into_iter()
                .map(|c| {
                    let is_pk = pk_columns.contains(&(schema_name.clone(), t.name.clone(), c.name.clone()));
                    SchemaNode {
                        name: c.name,
                        node_type: "column".to_string(),
                        data_type: Some(c.data_type),
                        row_count: None,
                        size_bytes: None,
                        is_primary_key: Some(is_pk),
                        is_foreign_key: None,
                        is_nullable: Some(c.is_nullable),
                        has_default: Some(c.has_default),
                        children: vec![],
                    }
                })
                .collect();

            table_nodes.push(SchemaNode {
                name: t.name,
                node_type: node_type.to_string(),
                data_type: None,
                row_count: count,
                size_bytes: None,
                is_primary_key: None,
                is_foreign_key: None,
                is_nullable: None,
                has_default: None,
                children,
            });
        }

        nodes.push(SchemaNode {
            name: schema_name,
            node_type: "schema".to_string(),
            data_type: None,
            row_count: None,
            size_bytes: None,
            is_primary_key: None,
            is_foreign_key: None,
            is_nullable: None,
            has_default: None,
            children: table_nodes,
        });
    }

    Ok(nodes)
}
