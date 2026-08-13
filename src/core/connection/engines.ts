import type { DatabaseEngine, EngineFamily } from '../domain/types';

/** Display + connection metadata for a single database engine. This is the
 *  single source of truth for the engine picker in the connection modal —
 *  adding a new wire-compatible engine is a one-entry change here. */
export interface EngineMeta {
  id: DatabaseEngine;
  /** Human-readable label shown in the engine dropdown. */
  label: string;
  /** Wire-protocol family — drives form layout, quoting, and capabilities.
   *  Omitted for engines with no SQL family at all (Redis: use
   *  `isRedisEngine()` instead of trying to fit it into a family). */
  family?: EngineFamily;
  /** Default TCP port. Omitted for file/REST engines (sqlite, cloudflare-d1). */
  defaultPort?: number;
  /** Accent color used for the connection badge / icon. */
  color: string;
}

/**
 * All selectable engines, in display order. Engines that share a wire family
 * reuse the same backend driver — they differ only in default port, label, and
 * accent color.
 *
 *   postgres family → PostgreSQL wire protocol (tokio-postgres)
 *   mysql family    → MySQL wire protocol (mysql_async)
 *   sqlite family   → local SQLite file (rusqlite) or REST-backed (D1)
 *   mssql family    → SQL Server TDS protocol (tiberius)
 */
export const ENGINE_REGISTRY: EngineMeta[] = [
  // Order by real-world popularity (DB-Engines / Stack Overflow Survey):
  // PostgreSQL, MySQL, and SQLite dominate; the rest follow by adoption.
  { id: 'postgres', label: 'PostgreSQL', family: 'postgres', defaultPort: 5432, color: '#5A9FD4' },
  { id: 'mysql', label: 'MySQL', family: 'mysql', defaultPort: 3306, color: '#5B9BD5' },
  { id: 'sqlite', label: 'SQLite', family: 'sqlite', color: '#35B8E6' },
  { id: 'mariadb', label: 'MariaDB', family: 'mysql', defaultPort: 3306, color: '#3FBDBA' },
  { id: 'duckdb', label: 'DuckDB', family: 'duckdb', color: '#F59E0B' },
  { id: 'cockroachdb', label: 'CockroachDB', family: 'postgres', defaultPort: 26257, color: '#6933FF' },
  { id: 'tidb', label: 'TiDB', family: 'mysql', defaultPort: 4000, color: '#E63946' },
  { id: 'yugabytedb', label: 'YugabyteDB', family: 'postgres', defaultPort: 5433, color: '#2D2D2D' },
  { id: 'cloudflare-d1', label: 'Cloudflare D1', family: 'sqlite', color: '#FAAE40' },
  { id: 'planetscale', label: 'PlanetScale', family: 'mysql', defaultPort: 3306, color: '#000000' },
  { id: 'mssql', label: 'SQL Server', family: 'mssql', defaultPort: 1433, color: '#CC2927' },
  // Redis has no SQL wire family — see `isRedisEngine()`.
  { id: 'redis', label: 'Redis', defaultPort: 6379, color: '#DC382D' },
  // MongoDB has no SQL wire family either — see `isMongoEngine()`.
  { id: 'mongodb', label: 'MongoDB', defaultPort: 27017, color: '#47A248' },
];

/** Quick lookup by engine id. */
const ENGINE_MAP: Record<string, EngineMeta> = Object.fromEntries(
  ENGINE_REGISTRY.map((e) => [e.id, e]),
);

/** Metadata for an engine id, with a sensible postgres fallback. */
export function engineMeta(engine: string): EngineMeta {
  return ENGINE_MAP[engine?.toLowerCase()] ?? ENGINE_REGISTRY[0];
}

/** Resolve a raw engine string to its wire-protocol family. Mirrors the
 *  backend `engine_family()` helper so frontend and backend agree on which
 *  engines share a driver, quoting style, and capability set. */
export function engineFamily(engine: string): EngineFamily {
  const e = (engine || '').toLowerCase();
  switch (e) {
    case 'postgres':
    case 'postgresql':
    case 'cockroachdb':
    case 'yugabytedb':
      return 'postgres';
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return 'mysql';
    case 'duckdb':
      return 'duckdb';
    case 'mssql':
    case 'sqlserver':
    case 'azuresql':
      return 'mssql';
    default:
      // sqlite, cloudflare-d1, d1 all route here.
      return 'sqlite';
  }
}

/** Convenience predicates matching the family helpers in the backend. */
export const isPostgresFamily = (engine: string): boolean => engineFamily(engine) === 'postgres';
export const isMysqlFamily = (engine: string): boolean => engineFamily(engine) === 'mysql';
export const isSqliteFamily = (engine: string): boolean => engineFamily(engine) === 'sqlite';
export const isDuckdbFamily = (engine: string): boolean => engineFamily(engine) === 'duckdb';
export const isMssqlFamily = (engine: string): boolean => engineFamily(engine) === 'mssql';

/** Redis sits outside the SQL family system entirely (no schema/columns, no
 *  `engine_family()` arm on the backend) — check this before falling back to
 *  `engineFamily()`'s sqlite default. */
export const isRedisEngine = (engine: string): boolean => (engine || '').toLowerCase() === 'redis';

/** MongoDB also sits outside the SQL family system (documents, not tables) —
 *  same reasoning as `isRedisEngine()`. Unlike Redis, Mongo does have a real
 *  schema tree (databases → collections); only the leaf data is non-tabular. */
export const isMongoEngine = (engine: string): boolean => (engine || '').toLowerCase() === 'mongodb';

/** Engine ids that appear in the connection dropdown. */
export const ALL_ENGINES: DatabaseEngine[] = ENGINE_REGISTRY.map((e) => e.id);
