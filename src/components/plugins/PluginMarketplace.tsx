import React from 'react';
import { Puzzle, CheckCircle2, Download, ExternalLink } from 'lucide-react';

interface PluginItem {
  id: string;
  name: string;
  category: 'Driver' | 'AI Provider' | 'Exporter' | 'Theme';
  version: string;
  description: string;
  author: string;
  installed: boolean;
}

const pluginsList: PluginItem[] = [
  {
    id: 'plugin_redis',
    name: 'Redis Key-Value Driver',
    category: 'Driver',
    version: '1.2.0',
    description: 'Native driver extension supporting Redis cluster monitoring and key search.',
    author: 'rdSQL Core Team',
    installed: true,
  },
  {
    id: 'plugin_mongo',
    name: 'MongoDB Document Driver',
    category: 'Driver',
    version: '2.0.1',
    description: 'BSON document inspector, aggregation pipeline generator, and collection query builder.',
    author: 'Community',
    installed: false,
  },
  {
    id: 'plugin_clickhouse',
    name: 'ClickHouse Analytics Engine',
    category: 'Driver',
    version: '1.0.5',
    description: 'High performance analytical query engine with native columnar viewer.',
    author: 'rdSQL Core Team',
    installed: false,
  },
  {
    id: 'plugin_theme_dracula',
    name: 'Dracula Midnight Theme',
    category: 'Theme',
    version: '3.1.0',
    description: 'Vibrant dark theme palette inspired by Dracula Pro.',
    author: 'Dracula Theme',
    installed: true,
  },
];

export const PluginMarketplace: React.FC = () => {
  return (
    <div className="w-full h-full bg-[#06090e] p-6 overflow-y-auto flex flex-col gap-6 select-none">
      {/* Header */}
      <div className="border-b border-[#1e293b] pb-4">
        <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
          <Puzzle className="w-5 h-5 text-blue-400" />
          rdSQL Plugin Ecosystem
        </h2>
        <p className="text-xs text-slate-400">
          Extend rdSQL with custom database drivers, AI models, custom themes, and formatters.
        </p>
      </div>

      {/* Plugins Grid */}
      <div className="grid grid-cols-2 gap-4">
        {pluginsList.map((plugin) => (
          <div
            key={plugin.id}
            className="p-5 bg-[#0a0f18] border border-[#1e293b] rounded-2xl flex flex-col justify-between hover:border-slate-700 transition-colors"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-slate-100">{plugin.name}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400">
                  {plugin.category}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">{plugin.description}</p>
            </div>

            <div className="pt-3 border-t border-[#1e293b] flex items-center justify-between text-xs">
              <span className="text-[11px] text-slate-500 font-mono">v{plugin.version} • by {plugin.author}</span>

              {plugin.installed ? (
                <span className="flex items-center gap-1 text-emerald-400 text-xs font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Installed
                </span>
              ) : (
                <button
                  onClick={() => alert(`Installing ${plugin.name}...`)}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium flex items-center gap-1.5 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Install Plugin
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
