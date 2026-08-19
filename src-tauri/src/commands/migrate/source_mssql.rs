//! SQL Server as a migration source (source-only for now — no
//! `target_sqlserver.rs` exists yet; see `orchestrator.rs`'s module doc for
//! why). Schema introspection and row reading into the canonical
//! representation (`super::canonical`), via `tiberius`.

use tiberius::{Client, ColumnData};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::canonical::{CanonicalColumn, CanonicalType, CanonicalValue, ConversionNote, TableRef};
use crate::commands::connection::{normalize_host, ConnectionConfig};
use crate::commands::error::from_tiberius;

const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub fn quote_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

pub fn table_ident(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(s), quote_ident(table)),
        _ => quote_ident(table),
    }
}

/// Connect and, when a schema (database) is given, switch the session's
/// database context to it — mirrors `commands::mssql::fetch_mssql_schema`'s
/// `USE [db]` pattern, since `INFORMATION_SCHEMA`/`sys.*` are always scoped
/// to whichever database is currently selected.
pub async fn connect(config: &ConnectionConfig, database: Option<&str>) -> Result<Client<Compat<TcpStream>>, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.or_else(|| crate::commands::engine::default_port(&config.engine)).unwrap_or(1433);
    let (host, port) = crate::commands::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "sa".to_string());
    let pass = config.password.clone().unwrap_or_default();
    let db = database.map(|s| s.to_string()).or_else(|| config.database.clone()).filter(|d| !d.is_empty());

    let mut tiberius_config = tiberius::Config::new();
    tiberius_config.host(&host);
    tiberius_config.port(port);
    if let Some(db) = &db {
        tiberius_config.database(db);
    }
    tiberius_config.authentication(tiberius::AuthMethod::sql_server(user, pass));

    let ssl_mode = config.ssl_mode.as_deref().unwrap_or("");
    if ssl_mode.eq_ignore_ascii_case("disable") {
        tiberius_config.encryption(tiberius::EncryptionLevel::NotSupported);
    } else {
        tiberius_config.encryption(tiberius::EncryptionLevel::Required);
        tiberius_config.trust_cert();
    }

    let addr = tiberius_config.get_addr();
    let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr.as_str())).await {
        Ok(res) => res.map_err(|e| {
            from_tiberius(tiberius::error::Error::Io { kind: e.kind(), message: e.to_string() }, None).to_json_string()
        })?,
        Err(_) => {
            return Err(from_tiberius(
                tiberius::error::Error::Io {
                    kind: std::io::ErrorKind::TimedOut,
                    message: format!("TCP connect to {} timed out after {}s", addr, CONNECT_TIMEOUT.as_secs()),
                },
                None,
            )
            .to_json_string())
        }
    };
    let _ = tcp.set_nodelay(true);
    Client::connect(tiberius_config, tcp.compat_write())
        .await
        .map_err(|e| from_tiberius(e, None).to_json_string())
}

fn map_native_type(
    name: &str,
    data_type: &str,
    char_max_len: Option<i32>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
) -> (CanonicalType, Option<String>) {
    let dt = data_type.to_lowercase();
    match dt.as_str() {
        "bit" => (CanonicalType::Bool, None),
        // T-SQL TINYINT is 0-255 (unsigned) — Int16 holds its full range.
        "tinyint" | "smallint" => (CanonicalType::Int16, None),
        "int" => (CanonicalType::Int32, None),
        "bigint" => (CanonicalType::Int64, None),
        "decimal" | "numeric" => (
            CanonicalType::Numeric { precision: numeric_precision.unwrap_or(18).max(1) as u32, scale: numeric_scale.unwrap_or(0).max(0) as u32 },
            None,
        ),
        "money" => (CanonicalType::Numeric { precision: 19, scale: 4 }, None),
        "smallmoney" => (CanonicalType::Numeric { precision: 10, scale: 4 }, None),
        "real" => (CanonicalType::Float32, None),
        "float" => (CanonicalType::Float64, None),
        "char" | "nchar" => (CanonicalType::Char(char_max_len.filter(|&n| n > 0).unwrap_or(255) as u32), None),
        "varchar" | "nvarchar" => match char_max_len {
            Some(n) if n > 0 => (CanonicalType::VarChar(n as u32), None),
            // -1 is T-SQL's `varchar(max)`/`nvarchar(max)`.
            _ => (CanonicalType::Text, None),
        },
        "text" | "ntext" | "xml" => (CanonicalType::Text, None),
        "binary" | "varbinary" | "image" => (CanonicalType::Bytes, None),
        "date" => (CanonicalType::Date, None),
        "time" => (CanonicalType::Time, None),
        "datetime" | "datetime2" | "smalldatetime" => (CanonicalType::Timestamp, None),
        "datetimeoffset" => (
            CanonicalType::Timestamp,
            Some(format!("`{}` is DATETIMEOFFSET — converted to UTC; the target has no timezone-aware type.", name)),
        ),
        "uniqueidentifier" => (CanonicalType::Uuid, None),
        other => (
            CanonicalType::Unknown(other.to_string()),
            Some(format!("`{}` has unrecognized SQL Server type `{}` — defaulting to TEXT.", name, other)),
        ),
    }
}

pub async fn fetch_columns(config: &ConnectionConfig, t: &TableRef) -> Result<Vec<CanonicalColumn>, String> {
    let mut client = connect(config, t.schema.as_deref()).await?;
    let schema = t.schema.clone();

    let col_sql = format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, \
                c.IS_NULLABLE, \
                COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS is_identity, \
                (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
                 JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA \
                 WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND ku.TABLE_SCHEMA = c.TABLE_SCHEMA AND ku.TABLE_NAME = c.TABLE_NAME AND ku.COLUMN_NAME = c.COLUMN_NAME) AS is_pk \
         FROM INFORMATION_SCHEMA.COLUMNS c \
         WHERE c.TABLE_NAME = '{}' AND c.TABLE_SCHEMA = COALESCE('{}', 'dbo') \
         ORDER BY c.ORDINAL_POSITION",
        t.table.replace('\'', "''"),
        schema.clone().unwrap_or_default().replace('\'', "''"),
    );

    let rows = client
        .simple_query(col_sql)
        .await
        .map_err(|e| from_tiberius(e, None).to_json_string())?
        .into_first_result()
        .await
        .map_err(|e| from_tiberius(e, None).to_json_string())?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let name = row.get::<&str, _>(0).unwrap_or("").to_string();
        let data_type = row.get::<&str, _>(1).unwrap_or("").to_string();
        let char_max_len: Option<i32> = row.get(2);
        let numeric_precision: Option<i32> = row.get::<i16, _>(3).map(|n| n as i32);
        let numeric_scale: Option<i32> = row.get::<i16, _>(4).map(|n| n as i32);
        let is_nullable = row.get::<&str, _>(5).unwrap_or("YES");
        let is_identity: Option<i32> = row.get(6);
        let is_pk: i32 = row.get(7).unwrap_or(0);

        let (ty, warning) = map_native_type(&name, &data_type, char_max_len, numeric_precision, numeric_scale);
        out.push(CanonicalColumn {
            name,
            ty,
            native_type: data_type,
            nullable: is_nullable.eq_ignore_ascii_case("YES"),
            is_primary_key: is_pk > 0,
            is_auto_increment: is_identity.unwrap_or(0) > 0,
            warning,
        });
    }
    Ok(out)
}

pub async fn fetch_row_estimate(config: &ConnectionConfig, t: &TableRef) -> Option<u64> {
    let mut client = connect(config, t.schema.as_deref()).await.ok()?;
    let schema = t.schema.clone().unwrap_or_else(|| "dbo".to_string());
    let sql = format!(
        "SELECT SUM(ps.row_count) FROM sys.tables tbl \
         JOIN sys.schemas sch ON sch.schema_id = tbl.schema_id \
         JOIN sys.dm_db_partition_stats ps ON ps.object_id = tbl.object_id AND ps.index_id IN (0, 1) \
         WHERE sch.name = '{}' AND tbl.name = '{}'",
        schema.replace('\'', "''"),
        t.table.replace('\'', "''"),
    );
    let rows = client.simple_query(sql).await.ok()?.into_first_result().await.ok()?;
    let count: i64 = rows.first()?.get(0)?;
    Some(count.max(0) as u64)
}

/// Build the `SELECT <cols> FROM <table>` statement used to stream a
/// table's rows for migration — no parameters, straightforward projection.
pub fn select_sql(t: &TableRef, columns: &[String]) -> String {
    let cols = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    format!("SELECT {} FROM {}", cols, table_ident(t.schema.as_deref(), &t.table))
}

fn int_or_bool(n: i64, ty: &CanonicalType) -> CanonicalValue {
    if matches!(ty, CanonicalType::Bool) { CanonicalValue::Bool(n != 0) } else { CanonicalValue::I64(n) }
}

/// Convert one tiberius cell to its canonical value. Date/time variants
/// delegate to tiberius's own `FromSql` impls for the `chrono` types (same
/// approach `commands::mssql::mssql_cell_to_json` already uses) rather than
/// hand-rolling TDS date/time arithmetic.
pub fn tiberius_value_to_canonical(data: &ColumnData<'static>, ty: &CanonicalType) -> (CanonicalValue, Option<ConversionNote>) {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    use tiberius::FromSql;
    use ColumnData as CD;
    match data {
        CD::U8(v) => (v.map(|n| int_or_bool(n as i64, ty)).unwrap_or(CanonicalValue::Null), None),
        CD::I16(v) => (v.map(|n| int_or_bool(n as i64, ty)).unwrap_or(CanonicalValue::Null), None),
        CD::I32(v) => (v.map(|n| int_or_bool(n as i64, ty)).unwrap_or(CanonicalValue::Null), None),
        CD::I64(v) => (v.map(|n| int_or_bool(n, ty)).unwrap_or(CanonicalValue::Null), None),
        CD::F32(v) => (v.map(|n| CanonicalValue::F64(n as f64)).unwrap_or(CanonicalValue::Null), None),
        CD::F64(v) => (v.map(CanonicalValue::F64).unwrap_or(CanonicalValue::Null), None),
        CD::Bit(v) => (v.map(CanonicalValue::Bool).unwrap_or(CanonicalValue::Null), None),
        CD::String(v) => (v.as_ref().map(|s| CanonicalValue::Text(s.to_string())).unwrap_or(CanonicalValue::Null), None),
        CD::Guid(v) => (v.map(|g| CanonicalValue::Text(g.to_string())).unwrap_or(CanonicalValue::Null), None),
        CD::Binary(v) => (v.as_ref().map(|b| CanonicalValue::Bytes(b.to_vec())).unwrap_or(CanonicalValue::Null), None),
        CD::Numeric(v) => (v.map(|n| CanonicalValue::Text(n.to_string())).unwrap_or(CanonicalValue::Null), None),
        CD::Xml(v) => (v.as_ref().map(|x| CanonicalValue::Text(x.to_string())).unwrap_or(CanonicalValue::Null), None),
        CD::Date(_) => match NaiveDate::from_sql(data) {
            Ok(Some(d)) => (CanonicalValue::Text(d.to_string()), None),
            _ => (CanonicalValue::Null, None),
        },
        CD::Time(_) => match NaiveTime::from_sql(data) {
            Ok(Some(t)) => (CanonicalValue::Text(t.to_string()), None),
            _ => (CanonicalValue::Null, None),
        },
        CD::SmallDateTime(_) | CD::DateTime(_) | CD::DateTime2(_) => match NaiveDateTime::from_sql(data) {
            Ok(Some(d)) => (CanonicalValue::Text(d.format("%Y-%m-%d %H:%M:%S%.f").to_string()), None),
            _ => (CanonicalValue::Null, None),
        },
        CD::DateTimeOffset(_) => match chrono::DateTime::<chrono::Utc>::from_sql(data) {
            Ok(Some(d)) => (CanonicalValue::Text(d.format("%Y-%m-%d %H:%M:%S%.f").to_string()), Some(ConversionNote::TimezoneDropped)),
            _ => (CanonicalValue::Null, None),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tinyint_holds_full_unsigned_range_in_int16() {
        let (ty, _) = map_native_type("n", "tinyint", None, None, None);
        assert_eq!(ty, CanonicalType::Int16);
    }

    #[test]
    fn decimal_carries_precision_and_scale() {
        let (ty, _) = map_native_type("price", "decimal", None, Some(10), Some(2));
        assert_eq!(ty, CanonicalType::Numeric { precision: 10, scale: 2 });
    }

    #[test]
    fn uniqueidentifier_maps_to_uuid() {
        let (ty, _) = map_native_type("id", "uniqueidentifier", None, None, None);
        assert_eq!(ty, CanonicalType::Uuid);
    }

    #[test]
    fn datetimeoffset_warns_about_dropped_timezone() {
        let (ty, warning) = map_native_type("created_at", "datetimeoffset", None, None, None);
        assert_eq!(ty, CanonicalType::Timestamp);
        assert!(warning.is_some());
    }

    #[test]
    fn nvarchar_max_becomes_text() {
        let (ty, _) = map_native_type("body", "nvarchar", Some(-1), None, None);
        assert_eq!(ty, CanonicalType::Text);
    }
}
