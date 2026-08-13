import React, { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  Table as TableIcon,
  ListTree,
  Braces,
  Trash2,
  Plus,
  Save,
  Loader2,
  X,
  ChevronLeft,
  ChevronRight,
  CheckCheck,
  GitCompare,
  Pencil,
} from 'lucide-react';
import { safeInvoke } from '../../core/tauri/ipc';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { MongoQueryBar } from './MongoQueryBar';
import { MongoDocumentTable } from './MongoDocumentTable';
import { MongoDocumentTree } from './MongoDocumentTree';
import { MongoCompareModal } from './MongoCompareModal';
import { formatBsonValue } from '../../core/mongo/bson';
import type { DatabaseConnection } from '../../core/domain/types';
import type { MongoDocument, MongoDocumentPage } from '../../core/mongo/types';

interface Props {
  connection: DatabaseConnection;
  database: string;
  collectionName: string;
}

type ViewMode = 'table' | 'tree' | 'json';

const PAGE_SIZE = 50;

function previewLabel(doc: MongoDocument): string {
  if (doc._id !== undefined) return formatBsonValue(doc._id);
  const json = JSON.stringify(doc);
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

const VIEW_MODES: { id: ViewMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'table', label: 'Table', icon: TableIcon },
  { id: 'tree', label: 'Tree', icon: ListTree },
  { id: 'json', label: 'JSON', icon: Braces },
];

/** The "Documents" tab of the MongoDB collection browser: a query bar
 *  (filter/project/sort/limit), a Table/Tree/JSON toggle for the document
 *  list, and a docked, resizable detail editor for viewing/editing/inserting
 *  a single document — a full-height second column beside the list (query
 *  bar/toolbar included), so both stay visible and the list remains
 *  independently scrollable. */
export const MongoDocumentsPanel: React.FC<Props> = ({ connection, database, collectionName }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('table');

  // Docked detail panel — resizable by dragging its left edge, same pattern
  // as StorageBrowser's docked object-detail panel and the ERD tab's
  // table-detail drawer (drag → mousemove/mouseup on window, width clamped
  // in the store's setter, `zoomLevel`-aware since the whole UI can be
  // zoomed).
  const { mongoDetailPanelWidth, setMongoDetailPanelWidth, zoomLevel } = useWorkspaceStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizingDetail, setIsResizingDetail] = useState(false);

  useEffect(() => {
    if (!isResizingDetail) return;
    const handleMouseMove = (e: MouseEvent) => {
      const containerRight = containerRef.current?.getBoundingClientRect().right;
      if (containerRight === undefined) return;
      setMongoDetailPanelWidth((containerRight - e.clientX) / zoomLevel);
    };
    const handleMouseUp = () => setIsResizingDetail(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingDetail, setMongoDetailPanelWidth, zoomLevel]);

  // ── Query bar state ───────────────────────────────────────────────────────
  const [filterInput, setFilterInput] = useState('');
  const [projectInput, setProjectInput] = useState('');
  const [sortInput, setSortInput] = useState('');
  const [limitInput, setLimitInput] = useState(String(PAGE_SIZE));
  const [appliedQuery, setAppliedQuery] = useState({ filter: '', project: '', sort: '', limit: String(PAGE_SIZE) });
  const [queryError, setQueryError] = useState<string | null>(null);

  const [page, setPage] = useState(0);
  const [documents, setDocuments] = useState<MongoDocument[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── Multi-select (bulk delete / compare) ──────────────────────────────────
  // Indices into the current page's `documents` — reset on page/query/
  // collection change since a new page invalidates the old positions.
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);

  const toggleSelect = (index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIndices((prev) => (prev.size === documents.length ? new Set() : new Set(documents.map((_, i) => i))));
  };

  const bulkDeleteSelected = async () => {
    const targets = documents.filter((_, i) => selectedIndices.has(i));
    if (targets.length === 0) return;
    setBulkDeleting(true);
    setBulkDeleteError(null);
    try {
      await safeInvoke('mongo_delete_documents', {
        config: connection,
        database,
        collectionName,
        filter: { _id: { $in: targets.map((d) => d._id) } },
      });
      setSelectedIndices(new Set());
      setBulkDeleteConfirm(false);
      await runFind();
    } catch (err: any) {
      setBulkDeleteError(err?.message || String(err));
    } finally {
      setBulkDeleting(false);
    }
  };

  const runFind = async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const filter = appliedQuery.filter.trim() ? JSON.parse(appliedQuery.filter) : undefined;
      const project = appliedQuery.project.trim() ? JSON.parse(appliedQuery.project) : undefined;
      const sort = appliedQuery.sort.trim() ? JSON.parse(appliedQuery.sort) : undefined;
      const limit = appliedQuery.limit.trim() ? Number(appliedQuery.limit) : PAGE_SIZE;
      const res = await safeInvoke<MongoDocumentPage>('mongo_find_documents', {
        config: connection,
        database,
        collectionName,
        filter,
        project,
        sort,
        skip: page * (limit || PAGE_SIZE),
        limit,
      });
      setDocuments(res.documents);
      setHasMore(res.hasMore);
    } catch (err: any) {
      setListError(err?.message || String(err));
      setDocuments([]);
      setHasMore(false);
    } finally {
      setLoadingList(false);
    }
  };

  useEffect(() => {
    setPage(0);
    setSelectedIndex(null);
    setIsNewDocument(false);
    setSelectedIndices(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, database, collectionName]);

  useEffect(() => {
    runFind();
    setSelectedIndices(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, database, collectionName, page, appliedQuery]);

  const runQuery = () => {
    try {
      if (filterInput.trim()) JSON.parse(filterInput);
      if (projectInput.trim()) JSON.parse(projectInput);
      if (sortInput.trim()) JSON.parse(sortInput);
      setQueryError(null);
      setPage(0);
      setAppliedQuery({ filter: filterInput, project: projectInput, sort: sortInput, limit: limitInput });
    } catch (err: any) {
      setQueryError(err?.message || 'Invalid JSON in filter/project/sort');
    }
  };

  // ── Selected document editor (slide-over) ─────────────────────────────────
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [isNewDocument, setIsNewDocument] = useState(false);
  // True when the slide-over was opened via the table's "Inspect" action
  // (read-only peek) rather than a row click (edit) — same document/JSON
  // view, but Monaco is read-only and Save/Delete are hidden until "Edit"
  // is explicitly clicked.
  const [isInspecting, setIsInspecting] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const detailOpen = selectedIndex !== null || isNewDocument;

  const selectDocument = (doc: MongoDocument, index: number) => {
    setSelectedIndex(index);
    setIsNewDocument(false);
    setIsInspecting(false);
    setDraft(JSON.stringify(doc, null, 2));
    setEditorError(null);
    setSaveError(null);
  };

  const inspectDocument = (doc: MongoDocument, index: number) => {
    setSelectedIndex(index);
    setIsNewDocument(false);
    setIsInspecting(true);
    setDraft(JSON.stringify(doc, null, 2));
    setEditorError(null);
    setSaveError(null);
  };

  const startNewDocument = () => {
    setSelectedIndex(null);
    setIsNewDocument(true);
    setIsInspecting(false);
    setDraft('{\n  \n}');
    setEditorError(null);
    setSaveError(null);
  };

  const closeDetail = () => {
    setSelectedIndex(null);
    setIsNewDocument(false);
    setIsInspecting(false);
  };

  const handleDraftChange = (value: string | undefined) => {
    const next = value ?? '';
    setDraft(next);
    try {
      JSON.parse(next);
      setEditorError(null);
    } catch (err: any) {
      setEditorError(err?.message || 'Invalid JSON');
    }
  };

  const saveDocument = async () => {
    let parsed: MongoDocument;
    try {
      parsed = JSON.parse(draft);
    } catch (err: any) {
      setEditorError(err?.message || 'Invalid JSON');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (isNewDocument) {
        await safeInvoke('mongo_insert_document', { config: connection, database, collectionName, document: parsed });
      } else if (selectedIndex !== null) {
        const original = documents[selectedIndex];
        await safeInvoke('mongo_update_document', {
          config: connection,
          database,
          collectionName,
          filter: { _id: original._id },
          document: parsed,
        });
      }
      setIsNewDocument(false);
      await runFind();
    } catch (err: any) {
      setSaveError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteDocument = async () => {
    if (selectedIndex === null) return;
    const target = documents[selectedIndex];
    setSaving(true);
    setSaveError(null);
    try {
      await safeInvoke('mongo_delete_document', { config: connection, database, collectionName, filter: { _id: target._id } });
      closeDetail();
      await runFind();
    } catch (err: any) {
      setSaveError(err?.message || String(err));
    } finally {
      setSaving(false);
      setDeleteConfirm(false);
    }
  };

  return (
    <div ref={containerRef} className="h-full flex min-h-0 relative">
    <div className="flex-1 min-w-0 h-full flex flex-col min-h-0">
      <MongoQueryBar
        filter={filterInput}
        onFilterChange={setFilterInput}
        project={projectInput}
        onProjectChange={setProjectInput}
        sort={sortInput}
        onSortChange={setSortInput}
        limit={limitInput}
        onLimitChange={setLimitInput}
        onRun={runQuery}
        running={loadingList}
        error={queryError}
      />

      {/* View mode toggle + list toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[#1e293b] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-0.5 bg-[#0f172a] rounded-lg p-0.5">
          {VIEW_MODES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setViewMode(id)}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-semibold transition-colors ${
                viewMode === id ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-slate-500">
            {documents.length} document{documents.length === 1 ? '' : 's'}
            {hasMore ? '+' : ''}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page === 0 || loadingList}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="p-1 rounded text-slate-400 hover:text-emerald-400 disabled:opacity-30 transition-colors"
              title="Previous page"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[10px] text-slate-500">Page {page + 1}</span>
            <button
              type="button"
              disabled={!hasMore || loadingList}
              onClick={() => setPage((p) => p + 1)}
              className="p-1 rounded text-slate-400 hover:text-emerald-400 disabled:opacity-30 transition-colors"
              title="Next page"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={startNewDocument}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Insert
          </button>
        </div>
      </div>

      {/* Batch selection banner — table view only, mirrors TableDataView's
          SQL grid multi-select toolbar (Compare + bulk delete). */}
      {selectedIndices.size > 0 && (
        <div className="h-8 bg-emerald-600/15 border-b border-emerald-500/30 px-3 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 font-medium text-emerald-300">
            <CheckCheck className="w-4 h-4 text-emerald-400" />
            <span>
              <strong>{selectedIndices.size}</strong> document{selectedIndices.size === 1 ? '' : 's'} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCompareOpen(true)}
              disabled={selectedIndices.size < 2}
              title={selectedIndices.size < 2 ? 'Select at least 2 documents to compare' : 'Compare selected documents side by side'}
              className="px-2.5 py-0.5 rounded bg-[#1e293b] hover:bg-[#334155] text-slate-200 font-semibold text-xs flex items-center gap-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <GitCompare className="w-3 h-3" />
              Compare
            </button>
            <button
              onClick={() => setBulkDeleteConfirm(true)}
              className="px-2.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center gap-1 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Delete Selected
            </button>
          </div>
        </div>
      )}

      {/* Document list — fills the rest of the left column. */}
      <div className="flex-1 min-h-0 bg-[#06090e]">
        {listError && (
          <div className="p-2">
            <CopyableErrorBanner message={listError} parseAsDbError compact />
          </div>
        )}
        {!listError && viewMode === 'table' && (
          <MongoDocumentTable
            documents={documents}
            selectedIndex={selectedIndex}
            onOpenDocument={selectDocument}
            onInspectDocument={inspectDocument}
            selectable
            selectedIndices={selectedIndices}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
          />
        )}
        {!listError && viewMode === 'tree' && <MongoDocumentTree documents={documents} onOpenDocument={selectDocument} />}
        {!listError && viewMode === 'json' && (
          <Editor
            height="100%"
            defaultLanguage="json"
            theme="vs-dark"
            value={JSON.stringify(documents, null, 2)}
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              minimap: { enabled: false },
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: 8 },
            }}
          />
        )}
      </div>
    </div>

    {compareOpen && (
      <MongoCompareModal
        documents={documents.filter((_, i) => selectedIndices.has(i))}
        onClose={() => setCompareOpen(false)}
      />
    )}

      {/* Docked document detail panel (edit / inspect) — a full-height,
          resizable second column alongside the whole left side (query bar,
          toolbar, list included), not just the list, so it reaches the same
          top edge as the query bar instead of starting partway down. */}
      {detailOpen && (
        <div
          style={{ width: `${mongoDetailPanelWidth * zoomLevel}px` }}
          className="relative shrink-0 h-full max-w-full bg-[#0a0f18] border-l border-[#1e293b] shadow-2xl flex flex-col"
        >
          <div
            onMouseDown={() => setIsResizingDetail(true)}
            className="absolute inset-y-0 -left-1.5 w-1.5 bg-transparent hover:bg-cyan-500 cursor-col-resize z-30 transition-colors"
            title="Drag to resize detail panel"
          />
          <div className="px-3 py-2 border-b border-[#1e293b] flex items-center justify-between shrink-0">
            <span className="text-[11px] font-semibold text-slate-300 truncate flex items-center gap-1.5">
              {isInspecting && <span className="text-[9px] px-1 py-0.2 rounded bg-slate-700/60 text-slate-400 font-mono uppercase tracking-wide">Inspecting</span>}
              {isNewDocument ? 'New document' : previewLabel(documents[selectedIndex!])}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {editorError && <span className="text-[10px] text-red-400">{editorError}</span>}
              {isInspecting ? (
                <button
                  type="button"
                  onClick={() => setIsInspecting(false)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-[#1e293b] hover:bg-[#334155] text-slate-200 transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
              ) : (
                <>
                  {!isNewDocument && (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(true)}
                      disabled={saving}
                      className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-40"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={saveDocument}
                    disabled={saving || !!editorError}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white transition-colors"
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                    Save
                  </button>
                </>
              )}
              <button type="button" onClick={closeDetail} className="p-1 rounded hover:bg-white/10 text-slate-500 hover:text-slate-200 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          {saveError && (
            <div className="p-2 shrink-0">
              <CopyableErrorBanner message={saveError} parseAsDbError compact />
            </div>
          )}
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              defaultLanguage="json"
              theme="vs-dark"
              value={draft}
              onChange={handleDraftChange}
              options={{
                readOnly: isInspecting,
                fontSize: 13,
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                minimap: { enabled: false },
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: 'on',
                padding: { top: 8 },
              }}
            />
          </div>
        </div>
        )}

      {deleteConfirm && (
        <ConfirmDialog
          title="Delete document"
          message="This permanently deletes the document from the collection. This cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          loading={saving}
          onConfirm={deleteDocument}
          onClose={() => setDeleteConfirm(false)}
        />
      )}

      {bulkDeleteConfirm && (
        <ConfirmDialog
          title={`Delete ${selectedIndices.size} document${selectedIndices.size === 1 ? '' : 's'}`}
          message="This permanently deletes every selected document from the collection. This cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          loading={bulkDeleting}
          onConfirm={bulkDeleteSelected}
          onClose={() => setBulkDeleteConfirm(false)}
        >
          {bulkDeleteError && <CopyableErrorBanner message={bulkDeleteError} parseAsDbError compact />}
        </ConfirmDialog>
      )}
    </div>
  );
};
