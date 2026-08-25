import { create } from 'zustand';

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  severity: ToastSeverity;
  title: string;
  message?: string;
  /** Optional action label + callback (e.g. "View", "Open Activity"). */
  actionLabel?: string;
  onAction?: () => void;
  createdAt: number;
  /** Skip the auto-dismiss timer — for long-running operations (e.g. update
   *  downloads) that must stay visible until explicitly updated/dismissed. */
  persistent?: boolean;
}

interface ToastState {
  toasts: Toast[];
  /** Returns the new toast's id so callers can later patch it via `update`. */
  push: (toast: Omit<Toast, 'id' | 'createdAt'>) => string;
  /** Patch an existing toast in place (e.g. to report progress) without
   *  restarting its auto-dismiss timer or losing its position in the stack. */
  update: (id: string, patch: Partial<Omit<Toast, 'id' | 'createdAt'>>) => void;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 4;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    set((state) => {
      const next = [...state.toasts, { ...toast, id, createdAt: Date.now() }];
      // Keep the stack bounded — drop the oldest.
      return { toasts: next.slice(-MAX_TOASTS) };
    });
    return id;
  },
  update: (id, patch) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience helper: dedup a notification by title within a short window so
 *  the same event doesn't spam the user. Tracks the last-fired time per key
 *  in a module-level map (good enough for in-session throttling). */
const lastFired = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000;

export function pushDedupedToast(
  key: string,
  toast: Omit<Toast, 'id' | 'createdAt'>,
  windowMs: number = DEDUP_WINDOW_MS
) {
  const now = Date.now();
  const last = lastFired.get(key);
  if (last != null && now - last < windowMs) return;
  lastFired.set(key, now);
  useToastStore.getState().push(toast);
}
