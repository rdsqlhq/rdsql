import type { SchemaTableNode } from '../domain/types';

/**
 * Backup/restore dependency graph — INDEPENDENT of the ERD visualization layer
 * (`src/core/erd/schemaGraph.ts`). The ERD layer is a UI tool with layout
 * concerns; backup/restore needs its own abstraction based on database metadata.
 *
 * The FK metadata from the backend is incomplete (Postgres hardcoded false,
 * SQLite None, MySQL MUL heuristic, D1 never), so this module uses a layered
 * strategy:
 *   1. If `is_foreign_key` is true on a column, infer the target table from
 *      name patterns (column `user_id` → table `users`).
 *   2. If all FK flags are false/None (Postgres/SQLite), still try name-pattern
 *      matching on ALL columns ending in `_id` — it catches the common case.
 *   3. If no FK-like columns are found, return an empty graph (no reordering).
 *
 * This is a HEURISTIC — it won't be perfect for unusual schemas. The caller
 * should combine it with engine-specific FK-disable (where available) as a
 * safety net. The `hasCycle` flag tells the caller whether FK-disable is
 * critical (cycles can't be topologically ordered).
 */

export interface TableDependency {
  table: string;
  /** Tables this table depends on (FK parents). Must be created/inserted first. */
  references: string[];
  /** Tables that depend on this table (FK children). */
  referencedBy: string[];
}

/**
 * Infer the FK target table name from a column name using conventional naming.
 * `user_id` → `users`, `order_id` → `orders`, `category_id` → `categories`.
 * Returns null if the column doesn't look like an FK reference.
 */
export function inferFkTarget(columnName: string, availableTables: Set<string>): string | null {
  const lower = columnName.toLowerCase();
  const m = lower.match(/^(.*?)_?id$/);
  if (!m || !m[1]) return null;
  const base = m[1].replace(/_$/, '');
  if (!base || base.length < 2) return null; // skip bare "id"

  // Try singular, plural, -es plural, -ies plural
  const candidates = [
    base,
    `${base}s`,
    `${base}es`,
    base.endsWith('y') ? `${base.slice(0, -1)}ies` : `${base}ies`,
  ];

  for (const c of candidates) {
    if (availableTables.has(c)) return c;
  }
  return null;
}

/**
 * Build a dependency graph from schema table metadata. The graph is keyed by
 * table name; each entry lists its FK parents (`references`) and children
 * (`referencedBy`).
 */
export function buildDependencyGraph(tables: SchemaTableNode[]): Map<string, TableDependency> {
  const tableNames = new Set(tables.map((t) => t.name.toLowerCase()));
  const graph = new Map<string, TableDependency>();

  // Initialize entries for every table
  for (const t of tables) {
    graph.set(t.name, { table: t.name, references: [], referencedBy: [] });
  }

  for (const t of tables) {
    const entry = graph.get(t.name)!;
    for (const col of t.children || []) {
      // Use is_foreign_key flag if it's explicitly true, OR fall back to
      // name-pattern matching on columns ending in _id (since the backend
      // doesn't reliably populate is_foreign_key for all engines).
      const looksLikeFk = col.is_foreign_key === true || /^.+_id$/.test(col.name.toLowerCase());
      if (!looksLikeFk) continue;

      const target = inferFkTarget(col.name, tableNames);
      if (target && target !== t.name && !entry.references.includes(target)) {
        entry.references.push(target);
        const targetEntry = graph.get(
          // Match case-insensitively — the Set is lowercase but the graph is
          // keyed by original case.
          tables.find((tt) => tt.name.toLowerCase() === target)?.name || target
        );
        if (targetEntry && !targetEntry.referencedBy.includes(t.name)) {
          targetEntry.referencedBy.push(t.name);
        }
      }
    }
  }

  return graph;
}

export interface TopoSortResult {
  /** Table names ordered so parents come before children. */
  ordered: string[];
  /** True if a cycle was detected (ordering is best-effort in that case). */
  hasCycle: boolean;
}

/**
 * Kahn's algorithm topological sort with cycle detection. Tables with no
 * outgoing FK references (parents/roots) come first; tables that reference
 * others come after their referenced parents.
 *
 * On cycles (A→B, B→A), the cycle is broken arbitrarily — the remaining nodes
 * are appended in their current order. The caller should check `hasCycle` and
 * treat FK-disable as critical when true.
 */
export function topoSort(graph: Map<string, TableDependency>): TopoSortResult {
  const allNodes = Array.from(graph.keys());
  if (allNodes.length === 0) return { ordered: [], hasCycle: false };

  // Build in-degree map (how many parents each table depends on)
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>(); // parent → children that depend on it

  for (const node of allNodes) {
    inDegree.set(node, 0);
    adjacency.set(node, new Set());
  }

  for (const [node, dep] of graph.entries()) {
    inDegree.set(node, dep.references.length);
    for (const parent of dep.references) {
      const parentChildren = adjacency.get(parent);
      if (parentChildren) parentChildren.add(node);
    }
  }

  // Seed queue with zero-in-degree nodes (tables with no FK dependencies)
  const queue: string[] = [];
  for (const [node, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(node);
  }

  const ordered: string[] = [];
  let hasCycle = false;

  while (queue.length > 0) {
    const node = queue.shift()!;
    ordered.push(node);
    const children = adjacency.get(node) || new Set();
    for (const child of children) {
      const newDeg = (inDegree.get(child) || 0) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  // If not all nodes were ordered, there's a cycle — append the rest
  if (ordered.length < allNodes.length) {
    hasCycle = true;
    for (const node of allNodes) {
      if (!ordered.includes(node)) ordered.push(node);
    }
  }

  return { ordered, hasCycle };
}

/**
 * Convenience: build the graph and sort in one call. Returns the ordered table
 * names + cycle flag.
 */
export function sortTablesByDependency(tables: SchemaTableNode[]): TopoSortResult {
  const graph = buildDependencyGraph(tables);
  return topoSort(graph);
}
