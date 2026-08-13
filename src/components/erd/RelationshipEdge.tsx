import React from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  useInternalNode,
  Position,
  InternalNode,
} from '@xyflow/react';
import { RelationshipKind } from '../../core/erd/types';

/**
 * Floating-edge geometry (xyflow's standard approach, see their "Floating
 * Edges" example). Radial and force-directed layouts scatter neighbors in
 * every direction around a card, but every Handle is hardcoded to
 * Left(target)/Right(source) — the layout hierarchical/left-to-right flow
 * assumes. With fixed handles, a neighbor sitting above/below/left of a card
 * still has to route out its right side and in the other's left side,
 * producing long looping S-curves that cross through unrelated cards. These
 * helpers instead compute where the straight line between the two cards'
 * centers crosses each card's actual border, and which side that point is
 * on — so the line always leaves/enters from the correct, nearest edge.
 */
function getNodeIntersection(intersectionNode: InternalNode, targetNode: InternalNode) {
  const w = (intersectionNode.measured.width ?? 0) / 2;
  const h = (intersectionNode.measured.height ?? 0) / 2;
  const nodePos = intersectionNode.internals.positionAbsolute;
  const targetPos = targetNode.internals.positionAbsolute;

  const x2 = nodePos.x + w;
  const y2 = nodePos.y + h;
  const x1 = targetPos.x + (targetNode.measured.width ?? 0) / 2;
  const y1 = targetPos.y + (targetNode.measured.height ?? 0) / 2;

  const xx1 = (x1 - x2) / (2 * w || 1);
  const yy1 = (y1 - y2) / (2 * h || 1);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;

  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

function getEdgePosition(node: InternalNode, point: { x: number; y: number }): Position {
  const pos = node.internals.positionAbsolute;
  const nx = Math.round(pos.x);
  const ny = Math.round(pos.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);

  if (px <= nx + 1) return Position.Left;
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  return Position.Bottom;
}

function getFloatingEdgeParams(source: InternalNode, target: InternalNode) {
  const sp = getNodeIntersection(source, target);
  const tp = getNodeIntersection(target, source);
  return {
    sx: sp.x,
    sy: sp.y,
    tx: tp.x,
    ty: tp.y,
    sourcePos: getEdgePosition(source, sp),
    targetPos: getEdgePosition(target, tp),
  };
}

export type EdgeLineStyle = 'curve' | 'step' | 'circuit';

/**
 * "Circuit" line style — PCB-trace look: right-angle routing like `step`, but
 * with 45°-chamfered corners instead of rounded ones, plus small square
 * "via" pads dropped at each real bend (the visual signature of a circuit
 * board trace). Self-authored rather than reusing getSmoothStepPath because
 * we need the actual bend coordinates to place those via pads — the library
 * function only returns a finished path string.
 */
const CIRCUIT_STUB = 24;
const CIRCUIT_CHAMFER = 10;

function positionDelta(pos: Position): { x: number; y: number } {
  switch (pos) {
    case Position.Left:
      return { x: -1, y: 0 };
    case Position.Right:
      return { x: 1, y: 0 };
    case Position.Top:
      return { x: 0, y: -1 };
    case Position.Bottom:
    default:
      return { x: 0, y: 1 };
  }
}

function buildCircuitPath(
  sourceX: number,
  sourceY: number,
  sourcePosition: Position,
  targetX: number,
  targetY: number,
  targetPosition: Position
) {
  const d1 = positionDelta(sourcePosition);
  const d2 = positionDelta(targetPosition);
  // Stub points just outside each card, in the direction its handle faces —
  // the trace always leaves/enters straight before it's allowed to turn.
  const p1 = { x: sourceX + d1.x * CIRCUIT_STUB, y: sourceY + d1.y * CIRCUIT_STUB };
  const p2 = { x: targetX + d2.x * CIRCUIT_STUB, y: targetY + d2.y * CIRCUIT_STUB };

  const raw = [{ x: sourceX, y: sourceY }, p1];
  const firstLegHorizontal = d1.x !== 0;
  if (Math.abs(p1.x - p2.x) > 0.5 && Math.abs(p1.y - p2.y) > 0.5) {
    // Stubs don't already share an axis — need one elbow between them.
    raw.push(firstLegHorizontal ? { x: p2.x, y: p1.y } : { x: p1.x, y: p2.y });
  }
  raw.push(p2, { x: targetX, y: targetY });

  // Collapse any zero-length or near-duplicate points (e.g. stub == target).
  const pts: { x: number; y: number }[] = [];
  for (const pt of raw) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) > 0.5) pts.push(pt);
  }

  let path = `M ${pts[0].x},${pts[0].y}`;
  const vias: { x: number; y: number }[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const c = Math.min(CIRCUIT_CHAMFER, inLen / 2, outLen / 2);
    if (c < 1) {
      path += ` L ${cur.x},${cur.y}`;
      continue;
    }
    const inX = cur.x - ((cur.x - prev.x) / inLen) * c;
    const inY = cur.y - ((cur.y - prev.y) / inLen) * c;
    const outX = cur.x + ((next.x - cur.x) / outLen) * c;
    const outY = cur.y + ((next.y - cur.y) / outLen) * c;
    path += ` L ${inX},${inY} L ${outX},${outY}`;
    vias.push(cur);
  }
  path += ` L ${pts[pts.length - 1].x},${pts[pts.length - 1].y}`;

  const mid = pts[Math.floor(pts.length / 2)];
  return { path, labelX: mid.x, labelY: mid.y, vias };
}
export type ConnectorType = 'normal' | 'dot';

export interface RelationshipEdgeData {
  kind: RelationshipKind;
  label: string;
  faded: boolean;
  /** 'curve' = smooth bezier S-line (default); 'step' = right-angle elbows. */
  lineStyle?: EdgeLineStyle;
  /** When grouped, this edge represents N relationships — show a count badge. */
  groupCount?: number;
  /** Override the auto-by-kind color. When set, ALL edges use this color. */
  connectorColor?: string;
  /** 'normal' = solid line; 'dot' = dotted line. */
  connectorType?: ConnectorType;
  /** When true, glowing particles travel along the path (electron-flow effect). */
  animated?: boolean;
  /** Radial/force layouts scatter nodes in every direction, so edges route
   *  to a computed point on each card's border instead of the fixed
   *  Left/Right handles hierarchical layout assumes. See getFloatingEdgeParams. */
  floating?: boolean;
}

import { connectionColor, KIND_COLOR } from '../../core/erd/edgeColors';

export const RelationshipEdge = React.memo(function RelationshipEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const d = (data || {}) as unknown as RelationshipEdgeData;
  const kind = d.kind || 'fk';

  // Hooks must run unconditionally — only used when d.floating is set.
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  let sx = sourceX;
  let sy = sourceY;
  let tx = targetX;
  let ty = targetY;
  let sourcePos = sourcePosition;
  let targetPos = targetPosition;
  if (d.floating && kind !== 'self' && sourceNode && targetNode) {
    const floating = getFloatingEdgeParams(sourceNode, targetNode);
    sx = floating.sx;
    sy = floating.sy;
    tx = floating.tx;
    ty = floating.ty;
    sourcePos = floating.sourcePos;
    targetPos = floating.targetPos;
  }
  // Color resolution: explicit single color > per-connection hash > by-kind.
  const color =
    d.connectorColor && d.connectorColor !== 'per-connection'
      ? d.connectorColor
      : d.connectorColor === 'per-connection'
        ? connectionColor(source || '', target || '')
        : KIND_COLOR[kind];
  const isDotted = d.connectorType === 'dot';
  const isAnimated = d.animated;

  let path: string;
  let labelX: number;
  let labelY: number;
  let vias: { x: number; y: number }[] = [];

  if (kind === 'self') {
    // Same-table relationship: loop out to the side and back rather than a
    // straight line, since source and target sit on the same box.
    const bulge = 90;
    path = `M ${sourceX},${sourceY} C ${sourceX + bulge},${sourceY - 36} ${
      targetX + bulge
    },${targetY + 36} ${targetX},${targetY}`;
    labelX = sourceX + bulge * 0.85;
    labelY = (sourceY + targetY) / 2;
  } else if (d.lineStyle === 'circuit') {
    const built = buildCircuitPath(sx, sy, sourcePos, tx, ty, targetPos);
    path = built.path;
    labelX = built.labelX;
    labelY = built.labelY;
    vias = built.vias;
  } else {
    const useStep = d.lineStyle === 'step';
    if (useStep) {
      // Right-angle elbows with rounded corners — the "L-line" look.
      const [p, lx, ly] = getSmoothStepPath({
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos,
        borderRadius: 12,
      });
      path = p;
      labelX = lx;
      labelY = ly;
    } else {
      // Smooth bezier S-curve (default) — flowing, no sharp corners.
      const [p, lx, ly] = getBezierPath({
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos,
      });
      path = p;
      labelX = lx;
      labelY = ly;
    }
  }

  return (
    <>
      {kind === 'many-to-many' && (
        <path d={path} fill="none" stroke={color} strokeWidth={5} strokeOpacity={d.faded ? 0.05 : 0.22} />
      )}
      {/* Circuit style gets a soft trace glow underneath — reads as a lit PCB
          trace rather than a plain line. */}
      {d.lineStyle === 'circuit' && (
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeLinecap="square"
          opacity={d.faded ? 0.04 : 0.25}
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: kind === 'self' ? 1.5 : 1.75,
          strokeLinecap: d.lineStyle === 'circuit' ? 'square' : undefined,
          strokeDasharray: isDotted
            ? '2 4'
            : kind === 'polymorphic'
              ? '5 4'
              : undefined,
          opacity: d.faded ? 0.12 : 1,
          transition: 'opacity 150ms ease',
        }}
      />
      {/* Via pads — small square markers at each real bend, the visual
          signature of a circuit-board trace. */}
      {d.lineStyle === 'circuit' &&
        vias.map((v, i) => (
          <rect
            key={i}
            x={v.x - 2.5}
            y={v.y - 2.5}
            width={5}
            height={5}
            fill={color}
            opacity={d.faded ? 0.12 : 0.9}
          />
        ))}
      {/* Electron-flow particles: 3 glowing dots travel along the path with
          staggered delays so they're evenly spaced. Works on BOTH solid and
          dotted lines — the particles are separate SVG circles layered on top. */}
      {isAnimated && !d.faded && (
        <>
          {[0, 2.5, 5].map((delay) => (
            <circle key={delay} r={3} fill={color} opacity={0.9}>
              <animateMotion dur="3s" repeatCount="indefinite" path={path} begin={`${delay}s`} />
              <animate
                attributeName="opacity"
                values="0;0.9;0.9;0"
                keyTimes="0;0.1;0.85;1"
                dur="3s"
                repeatCount="indefinite"
                begin={`${delay}s`}
              />
            </circle>
          ))}
          {/* Soft glow underlay for each particle. */}
          {[0, 2.5, 5].map((delay) => (
            <circle key={`glow-${delay}`} r={6} fill={color} opacity={0.25}>
              <animateMotion dur="3s" repeatCount="indefinite" path={path} begin={`${delay}s`} />
              <animate
                attributeName="opacity"
                values="0;0.25;0.25;0"
                keyTimes="0;0.1;0.85;1"
                dur="3s"
                repeatCount="indefinite"
                begin={`${delay}s`}
              />
            </circle>
          ))}
        </>
      )}
      {d.label && !d.faded && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
            className="absolute text-[9px] font-mono text-slate-400 bg-[#0a0f18]/90 px-1 rounded pointer-events-none flex items-center gap-1"
          >
            {d.label}
            {d.groupCount && d.groupCount > 1 && (
              <span className="text-[8px] px-1 rounded-full bg-blue-500/20 text-blue-400 font-bold">
                ×{d.groupCount}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const erdEdgeTypes = { relationship: RelationshipEdge };
