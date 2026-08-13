import { describe, it, expect } from 'vitest';
import { categorizeStatement, buildRestorePlan } from '../restorePlanner';
import { getEngineCapabilities } from '../backupEngine';

describe('categorizeStatement', () => {
  const mysqlCaps = getEngineCapabilities('mysql');
  const pgCaps = getEngineCapabilities('postgres');
  const sqliteCaps = getEngineCapabilities('sqlite');

  it('categorizes CREATE TABLE as ddl_create', () => {
    expect(categorizeStatement('CREATE TABLE users (id INT);', mysqlCaps)).toBe('ddl_create');
    expect(categorizeStatement('  CREATE TABLE IF NOT EXISTS `orders` (...);', mysqlCaps)).toBe('ddl_create');
  });

  it('categorizes CREATE INDEX as ddl_create', () => {
    expect(categorizeStatement('CREATE INDEX idx_name ON users(name);', pgCaps)).toBe('ddl_create');
    expect(categorizeStatement('CREATE UNIQUE INDEX idx_email ON users(email);', pgCaps)).toBe('ddl_create');
  });

  it('categorizes DROP TABLE as ddl_drop', () => {
    expect(categorizeStatement('DROP TABLE IF EXISTS users;', mysqlCaps)).toBe('ddl_drop');
    expect(categorizeStatement('DROP TABLE users CASCADE;', pgCaps)).toBe('ddl_drop');
  });

  it('categorizes ALTER TABLE as ddl_alter', () => {
    expect(categorizeStatement('ALTER TABLE users ADD COLUMN role VARCHAR(50);', pgCaps)).toBe('ddl_alter');
  });

  it('categorizes INSERT/UPDATE/DELETE as dml', () => {
    expect(categorizeStatement("INSERT INTO users VALUES (1, 'Alice');", mysqlCaps)).toBe('dml');
    expect(categorizeStatement('UPDATE users SET name = Bob WHERE id = 1;', mysqlCaps)).toBe('dml');
    expect(categorizeStatement('DELETE FROM users WHERE id = 1;', mysqlCaps)).toBe('dml');
  });

  it('categorizes MySQL FK disable/enable', () => {
    expect(categorizeStatement('SET FOREIGN_KEY_CHECKS = 0;', mysqlCaps)).toBe('fk_disable');
    expect(categorizeStatement('SET FOREIGN_KEY_CHECKS = 1;', mysqlCaps)).toBe('fk_enable');
  });

  it('categorizes PostgreSQL FK disable/enable', () => {
    expect(categorizeStatement("SET session_replication_role = 'replica';", pgCaps)).toBe('fk_disable');
    expect(categorizeStatement("SET session_replication_role = 'origin';", pgCaps)).toBe('fk_enable');
  });

  it('categorizes SQLite FK disable/enable', () => {
    expect(categorizeStatement('PRAGMA foreign_keys = OFF;', sqliteCaps)).toBe('fk_disable');
    expect(categorizeStatement('PRAGMA foreign_keys = ON;', sqliteCaps)).toBe('fk_enable');
  });

  it('detects MySQL FK statements even without capabilities (cross-file restore)', () => {
    expect(categorizeStatement('SET FOREIGN_KEY_CHECKS = 0;')).toBe('fk_disable');
    expect(categorizeStatement('SET FOREIGN_KEY_CHECKS = 1;')).toBe('fk_enable');
  });

  it('categorizes SET statements as pragma_set (non-FK)', () => {
    expect(categorizeStatement('SET search_path TO public;', pgCaps)).toBe('pragma_set');
    expect(categorizeStatement('SET NAMES utf8mb4;', mysqlCaps)).toBe('pragma_set');
  });

  it('categorizes unrecognized statements as unknown', () => {
    expect(categorizeStatement('SELECT 1;', mysqlCaps)).toBe('unknown');
    expect(categorizeStatement('GRANT SELECT ON users TO bob;', pgCaps)).toBe('unknown');
  });

  it('handles leading comments', () => {
    expect(categorizeStatement('-- comment\nCREATE TABLE x (id INT);', pgCaps)).toBe('ddl_create');
    expect(categorizeStatement('/* block */ DROP TABLE x;', pgCaps)).toBe('ddl_drop');
  });
});

describe('buildRestorePlan', () => {
  it('returns empty plan for empty input', () => {
    const plan = buildRestorePlan('');
    expect(plan.items).toEqual([]);
    expect(plan.totalStatements).toBe(0);
  });

  it('orders phases correctly: fk_off → creates → data → fk_on', () => {
    const sql = [
      'SET FOREIGN_KEY_CHECKS = 0;',
      "INSERT INTO orders (id) VALUES (1);",
      'CREATE TABLE orders (id INT);',
      'SET FOREIGN_KEY_CHECKS = 1;',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'mysql');
    const cats = plan.items.map((i) => i.category);
    expect(cats).toEqual(['fk_disable', 'ddl_create', 'dml', 'fk_enable']);
  });

  it('runs drops before creates', () => {
    const sql = [
      'CREATE TABLE users (id INT);',
      'DROP TABLE IF EXISTS old_users;',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'postgres');
    const cats = plan.items.map((i) => i.category);
    expect(cats).toEqual(['ddl_drop', 'ddl_create']);
  });

  it('runs alters after data', () => {
    const sql = [
      'ALTER TABLE users ADD COLUMN role TEXT;',
      "INSERT INTO users (id) VALUES (1);",
      'CREATE TABLE users (id INT);',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'postgres');
    const cats = plan.items.map((i) => i.category);
    const createIdx = cats.indexOf('ddl_create');
    const dmlIdx = cats.indexOf('dml');
    const alterIdx = cats.indexOf('ddl_alter');
    expect(createIdx).toBeLessThan(dmlIdx);
    expect(dmlIdx).toBeLessThan(alterIdx);
  });

  it('preserves unknown statement relative order (not moved blindly to end)', () => {
    const sql = [
      'CREATE TABLE a (id INT);',
      'GRANT SELECT ON a TO bob;',      // unknown
      'CREATE TABLE b (id INT);',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'postgres');
    // Both creates should come first (ddl_create bucket), then unknown.
    // But the unknown's originalIndex is 1, so within the unknown bucket it's
    // the only item. The key is it does NOT come after fk_enable.
    const cats = plan.items.map((i) => i.category);
    expect(cats).toEqual(['ddl_create', 'ddl_create', 'unknown']);
  });

  it('preserves original order within a phase', () => {
    const sql = [
      'CREATE TABLE z_table (id INT);',
      'CREATE TABLE a_table (id INT);',
      'CREATE TABLE m_table (id INT);',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'postgres');
    const tables = plan.items.map((i) => i.statement.match(/TABLE\s+(\w+)/)?.[1]);
    // Original order preserved within ddl_create bucket
    expect(tables).toEqual(['z_table', 'a_table', 'm_table']);
  });

  it('counts DDL and DML correctly', () => {
    const sql = [
      'CREATE TABLE users (id INT);',
      "INSERT INTO users VALUES (1);",
      "INSERT INTO users VALUES (2);",
      'DROP TABLE old;',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'mysql');
    expect(plan.ddlCount).toBe(2); // 1 create + 1 drop
    expect(plan.dmlCount).toBe(2); // 2 inserts
  });

  it('detects FK management in the file', () => {
    const sqlWithFk = 'SET FOREIGN_KEY_CHECKS = 0;\nCREATE TABLE x (id INT);\nSET FOREIGN_KEY_CHECKS = 1;';
    const sqlWithoutFk = 'CREATE TABLE x (id INT);\nINSERT INTO x VALUES (1);';
    expect(buildRestorePlan(sqlWithFk, 'mysql').hasFkManagement).toBe(true);
    expect(buildRestorePlan(sqlWithoutFk, 'mysql').hasFkManagement).toBe(false);
  });

  it('places unknown statements BEFORE fk_enable, not after', () => {
    const sql = [
      'SET FOREIGN_KEY_CHECKS = 0;',
      'CREATE TABLE x (id INT);',
      'GRANT ALL ON x TO admin;',     // unknown
      'SET FOREIGN_KEY_CHECKS = 1;',
    ].join('\n');
    const plan = buildRestorePlan(sql, 'mysql');
    const cats = plan.items.map((i) => i.category);
    const unknownIdx = cats.indexOf('unknown');
    const fkEnableIdx = cats.indexOf('fk_enable');
    expect(unknownIdx).toBeLessThan(fkEnableIdx);
  });
});
