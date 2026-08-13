/**
 * Multi-provider LLM client for the AI Database Assistant.
 *
 * One entry point — `generateSQL()` — accepts a sealed `AIConfig`, decrypts the
 * API key in memory, routes to the right protocol adapter, and returns the
 * extracted SQL + explanation. The caller never handles the plaintext key.
 *
 * Supported protocols:
 *  - `openai-compat` (OpenAI, OpenRouter, z.ai, Custom): POST {base}/chat/completions
 *    with `Authorization: Bearer <key>`. Works for any OpenAI-compatible endpoint.
 *  - `anthropic`: POST {base}/v1/messages with `x-api-key` + `anthropic-version`
 *    headers and the Claude messages shape.
 *  - `gemini`: POST {base}/v1beta/models/{model}:generateContent?key=<key>.
 *
 * The system prompt instructs the model to act as a senior SQL engineer for the
 * target dialect, to use the provided schema, and to return a fenced ```sql
 * block plus a brief explanation. We parse that block out of the response.
 */
import { decryptSecret } from '../storage/secrets';
import { PRESET_BY_ID, resolveBaseUrl } from './providers';
import { AIError, type AIConfig, type GenerateInput, type GenerateResult, type ModelInfo } from './types';

/** Friendly dialect name per engine, so the model targets the right SQL flavor. */
function dialectFor(engine?: string): string {
  switch (engine) {
    case 'postgres':
    case 'cockroachdb':
    case 'yugabytedb':
      return 'PostgreSQL';
    case 'mysql':
    case 'mariadb':
    case 'tidb':
    case 'planetscale':
      return 'MySQL';
    case 'sqlite':
    case 'cloudflare-d1':
      return 'SQLite';
    case 'duckdb':
      return 'DuckDB';
    case 'mssql':
    case 'sqlserver':
      return 'SQL Server (T-SQL)';
    default:
      return 'SQL';
  }
}

/** Build the system prompt. Keeps schema + dialect visible so answers are
 *  accurate and engine-compatible. */
function buildSystemPrompt(input: GenerateInput): string {
  const dialect = dialectFor(input.engine);
  const versionNote = input.serverVersion?.trim()
    ? ` The exact server is: ${input.serverVersion.trim().split('\n')[0]}.`
    : '';
  const schemaBlock = input.schemaContext.trim()
    ? `\n\nDatabase schema (use these exact table/column names):\n${input.schemaContext.trim()}`
    : '\n\nNo schema context is available — write generic SQL and note assumptions.';

  return [
    `You are a senior ${dialect} database engineer helping inside the rdSQL desktop app.`,
    `Generate correct, efficient ${dialect} SQL for the user's request.${versionNote}`,
    schemaBlock,
    '',
    'Respond with:',
    '1. A single fenced ```sql code block containing the SQL statement(s).',
    '2. A short (2-4 sentence) explanation after the block.',
    'Do NOT execute the SQL. Do NOT invent tables or columns that are not in the schema above.',
  ].join('\n');
}

/** Extract the first fenced ```sql (or ```) block as the SQL, and treat the
 *  remaining text as the explanation. Falls back gracefully if there's no
 *  fence. */
export function parseSqlResponse(raw: string): GenerateResult {
  const fenceMatch = raw.match(/```(?:sql|SQL)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const sql = fenceMatch[1].trim();
    const explanation = raw.replace(fenceMatch[0], '').trim();
    return { sql, explanation };
  }
  // No fence — if the text looks like SQL, treat the whole thing as SQL.
  const looksLikeSql = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|PRAGMA)\b/i.test(raw);
  if (looksLikeSql) {
    return { sql: raw.trim(), explanation: '' };
  }
  return { sql: '', explanation: raw.trim() };
}

/** Map a non-OK HTTP response to a typed AIError. */
async function errorFromResponse(res: Response, providerLabel: string): Promise<AIError> {
  let detail = '';
  try {
    const body = await res.text();
    // Try to pull a message out of common JSON error shapes.
    const parsed = JSON.parse(body);
    detail =
      parsed?.error?.message ||
      parsed?.error ||
      parsed?.message ||
      (typeof parsed === 'string' ? parsed : '');
  } catch {
    /* not JSON — ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return new AIError(
      `Authentication failed (${res.status}). Check your API key for ${providerLabel}.${detail ? ` — ${detail}` : ''}`,
      'auth',
    );
  }
  if (res.status === 429) {
    return new AIError(
      `Rate limit reached on ${providerLabel}. Wait a moment and try again.${detail ? ` — ${detail}` : ''}`,
      'rate-limit',
    );
  }
  return new AIError(
    `${providerLabel} returned HTTP ${res.status}.${detail ? ` ${detail}` : ''}`,
    'bad-response',
  );
}

// ── Protocol adapters ──────────────────────────────────────────────────────

/** OpenAI-compatible Chat Completions (OpenAI, OpenRouter, z.ai, Custom). */
async function callOpenAICompat(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  userPrompt: string,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(extraHeaders || {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 1200,
    }),
  });

  if (!res.ok) throw await errorFromResponse(res, 'the provider');

  const data = await res.json();
  const content: string | undefined = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new AIError('The provider returned an empty response.', 'bad-response');
  }
  return content;
}

/** Anthropic Messages API (Claude). */
async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  userPrompt: string,
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw await errorFromResponse(res, 'Anthropic');

  const data = await res.json();
  // Anthropic returns content as an array of blocks; concatenate text blocks.
  const blocks: Array<{ type: string; text?: string }> = data?.content || [];
  const content = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
  if (!content) {
    throw new AIError('Anthropic returned an empty response.', 'bad-response');
  }
  return content;
}

/** Google Gemini generateContent. */
async function callGemini(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  userPrompt: string,
): Promise<string> {
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
    }),
  });

  if (!res.ok) throw await errorFromResponse(res, 'Google Gemini');

  const data = await res.json();
  const candidates: Array<{ content?: { parts?: Array<{ text?: string }> } }> =
    data?.candidates || [];
  const content = candidates
    .flatMap((c) => c.content?.parts || [])
    .map((p) => p.text || '')
    .join('\n')
    .trim();
  if (!content) {
    // Gemini returns no candidates when input is blocked — surface that.
    const blockReason = data?.promptFeedback?.blockReason;
    throw new AIError(
      blockReason
        ? `Gemini blocked the request (${blockReason}).`
        : 'Gemini returned an empty response.',
      'bad-response',
    );
  }
  return content;
}

// ── Model listing adapters ─────────────────────────────────────────────────
// Each provider exposes a GET endpoint that lists available models. We reuse
// it for two purposes: validating the API key (a 401/403 means bad key) and
// populating the model dropdown in Settings. The endpoints:
//   openai-compat → GET {base}/models          (OpenAI, OpenRouter, z.ai, …)
//   anthropic     → GET {base}/v1/models       (x-api-key + anthropic-version)
//   gemini        → GET {base}/v1beta/models   (?key=…)

/** @internal exported for unit tests. */
export function parseOpenAIModels(data: any): ModelInfo[] {
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((m) => ({
      id: typeof m?.id === 'string' ? m.id : String(m?.id ?? ''),
      label: typeof m?.name === 'string' ? m.name : undefined,
      ownedBy: typeof m?.owned_by === 'string' ? m.owned_by : undefined,
    }))
    .filter((m) => m.id);
}

/** @internal exported for unit tests. */
export function parseAnthropicModels(data: any): ModelInfo[] {
  const list: any[] = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((m) => ({
      id: typeof m?.id === 'string' ? m.id : String(m?.id ?? ''),
      label: typeof m?.display_name === 'string' ? m.display_name : undefined,
    }))
    .filter((m) => m.id);
}

/** @internal exported for unit tests. */
export function parseGeminiModels(data: any): ModelInfo[] {
  const list: any[] = Array.isArray(data?.models) ? data.models : [];
  return list
    .map((m) => {
      // Gemini returns names like "models/gemini-2.0-flash"; strip the prefix.
      const raw = typeof m?.name === 'string' ? m.name : '';
      const id = raw.replace(/^models\//, '');
      return {
        id,
        label: typeof m?.displayName === 'string' ? m.displayName : undefined,
      };
    })
    .filter((m) => m.id);
}

/** Decrypt the sealed API key into memory. Throws a typed AIError on failure. */
async function resolveApiKey(config: AIConfig): Promise<string> {
  if (!config.apiKey) {
    throw new AIError('No API key configured.', 'not-configured');
  }
  let apiKey: string;
  try {
    apiKey = await decryptSecret(config.apiKey);
  } catch {
    throw new AIError(
      'Could not decrypt the stored API key. Re-enter it in Settings → AI.',
      'auth',
    );
  }
  if (!apiKey) {
    throw new AIError('The stored API key is empty.', 'not-configured');
  }
  return apiKey;
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Fetch the list of models available to the configured API key. This doubles
 * as a token validation check: a 401/403 surfaces as an `AIError(kind: 'auth')`,
 * so the caller can report "token invalid" without spending tokens on a real
 * completion. Returns an empty array only if the provider returns no models
 * (still a 200 — treated as a successful but empty listing).
 */
export async function fetchModels(
  config: AIConfig,
  /** Optional override plaintext key. When set (e.g. the user just typed a key
   *  in Settings and it hasn't been sealed yet), used directly instead of
   *  decrypting `config.apiKey`. */
  plaintextKey?: string,
): Promise<ModelInfo[]> {
  if (config.provider === 'custom' && !config.baseUrl?.trim()) {
    throw new AIError('Custom provider requires a base URL.', 'not-configured');
  }

  // Resolve the plaintext key — either from the override (just-typed) or by
  // decrypting the sealed value.
  let apiKey: string;
  if (plaintextKey !== undefined) {
    if (!plaintextKey) throw new AIError('No API key provided.', 'not-configured');
    apiKey = plaintextKey;
  } else {
    apiKey = await resolveApiKey(config);
  }

  const preset = PRESET_BY_ID[config.provider];
  const baseUrl = resolveBaseUrl(config.provider, config.baseUrl);

  let url: string;
  const headers: Record<string, string> = {};
  switch (preset.protocol) {
    case 'anthropic':
      url = `${baseUrl}/v1/models?limit=100`;
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      break;
    case 'gemini':
      url = `${baseUrl}/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
      break;
    case 'openai-compat':
    default:
      url = `${baseUrl}/models`;
      headers['Authorization'] = `Bearer ${apiKey}`;
      Object.assign(headers, preset.extraHeaders || {});
      break;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    if (err instanceof TypeError) {
      throw new AIError(
        `Network error contacting ${preset.label}. Check your connection and base URL.`,
        'network',
      );
    }
    throw new AIError(
      err instanceof Error ? err.message : 'Unexpected error listing models.',
      'unknown',
    );
  }

  if (!res.ok) throw await errorFromResponse(res, preset.label);

  const data = await res.json();
  switch (preset.protocol) {
    case 'anthropic':
      return parseAnthropicModels(data);
    case 'gemini':
      return parseGeminiModels(data);
    case 'openai-compat':
    default:
      return parseOpenAIModels(data);
  }
}

/**
 * Validate the API key by listing models. Returns the model list so the caller
 * can refresh the dropdown at the same time. Cheaper and more informative than
 * sending a throwaway completion — a 200 means the key is accepted by the
 * provider, a 401/403 means it's invalid.
 */
export async function validateConnection(
  config: AIConfig,
  plaintextKey?: string,
): Promise<ModelInfo[]> {
  return fetchModels(config, plaintextKey);
}

/**
 * Generate SQL via the configured provider. Throws `AIError` with a `kind` the
 * UI can branch on. `config.apiKey` is the SEALED ciphertext; it is decrypted
 * here and never leaves this function in plaintext form.
 */
export async function generateSQL(
  config: AIConfig,
  input: GenerateInput,
): Promise<GenerateResult> {
  // Validate configuration first — produce a setup-nudge-friendly error.
  if (!config.model) {
    throw new AIError('No model selected.', 'not-configured');
  }
  if (config.provider === 'custom' && !config.baseUrl?.trim()) {
    throw new AIError('Custom provider requires a base URL.', 'not-configured');
  }

  // Decrypt the key in memory just for this call.
  const apiKey = await resolveApiKey(config);

  const preset = PRESET_BY_ID[config.provider];
  const baseUrl = resolveBaseUrl(config.provider, config.baseUrl);
  const system = buildSystemPrompt(input);

  let raw: string;
  try {
    switch (preset.protocol) {
      case 'anthropic':
        raw = await callAnthropic(baseUrl, apiKey, config.model, system, input.prompt);
        break;
      case 'gemini':
        raw = await callGemini(baseUrl, apiKey, config.model, system, input.prompt);
        break;
      case 'openai-compat':
      default:
        raw = await callOpenAICompat(
          baseUrl,
          apiKey,
          config.model,
          system,
          input.prompt,
          preset.extraHeaders,
        );
        break;
    }
  } catch (err) {
    if (err instanceof AIError) throw err;
    // Network error / CORS / DNS — the fetch itself failed.
    if (err instanceof TypeError) {
      throw new AIError(
        `Network error contacting ${preset.label}. Check your connection and base URL.`,
        'network',
      );
    }
    throw new AIError(
      err instanceof Error ? err.message : 'Unexpected error during AI request.',
      'unknown',
    );
  }

  return parseSqlResponse(raw);
}

/**
 * Lightweight ping used by the Settings "Test Connection" button. Lists models
 * via `validateConnection` — a 200 means the token is valid, a 401/403 means
 * it isn't. Cheaper than a completion and returns useful data (the model list).
 */
export async function testConnection(
  config: AIConfig,
  plaintextKey?: string,
): Promise<ModelInfo[]> {
  return validateConnection(config, plaintextKey);
}
