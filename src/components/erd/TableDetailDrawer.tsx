import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Copy,
  Check,
  Table as TableIcon,
  KeyRound,
  Link2,
  Loader2,
  AlertTriangle,
  Columns3,
  ListTree,
  Zap,
  Eye as EyeIcon,
} from 'lucide-react';
import { ErdSchemaContext, SchemaTableNode } from '../../core/domain/types';
import { SchemaGraphModel } from '../../core/erd/types';
import { useConnectionStore } from '../../store/useConnectionStore';
import { fetchTableIndexes, fetchTableForeignKeys, IndexInfo, ForeignKeyInfo } from '../../core/sql/indexIntrospection';
import { fetchTableTriggers, TriggerInfo } from '../../core/sql/triggerIntrospection';

type DetailTab = 'details' | 'columns' | 'indexes' | 'triggers';

interface TableDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  tableName: string | null;
  schema: ErdSchemaContext;
  graph: SchemaGraphModel;
  table: SchemaTableNode | undefined;
  degree: number;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

function formatCount(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return n.toLocaleString('en-US');
}

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'columns', label: 'Columns' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'triggers', label: 'Triggers' },
];

/** A quiet label/value row — the base unit of the Details tab's metadata list. */
function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11.5px] text-slate-500">{label}</span>
      <span className="text-[11.5px] text-slate-200 font-mono truncate max-w-[65%]">{value}</span>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  label,
  count,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300 mb-1.5">
      <Icon className="w-3.5 h-3.5 text-slate-500" />
      {label}
      <span className="text-slate-500 font-normal">({count})</span>
    </div>
  );
}

function ColumnRow({ name, type, pk, fk }: { name: string; type: string; pk: boolean; fk: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[#0f172a] transition-colors">
      {pk ? (
        <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />
      ) : fk ? (
        <Link2 className="w-3 h-3 text-cyan-400 shrink-0" />
      ) : (
        <span className="w-1 h-1 rounded-full bg-slate-700 shrink-0 ml-1 mr-1" />
      )}
      <span className={`text-[11.5px] font-mono truncate ${pk ? 'text-amber-300' : 'text-slate-300'}`}>{name}</span>
      <span className="ml-auto text-[10.5px] font-mono text-slate-500 lowercase shrink-0 truncate max-w-[35%]">{type}</span>
      {(pk || fk) && (
        <span className={`text-[9.5px] font-mono font-semibold shrink-0 w-6 text-right ${pk ? 'text-amber-400' : 'text-cyan-400'}`}>
          {pk ? 'PK' : 'FK'}
        </span>
      )}
    </div>
  );
}

/**
 * Read-only right-panel showing a full breakdown of a single ERD table —
 * styled to match the docked detail panel in the marketing ERD screenshot
 * (plain label/value rows, no card chrome, colored text badges instead of
 * filled pills). Opened via double-click or the node's right-click menu.
 *
 * Indexes/triggers/foreign-keys aren't carried in `ErdSchemaContext` (the
 * schema tree only has PK/FK-flagged columns), so this queries them live the
 * same way `TableStructureModal` does.
 */
export function TableDetailDrawer({ open, onClose, tableName, schema, graph, table, degree }: TableDetailDrawerProps) {
  const [tab, setTab] = useState<DetailTab>('details');
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [copied, setCopied] = useState(false);

  const conn = useConnectionStore((s) => s.connections.find((c) => c.id === schema.connectionId));
  const engine = conn?.engine;

  useEffect(() => {
    if (open) setTab('details');
  }, [open, tableName]);

  useEffect(() => {
    if (!open || !tableName || !conn || !engine) return;
    let cancelled = false;
    setLoadingMeta(true);
    setMetaError(null);
    (async () => {
      try {
        const [idxs, fks, trgs] = await Promise.all([
          fetchTableIndexes({ config: conn, engine, schema: schema.schemaName, table: tableName }),
          fetchTableForeignKeys({ config: conn, engine, schema: schema.schemaName, table: tableName }),
          fetchTableTriggers({ config: conn, engine, schema: schema.schemaName, table: tableName }),
        ]);
        if (cancelled) return;
        setIndexes(idxs);
        setForeignKeys(fks);
        setTriggers(trgs);
      } catch (err: any) {
        if (cancelled) return;
        setMetaError(err?.message || String(err));
        setIndexes([]);
        setForeignKeys([]);
        setTriggers([]);
      } finally {
        if (!cancelled) setLoadingMeta(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tableName, conn, engine, schema.schemaName]);

  const fkByColumn = useMemo(() => {
    const m = new Map<string, ForeignKeyInfo>();
    foreignKeys.forEach((fk) => m.set(fk.column, fk));
    return m;
  }, [foreignKeys]);

  const columns = useMemo(
    () =>
      (table?.children || []).map((c) => ({
        name: c.name,
        type: c.data_type || '',
        pk: !!c.is_primary_key,
        fk: !!c.is_foreign_key || fkByColumn.has(c.name),
      })),
    [table, fkByColumn]
  );

  // Relations derived from the ERD's already-computed edge graph (no extra
  // query needed) — both directions: FKs this table owns (outgoing) and FKs
  // other tables hold that point back at this one (incoming).
  const relations = useMemo(() => {
    if (!tableName) return [];
    return graph.edges
      .filter((e) => e.source === tableName || e.target === tableName)
      .map((e) => {
        if (e.target === tableName) {
          // We own the FK column.
          return { key: e.id, left: e.targetColumn, dir: 'out' as const, right: `${e.source}.${e.sourceColumn}` };
        }
        // Another table's FK column points back at us.
        return { key: e.id, left: e.sourceColumn, dir: 'in' as const, right: `${e.target}.${e.targetColumn}` };
      });
  }, [graph.edges, tableName]);

  const handleCopyName = () => {
    if (!tableName) return;
    navigator.clipboard?.writeText(tableName).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (!tableName || !table) return null;

  const rowCount = formatCount(table.row_count);
  const size = formatBytes(table.size_bytes);

  return (
    <div className="h-full w-full bg-[#0a0f18] border-l border-[#1e293b] flex flex-col">
      {/* Header */}
        <div className="px-4 pt-3.5 pb-2.5 shrink-0">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {table.node_type === 'view' ? 'View' : 'Table'}
            </span>
            <button
              onClick={onClose}
              className="p-0.5 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors -mt-0.5 -mr-0.5"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {table.node_type === 'view' ? (
              <EyeIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <TableIcon className="w-4 h-4 text-blue-400 shrink-0" />
            )}
            <span className="text-[15px] font-bold text-slate-100 truncate">{tableName}</span>
            <button
              onClick={handleCopyName}
              className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-[#1e293b] transition-colors shrink-0"
              title="Copy table name"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-3.5 px-4 border-b border-[#1e293b] shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`py-2 text-[12.5px] font-medium border-b-2 -mb-px transition-colors ${
                tab === t.id ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3.5">
          {tab === 'details' && (
            <div className="space-y-4">
              <div>
                <MetaRow label="Schema" value={schema.schemaName} />
                <MetaRow label="Table Type" value={table.node_type === 'view' ? 'VIEW' : 'BASE TABLE'} />
                <MetaRow label="Rows (est.)" value={rowCount ?? '—'} />
                <MetaRow label="Size" value={size ?? '—'} />
                <MetaRow label="Relationships" value={String(degree)} />
              </div>

              {columns.length > 0 && (
                <div>
                  <SectionHeading icon={Columns3} label="Columns" count={columns.length} />
                  <div>
                    {columns.map((c) => (
                      <ColumnRow key={c.name} {...c} />
                    ))}
                  </div>
                </div>
              )}

              <div>
                <SectionHeading icon={ListTree} label="Indexes" count={indexes.length} />
                {loadingMeta ? (
                  <InlineLoading />
                ) : indexes.length === 0 ? (
                  <EmptyLine label="No indexes." />
                ) : (
                  <div>
                    {indexes.map((idx) => (
                      <div key={idx.name} className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[#0f172a] transition-colors">
                        <KeyRound className={`w-3 h-3 shrink-0 ${idx.isPrimary ? 'text-fuchsia-400' : 'text-slate-600'}`} />
                        <span className="text-[11.5px] font-mono text-slate-300 truncate">{idx.name}</span>
                        <span
                          className={`ml-auto text-[9.5px] font-mono font-semibold shrink-0 ${
                            idx.isPrimary ? 'text-fuchsia-400' : idx.isUnique ? 'text-blue-400' : 'text-slate-500'
                          }`}
                        >
                          {idx.isPrimary ? 'PRIMARY' : idx.isUnique ? 'UNIQUE' : 'INDEX'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {relations.length > 0 && (
                <div>
                  <SectionHeading icon={Link2} label="Relations" count={relations.length} />
                  <div>
                    {relations.map((r) => (
                      <div key={r.key} className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[#0f172a] transition-colors">
                        <Link2 className="w-3 h-3 text-slate-600 shrink-0" />
                        <span className="text-[11.5px] font-mono text-slate-300 truncate">{r.left}</span>
                        <span className="text-slate-600 shrink-0">{r.dir === 'out' ? '→' : '←'}</span>
                        <span className="text-[11.5px] font-mono text-slate-500 truncate">{r.right}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'columns' && (
            <div>
              {columns.map((c) => (
                <ColumnRow key={c.name} {...c} />
              ))}
            </div>
          )}

          {tab === 'indexes' && (
            <>
              {loadingMeta ? (
                <InlineLoading />
              ) : metaError ? (
                <ErrorLine message={metaError} />
              ) : indexes.length === 0 ? (
                <EmptyLine label="No indexes on this table." />
              ) : (
                <div className="space-y-3">
                  {indexes.map((idx) => (
                    <div key={idx.name}>
                      <div className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[#0f172a] transition-colors">
                        <KeyRound className={`w-3.5 h-3.5 shrink-0 ${idx.isPrimary ? 'text-fuchsia-400' : 'text-slate-600'}`} />
                        <span className="text-[12px] font-mono text-slate-200 truncate">{idx.name}</span>
                        {idx.method && <span className="text-[9.5px] text-slate-600 font-mono shrink-0">{idx.method}</span>}
                        <span
                          className={`ml-auto text-[9.5px] font-mono font-semibold shrink-0 ${
                            idx.isPrimary ? 'text-fuchsia-400' : idx.isUnique ? 'text-blue-400' : 'text-slate-500'
                          }`}
                        >
                          {idx.isPrimary ? 'PRIMARY' : idx.isUnique ? 'UNIQUE' : 'INDEX'}
                        </span>
                      </div>
                      <div className="text-[10.5px] font-mono text-slate-500 pl-6 truncate">{idx.columns.join(', ')}</div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'triggers' && (
            <>
              {loadingMeta ? (
                <InlineLoading />
              ) : metaError ? (
                <ErrorLine message={metaError} />
              ) : triggers.length === 0 ? (
                <EmptyLine label="No triggers on this table." />
              ) : (
                <div className="space-y-3">
                  {triggers.map((trg) => (
                    <div key={trg.name}>
                      <div className="flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[#0f172a] transition-colors">
                        <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="text-[12px] font-mono text-slate-200 truncate">{trg.name}</span>
                        <span className="ml-auto text-[9.5px] font-mono text-slate-500 shrink-0">
                          {[trg.timing, trg.events.join(' OR '), trg.level].filter(Boolean).join(' ')}
                        </span>
                      </div>
                      {trg.statement && (
                        <div className="text-[10.5px] font-mono text-slate-600 pl-6 truncate" title={trg.statement}>
                          {trg.statement}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
    </div>
  );
}

function InlineLoading() {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-slate-500 py-2">
      <Loader2 className="w-3 h-3 animate-spin" /> Loading…
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-red-300 py-2">
      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {message}
    </div>
  );
}

function EmptyLine({ label }: { label: string }) {
  return <div className="text-[11px] text-slate-600 italic py-2">{label}</div>;
}
