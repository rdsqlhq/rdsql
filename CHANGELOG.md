# Changelog

All notable changes to rdSQL Desktop are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

## [1.2.0] - 2026-10-25

### Added
- **Neon** as a database engine. Pasting a `*.neon.tech` URL picks it, and SSL is required by
  default. PostgreSQL and Neon connections can back up into each other.
- Help menu and About dialog: **Star on GitHub** and **Sponsor** links.
- An end-to-end suite (`e2e/backup`, `make e2e-backup` / `make e2e-backup-all`) that runs the
  real Backup, Restore and Migrate screens against PostgreSQL, MySQL, MariaDB, SQLite,
  DuckDB, CockroachDB, YugabyteDB, TiDB and SQL Server in Docker, and checks every copy row
  for row.

### Fixed
- **Backup and restore**
  - Restore into Neon, RDS, Supabase and other managed Postgres no longer stops at the first
    line: switching FK checks off needs superuser, so it is now skipped with a note.
  - Backup into another Postgres connection connected to a database named after the schema
    (e.g. `public`). The target picker now chooses a schema, and works when the target
    database is empty.
  - Backup "Fast" mode failed on Postgres and CockroachDB (several statements per call), and
    on SQLite silently kept only the first statement of each batch, about 4% of the rows.
  - Values that came out empty or wrong in backups: Postgres json/jsonb/bytea/interval/inet/
    money/bit/xml; MySQL, SQLite, DuckDB and SQL Server binary data; integers above 2^53.
  - The copy now keeps column defaults, serial/identity sequences, AUTO_INCREMENT and enum
    types, so the application can keep inserting rows. Views are no longer copied as tables.
  - SQL Server backups work: valid table definitions with lengths, IDENTITY columns,
    unicode text, exact dates, money and floats.
- **Migrate Database**: the Run step never showed the Run button; Postgres → MySQL failed on
  timezone columns; migrating from SQL Server failed to find tables and could crash.
- **CockroachDB**: the schema tree failed to load and could leave the window stuck on
  "Loading schema…".
- **SQL Server**: `SET`, `USE` and `#temp` tables now carry over between statements on the
  same connection, in the editor too.
- The data grid shows json/jsonb, oid and xml values instead of NULL.

### Removed
- Cloud sync is hidden for now; nothing in the UI offers or advertises it.

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
