import React, { useState } from 'react';
import { X, Cloud, Loader2, CheckCircle2 } from 'lucide-react';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { safeInvoke } from '../../core/tauri/ipc';
import { useStorageStore } from '../../store/useStorageStore';
import { STORAGE_PRESETS, getPreset, presetDefaults } from '../../core/storage/domain/presets';
import type { S3ConnectionConfig, S3ProviderPreset, TestStorageResult } from '../../core/storage/domain/types';
import { encryptSecret, maskAccessKeyId, UNCHANGED_SECRET } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import { track } from '../../core/analytics/track';

const inputClass =
  'w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none';

const labelClass = 'block text-[10px] font-medium text-slate-400 mb-1 uppercase tracking-wider';

interface Props {
  onClose: () => void;
  /** When set, edit this connection; otherwise create a new one. */
  editing?: S3ConnectionConfig | null;
}

/** Generate a fresh connection id matching the existing `conn_` / `stor_` style. */
function newId(): string {
  return `stor_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export const StorageConnectionDialog: React.FC<Props> = ({ onClose, editing }) => {
  const saveConnection = useStorageStore((s) => s.saveConnection);

  // Seed from the editing target or from the first preset's defaults.
  const [preset, setPreset] = useState<S3ProviderPreset>(editing?.preset ?? 'minio');
  const [name, setName] = useState(editing?.name ?? '');
  const [region, setRegion] = useState(editing?.region ?? getPreset('minio').region);
  const [bucket, setBucket] = useState(editing?.bucket ?? '');
  const [endpoint, setEndpoint] = useState(editing?.endpoint ?? '');
  const [accessKeyId, setAccessKeyId] = useState(editing?.accessKeyId ?? '');
  // The secret field: empty on create, UNCHANGED sentinel on edit (until typed).
  const [secretAccessKey, setSecretAccessKey] = useState<string>(
    editing ? UNCHANGED_SECRET : '',
  );
  const [forcePathStyle, setForcePathStyle] = useState(
    editing?.forcePathStyle ?? getPreset('minio').forcePathStyle,
  );
  const [pathPrefix, setPathPrefix] = useState(editing?.pathPrefix ?? 'rdsql/');

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestStorageResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const applyPreset = (p: S3ProviderPreset) => {
    setPreset(p);
    const d = presetDefaults(p);
    setRegion(d.region);
    setEndpoint(d.endpoint ?? '');
    setForcePathStyle(d.forcePathStyle);
    if (!editing) setPathPrefix(d.pathPrefix);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      // For the test we need a plaintext secret. On edit with UNCHANGED, the
      // user must re-enter the secret to test — surface that clearly.
      if (secretAccessKey === UNCHANGED_SECRET) {
        setTestError('Re-enter the secret access key to test the connection.');
        return;
      }
      const res = await safeInvoke<TestStorageResult>('s3_test_connection', {
        config: {
          id: editing?.id ?? newId(),
          name,
          region,
          bucket,
          endpoint: endpoint || undefined,
          accessKeyId,
          secretAccessKey,
          forcePathStyle,
          pathPrefix,
        },
      });
      setTestResult(res);
    } catch (err: unknown) {
      const se = toStorageError(err);
      setTestError(se.message);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !bucket.trim() || !accessKeyId.trim()) return;
    if (!editing && !secretAccessKey.trim()) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      // Seal the secret unless the user left it unchanged on edit.
      const sealedSecret =
        secretAccessKey === UNCHANGED_SECRET
          ? UNCHANGED_SECRET
          : await encryptSecret(secretAccessKey);

      const conn: S3ConnectionConfig = {
        id: editing?.id ?? newId(),
        name: name.trim(),
        preset,
        provider: 's3',
        region: region.trim(),
        bucket: bucket.trim(),
        endpoint: endpoint.trim() || undefined,
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: sealedSecret,
        forcePathStyle,
        pathPrefix: pathPrefix.trim(),
        // Preserve the existing tagId on edit — without this, saving an edit
        // would wipe the tag assignment and the connection would fall out of
        // its folder.
        tagId: editing?.tagId ?? null,
        createdAt: editing?.createdAt ?? now,
        updatedAt: now,
      };
      if (!editing) track({ name: 's3_connection_created', dimension: preset });
      saveConnection(conn);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const maskedSecret = editing ? maskAccessKeyId(editing.accessKeyId) : '';

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[560px] max-h-[85vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl text-slate-200 font-sans text-xs overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-slate-200">
            <Cloud className="w-3.5 h-3.5 text-amber-400" />
            <span>{editing ? 'Edit Storage Connection' : 'New Storage Connection'}</span>
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          <div>
            <label className={labelClass}>Provider Preset</label>
            <select
              className={inputClass}
              value={preset}
              onChange={(e) => applyPreset(e.target.value as S3ProviderPreset)}
            >
              {STORAGE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-500 mt-1">{getPreset(preset).hint}</p>
          </div>

          <div>
            <label className={labelClass}>Connection Name</label>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production R2"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Bucket</label>
              <input
                className={inputClass}
                value={bucket}
                onChange={(e) => setBucket(e.target.value)}
                placeholder="company-backups"
              />
            </div>
            <div>
              <label className={labelClass}>Region</label>
              <input
                className={inputClass}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="us-east-1 / auto"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Endpoint (optional for AWS S3)</label>
            <input
              className={`${inputClass} font-mono`}
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://<account>.r2.cloudflarestorage.com"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Access Key ID</label>
              <input
                className={`${inputClass} font-mono`}
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder="AKIA…"
              />
            </div>
            <div>
              <label className={labelClass}>
                Secret Access Key {editing && <span className="text-slate-600 normal-case">(leave to keep: {maskedSecret})</span>}
              </label>
              <input
                className={`${inputClass} font-mono`}
                type="password"
                value={secretAccessKey === UNCHANGED_SECRET ? '' : secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                placeholder={editing ? '•••••••• (unchanged)' : 'secret access key'}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Path Prefix (RDSQL scope)</label>
              <input
                className={`${inputClass} font-mono`}
                value={pathPrefix}
                onChange={(e) => setPathPrefix(e.target.value)}
                placeholder="rdsql/"
              />
              <p className="text-[10px] text-slate-500 mt-1">RDSQL writes stay under this prefix.</p>
            </div>
            <div>
              <label className={labelClass}>Addressing</label>
              <label className="flex items-center gap-2 h-8 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={forcePathStyle}
                  onChange={(e) => setForcePathStyle(e.target.checked)}
                  className="accent-blue-500"
                />
                <span>Force path-style (MinIO / self-hosted)</span>
              </label>
            </div>
          </div>

          {/* Test result / error */}
          {testResult && (
            <div className="flex items-center gap-2 text-emerald-400 text-[11px] px-2 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{testResult.message}</span>
            </div>
          )}
          {testError && (
            <CopyableErrorBanner message={testError} tone="red" compact />
          )}
        </div>

        <div className="border-t border-[#1e293b] px-3 py-2 flex items-center justify-between shrink-0 bg-[#06090e]">
          <button
            onClick={handleTest}
            disabled={testing || !bucket.trim() || !accessKeyId.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] disabled:opacity-40 flex items-center gap-1.5"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Cloud className="w-3.5 h-3.5" />}
            Test Connection
          </button>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !name.trim() || !bucket.trim() || !accessKeyId.trim() || (!editing && !secretAccessKey.trim())}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {editing ? 'Save Changes' : 'Create Connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
