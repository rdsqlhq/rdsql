import React, { useState } from 'react';
import { Link2, Copy, Check, Loader2, ExternalLink, ShieldAlert, Eye, Shield } from 'lucide-react';
import { FileTypeIcon } from './FileTypeIcon';
import { safeInvoke } from '../../core/tauri/ipc';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import {
  PRESIGN_EXPIRY_OPTIONS,
  PRESIGN_DEFAULT_SECS,
  formatExpiry,
} from '../../core/storage/domain/presign';
import { formatBytes, formatDateTime } from './format';
import { copyToClipboard } from '../../core/utils/clipboard';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import type { S3ConnectionConfig, StorageObject } from '../../core/storage/domain/types';

interface Props {
  connection: S3ConnectionConfig;
  object: StorageObject | null;
  /** Open the preview/edit pane for the given object key. */
  onPreview?: (key: string) => void;
  /** Open the ACL/permissions dialog for the given object key. */
  onPermissions?: (key: string) => void;
}

/**
 * The bottom details strip for the storage browser: shows the selected
 * object's metadata and generates a presigned GET URL with a configurable
 * expiry. The URL is held in memory only and embeds a time-limited signature —
 * anyone with the link can download the object until it expires.
 */
export const StorageDetailsStrip: React.FC<Props> = ({ connection, object, onPreview, onPermissions }) => {
  const [expiry, setExpiry] = useState(PRESIGN_DEFAULT_SECS);
  const [presignUrl, setPresignUrl] = useState<string | null>(null);
  const [presignLoading, setPresignLoading] = useState(false);
  const [presignError, setPresignError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset the generated URL + error when the selected object changes.
  React.useEffect(() => {
    setPresignUrl(null);
    setPresignError(null);
    setCopied(false);
  }, [object?.key]);

  if (!object) {
    return (
      <div className="shrink-0 border-t border-[#1e293b] px-3 py-2 text-[11px] text-slate-600 italic bg-[#0a0f18]">
        Select an object to see its details and generate a share link.
      </div>
    );
  }

  const handleGenerate = async () => {
    setPresignLoading(true);
    setPresignError(null);
    setPresignUrl(null);
    try {
      const decrypted = await withDecryptedSecret(connection);
      const url = await safeInvoke<string>('s3_presign_get', {
        config: decrypted,
        key: object.key,
        expiresSecs: expiry,
      });
      setPresignUrl(url);
    } catch (err: unknown) {
      setPresignError(toStorageError(err).message);
    } finally {
      setPresignLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!presignUrl) return;
    const ok = await copyToClipboard(presignUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="shrink-0 border-t border-[#1e293b] bg-[#0a0f18] px-3 py-2 flex flex-col gap-2">
      {/* Object metadata row */}
      <div className="flex items-center gap-3 text-[11px]">
        <FileTypeIcon name={object.name} className="w-3.5 h-3.5" />
        <span className="text-slate-200 truncate font-medium flex-1 min-w-0" title={object.key}>
          {object.name}
        </span>
        {onPreview && (
          <button
            onClick={() => onPreview(object.key)}
            className="shrink-0 h-6 px-2 rounded text-[11px] font-medium text-blue-300 bg-blue-600/15 border border-blue-600/30 hover:bg-blue-600/25 flex items-center gap-1"
            title="Preview / edit this file"
          >
            <Eye className="w-3 h-3" /> Preview
          </button>
        )}
        {onPermissions && (
          <button
            onClick={() => onPermissions(object.key)}
            className="shrink-0 h-6 px-2 rounded text-[11px] font-medium text-amber-300 bg-amber-600/15 border border-amber-600/30 hover:bg-amber-600/25 flex items-center gap-1"
            title="Object permissions (ACL)"
          >
            <Shield className="w-3 h-3" /> Permissions
          </button>
        )}
        <span className="text-slate-500 shrink-0">{formatBytes(object.size)}</span>
        <span className="text-slate-600 shrink-0">{formatDateTime(object.lastModified)}</span>
        {object.etag && (
          <span className="text-slate-600 shrink-0 font-mono hidden md:inline" title={`ETag: ${object.etag}`}>
            {object.etag.slice(0, 10)}
            {object.etag.length > 10 ? '…' : ''}
          </span>
        )}
      </div>

      {/* Presign row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link2 className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <span className="text-[11px] text-slate-400 shrink-0">Share link expires in</span>
        <select
          value={expiry}
          onChange={(e) => setExpiry(Number(e.target.value))}
          className="h-6 bg-[#0f172a] border border-[#1e293b] rounded text-[11px] text-slate-200 px-1 focus:outline-none focus:border-amber-500"
        >
          {PRESIGN_EXPIRY_OPTIONS.map((o) => (
            <option key={o.secs} value={o.secs}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={presignLoading}
          className="h-6 px-2 rounded text-[11px] font-medium text-amber-300 bg-amber-600/15 border border-amber-600/30 hover:bg-amber-600/25 disabled:opacity-50 flex items-center gap-1"
          title="Generate a presigned download URL"
        >
          {presignLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
          Generate Link
        </button>

        {presignUrl && (
          <>
            <input
              readOnly
              value={presignUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 h-6 bg-[#06090e] border border-[#1e293b] rounded text-[11px] text-slate-300 px-1.5 font-mono truncate focus:outline-none"
              title={presignUrl}
            />
            <button
              onClick={handleCopy}
              className="h-6 px-2 rounded text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1 shrink-0"
              title="Copy URL to clipboard"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={presignUrl}
              target="_blank"
              rel="noreferrer"
              className="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-amber-400 hover:bg-[#141e33] shrink-0"
              title="Open in browser"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          </>
        )}
      </div>

      {/* Presign error */}
      {presignError && <CopyableErrorBanner message={presignError} tone="amber" compact />}

      {/* Warning when a URL is active */}
      {presignUrl && (
        <div className="flex items-center gap-1.5 text-[10px] text-amber-500/80">
          <ShieldAlert className="w-3 h-3 shrink-0" />
          <span>
            Anyone with this link can download the object until it expires ({formatExpiry(expiry)}).
            The URL embeds a temporary signature — do not share it publicly beyond the intended recipient.
          </span>
        </div>
      )}
    </div>
  );
};
