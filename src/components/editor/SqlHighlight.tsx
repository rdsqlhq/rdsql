import React, { useMemo } from 'react';

/**
 * Lightweight SQL syntax highlighter for single-line / compact log rendering.
 *
 * No external dependency — a single regex tokenizer splits the input into
 * tokens (keyword, string, number, comment, identifier, punctuation, text)
 * and each kind gets a Tailwind color class. Designed for the dense, dark
 * log panel: colors are subtle (slate/blue/violet) so entries stay readable
 * even when many are visible at once.
 *
 * This is intentionally simple and fast — good enough for log lines and short
 * statements. The full SQL editor uses Monaco for rich highlighting.
 */

const KEYWORDS = new Set([
  // Core DML / DDL / TCL
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'SEQUENCE',
  'TRUNCATE', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'BEGIN', 'TRANSACTION', 'SAVEPOINT',
  // Clauses / joins
  'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS', 'ON', 'USING', 'AS',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT',
  'WITH', 'RECURSIVE', 'RETURNING', 'EXPLAIN', 'ANALYZE', 'VACUUM', 'PRAGMA',
  // Logical / set ops
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'DEFAULT',
  // Types (common)
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL',
  'TEXT', 'VARCHAR', 'CHAR', 'BOOLEAN', 'BOOL', 'JSON', 'JSONB',
  'TIMESTAMP', 'DATE', 'TIME', 'INTERVAL', 'UUID', 'BYTEA', 'BLOB',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL',
  // PG-specific
  'COALESCE', 'GREATEST', 'LEAST', 'NULLIF', 'CAST', 'GENERATED', 'IDENTITY',
  'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'KEY', 'REFERENCES', 'UNIQUE', 'CHECK',
  'CURRENT_TIMESTAMP', 'NOW', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'TRUE', 'FALSE', 'ARRAY', 'ROW', 'LATERAL', 'WINDOW', 'PARTITION',
]);

// One master regex that captures every token kind we care about. Order matters:
// comments and strings must be tried before punctuation/keywords so e.g. '--'
// inside a string isn't misread as a comment.
const TOKEN_RE = new RegExp(
  [
    /(?<comment>--[^\n]*|\/\*[\s\S]*?\*\/)/.source, // line + block comments
    /(?<string>'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`\\]|\\.)*`)/.source, // '...' / "..." / `...`
    /(?<number>\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/.source, // numeric literals
    /(?<word>[A-Za-z_][A-Za-z0-9_]*)/.source, // identifiers / keywords
    /(?<punct>[(),.;]+)/.source, // grouping / terminator punctuation
    /(?<ws>\s+)/.source, // whitespace (preserved as-is)
    /(?<other>[^\sA-Za-z0-9_'"]+)/.source, // operators and anything else
  ].join('|'),
  'g'
);

type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'identifier' | 'punct' | 'ws' | 'other';

const TOKEN_CLASS: Record<TokenKind, string> = {
  keyword: 'text-violet-300 font-medium',
  string: 'text-emerald-300',
  number: 'text-amber-300',
  comment: 'text-slate-500 italic',
  identifier: 'text-sky-200',
  punct: 'text-slate-500',
  ws: '',
  other: 'text-pink-300',
};

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(sql)) !== null) {
    const g = m.groups || {};
    if (g.comment) tokens.push({ kind: 'comment', value: g.comment });
    else if (g.string) tokens.push({ kind: 'string', value: g.string });
    else if (g.number) tokens.push({ kind: 'number', value: g.number });
    else if (g.word) {
      const kind: TokenKind = KEYWORDS.has(g.word.toUpperCase()) ? 'keyword' : 'identifier';
      tokens.push({ kind, value: g.word });
    } else if (g.punct) tokens.push({ kind: 'punct', value: g.punct });
    else if (g.ws) tokens.push({ kind: 'ws', value: g.ws });
    else if (g.other) tokens.push({ kind: 'other', value: g.other });
    if (m.index === TOKEN_RE.lastIndex) TOKEN_RE.lastIndex++; // avoid zero-length loop
  }
  return tokens;
}

export interface SqlHighlightProps {
  /** SQL text to render with syntax colors. */
  sql: string;
  /** Base text color class for non-highlighted fragments (defaults to slate-300). */
  className?: string;
}

/**
 * Render SQL with lightweight color coding. Whitespace is preserved so the
 * output flows naturally whether the source is single-line or multi-line.
 */
export const SqlHighlight: React.FC<SqlHighlightProps> = ({ sql, className = 'text-slate-300' }) => {
  const tokens = useMemo(() => tokenize(sql), [sql]);
  return (
    <code className={`font-mono ${className}`}>
      {tokens.map((t, i) =>
        t.kind === 'ws' ? (
          <span key={i}>{t.value}</span>
        ) : (
          <span key={i} className={TOKEN_CLASS[t.kind]}>
            {t.value}
          </span>
        )
      )}
    </code>
  );
};
