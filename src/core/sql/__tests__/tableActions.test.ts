import { describe, it, expect } from 'vitest';
import { SchemaColumnNode } from '../../domain/types';
import {
  getTableCapabilities,
  dropTableSql,
  truncateTableSql,
  resetAutoIncrementSql,
  analyzeTableSql,
  vacuumTableSql,
  optimizeTableSql,
  checkTableSql,
  reindexTableSql,
  maintenanceOpSql,
  maintenanceOpLabel,
  detectAutoIncrementColumn,
} from '../tableActions';

function col(name: string, over: Partial<SchemaColumnNode> = {}): SchemaColumnNode {
  return {
    name,
    node_type: 'column',
    data_type: 'integer',
    is_primary_key: false,
    is_foreign_key: false,
    is_nullable: true,
    has_default: false,
    ...over,
  };
}

// ───────────────────────── Capabilities ─────────────────────────

describe('getTableCapabilities', () => {
  it('postgres supports truncate, reset, and analyze/vacuum/reindex', () => {
    const c = getTableCapabilities('postgres');
    expect(c.supportsTruncate).toBe(true);
    expect(c.supportsResetAutoIncrement).toBe(true);
    expect(c.maintenanceOps).toEqual(['analyze', 'vacuum', 'reindex']);
  });

  it('mysql supports truncate, reset, and analyze/optimize/check', () => {
    const c = getTableCapabilities('mysql');
    expect(c.supportsTruncate).toBe(true);
    expect(c.supportsResetAutoIncrement).toBe(true);
    expect(c.maintenanceOps).toEqual(['analyze', 'optimize', 'check']);
  });

  it('mariadb (stored as mysql) resolves identically', () => {
    expect(getTableCapabilities('mariadb')).toEqual(getTableCapabilities('mysql'));
  });

  it('sqlite has no truncate but supports reset + analyze only', () => {
    const c = getTableCapabilities('sqlite');
    expect(c.supportsTruncate).toBe(false);
    expect(c.supportsResetAutoIncrement).toBe(true);
    expect(c.maintenanceOps).toEqual(['analyze']);
  });

  it('cloudflare-d1 is treated as sqlite-family', () => {
    const c = getTableCapabilities('cloudflare-d1');
    expect(c.supportsTruncate).toBe(false);
    expect(c.maintenanceOps).toEqual(['analyze']);
  });

  it('duckdb supports truncate, has no auto-increment, and exposes checkpoint + analyze', () => {
    const c = getTableCapabilities('duckdb');
    expect(c.supportsTruncate).toBe(true);
    expect(c.supportsResetAutoIncrement).toBe(false);
    expect(c.maintenanceOps).toEqual(['checkpoint', 'analyze']);
  });

  it('unknown engines are conservative', () => {
    const c = getTableCapabilities('totally-made-up-engine');
    expect(c.supportsTruncate).toBe(false);
    expect(c.supportsResetAutoIncrement).toBe(false);
    expect(c.maintenanceOps).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(getTableCapabilities('PostgreSQL')).toEqual(getTableCapabilities('postgres'));
    expect(getTableCapabilities('MySQL')).toEqual(getTableCapabilities('mysql'));
  });
});

// ───────────────────────── DROP TABLE ─────────────────────────

describe('dropTableSql', () => {
  it('quotes the table name', () => {
    expect(dropTableSql('postgres', 'users')).toBe('DROP TABLE "users";');
    expect(dropTableSql('mysql', 'users')).toBe('DROP TABLE `users`;');
  });

  it('qualifies with schema when provided', () => {
    expect(dropTableSql('postgres', 'users', 'public')).toBe('DROP TABLE "public"."users";');
  });

  it('never adds CASCADE', () => {
    expect(dropTableSql('postgres', 'users')).not.toContain('CASCADE');
  });

  it('escapes embedded quotes (injection safety)', () => {
    const sql = dropTableSql('postgres', 'evil"; DROP TABLE x; --');
    // The quote inside the name is doubled → the entire malicious payload is
    // inside the quoted identifier. There is exactly one statement (one `;` at
    // the very end), so the embedded `DROP TABLE x` is NOT a separate statement.
    expect(sql).toBe('DROP TABLE "evil""; DROP TABLE x; --";');
    // Only the trailing semicolon terminates the statement; the inner ';' is
    // trapped inside the quoted identifier.
    expect(sql.endsWith('";')).toBe(true);
    expect(sql.startsWith('DROP TABLE "')).toBe(true);
  });

  it('escapes backticks for mysql', () => {
    const sql = dropTableSql('mysql', 'ev`il');
    expect(sql).toBe('DROP TABLE `ev``il`;');
  });
});

// ───────────────────────── TRUNCATE ─────────────────────────

describe('truncateTableSql', () => {
  it('postgres uses RESTART IDENTITY', () => {
    expect(truncateTableSql('postgres', 'orders')).toBe('TRUNCATE TABLE "orders" RESTART IDENTITY;');
  });

  it('mysql is a plain TRUNCATE', () => {
    expect(truncateTableSql('mysql', 'orders')).toBe('TRUNCATE TABLE `orders`;');
  });

  it('sqlite uses DELETE FROM (no TRUNCATE statement)', () => {
    expect(truncateTableSql('sqlite', 'orders')).toBe('DELETE FROM "orders";');
  });

  it('d1 uses DELETE FROM too', () => {
    expect(truncateTableSql('cloudflare-d1', 'orders')).toBe('DELETE FROM "orders";');
  });

  it('duckdb uses TRUNCATE (no TABLE keyword)', () => {
    expect(truncateTableSql('duckdb', 'orders')).toBe('TRUNCATE "orders";');
  });

  it('unknown engines return null for truncate', () => {
    expect(truncateTableSql('totally-made-up-engine', 'orders')).toBeNull();
  });

  it('qualifies with schema', () => {
    expect(truncateTableSql('postgres', 'orders', 'public')).toContain('"public"."orders"');
  });
});

// ───────────────────────── RESET AUTO INCREMENT ─────────────────────────

describe('resetAutoIncrementSql', () => {
  it('mysql uses ALTER TABLE AUTO_INCREMENT', () => {
    expect(resetAutoIncrementSql('mysql', 'users', 5000)).toBe('ALTER TABLE `users` AUTO_INCREMENT = 5000;');
  });

  it('sqlite updates sqlite_sequence with value-1', () => {
    // next issued value should be 5000 → seq = 4999
    expect(resetAutoIncrementSql('sqlite', 'users', 5000)).toBe(
      "UPDATE sqlite_sequence SET seq = 4999 WHERE name = 'users';"
    );
  });

  it('postgres uses setval with the sequence name from metadata', () => {
    const sql = resetAutoIncrementSql('postgres', 'users', 5000, {
      columnName: 'id',
      currentMax: 4999,
      currentValue: 5000,
      sequenceName: 'public.users_id_seq',
    });
    expect(sql).toBe('SELECT setval(\'public.users_id_seq\', 4999, false);');
  });

  it('postgres returns null without a sequence name', () => {
    expect(resetAutoIncrementSql('postgres', 'users', 5000)).toBeNull();
  });

  it('duckdb returns null', () => {
    expect(resetAutoIncrementSql('duckdb', 'users', 5000)).toBeNull();
  });

  it('sqlite escapes single quotes in the table name', () => {
    const sql = resetAutoIncrementSql('sqlite', "ev'il", 10);
    expect(sql).toBe("UPDATE sqlite_sequence SET seq = 9 WHERE name = 'ev''il';");
  });
});

// ───────────────────────── Maintenance ─────────────────────────

describe('maintenance SQL generators', () => {
  it('analyze works for all real engines', () => {
    expect(analyzeTableSql('postgres', 't')).toBe('ANALYZE "t";');
    expect(analyzeTableSql('mysql', 't')).toBe('ANALYZE TABLE `t`;');
    expect(analyzeTableSql('sqlite', 't')).toBe('ANALYZE "t";');
    expect(analyzeTableSql('duckdb', 't')).toBe('ANALYZE "t";');
  });

  it('vacuum is postgres + sqlite; duckdb uses CHECKPOINT', () => {
    expect(vacuumTableSql('postgres', 't')).toContain('VACUUM');
    expect(vacuumTableSql('sqlite', 't')).toBe('VACUUM;');
    expect(vacuumTableSql('duckdb', 't')).toBe('CHECKPOINT;');
    expect(vacuumTableSql('mysql', 't')).toBeNull();
  });

  it('optimize is mysql; duckdb maps to CHECKPOINT', () => {
    expect(optimizeTableSql('mysql', 't')).toBe('OPTIMIZE TABLE `t`;');
    expect(optimizeTableSql('duckdb', 't')).toBe('CHECKPOINT;');
    expect(optimizeTableSql('postgres', 't')).toBeNull();
  });

  it('check is mysql; duckdb maps to CHECKPOINT', () => {
    expect(checkTableSql('mysql', 't')).toBe('CHECK TABLE `t`;');
    expect(checkTableSql('duckdb', 't')).toBe('CHECKPOINT;');
    expect(checkTableSql('sqlite', 't')).toBeNull();
  });

  it('reindex is postgres only; duckdb returns null', () => {
    expect(reindexTableSql('postgres', 't')).toBe('REINDEX TABLE "t";');
    expect(reindexTableSql('duckdb', 't')).toBeNull();
    expect(reindexTableSql('mysql', 't')).toBeNull();
  });
});

describe('maintenanceOpSql + maintenanceOpLabel', () => {
  it('dispatches by op key', () => {
    expect(maintenanceOpSql('analyze', 'postgres', 't')).toBe('ANALYZE "t";');
    expect(maintenanceOpSql('optimize', 'mysql', 't')).toBe('OPTIMIZE TABLE `t`;');
    expect(maintenanceOpSql('reindex', 'mysql', 't')).toBeNull();
  });

  it('checkpoint op returns CHECKPOINT for duckdb and null otherwise', () => {
    expect(maintenanceOpSql('checkpoint', 'duckdb', 't')).toBe('CHECKPOINT;');
    expect(maintenanceOpSql('checkpoint', 'postgres', 't')).toBeNull();
  });

  it('labels are human-readable', () => {
    expect(maintenanceOpLabel('analyze')).toBe('Analyze Table');
    expect(maintenanceOpLabel('optimize')).toBe('Optimize Table');
    expect(maintenanceOpLabel('checkpoint')).toBe('Checkpoint');
  });
});

// ───────────────────────── Auto-increment detection ─────────────────────────

describe('detectAutoIncrementColumn', () => {
  it('sqlite finds INTEGER PRIMARY KEY', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'INTEGER' }),
      col('name', { data_type: 'TEXT' }),
    ];
    expect(detectAutoIncrementColumn('sqlite', cols)).toBe('id');
  });

  it('postgres finds serial PK with default', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'integer', has_default: true }),
      col('name', { data_type: 'text' }),
    ];
    expect(detectAutoIncrementColumn('postgres', cols)).toBe('id');
  });

  it('mysql finds AUTO_INCREMENT PK (folded into has_default)', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'int', has_default: true }),
      col('email', { data_type: 'varchar' }),
    ];
    expect(detectAutoIncrementColumn('mysql', cols)).toBe('id');
  });

  it('returns null when there is no PK int column', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'uuid', has_default: true }),
      col('name', { data_type: 'text' }),
    ];
    expect(detectAutoIncrementColumn('postgres', cols)).toBeNull();
  });

  it('returns null for a non-auto-increment int PK (no default)', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'integer', has_default: false }),
    ];
    expect(detectAutoIncrementColumn('postgres', cols)).toBeNull();
  });

  it('returns null for an empty column list', () => {
    expect(detectAutoIncrementColumn('postgres', [])).toBeNull();
  });

  it('duckdb has no auto-increment concept (always returns null)', () => {
    const cols = [
      col('id', { is_primary_key: true, data_type: 'integer', has_default: true }),
      col('name', { data_type: 'text' }),
    ];
    expect(detectAutoIncrementColumn('duckdb', cols)).toBeNull();
  });
});
