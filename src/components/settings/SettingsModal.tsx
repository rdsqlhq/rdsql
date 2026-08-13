import React, { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
  Database,
  Cloud,
  Trash2,
  CheckCircle2,
  ScrollText,
  X,
  Sparkles,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  AlertCircle,
  UserCircle,
} from 'lucide-react';
import { useSettingsStore } from '../../store/useSettingsStore';
import { AccountSettingsTab } from './AccountSettingsTab';
import { Toggle } from './Toggle';
import { useStorageStore } from '../../store/useStorageStore';
import { useQueryLogStore } from '../../store/useQueryStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { getTransferManager } from '../../core/storage/react';
import { formatBytes } from '../storage/format';
import { ModelCombobox } from '../common/ModelCombobox';
import { PROVIDER_PRESETS, PRESET_BY_ID } from '../../core/ai/providers';
import { AIError, isAIConfigured, type AIProvider, type ModelInfo } from '../../core/ai/types';
import { testConnection, fetchModels } from '../../core/ai/client';

type SettingsTab = 'account' | 'query' | 'storage' | 'log' | 'data' | 'security' | 'ai';

const TABS: { id: SettingsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'account', label: 'Account', icon: UserCircle },
  { id: 'ai', label: 'AI Assistant', icon: Sparkles },
  { id: 'query', label: 'Query Execution', icon: Terminal },
  { id: 'storage', label: 'S3 Storage', icon: Cloud },
  { id: 'log', label: 'Global SQL Log', icon: ScrollText },
  { id: 'data', label: 'Application Data', icon: Database },
  { id: 'security', label: 'Security', icon: ShieldCheck },
];

/**
 * The application settings modal. Each category is a tab (VS Code-style left
 * rail + content pane) so the user never has to scroll through sections.
 * Rendered as a global overlay alongside AboutModal.
 */
export const SettingsModal: React.FC = () => {
  const { isSettingsModalOpen, setSettingsModalOpen, settingsModalInitialTab } = useWorkspaceStore();
  useEscapeToClose(isSettingsModalOpen ? () => setSettingsModalOpen(false) : null);

  const {
    rowLimit, execTimeoutSec, s3PreviewMaxBytes, setRowLimit, setExecTimeoutSec, setS3PreviewMaxBytes,
    showSystemSchemas, setShowSystemSchemas,
    showGlobalLogs, sqlLogColorCoding, sqlLogFullText,
    setShowGlobalLogs, setSqlLogColorCoding, setSqlLogFullText,
    ai, setAIConfig,
  } = useSettingsStore();
  const storageConnCount = useStorageStore((s) => s.connections.length);
  const logCount = useQueryLogStore((s) => s.logs.length);
  const clearLogs = useQueryLogStore((s) => s.clearLogs);

  const [activeTab, setActiveTab] = useState<SettingsTab>('ai');
  // When the modal is opened with a requested initial tab (e.g. from the AI
  // panel's "Configure AI" button), honor it once.
  useEffect(() => {
    if (isSettingsModalOpen && settingsModalInitialTab) {
      const requested = settingsModalInitialTab as SettingsTab;
      if (TABS.some((t) => t.id === requested)) setActiveTab(requested);
    }
  }, [isSettingsModalOpen, settingsModalInitialTab]);

  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const flash = (msg: string) => {
    setSavedFlash(msg);
    setTimeout(() => setSavedFlash(null), 1500);
  };

  if (!isSettingsModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={() => setSettingsModalOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl h-[600px] max-h-[85vh] bg-[#06090e] border border-[#1e293b] rounded-2xl shadow-2xl flex flex-col overflow-hidden relative"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-[#1e293b] px-6 py-3.5 shrink-0">
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-blue-400" />
            <h2 className="text-base font-bold text-slate-100">rdSQL Settings</h2>
          </div>
          <button
            onClick={() => setSettingsModalOpen(false)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors shrink-0"
            title="Close Settings"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: left tab rail + right content pane */}
        <div className="flex-1 flex overflow-hidden">
          {/* Tab sidebar */}
          <nav className="w-48 shrink-0 bg-[#080c14] border-r border-[#1e293b] flex flex-col gap-0.5 p-2 select-none">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-left ${
                    isActive
                      ? 'bg-blue-600/15 text-blue-300 border border-blue-500/30'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33] border border-transparent'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-400' : ''}`} />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Content pane */}
          <div className="flex-1 overflow-y-auto p-6 select-none">
            {activeTab === 'account' && <AccountSettingsTab />}
            {activeTab === 'ai' && (
              <AISettingsTab
                ai={ai}
                setAIConfig={setAIConfig}
                flash={flash}
              />
            )}

            {activeTab === 'query' && (
              <div className="flex flex-col gap-4">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-blue-400" />
                  Query Execution
                </h3>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <LabeledNumber
                    label="Default Row Limit"
                    value={rowLimit}
                    onChange={(n) => { setRowLimit(n); flash('Row limit saved'); }}
                  />
                  <LabeledNumber
                    label="Execution Timeout (s)"
                    value={execTimeoutSec}
                    onChange={(n) => { setExecTimeoutSec(n); flash('Timeout saved'); }}
                  />
                </div>
                <p className="text-[10px] text-slate-600">
                  Note: these are stored preferences. Enforcing them at the executor is on the roadmap.
                </p>
                <Toggle
                  label="Show system schemas in Explorer"
                  description="Include pg_catalog/information_schema (Postgres) and information_schema/mysql/performance_schema/sys (MySQL) in the schema tree, instead of hiding them like most DB tools do by default."
                  checked={showSystemSchemas}
                  onChange={(v) => { setShowSystemSchemas(v); flash(v ? 'System schemas shown' : 'System schemas hidden'); }}
                />
              </div>
            )}

            {activeTab === 'storage' && (
              <div className="flex flex-col gap-4 text-xs text-slate-400">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-amber-400" />
                  S3 Storage
                </h3>
                <div className="flex items-center justify-between">
                  <span>Configured storage connections</span>
                  <span className="font-mono text-slate-300">{storageConnCount}</span>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">In-app Preview Size Limit (bytes)</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={s3PreviewMaxBytes}
                      onChange={(e) => setS3PreviewMaxBytes(Number(e.target.value))}
                      className="w-40 bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 font-mono text-xs"
                    />
                    <span className="text-[11px] text-slate-600">≈ {formatBytes(s3PreviewMaxBytes)}</span>
                  </div>
                  <p className="text-[10px] text-slate-600 mt-1">
                    Files larger than this refuse inline preview and offer download instead.
                  </p>
                </div>
                <p className="text-[10px] text-slate-600">
                  Add or edit storage connections from the Storage section in the Explorer sidebar.
                </p>
              </div>
            )}

            {activeTab === 'log' && (
              <div className="flex flex-col gap-2 text-xs text-slate-400">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2 mb-2">
                  <ScrollText className="w-4 h-4 text-indigo-400" />
                  Global SQL Log
                </h3>
                <Toggle
                  label="Show global log panel"
                  description="Display the SQL log panel at the bottom of the workspace. Turn off to hide it entirely until re-enabled here."
                  checked={showGlobalLogs}
                  onChange={(v) => { setShowGlobalLogs(v); flash(v ? 'Log panel enabled' : 'Log panel hidden'); }}
                />
                <Toggle
                  label="SQL syntax color coding"
                  description="Highlight keywords, strings, numbers, and comments in log entries with distinct colors."
                  checked={sqlLogColorCoding}
                  onChange={(v) => { setSqlLogColorCoding(v); flash('Color coding saved'); }}
                />
                <Toggle
                  label="Show full query text"
                  description="Render the complete statement in each entry (wrapping when long) instead of a truncated single-line preview."
                  checked={sqlLogFullText}
                  onChange={(v) => { setSqlLogFullText(v); flash('Full text saved'); }}
                />
              </div>
            )}

            {activeTab === 'data' && (
              <div className="flex flex-col gap-4 text-xs text-slate-400">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <Database className="w-4 h-4 text-emerald-400" />
                  Application Data
                </h3>
                <div className="flex items-center justify-between">
                  <span>SQL log entries</span>
                  <span className="font-mono text-slate-300">{logCount} / 200</span>
                </div>
                <button
                  onClick={() => {
                    if (confirm('Clear the SQL log? This cannot be undone.')) {
                      clearLogs();
                      flash('SQL log cleared');
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-red-300 bg-red-600/15 border border-red-600/30 hover:bg-red-600/25 w-fit"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear SQL Log
                </button>
                <button
                  onClick={() => {
                    getTransferManager().clearFinished();
                    flash('Finished transfers cleared');
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-slate-200 bg-[#141e33] hover:bg-[#1c2a45] w-fit"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear Finished Transfers
                </button>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="flex flex-col gap-3 text-xs text-slate-400">
                <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  Security
                </h3>
                <p>
                  S3 secret access keys are encrypted at rest with AES-256-GCM  before being
                  written to storage. A per-device key-encryption key (KEK) seals each secret;
                  plaintext is held in memory only for the duration of a transfer.
                </p>
                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-400 text-xs font-semibold">
                    AES-256-GCM Encryption Active
                  </span>
                </div>
                <p className="text-[10px] text-slate-600">
                  Database passwords are stored unencrypted in Storage today (unchanged from
                  prior versions). OS-keychain storage for all secrets is on the roadmap.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Save flash — pinned to the bottom of the modal */}
        {savedFlash && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600/20 border border-emerald-600/40 text-emerald-300 text-xs shadow-lg z-50">
            <CheckCircle2 className="w-3.5 h-3.5" /> {savedFlash}
          </div>
        )}
      </div>
    </div>
  );
};

const LabeledNumber: React.FC<{ label: string; value: number; onChange: (n: number) => void }> = ({
  label, value, onChange,
}) => (
  <div>
    <label className="block text-slate-400 mb-1">{label}</label>
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 font-mono text-xs"
    />
  </div>
);

// ── AI Assistant settings tab ──────────────────────────────────────────────

/** Local working copy of the AI config while the user edits it. Saved back via
 *  `setAIConfig` (which seals the API key) when "Save" is pressed. */
interface AIEditorState {
  provider: AIProvider;
  apiKey: string;   // plaintext while editing; sealed on save
  model: string;
  baseUrl: string;
}

const AISettingsTab: React.FC<{
  ai: ReturnType<typeof useSettingsStore.getState>['ai'];
  setAIConfig: ReturnType<typeof useSettingsStore.getState>['setAIConfig'];
  flash: (msg: string) => void;
}> = ({ ai, setAIConfig, flash }) => {
  const configured = isAIConfigured(ai);

  // Local editable state seeded from the persisted config. `apiKey` here is
  // always plaintext while editing (or empty when an existing sealed key is
  // present — we show a placeholder instead of revealing it).
  const [draft, setDraft] = useState<AIEditorState>({
    provider: ai.provider,
    apiKey: '',
    model: ai.model,
    baseUrl: ai.baseUrl || '',
  });
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // Track whether the user typed a new key (vs. left the existing sealed one).
  const [keyTouched, setKeyTouched] = useState(false);
  // Fetched model list for the current provider/key. Populated by "Fetch
  // Models" or "Test Connection" (which validates the token + lists models in
  // one call). Lets the user pick from a dropdown instead of typing.
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);

  // Switching provider resets every input — token, model, base URL, fetched
  // models, and any prior test result. The new provider's defaults are used
  // only as placeholders (shown when the field is empty), never written in.
  const onProviderChange = (provider: AIProvider) => {
    setDraft({ provider, apiKey: '', model: '', baseUrl: '' });
    setKeyTouched(false);
    setModels([]);
    setTestResult(null);
  };

  /** Resolve the plaintext key for an API call: when the user just typed a
   *  new key, return it so the client uses it directly (no sealing needed for
   *  a one-off test). Otherwise return undefined so the client decrypts the
   *  persisted sealed key. */
  const resolvePlaintextKey = (): string | undefined => {
    if (keyTouched) return draft.apiKey;
    return undefined;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await setAIConfig({
        provider: draft.provider,
        // Only persist the key if the user typed one. Otherwise keep the
        // existing sealed key by omitting the field.
        ...(keyTouched ? { apiKey: draft.apiKey } : {}),
        model: draft.model,
        baseUrl: draft.baseUrl,
      });
      setKeyTouched(false);
      setDraft((d) => ({ ...d, apiKey: '' }));
      flash('AI settings saved');
    } finally {
      setSaving(false);
    }
  };

  /** Fetch the model list for the current provider + key. Also validates the
   *  token: a 401/403 surfaces as a typed error. When `populateResult` is set
   *  the outcome (ok/fail + message) is written into `testResult` so the UI
   *  shows the status banner. Returns the fetched models (empty on failure). */
  const runFetchModels = async (opts: { showBanner: boolean }): Promise<ModelInfo[]> => {
    const testConfig = {
      provider: draft.provider,
      apiKey: ai.apiKey, // sealed; ignored when plaintextKey is passed
      model: draft.model,
      baseUrl: draft.baseUrl,
      enabled: true,
    };
    try {
      const list = await fetchModels(testConfig, resolvePlaintextKey());
      setModels(list);
      if (opts.showBanner) {
        setTestResult({
          ok: true,
          message:
            list.length > 0
              ? `Token valid — ${list.length} model${list.length === 1 ? '' : 's'} available.`
              : 'Token valid, but the provider returned no models.',
        });
      }
      return list;
    } catch (err) {
      const message =
        err instanceof AIError ? err.message : err instanceof Error ? err.message : 'Request failed.';
      if (opts.showBanner) setTestResult({ ok: false, message });
      return [];
    }
  };

  const handleFetchModels = async () => {
    setFetchingModels(true);
    setTestResult(null);
    try {
      await runFetchModels({ showBanner: true });
    } finally {
      setFetchingModels(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // testConnection lists models — validates the token AND populates the
      // dropdown in one cheap GET (no completion tokens spent).
      await testConnection(
        {
          provider: draft.provider,
          apiKey: ai.apiKey,
          model: draft.model,
          baseUrl: draft.baseUrl,
          enabled: true,
        },
        resolvePlaintextKey(),
      ).then((list) => {
        setModels(list);
        setTestResult({
          ok: true,
          message:
            list.length > 0
              ? `Connection OK — token valid. ${list.length} model${list.length === 1 ? '' : 's'} available.`
              : 'Connection OK — token valid.',
        });
      });
    } catch (err) {
      const message =
        err instanceof AIError ? err.message : err instanceof Error ? err.message : 'Test failed.';
      setTestResult({ ok: false, message });
    } finally {
      setTesting(false);
    }
  };

  const preset = PRESET_BY_ID[draft.provider];
  const hasKey = keyTouched ? draft.apiKey.trim().length > 0 : ai.apiKey.length > 0;
  const hasUrl = draft.provider !== 'custom' || draft.baseUrl.trim().length > 0;
  const canSave = hasKey && draft.model.trim().length > 0;
  const canFetchOrTest = hasKey && hasUrl;
  const busy = testing || fetchingModels;

  return (
    <div className="flex flex-col gap-4 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cyan-400" />
          AI Database Assistant
        </h3>
        <span
          className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold ${
            configured
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
              : 'bg-slate-500/15 text-slate-400 border border-slate-500/30'
          }`}
        >
          {configured ? 'Configured' : 'Not configured'}
        </span>
      </div>

      <p className="text-[11px] text-slate-500 leading-relaxed">
        Connect a large-language-model provider so the AI Assistant can write and explain SQL using
        your live schema. The API token is encrypted at rest (AES-256-GCM) before being stored — the
        same protection applied to S3 secret keys.
      </p>

      {/* Provider */}
      <div>
        <label className="block text-slate-400 mb-1">Provider</label>
        <select
          value={draft.provider}
          onChange={(e) => onProviderChange(e.target.value as AIProvider)}
          className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 text-xs focus:outline-none focus:border-cyan-500/50"
        >
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* API Token */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-slate-400">API Token</label>
          {preset.keyUrl && (
            <a
              href={preset.keyUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-cyan-400 hover:underline flex items-center gap-1"
            >
              Get a key <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            placeholder={
              ai.apiKey && !keyTouched ? '•••••••• (saved — retype to replace)' : 'Paste your API token'
            }
            value={draft.apiKey}
            onChange={(e) => {
              setDraft((d) => ({ ...d, apiKey: e.target.value }));
              setKeyTouched(true);
              setTestResult(null);
            }}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 pr-9 font-mono text-xs focus:outline-none focus:border-cyan-500/50"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300"
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Base URL */}
      <div>
        <label className="block text-slate-400 mb-1">
          Base URL {draft.provider === 'custom' && <span className="text-rose-400">*</span>}
        </label>
        <input
          type="text"
          placeholder={preset.defaultBaseUrl || 'https://your-endpoint/v1'}
          value={draft.baseUrl}
          onChange={(e) => {
            setDraft((d) => ({ ...d, baseUrl: e.target.value }));
            setTestResult(null);
          }}
          spellCheck={false}
          className="w-full bg-[#0f172a] border border-[#1e293b] rounded-lg text-slate-200 p-2 font-mono text-xs focus:outline-none focus:border-cyan-500/50"
        />
        <p className="text-[10px] text-slate-600 mt-1">
          Defaults to the provider's official endpoint. Override for self-hosted or proxy gateways.
          Custom providers must speak the OpenAI Chat Completions format.
        </p>
      </div>

      {/* Model — combobox: free-text input backed by a fetched datalist. */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-slate-400">Model</label>
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={!canFetchOrTest || busy}
            className="text-[10px] text-cyan-400 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
            title="Fetch the list of models available to your key"
          >
            {fetchingModels ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            Fetch Models
          </button>
        </div>
        <ModelCombobox
          value={draft.model}
          onChange={(v) => {
            setDraft((d) => ({ ...d, model: v }));
            setTestResult(null);
          }}
          options={models}
          placeholder={preset.defaultModel || 'e.g. gpt-4o'}
        />
        <p className="text-[10px] text-slate-600 mt-1">
          {models.length > 0
            ? `${models.length} model${models.length === 1 ? '' : 's'} fetched — pick from the list or type your own.`
            : 'Type a model id, or click Fetch Models to list what your key can access.'}
        </p>
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`flex items-start gap-2 p-2.5 rounded-lg text-[11px] ${
            testResult.ok
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
              : 'bg-rose-500/10 border border-rose-500/20 text-rose-300'
          }`}
        >
          {testResult.ok ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          )}
          <span className="break-words">{testResult.message}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          Save
        </button>
        <button
          onClick={handleTest}
          disabled={!canFetchOrTest || busy}
          className="px-4 py-2 rounded-lg bg-[#141e33] hover:bg-[#1c2a45] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title="Validate the token by listing available models"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          Test Token
        </button>
      </div>
    </div>
  );
};
