//! Smoke test for DuckDB engine support against a real `.duckdb` file.
//!
//! Usage:
//!   cargo run --example duckdb_probe -- /path/to/file.duckdb
//!
//! Verifies: open, version, table listing, column listing, row count, and a
//! sample SELECT (cell → JSON conversion).

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let path = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("Usage: duckdb_probe <path-to-file.duckdb>");
        std::process::exit(1);
    });

    println!("Opening DuckDB file: {}", path);
    let conn = match duckdb::Connection::open(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("OPEN FAILED: {:?}", e);
            std::process::exit(1);
        }
    };

    // ── Version ──
    let version: String = conn
        .query_row("SELECT version()", [], |r| r.get(0))
        .unwrap_or_else(|_| "unknown".to_string());
    println!("DuckDB version: {}", version);

    // ── Tables ──
    println!("\nTables:");
    {
        let mut stmt = conn
            .prepare(
                "SELECT table_schema, table_name, table_type
                 FROM information_schema.tables
                 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                 ORDER BY table_schema, table_name",
            )
            .expect("prepare tables query");
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .expect("query tables");
        for row in rows.flatten() {
            let (schema, name, typ) = row;
            println!("  {}.{}  [{}]", schema, name, typ);
        }
    }

    // ── Columns for each table ──
    println!("\nColumns:");
    {
        let mut stmt = conn
            .prepare(
                "SELECT table_name, column_name, data_type, is_nullable
                 FROM information_schema.columns
                 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                 ORDER BY table_name, ordinal_position",
            )
            .expect("prepare columns query");
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .expect("query columns");
        let mut current_table = String::new();
        for row in rows.flatten() {
            let (table, col, ty, nullable) = row;
            if table != current_table {
                println!("  {}:", table);
                current_table = table;
            }
            println!("    {} {} [nullable={}]", col, ty, nullable);
        }
    }

    // ── Sample query: first table, LIMIT 5 ──
    println!("\nSample data (first table, 5 rows):");
    {
        let first_table: Option<String> = conn
            .query_row(
                "SELECT table_name FROM information_schema.tables
                 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                   AND table_type = 'BASE TABLE'
                 ORDER BY table_name LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();

        if let Some(table) = first_table {
            let sql = format!("SELECT * FROM \"{}\" LIMIT 5", table);
            println!("  SQL: {}", sql);
            let mut stmt = conn.prepare(&sql).expect("prepare sample query");
            // DuckDB requires explicit execution before any column metadata
            // (column_count, column_name, column_type) is available.
            stmt.execute([]).expect("execute sample query");
            let col_count = stmt.column_count();
            // Collect rows, then read column metadata.
            let collected: Vec<Vec<duckdb::types::Value>> = stmt
                .query_map([], |row| {
                    let mut vals = Vec::with_capacity(col_count);
                    for i in 0..col_count {
                        let v: duckdb::types::Value = row.get(i).unwrap_or(duckdb::types::Value::Null);
                        vals.push(v);
                    }
                    Ok(vals)
                })
                .expect("query sample")
                .flatten()
                .collect();
            let names: Vec<String> = (0..col_count)
                .map(|i| stmt.column_name(i).map(|s| s.to_string()).unwrap_or_default())
                .collect();
            println!("  Columns: {}", names.join(", "));
            for (ri, vals) in collected.iter().enumerate() {
                let rendered: Vec<String> = vals
                    .iter()
                    .map(|v| match v {
                        duckdb::types::Value::Null => "NULL".to_string(),
                        duckdb::types::Value::Int(n) => n.to_string(),
                        duckdb::types::Value::BigInt(n) => n.to_string(),
                        duckdb::types::Value::Double(f) => format!("{:.2}", f),
                        duckdb::types::Value::Text(s) => format!("{:?}", s),
                        other => format!("{:?}", other),
                    })
                    .collect();
                println!("  row {}: {}", ri, rendered.join(", "));
            }
        } else {
            println!("  (no base tables found)");
        }
    }

    // ── Row count ──
    println!("\nRow counts:");
    {
        let mut stmt = conn
            .prepare(
                "SELECT table_name FROM information_schema.tables
                 WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                   AND table_type = 'BASE TABLE'
                 ORDER BY table_name",
            )
            .expect("prepare count query");
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .expect("query count")
            .flatten()
            .collect();
        for t in tables {
            let count: i64 = conn
                .query_row(&format!("SELECT count(*) FROM \"{}\"", t), [], |r| r.get(0))
                .unwrap_or(-1);
            println!("  {}: {} rows", t, count);
        }
    }

    println!("\n✓ DuckDB probe completed successfully");
}
