import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesState,
  useEdgesState,
  Background,
  MiniMap,
  MarkerType,
  Node,
  Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  GitFork,
  Download,
  Code,
  Database,
  RotateCcw,
  Eye,
  EyeOff,
  Search,
  Map as MapIcon,
  Crosshair,
  Waypoints,
  Network,
  LayoutGrid,
  Share2,
  Workflow,
  ChevronDown,
  Expand,
  Shrink,
  Spline,
  Sigma,
  Palette,
  MoreHorizontal,
  Zap,
  Image as ImageIcon,
  FileCode2,
  FileText,
  Loader2,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Settings2,
  Check,
  CircuitBoard,
  Info,
} from 'lucide-react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { ErdSchemaContext } from '../../core/domain/types';
import { buildSchemaGraph, computeDegrees, resolveFkTarget } from '../../core/erd/schemaGraph';
import { getDirectNeighbors } from '../../core/erd/neighborhood';
import {
  LAYOUT_OPTIONS,
  estimateNodeHeight,
  runLayout,
  calculateGraphBounds,
  ERD_LAYOUT,
} from '../../core/erd/layout';
import { LayoutKind, ViewMode } from '../../core/erd/types';
import { erdNodeTypes, ErdColumn, TableNodeData, GraphPillNodeData } from './nodes';
import { erdEdgeTypes, RelationshipEdgeData, EdgeLineStyle, ConnectorType } from './RelationshipEdge';
import { useFocusGraph } from './useFocusGraph';
import { SearchPalette } from './SearchPalette';
import { useErdExport } from './useErdExport';
import { TableDetailDrawer } from './TableDetailDrawer';

function EmptyState() {
  const { setActiveView } = useWorkspaceStore();
  return (
    <div className="w-full h-full bg-[#06090e] flex flex-col items-center justify-center gap-3 select-none">
      <div className="w-12 h-12 rounded-2xl bg-[#0f172a] border border-[#1e293b] flex items-center justify-center text-blue-400">
        <GitFork className="w-6 h-6" />
      </div>
      <h4 className="text-sm font-bold text-slate-200">No Diagram Selected</h4>
      <p className="text-xs text-slate-400 max-w-sm text-center leading-relaxed">
        Right-click a database, schema, or table in the Explorer sidebar and choose{' '}
        <span className="text-blue-400 font-medium">"Show Relationship Diagram"</span> to generate an ERD.
      </p>
      <button
        onClick={() => setActiveView('explorer')}
        className="mt-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-600/30 transition-all"
      >
        Go to Explorer
      </button>
    </div>
  );
}

/** A single row inside the canvas "Options" popover: icon + label on the
 *  left, a checkmark on the right when active. Keeps the popover's toggle
 *  list (view + connector-style switches) visually consistent without
 *  repeating the same button markup five times. */
function OptionToggle({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors ${
        active ? 'bg-blue-600/15 text-blue-400' : 'text-slate-300 hover:bg-[#141e33]'
      }`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {active && <Check className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}

type DropdownPlacement = 'bottom-start' | 'bottom-end' | 'right-start';

/**
 * Positions a dropdown/popover panel with `position: fixed`, computed from
 * the trigger's rect and clamped to the viewport.
 *
 * The toolbar's dropdowns used to be `position: absolute` inside the ERD
 * tab's `overflow-hidden` ancestor chain (MainLayout wraps the tab content
 * in a couple of `overflow-hidden` panes for the resizable-panel layout) —
 * once a panel's content grew past that ancestor's box, the overflow rule
 * clipped it instead of letting it show over the canvas. `position: fixed`
 * escapes that clipping (its containing block is the viewport, not the
 * overflow-hidden ancestor), and computing top/left from the trigger's
 * bounding rect — clamped so the panel never runs past the window edge —
 * keeps it fully on-screen even when opened near a corner.
 */
function useDropdownPosition(
  triggerRef: React.RefObject<HTMLElement | null>,
  open: boolean,
  placement: DropdownPlacement,
  panelWidth: number
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<{ top: number; left: number; visibility: 'visible' | 'hidden' }>({
    top: -9999,
    left: -9999,
    visibility: 'hidden',
  });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = triggerRef.current.getBoundingClientRect();
    // First pass renders off-screen (visibility: hidden) so we can measure
    // the panel's real height before placing it — same two-pass approach as
    // the Explorer's clamped context menus.
    const panelH = panelRef.current?.offsetHeight ?? 0;
    const w = panelRef.current?.offsetWidth ?? panelWidth;

    let top: number;
    let left: number;
    if (placement === 'right-start') {
      left = rect.right + margin + w > vw ? Math.max(margin, rect.left - w - margin) : rect.right + margin;
      top = Math.max(margin, Math.min(rect.top, vh - panelH - margin));
    } else {
      top = rect.bottom + margin + panelH > vh ? Math.max(margin, rect.top - panelH - margin) : rect.bottom + 4;
      left =
        placement === 'bottom-end'
          ? Math.max(margin, Math.min(rect.right - w, vw - w - margin))
          : Math.max(margin, Math.min(rect.left, vw - w - margin));
    }
    setStyle({ top, left, visibility: 'visible' });
  }, [open, placement, panelWidth, triggerRef]);

  return { panelRef, style };
}

function ErdInner({ schema }: { schema: ErdSchemaContext }) {
  const { fitView, setCenter, getNode, zoomIn, zoomOut } = useReactFlow();

  const graph = useMemo(() => buildSchemaGraph(schema.tables), [schema]);

  const initialRootId = useMemo(() => {
    if (schema.focusTableName && graph.tablesByName.has(schema.focusTableName)) return schema.focusTableName;
    const degrees = computeDegrees(graph);
    let best: string | null = null;
    let bestDeg = -1;
    degrees.forEach((deg, name) => {
      if (deg > bestDeg) {
        bestDeg = deg;
        best = name;
      }
    });
    return best;
  }, [graph, schema.focusTableName]);

  const focus = useFocusGraph(graph, initialRootId);

  // Show every table by default. The user can still narrow with the D1/D2/D3
  // depth controls or by picking a focus root via search.
  useEffect(() => {
    focus.setShowAll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [compact, setCompact] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('diagram');
  const [layoutKind, setLayoutKind] = useState<LayoutKind>('hierarchical');
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showEdges, setShowEdges] = useState(true);
  const [lineStyle, setLineStyle] = useState<EdgeLineStyle>('curve');
  const [groupEdges, setGroupEdges] = useState(false);
  const [connectorColor, setConnectorColor] = useState<string | undefined>('per-connection');
  const [connectorType, setConnectorType] = useState<ConnectorType>('normal');
  const [animated, setAnimated] = useState(true);
  const [optionsMenuOpen, setOptionsMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [columnsExpandedIds, setColumnsExpandedIds] = useState<Set<string>>(new Set());
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [detailTableName, setDetailTableName] = useState<string | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ tableName: string; x: number; y: number } | null>(null);

  const degrees = useMemo(() => computeDegrees(graph), [graph]);

  // Ref to the canvas wrapper so the PNG exporter can locate the React Flow
  // viewport element to rasterize.
  const canvasRef = useRef<HTMLDivElement>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Docked table-detail panel — sits beside the canvas (Explorer-sidebar
  // style) instead of floating over it. Width lives in the shared workspace
  // store so it follows the same resize pattern as the Explorer/AI panels.
  const { erdDetailPanelWidth, setErdDetailPanelWidth, zoomLevel } = useWorkspaceStore();
  const canvasRowRef = useRef<HTMLDivElement>(null);
  const [isResizingDetail, setIsResizingDetail] = useState(false);

  useEffect(() => {
    if (!isResizingDetail) return;
    const handleMouseMove = (e: MouseEvent) => {
      const rowRight = canvasRowRef.current?.getBoundingClientRect().right;
      if (rowRight === undefined) return;
      setErdDetailPanelWidth((rowRight - e.clientX) / zoomLevel);
    };
    const handleMouseUp = () => setIsResizingDetail(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingDetail, setErdDetailPanelWidth, zoomLevel]);

  // Trigger refs for the fixed-position dropdowns below (layout picker,
  // export menu, canvas options popover) — see useDropdownPosition.
  const layoutBtnRef = useRef<HTMLButtonElement>(null);
  const exportBtnRef = useRef<HTMLButtonElement>(null);
  const optionsBtnRef = useRef<HTMLButtonElement>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const { exporting, error: exportError, exportPng, exportPdf, exportMermaid, exportDdl } = useErdExport({
    schema,
    graph,
    nodes,
    connectorColor,
    canvasContainerRef: canvasRef,
    // Re-fit the whole graph into view before capturing so off-screen nodes
    // aren't clipped by React Flow's viewport virtualization.
    onBeforeCapture: () => {
      fitView({ padding: 0.25, duration: 0 });
    },
  });

  const isCompactEffective = compact || viewMode === 'graph';

  // Wrap setViewMode so switching diagram↔graph re-centers the canvas —
  // without this the view can stay stuck at the old zoom/pan position while
  // the node layout changes underneath, making tables appear off-screen.
  const handleSetViewMode = useCallback(
    (mode: ViewMode) => {
      setViewMode(mode);
      // Defer so the rebuild effect has laid out the new node shapes first.
      requestAnimationFrame(() => {
        setTimeout(() => fitView({ padding: 0.25, duration: 400 }), 50);
      });
    },
    [fitView]
  );

  const handleHover = useCallback((name: string | null) => setHoveredNodeId(name), []);
  const handleOpenDetail = useCallback((name: string) => {
    setDetailTableName(name);
    setNodeContextMenu(null);
  }, []);
  const handleNodeContextMenu = useCallback((name: string, x: number, y: number) => {
    setNodeContextMenu({ tableName: name, x, y });
  }, []);
  const handleToggleColumns = useCallback((name: string) => {
    setColumnsExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // --- Structural rebuild: which tables/edges are visible, and where they sit.
  useEffect(() => {
    const visible = focus.visibleIds;
    const visibleTableList = [...visible];

    const visibleEdges = graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target));

    // Radial/force scatter neighbors in every direction around a card, so
    // edges route to a computed point on the card's border (RelationshipEdge's
    // "floating" mode) instead of a fixed per-column dot — a specific column's
    // dot sitting mid-card would visually disagree with a line that enters
    // from, say, the top or left. Column-level handles stay hierarchical-only.
    const showColumnHandles = layoutKind !== 'radial' && layoutKind !== 'force';

    // Build a per-table set of column names that participate in at least one
    // visible edge. The ERD nodes use this to render a connection dot (Handle)
    // ONLY on those columns — orphan columns with no relationship stay clean.
    const connectedColumnsByTable = new Map<string, Set<string>>();
    if (showColumnHandles) {
      for (const e of visibleEdges) {
        let src = connectedColumnsByTable.get(e.source);
        if (!src) connectedColumnsByTable.set(e.source, (src = new Set()));
        src.add(e.sourceColumn);
        let tgt = connectedColumnsByTable.get(e.target);
        if (!tgt) connectedColumnsByTable.set(e.target, (tgt = new Set()));
        tgt.add(e.targetColumn);
      }
    }

    const connectedInView = new Set<string>();
    visibleEdges.forEach((e) => {
      connectedInView.add(e.source);
      connectedInView.add(e.target);
    });
    const isolatedInView = visibleTableList.filter((n) => !connectedInView.has(n));
    const connectedInViewList = visibleTableList.filter((n) => connectedInView.has(n));

    const positions = runLayout(layoutKind, {
      tableNames: connectedInViewList,
      tablesByName: graph.tablesByName,
      edges: visibleEdges,
      compact: isCompactEffective,
      rootId: focus.rootId,
      expandedColumnIds: columnsExpandedIds,
    });

    // Bounds of the connected sub-diagram — used to seat the isolated-tables
    // grid below it without colliding with any node.
    const connectedFootprints = new Map(
      connectedInViewList.map((name) => [
        name,
        {
          w: ERD_LAYOUT.nodeWidth,
          h: estimateNodeHeight(graph.tablesByName.get(name), isCompactEffective, columnsExpandedIds.has(name)),
        },
      ])
    );
    const connectedBounds = calculateGraphBounds(positions, connectedFootprints);

    const isolatedPositions = new Map<string, { x: number; y: number }>();
    const labelY = connectedBounds.maxY + (connectedInViewList.length > 0 ? ERD_LAYOUT.isolatedSectionGap : 0);
    const gridStartY = labelY + (isolatedInView.length > 0 ? 40 : 0);
    if (isolatedInView.length > 0) {
      const rowGap = ERD_LAYOUT.siblingVerticalGap;
      const perRow = Math.max(1, Math.ceil(Math.sqrt(isolatedInView.length)));
      let x = 0;
      let y = gridStartY;
      let rowMaxHeight = 0;
      isolatedInView.forEach((name, i) => {
        const h = estimateNodeHeight(graph.tablesByName.get(name), isCompactEffective, columnsExpandedIds.has(name));
        isolatedPositions.set(name, { x, y });
        rowMaxHeight = Math.max(rowMaxHeight, h);
        x += ERD_LAYOUT.nodeSlotWidth;
        if ((i + 1) % perRow === 0) {
          x = 0;
          y += rowMaxHeight + rowGap;
          rowMaxHeight = 0;
        }
      });
    }

    const nodeType = viewMode === 'graph' ? 'graphPill' : 'tableNode';

    const buildNode = (name: string, pos: { x: number; y: number } | undefined): Node => {
      const table = graph.tablesByName.get(name);
      const columns: ErdColumn[] = (table?.children || []).map((c) => ({
        name: c.name,
        type: c.data_type || '',
        pk: !!c.is_primary_key,
        fk: !!c.is_foreign_key || !!resolveFkTarget(c.name, schema.tables, name),
      }));

      const baseData: TableNodeData | GraphPillNodeData =
        nodeType === 'tableNode'
          ? {
              tableName: name,
              columns,
              compact: isCompactEffective,
              columnsExpanded: columnsExpandedIds.has(name),
              faded: false,
              isRoot: name === focus.rootId,
              degree: degrees.get(name) || 0,
              connectedColumns: connectedColumnsByTable.get(name) || new Set<string>(),
              onToggleColumns: handleToggleColumns,
              onExpandToggle: focus.toggleExpand,
              onHover: handleHover,
              onOpenDetail: handleOpenDetail,
              onContextMenu: handleNodeContextMenu,
            }
          : {
              tableName: name,
              degree: degrees.get(name) || 0,
              faded: false,
              isRoot: name === focus.rootId,
              onExpandToggle: focus.toggleExpand,
              onHover: handleHover,
              onOpenDetail: handleOpenDetail,
              onContextMenu: handleNodeContextMenu,
            };

      return {
        id: name,
        type: nodeType,
        position: pos || { x: 0, y: 0 },
        data: baseData as unknown as Record<string, unknown>,
        style:
          nodeType === 'tableNode'
            ? {
                background: '#0a0f18',
                color: '#fff',
                border: `1px solid ${name === focus.rootId ? '#3b82f6' : '#1e293b'}`,
                borderRadius: '12px',
                padding: '12px',
              }
            : undefined,
      };
    };

    const nextNodes: Node[] = [
      ...connectedInViewList.map((name) => buildNode(name, positions.get(name))),
      ...isolatedInView.map((name) => buildNode(name, isolatedPositions.get(name))),
    ];

    if (isolatedInView.length > 0) {
      nextNodes.push({
        id: '__group_unrelated',
        type: 'groupLabel',
        position: { x: 0, y: labelY },
        data: { label: `No detected relationships (${isolatedInView.length})` },
        draggable: false,
        selectable: false,
        connectable: false,
      });
    }

    // When grouping is on, collapse multiple FKs between the SAME table pair
    // (in either direction) into a single edge with a count badge. This reduces
    // visual clutter when two tables share many relationships.
    const edgeColor = connectorColor || '#3b82f6';
    const nextEdges: Edge[] = showEdges
      ? (groupEdges
          ? (() => {
              const groups = new Map<string, { e: typeof visibleEdges[0]; count: number }>();
              for (const e of visibleEdges) {
                const key = [e.source, e.target].sort().join('→');
                const g = groups.get(key);
                if (g) g.count++;
                else groups.set(key, { e, count: 1 });
              }
              return [...groups.values()].map(({ e, count }) => {
                const data: RelationshipEdgeData = {
                  kind: e.kind,
                  label: count > 1 ? `${count} relations` : e.targetColumn,
                  faded: false,
                  lineStyle,
                  groupCount: count,
                  connectorColor,
                  connectorType,
                  animated,
                  floating: !showColumnHandles,
                };
                return {
                  id: count > 1 ? `grp-${e.source}-${e.target}` : e.id,
                  source: e.source,
                  target: e.target,
                  type: 'relationship',
                  data: data as unknown as Record<string, unknown>,
                  markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 16, height: 16 },
                };
              });
            })()
          : visibleEdges.map((e) => {
              const data: RelationshipEdgeData = {
                kind: e.kind,
                label: e.targetColumn,
                faded: false,
                lineStyle,
                connectorColor,
                connectorType,
                animated,
                floating: !showColumnHandles,
              };
              return {
                id: e.id,
                source: e.source,
                target: e.target,
                sourceHandle: !isCompactEffective && nodeType === 'tableNode' && showColumnHandles ? `s-${e.sourceColumn}` : undefined,
                targetHandle: !isCompactEffective && nodeType === 'tableNode' && showColumnHandles ? `t-${e.targetColumn}` : undefined,
                type: 'relationship',
                data: data as unknown as Record<string, unknown>,
                markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor, width: 16, height: 16 },
              };
            }))
      : [];

    setNodes(nextNodes);
    setEdges(nextEdges);
    requestAnimationFrame(() => fitView({ padding: 0.25, duration: 400 }));
    // Re-runs (and re-lays-out) whenever the visible set, layout algorithm,
    // or a table's column-expansion changes — expanding a card's columns
    // makes it taller, so the whole diagram auto-rearranges to keep every
    // card clear of its neighbors instead of letting them overlap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    focus.visibleIds,
    focus.rootId,
    layoutKind,
    isCompactEffective,
    viewMode,
    showEdges,
    lineStyle,
    groupEdges,
    connectorColor,
    connectorType,
    animated,
    layoutVersion,
    graph,
    degrees,
    columnsExpandedIds,
  ]);

  // --- Interactive overlay: hover fade + per-node column expand, no repositioning.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.type === 'groupLabel') return n;
        let faded = false;
        if (hoveredNodeId) {
          faded = n.id !== hoveredNodeId && !getDirectNeighbors(graph, hoveredNodeId).has(n.id);
        } else if (hoveredEdgeId) {
          const e = graph.edges.find((ed) => ed.id === hoveredEdgeId);
          faded = !e || (n.id !== e.source && n.id !== e.target);
        }
        return {
          ...n,
          data: {
            ...n.data,
            faded,
            isRoot: n.id === focus.rootId,
          },
        };
      })
    );
    setEdges((eds) =>
      eds.map((e) => {
        let faded = false;
        if (hoveredNodeId) {
          faded = e.source !== hoveredNodeId && e.target !== hoveredNodeId;
        } else if (hoveredEdgeId) {
          faded = e.id !== hoveredEdgeId;
        }
        return { ...e, data: { ...e.data, faded } };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredNodeId, hoveredEdgeId, focus.rootId, graph]);

  // Ctrl/Cmd+K search palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSearchSelect = useCallback(
    (name: string) => {
      if (!focus.visibleIds.has(name)) {
        focus.setRoot(name);
      } else {
        const n = getNode(name);
        if (n) setCenter(n.position.x + 110, n.position.y + 40, { zoom: 1, duration: 500 });
      }
    },
    [focus, getNode, setCenter]
  );

  const handleCenterOnRoot = useCallback(() => {
    if (!focus.rootId) {
      fitView({ padding: 0.25, duration: 400 });
      return;
    }
    const n = getNode(focus.rootId);
    if (n) setCenter(n.position.x + 110, n.position.y + 40, { zoom: 1, duration: 500 });
    else fitView({ padding: 0.25, duration: 400 });
  }, [focus.rootId, getNode, setCenter, fitView]);

  const currentLayout = LAYOUT_OPTIONS.find((l) => l.id === layoutKind);

  const layoutMenuPos = useDropdownPosition(layoutBtnRef, layoutMenuOpen, 'bottom-start', 224);
  const exportMenuPos = useDropdownPosition(exportBtnRef, exportMenuOpen && !exporting, 'bottom-end', 240);
  const exportErrorPos = useDropdownPosition(exportBtnRef, !!exportError, 'bottom-end', 280);
  const optionsMenuPos = useDropdownPosition(optionsBtnRef, optionsMenuOpen, 'right-start', 256);

  return (
    <div className="w-full h-full bg-[#06090e] flex flex-col relative select-none">
      {/* Top Toolbar — an info row and a clustered, wrapping control row.
          Buttons are icon-only (tooltips carry the label) so the row stays
          compact; each cluster is a non-breaking unit (shrink-0) so narrow
          widths wrap whole groups onto the next line instead of splitting
          them. Zoom in/out/fit are intentionally NOT duplicated here — the
          canvas's own Controls panel (bottom-left) already provides them. */}
      <div className="bg-[#0a0f18] border-b border-[#1e293b] relative">
        <div className="px-3 py-2 flex items-center gap-2 min-w-0">
          <GitFork className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-xs font-bold text-slate-200 shrink-0 hidden sm:inline">Visual ERD Studio</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-mono flex items-center gap-1 truncate min-w-0">
            <Database className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {schema.connectionName} / {schema.schemaName}
            </span>
          </span>
          <span className="text-[10px] text-slate-500 font-mono shrink-0 hidden md:inline">
            {focus.showAll ? `${schema.tables.length} tables` : `${focus.visibleIds.size} / ${schema.tables.length} shown`}
          </span>

          <div className="flex-1" />

          <button
            onClick={() => setSearchOpen(true)}
            className="p-1.5 rounded-lg bg-[#0f172a] border border-[#1e293b] text-slate-400 hover:text-slate-200 transition-colors shrink-0"
            title="Search tables (Ctrl+K)"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
          {/* View Mode — one of the two primary controls (it changes what the
              whole canvas renders), so it keeps a visible label unlike the
              rest of this row. */}
          <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden shrink-0">
            <button
              onClick={() => handleSetViewMode('diagram')}
              className={`px-2.5 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors ${
                viewMode === 'diagram' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
              }`}
              title="ER Diagram — full table cards"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>ER Diagram</span>
            </button>
            <button
              onClick={() => handleSetViewMode('graph')}
              className={`px-2.5 py-1.5 text-xs font-medium flex items-center gap-1.5 transition-colors border-l border-[#1e293b] ${
                viewMode === 'graph' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
              }`}
              title="Relationship Graph — simplified overview"
            >
              <Share2 className="w-3.5 h-3.5" />
              <span>Relationship Graph</span>
            </button>
          </div>

          {/* Layout picker */}
          <div className="shrink-0">
            <button
              ref={layoutBtnRef}
              onClick={() => setLayoutMenuOpen((v) => !v)}
              className={`p-1.5 rounded-lg transition-colors ${
                layoutMenuOpen ? 'bg-[#334155] text-white' : 'bg-[#1e293b] hover:bg-[#334155] text-slate-200'
              }`}
              title={`Auto layout algorithm — ${currentLayout?.label ?? ''}`}
            >
              <Workflow className="w-3.5 h-3.5" />
            </button>
            {layoutMenuOpen && (
              <div
                ref={layoutMenuPos.panelRef}
                style={{ position: 'fixed', top: layoutMenuPos.style.top, left: layoutMenuPos.style.left, visibility: layoutMenuPos.style.visibility, width: 224 }}
                className="bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5 z-[100]"
                onMouseLeave={() => setLayoutMenuOpen(false)}
              >
                {LAYOUT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    disabled={!opt.available}
                    title={opt.unavailableReason}
                    onClick={() => {
                      if (!opt.available) return;
                      setLayoutKind(opt.id);
                      setLayoutMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center justify-between gap-2 transition-colors ${
                      opt.id === layoutKind ? 'bg-blue-600/20 text-blue-400 font-semibold' : 'text-slate-300'
                    } ${opt.available ? 'hover:bg-[#141e33]' : 'opacity-40 cursor-not-allowed'}`}
                  >
                    <span>{opt.label}</span>
                    {!opt.available && <span className="text-[9px] text-slate-500">soon</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Re-run the chosen layout algorithm — lives next to the layout
              picker it acts on, instead of buried in the canvas panel. */}
          <button
            onClick={() => setLayoutVersion((v) => v + 1)}
            className="p-1.5 rounded-lg bg-[#1e293b] hover:bg-[#334155] text-slate-300 hover:text-slate-100 transition-colors shrink-0"
            title="Reset layout — re-run the auto layout algorithm"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {/* Depth / Focus */}
          <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden shrink-0">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                onClick={() => focus.setDepth(d as 1 | 2 | 3)}
                className={`px-2.5 py-1.5 text-xs font-mono transition-colors ${
                  !focus.showAll ? 'text-slate-300 hover:bg-[#1e293b]' : 'text-slate-600 hover:bg-[#1e293b]'
                }`}
                title={`Focus depth ${d}`}
              >
                D{d}
              </button>
            ))}
            <button
              onClick={() => focus.setShowAll(!focus.showAll)}
              className={`p-1.5 transition-colors border-l border-[#1e293b] ${
                focus.showAll ? 'bg-amber-500/20 text-amber-400' : 'text-slate-400 hover:bg-[#1e293b]'
              }`}
              title="Show every table (may be slow on very large schemas)"
            >
              <Network className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Expand / collapse */}
          <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden shrink-0">
            <button
              onClick={() => focus.expandAll()}
              className="p-1.5 text-slate-300 hover:bg-[#1e293b] transition-colors"
              title="Expand all tables"
            >
              <Expand className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={focus.collapseAll}
              className="p-1.5 text-slate-300 hover:bg-[#1e293b] transition-colors border-l border-[#1e293b]"
              title="Collapse back to focus root"
            >
              <Shrink className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 min-w-[8px]" />

          {/* Export — the other primary control (it's the main output action
              for this whole screen), so it keeps its label too. */}
          <div className="shrink-0">
            <button
              ref={exportBtnRef}
              onClick={() => !exporting && setExportMenuOpen((v) => !v)}
              disabled={exporting}
              className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-wait text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
              title={exporting ? 'Exporting…' : 'Export the current diagram'}
            >
              {exporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>{exporting ? 'Exporting…' : 'Export'}</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            {exportMenuOpen && !exporting && (
              <>
                {/* Click-away catcher — same pattern as the color picker popover. */}
                <div className="fixed inset-0 z-[90]" onClick={() => setExportMenuOpen(false)} />
                <div
                  ref={exportMenuPos.panelRef}
                  style={{ position: 'fixed', top: exportMenuPos.style.top, left: exportMenuPos.style.left, visibility: exportMenuPos.style.visibility, width: 240 }}
                  className="bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5 z-[100]"
                >
                  <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                    Export diagram
                  </div>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      exportPng();
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-[#141e33] transition-colors"
                  >
                    <ImageIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                    <span className="flex flex-col">
                      <span className="font-medium text-slate-200">PNG Image</span>
                      <span className="text-[10px] text-slate-500">Rasterized diagram with dark background</span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      exportPdf();
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-[#141e33] transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    <span className="flex flex-col">
                      <span className="font-medium text-slate-200">PDF Document</span>
                      <span className="text-[10px] text-slate-500">Full-page vector-quality diagram</span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      exportMermaid();
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-[#141e33] transition-colors"
                  >
                    <FileCode2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <span className="flex flex-col">
                      <span className="font-medium text-slate-200">Mermaid <span className="font-mono text-[10px] text-slate-500">.mmd</span></span>
                      <span className="text-[10px] text-slate-500">erDiagram — renders on GitHub, Notion, mermaid.live</span>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setExportMenuOpen(false);
                      exportDdl();
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-300 hover:bg-[#141e33] transition-colors"
                  >
                    <Code className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span className="flex flex-col">
                      <span className="font-medium text-slate-200">SQL DDL <span className="font-mono text-[10px] text-slate-500">.sql</span></span>
                      <span className="text-[10px] text-slate-500">CREATE TABLE statements with PK/FK</span>
                    </span>
                  </button>
                </div>
              </>
            )}
            {exportError && (
              <div
                ref={exportErrorPos.panelRef}
                style={{ position: 'fixed', top: exportErrorPos.style.top, left: exportErrorPos.style.left, visibility: exportErrorPos.style.visibility, width: 280 }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-red-300 text-[11px] z-[100]"
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="truncate">{exportError}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Canvas row — the ERD canvas plus the docked table-detail panel,
          Explorer-sidebar style (a resizable sibling column, not a floating
          overlay). */}
      <div className="flex-1 flex flex-row overflow-hidden relative" ref={canvasRowRef}>
      {/* ERD Canvas Area */}
      <div className="flex-1 min-w-0 h-full relative" ref={canvasRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={erdNodeTypes}
          edgeTypes={erdEdgeTypes}
          onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)}
          onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          nodesDraggable
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.25 }}
        >
          <Background color="#1e293b" gap={16} size={1} />
          {showMinimap && (
            <MiniMap
              pannable
              zoomable
              className="!bg-[#0a0f18] !border !border-[#1e293b] !rounded-lg overflow-hidden"
              maskColor="rgba(6, 9, 14, 0.65)"
              nodeColor={() => '#1e293b'}
              nodeStrokeColor="#3b82f6"
            />
          )}
        </ReactFlow>

        {/* Floating canvas controls — pure navigation only (zoom, fit, center),
            plus a single "Options" button that opens every view/connector-style
            toggle in one popover. Pinned to the TOP-LEFT corner so it never
            collides with React Flow's Controls (bottom-left) or MiniMap
            (bottom-right). */}
        <div className="absolute top-3 left-3 z-20">
          <div className="flex flex-col items-center gap-1 bg-[#0a0f18]/90 backdrop-blur border border-[#1e293b] rounded-xl p-1 shadow-lg">
            {/* Zoom controls — replaces React Flow's separate <Controls> panel
                so there's only one unified toolbar on the canvas. */}
            <button
              onClick={() => zoomIn({ duration: 200 })}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => zoomOut({ duration: 200 })}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => fitView({ padding: 0.25, duration: 400 })}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 transition-colors"
              title="Fit diagram to view"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <div className="w-5 h-px bg-[#1e293b]" />
            <button
              onClick={handleCenterOnRoot}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-[#1e293b] hover:text-slate-200 transition-colors"
              title="Center on focus root"
            >
              <Crosshair className="w-3.5 h-3.5" />
            </button>
            <div className="w-5 h-px bg-[#1e293b]" />

            {/* Everything else — view toggles + connector style + color —
                lives behind one "Options" button instead of nine separate
                icons always on screen. */}
            <div className="relative">
              <button
                ref={optionsBtnRef}
                onClick={() => setOptionsMenuOpen((v) => !v)}
                className={`p-1.5 rounded-lg transition-colors ${
                  optionsMenuOpen ? 'bg-blue-600/20 text-blue-400' : 'text-slate-400 hover:bg-[#1e293b] hover:text-slate-200'
                }`}
                title="Diagram options"
              >
                <Settings2 className="w-3.5 h-3.5" />
              </button>
              {optionsMenuOpen && typeof document !== 'undefined' && createPortal(
                <>
                  <div className="fixed inset-0 z-[90]" onClick={() => setOptionsMenuOpen(false)} />
                  {/* Portaled to <body> — this trigger sits inside a
                      `backdrop-blur` ancestor (the floating canvas panel),
                      and backdrop-filter establishes a containing block for
                      `position: fixed` descendants just like `transform`
                      does. Left in place, our viewport-computed coordinates
                      (useDropdownPosition) would resolve against that
                      ancestor's box instead of the viewport, undoing the fix
                      and re-exposing the panel to the ERD tab's
                      overflow-hidden clipping. Portaling out of that
                      subtree keeps it truly viewport-fixed. */}
                  <div
                    ref={optionsMenuPos.panelRef}
                    style={{ position: 'fixed', top: optionsMenuPos.style.top, left: optionsMenuPos.style.left, visibility: optionsMenuPos.style.visibility, width: 256 }}
                    className="bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-2 z-[100] text-slate-200">
                    <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-slate-500 font-bold">View</div>
                    <div className="px-1.5 flex flex-col gap-0.5">
                      <OptionToggle
                        icon={compact ? EyeOff : Eye}
                        label={compact ? 'Columns hidden' : 'Columns visible'}
                        active={!compact}
                        onClick={() => setCompact((c) => !c)}
                      />
                      <OptionToggle
                        icon={Waypoints}
                        label="Relationships"
                        active={showEdges}
                        onClick={() => setShowEdges((v) => !v)}
                      />
                      <OptionToggle
                        icon={MapIcon}
                        label="Minimap"
                        active={showMinimap}
                        onClick={() => setShowMinimap((v) => !v)}
                      />
                    </div>

                    <div className="h-px bg-[#1e293b] my-2" />

                    <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                      Connector Style
                    </div>
                    <div className="px-3 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-9 shrink-0">Line</span>
                        <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden flex-1">
                          <button
                            onClick={() => setLineStyle('curve')}
                            className={`flex-1 py-1 text-[11px] flex items-center justify-center gap-1 transition-colors ${
                              lineStyle === 'curve' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
                            }`}
                          >
                            <Spline className="w-3 h-3" /> Curve
                          </button>
                          <button
                            onClick={() => setLineStyle('step')}
                            className={`flex-1 py-1 text-[11px] flex items-center justify-center gap-1 transition-colors border-l border-[#1e293b] ${
                              lineStyle === 'step' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
                            }`}
                          >
                            <Sigma className="w-3 h-3" /> Angled
                          </button>
                          <button
                            onClick={() => setLineStyle('circuit')}
                            title="Circuit — chamfered right-angle traces with via pads, PCB style"
                            className={`flex-1 py-1 text-[11px] flex items-center justify-center gap-1 transition-colors border-l border-[#1e293b] ${
                              lineStyle === 'circuit' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
                            }`}
                          >
                            <CircuitBoard className="w-3 h-3" /> Circuit
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-slate-500 w-9 shrink-0">Type</span>
                        <div className="flex items-center rounded-lg border border-[#1e293b] overflow-hidden flex-1">
                          <button
                            onClick={() => setConnectorType('normal')}
                            className={`flex-1 py-1 text-[11px] transition-colors ${
                              connectorType === 'normal' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
                            }`}
                          >
                            Solid
                          </button>
                          <button
                            onClick={() => setConnectorType('dot')}
                            className={`flex-1 py-1 text-[11px] flex items-center justify-center gap-1 transition-colors border-l border-[#1e293b] ${
                              connectorType === 'dot' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:bg-[#1e293b]'
                            }`}
                          >
                            <MoreHorizontal className="w-3 h-3" /> Dotted
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="px-1.5 mt-2 flex flex-col gap-0.5">
                      <OptionToggle
                        icon={GitFork}
                        label="Group relations"
                        active={groupEdges}
                        onClick={() => setGroupEdges((v) => !v)}
                      />
                      <OptionToggle
                        icon={Zap}
                        label="Animate lines"
                        active={animated}
                        onClick={() => setAnimated((v) => !v)}
                      />
                    </div>

                    <div className="h-px bg-[#1e293b] my-2" />

                    <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-bold flex items-center gap-1.5">
                      <Palette className="w-3 h-3" /> Connector Color
                    </div>
                    <div className="px-3 flex flex-wrap gap-1.5">
                      {[
                        { c: undefined, label: 'Auto (by type)', cls: 'bg-gradient-to-br from-blue-400 via-amber-400 to-green-400' },
                        { c: 'per-connection', label: 'Per connection', cls: 'bg-gradient-to-br from-cyan-400 via-pink-400 to-orange-400' },
                        { c: '#3b82f6', label: 'Blue', cls: 'bg-blue-500' },
                        { c: '#10b981', label: 'Green', cls: 'bg-emerald-500' },
                        { c: '#f59e0b', label: 'Amber', cls: 'bg-amber-500' },
                        { c: '#a855f7', label: 'Purple', cls: 'bg-purple-500' },
                        { c: '#ef4444', label: 'Red', cls: 'bg-red-500' },
                        { c: '#64748b', label: 'Slate', cls: 'bg-slate-500' },
                      ].map((opt) => (
                        <button
                          key={opt.label}
                          onClick={() => setConnectorColor(opt.c)}
                          title={opt.label}
                          className={`w-6 h-6 rounded-full ${opt.cls} shrink-0 transition-all ${
                            connectorColor === opt.c ? 'ring-2 ring-offset-2 ring-offset-[#0a0f18] ring-white' : 'opacity-70 hover:opacity-100'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </>,
                document.body
              )}
            </div>
          </div>
        </div>

        <SearchPalette
          open={searchOpen}
          tableNames={graph.tableNames}
          onSelect={handleSearchSelect}
          onClose={() => setSearchOpen(false)}
        />

        {/* Right-click context menu on a table/pill node — a single "Table
            Detail" entry point into the detail drawer below. Portaled for the
            same reason as the Options popover: this sits inside the ERD tab's
            overflow-hidden ancestor chain, and a plain absolute/fixed panel
            left in place would resolve its coordinates against the nearest
            transformed/filtered ancestor instead of the viewport. */}
        {nodeContextMenu && typeof document !== 'undefined' && createPortal(
          <>
            <div
              className="fixed inset-0 z-[95]"
              onClick={() => setNodeContextMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setNodeContextMenu(null);
              }}
            />
            <div
              style={{
                position: 'fixed',
                top: Math.min(nodeContextMenu.y, window.innerHeight - 96),
                left: Math.min(nodeContextMenu.x, window.innerWidth - 216),
              }}
              className="w-52 bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl py-1.5 z-[96] text-slate-200"
            >
              <div className="px-3 pb-1.5 mb-1 border-b border-[#1e293b] flex items-center gap-1.5 text-[11px] font-mono text-slate-400 truncate">
                <Database className="w-3 h-3 shrink-0 text-blue-400" />
                <span className="truncate">{nodeContextMenu.tableName}</span>
              </div>
              <button
                onClick={() => handleOpenDetail(nodeContextMenu.tableName)}
                className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-slate-200 hover:bg-[#141e33] transition-colors"
              >
                <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                Table Detail
              </button>
            </div>
          </>,
          document.body
        )}
      </div>

      {/* Docked table-detail panel — Explorer/AI-panel resize pattern: a
          drag handle followed by a fixed-width (store-persisted-in-session)
          column, only mounted while a table is selected. */}
      {detailTableName && (
        <>
          <div
            onMouseDown={() => setIsResizingDetail(true)}
            className="w-1.5 h-full bg-[#1e293b]/40 hover:bg-cyan-500 cursor-col-resize z-30 transition-colors shrink-0"
            title="Drag to resize table detail panel"
          />
          <div style={{ width: `${erdDetailPanelWidth * zoomLevel}px` }} className="h-full shrink-0 relative">
            <TableDetailDrawer
              open={!!detailTableName}
              onClose={() => setDetailTableName(null)}
              tableName={detailTableName}
              schema={schema}
              graph={graph}
              table={detailTableName ? graph.tablesByName.get(detailTableName) : undefined}
              degree={detailTableName ? degrees.get(detailTableName) || 0 : 0}
            />
          </div>
        </>
      )}
      </div>
    </div>
  );
}

export const VisualERDCanvas: React.FC<{ schema: ErdSchemaContext | null }> = ({ schema }) => {
  if (!schema) return <EmptyState />;

  return (
    <ReactFlowProvider>
      <ErdInner key={`${schema.connectionId}-${schema.schemaName}-${schema.focusTableName || ''}`} schema={schema} />
    </ReactFlowProvider>
  );
};
