import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Eye,
  Zap,
  Braces,
  Clock,
  Save,
  Loader2,
  Sparkles,
  Plus,
  Trash2,
  Play,
  X,
} from 'lucide-react';
import { useTabStore } from '../../store/useTabStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useToastStore } from '../../store/useToastStore';
import { safeInvoke } from '../../core/tauri/ipc';
import { resolveTargetDatabase, qualifiedTable, quoteIdent } from '../../core/sql/ident';
import { ConfirmDialog } from '../common/ConfirmDialog';
import type { QueryResultData } from '../../core/domain/types';
import { isPostgresFamily, isMysqlFamily } from '../../core/connection/engines';
import { getGroupedTypeOptions } from '../../core/sql/dataTypes';
import {
  createViewSql,
  replaceViewSql,
  dropViewSql,
  fetchViewDefinition,
} from '../../core/sql/viewActions';
import {
  createTriggerSql,
  replaceTriggerSql,
  defaultTriggerFunctionName,
  type TriggerDef,
} from '../../core/sql/triggerActions';
import { fetchTriggerDefinition } from '../../core/sql/triggerIntrospection';
import {
  createProcedureSql,
  replaceProcedureSql,
  dropProcedureSql,
  commentOnRoutineSql,
  type ProcedureDef,
} from '../../core/sql/procedureActions';
import { fetchProcedureDefinition, type ProcedureParam } from '../../core/sql/procedureIntrospection';
import {
  createEventSql,
  alterEventSql,
  pgCronScheduleSql,
  pgCronReplaceSql,
  type EventDef,
} from '../../core/sql/eventActions';
import { fetchEventDefinition } from '../../core/sql/eventIntrospection';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { buildSchemaContext } from '../../core/ai/schemaContext';
import { generateSQL } from '../../core/ai/client';
import { isAIConfigured } from '../../core/ai/types';
import { useSettingsStore } from '../../store/useSettingsStore';

const KIND_META = {
  view: { label: 'View', Icon: Eye, color: 'text-cyan-400' },
  trigger: { label: 'Trigger', Icon: Zap, color: 'text-amber-400' },
  procedure: { label: 'Procedure', Icon: Braces, color: 'text-violet-400' },
  event: { label: 'Event', Icon: Clock, color: 'text-emerald-400' },
} as const;

const INTERVAL_FIELDS = ['SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'];

interface ParamRow extends ProcedureParam {
  id: string;
}
const newParamRow = (): ParamRow => ({
  id: `p_${Math.random().toString(36).slice(2)}`,
  name: '',
  mode: 'IN',
  type: 'varchar(255)',
});

/** HeidiSQL-style structured object editor, rendered as a workspace tab (not a
 *  modal, not the generic SQL editor): a Name field, engine-specific metadata,
 *  a SQL body editor, and a Save button that builds + executes the DDL. */
export const ObjectEditor: React.FC<{ tabId: string }> = ({ tabId }) => {
  const tab = useTabStore((s) => s.tabs.find((t) => t.id === tabId));
  const connections = useConnectionStore((s) => s.connections);
  const schemaTreeByConn = useConnectionStore((s) => s.schemaTreeByConn);
  const pushToast = useToastStore((s) => s.push);
  const setAIPanelOpen = useWorkspaceStore((s) => s.setAIPanelOpen);
  const ai = useSettingsStore((s) => s.ai);
  const aiReady = isAIConfigured(ai);

  const ctx = tab?.objectEditor;
  const conn = useMemo(
    () => connections.find((c) => c.id === tab?.connectionId),
    [connections, tab?.connectionId]
  );

  // Resolve the config the same way Explorer does — MySQL group nodes are
  // databases, so override `database` to reach non-default schemas.
  const config = useMemo(() => {
    if (!conn) return conn;
    const targetDb = resolveTargetDatabase(conn.engine, conn.database, ctx?.schemaName);
    return targetDb && targetDb !== conn.database ? { ...conn, database: targetDb } : conn;
  }, [conn, ctx?.schemaName]);

  const engine = conn?.engine ?? '';
  const isPg = isPostgresFamily(engine);
  const isMysql = isMysqlFamily(engine);
  const kind = ctx?.kind ?? 'view';
  const isEdit = ctx?.mode === 'edit';
  const meta = KIND_META[kind];

  // Table/view names available for the trigger "Table" combobox — sourced from
  // the same per-connection schema-tree cache the Explorer keeps warm, scoped
  // to this object's schema when known (MySQL group nodes ARE databases).
  const tableOptions = useMemo(() => {
    if (!conn) return [];
    const tree = schemaTreeByConn[conn.id] || [];
    const groupNode = ctx?.schemaName ? tree.find((g) => g.name === ctx.schemaName) : tree[0];
    const source = groupNode ? groupNode.children : tree.flatMap((g) => g.children);
    return Array.from(new Set(source.map((t) => t.name))).sort();
  }, [schemaTreeByConn, conn, ctx?.schemaName]);

  // ── Form state ──
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  // Trigger
  const [table, setTable] = useState(ctx?.tableName || '');
  const [timing, setTiming] = useState('BEFORE');
  const [events, setEvents] = useState<string[]>(['INSERT']);
  const [level, setLevel] = useState<'ROW' | 'STATEMENT'>('ROW');
  const [functionName, setFunctionName] = useState('');
  // Procedure / Function — HeidiSQL-style Options/Parameters/CREATE code tabs.
  // Shared with Trigger and Event too (Options/CREATE code — no Parameters tab there).
  const [params, setParams] = useState<ParamRow[]>([newParamRow()]);
  const [metaTab, setMetaTab] = useState<'options' | 'parameters' | 'code'>('options');
  const [routineType, setRoutineType] = useState<'PROCEDURE' | 'FUNCTION'>('PROCEDURE');
  const [returnType, setReturnType] = useState('');
  const [definer, setDefiner] = useState('');
  const [comment, setComment] = useState('');
  const [sqlSecurity, setSqlSecurity] = useState<'DEFINER' | 'INVOKER'>('DEFINER');
  const [deterministic, setDeterministic] = useState(false);
  const [dataAccess, setDataAccess] = useState('CONTAINS SQL');
  // PROCEDURE vs FUNCTION share one `kind` ('procedure') but read differently
  // everywhere a label is shown — this is the single place that decides which.
  const displayLabel = kind === 'procedure' ? (routineType === 'FUNCTION' ? 'Function' : 'Procedure') : meta.label;
  // Event
  const [scheduleType, setScheduleType] = useState<'ONE TIME' | 'RECURRING'>('RECURRING');
  const [intervalValue, setIntervalValue] = useState('1');
  const [intervalField, setIntervalField] = useState('DAY');
  const [executeAt, setExecuteAt] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [onCompletionPreserve, setOnCompletionPreserve] = useState(true);
  const [status, setStatus] = useState<'ENABLED' | 'DISABLED'>('ENABLED');
  const [cronSchedule, setCronSchedule] = useState('*/5 * * * *');

  const [loadingDef, setLoadingDef] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // ── Test Run — executes the body directly against the connection so the
  //    user can verify it before/after saving, without waiting for a schedule
  //    (event) or a separate CALL from the SQL editor (procedure/view).
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<QueryResultData | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState('');
  // Result panel is bottom-docked + drag-resizable, same position/interaction
  // as the SQL editor's ResultPanel (see MainLayout.tsx) — kept as a local
  // implementation rather than reusing that component directly, since it
  // reads its result from the active tab's `result`/`resultSets` in the tab
  // store, while Test Run's result is ad-hoc local state (a one-off query,
  // not routed through the tab's query-execution pipeline).
  const [testResultHeight, setTestResultHeight] = useState(240);
  const [isResizingTestResult, setIsResizingTestResult] = useState(false);
  const resizeAnchorRef = useRef(0);
  useEffect(() => {
    if (!isResizingTestResult) return;
    const onMove = (e: MouseEvent) => {
      const next = resizeAnchorRef.current - e.clientY;
      setTestResultHeight(Math.max(120, Math.min(next, window.innerHeight - 200)));
    };
    const onUp = () => setIsResizingTestResult(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingTestResult]);
  const [showTestArgsPrompt, setShowTestArgsPrompt] = useState(false);
  const [confirmRunEvent, setConfirmRunEvent] = useState(false);
  const canTestRun = kind === 'view' || kind === 'event' || kind === 'procedure';

  // Seed defaults for create mode + load definition for edit mode.
  useEffect(() => {
    if (!ctx || !conn) return;
    const k = ctx.kind;
    setRunResult(null);
    setRunError(null);
    setShowTestArgsPrompt(false);
    setConfirmRunEvent(false);
    setTestArgs('');
    setMetaTab('options');
    if (ctx.mode === 'create') {
      setName('');
      if (k === 'trigger') setBody(isPg ? 'BEGIN\n  RETURN NEW;\nEND;' : 'BEGIN\nEND');
      else if (k === 'procedure') setBody('BEGIN\nEND');
      else if (k === 'event') setBody('DELETE FROM sessions WHERE expires_at < NOW();');
      else setBody('SELECT id, name\nFROM your_table\nWHERE active = true;');
      setTable(ctx.tableName || '');
      if (k === 'procedure') {
        setParams([newParamRow()]);
        setRoutineType('PROCEDURE');
        setReturnType('');
        setDefiner('');
        setComment('');
        setSqlSecurity('DEFINER');
        setDeterministic(false);
        setDataAccess('CONTAINS SQL');
      }
      setLoadingDef(false);
      return;
    }
    // edit
    let cancelled = false;
    setLoadingDef(true);
    (async () => {
      try {
        if (k === 'view') {
          const def = await fetchViewDefinition({ config: config!, engine, schema: ctx.schemaName, view: ctx.name! });
          if (cancelled) return;
          setBody(def || '');
        } else if (k === 'trigger') {
          const def = await fetchTriggerDefinition({ config: config!, engine, schema: ctx.schemaName, name: ctx.name!, table: ctx.tableName || ctx.name! });
          if (cancelled) return;
          setTiming(def.timing || 'BEFORE');
          setEvents(def.events.length ? def.events : ['INSERT']);
          if (def.level === 'STATEMENT') setLevel('STATEMENT');
          setTable(def.table || ctx.tableName || '');
          setBody(def.body || '');
          if (def.functionName) setFunctionName(def.functionName);
        } else if (k === 'procedure') {
          const def = await fetchProcedureDefinition({ config: config!, engine, schema: ctx.schemaName, name: ctx.name! });
          if (cancelled) return;
          setParams(def.params.length ? def.params.map((p) => ({ ...p, id: `p_${Math.random().toString(36).slice(2)}` })) : [newParamRow()]);
          setBody(def.body || '');
          setRoutineType(def.routineType || 'PROCEDURE');
          setReturnType(def.returnType || '');
          setDefiner(def.definer || '');
          setComment(def.comment || '');
          setSqlSecurity(def.sqlSecurity || 'DEFINER');
          setDeterministic(def.deterministic ?? false);
          setDataAccess(def.dataAccess || 'CONTAINS SQL');
        } else if (k === 'event') {
          const def = await fetchEventDefinition({ config: config!, engine, schema: ctx.schemaName, name: ctx.name! });
          if (cancelled) return;
          if (def.scheduleType) setScheduleType(def.scheduleType);
          if (def.intervalValue) setIntervalValue(def.intervalValue);
          if (def.intervalField) setIntervalField(def.intervalField);
          if (def.executeAt) setExecuteAt(def.executeAt);
          if (def.starts) setStarts(def.starts);
          if (def.ends) setEnds(def.ends);
          if (typeof def.onCompletionPreserve === 'boolean') setOnCompletionPreserve(def.onCompletionPreserve);
          if (def.status) setStatus(def.status);
          if (def.cronSchedule) setCronSchedule(def.cronSchedule);
          setBody(def.body || '');
        }
        setName(ctx.name || '');
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      } finally {
        if (!cancelled) setLoadingDef(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const markDirty = () => setDirty(true);

  // ── Build the DDL statements for Save ──
  const buildStatements = (): string[] | null => {
    const trimmedName = name.trim();
    if (!trimmedName) return null;
    const schema = ctx?.schemaName;

    if (kind === 'view') {
      const def = { name: trimmedName, schema, selectSql: body };
      if (isEdit) {
        const r = replaceViewSql(engine, def);
        return r ? [r] : [dropViewSql(engine, trimmedName, schema), createViewSql(engine, def)];
      }
      return [createViewSql(engine, def)];
    }
    if (kind === 'trigger') {
      if (!table.trim()) return null;
      const def: TriggerDef = {
        name: trimmedName,
        schema,
        table: table.trim(),
        timing,
        events,
        level,
        body,
        functionName: isPg ? functionName.trim() || defaultTriggerFunctionName({ table: table.trim(), name: trimmedName }) : undefined,
      };
      return isEdit ? replaceTriggerSql(engine, def) : createTriggerSql(engine, def);
    }
    if (kind === 'procedure') {
      const isFunction = routineType === 'FUNCTION';
      // MySQL FUNCTION params have no mode keyword — force IN so the SQL
      // generator (and any stale UI selection) can't emit an invalid OUT/INOUT.
      const validParams = params
        .filter((p) => p.name.trim())
        .map(({ id: _id, ...rest }) => (isMysql && isFunction ? { ...rest, mode: 'IN' as const } : rest));
      const def: ProcedureDef = {
        name: trimmedName,
        schema,
        params: validParams,
        body,
        routineType,
        returnType: isFunction ? returnType.trim() : undefined,
        definer: isMysql ? definer.trim() || undefined : undefined,
        comment: comment.trim() || undefined,
        sqlSecurity,
        deterministic: isMysql ? deterministic : undefined,
        dataAccess: isMysql ? dataAccess : undefined,
      };
      const statements: string[] = [];
      if (isEdit) {
        const r = replaceProcedureSql(engine, def);
        if (r) statements.push(r);
        else {
          statements.push(dropProcedureSql(engine, trimmedName, schema, undefined, routineType));
          statements.push(createProcedureSql(engine, def));
        }
      } else {
        statements.push(createProcedureSql(engine, def));
      }
      // Postgres has no inline COMMENT clause — MySQL's is already embedded
      // in createProcedureSql's characteristics.
      if (isPg && def.comment) statements.push(commentOnRoutineSql(engine, def));
      return statements;
    }
    // event
    const def: EventDef = {
      name: trimmedName,
      schema,
      scheduleType,
      intervalValue,
      intervalField,
      executeAt,
      starts,
      ends,
      onCompletionPreserve,
      status,
      cronSchedule,
      body,
    };
    if (isPg) return isEdit ? pgCronReplaceSql(def) : [pgCronScheduleSql(def)];
    return [isEdit ? alterEventSql(engine, def) : createEventSql(engine, def)];
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    if (kind === 'trigger' && !table.trim()) {
      setError('Choose the table this trigger attaches to.');
      return;
    }
    if (kind === 'procedure' && routineType === 'FUNCTION' && !returnType.trim()) {
      setError('Choose a return type.');
      return;
    }
    if (!body.trim()) {
      setError('The body cannot be empty.');
      return;
    }
    const statements = buildStatements();
    if (!statements) {
      setError('Could not build the statement.');
      return;
    }
    setSaving(true);
    try {
      for (const sql of statements) {
        await safeInvoke('execute_query', {
          request: { config: config!, sql },
          queryId: `save_obj_${kind}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          __meta: { source: 'ddl' },
        });
      }
      setDirty(false);
      pushToast({ severity: 'success', title: `${displayLabel} saved`, message: name.trim() });
      // Nudge any open Explorer tree to refresh this object's folder.
      window.dispatchEvent(new CustomEvent('rdsql:refresh-object-folder', { detail: { kind, connectionId: conn?.id, schemaName: ctx?.schemaName } }));
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Test Run — build the ad-hoc statement for the current kind. Views run
  //    their SELECT wrapped in a capped preview; events run the body directly
  //    (bypassing the schedule); procedures CALL the already-saved routine
  //    with user-supplied test arguments. Triggers have no standalone form
  //    (NEW/OLD only exist inside a real DML statement), so they're excluded.
  const buildTestRunSql = (): string | null => {
    const trimmedName = name.trim();
    if (kind === 'view') {
      const b = body.trim().replace(/;\s*$/, '');
      return b ? `SELECT * FROM (${b}) AS _rdsql_test_run LIMIT 200` : null;
    }
    if (kind === 'event') {
      return body.trim() || null;
    }
    if (kind === 'procedure') {
      if (!trimmedName) return null;
      const ref = ctx?.schemaName
        ? `${quoteIdent(engine, ctx.schemaName)}.${quoteIdent(engine, trimmedName)}`
        : quoteIdent(engine, trimmedName);
      // FUNCTIONs return a value and are invoked with SELECT; PROCEDUREs have
      // no result and use CALL — using the wrong one is a syntax error on both engines.
      return routineType === 'FUNCTION' ? `SELECT ${ref}(${testArgs.trim()});` : `CALL ${ref}(${testArgs.trim()});`;
    }
    return null;
  };

  const executeTestRun = async () => {
    const sql = buildTestRunSql();
    if (!sql) {
      setRunError('Nothing to run — fill in the body first.');
      return;
    }
    setRunning(true);
    setRunError(null);
    setRunResult(null);
    try {
      const res = await safeInvoke<QueryResultData>('execute_query', {
        request: { config: config!, sql },
        queryId: `test_run_${kind}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        __meta: { source: 'ddl' },
      });
      setRunResult(res);
      pushToast({
        severity: 'success',
        title: 'Test run complete',
        message: res.rows.length > 0 ? `${res.rows.length} row(s) returned` : (res.status_message || `${res.affected_rows} row(s) affected`),
      });
    } catch (err: any) {
      setRunError(err?.message || String(err));
    } finally {
      setRunning(false);
      setShowTestArgsPrompt(false);
      setConfirmRunEvent(false);
    }
  };

  // Entry point from the "Test Run" button — procedures with parameters and
  // events (body may be destructive, e.g. a purge DELETE) get an extra
  // confirmation step before anything actually executes.
  const handleTestRunClick = () => {
    setRunError(null);
    if (kind === 'procedure') {
      const needsArgs = params.some((p) => p.name.trim());
      if (needsArgs && !showTestArgsPrompt) {
        setShowTestArgsPrompt(true);
        return;
      }
    }
    if (kind === 'event') {
      setConfirmRunEvent(true);
      return;
    }
    void executeTestRun();
  };

  // ── Ask AI to draft the body ──
  const [aiRunning, setAiRunning] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const handleAskAi = async () => {
    const p = aiPrompt.trim();
    if (!p || aiRunning) return;
    setAiRunning(true);
    setError(null);
    try {
      const schemaCtx = buildSchemaContext();
      const result = await generateSQL(ai, { prompt: `${bodyPrompt(kind, engine, { name, table, timing, events, params, routineType, returnType })} ${p}`, schemaContext: schemaCtx.text, engine });
      if (result.sql) setBody(result.sql);
      else setError('The model did not return SQL — try rephrasing.');
      setAiPrompt('');
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setAiRunning(false);
    }
  };

  if (!conn || !ctx) {
    return <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">Connection not found.</div>;
  }
  const { Icon, color } = meta;

  return (
    <div className="w-full h-full flex flex-col bg-[#06090e]">
      {/* Header: icon + kind + name field + Save */}
      <div className="h-12 shrink-0 border-b border-[#1e293b] px-3 bg-[#0a0f18] flex items-center gap-2 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          <Icon className={`w-4 h-4 ${color}`} />
          <span className="text-xs font-bold text-slate-200 whitespace-nowrap">
            {isEdit ? 'Edit' : 'New'} {displayLabel}
            <span className="text-slate-500 font-normal ml-2 whitespace-nowrap">
              {ctx.schemaName ? `${ctx.schemaName}` : conn.database || conn.name}
            </span>
          </span>
        </div>
        <div className="h-5 w-px bg-[#1e293b] mx-1 shrink-0" />
        <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider shrink-0">Name</label>
        <input
          type="text"
          value={name}
          disabled={isEdit}
          onChange={(e) => { setName(e.target.value); markDirty(); }}
          placeholder={`${displayLabel.toLowerCase()}_name`}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-7 w-56 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono shrink-0 disabled:opacity-60"
        />

        {/* Ask AI entry — opens the full assistant panel (drafts against live schema). */}
        {aiReady && (
          <button
            onClick={() => setAIPanelOpen(true)}
            className="ml-auto shrink-0 px-2 py-1 rounded-lg bg-violet-600/15 hover:bg-violet-600/25 border border-violet-500/30 text-violet-300 hover:text-violet-200 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
            title="Open the AI assistant to draft this in plain language"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Ask AI
          </button>
        )}
        {dirty && <span className="text-[10px] text-amber-400 shrink-0">unsaved</span>}
        {canTestRun && (
          <button
            onClick={handleTestRunClick}
            disabled={running || loadingDef || !body.trim() || (kind === 'procedure' && !name.trim())}
            className="shrink-0 px-3 py-1 rounded-lg bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/30 disabled:opacity-50 disabled:cursor-not-allowed text-blue-300 hover:text-blue-200 text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
            title={
              kind === 'view'
                ? 'Run the SELECT now (preview, capped at 200 rows)'
                : kind === 'event'
                ? "Run this event's body immediately, without waiting for its schedule"
                : routineType === 'FUNCTION'
                ? 'SELECT this function now with test arguments'
                : 'CALL this procedure now with test arguments'
            }
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Test Run
          </button>
        )}
        <button
          onClick={handleSave}
          disabled={saving || loadingDef || !name.trim()}
          className="shrink-0 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap"
          title="Save (build + run the DDL)"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save
        </button>
      </div>

      {/* Metadata fields (per kind) */}
      <div className="shrink-0 border-b border-[#1e293b] px-3 py-2.5 bg-[#080c14] flex flex-col gap-2.5">
        {kind === 'trigger' && (
          <div className="flex flex-col gap-2.5">
            <TabBar
              tabs={[
                { id: 'options', label: 'Options' },
                { id: 'code', label: 'CREATE code' },
              ]}
              active={metaTab}
              onChange={(t) => setMetaTab(t as 'options' | 'code')}
            />

            {metaTab === 'options' && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Table">
                  <TableComboBox
                    value={table}
                    onChange={(v) => { setTable(v); markDirty(); }}
                    options={tableOptions}
                    placeholder="table_name"
                    className={`${inputCls} w-48`}
                  />
                </Field>
                <Field label="Timing">
                  <select value={timing} onChange={(e) => { setTiming(e.target.value); markDirty(); }} className={inputCls}>
                    {['BEFORE', 'AFTER', 'INSTEAD OF'].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                {isPg && (
                  <Field label="Level">
                    <select value={level} onChange={(e) => { setLevel(e.target.value as 'ROW' | 'STATEMENT'); markDirty(); }} className={inputCls}>
                      <option value="ROW">FOR EACH ROW</option>
                      <option value="STATEMENT">FOR EACH STATEMENT</option>
                    </select>
                  </Field>
                )}
                <Field label="Events">
                  <div className="flex gap-2 h-7 items-center">
                    {['INSERT', 'UPDATE', 'DELETE'].map((evt) => (
                      <label key={evt} className="flex items-center gap-1 text-[11px] text-slate-300 cursor-pointer whitespace-nowrap">
                        <input
                          type={isMysql ? 'radio' : 'checkbox'}
                          name="trig-evt"
                          checked={events.includes(evt)}
                          onChange={() => {
                            if (isMysql) { setEvents([evt]); } else { setEvents((p) => p.includes(evt) ? p.filter((e) => e !== evt) : [...p, evt]); }
                            markDirty();
                          }}
                        />
                        {evt}
                      </label>
                    ))}
                  </div>
                </Field>
                {isPg && (
                  <Field label="Function name">
                    <input type="text" value={functionName} onChange={(e) => { setFunctionName(e.target.value); markDirty(); }} placeholder={defaultTriggerFunctionName({ table: table || 't', name: name || 'trg' })} spellCheck={false} className={`${inputCls} w-48`} />
                  </Field>
                )}
              </div>
            )}

            {metaTab === 'code' && (
              <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all bg-[#06090e] border border-[#1e293b] rounded-lg p-3 max-h-56 overflow-auto">
                {(buildStatements() || []).join('\n\n') || '-- Enter a name, table, and body to preview the generated SQL.'}
              </pre>
            )}
          </div>
        )}

        {kind === 'procedure' && (
          <div className="flex flex-col gap-2.5">
            {/* Options / Parameters / CREATE code — HeidiSQL-style tab picker.
                The tabs switch this panel only; Name (header) and Routine
                body (below) stay put regardless of which tab is active. */}
            <TabBar
              tabs={[
                { id: 'options', label: 'Options' },
                { id: 'parameters', label: 'Parameters' },
                { id: 'code', label: 'CREATE code' },
              ]}
              active={metaTab}
              onChange={(t) => setMetaTab(t as 'options' | 'parameters' | 'code')}
            />

            {metaTab === 'options' && (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Type">
                    <select
                      value={routineType}
                      onChange={(e) => {
                        const v = e.target.value as 'PROCEDURE' | 'FUNCTION';
                        setRoutineType(v);
                        if (v === 'FUNCTION' && !returnType.trim()) setReturnType(isMysql ? 'INT' : 'integer');
                        markDirty();
                      }}
                      className={`${inputCls} w-64`}
                    >
                      <option value="PROCEDURE">Procedure (doesn't return a result)</option>
                      <option value="FUNCTION">Function (returns a result)</option>
                    </select>
                  </Field>
                  <Field label="Returns">
                    <select
                      value={returnType}
                      disabled={routineType !== 'FUNCTION'}
                      onChange={(e) => { setReturnType(e.target.value); markDirty(); }}
                      className={`${inputCls} w-40 disabled:opacity-40`}
                    >
                      <option value="">—</option>
                      {getGroupedTypeOptions(engine).map((g) => (
                        <optgroup key={g.label} label={g.label}>{g.types.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}</optgroup>
                      ))}
                    </select>
                  </Field>
                  <Field label="SQL Security">
                    <select value={sqlSecurity} onChange={(e) => { setSqlSecurity(e.target.value as 'DEFINER' | 'INVOKER'); markDirty(); }} className={inputCls}>
                      <option value="DEFINER">Definer</option>
                      <option value="INVOKER">Invoker</option>
                    </select>
                  </Field>
                  {isMysql && (
                    <Field label="Data access">
                      <select value={dataAccess} onChange={(e) => { setDataAccess(e.target.value); markDirty(); }} className={`${inputCls} w-44`}>
                        {['CONTAINS SQL', 'NO SQL', 'READS SQL DATA', 'MODIFIES SQL DATA'].map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </Field>
                  )}
                  {isMysql && (
                    <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer h-7">
                      <input type="checkbox" checked={deterministic} onChange={(e) => { setDeterministic(e.target.checked); markDirty(); }} className="h-3.5 w-3.5" />
                      Deterministic
                    </label>
                  )}
                </div>
                <Field label="Definer">
                  <input
                    type="text"
                    value={definer}
                    disabled={!isMysql}
                    onChange={(e) => { setDefiner(e.target.value); markDirty(); }}
                    placeholder={isMysql ? "Current user (e.g. 'root'@'%')" : 'Not supported on Postgres'}
                    spellCheck={false}
                    className={`${inputCls} w-72 disabled:opacity-40`}
                  />
                </Field>
                <Field label="Comment">
                  <input
                    type="text"
                    value={comment}
                    onChange={(e) => { setComment(e.target.value); markDirty(); }}
                    placeholder="Optional description"
                    spellCheck={false}
                    className={`${inputCls} w-full`}
                  />
                </Field>
              </div>
            )}

            {metaTab === 'parameters' && (
              <ParamGrid
                params={params}
                setParams={setParams}
                markDirty={markDirty}
                engine={engine}
                isMysql={isMysql}
                routineType={routineType}
              />
            )}

            {metaTab === 'code' && (
              <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all bg-[#06090e] border border-[#1e293b] rounded-lg p-3 max-h-56 overflow-auto">
                {(buildStatements() || []).join('\n\n') || '-- Enter a name and body to preview the generated SQL.'}
              </pre>
            )}

            {showTestArgsPrompt && (
              <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/5 px-2.5 py-2">
                <Play className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                <div className="flex-1 flex flex-col gap-1">
                  <span className="text-[10px] text-slate-400">
                    Test arguments (raw SQL, e.g. <span className="font-mono text-slate-300">1, 'abc', NULL</span>)
                  </span>
                  <input
                    autoFocus
                    value={testArgs}
                    onChange={(e) => setTestArgs(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void executeTestRun(); }
                      if (e.key === 'Escape') setShowTestArgsPrompt(false);
                    }}
                    placeholder="arg1, arg2, ..."
                    spellCheck={false}
                    className="h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none font-mono"
                  />
                </div>
                <button
                  onClick={() => void executeTestRun()}
                  disabled={running}
                  className="h-7 px-2.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[10.5px] font-semibold flex items-center gap-1 shrink-0"
                >
                  {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run
                </button>
                <button
                  onClick={() => setShowTestArgsPrompt(false)}
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-[#1e293b] text-slate-500 hover:text-slate-300 shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {kind === 'event' && (
          <div className="flex flex-col gap-2.5">
            <TabBar
              tabs={[
                { id: 'options', label: 'Options' },
                { id: 'code', label: 'CREATE code' },
              ]}
              active={metaTab}
              onChange={(t) => setMetaTab(t as 'options' | 'code')}
            />

            {metaTab === 'options' && (
              <div className="flex flex-wrap items-end gap-3">
                {isPg ? (
                  <Field label="Cron schedule (pg_cron)">
                    <input type="text" value={cronSchedule} onChange={(e) => { setCronSchedule(e.target.value); markDirty(); }} placeholder="*/5 * * * *" spellCheck={false} className={`${inputCls} w-44 font-mono`} />
                  </Field>
                ) : (
                  <>
                    <Field label="Type">
                      <select value={scheduleType} onChange={(e) => { setScheduleType(e.target.value as 'ONE TIME' | 'RECURRING'); markDirty(); }} className={inputCls}>
                        <option value="RECURRING">Recurring</option>
                        <option value="ONE TIME">One time</option>
                      </select>
                    </Field>
                    {scheduleType === 'ONE TIME' ? (
                      <Field label="Run at">
                        <input type="datetime-local" value={executeAt.replace(' ', 'T').slice(0, 16)} onChange={(e) => { setExecuteAt(e.target.value.replace('T', ' ')); markDirty(); }} className={inputCls} />
                      </Field>
                    ) : (
                      <Field label="Every">
                        <div className="flex gap-2">
                          <input type="number" min={1} value={intervalValue} onChange={(e) => { setIntervalValue(e.target.value); markDirty(); }} className={`${inputCls} w-16`} />
                          <select value={intervalField} onChange={(e) => { setIntervalField(e.target.value); markDirty(); }} className={inputCls}>
                            {INTERVAL_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                          </select>
                        </div>
                      </Field>
                    )}
                    <Field label="Status">
                      <select value={status} onChange={(e) => { setStatus(e.target.value as 'ENABLED' | 'DISABLED'); markDirty(); }} className={inputCls}>
                        <option value="ENABLED">Enabled</option>
                        <option value="DISABLED">Disabled</option>
                      </select>
                    </Field>
                    <Field label="Preserve">
                      <input type="checkbox" checked={onCompletionPreserve} onChange={(e) => { setOnCompletionPreserve(e.target.checked); markDirty(); }} className="h-4 w-4" />
                    </Field>
                  </>
                )}
              </div>
            )}

            {metaTab === 'code' && (
              <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all bg-[#06090e] border border-[#1e293b] rounded-lg p-3 max-h-56 overflow-auto">
                {(buildStatements() || []).join('\n\n') || '-- Enter a name and body to preview the generated SQL.'}
              </pre>
            )}
          </div>
        )}

        {kind === 'view' && (
          <div className="text-[10.5px] text-slate-500">
            A view is a saved <span className="font-mono text-slate-400">SELECT</span>. Edit the query below and press <span className="font-mono text-emerald-400">Save</span> — it runs <span className="font-mono">CREATE OR REPLACE VIEW</span> on the connection.
          </div>
        )}

        {/* Inline AI draft row — quick "draft the body" without opening the full panel. */}
        {aiReady && (
          <div className="flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAskAi(); } }}
              placeholder={`Describe the ${displayLabel.toLowerCase()} body (e.g. "${kind === 'event' ? 'purge rows older than 30 days' : kind === 'trigger' ? 'set updated_at on update' : '...'}")`}
              disabled={aiRunning}
              spellCheck={false}
              className="flex-1 h-7 box-border bg-[#06090e] border border-violet-500/30 focus:border-violet-400 rounded px-2 text-[11px] text-slate-100 focus:outline-none disabled:opacity-60"
            />
            <button onClick={handleAskAi} disabled={aiRunning || !aiPrompt.trim()} className="h-7 px-2 rounded bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/30 text-violet-300 text-[10.5px] font-semibold flex items-center gap-1 disabled:opacity-40 whitespace-nowrap shrink-0">
              {aiRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {aiRunning ? 'Drafting…' : 'Draft body'}
            </button>
          </div>
        )}

        {error && <CopyableErrorBanner message={error} parseAsDbError tone="red" compact />}
      </div>

      {/* Body editor (Monaco) */}
      <div className="flex-1 relative min-h-0">
        {loadingDef ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-slate-500 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading definition…
          </div>
        ) : (
          <Editor
            height="100%"
            defaultLanguage="sql"
            theme="vs-dark"
            value={body}
            onChange={(v) => { setBody(v ?? ''); markDirty(); }}
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              minimap: { enabled: false },
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              padding: { top: 8 },
            }}
          />
        )}
      </div>

      {/* Test Run result — bottom-docked + drag-resizable, same position as
          the SQL editor's ResultPanel. Dismissible, shown until the next run
          or a tab switch. */}
      {(runResult || runError) && (
        <>
          <div
            onMouseDown={(e) => {
              resizeAnchorRef.current = e.clientY + testResultHeight;
              setIsResizingTestResult(true);
            }}
            className="h-1.5 w-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-row-resize z-30 transition-colors shrink-0"
            title="Drag to resize result panel"
          />
          <div
            style={{ height: testResultHeight }}
            className="min-h-[120px] shrink-0 border-t border-[#1e293b] bg-[#080c14] px-3 py-2.5 flex flex-col gap-2 overflow-hidden"
          >
            <div className="flex items-center justify-between shrink-0">
              <span className="text-[10px] font-semibold text-blue-300 uppercase tracking-wider flex items-center gap-1.5">
                <Play className="w-3 h-3" /> Test Run Result
              </span>
              <button
                onClick={() => { setRunResult(null); setRunError(null); }}
                className="text-slate-500 hover:text-slate-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {runError && <CopyableErrorBanner message={runError} parseAsDbError tone="red" compact />}
            {runResult && (
              <div className="flex-1 flex flex-col gap-1.5 min-h-0">
                <span className="text-[10.5px] text-slate-500 shrink-0">
                  {runResult.status_message || `${runResult.affected_rows} row(s) affected`} · {runResult.execution_time_ms}ms
                </span>
                {runResult.rows.length > 0 && (
                  <div className="flex-1 overflow-auto border border-[#1e293b] rounded-lg macos-scroll">
                    <table className="w-full text-[10.5px] font-mono border-collapse">
                      <thead className="sticky top-0 bg-[#0f172a]">
                        <tr>
                          {runResult.columns.map((c) => (
                            <th key={c.name} className="text-left px-2 py-1 text-slate-400 font-semibold border-b border-[#1e293b] whitespace-nowrap">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {runResult.rows.map((row, i) => (
                          <tr key={i} className="odd:bg-white/[0.02]">
                            {row.map((cell, j) => (
                              <td key={j} className="px-2 py-1 text-slate-300 whitespace-nowrap border-b border-[#1e293b]/50">
                                {cell === null ? <span className="text-slate-600 italic">NULL</span> : String(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {confirmRunEvent && (
        <ConfirmDialog
          title="Run event body now?"
          message={
            <>
              This executes the event's body immediately against <span className="font-mono text-slate-300">{conn.name}</span> —
              it does not wait for the schedule, and the statement runs for real (not a dry run).
            </>
          }
          confirmLabel={running ? 'Running…' : 'Run Now'}
          tone="warning"
          loading={running}
          onConfirm={() => void executeTestRun()}
          onClose={() => setConfirmRunEvent(false)}
        >
          <pre className="text-[11px] font-mono text-slate-400 whitespace-pre-wrap break-all bg-[#06090e] border border-[#1e293b] rounded-lg p-2 max-h-32 overflow-auto">
            {body.trim()}
          </pre>
        </ConfirmDialog>
      )}
    </div>
  );
};

const inputCls =
  "h-7 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none";

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1">
    <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">{label}</label>
    {children}
  </div>
);

/** HeidiSQL-style segmented tab picker — shared by Procedure/Function (Options
 *  / Parameters / CREATE code) and Trigger/Event (Options / CREATE code). */
const TabBar: React.FC<{
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}> = ({ tabs, active, onChange }) => (
  <div className="inline-flex self-start rounded-lg border border-[#1e293b] bg-[#0f172a] p-0.5 gap-0.5">
    {tabs.map((t) => (
      <button
        key={t.id}
        type="button"
        onClick={() => onChange(t.id)}
        className={`px-3 py-1 rounded-md text-[10.5px] font-semibold transition-colors ${
          active === t.id ? 'bg-[#1e293b] text-slate-100' : 'text-slate-500 hover:text-slate-300'
        }`}
      >
        {t.label}
      </button>
    ))}
  </div>
);

/** Procedure/Function parameter grid — one row per param, ordered Param /
 *  Data Type / In-Out to match how you'd read a call signature left-to-right.
 *  In/Out gets a fixed-width column since its values are short and constant
 *  ("IN"/"OUT"/"INOUT"), unlike the name/type columns which need the room. */
const ParamGrid: React.FC<{
  params: ParamRow[];
  setParams: React.Dispatch<React.SetStateAction<ParamRow[]>>;
  markDirty: () => void;
  engine: string;
  isMysql: boolean;
  routineType: 'PROCEDURE' | 'FUNCTION';
}> = ({ params, setParams, markDirty, engine, isMysql, routineType }) => {
  // MySQL FUNCTION params have no mode keyword at all (every param is
  // implicitly IN); Postgres FUNCTION accepts OUT natively, PROCEDURE doesn't.
  const modeOptions = isMysql
    ? routineType === 'FUNCTION' ? ['IN'] : ['IN', 'OUT', 'INOUT']
    : routineType === 'FUNCTION' ? ['IN', 'OUT', 'INOUT'] : ['IN', 'INOUT'];
  const modeDisabled = isMysql && routineType === 'FUNCTION';
  const cols = 'grid-cols-[1fr_1fr_92px_28px]';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Parameters</span>
        <button onClick={() => { setParams((p) => [...p, newParamRow()]); markDirty(); }} className="px-2 py-0.5 rounded bg-blue-600/20 text-blue-300 hover:bg-blue-600/30 flex items-center gap-1 text-[10.5px] font-semibold">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      <div className="border border-[#1e293b] rounded-lg overflow-hidden">
        <div className={`grid ${cols} gap-2 px-2 py-1.5 bg-[#0f172a] text-[9.5px] uppercase tracking-wider text-slate-500 font-semibold`}>
          <span>Param</span><span>Data Type</span><span>In/Out</span><span />
        </div>
        <div className="max-h-40 overflow-y-auto">
          {params.map((p) => (
            <div key={p.id} className={`grid ${cols} gap-2 px-2 py-1.5 items-center border-t border-[#1e293b]/50`}>
              <input
                value={p.name}
                onChange={(e) => { setParams((arr) => arr.map((x) => x.id === p.id ? { ...x, name: e.target.value } : x)); markDirty(); }}
                placeholder="param_name"
                spellCheck={false}
                className="h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none font-mono"
              />
              <select
                value={p.type}
                onChange={(e) => { setParams((arr) => arr.map((x) => x.id === p.id ? { ...x, type: e.target.value } : x)); markDirty(); }}
                className="h-7 box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-[11px] text-slate-100 focus:outline-none"
              >
                {getGroupedTypeOptions(engine).map((g) => (
                  <optgroup key={g.label} label={g.label}>{g.types.map((t) => <option key={t.label} value={t.label}>{t.label}</option>)}</optgroup>
                ))}
              </select>
              <select
                value={p.mode}
                disabled={modeDisabled}
                onChange={(e) => { setParams((arr) => arr.map((x) => x.id === p.id ? { ...x, mode: e.target.value as ProcedureParam['mode'] } : x)); markDirty(); }}
                className="h-7 w-full box-border bg-[#06090e] border border-[#1e293b] focus:border-blue-500 rounded px-1 text-[10.5px] text-slate-100 focus:outline-none disabled:opacity-40"
              >
                {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button
                onClick={() => { setParams((arr) => arr.filter((x) => x.id !== p.id)); markDirty(); }}
                disabled={params.length === 1}
                className="w-7 h-7 flex items-center justify-center rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-400 disabled:opacity-30"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/** Free-text input with a filtered, click-to-select dropdown of known table
 *  (and view) names — used for the trigger "Table" field so the user can
 *  search the schema instead of typing an exact name from memory. Stays a
 *  plain text input underneath (still typeable/clearable) since the target
 *  table doesn't have to already exist in the cached tree. */
const TableComboBox: React.FC<{
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
}> = ({ value, onChange, options, placeholder, className }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const q = value.trim().toLowerCase();
  const filtered = q ? options.filter((t) => t.toLowerCase().includes(q)) : options;

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={className}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 top-full left-0 mt-1 w-56 max-h-48 overflow-y-auto bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl py-1 macos-scroll">
          {filtered.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { onChange(t); setOpen(false); }}
              className="w-full text-left px-2.5 py-1.5 text-[11px] font-mono text-slate-200 hover:bg-[#141e33] truncate block"
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Builds the instruction prefix sent to the AI for "Draft body". The user's
 *  prompt is appended after this. */
function bodyPrompt(
  kind: 'view' | 'trigger' | 'procedure' | 'event',
  engine: string,
  s: { name: string; table: string; timing: string; events: string[]; params: ParamRow[]; routineType?: 'PROCEDURE' | 'FUNCTION'; returnType?: string }
): string {
  const pg = isPostgresFamily(engine);
  if (kind === 'view') return `Write a single SELECT statement for a database VIEW named "${s.name}". Return ONLY the SELECT — no CREATE VIEW.`;
  if (kind === 'trigger') {
    return pg
      ? `Write the body of a plpgsql trigger FUNCTION for trigger "${s.name}" firing ${s.timing} ${s.events.join(' OR ') || 'INSERT'} on "${s.table}". Use NEW/OLD; end with RETURN NEW; or RETURN OLD;. Return ONLY the statements between BEGIN and END.`
      : `Write the action statement(s) for a trigger "${s.name}" firing ${s.timing} ${s.events[0] || 'INSERT'} on "${s.table}" FOR EACH ROW (use NEW/OLD). Return ONLY the statements.`;
  }
  if (kind === 'procedure') {
    const pl = s.params.filter((p) => p.name.trim()).map((p) => `${p.mode} ${p.name} ${p.type}`).join(', ');
    const isFunction = s.routineType === 'FUNCTION';
    const routineWord = isFunction ? 'FUNCTION' : 'PROCEDURE';
    const returnsClause = isFunction ? ` that RETURNS ${s.returnType || 'a value'} (end with a RETURN statement)` : '';
    return `Write the body of a stored ${routineWord} named "${s.name}"${returnsClause}${pl ? ` with parameters ${pl}` : ' with no parameters'}. Return ONLY the statements between BEGIN and END.`;
  }
  return `Write the single SQL statement a scheduled EVENT should run. Return ONLY the SQL statement.`;
}
