//! Cross-engine database migration wizard (MySQL/PostgreSQL/SQL Server as a
//! source; PostgreSQL/MySQL as a target). See `orchestrator`'s module doc
//! for the supported directions and `canonical`'s for why a canonical
//! type/value layer sits between every source and target adapter instead of
//! one module per (source, target) pair.

pub mod canonical;
pub mod orchestrator;
pub mod source_mssql;
pub mod source_mysql;
pub mod source_postgres;
pub mod target_mysql;
pub mod target_postgres;

// A glob re-export (not a named one) so the hidden trampoline items
// `#[tauri::command]` generates alongside each command function — which
// `tauri::generate_handler!` in `lib.rs` also needs to resolve at
// `commands::migrate::<name>` — come along with it.
pub use orchestrator::*;
