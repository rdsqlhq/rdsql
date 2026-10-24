import React from 'react';
import { Puzzle, Cloud, Sparkles, HardDrive, RefreshCw, Plus, CheckCircle2, CircleDashed } from 'lucide-react';
import { ENGINE_REGISTRY } from '../../core/connection/engines';
import { EngineIcon } from '../common/EngineIcon';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useStorageStore } from '../../store/useStorageStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { isAIConfigured } from '../../core/ai/types';
import { checkForUpdateAndNotify } from '../../core/updater';
import { useAppVersion } from '../../core/hooks/useAppVersion';
import { CLOUD_SYNC_ENABLED } from '../../core/config/edition';

const FAMILY_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL protocol',
  mysql: 'MySQL protocol',
  sqlite: 'SQLite',
  duckdb: 'DuckDB',
  mssql: 'SQL Server (TDS)',
};

/** What this build supports and what is set up: the built-in database
 *  drivers with how many saved connections use each, and the status of the
 *  optional integrations (cloud sync when enabled, AI assistant, S3 storage,
 *  updates). */
export const IntegrationsView: React.FC = () => {
  const connections = useConnectionStore((s) => s.connections);
  const setConnectionModalOpen = useConnectionStore((s) => s.setConnectionModalOpen);
  const storageCount = useStorageStore((s) => s.connections.length);
  const ai = useSettingsStore((s) => s.ai);
  const { status, email, cloudConfigured } = useAuthStore();
  const setSettingsModalOpen = useWorkspaceStore((s) => s.setSettingsModalOpen);
  const version = useAppVersion();

  const countFor = (engine: string) => connections.filter((c) => c.engine === engine).length;
  const aiReady = isAIConfigured(ai);

  const integrations: {
    id: string;
    icon: React.ComponentType<{ className?: string }>;
    name: string;
    active: boolean;
    status: string;
    action?: { label: string; run: () => void };
  }[] = [
    {
      id: 'sync',
      icon: Cloud,
      name: 'Cloud sync',
      active: status === 'signed-in',
      status:
        cloudConfigured === false
          ? 'Not available in this build (it was built without the rdSQL cloud key).'
          : status === 'signed-in'
            ? `Signed in as ${email}. Connections, credentials and settings sync end-to-end encrypted.`
            : 'Signed out. Sign in to sync connections and settings across devices.',
      action: cloudConfigured === false ? undefined : { label: status === 'signed-in' ? 'Account' : 'Sign in', run: () => setSettingsModalOpen(true, 'account') },
    },
    {
      id: 'ai',
      icon: Sparkles,
      name: 'AI assistant',
      active: aiReady,
      status: aiReady ? `Using ${ai.provider} · ${ai.model}.` : 'Not configured. Add a provider and API key to draft and fix SQL.',
      action: { label: aiReady ? 'Settings' : 'Configure', run: () => setSettingsModalOpen(true, 'ai') },
    },
    {
      id: 's3',
      icon: HardDrive,
      name: 'S3-compatible storage',
      active: storageCount > 0,
      status:
        storageCount > 0
          ? `${storageCount} storage connection${storageCount === 1 ? '' : 's'}. Browse buckets and store backups.`
          : 'No storage connections. Add one from the Explorer sidebar (Storage section).',
    },
    {
      id: 'updates',
      icon: RefreshCw,
      name: 'Updates',
      active: true,
      status: `rdSQL ${version ? `v${version}` : ''}. Updates are signed and installed in-app.`,
      action: { label: 'Check now', run: () => void checkForUpdateAndNotify(false) },
    },
  ];

  return (
    <div className="w-full h-full bg-[#06090e] p-6 overflow-y-auto flex flex-col gap-6 select-none">
      <div className="border-b border-[#1e293b] pb-4">
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Puzzle className="w-5 h-5 text-blue-400" />
          Drivers &amp; Integrations
        </h2>
        <p className="text-xs text-slate-400">
          Everything below ships with rdSQL. There is nothing to install.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Integrations</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {integrations.filter((it) => CLOUD_SYNC_ENABLED || it.id !== 'sync').map((it) => {
            const Icon = it.icon;
            return (
              <div key={it.id} className="p-4 bg-[#0a0f18] border border-[#1e293b] rounded-xl flex gap-3">
                <Icon className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{it.name}</span>
                    {it.active ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <CircleDashed className="w-3.5 h-3.5 text-slate-500" />
                    )}
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed mt-1">{it.status}</p>
                </div>
                {it.action && (
                  <button
                    onClick={it.action.run}
                    className="self-start px-2.5 py-1 rounded-lg bg-[#141e33] hover:bg-[#1e293b] text-xs text-slate-200 whitespace-nowrap"
                  >
                    {it.action.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">Database drivers</h3>
          <button
            onClick={() => setConnectionModalOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs text-white"
          >
            <Plus className="w-3.5 h-3.5" /> New connection
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {ENGINE_REGISTRY.map((e) => {
            const n = countFor(e.id);
            return (
              <div key={e.id} className="p-3 bg-[#0a0f18] border border-[#1e293b] rounded-xl flex items-center gap-3">
                <EngineIcon engine={e.id} className="w-6 h-6 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-100 truncate">{e.label}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {e.family ? FAMILY_LABEL[e.family] : 'Built-in browser'}
                    {n > 0 ? ` · ${n} connection${n === 1 ? '' : 's'}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
