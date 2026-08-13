# Getting Started with rdSQL Desktop

## Purpose

Install rdSQL Desktop and get to a working connection in a few minutes.

## Requirements

- macOS, Windows, or Linux
- A database to connect to (or use SQLite/DuckDB, which need nothing extra —
  see [`connect-sqlite.md`](connect-sqlite.md))

## Steps

1. **Download** the installer for your platform from
   [rdsql.com/download](https://rdsql.com/download) or the
   [GitHub Releases](https://github.com/rdsqlhq/rdsql/releases) page.
2. **Install and launch** the app.
   - macOS: if you see *"app is damaged"* or *"unidentified developer"*, run
     `xattr -cr /Applications/rdSQL.app` — the build isn't Apple-notarized yet.
   - Windows: SmartScreen may warn about an unsigned app; choose "Run anyway".
3. **Create your first connection** — click **New Connection**, pick a
   **Database Engine**, fill in the connection details (see the per-engine
   guides below), and click **Save** (or **Test** first to confirm it connects).
4. **Run a query** — select the new connection, open a SQL editor tab, and
   run a query. See [`sql-editor.md`](sql-editor.md).
5. **(Optional) Sign in** for cross-device sync of connections and encrypted
   credentials, from the account/settings panel.

## Expected result

Your connection appears in the sidebar, and you can browse its schema and
run queries against it.

## Troubleshooting

- **Connection fails immediately** — double check host/port/credentials, and
  whether the database requires SSL (`SSL Mode`) or is only reachable through
  an SSH bastion (`Security & SSH` tab).
- **App won't open on macOS/Windows** — see the notarization/SmartScreen notes
  above; these are cosmetic OS warnings, not a broken build.

## See also

- [Connect to PostgreSQL](connect-postgresql.md)
- [Connect to MySQL / MariaDB](connect-mysql.md)
- [Connect to SQLite / DuckDB](connect-sqlite.md)
- [The SQL Editor](sql-editor.md)
