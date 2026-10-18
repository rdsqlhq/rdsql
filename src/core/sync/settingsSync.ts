/**
 * App settings sync — pushes/pulls the settings blob (row limit, timeouts,
 * UI toggles, AI assistant config) through the same generic
 * sync_resources/sync_changes engine `connectionSync.ts` uses. The server
 * already declares `app_setting` as a valid resource type
 * (rdsql-website/src/lib/api/syncResourceTypes.ts) — this just implements
 * the desktop side of it, which never existed before.
 *
 * `ai.apiKey` needs the same split-secrets treatment connectionSync.ts uses
 * for connection passwords: it's stored locally SEALED with a per-device KEK
 * (core/storage/secrets.ts), which is meaningless ciphertext on any other
 * device. Before pushing it's unsealed to plaintext in memory and
 * re-encrypted with the SHARED sync key (credentialCrypto.ts) for transport;
 * on pull, the reverse — decrypt with the shared sync key, then re-seal with
 * THIS device's own KEK for local storage. It never travels as plaintext and
 * never sits in the main (unencrypted) settings payload.
 */
import { useSettingsStore } from '../../store/useSettingsStore';
import { safeInvoke } from '../tauri/ipc';
import { encryptForSync, decryptFromSync } from './credentialCrypto';
import { encryptSecret, decryptSecret } from '../storage/secrets';
import type { AIProvider } from '../ai/types';

const RESOURCE_TYPE = 'app_setting';
// One fixed logical resource — settings are a single cohesive blob per
// account, not a per-item collection like connections.
const RESOURCE_ID = 'app-settings';

const VERSION_KEY = 'rdsql_settings_sync_version_v1';

function getLocalVersion(): number {
  return Number(localStorage.getItem(VERSION_KEY) || '0');
}
function setLocalVersion(v: number): void {
  localStorage.setItem(VERSION_KEY, String(v));
}

/** Not scoped per-account, same caveat as connectionSync.ts's version/cursor
 *  keys — call on sign-out or a different account signing in on this device
 *  inherits stale version bookkeeping. */
export function clearLocalSettingsSyncState(): void {
  localStorage.removeItem(VERSION_KEY);
}

interface SyncedSettingsPayload {
  /** Settings format. 1: the timeout is enforced (0 means none). 2: analytics
   *  is off unless the user turned it on. Missing on payloads from older app
   *  versions. */
  settingsVersion?: number;
  rowLimit: number;
  execTimeoutSec: number;
  s3PreviewMaxBytes: number;
  showSystemSchemas: boolean;
  showGlobalLogs: boolean;
  sqlLogColorCoding: boolean;
  sqlLogFullText: boolean;
  analyticsEnabled: boolean;
  ai: {
    provider: AIProvider;
    model: string;
    baseUrl?: string;
    enabled: boolean;
    // apiKey deliberately excluded — travels separately, encrypted.
  };
}

export async function pushSettings(): Promise<void> {
  const s = useSettingsStore.getState();
  const payload: SyncedSettingsPayload = {
    settingsVersion: 2,
    rowLimit: s.rowLimit,
    execTimeoutSec: s.execTimeoutSec,
    s3PreviewMaxBytes: s.s3PreviewMaxBytes,
    showSystemSchemas: s.showSystemSchemas,
    showGlobalLogs: s.showGlobalLogs,
    sqlLogColorCoding: s.sqlLogColorCoding,
    sqlLogFullText: s.sqlLogFullText,
    analyticsEnabled: s.analyticsEnabled,
    ai: {
      provider: s.ai.provider,
      model: s.ai.model,
      baseUrl: s.ai.baseUrl,
      enabled: s.ai.enabled,
    },
  };

  const result = await safeInvoke<{ version: number }>('backend_sync_push_resource', {
    resourceType: RESOURCE_TYPE,
    resourceId: RESOURCE_ID,
    payload: JSON.stringify(payload),
    expectedVersion: getLocalVersion(),
  });
  setLocalVersion(result.version);

  if (s.ai.apiKey) {
    const plaintextKey = await decryptSecret(s.ai.apiKey).catch(() => null);
    if (plaintextKey) {
      const encrypted = await encryptForSync(plaintextKey);
      await safeInvoke('backend_sync_push_credentials', {
        resourceId: RESOURCE_ID,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
      });
    }
  }
}

/** Returns true if a remote settings resource existed and was applied. */
export async function pullSettings(): Promise<boolean> {
  const resource = await safeInvoke<{ payload: string; version: number; deleted_at: string | null } | null>(
    'backend_sync_pull_resource',
    { resourceType: RESOURCE_TYPE, resourceId: RESOURCE_ID },
  ).catch(() => null);
  if (!resource || resource.deleted_at) return false;

  const payload = JSON.parse(resource.payload) as SyncedSettingsPayload;
  setLocalVersion(resource.version);

  // Keep this device's own key unless the remote actually has one to offer —
  // an account with sync enabled but no AI key configured shouldn't wipe a
  // key a device already had sealed locally.
  let apiKey = useSettingsStore.getState().ai.apiKey;
  const credentials = await safeInvoke<{ ciphertext: string; iv: string; tag: string } | null>(
    'backend_sync_pull_credentials',
    { resourceId: RESOURCE_ID },
  ).catch(() => null);
  if (credentials) {
    const plaintextKey = await decryptFromSync(credentials).catch(() => null);
    if (plaintextKey) apiKey = await encryptSecret(plaintextKey);
  }

  useSettingsStore.setState({
    rowLimit: payload.rowLimit,
    // Older versions stored a 30s default they never enforced (see the
    // settings store migration), so treat that as "no timeout".
    execTimeoutSec: !payload.settingsVersion && payload.execTimeoutSec === 30 ? 0 : payload.execTimeoutSec,
    s3PreviewMaxBytes: payload.s3PreviewMaxBytes,
    showSystemSchemas: payload.showSystemSchemas,
    showGlobalLogs: payload.showGlobalLogs,
    sqlLogColorCoding: payload.sqlLogColorCoding,
    sqlLogFullText: payload.sqlLogFullText,
    // Older versions defaulted analytics to on without the user choosing it,
    // so only take the value from payloads that know it's opt-in.
    analyticsEnabled:
      (payload.settingsVersion ?? 0) >= 2 ? payload.analyticsEnabled : useSettingsStore.getState().analyticsEnabled,
    ai: { ...useSettingsStore.getState().ai, ...payload.ai, apiKey },
  });
  return true;
}
