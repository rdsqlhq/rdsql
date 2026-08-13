import { useCallback, useMemo, useState } from 'react';
import { SchemaGraphModel } from '../../core/erd/types';
import { bfsLevels } from '../../core/erd/neighborhood';

export interface UseFocusGraphResult {
  rootId: string | null;
  expandedIds: Set<string>;
  visibleIds: Set<string>;
  showAll: boolean;
  setRoot: (id: string) => void;
  setDepth: (depth: 1 | 2 | 3) => void;
  toggleExpand: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  setShowAll: (value: boolean) => void;
}

/**
 * Focus Mode + progressive expansion state, decoupled from rendering.
 *
 * Model: `rootId` is the pinned center of the diagram. `expandedIds` is the
 * set of tables the user has "opened" — each one reveals its direct
 * neighbors. Visible tables = root + expanded tables + their neighbors.
 * Depth presets (1/2/3) are just a shortcut that pre-computes `expandedIds`
 * via BFS instead of requiring N manual clicks.
 */
export function useFocusGraph(graph: SchemaGraphModel, initialRootId?: string | null): UseFocusGraphResult {
  const [rootId, setRootId] = useState<string | null>(initialRootId ?? null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(initialRootId ? [initialRootId] : [])
  );
  const [showAll, setShowAll] = useState(false);

  const setRoot = useCallback((id: string) => {
    setRootId(id);
    setExpandedIds(new Set([id]));
    setShowAll(false);
  }, []);

  const setDepth = useCallback(
    (depth: 1 | 2 | 3) => {
      if (!rootId) return;
      const levels = bfsLevels(graph, [rootId]);
      const next = new Set<string>([rootId]);
      levels.forEach((lvl, name) => {
        if (lvl <= depth - 1) next.add(name);
      });
      setExpandedIds(next);
      setShowAll(false);
    },
    [graph, rootId]
  );

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setShowAll(false);
  }, []);

  const expandAll = useCallback(() => {
    setExpandedIds(new Set(graph.tableNames));
    setShowAll(false);
  }, [graph]);

  const collapseAll = useCallback(() => {
    setExpandedIds(new Set(rootId ? [rootId] : []));
    setShowAll(false);
  }, [rootId]);

  const visibleIds = useMemo(() => {
    if (showAll) return new Set(graph.tableNames);
    const visible = new Set<string>();
    if (rootId) visible.add(rootId);
    expandedIds.forEach((id) => {
      visible.add(id);
      (graph.adjacency.get(id) || new Set()).forEach((n) => visible.add(n));
    });
    return visible;
  }, [graph, rootId, expandedIds, showAll]);

  return {
    rootId,
    expandedIds,
    visibleIds,
    showAll,
    setRoot,
    setDepth,
    toggleExpand,
    expandAll,
    collapseAll,
    setShowAll,
  };
}
