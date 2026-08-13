import { describe, it, expect } from 'vitest';
import {
  buildDependencyGraph,
  topoSort,
  sortTablesByDependency,
  inferFkTarget,
} from '../dependencyGraph';
import type { SchemaTableNode } from '../../domain/types';

function makeTable(name: string, columns: { name: string; is_foreign_key?: boolean }[]): SchemaTableNode {
  return {
    name,
    node_type: 'table',
    children: columns.map((c) => ({
      name: c.name,
      node_type: 'column' as const,
      is_foreign_key: c.is_foreign_key,
      is_primary_key: false,
      is_nullable: true,
      has_default: false,
    })),
  };
}

describe('inferFkTarget', () => {
  const tables = new Set(['users', 'orders', 'categories', 'products', 'entries']);

  it('infers singular → plural', () => {
    expect(inferFkTarget('user_id', tables)).toBe('users');
    expect(inferFkTarget('order_id', tables)).toBe('orders');
  });

  it('infers -y → -ies plural', () => {
    expect(inferFkTarget('category_id', tables)).toBe('categories');
    expect(inferFkTarget('entry_id', tables)).toBe('entries');
  });

  it('infers -es plural', () => {
    expect(inferFkTarget('product_id', tables)).toBe('products');
  });

  it('returns null for non-id columns', () => {
    expect(inferFkTarget('name', tables)).toBeNull();
    expect(inferFkTarget('email', tables)).toBeNull();
  });

  it('returns null for bare "id"', () => {
    expect(inferFkTarget('id', tables)).toBeNull();
  });

  it('returns null when target table does not exist', () => {
    expect(inferFkTarget('nonexistent_id', tables)).toBeNull();
  });
});

describe('buildDependencyGraph', () => {
  it('returns empty graph for no tables', () => {
    const graph = buildDependencyGraph([]);
    expect(graph.size).toBe(0);
  });

  it('returns isolated nodes when no FK columns exist', () => {
    const tables = [
      makeTable('users', [{ name: 'id' }, { name: 'email' }]),
      makeTable('products', [{ name: 'id' }, { name: 'name' }]),
    ];
    const graph = buildDependencyGraph(tables);
    expect(graph.get('users')?.references).toEqual([]);
    expect(graph.get('products')?.references).toEqual([]);
  });

  it('detects FK via name-pattern even without is_foreign_key flag', () => {
    const tables = [
      makeTable('users', [{ name: 'id' }]),
      makeTable('orders', [{ name: 'id' }, { name: 'user_id' }]),
    ];
    const graph = buildDependencyGraph(tables);
    expect(graph.get('orders')?.references).toEqual(['users']);
    expect(graph.get('users')?.referencedBy).toEqual(['orders']);
  });

  it('detects FK via is_foreign_key flag', () => {
    const tables = [
      makeTable('categories', [{ name: 'id' }]),
      makeTable('products', [{ name: 'id' }, { name: 'category_id', is_foreign_key: true }]),
    ];
    const graph = buildDependencyGraph(tables);
    expect(graph.get('products')?.references).toEqual(['categories']);
  });

  it('handles multiple FK dependencies', () => {
    const tables = [
      makeTable('users', [{ name: 'id' }]),
      makeTable('products', [{ name: 'id' }]),
      makeTable('orders', [{ name: 'id' }, { name: 'user_id' }, { name: 'product_id' }]),
    ];
    const graph = buildDependencyGraph(tables);
    expect(graph.get('orders')?.references).toContain('users');
    expect(graph.get('orders')?.references).toContain('products');
    expect(graph.get('orders')?.references.length).toBe(2);
  });

  it('does not self-reference', () => {
    const tables = [
      makeTable('trees', [{ name: 'id' }, { name: 'parent_id' }]),
    ];
    const graph = buildDependencyGraph(tables);
    // parent_id → inferFkTarget → looks for "parents" or "parent" which doesn't exist
    // so it should have no references.
    expect(graph.get('trees')?.references).toEqual([]);
  });
});

describe('topoSort', () => {
  it('returns empty for empty graph', () => {
    const result = topoSort(new Map());
    expect(result.ordered).toEqual([]);
    expect(result.hasCycle).toBe(false);
  });

  it('returns original order when no dependencies', () => {
    const tables = [makeTable('a', [{ name: 'id' }]), makeTable('b', [{ name: 'id' }])];
    const graph = buildDependencyGraph(tables);
    const result = topoSort(graph);
    expect(result.ordered).toContain('a');
    expect(result.ordered).toContain('b');
    expect(result.hasCycle).toBe(false);
  });

  it('orders parents before children', () => {
    const tables = [
      makeTable('orders', [{ name: 'id' }, { name: 'user_id' }]),
      makeTable('users', [{ name: 'id' }]),
    ];
    const result = sortTablesByDependency(tables);
    const usersIdx = result.ordered.indexOf('users');
    const ordersIdx = result.ordered.indexOf('orders');
    expect(usersIdx).toBeLessThan(ordersIdx);
    expect(result.hasCycle).toBe(false);
  });

  it('handles chains: accounts → branches → deposits', () => {
    const tables = [
      makeTable('deposits', [{ name: 'id' }, { name: 'branch_id' }]),
      makeTable('branches', [{ name: 'id' }, { name: 'account_id' }]),
      makeTable('accounts', [{ name: 'id' }]),
    ];
    const result = sortTablesByDependency(tables);
    const accIdx = result.ordered.indexOf('accounts');
    const brIdx = result.ordered.indexOf('branches');
    const depIdx = result.ordered.indexOf('deposits');
    expect(accIdx).toBeLessThan(brIdx);
    expect(brIdx).toBeLessThan(depIdx);
    expect(result.hasCycle).toBe(false);
  });

  it('detects cycles and still returns all nodes', () => {
    // Build a manual cycle: alpha → beta → alpha
    const graph = new Map([
      ['alpha', { table: 'alpha', references: ['beta'], referencedBy: [] }],
      ['beta', { table: 'beta', references: ['alpha'], referencedBy: [] }],
    ]);
    const result = topoSort(graph);
    expect(result.hasCycle).toBe(true);
    expect(result.ordered).toContain('alpha');
    expect(result.ordered).toContain('beta');
    expect(result.ordered.length).toBe(2);
  });

  it('handles diamond dependency', () => {
    // accounts → branches, accounts → customers, branches → deposits, customers → deposits
    const tables = [
      makeTable('deposits', [{ name: 'id' }, { name: 'branch_id' }, { name: 'customer_id' }]),
      makeTable('branches', [{ name: 'id' }, { name: 'account_id' }]),
      makeTable('customers', [{ name: 'id' }, { name: 'account_id' }]),
      makeTable('accounts', [{ name: 'id' }]),
    ];
    const result = sortTablesByDependency(tables);
    const accIdx = result.ordered.indexOf('accounts');
    const depIdx = result.ordered.indexOf('deposits');
    expect(accIdx).toBeLessThan(depIdx);
    expect(result.hasCycle).toBe(false);
    // branches and customers should come after accounts but before deposits
    const brIdx = result.ordered.indexOf('branches');
    const cuIdx = result.ordered.indexOf('customers');
    expect(accIdx).toBeLessThan(brIdx);
    expect(accIdx).toBeLessThan(cuIdx);
    expect(brIdx).toBeLessThan(depIdx);
    expect(cuIdx).toBeLessThan(depIdx);
  });
});
