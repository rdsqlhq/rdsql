import type { SchemaGroupNode, SchemaTableNode, SchemaColumnNode } from '../domain/types';

/** SQL keywords offered as autocomplete suggestions. Covers the common DML/DDL
 *  vocabulary across Postgres/MySQL/SQLite so the editor feels helpful even
 *  before any schema is loaded. */
export const SQL_KEYWORDS: string[] = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'ALTER', 'DROP', 'ADD', 'COLUMN', 'RENAME', 'TO', 'MODIFY',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON', 'USING',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT',
  'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'DEFAULT', 'CHECK',
  'CONSTRAINT', 'INDEX', 'VIEW', 'TRIGGER', 'FUNCTION', 'PROCEDURE', 'RETURNING',
  'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'ASC', 'DESC', 'WITH', 'RECURSIVE',
  'GRANT', 'REVOKE', 'TRUNCATE', 'DATABASE', 'SCHEMA', 'USE', 'SHOW', 'DESCRIBE',
  'EXPLAIN', 'ANALYZE', 'VACUUM', 'TRANSACTION', 'START', 'SAVEPOINT',
  'TRUE', 'FALSE', 'CAST', 'COALESCE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
];

export interface SnippetDef {
  label: string;
  detail: string;
  /** Monaco snippet syntax, e.g. `SELECT ${1:cols} FROM ${2:table};`. */
  insertText: string;
}

/** Built-in SQL snippets surfaced in autocomplete and the toolbar dropdown. */
export const SQL_SNIPPETS: SnippetDef[] = [
  {
    label: 'select',
    detail: 'SELECT all columns',
    insertText: 'SELECT * FROM ${1:table} LIMIT ${2:100};',
  },
  {
    label: 'select_cols',
    detail: 'SELECT specific columns',
    insertText: 'SELECT ${1:column1}, ${2:column2}\nFROM ${3:table}\nWHERE ${4:condition};',
  },
  {
    label: 'insert',
    detail: 'INSERT row',
    insertText: "INSERT INTO ${1:table} (${2:column})\nVALUES (${3:value});",
  },
  {
    label: 'update',
    detail: 'UPDATE rows',
    insertText: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};',
  },
  {
    label: 'delete',
    detail: 'DELETE rows',
    insertText: 'DELETE FROM ${1:table}\nWHERE ${2:condition};',
  },
  {
    label: 'create_table',
    detail: 'CREATE TABLE',
    insertText:
      'CREATE TABLE ${1:name} (\n  id BIGINT PRIMARY KEY,\n  ${2:column} VARCHAR(255)\n);',
  },
  {
    label: 'join',
    detail: 'INNER JOIN',
    insertText:
      'SELECT *\nFROM ${1:left}\nINNER JOIN ${2:right} ON ${1:left}.${3:id} = ${2:right}.${3:id};',
  },
  {
    label: 'left_join',
    detail: 'LEFT JOIN',
    insertText:
      'SELECT *\nFROM ${1:left}\nLEFT JOIN ${2:right} ON ${1:left}.${3:id} = ${2:right}.${3:id};',
  },
  {
    label: 'orderby',
    detail: 'ORDER BY clause',
    insertText: 'ORDER BY ${1:column} ${2:DESC};',
  },
  {
    label: 'groupby',
    detail: 'GROUP BY clause',
    insertText: 'GROUP BY ${1:column}\nHAVING ${2:condition};',
  },
];

/** Flatten the schema tree into suggestion buckets for autocomplete. */
export interface SchemaSuggestions {
  databases: string[];
  tables: { name: string; schema?: string }[];
  /** Map of lowercased table name -> column names (across all schemas). */
  columnsByTable: Map<string, string[]>;
  /** Map of lowercased "schema.table" -> column names, for qualified
   *  `schema.table.` completion that resolves columns of THAT table only
   *  (not the cross-schema merge in `columnsByTable`). */
  columnsByDbTable: Map<string, string[]>;
  /** Map of lowercased database/schema name -> table names in it. */
  tablesByDatabase: Map<string, string[]>;
}

export function buildSchemaSuggestions(tree: SchemaGroupNode[] | null | undefined): SchemaSuggestions {
  const databases: string[] = [];
  const tables: { name: string; schema?: string }[] = [];
  const columnsByTable = new Map<string, string[]>();
  const columnsByDbTable = new Map<string, string[]>();
  const tablesByDatabase = new Map<string, string[]>();

  const addTable = (t: SchemaTableNode, schema?: string) => {
    tables.push({ name: t.name, schema });
    const cols = (t.children || []).map((c: SchemaColumnNode) => c.name);
    // Merge columns if the same table name appears in multiple schemas.
    const existing = columnsByTable.get(t.name.toLowerCase());
    if (existing) {
      const merged = Array.from(new Set([...existing, ...cols]));
      columnsByTable.set(t.name.toLowerCase(), merged);
    } else {
      columnsByTable.set(t.name.toLowerCase(), cols);
    }
    // Per-(schema,table) columns for qualified dot completion.
    if (schema) {
      columnsByDbTable.set(`${schema.toLowerCase()}.${t.name.toLowerCase()}`, cols);
      const key = schema.toLowerCase();
      const arr = tablesByDatabase.get(key) || [];
      if (!arr.includes(t.name)) arr.push(t.name);
      tablesByDatabase.set(key, arr);
    }
  };

  for (const group of tree || []) {
    databases.push(group.name);
    for (const t of group.children || []) addTable(t, group.name);
  }

  return { databases: Array.from(new Set(databases)), tables, columnsByTable, columnsByDbTable, tablesByDatabase };
}

/** Returns the identifier token immediately before a trailing dot, preserving
 *  original case. e.g. `SELECT * FROM klinikpro_local.` → "klinikpro_local".
 *  Returns null when the cursor isn't right after a `.<identifier>` boundary. */
export function tokenBeforeDot(textUntilCursor: string): string | null {
  const m = textUntilCursor.match(new RegExp(`(${IDENT})\\s*\\.\\s*$`));
  return m ? unquoteIdent(m[1]) : null;
}

/** Matches a single SQL identifier segment, either bare (`name`, `tbl_1`) or
 *  quoted with double-quotes / backticks. The captured group is the inner
 *  name WITHOUT the surrounding quotes so callers compare against raw schema
 *  names. Used by the dot-completion helper below. */
const IDENT = `(?:"[^"]+"|` + '`[^`]+`' + `|[A-Za-z_]\\w*)`;

function unquoteIdent(raw: string): string {
  if (raw.length >= 2) {
    if (raw[0] === '"' && raw[raw.length - 1] === '"') return raw.slice(1, -1).replace(/""/g, '"');
    if (raw[0] === '`' && raw[raw.length - 1] === '`') return raw.slice(1, -1).replace(/``/g, '`');
  }
  return raw;
}

/** Returns the (optionally qualified) identifier path immediately before a
 *  trailing dot, preserving original case. Handles up to two segments so both
 *  `table.` and `schema.table.` work, including quoted/backticked identifiers
 *  (e.g. `` `my-db`.`users`. `` → ["my-db", "users"]).
 *
 *  e.g. `SELECT * FROM klinikpro_local.users.` → ["klinikpro_local", "users"]
 *       `SELECT * FROM users.`               → ["users"]
 *  Returns null when the cursor isn't right after a `.<identifier>` boundary.
 *  The first element (when length === 2) is the schema/database, the last is
 *  the table/object name. */
export function qualifiedTokenBeforeDot(textUntilCursor: string): string[] | null {
  const two = textUntilCursor.match(new RegExp(`${IDENT}\\s*\\.\\s*${IDENT}\\s*\\.\\s*$`));
  if (two) return [unquoteIdent(two[1]), unquoteIdent(two[2])];
  const single = textUntilCursor.match(new RegExp(`(${IDENT})\\s*\\.\\s*$`));
  return single ? [unquoteIdent(single[1])] : null;
}

/** Parse the table name(s) listed in the nearest FROM/JOIN clauses before the
 *  cursor. Used to offer column suggestions without a dot. Returns lowercased
 *  table names.
 *
 *  `textUntilCursor` is the full editor text from the start up to the cursor. */
export function tablesInScope(textUntilCursor: string): string[] {
  const names = new Set<string>();

  // FROM/JOIN <ref> across the text before the cursor, where <ref> may be a
  // bare identifier, a quoted/backticked identifier, or a qualified
  // `schema.table`. We capture the full reference then take the last segment
  // (the table name) for column lookups.
  const refRe = new RegExp(
    `(?:FROM|JOIN)\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT})?)`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(textUntilCursor)) !== null) {
    const ref = m[1];
    const segs = ref.match(new RegExp(IDENT, 'g')) || [];
    const last = segs.length ? unquoteIdent(segs[segs.length - 1]) : '';
    if (last) names.add(last.toLowerCase());
  }
  return Array.from(names);
}
