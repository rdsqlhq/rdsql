import React, { useEffect, useState } from 'react';
import { X, Shield, Loader2, CheckCircle2, KeyRound } from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import {
  CANNED_ACLS,
  cannedAclHint,
  granteeLabel,
  type AclDto,
} from '../../core/storage/domain/acl';
import type { S3ConnectionConfig, StorageObject } from '../../core/storage/domain/types';

interface Props {
  connection: S3ConnectionConfig;
  object: StorageObject;
  onClose: () => void;
}

/**
 * Object ACL (permissions) viewer/editor. Shows the current grant list and a
 * canned-ACL dropdown to apply a new one. Provider-dependent — R2 and some
 * MinIO configs reject ACLs; the error path surfaces that cleanly.
 */
export const StorageAclDialog: React.FC<Props> = ({ connection, object, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [acl, setAcl] = useState<AclDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canned, setCanned] = useState('private');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const decrypted = await withDecryptedSecret(connection);
      const res = await safeInvoke<AclDto>('s3_get_object_acl', { config: decrypted, key: object.key });
      setAcl(res);
    } catch (err: unknown) {
      setError(toStorageError(err).message);
      setAcl(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [object.key]);

  const handleApply = async () => {
    setApplying(true);
    setApplyError(null);
    setApplied(false);
    try {
      const decrypted = await withDecryptedSecret(connection);
      await safeInvoke('s3_put_object_acl', { config: decrypted, key: object.key, canned });
      setApplied(true);
      // Refresh the ACL view.
      void load();
    } catch (err: unknown) {
      setApplyError(toStorageError(err).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[520px] max-h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 border-b border-[#1e293b] bg-[#06090e] px-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-slate-200 text-xs">
            <Shield className="w-3.5 h-3.5 text-amber-400" />
            Permissions — {object.name}
          </div>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-slate-500 text-xs py-8">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading permissions…
            </div>
          ) : error ? (
            <CopyableErrorBanner message={error} tone="amber" />
          ) : acl ? (
            <>
              {/* Current grants */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  Current Grants
                </div>
                <div className="border border-[#1e293b] rounded-lg overflow-hidden">
                  {acl.grants.length === 0 ? (
                    <div className="text-[11px] text-slate-600 italic px-3 py-2">No grants.</div>
                  ) : (
                    acl.grants.map((g, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-[#0f172a] last:border-0">
                        <KeyRound className="w-3 h-3 text-slate-600 shrink-0" />
                        <span className="text-slate-300 truncate flex-1 font-mono">{granteeLabel(g.grantee)}</span>
                        <span className="text-slate-500 shrink-0 font-mono">{g.permission}</span>
                      </div>
                    ))
                  )}
                </div>
                <div className="text-[10px] text-slate-600 mt-1">
                  Owner: <span className="font-mono">{acl.owner.displayName ?? acl.owner.id ?? '—'}</span>
                </div>
              </div>

              {/* Apply canned ACL */}
              <div className="border-t border-[#1e293b] pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">
                  Apply Canned ACL
                </div>
                <select
                  value={canned}
                  onChange={(e) => { setCanned(e.target.value); setApplied(false); setApplyError(null); }}
                  className="w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-amber-500 rounded px-2 text-xs text-slate-100 focus:outline-none"
                >
                  {CANNED_ACLS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-500 mt-1">{cannedAclHint(canned)}</p>

                {applyError && <div className="mt-2"><CopyableErrorBanner message={applyError} tone="amber" compact /></div>}
                {applied && (
                  <div className="mt-2 flex items-center gap-1.5 text-emerald-400 text-[11px]">
                    <CheckCircle2 className="w-3.5 h-3.5" /> ACL applied.
                  </div>
                )}

                <div className="flex justify-end mt-2">
                  <button
                    onClick={handleApply}
                    disabled={applying}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-amber-300 bg-amber-600/15 border border-amber-600/30 hover:bg-amber-600/25 disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Shield className="w-3.5 h-3.5" />}
                    Apply
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};
