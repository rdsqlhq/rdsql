// Backup → another connection, and backup → file → restore, for the extra
// engines: CockroachDB, YugabyteDB, TiDB, SQL Server (each in its own docker
// compose profile; skipped when its server isn't running) and the file-based
// SQLite and DuckDB (always run). Every copy is checked row for row.
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopBridge } from './bridge';
import { runBackup, runRestore, type RunResult } from './helpers';
import { engineCases, fingerprintAny, reachable, seed } from './engines';

afterAll(() => stopBridge());

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdsql-e2e-engine-files-'));
const only = process.env.E2E_ENGINES?.split(',').map((s) => s.trim());

function expectClean(r: RunResult) {
  const real = r.errors.filter((e) => !/session_replication_role|FOREIGN_KEY_CHECKS|foreign_keys/.test(e));
  if (r.status !== 'done' || real.length > 0) {
    console.log(r.log.split('\n').slice(-30).join('\n'));
    console.log(real.slice(0, 8).join('\n'));
  }
  expect(real).toEqual([]);
  expect(r.status).toBe('done');
}

for (const c of engineCases) {
  const enabled = (!only || only.includes(c.label)) && (await reachable(c));
  describe.runIf(enabled)(c.label, () => {
    const source = c.conn('rdsql_src');

    test('seed the source', async () => {
      await seed(c, 'rdsql_src');
      const print = await fingerprintAny(source, c.sourceGroup);
      expect(Object.keys(print).length).toBeGreaterThanOrEqual(5);
    });

    test('backup straight into another connection', async () => {
      await c.fresh('copy_conn');
      const target = c.conn('copy_conn');
      expectClean(await runBackup({ source, group: c.sourceGroup, target, targetGroup: c.targetGroup('copy_conn') }));
      const group = c.label === 'tidb' ? 'copy_conn' : c.sourceGroup === 'rdsql_src' ? 'copy_conn' : c.sourceGroup;
      const [got, want] = [await fingerprintAny(target, group), await fingerprintAny(source, c.sourceGroup)];
      for (const t of Object.keys(want)) if (got[t] !== want[t]) console.log(`DIFF ${c.label} ${t}: copy=${got[t]} source=${want[t]}`);
      expect(got).toEqual(want);
    });

    test('backup to a file, then restore it', async () => {
      const file = path.join(tmp, `${c.label}.sql`);
      expectClean(await runBackup({ source, group: c.sourceGroup, toFile: file }));
      await c.fresh('from_file');
      const target = c.conn('from_file');
      expectClean(await runRestore({ target, file }));
      const group = c.label === 'tidb' ? 'from_file' : c.sourceGroup === 'rdsql_src' ? 'from_file' : c.sourceGroup;
      const [got, want] = [await fingerprintAny(target, group), await fingerprintAny(source, c.sourceGroup)];
      for (const t of Object.keys(want)) if (got[t] !== want[t]) console.log(`DIFF ${c.label} ${t}: copy=${got[t]} source=${want[t]}`);
      expect(got).toEqual(want);
    });
  });
}
