import React, { useState, useRef, useEffect } from 'react';
import {
  Shield,
  Lock,
  Unlock,
  Download,
  Upload,
  CheckCircle2,
  Eye,
  EyeOff,
  X,
  Check,
  FileCode,
  Cloud,
  Database as DatabaseIcon,
} from 'lucide-react';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { DatabaseConnection } from '../../core/domain/types';
import type { S3ConnectionConfig } from '../../core/storage/domain/types';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useStorageStore } from '../../store/useStorageStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { EngineIcon } from '../common/EngineIcon';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import {
  encryptConnections,
  decryptPackage,
  isPasswordlessPackage,
  EncryptedPackage,
  DecryptedConnections,
} from '../../core/crypto/encryptedConnections';
import { encryptSecret } from '../../core/storage/secrets';
import { describeFsError } from '../../core/utils/fsErrors';

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface EncryptedConnectionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode?: 'export' | 'import';
  singleConnectionExport?: DatabaseConnection | null;
  /** A pre-resolved file path (e.g. from double-clicking a .rdsql file in the
   *  OS) to auto-load when the modal opens in import mode. Consumed once. */
  initialImportPath?: string;
}

export const EncryptedConnectionsModal: React.FC<EncryptedConnectionsModalProps> = ({
  isOpen,
  onClose,
  initialMode = 'export',
  singleConnectionExport = null,
  initialImportPath,
}) => {
  const { connections, saveConnection } = useConnectionStore();
  const storageConnections = useStorageStore((s) => s.connections);
  const saveStorageConnection = useStorageStore((s) => s.saveConnection);
  const [mode, setMode] = useState<'export' | 'import'>(initialMode);
  useEscapeToClose(isOpen ? onClose : null);

  // --- Export State ---
  const [selectedConnIds, setSelectedConnIds] = useState<Set<string>>(
    new Set(singleConnectionExport ? [singleConnectionExport.id] : connections.map((c) => c.id))
  );
  const [selectedStorageIds, setSelectedStorageIds] = useState<Set<string>>(
    new Set(storageConnections.map((c) => c.id))
  );
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [showExportPassphrase, setShowExportPassphrase] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // --- Import State ---
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importRawText, setImportRawText] = useState<string | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [showImportPassphrase, setShowImportPassphrase] = useState(false);
  const [decrypted, setDecrypted] = useState<DecryptedConnections | null>(null);
  const [importConflictStrategy, setImportConflictStrategy] = useState<'overwrite' | 'skip' | 'new_id'>('overwrite');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  /** True when the selected file was exported without a user password — the
   *  file is still encrypted (embedded key), so we skip the password prompt
   *  and decrypt immediately. */
  const [fileIsPasswordless, setFileIsPasswordless] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Toggle selection for export — DB connections
  const toggleSelectConn = (id: string) => {
    setSelectedConnIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Toggle selection for export — S3 connections
  const toggleSelectStorage = (id: string) => {
    setSelectedStorageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllConns = () => setSelectedConnIds(new Set(connections.map((c) => c.id)));
  const deselectAllConns = () => setSelectedConnIds(new Set());
  const selectAllStorage = () => setSelectedStorageIds(new Set(storageConnections.map((c) => c.id)));
  const deselectAllStorage = () => setSelectedStorageIds(new Set());

  // Password strength checker
  const getPasswordStrength = (pass: string) => {
    if (!pass) return { label: '', color: '' };
    if (pass.length < 6) return { label: 'Weak', color: 'text-rose-400 bg-rose-500/20' };
    if (pass.length < 10) return { label: 'Medium', color: 'text-amber-400 bg-amber-500/20' };
    return { label: 'Strong', color: 'text-emerald-400 bg-emerald-500/20' };
  };

  // Handle Encrypted Export
  const handleExport = async () => {
    setExportError(null);
    setExportSuccess(null);

    if (selectedConnIds.size === 0 && selectedStorageIds.size === 0) {
      setExportError('Please select at least one connection to export.');
      return;
    }

    // Password is OPTIONAL. If provided, the two fields must match. If left
    // blank, the file is still encrypted — a random key is embedded in it so
    // importing never asks for a password.
    const hasPassword = exportPassphrase.trim().length > 0;
    if (hasPassword && exportPassphrase !== confirmPassphrase) {
      setExportError('Passwords do not match.');
      return;
    }

    setExporting(true);
    try {
      const targetConns = connections.filter((c) => selectedConnIds.has(c.id));
      const targetStorage = storageConnections.filter((c) => selectedStorageIds.has(c.id));
      const encryptedPkg = await encryptConnections(
        targetConns,
        hasPassword ? exportPassphrase : undefined,
        targetStorage,
      );

      const jsonString = JSON.stringify(encryptedPkg, null, 2);
      const totalSelected = targetConns.length + targetStorage.length;
      const defaultName = `rdsql_connections_${Date.now()}.rdsql`;

      // Use Tauri's native save dialog when available; fall back to browser
      // download in non-Tauri (browser preview) environments.
      if (isTauri()) {
        const path = await save({
          defaultPath: defaultName,
          filters: [{ name: 'rdSQL Connections', extensions: ['rdsql'] }],
        });
        if (!path) {
          setExporting(false);
          return; // user cancelled
        }
        try {
          await writeTextFile(path, jsonString);
        } catch (fsErr: any) {
          // Permission denied, disk full, path vanished, etc. — surface a
          // friendly reason but keep the raw detail so it can be copied.
          setExportError(describeFsError(fsErr, 'write'));
          return;
        }
      } else {
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      const parts: string[] = [];
      if (targetConns.length) parts.push(`${targetConns.length} database`);
      if (targetStorage.length) parts.push(`${targetStorage.length} storage`);
      setExportSuccess(
        `Successfully exported ${totalSelected} connection profile(s) (${parts.join(' + ')}).`
      );
    } catch (err: any) {
      setExportError(err.message || 'Failed to export connections.');
    } finally {
      setExporting(false);
    }
  };

  // Shared loader: given a file path, read its contents, populate the import
  // state, and — if the file is a passwordless package — decrypt it right away.
  // Returns false on read error so the caller can bail (e.g. skip the prompt).
  const loadFromPath = async (path: string): Promise<boolean> => {
    let content: string;
    try {
      content = await readTextFile(path);
    } catch (readErr: any) {
      // Permission denied, file moved/deleted, wrong encoding, etc.
      setImportError(describeFsError(readErr, 'read'));
      return false;
    }
    // Store a lightweight pseudo-file so the existing UI (name/size display) works.
    const fileName = path.split(/[\\/]/).pop() || 'selected file';
    setImportFile({ name: fileName, size: content.length } as File);
    setImportRawText(content);

    // If the file is passwordless, decrypt it right away — no prompt needed.
    try {
      const pkg: EncryptedPackage = JSON.parse(content);
      if (isPasswordlessPackage(pkg)) {
        setFileIsPasswordless(true);
        setDecrypting(true);
        try {
          const decoded = await decryptPackage(pkg, undefined);
          setDecrypted(decoded);
        } catch (err: any) {
          setImportError(
            String(err?.message || '') ||
              'Failed to load connections. The file may be corrupt.',
          );
          setDecrypted(null);
        } finally {
          setDecrypting(false);
        }
      }
    } catch {
      // Not JSON / not a valid package — leave it to handleDecryptFile to show
      // a proper error when the user clicks Load.
    }
    return true;
  };

  // Reset import state before populating it with a new file.
  const resetImportState = () => {
    setImportError(null);
    setDecrypted(null);
    setImportSuccess(null);
    setImportPassphrase('');
    setFileIsPasswordless(false);
  };

  // Handle File Selection for Import — uses Tauri's native open dialog + readTextFile,
  // with a browser <input type="file"> fallback for non-Tauri preview mode.
  const handleFileChange = async (e?: React.ChangeEvent<HTMLInputElement>) => {
    resetImportState();
    setImportFile(null);
    setImportRawText(null);

    // Tauri native path
    if (isTauri()) {
      let path: string | null = null;
      try {
        const picked = await open({
          multiple: false,
          filters: [{ name: 'rdSQL Connections', extensions: ['rdsql', 'json'] }],
        });
        if (!picked || typeof picked !== 'string') return;
        path = picked;
      } catch (dialogErr: any) {
        // Dialog errors are rare (e.g. plugin not available) but shouldn't crash.
        setImportError(describeFsError(dialogErr, 'read'));
        return;
      }
      await loadFromPath(path);
    } else {
      // Browser fallback
      const file = e?.target.files?.[0];
      if (!file) return;
      setImportFile(file);
      const content = await new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve((event.target?.result as string) ?? null);
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
      if (!content) {
        setImportError('Could not read the selected file.');
        return;
      }
      setImportRawText(content);
      // Mirror the Tauri path's passwordless auto-decrypt for parity.
      try {
        const pkg: EncryptedPackage = JSON.parse(content);
        if (isPasswordlessPackage(pkg)) {
          setFileIsPasswordless(true);
          setDecrypting(true);
          try {
            const decoded = await decryptPackage(pkg, undefined);
            setDecrypted(decoded);
          } catch (err: any) {
            setImportError(
              String(err?.message || '') ||
                'Failed to load connections. The file may be corrupt.',
            );
            setDecrypted(null);
          } finally {
            setDecrypting(false);
          }
        }
      } catch {
        // Not JSON / not a valid package — leave it to handleDecryptFile.
      }
    }
  };

  // Auto-load a pre-resolved file (e.g. from double-clicking a .rdsql file in
  // the OS) when the modal opens in import mode. Runs once per open.
  useEffect(() => {
    if (!isOpen || mode !== 'import' || !initialImportPath) return;
    if (!isTauri()) return;
    resetImportState();
    setImportFile(null);
    setImportRawText(null);
    void loadFromPath(initialImportPath);
    // Intentionally only fire on open/initialPath — we don't want to re-load
    // on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialImportPath]);

  if (!isOpen) return null;

  // Handle Decryption of imported file
  const handleDecryptFile = async () => {
    setImportError(null);
    setImportSuccess(null);

    if (!importRawText) {
      setImportError('Please select a connection file (.rdsql).');
      return;
    }

    if (!fileIsPasswordless && !importPassphrase) {
      setImportError('Enter password.');
      return;
    }

    setDecrypting(true);
    try {
      const pkg: EncryptedPackage = JSON.parse(importRawText);
      const decoded = await decryptPackage(
        pkg,
        fileIsPasswordless ? undefined : importPassphrase,
      );
      setDecrypted(decoded);
    } catch (err: any) {
      const msg = String(err?.message || '');
      // The crypto layer now reports a real wrong-password/corrupt-file as the
      // exact string below. Anything else is a format/shape problem — never
      // misreport those as "wrong password" (that was the original bug).
      const isCryptoFailure =
        msg.includes('Incorrect password or file integrity check failed.');
      if (isCryptoFailure) {
        setImportError('Wrong password, or the file is corrupt. Check the password and try again.');
      } else if (msg.includes('JSON') || msg.includes('valid')) {
        setImportError('This file is not a valid connection backup (unreadable format).');
      } else {
        setImportError(msg || 'Failed to load connections. Check password or file integrity.');
      }
      setDecrypted(null);
    } finally {
      setDecrypting(false);
    }
  };

  // Commit Import to both stores.
  const handleCommitImport = async () => {
    if (!decrypted) return;
    if (decrypted.databases.length === 0 && decrypted.storage.length === 0) return;

    let importedCount = 0;

    // --- Database connections ---
    for (const importedConn of decrypted.databases) {
      const existing = connections.find((c) => c.id === importedConn.id);
      if (existing && importConflictStrategy === 'skip') continue;
      if (existing && importConflictStrategy === 'new_id') {
        saveConnection({
          ...importedConn,
          id: `conn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: `${importedConn.name} (Imported)`,
        });
        importedCount++;
        continue;
      }
      saveConnection(importedConn);
      importedCount++;
    }

    // --- Storage connections ---
    // Secrets arrive as plaintext (decrypted from the envelope). Re-seal each
    // with the importing device's KEK so it persists safely.
    for (const importedStorage of decrypted.storage) {
      const existing = storageConnections.find((c) => c.id === importedStorage.id);
      if (existing && importConflictStrategy === 'skip') continue;
      let toSave: S3ConnectionConfig;
      if (existing && importConflictStrategy === 'new_id') {
        toSave = {
          ...importedStorage,
          id: `stor_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          name: `${importedStorage.name} (Imported)`,
        };
      } else {
        toSave = { ...importedStorage };
      }
      // Re-seal plaintext secret under the local KEK before persisting.
      try {
        toSave.secretAccessKey = await encryptSecret(toSave.secretAccessKey || '');
        if (toSave.sessionToken) {
          toSave.sessionToken = await encryptSecret(toSave.sessionToken);
        }
      } catch {
        // If re-seal fails (e.g. KEK unavailable), skip this connection rather
        // than persist a plaintext secret.
        continue;
      }
      saveStorageConnection(toSave);
      importedCount++;
    }

    setImportSuccess(`Successfully imported ${importedCount} connection profile(s)!`);
    setTimeout(() => {
      onClose();
    }, 1500);
  };

  const strength = getPasswordStrength(exportPassphrase);
  const hasAnyConnections = connections.length > 0 || storageConnections.length > 0;
  const decryptedTotal = decrypted
    ? decrypted.databases.length + decrypted.storage.length
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fadeIn">
      <div className="w-full max-w-xl bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden flex flex-col text-xs font-sans">
        {/* Header */}
        <div className="h-12 bg-[#0f172a] px-4 border-b border-[#1e293b] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-blue-400">
              <Shield className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-100 text-xs">Connections Manager</h3>
              <span className="text-[10px] text-slate-500">Password Protected Export & Import</span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="flex border-b border-[#1e293b] bg-[#070a12]">
          <button
            onClick={() => setMode('export')}
            className={`flex-1 py-2.5 font-semibold text-xs flex items-center justify-center gap-2 border-b-2 transition-all ${
              mode === 'export'
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export</span>
          </button>
          <button
            onClick={() => setMode('import')}
            className={`flex-1 py-2.5 font-semibold text-xs flex items-center justify-center gap-2 border-b-2 transition-all ${
              mode === 'import'
                ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import</span>
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 max-h-[75vh] overflow-y-auto space-y-4">
          {/* ============================================================ */}
          {/* EXPORT MODE */}
          {/* ============================================================ */}
          {mode === 'export' && (
            <div className="space-y-4">
              {/* Database Connections Multi-Select */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-slate-300 font-semibold text-xs flex items-center gap-1.5">
                    <DatabaseIcon className="w-3.5 h-3.5 text-blue-400" />
                    Databases ({selectedConnIds.size}/{connections.length}):
                  </label>
                  {connections.length > 0 && (
                    <div className="flex gap-2 text-[10px]">
                      <button onClick={selectAllConns} className="text-blue-400 hover:underline">All</button>
                      <span className="text-slate-600">•</span>
                      <button onClick={deselectAllConns} className="text-slate-500 hover:underline">None</button>
                    </div>
                  )}
                </div>

                <div className="max-h-36 overflow-y-auto border border-[#1e293b] rounded-xl bg-[#06090e] p-1.5 space-y-1 macos-scroll">
                  {connections.length === 0 ? (
                    <div className="text-slate-500 text-center py-4 text-xs">No database connections</div>
                  ) : (
                    connections.map((conn) => {
                      const isSelected = selectedConnIds.has(conn.id);
                      return (
                        <div
                          key={conn.id}
                          onClick={() => toggleSelectConn(conn.id)}
                          className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                            isSelected ? 'bg-blue-500/15 border border-blue-500/30' : 'hover:bg-white/5 border border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <EngineIcon engine={conn.engine} className="w-4 h-4 shrink-0" />
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-200 truncate">{conn.name}</div>
                              <div className="text-[10px] text-slate-500 font-mono truncate">
                                {conn.engine} • {conn.host || conn.cfAccountId || conn.filePath || 'local'}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                              isSelected ? 'bg-blue-600 border-blue-500 text-white' : 'border-slate-600 bg-[#0f172a]'
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3" />}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Storage Connections Multi-Select */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-slate-300 font-semibold text-xs flex items-center gap-1.5">
                    <Cloud className="w-3.5 h-3.5 text-amber-400" />
                    Storage ({selectedStorageIds.size}/{storageConnections.length}):
                  </label>
                  {storageConnections.length > 0 && (
                    <div className="flex gap-2 text-[10px]">
                      <button onClick={selectAllStorage} className="text-amber-400 hover:underline">All</button>
                      <span className="text-slate-600">•</span>
                      <button onClick={deselectAllStorage} className="text-slate-500 hover:underline">None</button>
                    </div>
                  )}
                </div>

                <div className="max-h-36 overflow-y-auto border border-[#1e293b] rounded-xl bg-[#06090e] p-1.5 space-y-1 macos-scroll">
                  {storageConnections.length === 0 ? (
                    <div className="text-slate-500 text-center py-4 text-xs">No storage connections</div>
                  ) : (
                    storageConnections.map((conn) => {
                      const isSelected = selectedStorageIds.has(conn.id);
                      return (
                        <div
                          key={conn.id}
                          onClick={() => toggleSelectStorage(conn.id)}
                          className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-colors ${
                            isSelected ? 'bg-amber-500/15 border border-amber-500/30' : 'hover:bg-white/5 border border-transparent'
                          }`}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Cloud className="w-4 h-4 shrink-0 text-amber-400" />
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-200 truncate">{conn.name}</div>
                              <div className="text-[10px] text-slate-500 font-mono truncate">
                                {conn.preset} • {conn.bucket}{conn.endpoint ? ` • ${conn.endpoint}` : ''}
                              </div>
                            </div>
                          </div>
                          <div
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                              isSelected ? 'bg-amber-600 border-amber-500 text-white' : 'border-slate-600 bg-[#0f172a]'
                            }`}
                          >
                            {isSelected && <Check className="w-3 h-3" />}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Encryption Password (optional) */}
              <div className="space-y-3 pt-2 border-t border-[#1e293b]">
                <div className="flex items-center justify-between">
                  <label className="text-slate-300 font-semibold text-xs flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-blue-400" />
                    Password <span className="text-slate-500 font-normal">(optional)</span>:
                  </label>
                  {strength.label && (
                    <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${strength.color}`}>
                      {strength.label}
                    </span>
                  )}
                </div>

                <p className="text-[10px] text-slate-500 leading-relaxed">
                  The file is always encrypted. Leave blank to skip the password — anyone with the
                  file can import it without one. Set a password to require it when importing.
                </p>

                <div className="relative">
                  <input
                    type={showExportPassphrase ? 'text' : 'password'}
                    placeholder="Set a password (leave blank for none)"
                    value={exportPassphrase}
                    onChange={(e) => setExportPassphrase(e.target.value)}
                    className="w-full bg-[#06090e] border border-[#1e293b] rounded-xl px-3 py-2 text-slate-200 pr-9 focus:outline-none focus:border-blue-500/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowExportPassphrase(!showExportPassphrase)}
                    className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                  >
                    {showExportPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {exportPassphrase.trim().length > 0 && (
                  <div>
                    <input
                      type={showExportPassphrase ? 'text' : 'password'}
                      placeholder="Confirm password"
                      value={confirmPassphrase}
                      onChange={(e) => setConfirmPassphrase(e.target.value)}
                      className="w-full bg-[#06090e] border border-[#1e293b] rounded-xl px-3 py-2 text-slate-200 focus:outline-none focus:border-blue-500/50"
                    />
                  </div>
                )}
              </div>

              {/* Error / Success Notifications */}
              {exportError && <CopyableErrorBanner message={exportError} />}

              {exportSuccess && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{exportSuccess}</span>
                </div>
              )}

              {/* Action Button */}
              <button
                onClick={handleExport}
                disabled={exporting || !hasAnyConnections}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-semibold text-white text-xs shadow-lg shadow-blue-600/30 flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              >
                <Download className="w-4 h-4" />
                <span>{exporting ? 'Exporting…' : 'Export'}</span>
              </button>
            </div>
          )}

          {/* ============================================================ */}
          {/* IMPORT MODE */}
          {/* ============================================================ */}
          {mode === 'import' && (
            <div className="space-y-4">
              {/* File Dropzone */}
              <div>
                <label className="text-slate-300 font-semibold text-xs block mb-2">
                  Select File:
                </label>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".rdsql,.json"
                  className="hidden"
                />

                <div
                  onClick={() => handleFileChange()}
                  className="border-2 border-dashed border-[#1e293b] hover:border-blue-500/50 rounded-2xl p-5 text-center bg-[#06090e] cursor-pointer transition-colors flex flex-col items-center gap-2 group"
                >
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                    <FileCode className="w-5 h-5" />
                  </div>
                  {importFile ? (
                    <div>
                      <div className="font-semibold text-slate-200 text-xs">{importFile.name}</div>
                      <div className="text-[10px] text-slate-500">{(importFile.size / 1024).toFixed(1)} KB</div>
                    </div>
                  ) : (
                    <div>
                      <div className="font-medium text-slate-300 text-xs">Click to browse connection file</div>
                      <div className="text-[10px] text-slate-500">Supports .rdsql or .json files</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Password Prompt — only shown for files that actually require a
                  password. Passwordless files (embedded key) decrypt on file
                  selection and skip this block entirely. */}
              {importFile && !fileIsPasswordless && (
                <div className="space-y-3 pt-2 border-t border-[#1e293b]">
                  <label className="text-slate-300 font-semibold text-xs flex items-center gap-1.5">
                    <Unlock className="w-3.5 h-3.5 text-blue-400" />
                    Enter Password:
                  </label>
                  <div className="relative">
                    <input
                      type={showImportPassphrase ? 'text' : 'password'}
                      placeholder="Password used during export"
                      value={importPassphrase}
                      onChange={(e) => setImportPassphrase(e.target.value)}
                      className="w-full bg-[#06090e] border border-[#1e293b] rounded-xl px-3 py-2 text-slate-200 pr-9 focus:outline-none focus:border-blue-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowImportPassphrase(!showImportPassphrase)}
                      className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300"
                    >
                      {showImportPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>

                  <button
                    onClick={handleDecryptFile}
                    disabled={decrypting}
                    className="w-full py-2 rounded-xl bg-[#1e293b] hover:bg-[#334155] font-semibold text-slate-200 text-xs transition-colors flex items-center justify-center gap-2"
                  >
                    <Unlock className="w-3.5 h-3.5 text-blue-400" />
                    <span>{decrypting ? 'Loading...' : 'Load Connections'}</span>
                  </button>
                </div>
              )}

              {/* Passwordless file: show a "no password required" notice + a
                  Load button (decrypts using the embedded key). Useful if the
                  auto-decrypt on file pick failed or was cleared. */}
              {importFile && fileIsPasswordless && !decrypted && (
                <div className="space-y-3 pt-2 border-t border-[#1e293b]">
                  <div className="flex items-center gap-2 p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 text-[11px]">
                    <Unlock className="w-3.5 h-3.5 shrink-0" />
                    <span>This file has no password — it will be decrypted automatically.</span>
                  </div>
                  <button
                    onClick={handleDecryptFile}
                    disabled={decrypting}
                    className="w-full py-2 rounded-xl bg-[#1e293b] hover:bg-[#334155] font-semibold text-slate-200 text-xs transition-colors flex items-center justify-center gap-2"
                  >
                    <Unlock className="w-3.5 h-3.5 text-blue-400" />
                    <span>{decrypting ? 'Loading...' : 'Load Connections'}</span>
                  </button>
                </div>
              )}

              {/* Decrypted Connections Preview */}
              {decrypted && (
                <div className="space-y-3 pt-2 border-t border-[#1e293b] animate-fadeIn">
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-400 font-semibold text-xs flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      Loaded {decryptedTotal} Connection(s):
                    </span>
                  </div>

                  {/* Database preview */}
                  {decrypted.databases.length > 0 && (
                    <div className="max-h-32 overflow-y-auto border border-[#1e293b] rounded-xl bg-[#06090e] p-2 space-y-1 macos-scroll">
                      {decrypted.databases.map((conn) => (
                        <div key={conn.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-[#0f172a]/60">
                          <EngineIcon engine={conn.engine} className="w-4 h-4 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-200 truncate text-xs">{conn.name}</div>
                            <div className="text-[10px] text-slate-500 font-mono truncate">
                              {conn.engine} • {conn.host || conn.cfAccountId || conn.filePath || 'local'}
                            </div>
                          </div>
                          <span className="text-[9px] text-blue-400 font-semibold uppercase">DB</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Storage preview */}
                  {decrypted.storage.length > 0 && (
                    <div className="max-h-32 overflow-y-auto border border-[#1e293b] rounded-xl bg-[#06090e] p-2 space-y-1 macos-scroll">
                      {decrypted.storage.map((conn) => (
                        <div key={conn.id} className="flex items-center gap-2 p-1.5 rounded-lg bg-[#0f172a]/60">
                          <Cloud className="w-4 h-4 shrink-0 text-amber-400" />
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-200 truncate text-xs">{conn.name}</div>
                            <div className="text-[10px] text-slate-500 font-mono truncate">
                              {conn.preset} • {conn.bucket}
                            </div>
                          </div>
                          <span className="text-[9px] text-amber-400 font-semibold uppercase">S3</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Duplicate Resolution Strategy */}
                  <div>
                    <label className="text-slate-400 text-[11px] block mb-1">If connection ID exists:</label>
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <button
                        onClick={() => setImportConflictStrategy('overwrite')}
                        className={`py-1.5 px-2 rounded-lg border text-center font-medium transition-colors ${
                          importConflictStrategy === 'overwrite'
                            ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                            : 'border-[#1e293b] text-slate-400 hover:bg-white/5'
                        }`}
                      >
                        Overwrite
                      </button>
                      <button
                        onClick={() => setImportConflictStrategy('skip')}
                        className={`py-1.5 px-2 rounded-lg border text-center font-medium transition-colors ${
                          importConflictStrategy === 'skip'
                            ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                            : 'border-[#1e293b] text-slate-400 hover:bg-white/5'
                        }`}
                      >
                        Skip
                      </button>
                      <button
                        onClick={() => setImportConflictStrategy('new_id')}
                        className={`py-1.5 px-2 rounded-lg border text-center font-medium transition-colors ${
                          importConflictStrategy === 'new_id'
                            ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                            : 'border-[#1e293b] text-slate-400 hover:bg-white/5'
                        }`}
                      >
                        Add as New
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={handleCommitImport}
                    className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-white text-xs shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2 transition-all"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Import {decryptedTotal} Connection(s)</span>
                  </button>
                </div>
              )}

              {/* Notifications */}
              {importError && <CopyableErrorBanner message={importError} />}

              {importSuccess && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>{importSuccess}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
