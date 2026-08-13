import { describe, it, expect } from 'vitest';
import { parseEnvOrUrl, parseConnectionUrl } from '../envImport';

describe('parseEnvOrUrl', () => {
  it('parses a bare postgres:// URL', () => {
    const out = parseEnvOrUrl('postgres://alice:s3cr3t@db.example.com:5432/appdb');
    expect(out.engine).toBe('postgres');
    expect(out.host).toBe('db.example.com');
    expect(out.port).toBe(5432);
    expect(out.username).toBe('alice');
    expect(out.password).toBe('s3cr3t');
    expect(out.database).toBe('appdb');
    expect(out.appliedKeys).toContain('host');
  });

  it('parses a mysql:// URL with default port fallback', () => {
    const out = parseConnectionUrl('mysql://root@localhost/corp');
    expect(out.engine).toBe('mysql');
    expect(out.host).toBe('localhost');
    expect(out.port).toBe(3306);
    expect(out.username).toBe('root');
    expect(out.database).toBe('corp');
  });

  it('parses Laravel-style DB_* keys and maps DB_CONNECTION', () => {
    const env = `
      APP_NAME=Laravel
      DB_CONNECTION=pgsql
      DB_HOST=127.0.0.1
      DB_PORT=5432
      DB_DATABASE=forge
      DB_USERNAME=forge
      DB_PASSWORD=secret
    `;
    const out = parseEnvOrUrl(env);
    expect(out.engine).toBe('postgres');
    expect(out.host).toBe('127.0.0.1');
    expect(out.port).toBe(5432);
    expect(out.database).toBe('forge');
    expect(out.username).toBe('forge');
    expect(out.password).toBe('secret');
  });

  it('handles export prefix, comments, and surrounding quotes', () => {
    const env = `
      # database config
      export DB_HOST="db.local"
      DB_PASSWORD='pa$$ word'
      DB_PORT=6543 # inline comment
    `;
    const out = parseEnvOrUrl(env);
    expect(out.host).toBe('db.local');
    expect(out.password).toBe('pa$$ word');
    expect(out.port).toBe(6543);
  });

  it('parses DATABASE_URL= line inside an env blob', () => {
    const env = `
      APP_ENV=production
      DATABASE_URL=postgres://u:p@10.0.0.5:5432/prod
    `;
    const out = parseEnvOrUrl(env);
    expect(out.engine).toBe('postgres');
    expect(out.host).toBe('10.0.0.5');
    expect(out.database).toBe('prod');
    expect(out.username).toBe('u');
    expect(out.password).toBe('p');
  });

  it('returns empty appliedKeys for blank / garbage input', () => {
    expect(parseEnvOrUrl('').appliedKeys).toEqual([]);
    expect(parseEnvOrUrl('   \n# just a comment\n').appliedKeys).toEqual([]);
  });

  it('ignores malformed port values', () => {
    const out = parseEnvOrUrl('DB_PORT=not-a-number\nDB_HOST=h');
    expect(out.port).toBeUndefined();
    expect(out.host).toBe('h');
  });
});
