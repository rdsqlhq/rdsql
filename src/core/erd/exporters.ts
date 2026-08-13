import { SchemaTableNode } from '../domain/types';
import { SchemaGraphModel, RelationshipKind } from './types';
import { buildSchemaGraph } from './schemaGraph';

// ---------------------------------------------------------------------------
// ERD → text format exporters.
//
// These are pure functions (no React, no DOM) so they're trivial to unit-test
// and can be reused from any context (toolbar button, CLI, headless render).
// Each takes the inferred `SchemaGraphModel` (see schemaGraph.ts) plus the raw
// table list and returns a single string ready to save or copy.
// ---------------------------------------------------------------------------

// Mermaid entity names must be alphanumerics — wrap anything else in quotes.
// We keep it simple: quote when there's a character Mermaid's lexer would
// choke on, otherwise emit bare.
function mermaidName(name: string): string {
  return /^[\w]+$/.test(name) ? name : `"${name}"`;
}

// A column's SQL-ish type, normalized for the text exports. The schema tree
// already carries `data_type` straight from the backend; we just strip the
// parens off things like `VARCHAR(255)` → `VARCHAR` for the Mermaid view
// (Mermaid only needs a coarse type label), and leave the full type in DDL.
function coarseType(dataType: string | undefined): string {
  if (!dataType) return 'UNKNOWN';
  // "varchar(255)" → "VARCHAR", "timestamp with time zone" → "TIMESTAMP"
  const base = dataType.split(/[ (]/)[0] || dataType;
  return base.toUpperCase();
}

/**
 * Build a Mermaid `erDiagram` document from the inferred schema graph.
 *
 * Renders every table as an entity with its columns (PK / FK markers on the
 * ones the heuristic flagged), then emits one relationship line per edge.
 * `polymorphic` edges don't have a single resolvable target, so we drop the
 * relationship line and instead add a `note` on the owning table explaining
 * the ambiguity — that's honest about what the heuristic can and can't know.
 *
 * Output is directly pasteable into mermaid.live, GitHub READMEs, Notion, etc.
 */
export function toMermaid(graph: SchemaGraphModel): string {
  const lines: string[] = ['erDiagram', ''];

  // --- Entities -----------------------------------------------------------
  for (const table of graph.tablesByName.values()) {
    lines.push(`  ${mermaidName(table.name)} {`);
    if (table.children.length === 0) {
      lines.push('    %% no columns detected');
    } else {
      for (const col of table.children) {
        const markers: string[] = [];
        if (col.is_primary_key) markers.push('PK');
        if (col.is_foreign_key) markers.push('FK');
        const tail = markers.length ? ` ${markers.join(' ')}` : '';
        // Mermaid's erDiagram column syntax is:  TYPE NAME [PK|FK]
        lines.push(`    ${coarseType(col.data_type)} ${mermaidName(col.name)}${tail}`);
      }
    }
    lines.push('  }');
  }

  // --- Relationships ------------------------------------------------------
  // Dedupe per (source,target) pair — multiple FKs between the same two
  // tables collapse to one relationship line, which is how ER diagrams are
  // conventionally drawn and avoids Mermaid rejecting duplicate lines.
  const seen = new Set<string>();
  const polymorphNotes: string[] = [];

  for (const e of graph.edges) {
    if (e.kind === 'polymorphic') {
      polymorphNotes.push(e.target);
      continue;
    }
    const key = [e.source, e.target].sort().join('→');
    if (seen.has(key)) continue;
    seen.add(key);

    // Self-references (table → itself) are drawn as a loop. Mermaid supports
    // this fine, and the cardinality is by definition zero-or-more.
    // Cardinality heuristic: the FK side (e.target, the table holding the
    // column) is the "many" side; the referenced PK side (e.source) is "one".
    const rel =
      e.kind === 'many-to-many'
        ? `  ${mermaidName(e.source)} }o--o{ ${mermaidName(e.target)} : "has"`
        : `  ${mermaidName(e.source)} ||--o{ ${mermaidName(e.target)} : "${e.targetColumn}"`;
    lines.push(rel);
  }

  // One consolidated polymorphism note rather than spamming one per column.
  const uniquePoly = [...new Set(polymorphNotes)];
  if (uniquePoly.length) {
    lines.push('');
    for (const t of uniquePoly) {
      lines.push(`  note "${mermaidName(t)} has a polymorphic association (a *_type column) — target table is resolved at runtime"`);
    }
  }

  return lines.join('\n') + '\n';
}

// Quote a SQL identifier if it contains characters that need quoting.
// We use double quotes (ANSI / Postgres convention); MySQL users typically
// swap to backticks but the exported DDL is meant to be readable/human-
// reviewable rather than executed verbatim against a specific engine.
function sqlIdent(name: string): string {
  return /^[\w]+$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a best-effort `CREATE TABLE` DDL script from the schema tree.
 *
 * Column types come straight from the backend's `data_type`, so they're
 * already in the right dialect for the connection. PK is declared inline
 * (`column INTEGER PRIMARY KEY`); FKs are gathered into a trailing
 * `FOREIGN KEY (...) REFERENCES ...` block per table. NOT NULL is inferred
 * from `is_nullable === false` (a missing value means "unknown", so we err
 * on the side of not stamping a constraint we can't prove).
 *
 * Views in the schema tree are skipped — they're not tables and we don't
 * have their definitions.
 */
export function toDdl(graph: SchemaGraphModel): string {
  // Index FKs by the table that owns the FK column (graph edge `target`)
  // so we can emit them in the right CREATE TABLE.
  const fksByTable = new Map<string, { column: string; refTable: string; refColumn: string }[]>();
  for (const e of graph.edges) {
    if (e.kind === 'polymorphic') continue; // no single resolvable target
    let arr = fksByTable.get(e.target);
    if (!arr) fksByTable.set(e.target, (arr = []));
    arr.push({ column: e.targetColumn, refTable: e.source, refColumn: e.sourceColumn });
  }

  const blocks: string[] = [];

  for (const table of graph.tablesByName.values()) {
    if (table.node_type === 'view') continue;

    const colLines: string[] = [];
    const pkCols: string[] = [];

    for (const col of table.children) {
      if (col.is_primary_key) pkCols.push(col.name);

      const type = col.data_type || 'TEXT';
      let line = `  ${sqlIdent(col.name)} ${type}`;

      if (col.is_primary_key) {
        // Single-column PK declared inline for readability; multi-col PKs
        // are collected into a table-level constraint below.
        if (pkCols.length === 1) line += ' PRIMARY KEY';
      }
      if (col.is_nullable === false && !col.has_default) {
        line += ' NOT NULL';
      }
      colLines.push(line);
    }

    // Composite primary key (more than one PK column) → table constraint.
    if (pkCols.length > 1) {
      colLines.push(`  PRIMARY KEY (${pkCols.map(sqlIdent).join(', ')})`);
    }

    // Foreign keys for this table.
    const fks = fksByTable.get(table.name) || [];
    // Dedupe identical FKs (the graph can emit one edge per FK column).
    const seenFk = new Set<string>();
    for (const fk of fks) {
      const key = `${fk.column}→${fk.refTable}.${fk.refColumn}`;
      if (seenFk.has(key)) continue;
      seenFk.add(key);
      colLines.push(
        `  FOREIGN KEY (${sqlIdent(fk.column)}) REFERENCES ${sqlIdent(fk.refTable)} (${sqlIdent(fk.refColumn)})`
      );
    }

    blocks.push(`CREATE TABLE ${sqlIdent(table.name)} (\n${colLines.join(',\n')}\n);`);
  }

  return blocks.join('\n\n') + '\n';
}

/** Convenience for callers that only have the table list (builds the graph
 *  internally). Used by the export hook so it doesn't have to thread the
 *  graph through separately. */
export function renderSchemaAs(
  tables: SchemaTableNode[],
  format: 'mermaid' | 'ddl'
): string {
  const graph = buildSchemaGraph(tables);
  return format === 'mermaid' ? toMermaid(graph) : toDdl(graph);
}
