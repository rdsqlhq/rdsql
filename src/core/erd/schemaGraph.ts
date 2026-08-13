import { SchemaTableNode } from '../domain/types';
import { GraphEdgeModel, RelationshipKind, SchemaGraphModel } from './types';

// Best-effort match of a foreign-key-looking column (e.g. "user_id") to a
// table in the same schema (e.g. "users" / "user"). The schema tree we get
// back from the backend doesn't reliably carry FK target metadata, so this
// heuristic carries the whole relationship engine.
export function resolveFkTarget(
  columnName: string,
  tables: SchemaTableNode[],
  selfName: string
): SchemaTableNode | null {
  const m = columnName.toLowerCase().match(/^(.*?)_?id$/);
  if (!m || !m[1]) return null;
  const base = m[1].replace(/_$/, '');
  if (!base) return null;

  const candidates = new Set([
    base,
    `${base}s`,
    `${base}es`,
    base.endsWith('y') ? `${base.slice(0, -1)}ies` : `${base}ies`,
  ]);

  return tables.find((t) => candidates.has(t.name.toLowerCase())) || null;
}

// Laravel/Rails-style polymorphic association: a "<base>_id" column paired
// with a sibling "<base>_type" column on the same table. The concrete target
// table can't be known statically, so we mark it distinctly instead of
// guessing a single (likely wrong) target.
function isPolymorphicColumn(columnName: string, allColumnNames: string[]): boolean {
  const m = columnName.toLowerCase().match(/^(.*)_id$/);
  if (!m || !m[1]) return false;
  const base = m[1];
  return allColumnNames.some((c) => c.toLowerCase() === `${base}_type`);
}

// A small pivot/junction table (e.g. "role_user", "product_tag") that mostly
// just holds two FK columns and nothing else, and that nothing else points
// to. Its edges get rendered as "many-to-many" instead of plain FK lines.
function isJunctionTable(table: SchemaTableNode, fkColumnCount: number): boolean {
  return fkColumnCount >= 2 && table.children.length <= fkColumnCount + 2;
}

export function buildSchemaGraph(tables: SchemaTableNode[]): SchemaGraphModel {
  const tablesByName = new Map(tables.map((t) => [t.name, t]));
  const tableNames = tables.map((t) => t.name);
  const adjacency = new Map<string, Set<string>>();
  tableNames.forEach((n) => adjacency.set(n, new Set()));

  // First pass: figure out which tables look like pure join tables, so we
  // can classify their edges as many-to-many below.
  const fkCountByTable = new Map<string, number>();
  tables.forEach((table) => {
    const count = table.children.filter((c) => resolveFkTarget(c.name, tables, table.name)).length;
    fkCountByTable.set(table.name, count);
  });

  const edges: GraphEdgeModel[] = [];
  tables.forEach((table) => {
    const allColumnNames = table.children.map((c) => c.name);
    const seenTargets = new Set<string>();

    table.children.forEach((col) => {
      if (isPolymorphicColumn(col.name, allColumnNames)) {
        // Try to resolve anyway (sometimes it coincidentally matches), but
        // always tag it polymorphic so the UI is honest about the ambiguity.
        const target = resolveFkTarget(col.name, tables, table.name);
        if (!target || target.name === table.name) return;
        const id = `e-${target.name}-${table.name}-${col.name}`;
        if (seenTargets.has(id)) return;
        seenTargets.add(id);
        edges.push(makeEdge(id, target, table, col.name, 'polymorphic'));
        return;
      }

      const target = resolveFkTarget(col.name, tables, table.name);
      if (!target) return;
      const id = `e-${target.name}-${table.name}-${col.name}`;
      if (seenTargets.has(id)) return;
      seenTargets.add(id);

      let kind: RelationshipKind = 'fk';
      if (target.name === table.name) {
        kind = 'self';
      } else if (isJunctionTable(table, fkCountByTable.get(table.name) || 0)) {
        kind = 'many-to-many';
      }

      edges.push(makeEdge(id, target, table, col.name, kind));
    });
  });

  edges.forEach((e) => {
    adjacency.get(e.source)?.add(e.target);
    adjacency.get(e.target)?.add(e.source);
  });

  return { tableNames, tablesByName, edges, adjacency };
}

function makeEdge(
  id: string,
  target: SchemaTableNode,
  table: SchemaTableNode,
  colName: string,
  kind: RelationshipKind
): GraphEdgeModel {
  const pkCol = target.children.find((c) => c.is_primary_key)?.name || target.children[0]?.name || 'id';
  return {
    id,
    source: target.name,
    target: table.name,
    sourceColumn: pkCol,
    targetColumn: colName,
    kind,
  };
}

/** Degree (relationship count) of every table — handy for picking a sensible
 *  default focus root when nothing was explicitly selected. */
export function computeDegrees(graph: SchemaGraphModel): Map<string, number> {
  const degrees = new Map<string, number>();
  graph.tableNames.forEach((n) => degrees.set(n, graph.adjacency.get(n)?.size || 0));
  return degrees;
}
