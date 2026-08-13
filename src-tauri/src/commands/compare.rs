//! Database comparison & schema synchronization tooling.
//!
//! Provides three read-only operations (schema diff, table-data diff, and a
//! dry-run DDL script generator) and one write operation (apply a generated
//! schema-sync script to a target database). The design is deliberately
//! **source → target only**: the apply step receives only a `target`
//! `ConnectionConfig` — there is no parameter through which the source can be
//! written to. The source is read during diffing and never again.
//!
//! Safety gates (enforced in the UI and re-checked here):
//!   - DDL is generated as a preview first (`generate_schema_sync_sql`); it is
//!     never executed until the user explicitly applies it.
//!   - `apply_schema_sync` requires a `confirm_token` that must equal the
//!     target's database name — a defense-in-depth check that mirrors the
//!     type-to-confirm dialog in the frontend.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};
use tokio_postgres::NoTls;
use rusqlite::Connection as SqliteConn;
use duckdb::Connection as DuckdbConn;
use mysql_async::prelude::*;
use super::connection::{fetch_schema_tree_impl, normalize_host, ConnectionConfig, SchemaNode};
use super::error::{from_duckdb, from_mysql, from_postgres, from_sqlite, DbError};
use super::query::{mysql_opts, mysql_value_to_json};

/// Row cap for table-data comparison. Comparing unbounded tables can pull
/// millions of rows into memory; we sample the first chunk and flag the
/// result as truncated so the UI can tell the user to narrow the comparison.
const DATA_COMPARE_LIMIT: i64 = 1000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Compare & sync require the two databases to be the SAME engine — the diff
/// is structural (column types, nullability, PK) and the generated DDL is
/// engine-specific, so a cross-engine compare would produce misleading
/// results and a cross-engine sync would emit unrunnable SQL. Normalize the
/// engine string to its canonical family representative (postgres / mysql /
/// sqlite) so that e.g. `cockroachdb` and `yugabytedb` both compare as
/// `postgres`, and `tidb` / `planetscale` compare as `mysql`.
fn normalize_engine(engine: &str) -> String {
    super::engine::normalize_engine(engine)
}

/// Returns Err if source and target are not the same engine family.
fn require_same_engine(source: &ConnectionConfig, target: &ConnectionConfig) -> Result<(), String> {
    let src = normalize_engine(&source.engine);
    let tgt = normalize_engine(&target.engine);
    if src != tgt {
        return Err(DbError::app(format!(
            "Compare & sync requires both databases to be the same engine. \
             Source is \"{}\", target is \"{}\". Pick two {} databases (or two {} databases).",
            src, tgt, src, tgt
        ))
        .to_json_string());
    }
    Ok(())
}

/// The effective database for a connection: prefer the explicit
/// `scope_database` (set by the Compare tool's DB picker), otherwise fall
/// back to the connection's `database`. Used to connect with the right USE
/// context and to qualify table names when the engine treats a database as a
/// schema (MySQL/MariaDB).
fn effective_db(config: &ConnectionConfig) -> Option<String> {
    config
        .scope_database
        .clone()
        .filter(|d| !d.is_empty())
        .or_else(|| config.database.clone().filter(|d| !d.is_empty()))
}

// ---------------------------------------------------------------------------
// Shared result types
// ---------------------------------------------------------------------------

/// Coarse status of a compared object (table or column).
/// - `added`    = present in source, missing in target
/// - `removed`  = missing in source, present in target
/// - `modified` = present in both but differing
/// - `unchanged`= present in both and identical
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffStatus {
    Added,
    Removed,
    Modified,
    Unchanged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub added: u64,
    pub removed: u64,
    pub modified: u64,
    pub unchanged: u64,
}

// ---------------------------------------------------------------------------
// Schema diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    pub name: String,
    pub status: DiffStatus,
    pub data_type: Option<String>,
    /// Snapshot of the source column's type, present on `modified` columns.
    pub source_data_type: Option<String>,
    pub target_data_type: Option<String>,
    pub is_nullable: Option<bool>,
    pub source_is_nullable: Option<bool>,
    pub target_is_nullable: Option<bool>,
    pub is_primary_key: Option<bool>,
    pub source_is_primary_key: Option<bool>,
    pub target_is_primary_key: Option<bool>,
    /// Free-text description of what changed, human readable.
    pub change_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    pub schema: Option<String>,
    pub name: String,
    /// The kind of object this diff describes — `"table"` or `"view"`. Carried
    /// straight through from the schema tree so the UI can group and filter by
    /// object type. It does not affect how the diff or the DDL is computed.
    pub object_type: String,
    pub status: DiffStatus,
    pub row_count_source: Option<u64>,
    pub row_count_target: Option<u64>,
    pub columns: Vec<ColumnDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffResult {
    pub source_engine: String,
    pub target_engine: String,
    pub summary: DiffSummary,
    pub tables: Vec<TableDiff>,
}

/// Flatten the recursive `SchemaNode` tree into a lookup keyed by
/// `(schema?, table)`. SQLite has a single "main" schema so the schema key is
/// normalized to `None` for the cross-DB comparison when one side is SQLite.
type TableKey = (Option<String>, String);

struct FlatTable {
    schema: Option<String>,
    name: String,
    /// "table" or "view", as reported by the schema tree.
    object_type: String,
    columns: Vec<SchemaNode>,
    row_count: Option<u64>,
}

fn flatten_tree(tree: &[SchemaNode], engine: &str) -> Vec<FlatTable> {
    let is_sqlite = super::engine::engine_family(engine) == super::engine::EngineFamily::Sqlite;
    let mut out = Vec::new();
    for schema_node in tree {
        if schema_node.node_type != "schema" && schema_node.node_type != "database" {
            continue;
        }
        // SQLite's single schema is reported as "main"; normalize to None so a
        // SQLite-vs-Postgres comparison still matches tables by name only.
        let schema_name = if is_sqlite {
            None
        } else {
            Some(schema_node.name.clone())
        };
        for table_node in &schema_node.children {
            if table_node.node_type != "table" && table_node.node_type != "view" {
                continue;
            }
            out.push(FlatTable {
                schema: schema_name.clone(),
                name: table_node.name.clone(),
                object_type: table_node.node_type.clone(),
                columns: table_node.children.clone(),
                row_count: table_node.row_count,
            });
        }
    }
    out
}

/// Compute a single human-readable description of what differs between two
/// column definitions. Returns None when the columns are equivalent.
fn column_change(
    src: &SchemaNode,
    tgt: &SchemaNode,
) -> (DiffStatus, Option<String>) {
    let mut changes: Vec<String> = Vec::new();

    let src_type = src.data_type.as_deref().unwrap_or("");
    let tgt_type = tgt.data_type.as_deref().unwrap_or("");
    if !src_type.eq_ignore_ascii_case(tgt_type) {
        changes.push(format!("type: {} → {}", tgt_type, src_type));
    }

    let src_null = src.is_nullable.unwrap_or(true);
    let tgt_null = tgt.is_nullable.unwrap_or(true);
    if src_null != tgt_null {
        changes.push(format!(
            "nullable: {} → {}",
            nullable_label(tgt_null),
            nullable_label(src_null)
        ));
    }

    let src_pk = src.is_primary_key.unwrap_or(false);
    let tgt_pk = tgt.is_primary_key.unwrap_or(false);
    if src_pk != tgt_pk {
        changes.push(format!("primary key: {} → {}", tgt_pk, src_pk));
    }

    if changes.is_empty() {
        (DiffStatus::Unchanged, None)
    } else {
        (DiffStatus::Modified, Some(changes.join("; ")))
    }
}

fn nullable_label(n: bool) -> &'static str {
    if n {
        "YES"
    } else {
        "NO"
    }
}

/// Diff the two schema trees into a flat, UI-friendly result. Pure function —
/// no DB access — so it can be unit-tested and reused by both the schema
/// compare command and the sync-script generator.
fn diff_trees(
    source_tree: Vec<SchemaNode>,
    target_tree: Vec<SchemaNode>,
    source_engine: &str,
    target_engine: &str,
) -> SchemaDiffResult {
    let src_tables = flatten_tree(&source_tree, source_engine);
    let tgt_tables = flatten_tree(&target_tree, target_engine);

    let mut src_map: BTreeMap<TableKey, &FlatTable> = BTreeMap::new();
    for t in &src_tables {
        src_map.insert((t.schema.clone(), t.name.clone()), t);
    }
    let mut tgt_map: BTreeMap<TableKey, &FlatTable> = BTreeMap::new();
    for t in &tgt_tables {
        tgt_map.insert((t.schema.clone(), t.name.clone()), t);
    }

    let mut summary = DiffSummary {
        added: 0,
        removed: 0,
        modified: 0,
        unchanged: 0,
    };
    let mut tables: Vec<TableDiff> = Vec::new();

    let all_keys: std::collections::BTreeSet<TableKey> =
        src_map.keys().chain(tgt_map.keys()).cloned().collect();

    for key in all_keys {
        match (src_map.get(&key), tgt_map.get(&key)) {
            (Some(src), None) => {
                summary.added += 1;
                // The whole table is new in source — surface every column as added.
                let cols: Vec<ColumnDiff> = src
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        name: c.name.clone(),
                        status: DiffStatus::Added,
                        data_type: c.data_type.clone(),
                        source_data_type: c.data_type.clone(),
                        target_data_type: None,
                        is_nullable: c.is_nullable,
                        source_is_nullable: c.is_nullable,
                        target_is_nullable: None,
                        is_primary_key: c.is_primary_key,
                        source_is_primary_key: c.is_primary_key,
                        target_is_primary_key: None,
                        change_description: Some("column added".to_string()),
                    })
                    .collect();
                tables.push(TableDiff {
                    schema: src.schema.clone(),
                    name: src.name.clone(),
                    object_type: src.object_type.clone(),
                    status: DiffStatus::Added,
                    row_count_source: src.row_count,
                    row_count_target: None,
                    columns: cols,
                });
            }
            (None, Some(tgt)) => {
                summary.removed += 1;
                // Table exists in target but not source — from the sync
                // perspective this is "extra in target" and would be dropped.
                let cols: Vec<ColumnDiff> = tgt
                    .columns
                    .iter()
                    .map(|c| ColumnDiff {
                        name: c.name.clone(),
                        status: DiffStatus::Removed,
                        data_type: c.data_type.clone(),
                        source_data_type: None,
                        target_data_type: c.data_type.clone(),
                        is_nullable: c.is_nullable,
                        source_is_nullable: None,
                        target_is_nullable: c.is_nullable,
                        is_primary_key: c.is_primary_key,
                        source_is_primary_key: None,
                        target_is_primary_key: c.is_primary_key,
                        change_description: Some("column only in target".to_string()),
                    })
                    .collect();
                tables.push(TableDiff {
                    schema: tgt.schema.clone(),
                    name: tgt.name.clone(),
                    object_type: tgt.object_type.clone(),
                    status: DiffStatus::Removed,
                    row_count_source: None,
                    row_count_target: tgt.row_count,
                    columns: cols,
                });
            }
            (Some(src), Some(tgt)) => {
                // Build per-column diff. Match by column name.
                let mut src_cols: BTreeMap<&String, &SchemaNode> = BTreeMap::new();
                for c in &src.columns {
                    src_cols.insert(&c.name, c);
                }
                let mut tgt_cols: BTreeMap<&String, &SchemaNode> = BTreeMap::new();
                for c in &tgt.columns {
                    tgt_cols.insert(&c.name, c);
                }
                let col_keys: std::collections::BTreeSet<&String> =
                    src_cols.keys().chain(tgt_cols.keys()).cloned().collect();

                let mut cols: Vec<ColumnDiff> = Vec::new();
                let mut table_modified = false;
                for ck in col_keys {
                    match (src_cols.get(ck), tgt_cols.get(ck)) {
                        (Some(s), None) => {
                            table_modified = true;
                            cols.push(ColumnDiff {
                                name: s.name.clone(),
                                status: DiffStatus::Added,
                                data_type: s.data_type.clone(),
                                source_data_type: s.data_type.clone(),
                                target_data_type: None,
                                is_nullable: s.is_nullable,
                                source_is_nullable: s.is_nullable,
                                target_is_nullable: None,
                                is_primary_key: s.is_primary_key,
                                source_is_primary_key: s.is_primary_key,
                                target_is_primary_key: None,
                                change_description: Some("column added".to_string()),
                            });
                        }
                        (None, Some(t)) => {
                            table_modified = true;
                            cols.push(ColumnDiff {
                                name: t.name.clone(),
                                status: DiffStatus::Removed,
                                data_type: t.data_type.clone(),
                                source_data_type: None,
                                target_data_type: t.data_type.clone(),
                                is_nullable: t.is_nullable,
                                source_is_nullable: None,
                                target_is_nullable: t.is_nullable,
                                is_primary_key: t.is_primary_key,
                                source_is_primary_key: None,
                                target_is_primary_key: t.is_primary_key,
                                change_description: Some("column only in target".to_string()),
                            });
                        }
                        (Some(s), Some(t)) => {
                            let (status, desc) = column_change(s, t);
                            if !matches!(status, DiffStatus::Unchanged) {
                                table_modified = true;
                            }
                            cols.push(ColumnDiff {
                                name: s.name.clone(),
                                status,
                                data_type: s.data_type.clone(),
                                source_data_type: s.data_type.clone(),
                                target_data_type: t.data_type.clone(),
                                is_nullable: s.is_nullable,
                                source_is_nullable: s.is_nullable,
                                target_is_nullable: t.is_nullable,
                                is_primary_key: s.is_primary_key,
                                source_is_primary_key: s.is_primary_key,
                                target_is_primary_key: t.is_primary_key,
                                change_description: desc,
                            });
                        }
                        (None, None) => {}
                    }
                }

                if table_modified {
                    summary.modified += 1;
                    tables.push(TableDiff {
                        schema: src.schema.clone(),
                        name: src.name.clone(),
                        object_type: src.object_type.clone(),
                        status: DiffStatus::Modified,
                        row_count_source: src.row_count,
                        row_count_target: tgt.row_count,
                        columns: cols,
                    });
                } else {
                    summary.unchanged += 1;
                    // Identical on both sides. Emitted so the UI can list every
                    // table side by side with its row counts; the column diff is
                    // omitted because there is nothing to show and carrying it
                    // would multiply the payload on large schemas. Sync
                    // generation ignores `Unchanged` entries.
                    tables.push(TableDiff {
                        schema: src.schema.clone(),
                        name: src.name.clone(),
                        object_type: src.object_type.clone(),
                        status: DiffStatus::Unchanged,
                        row_count_source: src.row_count,
                        row_count_target: tgt.row_count,
                        columns: Vec::new(),
                    });
                }
            }
            // (None, None) is unreachable — `all_keys` is built only from keys
            // present in at least one map — but the exhaustiveness checker
            // requires it.
            (None, None) => {}
        }
    }

    SchemaDiffResult {
        source_engine: source_engine.to_string(),
        target_engine: target_engine.to_string(),
        summary,
        tables,
    }
}

#[tauri::command]
pub async fn compare_schema(
    source: ConnectionConfig,
    target: ConnectionConfig,
) -> Result<SchemaDiffResult, String> {
    require_same_engine(&source, &target)?;
    let source_engine = normalize_engine(&source.engine);
    let target_engine = normalize_engine(&target.engine);

    let source_tree = fetch_schema_tree_impl(source)
        .await
        .map_err(|e| format!("Failed to read source schema: {}", e))?;
    let target_tree = fetch_schema_tree_impl(target)
        .await
        .map_err(|e| format!("Failed to read target schema: {}", e))?;

    Ok(diff_trees(
        source_tree,
        target_tree,
        &source_engine,
        &target_engine,
    ))
}

// ---------------------------------------------------------------------------
// Table-data diff
// ---------------------------------------------------------------------------

/// One row that differs between source and target. The PK tuple identifies
/// the row; `source_row` / `target_row` carry the full column values (one may
/// be null when the row only exists on one side).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDifference {
    /// PK column values joined as a string, for display. Null when the table
    /// has no PK (rows are matched by full-row hash instead).
    pub key: Option<String>,
    pub source_row: Option<Vec<serde_json::Value>>,
    pub target_row: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDiffResult {
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<String>,
    /// True when the table has a primary key we could match rows on.
    pub has_primary_key: bool,
    /// The names of the primary-key columns, so the UI can mark them. Empty
    /// when the table has no PK (rows were matched by full-row hash).
    pub pk_columns: Vec<String>,
    /// Rows present in source but not target.
    pub only_in_source: Vec<RowDifference>,
    /// Rows present in target but not source.
    pub only_in_target: Vec<RowDifference>,
    /// Rows present in both with differing values.
    pub different: Vec<RowDifference>,
    pub matched_count: u64,
    /// True when we hit the row cap; the diff is partial.
    pub truncated: bool,
}

/// A lightweight (column name + values) snapshot of a table from one DB.
struct TableSnapshot {
    columns: Vec<String>,
    pk_columns: Vec<String>,
    /// Rows keyed by their PK tuple (joined with `\u{1f}`), or by a hash of
    /// the full row when there is no PK.
    rows: std::collections::BTreeMap<String, Vec<serde_json::Value>>,
}

/// Fetch a bounded snapshot of a table for diffing. Reads at most
/// `DATA_COMPARE_LIMIT` rows, ordered by PK when one exists (stable ordering
/// makes the hash-based fallback deterministic).
async fn fetch_table_snapshot(
    config: &ConnectionConfig,
    schema: Option<&str>,
    table: &str,
) -> Result<TableSnapshot, String> {
    let engine = config.engine.to_lowercase();
    match super::engine::engine_family(&engine) {
        super::engine::EngineFamily::Sqlite => fetch_table_snapshot_sqlite(config, table),
        super::engine::EngineFamily::Duckdb => fetch_table_snapshot_duckdb(config, schema, table),
        super::engine::EngineFamily::Postgres => {
            fetch_table_snapshot_postgres(config, schema, table).await
        }
        super::engine::EngineFamily::Mysql => fetch_table_snapshot_mysql(config, schema, table).await,
        super::engine::EngineFamily::Mssql => fetch_table_snapshot_mssql(config, schema, table).await,
    }
}

/// Read up to `DATA_COMPARE_LIMIT` rows from a SQL Server table for the
/// data-diff view. `schema` is the Explorer group (a database, like MySQL) —
/// point the connection there via `effective_db` and read the bare table
/// unqualified (see `qualify`'s doc comment for why).
async fn fetch_table_snapshot_mssql(
    config: &ConnectionConfig,
    schema: Option<&str>,
    table: &str,
) -> Result<TableSnapshot, String> {
    let effective_schema = schema.map(|s| s.to_string()).or_else(|| effective_db(config));
    let db_config = ConnectionConfig {
        database: effective_schema.clone().or_else(|| config.database.clone()),
        ..config.clone()
    };
    let table_ident = quote_ident("mssql", table);

    let pk_query = format!(
        "SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
           ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA \
         WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND ku.TABLE_NAME = '{}' \
         ORDER BY ku.ORDINAL_POSITION;",
        table.replace('\'', "''")
    );
    let pk_res = super::mssql::run_mssql_query(&db_config, &pk_query).await?;
    let pk_cols: Vec<String> = pk_res
        .rows
        .iter()
        .filter_map(|r| r.first().and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();

    let sql = if pk_cols.is_empty() {
        format!("SELECT TOP {} * FROM {};", DATA_COMPARE_LIMIT, table_ident)
    } else {
        let order = pk_cols.iter().map(|c| quote_ident("mssql", c)).collect::<Vec<_>>().join(", ");
        format!("SELECT TOP {} * FROM {} ORDER BY {};", DATA_COMPARE_LIMIT, table_ident, order)
    };

    let result = super::mssql::run_mssql_query(&db_config, &sql).await?;
    let col_names: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
    Ok(snapshot_from_rows(col_names, pk_cols, result.rows))
}

fn snapshot_from_rows(
    columns: Vec<String>,
    pk_columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
) -> TableSnapshot {
    let pk_idx: Vec<usize> = if pk_columns.is_empty() {
        Vec::new()
    } else {
        pk_columns
            .iter()
            .filter_map(|pk| columns.iter().position(|c| c.eq_ignore_ascii_case(pk)))
            .collect()
    };

    let mut map: std::collections::BTreeMap<String, Vec<serde_json::Value>> =
        std::collections::BTreeMap::new();
    for row in rows {
        let key = if pk_idx.is_empty() {
            // No PK — hash the full row so two identical rows collapse together.
            row_hash(&row)
        } else {
            pk_idx
                .iter()
                .map(|&i| value_key(row.get(i)))
                .collect::<Vec<_>>()
                .join("\u{1f}")
        };
        // Last-write-wins on duplicate keys is fine for diffing purposes.
        map.insert(key, row);
    }
    TableSnapshot {
        columns,
        pk_columns,
        rows: map,
    }
}

fn row_hash(row: &[serde_json::Value]) -> String {
    // A stable, order-sensitive stringification. serde_json::Value serializes
    // deterministically for primitives, which is all we compare at row level.
    let s = serde_json::to_string(row).unwrap_or_default();
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("h{:016x}", hasher.finish())
}

fn value_key(v: Option<&serde_json::Value>) -> String {
    match v {
        Some(serde_json::Value::Null) | None => "\u{0}".to_string(),
        Some(other) => other.to_string(),
    }
}

fn fetch_table_snapshot_sqlite(
    config: &ConnectionConfig,
    table: &str,
) -> Result<TableSnapshot, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("SQLite file path is empty.".to_string());
    }
    let conn = SqliteConn::open(&path).map_err(|e| from_sqlite(e, None).to_json_string())?;

    // PK columns via PRAGMA.
    let mut pk_cols: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info('{}')", table))
            .map_err(|e| from_sqlite(e, None).to_json_string())?;
        let pk_rows = stmt
            .query_map([], |row| {
                let name: String = row.get(1)?;
                let pk: i32 = row.get(5)?;
                Ok((name, pk))
            })
            .map_err(|e| from_sqlite(e, None).to_json_string())?;
        let mut pks: Vec<(String, i32)> = Vec::new();
        for r in pk_rows.flatten() {
            pks.push(r);
        }
        pks.sort_by_key(|(_, order)| *order);
        for (name, order) in pks {
            if order > 0 {
                pk_cols.push(name);
            }
        }
    }

    let quoted = format!("\"{}\"", table.replace('"', "\"\""));
    let sql = if pk_cols.is_empty() {
        format!("SELECT * FROM {} LIMIT {}", quoted, DATA_COMPARE_LIMIT)
    } else {
        let order = pk_cols
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT * FROM {} ORDER BY {} LIMIT {}", quoted, order, DATA_COMPARE_LIMIT)
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| from_sqlite(e, Some(&sql)).to_json_string())?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let mut rows_data = Vec::new();
    let mut iter = stmt.query([]).map_err(|e| from_sqlite(e, Some(&sql)).to_json_string())?;
    while let Ok(Some(row)) = iter.next() {
        let mut vals = Vec::new();
        for i in 0..col_names.len() {
            let v: rusqlite::types::Value = row.get(i).unwrap_or(rusqlite::types::Value::Null);
            vals.push(match v {
                rusqlite::types::Value::Null => serde_json::Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::json!(n),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::json!(s),
                rusqlite::types::Value::Blob(b) => serde_json::json!(format!("<blob {} bytes>", b.len())),
            });
        }
        rows_data.push(vals);
    }

    Ok(snapshot_from_rows(col_names, pk_cols, rows_data))
}

async fn fetch_table_snapshot_postgres(
    config: &ConnectionConfig,
    schema: Option<&str>,
    table: &str,
) -> Result<TableSnapshot, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(5432);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
    let db = config.database.clone().unwrap_or_else(|| "postgres".to_string());
    let pass = config.password.clone().unwrap_or_default();

    let conn_str = format!(
        "host={} port={} user={} dbname={} password={}",
        host, port, user, db, pass
    );
    let (client, connection) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_postgres::connect(&conn_str, NoTls),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let mut d = from_postgres(e, None);
            d.kind = super::error::ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => return Err(DbError::connection(format!(
            "PostgreSQL connection timed out after {}s — check that the server is running on {}:{}",
            CONNECT_TIMEOUT.as_secs(), host, port
        ))
        .to_json_string()),
    };
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    let qualified = qualify_pg_table(schema, table);

    // PK columns from information_schema.
    let pk_query =
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
           AND tc.table_schema = kcu.table_schema \
         WHERE tc.constraint_type = 'PRIMARY KEY' \
           AND COALESCE(kcu.table_schema, 'public') = COALESCE($1::text, 'public') \
           AND kcu.table_name = $2 \
         ORDER BY kcu.ordinal_position";
    let pk_rows = client
        .query(pk_query, &[&schema, &table])
        .await
        .map_err(|e| from_postgres(e, None).to_json_string())?;
    let pk_cols: Vec<String> = pk_rows.iter().map(|r| r.get::<_, String>(0)).collect();

    let sql = if pk_cols.is_empty() {
        format!("SELECT * FROM {} LIMIT {}", qualified, DATA_COMPARE_LIMIT)
    } else {
        let order = pk_cols
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT * FROM {} ORDER BY {} LIMIT {}", qualified, order, DATA_COMPARE_LIMIT)
    };

    let stmt = client
        .prepare(&sql)
        .await
        .map_err(|e| from_postgres(e, Some(&sql)).to_json_string())?;
    let col_names: Vec<String> = stmt.columns().iter().map(|c| c.name().to_string()).collect();
    let rows = client
        .query(&sql, &[])
        .await
        .map_err(|e| from_postgres(e, Some(&sql)).to_json_string())?;

    let mut rows_data = Vec::new();
    for row in &rows {
        let mut vals = Vec::new();
        for i in 0..col_names.len() {
            let v: Option<String> = row.try_get(i).ok();
            vals.push(match v {
                Some(s) => serde_json::json!(s),
                None => serde_json::Value::Null,
            });
        }
        rows_data.push(vals);
    }

    Ok(snapshot_from_rows(col_names, pk_cols, rows_data))
}

async fn fetch_table_snapshot_mysql(
    config: &ConnectionConfig,
    schema: Option<&str>,
    table: &str,
) -> Result<TableSnapshot, String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    // The compare tool targets a specific database (scope_database); fall back
    // to the connection's configured database. This sets both the USE context
    // and qualifies the PK/row lookups below.
    let db = effective_db(config);
    let pass = config.password.clone().unwrap_or_default();

    let opts = mysql_opts(host.clone(), port, user, pass, db.clone());
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            let mut d: DbError = from_mysql(e, None).into();
            d.kind = super::error::ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => return Err(DbError::connection(format!(
            "MySQL connection timed out after {}s — check that MySQL is running on {}:{}",
            CONNECT_TIMEOUT.as_secs(), host, port
        ))
        .to_json_string()),
    };

    // Qualify with the scope database when no explicit schema was given.
    let effective_schema = schema.map(|s| s.to_string()).or(db);
    let qualified = qualify_mysql_table(effective_schema.as_deref(), table);

    // PK columns for MySQL via information_schema (robust across versions).
    // Query as a single-column tuple so mysql_async's FromRow derivation is
    // unambiguous, then unwrap to a plain Vec<String>.
    let pk_query = format!(
        "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE \
         WHERE CONSTRAINT_NAME = 'PRIMARY' \
           AND COALESCE(TABLE_SCHEMA, DATABASE()) = COALESCE('{}', DATABASE()) \
           AND TABLE_NAME = '{}' \
         ORDER BY SEQ_IN_INDEX",
        effective_schema.clone().unwrap_or_default().replace('\'', "''"),
        table.replace('\'', "''")
    );
    let pk_rows: Result<Vec<(String,)>, mysql_async::Error> = conn.exec(&pk_query, ()).await;
    let pk_cols: Vec<String> = match pk_rows {
        Ok(rows) => rows.into_iter().map(|(c,)| c).collect(),
        Err(_) => Vec::new(),
    };

    let sql = if pk_cols.is_empty() {
        format!("SELECT * FROM {} LIMIT {}", qualified, DATA_COMPARE_LIMIT)
    } else {
        let order = pk_cols
            .iter()
            .map(|c| format!("`{}`", c.replace('`', "``")))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT * FROM {} ORDER BY {} LIMIT {}", qualified, order, DATA_COMPARE_LIMIT)
    };

    let mut result = conn
        .query_iter(&sql)
        .await
        .map_err(|e| from_mysql(e, Some(&sql)).0.to_json_string())?;
    let col_meta = result.columns_ref().to_vec();
    let col_names: Vec<String> = col_meta.iter().map(|c| c.name_str().to_string()).collect();

    let mut rows_data = Vec::new();
    loop {
        let row_opt = match result.next().await {
            Ok(o) => o,
            Err(e) => {
                drop(conn);
                let _ = pool.disconnect().await;
                return Err(from_mysql(e, Some(&sql)).0.to_json_string());
            }
        };
        let row = match row_opt {
            Some(r) => r,
            None => break,
        };
        let mut vals = Vec::new();
        for i in 0..col_names.len() {
            let v = match row.as_ref(i) {
                Some(v) => mysql_value_to_json(v),
                None => serde_json::Value::Null,
            };
            vals.push(v);
        }
        rows_data.push(vals);
    }

    drop(conn);
    let _ = pool.disconnect().await;

    Ok(snapshot_from_rows(col_names, pk_cols, rows_data))
}

fn qualify_pg_table(schema: Option<&str>, table: &str) -> String {
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    }
}

fn qualify_mysql_table(schema: Option<&str>, table: &str) -> String {
    let q = |s: &str| format!("`{}`", s.replace('`', "``"));
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", q(s), q(table)),
        _ => q(table),
    }
}

#[tauri::command]
pub async fn compare_table_data(
    source: ConnectionConfig,
    target: ConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DataDiffResult, String> {
    require_same_engine(&source, &target)?;
    let src = fetch_table_snapshot(&source, schema.as_deref(), &table).await?;
    let tgt = fetch_table_snapshot(&target, schema.as_deref(), &table).await?;

    // The two snapshots share column names (we compared the same table), but
    // in cross-engine setups the column order may differ. Prefer the source
    // column list for display.
    let columns = src.columns.clone();
    let has_pk = !src.pk_columns.is_empty() || !tgt.pk_columns.is_empty();

    let mut only_in_source = Vec::new();
    let mut only_in_target = Vec::new();
    let mut different = Vec::new();
    let mut matched_count: u64 = 0;

    for (key, src_row) in &src.rows {
        match tgt.rows.get(key) {
            None => {
                only_in_source.push(RowDifference {
                    key: display_key(key, has_pk),
                    source_row: Some(src_row.clone()),
                    target_row: None,
                });
            }
            Some(tgt_row) => {
                if rows_equal(src_row, tgt_row) {
                    matched_count += 1;
                } else {
                    different.push(RowDifference {
                        key: display_key(key, has_pk),
                        source_row: Some(src_row.clone()),
                        target_row: Some(tgt_row.clone()),
                    });
                }
            }
        }
    }
    for (key, tgt_row) in &tgt.rows {
        if !src.rows.contains_key(key) {
            only_in_target.push(RowDifference {
                key: display_key(key, has_pk),
                source_row: None,
                target_row: Some(tgt_row.clone()),
            });
        }
    }

    // Truncated flag: either side hit the limit. We can't know precisely
    // without a second count query, so approximate: if we read exactly the
    // cap, assume there may be more.
    let truncated = src.rows.len() as i64 >= DATA_COMPARE_LIMIT
        || tgt.rows.len() as i64 >= DATA_COMPARE_LIMIT;

    Ok(DataDiffResult {
        schema,
        table,
        columns,
        has_primary_key: has_pk,
        pk_columns: src.pk_columns.clone(),
        only_in_source,
        only_in_target,
        different,
        matched_count,
        truncated,
    })
}

fn display_key(key: &str, has_pk: bool) -> Option<String> {
    if has_pk {
        // PK keys are joined with the unit-separator char; replace for display.
        Some(key.replace('\u{1f}', " | "))
    } else {
        None
    }
}

fn rows_equal(a: &[serde_json::Value], b: &[serde_json::Value]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| value_equal(x, y))
}

/// Lenient equality: numbers compare by value across int/float; everything
/// else by JSON equality. Strings that look numeric compare numerically too,
/// because drivers often disagree on types for the same logical value.
fn value_equal(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    if a == b {
        return true;
    }
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
        _ => false,
    }
}

fn as_f64(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Schema sync: dry-run script generation + apply
// ---------------------------------------------------------------------------

/// Kind of operation a generated statement performs — drives the UI icon and
/// the confirmation copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncOperation {
    CreateTable,
    DropTable,
    AddColumn,
    DropColumn,
    AlterColumn,
    Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatement {
    pub operation: SyncOperation,
    /// Human description, e.g. "Add column `email` to `users`".
    pub description: String,
    /// The fully-qualified target DDL statement.
    pub sql: String,
    /// A table-qualified target (schema.table), used for grouping in the UI.
    pub target_object: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncScript {
    pub target_engine: String,
    pub statements: Vec<SyncStatement>,
    /// True when the target engine can run all statements as-is. False (with
    /// notes inline in `sql`) for unsupported operations, e.g. SQLite can't
    /// ALTER a column type in place.
    pub can_apply: bool,
    pub warnings: Vec<String>,
}

/// Build the DDL script that would bring `target` into sync with `source`.
/// Reuses the schema-diff machinery — this is a pure computation step that
/// never touches either database, so it's safe to call as a preview.
#[tauri::command]
pub async fn generate_schema_sync_sql(
    source: ConnectionConfig,
    target: ConnectionConfig,
) -> Result<SyncScript, String> {
    require_same_engine(&source, &target)?;
    let target_engine = normalize_engine(&target.engine);

    let source_tree = fetch_schema_tree_impl(source)
        .await
        .map_err(|e| format!("Failed to read source schema: {}", e))?;
    let target_tree = fetch_schema_tree_impl(target)
        .await
        .map_err(|e| format!("Failed to read target schema: {}", e))?;

    // Diff as source-vs-target so "added" = needs to be created in target.
    let diff = diff_trees(source_tree, target_tree, &target_engine, &target_engine);

    let mut statements = Vec::new();
    let mut warnings = Vec::new();
    let mut can_apply = true;

    for tbl in &diff.tables {
        let qualified = match &tbl.schema {
            Some(s) if !s.is_empty() => format!("{}.{}", s, tbl.name),
            _ => tbl.name.clone(),
        };
        match tbl.status {
            DiffStatus::Added => {
                // Views are diffed by their column list (that's all the schema
                // tree exposes), so the generated DDL is a CREATE TABLE — it
                // cannot reproduce the view's SELECT. Flag it instead of
                // silently emitting the wrong object kind.
                if tbl.object_type == "view" {
                    warnings.push(format!(
                        "`{}` is a VIEW in the source. The generated CREATE TABLE cannot reproduce its definition — create the view manually.",
                        qualified
                    ));
                }
                // Whole table missing in target → CREATE TABLE.
                statements.push(SyncStatement {
                    operation: SyncOperation::CreateTable,
                    description: format!("Create table `{}`", qualified),
                    sql: build_create_table(&target_engine, tbl),
                    target_object: qualified.clone(),
                });
            }
            DiffStatus::Removed => {
                // Table only in target → DROP to match source. Destructive,
                // so it's generated but flagged with a warning; the UI marks
                // it for explicit review.
                let drop_sql = build_drop_table(&target_engine, &tbl.schema, &tbl.name);
                if tbl.object_type == "view" {
                    warnings.push(format!(
                        "`{}` is a VIEW in the target. DROP TABLE will not remove it — use DROP VIEW manually.",
                        qualified
                    ));
                }
                warnings.push(format!(
                    "DROP TABLE `{}` is destructive and will delete all its data. Review carefully before applying.",
                    qualified
                ));
                statements.push(SyncStatement {
                    operation: SyncOperation::DropTable,
                    description: format!("Drop table `{}` (only in target)", qualified),
                    sql: drop_sql,
                    target_object: qualified.clone(),
                });
            }
            DiffStatus::Modified => {
                for col in &tbl.columns {
                    match col.status {
                        DiffStatus::Added => {
                            statements.push(SyncStatement {
                                operation: SyncOperation::AddColumn,
                                description: format!("Add column `{}` to `{}`", col.name, qualified),
                                sql: build_add_column(&target_engine, &tbl.schema, &tbl.name, col),
                                target_object: qualified.clone(),
                            });
                        }
                        DiffStatus::Removed => {
                            statements.push(SyncStatement {
                                operation: SyncOperation::DropColumn,
                                description: format!(
                                    "Drop column `{}` from `{}` (only in target)",
                                    col.name, qualified
                                ),
                                sql: build_drop_column(&target_engine, &tbl.schema, &tbl.name, &col.name),
                                target_object: qualified.clone(),
                            });
                        }
                        DiffStatus::Modified => {
                            match build_alter_column(&target_engine, &tbl.schema, &tbl.name, col) {
                                Some(sql) => statements.push(SyncStatement {
                                    operation: SyncOperation::AlterColumn,
                                    description: format!(
                                        "Alter column `{}` on `{}`: {}",
                                        col.name,
                                        qualified,
                                        col.change_description.clone().unwrap_or_default()
                                    ),
                                    sql,
                                    target_object: qualified.clone(),
                                }),
                                None => {
                                    can_apply = false;
                                    warnings.push(format!(
                                        "Column `{}.{}` changed in a way the {} engine can't ALTER in place. Apply this manually.",
                                        qualified, col.name, target_engine
                                    ));
                                }
                            }
                        }
                        DiffStatus::Unchanged => {}
                    }
                }
            }
            DiffStatus::Unchanged => {}
        }
    }

    Ok(SyncScript {
        target_engine,
        statements,
        can_apply,
        warnings,
    })
}

fn quote_ident(engine: &str, name: &str) -> String {
    if super::engine::is_mysql_family(engine) {
        format!("`{}`", name.replace('`', "``"))
    } else if super::engine::is_mssql(engine) {
        format!("[{}]", name.replace(']', "]]"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn qualify(engine: &str, schema: &Option<String>, table: &str) -> String {
    // For SQL Server, `schema` here is the Explorer group name — a whole
    // DATABASE (see fetch_table_snapshot_mssql / run_ddl_mssql), not a T-SQL
    // schema. `database.table` isn't valid T-SQL, so leave it unqualified —
    // the connection is pointed at the right database via `effective_db`
    // before the statement runs, and it resolves against that DB's `dbo`.
    if super::engine::is_mssql(engine) {
        return quote_ident(engine, table);
    }
    match schema {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(engine, s),
            quote_ident(engine, table)
        ),
        _ => quote_ident(engine, table),
    }
}

fn column_def(engine: &str, col: &ColumnDiff) -> String {
    let ty = col.data_type.clone().unwrap_or_else(|| "TEXT".to_string());
    let mut parts = vec![quote_ident(engine, &col.name), ty];
    if col.is_primary_key == Some(true) {
        parts.push("PRIMARY KEY".to_string());
    } else if col.is_nullable == Some(false) {
        parts.push("NOT NULL".to_string());
    }
    parts.join(" ")
}

fn build_create_table(engine: &str, tbl: &TableDiff) -> String {
    let qname = qualify(engine, &tbl.schema, &tbl.name);
    let cols: Vec<String> = tbl
        .columns
        .iter()
        .map(|c| format!("  {}", column_def(engine, c)))
        .collect();
    format!("CREATE TABLE {} (\n{}\n);", qname, cols.join(",\n"))
}

fn build_drop_table(engine: &str, schema: &Option<String>, table: &str) -> String {
    format!("DROP TABLE IF EXISTS {};", qualify(engine, schema, table))
}

fn build_add_column(
    engine: &str,
    schema: &Option<String>,
    table: &str,
    col: &ColumnDiff,
) -> String {
    // T-SQL's ADD clause takes the column definition directly — no COLUMN keyword.
    let verb = if super::engine::is_mssql(engine) { "ADD" } else { "ADD COLUMN" };
    format!(
        "ALTER TABLE {} {} {};",
        qualify(engine, schema, table),
        verb,
        column_def(engine, col)
    )
}

fn build_drop_column(engine: &str, schema: &Option<String>, table: &str, col: &str) -> String {
    format!(
        "ALTER TABLE {} DROP COLUMN {};",
        qualify(engine, schema, table),
        quote_ident(engine, col)
    )
}

/// Generate an ALTER COLUMN statement, or None when the engine doesn't
/// support the change in place (e.g. SQLite can't ALTER column type).
fn build_alter_column(
    engine: &str,
    schema: &Option<String>,
    table: &str,
    col: &ColumnDiff,
) -> Option<String> {
    let qname = qualify(engine, schema, table);
    let qcol = quote_ident(engine, &col.name);
    let ty = col.data_type.clone().unwrap_or_else(|| "TEXT".to_string());

    match super::engine::engine_family(engine) {
        super::engine::EngineFamily::Postgres => {
            // Postgres supports a single combined ALTER ... SET DATA TYPE ...
            // [SET/DROP NOT NULL].
            let mut clauses = vec![format!("{} TYPE {}", qcol, ty)];
            match (col.source_is_nullable, col.is_nullable) {
                (Some(false), Some(true)) => clauses.push("DROP NOT NULL".to_string()),
                (Some(true), Some(false)) => clauses.push("SET NOT NULL".to_string()),
                _ => {}
            }
            Some(format!(
                "ALTER TABLE {} ALTER COLUMN {};",
                qname,
                clauses.join(", ")
            ))
        }
        super::engine::EngineFamily::Mysql => {
            // MySQL re-specifies the whole column with MODIFY.
            let null = if col.is_nullable == Some(false) {
                " NOT NULL"
            } else {
                ""
            };
            Some(format!(
                "ALTER TABLE {} MODIFY COLUMN {} {}{};",
                qname, qcol, ty, null
            ))
        }
        super::engine::EngineFamily::Sqlite => {
            // SQLite only supports ADD COLUMN / RENAME COLUMN / DROP COLUMN
            // (since 3.35). Type/nullability changes require the
            // table-rebuild dance, which we deliberately don't auto-generate.
            None
        }
        super::engine::EngineFamily::Duckdb => {
            // DuckDB supports ALTER COLUMN SET DATA TYPE + SET/DROP NOT NULL
            // (syntax close to Postgres).
            let mut clauses = vec![format!("{} SET DATA TYPE {}", qcol, ty)];
            match (col.source_is_nullable, col.is_nullable) {
                (Some(false), Some(true)) => clauses.push("DROP NOT NULL".to_string()),
                (Some(true), Some(false)) => clauses.push("SET NOT NULL".to_string()),
                _ => {}
            }
            Some(format!(
                "ALTER TABLE {} ALTER COLUMN {};",
                qname,
                clauses.join(", ")
            ))
        }
        super::engine::EngineFamily::Mssql => {
            // T-SQL combines type + nullability into one ALTER COLUMN
            // statement, and always requires an explicit NULL/NOT NULL.
            let null = if col.is_nullable == Some(false) { "NOT NULL" } else { "NULL" };
            Some(format!("ALTER TABLE {} ALTER COLUMN {} {} {};", qname, qcol, ty, null))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub applied: u64,
    pub failed: u64,
    pub errors: Vec<String>,
    pub duration_ms: u64,
}

/// Apply a generated sync script to the **target only**. Each statement runs
/// independently (DDL usually can't be wrapped in a single transaction across
/// engines); failures are collected but don't abort the whole run, so a single
/// bad statement doesn't leave the rest un-applied.
///
/// Safety: `confirm_token` MUST equal the target's database name (or SQLite
/// file basename). This mirrors the type-to-confirm dialog in the UI and
/// guards against accidentally applying to the wrong connection.
#[tauri::command]
pub async fn apply_schema_sync(
    target: ConnectionConfig,
    statements: Vec<SyncStatement>,
    confirm_token: String,
) -> Result<ApplyResult, String> {
    // --- Safety gate: confirm token ----------------------------------------
    let expected = expected_confirm_token(&target);
    if !expected.eq_ignore_ascii_case(confirm_token.trim()) {
        return Err(DbError::app(format!(
            "Confirmation token does not match the target database name (\"{}\"). \
             Sync aborted — nothing was written.",
            expected
        ))
        .to_json_string());
    }

    let start = Instant::now();
    let engine = target.engine.to_lowercase();
    let mut applied: u64 = 0;
    let mut failed: u64 = 0;
    let mut errors: Vec<String> = Vec::new();

    for stmt in &statements {
        let sql = stmt.sql.trim();
        if sql.is_empty() {
            continue;
        }
        let res = run_ddl(&target, &engine, sql).await;
        match res {
            Ok(_) => applied += 1,
            Err(e) => {
                failed += 1;
                errors.push(format!("{} — {}", stmt.description, e));
            }
        }
    }

    Ok(ApplyResult {
        applied,
        failed,
        errors,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// The string the user must type to confirm an apply. Postgres/MySQL use the
/// database name; SQLite uses the file basename (no extension); D1 uses the
/// database id.
fn expected_confirm_token(config: &ConnectionConfig) -> String {
    let engine = config.engine.to_lowercase();
    if engine == "cloudflare-d1" || engine == "d1" {
        return config
            .cf_database_id
            .clone()
            .unwrap_or_else(|| "d1".to_string());
    }
    match super::engine::engine_family(&engine) {
        super::engine::EngineFamily::Sqlite | super::engine::EngineFamily::Duckdb => {
            let path = config.file_path.clone().unwrap_or_default();
            std::path::Path::new(&path)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone())
        }
        // Postgres / MySQL use the database name.
        _ => effective_db(config).unwrap_or_else(|| config.name.clone()),
    }
}

/// Execute a single DDL statement against the target. Returns the structured
/// error string on failure so the caller can collect it.
async fn run_ddl(config: &ConnectionConfig, engine: &str, sql: &str) -> Result<(), String> {
    match super::engine::engine_family(engine) {
        super::engine::EngineFamily::Sqlite => run_ddl_sqlite(config, sql),
        super::engine::EngineFamily::Duckdb => run_ddl_duckdb(config, sql),
        super::engine::EngineFamily::Postgres => run_ddl_postgres(config, sql).await,
        super::engine::EngineFamily::Mysql => run_ddl_mysql(config, sql).await,
        super::engine::EngineFamily::Mssql => run_ddl_mssql(config, sql).await,
    }
}

/// Execute a DDL statement against SQL Server, connected to `effective_db`
/// (the Compare tool's scoped database, or the connection's configured one)
/// — mirrors `run_ddl_mysql`'s USE-context pattern.
async fn run_ddl_mssql(config: &ConnectionConfig, sql: &str) -> Result<(), String> {
    let db_config = ConnectionConfig {
        database: effective_db(config),
        ..config.clone()
    };
    super::mssql::run_mssql_query(&db_config, sql).await?;
    Ok(())
}

fn run_ddl_sqlite(config: &ConnectionConfig, sql: &str) -> Result<(), String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("SQLite file path is empty.".to_string());
    }
    let conn = SqliteConn::open(&path).map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;
    conn.execute(sql, [])
        .map_err(|e| from_sqlite(e, Some(sql)).to_json_string())?;
    Ok(())
}

/// Read up to `DATA_COMPARE_LIMIT` rows from a DuckDB table for the data-diff
/// view. PK columns drive a stable row ordering when available.
fn fetch_table_snapshot_duckdb(
    config: &ConnectionConfig,
    schema: Option<&str>,
    table: &str,
) -> Result<TableSnapshot, String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("DuckDB file path is empty.".to_string());
    }
    let conn = DuckdbConn::open(&path).map_err(|e| from_duckdb(e, None).to_json_string())?;

    let qualified = match schema {
        Some(s) if !s.is_empty() => format!(
            "\"{}\".\"{}\"",
            s.replace('"', "\"\""),
            table.replace('"', "\"\"")
        ),
        _ => format!("\"{}\"", table.replace('"', "\"\"")),
    };

    // PK columns via information_schema.
    let mut pk_cols: Vec<String> = Vec::new();
    let pk_sql = format!(
        "SELECT k.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k
           ON k.constraint_name = tc.constraint_name
          AND k.table_schema = tc.table_schema
          AND k.table_name = tc.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_name = '{}' AND COALESCE(tc.table_schema, 'main') = '{}'",
        table.replace('\'', "''"),
        schema.unwrap_or("main").replace('\'', "''"),
    );
    if let Ok(mut s) = conn.prepare(&pk_sql) {
        if let Ok(rows) = s.query_map([], |r| r.get::<_, String>(0)) {
            for r in rows.flatten() {
                pk_cols.push(r);
            }
        }
    }

    let sql = if pk_cols.is_empty() {
        format!("SELECT * FROM {} LIMIT {}", qualified, DATA_COMPARE_LIMIT)
    } else {
        let order = pk_cols
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        format!("SELECT * FROM {} ORDER BY {} LIMIT {}", qualified, order, DATA_COMPARE_LIMIT)
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| from_duckdb(e, Some(&sql)).to_json_string())?;
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();

    let rows_iter = stmt
        .query_map([], |row| {
            let mut vals = Vec::with_capacity(col_names.len());
            for i in 0..col_names.len() {
                let v: duckdb::types::Value = row.get(i).unwrap_or(duckdb::types::Value::Null);
                vals.push(v);
            }
            Ok(vals)
        })
        .map_err(|e| from_duckdb(e, Some(&sql)).to_json_string())?;

    let mut rows_data = Vec::new();
    for row in rows_iter {
        let vals = row.map_err(|e| from_duckdb(e, Some(&sql)).to_json_string())?;
        rows_data.push(vals.into_iter().map(super::duckdb::duckdb_value_to_json).collect());
    }

    Ok(snapshot_from_rows(col_names, pk_cols, rows_data))
}

/// Execute a DDL statement against a DuckDB file.
fn run_ddl_duckdb(config: &ConnectionConfig, sql: &str) -> Result<(), String> {
    let path = config.file_path.clone().unwrap_or_default();
    if path.is_empty() {
        return Err("DuckDB file path is empty.".to_string());
    }
    let conn = DuckdbConn::open(&path).map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;
    conn.execute(sql, duckdb::params![])
        .map_err(|e| from_duckdb(e, Some(sql)).to_json_string())?;
    Ok(())
}

async fn run_ddl_postgres(config: &ConnectionConfig, sql: &str) -> Result<(), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(5432);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "postgres".to_string());
    let db = config.database.clone().unwrap_or_else(|| "postgres".to_string());
    let pass = config.password.clone().unwrap_or_default();

    let conn_str = format!(
        "host={} port={} user={} dbname={} password={}",
        host, port, user, db, pass
    );
    let (client, connection) = match tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_postgres::connect(&conn_str, NoTls),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            let mut d = from_postgres(e, Some(sql));
            d.kind = super::error::ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => return Err(DbError::connection(format!(
            "PostgreSQL connection timed out after {}s",
            CONNECT_TIMEOUT.as_secs()
        ))
        .to_json_string()),
    };
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("PostgreSQL connection error: {}", e);
        }
    });

    client
        .execute(sql, &[])
        .await
        .map_err(|e| from_postgres(e, Some(sql)).to_json_string())?;
    Ok(())
}

async fn run_ddl_mysql(config: &ConnectionConfig, sql: &str) -> Result<(), String> {
    let host = normalize_host(config.host.clone());
    let port = config.port.unwrap_or(3306);
    let (host, port) = super::ssh_tunnel::resolve_target(config, host, port).await?;
    let user = config.username.clone().unwrap_or_else(|| "root".to_string());
    let db = effective_db(config);
    let pass = config.password.clone().unwrap_or_default();

    let opts = mysql_opts(host.clone(), port, user, pass, db);
    let pool = mysql_async::Pool::new(opts);
    let mut conn = match tokio::time::timeout(CONNECT_TIMEOUT, pool.get_conn()).await {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => {
            let mut d: DbError = from_mysql(e, Some(sql)).into();
            d.kind = super::error::ErrorKind::Connection;
            return Err(d.to_json_string());
        }
        Err(_) => return Err(DbError::connection(format!(
            "MySQL connection timed out after {}s",
            CONNECT_TIMEOUT.as_secs()
        ))
        .to_json_string()),
    };

    conn.query_drop(sql)
        .await
        .map_err(|e| from_mysql(e, Some(sql)).0.to_json_string())?;
    drop(conn);
    let _ = pool.disconnect().await;
    Ok(())
}
