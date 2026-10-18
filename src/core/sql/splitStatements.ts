import { engineFamily } from '../connection/engines';

/** Lexical rules that change where a statement ends. */
export type SqlDialect = 'mysql' | 'postgres' | 'sqlite' | 'mssql' | 'generic';

export function sqlDialectFor(engine: string | undefined): SqlDialect {
  if (!engine) return 'generic';
  switch (engineFamily(engine)) {
    case 'mysql':
      return 'mysql';
    case 'postgres':
    case 'duckdb':
      return 'postgres';
    case 'sqlite':
      return 'sqlite';
    case 'mssql':
      return 'mssql';
    default:
      return 'generic';
  }
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;
const ROUTINE_HEAD =
  /^CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:TEMP(?:ORARY)?\s+)?(?:PROCEDURE|PROC|FUNCTION|TRIGGER|EVENT)\b/i;
/** Words after END that close a construct other than BEGIN/CASE. */
const END_SUFFIXES = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR']);
/** Words after BEGIN that start a transaction, not a block. */
const BEGIN_TXN = new Set(['TRANSACTION', 'TRAN', 'WORK', 'DISTRIBUTED']);

/**
 * Splits a SQL script into statements.
 *
 * A `;` ends a statement only outside of:
 * - string literals: '' doubling everywhere, plus backslash escapes in MySQL
 *   strings and Postgres E'...' strings
 * - quoted identifiers ("...", `...`, and [...] in SQL Server)
 * - comments (--, /* *\/, and # in MySQL). MySQL's executable /*! ... *\/
 *   comments are kept as code.
 * - Postgres dollar-quoted bodies ($$ ... $$, $tag$ ... $tag$)
 * - BEGIN ... END bodies of CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT
 *
 * Also understands the mysql client's `DELIMITER` command and SQL Server's
 * `GO` batch separator. Each statement keeps its trailing `;`. Leading
 * comments are dropped, and so are statements that are only comments.
 */
export function splitSqlStatements(sql: string, dialect: SqlDialect = 'generic'): string[] {
  const statements: string[] = [];
  const n = sql.length;
  let current = '';
  let delimiter = ';';
  let routine = false;
  let depth = 0;
  let wordsSeen = 0;

  const flush = (text: string) => {
    const cleaned = stripLeadingComments(text, dialect).trim();
    if (cleaned && cleaned !== delimiter) statements.push(cleaned);
    current = '';
    routine = false;
    depth = 0;
    wordsSeen = 0;
  };

  const atLineStart = (i: number) => {
    let j = i - 1;
    while (j >= 0 && (sql[j] === ' ' || sql[j] === '\t')) j--;
    return j < 0 || sql[j] === '\n' || sql[j] === '\r';
  };

  const lineEnd = (i: number) => {
    const nl = sql.indexOf('\n', i);
    return nl === -1 ? n : nl;
  };

  let i = 0;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Client-side commands that only make sense at the start of a line.
    if ((ch === 'D' || ch === 'd') && dialect === 'mysql' && atLineStart(i) && /^DELIMITER\s/i.test(sql.slice(i, i + 10))) {
      const end = lineEnd(i);
      const token = sql.slice(i + 9, end).trim();
      flush(current);
      if (token) delimiter = token;
      i = end;
      continue;
    }
    if ((ch === 'G' || ch === 'g') && dialect === 'mssql' && atLineStart(i)) {
      const end = lineEnd(i);
      if (/^GO(\s+\d+)?\s*$/i.test(sql.slice(i, end))) {
        flush(current);
        i = end;
        continue;
      }
    }

    // Custom delimiter (after `DELIMITER $$`): split on it verbatim.
    if (delimiter !== ';' && sql.startsWith(delimiter, i)) {
      flush(current);
      i += delimiter.length;
      continue;
    }

    // Line comments.
    if ((ch === '-' && next === '-') || (ch === '#' && dialect === 'mysql')) {
      const end = lineEnd(i);
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comments. MySQL's /*! ... */ runs as code, so it isn't skipped.
    if (ch === '/' && next === '*' && !(dialect === 'mysql' && sql[i + 2] === '!')) {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Quoted strings and identifiers.
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && dialect === 'mssql')) {
      const closeCh = ch === '[' ? ']' : ch;
      const prev = sql[i - 1];
      const prevPrev = sql[i - 2];
      const backslash =
        (dialect === 'mysql' && ch !== '`') ||
        (dialect === 'postgres' && ch === "'" && (prev === 'E' || prev === 'e') && !(prevPrev && IDENT_CHAR.test(prevPrev)));
      let j = i + 1;
      while (j < n) {
        const c = sql[j];
        if (backslash && c === '\\') {
          j += 2;
          continue;
        }
        if (c === closeCh) {
          if (sql[j + 1] === closeCh && closeCh !== ']') {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(j + 1, n);
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Dollar-quoted bodies: $$ ... $$ or $tag$ ... $tag$.
    if (ch === '$' && dialect !== 'mysql' && dialect !== 'mssql' && !(i > 0 && IDENT_CHAR.test(sql[i - 1]))) {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    // Words: track routine bodies so their inner `;` don't split.
    if (/[A-Za-z_]/.test(ch) && !(i > 0 && (IDENT_CHAR.test(sql[i - 1]) || sql[i - 1] === '.'))) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(sql[j]) && !(delimiter !== ';' && sql.startsWith(delimiter, j))) j++;
      const word = sql.slice(i, j).toUpperCase();
      current += sql.slice(i, j);
      i = j;

      if (!routine && wordsSeen < 12) {
        wordsSeen++;
        if (ROUTINE_HEAD.test(stripLeadingComments(current, dialect).trimStart())) routine = true;
      }
      if (routine && delimiter === ';') {
        const following = nextWord(sql, i);
        if (word === 'BEGIN' && !BEGIN_TXN.has(following)) depth++;
        else if (word === 'CASE') depth++;
        else if (word === 'END' && !END_SUFFIXES.has(following)) depth = Math.max(0, depth - 1);
      }
      continue;
    }

    if (ch === ';' && delimiter === ';' && depth === 0) {
      flush(current + ch);
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  flush(current);
  return statements;
}

function nextWord(sql: string, from: number): string {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(from, from + 64));
  return m ? m[1].toUpperCase() : '';
}

/** Removes comments (and whitespace) in front of a statement's first token. */
function stripLeadingComments(text: string, dialect: SqlDialect): string {
  let s = text;
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('--') || (dialect === 'mysql' && t.startsWith('#'))) {
      const nl = t.indexOf('\n');
      s = nl === -1 ? '' : t.slice(nl + 1);
    } else if (t.startsWith('/*') && !(dialect === 'mysql' && t.startsWith('/*!'))) {
      const close = t.indexOf('*/');
      s = close === -1 ? '' : t.slice(close + 2);
    } else {
      return t;
    }
  }
}
