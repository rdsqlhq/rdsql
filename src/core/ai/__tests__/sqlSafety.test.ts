import { describe, it, expect } from 'vitest';
import { classifySQL, isReadOnlySQL } from '../sqlSafety';

describe('classifySQL — safe (read-only) statements', () => {
  const safeCases: [label: string, sql: string][] = [
    ['SELECT', 'SELECT * FROM users LIMIT 10;'],
    ['lowercase select', 'select id, email from users;'],
    ['SHOW', 'SHOW TABLES;'],
    ['EXPLAIN', 'EXPLAIN SELECT * FROM orders;'],
    ['DESCRIBE', 'DESCRIBE users;'],
    ['DESC', 'DESC users;'],
    ['PRAGMA', 'PRAGMA table_info(users);'],
    ['WITH (CTE)', 'WITH t AS (SELECT 1) SELECT * FROM t;'],
    ['TABLE shorthand', 'TABLE users;'],
    ['VALUES', "VALUES (1, 'a'), (2, 'b');"],
    ['USE (MySQL db switch)', 'USE shopdb;'],
    ['with leading comment', '/* get users */ SELECT * FROM users;'],
    ['with line comment', '-- top users\nSELECT * FROM users;'],
    ['leading whitespace', '   \n  SELECT 1;'],
    ['parenthesized', '(SELECT * FROM users) UNION (SELECT * FROM admins);'],
  ];

  for (const [label, sql] of safeCases) {
    it(`treats ${label} as safe`, () => {
      const result = classifySQL(sql);
      expect(result.risk).toBe('safe');
      expect(result.destructiveVerbs).toEqual([]);
      expect(isReadOnlySQL(sql)).toBe(true);
    });
  }
});

describe('classifySQL — destructive statements', () => {
  const destructiveCases: [label: string, sql: string, expectedVerb: string][] = [
    ['INSERT', "INSERT INTO users (email) VALUES ('a@x.com');", 'INSERT'],
    ['UPDATE', 'UPDATE users SET active = true;', 'UPDATE'],
    ['DELETE', 'DELETE FROM users WHERE id = 1;', 'DELETE'],
    ['DROP', 'DROP TABLE temp;', 'DROP'],
    ['TRUNCATE', 'TRUNCATE TABLE logs;', 'TRUNCATE'],
    ['ALTER', 'ALTER TABLE users ADD COLUMN x INT;', 'ALTER'],
    ['CREATE', 'CREATE INDEX idx ON users(email);', 'CREATE'],
    ['GRANT', 'GRANT SELECT ON users TO reader;', 'GRANT'],
    ['REVOKE', 'REVOKE SELECT ON users FROM reader;', 'REVOKE'],
    ['lowercase drop', 'drop table if exists foo;', 'DROP'],
    ['with comment before drop', '-- cleanup\nDROP TABLE old;', 'DROP'],
  ];

  for (const [label, sql, expectedVerb] of destructiveCases) {
    it(`flags ${label} as destructive`, () => {
      const result = classifySQL(sql);
      expect(result.risk).toBe('destructive');
      expect(result.destructiveVerbs).toContain(expectedVerb);
      expect(isReadOnlySQL(sql)).toBe(false);
    });
  }
});

describe('classifySQL — multi-statement batches', () => {
  it('is destructive if ANY statement is destructive', () => {
    const sql = 'SELECT * FROM users; DELETE FROM logs;';
    const result = classifySQL(sql);
    expect(result.risk).toBe('destructive');
    expect(result.destructiveVerbs).toEqual(['DELETE']);
  });

  it('collects multiple destructive verbs (deduplicated, in order)', () => {
    const sql = 'INSERT INTO a VALUES (1); UPDATE b SET x=1; INSERT INTO a VALUES (2);';
    const result = classifySQL(sql);
    expect(result.risk).toBe('destructive');
    expect(result.destructiveVerbs).toEqual(['INSERT', 'UPDATE']);
  });

  it('is safe when all statements are read-only', () => {
    const sql = 'SELECT 1; SELECT 2; SHOW TABLES;';
    expect(classifySQL(sql).risk).toBe('safe');
  });

  it('treats empty input as safe (no destructive verbs)', () => {
    expect(classifySQL('').risk).toBe('safe');
    expect(classifySQL('   ').risk).toBe('safe');
    expect(classifySQL('-- only a comment').risk).toBe('safe');
  });
});
