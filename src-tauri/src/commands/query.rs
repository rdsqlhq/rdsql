use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio_postgres::types::{FromSql, Kind, Type as PgType};
use rusqlite::Connection;
use mysql_async::prelude::*;
use futures_util::StreamExt;
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
            v.map(|n| int_json(n as i128)).unwrap_or(serde_json::Value::Null)
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
        // `String`'s `accepts()` rejects both OIDs (the old `Option<String>`
        // here returned null for every json/jsonb cell), so read the raw
        // bytes: json's binary form is the text itself, jsonb's is a 0x01
        // version byte followed by the text.
        PgType::JSON | PgType::JSONB => {
            let v: Option<RawText> = row.try_get(idx).ok().flatten();
            match v {
                Some(RawText(s)) => {
                    let s = if *ty == PgType::JSONB { s.strip_prefix('\u{1}').unwrap_or(&s).to_string() } else { s };
                    serde_json::from_str::<serde_json::Value>(&s).unwrap_or_else(|_| json!(s))
                }
                None => serde_json::Value::Null,
            }
        }
        PgType::OID => {
            let v: Option<u32> = row.try_get(idx).ok().flatten();
            v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null)
        }
        // xml's binary form is its text.
        PgType::XML => {
            let v: Option<RawText> = row.try_get(idx).ok().flatten();
            v.map(|t| json!(t.0)).unwrap_or(serde_json::Value::Null)
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
        PgType::INT8 => to_json(row.try_get::<_, Option<Vec<Option<i64>>>>(idx).ok().flatten(), |n| int_json(n as i128)),
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
    let sql = request.sql.trim();
    if sql.is_empty() {
        return Err(DbError::app("SQL statement is empty — nothing to execute.").to_json_string());
    }
    let mut session = Session::open(&request.config).await?;
    let result = session.run(sql, None).await.map(|(r, _)| r);
    session.close().await;
    result
}

/// One open database connection. `execute_query` opens one per statement,
/// while `execute_batch` keeps a single session for a whole editor run, so
/// BEGIN/COMMIT/ROLLBACK, SET, temp tables and USE carry from one statement
/// to the next.
///
/// Dropping a session closes its connection, so the server rolls back any
/// transaction the run left open, including when the user presses Stop.
pub(crate) enum Session {
    Sqlite { conn: Connection, path: String },
    Postgres(tokio_postgres::Client),
    Mysql { pool: mysql_async::Pool, conn: mysql_async::Conn },
    Duckdb { conn: duckdb::Connection, config: ConnectionConfig },
    Mssql(super::mssql::MssqlClient),
    /// D1 is a stateless HTTP API: each statement is its own request.
    D1(ConnectionConfig),
}

impl Session {
    pub(crate) async fn open(config: &ConnectionConfig) -> Result<Session, String> {
        let engine = config.engine.to_lowercase();

        if engine == "cloudflare-d1" || engine == "d1" {
            return Ok(Session::D1(config.clone()));
        }
        if engine == "duckdb" {
            let conn = super::duckdb::open(config)?;
            return Ok(Session::Duckdb { conn, config: config.clone() });
        }
        if engine == "mssql" || engine == "sqlserver" || engine == "azuresql" {
            return Ok(Session::Mssql(super::mssql::connect_session(config).await?));
        }

        match super::engine::engine_family(&engine) {
            super::engine::EngineFamily::Sqlite => {
                let path = config.file_path.clone().unwrap_or_default();
                if path.is_empty() {
                    return Err(DbError::app("SQLite file path is empty. Set a database file in the connection.").to_json_string());
                }
                let conn = Connection::open(&path).map_err(|e| from_sqlite(e, None).to_json_string())?;
                Ok(Session::Sqlite { conn, path })
            }
            super::engine::EngineFamily::Postgres => {
                let host = normalize_host(config.host.clone());
                let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(5432);
                let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
                let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
                let db = config.database.clone().unwrap_or_else(|| "postgres".to_string());
                let pass = config.password.clone().unwrap_or_default();

                let conn_str = format!(
                    "host={} port={} user={} dbname={} password={}",
                    host, port, user, db, pass
                );

                let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, crate::commands::pg_tls::connect(&conn_str, config.ssl_mode.as_deref())).await {
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
                        log::warn!("PostgreSQL connection error: {}", e);
                    }
                });
                Ok(Session::Postgres(client))
            }
            super::engine::EngineFamily::Mysql => {
                let host = normalize_host(config.host.clone());
                let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(3306);
                let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
                let user = config.username.clone().unwrap_or_else(|| "root".to_string());
                let db = config.database.clone().filter(|d| !d.is_empty());
                let pass = config.password.clone().unwrap_or_default();

                let opts = mysql_opts(host.clone(), port, user, pass, db);
                // Create a fresh pool per session. Connection pooling was attempted but
                // caused "Pool was disconnected" errors when connections went stale
                // after the server's wait_timeout.
                let pool = mysql_async::Pool::new(opts);
                let conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
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
                Ok(Session::Mysql { pool, conn })
            }
            // Dispatched by engine name above; kept so the match stays exhaustive.
            super::engine::EngineFamily::Duckdb | super::engine::EngineFamily::Mssql => {
                Err(DbError::app("Query was not dispatched correctly.").to_json_string())
            }
        }
    }

    /// Points unqualified names at `schema` for the rest of the session
    /// (Postgres family only; MySQL selects its database at connect time).
    pub(crate) async fn set_schema(&mut self, schema: &str) -> Result<(), String> {
        if let Session::Postgres(client) = self {
            let sql = format!("SET search_path TO {}, public", quote_pg_ident(schema));
            client.batch_execute(&sql).await.map_err(|e| from_postgres(e, Some(&sql)).to_json_string())?;
        }
        Ok(())
    }

    /// Runs one statement. With `row_limit`, at most that many rows are kept
    /// and the second value reports whether more were returned.
    pub(crate) async fn run(&mut self, sql: &str, row_limit: Option<usize>) -> Result<(QueryResult, bool), String> {
        let start = Instant::now();
        let limit = row_limit.unwrap_or(usize::MAX);
        match self {
            Session::D1(config) => {
                let result = super::d1::run_d1_query(config, sql).await?;
                let columns = result
                    .columns
                    .iter()
                    .map(|c| QueryColumn {
                        name: c.name.clone(),
                        data_type: c.data_type.clone(),
                        enum_values: None,
                    })
                    .collect();
                Ok(truncate(QueryResult {
                    columns,
                    rows: result.rows,
                    execution_time_ms: result.execution_time_ms,
                    affected_rows: result.affected_rows,
                    status_message: result.status_message,
                }, limit))
            }
            Session::Duckdb { conn, config } => {
                Ok(truncate(super::duckdb::run_duckdb_on(conn, config, sql)?, limit))
            }
            Session::Mssql(client) => Ok(truncate(super::mssql::run_mssql_on(client, sql).await?, limit)),
            Session::Sqlite { conn, path } => {
                // `prepare` compiles only the first statement and silently
                // ignores the rest, so a script of several (backup's batched
                // INSERTs) lost every row after its first statement. Run a
                // multi-statement script one statement at a time instead.
                if let Some(affected) = run_sqlite_script(conn, sql)? {
                    return Ok((affected_result(affected, start), false));
                }
                let mut stmt = conn.prepare(sql).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;
                // A statement that yields columns returns rows (SELECT, PRAGMA,
                // EXPLAIN, WITH ... SELECT, INSERT ... RETURNING).
                if stmt.column_count() == 0 {
                    let affected = stmt.execute([]).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())? as u64;
                    return Ok((affected_result(affected, start), false));
                }

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
                let mut truncated = false;
                let mut rows_iter = stmt.query([]).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;
                loop {
                    let row = match rows_iter.next() {
                        Ok(Some(row)) => row,
                        Ok(None) => break,
                        Err(e) => return Err(from_sqlite(e, Some(sql)).to_json_string()),
                    };
                    if rows_data.len() >= limit {
                        truncated = true;
                        break;
                    }
                    let mut row_vals = Vec::new();
                    for i in 0..col_names.len() {
                        let val: rusqlite::types::Value = row.get(i).unwrap_or(rusqlite::types::Value::Null);
                        let json_val = match val {
                            rusqlite::types::Value::Null => serde_json::Value::Null,
                            rusqlite::types::Value::Integer(n) => int_json(n as i128),
                            rusqlite::types::Value::Real(f) => serde_json::json!(f),
                            rusqlite::types::Value::Text(s) => serde_json::json!(s),
                            rusqlite::types::Value::Blob(b) => serde_json::json!(format!("<blob {} bytes>", b.len())),
                        };
                        row_vals.push(json_val);
                    }
                    rows_data.push(row_vals);
                }

                let count = rows_data.len() as u64;
                Ok((QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    affected_rows: count,
                    status_message: format!("Query executed successfully ({})", path),
                }, truncated))
            }
            Session::Postgres(client) => {
                // Prepare first: it gives column metadata even for zero rows, and
                // tells row-returning statements (SELECT, WITH, VALUES,
                // ... RETURNING) apart from the rest without guessing from the
                // leading keyword.
                let stmt = match client.prepare(sql).await {
                    Ok(stmt) => stmt,
                    // A prepared statement holds exactly one command. Several
                    // in one call (backup's batched INSERTs, a pasted script)
                    // go through the simple protocol instead, which runs them
                    // in order and reports each one's row count.
                    Err(e) if is_multiple_commands_error(&e) => {
                        let messages = client.simple_query(sql).await
                            .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                        let affected = messages
                            .iter()
                            .map(|m| match m {
                                tokio_postgres::SimpleQueryMessage::CommandComplete(n) => *n,
                                _ => 0,
                            })
                            .sum();
                        return Ok((affected_result(affected, start), false));
                    }
                    Err(e) => return Err(from_postgres(e, Some(sql)).to_json_string()),
                };
                if stmt.columns().is_empty() {
                    let count = client.execute(&stmt, &[]).await
                        .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                    return Ok((affected_result(count, start), false));
                }

                // `col.type_().kind()` already carries a resolved enum's
                // labels: tokio-postgres's `prepare()` looks up unknown OIDs
                // in pg_enum itself and caches them.
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
                // Keep the column types so each cell is converted by its real
                // PostgreSQL type instead of being cast to String.
                let col_types: Vec<PgType> = stmt.columns().iter().map(|c| c.type_().clone()).collect();

                // Stream rows so a row limit stops reading early instead of
                // buffering the whole result first.
                let no_params: [&(dyn tokio_postgres::types::ToSql + Sync); 0] = [];
                let stream = client.query_raw(&stmt, no_params.iter().copied()).await
                    .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                futures_util::pin_mut!(stream);

                let mut rows_data = Vec::new();
                let mut truncated = false;
                while let Some(row) = stream.next().await {
                    let row = row.map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
                    if rows_data.len() >= limit {
                        truncated = true;
                        break;
                    }
                    let mut row_vals = Vec::with_capacity(col_types.len());
                    for (i, ty) in col_types.iter().enumerate() {
                        row_vals.push(pg_cell_to_json(&row, i, ty));
                    }
                    rows_data.push(row_vals);
                }

                let count = rows_data.len() as u64;
                Ok((QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    affected_rows: count,
                    status_message: "Query executed successfully".to_string(),
                }, truncated))
            }
            Session::Mysql { conn, .. } => {
                let mut result = conn.query_iter(sql).await
                    .map_err(|e| { let d: DbError = from_mysql(e, Some(sql)).into(); d.to_json_string() })?;

                // Column metadata is available before reading rows, so it is
                // there even when the result is empty. No columns means a
                // statement without a result set (INSERT, UPDATE, DDL, ...).
                let col_meta = result.columns_ref().to_vec();
                if col_meta.is_empty() {
                    let affected = result.affected_rows();
                    result.drop_result().await
                        .map_err(|e| { let d: DbError = from_mysql(e, Some(sql)).into(); d.to_json_string() })?;
                    return Ok((affected_result(affected, start), false));
                }
                let columns: Vec<QueryColumn> = col_meta
                    .iter()
                    .map(|c| QueryColumn {
                        name: c.name_str().to_string(),
                        data_type: mysql_type_name(&c.column_type()),
                        enum_values: None,
                    })
                    .collect();

                let mut rows_data = Vec::new();
                let mut truncated = false;
                loop {
                    let row = match result.next().await {
                        Ok(Some(r)) => r,
                        Ok(None) => break,
                        Err(e) => return Err(from_mysql(e, Some(sql)).0.to_json_string()),
                    };
                    // Past the limit, keep reading (the connection must drain the
                    // result before the next statement) but stop storing rows.
                    if rows_data.len() >= limit {
                        truncated = true;
                        continue;
                    }
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
                // A CALL can return more result sets; drain them too.
                result.drop_result().await
                    .map_err(|e| { let d: DbError = from_mysql(e, Some(sql)).into(); d.to_json_string() })?;

                let count = rows_data.len() as u64;
                Ok((QueryResult {
                    columns,
                    rows: rows_data,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    affected_rows: count,
                    status_message: "Query executed successfully".to_string(),
                }, truncated))
            }
        }
    }

    pub(crate) async fn close(self) {
        if let Session::Mysql { pool, conn } = self {
            drop(conn);
            let _ = pool.disconnect().await;
        }
    }
}

/// JSON for a 64-bit (or wider) integer cell. The frontend parses results
/// with `JSON.parse`, which rounds integers beyond ±2^53 (9007199254740993
/// arrives as ...992) — and a backup then writes the rounded value. Those are
/// sent as strings instead; every engine accepts a quoted integer back.
pub(crate) fn int_json(n: i128) -> serde_json::Value {
    const SAFE: i128 = (1 << 53) - 1;
    if (-SAFE..=SAFE).contains(&n) {
        serde_json::json!(n as i64)
    } else {
        serde_json::json!(n.to_string())
    }
}

/// Runs `sql` statement by statement when it holds more than one, returning
/// the total rows changed; None for a single statement, which the caller
/// runs itself so its rows come back. Row-returning statements in the
/// middle of a script are run and their rows discarded.
fn run_sqlite_script(conn: &Connection, sql: &str) -> Result<Option<u64>, String> {
    let err = |e| from_sqlite(e, Some(sql)).to_json_string();
    let mut count = 0;
    let mut probe = rusqlite::Batch::new(conn, sql);
    while probe.next().map_err(err)?.is_some() {
        count += 1;
        if count > 1 {
            break;
        }
    }
    if count < 2 {
        return Ok(None);
    }
    let mut affected = 0u64;
    let mut batch = rusqlite::Batch::new(conn, sql);
    while let Some(mut stmt) = batch.next().map_err(err)? {
        if stmt.column_count() == 0 {
            affected += stmt.execute([]).map_err(err)? as u64;
        } else {
            let mut rows = stmt.query([]).map_err(err)?;
            while rows.next().map_err(err)?.is_some() {}
        }
    }
    Ok(Some(affected))
}

/// The reply when `prepare` is given more than one statement: Postgres'
/// wording, then CockroachDB's.
fn is_multiple_commands_error(e: &tokio_postgres::Error) -> bool {
    e.as_db_error().is_some_and(|db| {
        db.message().contains("cannot insert multiple commands into a prepared statement")
            || (db.message().contains("prepared statement had") && db.message().contains("expected 1"))
    })
}

fn affected_result(affected: u64, start: Instant) -> QueryResult {
    QueryResult {
        columns: vec![],
        rows: vec![],
        execution_time_ms: start.elapsed().as_millis() as u64,
        affected_rows: affected,
        status_message: format!("OK, {} rows affected", affected),
    }
}

fn truncate(mut result: QueryResult, limit: usize) -> (QueryResult, bool) {
    let truncated = result.rows.len() > limit;
    if truncated {
        result.rows.truncate(limit);
        result.affected_rows = limit as u64;
    }
    (result, truncated)
}

fn quote_pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchRequest {
    pub config: ConnectionConfig,
    pub statements: Vec<String>,
    /// Postgres-family schema the editor tab targets (sets `search_path`).
    pub schema: Option<String>,
    /// Max rows kept per result set; `None` or 0 keeps everything.
    pub row_limit: Option<usize>,
    /// Per-statement timeout in seconds; `None` or 0 means no timeout.
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct BatchItem {
    pub statement: String,
    pub result: Option<QueryResult>,
    pub error: Option<String>,
    /// More rows were returned than `row_limit` allowed.
    pub truncated: bool,
    pub duration_ms: u64,
}

/// Runs an editor buffer's statements in order on ONE connection, stopping at
/// the first error. The whole batch shares `query_id`, so Stop cancels it.
#[tauri::command]
pub async fn execute_batch(
    request: BatchRequest,
    query_id: String,
    registry: tauri::State<'_, QueryRegistry>,
) -> Result<Vec<BatchItem>, String> {
    let token = CancellationToken::new();
    registry.lock().await.insert(query_id.clone(), token.clone());

    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err(DbError::app(CANCELLED_BY_USER).to_json_string()),
        res = run_batch(request) => res,
    };

    registry.lock().await.remove(&query_id);
    result
}

async fn run_batch(request: BatchRequest) -> Result<Vec<BatchItem>, String> {
    let mut session = Session::open(&request.config).await?;
    if let Some(schema) = request.schema.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Err(e) = session.set_schema(schema).await {
            session.close().await;
            return Err(e);
        }
    }
    let row_limit = request.row_limit.filter(|n| *n > 0);
    let timeout = request.timeout_sec.filter(|n| *n > 0).map(Duration::from_secs);

    let mut items = Vec::new();
    for statement in request.statements {
        let sql = statement.trim();
        if sql.is_empty() {
            continue;
        }
        let start = Instant::now();
        let outcome = match timeout {
            Some(t) => match tokio::time::timeout(t, session.run(sql, row_limit)).await {
                Ok(r) => r,
                Err(_) => Err(DbError::app(format!(
                    "Query timed out after {}s. Change the limit in Settings → Query Execution.",
                    t.as_secs()
                )).to_json_string()),
            },
            None => session.run(sql, row_limit).await,
        };
        let duration_ms = start.elapsed().as_millis() as u64;
        match outcome {
            Ok((result, truncated)) => items.push(BatchItem {
                statement: sql.to_string(),
                result: Some(result),
                error: None,
                truncated,
                duration_ms,
            }),
            Err(error) => {
                items.push(BatchItem {
                    statement: sql.to_string(),
                    result: None,
                    error: Some(error),
                    truncated: false,
                    duration_ms,
                });
                break;
            }
        }
    }
    session.close().await;
    Ok(items)
}

/// Sessions kept open across IPC calls, for work that sends statements one at
/// a time but needs them on one connection. Restore depends on this: its
/// `SET FOREIGN_KEY_CHECKS = 0` must still apply to the INSERTs after it.
pub struct SessionRegistry(pub(crate) Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>);

static NEXT_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[tauri::command]
pub async fn session_open(config: ConnectionConfig, sessions: tauri::State<'_, SessionRegistry>) -> Result<String, String> {
    let session = Session::open(&config).await?;
    let id = format!("session_{}", NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    sessions.0.lock().await.insert(id.clone(), Arc::new(Mutex::new(session)));
    Ok(id)
}

#[tauri::command]
pub async fn session_execute(
    session_id: String,
    sql: String,
    query_id: String,
    sessions: tauri::State<'_, SessionRegistry>,
    registry: tauri::State<'_, QueryRegistry>,
) -> Result<QueryResult, String> {
    let sql = sql.trim().to_string();
    if sql.is_empty() {
        return Err(DbError::app("SQL statement is empty — nothing to execute.").to_json_string());
    }
    let session = sessions.0.lock().await.get(&session_id).cloned().ok_or_else(|| {
        DbError::connection("The database session has ended. Start the operation again.").to_json_string()
    })?;

    let token = CancellationToken::new();
    registry.lock().await.insert(query_id.clone(), token.clone());
    let mut guard = session.lock().await;
    let result = tokio::select! {
        biased;
        _ = token.cancelled() => Err(DbError::app(CANCELLED_BY_USER).to_json_string()),
        res = guard.run(&sql, None) => res.map(|(r, _)| r),
    };
    drop(guard);
    registry.lock().await.remove(&query_id);

    // A cancelled statement can leave the connection mid-response; drop the
    // session rather than reuse it.
    if result.as_ref().err().is_some_and(|e| e.contains(CANCELLED_BY_USER)) {
        close_session(&sessions, &session_id).await;
    }
    result
}

#[tauri::command]
pub async fn session_close(session_id: String, sessions: tauri::State<'_, SessionRegistry>) -> Result<(), String> {
    close_session(&sessions, &session_id).await;
    Ok(())
}

async fn close_session(sessions: &SessionRegistry, session_id: &str) {
    let removed = sessions.0.lock().await.remove(session_id);
    if let Some(session) = removed {
        if let Ok(mutex) = Arc::try_unwrap(session) {
            mutex.into_inner().close().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite_config(path: &str) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "name": "test",
            "engine": "sqlite",
            "filePath": path,
        }))
        .unwrap()
    }

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("rdsql-batch-{}-{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        path.to_string_lossy().into_owned()
    }

    fn batch(path: &str, statements: &[&str], row_limit: Option<usize>) -> Vec<BatchItem> {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(run_batch(BatchRequest {
            config: sqlite_config(path),
            statements: statements.iter().map(|s| s.to_string()).collect(),
            schema: None,
            row_limit,
            timeout_sec: None,
        }))
        .unwrap()
    }

    #[test]
    fn rollback_in_one_run_undoes_earlier_statements() {
        let path = &temp_db("rollback");
        batch(path, &["CREATE TABLE t (id INTEGER)", "INSERT INTO t VALUES (1)"], None);

        let items = batch(path, &["BEGIN", "DELETE FROM t", "ROLLBACK"], None);
        assert!(items.iter().all(|i| i.error.is_none()));

        let items = batch(path, &["SELECT COUNT(*) FROM t"], None);
        assert_eq!(items[0].result.as_ref().unwrap().rows[0][0], serde_json::json!(1));
    }

    #[test]
    fn stops_at_first_error_and_reports_it() {
        let path = temp_db("errors");
        let items = batch(&path, &["SELECT 1", "SELECT * FROM missing", "SELECT 2"], None);
        assert_eq!(items.len(), 2);
        assert!(items[1].error.is_some());
    }

    #[test]
    fn row_limit_truncates_and_flags() {
        let path = temp_db("limit");
        let sql = "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 50) SELECT x FROM n";
        let items = batch(&path, &[sql], Some(10));
        let result = items[0].result.as_ref().unwrap();
        assert_eq!(result.rows.len(), 10);
        assert!(items[0].truncated);
    }

    #[test]
    fn cte_and_returning_statements_return_rows() {
        let path = temp_db("cte");
        let items = batch(
            &path,
            &["CREATE TABLE t (id INTEGER)", "INSERT INTO t VALUES (7) RETURNING id", "WITH x AS (SELECT id FROM t) SELECT * FROM x"],
            None,
        );
        assert_eq!(items[1].result.as_ref().unwrap().rows[0][0], serde_json::json!(7));
        assert_eq!(items[2].result.as_ref().unwrap().rows.len(), 1);
    }

    #[test]
    fn quotes_pg_identifiers() {
        assert_eq!(quote_pg_ident("sales"), "\"sales\"");
        assert_eq!(quote_pg_ident("we\"ird"), "\"we\"\"ird\"");
    }
}
