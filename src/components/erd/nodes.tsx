import React from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { Table as TableIcon, KeyRound, Link2, Database } from 'lucide-react';

export interface ErdColumn {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

export interface TableNodeData {
  tableName: string;
  columns: ErdColumn[];
  compact: boolean;
  columnsExpanded: boolean;
  faded: boolean;
  isRoot: boolean;
  degree: number;
  /** Column names that have at least one relationship edge connected to them.
   *  Only these columns render a Handle (connection dot) — orphan columns with
   *  no edges stay clean, no floating blue dots. */
  connectedColumns: Set<string>;
  onToggleColumns: (name: string) => void;
  onExpandToggle: (name: string) => void;
  onHover: (name: string | null) => void;
  /** Double-click on the card, or "Table Detail" from the right-click menu. */
  onOpenDetail: (name: string) => void;
  /** Right-click on the card — opens the small "Table Detail" context menu. */
  onContextMenu: (name: string, x: number, y: number) => void;
}

const targetHandleId = (col: string) => `t-${col}`;
const sourceHandleId = (col: string) => `s-${col}`;
const COLUMN_PREVIEW_COUNT = 5;

export const TableNode = React.memo(function TableNode({ data }: NodeProps) {
  const d = data as unknown as TableNodeData;
  const remaining = d.columns.length - COLUMN_PREVIEW_COUNT;
  const visibleCols = d.compact ? [] : d.columnsExpanded ? d.columns : d.columns.slice(0, COLUMN_PREVIEW_COUNT);

  return (
    <div
      className={`text-xs w-[220px] max-w-[220px] transition-opacity duration-200 ${
        d.faded ? 'opacity-20' : 'opacity-100'
      }`}
      onMouseEnter={() => d.onHover(d.tableName)}
      onMouseLeave={() => d.onHover(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        d.onContextMenu(d.tableName, e.clientX, e.clientY);
      }}
    >
      {/* Whole-node fallback connection points. Compact mode shows them as the
          only connection dots. In expanded mode they stay invisible but are
          still present so React Flow always has an id-less handle to resolve
          to — needed for radial/force layouts, which route edges to a
          computed point on the card's border (see RelationshipEdge's
          "floating" mode) rather than a fixed per-column dot, since a
          neighbor can sit on any side of the card in those layouts. */}
      <Handle
        type="target"
        position={Position.Left}
        className={`!bg-blue-500 !w-2 !h-2 ${d.compact ? '' : '!opacity-0 pointer-events-none'}`}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={`!bg-blue-500 !w-2 !h-2 ${d.compact ? '' : '!opacity-0 pointer-events-none'}`}
      />

      <div
        className={`font-bold text-slate-100 flex items-center gap-1.5 cursor-pointer select-none ${
          d.compact ? '' : 'border-b border-[#1e293b] pb-1.5 mb-1.5'
        } ${d.isRoot ? 'text-blue-400' : ''}`}
        onClick={() => d.onExpandToggle(d.tableName)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          d.onOpenDetail(d.tableName);
        }}
        title="Click to expand/collapse · double-click for table detail · right-click for options"
      >
        <TableIcon className={`w-3.5 h-3.5 shrink-0 ${d.isRoot ? 'text-blue-400' : 'text-cyan-400'}`} />
        <span className="truncate">{d.tableName}</span>
        {d.isRoot && (
          <span className="text-[8px] px-1 py-0.2 rounded bg-blue-500/20 text-blue-400 font-mono shrink-0">
            ROOT
          </span>
        )}
        {d.degree > 0 && (
          <span className="ml-auto text-[9px] text-slate-500 font-mono shrink-0">{d.degree}</span>
        )}
        {d.compact && (
          <span className="text-[9px] text-slate-500 font-mono shrink-0">{d.columns.length} cols</span>
        )}
      </div>

      {!d.compact && (
        <div className="flex flex-col gap-1">
          {visibleCols.map((c) => {
            const hasConnection = d.connectedColumns.has(c.name);
            return (
            <div
              key={c.name}
              className="relative flex items-center justify-between gap-2 text-[10.5px] font-mono py-0.5"
            >
              {/* Only render the connection dot (Handle) when this column
                  actually participates in a relationship edge — no orphan
                  blue dots on columns that have no lines. */}
              {hasConnection && (
                <Handle
                  type="target"
                  position={Position.Left}
                  id={targetHandleId(c.name)}
                  className="!bg-cyan-400 !w-1.5 !h-1.5 !border-0"
                  style={{ left: -7 }}
                />
              )}
              <span className="flex items-center gap-1.5 truncate min-w-0">
                {c.pk ? (
                  <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />
                ) : c.fk ? (
                  <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span className={`truncate ${c.pk ? 'text-amber-300 font-semibold' : 'text-slate-300'}`}>
                  {c.name}
                </span>
              </span>
              {c.type && (
                <span className="text-slate-500 shrink-0 lowercase truncate max-w-[70px]">{c.type}</span>
              )}
              {hasConnection && (
                <Handle
                  type="source"
                  position={Position.Right}
                  id={sourceHandleId(c.name)}
                  className="!bg-blue-500 !w-1.5 !h-1.5 !border-0"
                  style={{ right: -7 }}
                />
              )}
            </div>
            );
          })}

          {remaining > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                d.onToggleColumns(d.tableName);
              }}
              className="text-[10px] text-blue-400 hover:text-blue-300 text-left mt-0.5 font-mono"
            >
              {d.columnsExpanded ? 'Show less' : `+${remaining} more...`}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export interface GraphPillNodeData {
  tableName: string;
  degree: number;
  faded: boolean;
  isRoot: boolean;
  onExpandToggle: (name: string) => void;
  onHover: (name: string | null) => void;
  onOpenDetail: (name: string) => void;
  onContextMenu: (name: string, x: number, y: number) => void;
}

export const GraphPillNode = React.memo(function GraphPillNode({ data }: NodeProps) {
  const d = data as unknown as GraphPillNodeData;
  return (
    <div
      className={`px-3 py-2 rounded-full border text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all duration-200 whitespace-nowrap ${
        d.isRoot
          ? 'bg-blue-600 border-blue-400 text-white shadow-md shadow-blue-600/30'
          : 'bg-[#0a0f18] border-[#1e293b] text-slate-200 hover:border-slate-600'
      } ${d.faded ? 'opacity-20' : 'opacity-100'}`}
      onMouseEnter={() => d.onHover(d.tableName)}
      onMouseLeave={() => d.onHover(null)}
      onClick={() => d.onExpandToggle(d.tableName)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        d.onOpenDetail(d.tableName);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        d.onContextMenu(d.tableName, e.clientX, e.clientY);
      }}
      title="Click to expand/collapse · double-click for table detail · right-click for options"
    >
      <Handle type="target" position={Position.Left} className="!bg-blue-500 !w-1.5 !h-1.5" />
      <Database className="w-3 h-3 shrink-0" />
      <span className="truncate max-w-[130px]">{d.tableName}</span>
      {d.degree > 0 && <span className="text-[9px] opacity-70 font-mono">{d.degree}</span>}
      <Handle type="source" position={Position.Right} className="!bg-blue-500 !w-1.5 !h-1.5" />
    </div>
  );
});

export interface GroupLabelData {
  label: string;
}

export const GroupLabelNode = React.memo(function GroupLabelNode({ data }: NodeProps) {
  const d = data as unknown as GroupLabelData;
  return (
    <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap select-none flex items-center gap-2">
      <span className="w-6 h-px bg-[#1e293b]" />
      {d.label}
    </div>
  );
});

export const erdNodeTypes = {
  tableNode: TableNode,
  graphPill: GraphPillNode,
  groupLabel: GroupLabelNode,
};
