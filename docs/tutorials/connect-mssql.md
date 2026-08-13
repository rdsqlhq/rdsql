# Connect to Microsoft SQL Server

## Purpose

Add a SQL Server connection. rdSQL speaks TDS directly (no ODBC driver
required) and browses every database on the server from a single connection,
the same way it does for MySQL.

## Requirements

- Host, port (default `1433`), username, and password (SQL Server
  authentication — Windows/AD authentication isn't supported yet)
- Optionally a specific starting database name

## Steps

1. Click **New Connection**.
2. Set a **Connection Name** and choose **SQL Server** as the **Database
   Engine**.
3. Fill in **Host**, **Port**, **Database** (optional), **Username**,
   **Password**.
4. Set **SSL Mode**: `require` connects with TLS and trusts the server's
   certificate (the common case for local/dev SQL Server and its default
   self-signed cert); `disable` turns encryption off entirely.
5. Click **Test**, then **Save**.

## Expected result

The connection appears in the sidebar. Like MySQL, one connection can see
every database on the server — system databases (`master`, `tempdb`,
`model`, `msdb`) are hidden by default; enable **Show system schemas** in
the connection's Security tab to reveal them alongside `sys` and
`INFORMATION_SCHEMA`. Tables in non-`dbo` schemas are shown as
`schema.table` in the tree.

## Troubleshooting

- **Login failed for user** — confirm SQL Server authentication is enabled
  on the server (not Windows-auth-only) and the login has a database mapped.
- **Connection timed out** — check the server is listening on the TCP port
  you configured (`1433` by default) and not blocked by a firewall; SQL
  Server's dynamic-port SQL Browser service (UDP 1434) isn't used by rdSQL.
- **Certificate / TLS errors** — set **SSL Mode** to `require`, which trusts
  the server's certificate automatically (matches `TrustServerCertificate`
  in other SQL Server clients).

## Known limitations (current release)

Compare & Sync, the Health Monitor, Users & Privileges, Migration Studio,
and the Views/Triggers/Procedures/Events object editor don't support SQL
Server yet — core browsing, querying, and table/database DDL are fully
supported.
