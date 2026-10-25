// Drives the real BackupModal / RestoreModal in jsdom, and fingerprints
// databases so a test can check a copy matches its source row for row.
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { DatabaseConnection, QueryResultData } from '../../src/core/domain/types';
import { isPostgresServer } from '../../src/core/connection/engines';
import { bridgeInvoke, calls } from './bridge';
import { dialogState } from './setup';

const PW = 'rdsql_dev_pw';

/** Connections to the servers in docker-compose.yml. */
export const servers = {
  pgSrc: { engine: 'postgres', host: '127.0.0.1', port: 55432, username: 'rdsql', database: 'rdsql_src' },
  pgDst: { engine: 'postgres', host: '127.0.0.1', port: 55433, username: 'rdsql', database: 'postgres' },
  mysqlSrc: { engine: 'mysql', host: '127.0.0.1', port: 53306, username: 'root', database: 'rdsql_src' },
  mysqlDst: { engine: 'mysql', host: '127.0.0.1', port: 53307, username: 'root', database: '' },
  mariadbSrc: { engine: 'mariadb', host: '127.0.0.1', port: 53308, username: 'root', database: 'rdsql_src' },
  mariadbDst: { engine: 'mariadb', host: '127.0.0.1', port: 53309, username: 'root', database: '' },
} as const;

export function conn(server: (typeof servers)[keyof typeof servers], database?: string): DatabaseConnection {
  const db = database ?? server.database;
  return {
    id: `${server.engine}-${server.port}-${db}`,
    name: `${server.engine}:${server.port}/${db}`,
    password: PW,
    sslMode: 'disable',
    ...server,
    database: db,
  } as unknown as DatabaseConnection;
}

export async function query(c: DatabaseConnection, sql: string): Promise<QueryResultData> {
  return (await bridgeInvoke('execute_query', { request: { config: c, sql }, queryId: `e2e_${Date.now()}` })) as QueryResultData;
}

/** Drops and recreates `name` on the server `admin` is connected to. */
export async function freshDatabase(admin: DatabaseConnection, name: string): Promise<void> {
  if (isPostgresServer(admin.engine)) {
    await query(admin, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await query(admin, `CREATE DATABASE "${name}"`);
  } else {
    await query(admin, `DROP DATABASE IF EXISTS \`${name}\``);
    await query(admin, `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
}

/** Per base table: row count and a hash over every row's contents. */
export async function fingerprint(c: DatabaseConnection, schema: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (isPostgresServer(c.engine)) {
    const tables = await query(c, `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY 1`);
    for (const [t] of tables.rows) {
      const r = await query(c, `SELECT count(*)::text, md5(coalesce(string_agg(r::text, E'\\n' ORDER BY r::text), '')) FROM "${schema}"."${t}" r`);
      out[String(t)] = `${r.rows[0][0]} ${r.rows[0][1]}`;
    }
    return out;
  }
  const cols = await query(
    c,
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${schema}'
     AND TABLE_NAME IN (SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}' AND TABLE_TYPE = 'BASE TABLE')
     ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const byTable = new Map<string, string[]>();
  for (const [t, col, type] of cols.rows) {
    const binary = /binary|blob|bit/i.test(String(type));
    const expr = binary ? `HEX(\`${col}\`)` : `CAST(\`${col}\` AS CHAR)`;
    byTable.set(String(t), [...(byTable.get(String(t)) || []), `COALESCE(${expr}, '<null>')`]);
  }
  for (const [t, exprs] of byTable) {
    const r = await query(c, `SELECT COUNT(*), CAST(COALESCE(SUM(CRC32(CONCAT_WS('|', ${exprs.join(', ')}))), 0) AS CHAR) FROM \`${schema}\`.\`${t}\``);
    out[t] = `${r.rows[0][0]} ${r.rows[0][1]}`;
  }
  return out;
}

// ── Driving the modals ────────────────────────────────────────────────────

async function waitFor(el: HTMLElement, fn: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}. Modal text: ${el.textContent?.slice(0, 1500)}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
  }
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].filter((b) => b.textContent?.trim().includes(label)).pop();
  if (!found) throw new Error(`No "${label}" button`);
  return found;
}

async function setSelect(sel: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function mount(node: React.ReactNode): Promise<{ el: HTMLElement; unmount: () => void }> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return {
    el,
    unmount: () => {
      act(() => root.unmount());
      el.remove();
    },
  };
}

export interface RunResult {
  status: string;
  /** Failed backend calls (FK toggles a managed server refuses included). */
  errors: string[];
  log: string;
}

function collect(el: HTMLElement, status: string, firstCall: number): RunResult {
  const errors = calls.slice(firstCall).filter((c) => c.err).map((c) => `${c.cmd}: ${c.err} :: ${(c.sql || '').slice(0, 200)}`);
  const log = [...el.querySelectorAll('.font-mono div')].map((d) => d.textContent).join('\n');
  return { status, errors, log };
}

/**
 * Runs a backup from `source` (schema/database `group`), either straight into
 * `target` (picking `targetGroup` in its schema/database list) or into the
 * file `toFile`.
 */
export async function runBackup(opts: {
  source: DatabaseConnection;
  group: string;
  target?: DatabaseConnection;
  targetGroup?: string;
  toFile?: string;
  speed?: 'fast' | 'safe';
}): Promise<RunResult> {
  const { useConnectionStore } = await import('../../src/store/useConnectionStore');
  const { BackupModal } = await import('../../src/components/backup/BackupModal');
  useConnectionStore.setState({ connections: [opts.source, ...(opts.target ? [opts.target] : [])] });
  const firstCall = calls.length;
  const { el, unmount } = await mount(<BackupModal connection={opts.source} onClose={() => {}} initialGroupName={opts.group} />);
  try {
    await waitFor(el, () => /Tables \(\d+\)/.test(el.textContent || ''), 60_000, 'the table list');
    if (opts.target) {
      await act(async () => button(el, 'DB Connection').click());
      const connSelect = [...el.querySelectorAll('select')].find((s) => s.textContent?.includes('Select a connection'))!;
      await setSelect(connSelect, opts.target.id);
      const groupSelect = () =>
        [...el.querySelectorAll('select')].find((s) => /Select a (schema|database)/.test(s.textContent || ''));
      if (opts.targetGroup !== undefined) {
        await waitFor(el, () => !!groupSelect() && [...groupSelect()!.options].some((o) => o.value === opts.targetGroup), 60_000, 'the target schema list');
        await setSelect(groupSelect()!, opts.targetGroup);
      }
    } else {
      dialogState.path = opts.toFile!;
    }
    if (opts.speed === 'safe') await act(async () => button(el, 'Safe').click());
    await act(async () => button(el, 'Start Backup').click());
    await waitFor(el, () => /Backup complete|Completed with errors|Paused on|Stopped:/.test(el.textContent || ''), 25 * 60_000, 'the backup to finish');
    const status = /Backup complete/.test(el.textContent || '') ? 'done' : 'failed';
    return collect(el, status, firstCall);
  } finally {
    unmount();
  }
}

/** Restores the backup file `file` into `target` through the Restore modal. */
export async function runRestore(opts: { target: DatabaseConnection; file: string }): Promise<RunResult> {
  const { RestoreModal } = await import('../../src/components/backup/RestoreModal');
  const firstCall = calls.length;
  const { el, unmount } = await mount(<RestoreModal connection={opts.target} onClose={() => {}} />);
  try {
    dialogState.path = opts.file;
    await act(async () => button(el, 'Choose a .sql file').click());
    await waitFor(el, () => /(backup|script) · [\d.]+ (B|KB|MB|GB)/.test(el.textContent || ''), 60_000, 'the file to load');
    await act(async () => button(el, 'Run Restore').click());
    await waitFor(el, () => /Done|Completed with errors|Paused/.test(el.textContent || '') && !/Processing|Importing|Creating/.test(el.textContent || ''), 25 * 60_000, 'the restore to finish');
    const status = /Restore complete/.test(el.textContent || '') ? 'done' : 'failed';
    return collect(el, status, firstCall);
  } finally {
    unmount();
  }
}

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export interface MigrateResult {
  plans: { table: string; createTableSql: string; warnings: string[] }[];
  summary: { tables: { table: string; rowsMigrated: number; error: string | null }[]; totalRows: number } | null;
  error: string | null;
  text: string;
}

/** Runs the cross-engine Migrate Database wizard from `source` (database or
 *  schema `group`) into `target`, all tables selected. */
export async function runMigration(opts: { source: DatabaseConnection; group: string; target: DatabaseConnection }): Promise<MigrateResult> {
  const { useConnectionStore } = await import('../../src/store/useConnectionStore');
  const { DatabaseMigrationWizard } = await import('../../src/components/migrate/DatabaseMigrationWizard');
  useConnectionStore.setState({ connections: [opts.source, opts.target] });
  const firstCall = calls.length;
  const { el, unmount } = await mount(<DatabaseMigrationWizard />);
  try {
    const selects = () => [...el.querySelectorAll('select')];
    await waitFor(el, () => selects().length >= 3, 60_000, 'the wizard selects');
    await setSelect(selects()[0], opts.source.id);
    await setSelect(selects()[2], opts.target.id);
    await waitFor(el, () => [...selects()[1].options].some((o) => o.value === opts.group), 60_000, 'the source databases');
    await setSelect(selects()[1], opts.group);
    await waitFor(el, () => /Preview schema for [1-9]\d* table/.test(el.textContent || ''), 60_000, 'the source tables');
    await act(async () => button(el, 'Preview schema').click());
    await waitFor(el, () => /Continue to run|Failed|error/i.test(el.textContent || '') && !/Generating schema/.test(el.textContent || ''), 120_000, 'the schema preview');
    if (el.textContent!.includes('Continue to run')) {
      await act(async () => button(el, 'Continue to run').click());
      const token = opts.target.scopeDatabase || opts.target.database || opts.target.name;
      await waitFor(el, () => !!el.querySelector('input[type="text"]'), 30_000, 'the confirm box');
      await setInput(el.querySelector('input[type="text"]') as HTMLInputElement, token);
      await act(async () => button(el, 'Run migration').click());
      await waitFor(el, () => calls.slice(firstCall).some((c) => c.cmd === 'db_migrate_run' && (c.result || c.err)), 25 * 60_000, 'the migration to finish');
    }
    const plan = calls.slice(firstCall).find((c) => c.cmd === 'db_migrate_plan_tables');
    const run = calls.slice(firstCall).find((c) => c.cmd === 'db_migrate_run');
    return {
      plans: (plan?.result as MigrateResult['plans']) ?? [],
      summary: (run?.result as MigrateResult['summary']) ?? null,
      error: plan?.err ?? run?.err ?? null,
      text: el.textContent || '',
    };
  } finally {
    unmount();
  }
}
