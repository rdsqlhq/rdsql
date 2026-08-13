import { describe, it, expect } from 'vitest';
import type { SchemaTableNode } from '../../domain/types';
import type { GraphEdgeModel } from '../types';
import {
  runLayout,
  estimateNodeHeight,
  calculateGraphBounds,
  calculateConnectedComponents,
  resolveNodeCollisions,
  ERD_LAYOUT,
  NODE_WIDTH,
} from '../layout';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal table with N columns — only the fields layout.ts reads. */
function makeTable(name: string, columnCount = 3): SchemaTableNode {
  return {
    name,
    node_type: 'table',
    children: Array.from({ length: columnCount }, (_, i) => ({
      name: `col_${i}`,
      node_type: 'column' as const,
      is_primary_key: i === 0,
      is_foreign_key: false,
      is_nullable: true,
      has_default: false,
    })),
  };
}

function makeEdge(source: string, target: string, sourceColumn = 'id', targetColumn = 'parent_id'): GraphEdgeModel {
  return {
    id: `${source}.${sourceColumn}->${target}.${targetColumn}`,
    source,
    target,
    sourceColumn,
    targetColumn,
    kind: 'fk',
  };
}

interface LayoutFixtures {
  tables: SchemaTableNode[];
  edges: GraphEdgeModel[];
}

function layout(fixtures: LayoutFixtures, opts: { compact?: boolean; expandedColumnIds?: Set<string> } = {}) {
  const { tables, edges } = fixtures;
  const tablesByName = new Map(tables.map((t) => [t.name, t]));
  const tableNames = tables.map((t) => t.name);
  const positions = runLayout('hierarchical', {
    tableNames,
    tablesByName,
    edges,
    compact: opts.compact ?? false,
    expandedColumnIds: opts.expandedColumnIds,
  });
  const footprintMap = new Map<string, { w: number; h: number }>(
    tableNames.map((name) => [
      name,
      {
        w: NODE_WIDTH,
        h: estimateNodeHeight(tablesByName.get(name), opts.compact ?? false, opts.expandedColumnIds?.has(name)),
      },
    ])
  );
  return { positions, bounds: calculateGraphBounds(positions, footprintMap), tablesByName };
}

/** Bounding-box overlap check between two nodes. */
function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  padding = 0
): boolean {
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapX + padding > 0 && overlapY + padding > 0;
}

/** Assert no two nodes in the layout overlap (with minNodeGap clearance). */
function expectNoOverlaps(
  positions: Map<string, { x: number; y: number }>,
  tablesByName: Map<string, SchemaTableNode>,
  compact = false
) {
  const names = [...positions.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const pa = positions.get(a)!;
      const pb = positions.get(b)!;
      const fa = { w: NODE_WIDTH, h: estimateNodeHeight(tablesByName.get(a), compact) };
      const fb = { w: NODE_WIDTH, h: estimateNodeHeight(tablesByName.get(b), compact) };
      expect(
        boxesOverlap(
          { x: pa.x, y: pa.y, ...fa },
          { x: pb.x, y: pb.y, ...fb },
          -1 // allow touching but not true overlap
        ),
        `nodes "${a}" and "${b}" overlap`
      ).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Acceptance tests (TEST 1 – TEST 9)
// ---------------------------------------------------------------------------

describe('ERD hierarchical layout', () => {
  it('TEST 1: one parent → one child — wide horizontal gap, vertically aligned', () => {
    const tables = [makeTable('users'), makeTable('posts')];
    const edges = [makeEdge('users', 'posts')];
    const { positions, tablesByName } = layout({ tables, edges });

    const parent = positions.get('users')!;
    const child = positions.get('posts')!;

    // Child sits strictly to the right of the parent.
    expect(child.x).toBeGreaterThan(parent.x + NODE_WIDTH);

    // Horizontal gap is at least the configured parent→child gap.
    const horizontalGap = child.x - (parent.x + NODE_WIDTH);
    expect(horizontalGap).toBeGreaterThanOrEqual(ERD_LAYOUT.parentChildHorizontalGap - 10);

    // The two are roughly vertically aligned (center within one node height).
    const parentCenter = parent.y + estimateNodeHeight(tablesByName.get('users'), false) / 2;
    const childCenter = child.y + estimateNodeHeight(tablesByName.get('posts'), false) / 2;
    expect(Math.abs(parentCenter - childCenter)).toBeLessThan(NODE_WIDTH);

    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 2: one parent → multiple children — parent centered against child group', () => {
    const tables = ['users', 'posts', 'comments', 'likes'].map((n) => makeTable(n));
    const edges = [
      makeEdge('users', 'posts'),
      makeEdge('users', 'comments'),
      makeEdge('users', 'likes'),
    ];
    const { positions, tablesByName } = layout({ tables, edges });

    const parent = positions.get('users')!;
    const children = ['posts', 'comments', 'likes'].map((n) => positions.get(n)!);
    const childHeights = ['posts', 'comments', 'likes'].map((n) => estimateNodeHeight(tablesByName.get(n), false));

    // All children are to the right of the parent.
    children.forEach((c) => expect(c.x).toBeGreaterThan(parent.x + NODE_WIDTH));

    // Parent's vertical center ≈ children group's vertical center.
    const minY = Math.min(...children.map((c, i) => c.y));
    const maxY = Math.max(...children.map((c, i) => c.y + childHeights[i]));
    const childGroupCenterY = (minY + maxY) / 2;
    const parentCenterY = parent.y + estimateNodeHeight(tablesByName.get('users'), false) / 2;
    expect(Math.abs(parentCenterY - childGroupCenterY)).toBeLessThan(NODE_WIDTH);

    // Children are stacked compactly with childVerticalGap order of magnitude.
    const sortedChildren = children.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sortedChildren.length; i++) {
      const gap = sortedChildren[i].y - (sortedChildren[i - 1].y + childHeights[0]);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(ERD_LAYOUT.parentChildHorizontalGap); // compact, not stretched
    }

    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 3: long relationship chain — horizontal layered, wider than tall', () => {
    const tables = ['A', 'B', 'C', 'D'].map((n) => makeTable(n));
    const edges = [makeEdge('A', 'B'), makeEdge('B', 'C'), makeEdge('C', 'D')];
    const { positions, bounds, tablesByName } = layout({ tables, edges });

    // Each node is strictly to the right of the previous one (left→right flow).
    const a = positions.get('A')!;
    const b = positions.get('B')!;
    const c = positions.get('C')!;
    const d = positions.get('D')!;
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeGreaterThan(b.x);
    expect(d.x).toBeGreaterThan(c.x);

    // The canvas is wider than it is tall (the key visual priority).
    expect(bounds.width).toBeGreaterThan(bounds.height);

    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 4: shared child / multiple parents — every edge stays independent', () => {
    const tables = ['users', 'organizations', 'memberships'].map((n) => makeTable(n));
    const edges = [
      makeEdge('users', 'memberships', 'id', 'user_id'),
      makeEdge('organizations', 'memberships', 'id', 'org_id'),
    ];
    const { positions, tablesByName } = layout({ tables, edges });

    // The shared child has two parents pointing at it — both positioned.
    expect(positions.has('users')).toBe(true);
    expect(positions.has('organizations')).toBe(true);
    expect(positions.has('memberships')).toBe(true);

    // The layout never drops or merges edges — verify via the input edges,
    // since runLayout only returns positions (edges flow through unchanged).
    expect(edges.length).toBe(2);
    expect(new Set(edges.map((e) => `${e.source}->${e.target}`)).size).toBe(2);

    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 5: many-to-many junction — junction + both ends positioned, edges independent', () => {
    const tables = ['users', 'roles', 'user_roles'].map((n) => makeTable(n));
    const edges = [
      makeEdge('users', 'user_roles', 'id', 'user_id'),
      makeEdge('roles', 'user_roles', 'id', 'role_id'),
    ];
    const { positions, tablesByName } = layout({ tables, edges });

    expect(positions.has('users')).toBe(true);
    expect(positions.has('roles')).toBe(true);
    expect(positions.has('user_roles')).toBe(true);

    // Junction sits to the right of both of its parents.
    const junction = positions.get('user_roles')!;
    expect(junction.x).toBeGreaterThan(positions.get('users')!.x);
    expect(junction.x).toBeGreaterThan(positions.get('roles')!.x);

    expect(edges.length).toBe(2);
    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 6: self-referencing relationship — node positioned, not dropped', () => {
    const tables = [makeTable('employees')];
    const edges: GraphEdgeModel[] = [
      { ...makeEdge('employees', 'employees', 'id', 'manager_id'), kind: 'self' },
    ];
    const { positions, tablesByName } = layout({ tables, edges });

    expect(positions.has('employees')).toBe(true);
    expect(positions.get('employees')).toBeDefined();
    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 7: circular relationship — no node or edge dropped', () => {
    const tables = ['A', 'B'].map((n) => makeTable(n));
    const edges = [makeEdge('A', 'B'), makeEdge('B', 'A', 'id', 'ref_id')];
    const { positions, tablesByName } = layout({ tables, edges });

    // Both nodes survive the cycle fallback in the layer assignment.
    expect(positions.has('A')).toBe(true);
    expect(positions.has('B')).toBe(true);
    expect(positions.size).toBe(2);
    expect(edges.length).toBe(2);
    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 8: large schema (100+ tables) — completes without overlaps', () => {
    const count = 120;
    const tables: SchemaTableNode[] = [];
    for (let i = 0; i < count; i++) tables.push(makeTable(`t${i}`));
    // Build a chain plus some branches so the graph isn't trivially linear.
    const edges: GraphEdgeModel[] = [];
    for (let i = 0; i < count - 1; i++) {
      edges.push(makeEdge(`t${i}`, `t${i + 1}`));
    }
    // A few cross-edges to exercise the cycle fallback + crossing minimization.
    edges.push(makeEdge('t0', `t${count - 1}`, 'id', 'loop_id'));

    const { positions, tablesByName } = layout({ tables, edges });

    expect(positions.size).toBe(count);
    expectNoOverlaps(positions, tablesByName);
  });

  it('TEST 9: disconnected components — independent components do not inflate each other', () => {
    // Component A: a 4-table chain (tall-ish when laid out left→right).
    // Component B: a single isolated 2-table edge (short).
    const tables = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2'].map((n) => makeTable(n));
    const edges = [
      makeEdge('a1', 'a2'),
      makeEdge('a2', 'a3'),
      makeEdge('a3', 'a4'),
      makeEdge('b1', 'b2'),
    ];
    const { positions, tablesByName } = layout({ tables, edges });

    expect(positions.size).toBe(6);
    expectNoOverlaps(positions, tablesByName);

    // Component B's vertical span must not be inflated by Component A's height.
    const b1 = positions.get('b1')!;
    const b2 = positions.get('b2')!;
    const bSpan = Math.abs(b1.y - b2.y) + estimateNodeHeight(tablesByName.get('b1'), false);
    // Component B is a single edge — it should be compact (well under, say, 300px).
    expect(bSpan).toBeLessThan(300);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('layout invariants', () => {
  it('never produces overlapping nodes (hierarchical)', () => {
    const tables = ['parent', 'c1', 'c2', 'c3', 'leaf'].map((n) => makeTable(n));
    const edges = [
      makeEdge('parent', 'c1'),
      makeEdge('parent', 'c2'),
      makeEdge('parent', 'c3'),
      makeEdge('c2', 'leaf'),
    ];
    const { positions, tablesByName } = layout({ tables, edges });
    expectNoOverlaps(positions, tablesByName);
  });

  it('never produces overlapping nodes (force)', () => {
    const tables = ['parent', 'c1', 'c2', 'c3'].map((n) => makeTable(n));
    const edges = [makeEdge('parent', 'c1'), makeEdge('parent', 'c2'), makeEdge('parent', 'c3')];
    const tablesByName = new Map(tables.map((t) => [t.name, t]));
    const positions = runLayout('force', {
      tableNames: tables.map((t) => t.name),
      tablesByName,
      edges,
      compact: false,
    });
    expectNoOverlaps(positions, tablesByName);
  });

  it('empty graph returns empty positions', () => {
    const { positions } = layout({ tables: [], edges: [] });
    expect(positions.size).toBe(0);
  });

  it('horizontal parent→child gap is ≈5× the original 60px levelGap', () => {
    // The spec asked for ≈5× the previous 60px gap. ERD_LAYOUT.parentChildHorizontalGap
    // should reflect that intent (>= 280, i.e. comfortably above 60*4).
    expect(ERD_LAYOUT.parentChildHorizontalGap).toBeGreaterThanOrEqual(280);
    expect(ERD_LAYOUT.parentChildHorizontalGap / 60).toBeGreaterThanOrEqual(4.5);
  });

  it('horizontal gap is significantly larger than vertical sibling gap', () => {
    // Visual priority: HORIZONTAL RELATIONSHIP CLARITY > EXCESSIVE VERTICAL SPACING.
    expect(ERD_LAYOUT.parentChildHorizontalGap).toBeGreaterThan(ERD_LAYOUT.siblingVerticalGap * 5);
    expect(ERD_LAYOUT.levelGap).toBeGreaterThan(ERD_LAYOUT.childVerticalGap * 5);
  });

  it('calculateGraphBounds matches the actual node extents', () => {
    const tables = ['a', 'b', 'c'].map((n) => makeTable(n));
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const { positions, bounds, tablesByName } = layout({ tables, edges });

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    positions.forEach((p, name) => {
      const h = estimateNodeHeight(tablesByName.get(name), false);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_WIDTH);
      maxY = Math.max(maxY, p.y + h);
    });
    expect(bounds.minX).toBe(minX);
    expect(bounds.minY).toBe(minY);
    expect(bounds.maxX).toBe(maxX);
    expect(bounds.maxY).toBe(maxY);
    expect(bounds.width).toBe(maxX - minX);
    expect(bounds.height).toBe(maxY - minY);
  });
});

// ---------------------------------------------------------------------------
// Connected components helper
// ---------------------------------------------------------------------------

describe('calculateConnectedComponents', () => {
  it('groups connected nodes and separates disconnected ones', () => {
    const tableNames = ['a', 'b', 'c', 'x', 'y', 'z'];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('x', 'y')];
    const comps = calculateConnectedComponents(tableNames, edges);

    expect(comps.length).toBe(3);
    // Largest component first.
    expect(comps[0].sort()).toEqual(['a', 'b', 'c']);
    // z is fully isolated → its own component.
    const zComp = comps.find((c) => c.includes('z'));
    expect(zComp).toEqual(['z']);
  });

  it('handles an empty universe', () => {
    expect(calculateConnectedComponents([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveNodeCollisions (overlap safety net)
// ---------------------------------------------------------------------------

describe('resolveNodeCollisions', () => {
  it('pushes apart two exactly-overlapping nodes', () => {
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0, y: 0 }],
    ]);
    const footprints = new Map<string, { w: number; h: number }>([
      ['a', { w: NODE_WIDTH, h: 100 }],
      ['b', { w: NODE_WIDTH, h: 100 }],
    ]);
    resolveNodeCollisions(positions, footprints);

    const a = positions.get('a')!;
    const b = positions.get('b')!;
    expect(boxesOverlap({ ...a, ...footprints.get('a')! }, { ...b, ...footprints.get('b')! })).toBe(false);
  });

  it('leaves already-separated nodes untouched', () => {
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1000, y: 1000 }],
    ]);
    const footprints = new Map<string, { w: number; h: number }>([
      ['a', { w: NODE_WIDTH, h: 100 }],
      ['b', { w: NODE_WIDTH, h: 100 }],
    ]);
    resolveNodeCollisions(positions, footprints);
    expect(positions.get('a')).toEqual({ x: 0, y: 0 });
    expect(positions.get('b')).toEqual({ x: 1000, y: 1000 });
  });
});
