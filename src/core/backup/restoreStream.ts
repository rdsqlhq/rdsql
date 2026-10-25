import { scanSql, type SqlDialect } from '../sql/splitStatements';

/**
 * Reading a restore script piece by piece, so a dump of any size can be run
 * without loading it into memory (RestoreModal reads it in chunks through the
 * `file_read_chunk` command).
 */

export type RestoreItem =
  | { kind: 'statement'; text: string }
  /** A psql meta-command line (`\connect`, `\restrict` …): not SQL. */
  | { kind: 'meta'; text: string }
  /** Rows for a `COPY ... FROM stdin`, in COPY text format, one per line. */
  | { kind: 'copy'; sql: string; data: string; rows: number };

/** Splits a script that arrives in pieces into statements and COPY data.
 *  Feed it with `push(piece, isLastPiece)`; each call returns what became
 *  complete. Splitting the same text in any number of pieces gives the same
 *  items as passing it in one go. */
export class StatementScanner {
  private buf = '';
  private delimiter = ';';
  /** The COPY statement whose rows are being read, if any. */
  private copySql: string | null = null;
  /** The rest of the COPY statement's own line still has to be skipped. */
  private copyLineOpen = false;

  constructor(
    private readonly dialect: SqlDialect,
    /** COPY rows are handed over in batches of about this many characters. */
    private readonly copyBatchChars = 1 << 20
  ) {}

  push(piece: string, final: boolean): RestoreItem[] {
    this.buf += piece;
    const items: RestoreItem[] = [];
    for (;;) {
      if (this.copySql) {
        if (!this.readCopyRows(items, final)) break;
        continue;
      }
      const res = scanSql(this.buf, this.dialect, { final, delimiter: this.delimiter, psqlMeta: true, stopAtCopy: true });
      // A COPY statement is the last item; it isn't run on its own (it would
      // wait for rows on stdin) but sent with its rows as `copy` items.
      const scanned = res.copy ? res.items.slice(0, -1) : res.items;
      for (const item of scanned) items.push(item.kind === 'skipped' ? { kind: 'meta', text: item.text } : { kind: 'statement', text: item.text });
      this.buf = this.buf.slice(res.consumed);
      this.delimiter = res.delimiter;
      if (!res.copy) break;
      this.copySql = res.copy;
      this.copyLineOpen = true;
    }
    return items;
  }

  /** Reads COPY rows up to the `\.` line. Returns true when that line was
   *  reached (scanning SQL resumes), false when more input is needed. */
  private readCopyRows(items: RestoreItem[], final: boolean): boolean {
    let pos = 0;
    if (this.copyLineOpen) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1 && !final) return false;
      pos = nl === -1 ? this.buf.length : nl + 1;
      this.copyLineOpen = false;
    }
    let batch: string[] = [];
    let size = 0;
    const emit = () => {
      if (batch.length) items.push({ kind: 'copy', sql: this.copySql!, data: batch.join('\n') + '\n', rows: batch.length });
      batch = [];
      size = 0;
    };
    for (;;) {
      const nl = this.buf.indexOf('\n', pos);
      if (nl === -1 && !final) {
        emit();
        this.buf = this.buf.slice(pos);
        return false;
      }
      const end = nl === -1 ? this.buf.length : nl;
      const line = this.buf.slice(pos, end).replace(/\r$/, '');
      pos = nl === -1 ? this.buf.length : nl + 1;
      if (line === '\\.' || (nl === -1 && line === '')) {
        // End of the rows (or of the input, for a dump missing its `\.`).
        emit();
        this.buf = this.buf.slice(pos);
        this.copySql = null;
        return true;
      }
      batch.push(line);
      size += line.length + 1;
      if (size >= this.copyBatchChars) emit();
    }
  }

  /** Text left over after the last piece (an unterminated statement). */
  get rest(): string {
    return this.buf;
  }
}

/** Who wrote a restore script, judged from its first lines. */
export type DumpKind = 'rdsql' | 'pg_dump' | 'mysqldump' | 'sql';

export function detectDumpKind(head: string): DumpKind {
  if (/^-- rdSQL Backup/m.test(head)) return 'rdsql';
  if (/^-- PostgreSQL database dump/m.test(head)) return 'pg_dump';
  if (/^-- (MySQL|MariaDB) dump/m.test(head)) return 'mysqldump';
  return 'sql';
}

export const DUMP_LABEL: Record<DumpKind, string> = {
  rdsql: 'rdSQL backup',
  pg_dump: 'pg_dump script',
  mysqldump: 'mysqldump script',
  sql: 'SQL script',
};

export interface SkipRules {
  /** OWNER TO, GRANT, REVOKE and friends: they name roles that usually
   *  don't exist on the target server. */
  ownership: boolean;
  /** `USE otherdb`: when restoring into this connection's database, a dump's
   *  own USE would send everything after it somewhere else. */
  use: boolean;
}

/** Why a statement is left out under `rules`, or null to run it. */
export function skipReason(statement: string, rules: SkipRules): string | null {
  const s = statement.trimStart();
  if (rules.ownership) {
    if (/^ALTER\b[\s\S]*\sOWNER\s+TO\s/i.test(s)) return 'ownership';
    if (/^(GRANT|REVOKE)\s/i.test(s) || /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(s)) return 'privileges';
    // Needs ownership of the extension, which the restoring user rarely has.
    if (/^COMMENT\s+ON\s+EXTENSION\b/i.test(s)) return 'ownership';
  }
  if (rules.use && /^USE\s/i.test(s)) return 'database switch';
  return null;
}

/** Bytes of the file that weren't valid UTF-8 arrive as U+F780..U+F7FF, one
 *  character per byte (see RAW_BYTE_BASE in src-tauri/src/commands/files.rs). */
const RAW_BYTE = /[-]/;
const RAW_BYTE_BASE = 0xf700;

/** MySQL string escapes, as mysqldump writes them. */
const MYSQL_ESCAPES: Record<string, number> = { '0': 0, b: 8, n: 10, r: 13, t: 9, Z: 26 };

/**
 * Rewrites each string literal that holds raw bytes (a BLOB that mysqldump
 * wrote as-is) as an exact `X'..'` hex literal, dropping a `_binary`
 * introducer in front of it. Literals without raw bytes are left alone.
 * MySQL family only: other engines' dumps don't put raw bytes in literals.
 */
export function restoreBinaryLiterals(statement: string): string {
  if (!RAW_BYTE.test(statement)) return statement;
  let out = '';
  let i = 0;
  const n = statement.length;
  while (i < n) {
    const ch = statement[i];
    if (ch !== "'" && ch !== '"') {
      out += ch;
      i++;
      continue;
    }
    // Find the end of the literal (backslash escapes, doubled quotes).
    let j = i + 1;
    while (j < n) {
      if (statement[j] === '\\') j += 2;
      else if (statement[j] === ch && statement[j + 1] === ch) j += 2;
      else if (statement[j] === ch) break;
      else j++;
    }
    const body = statement.slice(i + 1, j);
    const literal = statement.slice(i, j + 1);
    if (!RAW_BYTE.test(body)) {
      out += literal;
      i = j + 1;
      continue;
    }
    const bytes: number[] = [];
    const encoder = new TextEncoder();
    for (let k = 0; k < body.length; k++) {
      let c = body[k];
      if (c === '\\' && k + 1 < body.length) {
        c = body[++k];
        if (c in MYSQL_ESCAPES) {
          bytes.push(MYSQL_ESCAPES[c]);
          continue;
        }
        // \% and \_ keep their backslash; anything else is the char itself.
        if (c === '%' || c === '_') bytes.push(92);
      } else if (c === ch && body[k + 1] === ch) {
        k++;
      }
      // By code point: a character above U+FFFF is two UTF-16 units.
      const code = body.codePointAt(k)!;
      if (code >= RAW_BYTE_BASE + 0x80 && code <= RAW_BYTE_BASE + 0xff) bytes.push(code - RAW_BYTE_BASE);
      else {
        if (code > 0xffff) k++;
        bytes.push(...encoder.encode(String.fromCodePoint(code)));
      }
    }
    out = out.replace(/_binary\s*$/i, '');
    out += `X'${bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}'`;
    i = j + 1;
  }
  return out;
}

/** True when a statement still holds raw bytes no rewrite could place. */
export function hasRawBytes(statement: string): boolean {
  return RAW_BYTE.test(statement);
}
