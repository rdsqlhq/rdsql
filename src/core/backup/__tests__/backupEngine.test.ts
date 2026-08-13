import { describe, it, expect } from 'vitest';
import {
  getEngineCapabilities,
  buildBackupPlan,
  generateDataStatements,
  type TableSelection,
} from '../backupEngine';
import type { SchemaTableNode, DatabaseEngine } from '../../domain/types';

function makeTable(name: string, columns: { name: string; is_foreign_key?: boolean }[]): SchemaTableNode {
  return {
    name,
    node_type: 'table',
    children: columns.map((c) => ({
      name: c.name,
      node_type: 'column' as const,
      is_foreign_key: c.is_foreign_key,
      is_primary_key: c.name === 'id',
      is_nullable: true,
      has_default: false,
      data_type: 'text',
    })),
  };
}

describe('getEngineCapabilities', () => {
  it('MySQL: can disable FK checks with SET FOREIGN_KEY_CHECKS', () => {
    const caps = getEngineCapabilities('mysql');
    expect(caps.canDisableFkChecks).toBe(true);
    expect(caps.fkDisableSql).toContain('FOREIGN_KEY_CHECKS');
    expect(caps.fkEnableSql).toContain('FOREIGN_KEY_CHECKS');
  });

  it('PostgreSQL: attempts session_replication_role (may fail at runtime)', () => {
    const caps = getEngineCapabilities('postgres');
    expect(caps.canDisableFkChecks).toBe(true);
    expect(caps.fkDisableSql).toContain('session_replication_role');
    expect(caps.fkDisableSql).toContain('replica');
    expect(caps.fkEnableSql).toContain('origin');
  });

  it('SQLite: can disable via PRAGMA', () => {
    const caps = getEngineCapabilities('sqlite');
    expect(caps.canDisableFkChecks).toBe(true);
    expect(caps.fkDisableSql).toContain('PRAGMA');
    expect(caps.fkEnableSql).toContain('ON');
  });

  it('D1: cannot disable FK checks', () => {
    const caps = getEngineCapabilities('cloudflare-d1');
    expect(caps.canDisableFkChecks).toBe(false);
    expect(caps.fkDisableSql).toBeNull();
    expect(caps.fkEnableSql).toBeNull();
  });

  it('DuckDB: enforces FK, no per-session disable (relies on dependency order)', () => {
    const caps = getEngineCapabilities('duckdb');
    expect(caps.engine).toBe('duckdb');
    expect(caps.canDisableFkChecks).toBe(false);
    expect(caps.fkDisableSql).toBeNull();
    expect(caps.fkEnableSql).toBeNull();
    // No FK re-enable item should be emitted in the plan (covered by buildBackupPlan test below).
    expect(caps.supportsTransactionalDdl).toBe(true);
    expect(caps.supportsDeferredConstraints).toBe(false);
  });

  it('Unknown engine: safe defaults (no FK disable)', () => {
    const caps = getEngineCapabilities('not-a-real-engine' as DatabaseEngine);
    expect(caps.canDisableFkChecks).toBe(false);
    expect(caps.fkDisableSql).toBeNull();
  });
});

describe('buildBackupPlan', () => {
  const tables = [
    makeTable('orders', [{ name: 'id' }, { name: 'user_id' }]),
    makeTable('users', [{ name: 'id' }, { name: 'email' }]),
  ];
  const selections = new Map<string, TableSelection>([
    ['users', { structure: true, data: true }],
    ['orders', { structure: true, data: true }],
  ]);

  it('produces items in phase order: schema → data → finalize', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections,
      schema: 'public',
      writeMode: 'insert',
    });
    const phases = plan.items.map((i) => i.phase);
    const schemaIdx = phases.lastIndexOf('schema');
    const dataIdx = phases.indexOf('data');
    const finalizeIdx = phases.indexOf('finalize');
    expect(schemaIdx).toBeLessThan(dataIdx);
    expect(dataIdx).toBeLessThan(finalizeIdx);
  });

  it('orders tables by dependency (users before orders)', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections,
      schema: 'public',
      writeMode: 'insert',
    });
    const usersIdx = plan.tableOrder.indexOf('users');
    const ordersIdx = plan.tableOrder.indexOf('orders');
    expect(usersIdx).toBeLessThan(ordersIdx);
  });

  it('includes FK re-enable in finalize phase for engines that support it', () => {
    const plan = buildBackupPlan({
      engine: 'mysql',
      tables,
      selections,
      schema: 'mydb',
      writeMode: 'insert',
    });
    const finalizeItems = plan.items.filter((i) => i.phase === 'finalize');
    expect(finalizeItems.length).toBe(1);
    expect(finalizeItems[0].sql).toContain('FOREIGN_KEY_CHECKS');
  });

  it('omits FK re-enable for D1', () => {
    const plan = buildBackupPlan({
      engine: 'cloudflare-d1',
      tables: [makeTable('items', [{ name: 'id' }])],
      selections: new Map([['items', { structure: true, data: true }]]),
      schema: 'db',
      writeMode: 'insert',
    });
    const finalizeItems = plan.items.filter((i) => i.phase === 'finalize');
    expect(finalizeItems.length).toBe(0);
  });

  it('DuckDB: emits DROP without CASCADE and skips FK finalize', () => {
    const plan = buildBackupPlan({
      engine: 'duckdb',
      tables,
      selections,
      schema: 'main',
      writeMode: 'drop',
    });
    // DuckDB enforces FK and has no per-session disable, so no finalize item.
    const finalizeItems = plan.items.filter((i) => i.phase === 'finalize');
    expect(finalizeItems.length).toBe(0);
    // DROP statements must not carry CASCADE (DuckDB doesn't need the wrapper).
    const dropItems = plan.items.filter((i) => i.id.startsWith('drop_'));
    expect(dropItems.length).toBe(2);
    for (const item of dropItems) {
      expect(item.sql).toMatch(/^DROP TABLE IF EXISTS /);
      expect(item.sql).not.toContain('CASCADE');
      // Double-quote identifier quoting (same as postgres), not backticks.
      expect(item.sql).toContain('"');
      expect(item.sql).not.toContain('`');
    }
  });

  it('emits DROP statements (reverse order) when writeMode is drop', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections,
      schema: 'public',
      writeMode: 'drop',
    });
    const dropItems = plan.items.filter((i) => i.id.startsWith('drop_'));
    expect(dropItems.length).toBe(2);
    // Drop order is reverse of create order (children first)
    // tableOrder is [users, orders] (parents first), so drop is [orders, users]
    expect(dropItems[0].table).toBe('orders');
    expect(dropItems[1].table).toBe('users');
  });

  it('emits TRUNCATE statements when writeMode is truncate', () => {
    const plan = buildBackupPlan({
      engine: 'mysql',
      tables,
      selections,
      schema: 'mydb',
      writeMode: 'truncate',
    });
    const truncItems = plan.items.filter((i) => i.id.startsWith('truncate_'));
    expect(truncItems.length).toBe(2);
    expect(truncItems[0].sql).toContain('TRUNCATE');
  });

  it('skips tables not in selections', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections: new Map([['users', { structure: true, data: false }]]),
      schema: 'public',
      writeMode: 'insert',
    });
    // Only users structure, no orders, no data
    expect(plan.items.some((i) => i.table === 'orders')).toBe(false);
    expect(plan.items.some((i) => i.table === 'users' && i.phase === 'data')).toBe(false);
    expect(plan.items.some((i) => i.table === 'users' && i.phase === 'schema')).toBe(true);
  });

  it('counts total tables correctly', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections,
      schema: 'public',
      writeMode: 'insert',
    });
    expect(plan.totalTables).toBe(2);
  });

  it('every item has a unique id (for future checkpoint tracking)', () => {
    const plan = buildBackupPlan({
      engine: 'postgres',
      tables,
      selections,
      schema: 'public',
      writeMode: 'drop',
    });
    const ids = plan.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('generateDataStatements', () => {
  it('generates INSERT statements with quoted identifiers', () => {
    const stmts = generateDataStatements('mysql', 'users', 'mydb', [
      { name: 'id', type: 'int', dataType: 'int' } as any,
      { name: 'name', type: 'text', dataType: 'text' } as any,
    ], [[1, 'Alice'], [2, 'Bob']]);
    expect(stmts.length).toBe(1);
    expect(stmts[0]).toContain('INSERT INTO');
    expect(stmts[0]).toContain('Alice');
    expect(stmts[0]).toContain('Bob');
  });

  it('returns empty array for no rows', () => {
    const stmts = generateDataStatements('postgres', 'users', 'public', [
      { name: 'id', type: 'int', dataType: 'int' } as any,
    ], []);
    expect(stmts).toEqual([]);
  });
});
