// Backup from the local Postgres source into a real Neon project, through the
// Backup screen, with the target saved as a "Neon" connection. Skipped unless
// E2E_NEON_URL is set to a Neon connection string, e.g.
//
//   E2E_NEON_URL='postgresql://user:pw@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require' \
//     npx vitest run -c e2e/vitest.config.ts e2e/backup/neon.e2e.test.tsx
//
// Works in a scratch database (`rdsql_e2e_neon`) that it creates and drops;
// the database in the URL is only used to run CREATE/DROP DATABASE.
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConnectionUrl } from '../../src/core/connection/envImport';
import type { DatabaseConnection } from '../../src/core/domain/types';
import { stopBridge } from './bridge';
import { conn, fingerprint, query, runBackup, runRestore, servers, type RunResult } from './helpers';

const url = process.env.E2E_NEON_URL;
const SCRATCH = 'rdsql_e2e_neon';

function neon(database: string): DatabaseConnection {
  const p = parseConnectionUrl(url!);
  return {
    id: `neon-${database}`,
    name: `Neon ${database}`,
    engine: p.engine,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
    sslMode: p.sslMode,
    database,
  } as unknown as DatabaseConnection;
}

function expectClean(r: RunResult) {
  // Neon never grants superuser, so the FK-check toggle is always refused.
  const real = r.errors.filter((e) => !/session_replication_role/.test(e));
  if (r.status !== 'done' || real.length) console.log(r.log.split('\n').slice(-30).join('\n'), real.slice(0, 5));
  expect(real).toEqual([]);
  expect(r.status).toBe('done');
}

describe.runIf(!!url)('postgres → neon', () => {
  const admin = () => neon(parseConnectionUrl(url!).database || 'neondb');
  const fresh = async () => {
    await query(admin(), `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`);
    await query(admin(), `CREATE DATABASE "${SCRATCH}"`);
  };

  afterAll(async () => {
    await query(admin(), `DROP DATABASE IF EXISTS "${SCRATCH}" WITH (FORCE)`).catch(() => {});
    stopBridge();
  });

  test('a pasted Neon URL becomes a Neon connection', () => {
    expect(neon(SCRATCH).engine).toBe('neon');
    expect(neon(SCRATCH).sslMode).toBe('require');
  });

  test('backup straight into the Neon connection', async () => {
    await fresh();
    const source = conn(servers.pgSrc);
    const target = neon(SCRATCH);
    expectClean(await runBackup({ source, group: 'public', target, targetGroup: 'public' }));
    expect(await fingerprint(target, 'public')).toEqual(await fingerprint(source, 'public'));
    const c = await query(target, `INSERT INTO customers (email, "fullName") VALUES ('new@example.com', 'New') RETURNING id`);
    expect(c.rows[0][0]).toBe(20001);
  });

  test('restore a backup file into Neon', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rdsql-e2e-neon-')), 'pg.sql');
    const source = conn(servers.pgSrc);
    expectClean(await runBackup({ source, group: 'public', toFile: file }));
    await fresh();
    const target = neon(SCRATCH);
    expectClean(await runRestore({ target, file }));
    expect(await fingerprint(target, 'public')).toEqual(await fingerprint(source, 'public'));
  });
});
