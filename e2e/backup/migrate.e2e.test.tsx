// The Migrate Database wizard between engines: MySQL → Postgres,
// Postgres → MySQL, and SQL Server → both, using the seeded sources from
// docker-compose.yml.
import { afterAll, describe, expect, test } from 'vitest';
import { stopBridge } from './bridge';
import { conn, freshDatabase, query, runMigration, servers, type MigrateResult } from './helpers';
import { engineCases, reachable, seed } from './engines';

afterAll(() => stopBridge());

function report(r: MigrateResult) {
  const failed = r.summary?.tables.filter((t) => t.error) ?? [];
  if (r.error || failed.length) {
    console.log('error:', r.error);
    for (const t of failed) console.log(`${t.table}: ${t.error}`);
  }
  return failed;
}

async function counts(c: ReturnType<typeof conn>, tables: string[], quote: (t: string) => string) {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await query(c, `SELECT COUNT(*) FROM ${quote(t)}`)).rows[0][0]);
  return out;
}

describe('migrate between engines', () => {
  test('mysql → postgres', async () => {
    const admin = conn(servers.pgDst);
    await freshDatabase(admin, 'from_mysql');
    const target = conn(servers.pgDst, 'from_mysql');
    const source = conn(servers.mysqlSrc);
    const r = await runMigration({ source, group: 'rdsql_src', target });
    expect(report(r)).toEqual([]);
    expect(r.error).toBeNull();
    const tables = r.summary!.tables.map((t) => t.table);
    expect(await counts(target, tables, (t) => `"${t}"`)).toEqual(await counts(source, tables, (t) => `\`${t}\``));
    const v = await query(target, `SELECT encode(bin, 'hex'), txt, js::text FROM type_zoo WHERE id = 2`);
    const s = await query(source, `SELECT LOWER(HEX(bin)), txt, CAST(js AS CHAR) FROM type_zoo WHERE id = 2`);
    expect(v.rows[0][0]).toBe(s.rows[0][0]);
    expect(v.rows[0][1]).toBe(s.rows[0][1]);
  });

  test('postgres → mysql', async () => {
    const admin = conn(servers.mysqlDst);
    await freshDatabase(admin, 'from_pg');
    const target = conn(servers.mysqlDst, 'from_pg');
    const source = conn(servers.pgSrc);
    const r = await runMigration({ source, group: 'public', target });
    expect(report(r)).toEqual([]);
    expect(r.error).toBeNull();
    const tables = r.summary!.tables.map((t) => t.table);
    expect(await counts(target, tables, (t) => `\`${t}\``)).toEqual(await counts(source, tables, (t) => `"${t}"`));
  });
});

// SQL Server is source-only in the wizard. Needs the `mssql` profile running
// (and seeded by engines.e2e.test.tsx) next to the default stack.
const mssql = engineCases.find((c) => c.label === 'mssql')!;
const mssqlUp = await reachable(mssql);

describe.runIf(mssqlUp)('migrate from SQL Server', () => {
  const source = mssql.conn('rdsql_src');

  test('seed the SQL Server source', async () => {
    await seed(mssql, 'rdsql_src');
  });

  for (const [label, server, quote] of [
    ['sql server → postgres', servers.pgDst, (t: string) => `"${t}"`],
    ['sql server → mysql', servers.mysqlDst, (t: string) => `\`${t}\``],
  ] as const) {
    test(label, async () => {
      await freshDatabase(conn(server), 'from_mssql');
      const target = conn(server, 'from_mssql');
      const r = await runMigration({ source, group: 'rdsql_src', target });
      expect(report(r)).toEqual([]);
      expect(r.error).toBeNull();
      const tables = r.summary!.tables.map((t) => t.table);
      expect(tables.length).toBeGreaterThanOrEqual(5);
      expect(await counts(target, tables, quote)).toEqual(await counts(source, tables, (t) => `[${t}]`));
      // Unicode text survives the trip.
      const s = await query(source, `SELECT full_name FROM customers WHERE id = 50`);
      const d = await query(target, `SELECT full_name FROM ${quote('customers')} WHERE id = 50`);
      expect(d.rows[0][0]).toBe(s.rows[0][0]);
    });
  }
});
