//! MySQL → PostgreSQL type mapping and value conversion, for the migration
//! wizard (`commands::pg_migrate`). Pure, no I/O.
//!
//! The `COLUMN_TYPE` string this parses is MySQL's full type spec (e.g.
//! `int(11) unsigned`, `tinyint(1)`, `enum('a','b')`, `decimal(10,2)`) — the
//! same string `connection::fetch_schema_tree_impl`'s MySQL branch already
//! captures into `SchemaNode.data_type`.
//!
//! Design notes on the trickier mappings (see also the project plan):
//!  - `tinyint(1)` is MySQL's boolean idiom → Postgres `boolean`.
//!  - Postgres has no unsigned integer types. Each unsigned MySQL int widens
//!    to the next signed type that can hold its full range; `bigint
//!    unsigned` has no such type (its max exceeds `i64`), so it widens to
//!    `numeric(20,0)` instead.
//!  - `enum(...)` becomes `text` + a `CHECK` constraint rather than a native
//!    Postgres `enum` type — native enums require a separate `CREATE TYPE`
//!    that must commit before use, which complicates a single migration
//!    transaction for comparatively little benefit.
//!  - `set(...)` becomes `text[]`; MySQL's comma-joined value list is split
//!    into a Postgres array literal.
//!  - MySQL's zero dates (`0000-00-00`) have no Postgres representation —
//!    converted to `NULL`.

/// Parsed shape of a MySQL `COLUMN_TYPE` string.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MysqlColumnShape {
    /// Base type name, lowercased, with `unsigned`/`zerofill` stripped
    /// (e.g. "int", "varchar", "decimal", "enum", "set").
    pub base: String,
    pub unsigned: bool,
    /// `varchar(n)` / `char(n)` / `bit(n)` length.
    pub length: Option<i64>,
    /// `decimal(p,s)` precision.
    pub precision: Option<i64>,
    /// `decimal(p,s)` scale.
    pub scale: Option<i64>,
    /// `enum(...)` / `set(...)` value list, in declared order.
    pub enum_values: Vec<String>,
}

/// Parse a raw MySQL `COLUMN_TYPE` string (as read from
/// `information_schema.COLUMNS.COLUMN_TYPE`) into its component parts.
pub fn parse_mysql_column_type(column_type: &str) -> MysqlColumnShape {
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

    let mut shape = MysqlColumnShape {
        base,
        unsigned,
        ..Default::default()
    };

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

/// Split a MySQL `enum(...)`/`set(...)` argument list (single-quoted,
/// comma-separated, `''` as the escaped-quote sequence) into plain values.
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

/// How a source value must be transformed on its way from MySQL to Postgres,
/// beyond a plain textual passthrough.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueTransform {
    /// Written as-is (numbers, plain text, already-correct date/time text).
    None,
    /// MySQL 0/1 → Postgres `t`/`f`.
    IntToBool,
    /// Binary data → Postgres bytea hex-escape text (`\xDEADBEEF`).
    RawBytes,
    /// MySQL zero dates (`0000-00-00...`) → `NULL`.
    ZeroDateToNull,
    /// MySQL SET's comma-joined string → a Postgres array literal.
    SetToArray,
}

/// A non-fatal observation about a single value conversion, deduplicated by
/// the caller so a column with a million offending rows produces one warning
/// line, not a million.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversionNote {
    ZeroDate,
    TimeOutOfRange,
}

impl ConversionNote {
    pub fn message(&self) -> &'static str {
        match self {
            ConversionNote::ZeroDate => {
                "contains a zero date (e.g. 0000-00-00) with no Postgres equivalent — stored as NULL."
            }
            ConversionNote::TimeOutOfRange => {
                "contains a TIME value outside Postgres's 0-24h range — clamped into range."
            }
        }
    }
}

/// The Postgres-side plan for one migrated column: its target DDL type, the
/// transform to apply to source values, and anything worth surfacing to the
/// user before they run the migration.
#[derive(Debug, Clone)]
pub struct PgColumnPlan {
    pub name: String,
    /// DDL type fragment, e.g. `"bigint"`, `"numeric(10,2)"`, `"text[]"`.
    pub pg_type: String,
    pub value_transform: ValueTransform,
    /// `Some("col" IN ('a','b'))` for enum columns.
    pub check_constraint: Option<String>,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    /// A one-off note about this specific column's mapping (e.g. the
    /// unsigned-bigint-widens-to-numeric rationale), not a per-row note.
    pub warning: Option<String>,
}

/// Map one MySQL column (already parsed) to its Postgres plan.
pub fn map_to_postgres(
    name: &str,
    shape: &MysqlColumnShape,
    nullable: bool,
    is_primary_key: bool,
    is_auto_increment: bool,
) -> PgColumnPlan {
    let mut warning = None;
    let mut check_constraint = None;

    let (pg_type, value_transform) = match shape.base.as_str() {
        "tinyint" if shape.length == Some(1) && !shape.unsigned => {
            ("boolean".to_string(), ValueTransform::IntToBool)
        }
        "bit" if shape.length.unwrap_or(1) == 1 => ("boolean".to_string(), ValueTransform::IntToBool),
        "bit" => (format!("bit({})", shape.length.unwrap_or(1)), ValueTransform::None),
        "tinyint" => ("smallint".to_string(), ValueTransform::None),
        "smallint" | "year" => {
            if shape.unsigned {
                ("integer".to_string(), ValueTransform::None)
            } else {
                ("smallint".to_string(), ValueTransform::None)
            }
        }
        "int" | "integer" | "mediumint" => {
            if shape.unsigned {
                ("bigint".to_string(), ValueTransform::None)
            } else {
                ("integer".to_string(), ValueTransform::None)
            }
        }
        "bigint" => {
            if shape.unsigned {
                warning = Some(format!(
                    "`{}` is BIGINT UNSIGNED — mapped to NUMERIC(20,0) because Postgres has no unsigned integer type.",
                    name
                ));
                ("numeric(20,0)".to_string(), ValueTransform::None)
            } else {
                ("bigint".to_string(), ValueTransform::None)
            }
        }
        "decimal" | "numeric" | "dec" | "fixed" => {
            let p = shape.precision.unwrap_or(10);
            let s = shape.scale.unwrap_or(0);
            (format!("numeric({},{})", p, s), ValueTransform::None)
        }
        "float" => ("real".to_string(), ValueTransform::None),
        "double" | "double precision" | "real" => ("double precision".to_string(), ValueTransform::None),
        "varchar" => (format!("varchar({})", shape.length.unwrap_or(255)), ValueTransform::None),
        "char" => (format!("char({})", shape.length.unwrap_or(255)), ValueTransform::None),
        "text" | "tinytext" | "mediumtext" | "longtext" => ("text".to_string(), ValueTransform::None),
        "blob" | "tinyblob" | "mediumblob" | "longblob" | "binary" | "varbinary" => {
            ("bytea".to_string(), ValueTransform::RawBytes)
        }
        "date" => ("date".to_string(), ValueTransform::ZeroDateToNull),
        "time" => ("time".to_string(), ValueTransform::None),
        "datetime" | "timestamp" => ("timestamp".to_string(), ValueTransform::ZeroDateToNull),
        "enum" => {
            let list = shape
                .enum_values
                .iter()
                .map(|v| format!("'{}'", v.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ");
            check_constraint = Some(format!("{} IN ({})", quote_pg_ident(name), list));
            ("text".to_string(), ValueTransform::None)
        }
        "set" => ("text[]".to_string(), ValueTransform::SetToArray),
        "json" => ("jsonb".to_string(), ValueTransform::None),
        other => {
            warning = Some(format!(
                "`{}` has unrecognized MySQL type `{}` — defaulting to TEXT.",
                name, other
            ));
            ("text".to_string(), ValueTransform::None)
        }
    };

    PgColumnPlan {
        name: name.to_string(),
        pg_type,
        value_transform,
        check_constraint,
        nullable,
        is_primary_key,
        is_auto_increment,
        warning,
    }
}

/// Quote a Postgres identifier.
pub fn quote_pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qualify_pg_table(schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", quote_pg_ident(s), quote_pg_ident(table)),
        _ => quote_pg_ident(table),
    }
}

/// Build the `CREATE TABLE` DDL for the migration preview. Deliberately
/// columns-only — no `PRIMARY KEY`/index — see `build_post_load_sql`'s doc
/// comment for why those are deferred until after the bulk load.
pub fn build_create_table_sql(schema: Option<&str>, table: &str, columns: &[PgColumnPlan]) -> String {
    let qualified = qualify_pg_table(schema, table);
    let lines: Vec<String> = columns
        .iter()
        .map(|c| {
            let mut parts = vec![quote_pg_ident(&c.name), c.pg_type.clone()];
            if !c.nullable {
                parts.push("NOT NULL".to_string());
            }
            if let Some(check) = &c.check_constraint {
                parts.push(format!("CHECK ({})", check));
            }
            format!("  {}", parts.join(" "))
        })
        .collect();
    format!("CREATE TABLE IF NOT EXISTS {} (\n{}\n);", qualified, lines.join(",\n"))
}

/// Statements to run once a table's data has fully loaded: primary key /
/// auto-increment sequence fixups, and a final `ANALYZE`.
///
/// These are deferred to *after* the bulk `COPY` rather than declared on
/// `CREATE TABLE` because index/constraint maintenance during a row-by-row
/// (or bulk-streamed) load is the dominant cost on large tables — the same
/// reason `pg_restore` builds indexes after loading data, not before.
pub fn build_post_load_sql(schema: Option<&str>, table: &str, columns: &[PgColumnPlan]) -> Vec<String> {
    let qualified = qualify_pg_table(schema, table);
    let mut stmts = Vec::new();

    let pk_cols: Vec<&PgColumnPlan> = columns.iter().filter(|c| c.is_primary_key).collect();
    if !pk_cols.is_empty() {
        let cols = pk_cols
            .iter()
            .map(|c| quote_pg_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        stmts.push(format!("ALTER TABLE {} ADD PRIMARY KEY ({});", qualified, cols));
    }

    for c in columns.iter().filter(|c| c.is_auto_increment) {
        // Sequence name kept simple (table_column_seq) — collisions across
        // migrated tables are astronomically unlikely and, if they happen,
        // surface as a clear "already exists" error rather than silent data
        // corruption.
        let seq_name = format!("{}_{}_seq", table, c.name);
        let qseq = quote_pg_ident(&seq_name);
        let qcol = quote_pg_ident(&c.name);
        stmts.push(format!("CREATE SEQUENCE IF NOT EXISTS {};", qseq));
        stmts.push(format!(
            "SELECT setval('{}', COALESCE((SELECT MAX({}) FROM {}), 1));",
            seq_name, qcol, qualified
        ));
        stmts.push(format!(
            "ALTER TABLE {} ALTER COLUMN {} SET DEFAULT nextval('{}');",
            qualified, qcol, seq_name
        ));
        stmts.push(format!("ALTER SEQUENCE {} OWNED BY {}.{};", qseq, qualified, qcol));
    }

    stmts.push(format!("ANALYZE {};", qualified));
    stmts
}

/// Escape one field's logical text for the Postgres `COPY ... FROM STDIN`
/// text format: backslash, tab, newline, and carriage return are the only
/// bytes that format treats specially. Column/array/bytea-hex literals that
/// themselves contain a backslash (e.g. `\xdeadbeef`) rely on this running
/// *after* the value has been rendered to its logical Postgres-input text —
/// escaping here doubles that backslash so Postgres's own COPY parser
/// restores the original `\x...` before handing it to the column's type
/// input function.
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

/// Render a MySQL SET column's comma-joined string as a Postgres array
/// literal (`{"a","b"}`). MySQL SET values can't themselves contain commas,
/// so splitting on `,` is unambiguous.
fn set_to_pg_array(raw: &[u8]) -> Vec<u8> {
    let s = String::from_utf8_lossy(raw);
    if s.is_empty() {
        return b"{}".to_vec();
    }
    let mut out = Vec::new();
    out.push(b'{');
    for (i, part) in s.split(',').enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.push(b'"');
        for ch in part.chars() {
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

fn is_zero_date_text(s: &str) -> bool {
    s.starts_with("0000-00-00")
}

/// Convert one MySQL value into its logical Postgres `COPY` text-format
/// representation for the given column plan. Returns `(None, _)` for SQL
/// NULL — the caller writes the literal `\N` marker directly, never through
/// `escape_copy_field`. The returned bytes still need `escape_copy_field`
/// applied before being written to the COPY stream.
pub fn mysql_value_to_pg_text(
    value: &mysql_async::Value,
    plan: &PgColumnPlan,
) -> (Option<Vec<u8>>, Option<ConversionNote>) {
    use mysql_async::Value as V;
    match value {
        V::NULL => (None, None),
        V::Bytes(b) => match plan.value_transform {
            ValueTransform::RawBytes => (Some(bytea_hex(b)), None),
            ValueTransform::SetToArray => (Some(set_to_pg_array(b)), None),
            ValueTransform::IntToBool => {
                let s = String::from_utf8_lossy(b);
                let truthy = s.trim() != "0" && !s.trim().is_empty();
                (Some((if truthy { "t" } else { "f" }).into()), None)
            }
            ValueTransform::ZeroDateToNull => {
                let s = String::from_utf8_lossy(b);
                if is_zero_date_text(&s) {
                    (None, Some(ConversionNote::ZeroDate))
                } else {
                    (Some(s.into_owned().into_bytes()), None)
                }
            }
            ValueTransform::None => (Some(b.clone()), None),
        },
        V::Int(i) => (Some(int_text(*i, plan)), None),
        V::UInt(u) => (Some(uint_text(*u, plan)), None),
        V::Float(f) => (Some(f.to_string().into_bytes()), None),
        V::Double(d) => (Some(d.to_string().into_bytes()), None),
        V::Date(y, mo, d, h, mi, s, micro) => {
            if *y == 0 && *mo == 0 && *d == 0 {
                return (None, Some(ConversionNote::ZeroDate));
            }
            let is_date_only = plan.pg_type == "date";
            let text = if is_date_only {
                format!("{:04}-{:02}-{:02}", y, mo, d)
            } else if *micro > 0 {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:06}", y, mo, d, h, mi, s, micro)
            } else {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, s)
            };
            (Some(text.into_bytes()), None)
        }
        V::Time(neg, days, h, mi, s, micro) => {
            let total_hours = *days as i64 * 24 + *h as i64;
            let out_of_range = *neg || total_hours >= 24;
            let hh = total_hours.rem_euclid(24) as u32;
            let text = if *micro > 0 {
                format!("{:02}:{:02}:{:02}.{:06}", hh, mi, s, micro)
            } else {
                format!("{:02}:{:02}:{:02}", hh, mi, s)
            };
            (
                Some(text.into_bytes()),
                if out_of_range { Some(ConversionNote::TimeOutOfRange) } else { None },
            )
        }
    }
}

fn int_text(i: i64, plan: &PgColumnPlan) -> Vec<u8> {
    if plan.value_transform == ValueTransform::IntToBool {
        (if i != 0 { "t" } else { "f" }).into()
    } else {
        i.to_string().into_bytes()
    }
}

fn uint_text(u: u64, plan: &PgColumnPlan) -> Vec<u8> {
    if plan.value_transform == ValueTransform::IntToBool {
        (if u != 0 { "t" } else { "f" }).into()
    } else {
        u.to_string().into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_for(column_type: &str, name: &str) -> PgColumnPlan {
        let shape = parse_mysql_column_type(column_type);
        map_to_postgres(name, &shape, true, false, false)
    }

    #[test]
    fn parses_unsigned_int() {
        let s = parse_mysql_column_type("int(11) unsigned");
        assert_eq!(s.base, "int");
        assert!(s.unsigned);
    }

    #[test]
    fn tinyint_one_maps_to_boolean() {
        let p = plan_for("tinyint(1)", "flag");
        assert_eq!(p.pg_type, "boolean");
        assert_eq!(p.value_transform, ValueTransform::IntToBool);
    }

    #[test]
    fn tinyint_wide_maps_to_smallint() {
        let p = plan_for("tinyint(4)", "n");
        assert_eq!(p.pg_type, "smallint");
        assert_eq!(p.value_transform, ValueTransform::None);
    }

    #[test]
    fn enum_maps_to_text_with_check() {
        let s = parse_mysql_column_type("enum('a','b','c')");
        assert_eq!(s.enum_values, vec!["a", "b", "c"]);
        let p = plan_for("enum('a','b','c')", "status");
        assert_eq!(p.pg_type, "text");
        assert!(p.check_constraint.as_deref().unwrap().contains("'a', 'b', 'c'"));
    }

    #[test]
    fn decimal_precision_and_scale() {
        let p = plan_for("decimal(10,2)", "price");
        assert_eq!(p.pg_type, "numeric(10,2)");
    }

    #[test]
    fn bigint_unsigned_widens_to_numeric_with_warning() {
        let p = plan_for("bigint unsigned", "big");
        assert_eq!(p.pg_type, "numeric(20,0)");
        assert!(p.warning.is_some());
    }

    #[test]
    fn blob_maps_to_bytea_raw_bytes() {
        let p = plan_for("blob", "data");
        assert_eq!(p.pg_type, "bytea");
        assert_eq!(p.value_transform, ValueTransform::RawBytes);
    }

    #[test]
    fn set_maps_to_text_array() {
        let p = plan_for("set('a','b')", "tags");
        assert_eq!(p.pg_type, "text[]");
        assert_eq!(p.value_transform, ValueTransform::SetToArray);
    }

    #[test]
    fn json_maps_to_jsonb() {
        let p = plan_for("json", "payload");
        assert_eq!(p.pg_type, "jsonb");
    }

    #[test]
    fn zero_date_detected() {
        assert!(is_zero_date_text("0000-00-00"));
        assert!(is_zero_date_text("0000-00-00 00:00:00"));
        assert!(!is_zero_date_text("2024-01-01"));
    }

    #[test]
    fn escapes_backslash_tab_newline_cr() {
        assert_eq!(escape_copy_field(b"a\\b\tc\nd\re"), b"a\\\\b\\tc\\nd\\re".to_vec());
    }

    #[test]
    fn bytea_hex_format() {
        assert_eq!(bytea_hex(&[0xDE, 0xAD]), b"\\xdead".to_vec());
    }

    #[test]
    fn set_to_array_literal() {
        assert_eq!(set_to_pg_array(b"a,b,c"), b"{\"a\",\"b\",\"c\"}".to_vec());
        assert_eq!(set_to_pg_array(b""), b"{}".to_vec());
    }

    #[test]
    fn value_conversion_zero_date_is_null_with_note() {
        let p = plan_for("date", "d");
        let v = mysql_async::Value::Date(0, 0, 0, 0, 0, 0, 0);
        let (text, note) = mysql_value_to_pg_text(&v, &p);
        assert!(text.is_none());
        assert_eq!(note, Some(ConversionNote::ZeroDate));
    }

    #[test]
    fn value_conversion_normal_date() {
        let p = plan_for("date", "d");
        let v = mysql_async::Value::Date(2024, 1, 2, 0, 0, 0, 0);
        let (text, note) = mysql_value_to_pg_text(&v, &p);
        assert_eq!(text, Some(b"2024-01-02".to_vec()));
        assert_eq!(note, None);
    }
}
