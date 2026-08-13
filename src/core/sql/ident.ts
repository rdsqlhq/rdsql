import { DatabaseEngine } from '../domain/types';
import { isMssqlFamily, isMysqlFamily, isPostgresFamily } from '../connection/engines';

/** Quote a single SQL identifier for the given engine, escaping any embedded quote chars. */
export function quoteIdent(engine: string, name: string): string {
  if (isMysqlFamily(engine)) return `\`${name.replace(/`/g, '``')}\``;
  if (isMssqlFamily(engine)) return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a fully-qualified, quoted table reference.
 *
 * The explorer lets you connect without picking a database, so the session has
 * no default schema — an unqualified `SELECT * FROM t` then fails outright with
 * MySQL's "No database selected" (error 1046). Qualifying also disambiguates
 * table names that exist in more than one schema, which is common on a shared
 * local server.
 *
 * `schemaName` here is always the Explorer *group* name — a real schema for
 * Postgres, but a whole separate *database* for MySQL and SQL Server (see
 * `resolveTargetDatabase`'s doc comment). MySQL tolerates `database.table` as
 * a valid 2-part identifier regardless of the connection's current database,
 * so qualifying with it works. SQL Server does not — `database.table` isn't
 * valid T-SQL (needs 3-part `database.schema.table`, or a database-context
 * switch + bare/`schema.table` reference) — so for `mssql` the qualifier is
 * dropped entirely and the caller must instead point the connection's
 * `database` field at the group via `resolveTargetDatabase` before running
 * the query. The table then resolves against that database's default `dbo`
 * schema.
 */
export function qualifiedTable(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName?: string
): string {
  const table = quoteIdent(engine, tableName);
  if (!schemaName || isMssqlFamily(engine)) return table;
  return `${quoteIdent(engine, schemaName)}.${table}`;
}

/** Standard "preview the first N rows" statement used by the explorer and tabs. */
export function selectPreviewSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName?: string,
  limit = 100
): string {
  const qt = qualifiedTable(engine, tableName, schemaName);
  // T-SQL has no LIMIT — TOP goes right after SELECT, not at the end.
  if (isMssqlFamily(engine)) return `SELECT TOP ${limit} * FROM ${qt};`;
  return `SELECT * FROM ${qt} LIMIT ${limit};`;
}

/**
 * Paginated "page N of rows" statement. T-SQL has no LIMIT/OFFSET — it uses
 * `OFFSET ... ROWS FETCH NEXT ... ROWS ONLY`, which the standard requires an
 * `ORDER BY` for; `ORDER BY (SELECT NULL)` is the conventional no-particular-
 * order idiom when the caller isn't sorting by a specific column.
 */
export function paginatedSelectSql(
  engine: DatabaseEngine | string,
  tableName: string,
  schemaName: string | undefined,
  limit: number,
  offset: number
): string {
  const qt = qualifiedTable(engine, tableName, schemaName);
  if (isMssqlFamily(engine)) {
    return `SELECT * FROM ${qt} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY;`;
  }
  return `SELECT * FROM ${qt} LIMIT ${limit} OFFSET ${offset};`;
}

/**
 * Resolve the actual *database* a query should connect to for a given engine and
 * explorer group node.
 *
 * Explorer group nodes mean different things per engine:
 *  - MySQL / MariaDB / SQLite / SQL Server: the group name IS the database
 *    (MySQL's `TABLE_SCHEMA`; SQL Server's `sys.databases.name` — one TDS
 *    session can see every database on the server, same as MySQL).
 *    Overriding the connection's database with it is correct and necessary
 *    (lets you browse tables in a non-default DB).
 *  - PostgreSQL: the group name is a SCHEMA (e.g. `public`), NOT a database.
 *    Overriding `config.database` with it makes the backend try `dbname=public`,
 *    which fails with `ERROR 3D000: database "public" does not exist`. For
 *    Postgres the schema belongs only in the SQL (via `qualifiedTable`), never
 *    in the connection config — so we keep the connection's configured database.
 */
export function resolveTargetDatabase(
  engine: DatabaseEngine | string,
  connDatabase: string | undefined,
  groupOrSchemaName?: string
): string | undefined {
  if (!groupOrSchemaName) return connDatabase;
  if (isPostgresFamily(engine)) return connDatabase;
  return groupOrSchemaName;
}

/** Strip surrounding double-quotes / backticks / square brackets from a single
 *  SQL identifier and unescape doubled quote chars inside it. Returns the raw
 *  name as the database knows it. */
function unquoteIdent(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    if (t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1).replace(/""/g, '"');
    if (t[0] === '`' && t[t.length - 1] === '`') return t.slice(1, -1).replace(/``/g, '`');
    if (t[0] === '[' && t[t.length - 1] === ']') return t.slice(1, -1).replace(/]]/g, ']');
  }
  return t;
}

/**
 * Best-effort detection of whether a SELECT reads from exactly one table — the
 * only case where inline editing of the result grid is safe (we can build
 * `UPDATE`/`DELETE`/`INSERT` against that one table). Returns `{ name, schema? }`
 * for a simple `SELECT ... FROM [schema.]table [WHERE/LIMIT/ORDER ...]`, and
 * `undefined` for anything more complex — joins, subqueries, CTEs, unions,
 * aggregates, function calls, `SELECT ... INTO`, set operations, multi-table
 * FROM. Conservative by design: when in doubt, the grid stays read-only.
 */
export function detectEditableTable(sql: string): { name: string; schema?: string } | undefined {
  const trimmed = sql.replace(/;+\s*$/, '').trim();
  if (!trimmed) return undefined;

  // Normalize for keyword detection without altering the FROM clause text.
  const upper = trimmed.toUpperCase();

  // Must start with SELECT (allow leading WITH/RECURSIVE? No — CTEs are out).
  if (!upper.startsWith('SELECT')) return undefined;

  // Reject anything that isn't a plain single-table read up front.
  const disqualifiers = [
    /\bJOIN\b/, /\bNATURAL\b/, /\bUNION\b/, /\bINTERSECT\b/, /\bEXCEPT\b/,
    /\bWITH\b/, /\bINTO\b/, /\bGROUP\s+BY\b/, /\bDISTINCT\b/,
  ];
  if (disqualifiers.some((re) => re.test(upper))) return undefined;

  // Find the FROM clause. Only the first FROM matters; reject subqueries
  // (a parenthesised source) and comma-separated multi-table FROM lists.
  const fromMatch = trimmed.match(/\bFROM\b\s+(.+?)(?:\bWHERE\b|\bORDER\b|\bLIMIT\b|\bOFFSET\b|;|$)/is);
  if (!fromMatch) return undefined;

  // Everything FROM provides up to the next known trailing clause keyword.
  const fromExpr = fromMatch[1].trim();
  // No subqueries and no additional comma-separated tables.
  if (fromExpr.includes('(') || fromExpr.includes(')')) return undefined;
  if (fromExpr.includes(',')) return undefined;
  // No alias chaining keywords that imply a second source (e.g. "t JOIN ...").
  if (/\b(JOIN|NATURAL|CROSS|INNER|LEFT|RIGHT|FULL|OUTER|ON|USING)\b/i.test(fromExpr)) {
    return undefined;
  }

  // Now `fromExpr` should be `tbl`, `schema.tbl`, `tbl alias`, or
  // `schema.tbl AS alias`. Tokenize the identifier segments (a dot separates
  // schema.table), dropping the optional `AS` alias keyword, then validate the
  // shape: at most one dot, and at most one trailing alias token.
  const rawTokens = fromExpr.match(/("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_]\w*)|\./g);
  if (!rawTokens) return undefined;

  const idents = rawTokens.filter((t) => t !== '.' && t.toUpperCase() !== 'AS');
  const dotCount = rawTokens.filter((t) => t === '.').length;
  if (dotCount > 1) return undefined; // schema.table.col — not a single table
  const expectedIdents = dotCount === 1 ? 2 : 1;
  // Allow exactly the qualified name, optionally followed by one alias token.
  if (idents.length !== expectedIdents && idents.length !== expectedIdents + 1) {
    return undefined;
  }
  // When `AS` is present there must be exactly one alias token after the name.
  const hasAs = /\bAS\b/i.test(fromExpr);
  if (hasAs && idents.length !== expectedIdents + 1) return undefined;

  const identsToUse = idents.slice(0, expectedIdents).map(unquoteIdent);
  if (identsToUse.length === 1) return { name: identsToUse[0] };
  return { schema: identsToUse[0], name: identsToUse[1] };
}
