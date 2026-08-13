import { describe, it, expect } from 'vitest';
import { evaluateRetention, isRetentionActive } from '../retention';
import type { StorageObject, RetentionPolicy } from '../types';

function obj(key: string, lastModified: string, size = 100): StorageObject {
  return { key, name: key, size, lastModified };
}

describe('isRetentionActive', () => {
  it('is false for an empty policy', () => {
    expect(isRetentionActive({})).toBe(false);
    expect(isRetentionActive({ keepLast: 0, keepDaily: 0 })).toBe(false);
  });

  it('is true when any arm is set', () => {
    expect(isRetentionActive({ keepLast: 5 })).toBe(true);
    expect(isRetentionActive({ keepMonthly: 3 })).toBe(true);
  });
});

describe('evaluateRetention — keepLast', () => {
  it('keeps the N newest and marks the rest for deletion', () => {
    const objects = [
      obj('a', '2026-08-01T00:00:00Z'),
      obj('b', '2026-08-02T00:00:00Z'),
      obj('c', '2026-08-03T00:00:00Z'),
      obj('d', '2026-08-04T00:00:00Z'),
    ];
    const { keep, delete: del } = evaluateRetention(objects, { keepLast: 2 });
    expect(keep.map((o) => o.key)).toEqual(['d', 'c']);
    expect(del.map((o) => o.key)).toEqual(['b', 'a']);
  });

  it('keeps everything when N >= count', () => {
    const objects = [
      obj('a', '2026-08-01T00:00:00Z'),
      obj('b', '2026-08-02T00:00:00Z'),
    ];
    const { keep, delete: del } = evaluateRetention(objects, { keepLast: 10 });
    expect(keep).toHaveLength(2);
    expect(del).toHaveLength(0);
  });
});

describe('evaluateRetention — keepDaily', () => {
  it('keeps the newest object per day for the N most recent days', () => {
    const objects = [
      obj('d1a', '2026-08-01T01:00:00Z'),
      obj('d1b', '2026-08-01T23:00:00Z'), // newer of day 1
      obj('d2', '2026-08-02T05:00:00Z'),
      obj('d3', '2026-08-03T05:00:00Z'),
    ];
    const { keep, delete: del } = evaluateRetention(objects, { keepDaily: 2 });
    // Two most recent days = day 3 and day 2; newest of each kept.
    expect(keep.map((o) => o.key).sort()).toEqual(['d2', 'd3']);
    expect(del.map((o) => o.key).sort()).toEqual(['d1a', 'd1b']);
  });
});

describe('evaluateRetention — keepMonthly', () => {
  it('keeps the newest object per calendar month', () => {
    const objects = [
      obj('jul1', '2026-07-01T00:00:00Z'),
      obj('jul2', '2026-07-15T00:00:00Z'),
      obj('aug1', '2026-08-01T00:00:00Z'),
    ];
    const { keep } = evaluateRetention(objects, { keepMonthly: 1 });
    // Most recent month = August.
    expect(keep.map((o) => o.key)).toEqual(['aug1']);
  });
});

describe('evaluateRetention — keepWeekly', () => {
  it('keeps one object per ISO week', () => {
    // 2026-08-03 is a Monday; 2026-08-05 same week; 2026-08-10 next week.
    const objects = [
      obj('w1a', '2026-08-03T00:00:00Z'),
      obj('w1b', '2026-08-05T00:00:00Z'),
      obj('w2', '2026-08-10T00:00:00Z'),
    ];
    const { keep } = evaluateRetention(objects, { keepWeekly: 2 });
    expect(keep.map((o) => o.key).sort()).toEqual(['w1b', 'w2']);
  });
});

describe('evaluateRetention — combined', () => {
  it('unions keep sets across arms', () => {
    const objects = [
      obj('d1', '2026-08-01T00:00:00Z'),
      obj('d2', '2026-08-02T00:00:00Z'),
      obj('d3', '2026-08-03T00:00:00Z'),
      obj('d4', '2026-08-04T00:00:00Z'),
    ];
    // keepLast 1 keeps the single newest; keepDaily 2 keeps the newest of the
    // two most recent days. Union = {d4, d3}. (d4 is newest of day 4; d3 newest
    // of day 3.)
    const { keep, delete: del } = evaluateRetention(objects, { keepLast: 1, keepDaily: 2 });
    expect(keep.map((o) => o.key).sort()).toEqual(['d3', 'd4']);
    expect(del.map((o) => o.key).sort()).toEqual(['d1', 'd2']);
  });
});

describe('evaluateRetention — empty policy', () => {
  it('keeps everything when the policy is empty', () => {
    const objects = [
      obj('a', '2026-08-01T00:00:00Z'),
      obj('b', '2026-08-02T00:00:00Z'),
    ];
    const policy: RetentionPolicy = {};
    const { keep, delete: del } = evaluateRetention(objects, policy);
    expect(keep).toHaveLength(2);
    expect(del).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const objects = [
      obj('a', '2026-08-01T00:00:00Z'),
      obj('b', '2026-08-02T00:00:00Z'),
    ];
    const snapshot = objects.map((o) => o.key);
    evaluateRetention(objects, { keepLast: 1 });
    expect(objects.map((o) => o.key)).toEqual(snapshot);
  });
});

describe('evaluateRetention — bad dates', () => {
  it('treats objects with unparseable dates as oldest', () => {
    const objects = [
      obj('bad', 'not-a-date'),
      obj('good', '2026-08-09T00:00:00Z'),
    ];
    const { delete: del } = evaluateRetention(objects, { keepLast: 1 });
    expect(del.map((o) => o.key)).toEqual(['bad']);
  });
});
