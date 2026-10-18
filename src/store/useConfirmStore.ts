import { create } from 'zustand';

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: 'danger' | 'warning' | 'default';
}

interface ConfirmState {
  pending: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  ask: (req: ConfirmRequest) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

/** Backs `confirmAsync`: one in-app confirmation at a time, rendered by
 *  <ConfirmHost />. */
export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  ask: (req) =>
    new Promise<boolean>((resolve) => {
      get().pending?.resolve(false);
      set({ pending: { ...req, resolve } });
    }),
  settle: (ok) => {
    const p = get().pending;
    set({ pending: null });
    p?.resolve(ok);
  },
}));

/** In-app replacement for `window.confirm()`, using the shared ConfirmDialog. */
export const confirmAsync = (req: ConfirmRequest) => useConfirmStore.getState().ask(req);
