/**
 * Parses the structured JSON error string produced by the Rust backend
 * (`DbError::to_json_string`). When the backend returns a plain string (older
 * code path or a non-DB error), this falls back gracefully so the UI always has
 * something to show.
 */
export interface ParsedDbError {
  /** connection | database | app */
  kind: 'connection' | 'database' | 'app';
  /** One-line summary, e.g. `ERROR 42P01: relation "x" does not exist`. */
  message: string;
  detail?: string;
  hint?: string;
  sql?: string;
  code?: string;
  /** True when we got a structured object; false when it's a plain string. */
  structured: boolean;
}

export function parseDbError(raw: string | undefined | null): ParsedDbError {
  const fallback = (message: string): ParsedDbError => ({ kind: 'app', message, structured: false });
  if (!raw) return fallback('Unknown error.');

  // The backend serializes DbError as JSON. Try to parse it; if it isn't an
  // object with a `message` field, treat the whole thing as a plain message.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && typeof obj.message === 'string') {
        const kind = obj.kind === 'connection' || obj.kind === 'database' ? obj.kind : 'app';
        return {
          kind,
          message: obj.message,
          detail: typeof obj.detail === 'string' ? obj.detail : undefined,
          hint: typeof obj.hint === 'string' ? obj.hint : undefined,
          sql: typeof obj.sql === 'string' ? obj.sql : undefined,
          code: typeof obj.code === 'string' ? obj.code : undefined,
          structured: true,
        };
      }
    } catch {
      // Not JSON — fall through to plain-string handling.
    }
  }
  return fallback(raw);
}

/** A short, human label for each error kind — used in the UI header/badge. */
export function errorKindLabel(kind: ParsedDbError['kind']): string {
  switch (kind) {
    case 'connection':
      return 'Connection error';
    case 'database':
      return 'Database error';
    default:
      return 'Application error';
  }
}

/** A tailwind text color class per kind, for the badge. */
export function errorKindColor(kind: ParsedDbError['kind']): string {
  switch (kind) {
    case 'connection':
      return 'text-amber-400';
    case 'database':
      return 'text-red-400';
    default:
      return 'text-purple-400';
  }
}

/**
 * Renders a ParsedDbError into a single multi-line plain-text "trace" suitable
 * for copying to the clipboard or pasting into a bug report. The format is
 * intentionally stable so the whole app copies the same shape:
 *
 *   [Connection error] ACCESS_DENIED
 *   message line
 *   DETAIL: ...
 *   HINT: ...
 *   SQL: ...
 */
export function formatDbErrorTrace(e: ParsedDbError): string {
  const parts: string[] = [`[${errorKindLabel(e.kind)}]${e.code ? ` ${e.code}` : ''}`];
  parts.push(e.message);
  if (e.detail) parts.push(`DETAIL: ${e.detail}`);
  if (e.hint) parts.push(`HINT: ${e.hint}`);
  if (e.sql) parts.push(`SQL: ${e.sql}`);
  return parts.join('\n');
}

/**
 * Normalises any error value (string, Error, structured JSON, or unknown) into a
 * single copyable trace string. This is the convenience callers want when all
 * they have is a raw error and they need text for the clipboard.
 */
export function errorToTrace(raw: unknown): string {
  if (raw == null) return '[Application error]\nUnknown error.';
  if (typeof raw === 'string') {
    return formatDbErrorTrace(parseDbError(raw));
  }
  if (raw instanceof Error) {
    return formatDbErrorTrace(parseDbError(raw.message));
  }
  try {
    return formatDbErrorTrace(parseDbError(String(raw)));
  } catch {
    return '[Application error]\nUnknown error.';
  }
}
