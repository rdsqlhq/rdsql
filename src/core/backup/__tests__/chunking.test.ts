import { describe, it, expect } from 'vitest';
import { pickChunkStrategy, selectKeysetChunkSql, selectOffsetChunkSql, stripSchemaQualifiers } from '../backupSql';
import type { SchemaTableNode } from '../../domain/types';

function makeTable(columns: { name: string; is_primary_key?: boolean }[]): Pick<SchemaTableNode, 'children'> {
  return {
    children: columns.map((c) => ({
      name: c.name,
      node_type: 'column' as const,
      is_primary_key: c.is_primary_key,
    })),
  };
}

describe('pickChunkStrategy', () => {
  it('uses keyset pagination for a single-column primary key', () => {
    const table = makeTable([{ name: 'id', is_primary_key: true }, { name: 'email' }]);
    const strategy = pickChunkStrategy(table);
    expect(strategy.mode).toBe('keyset');
    expect(strategy.keysetColumn).toBe('id');
    expect(strategy.orderColumns).toEqual(['id']);
  });

  it('falls back to offset pagination for a composite primary key', () => {
    const table = makeTable([
      { name: 'tenant_id', is_primary_key: true },
      { name: 'item_id', is_primary_key: true },
      { name: 'name' },
    ]);
    const strategy = pickChunkStrategy(table);
    expect(strategy.mode).toBe('offset');
    expect(strategy.orderColumns).toEqual(['tenant_id', 'item_id']);
  });

  it('falls back to offset pagination ordered by the first column when there is no primary key', () => {
    const table = makeTable([{ name: 'name' }, { name: 'value' }]);
    const strategy = pickChunkStrategy(table);
    expect(strategy.mode).toBe('offset');
    expect(strategy.orderColumns).toEqual(['name']);
  });

  it('handles a table with no columns at all', () => {
    const table = makeTable([]);
    const strategy = pickChunkStrategy(table);
    expect(strategy.mode).toBe('offset');
    expect(strategy.orderColumns).toEqual([]);
  });
});

describe('selectKeysetChunkSql', () => {
  it('omits the WHERE clause on the first page (afterValue = null)', () => {
    const sql = selectKeysetChunkSql('postgres', 'users', 'public', 'id', null, 5000);
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY "id" ASC');
    expect(sql).toContain('LIMIT 5000');
  });

  it('adds WHERE pk > lastValue on subsequent pages', () => {
    const sql = selectKeysetChunkSql('postgres', 'users', 'public', 'id', 4999, 5000);
    expect(sql).toContain('WHERE "id" > 4999');
  });

  it('quotes the after-value for string keys', () => {
    const sql = selectKeysetChunkSql('mysql', 'users', 'app', 'uuid', 'abc-123', 100);
    expect(sql).toContain("WHERE `uuid` > 'abc-123'");
    expect(sql).toContain('LIMIT 100');
  });

  it('uses the engine-appropriate identifier quoting', () => {
    const pg = selectKeysetChunkSql('postgres', 'orders', undefined, 'id', null, 10);
    const mysql = selectKeysetChunkSql('mysql', 'orders', undefined, 'id', null, 10);
    expect(pg).toContain('"id"');
    expect(mysql).toContain('`id`');
  });
});

describe('selectOffsetChunkSql', () => {
  it('builds LIMIT/OFFSET with ORDER BY over the given columns', () => {
    const sql = selectOffsetChunkSql('postgres', 'events', 'public', ['tenant_id', 'item_id'], 10000, 5000);
    expect(sql).toContain('ORDER BY "tenant_id" ASC, "item_id" ASC');
    expect(sql).toContain('LIMIT 5000 OFFSET 10000');
  });

  it('omits ORDER BY when there are no order columns (last-resort, unordered)', () => {
    const sql = selectOffsetChunkSql('postgres', 'events', 'public', [], 0, 5000);
    expect(sql).not.toContain('ORDER BY');
    expect(sql).toContain('LIMIT 5000 OFFSET 0');
  });
});

describe('stripSchemaQualifiers', () => {
  it('strips the MySQL-style database qualifier from CREATE TABLE', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS `tc_superadmin`.`add_ons` (\n  `id` bigint unsigned NOT NULL\n);';
    expect(stripSchemaQualifiers('mysql', sql)).toBe(
      'CREATE TABLE IF NOT EXISTS `add_ons` (\n  `id` bigint unsigned NOT NULL\n);'
    );
  });

  it('strips every occurrence across a whole script (CREATE, INSERT, DROP)', () => {
    const sql = [
      'DROP TABLE IF EXISTS `shop`.`orders`;',
      'CREATE TABLE IF NOT EXISTS `shop`.`orders` (`id` int NOT NULL);',
      "INSERT INTO `shop`.`orders` (`id`) VALUES\n  (1),\n  (2);",
    ].join('\n');
    const stripped = stripSchemaQualifiers('mysql', sql);
    expect(stripped).not.toContain('`shop`.');
    expect(stripped).toContain('DROP TABLE IF EXISTS `orders`;');
    expect(stripped).toContain('CREATE TABLE IF NOT EXISTS `orders`');
    expect(stripped).toContain('INSERT INTO `orders`');
  });

  it('strips the Postgres/SQLite/DuckDB double-quote schema qualifier', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS "app"."users" (\n  "id" text NOT NULL\n);';
    expect(stripSchemaQualifiers('postgres', sql)).toBe(
      'CREATE TABLE IF NOT EXISTS "users" (\n  "id" text NOT NULL\n);'
    );
  });

  it('does not touch string literal values that happen to contain a dot', () => {
    const sql = "INSERT INTO `orders` (`domain`) VALUES\n  ('example.com');";
    expect(stripSchemaQualifiers('mysql', sql)).toBe(sql);
  });

  it('is a no-op on already-unqualified SQL', () => {
    const sql = 'CREATE TABLE IF NOT EXISTS `add_ons` (`id` bigint NOT NULL);';
    expect(stripSchemaQualifiers('mysql', sql)).toBe(sql);
  });
});
