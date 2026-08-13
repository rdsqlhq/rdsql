use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio_postgres::NoTls;
use rusqlite::Connection;
use mysql_async::prelude::*;

/// Bound how long we'll wait on the initial TCP/auth handshake. Without this,
/// a misconfigured/unreachable server (or the classic "localhost" resolving
/// to IPv6 `::1` first when the DB only listens on `127.0.0.1`) leaves the
/// UI spinner running indefinitely instead of surfacing a clear error.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// "localhost" can resolve to `::1` before `127.0.0.1` on macOS, and most
/// local MySQL/Postgres installs only bind the IPv4 loopback address. That
/// mismatch makes the connection attempt hang until the OS gives up on the
/// (nothing-listening) IPv6 attempt rather than failing fast. Sidestep it by
/// always connecting to the IPv4 loopback explicitly.
/// Quote a Postgres identifier (schema/table/column name).
fn quote_pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn normalize_host(host: Option<String>) -> String {
    let h = host.unwrap_or_else(|| "127.0.0.1".to_string());
    if h.trim().eq_ignore_ascii_case("localhost") {
        "127.0.0.1".to_string()
    } else {
        h
    }
}

fn mysql_opts(host: String, port: u16, user: String, pass: String, db: Option<String>) -> mysql_async::Opts {
    mysql_async::OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(user))
        .pass(Some(pass))
        .db_name(db)
        .into()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: Option<String>,
    pub name: String,
    pub engine: String, // postgres, mysql, sqlite, duckdb, cloudflare-d1
    pub host: Option<String>,
    pub port: Option<u16>,
    pub database: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub ssl_mode: Option<String>,
    pub file_path: Option<String>,
    // Cloudflare D1
    pub cf_account_id: Option<String>,
    pub cf_api_token: Option<String>,
    pub cf_database_id: Option<String>,
    /// Optional database-name scope for the Compare & Sync tool. On engines
    /// where a single connection can see many databases (MySQL/MariaDB),
    /// setting this limits `fetch_schema_tree` and the compare/sync commands
    /// to that one database only — instead of diffing every database the
    /// user can see. Ignored on engines with a single database per
    /// connection (Postgres, SQLite, D1).
    pub scope_database: Option<String>,
    /// When true, `fetch_schema_tree` includes system schemas (Postgres:
    /// `pg_catalog`/`information_schema`; MySQL: `information_schema`/`mysql`/
    /// `performance_schema`/`sys`) instead of filtering them out. Passed as an
    /// ad hoc per-call override — like `scope_database` — not a field the user
    /// edits on the saved connection profile. Ignored by every other command.
    pub include_system_schemas: Option<bool>,
    /// Redis logical database index (`SELECT n`, 0-15 by default server
    /// config). Ignored by every other engine.
    pub redis_db_index: Option<u8>,
    /// Optional SSH tunnel / jump-server config. When set, every networked
    /// engine's connect path routes through it — see
    /// `commands::ssh_tunnel::resolve_target`.
    pub ssh: Option<super::ssh_tunnel::SshTunnelSpec>,
    /// MongoDB `authSource` (the database a user's credentials are defined
    /// in, when different from the connection's target database). Ignored
    /// by every other engine.
    pub mongo_auth_source: Option<String>,
    /// MongoDB replica set name (`replicaSet` URI option). Ignored by every
    /// other engine.
    pub mongo_replica_set: Option<String>,
    /// Full MongoDB connection string override (required for `mongodb+srv://`
    /// Atlas-style connections, which have no fixed port/host — see
    /// `commands::mongo`'s module doc). When set, takes precedence over
    /// host/port/username/password/database/mongo_auth_source/
    /// mongo_replica_set and bypasses the SSH tunnel. Ignored by every other
    /// engine.
    pub mongo_connection_string: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: u64,
    pub server_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SchemaNode {
    pub name: String,
    pub node_type: String, // schema, table, view, column
    pub data_type: Option<String>,
    pub row_count: Option<u64>,
    pub size_bytes: Option<u64>,
    pub is_primary_key: Option<bool>,
    pub is_foreign_key: Option<bool>,
    /// None = unknown (caller should treat as "don't enforce"). Only ever
    /// populated on column nodes.
    pub is_nullable: Option<bool>,
    /// True when the column has a DEFAULT, is an identity/auto-increment
    /// column, etc. — the database fills it in even if it's NOT NULL, so a
    /// UI shouldn't treat it as "required to type something in".
    pub has_default: Option<bool>,
    pub children: Vec<SchemaNode>,
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<ConnectionTestResult, String> {
    let start = Instant::now();
    let engine = config.engine.to_lowercase();

    // DuckDB is an embedded analytical engine with its own driver — dispatch
    // to the dedicated module before the family-based match below.
    if engine == "duckdb" {
        return super::duckdb::test_duckdb(&config).await;
    }
    if engine == "cloudflare-d1" || engine == "d1" {
        return match super::d1::test_d1(&config).await {
            Ok((msg, latency)) => Ok(ConnectionTestResult {
                success: true,
                message: msg,
                latency_ms: latency,
                server_version: Some("Cloudflare D1".to_string()),
            }),
            Err(e) => Ok(ConnectionTestResult {
                success: false,
                message: e,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            }),
        };
    }
    // SQL Server has its own driver (tiberius) — dispatch before family match.
    if engine == "mssql" || engine == "sqlserver" || engine == "azuresql" {
        return super::mssql::test_mssql(&config).await;
    }
    // Redis has its own wire protocol (RESP) — not a SQL family at all.
    // Short-circuit here too, same as D1/DuckDB above.
    if engine == "redis" {
        return match super::redis::test_connection_impl(&config).await {
            Ok(r) => Ok(ConnectionTestResult {
                success: r.success,
                message: r.message,
                latency_ms: r.latency_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64),
                server_version: Some("Redis".to_string()),
            }),
            Err(e) => Ok(ConnectionTestResult {
                success: false,
                message: e.message,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            }),
        };
    }
    // MongoDB is a document store — not a SQL family at all. Short-circuit
    // here too, same as Redis above.
    if engine == "mongodb" {
        return match super::mongo::test_connection_impl(&config).await {
            Ok(r) => Ok(ConnectionTestResult {
                success: r.success,
                message: r.message,
                latency_ms: r.latency_ms.unwrap_or_else(|| start.elapsed().as_millis() as u64),
                server_version: Some("MongoDB".to_string()),
            }),
            Err(e) => Ok(ConnectionTestResult {
                success: false,
                message: e.message,
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            }),
        };
    }

    match super::engine::engine_family(&engine) {
        super::engine::EngineFamily::Sqlite => {
            let path = config.file_path.unwrap_or_default();
            if path.is_empty() {
                return Ok(ConnectionTestResult {
                    success: false,
                    message: "SQLite file path cannot be empty".to_string(),
                    latency_ms: 0,
                    server_version: None,
                });
            }

            match Connection::open(&path) {
                Ok(conn) => {
                    let version: String = conn
                        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
                        .unwrap_or_else(|_| "3.x".to_string());
                    let latency = start.elapsed().as_millis() as u64;
                    Ok(ConnectionTestResult {
                        success: true,
                        message: format!("Connected to SQLite {}", version),
                        latency_ms: latency,
                        server_version: Some(format!("SQLite {}", version)),
                    })
                }
                Err(err) => Ok(ConnectionTestResult {
                    success: false,
                    message: format!("Failed to open SQLite database: {}", err),
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: None,
                }),
            }
        }
        super::engine::EngineFamily::Postgres => {
            let host = normalize_host(config.host.clone());
            let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(5432);
            let (host, port) = match super::ssh_tunnel::resolve_target(&config, host, port).await {
                Ok(t) => t,
                Err(e) => {
                    return Ok(ConnectionTestResult {
                        success: false,
                        message: e,
                        latency_ms: start.elapsed().as_millis() as u64,
                        server_version: None,
                    })
                }
            };
            let user = config.username.unwrap_or_else(|| "postgres".to_string());
            let db = config.database.unwrap_or_else(|| "postgres".to_string());
            let pass = config.password.unwrap_or_default();

            let conn_str = format!(
                "host={} port={} user={} dbname={} password={}",
                host, port, user, db, pass
            );

            match tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(&conn_str, NoTls)).await {
                Ok(Ok((client, connection))) => {
                    tokio::spawn(async move {
                        if let Err(e) = connection.await {
                            eprintln!("PostgreSQL connection error: {}", e);
                        }
                    });

                    match client.query_one("SELECT version()", &[]).await {
                        Ok(row) => {
                            let ver: String = row.get(0);
                            // `SELECT version()` returns e.g.
                            // "PostgreSQL 16.2 on x86_64-pc-linux-gnu ...". Pull the
                            // leading "PostgreSQL <ver>" token for a compact label.
                            let short = ver.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
                            let latency = start.elapsed().as_millis() as u64;
                            Ok(ConnectionTestResult {
                                success: true,
                                message: format!("Connected to {}", short),
                                latency_ms: latency,
                                server_version: Some(ver),
                            })
                        }
                        Err(e) => Ok(ConnectionTestResult {
                            success: false,
                            message: format!("Query version failed: {}", e),
                            latency_ms: start.elapsed().as_millis() as u64,
                            server_version: None,
                        }),
                    }
                }
                Ok(Err(err)) => Ok(ConnectionTestResult {
                    success: false,
                    message: format!("PostgreSQL connection failed: {}", err),
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: None,
                }),
                Err(_) => Ok(ConnectionTestResult {
                    success: false,
                    message: format!(
                        "PostgreSQL connection timed out after {}s — check that the server is running on {}:{} and reachable",
                        CONNECT_TIMEOUT.as_secs(), host, port
                    ),
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: None,
                }),
            }
        }
        super::engine::EngineFamily::Mysql => {
            let host = normalize_host(config.host.clone());
            let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(3306);
            let (host, port) = match super::ssh_tunnel::resolve_target(&config, host, port).await {
                Ok(t) => t,
                Err(e) => {
                    return Ok(ConnectionTestResult {
                        success: false,
                        message: e,
                        latency_ms: start.elapsed().as_millis() as u64,
                        server_version: None,
                    })
                }
            };
            let user = config.username.unwrap_or_else(|| "root".to_string());
            let db = config.database.clone().filter(|d| !d.is_empty());
            let pass = config.password.unwrap_or_default();

            let opts = mysql_opts(host.clone(), port, user, pass, db);
            let pool = mysql_async::Pool::new(opts);

            match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
                Ok(Ok(mut conn)) => {
                    let version: Option<String> = conn
                        .query_first("SELECT VERSION()")
                        .await
                        .unwrap_or(None);
                    let latency = start.elapsed().as_millis() as u64;
                    // `Pool::disconnect()` waits for every checked-out connection to be
                    // returned to the pool, so it deadlocks forever if `conn` is still
                    // alive here. Release it explicitly before tearing the pool down.
                    drop(conn);
                    let _ = pool.disconnect().await;
                    // `SELECT VERSION()` returns e.g. "8.0.36",
                    // "10.11.6-MariaDB-1:10.11.6+maria~ubu2204",
                    // "5.7.25-TiDB-v7.5.0", or a PlanetScale/Percona banner. Pick a
                    // compact label from the leading tokens.
                    let label = version
                        .as_deref()
                        .map(|v| {
                            let lower = v.to_lowercase();
                            let engine_name = if lower.contains("mariadb") {
                                "MariaDB"
                            } else if lower.contains("tidb") {
                                "TiDB"
                            } else if lower.contains("planetscale") {
                                "PlanetScale"
                            } else {
                                "MySQL"
                            };
                            // Take the leading version token (before any '-' or space).
                            let ver_token = v.split(|c: char| c == '-' || c.is_whitespace()).next().unwrap_or(v);
                            format!("Connected to {} {}", engine_name, ver_token)
                        })
                        .unwrap_or_else(|| format!("Connected to MySQL ({}:{})", host, port));
                    Ok(ConnectionTestResult {
                        success: true,
                        message: label,
                        latency_ms: latency,
                        server_version: version,
                    })
                }
                Ok(Err(err)) => {
                    let latency = start.elapsed().as_millis() as u64;
                    let _ = pool.disconnect().await;
                    Ok(ConnectionTestResult {
                        success: false,
                        message: format!("MySQL connection failed: {}", err),
                        latency_ms: latency,
                        server_version: None,
                    })
                }
                Err(_) => {
                    let latency = start.elapsed().as_millis() as u64;
                    let _ = pool.disconnect().await;
                    Ok(ConnectionTestResult {
                        success: false,
                        message: format!(
                            "MySQL connection timed out after {}s — check that MySQL is running on {}:{}, accepting TCP connections, and not blocked by a firewall",
                            CONNECT_TIMEOUT.as_secs(), host, port
                        ),
                        latency_ms: latency,
                        server_version: None,
                    })
                }
            }
        }
        // DuckDB is short-circuited above (`test_duckdb`); this arm is
        // unreachable but keeps the family match exhaustive.
        super::engine::EngineFamily::Duckdb => {
            Ok(ConnectionTestResult {
                success: false,
                message: "DuckDB test was not dispatched correctly.".to_string(),
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            })
        }
        // SQL Server is short-circuited above (`test_mssql`); this arm is
        // unreachable but keeps the family match exhaustive.
        super::engine::EngineFamily::Mssql => {
            Ok(ConnectionTestResult {
                success: false,
                message: "SQL Server test was not dispatched correctly.".to_string(),
                latency_ms: start.elapsed().as_millis() as u64,
                server_version: None,
            })
        }
    }
}

/// Introspection implementation shared by `fetch_schema_tree` (the IPC
/// command) and the compare/sync tooling (which needs to read two databases'
/// schemas without crossing the command boundary twice). The public
/// `fetch_schema_tree` below is just the `#[tauri::command]` wrapper.
pub async fn fetch_schema_tree_impl(config: ConnectionConfig) -> Result<Vec<SchemaNode>, String> {
    let engine = config.engine.to_lowercase();

    // D1 reuses SQLite SQL over REST — short-circuit before family dispatch.
    if engine == "cloudflare-d1" || engine == "d1" {
        return super::d1::fetch_d1_schema(&config).await;
    }
    // DuckDB has its own driver + introspection queries — short-circuit too.
    if engine == "duckdb" {
        return super::duckdb::fetch_duckdb_schema(&config);
    }
    // SQL Server has its own driver + introspection queries — short-circuit too.
    if engine == "mssql" || engine == "sqlserver" || engine == "azuresql" {
        return super::mssql::fetch_mssql_schema(&config).await;
    }
    // Redis has no schema/table/column tree at all — the Explorer opens a key
    // browser tab for it instead (see `commands::redis`).
    if engine == "redis" {
        return Ok(vec![]);
    }
    // MongoDB's database → collection structure fits the Explorer's tree
    // directly, unlike Redis's flat keyspace — see `commands::mongo::fetch_mongo_schema`.
    if engine == "mongodb" {
        return super::mongo::fetch_mongo_schema(&config).await;
    }

    match super::engine::engine_family(&engine) {
        super::engine::EngineFamily::Sqlite => {
            let path = config.file_path.unwrap_or_default();
            let conn = Connection::open(&path).map_err(|e| e.to_string())?;

            let mut stmt = conn
                .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
                .map_err(|e| e.to_string())?;

            let table_rows = stmt
                .query_map([], |row| {
                    let name: String = row.get(0)?;
                    let node_type: String = row.get(1)?;
                    Ok((name, node_type))
                })
                .map_err(|e| e.to_string())?;

            let mut table_nodes = Vec::new();

            for item in table_rows {
                if let Ok((tbl_name, tbl_type)) = item {
                    let row_count: u64 = conn
                        .query_row(&format!("SELECT count(*) FROM \"{}\"", tbl_name), [], |r| r.get(0))
                        .unwrap_or(0);

                    let mut col_stmt = conn
                        .prepare(&format!("PRAGMA table_info('{}')", tbl_name))
                        .map_err(|e| e.to_string())?;

                    // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
                    let col_rows = col_stmt
                        .query_map([], |row| {
                            let col_name: String = row.get(1)?;
                            let col_type: String = row.get(2)?;
                            let notnull: i64 = row.get(3)?;
                            let dflt_value: Option<String> = row.get(4)?;
                            let pk: i32 = row.get(5)?;
                            // SQLite `INTEGER PRIMARY KEY` columns alias the implicit
                            // rowid and are auto-populated when omitted, even though
                            // PRAGMA table_info reports them as NOT NULL.
                            let is_rowid_alias = pk > 0 && col_type.to_uppercase().contains("INT");
                            Ok(SchemaNode {
                                name: col_name,
                                node_type: "column".to_string(),
                                data_type: Some(col_type),
                                row_count: None,
                                size_bytes: None,
                                is_primary_key: Some(pk > 0),
                                is_foreign_key: Some(false),
                                is_nullable: Some(notnull == 0),
                                has_default: Some(dflt_value.is_some() || is_rowid_alias),
                                children: vec![],
                            })
                        })
                        .map_err(|e| e.to_string())?;

                    let mut cols = Vec::new();
                    for col in col_rows {
                        if let Ok(c) = col {
                            cols.push(c);
                        }
                    }

                    table_nodes.push(SchemaNode {
                        name: tbl_name,
                        node_type: tbl_type,
                        data_type: None,
                        row_count: Some(row_count),
                        size_bytes: Some(row_count * 128),
                        is_primary_key: None,
                        is_foreign_key: None,
                        is_nullable: None,
                        has_default: None,
                        children: cols,
                    });
                }
            }

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
        super::engine::EngineFamily::Postgres => {
            let host = normalize_host(config.host.clone());
            let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(5432);
            let (host, port) = super::ssh_tunnel::resolve_target(&config, host, port).await?;
            let user = config.username.unwrap_or_else(|| "postgres".to_string());
            let db = config.database.unwrap_or_else(|| "postgres".to_string());
            let pass = config.password.unwrap_or_default();

            let conn_str = format!(
                "host={} port={} user={} dbname={} password={}",
                host, port, user, db, pass
            );

            let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(&conn_str, NoTls)).await {
                Ok(Ok(pair)) => pair,
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => {
                    return Err(format!(
                        "PostgreSQL connection timed out after {}s — check that the server is running on {}:{}",
                        CONNECT_TIMEOUT.as_secs(), host, port
                    ))
                }
            };

            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    eprintln!("PostgreSQL connection error: {}", e);
                }
            });

            // Query PostgreSQL schemas, tables, size, columns, PK, FK,
            // nullability and default/identity info (for required-field validation).
            // Row counts use `pg_class.reltuples` as a fast estimate first, then
            // we run an accurate `COUNT(*)` for each table where the estimate is
            // 0 (new tables that haven't been ANALYZE'd yet show 0 even when they
            // have rows).
            // System schemas (pg_catalog, information_schema) are excluded by
            // default — same convention as every other DB GUI (DBeaver,
            // pgAdmin, TablePlus). `include_system_schemas` opts back in.
            // (`pg_toast` still won't appear even then: Postgres itself never
            // grants regular users USAGE on that schema, so information_schema
            // hides it regardless of our own filter — a server-side
            // restriction this app can't override.)
            let schema_filter = if config.include_system_schemas.unwrap_or(false) {
                ""
            } else {
                "WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')"
            };
            let query = format!("
                SELECT
                    t.table_schema,
                    t.table_name,
                    t.table_type,
                    COALESCE(pg_total_relation_size(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name)), 0)::bigint AS size_bytes,
                    GREATEST(0, COALESCE(c_est.reltuples::bigint, 0)) AS row_count,
                    col.column_name,
                    col.data_type,
                    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
                    col.is_nullable,
                    col.column_default,
                    col.is_identity
                FROM information_schema.tables t
                LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
                LEFT JOIN pg_class c_est ON c_est.relnamespace = n.oid AND c_est.relname = t.table_name
                JOIN information_schema.columns col
                  ON t.table_schema = col.table_schema AND t.table_name = col.table_name
                LEFT JOIN (
                    SELECT ku.table_schema, ku.table_name, ku.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage ku
                      ON tc.constraint_name = ku.constraint_name AND ku.table_schema = ku.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                ) pk ON pk.table_schema = col.table_schema
                     AND pk.table_name = col.table_name
                     AND pk.column_name = col.column_name
                {}
                ORDER BY t.table_schema, t.table_name, col.ordinal_position;
            ", schema_filter);

            let rows = client.query(&query, &[]).await.map_err(|e| e.to_string())?;

            // Collect unique (schema, table) pairs where the reltuples estimate
            // is 0, so we can run an accurate COUNT(*) for just those tables.
            let mut tables_needing_real_count: Vec<(String, String)> = Vec::new();
            {
                use std::collections::HashSet;
                let mut seen: HashSet<(String, String)> = HashSet::new();
                for row in &rows {
                    let est: i64 = row.get(4);
                    if est == 0 {
                        let s: String = row.get(0);
                        let t: String = row.get(1);
                        if seen.insert((s.clone(), t.clone())) {
                            tables_needing_real_count.push((s, t));
                        }
                    }
                }
            }

            // Run accurate COUNT(*) for tables where the estimate was 0 — batched
            // into a single UNION ALL round trip instead of one query per table.
            // A never-ANALYZE'd database (common right after a fresh
            // import/migration) can have reltuples = 0 on *every* table, and
            // sequential per-table round trips are cheap on localhost but add up
            // fast over an SSH tunnel (each hop's forwarded round trip carries
            // real network latency) — dozens of tables could mean dozens of
            // seconds. UNION ALL doesn't guarantee row order, so each branch
            // tags its result with the table's index for a reliable lookup.
            let mut real_counts: std::collections::HashMap<(String, String), i64> = std::collections::HashMap::new();
            if !tables_needing_real_count.is_empty() {
                let count_sql = tables_needing_real_count
                    .iter()
                    .enumerate()
                    .map(|(idx, (schema, table))| {
                        format!(
                            "SELECT {}::int AS idx, COUNT(*) AS cnt FROM {}.{}",
                            idx,
                            quote_pg_ident(schema),
                            quote_pg_ident(table)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" UNION ALL ");
                if let Ok(count_rows) = client.query(count_sql.as_str(), &[]).await {
                    for count_row in &count_rows {
                        let idx: i32 = count_row.get(0);
                        let cnt: i64 = count_row.get(1);
                        if let Some((schema, table)) = tables_needing_real_count.get(idx as usize) {
                            real_counts.insert((schema.clone(), table.clone()), cnt);
                        }
                    }
                }
            }

            struct TableMeta {
                tbl_type: String,
                size_bytes: u64,
                row_count: u64,
                cols: Vec<SchemaNode>,
            }

            use std::collections::BTreeMap;
            let mut schema_map: BTreeMap<String, BTreeMap<String, TableMeta>> = BTreeMap::new();

            for row in rows {
                let schema_name: String = row.get(0);
                let table_name: String = row.get(1);
                let tbl_type: String = row.get(2);
                let size_bytes: i64 = row.get(3);
                let est_count: i64 = row.get(4);
                // Prefer the accurate COUNT(*) when we ran one (tables where the
                // reltuples estimate was 0); otherwise use the estimate.
                let row_count: i64 = real_counts
                    .get(&(schema_name.clone(), table_name.clone()))
                    .copied()
                    .unwrap_or(est_count);
                let col_name: String = row.get(5);
                let col_type: String = row.get(6);
                let is_pk: bool = row.get(7);
                let is_nullable_txt: String = row.get(8);
                let column_default: Option<String> = row.get(9);
                let is_identity_txt: String = row.get(10);

                let tables = schema_map.entry(schema_name).or_default();
                let entry = tables.entry(table_name).or_insert_with(|| TableMeta {
                    tbl_type: if tbl_type == "VIEW" { "view".to_string() } else { "table".to_string() },
                    size_bytes: size_bytes as u64,
                    row_count: row_count as u64,
                    cols: Vec::new(),
                });

                entry.cols.push(SchemaNode {
                    name: col_name,
                    node_type: "column".to_string(),
                    data_type: Some(col_type),
                    row_count: None,
                    size_bytes: None,
                    is_primary_key: Some(is_pk),
                    is_foreign_key: Some(false),
                    is_nullable: Some(is_nullable_txt.eq_ignore_ascii_case("YES")),
                    has_default: Some(column_default.is_some() || is_identity_txt.eq_ignore_ascii_case("YES")),
                    children: vec![],
                });
            }

            let mut result_schemas = Vec::new();
            for (sch_name, tables) in schema_map {
                let mut table_nodes = Vec::new();
                for (tbl_name, meta) in tables {
                    table_nodes.push(SchemaNode {
                        name: tbl_name,
                        node_type: meta.tbl_type,
                        data_type: None,
                        row_count: Some(meta.row_count),
                        size_bytes: Some(meta.size_bytes),
                        is_primary_key: None,
                        is_foreign_key: None,
                        is_nullable: None,
                        has_default: None,
                        children: meta.cols,
                    });
                }
                result_schemas.push(SchemaNode {
                    name: sch_name,
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
        super::engine::EngineFamily::Mysql => {
            let host = normalize_host(config.host.clone());
            let port = config.port.or_else(|| super::engine::default_port(&engine)).unwrap_or(3306);
            let (host, port) = super::ssh_tunnel::resolve_target(&config, host, port).await?;
            let user = config.username.unwrap_or_else(|| "root".to_string());
            // A database is just an optional starting point, not a requirement —
            // a user (root especially) can see and browse every database they
            // have privileges on, exactly like HeidiSQL/phpMyAdmin do. Only scope
            // the query down when one was explicitly picked.
            let db = config.database.filter(|d| !d.is_empty());
            let pass = config.password.unwrap_or_default();

            let opts = mysql_opts(host.clone(), port, user, pass, db.clone());
            let pool = mysql_async::Pool::new(opts);
            let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => {
                    return Err(format!(
                        "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
                        CONNECT_TIMEOUT.as_secs(), host, port
                    ))
                }
            };

            struct TableMeta {
                tbl_type: String,
                row_count: u64,
                size_bytes: u64,
                cols: Vec<SchemaNode>,
            }

            fn push_mysql_column(
                tables: &mut std::collections::BTreeMap<String, TableMeta>,
                table_name: String,
                table_type: String,
                row_count: u64,
                size_bytes: u64,
                col_name: String,
                data_type: String,
                column_key: String,
                is_nullable_txt: String,
                column_default: Option<String>,
                extra: String,
            ) {
                let entry = tables.entry(table_name).or_insert_with(|| TableMeta {
                    tbl_type: if table_type == "VIEW" { "view".to_string() } else { "table".to_string() },
                    row_count,
                    size_bytes,
                    cols: Vec::new(),
                });
                let extra_lower = extra.to_lowercase();
                entry.cols.push(SchemaNode {
                    name: col_name,
                    node_type: "column".to_string(),
                    data_type: Some(data_type),
                    row_count: None,
                    size_bytes: None,
                    is_primary_key: Some(column_key == "PRI"),
                    // MySQL requires an index on FK columns, so COLUMN_KEY = 'MUL' is a
                    // reasonable (best-effort) signal that a column is a foreign key.
                    is_foreign_key: Some(column_key == "MUL"),
                    is_nullable: Some(is_nullable_txt.eq_ignore_ascii_case("YES")),
                    has_default: Some(column_default.is_some() || extra_lower.contains("auto_increment")),
                    children: vec![],
                });
            }

            use std::collections::BTreeMap;
            let mut schemas: BTreeMap<String, BTreeMap<String, TableMeta>> = BTreeMap::new();

            // When a `scope_database` is set (the Compare & Sync tool targets a
            // specific database), restrict the tree to that one database only.
            // Otherwise — the default Explorer behavior — list every database the
            // connected user can see, exactly like HeidiSQL/phpMyAdmin/TablePlus.
            let scope = config.scope_database.as_deref().filter(|d| !d.is_empty());

            // Seed databases up front, from SCHEMATA rather than the COLUMNS/TABLES
            // join below — a brand-new, empty database (e.g. one just created) has
            // no rows in COLUMNS at all, so without this it would silently vanish
            // from the tree instead of showing up as an empty group.
            let schema_names: Vec<String> = if let Some(db) = scope {
                conn.exec(
                    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                     WHERE SCHEMA_NAME = ? \
                     ORDER BY SCHEMA_NAME",
                    (db,),
                )
                .await
                .map_err(|e| e.to_string())?
            } else if config.include_system_schemas.unwrap_or(false) {
                conn.query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
                    .await
                    .map_err(|e| e.to_string())?
            } else {
                conn.query(
                    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                     WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') \
                     ORDER BY SCHEMA_NAME",
                )
                .await
                .map_err(|e| e.to_string())?
            };
            for name in schema_names {
                schemas.entry(name).or_default();
            }

            // Build the COLUMNS/TABLES introspection query. When scoped, filter
            // to the single database; otherwise list every non-system database.
            let rows: Vec<(String, String, String, u64, u64, String, String, String, String, Option<String>, String)> = if let Some(db) = scope {
                conn.exec(
                    "SELECT \
                        c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, \
                        COALESCE(t.TABLE_ROWS, 0) AS row_count, \
                        COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0) AS size_bytes, \
                        c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_KEY, c.IS_NULLABLE, \
                        c.COLUMN_DEFAULT, c.EXTRA \
                     FROM information_schema.COLUMNS c \
                     JOIN information_schema.TABLES t \
                       ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                     WHERE c.TABLE_SCHEMA = ? \
                     ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
                    (db,),
                )
                .await
                .map_err(|e| e.to_string())?
            } else {
                let schema_filter = if config.include_system_schemas.unwrap_or(false) {
                    String::new()
                } else {
                    "WHERE c.TABLE_SCHEMA NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')".to_string()
                };
                conn.query(
                    format!(
                        "SELECT \
                        c.TABLE_SCHEMA, c.TABLE_NAME, t.TABLE_TYPE, \
                        COALESCE(t.TABLE_ROWS, 0) AS row_count, \
                        COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0) AS size_bytes, \
                        c.COLUMN_NAME, c.COLUMN_TYPE, c.COLUMN_KEY, c.IS_NULLABLE, \
                        c.COLUMN_DEFAULT, c.EXTRA \
                     FROM information_schema.COLUMNS c \
                     JOIN information_schema.TABLES t \
                       ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
                     {} \
                     ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION",
                        schema_filter
                    ),
                )
                .await
                .map_err(|e| e.to_string())?
            };

            for (schema_name, table_name, table_type, row_count, size_bytes, col_name, data_type, column_key, is_nullable_txt, column_default, extra) in rows {
                let tables = schemas.entry(schema_name).or_default();
                push_mysql_column(
                    tables, table_name, table_type, row_count, size_bytes, col_name, data_type, column_key,
                    is_nullable_txt, column_default, extra,
                );
            }

            // See `test_connection`: the pool can only shut down once `conn` is released.
            drop(conn);
            let _ = pool.disconnect().await;

            let mut result_schemas = Vec::new();
            for (schema_name, tables) in schemas {
                let table_nodes: Vec<SchemaNode> = tables
                    .into_iter()
                    .map(|(name, meta)| SchemaNode {
                        name,
                        node_type: meta.tbl_type,
                        data_type: None,
                        row_count: Some(meta.row_count),
                        size_bytes: Some(meta.size_bytes),
                        is_primary_key: None,
                        is_foreign_key: None,
                        is_nullable: None,
                        has_default: None,
                        children: meta.cols,
                    })
                    .collect();

                result_schemas.push(SchemaNode {
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

            Ok(result_schemas)
        }
        // DuckDB is short-circuited above (`fetch_duckdb_schema`).
        super::engine::EngineFamily::Duckdb => Ok(vec![]),
        // SQL Server is short-circuited above (`fetch_mssql_schema`).
        super::engine::EngineFamily::Mssql => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn fetch_schema_tree(config: ConnectionConfig) -> Result<Vec<SchemaNode>, String> {
    fetch_schema_tree_impl(config).await
}
