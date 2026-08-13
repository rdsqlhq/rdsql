/**
 * Canvas-based ERD renderer — draws the schema diagram directly onto a
 * <canvas> using the Canvas 2D API, bypassing html-to-image entirely.
 *
 * Why: html-to-image clones the DOM into an SVG <foreignObject>, loads it as
 * an <img>, then paints to canvas. In Tauri's WebView that round-trip
 * frequently fails — the <img> won't load (CORS/taint on inline SVGs, font
 * embedding hangs, or lucide icon hrefs taint the canvas), and the export
 * rejects with a useless "[object Event]" error. Drawing with the Canvas API
 * has none of those problems: no DOM cloning, no CORS, no fonts to embed.
 *
 * The renderer reads node positions from React Flow's state (which already
 * reflects the current layout/zoom the user sees) and edge geometry from the
 * schema graph model, so the output matches the on-screen diagram.
 */
import type { Node } from '@xyflow/react';
import type { SchemaGraphModel, GraphEdgeModel } from './types';
import type { ErdColumn } from '../../components/erd/nodes';
import { resolveEdgeColor } from './edgeColors';

// ── Visual constants (kept in sync with the CSS in nodes.tsx) ──────────────

const NODE_WIDTH = 220;
const HEADER_HEIGHT = 32;
const ROW_HEIGHT = 22;
const PADDING = 8;
const CARD_RADIUS = 10;
const CARD_BG = '#0f172a';
const CARD_BORDER = '#1e293b';
const HEADER_TEXT = '#e2e8f0';
const BODY_TEXT = '#cbd5e1';
const MUTED_TEXT = '#64748b';
const PK_COLOR = '#fbbf24'; // amber — primary key
const FK_COLOR = '#38bdf8'; // sky — foreign key
const TYPE_COLOR = '#94a3b8';
const EDGE_COLOR = '#475569';
const BG_COLOR = '#06090e';
const TITLE_COLOR = '#94a3b8';

/** Input to the renderer. */
export interface RenderErdInput {
  nodes: Node[];
  graph: SchemaGraphModel;
  /** Schema name for the title bar. */
  schemaName?: string;
  /** Pixel ratio (2 = retina). Defaults to 2. */
  pixelRatio?: number;
  /** Connector color setting from the toolbar — a hex string (all edges same
   *  color), `'per-connection'` (hash per table pair), or undefined (by kind).
   *  Mirrors the live DOM rendering so the export matches what's on screen. */
  connectorColor?: string;
}

/** A resolved column for drawing (mirrors the node component's visible set). */
interface DrawableTable {
  name: string;
  x: number;
  y: number;
  columns: ErdColumn[];
}

/** Round-rect path helper (CanvasRenderingContext2D.roundRect isn't universal). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** Compute the bounding box of all nodes (with margin) so we can size the
 *  canvas and translate everything into positive coordinates. */
function computeBounds(tables: DrawableTable[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tables) {
    const h = HEADER_HEIGHT + PADDING * 2 + Math.max(t.columns.length, 1) * ROW_HEIGHT;
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x + NODE_WIDTH);
    maxY = Math.max(maxY, t.y + h);
  }
  if (!isFinite(minX)) {
    return { minX: 0, minY: 0, width: 800, height: 600 };
  }
  const margin = 80;
  const width = Math.max(maxX - minX + margin * 2, 400);
  const height = Math.max(maxY - minY + margin * 2, 300);
  return {
    minX: minX - margin,
    minY: minY - margin,
    width,
    height,
  };
}

/** Build the list of drawable tables from React Flow nodes. Accepts both the
 *  full `tableNode` (diagram view, has columns in data) and the compact
 *  `graphPill` (graph view, no columns). When columns aren't on the node data,
 *  we fall back to the schema graph's table map so the export always shows
 *  the columns regardless of the current view mode. */
function resolveTables(
  nodes: Node[],
  tablesByName: Map<string, import('../domain/types').SchemaTableNode>,
  maxColumns = 20,
): DrawableTable[] {
  const tables: DrawableTable[] = [];
  for (const node of nodes) {
    if (node.hidden) continue;
    // Skip non-table nodes (group labels, etc).
    if (node.type !== 'tableNode' && node.type !== 'graphPill') continue;
    const data = node.data as unknown as { tableName?: string; columns?: ErdColumn[] };
    const name = data.tableName;
    if (!name) continue;

    // Prefer columns already on the node (diagram view); fall back to the
    // schema graph (graph view pills don't carry columns in their data).
    let columns = data.columns;
    if (!columns || columns.length === 0) {
      const schemaTable = tablesByName.get(name);
      if (schemaTable?.children) {
        columns = schemaTable.children.map((c) => ({
          name: c.name,
          type: c.data_type || '',
          pk: !!c.is_primary_key,
          fk: !!c.is_foreign_key,
        }));
      }
    }
    if (!columns) continue;

    tables.push({
      name,
      x: node.position.x,
      y: node.position.y,
      // Cap the column count so a 200-column table doesn't blow up the canvas.
      columns: columns.slice(0, maxColumns),
    });
  }
  return tables;
}

/** Draw a single relationship edge as a smooth bezier between two tables.
 *  Resolves the color the same way the live DOM edge does (explicit >
 *  per-connection hash > by-kind). */
function drawEdge(
  ctx: CanvasRenderingContext2D,
  edge: GraphEdgeModel,
  byName: Map<string, DrawableTable>,
  connectorColor?: string,
) {
  const src = byName.get(edge.source);
  const tgt = byName.get(edge.target);
  if (!src || !tgt) return;

  const color = resolveEdgeColor(connectorColor, edge.kind, edge.source, edge.target);

  // Connect from the right edge of source to the left edge of target (or
  // whichever side is closer — a simple heuristic for readability).
  const srcRight = { x: src.x + NODE_WIDTH, y: src.y + HEADER_HEIGHT / 2 + PADDING };
  const tgtLeft = { x: tgt.x, y: tgt.y + HEADER_HEIGHT / 2 + PADDING };

  // If source is to the right of target, flip the connection sides.
  const flip = src.x > tgt.x;
  const start = flip ? { x: src.x, y: srcRight.y } : srcRight;
  const end = flip ? { x: tgt.x + NODE_WIDTH, y: tgtLeft.y } : tgtLeft;

  const dx = Math.abs(end.x - start.x);
  const ctrl = Math.max(40, dx / 2);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.bezierCurveTo(
    start.x + (flip ? -ctrl : ctrl),
    start.y,
    end.x + (flip ? ctrl : -ctrl),
    end.y,
    end.x,
    end.y,
  );
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75;
  ctx.stroke();

  // Draw small endpoint dots for visual clarity.
  for (const p of [start, end]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** Draw a single table card with its columns. */
function drawTable(ctx: CanvasRenderingContext2D, t: DrawableTable) {
  const cardHeight = HEADER_HEIGHT + PADDING * 2 + t.columns.length * ROW_HEIGHT;

  // Card background.
  roundRectPath(ctx, t.x, t.y, NODE_WIDTH, cardHeight, CARD_RADIUS);
  ctx.fillStyle = CARD_BG;
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header strip (slightly lighter).
  ctx.save();
  roundRectPath(ctx, t.x, t.y, NODE_WIDTH, HEADER_HEIGHT + PADDING, CARD_RADIUS);
  ctx.clip();
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(t.x, t.y, NODE_WIDTH, HEADER_HEIGHT + PADDING);
  ctx.restore();

  // Table name.
  ctx.fillStyle = HEADER_TEXT;
  ctx.font = 'bold 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(t.name, t.x + PADDING + 2, t.y + HEADER_HEIGHT / 2 + 2);

  // Columns.
  const colStartY = t.y + HEADER_HEIGHT + PADDING + ROW_HEIGHT / 2;
  ctx.font = '11px ui-monospace, monospace';

  // Layout: the card is NODE_WIDTH wide. Reserve space for the PK/FK dot on
  // the left, the type label on the right, and a gap between name and type.
  // If the name is too long it gets truncated with an ellipsis so the two
  // labels never overlap.
  const dotArea = PADDING + 14;             // left: dot + spacing
  const typeAreaRight = NODE_WIDTH - PADDING - 2; // right edge for type text
  const minGap = 12;                         // min pixels between name and type

  t.columns.forEach((col, i) => {
    const y = colStartY + i * ROW_HEIGHT;

    // Marker (PK / FK badge).
    if (col.pk) {
      ctx.fillStyle = PK_COLOR;
      ctx.beginPath();
      ctx.arc(t.x + PADDING + 4, y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (col.fk) {
      ctx.fillStyle = FK_COLOR;
      ctx.beginPath();
      ctx.arc(t.x + PADDING + 4, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Measure the type so we know where the name's available width ends.
    const typeText = col.type || '';
    const typeWidth = ctx.measureText(typeText).width;
    const nameMaxWidth = typeAreaRight - typeWidth - minGap - dotArea;

    // Column name (left-aligned, truncated with ellipsis if too long).
    ctx.fillStyle = col.pk ? PK_COLOR : col.fk ? FK_COLOR : BODY_TEXT;
    ctx.textAlign = 'left';
    const nameText = truncateText(ctx, col.name, Math.max(20, nameMaxWidth));
    ctx.fillText(nameText, t.x + dotArea, y);

    // Type (right-aligned, muted).
    ctx.fillStyle = TYPE_COLOR;
    ctx.textAlign = 'right';
    ctx.fillText(typeText, t.x + typeAreaRight, y);
  });
  ctx.textAlign = 'left';
}

/** Truncate `text` to fit within `maxWidth` (in CSS pixels), appending an
 *  ellipsis when truncation occurs. Uses the ctx's current font. */
function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisWidth <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : ellipsis;
}

/**
 * Render the ERD diagram to a canvas element and return it. The caller can
 * then call `canvas.toBlob()` to get a PNG.
 */
export function renderErdToCanvas(input: RenderErdInput): HTMLCanvasElement {
  const { nodes, graph, schemaName, pixelRatio = 2, connectorColor } = input;
  const tables = resolveTables(nodes, graph.tablesByName);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const bounds = computeBounds(tables);

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.width * pixelRatio);
  canvas.height = Math.ceil(bounds.height * pixelRatio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context.');

  // Background — drawn in raw pixel space (identity transform).
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Title — also in screen space (top-left corner of the image).
  if (schemaName) {
    ctx.fillStyle = TITLE_COLOR;
    ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`Schema: ${schemaName}`, 16 * pixelRatio, 16 * pixelRatio);
  }

  // Now set up the world transform for the diagram: scale for retina +
  // translate so all node coordinates (which can be negative) map into the
  // positive canvas pixel space. Everything below (edges + cards) uses world
  // coordinates from the layout.
  ctx.scale(pixelRatio, pixelRatio);
  ctx.translate(-bounds.minX, -bounds.minY);

  // Edges first (so they render under the cards).
  for (const edge of graph.edges) {
    drawEdge(ctx, edge, byName, connectorColor);
  }

  // Table cards on top.
  for (const t of tables) {
    drawTable(ctx, t);
  }

  return canvas;
}
