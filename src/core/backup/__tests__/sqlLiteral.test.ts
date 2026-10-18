import { describe, it, expect } from 'vitest';
import { sqlLiteral, cellLiteral, quoteSqlString, generateInsertStatements } from '../backupSql';

describe('quoteSqlString', () => {
  it('doubles backslashes only for MySQL-family engines', () => {
    expect(quoteSqlString('C:\\new', 'mysql')).toBe("'C:\\\\new'");
    expect(quoteSqlString('ends\\', 'mariadb')).toBe("'ends\\\\'");
    expect(quoteSqlString('C:\\new', 'postgres')).toBe("'C:\\new'");
    expect(quoteSqlString("it's", 'sqlite')).toBe("'it''s'");
  });
});

describe('sqlLiteral', () => {
  it('writes JSON objects and arrays as JSON text', () => {
    expect(sqlLiteral({ a: "b'c" }, 'postgres', 'jsonb')).toBe(`'{"a":"b''c"}'`);
    expect(sqlLiteral([1, 2], 'postgres', 'json')).toBe("'[1,2]'");
  });

  it('writes Postgres array columns as array literals', () => {
    expect(sqlLiteral([1, null, 3], 'postgres', '_int4')).toBe("'{1,NULL,3}'");
    expect(sqlLiteral(['a b', 'say "hi"'], 'postgres', '_text')).toBe(`'{"a b","say \\"hi\\""}'`);
    expect(sqlLiteral([[1, 2], [3, 4]], 'postgres', '_int4')).toBe("'{{1,2},{3,4}}'");
  });

  it('writes booleans as 1/0 for SQL Server', () => {
    expect(sqlLiteral(true, 'mssql')).toBe('1');
    expect(sqlLiteral(false, 'postgres')).toBe('FALSE');
  });
});

describe('cellLiteral', () => {
  it('quotes values and escapes per engine', () => {
    expect(cellLiteral(5, 'postgres')).toBe("'5'");
    expect(cellLiteral(null, 'mysql')).toBe('NULL');
    expect(cellLiteral('a\\b', 'mysql')).toBe("'a\\\\b'");
    expect(cellLiteral({ k: 1 }, 'postgres')).toBe(`'{"k":1}'`);
  });
});

describe('generateInsertStatements', () => {
  it('uses column types and engine escaping', () => {
    const [stmt] = generateInsertStatements(
      'mysql',
      't',
      undefined,
      [{ name: 'path', data_type: 'varchar' }],
      [['C:\\temp\\new']],
    );
    expect(stmt).toContain("'C:\\\\temp\\\\new'");
  });
});
