//! MySQL as a migration target: DDL generation from the canonical schema
//! and batched multi-row `INSERT` rendering.
//!
//! Unlike the Postgres target's `COPY`, the default (and only, for v1)
//! bulk-load path here is `INSERT INTO t (...) VALUES (...), (...), ...`
//! batches, run inside one transaction per table (`START TRANSACTION` ...
//! `COMMIT`, or a rollback on failure/cancel — see `orchestrator.rs`) so a
//! failed or cancelled table still ends up empty, matching the "always safe
//! to retry from scratch" property the Postgres target gets for free from
//! `COPY` being all-or-nothing.
//!
//! `mysql_async` *can* do `LOAD DATA LOCAL INFILE` (via
//! `Conn::set_infile_handler`), which would be faster, but it's disabled by
//! default on MySQL 8+ clients and servers and often blocked outright on
//! managed hosts (RDS and similar) — depending on it as the only path would
//! make this feature unreliable out of the box. It's left as a possible
//! opt-in fast path for later, not built now.
//!
//! `PRIMARY KEY`/`AUTO_INCREMENT` are declared directly in `CREATE TABLE`
//! (no post-load step, unlike the Postgres target): this app doesn't
//! discover secondary indexes at all yet, and InnoDB always has a
//! clustered key regardless of when the `PRIMARY KEY` is declared, so
//! deferring it here would buy nothing.

use super::canonical::{CanonicalColumn, CanonicalType, CanonicalValue};

pub fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

pub fn qualify_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_ident(s), quote_ident(table)),
        _ => quote_ident(table),
    }
}

/// Canonical type → MySQL DDL type. `Enum` maps to MySQL's *native*
/// `ENUM(...)` (unlike the Postgres target's `text + CHECK` workaround —
/// MySQL has no "commit before use" rule for enums). `TextArray` maps to
/// `JSON` (a JSON array) since MySQL has no array type and, coming from an
/// arbitrary source, no bounded value domain to build a `SET` from.
pub fn canonical_to_mysql_type(ty: &CanonicalType) -> String {
    match ty {
        CanonicalType::Bool => "tinyint(1)".to_string(),
        CanonicalType::Int16 => "smallint".to_string(),
        CanonicalType::Int32 => "int".to_string(),
        CanonicalType::Int64 => "bigint".to_string(),
        CanonicalType::Numeric { precision, scale } => format!("decimal({},{})", precision, scale),
        CanonicalType::Float32 => "float".to_string(),
        CanonicalType::Float64 => "double".to_string(),
        CanonicalType::VarChar(n) => format!("varchar({})", (*n).min(65_535)),
        CanonicalType::Char(n) => format!("char({})", (*n).min(255)),
        CanonicalType::Text => "longtext".to_string(),
        CanonicalType::Bytes => "longblob".to_string(),
        CanonicalType::Date => "date".to_string(),
        CanonicalType::Time => "time".to_string(),
        CanonicalType::Timestamp => "datetime".to_string(),
        CanonicalType::Json => "json".to_string(),
        // MySQL has no UUID type; CHAR(36) holds the canonical
        // `8-4-4-4-12` hex-with-hyphens text form.
        CanonicalType::Uuid => "char(36)".to_string(),
        CanonicalType::Enum(values) => {
            let list = values.iter().map(|v| format!("'{}'", v.replace('\'', "''"))).collect::<Vec<_>>().join(", ");
            format!("enum({})", list)
        }
        CanonicalType::TextArray => "json".to_string(),
        CanonicalType::Unknown(_) => "longtext".to_string(),
    }
}

pub fn build_create_table_sql(schema: Option<&str>, table: &str, columns: &[CanonicalColumn]) -> String {
    let qualified = qualify_table(schema, table);
    let mut lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut parts = vec![quote_ident(&c.name), canonical_to_mysql_type(&c.ty)];
            if !c.nullable {
                parts.push("NOT NULL".to_string());
            }
            if c.is_auto_increment {
                parts.push("AUTO_INCREMENT".to_string());
            }
            format!("  {}", parts.join(" "))
        })
        .collect();

    let pk_cols: Vec<&CanonicalColumn> = columns.iter().filter(|c| c.is_primary_key).collect();
    if !pk_cols.is_empty() {
        let cols = pk_cols.iter().map(|c| quote_ident(&c.name)).collect::<Vec<_>>().join(", ");
        lines.push(format!("  PRIMARY KEY ({})", cols));
    }

    format!("CREATE TABLE IF NOT EXISTS {} (\n{}\n);", qualified, lines.join(",\n"))
}

/// Render one canonical value as a MySQL SQL literal, for a batched
/// multi-row `INSERT`.
pub fn sql_literal(value: &CanonicalValue) -> String {
    match value {
        CanonicalValue::Null => "NULL".to_string(),
        CanonicalValue::Bool(b) => if *b { "1".to_string() } else { "0".to_string() },
        CanonicalValue::I64(i) => i.to_string(),
        CanonicalValue::U64(u) => u.to_string(),
        CanonicalValue::F64(f) => {
            if f.is_finite() { f.to_string() } else { "NULL".to_string() }
        }
        CanonicalValue::Text(s) => quote_string(s),
        CanonicalValue::Bytes(b) => format!("X'{}'", b.iter().map(|byte| format!("{:02x}", byte)).collect::<String>()),
        CanonicalValue::Json(s) => quote_string(s),
        CanonicalValue::TextArray(items) => {
            let json = serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string());
            quote_string(&json)
        }
    }
}

fn quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// Build one multi-row `INSERT` statement for a batch of rows.
pub fn insert_batch_sql(schema: Option<&str>, table: &str, columns: &[String], rows: &[Vec<CanonicalValue>]) -> String {
    let qualified = qualify_table(schema, table);
    let col_list = columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", ");
    let values = rows
        .iter()
        .map(|row| format!("({})", row.iter().map(sql_literal).collect::<Vec<_>>().join(", ")))
        .collect::<Vec<_>>()
        .join(",\n  ");
    format!("INSERT INTO {} ({}) VALUES\n  {};", qualified, col_list, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_becomes_native_mysql_enum() {
        assert_eq!(canonical_to_mysql_type(&CanonicalType::Enum(vec!["a".into(), "b".into()])), "enum('a', 'b')");
    }

    #[test]
    fn text_array_becomes_json() {
        assert_eq!(canonical_to_mysql_type(&CanonicalType::TextArray), "json");
    }

    #[test]
    fn bool_renders_as_zero_or_one() {
        assert_eq!(sql_literal(&CanonicalValue::Bool(true)), "1");
        assert_eq!(sql_literal(&CanonicalValue::Bool(false)), "0");
    }

    #[test]
    fn bytes_render_as_hex_literal() {
        assert_eq!(sql_literal(&CanonicalValue::Bytes(vec![0xDE, 0xAD])), "X'dead'");
    }

    #[test]
    fn string_quoting_escapes_quotes_and_backslashes() {
        assert_eq!(sql_literal(&CanonicalValue::Text("o'brien\\x".to_string())), "'o\\'brien\\\\x'");
    }

    #[test]
    fn insert_batch_builds_multi_row_values() {
        let sql = insert_batch_sql(
            None,
            "t",
            &["a".to_string(), "b".to_string()],
            &[vec![CanonicalValue::I64(1), CanonicalValue::Text("x".to_string())]],
        );
        assert!(sql.contains("INSERT INTO `t` (`a`, `b`) VALUES"));
        assert!(sql.contains("(1, 'x')"));
    }
}
