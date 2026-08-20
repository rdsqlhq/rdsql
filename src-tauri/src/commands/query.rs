use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_postgres::NoTls;
use tokio_postgres::types::{FromSql, Kind, Type as PgType};
use rusqlite::Connection;
use mysql_async::prelude::*;
use tokio_util::sync::CancellationToken;
use super::connection::{normalize_host, ConnectionConfig};
use super::error::{from_mysql, from_postgres, from_sqlite, DbError, ErrorKind};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Tracks in-flight queries by id so a `cancel_query` call can signal them to
/// abort. Held in Tauri app state.
pub type QueryRegistry = Arc<Mutex<HashMap<String, CancellationToken>>>;

/// Error string returned to the frontend when the user cancels a running query.
pub const CANCELLED_BY_USER: &str = "Query cancelled by user";

/// Convert a MySQL column type to a clean human-readable name, stripping the
/// `MYSQL_TYPE_` prefix (e.g. `MYSQL_TYPE_BLOB` → `blob`, `MYSQL_TYPE_LONG`
/// → `int`, `MYSQL_TYPE_VAR_STRING` → `varchar`).
fn mysql_type_name<T: std::fmt::Debug>(t: &T) -> String {
    let raw = format!("{:?}", t);
    let cleaned = raw
        .strip_prefix("MYSQL_TYPE_")
        .unwrap_or(&raw)
        .to_lowercase();
    match cleaned.as_str() {
        "long" | "longlong" | "int24" | "short" | "tiny" => "int".to_string(),
        "var_string" => "varchar".to_string(),
        "newdecimal" => "decimal".to_string(),
        "newdate" => "date".to_string(),
        "timestamp2" => "timestamp".to_string(),
        "datetime2" => "datetime".to_string(),
        "time2" => "time".to_string(),
        "tiny_blob" | "medium_blob" | "long_blob" => "blob".to_string(),
        "enum" => "enum".to_string(),
        "set" => "set".to_string(),
        "geometry" => "geometry".to_string(),
        "bit" => "bit".to_string(),
        "null" => "null".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn mysql_opts(host: String, port: u16, user: String, pass: String, db: Option<String>) -> mysql_async::Opts {
    mysql_async::OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(user))
        .pass(Some(pass))
        .db_name(db)
        .into()
}

pub(crate) fn mysql_value_to_json(v: &mysql_async::Value) -> serde_json::Value {
    use mysql_async::Value as V;
    match v {
        V::NULL => serde_json::Value::Null,
        V::Bytes(b) => match std::str::from_utf8(b) {
            Ok(s) => serde_json::json!(s),
            Err(_) => serde_json::json!(format!("<binary {} bytes>", b.len())),
        },
        V::Int(i) => serde_json::json!(i),
        V::UInt(u) => serde_json::json!(u),
        V::Float(f) => serde_json::json!(f),
        V::Double(d) => serde_json::json!(d),
        V::Date(y, mo, d, h, mi, s, micro) => {
            serde_json::json!(format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, mo, d, h, mi, s, micro))
        }
        V::Time(neg, days, h, mi, s, micro) => {
            let sign = if *neg { "-" } else { "" };
            serde_json::json!(format!("{}{}d {:02}:{:02}:{:02}.{:06}", sign, days, h, mi, s, micro))
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryRequest {
    pub config: ConnectionConfig,
    pub sql: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryColumn {
    pub name: String,
    pub data_type: String,
    /// Postgres `CREATE TYPE ... AS ENUM` columns get their allowed labels
    /// here, so the grid can render a dropdown of real values instead of a
    /// free-text box. `None` for every other column (and for every other
    /// engine — not populated for MySQL's inline `ENUM(...)` yet).
    pub enum_values: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<QueryColumn>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub execution_time_ms: u64,
    pub affected_rows: u64,
    pub status_message: String,
}

/// Cancels a running query by id. The token is removed from the registry
/// (the still-running query observes the cancel and returns its own error).
#[tauri::command]
pub async fn cancel_query(query_id: String, registry: tauri::State<'_, QueryRegistry>) -> Result<bool, String> {
    let token = { registry.lock().await.remove(&query_id) };
    if let Some(t) = token {
        t.cancel();
        Ok(true)
    } else {
        // Already finished or unknown — report false so the UI can react.
        Ok(false)
    }
}

#[tauri::command]
pub async fn execute_query(
    request: QueryRequest,
    query_id: String,
    registry: tauri::State<'_, QueryRegistry>,
) -> Result<QueryResult, String> {
    let token = CancellationToken::new();
    registry.lock().await.insert(query_id.clone(), token.clone());

    // Race the actual run against cancellation. We also abort the inner future
    // by selecting on its handle — when cancel wins we return immediately.
    let run_fut = run_query(request);

    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err(DbError::app(CANCELLED_BY_USER).to_json_string()),
        res = run_fut => res,
    };

    registry.lock().await.remove(&query_id);
    result
}

/// Wraps any Postgres wire value, keeping its raw bytes. `postgres-types`'
/// built-in `FromSql for String` gates on a conservative fixed OID list
/// (`accepts()` only allows `VARCHAR`/`TEXT`/`BPCHAR`/`NAME`/`UNKNOWN`, plus a
/// couple of named extension types) — a custom enum column's OID is never in
/// that list even though its wire value (text or "binary" — enums have no
/// packed binary form, both formats send the label's raw bytes) is plain
/// text. This type accepts anything so we can UTF-8-decode it ourselves for
/// exactly that case. Verified empirically against a live enum column: the
/// built-in `String` getter returns `WrongType`, this returns the label.
struct RawText(String);
impl<'a> FromSql<'a> for RawText {
    fn from_sql(_ty: &PgType, raw: &'a [u8]) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        Ok(RawText(String::from_utf8(raw.to_vec())?))
    }
    fn accepts(_ty: &PgType) -> bool {
        true
    }
}

/// Convert a PostgreSQL cell value to JSON, using the column's type OID to
/// pick the right Rust representation. This is critical: `try_get::<_, String>`
/// only works for character types — it silently returns `None` for int/float/
/// bool/date/uuid/timestamp/enum/etc. (each fails `String`'s `accepts()` check
/// and the error is swallowed by `.ok()`), which made `COUNT(*)` return `null`
/// and broke every numeric/boolean/date/enum column in SELECT results. By
/// dispatching on `Type`, each category gets its native FromSql
/// implementation — needs the `with-chrono-0_4`/`with-uuid-1` tokio-postgres
/// features (see Cargo.toml) for the date/time/UUID arms below.
fn pg_cell_to_json(row: &tokio_postgres::Row, idx: usize, ty: &PgType) -> serde_json::Value {
    use serde_json::json;

    // Custom types (`CREATE TYPE ... AS ENUM`) get a per-database OID that
    // can't be matched as a `PgType` constant below — checked via `.kind()`
    // before the constant-OID match.
    if matches!(ty.kind(), Kind::Enum(_)) {
        let v: Option<RawText> = row.try_get(idx).ok().flatten();
        return v.map(|t| json!(t.0)).unwrap_or(serde_json::Value::Null);
    }

    // Array columns (`int[]`, `text[]`, etc.) get a per-database OID that
    // can't be matched as a `PgType` constant below — checked via `.kind()`,
    // same as the enum detection above. Without this, the element type falls
    // into the catch-all `Option<String>` arm at the bottom, which fails
    // `accepts()` for the array's OID (not a text OID) and is silently
    // swallowed to `null` by `.ok()` — so every array column rendered as
    // NULL in the grid regardless of its actual content.
    if let Kind::Array(elem_ty) = ty.kind() {
        return pg_array_to_json(row, idx, elem_ty);
    }

    // Each typed getter below uses Option<T>, which returns None for SQL NULL.
    match *ty {
        // Integer family — Option wraps SQL NULL.
        PgType::INT2 => {
            let v: Option<i16> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        PgType::INT4 => {
            let v: Option<i32> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        PgType::INT8 => {
            let v: Option<i64> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        // Floating point.
        PgType::FLOAT4 => {
            let v: Option<f32> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        PgType::FLOAT8 => {
            let v: Option<f64> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        // Boolean.
        PgType::BOOL => {
            let v: Option<bool> = row.try_get(idx).ok().flatten();
            v.map(|b| json!(b)).unwrap_or(serde_json::Value::Null)
        }
        // Numeric / decimal — Postgres sends this as a packed base-10000
        // binary struct, not text, so `Option<String>` always failed here
        // (confirmed empirically: `WrongType`, silently swallowed to null by
        // the `.ok()` below it). `rust_decimal`'s `db-postgres` feature
        // decodes it directly and its `Display` preserves the declared
        // scale (e.g. `-99.100`, not `-99.1`). `NaN`/`Infinity` (valid
        // Postgres numeric special values `Decimal` can't represent) fall
        // through `.ok()` to `null` — a documented edge case, not a crash.
        PgType::NUMERIC => {
            let v: Option<rust_decimal::Decimal> = row.try_get(idx).ok().flatten();
            v.map(|d| json!(d.to_string())).unwrap_or(serde_json::Value::Null)
        }
        // UUID — needs the `with-uuid-1` tokio-postgres feature to decode as
        // `uuid::Uuid`. `Option<String>` looked plausible (UUIDs render as
        // text) but doesn't work: `String`'s `FromSql::accepts()` doesn't
        // include the UUID OID, so it always failed (confirmed empirically).
        PgType::UUID => {
            let v: Option<uuid::Uuid> = row.try_get(idx).ok().flatten();
            v.map(|u| json!(u.to_string())).unwrap_or(serde_json::Value::Null)
        }
        // Date/time family — same `accepts()` gap as NUMERIC/UUID (confirmed
        // empirically: all four returned `WrongType` via `Option<String>`,
        // which is why `created_at`/`scraped_at` rendered blank in the data
        // grid despite the underlying rows having real values). Needs the
        // `with-chrono-0_4` tokio-postgres feature.
        PgType::TIMESTAMP => {
            let v: Option<chrono::NaiveDateTime> = row.try_get(idx).ok().flatten();
            v.map(|d| json!(d.format("%Y-%m-%d %H:%M:%S%.f").to_string())).unwrap_or(serde_json::Value::Null)
        }
        PgType::TIMESTAMPTZ => {
            let v: Option<chrono::DateTime<chrono::Utc>> = row.try_get(idx).ok().flatten();
            v.map(|d| json!(d.to_rfc3339())).unwrap_or(serde_json::Value::Null)
        }
        PgType::DATE => {
            let v: Option<chrono::NaiveDate> = row.try_get(idx).ok().flatten();
            v.map(|d| json!(d.to_string())).unwrap_or(serde_json::Value::Null)
        }
        PgType::TIME => {
            let v: Option<chrono::NaiveTime> = row.try_get(idx).ok().flatten();
            v.map(|t| json!(t.to_string())).unwrap_or(serde_json::Value::Null)
        }
        // JSON / JSONB — tokio_postgres can deserialize these to serde_json::Value
        // only with the `with-serde_json-1` feature. Without it, we get the raw
        // text (JSONB is sent as text wire format anyway). Parse it into JSON so
        // the frontend receives a structured value, not a string.
        PgType::JSON | PgType::JSONB => {
            let v: Option<String> = row.try_get(idx).ok().flatten();
            match v {
                Some(s) => serde_json::from_str::<serde_json::Value>(&s)
                    .unwrap_or_else(|_| json!(s)),
                None => serde_json::Value::Null,
            }
        }
        // Bytea — describe rather than dump raw bytes.
        PgType::BYTEA => {
            let v: Option<Vec<u8>> = row.try_get(idx).ok().flatten();
            v.map(|b| json!(format!("<{} bytes>", b.len())))
                .unwrap_or(serde_json::Value::Null)
        }
        // Everything else genuinely text-shaped (text, varchar, bpchar, name)
        // converts cleanly to String. Types with their own binary wire
        // format that also need `Option<String>` here (interval, inet, and
        // anything else not covered above) will hit the same accepts()
        // failure as the ones fixed above — add an explicit arm using the
        // right FromSql target if one of those turns out to matter too.
        _ => {
            let v: Option<String> = row.try_get(idx).ok().flatten();
            v.map(|s| json!(s)).unwrap_or(serde_json::Value::Null)
        }
    }
}

/// Convert a PostgreSQL array cell to a JSON array, dispatching on the
/// array's element type the same way `pg_cell_to_json` dispatches on a
/// scalar's. Element-level NULLs are preserved (Postgres arrays can mix NULL
/// and non-NULL entries, e.g. `{1,NULL,3}`); a NULL array itself becomes
/// `Value::Null`. Kept at the same fidelity as `pg_cell_to_json`'s scalar
/// arms — numeric/uuid/timestamp/date/time elements fall to the text arm
/// exactly like their scalar counterparts do above.
fn pg_array_to_json(row: &tokio_postgres::Row, idx: usize, elem_ty: &PgType) -> serde_json::Value {
    use serde_json::json;

    fn to_json<T>(v: Option<Vec<Option<T>>>, conv: impl Fn(T) -> serde_json::Value) -> serde_json::Value {
        match v {
            Some(items) => {
                serde_json::Value::Array(items.into_iter().map(|o| o.map(&conv).unwrap_or(serde_json::Value::Null)).collect())
            }
            None => serde_json::Value::Null,
        }
    }

    match *elem_ty {
        PgType::INT2 => to_json(row.try_get::<_, Option<Vec<Option<i16>>>>(idx).ok().flatten(), |n| json!(n)),
        PgType::INT4 => to_json(row.try_get::<_, Option<Vec<Option<i32>>>>(idx).ok().flatten(), |n| json!(n)),
        PgType::INT8 => to_json(row.try_get::<_, Option<Vec<Option<i64>>>>(idx).ok().flatten(), |n| json!(n)),
        PgType::FLOAT4 => to_json(row.try_get::<_, Option<Vec<Option<f32>>>>(idx).ok().flatten(), |n| json!(n)),
        PgType::FLOAT8 => to_json(row.try_get::<_, Option<Vec<Option<f64>>>>(idx).ok().flatten(), |n| json!(n)),
        PgType::BOOL => to_json(row.try_get::<_, Option<Vec<Option<bool>>>>(idx).ok().flatten(), |b| json!(b)),
        // JSON/JSONB elements — parse each element's text into structured JSON.
        PgType::JSON | PgType::JSONB => to_json(
            row.try_get::<_, Option<Vec<Option<String>>>>(idx).ok().flatten(),
            |s| serde_json::from_str::<serde_json::Value>(&s).unwrap_or_else(|_| json!(s)),
        ),
        // Bytea elements — same "describe, don't dump" treatment as the scalar arm.
        PgType::BYTEA => to_json(
            row.try_get::<_, Option<Vec<Option<Vec<u8>>>>>(idx).ok().flatten(),
            |b| json!(format!("<{} bytes>", b.len())),
        ),
        // text/varchar/bpchar/name, and everything else genuinely text-shaped
        // on the wire (numeric, uuid, timestamp, date, time, interval, inet) —
        // same fallback `pg_cell_to_json`'s default arm uses for these.
        _ => to_json(row.try_get::<_, Option<Vec<Option<String>>>>(idx).ok().flatten(), |s| json!(s)),
    }
}

async fn run_query(request: QueryRequest) -> Result<QueryResult, String> {
    let start = Instant::now();
    let sql = request.sql.trim();

    if sql.is_empty() {
        return Err(DbError::app("SQL statement is empty — nothing to execute.").to_json_string());
    }

    let engine = request.config.engine.to_lowercase();

    // D1 reuses SQLite SQL over REST — short-circuit before family dispatch.
    if engine == "cloudflare-d1" || engine == "d1" {
        let result = super::d1::run_d1_query(&request.config, sql).await?;
        let columns = result
            .columns
            .iter()
            .map(|c| QueryColumn {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                enum_values: None,
            })
            .collect();
        return Ok(QueryResult {
            columns,
            rows: result.rows,
            execution_time_ms: result.execution_time_ms,
            affected_rows: result.affected_rows,
            status_message: result.status_message,
        });
    }
    // DuckDB has its own driver — dispatch to the dedicated module.
    if engine == "duckdb" {
        return super::duckdb::run_duckdb_query(&request.config, sql);
    }
    // SQL Server has its own driver — dispatch to the dedicated module.
    if engine == "mssql" || engine == "sqlserver" || engine == "azuresql" {
        return super::mssql::run_mssql_query(&request.config, sql).await;
    }

    match super::engine::engine_family(&engine) {
        super::engine::EngineFamily::Sqlite => {
            let path = request.config.file_path.unwrap_or_default();
            if path.is_empty() {
                return Err(DbError::app("SQLite file path is empty. Set a database file in the connection.").to_json_string());
            }
            let conn = Connection::open(&path).map_err(|e| from_sqlite(e, None).to_json_string())?;

            if sql.to_uppercase().starts_with("SELECT")
                || sql.to_uppercase().starts_with("PRAGMA")
                || sql.to_uppercase().starts_with("EXPLAIN")
            {
                let mut stmt = conn.prepare(sql).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;
                let col_names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();

                let columns: Vec<QueryColumn> = col_names
                    .iter()
                    .map(|n| QueryColumn {
                        name: n.clone(),
                        data_type: "TEXT".to_string(),
                        enum_values: None,
                    })
                    .collect();

                let mut rows_data = Vec::new();
                let mut rows_iter = stmt.query([]).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;

                while let Ok(Some(row)) = rows_iter.next() {
                    let mut row_vals = Vec::new();
                    for i in 0..col_names.len() {
                        let val: rusqlite::types::Value = row.get(i).unwrap_or(rusqlite::types::Value::Null);
                        let json_val = match val {
                            rusqlite::types::Value::Null => serde_json::Value::Null,
                            rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                            rusqlite::types::Value::Real(f) => serde_json::json!(f),
                            rusqlite::types::Value::Text(s) => serde_json::json!(s),
                            rusqlite::types::Value::Blob(b) => serde_json::json!(format!("<blob {} bytes>", b.len())),
                        };
                        row_vals.push(json_val);
                    }
                    rows_data.push(row_vals);
                }

                let elapsed = start.elapsed().as_millis() as u64;
                let count = rows_data.len() as u64;
                Ok(QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: elapsed,
                    affected_rows: count,
                    status_message: format!("Query executed successfully ({})", path),
                })
            } else {
                let affected = conn.execute(sql, []).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())? as u64;
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
        super::engine::EngineFamily::Postgres => {
            let host = normalize_host(request.config.host.clone());
            let port = request.config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(5432);
            let (host, port) = super::ssh_tunnel::resolve_target(&request.config, host, port).await?;
            let user = request.config.username.unwrap_or_else(|| "postgres".to_string());
            let db = request.config.database.unwrap_or_else(|| "postgres".to_string());
            let pass = request.config.password.unwrap_or_default();

            let conn_str = format!(
                "host={} port={} user={} dbname={} password={}",
                host, port, user, db, pass
            );

            let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(&conn_str, NoTls)).await {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => {
                    let mut d = from_postgres(e, None);
                    // Connect-time failures are connection-class even if the
                    // server replied (e.g. bad password / wrong database).
                    d.kind = ErrorKind::Connection;
                    return Err(d.to_json_string());
                }
                Err(_) => {
                    return Err(DbError::connection(format!(
                        "PostgreSQL connection timed out after {}s — check that the server is running on {}:{}",
                        CONNECT_TIMEOUT.as_secs(), host, port
                    )).to_json_string())
                }
            };

            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    eprintln!("PostgreSQL connection error: {}", e);
                }
            });

            if sql.to_uppercase().starts_with("SELECT")
                || sql.to_uppercase().starts_with("EXPLAIN")
                || sql.to_uppercase().starts_with("SHOW")
            {
                // Prepare the statement first so we can extract column metadata
                // even when the query returns zero rows (empty table preview).
                let stmt = client.prepare(sql).await
                    .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                // `col.type_().kind()` already carries a resolved enum's
                // labels directly — tokio-postgres's own `prepare()` queries
                // pg_enum internally the first time it sees an unrecognized
                // OID (see tokio_postgres::prepare::get_type) and caches the
                // result, so no extra catalog round-trip is needed here (an
                // earlier version of this ran its own pg_type/pg_enum query,
                // which was both redundant and, if it ever failed silently,
                // left enum_values permanently None with no visible error).
                let columns: Vec<QueryColumn> = stmt
                    .columns()
                    .iter()
                    .map(|col| {
                        let enum_values = match col.type_().kind() {
                            Kind::Enum(variants) => Some(variants.clone()),
                            _ => None,
                        };
                        QueryColumn {
                            name: col.name().to_string(),
                            data_type: col.type_().name().to_string(),
                            enum_values,
                        }
                    })
                    .collect();
                // Keep the column Type OIDs so we can dispatch each cell's
                // conversion by its actual PostgreSQL type (int8, float8, bool,
                // text, etc.) instead of blindly casting everything to String
                // — which silently nullifies non-character types.
                let col_types: Vec<PgType> = stmt.columns().iter().map(|c| c.type_().clone()).collect();
                drop(stmt);

                let rows = client.query(sql, &[]).await
                    .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;

                let mut rows_data = Vec::new();
                for row in &rows {
                    let mut row_vals = Vec::new();
                    for i in 0..columns.len() {
                        let ty = &col_types[i];
                        row_vals.push(pg_cell_to_json(row, i, ty));
                    }
                    rows_data.push(row_vals);
                }

                let elapsed = start.elapsed().as_millis() as u64;
                let count = rows_data.len() as u64;
                Ok(QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: elapsed,
                    affected_rows: count,
                    status_message: "Query executed successfully".to_string(),
                })
            } else {
                let count = client.execute(sql, &[]).await
                    .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                let elapsed = start.elapsed().as_millis() as u64;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    execution_time_ms: elapsed,
                    affected_rows: count,
                    status_message: format!("OK, {} rows affected", count),
                })
            }
        }
        super::engine::EngineFamily::Mysql => {
            let host = normalize_host(request.config.host.clone());
            let port = request.config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(3306);
            let (host, port) = super::ssh_tunnel::resolve_target(&request.config, host, port).await?;
            let user = request.config.username.unwrap_or_else(|| "root".to_string());
            let db = request.config.database.clone().filter(|d| !d.is_empty());
            let pass = request.config.password.unwrap_or_default();

            let opts = mysql_opts(host.clone(), port, user, pass, db);
            // Create a fresh pool per call. Connection pooling was attempted but
            // caused "Pool was disconnected" errors when connections went stale
            // after the server's wait_timeout. The frontend batching (fast mode)
            // mitigates the overhead by reducing the number of IPC calls.
            let pool = mysql_async::Pool::new(opts);
            let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => {
                    let mut d: DbError = from_mysql(e, None).into();
                    d.kind = ErrorKind::Connection;
                    return Err(d.to_json_string());
                }
                Err(_) => {
                    return Err(DbError::connection(format!(
                        "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
                        CONNECT_TIMEOUT.as_secs(), host, port
                    )).to_json_string())
                }
            };

            let upper = sql.to_uppercase();
            if upper.starts_with("SELECT")
                || upper.starts_with("SHOW")
                || upper.starts_with("EXPLAIN")
                || upper.starts_with("DESC")
            {
                let mut result = conn.query_iter(sql).await.map_err(|e| { let d: DbError = from_mysql(e, Some(sql)).into(); d.to_json_string() })?;

                // Extract column metadata from the query result before iterating
                // rows so it's available even when the table is empty.
                let col_meta = result.columns_ref().to_vec();
                let columns: Vec<QueryColumn> = col_meta
                    .iter()
                    .map(|c| QueryColumn {
                        name: c.name_str().to_string(),
                        data_type: mysql_type_name(&c.column_type()),
                        enum_values: None,
                    })
                    .collect();

                let mut rows_data = Vec::new();
                loop {
                    let row_opt = match result.next().await {
                        Ok(o) => o,
                        Err(e) => {
                            drop(conn);
                            let _ = pool.disconnect().await;
                            return Err(from_mysql(e, Some(sql)).0.to_json_string());
                        }
                    };
                    let row = match row_opt {
                        Some(r) => r,
                        None => break,
                    };
                    let mut row_vals = Vec::new();
                    for i in 0..columns.len() {
                        let json_val = match row.as_ref(i) {
                            Some(v) => mysql_value_to_json(v),
                            None => serde_json::Value::Null,
                        };
                        row_vals.push(json_val);
                    }
                    rows_data.push(row_vals);
                }

                drop(conn);
                let _ = pool.disconnect().await;

                let elapsed = start.elapsed().as_millis() as u64;
                let count = rows_data.len() as u64;
                Ok(QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: elapsed,
                    affected_rows: count,
                    status_message: "Query executed successfully".to_string(),
                })
            } else {
                conn.query_drop(sql).await.map_err(|e| { let d: DbError = from_mysql(e, Some(sql)).into(); d.to_json_string() })?;
                let affected = conn.affected_rows();
                let elapsed = start.elapsed().as_millis() as u64;
                drop(conn);
                let _ = pool.disconnect().await;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    execution_time_ms: elapsed,
                    affected_rows: affected,
                    status_message: format!("OK, {} rows affected", affected),
                })
            }
        }
        // DuckDB is short-circuited above (`run_duckdb_query`); this arm is
        // unreachable but keeps the family match exhaustive.
        super::engine::EngineFamily::Duckdb => {
            Err(DbError::app("DuckDB query was not dispatched correctly.").to_json_string())
        }
        // SQL Server is short-circuited above (`run_mssql_query`); this arm is
        // unreachable but keeps the family match exhaustive.
        super::engine::EngineFamily::Mssql => {
            Err(DbError::app("SQL Server query was not dispatched correctly.").to_json_string())
        }
    }
}
