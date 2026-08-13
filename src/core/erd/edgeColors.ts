/**
 * Edge color resolution — shared between the live React Flow edge renderer
 * (RelationshipEdge.tsx) and the canvas-based PNG/PDF exporter
 * (renderToCanvas.ts) so both produce identical colors.
 *
 * Resolution order:
 *  1. Explicit single color (when `connectorColor` is a hex string)
 *  2. `per-connection` — deterministic hash of source+target table names
 *  3. By relationship kind (fallback)
 */
import type { RelationshipKind } from './types';

/** Default color per relationship kind. */
export const KIND_COLOR: Record<RelationshipKind, string> = {
  fk: '#3b82f6',
  self: '#f59e0b',
  polymorphic: '#a855f7',
  'many-to-many': '#10b981',
};

/** Distinct palette for per-connection coloring — each relationship gets a
 *  deterministic color based on its source+target table names so repeated
 *  renders stay stable and adjacent lines are easy to tell apart. */
export const CONNECTION_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ef4444', // red
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#eab308', // yellow
];

/** Deterministic hash from two table names → palette index. Same pair always
 *  gets the same color. Exported so the canvas renderer matches the DOM. */
export function connectionColor(source: string, target: string): string {
  let hash = 0;
  const s = source < target ? source + target : target + source;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return CONNECTION_PALETTE[Math.abs(hash) % CONNECTION_PALETTE.length];
}

/**
 * Resolve the final stroke color for an edge, mirroring the logic in
 * RelationshipEdge.tsx. `connectorColor` is the user's toolbar setting:
 *  - a hex string → all edges use that color
 *  - `'per-connection'` → hash per source+target pair
 *  - undefined → fall back to kind-based color
 */
export function resolveEdgeColor(
  connectorColor: string | undefined,
  kind: RelationshipKind,
  source: string,
  target: string,
): string {
  if (connectorColor && connectorColor !== 'per-connection') {
    return connectorColor;
  }
  if (connectorColor === 'per-connection') {
    return connectionColor(source, target);
  }
  return KIND_COLOR[kind];
}
