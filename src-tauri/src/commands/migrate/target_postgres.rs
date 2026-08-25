//! PostgreSQL as a migration target: DDL generation from the canonical
//! schema and a `COPY ... FROM STDIN` (text format) bulk writer.
//!
//! Text format (not binary) trades a little throughput for a lot of
//! correctness: every value's Postgres text representation is parsed by
//! Postgres's own per-type input function instead of us hand-rolling the
//! wire binary encoding for numeric/date/array/jsonb. `COPY` is
//! all-or-nothing — a failed or cancelled table is left with zero rows, so
//! it's always safe to retry from scratch.
//!
//! `PRIMARY KEY`/sequence creation is deferred until *after* the data load
//! (`build_post_load_sql`) — index/constraint maintenance during a
//! streamed bulk load is the dominant cost on large tables, the same
//! reason `pg_restore` builds indexes after loading data, not before.

use tokio_postgres::NoTls;

use super::canonical::{CanonicalColumn, CanonicalType, CanonicalValue};
use crate::commands::connection::{normalize_host, ConnectionConfig};
use crate::commands::error::{from_postgres, DbError, ErrorKind};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn qualify_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(s), quote_ident(table)),
        _ => quote_ident(table),
    }
}

pub async fn connect(config: &ConnectionConfig) -> Result<(tokio_postgres::Client, tokio::task::JoinHandle<()>), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.or_else(|| crate::commands::engine::default_port(&config.engine)).unwrap_or(5432);
    let (host, port) = crate::commands::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
    let db = config
        .scope_database
        .clone()
        .filter(|d| !d.is_empty())
        .or_else(|| config.database.clone())
        .unwrap_or_else(|| "postgres".to_string());
    let pass = config.password.clone().unwrap_or_default();

    let conn_str = format!("host={} port={} user={} dbname={} password={}", host, port, user, db, pass);
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
            .to_json_string())
        }
    };
    let task = tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error (migration target): {}", e);
        }
    });
    Ok((client, task))
}

pub async fn fetch_existing_columns(client: &tokio_postgres::Client, schema: Option<&str>, table: &str) -> Result<Vec<String>, String> {
    let sql = "SELECT column_name FROM information_schema.columns \
               WHERE table_name = $1 AND table_schema = COALESCE($2, 'public') \
               ORDER BY ordinal_position";
    let schema_owned = schema.map(|s| s.to_string());
    let rows = client
        .query(sql, &[&table, &schema_owned])
        .await
        .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

/// Canonical type → Postgres DDL type, plus an optional `CHECK` clause
/// (used for `Enum` — see the module-level plan doc for why this app emits
/// `text + CHECK` rather than a native Postgres enum type).
pub fn canonical_to_postgres_type(col: &CanonicalColumn) -> (String, Option<String>) {
    match &col.ty {
        CanonicalType::Bool => ("boolean".to_string(), None),
        CanonicalType::Int16 => ("smallint".to_string(), None),
        CanonicalType::Int32 => ("integer".to_string(), None),
        CanonicalType::Int64 => ("bigint".to_string(), None),
        CanonicalType::Numeric { precision, scale } => (format!("numeric({},{})", precision, scale), None),
        CanonicalType::Float32 => ("real".to_string(), None),
        CanonicalType::Float64 => ("double precision".to_string(), None),
        CanonicalType::VarChar(n) => (format!("varchar({})", n), None),
        CanonicalType::Char(n) => (format!("char({})", n), None),
        CanonicalType::Text => ("text".to_string(), None),
        CanonicalType::Bytes => ("bytea".to_string(), None),
        CanonicalType::Date => ("date".to_string(), None),
        CanonicalType::Time => ("time".to_string(), None),
        CanonicalType::Timestamp => ("timestamp".to_string(), None),
        CanonicalType::Json => ("jsonb".to_string(), None),
        CanonicalType::Uuid => ("uuid".to_string(), None),
        CanonicalType::Enum(values) => {
            let list = values.iter().map(|v| format!("'{}'", v.replace('\'', "''"))).collect::<Vec<_>>().join(", ");
            ("text".to_string(), Some(format!("{} IN ({})", quote_ident(&col.name), list)))
        }
        CanonicalType::TextArray => ("text[]".to_string(), None),
        CanonicalType::Unknown(_) => ("text".to_string(), None),
    }
}

pub fn build_create_table_sql(schema: Option<&str>, table: &str, columns: &[CanonicalColumn]) -> String {
    let qualified = qualify_table(schema, table);
    let lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let (ty, check) = canonical_to_postgres_type(c);
            let mut parts = vec![quote_ident(&c.name), ty];
            if !c.nullable {
                parts.push("NOT NULL".to_string());
            }
            if let Some(check) = check {
                parts.push(format!("CHECK ({})", check));
            }
            format!("  {}", parts.join(" "))
        })
        .collect();
    format!("CREATE TABLE IF NOT EXISTS {} (\n{}\n);", qualified, lines.join(",\n"))
}

pub fn build_post_load_sql(schema: Option<&str>, table: &str, columns: &[CanonicalColumn]) -> Vec<String> {
    let qualified = qualify_table(schema, table);
    let mut stmts = Vec::new();

    let pk_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| c.is_primary_key).collect();
    if !pk_cols.is_empty() {
        let cols = pk_cols.iter().map(|c| quote_ident(&c.name)).collect::<Vec<_>>().join(", ");
        stmts.push(format!("ALTER TABLE {} ADD PRIMARY KEY ({});", qualified, cols));
    }

    for c in columns.iter().filter(|c| c.is_auto_increment) {
        let seq_name = format!("{}_{}_seq", table, c.name);
        let qseq = quote_ident(&seq_name);
        let qcol = quote_ident(&c.name);
        stmts.push(format!("CREATE SEQUENCE IF NOT EXISTS {};", qseq));
        stmts.push(format!("SELECT setval('{}', COALESCE((SELECT MAX({}) FROM {}), 1));", seq_name, qcol, qualified));
        stmts.push(format!("ALTER TABLE {} ALTER COLUMN {} SET DEFAULT nextval('{}');", qualified, qcol, seq_name));
        stmts.push(format!("ALTER SEQUENCE {} OWNED BY {}.{};", qseq, qualified, qcol));
    }

    stmts.push(format!("ANALYZE {};", qualified));
    stmts
}

/// Escape one field's logical text for the `COPY ... FROM STDIN` text
/// format: backslash, tab, newline, and carriage return are the only bytes
/// that format treats specially. Values whose logical text already
/// contains a backslash (e.g. bytea's `\xdeadbeef` hex form) rely on this
/// running *after* rendering — doubling that backslash so Postgres's COPY
/// parser restores the original text before handing it to the column's
/// type input function.
pub fn escape_copy_field(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    for &b in raw {
        match b {
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            _ => out.push(b),
        }
    }
    out
}

fn bytea_hex(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + bytes.len() * 2);
    out.extend_from_slice(b"\\x");
    for b in bytes {
        out.extend_from_slice(format!("{:02x}", b).as_bytes());
    }
    out
}

fn pg_array_literal(items: &[String]) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(b'{');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.push(b'"');
        for ch in item.chars() {
            if ch == '"' || ch == '\\' {
                out.push(b'\\');
            }
            let mut buf = [0u8; 4];
            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        }
        out.push(b'"');
    }
    out.push(b'}');
    out
}

/// Render one canonical value as its logical `COPY` text-format field
/// (still needs `escape_copy_field` applied before writing to the stream).
/// `None` means SQL NULL — written as the literal `\N` marker by the caller.
pub fn canonical_value_to_pg_text(value: &CanonicalValue) -> Option<Vec<u8>> {
    match value {
        CanonicalValue::Null => None,
        CanonicalValue::Bool(b) => Some(if *b { b"t".to_vec() } else { b"f".to_vec() }),
        CanonicalValue::I64(i) => Some(i.to_string().into_bytes()),
        CanonicalValue::U64(u) => Some(u.to_string().into_bytes()),
        CanonicalValue::F64(f) => Some(f.to_string().into_bytes()),
        CanonicalValue::Text(s) => Some(s.clone().into_bytes()),
        CanonicalValue::Bytes(b) => Some(bytea_hex(b)),
        CanonicalValue::Json(s) => Some(s.clone().into_bytes()),
        CanonicalValue::TextArray(items) => Some(pg_array_literal(items)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_becomes_text_with_check() {
        let col = CanonicalColumn {
            name: "status".to_string(),
            ty: CanonicalType::Enum(vec!["a".to_string(), "b".to_string()]),
            native_type: "enum('a','b')".to_string(),
            nullable: true,
            is_primary_key: false,
            is_auto_increment: false,
            warning: None,
        };
        let (ty, check) = canonical_to_postgres_type(&col);
        assert_eq!(ty, "text");
        assert!(check.unwrap().contains("'a', 'b'"));
    }

    #[test]
    fn bytea_renders_as_hex() {
        assert_eq!(canonical_value_to_pg_text(&CanonicalValue::Bytes(vec![0xDE, 0xAD])), Some(b"\\xdead".to_vec()));
    }

    #[test]
    fn text_array_renders_as_array_literal() {
        assert_eq!(
            canonical_value_to_pg_text(&CanonicalValue::TextArray(vec!["a".to_string(), "b".to_string()])),
            Some(b"{\"a\",\"b\"}".to_vec())
        );
    }

    #[test]
    fn escapes_backslash_tab_newline() {
        assert_eq!(escape_copy_field(b"a\\b\tc"), b"a\\\\b\\tc".to_vec());
    }
}
