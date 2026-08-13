/**
 * Health & Maintenance capability registry.
 *
 * The Health backend is engine-aware (see `src-tauri/src/commands/health/*`)
 * but not every engine supports every section — Redis has no schema/tables,
 * Mongo has no repair/maintenance actions yet, SQLite has no live activity
 * feed. Rather than each UI component re-deriving "does this engine support
 * X" from `engineFamily()`/`isMongoEngine()`/`isRedisEngine()` checks, this
 * module is the single source of truth: it says what a Health tab/section is
 * allowed to render, not how to render it.
 *
 * A capability being absent means "hide this section" — never "show an
 * application error". Partial/permission-limited data within a supported
 * capability is a separate, per-metric concern (handled by the `Option<T>` /
 * `None` convention already used throughout `health/mod.rs`).
 */
import { isMongoEngine, isRedisEngine, engineFamily } from '../connection/engines';

export type HealthCapability =
  | 'overview'
  | 'connections'
  | 'performance'
  | 'memory'
  | 'storage'
  | 'databases'
  | 'collections'
  | 'indexes'
  | 'queries'
  | 'locks'
  | 'replication'
  | 'persistence'
  | 'integrity'
  | 'maintenance';

const SQL_FAMILY_CAPABILITIES: HealthCapability[] = [
  'overview',
  'connections',
  'performance',
  'memory',
  'storage',
  'queries',
  'locks',
  'maintenance',
];

const SQLITE_CAPABILITIES: HealthCapability[] = ['overview', 'storage', 'integrity', 'maintenance'];

const MONGO_CAPABILITIES: HealthCapability[] = [
  'overview',
  'connections',
  'performance',
  'memory',
  'storage',
  'databases',
  'collections',
  'indexes',
  'replication',
];

const REDIS_CAPABILITIES: HealthCapability[] = [
  'overview',
  'connections',
  'performance',
  'memory',
  'persistence',
  'replication',
];

/** All Health capabilities enabled for a given engine string. */
export function healthCapabilitiesFor(engine: string): HealthCapability[] {
  if (isMongoEngine(engine)) return MONGO_CAPABILITIES;
  if (isRedisEngine(engine)) return REDIS_CAPABILITIES;
  if (engineFamily(engine) === 'sqlite') return SQLITE_CAPABILITIES;
  return SQL_FAMILY_CAPABILITIES;
}

/** Whether a given engine's Health view should render a section/tab. */
export function hasHealthCapability(engine: string, capability: HealthCapability): boolean {
  return healthCapabilitiesFor(engine).includes(capability);
}
