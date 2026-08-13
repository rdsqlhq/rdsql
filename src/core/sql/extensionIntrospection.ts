/**
 * Postgres-only: list installed extensions (`pg_extension`). Powers the
 * "Extensions" directory in the Explorer tree. Other engine families return [].
 */
import { DatabaseConnection } from '../domain/types';
import { isPostgresFamily } from '../connection/engines';
import { safeInvoke } from '../tauri/ipc';

export interface ExtensionItem {
  name: string;
  version: string;
}

type Cell = string | number | boolean | null;
interface QueryPayload {
  columns: { name: string }[];
  rows: Cell[][];
}

const str = (c: Cell): string => (c === null || c === undefined ? '' : String(c));

export async function fetchExtensions(config: DatabaseConnection, engine: string): Promise<ExtensionItem[]> {
  if (!isPostgresFamily(engine)) return [];
  const sql = `SELECT extname, extversion FROM pg_extension ORDER BY extname;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `ext_list_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({ name: str(row[0]), version: str(row[1]) }));
}

/** An extension available on the server (whether or not it's installed).
 *  `pg_available_extensions` exposes name / default_version / installed_version
 *  / comment — there's no `installed` boolean, so "installed" is derived from
 *  `installed_version` being non-null. */
export interface AvailableExtension {
  name: string;
  defaultVersion: string;
  installed: boolean;
  comment: string;
}

export async function fetchAvailableExtensions(config: DatabaseConnection, engine: string): Promise<AvailableExtension[]> {
  if (!isPostgresFamily(engine)) return [];
  const sql = `SELECT name, default_version, installed_version, comment FROM pg_available_extensions ORDER BY name;`;
  const result = await safeInvoke<QueryPayload>('execute_query', {
    request: { config, sql },
    queryId: `ext_avail_${Date.now()}`,
    __meta: { source: 'introspection' },
  });
  return result.rows.map((row) => ({
    name: str(row[0]),
    defaultVersion: str(row[1]),
    installed: !!str(row[2]), // installed_version non-empty ⇒ installed
    comment: str(row[3]),
  }));
}

/** SQL to install / uninstall an extension (Postgres). Identifier is a name,
 *  never user free-text, so it's safe to interpolate (pg extension names are
 *  restricted to [a-z0-9_]). */
export function createExtensionSql(name: string): string {
  return `CREATE EXTENSION IF NOT EXISTS "${name.replace(/"/g, '')}";`;
}
export function dropExtensionSql(name: string): string {
  return `DROP EXTENSION IF EXISTS "${name.replace(/"/g, '')}";`;
}

