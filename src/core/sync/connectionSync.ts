/**
 * Connection sync — pushes/pulls `DatabaseConnection` rows through the
 * generic `sync_resources`/`sync_changes` engine (`commands::backend`'s
 * `backend_sync_*` commands), splitting each connection into a plaintext
 * metadata payload (name, host, port, engine, …) and a separately
 * E2E-encrypted credentials blob (password, Cloudflare API token, SSH
 * password) via `credentialCrypto`.
 *
 * Scope for this pass: `connection` resources only (matches the plan's v1
 * scope — connection_group/tag sync can follow later as its own resource
 * type using the same generic engine, nothing here is connection-specific
 * beyond the split/merge helpers).
 */
import type { DatabaseConnection } from '../domain/types';
import { safeInvoke } from '../tauri/ipc';
import { useConnectionStore } from '../../store/useConnectionStore';
import { encryptForSync, decryptFromSync } from './credentialCrypto';

const RESOURCE_TYPE = 'connection';

interface PlainConnectionPayload extends Omit<DatabaseConnection, 'password' | 'cfApiToken' | 'ssh'> {
  ssh?: Omit<DatabaseConnection['ssh'], 'sshPassword'>;
}

interface ConnectionSecrets {
  password?: string;
  cfApiToken?: string;
  sshPassword?: string;
}

function splitConnection(conn: DatabaseConnection): { plain: PlainConnectionPayload; secrets: ConnectionSecrets } {
  const { password, cfApiToken, ssh, ...rest } = conn;
  const { sshPassword, ...sshRest } = ssh ?? {};
  return {
    plain: { ...rest, ...(ssh ? { ssh: sshRest } : {}) },
    secrets: { password, cfApiToken, sshPassword },
  };
}

function mergeConnection(plain: PlainConnectionPayload, secrets: ConnectionSecrets): DatabaseConnection {
  return {
    ...plain,
    password: secrets.password,
    cfApiToken: secrets.cfApiToken,
    ssh: plain.ssh || secrets.sshPassword ? { ...(plain.ssh as DatabaseConnection['ssh']), sshPassword: secrets.sshPassword } : undefined,
  } as DatabaseConnection;
}

export class SyncConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super('Sync conflict — this connection changed on another device since your last sync.');
  }
}

/** Local version tracking per connection, kept separate from
 *  `DatabaseConnection` itself (not persisted server-side metadata the rest
 *  of the app needs to know about). Simple localStorage map is enough —
 *  this is bookkeeping, not user data. */
const VERSION_KEY = 'rdsql_sync_versions_v1';
const CURSOR_KEY = 'rdsql_sync_cursor_v1';

/** Clears this device's local sync bookkeeping (per-connection version map +
 *  pull cursor). Neither is scoped by account — call this on sign-out, or a
 *  different account signing in on the same device inherits the previous
 *  account's version/cursor state, producing bogus conflicts or silently
 *  skipping changes it's never actually seen. */
export function clearLocalSyncState(): void {
  localStorage.removeItem(VERSION_KEY);
  localStorage.removeItem(CURSOR_KEY);
}

function getLocalVersions(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VERSION_KEY) || '{}');
  } catch {
    return {};
  }
}

function setLocalVersion(id: string, version: number): void {
  const versions = getLocalVersions();
  versions[id] = version;
  localStorage.setItem(VERSION_KEY, JSON.stringify(versions));
}

export function getLocalSyncVersion(connectionId: string): number {
  return getLocalVersions()[connectionId] ?? 0;
}

/** Pushes one connection. Throws `SyncConflictError` on a 409 (someone else
 *  synced a newer version) — callers decide whether to overwrite or pull
 *  first; this never silently resolves conflicts. */
export async function pushConnection(conn: DatabaseConnection): Promise<void> {
  const { plain, secrets } = splitConnection(conn);
  const expectedVersion = getLocalSyncVersion(conn.id);

  let result: { version: number };
  try {
    result = await safeInvoke<{ version: number }>('backend_sync_push_resource', {
      resourceType: RESOURCE_TYPE,
      resourceId: conn.id,
      payload: JSON.stringify(plain),
      expectedVersion,
    });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('version conflict')) {
      const match = msg.match(/currentVersion["\s:]+(\d+)/);
      throw new SyncConflictError(match ? Number(match[1]) : expectedVersion + 1);
    }
    throw err;
  }

  const hasSecrets = secrets.password || secrets.cfApiToken || secrets.sshPassword;
  if (hasSecrets) {
    const encrypted = await encryptForSync(JSON.stringify(secrets));
    await safeInvoke('backend_sync_push_credentials', {
      resourceId: conn.id,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
    });
  }

  setLocalVersion(conn.id, result.version);
}

/** Pulls one connection's plaintext metadata + (if present) its credentials,
 *  returning the merged `DatabaseConnection`. Does not touch the local
 *  store — caller decides how to apply it (direct upsert vs. conflict UI). */
export async function pullConnection(connectionId: string): Promise<DatabaseConnection | null> {
  const resource = await safeInvoke<{ payload: string; version: number; deleted_at: string | null } | null>(
    'backend_sync_pull_resource',
    { resourceType: RESOURCE_TYPE, resourceId: connectionId },
  ).catch(() => null);
  if (!resource || resource.deleted_at) return null;

  const plain = JSON.parse(resource.payload) as PlainConnectionPayload;

  let secrets: ConnectionSecrets = {};
  const credentials = await safeInvoke<{ ciphertext: string; iv: string; tag: string } | null>(
    'backend_sync_pull_credentials',
    { resourceId: connectionId },
  ).catch(() => null);
  if (credentials) {
    secrets = JSON.parse(await decryptFromSync(credentials));
  }

  setLocalVersion(connectionId, resource.version);
  return mergeConnection(plain, secrets);
}

/** Pulls every change since the last-seen cursor and applies upserts/deletes
 *  directly to `useConnectionStore`. Returns how many resources changed. */
export async function pullAllChanges(): Promise<number> {
  let cursor = Number(localStorage.getItem(CURSOR_KEY) || '0');
  let applied = 0;

  // Page through the manifest until caught up.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const manifest = await safeInvoke<{
      changes: Array<{ id: number; resource_type: string; resource_id: string; operation: 'upsert' | 'delete' }>;
      cursor: number;
      hasMore: boolean;
    }>('backend_sync_manifest', { cursor });

    for (const change of manifest.changes) {
      if (change.resource_type !== RESOURCE_TYPE) continue;
      if (change.operation === 'delete') {
        useConnectionStore.getState().deleteConnection(change.resource_id);
      } else {
        const conn = await pullConnection(change.resource_id);
        if (conn) useConnectionStore.getState().saveConnection(conn);
      }
      applied += 1;
    }

    cursor = manifest.cursor;
    localStorage.setItem(CURSOR_KEY, String(cursor));
    if (!manifest.hasMore) break;
  }

  return applied;
}

/** Conflict resolution — "keep remote": pulls the server's version and
 *  overwrites the local connection with it. */
export async function resolveConflictKeepRemote(connectionId: string): Promise<void> {
  const conn = await pullConnection(connectionId);
  if (conn) useConnectionStore.getState().saveConnection(conn);
}

/** Conflict resolution — "keep mine": re-reads the server's current version
 *  number (without applying its data) so the next push's optimistic-
 *  concurrency check succeeds, then pushes the local connection over it. */
export async function resolveConflictKeepLocal(connectionId: string): Promise<void> {
  const resource = await safeInvoke<{ version: number } | null>('backend_sync_pull_resource', {
    resourceType: RESOURCE_TYPE,
    resourceId: connectionId,
  }).catch(() => null);
  if (resource) setLocalVersion(connectionId, resource.version);

  const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
  if (conn) await pushConnection(conn);
}

/** Pushes every local connection (used for the first sync on a device, or
 *  "Sync now"). Conflicts are collected and returned rather than thrown, so
 *  one conflicting connection doesn't abort syncing the rest. */
export async function pushAllConnections(): Promise<{ pushed: number; conflicts: Array<{ id: string; name: string }> }> {
  const connections = useConnectionStore.getState().connections;
  const conflicts: Array<{ id: string; name: string }> = [];
  let pushed = 0;

  for (const conn of connections) {
    try {
      await pushConnection(conn);
      pushed += 1;
    } catch (err) {
      if (err instanceof SyncConflictError) {
        conflicts.push({ id: conn.id, name: conn.name });
      } else {
        throw err;
      }
    }
  }

  return { pushed, conflicts };
}
