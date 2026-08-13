import type { DatabaseEngine } from '../domain/types';
import type { S3ProviderPreset } from '../storage/domain/types';

/**
 * Explicit allowlist of trackable events — the ONLY events `track()` will
 * ever send. Mirrors the server-side allowlist in
 * `functions/api/analytics/event.ts`, which independently re-validates
 * every event (never trusts the client). Never add a field here that could
 * carry a hostname, credential, or query text — dimensions are always a
 * closed enum, never free text.
 */
export type AnalyticsEvent =
  | { name: 'connection_created'; dimension: DatabaseEngine }
  | { name: 'connection_tested'; dimension: DatabaseEngine }
  | { name: 's3_connection_created'; dimension: S3ProviderPreset };
