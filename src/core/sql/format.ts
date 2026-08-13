/**
 * A small, dependency-free SQL beautifier. It's not a full parser — it
 * normalizes whitespace, uppercases keywords, and breaks lines before major
 * clauses so a pasted one-liner becomes readable. Good enough for "Format"
 * in the editor; not a substitute for a real tokenizer like sql-formatter.
 *
 * It respects single-quoted string literals (with '' escaping) so data values
 * containing keywords or whitespace are left intact.
 */

// Clauses that should start on a new line when at the top level.
const LINE_START = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ON',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'JOIN',
  'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT',
  'VALUES', 'SET', 'INSERT', 'UPDATE', 'DELETE', 'INTO',
  'WITH', 'RETURNING',
]);

// Keywords that should be uppercased.
const KEYWORDS = new Set([
  'SELECT', 'DISTINCT', 'FROM', 'AS', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
  'BETWEEN', 'LIKE', 'ILIKE', 'EXISTS', 'ON', 'USING', 'INNER', 'LEFT', 'RIGHT', 'OUTER',
  'FULL', 'CROSS', 'JOIN', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
  'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'ALTER', 'DROP', 'ADD', 'COLUMN', 'RENAME', 'TO', 'PRIMARY', 'KEY',
  'FOREIGN', 'REFERENCES', 'UNIQUE', 'DEFAULT', 'CHECK', 'CONSTRAINT', 'INDEX', 'VIEW',
  'WITH', 'RECURSIVE', 'RETURNING', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'IF', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'TRUE', 'FALSE', 'CAST', 'AS', 'DISTINCT', 'EXISTS',
]);

interface Token {
  value: string;
  /** quoted string literal, paren, comma, semicolon, comment, or word */
  kind: 'string' | 'paren' | 'punct' | 'word' | 'ws';
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // Line / block comments
    if (ch === '-' && sql[i + 1] === '-') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      tokens.push({ value: sql.slice(i, end), kind: 'word' });
      i = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let end = sql.indexOf('*/', i + 2);
      end = end === -1 ? sql.length : end + 2;
      tokens.push({ value: sql.slice(i, end), kind: 'word' });
      i = end;
      continue;
    }

    // Single-quoted string literal (with '' escape)
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      tokens.push({ value: sql.slice(i, j), kind: 'string' });
      i = j;
      continue;
    }

    // Identifier-quoted (double-quote/backtick) — treat as opaque word
    if (ch === '"' || ch === '`') {
      const close = ch;
      let j = i + 1;
      while (j < sql.length && sql[j] !== close) j++;
      j = Math.min(j + 1, sql.length);
      tokens.push({ value: sql.slice(i, j), kind: 'word' });
      i = j;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ value: ch, kind: 'paren' });
      i++;
      continue;
    }
    if (',;'.includes(ch)) {
      tokens.push({ value: ch, kind: 'punct' });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i;
      while (j < sql.length && /\s/.test(sql[j])) j++;
      tokens.push({ value: sql.slice(i, j), kind: 'ws' });
      i = j;
      continue;
    }

    // Word (identifiers, keywords, numbers, operators)
    let j = i;
    while (j < sql.length && !/[\s()'",;`]/.test(sql[j])) j++;
    tokens.push({ value: sql.slice(i, j), kind: 'word' });
    i = j;
  }
  return tokens;
}

export function formatSql(sql: string): string {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let depth = 0;
  let atLineStart = true;
  let afterSelectCols = false;

  const indent = () => '  '.repeat(depth);

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === 'ws') continue;

    if (t.kind === 'string') {
      out.push(t.value);
      atLineStart = false;
      continue;
    }

    const upper = t.kind === 'word' ? t.value.toUpperCase() : '';

    if (t.kind === 'punct' && t.value === ';') {
      out.push(';');
      // Statement boundary — reset.
      out.push('\n\n');
      depth = 0;
      afterSelectCols = false;
      atLineStart = true;
      continue;
    }

    if (t.kind === 'paren' && t.value === '(') {
      out.push('(');
      depth++;
      atLineStart = false;
      continue;
    }
    if (t.kind === 'paren' && t.value === ')') {
      depth = Math.max(0, depth - 1);
      out.push(')');
      atLineStart = false;
      continue;
    }

    if (t.kind === 'punct' && t.value === ',') {
      out.push(',');
      out.push('\n' + indent());
      atLineStart = true;
      continue;
    }

    // Word / keyword
    let value = t.value;
    if (t.kind === 'word' && KEYWORDS.has(upper)) value = upper;

    if (LINE_START.has(upper)) {
      if (out.length > 0 && !atLineStart) out.push('\n');
      // Reset SELECT column grouping when we hit the next major clause.
      if (upper !== 'AND' && upper !== 'OR' && upper !== 'ON') {
        depth = Math.min(depth, 1);
        afterSelectCols = upper === 'SELECT';
      }
      out.push(indent() + value);
      atLineStart = false;
      continue;
    }

    // SELECT column list: indent each column on its own line for readability.
    if (afterSelectCols && upper === 'AS') {
      out.push(' AS ');
      atLineStart = false;
      continue;
    }

    if (atLineStart && out.length > 0) {
      out.push((upper === 'SELECT' ? '' : indent()) + value);
      atLineStart = false;
      continue;
    }

    // Default: space-separate words.
    if (out.length > 0 && !out[out.length - 1].endsWith('(')) {
      out.push(' ');
    }
    out.push(value);
    atLineStart = false;
  }

  return out.join('').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
