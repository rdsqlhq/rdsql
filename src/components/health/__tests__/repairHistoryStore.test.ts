import { describe, it, expect, beforeEach } from 'vitest';
import { useRepairHistoryStore, buildHistoryEntry } from '../../../store/useRepairHistoryStore';
import { RepairResult } from '../../../core/domain/health';

// Reset the persisted store between tests so they don't leak state.
beforeEach(() => {
  useRepairHistoryStore.setState({ entries: [] });
  localStorage.clear();
});

const okResult: RepairResult = {
  diagnosticId: 'd1',
  success: true,
  executedSql: ['VACUUM;'],
  affectedRows: 0,
  durationMs: 42,
  verification: 'ok',
};

const errResult: RepairResult = {
  diagnosticId: 'd2',
  success: false,
  executedSql: ['REINDEX idx_x;'],
  affectedRows: 0,
  durationMs: 10,
  error: 'permission denied',
};

describe('buildHistoryEntry', () => {
  it('builds a success entry from a successful result', () => {
    const entry = buildHistoryEntry({
      connectionId: 'conn1',
      connectionName: 'My DB',
      engine: 'postgres',
      operation: 'VACUUM',
      affectedObjects: ['public.orders'],
      result: okResult,
    });
    expect(entry.result).toBe('success');
    expect(entry.sql).toEqual(['VACUUM;']);
    expect(entry.errorMessage).toBeUndefined();
    expect(entry.connectionId).toBe('conn1');
    // No credential fields exist on the entry shape.
    expect((entry as any).password).toBeUndefined();
  });

  it('builds an error entry from a failed result', () => {
    const entry = buildHistoryEntry({
      connectionId: 'conn1',
      connectionName: 'My DB',
      engine: 'mysql',
      operation: 'REINDEX',
      affectedObjects: [],
      result: errResult,
    });
    expect(entry.result).toBe('error');
    expect(entry.errorMessage).toBe('permission denied');
  });
});

describe('useRepairHistoryStore', () => {
  it('appends entries and keeps newest-first', () => {
    const { addEntry } = useRepairHistoryStore.getState();
    addEntry(buildHistoryEntry({ connectionId: 'c1', connectionName: 'A', engine: 'postgres', operation: 'op1', affectedObjects: [], result: okResult }));
    addEntry(buildHistoryEntry({ connectionId: 'c2', connectionName: 'B', engine: 'mysql', operation: 'op2', affectedObjects: [], result: okResult }));
    const entries = useRepairHistoryStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].operation).toBe('op2'); // newest first
  });

  it('forConnection filters by connection', () => {
    const store = useRepairHistoryStore.getState();
    store.addEntry(buildHistoryEntry({ connectionId: 'c1', connectionName: 'A', engine: 'postgres', operation: 'op1', affectedObjects: [], result: okResult }));
    store.addEntry(buildHistoryEntry({ connectionId: 'c2', connectionName: 'B', engine: 'mysql', operation: 'op2', affectedObjects: [], result: okResult }));
    expect(useRepairHistoryStore.getState().forConnection('c1')).toHaveLength(1);
    expect(useRepairHistoryStore.getState().forConnection('c2')).toHaveLength(1);
    expect(useRepairHistoryStore.getState().forConnection('c3')).toHaveLength(0);
  });

  it('caps the log at a maximum', () => {
    const store = useRepairHistoryStore.getState();
    for (let i = 0; i < 550; i++) {
      store.addEntry(buildHistoryEntry({ connectionId: 'c1', connectionName: 'A', engine: 'postgres', operation: `op${i}`, affectedObjects: [], result: okResult }));
    }
    expect(useRepairHistoryStore.getState().entries.length).toBeLessThanOrEqual(500);
  });

  it('clear empties the log', () => {
    const store = useRepairHistoryStore.getState();
    store.addEntry(buildHistoryEntry({ connectionId: 'c1', connectionName: 'A', engine: 'postgres', operation: 'op', affectedObjects: [], result: okResult }));
    useRepairHistoryStore.getState().clear();
    expect(useRepairHistoryStore.getState().entries).toHaveLength(0);
  });
});
