import { describe, it, expect } from 'vitest';
import {
  normalizePrefix,
  joinPrefix,
  displayName,
  buildBackupPath,
  sanitizeSegment,
  isWithinPrefix,
  assertWithinPrefix,
  StorageSafetyError,
} from '../paths';

describe('normalizePrefix', () => {
  it('returns empty string for empty/whitespace input', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix('   ')).toBe('');
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix(null)).toBe('');
  });

  it('strips a leading slash', () => {
    expect(normalizePrefix('/rdsql/')).toBe('rdsql/');
    expect(normalizePrefix('//rdsql/backups')).toBe('rdsql/backups/');
  });

  it('ensures a trailing slash', () => {
    expect(normalizePrefix('rdsql')).toBe('rdsql/');
    expect(normalizePrefix('rdsql/backups')).toBe('rdsql/backups/');
  });

  it('collapses repeated slashes', () => {
    expect(normalizePrefix('rdsql///backups//prod')).toBe('rdsql/backups/prod/');
  });

  it('handles bucket root as empty', () => {
    expect(normalizePrefix('/')).toBe('');
  });
});

describe('joinPrefix', () => {
  it('skips empty/null segments', () => {
    expect(joinPrefix('rdsql', '', null, undefined, 'backups')).toBe('rdsql/backups/');
  });

  it('produces normalized output', () => {
    expect(joinPrefix('/rdsql/', '/prod//x', 'mysql')).toBe('rdsql/prod/x/mysql/');
  });

  it('returns empty when all segments empty', () => {
    expect(joinPrefix('', null, undefined)).toBe('');
  });
});

describe('displayName', () => {
  it('strips the browse prefix and trailing slash for folders', () => {
    expect(displayName('rdsql/backups/prod/', 'rdsql/backups/')).toBe('prod');
  });

  it('returns the last segment for object keys', () => {
    expect(displayName('rdsql/backups/prod/backup.sql', 'rdsql/backups/prod/')).toBe('backup.sql');
  });

  it('works with an empty browse prefix', () => {
    expect(displayName('backup.sql', '')).toBe('backup.sql');
    expect(displayName('rdsql/', '')).toBe('rdsql');
  });

  it('returns the full relative name when nested under browse prefix', () => {
    expect(displayName('rdsql/backups/prod/sub/backup.sql', 'rdsql/')).toBe('backup.sql');
  });
});

describe('sanitizeSegment', () => {
  it('replaces unsafe characters with underscore', () => {
    expect(sanitizeSegment('my db!')).toBe('my_db');
    expect(sanitizeSegment('prod/data')).toBe('prod_data');
  });

  it('returns unknown for empty input', () => {
    expect(sanitizeSegment('')).toBe('unknown');
    expect(sanitizeSegment(null)).toBe('unknown');
  });

  it('keeps alphanumerics, dash, underscore, dot', () => {
    expect(sanitizeSegment('engine-1.0_beta')).toBe('engine-1.0_beta');
  });

  it('trims leading/trailing underscores', () => {
    expect(sanitizeSegment('  prod  ')).toBe('prod');
    expect(sanitizeSegment('!!!')).toBe('unknown');
  });
});

describe('buildBackupPath', () => {
  it('builds a deterministic path with date segments', () => {
    const date = new Date(Date.UTC(2026, 7, 9, 23, 0)); // 2026-08-09 23:00 UTC
    const key = buildBackupPath({
      prefix: 'rdsql/',
      environment: 'production',
      engine: 'mysql',
      database: 'shop',
      date,
    });
    expect(key).toBe('rdsql/production/mysql/shop/2026/08/09/backup-202608092300.sql');
  });

  it('appends .gz when compressed and no custom filename', () => {
    const date = new Date(Date.UTC(2026, 7, 9, 23, 5));
    const key = buildBackupPath({
      prefix: 'rdsql/',
      engine: 'postgres',
      database: 'db',
      date,
      compressed: true,
    });
    expect(key.endsWith('.sql.gz')).toBe(true);
    expect(key).toBe('rdsql/unknown/postgres/db/2026/08/09/backup-202608092305.sql.gz');
  });

  it('honors a custom filename without appending .gz', () => {
    const date = new Date(Date.UTC(2026, 7, 9, 23, 0));
    const key = buildBackupPath({
      prefix: 'rdsql',
      engine: 'mysql',
      database: 'db',
      date,
      filename: 'manual.sql.gz',
    });
    expect(key).toBe('rdsql/unknown/mysql/db/2026/08/09/manual.sql.gz');
  });

  it('works with an empty prefix (bucket root)', () => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0));
    const key = buildBackupPath({
      prefix: '',
      engine: 'mysql',
      database: 'db',
      date,
    });
    expect(key).toBe('unknown/mysql/db/2026/01/01/backup-202601010000.sql');
  });

  it('sanitizes unsafe segments', () => {
    const date = new Date(Date.UTC(2026, 7, 9, 23, 0));
    const key = buildBackupPath({
      prefix: 'rdsql/',
      environment: 'prod/us',
      engine: 'my engine',
      database: 'weird/name',
      date,
    });
    expect(key).toBe('rdsql/prod_us/my_engine/weird_name/2026/08/09/backup-202608092300.sql');
  });
});

describe('isWithinPrefix', () => {
  it('allows keys under the prefix', () => {
    expect(isWithinPrefix('rdsql/backups/x.sql', 'rdsql/')).toBe(true);
    expect(isWithinPrefix('rdsql/backups/x.sql', 'rdsql/backups/')).toBe(true);
  });

  it('rejects keys that merely share a string prefix', () => {
    // "rdsql-evil/" starts with "rdsql" as a substring but not as a prefix segment.
    expect(isWithinPrefix('rdsql-evil/x.sql', 'rdsql/')).toBe(false);
  });

  it('rejects keys outside the prefix', () => {
    expect(isWithinPrefix('other/x.sql', 'rdsql/')).toBe(false);
  });

  it('allows the prefix root key itself', () => {
    expect(isWithinPrefix('rdsql', 'rdsql/')).toBe(true);
  });

  it('treats empty prefix as full-bucket scope', () => {
    expect(isWithinPrefix('anything/x.sql', '')).toBe(true);
    expect(isWithinPrefix('whatever', '')).toBe(true);
  });
});

describe('assertWithinPrefix', () => {
  it('does not throw for keys within the prefix', () => {
    expect(() => assertWithinPrefix('rdsql/x', 'rdsql/')).not.toThrow();
  });

  it('throws a StorageSafetyError for keys outside the prefix', () => {
    expect(() => assertWithinPrefix('other/x', 'rdsql/')).toThrow(StorageSafetyError);
    try {
      assertWithinPrefix('other/x', 'rdsql/');
    } catch (e) {
      expect(e).toBeInstanceOf(StorageSafetyError);
      expect((e as StorageSafetyError).key).toBe('other/x');
    }
  });
});
