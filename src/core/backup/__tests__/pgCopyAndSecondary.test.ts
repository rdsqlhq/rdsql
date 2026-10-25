import { describe, expect, it } from 'vitest';
import { pgCopyRow, pgCopySql, pgSecondaryObjects, pgSecondarySql } from '../backupSql';
import { buildBackupPlan } from '../backupEngine';
import type { SchemaTableNode } from '../../domain/types';

describe('COPY text format', () => {
  it('escapes the characters COPY treats specially and writes NULL as \\N', () => {
    expect(pgCopyRow(['a\tb', 'line\nbreak\r', 'back\\slash', null, '', '\\x00ff'])).toBe(
      'a\\tb\tline\\nbreak\\r\tback\\\\slash\t\\N\t\t\\\\x00ff'
    );
  });

  it('names the table and columns', () => {
    expect(pgCopySql('postgres', 'Order Items', ['id', 'fullName'], 'shop')).toBe('COPY "shop"."Order Items" ("id", "fullName") FROM stdin;');
  });
});

describe('indexes and constraints', () => {
  const objects = pgSecondaryObjects(
    [
      ['orders', 'orders_customer_id_fkey', 'f', 'FOREIGN KEY (customer_id) REFERENCES customers(id)', 'customers'],
      ['orders', 'orders_note_fkey', 'f', 'FOREIGN KEY (note_id) REFERENCES notes(id)', 'notes'],
      ['products', 'products_price_positive', 'c', 'CHECK ((price > (0)::numeric))', ''],
      ['customers', 'customers_email_key', 'u', 'UNIQUE (email)', ''],
    ],
    [['orders', 'orders_open_idx', "CREATE INDEX orders_open_idx ON orders USING btree (placed_at) WHERE (status = 'pending'::order_status)"]]
  );

  it('recreates each one, skipping it if it already exists', () => {
    expect(pgSecondarySql(objects[4])).toBe(
      "CREATE INDEX IF NOT EXISTS orders_open_idx ON orders USING btree (placed_at) WHERE (status = 'pending'::order_status);"
    );
    expect(pgSecondarySql(objects[3])).toBe(
      'DO $rdsql$ BEGIN ALTER TABLE "customers" ADD CONSTRAINT "customers_email_key" UNIQUE (email); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $rdsql$;'
    );
  });

  it('puts them after the data, foreign keys last, and drops keys to tables not copied', () => {
    const table = (name: string): SchemaTableNode => ({
      name,
      node_type: 'table',
      children: [{ name: 'id', node_type: 'column', data_type: 'integer', is_primary_key: true }],
    });
    const tables = ['customers', 'orders', 'products'].map(table);
    const selections = new Map(tables.map((t) => [t.name, { structure: true, data: true }]));
    const plan = buildBackupPlan({ engine: 'postgres', tables, selections, schema: 'public', writeMode: 'insert', targetSchema: 'public', pgSecondary: objects });
    const phases = plan.items.map((i) => i.phase);
    expect(phases.lastIndexOf('data')).toBeLessThan(phases.indexOf('secondary'));
    const secondary = plan.items.filter((i) => i.phase === 'secondary').map((i) => i.id);
    expect(secondary).toEqual([
      'check_products_products_price_positive',
      'unique_customers_customers_email_key',
      'index_orders_orders_open_idx',
      'foreign_key_orders_orders_customer_id_fkey',
    ]);
    // Definitions name tables without a schema, so the target schema goes first.
    expect(plan.items[0].sql).toBe('SET search_path TO "public", public;');
  });
});
