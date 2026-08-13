//! Engine family resolution and per-engine metadata.
//!
//! The app speaks a handful of wire protocols (PostgreSQL, MySQL, SQLite) but
//! supports several databases per protocol — each is wire-compatible and reuses
//! the same driver crate, only the connection string / default port / display
//! label differs. Rather than scattering `"postgres" | "postgresql" | "cockroachdb"`
//! lists across every `match engine.as_str()` arm, every command asks this
//! module for the engine's family and dispatches on that.
//!
//! Adding a new wire-compatible database is a one-line change here plus a UI
//! entry — no new match arms in the command layer.

/// The wire-protocol / driver families the backend actually implements.
/// DuckDB has its own crate (`duckdb`) and SQL dialect — it is not part of the
/// SQLite family despite both being embedded/file-based. SQL Server speaks its
/// own protocol (TDS, via the `tiberius` crate) — also its own family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineFamily {
    Postgres,
    Mysql,
    Sqlite,
    Duckdb,
    Mssql,
}

impl EngineFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            EngineFamily::Postgres => "postgres",
            EngineFamily::Mysql => "mysql",
            EngineFamily::Sqlite => "sqlite",
            EngineFamily::Duckdb => "duckdb",
            EngineFamily::Mssql => "mssql",
        }
    }
}

/// Resolve a raw engine string (as stored on `ConnectionConfig.engine`) into
/// its wire-protocol family. Comparison is ASCII-case-insensitive.
///
/// Known engines per family:
/// - **Postgres**: `postgres`, `postgresql`, `cockroachdb`, `yugabytedb`
/// - **MySQL**:    `mysql`, `mariadb`, `tidb`, `planetscale`
/// - **SQLite**:   `sqlite`, `cloudflare-d1`, `d1`
/// - **DuckDB**:   `duckdb`
/// - **SQL Server**: `mssql`, `sqlserver`, `azuresql`
pub fn engine_family(engine: &str) -> EngineFamily {
    match engine.to_lowercase().as_str() {
        "postgres" | "postgresql" | "cockroachdb" | "yugabytedb" => EngineFamily::Postgres,
        "mysql" | "mariadb" | "tidb" | "planetscale" => EngineFamily::Mysql,
        "duckdb" => EngineFamily::Duckdb,
        "mssql" | "sqlserver" | "azuresql" => EngineFamily::Mssql,
        // Everything else (sqlite, cloudflare-d1, d1) is treated as the SQLite family.
        _ => EngineFamily::Sqlite,
    }
}

/// Convenience: does `engine` belong to the Postgres wire family?
pub fn is_postgres(engine: &str) -> bool {
    engine_family(engine) == EngineFamily::Postgres
}

/// Convenience: does `engine` belong to the MySQL wire family?
pub fn is_mysql_family(engine: &str) -> bool {
    engine_family(engine) == EngineFamily::Mysql
}

/// Convenience: is `engine` DuckDB (its own driver family)?
pub fn is_duckdb(engine: &str) -> bool {
    engine_family(engine) == EngineFamily::Duckdb
}

/// Convenience: is `engine` SQL Server (its own driver family)?
pub fn is_mssql(engine: &str) -> bool {
    engine_family(engine) == EngineFamily::Mssql
}

/// Per-engine default TCP port (used when `ConnectionConfig.port` is `None`).
/// File/REST engines (sqlite, cloudflare-d1) return `None`.
pub fn default_port(engine: &str) -> Option<u16> {
    match engine.to_lowercase().as_str() {
        "postgres" | "postgresql" => Some(5432),
        "cockroachdb" => Some(26257),
        "yugabytedb" => Some(5433),
        "mysql" | "mariadb" | "planetscale" => Some(3306),
        "tidb" => Some(4000),
        "mssql" | "sqlserver" | "azuresql" => Some(1433),
        _ => None,
    }
}

/// Normalize an engine string to the canonical family representative. This is
/// the single source of truth for collapsing aliases (e.g. `mariadb` → `mysql`,
/// `cockroachdb` → `postgres`) before any logic that compares two connections'
/// engines for equality — used by Compare & Sync.
pub fn normalize_engine(engine: &str) -> String {
    engine_family(engine).as_str().to_string()
}
