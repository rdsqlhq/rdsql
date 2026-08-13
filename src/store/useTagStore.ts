import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ConnectionTag } from '../core/domain/types';
import { BUILTIN_TAGS } from '../core/domain/tags';

/**
 * Persisted store for environment/group tags + the folder expansion state used
 * by the Explorer sidebar.
 *
 * Only `tags` and `collapsedUntagged` are persisted; `expandedFolders` is a
 * plain array on disk (Sets aren't JSON-serializable) but exposed as a Set at
 * runtime via `partialize`/`onRehydrateStorage`.
 */
interface TagState {
  tags: ConnectionTag[];
  /** tag ids whose folder is expanded (ephemeral — not persisted). */
  expandedFolders: Set<string>;
  /** whether the "Other" (untagged) folder is collapsed. Persisted. */
  collapsedUntagged: boolean;
  /** Display order of tag folders (ids). Persisted so the user's arrangement sticks. */
  tagOrder: string[];

  addTag: (label: string, color: string) => ConnectionTag;
  updateTag: (id: string, patch: Partial<Pick<ConnectionTag, 'label' | 'color'>>) => void;
  deleteTag: (id: string) => void;
  toggleFolder: (tagId: string) => void;
  setFolderExpanded: (tagId: string, expanded: boolean) => void;
  setCollapsedUntagged: (v: boolean) => void;
}

export const useTagStore = create<TagState>()(
  persist(
    (set, get) => ({
      tags: [...BUILTIN_TAGS],
      expandedFolders: new Set<string>(),
      collapsedUntagged: false,
      tagOrder: BUILTIN_TAGS.map((t) => t.id),

      addTag: (label, color) => {
        const trimmed = label.trim();
        const tag: ConnectionTag = {
          id: `tag_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          label: trimmed,
          color,
        };
        set((state) => ({ tags: [...state.tags, tag], tagOrder: [...state.tagOrder, tag.id] }));
        return tag;
      },

      updateTag: (id, patch) => {
        set((state) => ({
          tags: state.tags.map((t) =>
            t.id === id
              ? {
                  ...t,
                  // Builtins keep their name locked (you can recolor them).
                  label: t.builtin ? t.label : patch.label ?? t.label,
                  color: patch.color ?? t.color,
                }
              : t
          ),
        }));
      },

      deleteTag: (id) => {
        const tag = get().tags.find((t) => t.id === id);
        if (!tag || tag.builtin) return; // builtins are undeletable
        set((state) => ({
          tags: state.tags.filter((t) => t.id !== id),
          tagOrder: state.tagOrder.filter((tid) => tid !== id),
        }));
      },

      toggleFolder: (tagId) => {
        set((state) => {
          const next = new Set(state.expandedFolders);
          if (next.has(tagId)) next.delete(tagId);
          else next.add(tagId);
          return { expandedFolders: next };
        });
      },

      setFolderExpanded: (tagId, expanded) => {
        set((state) => {
          const next = new Set(state.expandedFolders);
          if (expanded) next.add(tagId);
          else next.delete(tagId);
          return { expandedFolders: next };
        });
      },

      setCollapsedUntagged: (v) => set({ collapsedUntagged: v }),
    }),
    {
      name: 'rdsql_tags_v1',
      storage: createJSONStorage(() => localStorage),
      // Only persist serializable fields; the Set is ephemeral and rebuilt as
      // "all collapsed" on each load, which is the least surprising default.
      partialize: (state) => ({
        tags: state.tags,
        collapsedUntagged: state.collapsedUntagged,
        tagOrder: state.tagOrder,
      }),
      // Ensure builtins always exist even if an older/partial state was persisted
      // (e.g. a new builtin was added in a release).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<TagState>;
        const persistedTags = p.tags ?? [];
        const ids = new Set(persistedTags.map((t) => t.id));
        const ensured = [...persistedTags];
        for (const b of BUILTIN_TAGS) {
          if (!ids.has(b.id)) ensured.push(b);
        }
        return {
          ...current,
          ...p,
          tags: ensured,
          expandedFolders: new Set<string>(),
          tagOrder: p.tagOrder ?? BUILTIN_TAGS.map((t) => t.id),
        };
      },
    }
  )
);
