import React, { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { X, HardDriveUpload, Loader2, CheckCircle2, AlertTriangle, FileText, FolderOpen, Cloud, Copy, Check } from 'lucide-react';
import { DatabaseConnection } from '../../core/domain/types';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import { stripSchemaQualifiers } from '../../core/backup/backupSql';
import { sqlDialectFor } from '../../core/sql/splitStatements';
import { isMysqlFamily } from '../../core/connection/engines';
import { categorizeStatement } from '../../core/backup/restorePlanner';
import { getEngineCapabilities } from '../../core/backup/backupEngine';
import {
  StatementScanner,
  detectDumpKind,
  skipReason,
  restoreBinaryLiterals,
  hasRawBytes,
  DUMP_LABEL,
  type DumpKind,
  type RestoreItem,
} from '../../core/backup/restoreStream';
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

/** The file being restored. It is never loaded whole: the run reads it in
 *  CHUNK_BYTES pieces (`file_read_chunk`), so its size doesn't matter. */
interface RestoreSource {
  path: string;
  /** What to show for it: the local path, or bucket/key for S3. */
  label: string;
  size: number;
  kind: DumpKind;
  /** A downloaded copy to delete when the modal closes. */
  temp?: boolean;
}

interface FileChunk {
  text: string;
  bytes: number;
  eof: boolean;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
/** How much of the file is read up front to recognize its format. */
const HEAD_BYTES = 64 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Statements whose effect lasts for the session (SET, PRAGMA, FK checks,
 *  pg_dump's set_config). When a paused restore resumes on a new session,
 *  these are re-run from the part already done. */
function isSessionSetting(statement: string, engine: DatabaseConnection['engine']): boolean {
  if (/^SELECT\s+pg_catalog\.set_config\s*\(/i.test(statement)) return true;
  const cat = categorizeStatement(statement, getEngineCapabilities(engine));
  return cat === 'fk_disable' || cat === 'pragma_set';
}

export const RestoreModal: React.FC<RestoreModalProps> = ({ connection, onClose }) => {
  const [running, setRunning] = useState(false);
  useEscapeToClose(running ? null : onClose);
  const [source, setSource] = useState<RestoreSource | null>(null);
  const [stopOnError, setStopOnError] = useState(true);
  /** When true (default), any `` `db`.`table` ``/`"schema"."table"` qualifier
   *  baked into the file is stripped before execution, so every statement
   *  targets whatever database this connection is already pointed at —
   *  instead of failing with e.g. MySQL's "Unknown database 'tc_superadmin'"
   *  when the file's source database name doesn't exist on this server. */
  const [stripSourceDb, setStripSourceDb] = useState(true);
  /** Skip OWNER TO / GRANT / REVOKE: they name roles from the source server,
   *  which usually don't exist here. */
  const [skipOwnership, setSkipOwnership] = useState(true);
  const [done, setDone] = useState(false);
  const [hadError, setHadError] = useState(false);
  /** True when a run stopped on error mid-way but is resumable — see
   *  `pauseHere` in handleRestore. Distinct from `done`. */
  const [paused, setPaused] = useState(false);
  const [bytesDone, setBytesDone] = useState(0);
  const [counts, setCounts] = useState({ statements: 0, rows: 0 });
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
  /** Set by `pauseHere` to a closure that continues the run at the item
   *  that failed. Lives only as long as this modal instance. */
  const resumeRef = useRef<(() => Promise<void>) | null>(null);
  /** One backend session for the whole restore, so session settings such as
   *  `SET FOREIGN_KEY_CHECKS = 0` apply to every statement after them. Kept
   *  open while paused so Resume continues on the same connection. */
  const sessionRef = useRef<string | null>(null);
  const sourceRef = useRef<RestoreSource | null>(null);
  sourceRef.current = source;

  const closeSession = async () => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) await safeInvoke('session_close', { sessionId: id }).catch(() => {});
  };

  const dropTempFile = (s: RestoreSource | null) => {
    if (s?.temp) void remove(s.path).catch(() => {});
  };

  useEffect(
    () => () => {
      void closeSession();
      dropTempFile(sourceRef.current);
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  /** Reads just the start of the file to tell what kind of script it is. */
  const loadSource = async (path: string, label: string, temp = false) => {
    const size = await safeInvoke<number>('file_size', { path });
    const head = await safeInvoke<FileChunk>('file_read_chunk', { path, offset: 0, maxBytes: HEAD_BYTES });
    dropTempFile(source);
    const kind = detectDumpKind(head.text);
    setSource({ path, label, size, kind, temp });
    setLog([]);
    logLinesRef.current = [];
    setDone(false);
    setPaused(false);
    setBytesDone(0);
    setCounts({ statements: 0, rows: 0 });
    resumeRef.current = null;
    if (!head.text.trim()) setPickError('That file is empty.');
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
      await loadSource(path, path);
    } catch (readErr: any) {
      setPickError(readErr?.message || describeFsError(readErr, 'read'));
    }
  };

  /** Load a backup from S3-compatible storage: download it to a temp file
   *  (gunzipped if needed), then restore from that file like a local one. */
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
      const tmpPath = `${await tempDir()}/rdsql_restore_${Date.now()}_${obj.name}`;
      await safeInvoke('s3_download_object', {
        config: decrypted,
        key: obj.key,
        localPath: tmpPath,
        transferId: `restore_${Date.now()}`,
      });
      let localPath = tmpPath;
      if (/\.gz$/i.test(obj.key)) {
        // Gunzip via the Rust streaming helper into a sibling .sql temp file.
        localPath = `${tmpPath}.sql`;
        await safeInvoke('s3_gzip_decompress', { localIn: tmpPath, localOut: localPath });
        await remove(tmpPath).catch(() => {});
      }
      await loadSource(localPath, `${conn.bucket}/${obj.key}`, true);
    } catch (err: any) {
      setPickError(err?.message || String(err));
    } finally {
      setStorageBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!source) return;
    const src = source;
    setRunning(true);
    setDone(false);
    setPaused(false);
    setHadError(false);
    setLog([]);
    logLinesRef.current = [];
    setLogFilePath(null);
    setBytesDone(0);
    resumeRef.current = null;

    const engine = connection.engine;
    const dialect = sqlDialectFor(engine);
    // pg_dump names every object with its schema and empties search_path, so
    // stripping qualifiers would leave its statements nowhere to go.
    const strip = stripSourceDb && src.kind !== 'pg_dump';
    const rules = { ownership: skipOwnership, use: strip };
    appendLog(`Restoring ${DUMP_LABEL[src.kind]} (${formatBytes(src.size)}) into "${connection.name}".`);
    if (strip) appendLog("Ignoring the database name baked into the file — restoring into this connection's current database.");

    const tally = { statements: 0, rows: 0 };
    const skippedKinds = new Map<string, number>();
    const errorBox = { any: false };
    let lastLogged = 0;

    const execute = (sql: string, n: number) =>
      safeInvoke('session_execute', {
        sessionId: sessionRef.current,
        sql,
        queryId: `restore_${n}_${Date.now()}`,
        __meta: { source: 'restore' },
      });

    /** Pause on the item that failed. Resume retries that SAME item — the
     *  user fixes whatever caused it (a conflicting table, a permissions
     *  issue, disk space) and wants it re-attempted, not skipped. */
    const pauseHere = async (itemsDone: number) => {
      resumeRef.current = () => run(itemsDone);
      appendLog('Paused. Fix the issue, then click Resume to retry this statement and continue.', 'error');
      setHadError(true);
      setPaused(true);
      setCounts({ ...tally });
      await persistLog();
      setRunning(false);
    };

    /** Runs the file from the start, skipping the first `resumeAt` items
     *  (done before a pause). Re-reading instead of remembering an offset
     *  keeps the scanner's state (DELIMITER, COPY) exact. */
    const run = async (resumeAt: number) => {
      setRunning(true);
      setPaused(false);

      const newSession = !sessionRef.current;
      try {
        if (newSession) sessionRef.current = await safeInvoke<string>('session_open', { config: connection });
      } catch (err: any) {
        errorBox.any = true;
        appendLog(`Could not connect: ${err?.message || String(err)}`, 'error');
        await pauseHere(resumeAt);
        return;
      }

      const scanner = new StatementScanner(dialect);
      let offset = 0;
      let ordinal = 0;
      try {
        for (;;) {
          const chunk = await safeInvoke<FileChunk>('file_read_chunk', { path: src.path, offset, maxBytes: CHUNK_BYTES });
          offset += chunk.bytes;
          const items: RestoreItem[] = scanner.push(chunk.text, chunk.eof);

          for (const item of items) {
            ordinal++;
            if (ordinal <= resumeAt) {
              // A new session lost the settings made before the pause.
              if (newSession && item.kind === 'statement' && isSessionSetting(item.text, engine)) {
                await execute(item.text, ordinal).catch(() => {});
              }
              continue;
            }

            if (item.kind === 'meta') {
              skippedKinds.set('psql command', (skippedKinds.get('psql command') ?? 0) + 1);
              continue;
            }

            if (item.kind === 'copy') {
              try {
                await safeInvoke('session_copy_in', { sessionId: sessionRef.current, sql: item.sql, data: item.data });
                tally.rows += item.rows;
              } catch (err: any) {
                const msg = err?.message || String(err);
                errorBox.any = true;
                appendLog(`FAILED — ${msg} — ${item.sql}`, 'error');
                if (/session has ended|connection/i.test(msg)) await closeSession();
                if (stopOnError) {
                  await pauseHere(ordinal - 1);
                  return;
                }
              }
              continue;
            }

            const reason = skipReason(item.text, rules);
            if (reason) {
              skippedKinds.set(reason, (skippedKinds.get(reason) ?? 0) + 1);
              continue;
            }
            let sql = strip ? stripSchemaQualifiers(engine, item.text) : item.text;
            // Binary column values that mysqldump wrote as raw bytes.
            if (isMysqlFamily(engine)) sql = restoreBinaryLiterals(sql);
            try {
              if (hasRawBytes(sql)) throw new Error('This statement contains bytes that are not text, which this engine cannot take in a SQL string.');
              await execute(sql, ordinal);
              tally.statements++;
            } catch (err: any) {
              const msg = err?.message || String(err);
              const cat = categorizeStatement(sql, getEngineCapabilities(engine));
              // Turning FK checks off/on is an optimization, not data:
              // Postgres' `session_replication_role` needs superuser, which
              // managed hosts (Neon, RDS, Supabase) never grant.
              if ((cat === 'fk_disable' || cat === 'fk_enable') && !/session has ended/i.test(msg)) {
                appendLog(`Skipped "${sql.slice(0, 80)}" — ${msg}. Continuing without it.`);
                continue;
              }
              // pg_dump -n public writes CREATE SCHEMA public, which every
              // new database already has: what it asks for is already true.
              if (/^CREATE\s+SCHEMA\s/i.test(sql) && /42P06|already exists/i.test(msg)) {
                appendLog(`Schema already exists, kept as is: ${sql.slice(0, 80)}`);
                continue;
              }
              errorBox.any = true;
              appendLog(`FAILED — ${msg} — ${sql.slice(0, 300)}`, 'error');
              // A lost connection ends the session; Resume opens a new one.
              if (/session has ended|connection/i.test(msg)) await closeSession();
              if (stopOnError) {
                await pauseHere(ordinal - 1);
                return;
              }
            }
          }

          setBytesDone(offset);
          setCounts({ ...tally });
          // A progress line about every 10% of a large file.
          if (!chunk.eof && src.size > CHUNK_BYTES && offset - lastLogged >= src.size / 10) {
            lastLogged = offset;
            appendLog(`${formatBytes(offset)} of ${formatBytes(src.size)} — ${tally.statements.toLocaleString()} statements, ${tally.rows.toLocaleString()} rows`);
          }
          if (chunk.eof) break;
        }
      } catch (err: any) {
        // Reading the file failed (moved, unreadable, not UTF-8).
        errorBox.any = true;
        appendLog(err?.message || String(err), 'error');
        await pauseHere(Math.max(resumeAt, ordinal - 1));
        return;
      }

      if (scanner.rest.trim()) {
        errorBox.any = true;
        appendLog(`The file ends inside a statement, which was not run: ${scanner.rest.trim().slice(0, 200)}`, 'error');
      }
      for (const [kind, n] of skippedKinds) appendLog(`Skipped ${n.toLocaleString()} ${kind} statement${n === 1 ? '' : 's'}.`);
      appendLog(`${tally.statements.toLocaleString()} statements run, ${tally.rows.toLocaleString()} rows copied.`);

      await closeSession();
      setCounts({ ...tally });
      setBytesDone(src.size);
      setHadError(errorBox.any);
      if (!errorBox.any) appendLog('Restore complete.', 'success');
      await persistLog();
      setRunning(false);
      setDone(true);
      resumeRef.current = null;
    };

    await run(0);
  };

  /** Continue a paused restore, retrying the statement that failed. */
  const handleResume = async () => {
    if (!resumeRef.current) return;
    const resume = resumeRef.current;
    setHadError(false);
    await resume();
  };

  const percent = source && source.size > 0 ? Math.min(100, (bytesDone / source.size) * 100) : 0;
  const isPgDump = source?.kind === 'pg_dump';

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
              disabled={running}
              className="w-full h-9 flex items-center gap-2 px-2 rounded-lg bg-[#0f172a] border border-[#1e293b] hover:border-blue-500/50 text-left transition-colors disabled:opacity-50"
            >
              <FolderOpen className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              {source ? (
                <span className="truncate font-mono text-[11px] text-slate-200">{source.label}</span>
              ) : (
                <span className="text-slate-500">Choose a .sql file...</span>
              )}
            </button>
            {pickError && (
              <div className="mt-1">
                <CopyableErrorBanner message={pickError} tone="red" compact />
              </div>
            )}
            {source && (
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                <FileText className="w-3 h-3" /> {DUMP_LABEL[source.kind]} · {formatBytes(source.size)}
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
                disabled={storageBusy || running}
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
            <label className={`flex items-center gap-2 text-[11px] ${isPgDump ? 'text-slate-500' : 'text-slate-300'}`}>
              <input
                type="checkbox"
                checked={stripSourceDb && !isPgDump}
                disabled={isPgDump}
                onChange={(e) => setStripSourceDb(e.target.checked)}
                className="accent-blue-500"
              />
              Ignore database name baked into the file
            </label>
            <p className="text-[9px] text-slate-600 pl-5">
              {isPgDump
                ? 'Not used for pg_dump scripts: they name each object with its schema, which has to stay.'
                : stripSourceDb
                  ? "Restores into this connection's current database, even if it's named differently from where the backup came from. USE statements are skipped."
                  : 'Every CREATE/INSERT/DROP will target the exact database name from the file — fails if no database with that name exists here.'}
            </p>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={skipOwnership}
                onChange={(e) => setSkipOwnership(e.target.checked)}
                className="accent-blue-500"
              />
              Skip ownership and privileges (OWNER TO, GRANT, REVOKE)
            </label>
            <p className="text-[9px] text-slate-600 pl-5">
              They name users from the server the dump came from, which usually don't exist here.
            </p>
          </div>

          {paused && !running && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-[11px]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Paused after {counts.statements.toLocaleString()} statements. Fix the issue, then click Resume to retry it.
              </span>
            </div>
          )}

          {(running || log.length > 0) && (
            <div>
              {running && (
                <div className="flex items-center gap-2 mb-1.5">
                  <Loader2 className="w-3 h-3 animate-spin text-purple-400 shrink-0" />
                  <span className="text-[10px] text-slate-300 font-medium truncate flex-1">
                    {counts.statements.toLocaleString()} statements · {counts.rows.toLocaleString()} rows
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono shrink-0">
                    {source ? `${formatBytes(bytesDone)} / ${formatBytes(source.size)}` : ''}
                  </span>
                </div>
              )}
              <div className="h-1.5 w-full bg-[#1e293b] rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full transition-all ${hadError ? 'bg-amber-500' : 'bg-purple-500'}`}
                  style={{ width: `${percent}%` }}
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
                  disabled={running || !source}
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
