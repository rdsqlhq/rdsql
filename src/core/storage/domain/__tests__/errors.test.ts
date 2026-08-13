import { describe, it, expect } from 'vitest';
import { toStorageError, scrub, isCredentialError } from '../errors';
import type { StorageError } from '../types';

describe('toStorageError', () => {
  it('parses a JSON-serialized StorageError from Rust', () => {
    const payload = JSON.stringify({
      kind: 'auth',
      message: 'The AWS Access Key Id you provided does not exist.',
      hint: 'Check the access key id and secret.',
    });
    const err = toStorageError(new Error(payload));
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('Access Key Id');
    expect(err.hint).toBeDefined();
  });

  it('classifies a timeout string heuristically', () => {
    const err = toStorageError('request timed out after 30s');
    expect(err.kind).toBe('timeout');
  });

  it('classifies a network string heuristically', () => {
    const err = toStorageError('dns lookup failed: connection refused');
    expect(err.kind).toBe('network');
  });

  it('classifies a not-found string heuristically', () => {
    const err = toStorageError('NoSuchKey: The specified key does not exist (404)');
    expect(err.kind).toBe('notFound');
  });

  it('scrubs AWS access key ids from the message', () => {
    const err = toStorageError('bad key AKIAIOSFODNN7EXAMPLE somewhere');
    expect(err.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(err.message).toMatch(/AKIA••••/);
  });

  it('returns unknown for falsy input', () => {
    const err = toStorageError(undefined);
    expect(err.kind).toBe('unknown');
  });

  it('normalizes an unknown JSON kind to "unknown"', () => {
    const payload = JSON.stringify({ kind: 'not-a-real-kind', message: 'x' });
    const err = toStorageError(payload);
    expect(err.kind).toBe('unknown');
  });
});

describe('scrub', () => {
  it('redacts long base64/hex runs', () => {
    const secret = 'a'.repeat(48);
    expect(scrub(`token=${secret}`)).toBe('token=••••');
  });

  it('redacts authorization header values', () => {
    expect(scrub('authorization: Bearer abc.def.ghi')).toBe('authorization: ••••');
  });
});

describe('isCredentialError', () => {
  it('is true for auth and authorization kinds', () => {
    const auth: StorageError = { kind: 'auth', message: 'x' };
    const az: StorageError = { kind: 'authorization', message: 'x' };
    const net: StorageError = { kind: 'network', message: 'x' };
    expect(isCredentialError(auth)).toBe(true);
    expect(isCredentialError(az)).toBe(true);
    expect(isCredentialError(net)).toBe(false);
  });
});
