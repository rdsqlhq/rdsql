//! Structured, traceable error reporting for database operations.
//!
//! The default string errors returned by the SQL drivers are notoriously
//! terse — `tokio_postgres::Error` renders as "db error", `mysql_async` and
//! `rusqlite` collapse to a single line. That makes failures impossible to
//! diagnose from the UI. This module produces a structured, JSON-serialized
//! error that classifies *where* the failure happened (connecting to the
//! server vs. the server rejecting the statement vs. an app/IO fault) and
//! preserves the driver's full detail (SQLSTATE code, message, detail, hint).
//!
//! The frontend receives a JSON string (Tauri commands must return
//! `Result<T, String>`); it can either render it verbatim or parse it for a
//! richer layout.

use serde::Serialize;

/// Where a database operation failed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    /// Could not reach / authenticate to the server (network, auth, timeout).
    Connection,
    /// The server rejected the statement (syntax, permission, missing object…).
    Database,
    /// Something went wrong on our side (file IO, cancel, unsupported engine).
    App,
}

/// A structured, traceable error. Serialized to JSON and returned to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct DbError {
    pub kind: ErrorKind,
    /// One-line summary, e.g. "ERROR 42P01: relation \"x\" does not exist".
    pub message: String,
    /// Optional extended fields (DETAIL/HINT/position, server version, etc.).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Optional human hint (driver-provided suggestion).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// The SQL statement that triggered the error, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    /// SQLSTATE code (Postgres/MySQL), when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl DbError {
    pub fn connection(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Connection,
            message: message.into(),
            detail: None,
            hint: None,
            sql: None,
            code: None,
        }
    }

    pub fn app(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::App,
            message: message.into(),
            detail: None,
            hint: None,
            sql: None,
            code: None,
        }
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self {
            kind: ErrorKind::Database,
            message: message.into(),
            detail: None,
            hint: None,
            sql: None,
            code: None,
        }
    }

    pub fn with_sql(mut self, sql: impl Into<String>) -> Self {
        self.sql = Some(sql.into());
        self
    }

    /// Serialize to a JSON string for the Tauri command boundary. If
    /// serialization fails (it shouldn't for this simple struct), fall back to
    /// the message so we never lose the error entirely.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

/// Render a `tokio_postgres::Error` as a structured `DbError`, classifying
/// connection-time vs. query-time failures and extracting the underlying
/// `DbError`'s code/message/detail/hint when present.
///
/// `sql` is the statement that was running, for the trace.
pub fn from_postgres(err: tokio_postgres::Error, sql: Option<&str>) -> DbError {
    // Walk the error source chain for the DB-level error.
    let mut cur: Option<&dyn std::error::Error> = Some(&err);
    while let Some(e) = cur {
        if let Some(db) = e.downcast_ref::<tokio_postgres::error::DbError>() {
            let msg = db.message().trim();
            return DbError {
                kind: ErrorKind::Database,
                message: format!("ERROR {}: {}", db.code().code(), msg),
                detail: db.detail().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                hint: db.hint().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                sql: sql.map(|s| s.to_string()),
                code: Some(db.code().code().to_string()),
            };
        }
        cur = e.source();
    }
    // No DbError in the chain → connection / IO / auth failure.
    let msg = err.to_string();
    // Heuristic: the bare "db error" Display is useless; describe the category.
    let readable = if msg.trim().eq_ignore_ascii_case("db error") {
        "Could not complete the database operation (connection or IO failure).".to_string()
    } else {
        msg
    };
    DbError {
        kind: ErrorKind::Connection,
        message: readable,
        detail: None,
        hint: None,
        sql: sql.map(|s| s.to_string()),
        code: None,
    }
}

/// Render a `mysql_async::Error` as a structured `DbError`.
pub fn from_mysql(err: mysql_async::Error, sql: Option<&str>) -> DriverError {
    // mysql_async::Error::to_string() already includes the MySQL error code
    // and message (e.g. "ERROR 1046 (3D000): No database selected"), so we just
    // classify it: connection errors mention common IO/auth words, otherwise
    // treat it as a database (server-rejected) error.
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    let is_connection = lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("refused")
        || lower.contains("auth")
        || lower.contains("denied")
        || lower.contains("io error");
    // Try to pull a leading "ERROR nnnn (xxxxx):" code out of the message.
    let code = msg
        .split_whitespace()
        .nth(1)
        .filter(|t| t.chars().all(|c| c.is_ascii_digit()))
        .map(|n| format!("MYSQL_{}", n));

    DriverError(DbError {
        kind: if is_connection { ErrorKind::Connection } else { ErrorKind::Database },
        message: msg,
        detail: None,
        hint: None,
        sql: sql.map(|s| s.to_string()),
        code,
    })
}

/// Render a `rusqlite::Error` as a structured `DbError`.
pub fn from_sqlite(err: rusqlite::Error, sql: Option<&str>) -> DbError {
    // Only the low-level SqliteFailure carries a machine code; for everything
    // else fall back to the Display string but still classify sensibly.
    let (code, raw_msg) = match &err {
        rusqlite::Error::SqliteFailure(ffi_err, msg) => {
            let code = format!("SQLITE_{}", ffi_err.extended_code);
            let label = format!("{:?}", ffi_err.code);
            let m = msg.clone().unwrap_or(label);
            (Some(code), m)
        }
        other => (None, other.to_string()),
    };
    let lower = raw_msg.to_lowercase();
    let kind = if lower.contains("cannot open") || lower.contains("unable to open") {
        ErrorKind::Connection
    } else {
        ErrorKind::Database
    };
    DbError {
        kind,
        message: raw_msg,
        detail: None,
        hint: None,
        sql: sql.map(|s| s.to_string()),
        code,
    }
}

/// Render a `duckdb::Error` as a structured `DbError`. The `duckdb` crate's
/// error enum mirrors `rusqlite::Error` closely (DuckDBFailure, SqlInputError,
/// etc.), so the mapping follows the same shape as `from_sqlite`.
pub fn from_duckdb(err: duckdb::Error, sql: Option<&str>) -> DbError {
    let (code, raw_msg) = match &err {
        duckdb::Error::DuckDBFailure(ffi_err, msg) => {
            let code = format!("DUCKDB_{:?}", ffi_err.code);
            let m = msg.clone().unwrap_or_else(|| format!("{:?}", ffi_err.code));
            (Some(code), m)
        }
        other => (None, other.to_string()),
    };
    let lower = raw_msg.to_lowercase();
    let kind = if lower.contains("cannot open") || lower.contains("unable to open") {
        ErrorKind::Connection
    } else {
        ErrorKind::Database
    };
    DbError {
        kind,
        message: raw_msg,
        detail: None,
        hint: None,
        sql: sql.map(|s| s.to_string()),
        code,
    }
}

/// Render a `tiberius::error::Error` as a structured `DbError`. Unlike MySQL,
/// tiberius exposes a proper `Error::Server(TokenError)` variant carrying the
/// real SQL Server error number/severity/message — no string heuristics
/// needed, closer to `from_postgres`'s clean downcast.
pub fn from_tiberius(err: tiberius::error::Error, sql: Option<&str>) -> DbError {
    match &err {
        tiberius::error::Error::Server(token) => DbError {
            kind: ErrorKind::Database,
            message: format!("Msg {}, Level {}: {}", token.code(), token.class(), token.message()),
            detail: None,
            hint: None,
            sql: sql.map(|s| s.to_string()),
            code: Some(token.code().to_string()),
        },
        other => DbError {
            kind: ErrorKind::Connection,
            message: other.to_string(),
            detail: None,
            hint: None,
            sql: sql.map(|s| s.to_string()),
            code: None,
        },
    }
}

/// Thin wrapper so `from_mysql` can return by value while inferring the kind.
/// (mysql_async::Error isn't Clone in all versions, so we consume it.)
pub struct DriverError(pub DbError);
impl From<DriverError> for DbError {
    fn from(d: DriverError) -> Self {
        d.0
    }
}
