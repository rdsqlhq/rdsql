# Database Explorer

## Purpose

Browse schemas, tables, and columns for a connection without writing SQL,
and inspect/filter table data directly.

## Requirements

- At least one saved connection

## Steps

1. Select a connection in the sidebar — its schemas/tables/views load into a
   tree you can expand.
2. Click a table to open it in a data grid (browse rows without writing a
   `SELECT`).
3. Use the filter drawer to narrow rows by column conditions, without
   hand-writing a `WHERE` clause.
4. Inspect column types, keys, and indexes from the table's structure view.

## Expected result

You can navigate a database's full structure and preview/filter table data
from the tree, independent of the SQL editor.

## Troubleshooting

- **Tree is empty** — the connected user may lack privileges to list schemas;
  check grants on the database user.
- **Large tables load slowly** — the explorer paginates row previews; use the
  SQL editor with an explicit `LIMIT`/index for very large tables.

## See also

- [Visual ERD Studio](erd.md)
- [The SQL Editor](sql-editor.md)
