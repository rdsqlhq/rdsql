# Connect to SQLite, DuckDB, or Cloudflare D1

## Purpose

Add a local file-based connection (SQLite, DuckDB) or a Cloudflare D1
connection — no network database server required for the first two.

## Requirements

- SQLite / DuckDB: a `.db`/`.sqlite`/`.duckdb` file on disk (or create a new one)
- Cloudflare D1: a Cloudflare **Account ID**, an **API token** with D1
  read/write scope, and the D1 **Database ID or name**

## Steps — SQLite / DuckDB

1. Click **New Connection**.
2. Set a **Connection Name** and choose **SQLite** or **DuckDB** as the
   **Database Engine**.
3. In **Database File Path**, either browse to an existing file or point at a
   path to create a new database.
4. Click **Save** — there's nothing to "test" over the network; the file is
   opened directly.

## Steps — Cloudflare D1

1. Click **New Connection**.
2. Set a **Connection Name** and choose **Cloudflare D1** as the
   **Database Engine**.
3. Fill in your Cloudflare **Account ID**, **API token**, and the D1
   **Database ID / Name**.
4. Click **Test**, then **Save**.

## Expected result

The connection appears in the sidebar with its tables ready to browse and
query, same as any other engine.

## Troubleshooting

- **File not found** — SQLite/DuckDB paths are resolved on your machine; if
  the file lives on a network share, make sure it's mounted before opening it.
- **D1 auth error** — confirm the API token has D1 permissions and hasn't
  expired; the Account ID and Database ID are both found in the Cloudflare
  dashboard URL for that database.
