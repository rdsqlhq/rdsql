/**
 * React bindings + the real Tauri-backed IPC adapter for the TransferManager.
 *
 * `useTransferManager` is a singleton-scoped hook: there is one TransferManager
 * for the app (transfers are global — the UI shows them in a global queue), so
 * every component shares the same instance and sees the same live state.
 */
import { useSyncExternalStore } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { safeInvoke } from '../tauri/ipc';
import { TransferManager, type TransferIpc } from './transferEngine';

/** Tauri-backed IPC adapter for the TransferManager. Routes invoke calls
 *  through `safeInvoke` (so they get `__meta` peeling + logging) and turns
 *  Tauri `listen` into the simple `on(eventName, handler) => unsubscribe`
 *  shape the manager expects. Falls back to no-op subscriptions when not in
 *  the Tauri runtime (browser preview) so the manager is still usable. */
const tauriIpc: TransferIpc = {
  invoke(command, args) {
    return safeInvoke<unknown>(command, args);
  },
  on(eventName, handler) {
    // Not in Tauri (browser preview): no real events arrive, so return a noop.
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return () => {};
    }
    let unlisten: UnlistenFn | null = null;
    let active = true;
    listen(eventName, (e) => handler(e.payload)).then((u) => {
      if (!active) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

/** Singleton manager instance — transfers are global to the app. */
let manager: TransferManager | null = null;
export function getTransferManager(): TransferManager {
  if (!manager) manager = new TransferManager(tauriIpc);
  return manager;
}

/** React hook returning a live snapshot of all transfers. Re-renders on every
 *  task-list change (progress ticks, completion, cancellation). */
export function useTransferManager(): TransferManager {
  const m = getTransferManager();
  useSyncExternalStore(
    (cb) => m.subscribe(cb),
    () => m.snapshot(), // snapshot identity changes via sort/copy each emit
  );
  // The hook returns the manager itself; components read `manager.snapshot()`
  // during render (the subscription above triggers re-render on changes).
  return m;
}

/** Convenience hook for components that only need to know if any transfer is
 *  currently active (for a global indicator). */
export function useActiveTransferCount(): number {
  const m = getTransferManager();
  const snapshot = useSyncExternalStore(
    (cb) => m.subscribe(cb),
    () => m.snapshot(),
  );
  // Recompute on each render; the subscription drives re-renders.
  return snapshot.filter(
    (t) => t.status === 'active' || t.status === 'preparing' || t.status === 'retrying',
  ).length;
}

/** For tests only — inject a fresh manager bound to a custom IPC adapter. */
export function __resetTransferManagerForTests(): void {
  manager = null;
}
