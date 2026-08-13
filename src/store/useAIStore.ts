import { create } from 'zustand';
import { generateSQL } from '../core/ai/client';
import { buildSchemaContext, getActiveTarget } from '../core/ai/schemaContext';
import { classifySQL } from '../core/ai/sqlSafety';
import { AIError, isAIConfigured } from '../core/ai/types';
import { useSettingsStore } from './useSettingsStore';
import { useTabStore } from './useTabStore';
import { useWorkspaceStore } from './useWorkspaceStore';

/** An AI-proposed SQL change (a fix for a failed query, or a suggested
 *  improvement to a working one) attached to an assistant message. Rendered
 *  inline in the chat bubble with Apply/Discard actions — not a separate
 *  modal — so the proposal stays in the conversation history either way. */
export interface SqlProposal {
  kind: 'fix' | 'improve';
  /** Id of the tab this SQL came from (so Apply knows where to write it back). */
  tabId: string;
  originalSql: string;
  proposedSql: string;
  /** Fix only — the error the original SQL failed with. */
  errorMessage?: string;
  connectionName: string;
  databaseName?: string;
  /** Set once the user acts on it — the card then shows a resolved state
   *  instead of the Apply/Discard buttons. */
  resolution?: 'applied' | 'discarded';
}

export interface AIMessage {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
  sqlSnippet?: string;
  timestamp: string;
  /** True while the model is producing this message (spinner state). Set
   *  false once the reply lands. Only used for assistant messages. */
  pending?: boolean;
  /** Controls rendering / actions on the message bubble.
   *  - `setup-nudge`: assistant bubble telling the user to configure a provider;
   *    the panel renders an inline "Configure AI" button.
   *  - `error`: a failure message (network/auth/etc.) — styled as a warning.
   *  - `normal` (default): a successful assistant reply. */
  kind?: 'normal' | 'setup-nudge' | 'error';
  /** When true the message's `sqlSnippet` has not been executed yet and the
   *  panel shows a Run button. Flipped to false after the user runs it. */
  sqlRunnable?: boolean;
  /** Present on AI Fix / Improve replies — renders the before/after SQL card
   *  with Apply/Discard actions instead of the plain `sqlSnippet` block. */
  proposal?: SqlProposal;
  /** Set on `kind: 'error'` messages that came from a request the user can
   *  simply retry as-is (network hiccup, provider timeout, etc.) — the panel
   *  renders a "Resend" button that re-runs this closure instead of making
   *  the user retype their prompt. */
  retry?: () => void;
}

/** A pending destructive-run confirmation. While set, the panel renders
 *  ConfirmRunDialog. */
export interface PendingRun {
  messageId: string;
  sql: string;
  destructiveVerbs: string[];
  connectionName: string;
  databaseName?: string;
}

interface AIState {
  messages: AIMessage[];
  isGenerating: boolean;
  pendingRun: PendingRun | null;

  sendMessage: (prompt: string) => Promise<void>;
  clearHistory: () => void;

  /** Run a message's SQL snippet against the active connection. Safe queries
   *  run immediately; destructive ones set `pendingRun` for confirmation. */
  runMessageSQL: (messageId: string) => void;
  /** Confirm a pending destructive run — executes the SQL. */
  confirmRun: () => Promise<void>;
  /** Abort a pending destructive run. */
  cancelRun: () => void;

  /** Ask the AI to fix a failed editor query. Sends the SQL + error + schema
   *  context; on success appends an assistant message with a `proposal`. */
  requestFix: (tabId: string, sql: string, errorMessage: string) => Promise<void>;

  /** Ask the AI to suggest a better version of already-working SQL
   *  (performance/readability/best practices) without changing behavior.
   *  Sends the SQL + schema context; on success appends an assistant message
   *  with a `proposal`. */
  requestImprovement: (tabId: string, sql: string) => Promise<void>;

  /** Apply or discard a message's pending SQL proposal (fix or improve —
   *  both resolve the same way). Applying replaces the source tab's SQL;
   *  either way the message is marked resolved so the buttons don't linger. */
  resolveProposal: (messageId: string, action: 'apply' | 'discard') => void;
}

const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const SETUP_NUDGE_CONTENT =
  'No AI provider is configured yet. Add your API token in Settings → AI to start generating SQL with OpenAI, Anthropic, Gemini, z.ai, OpenRouter, or any custom endpoint.';

/** Push an assistant message onto the end of the list. */
function pushAssistant(set: (fn: (s: AIState) => Partial<AIState>) => void, msg: AIMessage) {
  set((state) => ({ messages: [...state.messages, msg] }));
}

/** Execute `sql` (from message `messageId`) against `target` — marks the
 *  source message as launched, opens a new SQL tab, runs it, and posts a
 *  follow-up status message. Shared by the safe (auto-run) and destructive
 *  (post-confirmation) paths in `runMessageSQL`/`confirmRun` so there's one
 *  place that actually performs a run. */
async function runAgainstTarget(
  set: (fn: (s: AIState) => Partial<AIState>) => void,
  messageId: string,
  sql: string,
  target: ReturnType<typeof getActiveTarget>,
) {
  if (!target.connection) return;

  set((state) => ({
    messages: state.messages.map((m) =>
      m.id === messageId ? { ...m, sqlRunnable: false } : m,
    ),
  }));

  const tabStore = useTabStore.getState();
  const newTabId = tabStore.openSqlTab('AI Query', sql, target.connectionId, target.schemaName);
  tabStore.setActiveTab(newTabId);
  // Execute — results land on the tab and render in the existing ResultPanel.
  await tabStore.executeQuery(newTabId);

  pushAssistant(set, {
    id: `msg_ran_${Date.now()}`,
    sender: 'assistant',
    kind: 'normal',
    content: `Ran on **${target.connection.name}**${
      target.database ? ` → ${target.database}` : ''
    }. Results are in the Result panel below.`,
    timestamp: nowTime(),
  });
}

export const useAIStore = create<AIState>((set, get) => ({
  messages: [
    {
      id: 'msg_welcome',
      sender: 'assistant',
      kind: 'normal',
      content:
        'Hello! I am your rdSQL AI Database Assistant. I can help generate queries, optimize SQL performance, design schemas, or explain execution plans — using your live schema as context.',
      timestamp: nowTime(),
    },
  ],
  isGenerating: false,
  pendingRun: null,

  sendMessage: async (prompt: string) => {
    const userMsg: AIMessage = {
      id: `msg_${Date.now()}`,
      sender: 'user',
      content: prompt,
      timestamp: nowTime(),
    };

    set((state) => ({
      messages: [...state.messages, userMsg],
      isGenerating: true,
    }));

    const { ai } = useSettingsStore.getState();
    if (!isAIConfigured(ai)) {
      set((state) => ({
        isGenerating: false,
        messages: [
          ...state.messages,
          {
            id: `msg_nudge_${Date.now()}`,
            sender: 'assistant',
            kind: 'setup-nudge',
            content: SETUP_NUDGE_CONTENT,
            timestamp: nowTime(),
          },
        ],
      }));
      return;
    }

    try {
      const ctx = buildSchemaContext();
      const result = await generateSQL(ai, {
        prompt,
        schemaContext: ctx.text,
        engine: ctx.engine,
        serverVersion: ctx.serverVersion,
      });

      pushAssistant(set, {
        id: `msg_${Date.now() + 1}`,
        sender: 'assistant',
        kind: 'normal',
        content: result.explanation || 'Here is the SQL:',
        sqlSnippet: result.sql || undefined,
        sqlRunnable: !!result.sql,
        timestamp: nowTime(),
      });
    } catch (err) {
      const isAIErr = err instanceof AIError;
      const message = isAIErr
        ? err.message
        : `Failed to generate query: ${err instanceof Error ? err.message : String(err)}`;
      pushAssistant(set, {
        id: `msg_err_${Date.now()}`,
        sender: 'assistant',
        kind: isAIErr && err.kind === 'not-configured' ? 'setup-nudge' : 'error',
        content: isAIErr && err.kind === 'not-configured' ? SETUP_NUDGE_CONTENT : message,
        timestamp: nowTime(),
        retry: isAIErr && err.kind === 'not-configured' ? undefined : () => get().sendMessage(prompt),
      });
    } finally {
      set({ isGenerating: false });
    }
  },

  clearHistory: () => set({ messages: [], pendingRun: null }),

  // ── Run SQL flow ────────────────────────────────────────────────────────

  runMessageSQL: (messageId) => {
    const msg = get().messages.find((m) => m.id === messageId);
    if (!msg?.sqlSnippet) return;

    const target = getActiveTarget();
    if (!target.connection) {
      pushAssistant(set, {
        id: `msg_noconn_${Date.now()}`,
        sender: 'assistant',
        kind: 'error',
        content: 'No active connection. Open a connected tab first, then try again.',
        timestamp: nowTime(),
        retry: () => get().runMessageSQL(messageId),
      });
      return;
    }

    const { risk, destructiveVerbs } = classifySQL(msg.sqlSnippet);
    if (risk === 'destructive') {
      // Gate behind a confirmation dialog — never auto-run destructive SQL.
      set({
        pendingRun: {
          messageId,
          sql: msg.sqlSnippet,
          destructiveVerbs,
          connectionName: target.connection.name,
          databaseName: target.database,
        },
      });
      return;
    }

    // Safe (read-only) — run immediately.
    void runAgainstTarget(set, messageId, msg.sqlSnippet, target);
  },

  confirmRun: async () => {
    const pending = get().pendingRun;
    if (!pending) return;
    set({ pendingRun: null });

    const target = getActiveTarget();
    if (!target.connection) {
      pushAssistant(set, {
        id: `msg_noconn_${Date.now()}`,
        sender: 'assistant',
        kind: 'error',
        content: 'No active connection. Open a connected tab first, then try again.',
        timestamp: nowTime(),
        // Re-open the same confirmation instead of silently re-running —
        // it's still a destructive statement and deserves the same gate.
        retry: () => set({ pendingRun: pending }),
      });
      return;
    }

    await runAgainstTarget(set, pending.messageId, pending.sql, target);
  },

  cancelRun: () => set({ pendingRun: null }),

  // ── AI Fix flow ─────────────────────────────────────────────────────────

  requestFix: async (tabId, sql, errorMessage) => {
    // The proposal renders inside the AI panel itself — without this,
    // clicking "AI Fix" silently updates state the user can't see unless
    // they'd already had the panel open. Force it open (never closes an
    // already-open panel).
    useWorkspaceStore.getState().setAIPanelOpen(true);

    const { ai } = useSettingsStore.getState();
    if (!isAIConfigured(ai)) {
      pushAssistant(set, {
        id: `msg_nudge_${Date.now()}`,
        sender: 'assistant',
        kind: 'setup-nudge',
        content: SETUP_NUDGE_CONTENT,
        timestamp: nowTime(),
      });
      return;
    }

    set({ isGenerating: true });
    const target = getActiveTarget();

    try {
      const ctx = buildSchemaContext();
      // Dedicated prompt: give the model the broken SQL, the exact error, and
      // the schema so it can propose a minimal corrected version.
      const fixPrompt = [
        `The following SQL failed with this error:`,
        ``,
        `SQL:`,
        sql,
        ``,
        `Error:`,
        errorMessage,
        ``,
        `Diagnose the cause and return the corrected SQL. Preserve the original intent — only change what's necessary to fix the error.`,
      ].join('\n');

      const result = await generateSQL(ai, {
        prompt: fixPrompt,
        schemaContext: ctx.text,
        engine: ctx.engine,
        serverVersion: ctx.serverVersion,
      });

      if (!result.sql) {
        pushAssistant(set, {
          id: `msg_fixempty_${Date.now()}`,
          sender: 'assistant',
          kind: 'error',
          content: result.explanation || 'I could not produce a fix for that query.',
          timestamp: nowTime(),
          retry: () => get().requestFix(tabId, sql, errorMessage),
        });
        return;
      }

      pushAssistant(set, {
        id: `msg_fix_${Date.now()}`,
        sender: 'assistant',
        kind: 'normal',
        content: result.explanation || 'Here’s a proposed fix for the error:',
        timestamp: nowTime(),
        proposal: {
          kind: 'fix',
          tabId,
          originalSql: sql,
          proposedSql: result.sql,
          errorMessage,
          connectionName: target.connection?.name ?? 'active connection',
          databaseName: target.database,
        },
      });
    } catch (err) {
      const message =
        err instanceof AIError
          ? err.message
          : `Failed to generate a fix: ${err instanceof Error ? err.message : String(err)}`;
      pushAssistant(set, {
        id: `msg_fixerr_${Date.now()}`,
        sender: 'assistant',
        kind: 'error',
        content: message,
        timestamp: nowTime(),
        retry: () => get().requestFix(tabId, sql, errorMessage),
      });
    } finally {
      set({ isGenerating: false });
    }
  },

  // ── AI Improve flow ─────────────────────────────────────────────────────

  requestImprovement: async (tabId, sql) => {
    if (!sql.trim()) return;
    // Same reasoning as requestFix: the result lives in the AI panel, so
    // force it open or the user won't see anything happen.
    useWorkspaceStore.getState().setAIPanelOpen(true);

    const { ai } = useSettingsStore.getState();
    if (!isAIConfigured(ai)) {
      pushAssistant(set, {
        id: `msg_nudge_${Date.now()}`,
        sender: 'assistant',
        kind: 'setup-nudge',
        content: SETUP_NUDGE_CONTENT,
        timestamp: nowTime(),
      });
      return;
    }

    set({ isGenerating: true });
    const target = getActiveTarget();

    try {
      const ctx = buildSchemaContext();
      // Dedicated prompt: explicitly forbid changing what the query returns —
      // this is an optimization/readability pass, not a rewrite request.
      const improvePrompt = [
        `The following SQL runs correctly. Suggest an improved version — better`,
        `performance (indexing/join/filter order, avoiding SELECT *, redundant`,
        `subqueries, etc.) and/or readability and best practices.`,
        ``,
        `SQL:`,
        sql,
        ``,
        `The improved query MUST return the exact same result set as the original —`,
        `do not change filtering, sorting, or output columns/semantics. If the`,
        `query is already good and there's nothing meaningful to improve, return`,
        `it unchanged and say so in the explanation.`,
      ].join('\n');

      const result = await generateSQL(ai, {
        prompt: improvePrompt,
        schemaContext: ctx.text,
        engine: ctx.engine,
        serverVersion: ctx.serverVersion,
      });

      if (!result.sql) {
        pushAssistant(set, {
          id: `msg_improveempty_${Date.now()}`,
          sender: 'assistant',
          kind: 'error',
          content: result.explanation || 'I could not suggest an improvement for that query.',
          timestamp: nowTime(),
          retry: () => get().requestImprovement(tabId, sql),
        });
        return;
      }

      pushAssistant(set, {
        id: `msg_improve_${Date.now()}`,
        sender: 'assistant',
        kind: 'normal',
        content: result.explanation || 'Here’s a suggested improvement:',
        timestamp: nowTime(),
        proposal: {
          kind: 'improve',
          tabId,
          originalSql: sql,
          proposedSql: result.sql,
          connectionName: target.connection?.name ?? 'active connection',
          databaseName: target.database,
        },
      });
    } catch (err) {
      const message =
        err instanceof AIError
          ? err.message
          : `Failed to generate an improvement: ${err instanceof Error ? err.message : String(err)}`;
      pushAssistant(set, {
        id: `msg_improveerr_${Date.now()}`,
        sender: 'assistant',
        kind: 'error',
        content: message,
        timestamp: nowTime(),
        retry: () => get().requestImprovement(tabId, sql),
      });
    } finally {
      set({ isGenerating: false });
    }
  },

  resolveProposal: (messageId, action) => {
    const msg = get().messages.find((m) => m.id === messageId);
    if (!msg?.proposal || msg.proposal.resolution) return;
    if (action === 'apply') {
      // Apply to the source tab's editor. We do NOT auto-run — the user
      // reviews the change and presses Run themselves.
      useTabStore.getState().updateTabSql(msg.proposal.tabId, msg.proposal.proposedSql);
    }
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId && m.proposal
          ? { ...m, proposal: { ...m.proposal, resolution: action === 'apply' ? 'applied' : 'discarded' } }
          : m
      ),
    }));
  },
}));
