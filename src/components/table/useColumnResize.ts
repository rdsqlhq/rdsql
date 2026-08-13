import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Column-resize support for the data grids. Keeps a per-column-name width map
 * in state and exposes a pointer-based drag handler for the resize handle in
 * each header `<th>`.
 *
 * Lifecycle:
 *   1. On first data render the table uses `table-auto` so the browser sizes
 *      each column to fit its content.
 *   2. `lockWidths(widthMap)` is called once (after the first rows are painted)
 *      to snapshot the auto-fit widths. This freezes the columns so scrolling
 *      (which mounts/unmounts virtualized rows) can't shift them.
 *   3. After that the user can drag a handle to override any column; those
 *      manual widths take precedence and persist.
 *
 * Persistence: when `storageKey` is provided, the width map is saved to
 * `localStorage` and restored on mount — so a user's column widths survive
 * page/table switches and app restarts.
 */

export const DEFAULT_COL_WIDTH = 160;
export const MIN_COL_WIDTH = 60;
/** Columns never exceed this width — wider is visually noisy and wastes space.
 *  Oversized content truncates with an ellipsis (…). */
export const MAX_COL_WIDTH = 360;

/** Clamp a width to the [MIN, MAX] range (used by the initial auto-fit
 *  snapshot so the first paint doesn't produce absurdly wide columns). */
function clampWidth(w: number): number {
  return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w)));
}

/** Apply only the minimum (used by manual drag + double-click auto-fit, where
 *  the user explicitly wants the chosen/content width — no upper cap). */
function clampMin(w: number): number {
  return Math.max(MIN_COL_WIDTH, Math.round(w));
}

const WIDTHS_KEY = (k: string) => `rdsql_col_widths_${k}`;

function loadWidths(key: string): Map<string, number> {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY(key));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, number>;
    // Clamp to min on load so a stale/invalid value isn't absurdly small;
    // keep large widths as-is (the user set them deliberately).
    const m = new Map<string, number>();
    Object.entries(obj).forEach(([k, v]) => { if (v > 0) m.set(k, clampMin(v)); });
    return m;
  } catch {
    return new Map();
  }
}

function saveWidths(key: string, m: Map<string, number>) {
  try {
    const obj: Record<string, number> = {};
    m.forEach((v, k) => { obj[k] = v; });
    localStorage.setItem(WIDTHS_KEY(key), JSON.stringify(obj));
  } catch {
    // Best-effort — storage may be full or unavailable.
  }
}

export function useColumnResize(
  storageKey?: string,
  /** Optional: measure the ideal (content-fit) width for a column, in px.
   *  Used by double-click-on-handle to auto-fit a single column. When not
   *  provided, double-click falls back to a reset-to-default. */
  measureColumn?: (name: string) => number | null,
) {
  // Restore persisted widths on first mount (if a storage key is given).
  const [widths, setWidths] = useState<Map<string, number>>(() =>
    storageKey ? loadWidths(storageKey) : new Map(),
  );
  const [locked, setLocked] = useState(false);
  const dragRef = useRef<{ name: string; startX: number; startW: number } | null>(null);

  // Persist whenever widths change (debounced via microtask is unnecessary —
  // the map only changes on drag-end-ish frequency).
  useEffect(() => {
    if (!storageKey) return;
    saveWidths(storageKey, widths);
  }, [storageKey, widths]);

  /** Snapshot a set of auto-fit widths (name → px) and freeze layout. Called
   *  once after the first data render; ignored if widths were restored from
   *  storage or set manually (in which case layout is already fixed). */
  const lockWidths = useCallback((widthMap: Map<string, number>) => {
    setWidths((prev) => {
      // Keep restored/manually-set widths; only fill in columns that have no
      // width yet (so an auto-fit snapshot completes the set without
      // overriding user preferences). Clamp every value to [MIN, MAX].
      const merged = new Map(prev);
      widthMap.forEach((v, k) => {
        if (!merged.has(k)) merged.set(k, clampWidth(v));
      });
      return merged;
    });
    setLocked(true);
  }, []);

  const startResize = useCallback(
    (name: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const th = (e.currentTarget as HTMLElement).closest('th') as HTMLTableCellElement | null;
      const startW = th?.offsetWidth ?? widths.get(name) ?? DEFAULT_COL_WIDTH;
      dragRef.current = { name, startX: e.clientX, startW };

      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        // Manual drag: only enforce the minimum — the user controls the upper
        // bound (no MAX cap).
        const nextW = clampMin(d.startW + (ev.clientX - d.startX));
        setWidths((prev) => {
          const next = new Map(prev);
          next.set(d.name, nextW);
          return next;
        });
      };
      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [widths],
  );

  /** Clear all custom widths (reset to default sizing) and unlock. */
  const resetWidths = useCallback(() => {
    setWidths(new Map());
    setLocked(false);
  }, []);

  /** Auto-fit a single column to its content width (double-click on handle).
   *  Uses the `measureColumn` callback if provided; otherwise resets to the
   *  default width. Only the minimum is enforced — content can be as wide as
   *  it needs to be. */
  const autoFitColumn = useCallback(
    (name: string) => {
      const measured = measureColumn?.(name);
      const w = clampMin(measured && measured > 0 ? measured : DEFAULT_COL_WIDTH);
      setWidths((prev) => {
        const next = new Map(prev);
        next.set(name, w);
        return next;
      });
      setLocked(true);
    },
    [measureColumn],
  );

  /** If widths were restored from storage, start in fixed layout immediately. */
  const isLocked = locked || widths.size > 0;

  return { widths, startResize, resetWidths, lockWidths, autoFitColumn, isLocked };
}
