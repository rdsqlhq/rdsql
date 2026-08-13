import { describe, it, expect } from 'vitest';
import {
  groupKind,
  getDatabaseCapabilities,
  isProtectedName,
  dropDatabaseSql,
  createDatabaseSql,
  emptyDatabaseSql,
} from '../databaseActions';

// ───────────────────────── groupKind ─────────────────────────

describe('groupKind', () => {
  it('mysql → database', () => {
    expect(groupKind('mysql')).toBe('database');
    expect(groupKind('mariadb')).toBe('database');
  });
  it('postgres → schema', () => {
    expect(groupKind('postgres')).toBe('schema');
    expect(groupKind('postgresql')).toBe('schema');
  });
  it('sqlite/d1 → file', () => {
    expect(groupKind('sqlite')).toBe('file');
    expect(groupKind('cloudflare-d1')).toBe('file');
    expect(groupKind('d1')).toBe('file');
  });
  it('is case-insensitive', () => {
    expect(groupKind('MySQL')).toBe('database');
    expect(groupKind('PostgreSQL')).toBe('schema');
  });
});

// ───────────────────────── getDatabaseCapabilities ─────────────────────────

describe('getDatabaseCapabilities', () => {
  it('mysql supports drop/create/empty with "Database" label', () => {
    const c = getDatabaseCapabilities('mysql');
    expect(c.supportsDrop).toBe(true);
    expect(c.supportsCreate).toBe(true);
    expect(c.supportsEmpty).toBe(true);
    expect(c.entityLabel).toBe('Database');
  });
  it('postgres supports drop/create/empty with "Schema" label', () => {
    const c = getDatabaseCapabilities('postgres');
    expect(c.supportsDrop).toBe(true);
    expect(c.supportsCreate).toBe(true);
    expect(c.supportsEmpty).toBe(true);
    expect(c.entityLabel).toBe('Schema');
  });
  it('sqlite/d1 support nothing', () => {
    for (const e of ['sqlite', 'cloudflare-d1', 'd1']) {
      const c = getDatabaseCapabilities(e);
      expect(c.supportsDrop).toBe(false);
      expect(c.supportsCreate).toBe(false);
      expect(c.supportsEmpty).toBe(false);
    }
  });
});

// ───────────────────────── isProtectedName ─────────────────────────

describe('isProtectedName', () => {
  it('blocks mysql system databases', () => {
    expect(isProtectedName('mysql', 'mysql')).toBe(true);
    expect(isProtectedName('mysql', 'information_schema')).toBe(true);
    expect(isProtectedName('mysql', 'performance_schema')).toBe(true);
    expect(isProtectedName('mysql', 'sys')).toBe(true);
  });
  it('blocks postgres system schemas', () => {
    expect(isProtectedName('postgres', 'pg_catalog')).toBe(true);
    expect(isProtectedName('postgres', 'information_schema')).toBe(true);
    expect(isProtectedName('postgres', 'public')).toBe(true);
  });
  it('allows normal names', () => {
    expect(isProtectedName('mysql', 'my_app')).toBe(false);
    expect(isProtectedName('postgres', 'app_schema')).toBe(false);
  });
  it('is case-insensitive for system names', () => {
    expect(isProtectedName('mysql', 'MySQL')).toBe(true);
    expect(isProtectedName('mysql', 'SYS')).toBe(true);
  });
  it('sqlite has no protected names', () => {
    expect(isProtectedName('sqlite', 'main')).toBe(false);
  });
});

// ───────────────────────── dropDatabaseSql ─────────────────────────

describe('dropDatabaseSql', () => {
  it('mysql → DROP DATABASE', () => {
    expect(dropDatabaseSql('mysql', 'mydb')).toBe('DROP DATABASE `mydb`;');
  });
  it('postgres → DROP SCHEMA CASCADE', () => {
    expect(dropDatabaseSql('postgres', 'app')).toBe('DROP SCHEMA "app" CASCADE;');
  });
  it('sqlite/d1 → null', () => {
    expect(dropDatabaseSql('sqlite', 'main')).toBeNull();
    expect(dropDatabaseSql('cloudflare-d1', 'main')).toBeNull();
  });
  it('returns null for protected system entities', () => {
    expect(dropDatabaseSql('mysql', 'mysql')).toBeNull();
    expect(dropDatabaseSql('postgres', 'public')).toBeNull();
  });
  it('escapes embedded quotes (injection safety)', () => {
    // mysql backtick escaping
    expect(dropDatabaseSql('mysql', 'ev`il')).toBe('DROP DATABASE `ev``il`;');
    // postgres double-quote escaping — entire payload trapped inside quotes
    const sql = dropDatabaseSql('postgres', 'evil"; DROP DATABASE x; --');
    expect(sql).toBe('DROP SCHEMA "evil""; DROP DATABASE x; --" CASCADE;');
    // Only one statement terminator structure (the trailing ;) — the inner
    // DROP DATABASE is trapped inside the quoted identifier.
    expect(sql?.endsWith('CASCADE;')).toBe(true);
  });
});

// ───────────────────────── createDatabaseSql ─────────────────────────

describe('createDatabaseSql', () => {
  it('mysql → CREATE DATABASE with optional charset', () => {
    expect(createDatabaseSql('mysql', 'mydb')).toBe('CREATE DATABASE `mydb`;');
    expect(createDatabaseSql('mysql', 'mydb', 'utf8mb4')).toBe(
      'CREATE DATABASE `mydb` CHARACTER SET utf8mb4;'
    );
  });
  it('postgres → CREATE SCHEMA IF NOT EXISTS', () => {
    expect(createDatabaseSql('postgres', 'app')).toBe('CREATE SCHEMA IF NOT EXISTS "app";');
  });
  it('sqlite/d1 → null', () => {
    expect(createDatabaseSql('sqlite', 'main')).toBeNull();
  });
  it('escapes quotes', () => {
    expect(createDatabaseSql('mysql', 'ev`il')).toBe('CREATE DATABASE `ev``il`;');
  });
});

// ───────────────────────── emptyDatabaseSql ─────────────────────────

describe('emptyDatabaseSql', () => {
  it('mysql → drop + recreate database', () => {
    const stmts = emptyDatabaseSql('mysql', 'mydb', ['t1', 't2']);
    expect(stmts).toEqual(['DROP DATABASE `mydb`;', 'CREATE DATABASE `mydb`;']);
  });
  it('postgres → drop + recreate schema', () => {
    const stmts = emptyDatabaseSql('postgres', 'app', ['t1']);
    expect(stmts).toEqual(['DROP SCHEMA "app" CASCADE;', 'CREATE SCHEMA "app";']);
  });
  it('sqlite → DELETE FROM each table', () => {
    const stmts = emptyDatabaseSql('sqlite', 'main', ['users', 'orders']);
    expect(stmts).toEqual(['DELETE FROM "users";', 'DELETE FROM "orders";']);
  });
  it('protected mysql databases produce no destructive stmts', () => {
    expect(emptyDatabaseSql('mysql', 'mysql', [])).toEqual([]);
    expect(emptyDatabaseSql('mysql', 'sys', [])).toEqual([]);
  });
  it('protected postgres schemas produce no destructive stmts', () => {
    expect(emptyDatabaseSql('postgres', 'public', [])).toEqual([]);
  });
  it('sqlite empty db with no tables → empty array', () => {
    expect(emptyDatabaseSql('sqlite', 'main', [])).toEqual([]);
  });
});
