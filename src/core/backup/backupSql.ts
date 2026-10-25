import { DatabaseEngine, QueryColumn, SchemaTableNode } from '../domain/types';
import { quoteIdent, qualifiedTable } from '../sql/ident';
import { engineFamily, isMssqlFamily, isMysqlFamily } from '../connection/engines';

/** Quotes text as a single-quoted SQL string. MySQL-family servers treat a
 *  backslash as an escape character by default, so it is doubled there;
 *  otherwise `C:\new` would come back with a newline in it. SQL Server
 *  strings get the N prefix: without it the text is read in the database's
 *  code page and anything outside it (emoji, 中文) turns into `?`. */
export function quoteSqlString(text: string, engine?: string): string {
  let s = text.replace(/'/g, "''");
  if (engine && isMysqlFamily(engine)) s = s.replace(/\\/g, '\\\\');
  if (engine && isMssqlFamily(engine)) return `N'${s}'`;
  return `'${s}'`;
}

/** Literal for a grid cell in a WHERE/SET/VALUES clause: every value is sent
 *  as a quoted string (the server casts it to the column type) and objects
 *  as their JSON text. */
export function cellLiteral(value: unknown, engine: string): string {
  if (value === null || value === undefined) return 'NULL';
  return quoteSqlString(typeof value === 'object' ? JSON.stringify(value) : String(value), engine);
}

/** Postgres array literal (`{1,"a b",NULL}`) for a JSON array cell. */
function pgArrayLiteral(values: unknown[]): string {
  const item = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return pgArrayLiteral(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  return `{${values.map(item).join(',')}}`;
}

/**
 * SQL literal for a value read back from a query result.
 *
 * `engine` picks the string escaping. `dataType` (the result column's type)
 * tells Postgres arrays (`_int4`, `_text`, ...) apart from JSON arrays, since
 * both arrive as JSON arrays; objects and other arrays are written as JSON.
 */
export function sqlLiteral(value: unknown, engine?: string, dataType?: string): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') {
    if (engine && isMssqlFamily(engine)) return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }
  if (Array.isArray(value) && engine && engineFamily(engine) === 'postgres' && dataType?.startsWith('_')) {
    return quoteSqlString(pgArrayLiteral(value), engine);
  }
  if (typeof value === 'object') return quoteSqlString(JSON.stringify(value), engine);
  return quoteSqlString(String(value), engine);
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

/** Postgres-family backup reads: every column cast to `::text`, so each value
 *  comes back in Postgres' own text form, which it reads back unchanged on
 *  INSERT. Without this, types the driver can't decode (interval, inet,
 *  money, bit, timetz, ...) come back as NULL and bytea as a "<n bytes>"
 *  placeholder. Columns are read through the alias `t`, so WHERE/ORDER BY
 *  (written as `t."col"`) still compare the real typed column, not its text.
 *  Returns null when the plain `SELECT *` should be used instead. */
/** A column as the chunk readers need it: its name and declared type. */
export type ChunkColumn = { name: string; data_type?: string };

/** Columns holding raw bytes, on engines whose driver returns them as a
 *  "<binary n bytes>" placeholder (MySQL family, SQLite, DuckDB, SQL Server)
 *  rather than the bytes. Backup reads these as hex and writes them back as
 *  a hex literal (see `hexLiteral`). Postgres doesn't need this: its reads
 *  are `::text` (see `textSelectList`). */
export function hexColumns(engine: DatabaseEngine | string, columns: ChunkColumn[] | undefined): Set<string> {
  if (!columns) return new Set();
  const fam = engineFamily(engine);
  const pattern =
    fam === 'mysql' ? /binary|blob|^bit\b/i : fam === 'sqlite' || fam === 'duckdb' ? /blob|binary|bytea/i : fam === 'mssql' ? /binary|image/i : null;
  if (!pattern) return new Set();
  return new Set(columns.filter((c) => pattern.test(c.data_type || '')).map((c) => c.name));
}

/** The hex-reading expression for column `ident` (see `hexColumns`). */
function hexRead(engine: DatabaseEngine | string, ident: string): string {
  if (isMssqlFamily(engine)) return `CONVERT(VARCHAR(MAX), ${ident}, 2)`;
  if (isMysqlFamily(engine)) return `HEX(${ident})`;
  // SQLite's hex(NULL) is '' (DuckDB's is NULL), which would come back as an
  // empty blob instead of NULL.
  if (engineFamily(engine) === 'sqlite') return `CASE WHEN ${ident} IS NULL THEN NULL ELSE hex(${ident}) END`;
  return `hex(${ident})`;
}

/** Bytes literal for a hex string read by `hexRead`. MySQL's HEX() of a BIT
 *  value drops leading zeros (b'1' → "1"), so odd lengths get a leading 0. */
export function hexLiteral(hex: unknown, engine: DatabaseEngine | string = 'mysql'): string {
  let h = String(hex);
  if (h.length % 2) h = '0' + h;
  if (isMssqlFamily(engine)) return `0x${h}`;
  if (engineFamily(engine) === 'duckdb') return `unhex('${h}')`;
  return `X'${h}'`;
}

function textSelectList(engine: DatabaseEngine | string, columns: ChunkColumn[] | undefined): string | null {
  if (!columns || columns.length === 0) return null;
  if (engineFamily(engine) === 'postgres') {
    return columns.map((c) => `t.${quoteIdent(engine, c.name)}::text AS ${quoteIdent(engine, c.name)}`).join(', ');
  }
  const hex = hexColumns(engine, columns);
  if (isMssqlFamily(engine)) {
    // As for Postgres: read each value as exact text, which SQL Server
    // converts back on INSERT. The driver's own values lose a
    // datetimeoffset's offset, round floats and drop money's 4th decimal.
    return columns
      .map((c) => {
        const ident = `t.${quoteIdent(engine, c.name)}`;
        const ty = (c.data_type || '').toLowerCase();
        const style = /date|time/.test(ty) ? 126 : /float|real/.test(ty) ? 3 : /money/.test(ty) ? 2 : null;
        const expr = hex.has(c.name)
          ? hexRead(engine, ident)
          : style === null
            ? `CONVERT(NVARCHAR(MAX), ${ident})`
            : `CONVERT(NVARCHAR(MAX), ${ident}, ${style})`;
        return `${expr} AS ${quoteIdent(engine, c.name)}`;
      })
      .join(', ');
  }
  if (hex.size === 0) return null;
  return columns
    .map((c) => {
      const ident = `t.${quoteIdent(engine, c.name)}`;
      return hex.has(c.name) ? `${hexRead(engine, ident)} AS ${quoteIdent(engine, c.name)}` : ident;
    })
    .join(', ');
}

/** Keyset page: rows with `pk > afterValue`, ordered by `pk`, capped at
 *  `limit`. Pass `afterValue = null` for the first page. `columns` (the
 *  table's columns) enables the text/hex reads above. */
export function selectKeysetChunkSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  pkColumn: string,
  afterValue: unknown,
  limit: number,
  columns?: ChunkColumn[]
): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  const textList = textSelectList(engine, columns);
  if (textList) {
    const pk = `t.${quoteIdent(engine, pkColumn)}`;
    // A binary key was read as HEX(), so compare against its bytes.
    const after = hexColumns(engine, columns).has(pkColumn) ? hexLiteral(afterValue, engine) : sqlLiteral(afterValue, engine);
    const where = afterValue === null || afterValue === undefined ? '' : ` WHERE ${pk} > ${after}`;
    if (isMssqlFamily(engine)) return `SELECT TOP ${Math.floor(limit)} ${textList} FROM ${target} t${where} ORDER BY ${pk} ASC;`;
    return `SELECT ${textList} FROM ${target} t${where} ORDER BY ${pk} ASC LIMIT ${Math.floor(limit)};`;
  }
  const pkIdent = quoteIdent(engine, pkColumn);
  const where = afterValue === null || afterValue === undefined ? '' : ` WHERE ${pkIdent} > ${sqlLiteral(afterValue, engine)}`;
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
  limit: number,
  columns?: ChunkColumn[]
): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  const textList = textSelectList(engine, columns);
  if (textList) {
    const order = orderColumns.map((c) => `t.${quoteIdent(engine, c)} ASC`).join(', ');
    if (isMssqlFamily(engine)) {
      return `SELECT ${textList} FROM ${target} t ORDER BY ${order || '(SELECT NULL)'} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${Math.floor(limit)} ROWS ONLY;`;
    }
    return `SELECT ${textList} FROM ${target} t${order ? ` ORDER BY ${order}` : ''} LIMIT ${Math.floor(limit)} OFFSET ${Math.floor(offset)};`;
  }
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
  schemaName?: string,
  /** Postgres user-defined type names (enums) used by the columns. Those
   *  names are quoted, since they are case-sensitive. */
  userTypes?: Set<string>
): string {
  const target = qualifiedTable(engine, table.name, schemaName);
  const pkCols = table.children.filter((c) => c.is_primary_key).map((c) => c.name);
  const isPg = engineFamily(engine) === 'postgres';

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
    const def = isPg ? col.column_default?.trim() : undefined;
    if (isPg) {
      const base = dt.replace(/(\[\])+$/, '');
      if (userTypes?.has(base)) dt = qualifiedTable(engine, base, schemaName) + dt.slice(base.length);
      // A nextval() default points at a sequence the target doesn't have;
      // serial types create it along with the table.
      if (def && /^nextval\(/i.test(def)) dt = PG_SERIAL_TYPES[dt.toLowerCase()] ?? dt;
    }
    const parts = [quoteIdent(engine, col.name), dt];
    if (col.is_nullable === false) parts.push('NOT NULL');
    if (def && /^GENERATED BY DEFAULT AS IDENTITY$/i.test(def)) parts.push(def);
    else if (def && !/^nextval\(/i.test(def)) parts.push(`DEFAULT ${def}`);
    // MySQL-family and SQL Server trees report the whole clause (DEFAULT /
    // AUTO_INCREMENT / IDENTITY / ON UPDATE), already in the server's syntax.
    if ((isMysqlFamily(engine) || isMssqlFamily(engine)) && col.column_default) parts.push(col.column_default);
    return `  ${parts.join(' ')}`;
  });

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => quoteIdent(engine, c)).join(', ')})`);
  }

  // T-SQL has no CREATE TABLE IF NOT EXISTS.
  if (isMssqlFamily(engine)) {
    return `IF OBJECT_ID(${quoteSqlString(target, engine)}, N'U') IS NULL CREATE TABLE ${target} (\n${lines.join(',\n')}\n);`;
  }
  return `CREATE TABLE IF NOT EXISTS ${target} (\n${lines.join(',\n')}\n);`;
}

/** SQL Server: a table whose IDENTITY column gets explicit values must have
 *  IDENTITY_INSERT on for that session while its rows go in (one table at a
 *  time). Returns the ON and OFF statements, or null when not needed. */
export function mssqlIdentityInsertSql(
  engine: DatabaseEngine | string,
  table: Pick<SchemaTableNode, 'name' | 'children'>,
  schemaName?: string
): { on: string; off: string } | null {
  if (!isMssqlFamily(engine) || !table.children.some((c) => /^IDENTITY/i.test(c.column_default || ''))) return null;
  const target = qualifiedTable(engine, table.name, schemaName);
  return { on: `SET IDENTITY_INSERT ${target} ON;`, off: `SET IDENTITY_INSERT ${target} OFF;` };
}

const PG_SERIAL_TYPES: Record<string, string> = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' };

/** True for a Postgres column whose values come from a sequence (serial or
 *  identity), which has to be moved past the restored rows. */
export function isPgSequenceColumn(engine: DatabaseEngine | string, col: { column_default?: string | null }): boolean {
  if (engineFamily(engine) !== 'postgres' || !col.column_default) return false;
  return /^nextval\(/i.test(col.column_default) || /^GENERATED BY DEFAULT AS IDENTITY$/i.test(col.column_default);
}

/** After a restore inserts explicit ids, moves the column's sequence past the
 *  largest one so the next insert doesn't collide with a restored row. */
export function pgSequenceResetSql(engine: DatabaseEngine | string, tableName: string, column: string, schemaName?: string): string {
  const target = qualifiedTable(engine, tableName, schemaName);
  const col = quoteIdent(engine, column);
  return `SELECT setval(pg_get_serial_sequence(${quoteSqlString(target)}, ${quoteSqlString(column)}), COALESCE(MAX(${col}), 0) + 1, false) FROM ${target};`;
}

/** Lists the enum types in a Postgres schema with their labels in order. */
export function pgEnumTypesSql(schema: string): string {
  return `SELECT t.typname::text AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = ${quoteSqlString(schema)} GROUP BY t.typname ORDER BY t.typname;`;
}

/** Creates an enum type unless one with that name already exists, so a
 *  backup can be restored again into the same database. */
export function createPgEnumSql(engine: DatabaseEngine | string, name: string, labels: string[], schemaName?: string): string {
  const target = qualifiedTable(engine, name, schemaName);
  const values = labels.map((l) => quoteSqlString(l)).join(', ');
  // CockroachDB has no DO blocks, but (unlike Postgres) has IF NOT EXISTS.
  if (engine === 'cockroachdb') return `CREATE TYPE IF NOT EXISTS ${target} AS ENUM (${values});`;
  return `DO $$ BEGIN CREATE TYPE ${target} AS ENUM (${values}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`;
}

/** Batches rows into multi-row INSERT statements so a large table doesn't
 *  become one INSERT per row (or one unbounded VALUES list). */
export function generateInsertStatements(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  columns: QueryColumn[],
  rows: unknown[][],
  batchSize = 200,
  /** Columns read as hex (see `hexColumns`), written as hex literals. */
  hexColumns?: Set<string>
): string[] {
  if (rows.length === 0 || columns.length === 0) return [];
  const target = qualifiedTable(engine, tableName, schemaName);
  const colNames = columns.map((c) => quoteIdent(engine, c.name)).join(', ');
  const statements: string[] = [];

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const literal = (v: unknown, ci: number) =>
      hexColumns?.has(columns[ci]?.name) && v !== null && v !== undefined ? hexLiteral(v, engine) : sqlLiteral(v, engine, columns[ci]?.data_type);
    const valuesSql = chunk.map((row) => `(${row.map(literal).join(', ')})`).join(',\n  ');
    statements.push(`INSERT INTO ${target} (${colNames}) VALUES\n  ${valuesSql};`);
  }

  return statements;
}

export { splitSqlStatements } from '../sql/splitStatements';

// ── PostgreSQL: COPY data and secondary objects ──────────────────────────

/** `COPY <table> (<cols>) FROM stdin;` for a backup's rows of `table`. */
export function pgCopySql(engine: DatabaseEngine | string, tableName: string, columns: string[], schemaName?: string): string {
  return `COPY ${qualifiedTable(engine, tableName, schemaName)} (${columns.map((c) => quoteIdent(engine, c)).join(', ')}) FROM stdin;`;
}

/** One row in COPY text format: tab-separated, `\N` for NULL, and backslash,
 *  newline, carriage return and tab escaped. Values are Postgres' own text
 *  forms (backup reads columns as ::text), which COPY reads back exactly. */
export function pgCopyRow(values: unknown[]): string {
  return values
    .map((v) => {
      if (v === null || v === undefined) return '\\N';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    })
    .join('\t');
}

/** A constraint or index of a table, as its source database defines it. */
export interface PgSecondaryObject {
  table: string;
  name: string;
  kind: 'index' | 'unique' | 'check' | 'exclusion' | 'foreign_key';
  /** pg_get_constraintdef / pg_get_indexdef, read with the source schema
   *  first in search_path so names come out unqualified. */
  definition: string;
  /** Foreign keys: the table it references (same schema), else ''. */
  references: string;
}

/** Constraints other than the primary key, in the current schema (run with
 *  `SET search_path TO <schema>` first). */
export const PG_CONSTRAINTS_SQL = `SELECT cl.relname AS table_name, c.conname, c.contype::text,
       pg_get_constraintdef(c.oid) AS definition,
       CASE WHEN rf.relnamespace = cl.relnamespace THEN rf.relname ELSE '' END AS references
FROM pg_constraint c
JOIN pg_class cl ON cl.oid = c.conrelid
LEFT JOIN pg_class rf ON rf.oid = c.confrelid
WHERE cl.relnamespace = to_regnamespace(current_schema())::oid AND c.contype IN ('u', 'c', 'x', 'f')
ORDER BY cl.relname, c.conname;`;

/** Indexes that don't belong to a primary key, unique or exclusion
 *  constraint (those come with the constraint). */
export const PG_INDEXES_SQL = `SELECT t.relname AS table_name, i.relname AS index_name, pg_get_indexdef(x.indexrelid) AS definition
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_class t ON t.oid = x.indrelid
WHERE t.relnamespace = to_regnamespace(current_schema())::oid
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid AND c.contype IN ('p', 'u', 'x') AND c.conrelid = x.indrelid)
ORDER BY t.relname, i.relname;`;

const CONSTRAINT_KIND: Record<string, PgSecondaryObject['kind']> = { u: 'unique', c: 'check', x: 'exclusion', f: 'foreign_key' };

/** Rows of PG_CONSTRAINTS_SQL and PG_INDEXES_SQL as PgSecondaryObjects. */
export function pgSecondaryObjects(constraints: unknown[][], indexes: unknown[][]): PgSecondaryObject[] {
  return [
    ...constraints.map(([table, name, type, definition, references]) => ({
      table: String(table),
      name: String(name),
      kind: CONSTRAINT_KIND[String(type)] ?? 'check',
      definition: String(definition),
      references: String(references ?? ''),
    })),
    ...indexes.map(([table, name, definition]) => ({
      table: String(table),
      name: String(name),
      kind: 'index' as const,
      definition: String(definition),
      references: '',
    })),
  ];
}

/** The statement that recreates `obj`. Both forms skip an object that
 *  already exists, so a backup can run again into the same target. */
export function pgSecondarySql(obj: PgSecondaryObject): string {
  if (obj.kind === 'index') return obj.definition.replace(/^CREATE (UNIQUE )?INDEX /i, (_m, u) => `CREATE ${u ?? ''}INDEX IF NOT EXISTS `) + ';';
  const alter = `ALTER TABLE ${quoteIdent('postgres', obj.table)} ADD CONSTRAINT ${quoteIdent('postgres', obj.name)} ${obj.definition}`;
  return `DO $rdsql$ BEGIN ${alter}; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $rdsql$;`;
}
