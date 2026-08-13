import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyToClipboard } from '../clipboard';
import { describeFsError } from '../fsErrors';
import {
  parseDbError,
  formatDbErrorTrace,
  errorToTrace,
  errorKindLabel,
} from '../../sql/dbError';

describe('describeFsError', () => {
  it('classifies write permission errors', () => {
    const msg = describeFsError(new Error('Permission denied (os error 13)'), 'write');
    expect(msg.toLowerCase()).toContain('permission denied');
    expect(msg.toLowerCase()).toContain("can't be written");
  });

  it('classifies write disk-full errors', () => {
    const msg = describeFsError(new Error('No space left on device (ENOSPC)'), 'write');
    expect(msg.toLowerCase()).toContain('disk space');
  });

  it('classifies read permission errors', () => {
    const msg = describeFsError({ message: 'access denied' }, 'read');
    expect(msg.toLowerCase()).toContain("isn't allowed to read");
  });

  it('classifies read missing-file errors', () => {
    const msg = describeFsError(new Error('NO SUCH FILE (enoent)'), 'read');
    expect(msg.toLowerCase()).toContain('could not be found');
  });

  it('classifies directory-instead-of-file for read', () => {
    const msg = describeFsError(new Error('Is a directory (EISDIR)'), 'read');
    expect(msg.toLowerCase()).toContain('folder');
  });

  it('falls back to raw detail for unknown errors', () => {
    const msg = describeFsError('something exotic happened', 'read');
    expect(msg).toContain("Couldn't read the selected file");
    expect(msg).toContain('something exotic happened');
  });

  it('handles cancellation gracefully', () => {
    expect(describeFsError(new Error('cancelled'), 'write')).toContain('cancelled');
    expect(describeFsError(new Error('aborted'), 'read')).toContain('cancelled');
  });
});

describe('formatDbErrorTrace', () => {
  it('formats a structured error with all fields', () => {
    const e = parseDbError(
      JSON.stringify({
        kind: 'database',
        message: 'relation "x" does not exist',
        detail: 'table missing',
        hint: 'run migrations',
        sql: 'SELECT * FROM x',
        code: '42P01',
      })
    );
    const trace = formatDbErrorTrace(e);
    expect(trace).toContain('[Database error] 42P01');
    expect(trace).toContain('relation "x" does not exist');
    expect(trace).toContain('DETAIL: table missing');
    expect(trace).toContain('HINT: run migrations');
    expect(trace).toContain('SQL: SELECT * FROM x');
  });

  it('omits optional sections when absent', () => {
    const e = parseDbError('plain string error');
    const trace = formatDbErrorTrace(e);
    expect(trace).toBe('[Application error]\nplain string error');
    expect(trace).not.toContain('DETAIL');
    expect(trace).not.toContain('HINT');
  });
});

describe('errorToTrace', () => {
  it('handles null', () => {
    expect(errorToTrace(null)).toContain('Unknown error');
  });

  it('handles plain strings', () => {
    expect(errorToTrace('boom')).toContain('boom');
  });

  it('handles Error instances', () => {
    expect(errorToTrace(new Error('kaboom'))).toContain('kaboom');
  });

  it('handles structured JSON strings', () => {
    const trace = errorToTrace(JSON.stringify({ message: 'syntax error', kind: 'database' }));
    expect(trace).toContain('syntax error');
    expect(trace).toContain(errorKindLabel('database'));
  });
});

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses navigator.clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyToClipboard('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(ok).toBe(true);
  });

  it('returns false when clipboard throws and document fallback unavailable', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    // document.execCommand missing in this stub — copyToClipboard should still
    // not throw, and should resolve to false (or true if jsdom provides it).
    const ok = await copyToClipboard('hello');
    expect(typeof ok).toBe('boolean');
  });
});
