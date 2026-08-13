import React, { useMemo, useState } from 'react';
import { cn } from '../../core/utils/cn';

/**
 * Read-only SQL viewer: line numbers + lightweight syntax highlighting.
 *
 * The text is rendered exactly as given — this component never rewrites,
 * reformats or generates SQL. Highlighting is a token pass over each line,
 * emitted as React elements (so nothing is ever injected as HTML).
 *
 * Long scripts are rendered up to `initialLines` and extended on demand, so a
 * 10k-statement sync doesn't put 10k rows in the DOM before the user asks.
 */

const KEYWORDS = new Set([
  'add', 'all', 'alter', 'and', 'as', 'asc', 'auto_increment', 'begin', 'between', 'by',
  'cascade', 'case', 'change', 'character', 'check', 'collate', 'column', 'comment',
  'commit', 'constraint', 'create', 'cross', 'current_timestamp', 'database', 'default',
  'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'engine', 'exists', 'first',
  'foreign', 'from', 'full', 'generated', 'group', 'having', 'if', 'in', 'index', 'inner',
  'insert', 'into', 'is', 'join', 'key', 'left', 'like', 'limit', 'modify', 'not', 'null',
  'on', 'or', 'order', 'outer', 'primary', 'references', 'rename', 'restrict', 'right',
  'rollback', 'schema', 'select', 'set', 'table', 'then', 'to', 'transaction', 'type',
  'union', 'unique', 'unsigned', 'update', 'using', 'values', 'view', 'when', 'where', 'with',
]);

const TYPES = new Set([
  'bigint', 'binary', 'bit', 'blob', 'bool', 'boolean', 'bytea', 'char', 'date', 'datetime',
  'decimal', 'double', 'enum', 'float', 'int', 'int2', 'int4', 'int8', 'integer', 'json',
  'jsonb', 'longtext', 'mediumint', 'mediumtext', 'numeric', 'real', 'serial', 'smallint',
  'text', 'time', 'timestamp', 'timestamptz', 'tinyint', 'tinytext', 'uuid', 'varbinary',
  'varchar',
]);

// Order matters: comments and quoted runs are consumed before bare words.
const TOKEN_RE =
  /(--[^\n]*)|(\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(`(?:[^`])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|([\s\S])/g;

/** Tokenize one line of SQL into styled spans. */
function highlightLine(line: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain) {
      out.push(<span key={`${keyPrefix}-p${i++}`}>{plain}</span>);
      plain = '';
    }
  };

  while ((match = TOKEN_RE.exec(line)) !== null) {
    const [text, lineComment, blockComment, sqlString, dq, bq, num, word] = match;
    if (lineComment || blockComment) {
      flushPlain();
      out.push(
        <span key={`${keyPrefix}-c${i++}`} className="text-slate-600 italic">
          {text}
        </span>
      );
    } else if (sqlString) {
      flushPlain();
      out.push(
        <span key={`${keyPrefix}-s${i++}`} className="text-emerald-300">
          {text}
        </span>
      );
    } else if (dq || bq) {
      // Quoted identifiers — the DDL quotes every table/column name.
      flushPlain();
      out.push(
        <span key={`${keyPrefix}-i${i++}`} className="text-slate-200">
          {text}
        </span>
      );
    } else if (num) {
      flushPlain();
      out.push(
        <span key={`${keyPrefix}-n${i++}`} className="text-orange-300">
          {text}
        </span>
      );
    } else if (word) {
      const lower = word.toLowerCase();
      if (KEYWORDS.has(lower)) {
        flushPlain();
        out.push(
          <span key={`${keyPrefix}-k${i++}`} className="text-cyan-400 font-semibold">
            {text}
          </span>
        );
      } else if (TYPES.has(lower)) {
        flushPlain();
        out.push(
          <span key={`${keyPrefix}-t${i++}`} className="text-purple-300">
            {text}
          </span>
        );
      } else {
        plain += text;
      }
    } else {
      plain += text;
    }
  }
  flushPlain();
  return out;
}

export const SqlPreview: React.FC<{
  sql: string;
  /** How many lines to render before showing the "show more" control. */
  initialLines?: number;
  className?: string;
  /** Max height of the scroll area; defaults to a comfortable panel height. */
  maxHeightClass?: string;
}> = ({ sql, initialLines = 400, className, maxHeightClass = 'max-h-[52vh]' }) => {
  const lines = useMemo(() => sql.split('\n'), [sql]);
  const [shown, setShown] = useState(initialLines);
  const visible = lines.slice(0, shown);
  const remaining = lines.length - visible.length;
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  if (sql.trim() === '') {
    return (
      <div className={cn('px-4 py-6 text-center text-[11px] text-slate-500', className)}>
        No statements in this section.
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col min-h-0', className)}>
      <div className={cn('overflow-auto', maxHeightClass)}>
        <pre className="text-[11px] leading-[1.6] font-mono">
          {visible.map((line, idx) => (
            <div key={idx} className="flex hover:bg-[#0f172a]/40">
              <span
                className="shrink-0 select-none text-right pr-3 pl-3 text-slate-700 tabular-nums sticky left-0 bg-[#06090e]"
                style={{ width: `calc(${gutterWidth} + 1.5rem)` }}
              >
                {idx + 1}
              </span>
              <code className="pr-4 whitespace-pre text-slate-300">
                {line === '' ? ' ' : highlightLine(line, `l${idx}`)}
              </code>
            </div>
          ))}
        </pre>
      </div>
      {remaining > 0 && (
        <button
          onClick={() => setShown((s) => s + initialLines)}
          className="w-full px-3 py-2 border-t border-[#1e293b] text-[11px] text-slate-400 hover:text-cyan-300 hover:bg-[#0f172a] transition-colors"
        >
          Show {Math.min(remaining, initialLines).toLocaleString()} more lines
          <span className="text-slate-600"> ({remaining.toLocaleString()} hidden)</span>
        </button>
      )}
    </div>
  );
};
