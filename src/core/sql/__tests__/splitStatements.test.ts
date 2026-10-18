import { describe, it, expect } from 'vitest';
import { splitSqlStatements, sqlDialectFor } from '../splitStatements';

describe('splitSqlStatements', () => {
  it('splits on top-level semicolons and keeps them', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1;', 'SELECT 2']);
  });

  it('ignores semicolons inside strings and quoted identifiers', () => {
    expect(splitSqlStatements("INSERT INTO t VALUES ('a;b', 'it''s'); SELECT 2;")).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s');",
      'SELECT 2;',
    ]);
    expect(splitSqlStatements('SELECT "a;b" FROM `c;d`; SELECT 2;')).toHaveLength(2);
  });

  it('does not let an apostrophe in a comment swallow the script', () => {
    expect(splitSqlStatements("-- don't run\nSELECT 1;\nSELECT 2;")).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(splitSqlStatements("/* it's; fine */ SELECT 1; SELECT 2;")).toEqual(['SELECT 1;', 'SELECT 2;']);
    expect(splitSqlStatements("# it's\nSELECT 1; SELECT 2;", 'mysql')).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('drops comment-only statements', () => {
    expect(splitSqlStatements('SELECT 1;\n-- the end\n')).toEqual(['SELECT 1;']);
  });

  it('keeps MySQL executable comments', () => {
    expect(splitSqlStatements('/*!40101 SET NAMES utf8 */;\nSELECT 1;', 'mysql')).toEqual([
      '/*!40101 SET NAMES utf8 */;',
      'SELECT 1;',
    ]);
  });

  it('handles MySQL backslash escapes but not in Postgres standard strings', () => {
    expect(splitSqlStatements("SELECT 'it\\'s;'; SELECT 2;", 'mysql')).toEqual(["SELECT 'it\\'s;';", 'SELECT 2;']);
    expect(splitSqlStatements("SELECT 'C:\\'; SELECT 2;", 'postgres')).toEqual(["SELECT 'C:\\';", 'SELECT 2;']);
    expect(splitSqlStatements("SELECT E'it\\'s;'; SELECT 2;", 'postgres')).toEqual(["SELECT E'it\\'s;';", 'SELECT 2;']);
  });

  it('keeps Postgres dollar-quoted function bodies whole', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;';
    expect(splitSqlStatements(`${fn}\nSELECT f();`, 'postgres')).toEqual([fn, 'SELECT f();']);
    const tagged = 'DO $body$ BEGIN PERFORM 1; END $body$;';
    expect(splitSqlStatements(tagged, 'postgres')).toEqual([tagged]);
  });

  it('does not treat $1 parameters or identifiers with $ as dollar quotes', () => {
    expect(splitSqlStatements('SELECT a$b$c FROM t; SELECT 2;')).toHaveLength(2);
  });

  it('keeps MySQL procedure bodies whole', () => {
    const proc = `CREATE PROCEDURE p()
BEGIN
  DECLARE x INT DEFAULT 0;
  IF x = 0 THEN
    SELECT CASE WHEN x = 0 THEN 'zero' ELSE 'other' END;
  END IF;
  WHILE x < 3 DO
    SET x = x + 1;
  END WHILE;
END;`;
    expect(splitSqlStatements(`${proc}\nCALL p();`, 'mysql')).toEqual([proc, 'CALL p();']);
  });

  it('keeps SQLite trigger bodies whole', () => {
    const trg = 'CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE c SET n = n + 1; INSERT INTO log VALUES (1); END;';
    expect(splitSqlStatements(`${trg} SELECT 1;`, 'sqlite')).toEqual([trg, 'SELECT 1;']);
  });

  it('does not treat a transaction BEGIN as a block', () => {
    expect(splitSqlStatements('BEGIN; DELETE FROM t; ROLLBACK;', 'postgres')).toEqual([
      'BEGIN;',
      'DELETE FROM t;',
      'ROLLBACK;',
    ]);
  });

  it('supports the mysql client DELIMITER command', () => {
    const script = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nCALL p();';
    expect(splitSqlStatements(script, 'mysql')).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; END', 'CALL p();']);
  });

  it('supports SQL Server GO batch separators and bracket identifiers', () => {
    const script = 'CREATE PROCEDURE p AS BEGIN SELECT [a;b] FROM t; END\nGO\nEXEC p;';
    expect(splitSqlStatements(script, 'mssql')).toEqual(['CREATE PROCEDURE p AS BEGIN SELECT [a;b] FROM t; END', 'EXEC p;']);
  });
});

describe('sqlDialectFor', () => {
  it('maps engines to dialects', () => {
    expect(sqlDialectFor('mariadb')).toBe('mysql');
    expect(sqlDialectFor('cockroachdb')).toBe('postgres');
    expect(sqlDialectFor('duckdb')).toBe('postgres');
    expect(sqlDialectFor('cloudflare-d1')).toBe('sqlite');
    expect(sqlDialectFor('mssql')).toBe('mssql');
    expect(sqlDialectFor(undefined)).toBe('generic');
  });
});
