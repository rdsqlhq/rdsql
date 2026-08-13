/**
 * AI provider configuration types.
 *
 * The user configures one LLM provider at a time (OpenAI, Anthropic, OpenRouter,
 * Google Gemini, z.ai, or any OpenAI-compatible Custom endpoint). The API key
 * is stored SEALED — encrypted at rest with the per-device KEK from
 * `core/storage/secrets` (same pattern as S3 secret keys). The plaintext key
 * only ever lives in memory for the duration of an API call.
 */

/** The set of built-in provider presets. `custom` covers any OpenAI-compatible
 *  endpoint the user points at via `baseUrl`. */
export type AIProvider =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'gemini'
  | 'zai'
  | 'custom';

/** Protocol family — decides which request/response adapter the client uses. */
export type AIProtocol = 'openai-compat' | 'anthropic' | 'gemini';

/**
 * Persisted AI configuration. `apiKey` is the SEALED (encrypted) string, never
 * plaintext — stored and loaded exactly like S3 secret keys. Decrypt on demand
 * via `decryptSecret()` immediately before an API call.
 */
export interface AIConfig {
  provider: AIProvider;
  /** Sealed ciphertext (output of `encryptSecret`). Empty string = unset. */
  apiKey: string;
  /** Model id, e.g. `gpt-4o`, `claude-3-5-sonnet-20241022`, `glm-4.6`,
   *  `gemini-2.0-flash`, `openai/gpt-4o` (OpenRouter). */
  model: string;
  /** Base URL of the API. When omitted the provider's default is used. */
  baseUrl?: string;
  /** Master on/off. Defaults to false; flipped true once a key + model are set. */
  enabled: boolean;
}

/** Default state before the user configures anything. */
export const EMPTY_AI_CONFIG: AIConfig = {
  provider: 'openai',
  apiKey: '',
  model: '',
  baseUrl: '',
  enabled: false,
};

/** True when the config has the minimum needed to make a real API call:
 *  a sealed API key and a model id. UI uses this to decide whether to show the
 *  setup nudge. */
export function isAIConfigured(config: AIConfig): boolean {
  return !!(config.apiKey && config.model);
}

/** Input to the LLM client — the user's prompt plus the schema context we
 *  gather from the active connection. */
export interface GenerateInput {
  prompt: string;
  /** Compact text representation of the active database schema (tables,
   *  columns, types, PK/FK). Empty when no connection / no schema loaded. */
  schemaContext: string;
  /** SQL dialect hint, e.g. `postgres`, `mysql`, `sqlite`. Helps the model
   *  emit syntax compatible with the target engine. */
  engine?: string;
  /** Full server version banner (e.g. `PostgreSQL 16.2 on ...`, `Microsoft
   *  SQL Server 2022 (RTM) - 16.0...`), when known. Lets the model target the
   *  exact engine/version instead of just the family — e.g. distinguishing
   *  syntax that changed between major versions. */
  serverVersion?: string;
}

/** Output of a successful generation. */
export interface GenerateResult {
  /** The extracted SQL statement(s). */
  sql: string;
  /** The model's natural-language explanation (everything outside the SQL
   *  block). */
  explanation: string;
}

/** A single model entry returned by `fetchModels()`. */
export interface ModelInfo {
  /** The model id to pass back in `AIConfig.model` (e.g. `gpt-4o`). */
  id: string;
  /** Human-friendly display name if the provider exposes one. */
  label?: string;
  /** Who owns the model — surfaced by OpenRouter / some gateways. */
  ownedBy?: string;
}

/** Error thrown by the client for the UI to surface. `kind` lets the panel
 *  render the right message + action (e.g. setup nudge). */
export class AIError extends Error {
  constructor(
    message: string,
    public kind: 'not-configured' | 'network' | 'auth' | 'rate-limit' | 'bad-response' | 'unknown',
  ) {
    super(message);
    this.name = 'AIError';
  }
}
