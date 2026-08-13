// Re-export the pure health-state helpers + display styles so health view
// components import from a single local path.
export { deriveHealthState } from '../../core/domain/health';
export type { HealthState } from '../../core/domain/health';
export { HEALTH_STATE_STYLES } from './primitives';
