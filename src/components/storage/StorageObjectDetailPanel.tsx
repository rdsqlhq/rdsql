import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Download,
  Link2,
  MoreHorizontal,
  Eye,
  Shield,
  Trash2,
  Loader2,
  Check,
  ExternalLink,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import { providerSupportsAcl } from '../../core/storage/domain/acl';
import type { AclDto } from '../../core/storage/domain/acl';
import { PRESIGN_DEFAULT_SECS } from '../../core/storage/domain/presign';
import { copyToClipboard } from '../../core/utils/clipboard';
import { formatBytes, formatDateTime, guessContentType } from './format';
import { FileTypeIcon } from './FileTypeIcon';
import type { S3ConnectionConfig, StorageObject, ObjectMetadata } from '../../core/storage/domain/types';

type DetailTab = 'details' | 'metadata';

interface Props {
  connection: S3ConnectionConfig;
  object: StorageObject;
  onClose: () => void;
  onDownload: (obj: StorageObject) => void;
  onDelete: (obj: StorageObject) => void;
  onPreview: (key: string) => void;
  onOpenAcl: (key: string) => void;
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
function isImage(name: string, contentType?: string): boolean {
  if (contentType) return contentType.startsWith('image/');
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT.includes(ext);
}

/** Result of `s3_get_object_bytes`, mirrors StorageFileViewer's local type. */
interface ObjectBytes {
  contentBase64: string;
  contentType?: string;
  size: number;
  truncated: boolean;
}

const IMAGE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — keep the thumbnail fetch cheap.

/**
 * Docked right-side panel showing a single S3 object's preview + metadata —
 * styled after the marketing S3 screenshot. Mirrors the ERD tab's
 * `TableDetailDrawer`: no fixed/overlay positioning, fills whatever column
 * `StorageBrowser` gives it.
 */
export const StorageObjectDetailPanel: React.FC<Props> = ({
  connection,
  object,
  onClose,
  onDownload,
  onDelete,
  onPreview,
  onOpenAcl,
}) => {
  const [tab, setTab] = useState<DetailTab>('details');
  const [moreOpen, setMoreOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Authoritative metadata via HEAD (list results never carry content-type —
  // S3's ListObjectsV2 doesn't return it). Cheap here since it's only fired
  // for the single selected object, not per row.
  const [head, setHead] = useState<ObjectMetadata | null>(null);
  const [headLoading, setHeadLoading] = useState(false);

  // Best-effort ACL summary (public-read vs private) — only fetched for
  // providers that implement GetObjectAcl.
  const [aclSummary, setAclSummary] = useState<'public' | 'private' | null>(null);

  // Presigned URL for the Details tab + "Copy URL" action.
  const [presignedUrl, setPresignedUrl] = useState<string | null>(null);
  const [presignLoading, setPresignLoading] = useState(false);

  // Inline thumbnail for image objects (lazy, size-capped).
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [thumbError, setThumbError] = useState(false);

  const aclSupported = providerSupportsAcl(connection.preset);
  const contentType = head?.contentType || object.contentType || guessContentType(object.name);
  const showImage = isImage(object.name, contentType);

  useEffect(() => {
    setTab('details');
    setMoreOpen(false);
    setHead(null);
    setAclSummary(null);
    setPresignedUrl(null);
    setThumbUrl(null);
    setThumbError(false);
  }, [object.key]);

  // HEAD for authoritative type/etag/size/last-modified.
  useEffect(() => {
    let cancelled = false;
    setHeadLoading(true);
    (async () => {
      try {
        const decrypted = await withDecryptedSecret(connection);
        const res = await safeInvoke<ObjectMetadata | null>('s3_head_object', { config: decrypted, key: object.key });
        if (!cancelled) setHead(res);
      } catch {
        // Non-fatal — the panel falls back to list-derived fields + a
        // guessed content type.
      } finally {
        if (!cancelled) setHeadLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, object.key]);

  // Best-effort ACL summary.
  useEffect(() => {
    if (!aclSupported) return;
    let cancelled = false;
    (async () => {
      try {
        const decrypted = await withDecryptedSecret(connection);
        const acl = await safeInvoke<AclDto>('s3_get_object_acl', { config: decrypted, key: object.key });
        if (cancelled) return;
        const isPublic = acl.grants.some((g) => g.grantee.uri?.endsWith('AllUsers') && g.permission.toUpperCase().includes('READ'));
        setAclSummary(isPublic ? 'public' : 'private');
      } catch {
        setAclSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, object.key, aclSupported]);

  // Presigned URL (default expiry) — used for the Details tab's URL row and
  // the "Copy URL" action.
  useEffect(() => {
    let cancelled = false;
    setPresignLoading(true);
    (async () => {
      try {
        const decrypted = await withDecryptedSecret(connection);
        const url = await safeInvoke<string>('s3_presign_get', { config: decrypted, key: object.key, expiresSecs: PRESIGN_DEFAULT_SECS });
        if (!cancelled) setPresignedUrl(url);
      } catch {
        if (!cancelled) setPresignedUrl(null);
      } finally {
        if (!cancelled) setPresignLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, object.key]);

  // Image thumbnail — lazy fetch, capped at IMAGE_PREVIEW_MAX_BYTES.
  useEffect(() => {
    if (!showImage || object.size > IMAGE_PREVIEW_MAX_BYTES) return;
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const decrypted = await withDecryptedSecret(connection);
        const res = await safeInvoke<ObjectBytes>('s3_get_object_bytes', {
          config: decrypted,
          key: object.key,
          maxBytes: IMAGE_PREVIEW_MAX_BYTES,
        });
        if (cancelled) return;
        const bin = atob(res.contentBase64);
        const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([u8], { type: res.contentType || contentType }));
        setThumbUrl(url);
      } catch {
        if (!cancelled) setThumbError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, object.key, showImage, object.size]);

  const handleCopyUrl = async () => {
    if (!presignedUrl) return;
    const ok = await copyToClipboard(presignedUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const etag = useMemo(() => (head?.etag || object.etag || '').replace(/^"|"$/g, ''), [head, object.etag]);

  return (
    <div className="h-full w-full bg-[#0a0f18] border-l border-[#1e293b] flex flex-col">
      {/* Header */}
      <div className="px-4 pt-3.5 pb-2.5 shrink-0 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-bold text-slate-100 truncate" title={object.name}>{object.name}</div>
          <div className="text-[10.5px] text-slate-500 font-mono truncate">
            {contentType} · {formatBytes(head?.size ?? object.size)}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors shrink-0"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Preview */}
      <div className="px-4 pb-3 shrink-0">
        <div className="w-full aspect-square rounded-lg bg-[#0f172a] border border-[#1e293b] flex items-center justify-center overflow-hidden">
          {showImage && thumbUrl ? (
            <img src={thumbUrl} alt={object.name} className="w-full h-full object-cover" />
          ) : showImage && !thumbError && object.size <= IMAGE_PREVIEW_MAX_BYTES ? (
            <Loader2 className="w-5 h-5 text-slate-600 animate-spin" />
          ) : (
            <FileTypeIcon name={object.name} contentType={contentType} className="w-10 h-10" />
          )}
        </div>

        {/* Action row */}
        <div className="flex items-center gap-1.5 mt-3">
          <button
            onClick={() => onDownload(object)}
            className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center justify-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </button>
          <button
            onClick={handleCopyUrl}
            disabled={!presignedUrl}
            className="flex-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center justify-center gap-1.5 disabled:opacity-40"
          >
            {presignLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Link2 className="w-3.5 h-3.5" />}
            Copy URL
          </button>
          <div className="relative">
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={`px-2 py-1.5 rounded-lg text-[11.5px] font-medium flex items-center gap-1 transition-colors ${
                moreOpen ? 'bg-[#1c2a45] text-slate-100' : 'text-slate-200 bg-[#141e33] hover:bg-[#1c2a45]'
              }`}
              title="More actions"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {moreOpen && (
              <>
                <div className="fixed inset-0 z-[90]" onClick={() => setMoreOpen(false)} />
                <div className="absolute right-0 top-8 z-[91] w-44 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5">
                  <button
                    onClick={() => { setMoreOpen(false); onPreview(object.key); }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-200 hover:bg-[#141e33]"
                  >
                    <Eye className="w-3.5 h-3.5 text-blue-400 shrink-0" /> Preview / Edit
                  </button>
                  {aclSupported && (
                    <button
                      onClick={() => { setMoreOpen(false); onOpenAcl(object.key); }}
                      className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-200 hover:bg-[#141e33]"
                    >
                      <Shield className="w-3.5 h-3.5 text-amber-400 shrink-0" /> Permissions (ACL)
                    </button>
                  )}
                  <div className="h-px bg-[#1e293b] my-1" />
                  <button
                    onClick={() => { setMoreOpen(false); onDelete(object); }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-red-400 hover:bg-[#141e33]"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" /> Delete
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-3.5 px-4 border-b border-[#1e293b] shrink-0">
        {(['details', 'metadata'] as DetailTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`py-2 text-[12.5px] font-medium border-b-2 -mb-px capitalize transition-colors ${
              tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3.5">
        {tab === 'details' ? (
          <div>
            <MetaRow label="Key" value={object.key} mono />
            <MetaRow label="Size" value={`${formatBytes(head?.size ?? object.size)}${headLoading ? '' : ` (${(head?.size ?? object.size).toLocaleString('en-US')} bytes)`}`} />
            <MetaRow label="Type" value={contentType} mono />
            <MetaRow label="Last Modified" value={formatDateTime(head?.lastModified ?? object.lastModified)} />
            {etag && <MetaRow label="ETag" value={`"${etag}"`} mono />}
            {aclSupported && (
              <MetaRow
                label="ACL"
                value={aclSummary === null ? '…' : aclSummary === 'public' ? 'public-read' : 'private'}
                valueClassName={aclSummary === 'public' ? 'text-emerald-400' : undefined}
              />
            )}
            {presignedUrl && (
              <div className="pt-1.5 mt-1.5 border-t border-[#1e293b]">
                <div className="text-[11.5px] text-slate-500 mb-1">URL</div>
                <a
                  href={presignedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-mono text-blue-400 hover:text-blue-300 break-all flex items-start gap-1"
                >
                  <span className="flex-1 break-all">{presignedUrl}</span>
                  <ExternalLink className="w-3 h-3 shrink-0 mt-0.5" />
                </a>
              </div>
            )}
          </div>
        ) : (
          <div>
            <MetaRow label="Content-Type" value={contentType} mono />
            <MetaRow label="Content-Length" value={`${(head?.size ?? object.size).toLocaleString('en-US')} bytes`} mono />
            {etag && <MetaRow label="ETag" value={`"${etag}"`} mono />}
            <MetaRow label="Last-Modified" value={formatDateTime(head?.lastModified ?? object.lastModified)} mono />
            {object.isMetadata && <MetaRow label="Kind" value="rdSQL backup sidecar (.meta.json)" />}
          </div>
        )}
      </div>
    </div>
  );
};

function MetaRow({ label, value, mono, valueClassName }: { label: string; value: React.ReactNode; mono?: boolean; valueClassName?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-[11.5px] text-slate-500 shrink-0">{label}</span>
      <span className={`text-[11.5px] text-right break-all ${mono ? 'font-mono' : ''} ${valueClassName ?? 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  );
}
