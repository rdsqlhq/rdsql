# The SQL Editor

## Purpose

Write and run SQL against any connected database, and work with the results.

## Requirements

- At least one saved connection (see the `connect-*.md` guides)

## Steps

1. Select a connection in the sidebar and open a new SQL editor tab.
2. Write a query in the editor (Monaco-based, with SQL syntax highlighting).
3. Run it — the results render in a data grid below/beside the editor.
4. From the results grid you can sort, filter, and export data.
5. Open multiple editor tabs to work against different connections or
   databases at once.

## Expected result

Query results appear in a grid, with row/column counts and query timing
shown alongside.

## Troubleshooting

- **Query hangs** — check that the connection is still reachable; long-running
  queries on remote databases can be cancelled from the editor toolbar.
- **Syntax errors** — the editor highlights SQL syntax but doesn't validate
  against your exact schema ahead of time; errors from the database itself
  are shown after running the query.

## See also

- [Database Explorer](database-explorer.md)
