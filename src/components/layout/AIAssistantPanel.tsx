import React, { useState, useRef, useEffect } from 'react';
import {
  Sparkles,
  Send,
  Copy,
  X,
  Trash2,
  Check,
  Settings as SettingsIcon,
  AlertTriangle,
  Play,
  Database as DatabaseIcon,
  Wand2,
  ExternalLink,
  ChevronDown,
  CornerDownLeft,
  RotateCw,
} from 'lucide-react';
import { useAIStore } from '../../store/useAIStore';
import { useTabStore } from '../../store/useTabStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { PRESET_BY_ID } from '../../core/ai/providers';
import { isAIConfigured } from '../../core/ai/types';
import { getActiveTarget } from '../../core/ai/schemaContext';
import { ConfirmRunDialog } from '../ai/ConfirmRunDialog';

export const AIAssistantPanel: React.FC = () => {
  const {
    messages,
    isGenerating,
    sendMessage,
    clearHistory,
    pendingRun,
    runMessageSQL,
    confirmRun,
    cancelRun,
    resolveProposal,
  } = useAIStore();
  const { addTab, updateTabSql, tabs, activeTabId } = useTabStore();
  const { isAIPanelOpen, toggleAIPanel, setSettingsModalOpen } = useWorkspaceStore();
  const ai = useSettingsStore((s) => s.ai);

  // Active connection indicator — re-read on every render so the header
  // reflects tab switches immediately.
  const target = isAIPanelOpen ? getActiveTarget() : { connection: undefined, database: undefined };

  const [inputPrompt, setInputPrompt] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // "New message" jump bubble — shown when a message arrives while the user
  // has scrolled up to read earlier history, instead of yanking their scroll
  // position to the bottom out from under them.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(messages.length);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 80;
    isAtBottomRef.current = atBottom;
    if (atBottom && newMessageCount > 0) setNewMessageCount(0);
  };

  const jumpToNewMessages = () => {
    scrollToBottom('smooth');
    setNewMessageCount(0);
  };

  useEffect(() => {
    const delta = messages.length - prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (delta <= 0) return;

    if (isAtBottomRef.current) {
      requestAnimationFrame(() => scrollToBottom('smooth'));
    } else {
      setNewMessageCount((n) => n + delta);
    }
  }, [messages.length]);

  // Opening the panel should land on the latest message, matching the
  // isAtBottomRef default — otherwise the first incoming message would
  // wrongly auto-scroll (or wrongly show the badge) depending on history length.
  useEffect(() => {
    if (!isAIPanelOpen) return;
    requestAnimationFrame(() => scrollToBottom('auto'));
  }, [isAIPanelOpen]);

  if (!isAIPanelOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPrompt.trim() || isGenerating) return;
    sendMessage(inputPrompt.trim());
    setInputPrompt('');
  };

  const handleCopySql = (sql: string, id: string) => {
    navigator.clipboard.writeText(sql);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Insert the AI's SQL into the active SQL-editor tab — the "apply it" step
  // for the Create View/Trigger/Procedure/Event flow (those are SQL-editor
  // tabs seeded with a template). Falls back to opening a new tab when the
  // active tab isn't a SQL editor (e.g. a data-grid tab is focused).
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const canInsertIntoActive = activeTab?.tabType === 'sql_editor';
  const handleInsertIntoEditor = (sql: string) => {
    if (canInsertIntoActive && activeTab) {
      updateTabSql(activeTab.id, sql);
    } else {
      const id = addTab('AI Query.sql', sql, true);
      void id;
    }
  };

  return (
    <aside className="w-full h-full bg-[#0a0f18] border-l border-[#1e293b] flex flex-col z-20 select-none">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-[#1e293b] flex items-center justify-between bg-[#06090e]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-md bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shrink-0">
            <Sparkles className="w-3.5 h-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-bold text-slate-200">AI Database Assistant</div>
            <div className="text-[10px] text-slate-500 truncate flex items-center gap-1">
              {isAIConfigured(ai) ? (
                <span className="truncate">
                  {PRESET_BY_ID[ai.provider].label} • {ai.model}
                </span>
              ) : (
                <span>No provider configured</span>
              )}
            </div>
            <div className="text-[10px] truncate flex items-center gap-1 mt-0.5">
              {target.connection ? (
                <>
                  <DatabaseIcon className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                  <span className="text-emerald-400/80 truncate">
                    {target.connection.name}
                    {target.database ? ` → ${target.database}` : ''}
                  </span>
                </>
              ) : (
                <>
                  <DatabaseIcon className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                  <span className="text-amber-400/80">No active connection</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setSettingsModalOpen(true, 'ai')}
            className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-[#1e293b] transition-colors"
            title="AI Settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={clearHistory}
            className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-[#1e293b] transition-colors"
            title="Clear Chat History"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleAIPanel}
            className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-[#1e293b] transition-colors"
            title="Close Panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Messages List */}
      <div
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
        className="flex-1 overflow-y-auto p-3 flex flex-col gap-3"
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1.5 max-w-[92%] ${
              msg.sender === 'user' ? 'self-end' : 'self-start'
            }`}
          >
            <div className="flex items-center gap-1 text-[10px] text-slate-500">
              <span>{msg.sender === 'user' ? 'You' : 'rdSQL AI'}</span>
              <span>•</span>
              <span>{msg.timestamp}</span>
            </div>

            <div
              className={`p-3 rounded-xl text-xs leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-blue-600 text-white rounded-br-none shadow-md shadow-blue-600/20'
                  : msg.kind === 'error'
                    ? 'bg-rose-500/10 border border-rose-500/30 text-rose-200 rounded-bl-none'
                    : msg.kind === 'setup-nudge'
                      ? 'bg-amber-500/10 border border-amber-500/30 text-amber-100 rounded-bl-none'
                      : msg.proposal
                        ? msg.proposal.kind === 'fix'
                          ? 'bg-cyan-500/5 border border-cyan-500/25 text-slate-200 rounded-bl-none'
                          : 'bg-violet-500/5 border border-violet-500/25 text-slate-200 rounded-bl-none'
                        : 'bg-[#141e33] border border-[#1e293b] text-slate-200 rounded-bl-none'
              }`}
            >
              {msg.kind === 'error' && (
                <div className="flex items-start gap-1.5 mb-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                  <span className="text-[10px] font-semibold text-rose-300 uppercase tracking-wide">Error</span>
                </div>
              )}
              <div>{msg.content}</div>

              {msg.kind === 'error' && msg.retry && (
                <button
                  onClick={() => msg.retry?.()}
                  disabled={isGenerating}
                  className="mt-2.5 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-200 text-[11px] font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  Resend
                </button>
              )}

              {msg.kind === 'setup-nudge' && (
                <button
                  onClick={() => setSettingsModalOpen(true, 'ai')}
                  className="mt-2.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <SettingsIcon className="w-3.5 h-3.5" />
                  Configure AI
                </button>
              )}

              {msg.sqlSnippet && (
                <div className="mt-2.5 bg-[#06090e] border border-[#1e293b] rounded-lg p-2 font-mono text-[11px] text-cyan-300 relative group">
                  <pre className="overflow-x-auto whitespace-pre-wrap">{msg.sqlSnippet}</pre>

                  <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-[#1e293b] flex-nowrap overflow-x-auto">
                    <button
                      onClick={() => handleCopySql(msg.sqlSnippet!, msg.id)}
                      className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded bg-[#1e293b] hover:bg-[#334155] text-slate-300 hover:text-white text-[10px] flex items-center gap-1 transition-colors"
                    >
                      {copiedId === msg.id ? (
                        <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                      ) : (
                        <Copy className="w-3 h-3 shrink-0" />
                      )}
                      {copiedId === msg.id ? 'Copied' : 'Copy'}
                    </button>

                    {/* Run on active connection — safe queries run immediately,
                        destructive ones open a confirmation dialog first. */}
                    {msg.sqlRunnable ? (
                      <button
                        onClick={() => runMessageSQL(msg.id)}
                        disabled={!target.connection}
                        className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white text-[10px] flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={
                          target.connection
                            ? `Run on ${target.connection.name}`
                            : 'No active connection'
                        }
                      >
                        <Play className="w-3 h-3 shrink-0" />
                        Run
                      </button>
                    ) : (
                      msg.sqlSnippet && (
                        <span className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded text-emerald-400/60 text-[10px] flex items-center gap-1">
                          <Check className="w-3 h-3 shrink-0" />
                          Executed
                        </span>
                      )
                    )}

                    {/* Insert into the active SQL-editor tab — the "apply" step
                        for Create View/Trigger/Procedure/Event tabs. Disabled
                        when the active tab isn't a SQL editor. */}
                    <button
                      onClick={() => handleInsertIntoEditor(msg.sqlSnippet!)}
                      disabled={!canInsertIntoActive}
                      title={
                        canInsertIntoActive
                          ? 'Insert into the active editor tab'
                          : 'No active SQL editor tab — switch to one first'
                      }
                      className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded bg-violet-600/30 hover:bg-violet-600 text-violet-300 hover:text-white text-[10px] flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                    >
                      <CornerDownLeft className="w-3 h-3 shrink-0" />
                      Insert
                    </button>

                    <button
                      onClick={() => addTab('AI Query.sql', msg.sqlSnippet, true)}
                      title="Open in a new editor tab"
                      className="shrink-0 whitespace-nowrap px-2 py-0.5 rounded bg-blue-600/30 hover:bg-blue-600 text-blue-300 hover:text-white text-[10px] flex items-center gap-1 transition-colors"
                    >
                      <ExternalLink className="w-3 h-3 shrink-0" />
                      Editor
                    </button>
                  </div>
                </div>
              )}

              {/* AI Fix / Improve proposal — before/after SQL with Apply/Discard,
                  inline in the chat instead of a separate modal so the whole
                  exchange (including what was applied or discarded) stays in
                  the conversation history. */}
              {msg.proposal && (
                <div className="mt-2.5 space-y-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
                    {msg.proposal.kind === 'fix' ? (
                      <>
                        <Wand2 className="w-3 h-3 text-cyan-400" />
                        <span className="text-cyan-300">Suggested fix</span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3 h-3 text-violet-400" />
                        <span className="text-violet-300">Suggested improvement</span>
                      </>
                    )}
                  </div>

                  {msg.proposal.errorMessage && (
                    <div>
                      <div className="text-[9px] text-red-400 font-semibold uppercase tracking-wide mb-1">
                        Original error
                      </div>
                      <pre className="bg-red-500/5 border border-red-500/20 rounded-lg p-2 text-[10.5px] font-mono text-red-300/80 whitespace-pre-wrap break-all max-h-16 overflow-y-auto macos-scroll">
                        {msg.proposal.errorMessage}
                      </pre>
                    </div>
                  )}

                  <div>
                    <div className="text-[9px] text-slate-500 font-semibold uppercase tracking-wide mb-1">
                      {msg.proposal.kind === 'fix' ? 'Original SQL' : 'Current SQL'}
                    </div>
                    <pre className="bg-[#06090e] border border-[#1e293b] rounded-lg p-2 text-[10.5px] font-mono text-slate-500 whitespace-pre-wrap break-all max-h-20 overflow-y-auto macos-scroll line-through opacity-70">
                      {msg.proposal.originalSql}
                    </pre>
                  </div>

                  <div>
                    <div className="text-[9px] text-emerald-400 font-semibold uppercase tracking-wide mb-1">
                      {msg.proposal.kind === 'fix' ? 'Proposed fix' : 'Suggested version'}
                    </div>
                    <pre className="bg-emerald-500/5 border border-emerald-500/30 rounded-lg p-2 text-[10.5px] font-mono text-emerald-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto macos-scroll">
                      {msg.proposal.proposedSql}
                    </pre>
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-slate-500">
                    <DatabaseIcon className="w-3 h-3 text-blue-400 shrink-0" />
                    <span>
                      {msg.proposal.connectionName}
                      {msg.proposal.databaseName ? ` → ${msg.proposal.databaseName}` : ''}
                    </span>
                  </div>

                  {msg.proposal.resolution ? (
                    <div
                      className={`text-[10px] flex items-center gap-1 font-medium ${
                        msg.proposal.resolution === 'applied' ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                    >
                      {msg.proposal.resolution === 'applied' ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                      {msg.proposal.resolution === 'applied' ? 'Applied to editor' : 'Discarded'}
                    </div>
                  ) : (
                    <div className="pt-0.5 space-y-1">
                      <div className="flex items-center gap-1.5 flex-nowrap">
                        <button
                          onClick={() => resolveProposal(msg.id, 'discard')}
                          className="shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg bg-[#1e293b] hover:bg-[#334155] text-slate-300 text-[10px] font-semibold transition-colors"
                        >
                          Discard
                        </button>
                        <button
                          onClick={() => resolveProposal(msg.id, 'apply')}
                          className={`shrink-0 whitespace-nowrap px-2.5 py-1 rounded-lg text-white text-[10px] font-semibold flex items-center gap-1 transition-colors ${
                            msg.proposal.kind === 'fix'
                              ? 'bg-cyan-600 hover:bg-cyan-500'
                              : 'bg-violet-600 hover:bg-violet-500'
                          }`}
                        >
                          <Check className="w-3 h-3 shrink-0" />
                          Apply
                        </button>
                      </div>
                      <span className="block text-[9px] text-slate-600">Doesn't auto-run — press Run yourself after applying.</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {isGenerating && (
          <div className="self-start flex items-center gap-2 p-3 bg-[#141e33] rounded-xl border border-[#1e293b] text-xs text-slate-400">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            <span>Waiting for AI response…</span>
          </div>
        )}

        {/* New-message jump bubble — sticky so it stays pinned above the
            fold while the user is scrolled up reading earlier messages. */}
        {newMessageCount > 0 && (
          <button
            onClick={jumpToNewMessages}
            className="sticky bottom-1 self-center z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-cyan-600 hover:bg-cyan-500 text-white text-[11px] font-semibold shadow-lg shadow-cyan-600/30 transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            {newMessageCount === 1 ? 'New message' : `${newMessageCount} new messages`}
          </button>
        )}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} className="p-3 border-t border-[#1e293b] bg-[#06090e]">
        <div className="relative flex items-center">
          <input
            type="text"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder="Ask AI to write SQL or analyze schema..."
            value={inputPrompt}
            onChange={(e) => setInputPrompt(e.target.value)}
            disabled={isGenerating}
            className="w-full bg-[#0f172a] border border-[#1e293b] focus:border-cyan-500 rounded-xl text-xs text-slate-200 pl-3 pr-9 py-2 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={!inputPrompt.trim() || isGenerating}
            className="absolute right-1.5 p-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold transition-all disabled:opacity-30 disabled:bg-slate-700"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>

      {/* Destructive-run confirmation — the only remaining modal; SQL
          fix/improve proposals render inline in the message list above. */}
      {pendingRun && (
        <ConfirmRunDialog
          pending={pendingRun}
          onConfirm={() => void confirmRun()}
          onCancel={cancelRun}
        />
      )}
    </aside>
  );
};
