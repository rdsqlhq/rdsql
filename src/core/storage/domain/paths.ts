/**
 * S3 prefix / key path utilities.
 *
 * S3 has no real folders — "prefixes" are just shared key prefixes. These
 * helpers normalize the bookkeeping so the browser and backup paths behave
 * consistently, and `validatePrefixSafety` enforces that RDSQL-managed
 * operations never escape the connection's configured `pathPrefix` unless the
 * user explicitly browses elsewhere.
 *
 * All functions are pure and side-effect free.
 */

/** Normalize a user-entered prefix:
 *  - trim whitespace
 *  - collapse repeated `/`
 *  - ensure exactly one trailing `/` (S3 convention for "folders")
 *  - strip a leading `/` (S3 keys are never absolute)
 *  Empty input → empty string (meaning "bucket root"). */
export function normalizePrefix(input: string | undefined | null): string {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';
  // Collapse runs of slashes.
  s = s.replace(/\/+/g, '/');
  // Strip leading slash — keys are relative.
  if (s.startsWith('/')) s = s.slice(1);
  // Ensure trailing slash for a "folder".
  if (s && !s.endsWith('/')) s += '/';
  return s;
}

/** Join prefix segments into one normalized prefix. Empty/null segments are
 *  skipped. Always returns a normalized prefix (trailing slash, no leading
 *  slash, collapsed slashes). */
export function joinPrefix(...segments: Array<string | undefined | null>): string {
  return normalizePrefix(segments.filter((s): s is string => !!s && s.trim().length > 0).join('/'));
}

/** The display name of a prefix or key, relative to a browse prefix:
 *  strips the browse prefix and the trailing slash. Returns the last segment
 *  so nested keys show just their file/folder name. */
export function displayName(fullKey: string, browsePrefix: string): string {
  const bp = normalizePrefix(browsePrefix);
  let rel = fullKey;
  if (bp && rel.startsWith(bp)) rel = rel.slice(bp.length);
  // Folder: strip trailing slash before taking the last segment.
  if (rel.endsWith('/')) rel = rel.slice(0, -1);
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(slash + 1) : rel;
}

/** Build a deterministic backup object key. Shape:
 *    {prefix}{environment}/{engine}/{database}/{YYYY}/{MM}/{DD}/backup-{timestamp}.sql[.gz]
 *  Every segment is sanitized to be filesystem/key-safe (no slashes/spaces
 *  within a segment). Returns the full key (no leading slash). */
export interface BuildBackupPathArgs {
  /** Connection root prefix (will be normalized). */
  prefix: string;
  /** Logical environment label (e.g. "production"). Sanitized. */
  environment?: string;
  /** DB engine (e.g. "mysql"). Sanitized. */
  engine: string;
  /** Database name. Sanitized. */
  database: string;
  /** Timestamp used for both the date segments and the filename stamp.
   *  Defaults to `new Date()`. */
  date?: Date;
  /** Override the full filename (must include extension). When omitted a
   *  `backup-{YYYYMMDDHHmm}.sql` name is generated. `.gz` appended if
   *  `compressed`. */
  filename?: string;
  /** When true, the generated filename gets a `.gz` suffix (unless the caller
   *  supplied a custom `filename`). */
  compressed?: boolean;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Replace any character that is unsafe in an S3 key segment. Keeps alphanumerics,
 *  dash, underscore, dot; everything else becomes `_`. */
export function sanitizeSegment(segment: string | undefined | null): string {
  if (!segment) return 'unknown';
  const s = String(segment).trim();
  if (!s) return 'unknown';
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function buildBackupPath(args: BuildBackupPathArgs): string {
  const d = args.date ?? new Date();
  const yyyy = String(d.getUTCFullYear());
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const stamp = `${yyyy}${mm}${dd}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;

  const filename =
    args.filename ??
    `backup-${stamp}.sql${args.compressed ? '.gz' : ''}`;

  const segments = [
    normalizePrefix(args.prefix),
    sanitizeSegment(args.environment),
    sanitizeSegment(args.engine),
    sanitizeSegment(args.database),
    yyyy,
    mm,
    dd,
    filename,
  ].filter(Boolean);

  // The filename is the final segment and must NOT get a trailing slash; the
  // normalize call would otherwise add one. Join everything except the
  // filename with normalized slashes, then append the filename.
  const dir = joinPrefix(...segments.slice(0, -1));
  const last = segments[segments.length - 1];
  return dir ? `${dir}${last}` : last;
}

/** Safety gate. Returns true when `key` is within the connection's
 *  `pathPrefix` (or the prefix is empty, meaning the user opted into
 *  bucket-root scope). Used to guard automated operations (backup, retention)
 *  so they can never delete/clobber objects the user did not intend.
 *
 *  NOTE: This does NOT prevent browsing — the user may explicitly browse
 *  outside the prefix. It only guards RDSQL-managed writes/deletes. */
export function isWithinPrefix(key: string, pathPrefix: string): boolean {
  const prefix = normalizePrefix(pathPrefix);
  // Empty prefix = bucket root = user accepted full-bucket scope.
  if (!prefix) return true;
  return key === prefix.slice(0, -1) || key.startsWith(prefix);
}

/** Throwing variant for automated code paths. */
export function assertWithinPrefix(key: string, pathPrefix: string): void {
  if (!isWithinPrefix(key, pathPrefix)) {
    throw new StorageSafetyError(
      `Refused to operate on key outside the configured prefix: ${key}`,
      key,
    );
  }
}

/** Dedicated error class so safety violations are distinguishable from generic
 *  runtime errors in logs/tests. */
export class StorageSafetyError extends Error {
  readonly key: string;
  constructor(message: string, key: string) {
    super(message);
    this.name = 'StorageSafetyError';
    this.key = key;
  }
}
