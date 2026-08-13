import { SchemaGraphModel } from './types';

/** BFS distance (in hops) from a set of root tables to every reachable table. */
export function bfsLevels(graph: SchemaGraphModel, roots: Iterable<string>): Map<string, number> {
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!level.has(r)) {
      level.set(r, 0);
      queue.push(r);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = level.get(cur)!;
    const neighbors = graph.adjacency.get(cur);
    if (!neighbors) continue;
    neighbors.forEach((n) => {
      if (!level.has(n)) {
        level.set(n, d + 1);
        queue.push(n);
      }
    });
  }

  return level;
}

/** All table names reachable from `roots` within `depth` hops (inclusive). */
export function getNeighborhood(graph: SchemaGraphModel, roots: Iterable<string>, depth: number): Set<string> {
  const levels = bfsLevels(graph, roots);
  const result = new Set<string>();
  levels.forEach((d, name) => {
    if (d <= depth) result.add(name);
  });
  return result;
}

/** Direct neighbors (1 hop) of a single table. */
export function getDirectNeighbors(graph: SchemaGraphModel, tableName: string): Set<string> {
  return new Set(graph.adjacency.get(tableName) || []);
}

export function getEdgeIdsBetween(graph: SchemaGraphModel, visibleNames: Set<string>): Set<string> {
  const ids = new Set<string>();
  graph.edges.forEach((e) => {
    if (visibleNames.has(e.source) && visibleNames.has(e.target)) ids.add(e.id);
  });
  return ids;
}
