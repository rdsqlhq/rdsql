import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  GitCompare,
  CheckCircle2,
  Database,
  Plus,
  Minus,
  AlertTriangle,
  RefreshCw,
  Loader2,
  Table as TableIcon,
  ShieldAlert,
  KeyRound,
} from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useToastStore } from '../../store/useToastStore';
import { safeInvoke } from '../../core/tauri/ipc';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { cn } from '../../core/utils/cn';
import { SchemaCompareView } from './SchemaCompareView';
import { summarizeStatements } from '../../core/compare/diffModel';
import type {
  SchemaDiffResult,
  DataDiffResult,
  SyncScript,
  SyncStatement,
  ApplyResult,
  DatabaseConnection,
  SchemaGroupNode,
} from '../../core/domain/types';

type Tab = 'schema' | 'data';

/** Human label for a connection — engine + database/file, with a fallback.
 *  Honors `scopeDatabase` so the compare tool shows the picked DB. */
function connLabel(c: DatabaseConnection): string {
  const db = effectiveDatabase(c);
  if (c.engine === 'sqlite') {
    const base = c.filePath ? c.filePath.split(/[\\/]/).pop() : db;
    return `${c.name} (${base ?? 'sqlite'})`;
  }
  if (c.engine === 'cloudflare-d1') {
    return `${c.name} (D1)`;
  }
  return `${c.name} (${db ?? c.engine})`;
}

/** Normalize engine names to a canonical family so mysql ≡ mariadb and
 *  postgres ≡ postgresql. Mirrors `normalize_engine` in compare.rs. */
function normalizeEngine(engine: string): string {
  const e = engine.toLowerCase();
  if (e === 'postgresql') return 'postgres';
  if (e === 'mariadb') return 'mysql';
  return e;
}

/** The effective database the compare tool operates on: prefer the explicitly
 *  picked `scopeDatabase`, otherwise the connection's `database`. */
function effectiveDatabase(c: DatabaseConnection | undefined): string | undefined {
  if (!c) return undefined;
  return c.scopeDatabase || c.database;
}

/** Compute the confirmation token the backend expects for a target. Mirrors
 *  `expected_confirm_token` in compare.rs so the type-to-confirm prompt shows
 *  the right string. */
export function expectedConfirmToken(c: DatabaseConnection): string {
  if (c.engine === 'sqlite') {
    const base = c.filePath ? c.filePath.split(/[\\/]/).pop() : '';
    return base ? base.replace(/\.\w+$/, '') : (c.filePath ?? '');
  }
  if (c.engine === 'cloudflare-d1') {
    return c.cfDatabaseId ?? 'd1';
  }
  return effectiveDatabase(c) ?? c.name;
}

/** Detect a "production-like" target so we can surface a red warning. The
 *  backend never blocks, but the UI should make the danger loud. */
function looksLikeProduction(c: DatabaseConnection | undefined): boolean {
  if (!c) return false;
  const db = effectiveDatabase(c);
  const hay = `${c.name} ${db ?? ''} ${c.tagId ?? ''}`.toLowerCase();
  return hay.includes('prod');
}

/** Compact connection + database picker for one side of the comparison. */
const DbPicker: React.FC<{
  role: 'source' | 'target';
  connections: DatabaseConnection[];
  connectionId: string;
  onConnectionChange: (id: string) => void;
  databases: string[];
  database: string;
  onDatabaseChange: (db: string) => void;
  loading: boolean;
  engine: string;
  badge?: React.ReactNode;
}> = ({
  role,
  connections,
  connectionId,
  onConnectionChange,
  databases,
  database,
  onDatabaseChange,
  loading,
  engine,
  badge,
}) => {
  const isSource = role === 'source';
  const select =
    'bg-[#0f172a] border border-[#1e293b] rounded-lg text-[11px] text-slate-200 px-2 py-1 max-w-[190px] focus:outline-none ' +
    (isSource ? 'focus:border-cyan-500/50' : 'focus:border-amber-500/50');

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Database className={cn('w-3.5 h-3.5 shrink-0', isSource ? 'text-cyan-400' : 'text-amber-400')} />
      <span
        className={cn(
          'text-[10px] font-bold uppercase tracking-wider shrink-0',
          isSource ? 'text-cyan-400' : 'text-amber-400'
        )}
        title={isSource ? 'Read only — never written to' : 'A sync writes here'}
      >
        {isSource ? 'Source' : 'Target'}
      </span>
      <select
        value={connectionId}
        onChange={(e) => onConnectionChange(e.target.value)}
        aria-label={`${role} connection`}
        className={select}
      >
        {connections.length === 0 && <option value="">No connections</option>}
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {connLabel(c)}
          </option>
        ))}
      </select>
      {/* Only multi-database engines (mysql/mariadb) need a second picker. */}
      {databases.length > 0 && (
        <select
          value={database}
          onChange={(e) => onDatabaseChange(e.target.value)}
          aria-label={`${role} database`}
          className={select}
        >
          {databases.map((db) => (
            <option key={db} value={db}>
              {db}
            </option>
          ))}
        </select>
      )}
      {loading && <Loader2 className="w-3 h-3 animate-spin text-slate-500 shrink-0" />}
      {engine && (
        <span className="text-[9px] font-bold text-slate-600 uppercase tracking-wider shrink-0">
          {engine}
        </span>
      )}
      {badge}
    </div>
  );
};

const Notice: React.FC<{ tone: 'danger' | 'warning'; children: React.ReactNode }> = ({
  tone,
  children,
}) => (
  <div
    className={cn(
      'flex items-center gap-2 text-[11px] rounded-lg px-3 py-1.5 border',
      tone === 'danger'
        ? 'text-rose-300 bg-rose-500/5 border-rose-500/20'
        : 'text-amber-300 bg-amber-500/5 border-amber-500/20'
    )}
  >
    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
    <span>{children}</span>
  </div>
);

export const MigrationStudio: React.FC = () => {
  const { connections } = useConnectionStore();
  const pushToast = useToastStore((s) => s.push);

  // --- source / target selection -------------------------------------------
  const [sourceId, setSourceId] = useState<string>(connections[0]?.id ?? '');
  const [targetId, setTargetId] = useState<string>(connections[1]?.id ?? connections[0]?.id ?? '');

  // Per-side database picker state. Engines where one connection maps to many
  // databases (MySQL/MariaDB) show a second dropdown; single-DB engines
  // (postgres, sqlite, d1) don't.
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
  const [sourceDbLoading, setSourceDbLoading] = useState(false);
  const [sourceDbName, setSourceDbName] = useState('');
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [targetDbLoading, setTargetDbLoading] = useState(false);
  const [targetDbName, setTargetDbName] = useState('');

  const source = connections.find((c) => c.id === sourceId);
  const target = connections.find((c) => c.id === targetId);

  // Compare & sync require the same engine family. Guard in the UI as well as
  // the backend so the user gets immediate feedback when picking connections.
  const sourceEngine = source ? normalizeEngine(source.engine) : '';
  const targetEngine = target ? normalizeEngine(target.engine) : '';
  const engineMismatch = !!source && !!target && sourceEngine !== targetEngine;
  const sameDb = sourceId !== '' && sourceId === targetId;
  const canCompare = !!source && !!target && !sameDb && !engineMismatch;

  // Load the list of databases for the picked source connection.
  useEffect(() => {
    if (!source) {
      setSourceDatabases([]);
      setSourceDbName('');
      return;
    }
    if (source.engine === 'sqlite' || source.engine === 'cloudflare-d1') {
      setSourceDatabases([]);
      setSourceDbName(source.database || '');
      return;
    }
    let cancelled = false;
    setSourceDbLoading(true);
    (async () => {
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', { config: source });
        if (cancelled) return;
        const dbNames = (tree || []).map((g) => g.name);
        setSourceDatabases(dbNames);
        setSourceDbName(dbNames[0] ?? '');
      } catch {
        if (!cancelled) setSourceDatabases([]);
      } finally {
        if (!cancelled) setSourceDbLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sourceId, source]);

  // Load the list of databases for the picked target connection.
  useEffect(() => {
    if (!target) {
      setTargetDatabases([]);
      setTargetDbName('');
      return;
    }
    if (target.engine === 'sqlite' || target.engine === 'cloudflare-d1') {
      setTargetDatabases([]);
      setTargetDbName(target.database || '');
      return;
    }
    let cancelled = false;
    setTargetDbLoading(true);
    (async () => {
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', { config: target });
        if (cancelled) return;
        const dbNames = (tree || []).map((g) => g.name);
        setTargetDatabases(dbNames);
        setTargetDbName(dbNames[0] ?? '');
      } catch {
        if (!cancelled) setTargetDatabases([]);
      } finally {
        if (!cancelled) setTargetDbLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [targetId, target]);

  /** Build the effective config for an IPC call: clone the connection and set
   *  `scopeDatabase` to the picked DB (multi-DB engines only). */
  const withScope = (conn: DatabaseConnection | undefined, dbName: string): DatabaseConnection | undefined => {
    if (!conn) return undefined;
    if (conn.engine === 'sqlite' || conn.engine === 'cloudflare-d1') return conn;
    return { ...conn, scopeDatabase: dbName || undefined };
  };

  const [tab, setTab] = useState<Tab>('schema');

  // --- schema compare state -------------------------------------------------
  const [schemaDiff, setSchemaDiff] = useState<SchemaDiffResult | null>(null);
  const [comparingSchema, setComparingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // --- data compare state ---------------------------------------------------
  const [dataDiff, setDataDiff] = useState<DataDiffResult | null>(null);
  const [comparingData, setComparingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataTable, setDataTable] = useState('');

  // --- sync state -----------------------------------------------------------
  const [syncScript, setSyncScript] = useState<SyncScript | null>(null);
  const [generatingSync, setGeneratingSync] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  /** The exact statement subset the user chose to apply. Defaults to the whole
   *  generated script; the compare view narrows it when changes are excluded. */
  const [pendingStatements, setPendingStatements] = useState<SyncStatement[]>([]);
  /** Bumped to ask the compare view to open its SQL Preview tab (the
   *  "Review SQL" escape hatch in the confirmation dialog). */
  const [reviewSignal, setReviewSignal] = useState(0);

  // Tables that exist in both DBs (candidates for data compare). Derived from
  // the schema diff when present.
  const commonTables = useMemo(() => {
    if (!schemaDiff) return [];
    return schemaDiff.tables
      .filter((t) => t.status === 'unchanged' || t.status === 'modified')
      .map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name));
  }, [schemaDiff]);

  const runSchemaCompare = async () => {
    const src = withScope(source, sourceDbName);
    const tgt = withScope(target, targetDbName);
    if (!src || !tgt) return;
    setComparingSchema(true);
    setSchemaError(null);
    setSchemaDiff(null);
    setSyncScript(null);
    setApplyResult(null);
    try {
      const res = await safeInvoke<SchemaDiffResult>('compare_schema', {
        source: src,
        target: tgt,
      });
      setSchemaDiff(res);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setSchemaError(msg);
      pushToast({ severity: 'error', title: 'Schema compare failed', message: msg });
    } finally {
      setComparingSchema(false);
    }
  };

  const runDataCompare = async () => {
    const src = withScope(source, sourceDbName);
    const tgt = withScope(target, targetDbName);
    if (!src || !tgt || !dataTable) return;
    setComparingData(true);
    setDataError(null);
    setDataDiff(null);
    try {
      // Split "schema.table" back out so the backend can qualify the query.
      const dot = dataTable.indexOf('.');
      const schema = dot >= 0 ? dataTable.slice(0, dot) : null;
      const table = dot >= 0 ? dataTable.slice(dot + 1) : dataTable;
      const res = await safeInvoke<DataDiffResult>('compare_table_data', {
        source: src,
        target: tgt,
        schema,
        table,
      });
      setDataDiff(res);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setDataError(msg);
      pushToast({ severity: 'error', title: 'Data compare failed', message: msg });
    } finally {
      setComparingData(false);
    }
  };

  const generateSync = async () => {
    const src = withScope(source, sourceDbName);
    const tgt = withScope(target, targetDbName);
    if (!src || !tgt) return;
    setGeneratingSync(true);
    setSyncError(null);
    setSyncScript(null);
    setApplyResult(null);
    try {
      const res = await safeInvoke<SyncScript>('generate_schema_sync_sql', {
        source: src,
        target: tgt,
      });
      setSyncScript(res);
      if (res.warnings.length > 0) {
        pushToast({
          severity: 'warning',
          title: 'Sync script generated with warnings',
          message: `${res.warnings.length} warning(s) — review before applying.`,
        });
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setSyncError(msg);
      pushToast({ severity: 'error', title: 'Sync script generation failed', message: msg });
    } finally {
      setGeneratingSync(false);
    }
  };

  const applySync = async () => {
    const tgt = withScope(target, targetDbName);
    if (!tgt || !syncScript || pendingStatements.length === 0) return;
    setApplying(true);
    try {
      const token = expectedConfirmToken(tgt);
      const res = await safeInvoke<ApplyResult>('apply_schema_sync', {
        target: tgt,
        // Only the reviewed subset is sent. The SQL itself is the backend's
        // generated text, untouched.
        statements: pendingStatements,
        confirmToken: token,
      });
      setApplyResult(res);
      if (res.failed === 0) {
        pushToast({
          severity: 'success',
          title: 'Sync applied',
          message: `${res.applied} statement(s) applied in ${res.durationMs}ms.`,
        });
      } else {
        pushToast({
          severity: 'warning',
          title: 'Sync partially applied',
          message: `${res.applied} succeeded, ${res.failed} failed.`,
        });
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setSyncError(msg);
      pushToast({ severity: 'error', title: 'Sync apply failed', message: msg });
    } finally {
      setApplying(false);
      setConfirmOpen(false);
    }
  };

  /** Open the confirmation gate for a reviewed statement subset. */
  const requestApply = (statements: SyncStatement[]) => {
    if (statements.length === 0) return;
    setPendingStatements(statements);
    setConfirmOpen(true);
  };

  const scopedTarget = withScope(target, targetDbName);
  const targetIsProd = looksLikeProduction(scopedTarget);
  const expectedToken = scopedTarget ? expectedConfirmToken(scopedTarget) : '';
  const pendingSummary = useMemo(() => summarizeStatements(pendingStatements), [pendingStatements]);
  const pendingObjects = useMemo(
    () => new Set(pendingStatements.filter((s) => s.operation === 'droptable').map((s) => s.targetObject)).size,
    [pendingStatements]
  );

  const sourceLabel = source ? (sourceDbName || effectiveDatabase(source) || source.name) : '—';
  const targetLabel = target ? (targetDbName || effectiveDatabase(target) || target.name) : '—';
  const blockedReason = engineMismatch
    ? `Source is ${sourceEngine} and target is ${targetEngine}. Compare & sync require the same engine on both sides.`
    : sameDb
    ? 'Source and target are the same connection. Pick two different connections to compare.'
    : connections.length === 0
    ? 'No connections configured yet. Add a database connection first.'
    : undefined;

  return (
    <div className="w-full h-full bg-[#06090e] flex flex-col overflow-hidden select-none">
      {/* ----------------------------------------------------------------- */}
      {/* Header — who compares with whom, and which view                    */}
      {/* ----------------------------------------------------------------- */}
      <div className="px-4 py-2 border-b border-[#1e293b] shrink-0 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
            <ArrowLeftRight className="w-4 h-4 text-blue-400" />
            Compare &amp; Sync
          </h2>

          {/* Source → Target on one line. The direction is the safety model. */}
          <DbPicker
            role="source"
            connections={connections}
            connectionId={sourceId}
            onConnectionChange={setSourceId}
            databases={sourceDatabases}
            database={sourceDbName}
            onDatabaseChange={setSourceDbName}
            loading={sourceDbLoading}
            engine={sourceEngine}
          />

          <ArrowRight className="w-4 h-4 text-cyan-500 shrink-0" />

          <DbPicker
            role="target"
            connections={connections}
            connectionId={targetId}
            onConnectionChange={setTargetId}
            databases={targetDatabases}
            database={targetDbName}
            onDatabaseChange={setTargetDbName}
            loading={targetDbLoading}
            engine={targetEngine}
            badge={
              targetIsProd ? (
                <span className="flex items-center gap-1 text-[10px] font-bold text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-1.5 py-0.5">
                  <ShieldAlert className="w-3 h-3" />
                  PROD
                </span>
              ) : undefined
            }
          />

          {/* View switch */}
          <div className="ml-auto flex items-center gap-0.5 bg-[#0a0f18] border border-[#1e293b] rounded-lg p-0.5">
            {(
              [
                { id: 'schema' as const, label: 'Tables', Icon: GitCompare },
                { id: 'data' as const, label: 'Row data', Icon: TableIcon },
              ]
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                disabled={!canCompare}
                aria-pressed={tab === t.id}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors',
                  tab === t.id ? 'bg-cyan-600/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200',
                  !canCompare && 'opacity-40 cursor-not-allowed'
                )}
              >
                <t.Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* At most one line of guidance, and only when it matters. */}
        {engineMismatch ? (
          <Notice tone="danger">
            Both sides must use the same engine. Source is <b>{sourceEngine}</b>, target is{' '}
            <b>{targetEngine}</b>.
          </Notice>
        ) : sameDb ? (
          <Notice tone="warning">
            Source and target are the same connection — pick two different ones.
          </Notice>
        ) : targetIsProd ? (
          <Notice tone="danger">
            The target looks like production. A sync modifies it; you'll have to type its name to
            confirm.
          </Notice>
        ) : null}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Tab content                                                       */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'schema' && (
          <SchemaCompareView
            canCompare={canCompare}
            blockedReason={blockedReason}
            comparing={comparingSchema}
            error={schemaError}
            diff={schemaDiff}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
            targetIsProd={targetIsProd}
            onCompare={runSchemaCompare}
            syncScript={syncScript}
            generatingSync={generatingSync}
            syncError={syncError}
            applyResult={applyResult}
            onGenerateSync={generateSync}
            onApply={requestApply}
            applying={applying}
            focusSqlSignal={reviewSignal}
          />
        )}
        {tab === 'data' && (
          <div className="h-full overflow-y-auto px-4 py-4">
          <DataCompareTab
            canCompare={canCompare}
            comparing={comparingData}
            error={dataError}
            diff={dataDiff}
            commonTables={commonTables}
            selectedTable={dataTable}
            onSelectTable={(t) => setDataTable(t)}
            onCompare={runDataCompare}
            hasSchemaDiff={!!schemaDiff}
          />
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Apply confirmation (safety gate)                                  */}
      {/* ----------------------------------------------------------------- */}
      {confirmOpen && scopedTarget && (
        <ConfirmDialog
          title="Confirm schema sync"
          tone="danger"
          confirmLabel={applying ? 'Applying…' : 'Apply Sync'}
          loading={applying}
          requireText={expectedToken}
          requireTextLabel={`Type the target database name to confirm (${expectedToken})`}
          message={
            <>
              Target: <span className="font-semibold text-slate-200">{connLabel(scopedTarget)}</span>.
              {' '}This will execute <span className="font-semibold text-slate-200">{pendingStatements.length}</span> reviewed DDL statement(s).
              {' '}The source database will not be touched. This cannot be undone.
            </>
          }
          onClose={() => setConfirmOpen(false)}
          onConfirm={applySync}
        >
          {/* Statement breakdown — the numbers come from the script itself. */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-[#06090e] border border-[#1e293b] rounded-lg px-2.5 py-1.5">
              <div className="text-emerald-400 font-bold">{pendingSummary.create}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Create</div>
            </div>
            <div className="bg-[#06090e] border border-[#1e293b] rounded-lg px-2.5 py-1.5">
              <div className="text-amber-400 font-bold">{pendingSummary.alter}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Alter</div>
            </div>
            <div className="bg-[#06090e] border border-[#1e293b] rounded-lg px-2.5 py-1.5">
              <div className="text-rose-400 font-bold">{pendingSummary.drop}</div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider">Drop</div>
            </div>
          </div>

          {pendingSummary.destructive > 0 && (
            <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-rose-200">This sync contains destructive changes</div>
                <div className="mt-0.5">
                  − {pendingSummary.destructive} DROP statement{pendingSummary.destructive === 1 ? '' : 's'}
                  {pendingObjects > 0 && <> · − {pendingObjects} object{pendingObjects === 1 ? '' : 's'} dropped entirely</>}
                </div>
                <div className="text-rose-300/80 mt-0.5">
                  These may permanently remove database objects and their data.
                </div>
              </div>
            </div>
          )}

          <button
            onClick={() => {
              setConfirmOpen(false);
              setReviewSignal((n) => n + 1);
            }}
            className="w-full px-3 py-1.5 rounded-lg border border-[#1e293b] bg-[#06090e] hover:border-cyan-500/50 text-xs font-medium text-slate-300 transition-colors"
          >
            Review SQL first
          </button>

          {targetIsProd && (
            <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                You are about to modify a database that looks like production. Double-check the target connection.
              </span>
            </div>
          )}
          {syncScript && syncScript.warnings.length > 0 && (
            <div className="space-y-1 text-xs text-amber-300 bg-amber-500/5 border border-amber-500/20 rounded-lg p-2.5">
              {syncScript.warnings.slice(0, 5).map((w, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>{w}</span>
                </div>
              ))}
              {syncScript.warnings.length > 5 && (
                <div className="text-slate-400">…and {syncScript.warnings.length - 5} more.</div>
              )}
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
};

const SummaryStat: React.FC<{
  label: string;
  value: number;
  cls: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = ({ label, value, cls, Icon }) => (
  <div className="flex items-center gap-2 bg-[#0a0f18] border border-[#1e293b] rounded-lg px-3 py-2">
    <Icon className={cn('w-4 h-4', cls)} />
    <div>
      <div className={cn('text-base font-bold leading-none', cls)}>{value}</div>
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{label}</div>
    </div>
  </div>
);

// ===========================================================================
// Data Compare Tab
// ===========================================================================

interface DataCompareTabProps {
  canCompare: boolean;
  comparing: boolean;
  error: string | null;
  diff: DataDiffResult | null;
  commonTables: string[];
  selectedTable: string;
  onSelectTable: (t: string) => void;
  onCompare: () => void;
  hasSchemaDiff: boolean;
}

const DataCompareTab: React.FC<DataCompareTabProps> = ({
  canCompare,
  comparing,
  error,
  diff,
  commonTables,
  selectedTable,
  onSelectTable,
  onCompare,
  hasSchemaDiff,
}) => {
  if (!canCompare) {
    return <EmptyHint text="Select a source and a different target database to begin." />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        {commonTables.length > 0 ? (
          <div className="flex-1">
            <label className="block text-[11px] text-slate-400 mb-1">Table (common to both DBs)</label>
            <select
              value={selectedTable}
              onChange={(e) => onSelectTable(e.target.value)}
              className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-xs text-slate-200 p-2 focus:outline-none focus:border-cyan-500/50"
            >
              <option value="">Select a table…</option>
              {commonTables.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex-1">
            <label className="block text-[11px] text-slate-400 mb-1">
              Table name {!hasSchemaDiff && '(run Schema Compare first to pick from common tables)'}
            </label>
            <input
              type="text"
              value={selectedTable}
              onChange={(e) => onSelectTable(e.target.value)}
              placeholder="e.g. users"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-xs text-slate-200 p-2 font-mono focus:outline-none focus:border-cyan-500/50"
            />
          </div>
        )}

        <button
          onClick={onCompare}
          disabled={comparing || !selectedTable}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold shadow-lg shadow-blue-600/30 transition-all"
        >
          {comparing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {comparing ? 'Comparing…' : 'Compare Data'}
        </button>
      </div>

      {error && <ErrorBanner message={error} />}

      {diff && (
        <DataDiffResultView diff={diff} />
      )}
    </div>
  );
};

/** A single unified record row, regardless of which diff bucket it came
 *  from. `status` classifies it so the table can badge + color it. */
type UnifiedRow = {
  key: string | null;
  sourceRow?: (string | number | boolean | null)[];
  targetRow?: (string | number | boolean | null)[];
  status: 'same' | 'different' | 'source' | 'target';
};

/** Merge the backend's three buckets into one row list, sorted so that the
 *  PK key stays in a stable order (rows present in both keep their relative
 *  order; only-source and only-target rows fall to the end grouped by key). */
function mergeRows(diff: DataDiffResult): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const r of diff.different) {
    rows.push({ ...r, status: 'different' });
  }
  for (const r of diff.onlyInSource) {
    rows.push({ ...r, status: 'source' });
  }
  for (const r of diff.onlyInTarget) {
    rows.push({ ...r, status: 'target' });
  }
  // Sort by key when present (numeric-aware), else keep insertion order.
  rows.sort((a, b) => {
    const ka = a.key ?? '';
    const kb = b.key ?? '';
    const na = Number(ka);
    const nb = Number(kb);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return ka.localeCompare(kb);
  });
  return rows;
}

type RowFilter = 'all' | 'different' | 'source' | 'target';

const STATUS_META: Record<UnifiedRow['status'], { label: string; cls: string }> = {
  same: { label: 'same', cls: 'text-slate-500 bg-slate-500/10' },
  different: { label: 'DIFF', cls: 'text-rose-300 bg-rose-500/15' },
  source: { label: 'SRC ONLY', cls: 'text-cyan-300 bg-cyan-500/15' },
  target: { label: 'TGT ONLY', cls: 'text-amber-300 bg-amber-500/15' },
};

const DataDiffResultView: React.FC<{ diff: DataDiffResult }> = ({ diff }) => {
  const totalDiff = diff.onlyInSource.length + diff.onlyInTarget.length + diff.different.length;
  const [filter, setFilter] = useState<RowFilter>('all');
  const pkSet = useMemo(() => new Set(diff.pkColumns.map((c) => c.toLowerCase())), [diff.pkColumns]);
  const allRows = useMemo(() => mergeRows(diff), [diff]);

  const visibleRows = useMemo(() => {
    if (filter === 'all') return allRows;
    return allRows.filter((r) => r.status === filter);
  }, [allRows, filter]);

  const filters: { id: RowFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: allRows.length },
    { id: 'different', label: 'Different', count: diff.different.length },
    { id: 'source', label: 'Source only', count: diff.onlyInSource.length },
    { id: 'target', label: 'Target only', count: diff.onlyInTarget.length },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-2">
        <SummaryStat label="Matched" value={diff.matchedCount} cls="text-emerald-400" Icon={CheckCircle2} />
        <SummaryStat label="Only Source" value={diff.onlyInSource.length} cls="text-cyan-400" Icon={Plus} />
        <SummaryStat label="Only Target" value={diff.onlyInTarget.length} cls="text-amber-400" Icon={Minus} />
        <SummaryStat label="Different" value={diff.different.length} cls="text-rose-400" Icon={AlertTriangle} />
      </div>

      {!diff.hasPrimaryKey && (
        <div className="flex items-center gap-2 text-xs text-amber-300 bg-amber-500/5 border border-amber-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          This table has no primary key. Rows are matched by full-row hash — identical rows with different column order may not align. Treat as approximate.
        </div>
      )}
      {diff.truncated && (
        <div className="flex items-center gap-2 text-xs text-slate-400 bg-[#0a0f18] border border-[#1e293b] rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          Row cap reached — only the first ~1000 rows were compared. Narrow the comparison for a full diff.
        </div>
      )}

      {totalDiff === 0 ? (
        <div className="p-6 text-center text-xs text-slate-500 bg-[#0a0f18] border border-[#1e293b] rounded-xl">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-2" />
          No differences found in the sampled rows.
        </div>
      ) : (
        <div className="bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden">
          {/* Toolbar: row filters */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-[#1e293b] overflow-x-auto">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap',
                  filter === f.id
                    ? 'bg-cyan-600/20 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33] border border-transparent'
                )}
              >
                {f.label}
                <span className="text-[9px] text-slate-500 bg-[#1e293b] rounded px-1">{f.count}</span>
              </button>
            ))}
          </div>

          {/* The single unified table: header = table columns, one row per record. */}
          <div className="overflow-auto max-h-[46vh]">
            <table className="w-full text-[11px] border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#06090e] border-b border-[#1e293b]">
                  <th className="text-left px-2 py-1.5 font-medium text-slate-500 whitespace-nowrap sticky left-0 bg-[#06090e] z-20">
                    Status
                  </th>
                  {diff.columns.map((c) => {
                    const isPk = pkSet.has(c.toLowerCase());
                    return (
                      <th
                        key={c}
                        className="text-left px-2 py-1.5 font-medium whitespace-nowrap"
                        title={isPk ? 'Primary key' : undefined}
                      >
                        <span className={cn('font-mono', isPk ? 'text-amber-400' : 'text-slate-400')}>
                          {isPk && <KeyRound className="w-2.5 h-2.5 inline mr-1 -mt-0.5" />}
                          {c}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => {
                  const meta = STATUS_META[r.status];
                  const src = r.sourceRow ?? [];
                  const tgt = r.targetRow ?? [];
                  return (
                    <tr
                      key={i}
                      className={cn(
                        'border-b border-[#1e293b]/40 hover:bg-[#0f172a]/40',
                        r.status === 'different' && 'bg-rose-500/[0.03]',
                        r.status === 'source' && 'bg-cyan-500/[0.03]',
                        r.status === 'target' && 'bg-amber-500/[0.03]'
                      )}
                    >
                      {/* Status cell (sticky left so it stays visible on horizontal scroll) */}
                      <td className="px-2 py-1 whitespace-nowrap sticky left-0 bg-inherit z-10">
                        <div className="flex flex-col gap-0.5">
                          <span className={cn('text-[9px] font-bold rounded px-1 py-0.5 w-fit', meta.cls)}>
                            {meta.label}
                          </span>
                          {r.key && (
                            <span className="text-[9px] text-slate-600 font-mono max-w-[90px] truncate" title={r.key}>
                              {r.key}
                            </span>
                          )}
                        </div>
                      </td>
                      {/* One cell per table column. For "different" rows where the
                          value changed, show `db1 → db2` inline with highlight. */}
                      {diff.columns.map((c, j) => {
                        const sv = src[j];
                        const tv = tgt[j];
                        // Row only in source → target cell is empty.
                        if (r.status === 'source') {
                          return (
                            <td
                              key={c}
                              className="px-2 py-1 font-mono whitespace-nowrap max-w-[240px] truncate text-slate-300"
                              title={renderVal(sv)}
                            >
                              {renderVal(sv)}
                            </td>
                          );
                        }
                        // Row only in target → source cell is empty.
                        if (r.status === 'target') {
                          return (
                            <td
                              key={c}
                              className="px-2 py-1 font-mono whitespace-nowrap max-w-[240px] truncate text-slate-300"
                              title={renderVal(tv)}
                            >
                              {renderVal(tv)}
                            </td>
                          );
                        }
                        // Row in both — cell changed?
                        const changed = !valsEqual(sv, tv);
                        if (changed) {
                          return (
                            <td
                              key={c}
                              className="px-2 py-1 font-mono whitespace-nowrap max-w-[280px] truncate text-rose-200 bg-rose-500/10"
                              title={`${renderVal(sv)} → ${renderVal(tv)}`}
                            >
                              <span className="text-slate-500 line-through">{renderVal(sv)}</span>
                              <span className="text-slate-600 mx-1">→</span>
                              <span className="text-rose-100 font-semibold">{renderVal(tv)}</span>
                            </td>
                          );
                        }
                        // Identical cell.
                        return (
                          <td
                            key={c}
                            className="px-2 py-1 font-mono whitespace-nowrap max-w-[240px] truncate text-slate-300"
                            title={renderVal(sv)}
                          >
                            {renderVal(sv)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-3 px-3 py-2 border-t border-[#1e293b] text-[10px] text-slate-500 flex-wrap">
            <span className="flex items-center gap-1">
              <KeyRound className="w-2.5 h-2.5 text-amber-400" /> primary key
            </span>
            <span className="flex items-center gap-1">
              <span className="text-slate-500 line-through font-mono">old</span>
              <span className="text-slate-600">→</span>
              <span className="text-rose-200 font-mono">new</span> changed cell
            </span>
            <span className="text-slate-600">∅ = null</span>
          </div>
        </div>
      )}
    </div>
  );
};

function renderVal(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  return String(v);
}

function valsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = Number(a);
  const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && na === nb) return true;
  return false;
}

// ===========================================================================
// Small shared bits
// ===========================================================================

const EmptyHint: React.FC<{ text: string }> = ({ text }) => (
  <div className="flex flex-col items-center justify-center h-full text-center py-16">
    <ArrowLeftRight className="w-8 h-8 text-slate-700 mb-3" />
    <p className="text-xs text-slate-500 max-w-xs">{text}</p>
  </div>
);

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2">
    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
    <span className="font-mono break-all">{message}</span>
  </div>
);
