// The extra engines in docker-compose.yml's profiles (CockroachDB, YugabyteDB,
// TiDB, SQL Server) plus the two file-based ones (SQLite, DuckDB): how to
// connect, how to make a fresh database, how to seed it, and how to
// fingerprint it for a row-for-row comparison.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseConnection } from '../../src/core/domain/types';
import { splitSqlStatements } from '../../src/core/backup/backupSql';
import { sqlDialectFor } from '../../src/core/sql/splitStatements';
import { query } from './helpers';
import { bridgeInvoke } from './bridge';

export interface EngineCase {
  label: string;
  /** docker compose profile that starts the server; absent for file engines. */
  profile?: string;
  seedFile: string;
  /** Connection to database `db` (created by `fresh` first). */
  conn: (db: string) => DatabaseConnection;
  /** What to pick in the Backup modal's target schema/database list for a
   *  copy into `db`; undefined when the list doesn't apply (SQLite). */
  targetGroup: (db: string) => string | undefined;
  /** The source's schema/database group in the Backup modal. */
  sourceGroup: string;
  /** Drops and recreates database `db`. */
  fresh: (db: string) => Promise<void>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdsql-e2e-engines-'));

function base(engine: string, port: number, username: string, password: string, database: string, sslMode = 'disable'): DatabaseConnection {
  return {
    id: `${engine}-${port}-${database}`,
    name: `${engine}:${port}/${database}`,
    engine,
    host: '127.0.0.1',
    port,
    username,
    password,
    database,
    sslMode,
  } as unknown as DatabaseConnection;
}

function file(engine: string, db: string): DatabaseConnection {
  const ext = engine === 'sqlite' ? 'sqlite' : 'duckdb';
  return { id: `${engine}-${db}`, name: `${engine}:${db}`, engine, filePath: path.join(tmp, `${db}.${ext}`), database: db } as unknown as DatabaseConnection;
}

function removeFile(c: DatabaseConnection) {
  const p = (c as unknown as { filePath: string }).filePath;
  for (const f of [p, `${p}.wal`, `${p}-journal`, `${p}-wal`, `${p}-shm`]) fs.rmSync(f, { force: true });
}

const pgFresh = (admin: DatabaseConnection) => async (db: string) => {
  await query(admin, `DROP DATABASE IF EXISTS "${db}" CASCADE`).catch(() => query(admin, `DROP DATABASE IF EXISTS "${db}"`));
  await query(admin, `CREATE DATABASE "${db}"`);
};

export const engineCases: EngineCase[] = [
  {
    label: 'cockroachdb',
    profile: 'cockroach',
    seedFile: 'pg-compat.sql',
    conn: (db) => base('cockroachdb', 56257, 'root', '', db),
    targetGroup: () => 'public',
    sourceGroup: 'public',
    fresh: pgFresh(base('cockroachdb', 56257, 'root', '', 'defaultdb')),
  },
  {
    label: 'yugabytedb',
    profile: 'yugabyte',
    seedFile: 'pg-compat.sql',
    conn: (db) => base('yugabytedb', 55434, 'yugabyte', '', db),
    targetGroup: () => 'public',
    sourceGroup: 'public',
    fresh: async (db) => {
      const admin = base('yugabytedb', 55434, 'yugabyte', '', 'yugabyte');
      await query(admin, `DROP DATABASE IF EXISTS "${db}"`);
      await query(admin, `CREATE DATABASE "${db}"`);
    },
  },
  {
    label: 'tidb',
    profile: 'tidb',
    seedFile: 'mysql.sql',
    conn: (db) => base('tidb', 54000, 'root', '', db),
    targetGroup: (db) => db,
    sourceGroup: 'rdsql_src',
    fresh: async (db) => {
      const admin = base('tidb', 54000, 'root', '', '');
      await query(admin, `DROP DATABASE IF EXISTS \`${db}\``);
      await query(admin, `CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    },
  },
  {
    label: 'mssql',
    profile: 'mssql',
    seedFile: 'mssql.sql',
    conn: (db) => base('mssql', 51433, 'sa', 'rdSQL_dev_Passw0rd!', db, ''),
    targetGroup: (db) => db,
    sourceGroup: 'rdsql_src',
    fresh: async (db) => {
      const admin = base('mssql', 51433, 'sa', 'rdSQL_dev_Passw0rd!', 'master', '');
      await query(admin, `IF DB_ID('${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END`);
      await query(admin, `CREATE DATABASE [${db}]`);
    },
  },
  {
    label: 'sqlite',
    seedFile: 'sqlite.sql',
    conn: (db) => file('sqlite', db),
    targetGroup: () => undefined,
    sourceGroup: 'main',
    fresh: async (db) => removeFile(file('sqlite', db)),
  },
  {
    label: 'duckdb',
    seedFile: 'duckdb.sql',
    conn: (db) => file('duckdb', db),
    targetGroup: () => undefined,
    sourceGroup: 'main',
    fresh: async (db) => removeFile(file('duckdb', db)),
  },
];

/** True when the case's server answers (file engines always do). */
export async function reachable(c: EngineCase): Promise<boolean> {
  if (!c.profile) return true;
  const admin = c.label === 'tidb' ? c.conn('') : c.label === 'mssql' ? c.conn('master') : c.label === 'yugabytedb' ? c.conn('yugabyte') : c.conn('defaultdb');
  return query(admin, 'SELECT 1').then(
    () => true,
    () => false
  );
}

/** Recreates database `db` and loads the case's seed file into it. */
export async function seed(c: EngineCase, db: string): Promise<void> {
  await c.fresh(db);
  const target = c.conn(db);
  let sql = fs.readFileSync(path.join(__dirname, 'seed', c.seedFile), 'utf8');
  // mysql.sql is written for the docker init path (its own database name).
  sql = sql.replace(/^(SET NAMES|ALTER DATABASE|USE) [^\n]*\n/gm, '');
  // One session, so session settings (SQL Server's IDENTITY_INSERT) hold.
  const sessionId = (await bridgeInvoke('session_open', { config: target })) as string;
  try {
    for (const stmt of splitSqlStatements(sql, sqlDialectFor(target.engine))) {
      if (/^\s*ANALYZE/i.test(stmt)) continue;
      await bridgeInvoke('session_execute', { sessionId, sql: stmt, queryId: `seed_${Date.now()}` });
    }
  } finally {
    await bridgeInvoke('session_close', { sessionId });
  }
}

// ── Fingerprints ──────────────────────────────────────────────────────────

/** Per base table: row count and a hash over every row's contents, in a form
 *  that is equal for two databases exactly when their rows are. */
export async function fingerprintAny(c: DatabaseConnection, group: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const fam = c.engine;
  if (fam === 'sqlite') {
    const tables = await query(c, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY 1`);
    for (const [t] of tables.rows) {
      const cols = await query(c, `SELECT name FROM pragma_table_info('${t}')`);
      const expr = cols.rows.map(([n]) => `quote("${n}")`).join(` || '|' || `);
      const r = await query(c, `SELECT count(*), group_concat(x, char(10)) FROM (SELECT ${expr} AS x FROM "${t}" ORDER BY x)`);
      out[String(t)] = `${r.rows[0][0]} ${crypto.createHash('md5').update(String(r.rows[0][1] ?? '')).digest('hex')}`;
    }
    return out;
  }
  if (fam === 'mssql') {
    const cols = await query(
      c,
      `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA = 'dbo' ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`
    );
    const byTable = new Map<string, string[]>();
    for (const [t, col, type] of cols.rows) {
      const ty = String(type);
      const conv = /binary|image/.test(ty)
        ? `CONVERT(NVARCHAR(MAX), CONVERT(VARBINARY(MAX), [${col}]), 2)`
        : /date|time/.test(ty)
          ? `CONVERT(NVARCHAR(MAX), [${col}], 126)`
          : /float|real/.test(ty)
            ? `CONVERT(NVARCHAR(MAX), [${col}], 3)`
            : `CONVERT(NVARCHAR(MAX), [${col}])`;
      byTable.set(String(t), [...(byTable.get(String(t)) || []), `ISNULL(${conv}, N'<null>')`]);
    }
    for (const [t, exprs] of byTable) {
      const r = await query(
        c,
        `SELECT COUNT(*), CAST(SUM(CAST(CAST(HASHBYTES('SHA2_256', x) AS BINARY(4)) AS INT) * CAST(1 AS BIGINT)) AS VARCHAR(40))
         FROM (SELECT CONCAT_WS('|', N'', ${exprs.join(', ')}) AS x FROM [dbo].[${t}]) s`
      );
      out[t] = `${r.rows[0][0]} ${r.rows[0][1]}`;
    }
    return out;
  }
  if (fam === 'tidb') {
    const { fingerprint } = await import('./helpers');
    return fingerprint(c, group);
  }
  // Postgres-compatible servers and DuckDB.
  const cast = fam === 'duckdb' ? 'VARCHAR' : 'text';
  const cols = await query(
    c,
    `SELECT c.table_name, c.column_name FROM information_schema.columns c JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = '${group}' AND t.table_type = 'BASE TABLE' ORDER BY c.table_name, c.ordinal_position`
  );
  const byTable = new Map<string, string[]>();
  for (const [t, col] of cols.rows) {
    byTable.set(String(t), [...(byTable.get(String(t)) || []), `coalesce(CAST("${col}" AS ${cast}), '<null>')`]);
  }
  for (const [t, exprs] of byTable) {
    const r = await query(
      c,
      `SELECT CAST(count(*) AS ${cast}), md5(coalesce(string_agg(x, '~' ORDER BY x), '')) FROM (SELECT concat_ws('|', ${exprs.join(', ')}) AS x FROM "${group}"."${t}") s`
    );
    out[t] = `${r.rows[0][0]} ${r.rows[0][1]}`;
  }
  return out;
}
