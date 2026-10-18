import { safeInvoke } from '../tauri/ipc';
import { engineFamily } from '../connection/engines';
import type { BatchItem } from './batch';

/** One staged grid change, ready to run. */
export interface GridChange {
  kind: 'insert' | 'update' | 'delete';
  sql: string;
  label?: string;
  /** `SELECT COUNT(*)` with the same WHERE as `sql`. When set, the change
   *  only runs if it matches exactly one row. Used when the row can't be
   *  identified by a full primary key. */
  guardSql?: string;
}

export interface ApplyOutcome {
  error?: string;
  /** UPDATE/DELETE statements that matched no row. */
  unmatched: number;
}

function beginStatement(engine: string): string | null {
  const e = engine.toLowerCase();
  if (e === 'cloudflare-d1' || e === 'd1') return null; // D1 has no client transactions
  switch (engineFamily(engine)) {
    case 'mysql':
      return 'START TRANSACTION';
    case 'mssql':
      return 'BEGIN TRANSACTION';
    default:
      return 'BEGIN';
  }
}

/**
 * Runs grid changes all-or-nothing: guards first, then every change inside
 * one transaction on one connection. If any statement fails, the connection
 * closes before COMMIT and the server rolls the whole set back.
 */
export async function applyGridChanges(
  config: { engine: string },
  changes: GridChange[],
  queryIdPrefix: string,
): Promise<ApplyOutcome> {
  if (changes.length === 0) return { unmatched: 0 };

  const guarded = changes.filter((c) => c.guardSql);
  if (guarded.length > 0) {
    const items = await safeInvoke<BatchItem[]>('execute_batch', {
      request: { config, statements: guarded.map((c) => c.guardSql) },
      queryId: `${queryIdPrefix}_guard_${Date.now()}`,
      __meta: { source: 'table' },
    });
    for (const [i, change] of guarded.entries()) {
      const item = items[i];
      if (!item || item.error) return { error: item?.error ?? 'Could not check the rows to change.', unmatched: 0 };
      const count = Number(item.result?.rows?.[0]?.[0] ?? 0);
      if (count !== 1) {
        return {
          error:
            `Nothing was saved: a ${change.kind} on ${change.label ?? 'this table'} matches ${count} rows, not 1. ` +
            'The row has no unique key in this result, so it cannot be told apart from the others. ' +
            'Include the primary key in the SELECT, or add one to the table.',
          unmatched: 0,
        };
      }
    }
  }

  const begin = beginStatement(config.engine);
  const statements = begin ? [begin, ...changes.map((c) => c.sql), 'COMMIT'] : changes.map((c) => c.sql);
  const items = await safeInvoke<BatchItem[]>('execute_batch', {
    request: { config, statements },
    queryId: `${queryIdPrefix}_${Date.now()}`,
    __meta: { source: 'table' },
  });

  const failed = items.find((it) => it.error);
  if (failed) {
    return {
      error: begin ? `${failed.error}\n\nNo changes were saved (the transaction was rolled back).` : failed.error ?? undefined,
      unmatched: 0,
    };
  }

  const offset = begin ? 1 : 0;
  let unmatched = 0;
  changes.forEach((c, i) => {
    if ((c.kind === 'update' || c.kind === 'delete') && items[i + offset]?.result?.affected_rows === 0) unmatched++;
  });
  return { unmatched };
}
