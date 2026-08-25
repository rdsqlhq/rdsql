//! Microsoft SQL Server — connection test, query execution, and schema
//! introspection via the `tiberius` crate (TDS protocol over a plain Tokio
//! `TcpStream`, wrapped for tiberius's `AsyncRead`/`AsyncWrite` needs via
//! `tokio_util::compat`).
//!
//! SQL Server speaks its own wire protocol (TDS) — not compatible with
//! Postgres or MySQL — so like DuckDB and Cloudflare D1 it gets its own
//! dedicated module, short-circuited before the shared `EngineFamily` match
//! in `connection.rs`/`query.rs` rather than adding arms there.
//!
//! One TDS session can see every database on the server (like MySQL), but
//! `INFORMATION_SCHEMA`/`sys.*` catalog views are always scoped to whichever
//! database is currently selected. `fetch_mssql_schema` walks every database
//! with a `USE [db]` before introspecting it, mirroring how SSMS/Azure Data
//! Studio's Object Explorer builds its tree from a single connection.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use tiberius::{AuthMethod, Client, ColumnData, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::connection::{normalize_host, ConnectionConfig, ConnectionTestResult, SchemaNode};
use super::error::from_tiberius;
use super::query::{QueryColumn, QueryResult};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Quote a T-SQL identifier (database/schema/table name) with `[brackets]`,
/// doubling any embedded `]`. Used only for the `USE [db]` session-context
/// switch below — table/column identifiers in generated SQL are quoted on
/// the frontend via `quoteIdent()`.
fn quote_mssql_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// Build a `tiberius::Config` from the connection form and open a TCP + TDS
/// session. Encryption defaults to required-with-trusted-cert (self-signed
/// certs are the common case for local/dev SQL Server); `sslMode: "disable"`
/// turns encryption off entirely.
async fn connect_raw(config: &ConnectionConfig) -> Result<Client<Compat<TcpStream>>, tiberius::error::Error> {
    let host = normalize_host(config.host.clone());
    let port = config
        .port
        .or_else(|| super::engine::default_port(&config.engine))
        .unwrap_or(1433);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port)
        .await
        .map_err(|message| tiberius::error::Error::Io { kind: std::io::ErrorKind::Other, message })?;
    let user = config.username.clone().unwrap_or_else(|| "sa".to_string());
    let pass = config.password.clone().unwrap_or_default();
    let db = config.database.clone().filter(|d| !d.is_empty());

    let mut tiberius_config = Config::new();
    tiberius_config.host(&host);
    tiberius_config.port(port);
    if let Some(db) = db {
        tiberius_config.database(db);
    }
    tiberius_config.authentication(AuthMethod::sql_server(user, pass));

    let ssl_mode = config.ssl_mode.as_deref().unwrap_or("");
    if ssl_mode.eq_ignore_ascii_case("disable") {
        tiberius_config.encryption(EncryptionLevel::NotSupported);
    } else {
        tiberius_config.encryption(EncryptionLevel::Required);
        tiberius_config.trust_cert();
    }

    let addr = tiberius_config.get_addr();
    // Only the raw TCP connect is safe to abandon on a timeout — no protocol
    // bytes have been written yet. Once `Client::connect` starts the TLS +
    // TDS PRELOGIN/LOGIN7 handshake it must be allowed to run to completion:
    // forcibly dropping that future mid-write (e.g. by wrapping it in the
    // same `tokio::time::timeout`) truncates a TDS packet the server has
    // already started reading, which SQL Server reports as "Length specified
    // in network packet payload did not match number of bytes read" (error
    // 17836) and closes the connection — a real bug, not a fluke, more
    // likely to hit under host load (slow TLS handshake) than in a quiet
    // isolated test.
    let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr.as_str())).await {
        Ok(res) => res?,
        Err(_) => {
            return Err(tiberius::error::Error::Io {
                kind: std::io::ErrorKind::TimedOut,
                message: format!("TCP connect to {} timed out after {}s", addr, CONNECT_TIMEOUT.as_secs()),
            })
        }
    };
    tcp.set_nodelay(true)?;
    Client::connect(tiberius_config, tcp.compat_write()).await
}

/// Connect, collapsing timeout and driver-error cases into a single JSON
/// `DbError` string — the shape every Tauri command boundary in this app
/// expects. The timeout itself is applied only to the TCP connect step
/// inside `connect_raw` (see the comment there) — the TLS/TDS handshake
/// runs to completion once started.
async fn connect(config: &ConnectionConfig) -> Result<Client<Compat<TcpStream>>, String> {
    connect_raw(config).await.map_err(|e| from_tiberius(e, None).to_json_string())
}

/// Connection test: connect, run `SELECT @@VERSION`, and parse a compact
/// label from the (multi-line) version banner.
pub async fn test_mssql(config: &ConnectionConfig) -> Result<ConnectionTestResult, String> {
    let start = Instant::now();
    let host = normalize_host(config.host.clone());
    let port = config
        .port
        .or_else(|| super::engine::default_port(&config.engine))
        .unwrap_or(1433);

    let mut client = match connect(config).await {
        Ok(c) => c,
        Err(err) => {
            return Ok(ConnectionTestResult {
                success: false,
                message: format!("SQL Server connection failed: {}", err),
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            })
        }
    };

    let version: Option<String> = match client.simple_query("SELECT @@VERSION AS v").await {
        Ok(stream) => stream
            .into_row()
            .await
            .ok()
            .flatten()
            .and_then(|row| row.get::<&str, _>(0).map(|s| s.to_string())),
        Err(_) => None,
    };

    let latency = start.elapsed().as_millis() as u64;
    let label = version
        .as_deref()
        .map(|v| format!("Connected to {}", v.lines().next().unwrap_or(v).trim()))
        .unwrap_or_else(|| format!("Connected to SQL Server ({}:{})", host, port));

    Ok(ConnectionTestResult {
        success: true,
        message: label,
        latency_ms: latency,
        server_version: version,
    })
}

struct TableMeta {
    tbl_type: String,
    row_count: Option<u64>,
    size_bytes: Option<u64>,
    cols: Vec<SchemaNode>,
}

/// Schema introspection: walk every database on the server (or just
/// `scope_database`, when the Compare & Sync tool targets one), and within
/// each, every table/view + column, PK, identity, and row-count/size stats.
pub async fn fetch_mssql_schema(config: &ConnectionConfig) -> Result<Vec<SchemaNode>, String> {
    let mut client = connect(config).await?;

    let include_system = config.include_system_schemas.unwrap_or(false);
    let scope = config.scope_database.as_deref().filter(|d| !d.is_empty());

    let db_query = if let Some(db) = scope {
        format!(
            "SELECT name FROM sys.databases WHERE state = 0 AND name = '{}' ORDER BY name",
            db.replace('\'', "''")
        )
    } else if include_system {
        "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name".to_string()
    } else {
        "SELECT name FROM sys.databases WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb') ORDER BY name".to_string()
    };

    let db_names: Vec<String> = client
        .simple_query(db_query)
        .await
        .map_err(|e| from_tiberius(e, None).to_json_string())?
        .into_first_result()
        .await
        .map_err(|e| from_tiberius(e, None).to_json_string())?
        .iter()
        .filter_map(|row| row.get::<&str, _>(0).map(|s| s.to_string()))
        .collect();

    let schema_filter = if include_system {
        String::new()
    } else {
        "AND c.TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')".to_string()
    };

    const PK_QUERY: &str = "
        SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
          ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'";

    const IDENTITY_QUERY: &str = "
        SELECT s.name, t.name, c.name
        FROM sys.identity_columns c
        JOIN sys.tables t ON t.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id";

    const STATS_QUERY: &str = "
        SELECT sch.name, tbl.name, SUM(ps.row_count), SUM(ps.used_page_count) * 8 * 1024
        FROM sys.tables tbl
        JOIN sys.schemas sch ON sch.schema_id = tbl.schema_id
        JOIN sys.dm_db_partition_stats ps ON ps.object_id = tbl.object_id AND ps.index_id IN (0, 1)
        GROUP BY sch.name, tbl.name";

    let mut result_schemas = Vec::new();

    for db_name in db_names {
        // Session-scoped context switch — subsequent queries on this same
        // client see this database's INFORMATION_SCHEMA/sys.* views.
        if client
            .simple_query(format!("USE {}", quote_mssql_ident(&db_name)))
            .await
            .is_err()
        {
            // No permission to enter this database — skip it rather than
            // failing the whole tree.
            continue;
        }

        // Best-effort: a permission-restricted login might not be able to read
        // every catalog view in every database. Fall back to empty rather
        // than failing the whole tree walk.
        async fn rows_of(client: &mut Client<Compat<TcpStream>>, sql: &str) -> Vec<tiberius::Row> {
            match client.simple_query(sql).await {
                Ok(stream) => stream.into_first_result().await.unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        }

        let pk_set: HashSet<(String, String, String)> = rows_of(&mut client, PK_QUERY)
            .await
            .iter()
            .filter_map(|r| {
                Some((
                    r.get::<&str, _>(0)?.to_string(),
                    r.get::<&str, _>(1)?.to_string(),
                    r.get::<&str, _>(2)?.to_string(),
                ))
            })
            .collect();

        let identity_set: HashSet<(String, String, String)> = rows_of(&mut client, IDENTITY_QUERY)
            .await
            .iter()
            .filter_map(|r| {
                Some((
                    r.get::<&str, _>(0)?.to_string(),
                    r.get::<&str, _>(1)?.to_string(),
                    r.get::<&str, _>(2)?.to_string(),
                ))
            })
            .collect();

        let stats_map: HashMap<(String, String), (u64, u64)> = rows_of(&mut client, STATS_QUERY)
            .await
            .iter()
            .filter_map(|r| {
                let schema = r.get::<&str, _>(0)?.to_string();
                let table = r.get::<&str, _>(1)?.to_string();
                let rows: i64 = r.get(2).unwrap_or(0);
                let size: i64 = r.get(3).unwrap_or(0);
                Some(((schema, table), (rows.max(0) as u64, size.max(0) as u64)))
            })
            .collect();

        let col_query = format!(
            "SELECT c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, c.COLUMN_NAME, c.DATA_TYPE, \
                    c.IS_NULLABLE, c.COLUMN_DEFAULT \
             FROM INFORMATION_SCHEMA.COLUMNS c \
             JOIN INFORMATION_SCHEMA.TABLES t \
               ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE 1 = 1 {} \
             ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
            schema_filter
        );

        let col_rows = client
            .simple_query(col_query)
            .await
            .map_err(|e| from_tiberius(e, None).to_json_string())?
            .into_first_result()
            .await
            .map_err(|e| from_tiberius(e, None).to_json_string())?;

        let mut tables: BTreeMap<String, BTreeMap<String, TableMeta>> = BTreeMap::new();

        for row in &col_rows {
            let schema_name = row.get::<&str, _>(0).unwrap_or("").to_string();
            let table_name = row.get::<&str, _>(1).unwrap_or("").to_string();
            let table_type = row.get::<&str, _>(2).unwrap_or("");
            let col_name = row.get::<&str, _>(3).unwrap_or("").to_string();
            let data_type = row.get::<&str, _>(4).unwrap_or("").to_string();
            let is_nullable = row.get::<&str, _>(5).unwrap_or("YES");
            let col_default = row.get::<&str, _>(6);

            let key = (schema_name.clone(), table_name.clone(), col_name.clone());
            let is_pk = pk_set.contains(&key);
            let is_identity = identity_set.contains(&key);
            let stats = stats_map.get(&(schema_name.clone(), table_name.clone())).copied();

            let schema_tables = tables.entry(schema_name).or_default();
            let entry = schema_tables.entry(table_name).or_insert_with(|| TableMeta {
                tbl_type: if table_type.eq_ignore_ascii_case("VIEW") { "view".to_string() } else { "table".to_string() },
                row_count: stats.map(|(r, _)| r),
                size_bytes: stats.map(|(_, s)| s),
                cols: Vec::new(),
            });

            entry.cols.push(SchemaNode {
                name: col_name,
                node_type: "column".to_string(),
                data_type: Some(data_type),
                row_count: None,
                size_bytes: None,
                is_primary_key: Some(is_pk),
                is_foreign_key: Some(false),
                is_nullable: Some(is_nullable.eq_ignore_ascii_case("YES")),
                has_default: Some(col_default.is_some() || is_identity),
                children: vec![],
            });
        }

        let mut table_nodes = Vec::new();
        for (schema_name, tbls) in tables {
            for (table_name, meta) in tbls {
                // Qualify with the T-SQL schema when it isn't the default
                // `dbo`, so multiple schemas in one database don't collide.
                let display_name = if schema_name.eq_ignore_ascii_case("dbo") {
                    table_name
                } else {
                    format!("{}.{}", schema_name, table_name)
                };
                table_nodes.push(SchemaNode {
                    name: display_name,
                    node_type: meta.tbl_type,
                    data_type: None,
                    row_count: meta.row_count,
                    size_bytes: meta.size_bytes,
                    is_primary_key: None,
                    is_foreign_key: None,
                    is_nullable: None,
                    has_default: None,
                    children: meta.cols,
                });
            }
        }

        result_schemas.push(SchemaNode {
            name: db_name,
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

    Ok(result_schemas)
}

/// Convert a SQL Server column type to a clean, lower-cased name for display
/// (e.g. `NVarchar` → `nvarchar`). Mirrors `mysql_type_name`'s Debug-based
/// approach — robust to the exact enum shape without an exhaustive match.
fn mssql_type_name(t: tiberius::ColumnType) -> String {
    format!("{:?}", t).to_lowercase()
}

/// Convert a tiberius cell value to JSON. Date/time variants delegate to
/// tiberius's own `FromSql` impls for the `chrono` types (generated by its
/// `from_sql!` macro over `ColumnData` — see `tiberius::tds::time::chrono`)
/// rather than hand-rolling the TDS date/time arithmetic here.
fn mssql_cell_to_json(data: &ColumnData<'static>) -> serde_json::Value {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use serde_json::json;
    use tiberius::FromSql;
    use ColumnData as CD;
    match data {
        CD::U8(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::I16(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::I32(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::I64(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::F32(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::F64(v) => v.map(|n| json!(n)).unwrap_or(serde_json::Value::Null),
        CD::Bit(v) => v.map(|b| json!(b)).unwrap_or(serde_json::Value::Null),
        CD::String(v) => v.as_ref().map(|s| json!(s.as_ref())).unwrap_or(serde_json::Value::Null),
        CD::Guid(v) => v.map(|g| json!(g.to_string())).unwrap_or(serde_json::Value::Null),
        CD::Binary(v) => v
            .as_ref()
            .map(|b| json!(format!("<binary {} bytes>", b.len())))
            .unwrap_or(serde_json::Value::Null),
        CD::Numeric(v) => v.map(|n| json!(n.to_string())).unwrap_or(serde_json::Value::Null),
        CD::Xml(v) => v.as_ref().map(|x| json!(x.to_string())).unwrap_or(serde_json::Value::Null),
        CD::Date(_) => NaiveDate::from_sql(data)
            .ok()
            .flatten()
            .map(|d| json!(d.to_string()))
            .unwrap_or(serde_json::Value::Null),
        CD::Time(_) => NaiveTime::from_sql(data)
            .ok()
            .flatten()
            .map(|t| json!(t.to_string()))
            .unwrap_or(serde_json::Value::Null),
        // SmallDateTime / DateTime / DateTime2 all route through the same
        // `NaiveDateTime: FromSql` impl (it matches all three ColumnData
        // patterns internally).
        CD::SmallDateTime(_) | CD::DateTime(_) | CD::DateTime2(_) => NaiveDateTime::from_sql(data)
            .ok()
            .flatten()
            .map(|d| json!(d.to_string()))
            .unwrap_or(serde_json::Value::Null),
        CD::DateTimeOffset(_) => chrono::DateTime::<chrono::Utc>::from_sql(data)
            .ok()
            .flatten()
            .map(|d| json!(d.to_rfc3339()))
            .unwrap_or(serde_json::Value::Null),
    }
}

/// Query execution. SELECT-shaped statements stream rows via `Client::query`
/// (parameter-less — this app always sends a single, already-composed
/// statement); everything else runs via `Client::execute` for an
/// affected-rows count, matching the DML/DDL path used by every other
/// engine's `run_query` arm.
pub async fn run_mssql_query(config: &ConnectionConfig, sql: &str) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut client = connect(config).await?;

    let upper = sql.trim_start().to_uppercase();
    let is_select = upper.starts_with("SELECT")
        || upper.starts_with("WITH")
        || upper.starts_with("EXEC")
        || upper.starts_with("EXECUTE");

    if is_select {
        let mut stream = client
            .query(sql, &[])
            .await
            .map_err(|e| from_tiberius(e, Some(sql)).to_json_string())?;

        let columns: Vec<QueryColumn> = stream
            .columns()
            .await
            .map_err(|e| from_tiberius(e, Some(sql)).to_json_string())?
            .unwrap_or(&[])
            .iter()
            .map(|c| QueryColumn {
                name: c.name().to_string(),
                data_type: mssql_type_name(c.column_type()),
                enum_values: None,
            })
            .collect();

        let rows = stream
            .into_first_result()
            .await
            .map_err(|e| from_tiberius(e, Some(sql)).to_json_string())?;

        let rows_data: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| row.cells().map(|(_, data)| mssql_cell_to_json(data)).collect())
            .collect();

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
        let result = client
            .execute(sql, &[])
            .await
            .map_err(|e| from_tiberius(e, Some(sql)).to_json_string())?;
        let affected = result.total();
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
