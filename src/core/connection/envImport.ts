import type { DatabaseEngine } from '../domain/types';

/** Result of parsing a pasted `.env` blob or a bare connection URL. `appliedKeys`
 *  lists the human-readable field names that were filled, so the UI can show
 *  "Filled: host, port, database, …" feedback. Only fields actually present in
 *  the input are set — everything else is left `undefined` so the caller can
 *  merge without clobbering values the user already typed. */
export interface ParsedConnection {
  engine?: DatabaseEngine;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  /** Human-readable names of the fields that were populated. */
  appliedKeys: string[];
}

/** Laraval/PHP `DB_CONNECTION` value → our engine id. */
const ENGINE_ALIASES: Record<string, DatabaseEngine> = {
  pgsql: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  cockroachdb: 'cockroachdb',
  cockroach: 'cockroachdb',
  yugabyte: 'yugabytedb',
  yugabytedb: 'yugabytedb',
  mysql: 'mysql',
  mariadb: 'mariadb',
  tidb: 'tidb',
  planetscale: 'planetscale',
  sqlite: 'sqlite',
  d1: 'cloudflare-d1',
  cloudflare: 'cloudflare-d1',
  sqlsrv: 'mssql',
  mssql: 'mssql',
  sqlserver: 'mssql',
};

/** Map of env var name → the ParsedConnection field it populates. The value is
 *  a small adapter that coerces the raw string into the right shape. */
const KEY_MAP: Record<string, (raw: string, out: ParsedConnection) => void> = {
  // Laravel / PHP artisan
  DB_HOST: (v, o) => { o.host = v; o.appliedKeys.push('host'); },
  DB_PORT: (v, o) => { const n = Number(v); if (Number.isFinite(n)) { o.port = n; o.appliedKeys.push('port'); } },
  DB_DATABASE: (v, o) => { o.database = v; o.appliedKeys.push('database'); },
  DB_USERNAME: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  DB_PASSWORD: (v, o) => { o.password = v; o.appliedKeys.push('password'); },
  DB_CONNECTION: (v, o) => {
    const eng = ENGINE_ALIASES[v.toLowerCase()];
    if (eng) { o.engine = eng; o.appliedKeys.push('engine'); }
  },
  // Rails / generic DATABASE_* style
  DATABASE_HOST: (v, o) => { o.host = v; o.appliedKeys.push('host'); },
  DATABASE_PORT: (v, o) => { const n = Number(v); if (Number.isFinite(n)) { o.port = n; o.appliedKeys.push('port'); } },
  DATABASE_NAME: (v, o) => { o.database = v; o.appliedKeys.push('database'); },
  DATABASE_USER: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  DATABASE_USERNAME: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  DATABASE_PASSWORD: (v, o) => { o.password = v; o.appliedKeys.push('password'); },
  // Node / Prisma / common
  POSTGRES_HOST: (v, o) => { o.host = v; o.appliedKeys.push('host'); },
  POSTGRES_PORT: (v, o) => { const n = Number(v); if (Number.isFinite(n)) { o.port = n; o.appliedKeys.push('port'); } },
  POSTGRES_DB: (v, o) => { o.database = v; o.appliedKeys.push('database'); },
  POSTGRES_USER: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  POSTGRES_PASSWORD: (v, o) => { o.password = v; o.appliedKeys.push('password'); },
  MYSQL_HOST: (v, o) => { o.host = v; o.appliedKeys.push('host'); },
  MYSQL_PORT: (v, o) => { const n = Number(v); if (Number.isFinite(n)) { o.port = n; o.appliedKeys.push('port'); } },
  MYSQL_DATABASE: (v, o) => { o.database = v; o.appliedKeys.push('database'); },
  MYSQL_USER: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  MYSQL_PASSWORD: (v, o) => { o.password = v; o.appliedKeys.push('password'); },
  MSSQL_HOST: (v, o) => { o.host = v; o.appliedKeys.push('host'); },
  MSSQL_PORT: (v, o) => { const n = Number(v); if (Number.isFinite(n)) { o.port = n; o.appliedKeys.push('port'); } },
  MSSQL_DATABASE: (v, o) => { o.database = v; o.appliedKeys.push('database'); },
  MSSQL_USER: (v, o) => { o.username = v; o.appliedKeys.push('username'); },
  MSSQL_PASSWORD: (v, o) => { o.password = v; o.appliedKeys.push('password'); },
};

/** Parse a `postgres://user:pass@host:5432/db` (or mysql://) URL into the
 *  common fields. Exported so the Auto-fill UI can reuse it for the bare-URL
 *  case (when the user pastes a single connection string). */
export function parseConnectionUrl(url: string): ParsedConnection {
  const out: ParsedConnection = { appliedKeys: [] };
  try {
    const parsed = new URL(url.trim());
    const proto = parsed.protocol.toLowerCase();
    if (proto.includes('postgres')) {
      out.engine = 'postgres';
      out.appliedKeys.push('engine');
    } else if (proto === 'cockroachdb:' || proto === 'cockroach:') {
      out.engine = 'cockroachdb';
      out.appliedKeys.push('engine');
    } else if (proto === 'yugabyte:' || proto === 'yugabytedb:') {
      out.engine = 'yugabytedb';
      out.appliedKeys.push('engine');
    } else if (proto.includes('mysql')) {
      out.engine = 'mysql';
      out.appliedKeys.push('engine');
    } else if (proto === 'tidb:') {
      out.engine = 'tidb';
      out.appliedKeys.push('engine');
    } else if (proto === 'mssql:' || proto === 'sqlserver:' || proto === 'sqlsrv:') {
      out.engine = 'mssql';
      out.appliedKeys.push('engine');
    }
    const isPgFamily = out.engine === 'postgres' || out.engine === 'cockroachdb' || out.engine === 'yugabytedb';
    if (parsed.hostname) { out.host = parsed.hostname; out.appliedKeys.push('host'); }
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) {
      out.port = port;
      out.appliedKeys.push('port');
    } else {
      // Fall back to the family's well-known default port.
      out.port = isPgFamily
        ? (out.engine === 'cockroachdb' ? 26257 : out.engine === 'yugabytedb' ? 5433 : 5432)
        : out.engine === 'mssql' ? 1433 : 3306;
      out.appliedKeys.push('port');
    }
    if (parsed.username) { out.username = decodeURIComponent(parsed.username); out.appliedKeys.push('username'); }
    if (parsed.password) { out.password = decodeURIComponent(parsed.password); out.appliedKeys.push('password'); }
    const db = parsed.pathname.replace(/^\//, '');
    if (db) { out.database = db; out.appliedKeys.push('database'); }
  } catch {
    // Not a valid URL — return empty.
  }
  return out;
}

/** True when `text` looks like a single connection URL rather than an env
 *  blob. We treat it as a URL when the first non-blank, non-comment line
 *  matches `<scheme>://` and has no `=` before its query string — a query
 *  string (`?schema=public`, `?sslmode=require`, …) legitimately contains
 *  `=`, so only the part before the `?` disqualifies it as a `KEY=VALUE`
 *  env line. */
function looksLikeUrl(text: string): boolean {
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!firstLine) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(firstLine)) return false;
  return !firstLine.split('?')[0].includes('=');
}

/** Parse a pasted `.env` blob or a bare connection URL into connection fields.
 *
 *  - If the input is a single `postgres://…` / `mysql://…` URL, it is parsed
 *    directly (also picks up `DATABASE_URL=…` / `DB_URL=…` lines).
 *  - Otherwise each line is treated as `KEY=VALUE` (Laravel, Rails, Prisma,
 *    Docker-compose style), with `#` comments, blank lines, and a leading
 *    `export ` all ignored. Surrounding quotes on values are stripped.
 */
export function parseEnvOrUrl(text: string): ParsedConnection {
  const trimmed = (text || '').trim();
  if (!trimmed) return { appliedKeys: [] };

  // Bare connection string pasted on its own.
  if (looksLikeUrl(trimmed)) return parseConnectionUrl(trimmed);

  const out: ParsedConnection = { appliedKeys: [] };
  const lines = trimmed.split(/\r?\n/);
  const urlKeys = ['DATABASE_URL', 'DB_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'POSTGRES_URL', 'MYSQL_URL', 'MSSQL_URL'];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Strip a leading `export ` (shell-style) before splitting.
    const withoutExport = line.replace(/^export\s+/, '');
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim().toUpperCase();
    let value = withoutExport.slice(eq + 1).trim();
    // Inline comment after the value (only when the value isn't quoted).
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    // URL-style keys win for engine/host/port/db/user/pass in one shot.
    if (urlKeys.includes(key)) {
      const parsed = parseConnectionUrl(value);
      mergeParsed(out, parsed);
      continue;
    }
    const adapter = KEY_MAP[key];
    if (adapter) adapter(value, out);
  }

  return out;
}

/** Merge `src` into `dest`, filling only fields that `dest` hasn't set yet so
 *  an earlier, more specific source isn't overwritten by a later generic one. */
function mergeParsed(dest: ParsedConnection, src: ParsedConnection): void {
  if (!dest.engine && src.engine) { dest.engine = src.engine; dest.appliedKeys.push('engine'); }
  if (!dest.host && src.host) { dest.host = src.host; dest.appliedKeys.push('host'); }
  if (dest.port === undefined && src.port !== undefined) { dest.port = src.port; dest.appliedKeys.push('port'); }
  if (!dest.database && src.database) { dest.database = src.database; dest.appliedKeys.push('database'); }
  if (!dest.username && src.username) { dest.username = src.username; dest.appliedKeys.push('username'); }
  if (!dest.password && src.password) { dest.password = src.password; dest.appliedKeys.push('password'); }
}
