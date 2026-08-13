import React, { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Loader2,
  Save,
  Pencil,
  Eye,
  Download,
  AlertTriangle,
  FileX2,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { writeTextFile, remove } from '@tauri-apps/plugin-fs';
import { withDecryptedSecret } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import { getTransferManager } from '../../core/storage/react';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { formatBytes } from './format';
import type { S3ConnectionConfig, StorageObject } from '../../core/storage/domain/types';

/** Result of `s3_get_object_bytes`. */
interface ObjectBytes {
  contentBase64: string;
  contentType?: string;
  size: number;
  truncated: boolean;
}

/** Coarse file kind, picked from extension + content-type. */
type FileKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'binary';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'weba'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'ogv', 'm4v', '3gp'];
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'log',
  'sql', 'js', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'scss', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'php',
  'sh', 'bash', 'zsh', 'ini', 'toml', 'env', 'gitignore', 'dockerfile',
  'graphql', 'gql', 'lua', 'r', 'kt', 'swift', 'scala', 'clj', 'vim',
];

/** Map a file extension to a Monaco language id. */
function monacoLanguage(ext: string): string {
  const map: Record<string, string> = {
    json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', js: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', sql: 'sql', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', java: 'java', c: 'c', cc: 'cpp', cpp: 'cpp', h: 'c',
    hpp: 'cpp', php: 'php', sh: 'shell', bash: 'shell', ini: 'ini', toml: 'ini',
    graphql: 'graphql', gql: 'graphql', md: 'markdown', markdown: 'markdown',
    csv: 'plaintext', tsv: 'plaintext', log: 'plaintext', txt: 'plaintext',
  };
  return map[ext] ?? 'plaintext';
}

function detectKind(name: string, contentType?: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType === 'application/pdf') return 'pdf';
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('yaml')) return 'text';
  }
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.includes(ext)) return 'text';
  return 'binary';
}

interface Props {
  connection: S3ConnectionConfig;
  object: StorageObject;
  /** Max bytes to fetch for preview (from settings). */
  maxBytes: number;
  /** Notifies the parent when the user closes the preview. */
  onClose: () => void;
}

/**
 * In-app file preview/edit pane for an S3 object. Images render natively, PDFs
 * via an iframe blob URL, and text/code/JSON via Monaco (read-only by default,
 * editable with a Save button that re-uploads). The fetch is lazy — it fires
 * on mount, not on object selection in the parent.
 */
export const StorageFileViewer: React.FC<Props> = ({ connection, object, maxBytes, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ObjectBytes | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const kind = useMemo(
    () => detectKind(object.name, bytes?.contentType),
    [object.name, bytes?.contentType],
  );
  const ext = object.name.split('.').pop()?.toLowerCase() ?? '';

  // Lazy fetch on mount / when the target object changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBytes(null);
    setEditing(false);
    (async () => {
      try {
        const decrypted = await withDecryptedSecret(connection);
        const res = await safeInvoke<ObjectBytes>('s3_get_object_bytes', {
          config: decrypted,
          key: object.key,
          maxBytes,
        });
        if (cancelled) return;
        setBytes(res);
      } catch (err: unknown) {
        if (!cancelled) setError(toStorageError(err).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, object.key, maxBytes]);

  // Decode the text content for Monaco when kind === text.
  const textContent = useMemo(() => {
    if (!bytes || kind !== 'text') return '';
    try {
      const bin = atob(bytes.contentBase64);
      // Decode as UTF-8.
      const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: false }).decode(u8);
    } catch {
      return '';
    }
  }, [bytes, kind]);

  // Object URL for image/pdf/audio/video rendering.
  const objectUrl = useMemo(() => {
    if (!bytes || !['image', 'pdf', 'audio', 'video'].includes(kind)) return null;
    try {
      const bin = atob(bytes.contentBase64);
      const u8 = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const mime = bytes.contentType ?? (
        kind === 'pdf' ? 'application/pdf' :
        kind === 'audio' ? 'audio/mpeg' :
        kind === 'video' ? 'video/mp4' : 'image/*'
      );
      return URL.createObjectURL(new Blob([u8], { type: mime }));
    } catch {
      return null;
    }
  }, [bytes, kind]);

  useEffect(() => {
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [objectUrl]);

  // Seed the editor draft when entering edit mode (or when content arrives).
  useEffect(() => {
    if (kind === 'text' && !editing && textContent) setDraft(textContent);
  }, [textContent, kind, editing]);

  const handleSave = async () => {
    if (!connection) return;
    setSaving(true);
    setSaveError(null);
    const tmpPath = `/tmp/rdsql_edit_${Date.now()}_${object.name}`;
    try {
      await writeTextFile(tmpPath, draft);
      const decrypted = await withDecryptedSecret(connection);
      await safeInvoke('s3_upload_object', {
        config: decrypted,
        key: object.key,
        localPath: tmpPath,
        transferId: `edit_save_${Date.now()}`,
      });
      setEditing(false);
    } catch (err: any) {
      setSaveError(err?.message || String(err));
    } finally {
      await remove(tmpPath).catch(() => {});
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-[#06090e]">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-[#1e293b] bg-[#0a0f18]">
        <span className="text-xs text-slate-200 truncate flex-1 font-medium" title={object.key}>
          {object.name}
        </span>
        <span className="text-[10px] text-slate-600 shrink-0">
          {bytes ? formatBytes(bytes.size) : '…'}
        </span>
        {kind === 'text' && !editing && bytes && !bytes.truncated && (
          <button
            onClick={() => { setDraft(textContent); setEditing(true); }}
            className="px-2 h-6 rounded text-[11px] font-medium text-blue-300 bg-blue-600/15 border border-blue-600/30 hover:bg-blue-600/25 flex items-center gap-1"
            title="Edit this file and save back to S3"
          >
            <Pencil className="w-3 h-3" /> Edit
          </button>
        )}
        {editing && (
          <>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-2 h-6 rounded text-[11px] font-medium text-emerald-300 bg-emerald-600/15 border border-emerald-600/30 hover:bg-emerald-600/25 flex items-center gap-1 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </button>
            <button
              onClick={() => { setEditing(false); setSaveError(null); }}
              className="px-2 h-6 rounded text-[11px] font-medium text-slate-300 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1"
            >
              <Eye className="w-3 h-3" /> View
            </button>
          </>
        )}
        <button
          onClick={onClose}
          className="px-2 h-6 rounded text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:bg-[#141e33]"
        >
          ✕
        </button>
      </div>

      {/* Save error */}
      {saveError && (
        <div className="shrink-0 p-2">
          <CopyableErrorBanner message={saveError} tone="red" compact />
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-slate-500 text-xs">
            <Loader2 className="w-4 h-4 animate-spin" /> Fetching {object.name}…
          </div>
        ) : error ? (
          <div className="p-3">
            <CopyableErrorBanner message={error} tone="red" />
          </div>
        ) : bytes?.truncated && kind !== 'image' && kind !== 'audio' && kind !== 'video' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-6">
            <AlertTriangle className="w-8 h-8 text-amber-400" />
            <div className="text-sm text-slate-300">This file is too large to preview</div>
            <div className="text-[11px] text-slate-500 max-w-sm">
              {formatBytes(bytes.size)} exceeds the {formatBytes(maxBytes)} preview limit. Download it to view locally.
            </div>
            <DownloadToFolderButton connection={connection} object={object} />
          </div>
        ) : kind === 'audio' ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/20 border border-purple-500/20 flex items-center justify-center">
              <svg className="w-10 h-10 text-purple-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            </div>
            <div className="text-sm text-slate-300 font-medium truncate max-w-xs">{object.name}</div>
            {objectUrl ? (
              <audio
                controls
                src={objectUrl}
                className="w-full max-w-sm rounded-xl"
                style={{ colorScheme: 'dark' }}
              />
            ) : (
              <span className="text-slate-500 text-xs">Could not decode audio.</span>
            )}
          </div>
        ) : kind === 'video' ? (
          <div className="flex items-center justify-center h-full p-4 bg-black">
            {objectUrl ? (
              <video
                controls
                src={objectUrl}
                className="max-w-full max-h-full rounded-lg shadow-2xl"
                style={{ colorScheme: 'dark' }}
              />
            ) : (
              <span className="text-slate-500 text-xs">Could not decode video.</span>
            )}
          </div>
        ) : kind === 'binary' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-6">
            <FileX2 className="w-8 h-8 text-slate-600" />
            <div className="text-sm text-slate-400">No inline preview for this file type</div>
            <div className="text-[11px] text-slate-600">{bytes?.contentType || ext || 'binary'}</div>
            <DownloadToFolderButton connection={connection} object={object} />
          </div>
        ) : kind === 'image' ? (
          <div className="flex items-center justify-center h-full p-4 overflow-auto bg-[#06090e]">
            {objectUrl ? (
              <img src={objectUrl} alt={object.name} className="max-w-full max-h-full object-contain rounded shadow-lg" />
            ) : (
              <span className="text-slate-500 text-xs">Could not decode image.</span>
            )}
          </div>
        ) : kind === 'pdf' ? (
          <div className="h-full w-full bg-[#06090e]">
            {objectUrl ? (
              <iframe src={objectUrl} title={object.name} className="w-full h-full border-0" />
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-6">
                <span className="text-slate-500 text-xs">Could not render PDF.</span>
                <DownloadToFolderButton connection={connection} object={object} />
              </div>
            )}
          </div>
        ) : (
          // text / code / json — Monaco
          <Editor
            height="100%"
            defaultLanguage={monacoLanguage(ext)}
            theme="vs-dark"
            value={editing ? draft : textContent}
            onChange={(val) => editing && setDraft(val ?? '')}
            options={{
              readOnly: !editing,
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
    </div>
  );
};

/** Small "download to view locally" fallback button. */
const DownloadToFolderButton: React.FC<{ connection: S3ConnectionConfig; object: StorageObject }> = ({
  connection, object,
}) => (
  <button
    onClick={async () => {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const localPath = await save({ defaultPath: object.name });
      if (!localPath) return;
      const decrypted = await withDecryptedSecret(connection);
      getTransferManager().start({
        direction: 'download',
        connectionId: connection.id,
        config: decrypted,
        key: object.key,
        localPath,
      });
    }}
    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] flex items-center gap-1.5"
  >
    <Download className="w-3.5 h-3.5" /> Download
  </button>
);
