import { SchemaTableNode } from '../domain/types';
import { GraphEdgeModel, LayoutKind, LayoutOption, Point } from './types';

export const LAYOUT_OPTIONS: LayoutOption[] = [
  { id: 'hierarchical', label: 'Hierarchical', available: true },
  { id: 'radial', label: 'Radial', available: true },
  { id: 'force', label: 'Force-Directed', available: true },
  {
    id: 'elk',
    label: 'ELK',
    available: false,
    unavailableReason: "Requires installing the 'elkjs' package — not available offline in this workspace.",
  },
  {
    id: 'dagre',
    label: 'Dagre',
    available: false,
    unavailableReason: "Requires installing the 'dagre' package — not available offline in this workspace.",
  },
];

// ---------------------------------------------------------------------------
// Centralized layout configuration
// ---------------------------------------------------------------------------
// Every spacing value used by the ERD layout lives here. Nothing in this file
// (or the canvas consumer) should hardcode a gap/padding/size. The horizontal
// parent→child gap is intentionally MUCH larger than the vertical sibling gap
// so the diagram reads left-to-right with short, traceable relationship lines
// instead of a tall, vertically-stretched stack.
//
// `parentChildHorizontalGap` is ≈5× the previous hardcoded `levelGap` of 60,
// which is the core visual change requested: connected tables are spread wide
// apart horizontally, while siblings/children stay compact vertically.
export const ERD_LAYOUT = {
  /** Rendered width of a table card (must match nodes.tsx `w-[220px]`). */
  nodeWidth: 220,
  /** nodeWidth + horizontal gap between same-column neighbors. */
  nodeSlotWidth: 250,
  /** Horizontal distance between relationship levels (parent column → child column). */
  parentChildHorizontalGap: 320,
  /** Horizontal gap between layers — equals parentChildHorizontalGap (L→R flow). */
  levelGap: 320,
  /** Vertical gap between a parent's children stacked in the same level. */
  childVerticalGap: 28,
  /** Vertical gap between unrelated siblings within a level. */
  siblingVerticalGap: 24,
  /** Minimum clearance kept between any two node boxes by overlap resolution. */
  minNodeGap: 24,
  /** Gap between disconnected sub-layouts packed on the canvas. */
  componentGap: 120,
  /** Vertical clearance between the main diagram and the isolated-tables grid. */
  isolatedSectionGap: 80,
  /** Safety cap on a single level's pixel height before it sub-column-wraps.
   *  Generous so normal schemas never wrap, but a 50-table level still can. */
  maxColumnHeight: 4000,
  /** Barycenter reordering sweeps for edge-crossing minimization. */
  barycenterSweeps: 24,
  /** Parent-to-children vertical centering iterations. */
  parentCenteringIterations: 30,
} as const;

// Backwards-compatible aliases — other modules import these names.
export const NODE_WIDTH = ERD_LAYOUT.nodeWidth;
export const NODE_SLOT_WIDTH = ERD_LAYOUT.nodeSlotWidth;

export function estimateNodeHeight(
  table: SchemaTableNode | undefined,
  compact: boolean,
  columnsExpanded = false
): number {
  if (compact) return 46;
  const total = table?.children.length || 0;
  const colCount = columnsExpanded ? total : Math.min(total, 5);
  const extraRow = total > 5 ? 1 : 0; // "+N more" / "Show less" toggle row
  return 56 + (colCount + extraRow) * 19;
}

interface LayoutInput {
  tableNames: string[];
  tablesByName: Map<string, SchemaTableNode>;
  edges: GraphEdgeModel[];
  compact: boolean;
  rootId?: string | null;
  /** Tables the user has expanded to show every column — sized taller than
   *  the default 5-row preview, so layouts need this to avoid overlap. */
  expandedColumnIds?: Set<string>;
}

interface Footprint {
  w: number;
  h: number;
}

export interface GraphBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

function footprintOf(
  name: string,
  tablesByName: Map<string, SchemaTableNode>,
  compact: boolean,
  expandedColumnIds?: Set<string>
): Footprint {
  return {
    w: NODE_WIDTH,
    h: estimateNodeHeight(tablesByName.get(name), compact, expandedColumnIds?.has(name)),
  };
}

function buildFootprints(input: LayoutInput): Map<string, Footprint> {
  return new Map(
    input.tableNames.map((name) => [
      name,
      footprintOf(name, input.tablesByName, input.compact, input.expandedColumnIds),
    ])
  );
}

// ===========================================================================
// PHASE 1 — GRAPH ANALYSIS
// ===========================================================================

/**
 * Undirected adjacency map for a set of edges over a node universe. Used by
 * every analysis helper (components, levels, barycenter, centering). Direction
 * is irrelevant for layout — a relationship is a connection either way.
 */
function buildAdjacency(tableNames: string[], edges: GraphEdgeModel[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  tableNames.forEach((n) => adj.set(n, new Set()));
  edges.forEach((e) => {
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  });
  return adj;
}

/**
 * Split the graph into connected components using union-find over the
 * undirected adjacency. Each component is then laid out independently and
 * packed, so one tall relationship chain can't stretch an unrelated 2-table
 * subgraph (acceptance TEST 9). O(V + E)·α.
 */
export function calculateConnectedComponents(tableNames: string[], edges: GraphEdgeModel[]): string[][] {
  const parent = new Map<string, string>();
  tableNames.forEach((n) => parent.set(n, n));

  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      parent.set(cur, parent.get(parent.get(cur)!)!); // path compression
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  edges.forEach((e) => {
    if (parent.has(e.source) && parent.has(e.target)) union(e.source, e.target);
  });

  const groups = new Map<string, string[]>();
  tableNames.forEach((n) => {
    const root = find(n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(n);
  });

  // Deterministic order: largest component first, then by first table name.
  return [...groups.values()].sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return (a[0] || '').localeCompare(b[0] || '');
  });
}

/**
 * Topological layer assignment (BFS / Kahn's algorithm). Parents go in lower
 * levels (left), children in higher levels (right). Falls back gracefully on
 * cycles — nodes still in a cycle after processing keep their max-seen level,
 * which produces a readable left-to-right flow without dropping anyone.
 *
 * Returns the per-node level plus the byLevel grouping and the directed
 * out-adjacency (source → direct children) used by child-group centering.
 */
function calculateGraphHierarchy(
  tableNames: string[],
  edges: GraphEdgeModel[]
): { level: Map<string, number>; byLevel: Map<number, string[]>; outAdj: Map<string, string[]> } {
  const outAdj = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  tableNames.forEach((n) => {
    outAdj.set(n, []);
    remaining.set(n, 0);
  });
  edges.forEach((e) => {
    if (!outAdj.has(e.source) || !remaining.has(e.target)) return;
    outAdj.get(e.source)!.push(e.target);
    remaining.set(e.target, (remaining.get(e.target) || 0) + 1);
  });

  const level = new Map<string, number>();
  tableNames.forEach((n) => level.set(n, 0));

  const queue: string[] = tableNames.filter((n) => (remaining.get(n) || 0) === 0);
  const processed = new Set<string>();
  let guard = 0;
  const guardLimit = tableNames.length * tableNames.length + 10;
  while (queue.length && guard < guardLimit) {
    guard++;
    const n = queue.shift()!;
    if (processed.has(n)) continue;
    processed.add(n);
    (outAdj.get(n) || []).forEach((next) => {
      level.set(next, Math.max(level.get(next) || 0, (level.get(n) || 0) + 1));
      const d = (remaining.get(next) || 0) - 1;
      remaining.set(next, d);
      if (d <= 0) queue.push(next);
    });
  }

  // Cycle fallback: any node never processed (still has incoming edges from a
  // cycle) gets pushed one level deeper than its highest out-neighbor so it
  // still lays out to the right of what points at it.
  if (processed.size < tableNames.length) {
    tableNames.forEach((n) => {
      if (processed.has(n)) return;
      const backMax = (outAdj.get(n) || []).reduce((mx, child) => {
        if (level.get(child)! <= level.get(n)!) return mx;
        return Math.max(mx, level.get(child)!);
      }, -1);
      if (backMax >= 0) level.set(n, backMax + 1);
    });
  }

  const byLevel = new Map<number, string[]>();
  tableNames.forEach((n) => {
    const l = level.get(n) || 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l)!.push(n);
  });

  return { level, byLevel, outAdj };
}

/**
 * Barycenter node reordering within each layer to minimize edge crossings
 * (Sugiyama heuristic). Each node's barycenter = average index of its
 * neighbors in the adjacent (reference) layer. Sorting by that pulls connected
 * nodes close together vertically. Mutates `byLevel` in place.
 */
function minimizeCrossings(byLevel: Map<number, string[]>, adjacency: Map<string, Set<string>>) {
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  for (let sweep = 0; sweep < ERD_LAYOUT.barycenterSweeps; sweep++) {
    const downward = sweep % 2 === 0;
    const lvls = downward ? sortedLevels : [...sortedLevels].reverse();
    for (const lvl of lvls) {
      const nodes = byLevel.get(lvl)!;
      const refLevel = downward ? lvl - 1 : lvl + 1;
      const refNodes = byLevel.get(refLevel);
      if (!refNodes) continue;
      const refPos = new Map<string, number>();
      refNodes.forEach((n, i) => refPos.set(n, i));

      const scored = nodes.map((node, fallbackIdx) => {
        const neighbors = adjacency.get(node) || new Set<string>();
        let sum = 0;
        let count = 0;
        neighbors.forEach((nb) => {
          if (refPos.has(nb)) {
            sum += refPos.get(nb)!;
            count++;
          }
        });
        return { node, score: count > 0 ? sum / count : fallbackIdx, fallbackIdx };
      });
      scored.sort((a, b) => a.score - b.score || a.fallbackIdx - b.fallbackIdx);
      byLevel.set(lvl, scored.map((s) => s.node));
    }
  }
}

/**
 * Group each node's DIRECT CHILDREN (next-level out-neighbors) for vertical
 * centering. This grouping is used ONLY to compute positions — it NEVER
 * becomes an edge group. Rendering still emits one independent edge per
 * relationship.
 */
function calculateChildGroups(
  byLevel: Map<number, string[]>,
  outAdj: Map<string, string[]>
): Map<string, string[]> {
  const childGroups = new Map<string, string[]>();
  byLevel.forEach((nodes) => {
    nodes.forEach((n) => {
      childGroups.set(n, outAdj.get(n) || []);
    });
  });
  return childGroups;
}

// ===========================================================================
// PHASE 2 — NODE POSITIONING
// ===========================================================================

/**
 * Assign X positions per level (left→right flow) using ERD_LAYOUT.levelGap.
 * A level may sub-column-wrap if its stacked height exceeds maxColumnHeight
 * (rare; only very wide schemas). Returns the X offset of each level.
 */
function calculateLayerPositions(byLevel: Map<number, string[]>, heightOf: (n: string) => number) {
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const xByLevel = new Map<number, number>();
  const vGap = ERD_LAYOUT.siblingVerticalGap;
  let xCursor = 0;
  sortedLevels.forEach((lvl) => {
    const items = byLevel.get(lvl)!;
    const numCols = Math.max(
      1,
      Math.ceil(items.reduce((s, n) => s + heightOf(n) + vGap, 0) / Math.max(1, ERD_LAYOUT.maxColumnHeight))
    );
    xByLevel.set(lvl, xCursor);
    xCursor += numCols * NODE_SLOT_WIDTH + ERD_LAYOUT.levelGap;
  });
  return xByLevel;
}

/**
 * Initial top-to-bottom Y placement per level column. Compact stacking using
 * siblingVerticalGap, so a level with many children stays tight rather than
 * spreading out vertically.
 */
function calculateChildPositions(
  byLevel: Map<number, string[]>,
  xByLevel: Map<number, number>,
  heightOf: (n: string) => number
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const vGap = ERD_LAYOUT.siblingVerticalGap;
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);

  sortedLevels.forEach((lvl) => {
    const items = byLevel.get(lvl)!;
    const columns: string[][] = [[]];
    let curHeight = 0;
    items.forEach((name) => {
      const h = heightOf(name);
      if (curHeight > 0 && curHeight + h > ERD_LAYOUT.maxColumnHeight) {
        columns.push([]);
        curHeight = 0;
      }
      columns[columns.length - 1].push(name);
      curHeight += h + vGap;
    });

    const baseX = xByLevel.get(lvl) || 0;
    columns.forEach((col, ci) => {
      let cursorY = 0;
      col.forEach((name) => {
        positions.set(name, { x: baseX + ci * NODE_SLOT_WIDTH, y: cursorY });
        cursorY += heightOf(name) + vGap;
      });
    });
  });

  return positions;
}

/**
 * Vertically center each parent against its connected child group. For a
 * parent P with children C1..Cn in the next level, compute the children's
 * combined vertical midpoint and shift P (then re-stack its level locally with
 * at least siblingVerticalGap) so P sits across the middle child instead of
 * pinned to the top of the child list.
 *
 * After centering, each level is re-stacked top-to-bottom preserving the
 * barycenter-optimized order, with childVerticalGap between connected groups.
 * Several iterations converge to a stable layout.
 *
 * POSITIONING ONLY — edges are unaffected.
 */
function centerParentToChildren(
  positions: Map<string, Point>,
  byLevel: Map<number, string[]>,
  childGroups: Map<string, string[]>,
  heightOf: (n: string) => number
) {
  const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
  const vGap = ERD_LAYOUT.childVerticalGap;

  for (let iter = 0; iter < ERD_LAYOUT.parentCenteringIterations; iter++) {
    let changed = false;

    sortedLevels.forEach((lvl) => {
      const items = byLevel.get(lvl)!;
      const baseX = positions.get(items[0])?.x ?? 0;

      // Desired Y for each node = vertical midpoint of its child group
      // (fallback: its own neighbors' midpoint; final fallback: current Y).
      const scored = items.map((node) => {
        const children = (childGroups.get(node) || []).filter((c) => positions.has(c));
        let desiredY = positions.get(node)!.y;
        if (children.length > 0) {
          // Midpoint of the children's combined vertical span.
          let minY = Infinity;
          let maxY = -Infinity;
          let sumCenter = 0;
          children.forEach((c) => {
            const cp = positions.get(c)!;
            const ch = heightOf(c);
            minY = Math.min(minY, cp.y);
            maxY = Math.max(maxY, cp.y + ch);
            sumCenter += cp.y + ch / 2;
          });
          const spanCenter = (minY + maxY) / 2;
          const avgCenter = sumCenter / children.length;
          // Blend span-center (groups the parent across the whole child block)
          // with average-center (handles uneven child heights) for stability.
          desiredY = (spanCenter + avgCenter) / 2 - heightOf(node) / 2;
        } else {
          // No children in the next level: pull toward any neighbor's midpoint
          // so terminal/leaf nodes still align with who they connect to.
          const p = positions.get(node)!;
          // neighbors handled implicitly via the barycenter ordering already;
          // keep current Y as the stable anchor.
          desiredY = p.y;
        }
        return { node, desiredY };
      });

      // Sort by desired Y to preserve the crossing-minimized order, then
      // re-stack compactly with at least childVerticalGap between boxes.
      scored.sort((a, b) => a.desiredY - b.desiredY);
      let cursorY = scored[0]?.desiredY ?? 0;
      const newItems: string[] = [];
      scored.forEach((s) => {
        cursorY = Math.max(cursorY, s.desiredY);
        const old = positions.get(s.node)!;
        if (Math.abs(old.y - cursorY) > 1) changed = true;
        positions.set(s.node, { x: baseX, y: cursorY });
        newItems.push(s.node);
        cursorY += heightOf(s.node) + vGap;
      });
      byLevel.set(lvl, newItems);
    });

    if (!changed && iter > 5) break;
  }
}

/**
 * Final safety net: pushes apart any table cards whose bounding boxes still
 * intersect (or sit closer than minNodeGap). Damped (split the overlap, move
 * each node half) so the layout stays tidy. Iteration count adapts to graph
 * size so large schemas still finish quickly.
 */
export function resolveNodeCollisions(positions: Map<string, Point>, footprints: Map<string, Footprint>) {
  const names = [...positions.keys()];
  const n = names.length;
  if (n < 2) return;
  const iterations = n > 400 ? 25 : n > 150 ? 50 : 120;
  const padding = ERD_LAYOUT.minNodeGap;

  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = names[i];
      const pa = positions.get(a)!;
      const fa = footprints.get(a)!;
      for (let j = i + 1; j < n; j++) {
        const b = names[j];
        const pb = positions.get(b)!;
        const fb = footprints.get(b)!;

        const overlapX = Math.min(pa.x + fa.w, pb.x + fb.w) - Math.max(pa.x, pb.x);
        const overlapY = Math.min(pa.y + fa.h, pb.y + fb.h) - Math.max(pa.y, pb.y);
        const pushX = overlapX + padding;
        const pushY = overlapY + padding;
        if (pushX <= 0 || pushY <= 0) continue;

        moved = true;
        // Push along the axis of LEAST overlap (cheapest separation), damped.
        if (pushX < pushY) {
          const sign = pa.x + fa.w / 2 <= pb.x + fb.w / 2 ? -1 : 1;
          const half = (sign * pushX) / 2;
          pa.x += half;
          pb.x -= half;
        } else {
          const sign = pa.y + fa.h / 2 <= pb.y + fb.h / 2 ? -1 : 1;
          const half = (sign * pushY) / 2;
          pa.y += half;
          pb.y -= half;
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Bounding box of all positioned nodes. Used by the canvas consumer to place
 * the isolated-tables grid below the main diagram without colliding with it.
 */
export function calculateGraphBounds(positions: Map<string, Point>, footprints: Map<string, Footprint>): GraphBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  positions.forEach((p, name) => {
    const f = footprints.get(name);
    const w = f?.w ?? NODE_WIDTH;
    const h = f?.h ?? 0;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + w);
    maxY = Math.max(maxY, p.y + h);
  });
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// ===========================================================================
// HIERARCHICAL LAYOUT (default) — orchestrates the two-phase pipeline
// ===========================================================================

/**
 * Per-component hierarchical layout. Runs the full Phase-1 + Phase-2 pipeline
 * on a single connected component, returning absolute positions. Called once
 * per component by the top-level packer.
 */
function runHierarchicalOnComponent(
  componentNodes: string[],
  edges: GraphEdgeModel[],
  tablesByName: Map<string, SchemaTableNode>,
  compact: boolean,
  expandedColumnIds: Set<string> | undefined
): Map<string, Point> {
  const heightOf = (name: string) =>
    estimateNodeHeight(tablesByName.get(name), compact, expandedColumnIds?.has(name));
  const adjacency = buildAdjacency(componentNodes, edges);

  // Phase 1 — analysis
  const { byLevel, outAdj } = calculateGraphHierarchy(componentNodes, edges);
  minimizeCrossings(byLevel, adjacency);
  const childGroups = calculateChildGroups(byLevel, outAdj);

  // Phase 2 — positioning
  const xByLevel = calculateLayerPositions(byLevel, heightOf);
  const positions = calculateChildPositions(byLevel, xByLevel, heightOf);
  centerParentToChildren(positions, byLevel, childGroups, heightOf);

  return positions;
}

/**
 * Top-level hierarchical layout. Decomposes the graph into connected
 * components, lays each out independently (so unrelated subgraphs don't
 * inflate each other's spacing), then packs components side-by-side.
 */
function hierarchicalLayout(input: LayoutInput): Map<string, Point> {
  const { tableNames, edges, tablesByName, compact, expandedColumnIds } = input;
  const out = new Map<string, Point>();
  if (tableNames.length === 0) return out;

  const components = calculateConnectedComponents(tableNames, edges);

  // Pack components left-to-right. Each component's local origin is (0,0);
  // after layout we offset it by the running X cursor plus a gap. Components
  // are also vertically centered against each other so a short 2-table graph
  // doesn't sit at a wildly different Y than a tall chain next to it.
  let xCursor = 0;
  const componentBounds: { bounds: GraphBounds; positions: Map<string, Point> }[] = [];

  components.forEach((compNodes) => {
    // Edges restricted to this component.
    const compSet = new Set(compNodes);
    const compEdges = edges.filter((e) => compSet.has(e.source) && compSet.has(e.target));

    const compPositions = runHierarchicalOnComponent(
      compNodes,
      compEdges,
      tablesByName,
      compact,
      expandedColumnIds
    );

    const compFootprints = new Map(
      compNodes.map((name) => [
        name,
        footprintOf(name, tablesByName, compact, expandedColumnIds),
      ])
    );
    const bounds = calculateGraphBounds(compPositions, compFootprints);
    componentBounds.push({ bounds, positions: compPositions });
  });

  // Lay components out in rows of bounded width so the canvas stays readable
  // when there are many small disconnected components (pack into a grid whose
  // column count scales with component count).
  const cols = Math.max(1, Math.ceil(Math.sqrt(componentBounds.length)));
  const cellW = NODE_SLOT_WIDTH + ERD_LAYOUT.componentGap;
  let rowY = 0;
  let rowMaxH = 0;
  let col = 0;

  componentBounds.forEach(({ bounds, positions }) => {
    if (col >= cols) {
      rowY += rowMaxH + ERD_LAYOUT.componentGap;
      rowMaxH = 0;
      col = 0;
    }
    const offsetX = col * cellW - bounds.minX;
    const offsetY = rowY - bounds.minY;
    positions.forEach((p, name) => {
      out.set(name, { x: p.x + offsetX, y: p.y + offsetY });
    });
    rowMaxH = Math.max(rowMaxH, bounds.height);
    col++;
  });

  return out;
}

// ===========================================================================
// RADIAL + FORCE layouts (retuned to read gaps from ERD_LAYOUT)
// ===========================================================================

// Root at the center, relationships fan out in concentric rings by hop
// distance. Ring radius scales with how many tables share that ring so a
// crowded ring doesn't crush its nodes into each other.
function radialLayout({ tableNames, tablesByName, edges, compact, rootId, expandedColumnIds }: LayoutInput): Map<string, Point> {
  const adjacency = buildAdjacency(tableNames, edges);

  const root = rootId && tableNames.includes(rootId) ? rootId : tableNames[0];
  const depth = new Map<string, number>();
  if (root) {
    depth.set(root, 0);
    const queue = [root];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = depth.get(cur)!;
      (adjacency.get(cur) || []).forEach((n) => {
        if (!depth.has(n)) {
          depth.set(n, d + 1);
          queue.push(n);
        }
      });
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  tableNames.forEach((n) => {
    if (!depth.has(n)) depth.set(n, maxDepth + 1);
  });

  const byRing = new Map<number, string[]>();
  tableNames.forEach((n) => {
    const d = depth.get(n) || 0;
    if (!byRing.has(d)) byRing.set(d, []);
    byRing.get(d)!.push(n);
  });

  const ringStep = compact ? 160 : 280;
  const positions = new Map<string, Point>();
  let previousOuterRadius = 0;

  [...byRing.keys()]
    .sort((a, b) => a - b)
    .forEach((ring) => {
      const ids = byRing.get(ring)!;
      if (ring === 0) {
        ids.forEach((id) => positions.set(id, { x: 0, y: 0 }));
        previousOuterRadius =
          Math.max(
            NODE_WIDTH,
            ...ids.map((id) => estimateNodeHeight(tablesByName.get(id), compact, expandedColumnIds?.has(id)))
          ) / 2;
        return;
      }

      const spacingNeeded = NODE_WIDTH + ERD_LAYOUT.minNodeGap;
      const circumferenceRadius = ids.length > 1 ? (ids.length * spacingNeeded) / (2 * Math.PI) : 0;
      const radius = Math.max(previousOuterRadius + ringStep, circumferenceRadius, ring * ringStep);

      ids.forEach((id, i) => {
        const angle = (2 * Math.PI * i) / ids.length + ring * 0.35;
        positions.set(id, { x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
      });

      previousOuterRadius = radius;
    });

  return positions;
}

// Simple spring/repulsion simulation. Runs synchronously — fine at the scale
// Focus Mode limits us to (tens of nodes, not the whole database).
function forceLayout({ tableNames, tablesByName, edges, compact, expandedColumnIds }: LayoutInput): Map<string, Point> {
  const n = tableNames.length;
  const positions = new Map<string, Point>();
  if (n === 0) return positions;

  const spread = Math.max(320, Math.sqrt(n) * 140);
  tableNames.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / n;
    positions.set(id, { x: spread * Math.cos(angle), y: spread * Math.sin(angle) });
  });

  const footprints = buildFootprints({ tableNames, tablesByName, edges, compact, expandedColumnIds });
  const velocity = new Map<string, Point>(tableNames.map((id) => [id, { x: 0, y: 0 }]));
  const linked = edges.filter((e) => positions.has(e.source) && positions.has(e.target));
  const iterations = n > 150 ? 120 : 280;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = tableNames[i];
        const b = tableNames[j];
        const pa = positions.get(a)!;
        const pb = positions.get(b)!;
        const fa = footprints.get(a)!;
        const fb = footprints.get(b)!;
        const idealLen = (Math.max(fa.w, fa.h) + Math.max(fb.w, fb.h)) / 2 + 100;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const force = (idealLen * idealLen * 2.5) / (dist * dist);
        dx /= dist;
        dy /= dist;
        const va = velocity.get(a)!;
        const vb = velocity.get(b)!;
        va.x += dx * force * 0.01;
        va.y += dy * force * 0.01;
        vb.x -= dx * force * 0.01;
        vb.y -= dy * force * 0.01;
      }
    }

    linked.forEach((e) => {
      const pa = positions.get(e.source)!;
      const pb = positions.get(e.target)!;
      const fa = footprints.get(e.source)!;
      const fb = footprints.get(e.target)!;
      const idealLen = (Math.max(fa.w, fa.h) + Math.max(fb.w, fb.h)) / 2 + 100;
      let dx = pb.x - pa.x;
      let dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - idealLen) * 0.02;
      dx /= dist;
      dy /= dist;
      const va = velocity.get(e.source)!;
      const vb = velocity.get(e.target)!;
      va.x += dx * force;
      va.y += dy * force;
      vb.x -= dx * force;
      vb.y -= dy * force;
    });

    tableNames.forEach((id) => {
      const v = velocity.get(id)!;
      const p = positions.get(id)!;
      v.x *= 0.85;
      v.y *= 0.85;
      p.x += v.x;
      p.y += v.y;
    });
  }

  return positions;
}

// ===========================================================================
// PUBLIC ENTRY POINT
// ===========================================================================

/**
 * Thin orchestrator. Dispatches to the chosen algorithm, then runs the
 * universal no-overlap safety pass. Signature unchanged from the previous
 * implementation so the canvas consumer needs no API change.
 */
export function runLayout(kind: LayoutKind, input: LayoutInput): Map<string, Point> {
  let positions: Map<string, Point>;
  switch (kind) {
    case 'radial':
      positions = radialLayout(input);
      break;
    case 'force':
      positions = forceLayout(input);
      break;
    case 'elk':
    case 'dagre':
      // Not available offline — fall back to hierarchical rather than failing.
      positions = hierarchicalLayout(input);
      break;
    case 'hierarchical':
    default:
      positions = hierarchicalLayout(input);
      break;
  }

  // Guarantee-of-no-overlap pass, regardless of which algorithm ran above.
  const footprints = buildFootprints(input);
  resolveNodeCollisions(positions, footprints);

  return positions;
}
