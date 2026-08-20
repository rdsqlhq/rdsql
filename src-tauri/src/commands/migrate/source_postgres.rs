//! PostgreSQL as a migration source: schema introspection and row reading
//! into the canonical representation (`super::canonical`).
//!
//! Every column is selected with an explicit `::text` cast (see
//! `select_sql`) rather than relying on `tokio_postgres`'s typed `FromSql`
//! decoding. This sidesteps needing a `rust_decimal`/`bigdecimal` dependency
//! just to read `NUMERIC` (and separate special-casing for arrays, UUIDs,
//! `json`/`jsonb`, and enum types) — Postgres's own per-type text output
//! function already renders every value correctly, and that text is valid
//! input on every target this app writes to. Only booleans (and, for
//! consistency, the plain integer/float types) are parsed back out of that
//! text into a properly-typed `CanonicalValue`; a boolean rendered as the
//! literal string `"t"` would silently corrupt a MySQL `TINYINT(1)` target
//! column (MySQL coerces a non-numeric string to `0`).

use tokio_postgres::NoTls;

use super::canonical::{CanonicalColumn, CanonicalType, CanonicalValue, ConversionNote, TableRef};
use crate::commands::connection::{normalize_host, ConnectionConfig};
use crate::commands::error::{from_postgres, DbError, ErrorKind};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn table_ident(schema: Option<&str>, table: &str) -> String {
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
            eprintln!("PostgreSQL connection error (migration source): {}", e);
        }
    });
    Ok((client, task))
}

fn map_native_type(
    name: &str,
    data_type: &str,
    udt_name: &str,
    char_max_len: Option<i32>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
    enum_values: &[String],
) -> (CanonicalType, Option<String>) {
    let dt = data_type.to_lowercase();
    match dt.as_str() {
        "boolean" => (CanonicalType::Bool, None),
        "smallint" => (CanonicalType::Int16, None),
        "integer" => (CanonicalType::Int32, None),
        "bigint" => (CanonicalType::Int64, None),
        "numeric" | "decimal" => (
            CanonicalType::Numeric { precision: numeric_precision.unwrap_or(20).max(1) as u32, scale: numeric_scale.unwrap_or(0).max(0) as u32 },
            None,
        ),
        "real" => (CanonicalType::Float32, None),
        "double precision" => (CanonicalType::Float64, None),
        "character varying" => (CanonicalType::VarChar(char_max_len.filter(|&n| n > 0).unwrap_or(255) as u32), None),
        "character" => (CanonicalType::Char(char_max_len.filter(|&n| n > 0).unwrap_or(255) as u32), None),
        "text" | "citext" => (CanonicalType::Text, None),
        "bytea" => (CanonicalType::Bytes, None),
        "date" => (CanonicalType::Date, None),
        "time without time zone" | "time with time zone" => (CanonicalType::Time, None),
        "timestamp without time zone" => (CanonicalType::Timestamp, None),
        "timestamp with time zone" => (
            CanonicalType::Timestamp,
            Some(format!("`{}` is TIMESTAMPTZ — converted to UTC; the target has no timezone-aware type.", name)),
        ),
        "json" | "jsonb" => (CanonicalType::Json, None),
        "uuid" => (CanonicalType::Uuid, None),
        "array" => (CanonicalType::TextArray, None),
        "user-defined" => {
            if !enum_values.is_empty() {
                (CanonicalType::Enum(enum_values.to_vec()), None)
            } else {
                (
                    CanonicalType::Unknown(udt_name.to_string()),
                    Some(format!("`{}` has a user-defined type (`{}`) that isn't an enum — defaulting to TEXT.", name, udt_name)),
                )
            }
        }
        other => (
            CanonicalType::Unknown(other.to_string()),
            Some(format!("`{}` has unrecognized Postgres type `{}` — defaulting to TEXT.", name, other)),
        ),
    }
}

/// Read one table's columns, including primary key and identity-column
/// (`GENERATED ... AS IDENTITY` / `serial`-backed) flags, and enum member
/// lists for any `USER-DEFINED` column backed by a native enum type.
pub async fn fetch_columns(config: &ConnectionConfig, t: &TableRef) -> Result<Vec<CanonicalColumn>, String> {
    let (client, task) = connect(config).await?;
    let schema = t.schema.clone().unwrap_or_else(|| "public".to_string());

    let col_sql = "SELECT column_name, data_type, udt_name, character_maximum_length, \
                          numeric_precision, numeric_scale, is_nullable, is_identity \
                   FROM information_schema.columns \
                   WHERE table_name = $1 AND table_schema = $2 \
                   ORDER BY ordinal_position";
    let rows = client
        .query(col_sql, &[&t.table, &schema])
        .await
        .map_err(|e| from_postgres(e, Some(col_sql)).to_json_string())?;

    let pk_sql = "SELECT kcu.column_name FROM information_schema.table_constraints tc \
                  JOIN information_schema.key_column_usage kcu \
                    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
                  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2";
    let pk_rows = client
        .query(pk_sql, &[&schema, &t.table])
        .await
        .map_err(|e| from_postgres(e, Some(pk_sql)).to_json_string())?;
    let pk_cols: std::collections::HashSet<String> = pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let name: String = row.get(0);
        let data_type: String = row.get(1);
        let udt_name: String = row.get(2);
        let char_max_len: Option<i32> = row.get(3);
        let numeric_precision: Option<i32> = row.get(4);
        let numeric_scale: Option<i32> = row.get(5);
        let is_nullable: String = row.get(6);
        let is_identity: String = row.get(7);

        let enum_values = if data_type.eq_ignore_ascii_case("USER-DEFINED") {
            fetch_enum_values(&client, &udt_name).await
        } else {
            Vec::new()
        };

        let (ty, warning) = map_native_type(&name, &data_type, &udt_name, char_max_len, numeric_precision, numeric_scale, &enum_values);

        out.push(CanonicalColumn {
            name: name.clone(),
            ty,
            native_type: if data_type.eq_ignore_ascii_case("ARRAY") { format!("{}[]", udt_name.trim_start_matches('_')) } else { udt_name },
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            is_primary_key: pk_cols.contains(&name),
            is_auto_increment: is_identity.eq_ignore_ascii_case("YES"),
            warning,
        });
    }

    drop(client);
    task.abort();
    Ok(out)
}

async fn fetch_enum_values(client: &tokio_postgres::Client, udt_name: &str) -> Vec<String> {
    let sql = "SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder";
    client
        .query(sql, &[&udt_name])
        .await
        .map(|rows| rows.iter().map(|r| r.get::<_, String>(0)).collect())
        .unwrap_or_default()
}

pub async fn fetch_row_estimate(config: &ConnectionConfig, t: &TableRef) -> Option<u64> {
    let (client, task) = connect(config).await.ok()?;
    let schema = t.schema.clone().unwrap_or_else(|| "public".to_string());
    let sql = "SELECT reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $1 AND c.relname = $2";
    let row = client.query_opt(sql, &[&schema, &t.table]).await.ok()??;
    let estimate: i64 = row.get(0);
    drop(client);
    task.abort();
    Some(estimate.max(0) as u64)
}

/// Build a `SELECT` that casts every column to `::text` (see module doc),
/// aliased back to its original name for the row-conversion pass.
pub fn select_sql(t: &TableRef, columns: &[String]) -> String {
    let cols = columns
        .iter()
        .map(|c| format!("{}::text AS {}", quote_ident(c), quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("SELECT {} FROM {}", cols, table_ident(t.schema.as_deref(), &t.table))
}

/// Parse one already-`::text`-cast cell into its canonical value.
pub fn postgres_text_to_canonical(text: Option<&str>, ty: &CanonicalType) -> (CanonicalValue, Option<ConversionNote>) {
    let s = match text {
        None => return (CanonicalValue::Null, None),
        Some(s) => s,
    };
    match ty {
        CanonicalType::Bool => (CanonicalValue::Bool(s == "t" || s.eq_ignore_ascii_case("true")), None),
        CanonicalType::Int16 | CanonicalType::Int32 | CanonicalType::Int64 => match s.parse::<i64>() {
            Ok(n) => (CanonicalValue::I64(n), None),
            Err(_) => (CanonicalValue::Text(s.to_string()), None),
        },
        CanonicalType::Float32 | CanonicalType::Float64 => match s.parse::<f64>() {
            Ok(f) => (CanonicalValue::F64(f), None),
            Err(_) => (CanonicalValue::Text(s.to_string()), None),
        },
        CanonicalType::Bytes => (CanonicalValue::Bytes(parse_pg_bytea_hex(s)), None),
        CanonicalType::TextArray => (CanonicalValue::TextArray(parse_pg_array_literal(s)), None),
        CanonicalType::Json => (CanonicalValue::Json(s.to_string()), None),
        // Numeric/Text/Char/VarChar/Date/Time/Timestamp/Uuid/Enum/Unknown:
        // Postgres's text output for all of these is already valid input
        // text on every target this app writes to.
        _ => (CanonicalValue::Text(s.to_string()), None),
    }
}

/// Decode Postgres's `bytea::text` hex format (`\xdeadbeef`, the default
/// `bytea_output` since Postgres 9.0) back into raw bytes.
fn parse_pg_bytea_hex(s: &str) -> Vec<u8> {
    let hex = s.strip_prefix("\\x").unwrap_or(s);
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i + 2 <= bytes.len() {
        if let Ok(b) = u8::from_str_radix(&hex[i..i + 2], 16) {
            out.push(b);
        }
        i += 2;
    }
    out
}

/// Parse a Postgres array-literal text (`{a,"b,c",NULL}`) into its element
/// strings. Handles quoted elements (with `\"`/`\\` escapes) and the
/// unquoted `NULL` marker; nested arrays are not supported and fall back to
/// treating the nested `{...}` as one opaque element (acceptable — 1-D
/// arrays of scalars are the overwhelmingly common case this tool targets).
fn parse_pg_array_literal(s: &str) -> Vec<String> {
    let inner = s.trim().strip_prefix('{').and_then(|s| s.strip_suffix('}')).unwrap_or(s.trim());
    if inner.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if !in_quotes => in_quotes = true,
            '"' if in_quotes => in_quotes = false,
            '\\' if in_quotes => {
                if let Some(&next) = chars.peek() {
                    current.push(next);
                    chars.next();
                }
            }
            ',' if !in_quotes => {
                out.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    out.push(current);
    out.into_iter()
        .map(|s| if s == "NULL" { String::new() } else { s })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_carries_precision_and_scale() {
        let (ty, _) = map_native_type("price", "numeric", "numeric", None, Some(10), Some(2), &[]);
        assert_eq!(ty, CanonicalType::Numeric { precision: 10, scale: 2 });
    }

    #[test]
    fn user_defined_enum_type_carries_its_values() {
        let (ty, warning) = map_native_type("status", "USER-DEFINED", "status_enum", None, None, None, &["a".to_string(), "b".to_string()]);
        assert_eq!(ty, CanonicalType::Enum(vec!["a".to_string(), "b".to_string()]));
        assert!(warning.is_none());
    }

    #[test]
    fn timestamptz_warns_about_dropped_timezone() {
        let (ty, warning) = map_native_type("created_at", "timestamp with time zone", "timestamptz", None, None, None, &[]);
        assert_eq!(ty, CanonicalType::Timestamp);
        assert!(warning.is_some());
    }

    #[test]
    fn bool_text_parses_t_and_f() {
        let (v, _) = postgres_text_to_canonical(Some("t"), &CanonicalType::Bool);
        assert_eq!(v, CanonicalValue::Bool(true));
        let (v, _) = postgres_text_to_canonical(Some("f"), &CanonicalType::Bool);
        assert_eq!(v, CanonicalValue::Bool(false));
    }

    #[test]
    fn null_text_becomes_canonical_null() {
        let (v, note) = postgres_text_to_canonical(None, &CanonicalType::Int32);
        assert_eq!(v, CanonicalValue::Null);
        assert_eq!(note, None);
    }

    #[test]
    fn bytea_hex_text_decodes_to_raw_bytes() {
        let (v, _) = postgres_text_to_canonical(Some("\\xdead"), &CanonicalType::Bytes);
        assert_eq!(v, CanonicalValue::Bytes(vec![0xDE, 0xAD]));
    }

    #[test]
    fn array_literal_parses_quoted_and_plain_elements() {
        assert_eq!(parse_pg_array_literal("{a,b}"), vec!["a".to_string(), "b".to_string()]);
        assert_eq!(parse_pg_array_literal("{\"a,b\",c}"), vec!["a,b".to_string(), "c".to_string()]);
    }
}
