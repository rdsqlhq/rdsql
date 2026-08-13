/**
 * Presigned URL expiry options — pure data used by the storage details UI.
 *
 * S3 caps presigned URL lifetimes at 7 days (604800s); the Rust command clamps
 * the value, but the menu only offers valid options so the UI never shows a
 * "generate" button that would produce a clamped result silently.
 */

export interface PresignExpiryOption {
  /** Human label for the dropdown. */
  label: string;
  /** Expiry in seconds. */
  secs: number;
}

/** The selectable expiry presets offered in the details panel. Ordered
 *  shortest → longest. The default is 1 hour (`3600`). */
export const PRESIGN_EXPIRY_OPTIONS: PresignExpiryOption[] = [
  { label: '5 minutes', secs: 300 },
  { label: '1 hour', secs: 3600 },
  { label: '24 hours', secs: 86_400 },
  { label: '7 days', secs: 604_800 },
];

/** S3's hard maximum for a presigned URL lifetime, in seconds. */
export const PRESIGN_MAX_SECS = 604_800;

/** The default expiry (1 hour) — used when the details panel first opens. */
export const PRESIGN_DEFAULT_SECS = 3600;

/** Format an expiry-in-seconds value as a human label. Falls back to the raw
 *  seconds for custom values that aren't in the preset list. */
export function formatExpiry(secs: number): string {
  const match = PRESIGN_EXPIRY_OPTIONS.find((o) => o.secs === secs);
  if (match) return match.label;
  if (secs >= 86_400 && secs % 86_400 === 0) return `${secs / 86_400} day(s)`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} hour(s)`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60} minute(s)`;
  return `${secs}s`;
}
