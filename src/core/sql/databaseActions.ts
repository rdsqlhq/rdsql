/**
 * Engine-aware database / schema-level SQL generators.
 *
 * Mirrors `tableActions.ts` but operates at the database/schema level for the
 * Explorer group nodes. The semantics of a "group node" depend on the engine:
 *
 *   MySQL / MariaDB → the group IS a database (`information_schema.SCHEMATA`)
 *   PostgreSQL      → the group is a SCHEMA within the connection's database
 *   SQLite / D1     → a single `main` group (the whole file — no drop applies)
 *
 * IMPORTANT: `group.node_type` from the backend is ALWAYS `"schema"` (even for
 * MySQL), so capability/SQL decisions branch on `engine`, never on `node_type`.
 *
 * All identifiers are quoted via the existing `quoteIdent` helper. No SQL is
 * executed here — pure functions, unit-tested in `__tests__/databaseActions.test.ts`.
 */
import { quoteIdent } from './ident';
import { isMysqlFamily, isPostgresFamily } from '../connection/engines';

// ───────────────────────── Engine normalization ─────────────────────────

export function normalizeEngine(engine: string): string {
  return engine.toLowerCase();
}

/** What a group node represents for this engine. */
export type GroupKind = 'database' | 'schema' | 'file';

/** Resolve what a group node means for the connected engine. */
export function groupKind(engine: string): GroupKind {
  const e = normalizeEngine(engine);
  switch (e) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return 'database';
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return 'schema';
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      return 'file';
    case 'mssql':
    case 'sqlserver':
      return 'database';
    default:
      return 'file';
  }
}

// ───────────────────────── Capabilities ─────────────────────────

export interface DatabaseCapabilities {
  /** True if the group can be dropped (DROP DATABASE / DROP SCHEMA). */
  supportsDrop: boolean;
  /** True if a new schema/database can be created on this connection. */
  supportsCreate: boolean;
  /** True if the database can be emptied (drop + recreate, keeping it browsable). */
  supportsEmpty: boolean;
  /** Human label for the droppable entity: "Database" (MySQL) / "Schema" (Postgres). */
  entityLabel: string;
}

export function getDatabaseCapabilities(engine: string): DatabaseCapabilities {
  const e = normalizeEngine(engine);
  switch (e) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return { supportsDrop: true, supportsCreate: true, supportsEmpty: true, entityLabel: 'Database' };
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return { supportsDrop: true, supportsCreate: true, supportsEmpty: true, entityLabel: 'Schema' };
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      // Single file/main group — dropping or recreating the whole DB is not applicable.
      return { supportsDrop: false, supportsCreate: false, supportsEmpty: false, entityLabel: 'Database' };
    case 'mssql':
    case 'sqlserver':
      return { supportsDrop: true, supportsCreate: true, supportsEmpty: true, entityLabel: 'Database' };
    default:
      return { supportsDrop: false, supportsCreate: false, supportsEmpty: false, entityLabel: 'Database' };
  }
}

// ───────────────────────── System DB protection ─────────────────────────

/** MySQL/MariaDB system databases that must never be dropped. */
const PROTECTED_DATABASES = new Set([
  'information_schema',
  'mysql',
  'performance_schema',
  'sys',
]);

/** Postgres system schemas that must never be dropped. */
const PROTECTED_SCHEMAS = new Set([
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'public', // dropping `public` is technically possible but almost always a mistake
]);

/** SQL Server system databases that must never be dropped. */
const PROTECTED_MSSQL_DATABASES = new Set([
  'master',
  'tempdb',
  'model',
  'msdb',
]);

/** True if the name is a system database/schema that we refuse to drop. */
export function isProtectedName(engine: string, name: string): boolean {
  const e = normalizeEngine(engine);
  const lower = name.toLowerCase();
  if (isMysqlFamily(e)) return PROTECTED_DATABASES.has(lower);
  if (isPostgresFamily(e)) return PROTECTED_SCHEMAS.has(lower);
  if (e === 'mssql' || e === 'sqlserver') return PROTECTED_MSSQL_DATABASES.has(lower);
  return false;
}

// ───────────────────────── DROP ─────────────────────────

/**
 * Generate `DROP DATABASE` (MySQL) or `DROP SCHEMA` (Postgres) SQL.
 *
 * Postgres uses `DROP SCHEMA ... CASCADE` by default because a schema with
 * objects cannot be dropped without it — the user has already confirmed via
 * type-to-confirm, and RESTRICT (the default) would just fail on any
 * non-empty schema. MySQL `DROP DATABASE` always cascades implicitly.
 *
 * Returns `null` when the engine/group does not support dropping (SQLite/D1),
 * or when the name is a protected system entity.
 */
export function dropDatabaseSql(engine: string, name: string): string | null {
  if (isProtectedName(engine, name)) return null;
  const e = normalizeEngine(engine);
  const q = quoteIdent(engine, name);
  switch (e) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return `DROP DATABASE ${q};`;
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return `DROP SCHEMA ${q} CASCADE;`;
    case 'mssql':
    case 'sqlserver':
      return `DROP DATABASE ${q};`;
    default:
      return null;
  }
}

// ───────────────────────── CREATE ─────────────────────────

/**
 * Generate `CREATE DATABASE` (MySQL) or `CREATE SCHEMA` (Postgres) SQL.
 * Returns null for SQLite/D1.
 */
export function createDatabaseSql(engine: string, name: string, charset?: string): string | null {
  const e = normalizeEngine(engine);
  const q = quoteIdent(engine, name);
  switch (e) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale': {
      let sql = `CREATE DATABASE ${q}`;
      if (charset && charset.trim()) sql += ` CHARACTER SET ${charset.trim()}`;
      return `${sql};`;
    }
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return `CREATE SCHEMA IF NOT EXISTS ${q};`;
    case 'mssql':
    case 'sqlserver':
      return `CREATE DATABASE ${q};`;
    default:
      return null;
  }
}

// ───────────────────────── EMPTY ─────────────────────────

/**
 * Empty a database/schema: drop every table/view it contains, then (MySQL only)
 * recreate the database to reset it to a pristine state. For Postgres, dropping
 * and recreating the schema is the cleanest equivalent.
 *
 * Returns an array of statements to execute in order. Empty array when the
 * engine doesn't support it.
 *
 * Note: the table names to drop must be resolved at call time from the live
 * schema tree — this helper takes them as an argument so it stays pure.
 */
export function emptyDatabaseSql(
  engine: string,
  name: string,
  childTableNames: string[]
): string[] {
  const e = normalizeEngine(engine);
  const q = quoteIdent(engine, name);
  const stmts: string[] = [];

  switch (e) {
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      // Drop + recreate the database. Faster than dropping each table and
      // resets AUTO_INCREMENT + privileges to defaults.
      if (!isProtectedName(engine, name)) {
        stmts.push(`DROP DATABASE ${q};`);
        stmts.push(`CREATE DATABASE ${q};`);
      }
      return stmts;
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      // Drop + recreate the schema. CASCADE handles dependent objects.
      if (!isProtectedName(engine, name)) {
        stmts.push(`DROP SCHEMA ${q} CASCADE;`);
        stmts.push(`CREATE SCHEMA ${q};`);
      }
      return stmts;
    case 'sqlite':
    case 'cloudflare-d1':
    case 'd1':
      // SQLite: no DROP DATABASE — delete from each table instead.
      for (const t of childTableNames) {
        stmts.push(`DELETE FROM ${quoteIdent(engine, t)};`);
      }
      return stmts;
    case 'mssql':
    case 'sqlserver':
      // Drop + recreate the database, same rationale as MySQL/Postgres above.
      if (!isProtectedName(engine, name)) {
        stmts.push(`DROP DATABASE ${q};`);
        stmts.push(`CREATE DATABASE ${q};`);
      }
      return stmts;
    default:
      return [];
  }
}
