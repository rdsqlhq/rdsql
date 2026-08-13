import type { ConnectionTag } from './types';

/**
 * The four built-in tags. These ship out of the box and can be recolored, but
 * never deleted (so users always have a conventional starting set available).
 * Custom tags are added on top via the tag store.
 */
export const BUILTIN_TAGS: ConnectionTag[] = [
  { id: 'tag_production', label: 'Production', color: '#ef4444', builtin: true },
  { id: 'tag_staging', label: 'Staging', color: '#f59e0b', builtin: true },
  { id: 'tag_dev', label: 'Dev', color: '#3b82f6', builtin: true },
  { id: 'tag_local', label: 'Local', color: '#64748b', builtin: true },
];

/** A spread of pleasant preset colors offered in the new-tag color picker. */
export const TAG_COLOR_PRESETS: string[] = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#64748b', // slate
  '#f97316', // orange
];

/** Look up a tag by id in a list. Returns undefined for null/missing ids. */
export function getTagById(tags: ConnectionTag[], id?: string | null): ConnectionTag | undefined {
  if (!id) return undefined;
  return tags.find((t) => t.id === id);
}

/**
 * Convert a #RRGGBB hex color into an `rgba(r, g, b, alpha)` string. Used for
 * semi-transparent badge backgrounds and folder accents driven by a dynamic
 * hex (which can't be a static Tailwind class). Returns a safe slate fallback
 * for malformed input.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex?.trim?.() || '');
  if (!m) return `rgba(100, 116, 139, ${alpha})`; // slate-500 fallback
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Validate a candidate tag label: non-empty after trim, max 24 chars. */
export function isValidTagLabel(label: string): boolean {
  const t = label.trim();
  return t.length > 0 && t.length <= 24;
}

/**
 * Group connections by their tagId. Returns an ordered array of
 * `{ tag, connections }` folders (only tags that have ≥1 connection) plus a
 * final `untagged` bucket. Tags appear in the order of `tagOrder`; connections
 * within a folder preserve their original array order.
 */
export interface TagFolder {
  tag: ConnectionTag | null; // null = the "Other / untagged" bucket
  connections: { id: string; name: string }[];
}

export function groupByTag<T extends { tagId?: string | null }>(items: T[], tags: ConnectionTag[], tagOrder: string[] = []): TagFolder[] {
  const buckets = new Map<string, T[]>();
  const untagged: T[] = [];

  for (const item of items) {
    // A tagId that doesn't resolve to a real tag — deleted locally, or
    // imported from another device whose tag definitions never shipped with
    // the connection (tags live in a separate store from connections/backups)
    // — is treated as untagged rather than kept in its own bucket. Otherwise
    // it becomes an unreachable phantom folder below (see the `null`-tag
    // dedup note), silently hiding the connection from the Explorer.
    if (item.tagId && getTagById(tags, item.tagId)) {
      const arr = buckets.get(item.tagId);
      if (arr) arr.push(item);
      else buckets.set(item.tagId, [item]);
    } else {
      untagged.push(item);
    }
  }

  const folders: TagFolder[] = [];

  // Resolve order: tagOrder first (for known tags), then builtins, then any
  // remaining custom tags not in tagOrder. Every bucket key is guaranteed to
  // resolve to a real tag now, so `tag` is never null here.
  const seen = new Set<string>();
  const resolve = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const tag = getTagById(tags, id);
    const conns = buckets.get(id);
    if (tag && conns && conns.length > 0) {
      folders.push({ tag, connections: conns.map((c) => ({ id: (c as any).id, name: (c as any).name })) });
    }
  };

  // 1. explicit order
  for (const id of tagOrder) resolve(id);
  // 2. builtin tags (always render in canonical order if populated)
  for (const t of BUILTIN_TAGS) resolve(t.id);
  // 3. any remaining buckets (custom tags not in tagOrder)
  for (const id of Array.from(buckets.keys())) resolve(id);

  // 4. untagged bucket last — the single, unambiguous `tag: null` folder.
  if (untagged.length > 0) {
    folders.push({ tag: null, connections: untagged.map((c) => ({ id: (c as any).id, name: (c as any).name })) });
  }

  return folders;
}
