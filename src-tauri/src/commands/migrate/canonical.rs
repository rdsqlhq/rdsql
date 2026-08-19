//! The canonical type/value intermediate representation shared by every
//! source and target adapter in `commands::migrate`.
//!
//! Without this layer, supporting N engines as sources and M as targets
//! would need N×M pairwise type-mapping modules (and the pairwise count
//! only grows as more engines are added). With it, each engine needs
//! exactly one adapter: a "read" side (native schema/row → canonical) for
//! engines that can be a source, and a "write" side (canonical → native
//! DDL/bulk-load) for engines that can be a target. Adding an engine later
//! is one new adapter, not a new pairing against every engine that already
//! exists.

use serde::{Deserialize, Serialize};

/// Which table (optionally schema-qualified) a migration operates on. The
/// schema is always passed explicitly by the orchestrator — never inferred
/// from `ConnectionConfig.scope_database` — so a table reference is
/// unambiguous regardless of what the connection's own default happens to
/// be pointed at. Also the IPC shape for `db_migrate_plan_tables`'s
/// `tables` argument.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRef {
    pub schema: Option<String>,
    pub table: String,
}

/// A type in the intermediate representation every source normalizes into
/// and every target renders from.
#[derive(Debug, Clone, PartialEq)]
pub enum CanonicalType {
    Bool,
    Int16,
    Int32,
    Int64,
    /// Arbitrary-precision decimal — also the landing spot for integers too
    /// wide for `Int64` (e.g. MySQL `BIGINT UNSIGNED`, which exceeds `i64`).
    Numeric { precision: u32, scale: u32 },
    Float32,
    Float64,
    VarChar(u32),
    Char(u32),
    Text,
    /// Raw binary (blob/bytea/varbinary/image).
    Bytes,
    Date,
    Time,
    Timestamp,
    Json,
    Uuid,
    /// A fixed set of allowed string values, in declared order.
    Enum(Vec<String>),
    /// An unbounded list of strings (MySQL `SET`, Postgres `text[]`).
    /// Engines with no native array/set type render it as JSON.
    TextArray,
    /// Anything unrecognized — every target renders it as its widest text
    /// type, and the original native type name is kept for the warning.
    Unknown(String),
}

/// One column's canonical shape, produced by a source adapter's schema
/// introspection and consumed by a target adapter's DDL builder.
#[derive(Debug, Clone)]
pub struct CanonicalColumn {
    pub name: String,
    pub ty: CanonicalType,
    /// The original native type string, kept only for display in the
    /// wizard's mapping preview (e.g. "int(11) unsigned" next to "bigint").
    pub native_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub is_auto_increment: bool,
    /// A one-off note about *this column's* mapping (e.g. "widened to
    /// NUMERIC because...") — not a per-row note. Surfaced once per column
    /// regardless of how many rows the table has.
    pub warning: Option<String>,
}

/// One value in the intermediate representation, produced by a source
/// adapter's row conversion and consumed by a target adapter's writer.
/// Deliberately typed (not "everything is text") because a few conversions
/// — booleans above all — are wrong if collapsed to text: a MySQL
/// `TINYINT(1)` target must see `0`/`1`, not the two-character string `"t"`.
#[derive(Debug, Clone, PartialEq)]
pub enum CanonicalValue {
    Null,
    Bool(bool),
    I64(i64),
    U64(u64),
    F64(f64),
    /// Text passthrough — also used for values whose source-native text
    /// representation is already valid input on every supported target
    /// (decimal/numeric text, ISO date/time/timestamp text, UUID text, enum
    /// member text).
    Text(String),
    Bytes(Vec<u8>),
    Json(String),
    TextArray(Vec<String>),
}

/// A non-fatal observation about a single value conversion. Callers
/// deduplicate by `(column, note kind)` so a column with a million
/// offending rows produces one warning line, not a million — the same
/// property the original MySQL→Postgres implementation established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConversionNote {
    /// MySQL's zero dates (`0000-00-00[...]`) have no equivalent anywhere
    /// else — converted to `NULL`.
    ZeroDate,
    /// A MySQL `TIME` value outside Postgres/MySQL's shared 0-24h range —
    /// clamped into range.
    TimeOutOfRange,
    /// The source value was timezone-aware (Postgres `timestamptz`, SQL
    /// Server `datetimeoffset`); converted to UTC and the offset dropped,
    /// since no target column type here is timezone-aware.
    TimezoneDropped,
}

/// Split a SQL script on top-level semicolons, respecting single-quoted
/// string literals (with standard `''` escaping) — mirrors
/// `src/core/backup/backupSql.ts`'s `splitSqlStatements` so a DDL preview
/// (Postgres or MySQL) can contain more than one statement.
pub fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        current.push(ch);
        if ch == '\'' {
            if in_string && chars.get(i + 1) == Some(&'\'') {
                current.push('\'');
                i += 2;
                continue;
            }
            in_string = !in_string;
        } else if ch == ';' && !in_string {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                statements.push(trimmed);
            }
            current.clear();
        }
        i += 1;
    }
    let tail = current.trim().to_string();
    if !tail.is_empty() {
        statements.push(tail);
    }
    statements
}

impl ConversionNote {
    pub fn message(&self) -> &'static str {
        match self {
            ConversionNote::ZeroDate => {
                "contains a zero date (e.g. 0000-00-00) with no equivalent on the target — stored as NULL."
            }
            ConversionNote::TimeOutOfRange => {
                "contains a TIME value outside the target's 0-24h range — clamped into range."
            }
            ConversionNote::TimezoneDropped => {
                "is timezone-aware on the source; the target column has no timezone — converted to UTC and the offset was dropped."
            }
        }
    }
}
