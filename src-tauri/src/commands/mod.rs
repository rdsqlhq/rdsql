pub mod error;
// Engine family resolution + per-engine metadata. Single source of truth for
// collapsing wire-compatible aliases (mariadb→mysql, cockroachdb→postgres, …).
pub mod engine;
pub mod connection;
pub mod query;
// SSH tunnel / jump-server support, shared by every networked engine
// (Postgres, MySQL, SQL Server, Redis). `ConnectionConfig`'s `ssh` field
// lives in connection.rs, but the tunneling logic itself is isolated here.
pub mod ssh_tunnel;
pub mod pool;
pub mod transfer;
pub mod storage;
pub mod ai;
pub mod d1;
// DuckDB embedded analytical engine (own driver crate + SQL dialect).
pub mod duckdb;
// Microsoft SQL Server (own wire protocol — TDS, via the `tiberius` crate).
pub mod mssql;
pub mod health;
pub mod compare;
pub mod updater;
// Isolated S3-compatible storage provider (AWS S3, R2, MinIO, B2, …).
// Purely additive — no existing command depends on it.
pub mod s3;
// Redis / Valkey key-value store (isolated module: browsing + basic value
// editing). Reuses `connection::ConnectionConfig` for the connection itself,
// but its data/result types are its own — Redis has no schema/columns.
pub mod redis;
// MongoDB document store (isolated module: browsing + basic document CRUD).
// Reuses `connection::ConnectionConfig`; its schema tree (database →
// collection) is real, but document results are plain JSON, not
// `QueryResultData` — see commands::mongo's module doc. Named `mongo`, not
// `mongodb`, to avoid an identifier clash with the `mongodb` crate.
pub mod mongo;
// rdSQL Cloudflare backend: accounts, OAuth device-linking, pairing,
// entitlement, encrypted connection sync. See commands::backend's module doc.
pub mod backend;
// Cross-engine database migration wizard (isolated module; all commands are
// additive). See `migrate::canonical`'s module doc for the design.
pub mod migrate;
