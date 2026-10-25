import { describe, expect, it } from 'vitest';
import { StatementScanner, detectDumpKind, skipReason, type RestoreItem } from '../restoreStream';
import type { SqlDialect } from '../../sql/splitStatements';

function scanInPieces(text: string, dialect: SqlDialect, size: number): RestoreItem[] {
  const scanner = new StatementScanner(dialect, 40);
  const items: RestoreItem[] = [];
  for (let i = 0; i < text.length; i += size) {
    items.push(...scanner.push(text.slice(i, i + size), i + size >= text.length));
  }
  if (text.length === 0) items.push(...scanner.push('', true));
  return items;
}

/** COPY batches are split by size, so compare their rows, not the batches. */
function normalize(items: RestoreItem[]) {
  const out: (string | { copy: string; data: string })[] = [];
  for (const it of items) {
    if (it.kind !== 'copy') out.push(`${it.kind}:${it.text}`);
    else {
      const last = out[out.length - 1];
      if (typeof last === 'object' && last.copy === it.sql) last.data += it.data;
      else out.push({ copy: it.sql, data: it.data });
    }
  }
  return out;
}

const PG_DUMP = `--
-- PostgreSQL database dump
--

\\restrict abc123

SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);
CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;
CREATE TABLE public.t (id integer, note text);
ALTER TABLE public.t OWNER TO alice;
COPY public.t (id, note) FROM stdin;
1\tsemi; colon
2\t\\N
3\tit's -- not a comment
\\.

SELECT pg_catalog.setval('public.t_id_seq', 3, true);
GRANT ALL ON TABLE public.t TO bob;

\\unrestrict abc123
`;

const MYSQL = `-- MySQL dump 10.13
/*!40101 SET NAMES utf8mb4 */;
INSERT INTO \`t\` VALUES (1,'a;b'),(2,'c\\\\\\'d');
DELIMITER ;;
CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END ;;
DELIMITER ;
USE \`other\`;
`;

describe('StatementScanner', () => {
  it('reads a pg_dump script: meta lines, COPY rows, then SQL again', () => {
    const items = normalize(scanInPieces(PG_DUMP, 'postgres', PG_DUMP.length));
    expect(items).toEqual([
      'meta:\\restrict abc123',
      'statement:SET statement_timeout = 0;',
      "statement:SELECT pg_catalog.set_config('search_path', '', false);",
      'statement:CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;',
      'statement:CREATE TABLE public.t (id integer, note text);',
      'statement:ALTER TABLE public.t OWNER TO alice;',
      { copy: 'COPY public.t (id, note) FROM stdin;', data: "1\tsemi; colon\n2\t\\N\n3\tit's -- not a comment\n" },
      "statement:SELECT pg_catalog.setval('public.t_id_seq', 3, true);",
      'statement:GRANT ALL ON TABLE public.t TO bob;',
      'meta:\\unrestrict abc123',
    ]);
  });

  it.each([
    ['postgres', PG_DUMP],
    ['mysql', MYSQL],
  ] as const)('gives the same %s items for any piece size', (dialect, text) => {
    const whole = normalize(scanInPieces(text, dialect, text.length));
    for (let size = 1; size <= 64; size++) {
      expect(normalize(scanInPieces(text, dialect, size)), `piece size ${size}`).toEqual(whole);
    }
  });

  it('keeps the mysql DELIMITER across pieces', () => {
    const items = normalize(scanInPieces(MYSQL, 'mysql', 3));
    expect(items).toContain('statement:CREATE TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN SET NEW.a = 1; END');
    expect(items[items.length - 1]).toBe('statement:USE `other`;');
  });

  it('hands COPY rows over in batches', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i}\tvalue ${i}`).join('\n');
    const script = `COPY t (id, v) FROM stdin;\n${rows}\n\\.\nSELECT 1;\n`;
    const items = scanInPieces(script, 'postgres', 17);
    const copies = items.filter((i) => i.kind === 'copy');
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.reduce((n, c) => n + (c.kind === 'copy' ? c.rows : 0), 0)).toBe(50);
    expect(items[items.length - 1]).toEqual({ kind: 'statement', text: 'SELECT 1;' });
  });
});

describe('detectDumpKind / skipReason', () => {
  it('recognizes the dump tools', () => {
    expect(detectDumpKind('-- rdSQL Backup\n-- Format-Version: 2')).toBe('rdsql');
    expect(detectDumpKind(PG_DUMP)).toBe('pg_dump');
    expect(detectDumpKind(MYSQL)).toBe('mysqldump');
    expect(detectDumpKind('-- MariaDB dump 10.19')).toBe('mysqldump');
    expect(detectDumpKind('CREATE TABLE t (id int);')).toBe('sql');
  });

  it('skips role and database-switch statements only when asked', () => {
    const on = { ownership: true, use: true };
    expect(skipReason('ALTER TABLE public.t OWNER TO alice;', on)).toBe('ownership');
    expect(skipReason('ALTER SEQUENCE public.s OWNER TO alice;', on)).toBe('ownership');
    expect(skipReason('GRANT ALL ON TABLE public.t TO bob;', on)).toBe('privileges');
    expect(skipReason('REVOKE ALL ON SCHEMA public FROM PUBLIC;', on)).toBe('privileges');
    expect(skipReason('COMMENT ON EXTENSION plpgsql IS \'x\';', on)).toBe('ownership');
    expect(skipReason('USE `other`;', on)).toBe('database switch');
    expect(skipReason('ALTER TABLE t ADD COLUMN owner text;', on)).toBeNull();
    expect(skipReason('ALTER TABLE public.t OWNER TO alice;', { ownership: false, use: false })).toBeNull();
  });
});

describe('restoreBinaryLiterals', () => {
  it('turns literals holding raw bytes into exact hex, leaving the rest', async () => {
    const { restoreBinaryLiterals } = await import('../restoreStream');
    // ff and fe arrive as U+F7FF / U+F7FE; \0 and \' are mysqldump escapes.
    const stmt = "INSERT INTO t VALUES (1,'text ü',_binary '\\0a\\''),(2,'it''s',NULL);";
    expect(restoreBinaryLiterals(stmt)).toBe("INSERT INTO t VALUES (1,'text ü',X'FF006127FE'),(2,'it''s',NULL);");
    expect(restoreBinaryLiterals("INSERT INTO t VALUES ('plain');")).toBe("INSERT INTO t VALUES ('plain');");
    // Valid UTF-8 inside a binary literal keeps its bytes (ü = c3 bc).
    expect(restoreBinaryLiterals("SELECT _binary 'ü';")).toBe("SELECT X'C3BC80';");
    // Bytes that happen to form a character above U+FFFF (f4 86 bc 85), as in
    // a real mysqldump of an MD5 blob.
    expect(restoreBinaryLiterals("SELECT _binary '\u{106F05}\uF7FF';")).toBe("SELECT X'F486BC85FF';");
  });
});
