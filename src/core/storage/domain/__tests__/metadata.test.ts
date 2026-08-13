import { describe, it, expect } from 'vitest';
import {
  serializeMetadata,
  parseMetadata,
  metadataKeyFor,
  isMetadataKey,
  backupKeyForMetadata,
  METADATA_SUFFIX,
} from '../metadata';
import type { BackupMetadata } from '../types';

const base: BackupMetadata = {
  version: 1,
  type: 'database-backup',
  engine: 'mysql',
  database: 'shop',
  connectionName: 'prod',
  createdAt: '2026-08-09T23:00:00.000Z',
  compression: 'gzip',
  encryption: 'none',
  size: 123456789,
  checksum: 'abc123',
  rdsqlVersion: '1.0.0',
};

describe('serializeMetadata', () => {
  it('produces valid JSON with version 1', () => {
    const s = serializeMetadata(base);
    const parsed = JSON.parse(s);
    expect(parsed.version).toBe(1);
    expect(parsed.type).toBe('database-backup');
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      serializeMetadata({ ...base, version: 99 as BackupMetadata['version'] }),
    ).toThrow(/Unsupported backup metadata version/);
  });

  it('never includes a credentials-shaped field', () => {
    const s = serializeMetadata(base);
    expect(s).not.toMatch(/secret|password|token|accessKey/i);
  });
});

describe('parseMetadata', () => {
  it('round-trips through serialize', () => {
    const s = serializeMetadata(base);
    expect(parseMetadata(s)).toEqual(base);
  });

  it('returns null for empty input', () => {
    expect(parseMetadata('')).toBeNull();
    expect(parseMetadata('   ')).toBeNull();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseMetadata('{not json')).toThrow();
  });

  it('throws on unsupported version', () => {
    const bad = JSON.stringify({ ...base, version: 2 });
    expect(() => parseMetadata(bad)).toThrow(/Unsupported backup metadata version/);
  });

  it('throws on unexpected type', () => {
    const bad = JSON.stringify({ ...base, type: 'something-else' });
    expect(() => parseMetadata(bad)).toThrow(/Unexpected metadata type/);
  });
});

describe('metadata key helpers', () => {
  it('metadataKeyFor appends the suffix', () => {
    expect(metadataKeyFor('rdsql/x/backup.sql.gz')).toBe(
      `rdsql/x/backup.sql.gz${METADATA_SUFFIX}`,
    );
  });

  it('isMetadataKey detects sidecars', () => {
    expect(isMetadataKey('x.sql.gz.meta.json')).toBe(true);
    expect(isMetadataKey('x.sql.gz')).toBe(false);
  });

  it('backupKeyForMetadata strips the suffix', () => {
    expect(backupKeyForMetadata('rdsql/x.sql.gz.meta.json')).toBe('rdsql/x.sql.gz');
  });

  it('backupKeyForMetadata passes through non-metadata keys unchanged', () => {
    expect(backupKeyForMetadata('rdsql/x.sql.gz')).toBe('rdsql/x.sql.gz');
  });
});
