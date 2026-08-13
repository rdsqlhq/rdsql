import { useAuthStore } from '../../store/useAuthStore';

export type AppEdition = 'pro' | 'community';

/** Build-time default — used as the signed-out/offline fallback by
 *  `useEdition()` below, and still what `tauri.conf.json`'s static native
 *  window title is hardcoded to match (that string is read before any JS
 *  runs, so it can't follow the live account). To ship a Community build,
 *  flip this AND `src-tauri/tauri.conf.json`'s `app.windows[0].title`.
 *
 *  Nothing else should read this directly — it's not the live entitlement.
 *  Components should call `useEdition()`/`useIsPro()` instead. */
export const APP_EDITION = 'community' as AppEdition;

const DEFAULT_IS_PRO = APP_EDITION === 'pro';

/** Full display title, e.g. "rdSQL - Professional" / "rdSQL - Community Edition" */
export const APP_TITLE = DEFAULT_IS_PRO ? 'rdSQL - Professional' : 'rdSQL - Community Edition';

/**
 * Live, account-driven entitlement — reflects the signed-in account's real
 * plan (from `/api/me` via `useAuthStore`), falling back to the build-time
 * `APP_EDITION` default when signed out or offline. This is intentionally a
 * hook, not a static export: entitlement can change at runtime (sign in,
 * sign out, plan change), unlike everything else in this file.
 */
export function useEdition(): AppEdition {
  const status = useAuthStore((s) => s.status);
  const plan = useAuthStore((s) => s.entitlement?.plan);
  return status === 'signed-in' && plan ? plan : APP_EDITION;
}

export function useIsPro(): boolean {
  return useEdition() === 'pro';
}

/** Short badge label, e.g. "PRO" / "COMMUNITY" — live, not build-time. */
export function useEditionLabel(): string {
  return useEdition() === 'pro' ? 'PRO' : 'COMMUNITY';
}
