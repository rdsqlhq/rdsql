import { useCallback, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';
import { jsPDF } from 'jspdf';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs';
import type { ErdSchemaContext } from '../../core/domain/types';
import type { SchemaGraphModel } from '../../core/erd/types';
import { renderSchemaAs } from '../../core/erd/exporters';
import { renderErdToCanvas } from '../../core/erd/renderToCanvas';

// ---------------------------------------------------------------------------
// ERD export hook.
//
// Centralizes the three export flows (PNG raster, Mermaid text, DDL text) so
// the toolbar only has to call `exportPng() / exportMermaid() / exportDdl()`.
//
// File-saving follows the established Tauri pattern (see TableDataView's CSV
// export): native save dialog → writeTextFile / writeFile. When running
// outside Tauri (web build, unit tests), we fall back to a blob download so
// the feature still works.
//
// PNG capture targets the React Flow `.react-flow__viewport` element — that's
// the transformed pane holding all nodes + edges, so the output is exactly
// the diagram with its current layout/zoom. The caller is expected to have
// called `fitView()` first so the whole graph is in frame.
// ---------------------------------------------------------------------------

const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

const TIMESTAMP = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** Convert a Blob into a Uint8Array — needed because Tauri's `writeFile`
 *  expects bytes, not a Blob. */
async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const arr = new Uint8Array(await blob.arrayBuffer());
  return arr;
}

/** Extract a human-readable message from anything that was thrown — handles
 *  DOM Events (which have no .message) and plain objects that html-to-image
 *  can reject with when an internal image fails to load. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    // html-to-image rejects with the image's onerror Event, which stringifies
    // to "[object Event]" — surface something more helpful.
    if (err instanceof Event) return 'image render failed (possible CORS/font issue)';
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/** Web fallback: trigger a real browser download for a Blob. */
function browserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt the user for a save path (native) or just hand back a synthesized
 *  filename (web). Returns null when the user cancels the native dialog. */
async function pickSavePath(title: string, defaultName: string, ext: string): Promise<string | null> {
  if (!isTauri()) return defaultName;
  const path = await save({
    title,
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return path || null;
}

export interface UseErdExportArgs {
  schema: ErdSchemaContext;
  graph: SchemaGraphModel;
  /** React Flow node state — needed by the canvas renderer to read each table's
   *  position. The DOM-snapshot approach (html-to-image) was unreliable in
   *  Tauri's WebView, so we now draw the diagram directly to a <canvas>. */
  nodes: Node[];
  /** Connector color setting from the ERD toolbar — passed through to the
   *  canvas renderer so edge colors in the export match what's on screen. */
  connectorColor?: string;
  /** Element that contains the React Flow canvas — kept for the fitView call
   *  before capture so node positions reflect the final layout. */
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Called before capture so the caller can fit the whole graph into view
   *  (otherwise off-screen nodes may be clipped by React Flow's virtualization).
   *  Must return a promise that resolves once the fit animation has settled. */
  onBeforeCapture?: () => Promise<void> | void;
}

export function useErdExport({ schema, graph, nodes, connectorColor, canvasContainerRef, onBeforeCapture }: UseErdExportArgs) {
  const [exporting, setExporting] = useState(false);
  // Last error message, surfaced as a transient banner by the toolbar.
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  }, []);

  const runExport = useCallback(
    async (kind: 'png' | 'pdf' | 'mermaid' | 'ddl') => {
      if (exporting) return;
      setExporting(true);
      try {
        const baseName = `${schema.schemaName}_${TIMESTAMP()}`;

        if (kind === 'png' || kind === 'pdf') {
          // Give React Flow a chance to lay out the whole graph before we
          // capture — node positions need to reflect the final layout.
          if (onBeforeCapture) await onBeforeCapture();
          // Two RAFs: one for the fitView state to flush, one for any node
          // re-mounts triggered by the viewport change.
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

          if (nodes.length === 0) {
            flashError('Diagram is empty — open a schema with tables first.');
            return;
          }

          // Draw the diagram directly to a canvas using the Canvas 2D API.
          const canvas = renderErdToCanvas({
            nodes,
            graph,
            schemaName: schema.schemaName,
            pixelRatio: 2,
            connectorColor,
          });

          if (kind === 'png') {
            // Canvas → PNG blob.
            const blob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob(resolve, 'image/png')
            );
            if (!blob) {
              flashError('Failed to encode PNG (canvas.toBlob returned null).');
              return;
            }

            const fileName = `${baseName}.png`;
            const path = await pickSavePath('Export PNG', fileName, 'png');
            if (!path) return; // cancelled

            if (isTauri()) {
              await writeFile(path, await blobToBytes(blob));
            } else {
              browserDownload(blob, path);
            }
            return;
          }

          // --- PDF -----------------------------------------------------------
          // Embed the canvas as a full-page image. jsPDF sizes the page to
          // match the image aspect ratio (landscape or portrait as needed) so
          // the diagram fills the page without distortion. For very tall/wide
          // diagrams the image is scaled to fit within a generous max page.
          const imgData = canvas.toDataURL('image/png');
          // Canvas dimensions are in device pixels; jsPDF works in points (pt)
          // where 1pt = 1/72 inch. We use the canvas CSS-equivalent size
          // (divide by pixelRatio) so text stays readable.
          const imgW = canvas.width / 2; // pixelRatio = 2
          const imgH = canvas.height / 2;
          const orientation = imgW >= imgH ? 'landscape' : 'portrait';
          const pdf = new jsPDF({
            orientation,
            unit: 'pt',
            format: [imgW, imgH],
          });
          pdf.addImage(imgData, 'PNG', 0, 0, imgW, imgH);
          const pdfBlob = pdf.output('blob');

          const fileName = `${baseName}.pdf`;
          const path = await pickSavePath('Export PDF', fileName, 'pdf');
          if (!path) return; // cancelled

          if (isTauri()) {
            await writeFile(path, await blobToBytes(pdfBlob));
          } else {
            browserDownload(pdfBlob, path);
          }
          return;
        }

        // --- Text exports ---------------------------------------------------
        const text = renderSchemaAs(schema.tables, kind);
        const ext = kind === 'mermaid' ? 'mmd' : 'sql';
        const fileName = `${baseName}.${ext}`;
        const path = await pickSavePath(
          kind === 'mermaid' ? 'Export Mermaid' : 'Export SQL DDL',
          fileName,
          ext
        );
        if (!path) return; // cancelled

        if (isTauri()) {
          await writeTextFile(path, text);
        } else {
          browserDownload(new Blob([text], { type: 'text/plain' }), path);
        }
      } catch (err: unknown) {
        console.error(`ERD ${kind} export failed:`, err);
        flashError(`${kind.toUpperCase()} export failed: ${errMsg(err)}`);
      } finally {
        setExporting(false);
      }
    },
    [exporting, schema, graph, nodes, connectorColor, canvasContainerRef, onBeforeCapture, flashError]
  );

  const exportPng = useCallback(() => runExport('png'), [runExport]);
  const exportPdf = useCallback(() => runExport('pdf'), [runExport]);
  const exportMermaid = useCallback(() => runExport('mermaid'), [runExport]);
  const exportDdl = useCallback(() => runExport('ddl'), [runExport]);

  return { exporting, error, exportPng, exportPdf, exportMermaid, exportDdl };
}
