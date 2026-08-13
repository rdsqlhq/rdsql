import { DatabaseEngine, QueryColumn, SchemaTableNode } from '../domain/types';
import { quoteIdent, qualifiedTable } from '../sql/ident';
import { isMssqlFamily, isMysqlFamily } from '../connection/engines';

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Reverses `qualifiedTable`'s schema-qualification: turns every
 * `` `db`.`table` `` (MySQL-family) or `"schema"."table"` (Postgres/SQLite/
 * DuckDB/D1) occurrence in a SQL script into just the bare, quoted table
 * reference.
 *
 * Why: a backup written with `targetSchema` set (see `buildBackupPlan`)
 * hardcodes the SOURCE database/schema name into every CREATE/INSERT/DROP.
 * Restoring that file into a connection whose current database has a
 * DIFFERENT name then fails outright — e.g. MySQL's "Unknown database
 * 'tc_superadmin'" when the target server has no such database. Stripping
 * the qualifier makes every statement target whatever database the
 * executing connection is already pointed at, matching how `mysql -D dbname
 * < file.sql` / `psql -d dbname -f file.sql` are normally used.
 *
 * Only matches the exact `quoted.quoted` shape `qualifiedTable` emits (two
 * adjacent identifier-quoted tokens joined by a bare dot) — string literals
 * use a different quote character in both dialects (`'...'`), so this can't
 * accidentally rewrite a data value.
 */
export function stripSchemaQualifiers(engine: DatabaseEngine | string, sql: string): string {
  const pattern = isMysqlFamily(engine) ? /`[^`]+`\.(`[^`]+`)/g : /"[^"]+"\.("[^"]+")/g;
  return sql.replace(pattern, '$1');
}

export function selectAllSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName?: string,
  /** When set, caps the number of dumped rows (e.g. first 100). */
  limit?: number
): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  if (limit !== undefined && limit > 0) {
    // T-SQL has no LIMIT — TOP goes right after SELECT.
    if (isMssqlFamily(engine)) return `SELECT TOP ${Math.floor(limit)} * FROM ${target};`;
    return `SELECT * FROM ${target} LIMIT ${Math.floor(limit)};`;
  }
  return `SELECT * FROM ${target};`;
}

/**
 * How a table's data should be read in bounded pages instead of one
 * unbounded `SELECT *`. Chosen once per table (cheap, synchronous — no IO):
 *
 *  - 'keyset': the table has exactly one primary-key column. Pages are
 *    fetched as `WHERE pk > <last seen value> ORDER BY pk LIMIT n`, which
 *    stays fast at any offset because it's an index seek, not a scan-and-
 *    discard. This is the preferred strategy for large tables.
 *  - 'offset': no single-column PK to seek on (composite PK, or none at
 *    all). Falls back to `ORDER BY <cols> LIMIT n OFFSET m`. Still bounds
 *    memory per page, but OFFSET cost grows with the offset itself, so this
 *    degrades on very large tables. `orderColumns` is the best available
 *    determinism — PK columns if there's a composite key, else just the
 *    first column as a last resort (may still reorder rows that tie on it).
 */
export interface ChunkStrategy {
  mode: 'keyset' | 'offset';
  keysetColumn?: string;
  orderColumns: string[];
}

export function pickChunkStrategy(table: Pick<SchemaTableNode, 'children'>): ChunkStrategy {
  const pkCols = (table.children || []).filter((c) => c.is_primary_key).map((c) => c.name);
  if (pkCols.length === 1) {
    return { mode: 'keyset', keysetColumn: pkCols[0], orderColumns: pkCols };
  }
  if (pkCols.length > 1) {
    return { mode: 'offset', orderColumns: pkCols };
  }
  const firstCol = table.children?.[0]?.name;
  return { mode: 'offset', orderColumns: firstCol ? [firstCol] : [] };
}

/** Keyset page: rows with `pk > afterValue`, ordered by `pk`, capped at
 *  `limit`. Pass `afterValue = null` for the first page. */
export function selectKeysetChunkSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  pkColumn: string,
  afterValue: unknown,
  limit: number
): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  const pkIdent = quoteIdent(engine, pkColumn);
  const where = afterValue === null || afterValue === undefined ? '' : ` WHERE ${pkIdent} > ${sqlLiteral(afterValue)}`;
  if (isMssqlFamily(engine)) {
    return `SELECT TOP ${Math.floor(limit)} * FROM ${target}${where} ORDER BY ${pkIdent} ASC;`;
  }
  return `SELECT * FROM ${target}${where} ORDER BY ${pkIdent} ASC LIMIT ${Math.floor(limit)};`;
}

/** Offset-fallback page: rows `[offset, offset + limit)` under a best-effort
 *  deterministic order. Used only when no single-column PK is available. */
export function selectOffsetChunkSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  orderColumns: string[],
  offset: number,
  limit: number
): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  const orderList = orderColumns.map((c) => `${quoteIdent(engine, c)} ASC`).join(', ');
  if (isMssqlFamily(engine)) {
    // OFFSET/FETCH requires an ORDER BY; fall back to the standard
    // no-particular-order idiom when there's nothing to sort by.
    const orderClause = orderList || '(SELECT NULL)';
    return `SELECT * FROM ${target} ORDER BY ${orderClause} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${Math.floor(limit)} ROWS ONLY;`;
  }
  const orderClause = orderList ? ` ORDER BY ${orderList}` : '';
  return `SELECT * FROM ${target}${orderClause} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)};`;
}

/**
 * Best-effort CREATE TABLE reconstructed from the schema tree's column
 * metadata (name, data type, nullability, primary key). It captures enough
 * to recreate a structurally-compatible table, but — since it isn't reading
 * the engine's real DDL — it won't reproduce exact type modifiers (varchar
 * length, numeric precision), indexes, foreign keys, or check constraints.
 * Good enough for "restore this table's shape somewhere else"; not a
 * byte-for-byte replacement for `pg_dump`/`mysqldump`.
 */
export function generateCreateTableSql(
  engine: DatabaseEngine | string,
  table: SchemaTableNode,
  schemaName?: string
): string {
  const target = qualifiedTable(engine, table.name, schemaName);
  const pkCols = table.children.filter((c) => c.is_primary_key).map((c) => c.name);

  const lines = table.children.map((col) => {
    let dt = col.data_type || 'TEXT';
    // MySQL requires a length for varchar/char. If the schema tree didn't
    // include one (e.g. DATA_TYPE instead of COLUMN_TYPE), add a safe default.
    if (typeof engine === 'string' ? isMysqlFamily(engine) : false) {
      const lowerDt = dt.toLowerCase();
      if (lowerDt === 'varchar' || lowerDt === 'char') {
        dt = `${lowerDt}(255)`;
      } else if (lowerDt === 'varbinary' || lowerDt === 'binary') {
        dt = `${lowerDt}(255)`;
      }
    }
    const parts = [quoteIdent(engine, col.name), dt];
    if (col.is_nullable === false) parts.push('NOT NULL');
    return `  ${parts.join(' ')}`;
  });

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => quoteIdent(engine, c)).join(', ')})`);
  }

  return `CREATE TABLE IF NOT EXISTS ${target} (\n${lines.join(',\n')}\n);`;
}

/** Batches rows into multi-row INSERT statements so a large table doesn't
 *  become one INSERT per row (or one unbounded VALUES list). */
export function generateInsertStatements(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  columns: QueryColumn[],
  rows: unknown[][],
  batchSize = 200
): string[] {
  if (rows.length === 0 || columns.length === 0) return [];
  const target = qualifiedTable(engine, tableName, schemaName);
  const colNames = columns.map((c) => quoteIdent(engine, c.name)).join(', ');
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valuesSql = chunk.map((row) => `(${row.map((v) => sqlLiteral(v)).join(', ')})`).join(',\n  ');
    statements.push(`INSERT INTO ${target} (${colNames}) VALUES\n  ${valuesSql};`);
  }

  return statements;
}

/**
 * Splits a SQL script on top-level semicolons, respecting single-quoted
 * string literals (with standard '' escaping) so a semicolon inside a data
 * value doesn't fracture a statement. This is what backup files this app
 * generates (and most hand-written standard SQL) use — it isn't a full SQL
 * parser, so exotic dollar-quoting or dialect-specific literal styles
 * aren't handled.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    current += ch;
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        current += sql[++i];
        continue;
      }
      inString = !inString;
    } else if (ch === ';' && !inString) {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
