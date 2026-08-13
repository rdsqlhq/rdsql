import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  RefreshCw,
  Trash2,
  Plus,
  Save,
  Clock,
  Loader2,
  Key as KeyIcon,
  ChevronRight,
  Braces,
  FileText,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { useConnectionStore } from '../../store/useConnectionStore';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { CreateKeyDialog } from './CreateKeyDialog';
import { TtlDialog } from './TtlDialog';
import type { RedisDbInfo, RedisKeyDetail, RedisKeyEntry, RedisScanResult } from '../../core/redis/types';

interface Props {
  connectionId?: string;
  /** Which logical DB (0-15) this tab is browsing — set by the Explorer's
   *  Databases tree, or `undefined` to fall back to the connection's own
   *  configured `redisDbIndex` (or 0). */
  dbIndex?: number;
}

const SCAN_COUNT = 200;
const ROW_HEIGHT = 28;
const OVERSCAN = 20;
const DB_COUNT = 16;

type TypeFilter = 'all' | 'string' | 'hash' | 'list' | 'set' | 'zset';
type TtlFilter = 'any' | 'has' | 'none' | 'expiring';
const EXPIRING_SOON_MS = 60 * 60 * 1000; // 1h — matches the "Expiring <1h" filter label

/** Badge color per Redis value type — purely cosmetic, mirrors the app's
 *  per-engine accent-color convention (EngineIcon.tsx). */
const TYPE_COLOR: Record<string, string> = {
  string: 'text-cyan-400 border-cyan-500/30 bg-cyan-500/10',
  hash: 'text-amber-400 border-amber-500/30 bg-amber-500/10',
  list: 'text-purple-400 border-purple-500/30 bg-purple-500/10',
  set: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  zset: 'text-pink-400 border-pink-500/30 bg-pink-500/10',
};

function formatTtl(ms: number | undefined): string {
  if (ms === undefined) return '∞';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best-effort "does this look like JSON" check, purely for offering the
 *  Pretty/Raw toggle — never used to alter what's actually stored. */
function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

const labelClass = 'block text-[11px] font-medium text-slate-400 mb-1';
const inputClass =
  'w-full bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded px-2.5 py-1.5 text-[12px] text-slate-100 focus:outline-none';
const selectClass =
  'bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded px-2 py-1 text-[11px] text-slate-100 focus:outline-none';

export const RedisBrowser: React.FC<Props> = ({ connectionId, dbIndex }) => {
  const connections = useConnectionStore((s) => s.connections);
  const connection = useMemo(
    () => connections.find((c) => c.id === connectionId) ?? null,
    [connections, connectionId],
  );

  // ── Selected logical DB ───────────────────────────────────────────────────
  // Tree-driven (the `dbIndex` prop) takes precedence; falls back to the
  // connection's own configured default. Switching DB never writes back to
  // the saved connection — it's session/tab-scoped only.
  const [selectedDb, setSelectedDb] = useState(dbIndex ?? connection?.redisDbIndex ?? 0);
  useEffect(() => {
    if (dbIndex !== undefined) setSelectedDb(dbIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbIndex]);

  const effectiveConfig = useMemo(
    () => (connection ? { ...connection, redisDbIndex: selectedDb } : null),
    [connection, selectedDb],
  );

  // ── Per-DB stats (key count / memory context for the header) ─────────────
  const [keyspace, setKeyspace] = useState<RedisDbInfo[] | null>(null);
  const [keyspaceLoading, setKeyspaceLoading] = useState(false);

  const loadKeyspace = async () => {
    if (!connection) return;
    setKeyspaceLoading(true);
    try {
      const dbs = await safeInvoke<RedisDbInfo[]>('redis_keyspace_info', { config: connection });
      setKeyspace(dbs);
    } catch {
      // Purely informational (header count) — a failure here shouldn't block
      // browsing, so just leave the count blank rather than erroring the page.
      setKeyspace(null);
    } finally {
      setKeyspaceLoading(false);
    }
  };

  useEffect(() => {
    loadKeyspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, selectedDb]);

  const currentDbInfo = keyspace?.find((d) => d.dbIndex === selectedDb);

  // ── Key list (SCAN pagination) ────────────────────────────────────────────
  const [entries, setEntries] = useState<RedisKeyEntry[]>([]);
  const [pattern, setPattern] = useState('');
  const [cursor, setCursor] = useState(0);
  const [scanDone, setScanDone] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [ttlFilter, setTtlFilter] = useState<TtlFilter>('any');
  const patternDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const runScan = async (reset: boolean) => {
    if (!effectiveConfig) return;
    setLoadingKeys(true);
    setListError(null);
    try {
      const fromCursor = reset ? 0 : cursor;
      const trimmed = pattern.trim();
      const res = await safeInvoke<RedisScanResult>('redis_scan_keys', {
        config: effectiveConfig,
        cursor: fromCursor,
        pattern: trimmed ? `*${trimmed}*` : undefined,
        count: SCAN_COUNT,
      });
      setEntries((prev) => (reset ? res.entries : [...prev, ...res.entries]));
      setCursor(res.cursor);
      setScanDone(res.done);
    } catch (err: any) {
      setListError(err?.message || String(err));
    } finally {
      setLoadingKeys(false);
    }
  };

  useEffect(() => {
    setEntries([]);
    setCursor(0);
    setScanDone(false);
    setSelectedKey(null);
    if (effectiveConfig) runScan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, selectedDb]);

  const handlePatternChange = (value: string) => {
    setPattern(value);
    if (patternDebounce.current) clearTimeout(patternDebounce.current);
    patternDebounce.current = setTimeout(() => {
      setEntries([]);
      setCursor(0);
      setScanDone(false);
      runScan(true);
    }, 300);
  };

  const refreshAll = () => {
    loadKeyspace();
    setEntries([]);
    setCursor(0);
    setScanDone(false);
    runScan(true);
  };

  // Client-side filters over the currently loaded page(s) — Type/TTL aren't
  // SCAN-native filters, so this only narrows what's already been fetched
  // (the glob `pattern` above is the only thing that narrows the actual scan).
  const filteredEntries = useMemo(() => {
    return entries.filter((e) => {
      if (typeFilter !== 'all' && e.keyType !== typeFilter) return false;
      if (ttlFilter === 'has' && e.ttlMs === undefined) return false;
      if (ttlFilter === 'none' && e.ttlMs !== undefined) return false;
      if (ttlFilter === 'expiring' && (e.ttlMs === undefined || e.ttlMs > EXPIRING_SOON_MS)) return false;
      return true;
    });
  }, [entries, typeFilter, ttlFilter]);

  // ── Selected key detail ───────────────────────────────────────────────────
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable buffers, reset whenever a new key's detail loads.
  const [stringEdit, setStringEdit] = useState('');
  const [stringView, setStringView] = useState<'pretty' | 'raw'>('raw');
  const [hashEdits, setHashEdits] = useState<Record<string, string>>({});
  const [newHashField, setNewHashField] = useState('');
  const [newHashValue, setNewHashValue] = useState('');

  const [deleteConfirm, setDeleteConfirm] = useState<
    { kind: 'key' } | { kind: 'hashField'; field: string } | null
  >(null);
  const [ttlDialogOpen, setTtlDialogOpen] = useState(false);
  const [createKeyOpen, setCreateKeyOpen] = useState(false);

  const loadDetail = async (key: string) => {
    if (!effectiveConfig) return;
    setLoadingDetail(true);
    setDetailError(null);
    try {
      const d = await safeInvoke<RedisKeyDetail>('redis_get_key_detail', { config: effectiveConfig, key });
      setDetail(d);
      if (d.value.valueType === 'string') {
        setStringEdit(d.value.value);
        setStringView(looksLikeJson(d.value.value) ? 'pretty' : 'raw');
      }
      if (d.value.valueType === 'hash') {
        setHashEdits(Object.fromEntries(d.value.entries));
      }
    } catch (err: any) {
      setDetail(null);
      setDetailError(err?.message || String(err));
    } finally {
      setLoadingDetail(false);
    }
  };

  const selectKey = (key: string) => {
    setSelectedKey(key);
    loadDetail(key);
  };

  const withSaving = async (fn: () => Promise<void>) => {
    setSaving(true);
    try {
      await fn();
    } catch (err: any) {
      setDetailError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveStringValue = () =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_set_string_value', { config: effectiveConfig, key: selectedKey, value: stringEdit });
      await loadDetail(selectedKey);
    });

  const saveHashField = (field: string) =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_set_hash_field', { config: effectiveConfig, key: selectedKey, field, value: hashEdits[field] ?? '' });
      await loadDetail(selectedKey);
    });

  const addHashField = () =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey || !newHashField.trim()) return;
      await safeInvoke('redis_set_hash_field', {
        config: effectiveConfig,
        key: selectedKey,
        field: newHashField.trim(),
        value: newHashValue,
      });
      setNewHashField('');
      setNewHashValue('');
      await loadDetail(selectedKey);
    });

  const deleteHashField = (field: string) =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_delete_hash_field', { config: effectiveConfig, key: selectedKey, field });
      await loadDetail(selectedKey);
    });

  const applyTtl = (seconds: number) =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_set_ttl', { config: effectiveConfig, key: selectedKey, ttlSeconds: seconds });
      await loadDetail(selectedKey);
    });

  const removeTtl = () =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_set_ttl', { config: effectiveConfig, key: selectedKey, ttlSeconds: null });
      await loadDetail(selectedKey);
    });

  const deleteKey = () =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_delete_key', { config: effectiveConfig, key: selectedKey });
      setEntries((prev) => prev.filter((e) => e.key !== selectedKey));
      setSelectedKey(null);
      setDetail(null);
    });

  // "Expire Now" is functionally an immediate delete — no dedicated backend
  // call needed. Also used as the TTL dialog's own "Expire Now" action.
  const expireNow = () =>
    withSaving(async () => {
      if (!effectiveConfig || !selectedKey) return;
      await safeInvoke('redis_delete_key', { config: effectiveConfig, key: selectedKey });
      setEntries((prev) => prev.filter((e) => e.key !== selectedKey));
      setSelectedKey(null);
      setDetail(null);
      setTtlDialogOpen(false);
    });

  // ── Virtualized key list ───────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onListScroll = () => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop);
  };

  const vStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const vCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const vEnd = Math.min(filteredEntries.length, vStart + vCount);
  const vEntries = filteredEntries.slice(vStart, vEnd);
  const spacerTop = vStart * ROW_HEIGHT;
  const spacerBottom = Math.max(0, (filteredEntries.length - vEnd) * ROW_HEIGHT);

  // ── Keyboard shortcuts (scoped to this component — there's no shared
  //     shortcut registry in this app; mirrors MainLayout's zoom-shortcut
  //     pattern) ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inTextField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        refreshAll();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setCreateKeyOpen(true);
      } else if (e.key === 'Delete' && !inTextField && selectedKey) {
        e.preventDefault();
        setDeleteConfirm({ kind: 'key' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, effectiveConfig]);

  if (!connection) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        No Redis connection selected.
      </div>
    );
  }

  const dbKeyCount = currentDbInfo?.keys;
  const isEmptyDb = !pattern.trim() && scanDone && entries.length === 0 && !loadingKeys && !listError;
  const isEmptySearch = !!pattern.trim() && scanDone && filteredEntries.length === 0 && !loadingKeys && !listError;

  return (
    <div className="h-full flex min-h-0 overflow-hidden">
      {/* ── Key list ─────────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-[#1e293b] flex flex-col min-h-0 bg-[#06090e]">
        {/* Header: DB selector + counts */}
        <div className="px-2.5 pt-2.5 pb-2 border-b border-[#1e293b] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <select
              value={selectedDb}
              onChange={(e) => setSelectedDb(Number(e.target.value))}
              className={`${selectClass} font-mono font-semibold`}
              title="Switch logical database (SELECT n)"
            >
              {Array.from({ length: DB_COUNT }, (_, i) => i).map((n) => (
                <option key={n} value={n}>DB {n}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={refreshAll}
              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-red-400 transition-colors shrink-0"
              title="Refresh (⌘R)"
            >
              <RefreshCw className={`w-3 h-3 ${loadingKeys || keyspaceLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="text-[10px] text-slate-500">
            {dbKeyCount !== undefined ? `${dbKeyCount.toLocaleString()} key${dbKeyCount === 1 ? '' : 's'}` : keyspaceLoading ? 'Loading…' : '—'}
          </div>
        </div>

        {/* Toolbar: search + filters + new key */}
        <div className="p-2.5 border-b border-[#1e293b] space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-2" />
            <input
              ref={searchInputRef}
              value={pattern}
              onChange={(e) => handlePatternChange(e.target.value)}
              placeholder="Search keys… (⌘F)"
              className="w-full bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded pl-7 pr-2 py-1.5 text-[11px] text-slate-100 focus:outline-none"
            />
          </div>
          <div className="text-[9.5px] text-slate-600">
            Uses Redis SCAN + glob pattern matching (e.g. <span className="font-mono">user:*</span>)
          </div>
          <div className="flex items-center gap-1.5">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as TypeFilter)} className={`${selectClass} flex-1`}>
              <option value="all">All types</option>
              <option value="string">String</option>
              <option value="hash">Hash</option>
              <option value="list">List</option>
              <option value="set">Set</option>
              <option value="zset">ZSet</option>
            </select>
            <select value={ttlFilter} onChange={(e) => setTtlFilter(e.target.value as TtlFilter)} className={`${selectClass} flex-1`}>
              <option value="any">Any TTL</option>
              <option value="has">Has TTL</option>
              <option value="none">No TTL</option>
              <option value="expiring">Expiring &lt;1h</option>
            </select>
            <button
              type="button"
              onClick={() => setCreateKeyOpen(true)}
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-red-600/20 text-red-300 hover:bg-red-600/30 transition-colors shrink-0"
              title="New Key (⌘N)"
            >
              <Plus className="w-3 h-3" />
              Key
            </button>
          </div>
        </div>

        <div ref={scrollRef} onScroll={onListScroll} className="flex-1 overflow-y-auto">
          {listError && (
            <div className="p-2">
              <CopyableErrorBanner message={listError} parseAsDbError compact />
            </div>
          )}
          {isEmptyDb && (
            <div className="p-4 text-center space-y-2">
              <div className="text-[11px] text-slate-400 font-medium">DB {selectedDb} is empty</div>
              <div className="text-[10px] text-slate-600">Create your first Redis key to get started.</div>
              <button
                type="button"
                onClick={() => setCreateKeyOpen(true)}
                className="mt-1 px-2.5 py-1 rounded text-[11px] font-medium bg-red-600/20 text-red-300 hover:bg-red-600/30 transition-colors"
              >
                + New Key
              </button>
            </div>
          )}
          {isEmptySearch && (
            <div className="p-4 text-center space-y-1">
              <div className="text-[11px] text-slate-400 font-medium">No keys match "{pattern.trim()}"</div>
              <div className="text-[10px] text-slate-600">Try another pattern or clear the filter.</div>
            </div>
          )}
          {filteredEntries.length > 0 && (
            <div style={{ height: spacerTop }} />
          )}
          {vEntries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => selectKey(entry.key)}
              style={{ height: ROW_HEIGHT }}
              className={`w-full flex items-center gap-1.5 px-2.5 text-[11px] font-mono text-left transition-colors ${
                selectedKey === entry.key ? 'bg-red-500/10 text-red-300' : 'text-slate-300 hover:bg-[#0f172a]'
              }`}
              title={entry.key}
            >
              <KeyIcon className="w-3 h-3 shrink-0 text-slate-600" />
              <span className="truncate flex-1">{entry.key}</span>
              <span
                className={`text-[9px] font-semibold uppercase px-1 py-0.5 rounded border shrink-0 ${
                  TYPE_COLOR[entry.keyType] || 'text-slate-400 border-slate-600 bg-slate-500/10'
                }`}
              >
                {entry.keyType}
              </span>
              <span className="text-[9.5px] text-slate-600 shrink-0 w-10 text-right">{formatTtl(entry.ttlMs)}</span>
              {selectedKey === entry.key && <ChevronRight className="w-3 h-3 shrink-0" />}
            </button>
          ))}
          {filteredEntries.length > 0 && (
            <div style={{ height: spacerBottom }} />
          )}
          {!scanDone && entries.length > 0 && (
            <button
              type="button"
              onClick={() => runScan(false)}
              disabled={loadingKeys}
              className="w-full py-2 text-[11px] text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {loadingKeys ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </div>

      {/* ── Selected key detail ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {!selectedKey ? (
          <div className="flex-1 h-full flex items-center justify-center text-slate-500 text-sm">
            Select a key to view its value.
          </div>
        ) : loadingDetail ? (
          <div className="flex-1 h-full flex items-center justify-center text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : detailError ? (
          <div className="p-4">
            <CopyableErrorBanner message={detailError} parseAsDbError />
          </div>
        ) : detail ? (
          <div className="p-4 space-y-4 max-w-3xl">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-sm text-slate-100 truncate">{detail.key}</div>
              </div>
              <button
                type="button"
                onClick={() => setDeleteConfirm({ kind: 'key' })}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] text-rose-400 hover:bg-rose-500/10 border border-rose-500/30 transition-colors shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete Key
              </button>
            </div>

            {/* Overview strip */}
            <div className="grid grid-cols-4 gap-2 text-[11px]">
              <div className="bg-[#0f172a] rounded px-2.5 py-1.5">
                <div className="text-[9.5px] text-slate-600 mb-0.5">Type</div>
                <div className={`inline-block text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${TYPE_COLOR[detail.keyType] || 'text-slate-400 border-slate-600 bg-slate-500/10'}`}>
                  {detail.keyType}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setTtlDialogOpen(true)}
                className="bg-[#0f172a] rounded px-2.5 py-1.5 text-left hover:bg-[#152036] transition-colors"
                title="Click to edit TTL"
              >
                <div className="text-[9.5px] text-slate-600 mb-0.5 flex items-center gap-1"><Clock className="w-2.5 h-2.5" />TTL</div>
                <div className="text-slate-200 font-mono">{formatTtl(detail.ttlMs)}</div>
              </button>
              <div className="bg-[#0f172a] rounded px-2.5 py-1.5">
                <div className="text-[9.5px] text-slate-600 mb-0.5">Memory</div>
                <div className="text-slate-200 font-mono">{formatBytes(detail.memoryBytes) ?? '—'}</div>
              </div>
              <div className="bg-[#0f172a] rounded px-2.5 py-1.5">
                <div className="text-[9.5px] text-slate-600 mb-0.5">Encoding</div>
                <div className="text-slate-200 font-mono truncate" title={detail.encoding}>{detail.encoding ?? '—'}</div>
              </div>
            </div>

            {/* Value viewer/editor, per type */}
            {detail.value.valueType === 'string' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={labelClass}>Value</label>
                  {looksLikeJson(stringEdit) && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setStringView('pretty')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${stringView === 'pretty' ? 'bg-red-500/20 text-red-300' : 'text-slate-500 hover:text-slate-300'}`}
                      >
                        <Braces className="w-3 h-3" /> Pretty JSON
                      </button>
                      <button
                        type="button"
                        onClick={() => setStringView('raw')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${stringView === 'raw' ? 'bg-red-500/20 text-red-300' : 'text-slate-500 hover:text-slate-300'}`}
                      >
                        <FileText className="w-3 h-3" /> Raw
                      </button>
                    </div>
                  )}
                </div>
                <textarea
                  value={stringView === 'pretty' && looksLikeJson(stringEdit) ? (() => {
                    try { return JSON.stringify(JSON.parse(stringEdit), null, 2); } catch { return stringEdit; }
                  })() : stringEdit}
                  onChange={(e) => setStringEdit(e.target.value)}
                  rows={10}
                  className={`${inputClass} font-mono resize-y`}
                />
                <button
                  type="button"
                  onClick={saveStringValue}
                  disabled={saving}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded text-[11px] font-medium bg-red-600 text-white hover:bg-red-500 transition-colors disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save
                </button>
              </div>
            )}

            {detail.value.valueType === 'hash' && (
              <div className="space-y-2">
                <label className={labelClass}>Fields ({detail.value.entries.length})</label>
                <div className="space-y-1.5">
                  {detail.value.entries.map(([field]) => (
                    <div key={field} className="flex items-center gap-1.5">
                      <input value={field} disabled className={`${inputClass} font-mono w-40 opacity-70`} />
                      <input
                        value={hashEdits[field] ?? ''}
                        onChange={(e) => setHashEdits((prev) => ({ ...prev, [field]: e.target.value }))}
                        className={`${inputClass} font-mono flex-1`}
                      />
                      <button
                        type="button"
                        onClick={() => saveHashField(field)}
                        disabled={saving}
                        title="Save field"
                        className="p-1.5 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteHashField(field)}
                        disabled={saving}
                        title="Delete field"
                        className="p-1.5 rounded text-rose-400 hover:bg-rose-500/10 disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-1.5 pt-2 border-t border-[#1e293b]">
                  <input
                    value={newHashField}
                    onChange={(e) => setNewHashField(e.target.value)}
                    placeholder="new field"
                    className={`${inputClass} font-mono w-40`}
                  />
                  <input
                    value={newHashValue}
                    onChange={(e) => setNewHashValue(e.target.value)}
                    placeholder="value"
                    className={`${inputClass} font-mono flex-1`}
                  />
                  <button
                    type="button"
                    onClick={addHashField}
                    disabled={saving || !newHashField.trim()}
                    title="Add field"
                    className="p-1.5 rounded text-slate-300 hover:bg-[#1e293b] disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {detail.value.valueType === 'list' && (
              <div>
                <label className={labelClass}>
                  Items ({detail.value.items.length}
                  {detail.value.truncated ? ', truncated' : ''})
                </label>
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {detail.value.items.map((item, i) => (
                    <div key={i} className="flex gap-2 text-[11px] font-mono text-slate-300 px-2 py-1 bg-[#0f172a] rounded">
                      <span className="text-slate-600 shrink-0">{i}</span>
                      <span className="truncate">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.value.valueType === 'set' && (
              <div>
                <label className={labelClass}>
                  Members ({detail.value.members.length}
                  {detail.value.truncated ? ', truncated' : ''})
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {detail.value.members.map((member) => (
                    <span key={member} className="px-2 py-1 rounded bg-[#0f172a] text-[11px] font-mono text-slate-300">
                      {member}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {detail.value.valueType === 'zset' && (
              <div>
                <label className={labelClass}>
                  Members ({detail.value.members.length}
                  {detail.value.truncated ? ', truncated' : ''})
                </label>
                <div className="space-y-1 max-h-96 overflow-y-auto">
                  {detail.value.members.map(([member, score]) => (
                    <div key={member} className="flex justify-between text-[11px] font-mono text-slate-300 px-2 py-1 bg-[#0f172a] rounded">
                      <span className="truncate">{member}</span>
                      <span className="text-slate-500 shrink-0">{score}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      {deleteConfirm?.kind === 'key' && selectedKey && (
        <ConfirmDialog
          title="Delete key"
          message={<>Permanently delete <span className="font-mono text-slate-200">{selectedKey}</span>? This cannot be undone.</>}
          confirmLabel="Delete"
          tone="danger"
          loading={saving}
          onConfirm={async () => {
            await deleteKey();
            setDeleteConfirm(null);
          }}
          onClose={() => setDeleteConfirm(null)}
        />
      )}

      {ttlDialogOpen && selectedKey && detail && (
        <TtlDialog
          keyName={selectedKey}
          currentTtlMs={detail.ttlMs}
          onClose={() => setTtlDialogOpen(false)}
          onApply={applyTtl}
          onRemoveTtl={removeTtl}
          onExpireNow={expireNow}
        />
      )}

      {createKeyOpen && connection && (
        <CreateKeyDialog
          connection={connection}
          dbIndex={selectedDb}
          onClose={() => setCreateKeyOpen(false)}
          onCreated={(key) => {
            setCreateKeyOpen(false);
            refreshAll();
            selectKey(key);
          }}
        />
      )}
    </div>
  );
};
