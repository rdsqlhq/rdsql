/**
 * Storage error mapping — frontend side.
 *
 * Rust S3 commands return `Result<T, String>` where the `String` is a
 * JSON-serialized `StorageError` (`{ kind, message, hint }`) — mirroring the
 * existing `DbError` pattern in `commands::error`. This module turns a thrown
 * `Error` from `safeInvoke` back into a typed `StorageError`, and provides
 * helpers to classify raw/unknown errors that did not come through the Rust
 * mapping (e.g. IPC transport failures).
 */
import type { StorageError, StorageErrorKind } from './types';

/** Try to interpret a thrown value as a JSON-serialized `StorageError` from
 *  Rust. Falls back to a best-effort classification when the payload is a
 *  plain string or an unknown shape. Never throws. */
export function toStorageError(err: unknown): StorageError {
  if (!err) {
    return { kind: 'unknown', message: 'Unknown storage error.' };
  }

  const raw = typeof err === 'string' ? err : (err as { message?: string })?.message ?? String(err);

  // Rust side serializes errors as JSON.
  try {
    const parsed = JSON.parse(raw) as Partial<StorageError>;
    if (parsed && typeof parsed.kind === 'string' && typeof parsed.message === 'string') {
      return {
        kind: normalizeKind(parsed.kind),
        message: parsed.message,
        hint: parsed.hint,
      };
    }
  } catch {
    /* not JSON — fall through to heuristic */
  }

  // Heuristic classification for IPC/transport errors that bypassed the Rust
  // mapper. Strings are matched loosely; secrets should already be scrubbed
  // on the Rust side, but we strip a few telltale patterns defensively.
  const lower = raw.toLowerCase();
  let kind: StorageErrorKind = 'unknown';
  if (/(auth|credential|access key|forbidden|403)/.test(lower)) kind = 'auth';
  else if (/(timeout|timed out)/.test(lower)) kind = 'timeout';
  else if (/(network|unreachable|dns|connection refused|econn)/.test(lower)) kind = 'network';
  else if (/(not found|404|no such key)/.test(lower)) kind = 'notFound';
  else if (/(multipart|upload)/.test(lower)) kind = 'multipart';

  return { kind, message: scrub(raw) };
}

/** Normalize an arbitrary string into a known `StorageErrorKind`. */
function normalizeKind(k: string): StorageErrorKind {
  const known: StorageErrorKind[] = [
    'auth',
    'authorization',
    'notFound',
    'network',
    'timeout',
    'config',
    'upload',
    'download',
    'multipart',
    'unknown',
  ];
  return (known as string[]).includes(k) ? (k as StorageErrorKind) : 'unknown';
}

/** Scrub obvious secret-looking substrings from a message before display.
 *  This is defense-in-depth — the Rust side already strips secrets. */
export function scrub(message: string): string {
  return message
    // AWS access key ids (AKIA…, 20 chars)
    .replace(/AKIA[0-9A-Z]{12,16}/g, 'AKIA••••')
    // Long hex/base64 runs (likely secret keys / signatures / tokens). Runs of
    // 40+ chars are almost never legitimate in a user-facing message.
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '••••')
    // Authorization header value — consume to end of line so a "Bearer x.y.z"
    // value is fully redacted, not just the scheme.
    .replace(/(authorization:\s*).+/gi, '$1••••')
    .trim();
}

/** True when the error indicates the credentials/permissions are wrong — used
 *  by the UI to nudge the user back to the connection editor. */
export function isCredentialError(err: StorageError): boolean {
  return err.kind === 'auth' || err.kind === 'authorization';
}
