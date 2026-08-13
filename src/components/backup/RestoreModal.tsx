import React, { useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { X, HardDriveUpload, Loader2, CheckCircle2, AlertTriangle, FileText, FolderOpen, Cloud, Copy, Check } from 'lucide-react';
import { DatabaseConnection } from '../../core/domain/types';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { splitSqlStatements, stripSchemaQualifiers } from '../../core/backup/backupSql';
import { buildRestorePlan, type RestorePlanItem, type RestoreStatementCategory } from '../../core/backup/restorePlanner';
import { describeFsError } from '../../core/utils/fsErrors';
import { copyToClipboard } from '../../core/utils/clipboard';
import { tempDir } from '../../core/utils/tempDir';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
// S3 source (Phase 6) — additive. Reuses the existing restore engine; only the
// SQL-source step changes (download → read instead of open → read).
import { useStorageStore } from '../../store/useStorageStore';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { StorageBrowser } from '../storage/StorageBrowser';
import { isMetadataKey } from '../../core/storage/domain/metadata';
import type { StorageObject } from '../../core/storage/domain/types';

interface RestoreModalProps {
  connection: DatabaseConnection;
  onClose: () => void;
}

type LogKind = 'info' | 'success' | 'error';

export const RestoreModal: React.FC<RestoreModalProps> = ({ connection, onClose }) => {
  const [running, setRunning] = useState(false);
  useEscapeToClose(running ? null : onClose);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState<string>('');
  const [statements, setStatements] = useState<string[]>([]);
  const [stopOnError, setStopOnError] = useState(true);
  /** When true (default), any `` `db`.`table` ``/`"schema"."table"` qualifier
   *  baked into the file is stripped before execution, so every statement
   *  targets whatever database this connection is already pointed at —
   *  instead of failing with e.g. MySQL's "Unknown database 'tc_superadmin'"
   *  when the file's source database name doesn't exist on this server. */
  const [stripSourceDb, setStripSourceDb] = useState(true);
  const [done, setDone] = useState(false);
  const [hadError, setHadError] = useState(false);
  /** True when a run stopped on error mid-way but is resumable — see
   *  `pauseHere` in handleRestore. Distinct from `done`. */
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalPlanned, setTotalPlanned] = useState(0);
  const [currentPhase, setCurrentPhase] = useState<string>('');
  const [log, setLog] = useState<{ text: string; kind: LogKind }[]>([]);
  const [copiedLog, setCopiedLog] = useState(false);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // S3-source picker state.
  const [showStoragePicker, setShowStoragePicker] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);

  /** Mirrors `log` state synchronously so `persistLog` (called mid-flight)
   *  always has the full history, not whatever last flushed to state. */
  const logLinesRef = useRef<{ text: string; kind: LogKind }[]>([]);
  /** Set by `pauseHere` to a closure that re-enters the plan at the
   *  statement that failed. Lives only as long as this modal instance. */
  const resumeRef = useRef<(() => Promise<void>) | null>(null);

  const appendLog = (text: string, kind: LogKind = 'info') => {
    logLinesRef.current = [...logLinesRef.current, { text, kind }];
    setLog(logLinesRef.current);
  };

  /** Best-effort: persist the full run log to a temp file so it survives
   *  even if the user never copies it. Never throws. */
  const persistLog = async () => {
    try {
      const dir = await tempDir();
      const path = `${dir}/rdsql_restore_${connection.name.replace(/\s+/g, '_')}_${Date.now()}.log.txt`;
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

  const handlePickFile = async () => {
    setPickError(null);
    let path: string | null = null;
    try {
      const picked = await open({ multiple: false, filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }] });
      if (!picked || typeof picked !== 'string') return;
      path = picked;
    } catch (dialogErr: any) {
      setPickError(describeFsError(dialogErr, 'read'));
      return;
    }
    try {
      const content = await readTextFile(path);
      const stmts = splitSqlStatements(content);
      setRawContent(content);
      setFilePath(path);
      setStatements(stmts);
      setLog([]);
      setDone(false);
      setProgress(0);
      if (stmts.length === 0) {
        setPickError('No SQL statements found in that file.');
      }
    } catch (readErr: any) {
      setPickError(describeFsError(readErr, 'read'));
    }
  };

  /** Load a backup from S3-compatible storage: download to a temp file, read it
   *  (gunzip if needed), and feed the existing restore pipeline. No second
   *  restore engine — the SQL content is treated identically to a local file. */
  const handlePickFromStorage = async (obj: StorageObject) => {
    setPickError(null);
    setStorageBusy(true);
    setShowStoragePicker(false);
    const conn = useStorageStore.getState().connections.find(
      (c) => c.id === useStorageStore.getState().activeConnectionId,
    );
    if (!conn) {
      setPickError('No storage connection selected.');
      setStorageBusy(false);
      return;
    }
    if (isMetadataKey(obj.key)) {
      setPickError('That is a metadata sidecar, not a backup. Pick the .sql[.gz] file.');
      setStorageBusy(false);
      return;
    }
    try {
      const decrypted = await withDecryptedSecret(conn);
      const tmpPath = `/tmp/rdsql_restore_${Date.now()}_${obj.name}`;
      await safeInvoke('s3_download_object', {
        config: decrypted,
        key: obj.key,
        localPath: tmpPath,
        transferId: `restore_${Date.now()}`,
      });
      let content: string;
      if (/\.gz$/i.test(obj.key)) {
        // Gunzip via the Rust streaming helper into a sibling .sql temp file.
        const gunzipped = `${tmpPath}.sql`;
        await safeInvoke('s3_gzip_decompress', { localIn: tmpPath, localOut: gunzipped });
        content = await readTextFile(gunzipped);
        await remove(gunzipped).catch(() => {});
      } else {
        content = await readTextFile(tmpPath);
      }
      await remove(tmpPath).catch(() => {});

      const stmts = splitSqlStatements(content);
      setRawContent(content);
      setFilePath(`${conn.bucket}/${obj.key}`);
      setStatements(stmts);
      setLog([]);
      setDone(false);
      setProgress(0);
      if (stmts.length === 0) {
        setPickError('No SQL statements found in that backup object.');
      }
    } catch (err: any) {
      setPickError(err?.message || String(err));
    } finally {
      setStorageBusy(false);
    }
  };

  const phaseLabel = (cat: RestoreStatementCategory): string => {
    switch (cat) {
      case 'fk_disable': return 'Disabling FK checks';
      case 'fk_enable': return 'Re-enabling FK checks';
      case 'ddl_drop': return 'Dropping objects';
      case 'ddl_create': return 'Creating schema';
      case 'ddl_alter': return 'Altering schema';
      case 'dml': return 'Importing data';
      case 'pragma_set': return 'Session settings';
      default: return 'Executing';
    }
  };

  const handleRestore = async () => {
    if (statements.length === 0) return;
    setRunning(true);
    setDone(false);
    setPaused(false);
    setHadError(false);
    setLog([]);
    logLinesRef.current = [];
    setLogFilePath(null);
    setProgress(0);
    resumeRef.current = null;

    // If enabled, drop the file's baked-in database/schema qualifier from
    // every CREATE/INSERT/DROP/ALTER before parsing, so the file replays
    // against whatever database THIS connection is pointed at rather than
    // requiring a same-named database to exist on the target server.
    const effectiveSql = stripSourceDb ? stripSchemaQualifiers(connection.engine, rawContent) : rawContent;
    if (stripSourceDb) appendLog('Ignoring the database name baked into the file — restoring into this connection\'s current database.');

    // Build categorized execution plan — re-orders statements into safe phases
    // (fk-off → drops → creates → data → alters → unknown → fk-on). Built once
    // per fresh run; `runPlan` (below) re-enters this SAME plan on resume, so
    // a pause never re-categorizes or re-orders statements mid-flight.
    const plan = buildRestorePlan(effectiveSql, connection.engine);
    setTotalPlanned(plan.totalStatements);
    appendLog(`Plan: ${plan.ddlCount} DDL, ${plan.dmlCount} DML, ${plan.totalStatements} total statements`);

    const errorBox = { any: false };

    /** Pause on the statement that failed. Resuming retries that SAME
     *  statement (not the next one) — the assumption is the user fixes
     *  whatever caused it (a conflicting table, a permissions issue, disk
     *  space) and wants the failed statement re-attempted, not skipped. */
    const pauseHere = async (atIndex: number) => {
      resumeRef.current = () => runPlan(atIndex);
      appendLog('Paused. Fix the issue, then click Resume to retry this statement and continue.', 'error');
      setProgress(atIndex);
      setHadError(true);
      setPaused(true);
      setCurrentPhase('');
      await persistLog();
      setRunning(false);
    };

    const runPlan = async (fromIndex: number) => {
      setRunning(true);
      setPaused(false);

      for (let i = fromIndex; i < plan.items.length; i++) {
        const item = plan.items[i];
        setCurrentPhase(phaseLabel(item.category));

        const stmt = item.statement;
        try {
          await safeInvoke('execute_query', {
            request: { config: connection, sql: stmt },
            queryId: `restore_${i}_${Date.now()}`,
            __meta: { source: 'restore' },
          });
          appendLog(`[${i + 1}/${plan.items.length}] ${item.category}: OK`, 'success');
        } catch (err: any) {
          errorBox.any = true;
          const msg = err?.message || String(err);
          appendLog(`[${i + 1}/${plan.items.length}] ${item.category}: FAILED — ${msg}`, 'error');
          if (stopOnError) {
            await pauseHere(i);
            return;
          }
        }
        setProgress(i + 1);
      }

      setHadError(errorBox.any);
      setCurrentPhase('');
      if (!errorBox.any) appendLog('Restore complete.', 'success');
      await persistLog();
      setRunning(false);
      setDone(true);
      resumeRef.current = null;
    };

    await runPlan(0);
  };

  /** Continue a paused restore, retrying the statement that failed. */
  const handleResume = async () => {
    if (!resumeRef.current) return;
    const resume = resumeRef.current;
    setHadError(false);
    await resume();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[520px] max-h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <HardDriveUpload className="w-3.5 h-3.5 text-purple-400" />
            <span>Restore — {connection.name}</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Statements run directly against "{connection.name}". Make sure this is the right target — this can overwrite or duplicate data.</span>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
              Backup File
            </label>
            <button
              onClick={handlePickFile}
              className="w-full h-9 flex items-center gap-2 px-2 rounded-lg bg-[#0f172a] border border-[#1e293b] hover:border-blue-500/50 text-left transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              {filePath ? (
                <span className="truncate font-mono text-[11px] text-slate-200">{filePath}</span>
              ) : (
                <span className="text-slate-500">Choose a .sql file...</span>
              )}
            </button>
            {pickError && (
              <div className="mt-1">
                <CopyableErrorBanner message={pickError} tone="red" compact />
              </div>
            )}
            {filePath && statements.length > 0 && (
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                <FileText className="w-3 h-3" /> {statements.length} statement{statements.length === 1 ? '' : 's'} found
              </div>
            )}
            {/* Restore from S3-compatible storage (Phase 6). Opens an embedded
                browser that downloads the chosen object to a temp file and
                feeds it through the same restore engine as a local file. */}
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => {
                  if (useStorageStore.getState().connections.length === 0) {
                    setPickError('No storage connections configured. Add one in the Storage view.');
                    return;
                  }
                  setPickError(null);
                  setShowStoragePicker(true);
                }}
                disabled={storageBusy}
                className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-amber-300 bg-amber-600/10 border border-amber-600/30 hover:bg-amber-600/20 flex items-center gap-1.5 disabled:opacity-50"
                title="Restore a backup from S3-compatible storage"
              >
                {storageBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
                From Storage…
              </button>
              {useStorageStore.getState().connections.length > 0 && (
                <span className="text-[10px] text-slate-600">
                  {useStorageStore.getState().connections.length} storage connection{useStorageStore.getState().connections.length === 1 ? '' : 's'} available
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={(e) => setStopOnError(e.target.checked)}
                className="accent-blue-500"
              />
              Stop on first error
            </label>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={stripSourceDb}
                onChange={(e) => setStripSourceDb(e.target.checked)}
                className="accent-blue-500"
              />
              Ignore database name baked into the file
            </label>
            <p className="text-[9px] text-slate-600 pl-5">
              {stripSourceDb
                ? "Restores into this connection's current database, even if it's named differently from where the backup came from."
                : 'Every CREATE/INSERT/DROP will target the exact database name from the file — fails if no database with that name exists here.'}
            </p>
          </div>

          {paused && !running && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Paused at statement {progress + 1}/{totalPlanned || statements.length} — {currentPhase || 'see log'}
                . Fix the issue, then click Resume to retry it.
              </span>
            </div>
          )}

          {(running || log.length > 0) && (
            <div>
              {running && (
                <div className="flex items-center gap-2 mb-1.5">
                  <Loader2 className="w-3 h-3 animate-spin text-purple-400 shrink-0" />
                  <span className="text-[10px] text-slate-300 font-medium truncate flex-1">
                    {currentPhase || 'Processing…'}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono shrink-0">
                    {totalPlanned > 0 ? `${progress}/${totalPlanned}` : `${progress}/${statements.length}`}
                  </span>
                </div>
              )}
              <div className="h-1.5 w-full bg-[#1e293b] rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full transition-all ${hadError ? 'bg-amber-500' : 'bg-purple-500'}`}
                  style={{ width: (totalPlanned || statements.length) ? `${(progress / (totalPlanned || statements.length)) * 100}%` : '0%' }}
                />
              </div>
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
                    className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-200 transition-colors shrink-0"
                    title="Copy all log entries"
                  >
                    {copiedLog ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copiedLog ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="p-2 max-h-52 overflow-y-auto font-mono text-[10.5px] flex flex-col gap-0.5 select-text cursor-text">
                  {log.map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.kind === 'error' ? 'text-red-400' : l.kind === 'success' ? 'text-emerald-400' : 'text-slate-400'
                      }
                    >
                      {l.text}
                    </div>
                  ))}
                </div>
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
                  onClick={handleRestore}
                  disabled={running || statements.length === 0}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  {running && <Loader2 className="w-3 h-3 animate-spin" />}
                  Run Restore
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* Storage picker overlay — embedded browser in single-select mode. */}
      {showStoragePicker && (
        <div
          className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center"
          onClick={() => setShowStoragePicker(false)}
        >
          <div
            className="w-[720px] max-h-[75vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 font-bold text-slate-200 text-xs">
                <Cloud className="w-3.5 h-3.5 text-amber-400" />
                Pick a backup object
              </div>
              <button
                onClick={() => setShowStoragePicker(false)}
                className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3">
              <StorageBrowser
                embedded
                filterSuffixes={['.sql', '.sql.gz']}
                onSelectObject={(o) => handlePickFromStorage(o)}
              />
            </div>
            <div className="px-3 py-2 border-t border-[#1e293b] text-[10px] text-slate-500 bg-[#06090e]">
              Click a backup object to download and load it for restore.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
