# Changelog

All notable changes to rdSQL Desktop are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.1.0] - 2026-08-12

### Added
- **Account sign-in and encrypted cross-device sync** — connections and credentials sync
  end-to-end encrypted across devices, with device pairing (pair a new device via a short
  pairing code) and per-device management (rename/revoke) from Settings → Account.
- **Opt-in usage analytics** — lightweight, anonymous event tracking to help prioritize what
  to build next.
- ERD Studio: table detail drawer for inspecting a table's columns/keys without leaving the
  diagram.
- Storage browser: object detail panel for S3/R2/MinIO objects.
- Table explorer: row inspector panel for viewing a single row's full contents.
- SQL core: trigger introspection support.

### Fixed
- Connections with a stale tag reference (the tag was deleted, or the connection was
  imported from another device without that tag's definition) were disappearing from the
  Explorer entirely instead of falling back to the "untagged" bucket — the Explorer only
  ever rendered the *first* untagged folder it found, so a phantom stale-tag folder ahead of
  the real one hid every genuinely untagged connection, including freshly-added SQLite and
  imported S3 connections.
- Cloudflare D1: `PRAGMA table_info` columns could be silently swapped (e.g. a column's name
  and type mixed up) because they were read by fixed array position while the underlying
  `serde_json::Map` sorts keys alphabetically rather than preserving PRAGMA's declared order.
- Resolved a `mysql_async` future-incompatibility warning.
- Fixed a build failure on Linux/Windows: `RunEvent::Opened` only exists on macOS/iOS in
  Tauri 2.x, but was being matched unconditionally — this broke both CI and Windows release
  builds. Now correctly platform-gated.

### Changed
- Various UI refinements across the SQL editor, table data view, AI assistant panel, and
  global SQL log.

## [1.0.0] - 2026-08-09

Initial public release. Native database workspace (Tauri v2 + Rust, React 19 + TypeScript)
with SQL editor, table explorer, Visual ERD Studio, Migration Studio, native backup/restore,
S3-compatible object storage browser, and an AI assistant for SQL generation, query
optimization, and schema explanation. Multi-engine support: PostgreSQL, MySQL, MariaDB,
SQLite, DuckDB, Cloudflare D1, CockroachDB, YugabyteDB, TiDB, PlanetScale.
