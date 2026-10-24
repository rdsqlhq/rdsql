// Backup → another connection, and backup → file → restore, for each engine
// in docker-compose.yml. Every run is checked row for row against the source.
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopBridge } from './bridge';
import { conn, fingerprint, freshDatabase, query, runBackup, runRestore, servers, type RunResult } from './helpers';

afterAll(() => stopBridge());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdsql-e2e-backup-'));

/** Failures other than the FK-toggle a server may refuse. */
function realErrors(r: RunResult): string[] {
  return r.errors.filter((e) => !/session_replication_role|FOREIGN_KEY_CHECKS/.test(e));
}

function expectClean(r: RunResult) {
  if (r.status !== 'done' || realErrors(r).length > 0) {
    console.log(r.log.split('\n').slice(-40).join('\n'));
    console.log(realErrors(r).slice(0, 10).join('\n'));
  }
  expect(realErrors(r)).toEqual([]);
  expect(r.status).toBe('done');
}

/** Source fingerprint without views (backups copy base tables only). */
async function sourcePrint(source: ReturnType<typeof conn>, group: string) {
  return fingerprint(source, group);
}

describe('postgres 16 → postgres 17', () => {
  const source = conn(servers.pgSrc);
  const admin = conn(servers.pgDst);

  test('backup straight into another connection', async () => {
    await freshDatabase(admin, 'copy_conn');
    const target = conn(servers.pgDst, 'copy_conn');
    const r = await runBackup({ source, group: 'public', target, targetGroup: 'public' });
    expectClean(r);
    expect(await fingerprint(target, 'public')).toEqual(await sourcePrint(source, 'public'));

    // Defaults, serial/identity sequences and enums came across, so the
    // copy accepts new rows the way the source does.
    const c = await query(target, `INSERT INTO customers (email, "fullName") VALUES ('new@example.com', 'New') RETURNING id, country, profile::text`);
    expect(c.rows[0]).toEqual([20001, 'ID', '{}']);
    const p = await query(target, `INSERT INTO products (sku, name, price) VALUES ('NEW', 'New', 1) RETURNING id, active`);
    expect(p.rows[0]).toEqual([2001, true]);
    const o = await query(target, `INSERT INTO orders (customer_id, placed_at) VALUES (1, now()) RETURNING id, status::text`);
    expect(o.rows[0]).toEqual([100001, 'pending']);
    const views = await query(target, `SELECT count(*)::int FROM information_schema.views WHERE table_schema = 'public'`);
    expect(views.rows[0][0]).toBe(0);
  });

  test('backup into a schema that does not exist yet (safe mode)', async () => {
    await freshDatabase(admin, 'copy_schema');
    const target = conn(servers.pgDst, 'copy_schema');
    // Offered because it matches the source schema's name; created on the fly.
    await query(source, `CREATE SCHEMA IF NOT EXISTS shop`);
    await query(source, `CREATE TABLE IF NOT EXISTS shop.small AS SELECT g AS id, 'v' || g AS v FROM generate_series(1, 2500) g`);
    const r = await runBackup({ source, group: 'shop', target, targetGroup: 'shop', speed: 'safe' });
    expectClean(r);
    expect(await fingerprint(target, 'shop')).toEqual(await fingerprint(source, 'shop'));
  });

  test('backup to a file, then restore it', async () => {
    const file = path.join(tmp, 'pg.sql');
    expectClean(await runBackup({ source, group: 'public', toFile: file }));
    await freshDatabase(admin, 'from_file');
    const target = conn(servers.pgDst, 'from_file');
    expectClean(await runRestore({ target, file }));
    expect(await fingerprint(target, 'public')).toEqual(await sourcePrint(source, 'public'));
    const c = await query(target, `INSERT INTO customers (email, "fullName") VALUES ('new@example.com', 'New') RETURNING id`);
    expect(c.rows[0][0]).toBe(20001);
  });
});

for (const [label, src, dst] of [
  ['mysql 8.4 → mysql 8.4', servers.mysqlSrc, servers.mysqlDst],
  ['mariadb 11.4 → mariadb 11.4', servers.mariadbSrc, servers.mariadbDst],
] as const) {
  describe(label, () => {
    const source = conn(src);
    const admin = conn(dst);

    test('backup straight into another connection', async () => {
      await freshDatabase(admin, 'copy_conn');
      const r = await runBackup({ source, group: 'rdsql_src', target: admin, targetGroup: 'copy_conn' });
      expectClean(r);
      const target = conn(dst, 'copy_conn');
      expect(await fingerprint(target, 'copy_conn')).toEqual(await fingerprint(source, 'rdsql_src'));
      // AUTO_INCREMENT and defaults came across.
      await query(target, `INSERT INTO customers (email, full_name, created_at) VALUES ('new@example.com', 'New', NOW())`);
      const c = await query(target, `SELECT id, country FROM customers WHERE email = 'new@example.com'`);
      // MySQL's text protocol returns every value as a string.
      expect(c.rows[0]).toEqual(['20001', 'ID']);
    });

    test('backup to a file, then restore it', async () => {
      const file = path.join(tmp, `${src.engine}.sql`);
      expectClean(await runBackup({ source, group: 'rdsql_src', toFile: file }));
      await freshDatabase(admin, 'from_file');
      const target = conn(dst, 'from_file');
      expectClean(await runRestore({ target, file }));
      expect(await fingerprint(target, 'from_file')).toEqual(await fingerprint(source, 'rdsql_src'));
    });
  });
}
