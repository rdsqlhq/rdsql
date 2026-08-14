import { create } from 'zustand';
import { safeInvoke } from '../core/tauri/ipc';
import type { AppEdition } from '../core/config/edition';
import { generatePairingCode, exportSyncKeyForPairing, importSyncKeyFromPairing, clearSyncKey, type EncryptedField } from '../core/sync/credentialCrypto';
import { clearLocalSyncState } from '../core/sync/connectionSync';
import { clearLocalSettingsSyncState } from '../core/sync/settingsSync';
import { resetLocalSyncDisplayState } from './useSyncStore';

/**
 * Account/session state — backed by the rdSQL Cloudflare backend
 * (`src-tauri/src/commands/backend.rs`). Login itself is a browser flow, not
 * a form here: `openLogin()` opens the system browser to the website's
 * `/account` page; the app receives the resulting session via a
 * `rdsql://auth/callback` deep link, which `lib.rs`'s handler turns into an
 * `auth-callback` event. `MainLayout.tsx` listens for that event and calls
 * `handleAuthCallback`, matching the app's existing `menu_action`/`open-file`
 * event-wiring convention.
 *
 * Tokens themselves never touch this store (or localStorage) — they live in
 * the OS keychain via `backend.rs`. This store only holds the
 * already-authenticated profile/entitlement data returned by `/api/me`.
 */

export interface Entitlement {
  plan: AppEdition;
  features: string[];
}

export interface AuthDevice {
  id: string;
  device_name: string;
  platform: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface MeResponse {
  account: { id: string; email: string };
  entitlement: Entitlement;
  devices: AuthDevice[];
  currentDeviceId: string;
}

interface AuthState {
  status: 'signed-out' | 'signing-in' | 'signed-in';
  email: string | null;
  entitlement: Entitlement | null;
  devices: AuthDevice[];
  currentDeviceId: string | null;
  error: string | null;
  /** null until checked. False on self-built/community binaries that weren't
   *  compiled with the official backend's build-time config — see
   *  backend.rs's `require_cloud_configured`. */
  cloudConfigured: boolean | null;

  checkCloudConfigured: () => Promise<void>;
  openLogin: () => Promise<void>;
  cancelLogin: () => void;
  redeemPairingCode: (code: string) => Promise<void>;
  createPairingCode: () => Promise<{ code: string; expiresAt: string }>;
  signOut: () => Promise<void>;
  refreshEntitlement: () => Promise<void>;
  renameDevice: (deviceId: string, name: string) => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<void>;
  handleAuthCallback: (status: 'success' | 'error', message?: string) => void;
}

const SIGNED_OUT = { status: 'signed-out' as const, email: null, entitlement: null, devices: [], currentDeviceId: null };

// Not the token itself (that's keychain-only) — just a non-secret marker so
// boot-time refreshEntitlement() can skip touching the Keychain entirely
// when there's clearly no session to restore. Matters most in `tauri dev`:
// every `cargo run` re-signs the binary with a fresh ad-hoc identity, so
// macOS treats it as a new/untrusted app and would otherwise re-prompt for
// Keychain access on every single dev boot, even when signed out.
const HAS_SESSION_KEY = 'rdsql_has_cloud_session';
const markHasSession = () => localStorage.setItem(HAS_SESSION_KEY, '1');
const clearHasSession = () => localStorage.removeItem(HAS_SESSION_KEY);
const hasSessionFlag = () => localStorage.getItem(HAS_SESSION_KEY) === '1';

// How long to wait for the rdsql://auth/callback deep link before giving up
// and letting the user retry — a browser tab left open with nobody there to
// finish signing in shouldn't leave the app stuck in "signing-in" forever.
const LOGIN_TIMEOUT_MS = 120_000;
let loginTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

function clearLoginTimeout() {
  if (loginTimeoutHandle) {
    clearTimeout(loginTimeoutHandle);
    loginTimeoutHandle = null;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'signed-out',
  email: null,
  entitlement: null,
  devices: [],
  currentDeviceId: null,
  error: null,
  cloudConfigured: null,

  checkCloudConfigured: async () => {
    const configured = await safeInvoke<boolean>('backend_is_cloud_configured').catch(() => false);
    set({ cloudConfigured: configured });
  },

  openLogin: async () => {
    set({ status: 'signing-in', error: null });
    try {
      // Resolves once the browser opens — actual sign-in completion arrives
      // later via the auth-callback event (handleAuthCallback below).
      await safeInvoke('backend_open_login');
      clearLoginTimeout();
      loginTimeoutHandle = setTimeout(() => {
        loginTimeoutHandle = null;
        if (get().status === 'signing-in') {
          set({ status: 'signed-out', error: 'Sign-in timed out — try again.' });
        }
      }, LOGIN_TIMEOUT_MS);
    } catch (err: any) {
      set({ status: 'signed-out', error: err?.message || String(err) });
    }
  },

  cancelLogin: () => {
    clearLoginTimeout();
    set({ status: 'signed-out', error: null });
  },

  redeemPairingCode: async (code) => {
    set({ status: 'signing-in', error: null });
    try {
      const result = await safeInvoke<{ syncKey: EncryptedField | null }>('backend_redeem_pairing_code', { code });
      if (result.syncKey) {
        // Adopting a new sync identity via pairing — any leftover local
        // version/cursor bookkeeping belongs to whatever account last used
        // this device, not this one. Clear it first so it doesn't produce
        // bogus conflicts (or silently skip real changes) against the newly
        // paired account's data.
        clearLocalSyncState();
        clearLocalSettingsSyncState();
        resetLocalSyncDisplayState();
        // The pairing device had sync set up — adopt its key so this device
        // can read/write the same encrypted connection data immediately.
        await importSyncKeyFromPairing(code, result.syncKey);
      }
      markHasSession();
      await get().refreshEntitlement();
    } catch (err: any) {
      set({ status: 'signed-out', error: err?.message || String(err) });
      throw err;
    }
  },

  createPairingCode: async () => {
    const code = generatePairingCode();
    const syncKey = await exportSyncKeyForPairing(code);
    const { expiresAt } = await safeInvoke<{ expiresAt: string }>('backend_create_pairing_code', { code, syncKey });
    return { code, expiresAt };
  },

  signOut: async () => {
    try {
      await safeInvoke('backend_logout');
    } catch {
      // Best-effort — local state clears regardless of whether the server call succeeded.
    }
    clearHasSession();
    // The E2E sync key and local version/cursor bookkeeping are NOT scoped
    // per-account — they live under fixed keychain/localStorage keys. If a
    // different account signs in on this device afterward, ensureSyncKey()
    // only generates a fresh key when none exists, so without this it would
    // silently inherit and start using the previous account's sync key
    // (their synced connection credentials would be encrypted with a key
    // this "new" account never actually generated or received via pairing).
    await clearSyncKey().catch(() => undefined);
    clearLocalSyncState();
    clearLocalSettingsSyncState();
    resetLocalSyncDisplayState();
    set({ ...SIGNED_OUT, error: null });
  },

  refreshEntitlement: async () => {
    // Dev builds (`tauri dev`/`make dev`) don't get the official RDSQL_CLIENT_KEY
    // build-time config (see Makefile's API_ENV), so cloud is never configured
    // there — skip before touching the Keychain at all. This also matters
    // because every `cargo run` re-signs the binary with a fresh ad-hoc
    // identity, so macOS would otherwise re-prompt for Keychain access on
    // every dev boot.
    const configured = await safeInvoke<boolean>('backend_is_cloud_configured').catch(() => false);
    if (!configured) {
      set({ ...SIGNED_OUT, error: null, cloudConfigured: false });
      return;
    }
    // Nothing was ever signed in on this device (or it was signed out) —
    // skip the Keychain read entirely rather than triggering a macOS access
    // prompt for a lookup we already know will be empty.
    if (!hasSessionFlag()) {
      set({ ...SIGNED_OUT, error: null, cloudConfigured: true });
      return;
    }
    try {
      const me = await safeInvoke<MeResponse>('backend_get_me');
      markHasSession();
      set({
        status: 'signed-in',
        email: me.account.email,
        entitlement: me.entitlement,
        devices: me.devices,
        currentDeviceId: me.currentDeviceId,
        error: null,
      });
    } catch {
      // Best-effort, offline-tolerant: never blocks the app. If we're not
      // actually signed in locally, fall back to signed-out; if we are (just
      // an offline/network hiccup), keep the last-known state instead of
      // kicking the user out for a transient failure.
      const signedIn = await safeInvoke<boolean>('backend_is_signed_in').catch(() => false);
      if (!signedIn) {
        clearHasSession();
        set({ ...SIGNED_OUT, error: null });
      }
    }
  },

  renameDevice: async (deviceId, name) => {
    await safeInvoke('backend_rename_device', { deviceId, deviceName: name });
    await get().refreshEntitlement();
  },

  revokeDevice: async (deviceId) => {
    await safeInvoke('backend_revoke_device', { deviceId });
    await get().refreshEntitlement();
  },

  handleAuthCallback: (status, message) => {
    clearLoginTimeout();
    if (status === 'success') {
      markHasSession();
      void get().refreshEntitlement();
    } else {
      set({ status: 'signed-out', error: message || 'Sign-in failed' });
    }
  },
}));
