import React from 'react';
import {
  File as FileIcon,
  FileImage,
  FileText,
  FileCode,
  FileArchive,
  FileAudio,
  FileVideo,
  FileSpreadsheet,
  FileJson,
  FileType,
  FileCog,
  FileLock,
} from 'lucide-react';

/**
 * File-type icon picker — chooses a lucide icon + accent color from the
 * object's name/extension (and content-type when available), mirroring how
 * Finder/VS Code distinguish file kinds at a glance.
 *
 * Falls back to a plain file icon for unknown types.
 *
 * Usage: `<FileTypeIcon name="photo.jpg" className="w-3.5 h-3.5" />`
 */

type IconCmp = React.ComponentType<{ className?: string }>;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'];
const VIDEO_EXT = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg'];
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'aiff', 'opus'];
const ARCHIVE_EXT = ['zip', 'gz', 'tar', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'lz4'];
const CODE_EXT = [
  'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cc', 'cpp', 'h', 'hpp',
  'php', 'sh', 'bash', 'zsh', 'kt', 'swift', 'scala', 'clj', 'lua', 'r', 'vim',
  'graphql', 'gql',
];
const WEB_EXT = ['html', 'htm', 'css', 'scss', 'sass', 'less'];
const SPREADSHEET_EXT = ['csv', 'tsv', 'xls', 'xlsx', 'ods'];
const TEXT_EXT = ['txt', 'md', 'markdown', 'log', 'rtf', 'ini', 'toml', 'env', 'conf'];
const DOC_EXT = ['doc', 'docx', 'odt', 'pages'];
const LOCK_EXT = ['pem', 'key', 'crt', 'p12', 'pfx', 'asc', 'gpg'];

interface KindMatch {
  Icon: IconCmp;
  color: string;
}

/** Resolve the icon + color for a file. contentType wins when it's specific. */
function matchKind(name: string, contentType?: string): KindMatch {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  // Content-type is authoritative when present and specific (not generic octet/text).
  if (contentType) {
    if (contentType.startsWith('image/')) return { Icon: FileImage, color: 'text-violet-400' };
    if (contentType.startsWith('video/')) return { Icon: FileVideo, color: 'text-pink-400' };
    if (contentType.startsWith('audio/')) return { Icon: FileAudio, color: 'text-fuchsia-400' };
    if (contentType === 'application/pdf') return { Icon: FileType, color: 'text-red-400' };
    if (contentType === 'application/json' || contentType.includes('json')) return { Icon: FileJson, color: 'text-amber-400' };
    if (contentType.includes('xml') || contentType.includes('yaml')) return { Icon: FileCode, color: 'text-blue-400' };
    if (contentType.includes('gzip') || contentType.includes('zip') || contentType.includes('compressed')) {
      return { Icon: FileArchive, color: 'text-orange-400' };
    }
    if (contentType.includes('spreadsheet') || contentType.includes('csv')) return { Icon: FileSpreadsheet, color: 'text-emerald-400' };
  }
  if (IMAGE_EXT.includes(ext)) return { Icon: FileImage, color: 'text-violet-400' };
  if (VIDEO_EXT.includes(ext)) return { Icon: FileVideo, color: 'text-pink-400' };
  if (AUDIO_EXT.includes(ext)) return { Icon: FileAudio, color: 'text-fuchsia-400' };
  if (ext === 'pdf') return { Icon: FileType, color: 'text-red-400' };
  if (ext === 'json') return { Icon: FileJson, color: 'text-amber-400' };
  if (ext === 'sql') return { Icon: FileCode, color: 'text-cyan-400' };
  if (ext === 'xml' || ext === 'yaml' || ext === 'yml') return { Icon: FileCode, color: 'text-blue-400' };
  if (ARCHIVE_EXT.includes(ext)) return { Icon: FileArchive, color: 'text-orange-400' };
  if (SPREADSHEET_EXT.includes(ext)) return { Icon: FileSpreadsheet, color: 'text-emerald-400' };
  if ([...CODE_EXT, ...WEB_EXT].includes(ext)) return { Icon: FileCode, color: 'text-blue-400' };
  if (DOC_EXT.includes(ext)) return { Icon: FileText, color: 'text-sky-400' };
  if (LOCK_EXT.includes(ext)) return { Icon: FileLock, color: 'text-yellow-400' };
  if (TEXT_EXT.includes(ext)) return { Icon: FileText, color: 'text-slate-400' };
  // Metadata sidecars (rdsql-managed backups).
  if (name.endsWith('.meta.json')) return { Icon: FileCog, color: 'text-slate-500' };
  return { Icon: FileIcon, color: 'text-slate-500' };
}

export const FileTypeIcon: React.FC<{
  /** Object key/name — used to detect the extension. */
  name: string;
  /** Optional content-type from HEAD; wins over extension when specific. */
  contentType?: string;
  className?: string;
}> = ({ name, contentType, className }) => {
  const { Icon, color } = matchKind(name, contentType);
  return <Icon className={`${className ?? ''} ${color} shrink-0`} />;
};
