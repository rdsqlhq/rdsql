# Visual ERD Studio

## Purpose

See a database's tables and foreign-key relationships as an interactive
entity-relationship diagram, and export it.

## Requirements

- A connection to a database with foreign keys (or explore a schema without
  them — tables still render as nodes)

## Steps

1. Select a connection and open **ERD Studio**.
2. The canvas lays out tables as nodes, with relationship lines drawn from
   foreign keys.
3. Drag nodes to rearrange the layout; zoom/pan to navigate large schemas.
4. Click a table node to see its columns, types, and keys.
5. Export the diagram (e.g. as an image) from the ERD toolbar.

## Expected result

A visual map of the schema's tables and how they relate, that you can
rearrange and export.

## Troubleshooting

- **No relationship lines** — the database may not have foreign key
  constraints defined; the ERD reflects actual schema metadata, it doesn't
  infer relationships from naming conventions.
- **Diagram is cluttered on a large schema** — use zoom/pan and drag related
  tables together; there's no auto "focus on subset" filter yet.

## See also

- [Database Explorer](database-explorer.md)
