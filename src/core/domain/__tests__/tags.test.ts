import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TAGS,
  TAG_COLOR_PRESETS,
  getTagById,
  hexToRgba,
  isValidTagLabel,
  groupByTag,
} from '../tags';
import type { ConnectionTag } from '../types';

describe('BUILTIN_TAGS', () => {
  it('ships the four conventional environments', () => {
    const labels = BUILTIN_TAGS.map((t) => t.label);
    expect(labels).toEqual(['Production', 'Staging', 'Dev', 'Local']);
  });

  it('all builtins are marked builtin and have stable ids + hex colors', () => {
    for (const t of BUILTIN_TAGS) {
      expect(t.builtin).toBe(true);
      expect(t.id).toMatch(/^tag_/);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('has unique ids', () => {
    const ids = BUILTIN_TAGS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('TAG_COLOR_PRESETS', () => {
  it('contains only valid hex colors', () => {
    for (const c of TAG_COLOR_PRESETS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
  it('includes red, amber, blue, slate (the builtin palette)', () => {
    expect(TAG_COLOR_PRESETS).toContain('#ef4444');
    expect(TAG_COLOR_PRESETS).toContain('#f59e0b');
    expect(TAG_COLOR_PRESETS).toContain('#3b82f6');
    expect(TAG_COLOR_PRESETS).toContain('#64748b');
  });
});

describe('getTagById', () => {
  const tags: ConnectionTag[] = [
    ...BUILTIN_TAGS,
    { id: 'tag_custom_x', label: 'Sandbox', color: '#aabbcc' },
  ];

  it('finds a tag by id', () => {
    expect(getTagById(tags, 'tag_custom_x')?.label).toBe('Sandbox');
  });
  it('returns undefined for a missing id', () => {
    expect(getTagById(tags, 'tag_nope')).toBeUndefined();
  });
  it('treats null/undefined/empty as no tag', () => {
    expect(getTagById(tags, null)).toBeUndefined();
    expect(getTagById(tags, undefined)).toBeUndefined();
    expect(getTagById(tags, '')).toBeUndefined();
  });
});

describe('hexToRgba', () => {
  it('converts a 6-digit hex with alpha', () => {
    expect(hexToRgba('#ef4444', 0.15)).toBe('rgba(239, 68, 68, 0.15)');
    expect(hexToRgba('#3b82f6', 1)).toBe('rgba(59, 130, 246, 1)');
  });
  it('accepts hex without the leading #', () => {
    expect(hexToRgba('ffffff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });
  it('falls back to slate for malformed input', () => {
    expect(hexToRgba('notacolor', 0.2)).toBe('rgba(100, 116, 139, 0.2)');
    expect(hexToRgba('', 0.2)).toBe('rgba(100, 116, 139, 0.2)');
    expect(hexToRgba('#123', 0.2)).toBe('rgba(100, 116, 139, 0.2)'); // not 6 digits
  });
});

describe('isValidTagLabel', () => {
  it('accepts normal labels', () => {
    expect(isValidTagLabel('Production')).toBe(true);
    expect(isValidTagLabel('  spaced  ')).toBe(true); // trims
  });
  it('rejects empty / whitespace-only', () => {
    expect(isValidTagLabel('')).toBe(false);
    expect(isValidTagLabel('   ')).toBe(false);
  });
  it('rejects labels longer than 24 chars', () => {
    expect(isValidTagLabel('a'.repeat(24))).toBe(true);
    expect(isValidTagLabel('a'.repeat(25))).toBe(false);
  });
});

describe('groupByTag', () => {
  const tags: ConnectionTag[] = [
    ...BUILTIN_TAGS,
    { id: 'tag_custom', label: 'Sandbox', color: '#aabbcc' },
  ];
  type Item = { id: string; name: string; tagId?: string | null };

  it('groups items into tagged folders + a trailing untagged bucket', () => {
    const items: Item[] = [
      { id: 'a', name: 'A', tagId: 'tag_production' },
      { id: 'b', name: 'B', tagId: 'tag_dev' },
      { id: 'c', name: 'C', tagId: 'tag_production' },
      { id: 'd', name: 'D' }, // untagged
    ];
    const folders = groupByTag(items, tags);
    expect(folders.map((f) => f.tag?.label ?? 'Other')).toEqual(['Production', 'Dev', 'Other']);
    expect(folders[0].connections.map((c) => c.id)).toEqual(['a', 'c']);
    expect(folders[1].connections.map((c) => c.id)).toEqual(['b']);
    expect(folders[2].connections.map((c) => c.id)).toEqual(['d']);
  });

  it('hides empty tags (no zero-count folders)', () => {
    const items: Item[] = [{ id: 'a', name: 'A', tagId: 'tag_staging' }];
    const folders = groupByTag(items, tags);
    // Only Staging should appear; Production/Dev/Local/Sandbox have 0 connections.
    expect(folders.map((f) => f.tag?.label ?? 'Other')).toEqual(['Staging']);
  });

  it('omits the untagged bucket when every item is tagged', () => {
    const items: Item[] = [{ id: 'a', name: 'A', tagId: 'tag_dev' }];
    const folders = groupByTag(items, tags);
    expect(folders.some((f) => f.tag === null)).toBe(false);
  });

  it('puts untagged-only items into a single Other bucket', () => {
    const items: Item[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const folders = groupByTag(items, tags);
    expect(folders.length).toBe(1);
    expect(folders[0].tag).toBeNull();
    expect(folders[0].connections.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('respects explicit tagOrder', () => {
    const items: Item[] = [
      { id: 'a', name: 'A', tagId: 'tag_production' },
      { id: 'b', name: 'B', tagId: 'tag_dev' },
    ];
    const folders = groupByTag(items, tags, ['tag_dev', 'tag_production']);
    expect(folders.map((f) => f.tag?.label)).toEqual(['Dev', 'Production']);
  });

  it('folds a stale tagId (tag deleted, or imported without its tag def) into the untagged bucket', () => {
    const items: Item[] = [{ id: 'a', name: 'A', tagId: 'tag_gone' }];
    const folders = groupByTag(items, tags);
    expect(folders.length).toBe(1);
    expect(folders[0].tag).toBeNull();
    expect(folders[0].connections.map((c) => c.id)).toEqual(['a']);
  });

  it('merges a stale-tagId item with genuinely untagged items into ONE untagged bucket', () => {
    // Regression test: previously a stale tagId created its own separate
    // `tag: null` folder, and the Explorer's `.find(f => !f.tag)` only ever
    // rendered the FIRST such folder — silently hiding every connection in
    // whichever null-tag bucket lost the race (e.g. brand-new connections,
    // or S3 connections imported from another device without their tag def).
    const items: Item[] = [
      { id: 'a', name: 'A', tagId: 'tag_gone' }, // stale tag
      { id: 'b', name: 'B' }, // genuinely untagged
    ];
    const folders = groupByTag(items, tags);
    expect(folders.length).toBe(1);
    expect(folders[0].tag).toBeNull();
    expect(folders[0].connections.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
