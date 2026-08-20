//! MySQL as a migration source: schema introspection and row streaming into
//! the canonical representation (`super::canonical`).

use mysql_async::prelude::*;

use super::canonical::{CanonicalColumn, CanonicalType, CanonicalValue, ConversionNote, TableRef};
use crate::commands::connection::{normalize_host, ConnectionConfig};
use crate::commands::error::{from_mysql, DbError, ErrorKind};

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub async fn connect(config: &ConnectionConfig) -> Result<(mysql_async::Conn, mysql_async::Pool), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.or_else(|| crate::commands::engine::default_port(&config.engine)).unwrap_or(3306);
    let (host, port) = crate::commands::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let pass = config.password.clone().unwrap_or_default();

    let opts = crate::commands::query::mysql_opts(host.clone(), port, user, pass, db);
    let pool = mysql_async::Pool::new(opts);
    match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => Ok((c, pool)),
        Ok(Err(e)) => {
            let mut d: DbError = from_mysql(e, None).into();
            d.kind = ErrorKind::Connection;
            Err(d.to_json_string())
        }
        Err(_) => Err(DbError::connection(format!(
            "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
            CONNECT_TIMEOUT.as_secs(), host, port
        ))
        .to_json_string()),
    }
}

pub fn table_ident(schema: Option<&str>, table: &str) -> String {
    let q = |s: &str| format!("`{}`", s.replace('`', "``"));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    }
}

/// Parsed shape of a MySQL `COLUMN_TYPE` string (e.g. `int(11) unsigned`,
/// `tinyint(1)`, `enum('a','b')`, `decimal(10,2)`).
struct MysqlColumnShape {
    base: String,
    unsigned: bool,
    length: Option<i64>,
    precision: Option<i64>,
    scale: Option<i64>,
    enum_values: Vec<String>,
}

fn parse_mysql_column_type(column_type: &str) -> MysqlColumnShape {
    let lower = column_type.trim().to_lowercase();
    let unsigned = lower.contains("unsigned");
    let stripped = lower.replace("unsigned", "").replace("zerofill", "");
    let stripped = stripped.trim();

    let (base, args) = match stripped.find('(') {
        Some(idx) => {
            let name = stripped[..idx].trim().to_string();
            let rest = &stripped[idx + 1..];
            let close = rest.rfind(')').unwrap_or(rest.len());
            (name, Some(rest[..close].to_string()))
        }
        None => (stripped.to_string(), None),
    };

    let mut shape = MysqlColumnShape { base, unsigned, length: None, precision: None, scale: None, enum_values: Vec::new() };

    if let Some(args) = args {
        if shape.base == "enum" || shape.base == "set" {
            shape.enum_values = split_quoted_list(&args);
        } else if let Some((p, s)) = args.split_once(',') {
            shape.precision = p.trim().parse().ok();
            shape.scale = s.trim().parse().ok();
        } else {
            shape.length = args.trim().parse().ok();
        }
    }

    shape
}

fn split_quoted_list(args: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = args.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if in_quotes && chars.peek() == Some(&'\'') {
                current.push('\'');
                chars.next();
                continue;
            }
            in_quotes = !in_quotes;
            continue;
        }
        if c == ',' && !in_quotes {
            values.push(std::mem::take(&mut current));
            continue;
        }
        current.push(c);
    }
    if !current.is_empty() || !values.is_empty() {
        values.push(current);
    }
    values
}

/// Map one MySQL column (raw `COLUMN_TYPE` string) to its canonical shape.
pub fn mysql_native_to_canonical(
    name: &str,
    column_type: &str,
    nullable: bool,
    is_primary_key: bool,
    is_auto_increment: bool,
) -> CanonicalColumn {
    let shape = parse_mysql_column_type(column_type);
    let mut warning = None;

    let ty = match shape.base.as_str() {
        "tinyint" if shape.length == Some(1) && !shape.unsigned => CanonicalType::Bool,
        "bit" if shape.length.unwrap_or(1) == 1 => CanonicalType::Bool,
        "bit" => {
            warning = Some(format!(
                "`{}` is BIT({}) — stored as raw bytes rather than a native bit type.",
                name, shape.length.unwrap_or(1)
            ));
            CanonicalType::Bytes
        }
        "tinyint" => CanonicalType::Int16,
        "smallint" | "year" => {
            if shape.unsigned { CanonicalType::Int32 } else { CanonicalType::Int16 }
        }
        "int" | "integer" | "mediumint" => {
            if shape.unsigned { CanonicalType::Int64 } else { CanonicalType::Int32 }
        }
        "bigint" => {
            if shape.unsigned {
                warning = Some(format!(
                    "`{}` is BIGINT UNSIGNED — widened to NUMERIC(20,0); no 64-bit target type can hold its full range.",
                    name
                ));
                CanonicalType::Numeric { precision: 20, scale: 0 }
            } else {
                CanonicalType::Int64
            }
        }
        "decimal" | "numeric" | "dec" | "fixed" => CanonicalType::Numeric {
            precision: shape.precision.unwrap_or(10) as u32,
            scale: shape.scale.unwrap_or(0) as u32,
        },
        "float" => CanonicalType::Float32,
        "double" | "double precision" | "real" => CanonicalType::Float64,
        "varchar" => CanonicalType::VarChar(shape.length.unwrap_or(255) as u32),
        "char" => CanonicalType::Char(shape.length.unwrap_or(255) as u32),
        "text" | "tinytext" | "mediumtext" | "longtext" => CanonicalType::Text,
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" => CanonicalType::Bytes,
        "date" => CanonicalType::Date,
        "time" => CanonicalType::Time,
        "datetime" | "timestamp" => CanonicalType::Timestamp,
        "enum" => CanonicalType::Enum(shape.enum_values.clone()),
        "set" => CanonicalType::TextArray,
        "json" => CanonicalType::Json,
        other => {
            warning = Some(format!("`{}` has unrecognized MySQL type `{}` — defaulting to TEXT.", name, other));
            CanonicalType::Unknown(other.to_string())
        }
    };

    CanonicalColumn {
        name: name.to_string(),
        ty,
        native_type: column_type.to_string(),
        nullable,
        is_primary_key,
        is_auto_increment,
        warning,
    }
}

/// Read a MySQL table's columns from `information_schema`, including
/// `EXTRA` (for auto-increment detection — the shared schema tree elsewhere
/// in this app folds that into a generic `has_default` flag).
pub async fn fetch_columns(config: &ConnectionConfig, t: &TableRef) -> Result<Vec<CanonicalColumn>, String> {
    let (mut conn, pool) = connect(config).await?;
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let schema_filter = t.schema.clone().or(db);

    let sql = "SELECT c.COLUMN_NAME, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY, c.EXTRA \
               FROM information_schema.COLUMNS c \
               WHERE c.TABLE_NAME = ? \
                 AND COALESCE(c.TABLE_SCHEMA, DATABASE()) = COALESCE(?, DATABASE()) \
               ORDER BY c.ORDINAL_POSITION";
    let rows: Vec<(String, String, String, String, String)> = conn
        .exec(sql, (t.table.clone(), schema_filter))
        .await
        .map_err(|e| from_mysql(e, Some(sql)).0.to_json_string())?;

    drop(conn);
    let _ = pool.disconnect().await;

    Ok(rows
        .into_iter()
        .map(|(name, column_type, is_nullable, column_key, extra)| {
            mysql_native_to_canonical(
                &name,
                &column_type,
                is_nullable.eq_ignore_ascii_case("YES"),
                column_key == "PRI",
                extra.to_lowercase().contains("auto_increment"),
            )
        })
        .collect())
}

pub async fn fetch_row_estimate(config: &ConnectionConfig, t: &TableRef) -> Option<u64> {
    let (mut conn, pool) = connect(config).await.ok()?;
    let db = config.scope_database.clone().filter(|d| !d.is_empty()).or_else(|| config.database.clone());
    let schema_filter = t.schema.clone().or(db);
    let sql = "SELECT COALESCE(TABLE_ROWS, 0) FROM information_schema.TABLES \
               WHERE TABLE_NAME = ? AND COALESCE(TABLE_SCHEMA, DATABASE()) = COALESCE(?, DATABASE())";
    let result: Option<(u64,)> = conn.exec_first(sql, (t.table.clone(), schema_filter)).await.ok()?;
    drop(conn);
    let _ = pool.disconnect().await;
    result.map(|(n,)| n)
}

/// Convert one `mysql_async::Value` into its canonical value, given the
/// column's already-computed canonical type (needed to disambiguate, e.g.,
/// a `Bytes` value that's really a raw `BIT(1)` boolean from one that's
/// really a blob).
pub fn mysql_value_to_canonical(v: &mysql_async::Value, ty: &CanonicalType) -> (CanonicalValue, Option<ConversionNote>) {
    use mysql_async::Value as V;
    match v {
        V::NULL => (CanonicalValue::Null, None),
        V::Bytes(b) => match ty {
            CanonicalType::Bool => {
                // BIT(1) arrives as a raw binary byte (0x00/0x01), not ASCII
                // text — "any byte nonzero" is the correct truthy check here.
                (CanonicalValue::Bool(b.iter().any(|&byte| byte != 0)), None)
            }
            CanonicalType::TextArray => {
                let s = String::from_utf8_lossy(b);
                let items: Vec<String> = if s.is_empty() { Vec::new() } else { s.split(',').map(|p| p.to_string()).collect() };
                (CanonicalValue::TextArray(items), None)
            }
            CanonicalType::Bytes => (CanonicalValue::Bytes(b.to_vec()), None),
            CanonicalType::Json => (CanonicalValue::Json(String::from_utf8_lossy(b).into_owned()), None),
            CanonicalType::Date | CanonicalType::Timestamp => {
                let s = String::from_utf8_lossy(b);
                if s.starts_with("0000-00-00") {
                    (CanonicalValue::Null, Some(ConversionNote::ZeroDate))
                } else {
                    (CanonicalValue::Text(s.into_owned()), None)
                }
            }
            _ => (CanonicalValue::Text(String::from_utf8_lossy(b).into_owned()), None),
        },
        V::Int(i) => (
            if matches!(ty, CanonicalType::Bool) { CanonicalValue::Bool(*i != 0) } else { CanonicalValue::I64(*i) },
            None,
        ),
        V::UInt(u) => (
            if matches!(ty, CanonicalType::Bool) { CanonicalValue::Bool(*u != 0) } else { CanonicalValue::U64(*u) },
            None,
        ),
        V::Float(f) => (CanonicalValue::F64(*f as f64), None),
        V::Double(d) => (CanonicalValue::F64(*d), None),
        V::Date(y, mo, d, h, mi, s, micro) => {
            if *y == 0 && *mo == 0 && *d == 0 {
                return (CanonicalValue::Null, Some(ConversionNote::ZeroDate));
            }
            let text = if matches!(ty, CanonicalType::Date) {
                format!("{:04}-{:02}-{:02}", y, mo, d)
            } else if *micro > 0 {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, mo, d, h, mi, s, micro)
            } else {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
            };
            (CanonicalValue::Text(text), None)
        }
        V::Time(neg, days, h, mi, s, micro) => {
            let total_hours = *days as i64 * 24 + *h as i64;
            let out_of_range = *neg || total_hours >= 24;
            let hh = total_hours.rem_euclid(24) as u32;
            let text = if *micro > 0 { format!("{:02}:{:02}:{:02}.{:06}", hh, mi, s, micro) } else { format!("{:02}:{:02}:{:02}", hh, mi, s) };
            (CanonicalValue::Text(text), if out_of_range { Some(ConversionNote::TimeOutOfRange) } else { None })
        }
    }
}

/// Build the `SELECT <cols> FROM <table>` statement used to stream a
/// table's rows for migration. The row-streaming loop itself lives in
/// `orchestrator.rs` alongside the target writer it feeds — both the
/// `mysql_async::Conn` and the `QueryResult` borrowing it need to live in
/// the same stack frame (mysql_async's cursor type borrows the connection),
/// so this module deliberately stops at "give me the pieces to open a
/// cursor" rather than wrapping them in a struct that would need to move
/// across an API boundary.
pub fn select_sql(t: &TableRef, columns: &[String]) -> String {
    let cols = columns.iter().map(|c| format!("`{}`", c.replace('`', "``"))).collect::<Vec<_>>().join(", ");
    format!("SELECT {} FROM {}", cols, table_ident(t.schema.as_deref(), &t.table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tinyint_one_maps_to_bool() {
        let col = mysql_native_to_canonical("flag", "tinyint(1)", true, false, false);
        assert_eq!(col.ty, CanonicalType::Bool);
    }

    #[test]
    fn bigint_unsigned_widens_to_numeric_with_warning() {
        let col = mysql_native_to_canonical("big", "bigint unsigned", true, false, false);
        assert_eq!(col.ty, CanonicalType::Numeric { precision: 20, scale: 0 });
        assert!(col.warning.is_some());
    }

    #[test]
    fn enum_carries_its_values() {
        let col = mysql_native_to_canonical("status", "enum('a','b')", true, false, false);
        assert_eq!(col.ty, CanonicalType::Enum(vec!["a".to_string(), "b".to_string()]));
    }

    #[test]
    fn set_maps_to_text_array() {
        let col = mysql_native_to_canonical("tags", "set('a','b')", true, false, false);
        assert_eq!(col.ty, CanonicalType::TextArray);
    }

    #[test]
    fn bit_one_boolean_reads_raw_byte_not_ascii_text() {
        // Regression: BIT(1) arrives from mysql_async as a raw binary byte
        // (0x00/0x01), not the ASCII text "0"/"1" — a naive
        // `s == "0"` text comparison would misread the NUL byte as truthy.
        let (v, note) = mysql_value_to_canonical(&mysql_async::Value::Bytes(vec![0]), &CanonicalType::Bool);
        assert_eq!(v, CanonicalValue::Bool(false));
        assert!(note.is_none());
        let (v, _) = mysql_value_to_canonical(&mysql_async::Value::Bytes(vec![1]), &CanonicalType::Bool);
        assert_eq!(v, CanonicalValue::Bool(true));
    }

    #[test]
    fn zero_date_becomes_null_with_note() {
        let (v, note) = mysql_value_to_canonical(&mysql_async::Value::Date(0, 0, 0, 0, 0, 0, 0), &CanonicalType::Date);
        assert_eq!(v, CanonicalValue::Null);
        assert_eq!(note, Some(ConversionNote::ZeroDate));
    }

    #[test]
    fn normal_date_renders_as_iso_text() {
        let (v, note) = mysql_value_to_canonical(&mysql_async::Value::Date(2024, 1, 2, 0, 0, 0, 0), &CanonicalType::Date);
        assert_eq!(v, CanonicalValue::Text("2024-01-02".to_string()));
        assert_eq!(note, None);
    }
}
