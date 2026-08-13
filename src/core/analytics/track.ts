import { useSettingsStore } from '../../store/useSettingsStore';
import { safeInvoke } from '../tauri/ipc';
import { getInstallId } from './installId';
import type { AnalyticsEvent } from './events';

/**
 * Fire-and-forget, opt-in-only usage tracking. No-ops instantly if
 * analytics is off (checked fresh on every call — never cached — so
 * toggling the setting off takes effect immediately). Never throws, never
 * surfaces an error toast, never affects app behavior — analytics must be
 * invisible when it fails.
 */
export function track(event: AnalyticsEvent): void {
  if (!useSettingsStore.getState().analyticsEnabled) return;
  void safeInvoke('backend_analytics_event', {
    installId: getInstallId(),
    eventName: event.name,
    dimension: event.dimension,
  }).catch(() => {
    // Silently ignored — see module doc.
  });
}
