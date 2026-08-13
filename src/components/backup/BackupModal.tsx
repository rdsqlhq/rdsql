import React, { useEffect, useMemo, useRef, useState } from 'react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, remove } from '@tauri-apps/plugin-fs';
import {
  X,
  HardDriveDownload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Database as DatabaseIcon,
  Table as TableIcon,
  FolderOpen,
  Copy,
  Check,
  Link2,
  Cloud,
} from 'lucide-react';
import { DatabaseConnection, QueryResultData, QueryColumn, SchemaGroupNode, SchemaTableNode } from '../../core/domain/types';
import { safeInvoke } from '../../core/tauri/ipc';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import {
  generateInsertStatements,
  pickChunkStrategy,
  selectKeysetChunkSql,
  selectOffsetChunkSql,
} from '../../core/backup/backupSql';
import { buildBackupPlan, generateDataStatements, type TableSelection } from '../../core/backup/backupEngine';
import { describeFsError } from '../../core/utils/fsErrors';
import { copyToClipboard } from '../../core/utils/clipboard';
import { tempDir } from '../../core/utils/tempDir';
// S3 destination (Phase 5) — purely additive imports; the backup engine itself
// is unchanged. These power the optional S3 upload of the assembled script.
import { useStorageStore } from '../../store/useStorageStore';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { serializeMetadata, metadataKeyFor } from '../../core/storage/domain/metadata';
import { normalizePrefix } from '../../core/storage/domain/paths';

interface BackupModalProps {
  connection: DatabaseConnection;
  onClose: () => void;
  /** Pre-select this schema/database when the tree loads (e.g. when opened
   *  from a specific database node's context menu rather than the
   *  connection's). Falls back to the first group if not found. */
  initialGroupName?: string;
}

type LogKind = 'info' | 'success' | 'error';

/** Build a deterministic S3 key for a backup under the user's chosen path.
 *  If `s3Path` already names a full filename (has a suffix), use it verbatim;
 *  otherwise treat it as a folder and place `filename` (± .gz) inside it. */
function buildS3BackupKey(s3Path: string, filename: string, gzip: boolean): string {
  const p = (s3Path || '').trim();
  const fname = gzip && !/\.gz$/i.test(filename) ? `${filename}.gz` : filename;
  // If the path looks like a file (has an extension and no trailing slash),
  // honor it verbatim; otherwise treat as a prefix and append the filename.
  if (p && !p.endsWith('/') && /\.[A-Za-z0-9]+$/.test(p)) return p;
  return `${normalizePrefix(p)}${fname}`;
}

function formatBytes(bytes?: number | null): string {
  if (!bytes || typeof bytes !== 'number' || bytes <= 0) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatRowCount(count?: number | null): string {
  if (typeof count !== 'number') return '—';
  return count.toLocaleString();
}

/** Rows fetched per page during the data phase. Bounds memory/IPC payload
 *  size regardless of table size — a 50M-row table is read as ~10k pages of
 *  this size instead of one unbounded `SELECT *`. */
const DATA_CHUNK_SIZE = 5000;

/** Where we are within one table's data phase — enough to resume a paused
 *  backup exactly where it stopped instead of re-reading from row 0. */
interface DataCursor {
  mode: 'keyset' | 'offset';
  /** Last primary-key value seen (keyset mode) — null before the first page. */
  lastKeyVal: unknown;
  /** Rows skipped so far (offset-fallback mode). */
  offset: number;
  /** Rows processed so far for THIS table — drives the row-progress bar and
   *  the "first N rows" cap. */
  rowsProcessed: number;
}

export const BackupModal: React.FC<BackupModalProps> = ({ connection, onClose, initialGroupName }) => {
  const { connections } = useConnectionStore();
  const [running, setRunning] = useState(false);
  useEscapeToClose(running ? null : onClose);
  // Only show same-engine connections as valid backup destinations — types are
  // emitted verbatim (no cross-engine conversion), so a MySQL→Postgres copy
  // would produce invalid DDL.
  const sameEngineConnections = useMemo(
    () => connections.filter((c) => c.id !== connection.id && c.engine === connection.engine),
    [connections, connection.id, connection.engine]
  );

  const [groups, setGroups] = useState<SchemaGroupNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null);
  const [selections, setSelections] = useState<Map<string, TableSelection>>(new Map());

  const [destination, setDestination] = useState<'file' | 'connection' | 's3'>('file');
  const [targetConnectionId, setTargetConnectionId] = useState<string>('');
  /** Databases discovered on the target connection (fetched lazily when picked). */
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [targetDbLoading, setTargetDbLoading] = useState(false);
  const [targetDatabaseName, setTargetDatabaseName] = useState<string>('');
  const [fileName, setFileName] = useState('backup.sql');
  /** Chosen output directory (native folder picker). When set, the backup is
   *  written directly to `<saveDirectory>/<fileName>` without popping the save
   *  dialog again. When empty, the native save() dialog is used instead. */
  const [saveDirectory, setSaveDirectory] = useState<string | null>(null);

  // S3 destination state. When `destination === 's3'`, the assembled script is
  // written to a temp file and streamed up via `s3_upload_object`; an optional
  // gzip pass and a versioned `.meta.json` sidecar are uploaded alongside.
  const [s3ConnectionId, setS3ConnectionId] = useState<string>('');
  const [s3Path, setS3Path] = useState<string>('');
  const [s3Gzip, setS3Gzip] = useState(false);

  // Data dump options
  /** "all" dumps every row; "limit" caps to `dataLimit` rows per table. */
  const [dataMode, setDataMode] = useState<'all' | 'limit'>('all');
  const [dataLimit, setDataLimit] = useState<number>(100);
  /** How to treat existing rows in the destination before inserting. */
  const [writeMode, setWriteMode] = useState<'insert' | 'truncate' | 'drop'>('insert');
  /** File/S3 destinations only ('connection' is always unqualified — see
   *  `targetSchema` below). When false (default), CREATE/INSERT/DROP target
   *  bare table names so the file replays into whatever database the
   *  restoring connection is pointed at. When true, every statement is
   *  qualified with THIS source database's name — restoring then requires a
   *  same-named database to already exist on the target server. */
  const [qualifyWithDbName, setQualifyWithDbName] = useState(false);
  /** When true, the first statement-level error aborts the whole backup. */
  const [stopOnError, setStopOnError] = useState(true);
  /** Speed mode: 'safe' sends one statement per IPC call (reliable but slow).
   *  'fast' batches multiple statements into a single IPC call (much faster). */
  const [speedMode, setSpeedMode] = useState<'fast' | 'safe'>('fast');

  const [done, setDone] = useState(false);
  const [hadError, setHadError] = useState(false);
  /** True when a run stopped on error mid-way but is resumable (data phase
   *  only — see `pauseHere` in handleStart). Distinct from `done`: a paused
   *  run is neither finished nor safe to restart from scratch. */
  const [paused, setPaused] = useState(false);
  const [log, setLog] = useState<{ text: string; kind: LogKind }[]>([]);
  const [copiedLog, setCopiedLog] = useState(false);
  /** Local path the full run log was last written to (best-effort — see
   *  `persistLog` in handleStart). Shown so the user can find it even after
   *  closing the modal. */
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [totalTables, setTotalTables] = useState(0);
  /** Name of the table currently being processed (shown in the progress label). */
  const [currentTable, setCurrentTable] = useState<string | null>(null);
  /** Current phase: "reading" (SELECT source) / "applying" (writing to dest). */
  const [currentStep, setCurrentStep] = useState<string | null>(null);
  /** Sub-progress within a table (e.g. "statement 3/15"). */
  const [stmtProgress, setStmtProgress] = useState<{ done: number; total: number } | null>(null);
  /** Row-level progress within the table currently being read (data phase). */
  const [rowProgress, setRowProgress] = useState<{ done: number; total: number | null } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  /** Set by `pauseHere` to a closure that continues the data phase exactly
   *  where it stopped. Cleared on a fresh "Start Backup". Living entirely as
   *  a closure (not serialized state) means resume only survives while this
   *  modal instance stays mounted — closing it discards the checkpoint,
   *  same as any in-memory progress. */
  const resumeRef = useRef<(() => Promise<void>) | null>(null);

  // Auto-scroll the log to the bottom whenever new entries arrive so the user
  // always sees the latest progress without manual scrolling.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [log.length]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingTree(true);
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', { config: connection });
        if (cancelled) return;
        setGroups(tree || []);
        if (tree && tree.length > 0) {
          const preferred = initialGroupName && tree.some((g) => g.name === initialGroupName) ? initialGroupName : tree[0].name;
          setSelectedGroupName(preferred);
        }
      } catch {
        if (!cancelled) setGroups([]);
      } finally {
        if (!cancelled) setLoadingTree(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  const groupTables: SchemaTableNode[] = useMemo(
    () => groups.find((g) => g.name === selectedGroupName)?.children || [],
    [groups, selectedGroupName]
  );

  useEffect(() => {
    const next = new Map<string, TableSelection>();
    groupTables.forEach((t) => next.set(t.name, { structure: true, data: true }));
    setSelections(next);
  }, [groupTables]);

  useEffect(() => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const label = selectedGroupName || connection.database || 'backup';
    setFileName(`${connection.name.replace(/\s+/g, '_')}_${label}_${stamp}.sql`);
  }, [connection.name, connection.database, selectedGroupName]);

  // When the user picks a target connection, fetch its schema tree to populate
  // the database dropdown. SQLite/D1 have a single file so this is skipped.
  useEffect(() => {
    if (!targetConnectionId) {
      setTargetDatabases([]);
      setTargetDatabaseName('');
      return;
    }
    const targetConn = connections.find((c) => c.id === targetConnectionId);
    if (!targetConn) return;
    // File-based engines don't have multiple databases.
    if (targetConn.engine === 'sqlite' || targetConn.engine === 'cloudflare-d1') {
      setTargetDatabases([]);
      setTargetDatabaseName(targetConn.database || '');
      return;
    }
    let cancelled = false;
    setTargetDbLoading(true);
    (async () => {
      try {
        const tree = await safeInvoke<SchemaGroupNode[]>('fetch_schema_tree', { config: targetConn });
        if (cancelled) return;
        const dbNames = (tree || []).map((g) => g.name);
        setTargetDatabases(dbNames);
        setTargetDatabaseName('');
      } catch {
        if (!cancelled) setTargetDatabases([]);
      } finally {
        if (!cancelled) setTargetDbLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetConnectionId, connections]);

  const toggleAll = (field: keyof TableSelection, value: boolean) => {
    setSelections((prev) => {
      const next = new Map(prev);
      groupTables.forEach((t) => {
        const cur = next.get(t.name) || { structure: true, data: true };
        next.set(t.name, { ...cur, [field]: value });
      });
      return next;
    });
  };

  const toggleTable = (tableName: string, field: keyof TableSelection) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const cur = next.get(tableName) || { structure: true, data: true };
      next.set(tableName, { ...cur, [field]: !cur[field] });
      return next;
    });
  };

  /** Mirrors `log` state synchronously so `persistLog` (called mid-flight,
   *  where state updates haven't flushed yet) always has the full history. */
  const logLinesRef = useRef<{ text: string; kind: LogKind }[]>([]);

  const appendLog = (text: string, kind: LogKind = 'info') => {
    logLinesRef.current = [...logLinesRef.current, { text, kind }];
    setLog(logLinesRef.current);
  };

  /** Best-effort: write the full run log to a local text file next to the
   *  output (or a temp dir for live-connection destinations) so it survives
   *  even if the user never copies it. Failure here must never break the
   *  backup itself. */
  const persistLog = async (basePathHint: string | null) => {
    try {
      const base = basePathHint
        ? basePathHint.replace(/\.sql$/i, '')
        : `${await tempDir()}/rdsql_backup_${connection.name.replace(/\s+/g, '_')}_${Date.now()}`;
      const path = `${base}.log.txt`;
      const text = logLinesRef.current.map((l) => `[${l.kind.toUpperCase()}] ${l.text}`).join('\n');
      await writeTextFile(path, text);
      setLogFilePath(path);
    } catch {
      // Best-effort only — the in-app log (and its Copy button) still works.
    }
  };

  const handleCopyLog = async () => {
    await copyToClipboard(log.map((l) => l.text).join('\n'));
    setCopiedLog(true);
    setTimeout(() => setCopiedLog(false), 2000);
  };

  const handlePickFolder = async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (dir && typeof dir === 'string') {
        setSaveDirectory(dir);
      }
    } catch {
      // Dialog dismissed or unavailable — no-op.
    }
  };

  const handleStart = async () => {
    const chosenTables = groupTables.filter((t) => {
      const sel = selections.get(t.name);
      return sel && (sel.structure || sel.data);
    });

    if (chosenTables.length === 0) {
      setLog([{ text: 'Select at least one table with structure or data checked.', kind: 'error' }]);
      return;
    }
    if (destination === 'connection') {
      if (!targetConnectionId) {
        setLog([{ text: 'Choose a destination connection.', kind: 'error' }]);
        return;
      }
      const targetConn = connections.find((c) => c.id === targetConnectionId);
      if (targetConn && targetConn.engine !== 'sqlite' && targetConn.engine !== 'cloudflare-d1' && !targetDatabaseName) {
        setLog([{ text: 'Choose a destination database on the target connection.', kind: 'error' }]);
        return;
      }
    }
    if (destination === 's3') {
      if (!s3ConnectionId) {
        setLog([{ text: 'Choose a storage connection for the S3 destination.', kind: 'error' }]);
        return;
      }
    }

    setRunning(true);
    setDone(false);
    setPaused(false);
    setHadError(false);
    setLog([]);
    logLinesRef.current = [];
    setLogFilePath(null);
    setProgress(0);
    setTotalTables(chosenTables.length);
    setCurrentTable(null);
    setCurrentStep('Planning backup…');
    setStmtProgress(null);
    setRowProgress(null);
    resumeRef.current = null;

    const targetConn =
      destination === 'connection' ? connections.find((c) => c.id === targetConnectionId) || null : null;
    const effectiveLimit = dataMode === 'limit' && dataLimit > 0 ? dataLimit : undefined;

    // Build the execution plan — sorted by dependency, phased.
    // Live-DB destinations never qualify — the applyConn config already has
    // `database` set, so qualifying table names with the DB name causes
    // case-sensitivity issues on MySQL (Test_db ≠ test_db). File/S3 output
    // defaults to unqualified too (portable — restores into whatever
    // database the target connection is pointed at, regardless of what this
    // source database is named); `qualifyWithDbName` opts back into the old
    // self-contained-with-explicit-name behavior.
    const plan = buildBackupPlan({
      engine: connection.engine,
      tables: chosenTables,
      selections,
      schema: selectedGroupName || connection.database || '',
      writeMode,
      targetSchema: destination === 'connection' || !qualifyWithDbName ? null : undefined,
    });

    setTotalTables(plan.totalTables);
    appendLog(`Plan: ${plan.totalTables} tables, ${plan.items.length} statements${plan.hasCycle ? ' (FK cycle detected — FK-disable recommended)' : ''}`);

    // Apply connection (for live-DB destination).
    const applyConn = targetConn
      ? targetDatabaseName
        ? { ...targetConn, database: targetDatabaseName }
        : targetConn
      : null;

    // ── Resolve the output target UP FRONT, before any reading/writing ───
    // Previously the save dialog (file mode) and S3 lookup (s3 mode) only
    // ran AFTER the whole backup had been assembled in memory — so a
    // cancelled dialog, or a missing storage connection, threw away all that
    // work. Resolving here means we fail fast, and — since data below is
    // streamed straight to `outputPath` chunk by chunk instead of being
    // built up as one giant in-memory string — a multi-GB table no longer
    // has to fit in memory before it can be written out.
    let outputPath: string | null = null; // local file path data is appended to (file dest, or s3 temp raw file)
    let s3Ctx: {
      s3Conn: ReturnType<typeof useStorageStore.getState>['connections'][number];
      tmpDir: string;
      baseName: string;
    } | null = null;

    if (destination === 'file') {
      try {
        if (saveDirectory) {
          const sep = saveDirectory.includes('\\') && !saveDirectory.includes('/') ? '\\' : '/';
          outputPath = `${saveDirectory}${sep}${fileName}`;
        } else {
          outputPath = await save({ defaultPath: fileName, filters: [{ name: 'SQL', extensions: ['sql'] }] });
        }
      } catch (err: any) {
        appendLog(describeFsError(err, 'write'), 'error');
        setRunning(false);
        setDone(true);
        setHadError(true);
        return;
      }
      if (!outputPath) {
        appendLog('Save cancelled.', 'error');
        setRunning(false);
        return;
      }
    } else if (destination === 's3') {
      const s3Conn = useStorageStore.getState().connections.find((c) => c.id === s3ConnectionId);
      if (!s3Conn) {
        appendLog('No storage connection selected.', 'error');
        setRunning(false);
        setDone(true);
        setHadError(true);
        return;
      }
      const tmpDir = await tempDir();
      const baseName = s3Gzip ? fileName.replace(/\.gz$/i, '') : fileName;
      outputPath = `${tmpDir}/${baseName}.tmp`;
      s3Ctx = { s3Conn, tmpDir, baseName };
    }

    // First write creates/truncates the file; every write after this one
    // appends, so no phase ever holds the whole script in memory at once.
    const writeChunk = async (text: string, first = false) => {
      if (!outputPath) return;
      await writeTextFile(outputPath, text, first ? undefined : { append: true });
    };

    if (outputPath) {
      await writeChunk(
        [
          `-- rdSQL Backup`,
          `-- Format-Version: 2`,
          `-- Engine: ${connection.engine}`,
          `-- Source: ${connection.name}${selectedGroupName ? ` / ${selectedGroupName}` : ''}`,
          `-- Tables: ${plan.totalTables}`,
          `-- Has-FK: ${plan.hasCycle || chosenTables.some((t) => t.children?.some((c) => c.is_foreign_key))}`,
          `-- Generated: ${new Date().toISOString()}`,
          '',
        ].join('\n'),
        true
      );
    }

    // ── FK disable: attempt at runtime, gracefully fall back ─────────────
    // For PostgreSQL, session_replication_role requires superuser. If it fails,
    // we log a warning and rely on dependency ordering alone.
    // NOTE: each `execute_query` IPC call opens its own DB connection (see
    // query.rs) — a pragma/SET set in one call does not carry over to the
    // next. Against a live "connection" destination this only actually
    // protects statements sent in the SAME call as the disable itself; the
    // topological table ordering (parents before children) is what really
    // keeps inserts FK-safe here. Left as-is — fixing that needs a
    // session-scoped connection on the Rust side, out of scope for this pass.
    let fkDisabled = false;
    if (plan.capabilities.canDisableFkChecks && plan.capabilities.fkDisableSql) {
      await writeChunk(plan.capabilities.fkDisableSql + '\n\n');
      if (destination === 'connection' && applyConn) {
        try {
          await safeInvoke('execute_query', { request: { config: applyConn, sql: plan.capabilities.fkDisableSql }, queryId: `backup_fk_off_${Date.now()}` });
          fkDisabled = true;
        } catch {
          appendLog(`Warning: Could not disable FK checks (${plan.capabilities.engine} privilege required). Relying on dependency ordering.`, 'error');
        }
      }
    }

    const errorBox = { any: false };
    let tablesCompleted = 0;

    // Helper: execute a batch of SQL statements against the destination. In
    // 'fast' mode, all statements are joined into one IPC call (one connection
    // cycle). In 'safe' mode, each statement gets its own IPC call.
    // The IPC layer logs every statement via `__meta: { source: 'backup' }`.
    const applyBatch = async (stmts: string[], label: string): Promise<boolean> => {
      if (stmts.length === 0) return true;
      // Normalize statements: strip trailing semicolons so the join doesn't
      // produce empty statements (e.g. "...);\n;\nCREATE..." which MySQL rejects).
      const normalized = stmts.map((s) => s.trim().replace(/;+\s*$/, ''));
      try {
        if (speedMode === 'fast') {
          // One IPC call for the entire batch — join with single semicolons.
          const batchSql = normalized.join(';\n');
          await safeInvoke('execute_query', {
            request: { config: applyConn!, sql: batchSql },
            queryId: `backup_batch_${label}_${Date.now()}`,
            __meta: { source: 'backup' },
          });
        } else {
          // Safe mode: one IPC per statement (reliable, granular errors).
          for (const stmt of normalized) {
            await safeInvoke('execute_query', {
              request: { config: applyConn!, sql: stmt },
              queryId: `backup_${label}_${Date.now()}`,
              __meta: { source: 'backup' },
            });
          }
        }
        return true;
      } catch (err: any) {
        errorBox.any = true;
        // Parse the full error message — the backend returns JSON with the
        // complete server error including detail/hint.
        let msg = err?.message || String(err);
        try {
          const parsed = JSON.parse(msg);
          msg = parsed.message || msg;
          if (parsed.detail) msg += `\nDETAIL: ${parsed.detail}`;
          if (parsed.hint) msg += `\nHINT: ${parsed.hint}`;
        } catch {
          // Not JSON — use the raw string.
        }
        const sqlPreview = normalized.length === 1 ? normalized[0].slice(0, 200) : `[${normalized.length} statements]`;
        appendLog(`  Failed (${label}): ${msg}${sqlPreview ? ` — ${sqlPreview}` : ''}`, 'error');
        return false;
      }
    };

    // ── Phase 1: Schema (execute CREATE/DROP/TRUNCATE) ───────────────────
    // Schema statements are always executed one-per-call (safe mode) because
    // MySQL doesn't support multi-statement queries without a special flag,
    // and CREATE TABLE statements have complex multi-line bodies that can
    // confuse the join. Data phase (INSERTs) can still use fast mode batching.
    // Schema errors are NOT resumable (unlike the data phase below): DDL is
    // cheap to redo (CREATE TABLE IF NOT EXISTS is idempotent) and mixing two
    // checkpoint shapes wasn't worth it — just fix the issue and click
    // "Start Backup" again.
    let schemaAborted = false;
    if (destination === 'connection' && applyConn) {
      const schemaItems = plan.items.filter((i) => i.phase === 'schema' && i.sql);
      if (schemaItems.length > 0) {
        setCurrentStep('Creating schema…');
        setStmtProgress({ done: 0, total: schemaItems.length });
        for (const [sIdx, sItem] of schemaItems.entries()) {
          setStmtProgress({ done: sIdx, total: schemaItems.length });
          const ok = await applyBatch([sItem.sql], `schema:${sItem.table || sItem.id}`);
          if (!ok && stopOnError) {
            appendLog('Stopped: schema creation failed.', 'error');
            schemaAborted = true;
            break;
          }
        }
        setStmtProgress({ done: schemaItems.length, total: schemaItems.length });
      }
    } else if (outputPath) {
      for (const item of plan.items.filter((i) => i.phase === 'schema' && i.sql)) {
        await writeChunk(item.sql + '\n\n');
      }
    }

    if (schemaAborted) {
      setHadError(true);
      setCurrentTable(null);
      setCurrentStep(null);
      setStmtProgress(null);
      await persistLog(outputPath);
      setRunning(false);
      setDone(true);
      return;
    }

    const dataItems = plan.items.filter((i) => i.phase === 'data');

    /** Pause the run: stop mid-table, remember exactly where, and let the
     *  user resume instead of losing everything and re-reading from row 0.
     *  Closes over `dataItems`/`applyConn`/`outputPath`/etc. from this same
     *  handleStart call, so `resumeRef.current()` continues with the exact
     *  same plan and destination. */
    const pauseHere = async (fromIndex: number, cursor: DataCursor) => {
      resumeRef.current = () => runData(fromIndex, cursor);
      appendLog('Paused. Fix the issue, then click Resume to continue from this exact row — nothing already written is re-sent.', 'error');
      setHadError(true);
      setPaused(true);
      setCurrentStep(null);
      await persistLog(outputPath);
      setRunning(false);
    };

    /** Runs the finalize phase (FK re-enable, file save confirmation, S3
     *  upload) — only reached once every table has fully completed. */
    const finalizeRun = async () => {
      const finalizeItems = plan.items.filter((i) => i.phase === 'finalize' && i.sql);
      for (const item of finalizeItems) {
        if (outputPath) await writeChunk('\n' + item.sql + '\n');
        if (destination === 'connection' && applyConn) await applyBatch([item.sql], 'finalize');
      }

      if (plan.capabilities.canDisableFkChecks && plan.capabilities.fkEnableSql) {
        if (outputPath) await writeChunk('\n' + plan.capabilities.fkEnableSql + '\n');
        if (destination === 'connection' && applyConn && fkDisabled) {
          try {
            await safeInvoke('execute_query', { request: { config: applyConn, sql: plan.capabilities.fkEnableSql }, queryId: `backup_fk_on_${Date.now()}` });
          } catch {
            appendLog(`Warning: Could not re-enable FK checks. They may remain disabled for this session.`, 'error');
          }
        }
      }

      if (destination === 'file' && outputPath) {
        appendLog(`Saved to ${outputPath}`, 'success');
      }

      if (destination === 's3' && s3Ctx && outputPath) {
        try {
          const decrypted = await withDecryptedSecret(s3Ctx.s3Conn);
          let uploadPath = outputPath;
          const uploadKey = buildS3BackupKey(s3Path, s3Ctx.baseName, s3Gzip);
          if (s3Gzip) {
            const gzPath = `${outputPath}.gz`;
            await safeInvoke('s3_gzip_compress', { localIn: outputPath, localOut: gzPath });
            uploadPath = gzPath;
            await remove(outputPath).catch(() => {});
            appendLog('Compressed (gzip).', 'info');
          }

          const upload = await safeInvoke<{ size: number }>('s3_upload_object', {
            config: decrypted,
            key: uploadKey,
            localPath: uploadPath,
            transferId: `backup_${Date.now()}`,
          });
          appendLog(`Uploaded to ${s3Ctx.s3Conn.bucket}/${uploadKey} (${upload.size} bytes).`, 'success');

          const metaKey = metadataKeyFor(uploadKey);
          const meta = serializeMetadata({
            version: 1,
            type: 'database-backup',
            engine: connection.engine,
            database: connection.database || selectedGroupName || '',
            connectionName: connection.name,
            createdAt: new Date().toISOString(),
            compression: s3Gzip ? 'gzip' : 'none',
            encryption: 'none',
            size: upload.size,
          });
          const metaPath = `${s3Ctx.tmpDir}/${s3Ctx.baseName}.meta.json`;
          await writeTextFile(metaPath, meta);
          await safeInvoke('s3_upload_object', {
            config: decrypted,
            key: metaKey,
            localPath: metaPath,
            transferId: `backup_meta_${Date.now()}`,
          });

          await remove(uploadPath).catch(() => {});
          await remove(metaPath).catch(() => {});
        } catch (err: any) {
          errorBox.any = true;
          appendLog(`S3 upload failed: ${err?.message || err}`, 'error');
        }
      }

      setHadError(errorBox.any);
      setCurrentTable(null);
      setCurrentStep(null);
      setStmtProgress(null);
      setRowProgress(null);
      if (!errorBox.any) appendLog('Backup complete.', 'success');
      await persistLog(outputPath);
      setRunning(false);
      setDone(true);
      resumeRef.current = null;
    };

    /** Data phase, resumable. `fromIndex` is which table in `dataItems` to
     *  start at; `resumeCursor` (if given) is where WITHIN that table to
     *  continue from — every earlier table is assumed already fully done. */
    const runData = async (fromIndex: number, resumeCursor: DataCursor | null) => {
      setRunning(true);
      setPaused(false);
      tablesCompleted = fromIndex;
      setProgress(tablesCompleted);

      for (let idx = fromIndex; idx < dataItems.length; idx++) {
        const item = dataItems[idx];
        const table = chosenTables.find((t) => t.name === item.table);
        const strategy = table ? pickChunkStrategy(table) : { mode: 'offset' as const, orderColumns: [] };
        const cursor: DataCursor =
          idx === fromIndex && resumeCursor ? resumeCursor : { mode: strategy.mode, lastKeyVal: null, offset: 0, rowsProcessed: 0 };

        setCurrentTable(item.table);
        setCurrentStep('Reading & applying data…');
        setStmtProgress({ done: idx, total: dataItems.length });
        setRowProgress({ done: cursor.rowsProcessed, total: typeof table?.row_count === 'number' ? table.row_count : null });
        let tableFailed = false;

        while (true) {
          const remaining = effectiveLimit !== undefined ? effectiveLimit - cursor.rowsProcessed : undefined;
          if (remaining !== undefined && remaining <= 0) break;
          const chunkLimit = remaining !== undefined ? Math.min(DATA_CHUNK_SIZE, remaining) : DATA_CHUNK_SIZE;

          const chunkSql =
            strategy.mode === 'keyset' && strategy.keysetColumn
              ? selectKeysetChunkSql(connection.engine, item.table, selectedGroupName || undefined, strategy.keysetColumn, cursor.lastKeyVal, chunkLimit)
              : selectOffsetChunkSql(connection.engine, item.table, selectedGroupName || undefined, strategy.orderColumns, cursor.offset, chunkLimit);

          let res: QueryResultData;
          try {
            res = await safeInvoke<QueryResultData>('execute_query', {
              request: { config: connection, sql: chunkSql },
              queryId: `backup_read_${item.table}_${idx}_${cursor.rowsProcessed}_${Date.now()}`,
            });
          } catch (err: any) {
            errorBox.any = true;
            appendLog(`  Failed reading "${item.table}" at row ${cursor.rowsProcessed}: ${err?.message || err}`, 'error');
            if (stopOnError) { await pauseHere(idx, cursor); return; }
            tableFailed = true;
            break;
          }

          if (res.rows.length === 0) break;

          const stmts =
            destination === 'connection'
              ? generateDataStatements(connection.engine, item.table, undefined, res.columns, res.rows)
              : generateInsertStatements(connection.engine, item.table, selectedGroupName || undefined, res.columns, res.rows);

          if (destination === 'connection' && applyConn && stmts.length > 0) {
            const ok = await applyBatch(stmts, `data:${item.table}:${cursor.offset || cursor.rowsProcessed}`);
            if (!ok) {
              if (stopOnError) { await pauseHere(idx, cursor); return; }
              tableFailed = true;
              break;
            }
          } else if (outputPath && stmts.length > 0) {
            try {
              await writeChunk(stmts.join('\n') + '\n');
            } catch (err: any) {
              errorBox.any = true;
              appendLog(`  Failed writing chunk for "${item.table}": ${describeFsError(err, 'write')}`, 'error');
              if (stopOnError) { await pauseHere(idx, cursor); return; }
              tableFailed = true;
              break;
            }
          }

          cursor.rowsProcessed += res.rows.length;
          if (strategy.mode === 'keyset' && strategy.keysetColumn) {
            const pkIdx = res.columns.findIndex((c) => c.name === strategy.keysetColumn);
            cursor.lastKeyVal = pkIdx >= 0 ? res.rows[res.rows.length - 1][pkIdx] : cursor.lastKeyVal;
          } else {
            cursor.offset += res.rows.length;
          }
          setRowProgress({ done: cursor.rowsProcessed, total: typeof table?.row_count === 'number' ? table.row_count : null });

          if (res.rows.length < chunkLimit) break; // short page = last page
        }

        tablesCompleted = idx + 1;
        setProgress(tablesCompleted);
        if (tableFailed) {
          appendLog(`"${item.table}" incomplete after ${cursor.rowsProcessed} row(s) — see error above. Continuing (stop-on-error is off).`, 'error');
        } else {
          appendLog(`"${item.table}" done (${cursor.rowsProcessed} row(s))`, 'success');
        }
        setRowProgress(null);
      }

      await finalizeRun();
    };

    await runData(0, null);
  };

  /** Continue a paused backup exactly where it stopped. No-op if there's
   *  nothing to resume (e.g. the modal was reset by a fresh Start). */
  const handleResume = async () => {
    if (!resumeRef.current) return;
    const resume = resumeRef.current;
    setHadError(false);
    await resume();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[560px] max-h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <HardDriveDownload className="w-3.5 h-3.5 text-amber-400" />
            <span>Backup — {connection.name}</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {loadingTree ? (
            <div className="flex items-center gap-2 text-slate-400 py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading schema...
            </div>
          ) : groups.length === 0 ? (
            <div className="text-slate-500 italic py-6 text-center">No databases/schemas found on this connection.</div>
          ) : (
            <>
              {groups.length > 1 && (
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Database / Schema
                  </label>
                  <select
                    value={selectedGroupName || ''}
                    onChange={(e) => setSelectedGroupName(e.target.value)}
                    className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                  >
                    {groups.map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                    Tables ({groupTables.length})
                  </label>
                  <div className="flex items-center gap-2 text-[10px] text-slate-500">
                    <button onClick={() => toggleAll('structure', true)} className="hover:text-slate-200">
                      All structure
                    </button>
                    <button onClick={() => toggleAll('data', true)} className="hover:text-slate-200">
                      All data
                    </button>
                    <button
                      onClick={() => {
                        toggleAll('structure', false);
                        toggleAll('data', false);
                      }}
                      className="hover:text-slate-200"
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="border border-[#1e293b] rounded-lg overflow-hidden">
                  <div className="grid grid-cols-[1fr,60px,60px,65px,65px] bg-[#06090e] px-2 py-1 text-[10px] font-semibold text-slate-500 uppercase">
                    <span>Table</span>
                    <span className="text-right">Rows</span>
                    <span className="text-right">Size</span>
                    <span className="text-center">Structure</span>
                    <span className="text-center">Data</span>
                  </div>
                  <div className="max-h-52 overflow-y-auto">
                    {groupTables.map((t) => {
                      const sel = selections.get(t.name) || { structure: true, data: true };
                      const hasFk = t.children?.some((c) => c.is_foreign_key);
                      return (
                        <div
                          key={t.name}
                          className="grid grid-cols-[1fr,60px,60px,65px,65px] items-center px-2 py-1 border-t border-[#141e33] hover:bg-[#0f172a]"
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            <TableIcon className="w-3 h-3 text-cyan-400 shrink-0" />
                            <span className="truncate">{t.name}</span>
                            {hasFk && (
                              <span
                                className="flex items-center gap-0.5 text-[8px] font-bold px-1 py-0 rounded bg-purple-500/20 text-purple-400 shrink-0"
                                title="Has foreign key relationships"
                              >
                                <Link2 className="w-2 h-2" />
                                FK
                              </span>
                            )}
                          </span>
                          <span className="text-right text-[10px] font-mono text-slate-500">
                            {formatRowCount(t.row_count)}
                          </span>
                          <span className="text-right text-[10px] font-mono text-slate-500">
                            {formatBytes(t.size_bytes)}
                          </span>
                          <span className="flex justify-center">
                            <input
                              type="checkbox"
                              checked={sel.structure}
                              onChange={() => toggleTable(t.name, 'structure')}
                              className="accent-blue-500"
                            />
                          </span>
                          <span className="flex justify-center">
                            <input
                              type="checkbox"
                              checked={sel.data}
                              onChange={() => toggleTable(t.name, 'data')}
                              className="accent-blue-500"
                            />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Destination
                </label>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <button
                    onClick={() => setDestination('file')}
                    className={`flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-semibold transition-colors ${
                      destination === 'file'
                        ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                        : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" /> File
                  </button>
                  <button
                    onClick={() => setDestination('connection')}
                    className={`flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-semibold transition-colors ${
                      destination === 'connection'
                        ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                        : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                    }`}
                    title={`Backup to another ${connection.engine} connection`}
                  >
                    <DatabaseIcon className="w-3.5 h-3.5" /> DB Connection
                  </button>
                  <button
                    onClick={() => setDestination('s3')}
                    className={`flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-semibold transition-colors ${
                      destination === 's3'
                        ? 'bg-amber-600/20 border-amber-500/40 text-amber-400'
                        : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                    }`}
                    title="Upload the backup to S3-compatible storage"
                  >
                    <Cloud className="w-3.5 h-3.5" /> S3 Storage
                  </button>
                </div>

                {destination === 'file' ? (
                  <div className="space-y-2">
                    {/* Folder picker */}
                    <div className="flex gap-2">
                      <button
                        onClick={handlePickFolder}
                        className="h-8 shrink-0 flex items-center gap-1.5 px-2.5 rounded bg-[#0f172a] hover:bg-[#1e293b] border border-[#1e293b] focus:border-blue-500 text-xs text-slate-300 transition-colors"
                        title="Choose output folder"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-blue-400" />
                        Browse…
                      </button>
                      <div className="flex-1 h-8 box-border bg-[#0f172a] border border-[#1e293b] rounded px-2 flex items-center text-xs text-slate-400 font-mono truncate">
                        {saveDirectory ? (
                          <span className="truncate text-slate-300">{saveDirectory}</span>
                        ) : (
                          <span className="italic text-slate-600">No folder chosen — save dialog will prompt</span>
                        )}
                      </div>
                      {saveDirectory && (
                        <button
                          onClick={() => setSaveDirectory(null)}
                          className="h-8 shrink-0 px-2 rounded text-slate-500 hover:text-red-400 text-xs transition-colors"
                          title="Clear folder"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {/* Filename */}
                    <input
                      type="text"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      value={fileName}
                      onChange={(e) => setFileName(e.target.value)}
                      placeholder="backup.sql"
                      className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono"
                    />
                  </div>
                ) : destination === 's3' ? (
                  <div className="space-y-2">
                    {useStorageStore.getState().connections.length === 0 ? (
                      <div className="text-[11px] text-slate-500 italic py-2 text-center">
                        No storage connections configured.
                        <br />
                        Add an S3 connection in the Storage view to enable cloud backups.
                      </div>
                    ) : (
                      <>
                        <div>
                          <label className="block text-[9px] text-slate-500 mb-1">Storage Connection</label>
                          <select
                            value={s3ConnectionId}
                            onChange={(e) => {
                              setS3ConnectionId(e.target.value);
                              const c = useStorageStore.getState().connections.find((x) => x.id === e.target.value);
                              if (c && !s3Path) setS3Path(c.pathPrefix || '');
                            }}
                            className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-amber-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                          >
                            <option value="">Select a storage connection...</option>
                            {useStorageStore.getState().connections.map((c) => (
                              <option key={c.id} value={c.id}>{c.name} ({c.bucket})</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[9px] text-slate-500 mb-1">
                            Object Key / Path (leave as folder to auto-name, or full filename)
                          </label>
                          <input
                            type="text"
                            autoCapitalize="off"
                            autoCorrect="off"
                            autoComplete="off"
                            spellCheck={false}
                            value={s3Path}
                            onChange={(e) => setS3Path(e.target.value)}
                            placeholder="rdsql/backups/production/  (or full key ending in .sql)"
                            className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-amber-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono"
                          />
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={s3Gzip}
                            onChange={(e) => setS3Gzip(e.target.checked)}
                            className="accent-amber-500"
                          />
                          <span>Compress with gzip before upload (.sql.gz)</span>
                        </label>
                      </>
                    )}
                  </div>
                ) : sameEngineConnections.length === 0 ? (
                  <div className="text-[11px] text-slate-500 italic py-2 text-center">
                    No other {connection.engine} connections available.
                    <br />
                    Add a same-engine connection to enable DB-to-DB backup.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Step 1: Pick connection */}
                    <div>
                      <label className="block text-[9px] text-slate-500 mb-1">Connection ({connection.engine} only)</label>
                      <select
                        value={targetConnectionId}
                        onChange={(e) => {
                          setTargetConnectionId(e.target.value);
                          setTargetDatabaseName('');
                        }}
                        className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                      >
                        <option value="">Select a connection...</option>
                        {sameEngineConnections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.host || c.filePath || 'local'})
                          </option>
                        ))}
                      </select>
                    </div>
                    {/* Step 2: Pick database (skip for file-based engines) */}
                    {targetConnectionId && targetDatabases.length > 0 && (
                      <div>
                        <label className="block text-[9px] text-slate-500 mb-1">Database</label>
                        <select
                          value={targetDatabaseName}
                          onChange={(e) => setTargetDatabaseName(e.target.value)}
                          className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                        >
                          <option value="">Select a database...</option>
                          {targetDatabases.map((db) => (
                            <option key={db} value={db}>{db}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {targetConnectionId && targetDbLoading && (
                      <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading databases...
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Data dump options: how much data, and how to write it. */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Data Dump
                  </label>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setDataMode('all')}
                      className={`flex-1 h-7 rounded text-[10.5px] font-semibold border transition-colors ${
                        dataMode === 'all'
                          ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      All rows
                    </button>
                    <button
                      onClick={() => setDataMode('limit')}
                      className={`flex-1 h-7 rounded text-[10.5px] font-semibold border transition-colors ${
                        dataMode === 'limit'
                          ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      First N
                    </button>
                    {dataMode === 'limit' && (
                      <input
                        type="number"
                        min={1}
                        value={dataLimit}
                        onChange={(e) => setDataLimit(Math.max(1, parseInt(e.target.value || '100', 10)))}
                        className="w-20 h-7 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none font-mono"
                        placeholder="100"
                      />
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Write Method
                  </label>
                  <select
                    value={writeMode}
                    onChange={(e) => setWriteMode(e.target.value as 'insert' | 'truncate' | 'drop')}
                    className="w-full h-7 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                  >
                    <option value="insert">Insert only (fail if exists)</option>
                    <option value="truncate">Truncate existing, then insert</option>
                    <option value="drop">Drop & recreate, then insert</option>
                  </select>
                  {destination === 'file' && (
                    <p className="text-[9px] text-slate-600 mt-1">Included as preamble in the generated script.</p>
                  )}
                </div>

                {destination !== 'connection' && (
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      Database Name
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer h-7">
                      <input
                        type="checkbox"
                        checked={qualifyWithDbName}
                        onChange={(e) => setQualifyWithDbName(e.target.checked)}
                        className="accent-blue-500"
                      />
                      Bake "{selectedGroupName || connection.database || 'this database'}" into the script
                    </label>
                    <p className="text-[9px] text-slate-600 mt-1">
                      {qualifyWithDbName
                        ? 'Restoring elsewhere requires a database with this exact name to exist there.'
                        : 'Off (recommended) — restores into whatever database the target connection is pointed at.'}
                    </p>
                  </div>
                )}

                {/* Speed mode */}
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Speed
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSpeedMode('fast')}
                      className={`h-7 rounded-lg border text-[10px] font-semibold transition-colors ${
                        speedMode === 'fast'
                          ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                      }`}
                      title="Batch multiple statements into one DB call. Much faster, less granular error reporting."
                    >
                      ⚡ Fast
                    </button>
                    <button
                      type="button"
                      onClick={() => setSpeedMode('safe')}
                      className={`h-7 rounded-lg border text-[10px] font-semibold transition-colors ${
                        speedMode === 'safe'
                          ? 'bg-blue-600/20 border-blue-500/40 text-blue-400'
                          : 'bg-[#0f172a] border-[#1e293b] text-slate-400 hover:text-slate-200'
                      }`}
                      title="One statement per DB call. Slower but precise error reporting."
                    >
                      🛡️ Safe
                    </button>
                  </div>
                  <p className="text-[9px] text-slate-600 mt-1">
                    {speedMode === 'fast'
                      ? 'Batches statements — fewer connections, much faster.'
                      : 'One statement at a time — precise error per statement.'}
                  </p>
                </div>

                {/* Error handling */}
                <div>
                  <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Error Handling
                  </label>
                  <label className="flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stopOnError}
                      onChange={(e) => setStopOnError(e.target.checked)}
                      className="accent-blue-500"
                    />
                    Stop on first error
                  </label>
                  <p className="text-[9px] text-slate-600 mt-1">
                    {stopOnError ? 'Aborts immediately when a statement fails.' : 'Continues to the next table when a statement fails.'}
                  </p>
                </div>
              </div>
            </>
          )}

          {running && (
            <div className="rounded-lg border border-[#1e293b] bg-[#06090e] p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-slate-200 truncate">
                    {currentTable ? `Backing up "${currentTable}"` : 'Starting…'}
                  </div>
                  <div className="text-[9px] text-slate-500 truncate">
                    {currentStep || ''}
                    {rowProgress
                      ? ` (${rowProgress.done.toLocaleString()}${rowProgress.total ? ` / ~${rowProgress.total.toLocaleString()}` : ''} rows)`
                      : stmtProgress && stmtProgress.total > 1
                      ? ` (${stmtProgress.done + 1}/${stmtProgress.total} statements)`
                      : ''}
                  </div>
                </div>
                <span className="text-[10px] text-slate-500 font-mono shrink-0">
                  {totalTables > 0 ? `${progress}/${totalTables}` : ''}
                </span>
              </div>
              {totalTables > 0 && (
                <div className="h-2 w-full bg-[#1e293b] rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${hadError ? 'bg-amber-500' : 'bg-blue-500'}`}
                    style={{ width: `${totalTables > 0 ? (progress / totalTables) * 100 : 0}%` }}
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-slate-500">
                  {totalTables > 0
                    ? `${Math.round((progress / totalTables) * 100)}% complete`
                    : 'Preparing backup…'}
                </span>
                {totalTables > 0 && progress > 0 && (
                  <span className="text-[9px] text-slate-600">
                    {totalTables - progress} table{totalTables - progress !== 1 ? 's' : ''} remaining
                  </span>
                )}
              </div>
            </div>
          )}

          {done && !running && totalTables > 0 && (
            <div className="rounded-lg border border-[#1e293b] bg-[#06090e] p-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-400 font-medium">
                  {progress}/{totalTables} tables processed
                </span>
                <span className="text-[10px] text-slate-500 font-mono">100%</span>
              </div>
              <div className="h-1.5 w-full bg-[#1e293b] rounded-full overflow-hidden">
                <div
                  className={`h-full ${hadError ? 'bg-amber-500' : 'bg-emerald-500'}`}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          )}

          {paused && !running && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Paused on "{currentTable}" — {progress}/{totalTables} tables fully done. Fix the issue below, then
                click Resume to continue from this exact row.
              </span>
            </div>
          )}

          {log.length > 0 && (
            <div className="border border-[#1e293b] rounded-lg bg-[#06090e] overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[#1e293b] bg-[#0a0f18]">
                <span
                  className="text-[9px] uppercase tracking-wider font-bold text-slate-500 truncate"
                  title={logFilePath ?? undefined}
                >
                  Log{logFilePath ? ` — saved to ${logFilePath}` : ''}
                </span>
                <button
                  onClick={handleCopyLog}
                  className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-200 transition-colors"
                  title="Copy all log entries"
                >
                  {copiedLog ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  {copiedLog ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="p-2 max-h-40 overflow-y-auto font-mono text-[10.5px] flex flex-col gap-0.5 select-text cursor-text">
                {log.map((l, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-1.5 group/line ${
                      l.kind === 'error' ? 'text-red-400' : l.kind === 'success' ? 'text-emerald-400' : 'text-slate-400'
                    }`}
                  >
                    <span className="flex-1 break-all">{l.text}</span>
                    {l.kind === 'error' && (
                      <button
                        onClick={async () => {
                          await copyToClipboard(l.text);
                          setCopiedLog(true);
                          setTimeout(() => setCopiedLog(false), 2000);
                        }}
                        className="shrink-0 p-0.5 rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-300 transition-all"
                        title="Copy this error"
                      >
                        <Copy className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>

        <div className="h-12 border-t border-[#1e293b] px-3 flex items-center justify-between shrink-0 bg-[#06090e]">
          <div className="flex items-center gap-1.5 text-[11px]">
            {done && !hadError && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5" /> Done
              </span>
            )}
            {done && hadError && (
              <span className="flex items-center gap-1 text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" /> Completed with errors
              </span>
            )}
            {paused && !running && (
              <span className="flex items-center gap-1 text-amber-400">
                <AlertTriangle className="w-3.5 h-3.5" /> Paused
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold transition-colors"
            >
              {done ? 'Close' : 'Cancel'}
            </button>
            {paused ? (
              <button
                onClick={handleResume}
                disabled={running}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                {running && <Loader2 className="w-3 h-3 animate-spin" />}
                Resume
              </button>
            ) : (
              !done && (
                <button
                  onClick={handleStart}
                  disabled={running || loadingTree || groupTables.length === 0}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  {running && <Loader2 className="w-3 h-3 animate-spin" />}
                  Start Backup
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
