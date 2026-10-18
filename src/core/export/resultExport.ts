import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { QueryColumn } from '../domain/types';
import { generateInsertStatements } from '../backup/backupSql';

export type ExportFormat = 'csv' | 'json' | 'sql';

export const EXPORT_FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL INSERT statements' },
];

type Rows = unknown[][];

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function csvField(value: unknown): string {
  const s = textOf(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: QueryColumn[], rows: Rows): string {
  const header = columns.map((c) => csvField(c.name)).join(',');
  const body = rows.map((row) => columns.map((_, i) => csvField(row[i])).join(','));
  return [header, ...body].join('\n');
}

/** Tab-separated text, for pasting into a spreadsheet. */
export function toTsv(columns: QueryColumn[], rows: Rows): string {
  const field = (v: unknown) => textOf(v).replace(/[\t\r\n]+/g, ' ');
  return [columns.map((c) => field(c.name)).join('\t'), ...rows.map((r) => columns.map((_, i) => field(r[i])).join('\t'))].join('\n');
}

export function toJson(columns: QueryColumn[], rows: Rows): string {
  const objects = rows.map((row) => Object.fromEntries(columns.map((c, i) => [c.name, row[i] ?? null])));
  return JSON.stringify(objects, null, 2);
}

export function toSqlInserts(
  engine: string,
  tableName: string,
  schemaName: string | undefined,
  columns: QueryColumn[],
  rows: Rows,
): string {
  return generateInsertStatements(engine, tableName, schemaName, columns, rows).join('\n\n');
}

export interface ExportSource {
  engine: string;
  /** Used for the file name and as the INSERT target. */
  tableName: string;
  schemaName?: string;
  columns: QueryColumn[];
  rows: Rows;
}

export function renderExport(format: ExportFormat, src: ExportSource): string {
  switch (format) {
    case 'csv':
      return toCsv(src.columns, src.rows);
    case 'json':
      return toJson(src.columns, src.rows);
    case 'sql':
      return toSqlInserts(src.engine, src.tableName, src.schemaName, src.columns, src.rows);
  }
}

/** Asks where to save, then writes the file. Returns the path, or null when
 *  the user cancels. */
export async function saveExport(format: ExportFormat, src: ExportSource): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = src.tableName.replace(/[^\w.-]+/g, '_') || 'export';
  const path = await save({
    title: `Export ${format.toUpperCase()}`,
    defaultPath: `${base}_${stamp}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
  });
  if (!path) return null;
  await writeTextFile(path, renderExport(format, src));
  return path;
}

/** Fired by the File → Export menu; the active tab's view handles it. */
export const EXPORT_EVENT = 'rdsql:export';
export type ExportEventDetail = { format: ExportFormat; handled: boolean };
