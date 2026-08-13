/**
 * Build a compact text summary of the active database schema to send to the LLM
 * as context. We never send credentials — only engine name + table/column
 * metadata (names, types, PK/FK/nullable flags, row counts).
 *
 * Sources, in priority order:
 *  1. The active tab's `erdSchema` (a focused per-schema table bundle) — used
 *     when the user is on an ERD tab.
 *  2. The active connection's `schemaTreeByConn` cache (the full tree the
 *     Explorer populates), optionally narrowed to `activeDatabaseByConn`.
 *
 * Output is capped so prompts stay within typical context windows. When no
 * connection / no schema is loaded we return an empty string and the model is
 * asked to answer generically.
 */
import type {
  DatabaseConnection,
  DatabaseEngine,
  SchemaColumnNode,
  SchemaGroupNode,
  SchemaTableNode,
} from '../domain/types';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useTabStore } from '../../store/useTabStore';

/** Soft cap on the generated context. ~6k chars ≈ ~1.5k tokens, leaving plenty
 *  of room for the system prompt + the model's response. */
const MAX_CONTEXT_CHARS = 6000;

/** Render one column compactly: `email TEXT not null pk`. */
function renderColumn(col: SchemaColumnNode): string {
  const parts: string[] = [col.name];
  if (col.data_type) parts.push(col.data_type);
  if (col.is_nullable === false) parts.push('not null');
  if (col.is_primary_key) parts.push('pk');
  if (col.is_foreign_key) parts.push('fk');
  if (col.has_default) parts.push('default');
  return parts.join(' ');
}

/** Render one table: `public.users (id BIGINT pk, email TEXT not null, ...)`. */
function renderTable(
  qualifiedName: string,
  table: SchemaTableNode,
): string {
  const cols = (table.children || []).map(renderColumn).join(', ');
  const meta: string[] = [];
  if (table.node_type === 'view') meta.push('view');
  if (typeof table.row_count === 'number' && table.row_count >= 0) {
    meta.push(`~${table.row_count.toLocaleString()} rows`);
  }
  const metaStr = meta.length ? `  [${meta.join('; ')}]` : '';
  return `${qualifiedName} (${cols})${metaStr}`;
}

/** Flatten a `SchemaGroupNode[]` tree into lines, qualifying each table with
 *  its parent group name. Stops once we hit the char cap. */
function flattenTree(
  tree: SchemaGroupNode[],
  maxChars: number,
): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const group of tree) {
    const groupPrefix = group.name ? `${group.name}.` : '';
    for (const table of group.children || []) {
      const line = renderTable(`${groupPrefix}${table.name}`, table);
      if (used + line.length + 1 > maxChars) {
        lines.push('…(schema truncated — more tables omitted)');
        return lines;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  return lines;
}

/** Flatten a bare `SchemaTableNode[]` (the ERD tab's focused bundle). */
function flattenTables(
  tables: SchemaTableNode[],
  schemaName: string | undefined,
  maxChars: number,
): string[] {
  const prefix = schemaName ? `${schemaName}.` : '';
  const lines: string[] = [];
  let used = 0;
  for (const table of tables) {
    const line = renderTable(`${prefix}${table.name}`, table);
    if (used + line.length + 1 > maxChars) {
      lines.push('…(schema truncated — more tables omitted)');
      return lines;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

export interface BuildContextResult {
  /** The schema summary text (may be empty). */
  text: string;
  /** Engine of the active connection, if any. */
  engine?: DatabaseEngine;
  /** Active database name, if any. */
  database?: string;
  /** Server version banner, if the connection has been tested this session
   *  (see `useConnectionStore.serverVersionByConn`). Lets the AI target the
   *  exact engine version instead of just the family (e.g. distinguishing
   *  SQL Server's `OFFSET...FETCH` from an older syntax). */
  serverVersion?: string;
}

/**
 * Gather the active schema context for an AI request. Reads current store
 * state synchronously — safe to call from the AI store's `sendMessage`.
 */
export function buildSchemaContext(): BuildContextResult {
  const connState = useConnectionStore.getState();
  const { activeConnectionId, connections, schemaTreeByConn, activeDatabaseByConn, serverVersionByConn } = connState;
  const tabState = useTabStore.getState();

  const activeConn = activeConnectionId
    ? connections.find((c) => c.id === activeConnectionId)
    : undefined;
  const serverVersion = activeConnectionId ? serverVersionByConn[activeConnectionId] : undefined;

  let tableLines: string[] = [];
  let database: string | undefined;

  // 1) Prefer the active tab's focused ERD schema bundle (narrowest, most
  //    relevant when the user is looking at one schema).
  const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);
  const erdTables = activeTab?.erdSchema?.tables;
  if (erdTables && erdTables.length > 0) {
    database = activeTab?.erdSchema?.schemaName;
    tableLines = flattenTables(erdTables, database, MAX_CONTEXT_CHARS);
  } else if (activeConnectionId) {
    // 2) Fall back to the connection's cached tree, optionally narrowed to the
    //    currently-selected database group.
    const tree = schemaTreeByConn[activeConnectionId] || [];
    database = activeDatabaseByConn[activeConnectionId] || activeConn?.database;
    const narrowed =
      database && tree.length > 1
        ? tree.filter((g) => g.name === database)
        : tree;
    tableLines = flattenTree(narrowed, MAX_CONTEXT_CHARS);
  }

  if (tableLines.length === 0) {
    return {
      text: '',
      engine: activeConn?.engine,
      database,
      serverVersion,
    };
  }

  const headerParts: string[] = [];
  if (database) headerParts.push(`database: ${database}`);
  if (activeConn?.engine) headerParts.push(`engine: ${activeConn.engine}`);
  const header = headerParts.length ? headerParts.join('  •  ') + '\n' : '';

  return {
    text: header + tableLines.join('\n'),
    engine: activeConn?.engine,
    database,
    serverVersion,
  };
}

/** The resolved execution target for AI-run SQL. Shared by the Run and
 *  AI-Fix flows so both pick the same connection + database the editor would
 *  use if the user pressed Run right now. */
export interface ActiveTarget {
  connection: DatabaseConnection | undefined;
  connectionId: string | undefined;
  /** Schema/database name to bind the new tab to. */
  schemaName: string | undefined;
  /** Effective database name for display (schema override or connection db). */
  database: string | undefined;
}

/**
 * Resolve the active connection + database the AI should target when running
 * or fixing SQL. Follows the same precedence as `executeQuery` in useTabStore:
 * the active tab's own connection/schema wins, falling back to the global
 * active connection + its selected database group.
 */
export function getActiveTarget(): ActiveTarget {
  const connState = useConnectionStore.getState();
  const { connections, activeConnectionId, activeDatabaseByConn } = connState;
  const tabState = useTabStore.getState();
  const activeTab = tabState.tabs.find((t) => t.id === tabState.activeTabId);

  const connectionId = activeTab?.connectionId ?? activeConnectionId ?? undefined;
  const connection = connectionId
    ? connections.find((c) => c.id === connectionId)
    : undefined;

  const schemaName =
    activeTab?.schemaName ??
    (connectionId ? activeDatabaseByConn[connectionId] : undefined) ??
    undefined;
  const database = schemaName || connection?.database;

  return { connection, connectionId, schemaName, database };
}
