import React, { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  X, Database, Check, RefreshCw, Link2, Cloud, Terminal, Tag as TagIcon,
  FolderOpen, Lock, Server, Info, KeyRound, ShieldCheck, ArrowRightLeft,
} from 'lucide-react';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useStorageStore } from '../../store/useStorageStore';
import { useTagStore } from '../../store/useTagStore';
import { DatabaseConnection, DatabaseEngine, SshTunnelConfig } from '../../core/domain/types';
import { hexToRgba } from '../../core/domain/tags';
import { safeInvoke } from '../../core/tauri/ipc';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { parseEnvOrUrl } from '../../core/connection/envImport';
import { ENGINE_REGISTRY, engineMeta, engineFamily as getEngineFamily } from '../../core/connection/engines';
// S3 fields when the user picks the Storage kind in this same modal.
import { STORAGE_PRESETS, getPreset, presetDefaults } from '../../core/storage/domain/presets';
import type { S3ConnectionConfig, S3ProviderPreset, TestStorageResult } from '../../core/storage/domain/types';
import { encryptSecret, UNCHANGED_SECRET } from '../../core/storage/secrets';
import { toStorageError } from '../../core/storage/domain/errors';
import { track } from '../../core/analytics/track';
import { useSettingsStore } from '../../store/useSettingsStore';

/** True when running inside the Tauri native shell (so native dialog/fs plugins
 *  are available). In the browser/dev preview the path pickers degrade to plain
 *  text inputs. Mirrors the helper in EncryptedConnectionsModal.tsx. */
const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const ALL_ENGINES = ENGINE_REGISTRY.map((e) => e.id);

const SSL_MODES: Record<string, string[]> = {
  postgres: ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'],
  mysql: ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'],
  // TDS encryption is effectively on/off — "disable" turns it off entirely,
  // anything else connects with encryption required and the server cert
  // trusted (matches the common self-signed-cert local/dev SQL Server setup).
  mssql: ['disable', 'require'],
};

type OpenDialogOptions = Parameters<typeof open>[0];

/** A labeled path input paired with one or more native "Browse" buttons that
 *  open the OS file/folder picker (Tauri dialog). Each entry in `actions` is a
 *  button; clicking it runs `open(opts)` and, on success, calls `onChange` with
 *  the chosen path. Cancellation is a silent no-op. In the browser/dev preview
 *  the buttons are hidden and only the text input remains. */
const PathInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  inputClass: string;
  actions: { label: string; icon: React.ReactNode; options?: OpenDialogOptions }[];
}> = ({ value, onChange, placeholder, required, inputClass, actions }) => {
  const handlePick = async (options: OpenDialogOptions) => {
    try {
      const picked = await open(options ?? {});
      if (!picked) return; // user cancelled
      if (Array.isArray(picked)) {
        if (picked.length > 0) onChange(picked[0]);
      } else {
        onChange(picked);
      }
    } catch {
      // Dialog unavailable or dismissed — no-op.
    }
  };
  return (
    <div className="flex gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputClass} flex-1 min-w-0`}
        required={required}
      />
      {isTauri() && actions.map((a, i) => (
        <button
          key={i}
          type="button"
          title={a.label}
          onClick={() => handlePick(a.options)}
          className="shrink-0 px-2 rounded border border-[#1e293b] bg-[#0f172a] hover:border-blue-500 text-slate-400 hover:text-blue-400 flex items-center transition-colors"
        >
          {a.icon}
        </button>
      ))}
    </div>
  );
};

/** Shared style constants for the form. Kept inline (not exported) so every
 *  section reads identically across the sidebar layout. */
const inputClass = "w-full h-8 box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded px-2 text-xs text-slate-100 focus:outline-none";
const labelClass = "block text-[11px] font-medium text-slate-400 mb-1";

/** A small section header used at the top of each right-pane section: icon +
 *  title + optional one-line description. */
const SectionHeader: React.FC<{ icon: React.ReactNode; title: string; desc?: string }> = ({ icon, title, desc }) => (
  <div className="flex items-start gap-2.5 mb-4">
    <div className="shrink-0 w-7 h-7 rounded-lg bg-[#0f172a] border border-[#1e293b] flex items-center justify-center text-blue-400">
      {icon}
    </div>
    <div>
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      {desc && <p className="text-[10px] text-slate-500 mt-0.5">{desc}</p>}
    </div>
  </div>
);

/** One sidebar nav entry. `active` highlights the row; the green dot flags a
 *  section that has content (e.g. an SSH tunnel configured, tags applied). */
const NavItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: boolean;
}> = ({ icon, label, active, onClick, dot }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
      active
        ? 'bg-blue-600/15 text-blue-300 border border-blue-500/40'
        : 'text-slate-400 hover:text-slate-200 hover:bg-[#0f172a] border border-transparent'
    }`}
  >
    <span className={active ? 'text-blue-400' : 'text-slate-500'}>{icon}</span>
    <span className="flex-1 text-left truncate">{label}</span>
    {dot && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
  </button>
);

export const ConnectionModal: React.FC = () => {
  const { isConnectionModalOpen, setConnectionModalOpen, saveConnection, editingConnection, setServerVersion } = useConnectionStore();
  const { tags } = useTagStore();
  useEscapeToClose(isConnectionModalOpen ? () => setConnectionModalOpen(false) : null);

  const [engine, setEngine] = useState<DatabaseEngine>('postgres');
  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [filePath, setFilePath] = useState('');
  const [urlString, setUrlString] = useState('');
  const [sslMode, setSslMode] = useState('');
  const [tagId, setTagId] = useState<string | null>(null);
  // Per-connection "show system schemas" (pg_catalog/information_schema on
  // Postgres; mysql/sys/… on MySQL). Initialized to the effective value
  // (explicit override, else the global default) so the checkbox reflects what
  // the user actually sees in the Explorer.
  const globalShowSystemSchemas = useSettingsStore((s) => s.showSystemSchemas);
  const [showSystemSchemas, setShowSystemSchemas] = useState(false);

  // Cloudflare D1
  const [cfAccountId, setCfAccountId] = useState('');
  const [cfApiToken, setCfApiToken] = useState('');
  const [cfDatabaseId, setCfDatabaseId] = useState('');
  // Redis logical DB index (0-15 by default server config).
  const [redisDbIndex, setRedisDbIndex] = useState(0);
  // MongoDB — authSource/replicaSet are discrete-field extras; connectionString
  // is the Atlas/`+srv` override (see ConnectionConfig.mongoConnectionString).
  const [mongoAuthSource, setMongoAuthSource] = useState('');
  const [mongoReplicaSet, setMongoReplicaSet] = useState('');
  const [mongoConnectionString, setMongoConnectionString] = useState('');

  // SSH tunnel
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [jumpHost, setJumpHost] = useState('');
  // Which auth field is shown. A private key always wins over a password
  // when both are set (mirrors src-tauri/.../ssh_tunnel.rs `authenticate`),
  // so showing both inputs at once invited the "which one is actually used?"
  // question — this toggle makes the active method explicit instead.
  const [sshAuthMethod, setSshAuthMethod] = useState<'key' | 'password'>('key');
  const [showJumpHost, setShowJumpHost] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; latency_ms?: number; server_version?: string } | null>(null);

  // SSH-only test — validates just the tunnel hop (auth + reachability),
  // independent of the "Test Connection" button which exercises the whole
  // DB driver through the tunnel. Kept as separate state so testing the
  // bastion doesn't clobber (or get clobbered by) the DB test result.
  const [sshTesting, setSshTesting] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<{ success: boolean; message: string; latencyMs?: number } | null>(null);

  /** Active sidebar section. The available sections depend on `kind` (DB vs
   *  S3) and the chosen engine; switching kind/engine resets to 'connection'. */
  const [section, setSection] = useState<'connection' | 'security' | 'tags'>('connection');

  // Status line under the Connection URL / .env field, shown when parsing
  // recognized fields ("Filled: host, port, …"). Shared by the URL field.
  const [autofillMsg, setAutofillMsg] = useState<string | null>(null);

  // Top-level connection kind. The modal serves both DB and S3 connections so
  // users have one entry point ("New Connection"); picking Storage swaps the
  // form body to S3 fields and routes test/save through the storage store.
  const [kind, setKind] = useState<'database' | 's3'>('database');

  // ── S3 fields (only used when kind === 's3') ──────────────────────────────
  const storageSave = useStorageStore((s) => s.saveConnection);
  const [s3Preset, setS3Preset] = useState<S3ProviderPreset>('minio');
  const [s3Region, setS3Region] = useState(getPreset('minio').region);
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3AccessKeyId, setS3AccessKeyId] = useState('');
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState(UNCHANGED_SECRET);
  const [s3ForcePathStyle, setS3ForcePathStyle] = useState(getPreset('minio').forcePathStyle);
  const [s3PathPrefix, setS3PathPrefix] = useState('rdsql/');

  useEffect(() => {
    if (!isConnectionModalOpen) return;
    if (editingConnection) {
      const c = editingConnection;
      setEngine(c.engine);
      setName(c.name);
      setHost(c.host || '127.0.0.1');
      setPort(c.port || engineMeta(c.engine).defaultPort || 5432);
      setDatabase(c.database || '');
      setUsername(c.username || '');
      setPassword(c.password || '');
      setFilePath(c.filePath || '');
      setSslMode(c.sslMode || '');
      setTagId(c.tagId ?? null);
      setShowSystemSchemas(c.showSystemSchemas ?? globalShowSystemSchemas);
      setCfAccountId(c.cfAccountId || '');
      setCfApiToken(c.cfApiToken || '');
      setCfDatabaseId(c.cfDatabaseId || '');
      setRedisDbIndex(c.redisDbIndex ?? 0);
      setMongoAuthSource(c.mongoAuthSource || '');
      setMongoReplicaSet(c.mongoReplicaSet || '');
      setMongoConnectionString(c.mongoConnectionString || '');
      if (c.ssh) {
        setSshEnabled(true);
        setSshHost(c.ssh.sshHost || '');
        setSshPort(c.ssh.sshPort || 22);
        setSshUser(c.ssh.sshUser || '');
        setSshKeyPath(c.ssh.sshKeyPath || '');
        setSshPassword(c.ssh.sshPassword || '');
        setJumpHost(c.ssh.jumpHost || '');
        setSshAuthMethod(c.ssh.sshPassword && !c.ssh.sshKeyPath ? 'password' : 'key');
        setShowJumpHost(!!c.ssh.jumpHost);
      } else {
        setSshEnabled(false);
        setSshAuthMethod('key');
        setShowJumpHost(false);
      }
      setSection('connection');
      setAutofillMsg(null);
      setTestResult(null);
      setSshTestResult(null);
    } else {
      setEngine('postgres');
      setName('');
      setHost('127.0.0.1');
      setPort(5432);
      setDatabase('');
      setUsername('');
      setPassword('');
      setFilePath('');
      setUrlString('');
      setSslMode('');
      setTagId(null);
      setShowSystemSchemas(globalShowSystemSchemas);
      setCfAccountId('');
      setCfApiToken('');
      setCfDatabaseId('');
      setRedisDbIndex(0);
      setMongoAuthSource('');
      setMongoReplicaSet('');
      setMongoConnectionString('');
      setSshEnabled(false);
      setSshHost('');
      setSshPort(22);
      setSshUser('');
      setSshKeyPath('');
      setSshPassword('');
      setJumpHost('');
      setSshAuthMethod('key');
      setShowJumpHost(false);
      setSection('connection');
      setAutofillMsg(null);
      setTestResult(null);
      setSshTestResult(null);
      // Reset S3 fields + kind when opening for a new connection.
      setKind('database');
      setS3Preset('minio');
      setS3Region(getPreset('minio').region);
      setS3Bucket('');
      setS3Endpoint('');
      setS3AccessKeyId('');
      setS3SecretAccessKey(UNCHANGED_SECRET);
      setS3ForcePathStyle(getPreset('minio').forcePathStyle);
      setS3PathPrefix('rdsql/');
    }
  }, [isConnectionModalOpen, editingConnection]);

  if (!isConnectionModalOpen) return null;

  const isFileBased = engine === 'sqlite' || engine === 'duckdb';
  const isD1 = engine === 'cloudflare-d1';
  const isRedis = engine === 'redis';
  const isMongo = engine === 'mongodb';
  const isNetworked = !isFileBased && !isD1 && !isRedis; // postgres / mysql / mssql / mongodb family
  const isS3 = kind === 's3';
  // Every engine the backend's ssh_tunnel::resolve_target actually wires up
  // (postgres/mysql/mssql/redis/mongodb) — see
  // src-tauri/src/commands/{connection,mssql,redis,mongo}.rs. File-based
  // engines (sqlite/duckdb) and D1 (HTTPS API, no raw socket) have nothing
  // to tunnel.
  const isSshCapable = isNetworked || isRedis;

  /** Shared by every buildConfig() branch below — returns the SSH tunnel spec
   *  the form currently describes, or undefined when the tunnel is off. */
  const buildSshConfig = (): SshTunnelConfig | undefined =>
    sshEnabled
      ? {
          sshHost,
          sshPort,
          sshUser,
          sshKeyPath: sshKeyPath || undefined,
          sshPassword: sshPassword || undefined,
          jumpHost: jumpHost || undefined,
        }
      : undefined;

  /** Parse the Connection URL / .env textarea. Accepts both a bare connection
   *  URL (postgres://… / mysql://…) and a pasted .env block (DB_HOST=…,
   *  DATABASE_URL=…). Every recognized field fills the form live. */
  const handleParseUrl = (text: string) => {
    setUrlString(text);
    if (!text.trim()) {
      setAutofillMsg(null);
      return;
    }
    const parsed = parseEnvOrUrl(text);
    if (parsed.engine) setEngine(parsed.engine);
    if (parsed.host) setHost(parsed.host);
    if (parsed.port !== undefined) setPort(parsed.port);
    if (parsed.database) { setDatabase(parsed.database); if (!name) setName(parsed.database); }
    if (parsed.username) setUsername(parsed.username);
    if (parsed.password) setPassword(parsed.password);
    const unique = Array.from(new Set(parsed.appliedKeys));
    setAutofillMsg(
      unique.length > 0
        ? `Filled: ${unique.join(', ')}`
        : 'No recognizable fields found — paste a URL or .env vars.',
    );
  };

  const buildConfig = (): DatabaseConnection => {
    const base: DatabaseConnection = {
      id: editingConnection?.id || `conn_${Date.now()}`,
      name: name || `${database || engine.toUpperCase()} Connection`,
      engine,
      colorTag:
        editingConnection?.colorTag ||
        engineMeta(engine).color,
      isFavorite: editingConnection?.isFavorite ?? false,
      tagId: tagId ?? null,
      // Preserve client-side prefs that this form doesn't expose, so editing a
      // connection (e.g. changing its host) doesn't silently wipe them.
      scopeDatabase: editingConnection?.scopeDatabase,
      // Only meaningful for Postgres/MySQL/SQL Server (the engines that have
      // system schemas); omit for others so it doesn't linger on the profile.
      showSystemSchemas:
        getEngineFamily(engine) === 'postgres' || getEngineFamily(engine) === 'mysql' || getEngineFamily(engine) === 'mssql'
          ? showSystemSchemas
          : undefined,
    };

    if (isD1) {
      return { ...base, cfAccountId, cfApiToken, cfDatabaseId, database: cfDatabaseId };
    }
    if (isFileBased) {
      return { ...base, filePath };
    }
    if (isRedis) {
      return {
        ...base,
        host,
        port,
        username: username || undefined,
        password,
        redisDbIndex,
        sslMode: sslMode || undefined,
        ssh: buildSshConfig(),
      };
    }
    if (isMongo) {
      return {
        ...base,
        host,
        port,
        database,
        username: username || undefined,
        password,
        sslMode: sslMode || undefined,
        ssh: buildSshConfig(),
        mongoAuthSource: mongoAuthSource || undefined,
        mongoReplicaSet: mongoReplicaSet || undefined,
        mongoConnectionString: mongoConnectionString || undefined,
      };
    }
    const conn: DatabaseConnection = {
      ...base,
      host,
      port,
      database,
      username,
      password,
      sslMode: sslMode || undefined,
      ssh: buildSshConfig(),
    };
    return conn;
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (isS3) {
        if (s3SecretAccessKey === UNCHANGED_SECRET) {
          setTestResult({ success: false, message: 'Enter the secret access key to test.' });
          return;
        }
        const res = await safeInvoke<TestStorageResult>('s3_test_connection', {
          config: {
            id: 'preview',
            name,
            region: s3Region,
            bucket: s3Bucket,
            endpoint: s3Endpoint || undefined,
            accessKeyId: s3AccessKeyId,
            secretAccessKey: s3SecretAccessKey,
            forcePathStyle: s3ForcePathStyle,
            pathPrefix: s3PathPrefix,
          },
        });
        setTestResult({ success: res.success, message: res.message, latency_ms: res.latencyMs });
        return;
      }
      const cfg = buildConfig();
      const res = await safeInvoke<{ success: boolean; message: string; latency_ms: number; server_version?: string }>(
        'test_connection',
        { config: cfg }
      );
      setTestResult(res);
      // Cache the version banner for the AI assistant's dialect/version context.
      if (res.success && res.server_version && cfg.id) {
        setServerVersion(cfg.id, res.server_version);
      }
    } catch (err: any) {
      setTestResult({ success: false, message: isS3 ? toStorageError(err).message : (err?.message || String(err)) });
    } finally {
      setTesting(false);
    }
  };

  /** Tests just the SSH hop (connect + authenticate, then disconnect) — no
   *  database driver involved. Lets the user confirm the bastion/jump host
   *  is reachable before ever pointing a DB connection through it. */
  const handleTestSsh = async () => {
    setSshTesting(true);
    setSshTestResult(null);
    try {
      const spec = buildSshConfig();
      if (!spec) return;
      const res = await safeInvoke<{ success: boolean; message: string; latencyMs: number }>(
        'test_ssh_connection',
        { spec }
      );
      setSshTestResult(res);
    } catch (err: any) {
      setSshTestResult({ success: false, message: err?.message || String(err) });
    } finally {
      setSshTesting(false);
    }
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    // S3 kind: build + seal a storage connection into the storage store.
    if (isS3) {
      if (!name.trim() || !s3Bucket.trim() || !s3AccessKeyId.trim() || s3SecretAccessKey === UNCHANGED_SECRET) return;
      const now = new Date().toISOString();
      // encryptSecret is async, but save is fire-and-forget here; we void it.
      void encryptSecret(s3SecretAccessKey).then((sealed) => {
        const s3Conn: S3ConnectionConfig = {
          id: `stor_${Date.now()}`,
          name: name.trim(),
          preset: s3Preset,
          provider: 's3',
          region: s3Region.trim(),
          bucket: s3Bucket.trim(),
          endpoint: s3Endpoint.trim() || undefined,
          accessKeyId: s3AccessKeyId.trim(),
          secretAccessKey: sealed,
          forcePathStyle: s3ForcePathStyle,
          pathPrefix: s3PathPrefix.trim(),
          createdAt: now,
          updatedAt: now,
        };
        storageSave(s3Conn);
        setConnectionModalOpen(false);
      });
      return;
    }
    const conn = buildConfig();
    if (!editingConnection) track({ name: 'connection_created', dimension: conn.engine });
    saveConnection(conn);
    setConnectionModalOpen(false);
  };

  // ── Sidebar section list ─────────────────────────────────────────────────
  // Built per-kind so S3 shows different sections than DB. The 'security' and
  // 'connection' sections adapt their bodies to the selected engine inside.
  // Connection name, type (DB/S3), engine, and preset all live at the top of
  // the Connection section, so there is no separate General section.
  type SectionId = 'connection' | 'security' | 'tags';
  const navSections: { id: SectionId; label: string; icon: React.ReactNode; dot?: boolean }[] = isS3
    ? [
        { id: 'connection', label: 'Bucket & Endpoint', icon: <Cloud className="w-3.5 h-3.5" /> },
        { id: 'security', label: 'Credentials', icon: <Lock className="w-3.5 h-3.5" />, dot: s3SecretAccessKey !== UNCHANGED_SECRET && s3SecretAccessKey !== '' },
        { id: 'tags', label: 'Tags', icon: <TagIcon className="w-3.5 h-3.5" />, dot: tagId !== null },
      ]
    : [
        { id: 'connection', label: 'Connection', icon: <Server className="w-3.5 h-3.5" /> },
        ...(isSshCapable
          ? [{ id: 'security' as SectionId, label: 'Security & SSH', icon: <Lock className="w-3.5 h-3.5" />, dot: sshEnabled }]
          : []),
        { id: 'tags', label: 'Tags', icon: <TagIcon className="w-3.5 h-3.5" />, dot: tagId !== null },
      ];

  // Clamp the active section to one that exists for the current kind/engine.
  // (e.g. switching from postgres to sqlite hides 'security'.)
  const validSection = navSections.some((s) => s.id === section) ? section : 'connection';

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setConnectionModalOpen(false)}>
      <div
        className="w-full max-w-3xl h-[80vh] bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-[#1e293b] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 font-bold text-sm text-slate-100">
            <Database className="w-4 h-4 text-blue-400" />
            {editingConnection ? 'Edit Connection' : 'New Connection'}
            <span className="text-[10px] font-normal text-slate-500 ml-1 px-1.5 py-0.5 rounded bg-[#0f172a] border border-[#1e293b] uppercase">
              {isS3 ? 'Storage' : engine === 'cloudflare-d1' ? 'D1' : engine}
            </span>
          </div>
          <button onClick={() => setConnectionModalOpen(false)} className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 flex min-h-0">
          {/* ── Sidebar nav ─────────────────────────────────────────────── */}
          <nav className="w-44 shrink-0 border-r border-[#1e293b] bg-[#06090e] p-2.5 space-y-1 overflow-y-auto">
            {navSections.map((s) => (
              <NavItem
                key={s.id}
                icon={s.icon}
                label={s.label}
                active={validSection === s.id}
                dot={s.dot}
                onClick={() => setSection(s.id)}
              />
            ))}
            <div className="pt-3 mt-3 border-t border-[#1e293b]">
              <p className="px-2.5 text-[9px] uppercase tracking-wide text-slate-600 font-semibold mb-1.5">Connection Type</p>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => { setKind('database'); setSection('connection'); setTestResult(null); }}
                  className={`py-1.5 rounded-lg border text-[10px] font-semibold flex flex-col items-center gap-0.5 transition-all ${
                    !isS3 ? 'bg-blue-600/20 border-blue-500 text-blue-400' : 'border-[#1e293b] text-slate-500 hover:border-slate-600'
                  }`}
                >
                  <Database className="w-3.5 h-3.5" /> DB
                </button>
                <button
                  type="button"
                  onClick={() => { setKind('s3'); setSection('connection'); setTestResult(null); }}
                  className={`py-1.5 rounded-lg border text-[10px] font-semibold flex flex-col items-center gap-0.5 transition-all ${
                    isS3 ? 'bg-amber-600/20 border-amber-500 text-amber-400' : 'border-[#1e293b] text-slate-500 hover:border-slate-600'
                  }`}
                >
                  <Cloud className="w-3.5 h-3.5" /> S3
                </button>
              </div>
            </div>
          </nav>

          {/* ── Right pane: the active section ──────────────────────────── */}
          <div className="flex-1 overflow-y-auto p-5">

            {/* ═══ CONNECTION ════════════════════════════════════════════ */}
            {validSection === 'connection' && (
              <div>
                {/* Identity block — name + (DB) engine / (S3) preset. Sits at the
                    top of the Connection section for every kind/engine. */}
                <SectionHeader
                  icon={isS3 ? <Cloud className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                  title={isS3 ? 'Connection' : 'Connection'}
                  desc={isS3 ? 'Name and locate this storage connection.' : 'Name the connection and pick the database engine.'}
                />
                <div className="space-y-4 mb-5 pb-5 border-b border-[#1e293b]">
                  <div>
                    <label className={labelClass}>Connection Name</label>
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder={isS3 ? 'Production R2' : 'My Database'} className={inputClass} autoFocus />
                  </div>

                  {/* Engine picker — DB only. A dropdown keeps the connection
                      form compact (the old 4-icon grid ate a lot of vertical
                      space for a choice that changes rarely). */}
                  {!isS3 && (
                    <div>
                      <label className={labelClass}>Database Engine</label>
                      <select
                        className={inputClass}
                        value={engine}
                        onChange={(e) => {
                          const next = e.target.value as DatabaseEngine;
                          setEngine(next);
                          const dp = engineMeta(next).defaultPort;
                          if (dp !== undefined) setPort(dp);
                          // 'security' only exists for networked engines — bounce to connection.
                          if (getEngineFamily(next) === 'sqlite' && section === 'security') setSection('connection');
                          setTestResult(null);
                        }}
                      >
                        {ALL_ENGINES.map((e) => (
                          <option key={e} value={e}>
                            {engineMeta(e).label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* S3 preset — S3 only. */}
                  {isS3 && (
                    <div>
                      <label className={labelClass}>Provider Preset</label>
                      <select
                        className={inputClass}
                        value={s3Preset}
                        onChange={(e) => {
                          const p = e.target.value as S3ProviderPreset;
                          setS3Preset(p);
                          const d = presetDefaults(p);
                          setS3Region(d.region);
                          setS3Endpoint(d.endpoint ?? '');
                          setS3ForcePathStyle(d.forcePathStyle);
                        }}
                      >
                        {STORAGE_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                      <p className="text-[10px] text-slate-500 mt-1">{getPreset(s3Preset).hint}</p>
                    </div>
                  )}
                </div>

                {/* Engine/kind-specific connection fields below the identity. */}
                {isS3 ? (
                  <>
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>Bucket</label>
                          <input className={inputClass} value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} placeholder="company-backups" />
                        </div>
                        <div>
                          <label className={labelClass}>Region</label>
                          <input className={inputClass} value={s3Region} onChange={(e) => setS3Region(e.target.value)} placeholder="us-east-1 / auto" />
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>Endpoint (optional for AWS S3)</label>
                        <input className={`${inputClass} font-mono`} value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} placeholder="https://<account>.r2.cloudflarestorage.com" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>Path Prefix (RDSQL scope)</label>
                          <input className={`${inputClass} font-mono`} value={s3PathPrefix} onChange={(e) => setS3PathPrefix(e.target.value)} placeholder="rdsql/" />
                          <p className="text-[10px] text-slate-500 mt-1">RDSQL writes stay under this prefix.</p>
                        </div>
                        <div>
                          <label className={labelClass}>Addressing</label>
                          <label className="flex items-center gap-2 h-8 text-slate-300 cursor-pointer">
                            <input type="checkbox" checked={s3ForcePathStyle} onChange={(e) => setS3ForcePathStyle(e.target.checked)} className="accent-amber-500" />
                            <span className="text-[11px]">Force path-style (MinIO)</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </>
                ) : isD1 ? (
                  <>
                    <div className="space-y-4">
                      <div>
                        <label className={labelClass}>Account ID</label>
                        <input value={cfAccountId} onChange={(e) => setCfAccountId(e.target.value)} placeholder="a1b2c3d4..." className={`${inputClass} font-mono`} />
                      </div>
                      <div>
                        <label className={labelClass}>Database ID / Name</label>
                        <input value={cfDatabaseId} onChange={(e) => setCfDatabaseId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx or db-name" className={`${inputClass} font-mono`} />
                      </div>
                      <p className="text-[10px] text-slate-600 flex items-start gap-1.5">
                        <Info className="w-3 h-3 shrink-0 mt-0.5" />
                        Create a token at Cloudflare Dashboard → My Profile → API Tokens with D1 edit permissions.
                      </p>
                    </div>
                  </>
                ) : isFileBased ? (
                  <>
                    <div className="space-y-4">
                      <div>
                        <label className={labelClass}>Database File Path</label>
                        <PathInput
                          value={filePath}
                          onChange={setFilePath}
                          placeholder="/path/to/database.db"
                          required
                          inputClass={`${inputClass} font-mono`}
                          actions={[
                            {
                              label: 'Browse for database file',
                              icon: <FolderOpen className="w-3.5 h-3.5" />,
                              options: {
                                multiple: false,
                                filters: [
                                  { name: engine === 'duckdb' ? 'DuckDB' : 'SQLite', extensions: engine === 'duckdb' ? ['duckdb', 'db'] : ['db', 'sqlite', 'sqlite3'] },
                                ],
                              },
                            },
                            {
                              label: 'Pick a folder for a new database',
                              icon: <span className="text-[10px] font-bold leading-none">New</span>,
                              options: { multiple: false, directory: true },
                            },
                          ]}
                        />
                        <p className="text-[10px] text-slate-500 mt-1">Browse for an existing .db file, or pick a folder to create a new database.</p>
                      </div>
                    </div>
                  </>
                ) : isRedis ? (
                  <>
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className={labelClass}>Host</label>
                          <input value={host} onChange={(e) => setHost(e.target.value)} className={inputClass} required />
                        </div>
                        <div>
                          <label className={labelClass}>Port</label>
                          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputClass} required />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className={labelClass}>Username (ACL, optional)</label>
                          <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} placeholder="default" />
                        </div>
                        <div>
                          <label className={labelClass}>Password (optional)</label>
                          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
                        </div>
                        <div>
                          <label className={labelClass}>DB Index</label>
                          <input
                            type="number"
                            min={0}
                            max={15}
                            value={redisDbIndex}
                            onChange={(e) => setRedisDbIndex(Number(e.target.value))}
                            className={inputClass}
                          />
                        </div>
                      </div>

                      <label className="flex items-center gap-2 h-8 text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={sslMode === 'require'}
                          onChange={(e) => setSslMode(e.target.checked ? 'require' : '')}
                          className="accent-red-500"
                        />
                        <span className="text-[11px]">Use TLS (rediss://)</span>
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-4">
                      <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                          <label className={labelClass}>Host</label>
                          <input value={host} onChange={(e) => setHost(e.target.value)} className={inputClass} required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                        </div>
                        <div>
                          <label className={labelClass}>Port</label>
                          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputClass} required />
                        </div>
                      </div>

                      <div>
                        <label className={labelClass}>Database</label>
                        <input value={database} onChange={(e) => setDatabase(e.target.value)} className={inputClass} required autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                      </div>

                      {/* autoCapitalize/autoCorrect/spellCheck off — credentials must round-trip
                          byte-for-byte; WebKit's system-level "Capitalize automatically" text
                          feature otherwise silently uppercases the first letter typed (e.g.
                          "sa" becomes "Sa"), producing a confusing auth failure. */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelClass}>Username</label>
                          <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                        </div>
                        <div>
                          <label className={labelClass}>Password</label>
                          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                        </div>
                      </div>

                      {isMongo && (
                        <div className="space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className={labelClass}>Auth Source (optional)</label>
                              <input
                                value={mongoAuthSource}
                                onChange={(e) => setMongoAuthSource(e.target.value)}
                                className={inputClass}
                                placeholder="admin"
                              />
                            </div>
                            <div>
                              <label className={labelClass}>Replica Set (optional)</label>
                              <input
                                value={mongoReplicaSet}
                                onChange={(e) => setMongoReplicaSet(e.target.value)}
                                className={inputClass}
                                placeholder="rs0"
                              />
                            </div>
                          </div>
                          <div>
                            <label className={labelClass}>Advanced: full connection string (optional)</label>
                            <input
                              value={mongoConnectionString}
                              onChange={(e) => setMongoConnectionString(e.target.value)}
                              className={`${inputClass} font-mono`}
                              placeholder="mongodb+srv://user:pass@cluster0.xxxx.mongodb.net/mydb"
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                            <p className="text-[10px] text-slate-500 mt-1">
                              Required for Atlas (mongodb+srv://) connections — when set, this replaces the
                              fields above and bypasses the SSH tunnel (a +srv URI resolves its own hosts via DNS).
                            </p>
                          </div>
                        </div>
                      )}

                      {/* URL / .env paste — quick fill. Lives at the END of the
                          form so the user fills the fields directly, then can
                          optionally paste a URL / .env to bulk-fill. Accepts a
                          single connection URL OR a pasted .env block; parsed
                          live via parseEnvOrUrl. Single line by default, grows
                          with content (field-sizing) and is drag-resizable. */}
                      <div>
                        <label className={labelClass}>Connection URL or .env (auto-fills fields)</label>
                        <div className="relative">
                          <Link2 className="w-3 h-3 text-slate-500 absolute left-2.5 top-2.5" />
                          <textarea
                            value={urlString}
                            onChange={(e) => handleParseUrl(e.target.value)}
                            placeholder="postgres://user:pass@host:5432/db  —  or paste a .env block (DB_HOST=…, DATABASE_URL=…)"
                            rows={1}
                            className="w-full box-border bg-[#0f172a] border border-[#1e293b] focus:border-blue-500 rounded pl-8 pr-2 py-1.5 text-[11px] font-mono text-slate-100 focus:outline-none resize-y leading-6"
                            style={{ fieldSizing: 'content' as React.CSSProperties['fieldSizing'] }}
                          />
                        </div>
                        {autofillMsg && (
                          <p className={`text-[10px] mt-1 ${autofillMsg.startsWith('Filled') ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {autofillMsg}
                          </p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ═══ SECURITY / CREDENTIALS ════════════════════════════════ */}
            {validSection === 'security' && (
              <div>
                {isS3 ? (
                  <>
                    <SectionHeader icon={<Lock className="w-4 h-4" />} title="Credentials" desc="S3 access key pair." />
                    <div className="space-y-4">
                      <div>
                        <label className={labelClass}>Access Key ID</label>
                        <input className={`${inputClass} font-mono`} value={s3AccessKeyId} onChange={(e) => setS3AccessKeyId(e.target.value)} placeholder="AKIA…" />
                      </div>
                      <div>
                        <label className={labelClass}>Secret Access Key</label>
                        <input
                          className={`${inputClass} font-mono`}
                          type="password"
                          value={s3SecretAccessKey === UNCHANGED_SECRET ? '' : s3SecretAccessKey}
                          onChange={(e) => setS3SecretAccessKey(e.target.value)}
                          placeholder="secret access key"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <SectionHeader
                      icon={<Lock className="w-4 h-4" />}
                      title="Security & SSH"
                      desc={isNetworked ? 'Optional SSH tunnel / jump server, and SSL mode.' : 'Optional SSH tunnel / jump server.'}
                    />
                    <div className="space-y-5">
                      {/* Show system schemas — per-connection preference (Postgres/MySQL/SQL Server). */}
                      {(getEngineFamily(engine) === 'postgres' || getEngineFamily(engine) === 'mysql' || getEngineFamily(engine) === 'mssql') && (
                        <label className="flex items-center gap-2 h-8 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showSystemSchemas}
                            onChange={(e) => setShowSystemSchemas(e.target.checked)}
                            className="accent-cyan-500"
                          />
                          <span className="text-[11px]">Show system schemas in Explorer</span>
                          <span className="text-[10px] text-slate-600">
                            ({getEngineFamily(engine) === 'postgres' ? 'pg_catalog, information_schema' : getEngineFamily(engine) === 'mssql' ? 'sys, INFORMATION_SCHEMA, master, tempdb' : 'mysql, sys, performance_schema'})
                          </span>
                        </label>
                      )}

                      <div className="border-t border-[#1e293b] pt-5">
                        {/* SSH enable toggle */}
                        <div className="flex items-center justify-between mb-3">
                          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                            <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                            SSH Tunnel / Jump Server
                          </span>
                          <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={sshEnabled}
                              onChange={(e) => { setSshEnabled(e.target.checked); setSshTestResult(null); }}
                              className="accent-cyan-500"
                            />
                            Enable tunnel
                          </label>
                        </div>

                        {sshEnabled ? (
                          <div className="space-y-4">
                            <p className="text-[10px] text-slate-500 leading-relaxed">
                              The database connection is made from <span className="text-slate-400">inside</span> this
                              SSH session, not from your machine — use this when the database only accepts
                              connections from a bastion / VPC-internal host.
                            </p>

                            {/* Bastion host */}
                            <div className="rounded-lg border border-[#1e293b] bg-[#0b1220] p-3 space-y-3">
                              <p className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                                <Server className="w-3 h-3" /> Bastion Host
                              </p>
                              <div className="grid grid-cols-3 gap-3">
                                <div className="col-span-2">
                                  <label className={labelClass}>SSH Host</label>
                                  <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" className={inputClass} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                                </div>
                                <div>
                                  <label className={labelClass}>Port</label>
                                  <input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} className={inputClass} />
                                </div>
                              </div>
                              <div>
                                <label className={labelClass}>SSH User</label>
                                <input
                                  value={sshUser}
                                  onChange={(e) => setSshUser(e.target.value)}
                                  placeholder="ubuntu"
                                  className={inputClass}
                                  autoComplete="off"
                                  autoCapitalize="off"
                                  autoCorrect="off"
                                  spellCheck={false}
                                />
                              </div>
                            </div>

                            {/* Authentication — key vs. password. Only one field is
                                shown at a time: a private key always wins over a
                                password when both are set, so showing both invited
                                the "which one actually gets used?" question. */}
                            <div className="rounded-lg border border-[#1e293b] bg-[#0b1220] p-3 space-y-3">
                              <div className="flex items-center justify-between">
                                <p className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
                                  <ShieldCheck className="w-3 h-3" /> Authentication
                                </p>
                                <div className="flex rounded-md border border-[#1e293b] overflow-hidden text-[10px] font-semibold">
                                  <button
                                    type="button"
                                    onClick={() => setSshAuthMethod('key')}
                                    className={`px-2.5 py-1 flex items-center gap-1 transition-colors ${
                                      sshAuthMethod === 'key' ? 'bg-cyan-600/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                                  >
                                    <KeyRound className="w-3 h-3" /> Private Key
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setSshAuthMethod('password')}
                                    className={`px-2.5 py-1 flex items-center gap-1 border-l border-[#1e293b] transition-colors ${
                                      sshAuthMethod === 'password' ? 'bg-cyan-600/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                                  >
                                    <Lock className="w-3 h-3" /> Password
                                  </button>
                                </div>
                              </div>

                              {sshAuthMethod === 'key' ? (
                                <div>
                                  <label className={labelClass}>Private Key Path</label>
                                  <PathInput
                                    value={sshKeyPath}
                                    onChange={setSshKeyPath}
                                    placeholder="~/.ssh/id_rsa"
                                    inputClass={`${inputClass} font-mono`}
                                    actions={[
                                      {
                                        label: 'Browse for private key',
                                        icon: <FolderOpen className="w-3.5 h-3.5" />,
                                        options: { multiple: false, defaultPath: '~/.ssh' },
                                      },
                                    ]}
                                  />
                                  <p className="text-[10px] text-slate-600 mt-1">Key must be unencrypted (no passphrase).</p>
                                </div>
                              ) : (
                                <div>
                                  <label className={labelClass}>SSH Password</label>
                                  <input
                                    type="password"
                                    value={sshPassword}
                                    onChange={(e) => setSshPassword(e.target.value)}
                                    className={inputClass}
                                    autoComplete="new-password"
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                  />
                                </div>
                              )}
                            </div>

                            {/* Jump host — advanced/rare, collapsed by default. */}
                            <div>
                              <label className="flex items-center gap-2 text-[10px] text-slate-400 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={showJumpHost}
                                  onChange={(e) => { setShowJumpHost(e.target.checked); if (!e.target.checked) setJumpHost(''); }}
                                  className="accent-cyan-500"
                                />
                                <ArrowRightLeft className="w-3 h-3" />
                                Route through an additional jump host
                              </label>
                              {showJumpHost && (
                                <div className="mt-2">
                                  <input
                                    value={jumpHost}
                                    onChange={(e) => setJumpHost(e.target.value)}
                                    placeholder="user@jumphost:22"
                                    className={`${inputClass} font-mono`}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    spellCheck={false}
                                  />
                                  <p className="text-[10px] text-slate-600 mt-1">
                                    Hops through this host first, then to the SSH host above. Reuses the same key/password.
                                  </p>
                                </div>
                              )}
                            </div>

                            {/* Test just the SSH hop — separate from the footer's
                                "Test Connection", which only runs after the tunnel
                                (if any) is already up. */}
                            <div className="flex items-center gap-2 pt-1">
                              <button
                                type="button"
                                onClick={handleTestSsh}
                                disabled={sshTesting || !sshHost || !sshUser}
                                className="px-2.5 py-1.5 rounded-md text-[11px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-300 flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                              >
                                {sshTesting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Terminal className="w-3 h-3 text-cyan-400" />}
                                Test SSH Connection
                              </button>
                              {sshTesting && (
                                <span className="text-[10px] text-slate-500">Connecting…</span>
                              )}
                              {!sshTesting && sshTestResult?.success && (
                                <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium min-w-0">
                                  <Check className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{sshTestResult.message}</span>
                                  {sshTestResult.latencyMs !== undefined && (
                                    <span className="font-mono text-slate-500">({sshTestResult.latencyMs}ms)</span>
                                  )}
                                </span>
                              )}
                              {!sshTesting && sshTestResult && !sshTestResult.success && (
                                <span className="flex items-start gap-1 text-[10px] text-red-400 font-medium min-w-0">
                                  <X className="w-3 h-3 shrink-0 mt-0.5" />
                                  <span className="break-words">{sshTestResult.message}</span>
                                </span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <p className="text-[10px] text-slate-600">
                            Enable to route the database connection through an SSH bastion.
                          </p>
                        )}
                      </div>

                      {/* SSL Mode — Postgres/MySQL/SQL Server only; Redis has its
                          own inline "Use TLS (rediss://)" toggle in Connection.
                          Lives below the SSH tunnel: it governs the leg from the
                          tunnel's local forward (or straight from this machine,
                          when no tunnel is set) to the database itself. */}
                      {isNetworked && (
                        <div className="border-t border-[#1e293b] pt-5">
                          <label className={labelClass}>SSL Mode</label>
                          <select value={sslMode} onChange={(e) => setSslMode(e.target.value)} className={inputClass}>
                            <option value="">Default</option>
                            {SSL_MODES[getEngineFamily(engine)]?.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ═══ TAGS ══════════════════════════════════════════════════ */}
            {validSection === 'tags' && (
              <div>
                <SectionHeader icon={<TagIcon className="w-4 h-4" />} title="Tags" desc="Group this connection in the Explorer sidebar." />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTagId(null)}
                    className={`text-[10px] font-semibold px-2 py-1 rounded-md border transition-colors ${
                      tagId === null
                        ? 'border-slate-500 bg-slate-500/15 text-slate-200'
                        : 'border-[#1e293b] text-slate-500 hover:text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    None
                  </button>
                  {tags.map((t) => {
                    const selected = tagId === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTagId(selected ? null : t.id)}
                        className="text-[10px] font-semibold px-2 py-1 rounded-md border transition-all flex items-center gap-1.5"
                        style={{
                          backgroundColor: selected ? hexToRgba(t.color, 0.2) : hexToRgba(t.color, 0.08),
                          borderColor: selected ? t.color : hexToRgba(t.color, 0.3),
                          color: selected ? t.color : hexToRgba(t.color, 0.9),
                        }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}


          </div>
        </form>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#1e293b] flex items-center justify-between gap-3 shrink-0 bg-[#06090e]">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={handleTestConnection}
              disabled={testing}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-300 flex items-center gap-1.5 disabled:opacity-50 transition-colors shrink-0"
            >
              {testing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : isS3 ? <Cloud className="w-3.5 h-3.5" /> : <Database className="w-3.5 h-3.5" />}
              Test Connection
            </button>
            {/* Inline test result — a simple text + icon right next to the
                button instead of a full alert banner. Success shows a green
                check + latency; failure shows a red icon + short message (the
                full copyable error still renders in the banner area below the
                footer for long messages). */}
            {testing && (
              <span className="flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0">
                <RefreshCw className="w-3 h-3 animate-spin" />
                Testing…
              </span>
            )}
            {!testing && testResult?.success && (
              <span
                className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium min-w-0 animate-[erd-edge-in_0.2s_ease-out]"
                title={testResult.server_version || testResult.message}
              >
                <Check className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{testResult.message}</span>
                {testResult.latency_ms !== undefined && (
                  <span className="font-mono text-[10px] text-slate-500 shrink-0">{testResult.latency_ms}ms</span>
                )}
              </span>
            )}
            {!testing && testResult && !testResult.success && (
              <span className="flex items-center gap-1.5 text-[11px] text-red-400 font-medium shrink-0" title={testResult.message}>
                <X className="w-3.5 h-3.5 shrink-0" />
                <span>Failed</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setConnectionModalOpen(false)} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button onClick={handleSave} className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors">
              Save Connection
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
