import React, { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  DatabaseZap,
  ArrowRight,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Play,
  Square,
  ChevronLeft,
  Database,
} from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useToastStore } from '../../store/useToastStore';
import { safeInvoke, inTauri } from '../../core/tauri/ipc';
import { cn } from '../../core/utils/cn';
import { isMysqlFamily, isPostgresFamily } from '../../core/connection/engines';
import type {
  DatabaseConnection,
  SchemaGroupNode,
  PgTableRef,
  PgTableMigrationPlan,
  PgTableRunInput,
  PgMigrationRunSummary,
  PgMigrationProgress,
} from '../../core/domain/types';

type Step = 'select' | 'preview' | 'run' | 'done';

/** The confirmation token the backend expects for the target — the
 *  database name, mirroring `expected_pg_confirm_token` in pg_migrate.rs. */
function expectedTargetToken(c: DatabaseConnection): string {
  return c.scopeDatabase || c.database || c.name;
}

export const MysqlToPostgresWizard: React.FC = () => {
  const { connections } = useConnectionStore();
  const pushToast = useToastStore((s) => s.push);

  const mysqlConnections = useMemo(() => connections.filter((c) => isMysqlFamily(c.engine)), [connections]);
  const pgConnections = useMemo(() => connections.filter((c) => isPostgresFamily(c.engine)), [connections]);

  const [step, setStep] = useState<Step>('select');
  const [sourceId, setSourceId] = useState(mysqlConnections[0]?.id ?? '');
  const [targetId, setTargetId] = useState(pgConnections[0]?.id ?? '');
  const source = connections.find((c) => c.id === sourceId);
  const target = connections.find((c) => c.id === targetId);

  const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
  const [sourceDbName, setSourceDbName] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);

  const [tables, setTables] = useState<{ name: string; rowCount: number | null }[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());

  const [plans, setPlans] = useState<PgTableMigrationPlan[]>([]);
  const [editedDdl, setEditedDdl] = useState<Record<string, string>>({});
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const [confirmText, setConfirmText] = useState('');
  const [migrationId, setMigrationId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progressByTable, setProgressByTable] = useState<Record<string, PgMigrationProgress>>({});
  const [summary, setSummary] = useState<PgMigrationRunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Load the MySQL source's databases so a specific one can be picked (a
  // MySQL connection can see many, unlike Postgres's one-database-per-
  // connection model).
  useEffect(() => {
    if (!source) {
      setSourceDatabases([]);
      setSourceDbName('');
      return;
    }
    let cancelled = false;
    setLoadingDbs(true);
    (async () => {
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', { config: source });
        if (cancelled) return;
        const names = (tree || []).map((g) => g.name);
        setSourceDatabases(names);
        setSourceDbName(names[0] ?? '');
      } catch {
        if (!cancelled) setSourceDatabases([]);
      } finally {
        if (!cancelled) setLoadingDbs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, source]);

  // Load the selected database's tables (with row counts) once picked.
  useEffect(() => {
    if (!source || !sourceDbName) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    (async () => {
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', {
          config: { ...source, scopeDatabase: sourceDbName },
        });
        if (cancelled) return;
        const group = (tree || []).find((g) => g.name === sourceDbName) ?? tree?.[0];
        const list = (group?.children ?? [])
          .filter((t) => t.node_type === 'table')
          .map((t) => ({ name: t.name, rowCount: t.row_count ?? null }));
        setTables(list);
        setSelectedTables(new Set(list.map((t) => t.name)));
      } catch {
        if (!cancelled) setTables([]);
      } finally {
        if (!cancelled) setLoadingTables(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, sourceDbName]);

  const canPlan = !!source && !!target && sourceDbName !== '' && selectedTables.size > 0;

  const runPlan = async () => {
    if (!source || !target) return;
    setPlanning(true);
    setPlanError(null);
    try {
      const refs: PgTableRef[] = Array.from(selectedTables).map((table) => ({ schema: sourceDbName, table }));
      const result = await safeInvoke<PgTableMigrationPlan[]>('pg_migrate_plan_tables', {
        source,
        target,
        tables: refs,
      });
      setPlans(result);
      setEditedDdl(Object.fromEntries(result.map((p) => [p.table, p.createTableSql])));
      setStep('preview');
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setPlanError(msg);
      pushToast({ severity: 'error', title: 'Failed to plan migration', message: msg });
    } finally {
      setPlanning(false);
    }
  };

  // Subscribe to migration_progress while a migration is running.
  useEffect(() => {
    if (!migrationId || !inTauri()) return;
    let unlisten: (() => void) | null = null;
    let active = true;
    listen<PgMigrationProgress>('migration_progress', (e) => {
      if (e.payload.migrationId !== migrationId) return;
      setProgressByTable((prev) => ({ ...prev, [e.payload.table]: e.payload }));
    }).then((u) => {
      if (!active) u();
      else unlisten = u;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [migrationId]);

  const startRun = async () => {
    if (!source || !target) return;
    const id = crypto.randomUUID();
    setMigrationId(id);
    setProgressByTable({});
    setSummary(null);
    setRunError(null);
    setRunning(true);
    setStep('run');
    try {
      const runTables: PgTableRunInput[] = plans.map((p) => ({
        schema: p.schema,
        table: p.table,
        createTableSql: editedDdl[p.table] ?? p.createTableSql,
      }));
      const result = await safeInvoke<PgMigrationRunSummary>('pg_migrate_run', {
        migrationId: id,
        source,
        target,
        tables: runTables,
        confirmToken: confirmText,
      });
      setSummary(result);
      setStep('done');
      const failed = result.tables.filter((t) => t.error).length;
      if (failed === 0 && !result.cancelled) {
        pushToast({
          severity: 'success',
          title: 'Migration complete',
          message: `${result.totalRows.toLocaleString()} row(s) migrated across ${result.tables.length} table(s).`,
        });
      } else {
        pushToast({
          severity: 'warning',
          title: result.cancelled ? 'Migration cancelled' : 'Migration finished with errors',
          message: `${result.tables.length - failed} succeeded, ${failed} failed.`,
        });
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      setRunError(msg);
      setStep('done');
      pushToast({ severity: 'error', title: 'Migration failed', message: msg });
    } finally {
      setRunning(false);
    }
  };

  const cancelRun = async () => {
    if (!migrationId) return;
    try {
      await safeInvoke('pg_migrate_cancel', { migrationId });
    } catch {
      // best-effort
    }
  };

  const targetToken = target ? expectedTargetToken(target) : '';

  return (
    <div className="w-full h-full bg-[#06090e] flex flex-col overflow-hidden select-none">
      <div className="px-4 py-2 border-b border-[#1e293b] shrink-0 flex items-center gap-2">
        <h2 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
          <DatabaseZap className="w-4 h-4 text-purple-400" />
          Migrate MySQL to PostgreSQL
        </h2>
        <span className="text-[10px] text-slate-500 ml-2">
          {step === 'select' && 'Step 1 of 3 — pick source, target, and tables'}
          {step === 'preview' && 'Step 2 of 3 — review the generated schema'}
          {(step === 'run' || step === 'done') && 'Step 3 of 3 — run'}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        {step === 'select' && (
          <SelectStep
            mysqlConnections={mysqlConnections}
            pgConnections={pgConnections}
            sourceId={sourceId}
            targetId={targetId}
            onSourceChange={setSourceId}
            onTargetChange={setTargetId}
            sourceDatabases={sourceDatabases}
            sourceDbName={sourceDbName}
            onSourceDbChange={setSourceDbName}
            loadingDbs={loadingDbs}
            tables={tables}
            loadingTables={loadingTables}
            selectedTables={selectedTables}
            onToggleTable={(name) =>
              setSelectedTables((prev) => {
                const next = new Set(prev);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
            onToggleAll={(checked) => setSelectedTables(checked ? new Set(tables.map((t) => t.name)) : new Set())}
            canPlan={canPlan}
            planning={planning}
            planError={planError}
            onNext={runPlan}
          />
        )}

        {step === 'preview' && (
          <PreviewStep
            plans={plans}
            editedDdl={editedDdl}
            onEditDdl={(table, sql) => setEditedDdl((prev) => ({ ...prev, [table]: sql }))}
            onBack={() => setStep('select')}
            onNext={() => setStep('run')}
          />
        )}

        {(step === 'run' || step === 'done') && (
          <RunStep
            target={target}
            plans={plans}
            progressByTable={progressByTable}
            confirmText={confirmText}
            onConfirmTextChange={setConfirmText}
            targetToken={targetToken}
            running={running}
            summary={summary}
            runError={runError}
            onBack={() => setStep('preview')}
            onStart={startRun}
            onCancel={cancelRun}
            hasStarted={step === 'run' || step === 'done'}
          />
        )}
      </div>
    </div>
  );
};

// ===========================================================================
// Step 1 — select source, target, tables
// ===========================================================================

const SelectStep: React.FC<{
  mysqlConnections: DatabaseConnection[];
  pgConnections: DatabaseConnection[];
  sourceId: string;
  targetId: string;
  onSourceChange: (id: string) => void;
  onTargetChange: (id: string) => void;
  sourceDatabases: string[];
  sourceDbName: string;
  onSourceDbChange: (db: string) => void;
  loadingDbs: boolean;
  tables: { name: string; rowCount: number | null }[];
  loadingTables: boolean;
  selectedTables: Set<string>;
  onToggleTable: (name: string) => void;
  onToggleAll: (checked: boolean) => void;
  canPlan: boolean;
  planning: boolean;
  planError: string | null;
  onNext: () => void;
}> = ({
  mysqlConnections,
  pgConnections,
  sourceId,
  targetId,
  onSourceChange,
  onTargetChange,
  sourceDatabases,
  sourceDbName,
  onSourceDbChange,
  loadingDbs,
  tables,
  loadingTables,
  selectedTables,
  onToggleTable,
  onToggleAll,
  canPlan,
  planning,
  planError,
  onNext,
}) => {
  const selectCls =
    'w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-xs text-slate-200 px-2.5 py-1.5 focus:outline-none focus:border-purple-500/50';

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-[11px] text-cyan-400 font-bold uppercase tracking-wider mb-1">
            Source (MySQL)
          </label>
          {mysqlConnections.length === 0 ? (
            <div className="text-[11px] text-slate-500">No MySQL/MariaDB connections configured.</div>
          ) : (
            <select value={sourceId} onChange={(e) => onSourceChange(e.target.value)} className={selectCls}>
              {mysqlConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {sourceDatabases.length > 0 && (
            <select
              value={sourceDbName}
              onChange={(e) => onSourceDbChange(e.target.value)}
              className={cn(selectCls, 'mt-2')}
            >
              {sourceDatabases.map((db) => (
                <option key={db} value={db}>
                  {db}
                </option>
              ))}
            </select>
          )}
          {loadingDbs && <Loader2 className="w-3 h-3 animate-spin text-slate-500 mt-2" />}
        </div>

        <div>
          <label className="block text-[11px] text-amber-400 font-bold uppercase tracking-wider mb-1">
            Target (PostgreSQL)
          </label>
          {pgConnections.length === 0 ? (
            <div className="text-[11px] text-slate-500">No PostgreSQL connections configured.</div>
          ) : (
            <select value={targetId} onChange={(e) => onTargetChange(e.target.value)} className={selectCls}>
              {pgConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.database || c.name})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#1e293b]">
          <span className="text-[11px] font-semibold text-slate-300">Tables to migrate</span>
          <div className="flex items-center gap-2">
            <button onClick={() => onToggleAll(true)} className="text-[10px] text-cyan-400 hover:text-cyan-300">
              Select all
            </button>
            <button onClick={() => onToggleAll(false)} className="text-[10px] text-slate-500 hover:text-slate-300">
              Clear
            </button>
          </div>
        </div>
        <div className="max-h-[40vh] overflow-y-auto">
          {loadingTables ? (
            <div className="p-4 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading tables…
            </div>
          ) : tables.length === 0 ? (
            <div className="p-4 text-xs text-slate-500">No tables found in this database.</div>
          ) : (
            <table className="w-full text-[11px]">
              <tbody>
                {tables.map((t) => (
                  <tr
                    key={t.name}
                    className="border-b border-[#1e293b]/40 hover:bg-[#0f172a]/40 cursor-pointer"
                    onClick={() => onToggleTable(t.name)}
                  >
                    <td className="px-3 py-1.5 w-6">
                      <input type="checkbox" checked={selectedTables.has(t.name)} onChange={() => onToggleTable(t.name)} />
                    </td>
                    <td className="px-1 py-1.5 font-mono text-slate-200">{t.name}</td>
                    <td className="px-3 py-1.5 text-right text-slate-500">
                      {t.rowCount != null ? `${t.rowCount.toLocaleString()} rows` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {planError && (
        <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="font-mono break-all">{planError}</span>
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!canPlan || planning}
        className="self-start flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-semibold shadow-lg shadow-purple-600/30 transition-all"
      >
        {planning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
        {planning ? 'Generating schema…' : `Preview schema for ${selectedTables.size} table(s)`}
      </button>
    </div>
  );
};

// ===========================================================================
// Step 2 — preview generated DDL + warnings
// ===========================================================================

const PreviewStep: React.FC<{
  plans: PgTableMigrationPlan[];
  editedDdl: Record<string, string>;
  onEditDdl: (table: string, sql: string) => void;
  onBack: () => void;
  onNext: () => void;
}> = ({ plans, editedDdl, onEditDdl, onBack, onNext }) => {
  const [expanded, setExpanded] = useState<string | null>(plans[0]?.table ?? null);
  const allWarnings = useMemo(() => plans.flatMap((p) => p.warnings.map((w) => ({ table: p.table, w }))), [plans]);

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      {allWarnings.length > 0 && (
        <div className="space-y-1 text-xs text-amber-300 bg-amber-500/5 border border-amber-500/20 rounded-lg p-2.5">
          {allWarnings.slice(0, 8).map((item, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>
                <span className="font-mono text-amber-200">{item.table}</span>: {item.w}
              </span>
            </div>
          ))}
          {allWarnings.length > 8 && <div className="text-slate-400">…and {allWarnings.length - 8} more.</div>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {plans.map((p) => {
          const isOpen = expanded === p.table;
          return (
            <div key={p.table} className="bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : p.table)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#0f172a]/40"
              >
                <span className="flex items-center gap-2 text-xs font-mono text-slate-200">
                  <Database className="w-3.5 h-3.5 text-purple-400" />
                  {p.table}
                  <span className="text-[10px] text-slate-500">
                    {p.columns.length} column(s)
                    {p.rowCountEstimate != null ? ` · ~${p.rowCountEstimate.toLocaleString()} rows` : ''}
                  </span>
                </span>
                <span className="text-[10px] text-slate-500">{isOpen ? 'Hide' : 'Show'}</span>
              </button>
              {isOpen && (
                <div className="border-t border-[#1e293b] p-3 space-y-3">
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-slate-500 text-left">
                          <th className="pb-1 pr-3">Column</th>
                          <th className="pb-1 pr-3">MySQL type</th>
                          <th className="pb-1 pr-3">Postgres type</th>
                          <th className="pb-1">Flags</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.columns.map((c) => (
                          <tr key={c.name} className="border-t border-[#1e293b]/40">
                            <td className="py-1 pr-3 font-mono text-slate-200">{c.name}</td>
                            <td className="py-1 pr-3 font-mono text-slate-500">{c.mysqlType}</td>
                            <td className="py-1 pr-3 font-mono text-cyan-300">{c.pgType}</td>
                            <td className="py-1 text-slate-500">
                              {c.isPrimaryKey && 'PK '}
                              {c.isAutoIncrement && 'AUTO_INCREMENT '}
                              {!c.nullable && 'NOT NULL'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-1">
                      CREATE TABLE (editable — column names must stay the same to be migrated)
                    </label>
                    <textarea
                      value={editedDdl[p.table] ?? p.createTableSql}
                      onChange={(e) => onEditDdl(p.table, e.target.value)}
                      rows={Math.min(14, (editedDdl[p.table] ?? p.createTableSql).split('\n').length + 1)}
                      spellCheck={false}
                      className="w-full bg-[#06090e] border border-[#1e293b] rounded-lg text-[11px] font-mono text-slate-200 p-2.5 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#1e293b] text-slate-300 hover:border-slate-600 text-xs font-medium"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onNext}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-lg shadow-purple-600/30 transition-all"
        >
          <ArrowRight className="w-4 h-4" /> Continue to run
        </button>
      </div>
    </div>
  );
};

// ===========================================================================
// Step 3 — confirm + run + progress + summary
// ===========================================================================

const RunStep: React.FC<{
  target: DatabaseConnection | undefined;
  plans: PgTableMigrationPlan[];
  progressByTable: Record<string, PgMigrationProgress>;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  targetToken: string;
  running: boolean;
  summary: PgMigrationRunSummary | null;
  runError: string | null;
  onBack: () => void;
  onStart: () => void;
  onCancel: () => void;
  hasStarted: boolean;
}> = ({
  target,
  plans,
  progressByTable,
  confirmText,
  onConfirmTextChange,
  targetToken,
  running,
  summary,
  runError,
  onBack,
  onStart,
  onCancel,
  hasStarted,
}) => {
  const tokenMatches = confirmText.trim() === targetToken;

  if (summary || runError) {
    const failed = summary?.tables.filter((t) => t.error).length ?? 0;
    return (
      <div className="flex flex-col gap-4 max-w-3xl">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Rows migrated" value={(summary?.totalRows ?? 0).toLocaleString()} cls="text-emerald-400" />
          <Stat label="Tables OK" value={String((summary?.tables.length ?? 0) - failed)} cls="text-cyan-400" />
          <Stat label="Tables failed" value={String(failed)} cls={failed > 0 ? 'text-rose-400' : 'text-slate-500'} />
        </div>

        {runError && (
          <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded-lg px-3 py-2">
            <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="font-mono break-all">{runError}</span>
          </div>
        )}

        {summary && (
          <div className="bg-[#0a0f18] border border-[#1e293b] rounded-xl overflow-hidden">
            {summary.tables.map((t) => (
              <div key={t.table} className="flex items-center gap-2 px-3 py-2 border-b border-[#1e293b]/40 text-xs">
                {t.error ? (
                  <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                )}
                <span className="font-mono text-slate-200">{t.table}</span>
                <span className="text-slate-500 ml-auto">
                  {t.error ? t.error : `${t.rowsMigrated.toLocaleString()} rows · ${t.durationMs}ms`}
                </span>
              </div>
            ))}
            {summary.tables.some((t) => t.warnings.length > 0) && (
              <div className="p-3 space-y-1 text-[11px] text-amber-300">
                {summary.tables.flatMap((t) => t.warnings.map((w, i) => (
                  <div key={`${t.table}-${i}`} className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>
                      <span className="font-mono text-amber-200">{t.table}</span>: {w}
                    </span>
                  </div>
                )))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (hasStarted) {
    return (
      <div className="flex flex-col gap-3 max-w-3xl">
        {plans.map((p) => {
          const prog = progressByTable[p.table];
          const pct = prog?.rowsTotal ? Math.min(100, Math.round((prog.rowsDone / prog.rowsTotal) * 100)) : null;
          return (
            <div key={p.table} className="bg-[#0a0f18] border border-[#1e293b] rounded-xl px-3 py-2.5">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-mono text-slate-200">{p.table}</span>
                <span className="text-slate-500">
                  {prog ? `${prog.phase} · ${prog.rowsDone.toLocaleString()} row(s)` : 'queued'}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-[#1e293b] overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-all',
                    prog?.phase === 'error' ? 'bg-rose-500' : prog?.phase === 'done' ? 'bg-emerald-500' : 'bg-purple-500'
                  )}
                  style={{ width: pct != null ? `${pct}%` : prog ? '60%' : '0%' }}
                />
              </div>
            </div>
          );
        })}
        {running && (
          <button
            onClick={onCancel}
            className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 text-xs font-medium"
          >
            <Square className="w-3 h-3" /> Cancel
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-lg">
      <div className="text-xs text-slate-400">
        This will create/modify {plans.length} table(s) on <span className="text-slate-200 font-semibold">{target?.name}</span> and
        load their data. This cannot be undone automatically.
      </div>
      <div>
        <label className="block text-[11px] text-slate-500 mb-1">
          Type the target database name to confirm ({targetToken})
        </label>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => onConfirmTextChange(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-xs text-slate-200 px-3 py-2 font-mono focus:outline-none focus:border-purple-500/50"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#1e293b] text-slate-300 hover:border-slate-600 text-xs font-medium"
        >
          <ChevronLeft className="w-4 h-4" /> Back
        </button>
        <button
          onClick={onStart}
          disabled={!tokenMatches}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-semibold shadow-lg shadow-purple-600/30 transition-all"
        >
          <Play className="w-4 h-4" /> Run migration
        </button>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; cls: string }> = ({ label, value, cls }) => (
  <div className="bg-[#0a0f18] border border-[#1e293b] rounded-lg px-3 py-2">
    <div className={cn('text-base font-bold leading-none', cls)}>{value}</div>
    <div className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">{label}</div>
  </div>
);
