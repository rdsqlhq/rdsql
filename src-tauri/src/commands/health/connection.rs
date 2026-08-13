//! Per-engine connection helpers for the health module.
//!
//! RDSQL has no connection pool — `commands::query` and `commands::connection`
//! each re-open a connection per call. Rather than paste those ~30 lines of
//! connect logic into every diagnostics/repair/metrics function, this module
//! exposes thin `connect_*` helpers returning the driver's client. Each helper
//! applies the same IPv4-localhost normalization and 8s connect timeout used
//! elsewhere in the app so behavior stays consistent.

use std::time::Duration;
use tokio_postgres::NoTls;

use super::super::connection::{normalize_host, ConnectionConfig};
use super::super::error::{from_duckdb, from_mysql, from_postgres, from_sqlite, DbError, ErrorKind};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// A Postgres client. The connection task is spawned here exactly like
/// `commands::query::run_query` does it.
pub async fn connect_postgres(config: &ConnectionConfig) -> Result<tokio_postgres::Client, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(5432);
    let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
    let db = config.database.clone().unwrap_or_else(|| "postgres".to_string());
    let pass = config.password.clone().unwrap_or_default();

    let conn_str = format!(
        "host={} port={} user={} dbname={} password={}",
        host, port, user, db, pass
    );

    let (client, connection) = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_postgres::connect(&conn_str, NoTls)).await {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let mut d = from_postgres(e, None);
            d.kind = ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => {
            return Err(DbError::connection(format!(
                "PostgreSQL connection timed out after {}s — check that the server is running on {}:{}",
                CONNECT_TIMEOUT.as_secs(), host, port
            ))
            .to_json_string());
        }
    };

    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    Ok(client)
}

/// A MySQL/MariaDB connection. Caller is responsible for dropping the conn
/// before disconnecting the pool (same pattern as `commands::query`).
pub async fn connect_mysql(
    config: &ConnectionConfig,
) -> Result<(mysql_async::Pool, mysql_async::Conn), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.database.clone().filter(|d| !d.is_empty());
    let pass = config.password.clone().unwrap_or_default();

    let opts: mysql_async::Opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname(host.clone())
        .tcp_port(port)
        .user(Some(user))
        .pass(Some(pass))
        .db_name(db)
        .into();
    let pool = mysql_async::Pool::new(opts);

    let conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            let mut d: DbError = from_mysql(e, None).into();
            d.kind = ErrorKind::Connection;
            let _ = pool.disconnect().await;
            return Err(d.to_json_string());
        }
        Err(_) => {
            let _ = pool.disconnect().await;
            return Err(DbError::connection(format!(
                "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
                CONNECT_TIMEOUT.as_secs(), host, port
            ))
            .to_json_string());
        }
    };

    Ok((pool, conn))
}

/// A SQLite connection (rusqlite). The health commands open read-only where
/// possible to avoid surprising writes during diagnostics.
pub fn open_sqlite(config: &ConnectionConfig) -> Result<rusqlite::Connection, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err(DbError::app("SQLite database file path is required. Set a database file in the connection.").to_json_string());
    }
    // Open read-only for diagnostics; the repair layer re-opens read-write.
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    rusqlite::Connection::open_with_flags(&path, flags).map_err(|e| from_sqlite(e, None).to_json_string())
}

/// Open SQLite read-write (for repair execution).
pub fn open_sqlite_rw(config: &ConnectionConfig) -> Result<rusqlite::Connection, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err(DbError::app("SQLite database file path is required. Set a database file in the connection.").to_json_string());
    }
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE | rusqlite::OpenFlags::SQLITE_OPEN_URI;
    rusqlite::Connection::open_with_flags(&path, flags).map_err(|e| from_sqlite(e, None).to_json_string())
}

/// A DuckDB connection (read-only for diagnostics). The repair layer re-opens
/// read-write via `open_duckdb_rw`.
pub fn open_duckdb(config: &ConnectionConfig) -> Result<duckdb::Connection, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err(DbError::app("DuckDB file path is empty. Set a database file in the connection.").to_json_string());
    }
    let cfg = duckdb::Config::default()
        .access_mode(duckdb::AccessMode::ReadOnly)
        .map_err(|e| from_duckdb(e, None).to_json_string())?;
    duckdb::Connection::open_with_flags(&path, cfg).map_err(|e| from_duckdb(e, None).to_json_string())
}

/// Open DuckDB read-write (for repair execution).
pub fn open_duckdb_rw(config: &ConnectionConfig) -> Result<duckdb::Connection, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err(DbError::app("DuckDB file path is empty. Set a database file in the connection.").to_json_string());
    }
    duckdb::Connection::open(&path).map_err(|e| from_duckdb(e, None).to_json_string())
}

/// Lowercased, normalized engine name.
pub fn engine_key(config: &ConnectionConfig) -> String {
    config.engine.to_lowercase()
}
