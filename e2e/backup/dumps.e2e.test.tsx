// Restoring dumps made by the databases' own tools, pg_dump and mysqldump,
// through the Restore screen. The dumps are created from the seeded sources
// with the tools inside the docker containers, then restored into an empty
// database and compared to the source row for row.
import { afterAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopBridge } from './bridge';
import { conn, fingerprint, freshDatabase, query, runRestore, servers, type RunResult } from './helpers';

afterAll(() => stopBridge());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdsql-e2e-dumps-'));
const compose = ['compose', '-f', path.join(__dirname, 'docker-compose.yml')];

/** Runs a dump tool in a container and saves its output. */
function dump(service: string, args: string[], file: string): string {
  const out = execFileSync('docker', [...compose, 'exec', '-T', service, ...args], { maxBuffer: 1 << 30 });
  const target = path.join(tmp, file);
  fs.writeFileSync(target, out);
  return target;
}

function expectClean(r: RunResult) {
  if (r.status !== 'done' || r.errors.length) console.log(r.log.split('\n').slice(-20).join('\n'), r.errors.slice(0, 5));
  expect(r.errors).toEqual([]);
  expect(r.status).toBe('done');
}

describe('pg_dump', () => {
  test('a plain pg_dump script restores exactly', async () => {
    // pg_dump 17 from the target's container, against the 16 source: the
    // usual "newer tools, older server" setup, and it writes \restrict.
    const file = dump(
      'pg-dst',
      ['env', 'PGPASSWORD=rdsql_dev_pw', 'pg_dump', '-h', 'pg-src', '-U', 'rdsql', '--no-owner', 'rdsql_src'],
      'pg_dump.sql'
    );
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('COPY public.order_items');

    await freshDatabase(conn(servers.pgDst), 'from_pg_dump');
    const target = conn(servers.pgDst, 'from_pg_dump');
    expectClean(await runRestore({ target, file }));
    expect(await fingerprint(target, 'public')).toEqual(await fingerprint(conn(servers.pgSrc), 'public'));
    // Sequences, defaults, enums and constraints came from the dump itself.
    const c = await query(target, `INSERT INTO customers (email, "fullName") VALUES ('new@example.com', 'New') RETURNING id, country`);
    expect(c.rows[0]).toEqual([20001, 'ID']);
    const fk = await query(target, `SELECT count(*)::int FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'`);
    expect(fk.rows[0][0]).toBeGreaterThan(0);
  });

  test('ownership and grants for roles that do not exist are skipped', async () => {
    // With owners kept, the script names role "rdsql" … which exists here,
    // so add a grant to a role that doesn't.
    const file = dump('pg-dst', ['env', 'PGPASSWORD=rdsql_dev_pw', 'pg_dump', '-h', 'pg-src', '-U', 'rdsql', '-t', 'audit_log', 'rdsql_src'], 'pg_dump_owned.sql');
    fs.appendFileSync(file, '\nGRANT SELECT ON public.audit_log TO nobody_here;\nALTER TABLE public.audit_log OWNER TO nobody_here;\n');
    await freshDatabase(conn(servers.pgDst), 'from_pg_dump_owned');
    const target = conn(servers.pgDst, 'from_pg_dump_owned');
    const r = await runRestore({ target, file });
    expectClean(r);
    expect(r.log).toMatch(/Skipped \d+ privileges statements?/);
    expect(r.log).toMatch(/Skipped \d+ ownership statements?/);
  });
});

for (const [label, server, service] of [
  ['mysqldump (MySQL 8.4)', servers.mysqlSrc, 'mysql-src'],
  ['mariadb-dump (MariaDB 11.4)', servers.mariadbSrc, 'mariadb-src'],
] as const) {
  describe(label, () => {
    test('restores exactly', async () => {
      const tool = service === 'mysql-src' ? 'mysqldump' : 'mariadb-dump';
      const file = dump(service, [tool, '-uroot', '-prdsql_dev_pw', '--routines', '--triggers', '--databases', 'rdsql_src'], `${service}.sql`);
      // --databases writes CREATE DATABASE + USE rdsql_src; the USE must be
      // skipped so the rows land in the database being restored into.
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^USE `rdsql_src`;/m);

      const dst = service === 'mysql-src' ? servers.mysqlDst : servers.mariadbDst;
      await freshDatabase(conn(dst), 'from_dump');
      const target = conn(dst, 'from_dump');
      expectClean(await runRestore({ target, file }));
      const [got, want] = [await fingerprint(target, 'from_dump'), await fingerprint(conn(server), 'rdsql_src')];
      for (const t of Object.keys(want)) if (got[t] !== want[t]) console.log(`DIFF ${label} ${t}: copy=${got[t]} source=${want[t]}`);
      expect(got).toEqual(want);
    });
  });
}
