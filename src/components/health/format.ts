/** Formatting helpers shared across the health views. Pure (unit-testable). */

export function formatBytes(bytes?: number | null, digits = 2): string {
  if (bytes == null || typeof bytes !== 'number' || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(digits))} ${sizes[i]}`;
}

export function formatNumber(n?: number | null): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatRatio(ratio?: number | null): string {
  if (ratio == null) return '—';
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatRelativeTime(epochMs?: number | null): string {
  if (!epochMs) return '—';
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}
