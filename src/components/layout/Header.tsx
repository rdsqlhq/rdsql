import React from 'react';
import {
  Search,
  Sparkles,
  Puzzle,
  Settings,
  PanelBottom,
  PanelBottomClose,
  FileCode,
  Shield,
  Activity,
  ArrowLeftRight,
  ZoomIn,
  ZoomOut,
  UserCircle,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useTabStore } from '../../store/useTabStore';
import { useAuthStore } from '../../store/useAuthStore';
import { ActiveView } from '../../core/domain/types';

const navItems: { id: ActiveView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'plugins', label: 'Plugin Ecosystem', icon: Puzzle },
];

export const Header: React.FC = () => {
  const {
    activeView,
    setActiveView,
    isAIPanelOpen,
    toggleAIPanel,
    isOutputConsoleOpen,
    toggleOutputConsole,
    openEncryptedConnectionsModal,
    isSettingsModalOpen,
    setSettingsModalOpen,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetZoom,
  } = useWorkspaceStore();
  const { openSqlTab } = useTabStore();
  const authStatus = useAuthStore((s) => s.status);
  const authEmail = useAuthStore((s) => s.email);

  return (
    <header className="h-12 bg-[#0a0f18] border-b border-[#1e293b] flex items-center justify-between px-3 shrink-0 text-xs select-none z-40">
      {/* Left: View Navigation */}
      <div className="flex items-center gap-3 min-w-0 shrink">
        {/* View Navigation */}
        <nav className="flex items-center gap-1 min-w-0 overflow-hidden">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                title={item.label}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33]'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden lg:inline">{item.label.split(' ')[0]}</span>
              </button>
            );
          })}

          <button
            onClick={() => {
              setActiveView('explorer');
              openSqlTab();
            }}
            title="Open SQL Editor"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors whitespace-nowrap shrink-0"
          >
            <FileCode className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden lg:inline">SQL Editor</span>
          </button>

          <button
            onClick={() => setActiveView(activeView === 'migration' ? 'explorer' : 'migration')}
            title="Compare & Sync Databases"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'migration'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33]'
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden lg:inline">Compare</span>
          </button>

          <button
            onClick={() => setActiveView(activeView === 'health' ? 'explorer' : 'health')}
            title="Database Health & Maintenance"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              activeView === 'health'
                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33]'
            }`}
          >
            <Activity className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden lg:inline">Health</span>
          </button>
        </nav>
      </div>

      {/* Center: Command Palette Trigger */}
      <button
        onClick={() => openSqlTab()}
        className="flex items-center gap-2 px-3 py-1 rounded-lg bg-[#0f172a] border border-[#1e293b] text-slate-400 hover:text-slate-200 hover:border-blue-500/50 text-xs transition-all w-9 sm:w-auto sm:min-w-[10rem] md:w-64 justify-center sm:justify-between shrink-0 mx-2"
      >
        <div className="flex items-center gap-2 whitespace-nowrap overflow-hidden">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline truncate">Quick command or SQL...</span>
        </div>
        <kbd className="hidden md:inline px-1.5 py-0.5 text-[10px] font-mono bg-[#1e293b] rounded text-slate-400 border border-[#334155] shrink-0">
          ⌘K
        </kbd>
      </button>

      {/* Right: AI Studio & Settings */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Bottom Output Panel toggle */}
        <button
          onClick={toggleOutputConsole}
          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
            isOutputConsoleOpen
              ? 'text-blue-400 hover:bg-[#141e33]'
              : 'text-slate-500 hover:text-slate-200 hover:bg-[#141e33]'
          }`}
          title={isOutputConsoleOpen ? 'Hide Output Panel' : 'Show Output Panel'}
        >
          {isOutputConsoleOpen ? (
            <PanelBottomClose className="w-4 h-4" />
          ) : (
            <PanelBottom className="w-4 h-4" />
          )}
        </button>

        <div className="h-4 w-px bg-[#1e293b] my-auto" />

        {/* Zoom Controls */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={zoomOut}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors"
            title="Zoom Out (⌘-)"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            onClick={resetZoom}
            className="px-1.5 py-1 rounded-lg text-[10px] font-mono font-semibold text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors min-w-[36px] text-center"
            title="Reset Zoom (⌘0)"
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            onClick={zoomIn}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141e33] transition-colors"
            title="Zoom In (⌘+)"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>

        <div className="h-4 w-px bg-[#1e293b] my-auto" />

        {/* AI Assistant Button */}
        <button
          onClick={toggleAIPanel}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg transition-all whitespace-nowrap shrink-0 ${
            isAIPanelOpen
              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
              : 'bg-[#0f172a] text-slate-300 hover:bg-[#141e33] border border-[#1e293b]'
          }`}
          title="AI Assistant"
        >
          <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="hidden lg:inline">AI Assistant</span>
        </button>

        <div className="h-4 w-px bg-[#1e293b] my-auto" />

        {/* Account / sign-in status — opens Settings straight to the Account tab */}
        <button
          onClick={() => setSettingsModalOpen(true, 'account')}
          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
            authStatus === 'signed-in' ? 'text-blue-400 hover:bg-[#141e33]' : 'text-slate-400 hover:text-slate-200 hover:bg-[#141e33]'
          }`}
          title={authStatus === 'signed-in' ? `Signed in as ${authEmail}` : 'Sign in'}
        >
          <UserCircle className="w-4 h-4" />
        </button>

        <div className="h-4 w-px bg-[#1e293b] my-auto" />

        <button
          onClick={() => setSettingsModalOpen(true)}
          className={`p-1.5 rounded-lg transition-colors shrink-0 ${
            isSettingsModalOpen
              ? 'bg-blue-600 text-white'
              : 'hover:bg-[#141e33] text-slate-400 hover:text-slate-200'
          }`}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
