import React, { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { safeInvoke } from '../../core/tauri/ipc';
import type { DatabaseConnection } from '../../core/domain/types';

/** The 5 Redis types this app can browse (`fetch_value` in
 *  `commands::redis`) — no Stream, no module types, so none of those are
 *  offered here either (never advertise a type the viewer can't open). */
type CreatableType = 'string' | 'hash' | 'list' | 'set' | 'zset';

const TYPE_OPTIONS: { value: CreatableType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'hash', label: 'Hash' },
  { value: 'list', label: 'List' },
  { value: 'set', label: 'Set' },
  { value: 'zset', label: 'Sorted Set' },
];

const labelClass = 'block text-[11px] font-medium text-slate-400 mb-1';
const inputClass =
  'w-full bg-[#0f172a] border border-[#1e293b] focus:border-red-500 rounded px-2.5 py-1.5 text-[12px] text-slate-100 focus:outline-none';

interface Props {
  connection: DatabaseConnection;
  /** Which logical DB (0-15) to create the key in — the browser's current selection. */
  dbIndex: number;
  onClose: () => void;
  /** Fired after the key is created and its TTL (if any) applied, so the
   *  caller can refresh the list and select the new key. */
  onCreated: (key: string) => void;
}

export const CreateKeyDialog: React.FC<Props> = ({ connection, dbIndex, onClose, onCreated }) => {
  useEscapeToClose(onClose);

  const [key, setKey] = useState('');
  const [type, setType] = useState<CreatableType>('string');
  const [stringValue, setStringValue] = useState('');
  const [hashField, setHashField] = useState('');
  const [hashValue, setHashValue] = useState('');
  const [listValue, setListValue] = useState('');
  const [setMember, setSetMember] = useState('');
  const [zsetMember, setZsetMember] = useState('');
  const [zsetScore, setZsetScore] = useState('0');
  const [ttlSeconds, setTtlSeconds] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveConfig = { ...connection, redisDbIndex: dbIndex };

  const canSubmit = (() => {
    if (!key.trim()) return false;
    switch (type) {
      case 'string':
        return true; // an empty string value is a legitimate STRING key
      case 'hash':
        return hashField.trim() !== '';
      case 'list':
        return listValue.trim() !== '';
      case 'set':
        return setMember.trim() !== '';
      case 'zset':
        return zsetMember.trim() !== '' && !Number.isNaN(Number(zsetScore));
      default:
        return false;
    }
  })();

  const handleCreate = async () => {
    if (!canSubmit || creating) return;
    const trimmedKey = key.trim();
    setCreating(true);
    setError(null);
    try {
      // Refuse to clobber an existing key — reuse redis_get_key_detail's
      // NotFound error rather than adding a dedicated EXISTS command.
      const alreadyExists = await safeInvoke('redis_get_key_detail', { config: effectiveConfig, key: trimmedKey })
        .then(() => true)
        .catch((err: any) => {
          const message = err?.message || '';
          if (message.includes('"kind":"notfound"')) return false;
          throw err; // a real error (network/auth/etc.) — surface it, don't assume "doesn't exist"
        });
      if (alreadyExists) {
        setError(`Key "${trimmedKey}" already exists.`);
        setCreating(false);
        return;
      }

      switch (type) {
        case 'string':
          await safeInvoke('redis_set_string_value', { config: effectiveConfig, key: trimmedKey, value: stringValue });
          break;
        case 'hash':
          await safeInvoke('redis_set_hash_field', { config: effectiveConfig, key: trimmedKey, field: hashField.trim(), value: hashValue });
          break;
        case 'list':
          await safeInvoke('redis_list_push', { config: effectiveConfig, key: trimmedKey, value: listValue, left: false });
          break;
        case 'set':
          await safeInvoke('redis_set_add', { config: effectiveConfig, key: trimmedKey, member: setMember.trim() });
          break;
        case 'zset':
          await safeInvoke('redis_zset_add', {
            config: effectiveConfig,
            key: trimmedKey,
            member: zsetMember.trim(),
            score: Number(zsetScore),
          });
          break;
      }

      const ttl = ttlSeconds.trim() === '' ? null : Number(ttlSeconds);
      if (ttl && ttl > 0) {
        await safeInvoke('redis_set_ttl', { config: effectiveConfig, key: trimmedKey, ttlSeconds: ttl });
      }

      onCreated(trimmedKey);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[85vh] bg-[#0a0f18] border border-red-500/20 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-red-300">
            <Plus className="w-4 h-4" />
            Create Redis Key
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <label className={labelClass}>Key</label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="user:1001"
              autoFocus
              className={`${inputClass} font-mono`}
            />
          </div>

          <div>
            <label className={labelClass}>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as CreatableType)} className={inputClass}>
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {type === 'string' && (
            <div>
              <label className={labelClass}>Value</label>
              <textarea
                value={stringValue}
                onChange={(e) => setStringValue(e.target.value)}
                rows={4}
                className={`${inputClass} font-mono resize-y`}
              />
            </div>
          )}

          {type === 'hash' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Field</label>
                <input value={hashField} onChange={(e) => setHashField(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className={labelClass}>Value</label>
                <input value={hashValue} onChange={(e) => setHashValue(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
            </div>
          )}

          {type === 'list' && (
            <div>
              <label className={labelClass}>Initial value</label>
              <input value={listValue} onChange={(e) => setListValue(e.target.value)} className={`${inputClass} font-mono`} />
            </div>
          )}

          {type === 'set' && (
            <div>
              <label className={labelClass}>Initial member</label>
              <input value={setMember} onChange={(e) => setSetMember(e.target.value)} className={`${inputClass} font-mono`} />
            </div>
          )}

          {type === 'zset' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Member</label>
                <input value={zsetMember} onChange={(e) => setZsetMember(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className={labelClass}>Score</label>
                <input
                  type="number"
                  value={zsetScore}
                  onChange={(e) => setZsetScore(e.target.value)}
                  className={`${inputClass} font-mono`}
                />
              </div>
            </div>
          )}

          <div>
            <label className={labelClass}>TTL (seconds, empty = no expiration)</label>
            <input
              type="number"
              min={0}
              value={ttlSeconds}
              onChange={(e) => setTtlSeconds(e.target.value)}
              placeholder="No expiration"
              className={inputClass}
            />
          </div>

          {error && (
            <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-2.5 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#1e293b]">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canSubmit || creating}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-white text-xs font-semibold bg-red-600 hover:bg-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating && <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
