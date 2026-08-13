/**
 * Built-in provider presets.
 *
 * Most providers (OpenAI, OpenRouter, z.ai, and any OpenAI-compatible Custom
 * endpoint) speak the OpenAI Chat Completions wire format, so they share one
 * adapter. Anthropic and Google Gemini use their own request/response shapes
 * and get dedicated adapters in `client.ts`.
 *
 * The registry drives the Settings dropdown: picking a provider auto-fills a
 * sensible default model + base URL, both of which the user can still edit.
 */
import type { AIProvider, AIProtocol } from './types';

export interface ProviderPreset {
  /** Stable id matching `AIProvider`. */
  id: AIProvider;
  /** Human-readable label for the dropdown. */
  label: string;
  /** Which wire-format adapter the client should use. */
  protocol: AIProtocol;
  /** Default base URL. Empty for `custom` (user must supply). */
  defaultBaseUrl: string;
  /** Default model id the field is pre-filled with. */
  defaultModel: string;
  /** Where to sign up for / obtain an API key. */
  keyUrl: string;
  /** Optional request headers every call must include (e.g. OpenRouter's
   *  `HTTP-Referer`). Auth headers are added separately by the client. */
  extraHeaders?: Record<string, string>;
}

/** Ordered list shown in the Settings dropdown. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-compat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-sonnet-20241022',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-compat',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    keyUrl: 'https://openrouter.ai/keys',
    extraHeaders: {
      'HTTP-Referer': 'https://rdsql.app',
      'X-Title': 'rdSQL Desktop',
    },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.0-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'zai',
    label: 'z.ai (GLM)',
    protocol: 'openai-compat',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
    keyUrl: 'https://z.ai/manage/apikey',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    protocol: 'openai-compat',
    defaultBaseUrl: '',
    defaultModel: '',
    keyUrl: '',
  },
];

/** Quick lookup by id. */
export const PRESET_BY_ID: Record<AIProvider, ProviderPreset> = PROVIDER_PRESETS.reduce(
  (acc, p) => {
    acc[p.id] = p;
    return acc;
  },
  {} as Record<AIProvider, ProviderPreset>,
);

/** Resolve the effective base URL for a config (falls back to the preset
 *  default when the user hasn't overridden it). */
export function resolveBaseUrl(provider: AIProvider, override?: string): string {
  const preset = PRESET_BY_ID[provider];
  const url = (override && override.trim()) || preset.defaultBaseUrl;
  // Strip a trailing slash so we control path joining in the client.
  return url.replace(/\/+$/, '');
}
