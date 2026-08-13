import { describe, it, expect } from 'vitest';
import {
  PRESIGN_EXPIRY_OPTIONS,
  PRESIGN_MAX_SECS,
  PRESIGN_DEFAULT_SECS,
  formatExpiry,
} from '../presign';

describe('PRESIGN_EXPIRY_OPTIONS', () => {
  it('offers 4 presets sorted shortest to longest', () => {
    expect(PRESIGN_EXPIRY_OPTIONS).toHaveLength(4);
    const secs = PRESIGN_EXPIRY_OPTIONS.map((o) => o.secs);
    expect(secs).toEqual([...secs].sort((a, b) => a - b));
  });

  it('never exceeds the 7-day S3 maximum', () => {
    for (const o of PRESIGN_EXPIRY_OPTIONS) {
      expect(o.secs).toBeLessThanOrEqual(PRESIGN_MAX_SECS);
    }
  });

  it('includes the default (1 hour) as an option', () => {
    expect(PRESIGN_EXPIRY_OPTIONS.some((o) => o.secs === PRESIGN_DEFAULT_SECS)).toBe(true);
  });
});

describe('formatExpiry', () => {
  it('matches a preset label', () => {
    expect(formatExpiry(3600)).toBe('1 hour');
    expect(formatExpiry(604_800)).toBe('7 days');
  });

  it('formats custom hour/day values', () => {
    expect(formatExpiry(7200)).toBe('2 hour(s)');
    expect(formatExpiry(172_800)).toBe('2 day(s)');
  });

  it('falls back to raw seconds for non-round values', () => {
    expect(formatExpiry(90)).toBe('90s');
  });
});
