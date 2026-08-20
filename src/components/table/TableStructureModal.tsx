import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import {
  X,
  Columns,
  Key,
  FileCode,
  Layers,
  Copy,
  Check,
  Plus,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  GitBranch,
  Save,
  Code,
  Pencil,
  Trash2,
  Loader2,
  Link2,
  Sparkles,
  List,
} from 'lucide-react';
import { SchemaTableNode, SchemaColumnNode, DatabaseConnection, QueryResultData } from '../../core/domain/types';
import { safeInvoke } from '../../core/tauri/ipc';
import { quoteIdent, qualifiedTable } from '../../core/sql/ident';
import { isPostgresFamily } from '../../core/connection/engines';
import { getGroupedTypeOptions, getTypeOptions, isEnumType, parseEnumInner, buildEnumInner } from '../../core/sql/dataTypes';
import { EnumValuesInput } from './EnumValuesInput';
import { CopyableErrorBanner } from '../common/CopyableErrorBanner';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  fetchTableIndexes,
  fetchTableForeignKeys,
  createIndexSql,
  dropIndexSql,
  addForeignKeySql,
  dropForeignKeySql,
  setColumnCommentSql,
  supportsColumnComment,
  type IndexInfo,
  type ForeignKeyInfo,
} from '../../core/sql/indexIntrospection';

interface TableStructureModalProps {
  isOpen: boolean;
  tableName: string;
  columns: SchemaColumnNode[];
  conn: DatabaseConnection;
  schemaName?: string;
  onSchemaChanged: () => void;
  onClose: () => void;
}

// ── Standardized input/select heights ─────────────────────────────────────
// All form controls in the modal use `h-8` so inputs/selects align and feel
// consistent (HeidiSQL-style). `INPUT_CLS_SM` is for secondary fields like the
// column-comment input.
const INPUT_CLS = 'h-8 box-border w-full bg-[#06090e] border border-[#1e293b] rounded-lg px-2 text-xs text-slate-100 focus:outline-none focus:border-blue-500';
const INPUT_CLS_SM = 'h-7 box-border w-full bg-[#06090e] border border-[#1e293b] rounded-lg px-2 text-[11px] text-slate-400 focus:outline-none focus:border-blue-500/50';

interface DraftCol {
  name: string;
  /** Base type only — e.g. `varchar`, `int`, `decimal`. */
  type: string;
  /** Length/precision in parens — e.g. `255`, `10,2`, or `''` when none. */
  length: string;
  nullable: boolean;
  pk: boolean;
  comment: string;
}

/**
 * Split a full data type string into `{ type, length }`. Handles `varchar(255)`,
 * `decimal(10,2)`, and bare types like `int` / `text`.
 */
function splitType(full?: string): { type: string; length: string } {
  if (!full) return { type: 'varchar', length: '255' };
  const m = /^([^(]+)\s*\(([^)]*)\)/.exec(full);
  if (m) return { type: m[1].trim().toLowerCase(), length: m[2].trim() };
  return { type: full.trim().toLowerCase(), length: '' };
}

/** Recombine base type + length into a full type string. */
function joinType(type: string, length: string): string {
  const t = type.trim();
  if (!length.trim()) return t;
  return `${t}(${length.trim()})`;
}

const toDraft = (c: SchemaColumnNode): DraftCol => {
  const { type, length } = splitType(c.data_type);
  return {
    name: c.name,
    type,
    length,
    nullable: c.is_nullable !== false,
    pk: !!c.is_primary_key,
    comment: '',
  };
};

export const TableStructureModal: React.FC<TableStructureModalProps> = ({
  isOpen,
  tableName,
  columns,
  conn,
  schemaName,
  onSchemaChanged,
  onClose,
}) => {
  useEscapeToClose(isOpen ? onClose : null);
  const [activeTab, setActiveTab] = useState<'columns' | 'indexes' | 'foreignKeys' | 'enumTypes' | 'ddl'>('columns');
  const [copied, setCopied] = useState(false);

  // Add-column form
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newCol, setNewCol] = useState<DraftCol>({ name: '', type: 'varchar', length: '255', nullable: true, pk: false, comment: '' });

  // Inline edit (per column)
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<DraftCol | null>(null);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Live index / FK state (fetched from the DB, replacing the old mock data).
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // Postgres enum types (`CREATE TYPE ... AS ENUM`) — a schema-level object,
  // not a column property, so they're managed here as their own tab rather
  // than folded into the Columns tab. Not offered for other engines: MySQL's
  // ENUM is inline column syntax (handled directly via EnumValuesInput in
  // the Columns tab instead), and SQLite/MSSQL have no enum concept at all.
  interface EnumTypeInfo { name: string; values: string[]; }
  const [enumTypes, setEnumTypes] = useState<EnumTypeInfo[]>([]);
  const [loadingEnums, setLoadingEnums] = useState(false);
  const [enumsError, setEnumsError] = useState<string | null>(null);
  const [isAddingEnum, setIsAddingEnum] = useState(false);
  const [newEnum, setNewEnum] = useState<{ name: string; valuesInner: string }>({ name: '', valuesInner: '' });
  const [editingEnumName, setEditingEnumName] = useState<string | null>(null);
  const [editEnum, setEditEnum] = useState<{ name: string; valuesInner: string } | null>(null);
  // Which enum type's quick-edit popup is open, shown inline from the
  // Columns tab (next to a column whose type is that enum) instead of
  // requiring a trip to the Enum Types tab. Shares editingEnumName/editEnum
  // with that tab's own inline edit — same state, just a different place to
  // render it, so Save/recreate behave identically either way.
  const [enumPopoverFor, setEnumPopoverFor] = useState<string | null>(null);
  const enumPopoverRef = useRef<HTMLDivElement | null>(null);
  // Populated when a values edit needs the recreate flow (Postgres can only
  // ADD a value in place — removing or reordering means: rename the old
  // type out of the way, create a new one with the target values, migrate
  // every column using it, then drop the old type). Holds the blast-radius
  // (which columns) so the confirm dialog can show it before running.
  const [enumImpact, setEnumImpact] = useState<{
    original: EnumTypeInfo;
    newName: string;
    newValues: string[];
    columns: { schema: string; table: string; column: string; defaultExpr: string | null }[];
  } | null>(null);

  if (!isOpen) return null;

  const engine = conn.engine;
  const tbl = qualifiedTable(engine, tableName, schemaName);
  const isPg = isPostgresFamily(engine);

  // ── Live introspection ──────────────────────────────────────────────────
  const refreshMeta = useCallback(async () => {
    setLoadingMeta(true);
    setMetaError(null);
    try {
      const [idxs, fks] = await Promise.all([
        fetchTableIndexes({ config: conn, engine, schema: schemaName, table: tableName }),
        fetchTableForeignKeys({ config: conn, engine, schema: schemaName, table: tableName }),
      ]);
      setIndexes(idxs);
      setForeignKeys(fks);
    } catch (err: any) {
      setMetaError(err?.message || String(err));
      setIndexes([]);
      setForeignKeys([]);
    } finally {
      setLoadingMeta(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, engine, schemaName, tableName]);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  // ── Enum types (Postgres only) ────────────────────────────────────────────
  const refreshEnumTypes = useCallback(async () => {
    if (!isPg) return;
    setLoadingEnums(true);
    setEnumsError(null);
    try {
      const sch = (schemaName || 'public').replace(/'/g, "''");
      const res = await safeInvoke<QueryResultData>('execute_query', {
        request: {
          config: conn,
          sql: `SELECT t.typname, e.enumlabel FROM pg_type t
                JOIN pg_enum e ON t.oid = e.enumtypid
                JOIN pg_namespace n ON n.oid = t.typnamespace
                WHERE n.nspname = '${sch}'
                ORDER BY t.typname, e.enumsortorder;`,
        },
        queryId: `enum_types_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      const byName = new Map<string, string[]>();
      for (const row of res.rows) {
        const name = String(row[0]);
        const label = String(row[1]);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name)!.push(label);
      }
      setEnumTypes(Array.from(byName.entries()).map(([name, values]) => ({ name, values })));
    } catch (err: any) {
      setEnumsError(err?.message || String(err));
      setEnumTypes([]);
    } finally {
      setLoadingEnums(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, isPg, schemaName]);

  useEffect(() => {
    void refreshEnumTypes();
  }, [refreshEnumTypes]);

  // Close the Columns-tab quick-edit popup on an outside click, matching
  // every other dropdown/popover in this app (e.g. DataGrid's column-
  // visibility menu).
  useEffect(() => {
    if (!enumPopoverFor) return;
    const onDown = (e: MouseEvent) => {
      if (enumPopoverRef.current && !enumPopoverRef.current.contains(e.target as Node)) {
        setEnumPopoverFor(null);
        setEditingEnumName(null);
        setEditEnum(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [enumPopoverFor]);

  // ── DDL runner ──────────────────────────────────────────────────────────
  const runDdl = async (sql: string, label: string) => {
    setRunning(true);
    setError(null);
    setInfo(null);
    try {
      await safeInvoke('execute_query', {
        request: { config: conn, sql },
        queryId: `alter_${tableName}_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      setInfo(`${label} applied. Refreshing schema…`);
      onSchemaChanged();
      // Clear local editing state — the refreshed `columns` prop replaces it.
      setIsAddingColumn(false);
      setNewCol({ name: '', type: 'varchar', length: '255', nullable: true, pk: false, comment: '' });
      setEditingName(null);
      setEditDraft(null);
      // Re-fetch indexes / FKs so the modal reflects the change immediately.
      void refreshMeta();
    } catch (err: any) {
      const msg = err?.message || String(err);
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  // ── Columns: add / edit / drop ──────────────────────────────────────────
  const handleAdd = () => {
    if (!newCol.name.trim()) {
      setError('Column name is required.');
      return;
    }
    const fullType = joinType(newCol.type, newCol.length);
    const ident = quoteIdent(engine, newCol.name.trim());
    // T-SQL's ADD clause takes the column definition directly — no COLUMN keyword.
    const isMssql = engine === 'mssql';
    let sql = isMssql ? `ALTER TABLE ${tbl} ADD ${ident} ${fullType}` : `ALTER TABLE ${tbl} ADD COLUMN ${ident} ${fullType}`;
    if (!newCol.nullable) sql += ' NOT NULL';
    sql += ';';
    // Attach a comment if provided + supported.
    if (newCol.comment.trim() && supportsColumnComment(engine)) {
      const commentSql = setColumnCommentSql(engine, schemaName, tableName, newCol.name.trim(), newCol.comment.trim(), fullType);
      if (commentSql) sql += '\n' + commentSql;
    }
    runDdl(sql, `Column "${newCol.name.trim()}" added`);
  };

  const startEdit = (c: SchemaColumnNode) => {
    setEditingName(c.name);
    setEditDraft(toDraft(c));
    setError(null);
    setInfo(null);
  };

  const handleSaveEdit = (original: SchemaColumnNode) => {
    if (!editDraft) return;
    if (!editDraft.name.trim()) {
      setError('Column name is required.');
      return;
    }
    const newFullType = joinType(editDraft.type, editDraft.length);
    const oldIdent = quoteIdent(engine, original.name);
    const newIdent = quoteIdent(engine, editDraft.name.trim());
    const statements: string[] = [];
    const isMysqlFamily = engine === 'mysql';
    const isMssql = engine === 'mssql';
    if (original.name !== editDraft.name.trim()) {
      if (isMysqlFamily) {
        statements.push(
          `ALTER TABLE ${tbl} CHANGE COLUMN ${oldIdent} ${newIdent} ${newFullType}${editDraft.nullable ? '' : ' NOT NULL'};`
        );
      } else if (isMssql) {
        // T-SQL has no RENAME COLUMN — sp_rename takes the unquoted,
        // dot-qualified object name as a plain string.
        const objName = `${schemaName ? `${schemaName}.` : ''}${tableName}.${original.name}`.replace(/'/g, "''");
        statements.push(`EXEC sp_rename '${objName}', '${editDraft.name.trim()}', 'COLUMN';`);
      } else {
        statements.push(`ALTER TABLE ${tbl} RENAME COLUMN ${oldIdent} TO ${newIdent};`);
      }
    }
    const typeHandledByChange = isMysqlFamily;
    if (isMssql) {
      // T-SQL combines type + nullability into one ALTER COLUMN statement,
      // and always requires an explicit NULL/NOT NULL.
      if ((original.data_type || '') !== newFullType || (original.is_nullable !== false) !== editDraft.nullable) {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${newIdent} ${newFullType} ${editDraft.nullable ? 'NULL' : 'NOT NULL'};`);
      }
    } else {
      if (!typeHandledByChange && (original.data_type || '') !== newFullType) {
        statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${newIdent} TYPE ${newFullType};`);
      }
      if (!typeHandledByChange) {
        const wasNullable = original.is_nullable !== false;
        if (wasNullable && !editDraft.nullable) {
          statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${newIdent} SET NOT NULL;`);
        } else if (!wasNullable && editDraft.nullable) {
          statements.push(`ALTER TABLE ${tbl} ALTER COLUMN ${newIdent} DROP NOT NULL;`);
        }
      }
    }
    if (editDraft.comment.trim() && supportsColumnComment(engine)) {
      const commentSql = setColumnCommentSql(engine, schemaName, tableName, editDraft.name.trim(), editDraft.comment.trim(), newFullType);
      if (commentSql) statements.push(commentSql);
    }
    if (statements.length === 0) {
      setEditingName(null);
      setInfo('No changes to save.');
      return;
    }
    runDdl(statements.join('\n'), `Column "${original.name}" updated`);
  };

  const handleRemove = (c: SchemaColumnNode) => {
    if (!window.confirm(`Drop column "${c.name}" from ${tableName}? This cannot be undone.`)) return;
    const ident = quoteIdent(engine, c.name);
    runDdl(`ALTER TABLE ${tbl} DROP COLUMN ${ident};`, `Column "${c.name}" dropped`);
  };

  // ── Indexes: add / edit / drop ──────────────────────────────────────────
  // Editing an index = drop the old + create the new (most engines have no
  // ALTER INDEX that changes columns/uniqueness in place). `editingIdxName`
  // tracks which index row is in inline-edit mode.
  const [isAddingIndex, setIsAddingIndex] = useState(false);
  const [newIdx, setNewIdx] = useState<{ name: string; columns: string[]; isUnique: boolean; method: string }>({
    name: '',
    columns: [],
    isUnique: false,
    method: 'BTREE',
  });
  const [editingIdxName, setEditingIdxName] = useState<string | null>(null);
  const [editIdx, setEditIdx] = useState<{ name: string; columns: string[]; isUnique: boolean; method: string } | null>(null);

  const buildIndexFormState = (idx: IndexInfo) => ({
    name: idx.name,
    columns: [...idx.columns],
    isUnique: idx.isUnique,
    method: idx.method || 'BTREE',
  });

  const startEditIndex = (idx: IndexInfo) => {
    setEditingIdxName(idx.name);
    setEditIdx(buildIndexFormState(idx));
    setError(null);
    setInfo(null);
  };

  const handleSaveEditIndex = (original: IndexInfo) => {
    if (!editIdx) return;
    if (editIdx.columns.length === 0) {
      setError('Select at least one column for the index.');
      return;
    }
    // Drop old, then create new — combined into one DDL batch.
    const drop = dropIndexSql(engine, schemaName, tableName, original.name);
    const create = createIndexSql({
      engine,
      schema: schemaName,
      table: tableName,
      name: editIdx.name.trim() || undefined,
      columns: editIdx.columns,
      isUnique: editIdx.isUnique,
      method: editIdx.method,
    });
    if (!create) {
      setError('Could not rebuild the index for this engine.');
      return;
    }
    runDdl(`${drop}\n${create}`, `Index "${original.name}" updated`);
    setEditingIdxName(null);
    setEditIdx(null);
  };

  const handleAddIndex = () => {
    if (newIdx.columns.length === 0) {
      setError('Select at least one column for the index.');
      return;
    }
    const sql = createIndexSql({
      engine,
      schema: schemaName,
      table: tableName,
      name: newIdx.name.trim() || undefined,
      columns: newIdx.columns,
      isUnique: newIdx.isUnique,
      method: newIdx.method,
    });
    if (!sql) {
      setError('Could not build CREATE INDEX statement for this engine.');
      return;
    }
    runDdl(sql, `Index "${newIdx.name.trim() || newIdx.columns.join('_')}" created`);
    setNewIdx({ name: '', columns: [], isUnique: false, method: 'BTREE' });
    setIsAddingIndex(false);
  };

  const handleDropIndex = (idx: IndexInfo) => {
    if (idx.isPrimary) return; // PK is managed via columns
    if (!window.confirm(`Drop index "${idx.name}"?`)) return;
    const sql = dropIndexSql(engine, schemaName, tableName, idx.name);
    runDdl(sql, `Index "${idx.name}" dropped`);
  };

  // ── Foreign keys: add / edit / drop ──────────────────────────────────────
  // Editing an FK = drop + re-add (ALTER CONSTRAINT with a new definition is
  // not portable). `editingFkName` tracks which FK row is inline-editing.
  const [isAddingFk, setIsAddingFk] = useState(false);
  const emptyFk = () => ({
    constraintName: '',
    column: '',
    referencedTable: '',
    referencedColumn: 'id',
    onUpdate: 'NO ACTION',
    onDelete: 'NO ACTION',
  });
  const [newFk, setNewFk] = useState(emptyFk());
  const [editingFkName, setEditingFkName] = useState<string | null>(null);
  const [editFk, setEditFk] = useState<ReturnType<typeof emptyFk> | null>(null);

  const startEditFk = (fk: ForeignKeyInfo) => {
    setEditingFkName(fk.constraintName);
    setEditFk({
      constraintName: fk.constraintName,
      column: fk.column,
      referencedTable: fk.referencedTable,
      referencedColumn: fk.referencedColumn,
      onUpdate: fk.onUpdate || 'NO ACTION',
      onDelete: fk.onDelete || 'NO ACTION',
    });
    setError(null);
    setInfo(null);
  };

  const handleSaveEditFk = (original: ForeignKeyInfo) => {
    if (!editFk) return;
    if (!editFk.column || !editFk.referencedTable || !editFk.referencedColumn) {
      setError('Local column, referenced table, and referenced column are required.');
      return;
    }
    const drop = dropForeignKeySql(engine, schemaName, tableName, original.constraintName);
    const create = addForeignKeySql({
      engine,
      schema: schemaName,
      table: tableName,
      constraintName: editFk.constraintName.trim() || undefined,
      column: editFk.column,
      referencedSchema: schemaName,
      referencedTable: editFk.referencedTable,
      referencedColumn: editFk.referencedColumn,
      onUpdate: editFk.onUpdate,
      onDelete: editFk.onDelete,
    });
    runDdl(`${drop}\n${create}`, `Foreign key "${original.constraintName}" updated`);
    setEditingFkName(null);
    setEditFk(null);
  };

  const handleAddFk = () => {
    if (!newFk.column || !newFk.referencedTable || !newFk.referencedColumn) {
      setError('Local column, referenced table, and referenced column are required.');
      return;
    }
    const sql = addForeignKeySql({
      engine,
      schema: schemaName,
      table: tableName,
      constraintName: newFk.constraintName.trim() || undefined,
      column: newFk.column,
      referencedSchema: schemaName,
      referencedTable: newFk.referencedTable,
      referencedColumn: newFk.referencedColumn,
      onUpdate: newFk.onUpdate,
      onDelete: newFk.onDelete,
    });
    runDdl(sql, `Foreign key "${newFk.constraintName.trim() || newFk.column}" added`);
    setNewFk(emptyFk());
    setIsAddingFk(false);
  };

  const handleDropFk = (fk: ForeignKeyInfo) => {
    if (!window.confirm(`Drop foreign key "${fk.constraintName}"?`)) return;
    const sql = dropForeignKeySql(engine, schemaName, tableName, fk.constraintName);
    runDdl(sql, `Foreign key "${fk.constraintName}" dropped`);
  };

  // ── Enum types: add / edit / drop ────────────────────────────────────────
  const qualifiedType = (name: string) => qualifiedTable(engine, name, schemaName);

  const runEnumDdl = async (sql: string, label: string) => {
    setRunning(true);
    setError(null);
    setInfo(null);
    try {
      await safeInvoke('execute_query', {
        request: { config: conn, sql },
        queryId: `enum_ddl_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      setInfo(`${label} applied.`);
      setIsAddingEnum(false);
      setNewEnum({ name: '', valuesInner: '' });
      setEditingEnumName(null);
      setEditEnum(null);
      setEnumImpact(null);
      setEnumPopoverFor(null);
      void refreshEnumTypes();
      onSchemaChanged();
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  const handleAddEnum = () => {
    const name = newEnum.name.trim();
    if (!name) { setError('Type name is required.'); return; }
    if (parseEnumInner(newEnum.valuesInner).length === 0) { setError('Add at least one value.'); return; }
    runEnumDdl(`CREATE TYPE ${qualifiedType(name)} AS ENUM (${newEnum.valuesInner});`, `Enum type "${name}" created`);
  };

  const startEditEnum = (t: EnumTypeInfo) => {
    setEditingEnumName(t.name);
    setEditEnum({ name: t.name, valuesInner: buildEnumInner(t.values) });
    setError(null);
    setInfo(null);
  };

  const handleSaveEditEnum = async (original: EnumTypeInfo) => {
    if (!editEnum) return;
    const newName = editEnum.name.trim();
    if (!newName) { setError('Type name is required.'); return; }
    const newValues = parseEnumInner(editEnum.valuesInner);
    if (newValues.length === 0) { setError('Add at least one value.'); return; }

    const nameChanged = newName !== original.name;
    const valuesChanged = JSON.stringify(newValues) !== JSON.stringify(original.values);

    if (!nameChanged && !valuesChanged) {
      setEditingEnumName(null);
      setEnumPopoverFor(null);
      setInfo('No changes to save.');
      return;
    }

    if (!valuesChanged) {
      // Pure rename — cheap and safe, no recreation needed.
      runEnumDdl(`ALTER TYPE ${qualifiedType(original.name)} RENAME TO ${quoteIdent(engine, newName)};`, `Enum type "${original.name}" renamed`);
      return;
    }

    // Values changed (added/removed/reordered) — Postgres's ALTER TYPE can
    // only ADD a value in place, never remove or reorder one, so this needs
    // a full recreate. Find every column using the type first, so the
    // confirm dialog can show the actual blast radius before anything runs.
    setRunning(true);
    setError(null);
    try {
      const typeName = original.name.replace(/'/g, "''");
      const res = await safeInvoke<QueryResultData>('execute_query', {
        request: {
          config: conn,
          sql: `SELECT table_schema, table_name, column_name, column_default FROM information_schema.columns WHERE udt_name = '${typeName}';`,
        },
        queryId: `enum_deps_${Date.now()}`,
        __meta: { source: 'ddl' },
      });
      const columns = res.rows.map((r) => ({
        schema: String(r[0]),
        table: String(r[1]),
        column: String(r[2]),
        // e.g. "'active'::mood" — Postgres deparses a column default this
        // way. Ties the default's cast to the type being dropped below, so
        // it must be dropped before the type change and re-added against
        // the new type afterward, or DROP TYPE fails on the leftover
        // dependency (and a plain ALTER COLUMN TYPE would otherwise try to
        // convert it itself and can fail there instead).
        defaultExpr: r[3] === null || r[3] === undefined ? null : String(r[3]),
      }));
      setEnumImpact({ original, newName, newValues, columns });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  };

  const confirmEnumRecreate = () => {
    if (!enumImpact) return;
    const { original, newName, newValues, columns } = enumImpact;
    const tmpName = `${original.name}_old_${Date.now()}`;
    const newQualified = qualifiedType(newName);
    const statements: string[] = [
      `ALTER TYPE ${qualifiedType(original.name)} RENAME TO ${quoteIdent(engine, tmpName)};`,
      `CREATE TYPE ${newQualified} AS ENUM (${buildEnumInner(newValues)});`,
    ];
    for (const c of columns) {
      const colTbl = qualifiedTable(engine, c.table, c.schema);
      const colIdent = quoteIdent(engine, c.column);
      // A default tied to the old type must come off first — otherwise it's
      // still a dependency on the old type after the column's own type has
      // moved on, and DROP TYPE below fails.
      if (c.defaultExpr) statements.push(`ALTER TABLE ${colTbl} ALTER COLUMN ${colIdent} DROP DEFAULT;`);
      statements.push(`ALTER TABLE ${colTbl} ALTER COLUMN ${colIdent} TYPE ${newQualified} USING ${colIdent}::text::${newQualified};`);
      if (c.defaultExpr) {
        // Re-cast just the literal part of the old default ("'active'::mood"
        // -> "'active'") onto the new type. Falls back to re-applying the
        // default expression completely as-is if it isn't the usual
        // quoted-literal-then-cast shape Postgres normally deparses enum
        // defaults as — best-effort, surfaced as a normal DB error if wrong.
        const literalMatch = /^('(?:[^']|'')*')/.exec(c.defaultExpr);
        const newDefault = literalMatch ? `${literalMatch[1]}::${newQualified}` : c.defaultExpr;
        statements.push(`ALTER TABLE ${colTbl} ALTER COLUMN ${colIdent} SET DEFAULT ${newDefault};`);
      }
    }
    statements.push(`DROP TYPE ${qualifiedType(tmpName)};`);
    runEnumDdl(statements.join('\n'), `Enum type "${original.name}" updated`);
  };

  const handleRemoveEnum = (t: EnumTypeInfo) => {
    if (!window.confirm(`Drop enum type "${t.name}"? This fails if any column still uses it.`)) return;
    runEnumDdl(`DROP TYPE ${qualifiedType(t.name)};`, `Enum type "${t.name}" dropped`);
  };

  // ── DDL preview ─────────────────────────────────────────────────────────
  const generateDDL = () => {
    let ddl = `-- Structure definition for ${tbl}\n\n`;
    if (columns.length === 0) {
      return `-- Table ${tbl} has 0 columns defined.`;
    }
    ddl += `CREATE TABLE ${tbl} (\n`;
    const colLines = columns.map((c) => {
      let line = `  ${quoteIdent(engine, c.name)} ${c.data_type || 'VARCHAR(255)'}`;
      if (c.is_nullable === false) line += ' NOT NULL';
      if (c.is_primary_key) line += ' PRIMARY KEY';
      return line;
    });
    ddl += colLines.join(',\n');
    // Foreign keys inline
    if (foreignKeys.length > 0) {
      ddl += ',\n' + foreignKeys.map((fk) => {
        const refTbl = fk.referencedSchema
          ? qualifiedTable(engine, fk.referencedTable, fk.referencedSchema)
          : quoteIdent(engine, fk.referencedTable);
        const actions: string[] = [];
        if (fk.onUpdate && fk.onUpdate.toUpperCase() !== 'NO ACTION') actions.push(`ON UPDATE ${fk.onUpdate.toUpperCase()}`);
        if (fk.onDelete && fk.onDelete.toUpperCase() !== 'NO ACTION') actions.push(`ON DELETE ${fk.onDelete.toUpperCase()}`);
        return `  CONSTRAINT ${quoteIdent(engine, fk.constraintName)} FOREIGN KEY (${quoteIdent(engine, fk.column)}) REFERENCES ${refTbl}(${quoteIdent(engine, fk.referencedColumn)})${actions.length ? ' ' + actions.join(' ') : ''}`;
      }).join(',\n');
    }
    ddl += `\n);\n`;
    // Secondary indexes (PK is already inline)
    const secondaryIdx = indexes.filter((i) => !i.isPrimary);
    if (secondaryIdx.length > 0) {
      ddl += '\n' + secondaryIdx.map((idx) => createIndexSql({
        engine,
        schema: schemaName,
        table: tableName,
        name: idx.name,
        columns: idx.columns,
        isUnique: idx.isUnique,
        method: idx.method,
      })).join('\n');
    }
    return ddl;
  };

  const copyDDL = () => {
    navigator.clipboard.writeText(generateDDL());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getColumnIcon = (dataType?: string, isPrimaryKey?: boolean) => {
    if (isPrimaryKey) return <Key className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    if (!dataType) return <Code className="w-3.5 h-3.5 text-slate-500 shrink-0" />;
    const dt = dataType.toLowerCase();
    if (dt.includes('int') || dt.includes('float') || dt.includes('double') || dt.includes('numeric') || dt.includes('decimal')) {
      return <Hash className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    }
    if (dt.includes('date') || dt.includes('time') || dt.includes('timestamp')) {
      return <Calendar className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    }
    if (dt.includes('bool')) {
      return <ToggleLeft className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
    }
    return <Type className="w-3.5 h-3.5 text-blue-400 shrink-0" />;
  };

  // ── Type-pill color helper (matches the icon palette) ───────────────────
  const typePillClass = (dataType?: string): string => {
    if (!dataType) return 'bg-slate-500/15 text-slate-400';
    const dt = dataType.toLowerCase();
    if (dt.includes('int') || dt.includes('float') || dt.includes('double') || dt.includes('numeric') || dt.includes('decimal')) {
      return 'bg-amber-500/15 text-amber-400';
    }
    if (dt.includes('date') || dt.includes('time') || dt.includes('timestamp')) {
      return 'bg-cyan-500/15 text-cyan-400';
    }
    if (dt.includes('bool')) return 'bg-purple-500/15 text-purple-400';
    return 'bg-blue-500/15 text-blue-400';
  };

  const indexCount = indexes.length;
  const fkCount = foreignKeys.length;

  return (
    <>
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 select-none font-sans">
      <div className="bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl w-full max-w-4xl min-h-[560px] max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-[#1e293b] flex items-center justify-between bg-gradient-to-r from-[#06090e] to-[#0c1320]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center ring-1 ring-blue-500/20">
              <Columns className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 font-mono flex items-center gap-2">
                {tbl}
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-300">
                  {String(engine).toUpperCase()}
                </span>
              </h2>
              <p className="text-[11px] text-slate-400 font-mono">
                {columns.length} columns • {indexCount} indexes • {fkCount} foreign keys
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center border-b border-[#1e293b] bg-[#080c14] text-xs font-medium px-3">
          <div className="flex gap-1">
            {[
              ['columns', 'Columns', columns.length, Columns] as const,
              ['indexes', 'Indexes', indexCount, Layers] as const,
              ['foreignKeys', 'Foreign Keys', fkCount, GitBranch] as const,
              ...(isPg ? [['enumTypes', 'Enum Types', enumTypes.length, List] as const] : []),
              ['ddl', 'DDL', null, FileCode] as const,
            ].map(([key, label, count, Icon]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-3 py-2.5 border-b-2 transition-all flex items-center gap-1.5 rounded-t-md ${
                  activeTab === key
                    ? 'border-blue-500 text-blue-300 font-semibold bg-blue-500/5'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/5'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
                {count !== null && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold ${
                    activeTab === key ? 'bg-blue-500/30 text-blue-200' : 'bg-slate-700/50 text-slate-400'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-4 bg-[#06090e] font-mono text-xs macos-scroll">
          {error && (
            <div className="mb-3">
              <CopyableErrorBanner message={error} tone="red" compact parseAsDbError />
            </div>
          )}
          {info && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] flex items-center gap-2">
              <Check className="w-3 h-3 shrink-0" />
              {info}
            </div>
          )}

          {/* ── Columns ─────────────────────────────────────────────────── */}
          {activeTab === 'columns' && (
            <div className="space-y-2.5">
              <div className="border border-[#1e293b] rounded-xl overflow-hidden bg-[#0a0f18]">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-[#0f172a] border-b border-[#1e293b] text-slate-400 uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="py-1.5 px-2.5 border-r border-[#1e293b] w-9 text-center">#</th>
                      <th className="py-1.5 px-2.5 border-r border-[#1e293b]">Field Name</th>
                      <th className="py-1.5 px-2.5 border-r border-[#1e293b] w-40">Type</th>
                      <th className="py-1.5 px-2.5 border-r border-[#1e293b] w-20">Length</th>
                      <th className="py-1.5 px-2.5 border-r border-[#1e293b] text-center w-20">Flags</th>
                      <th className="py-1.5 px-2.5 text-center w-20">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((col, idx) => {
                      const isEditing = editingName === col.name;
                      const d = isEditing ? editDraft! : toDraft(col);
                      return (
                        <tr key={col.name} className={`border-b border-[#1e293b]/50 transition-colors ${idx % 2 === 1 ? 'bg-white/[0.015]' : ''} hover:bg-[#141e33]`}>
                          <td className="py-1.5 px-2.5 border-r border-[#1e293b] text-slate-500 text-center text-[11px]">{idx + 1}</td>
                          <td className="py-1.5 px-2.5 border-r border-[#1e293b] text-slate-200 align-top">
                            {isEditing ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  {getColumnIcon(joinType(d.type, d.length), d.pk)}
                                  <input
                                    value={d.name}
                                    onChange={(e) => setEditDraft({ ...d, name: e.target.value })}
                                    autoFocus
                                    className={INPUT_CLS}
                                  />
                                </div>
                                {supportsColumnComment(engine) && (
                                  <input
                                    value={d.comment}
                                    onChange={(e) => setEditDraft({ ...d, comment: e.target.value })}
                                    placeholder="Comment (optional)…"
                                    className={INPUT_CLS_SM}
                                  />
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 font-semibold">
                                {getColumnIcon(col.data_type, col.is_primary_key)}
                                <span>{col.name}</span>
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 border-r border-[#1e293b] align-top">
                            {isEditing ? (
                              <select
                                value={d.type}
                                onChange={(e) => setEditDraft({ ...d, type: e.target.value })}
                                className={INPUT_CLS}
                              >
                                {getGroupedTypeOptions(engine).map((group) => (
                                  <optgroup key={group.label} label={group.label}>
                                    {group.types.map((t) => (
                                      <option key={t.label} value={t.label}>{t.label}</option>
                                    ))}
                                  </optgroup>
                                ))}
                                {!getTypeOptions(engine).includes(d.type) && (
                                  <option value={d.type}>{d.type}</option>
                                )}
                              </select>
                            ) : (
                              <div className="relative flex items-center gap-1">
                                <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold lowercase ${typePillClass(col.data_type)}`}>
                                  {splitType(col.data_type).type || '—'}
                                </span>
                                {(() => {
                                  const colEnum = isPg ? enumTypes.find((et) => et.name.toLowerCase() === (col.data_type || '').toLowerCase()) : undefined;
                                  if (!colEnum) return null;
                                  return (
                                    <>
                                      <button
                                        onClick={() => { startEditEnum(colEnum); setEnumPopoverFor(colEnum.name); }}
                                        title={`Edit enum type "${colEnum.name}"`}
                                        className="p-0.5 rounded hover:bg-[#1e293b] text-slate-500 hover:text-purple-400"
                                      >
                                        <List className="w-3 h-3" />
                                      </button>
                                      {enumPopoverFor === colEnum.name && editEnum && (
                                        <div ref={enumPopoverRef} className="absolute z-40 top-full left-0 mt-1 w-64 bg-[#0a0f18] border border-[#1e293b] rounded-lg shadow-2xl p-2.5 space-y-2 normal-case">
                                          <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold text-purple-300 uppercase tracking-wider flex items-center gap-1">
                                              <List className="w-3 h-3" /> Edit Enum Type
                                            </span>
                                            <button onClick={() => { setEnumPopoverFor(null); setEditingEnumName(null); setEditEnum(null); setError(null); }} className="text-slate-500 hover:text-slate-300">
                                              <X className="w-3 h-3" />
                                            </button>
                                          </div>
                                          <div>
                                            <label className="block text-[9px] text-slate-400 mb-1">Type Name</label>
                                            <input type="text" value={editEnum.name} onChange={(e) => setEditEnum({ ...editEnum, name: e.target.value })} className={INPUT_CLS_SM} />
                                          </div>
                                          <div>
                                            <label className="block text-[9px] text-slate-400 mb-1">Values</label>
                                            <EnumValuesInput value={editEnum.valuesInner} onChange={(inner) => setEditEnum({ ...editEnum, valuesInner: inner })} className={INPUT_CLS_SM} />
                                          </div>
                                          <div className="text-[9px] text-amber-400/80 normal-case">
                                            Removing or reordering values migrates every column using this type — you'll see which ones before anything runs.
                                          </div>
                                          <div className="flex justify-end gap-1.5">
                                            <button onClick={() => { setEnumPopoverFor(null); setEditingEnumName(null); setEditEnum(null); setError(null); }}
                                              className="px-2 py-1 rounded text-[10px] font-semibold bg-[#141e33] hover:bg-[#1e293b] text-slate-400">
                                              Cancel
                                            </button>
                                            <button onClick={() => handleSaveEditEnum(colEnum)} disabled={running}
                                              className="px-2 py-1 rounded text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white flex items-center gap-1">
                                              {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                                              Save
                                            </button>
                                          </div>
                                        </div>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 border-r border-[#1e293b] align-top">
                            {isEditing ? (
                              isEnumType(d.type) ? (
                                <EnumValuesInput
                                  value={d.length}
                                  onChange={(inner) => setEditDraft({ ...d, length: inner })}
                                  className={INPUT_CLS}
                                />
                              ) : (
                                <input
                                  value={d.length}
                                  onChange={(e) => setEditDraft({ ...d, length: e.target.value })}
                                  placeholder="—"
                                  className={INPUT_CLS}
                                />
                              )
                            ) : (
                              <span className="text-slate-400 text-[11px] font-mono">{splitType(col.data_type).length || '—'}</span>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 border-r border-[#1e293b] text-center align-top">
                            {isEditing ? (
                              <div className="flex items-center justify-center gap-2">
                                <label className="flex items-center gap-1 text-[9px] text-slate-300">
                                  <input type="checkbox" checked={d.nullable} onChange={(e) => setEditDraft({ ...d, nullable: e.target.checked })} />
                                  NULL
                                </label>
                                <label className="flex items-center gap-1 text-[9px] text-slate-300">
                                  <input type="checkbox" checked={d.pk} onChange={(e) => setEditDraft({ ...d, pk: e.target.checked })} />
                                  PK
                                </label>
                              </div>
                            ) : (
                              <div className="flex flex-wrap items-center justify-center gap-1">
                                {col.is_primary_key ? (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-bold">PK</span>
                                ) : (
                                  <span className="text-slate-600 text-[10px]">—</span>
                                )}
                                {col.is_nullable !== false && (
                                  <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400 text-[9px] font-bold">NULL</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 px-2.5 text-center align-top">
                            {isEditing ? (
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => handleSaveEdit(col)} disabled={running} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 disabled:opacity-40" title="Save changes">
                                  {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                </button>
                                <button onClick={() => { setEditingName(null); setEditDraft(null); setError(null); }} className="p-1 rounded hover:bg-[#1e293b] text-slate-400" title="Cancel">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-center gap-1">
                                <button onClick={() => startEdit(col)} className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-blue-400" title="Edit column">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => handleRemove(col)} disabled={running} className="p-1 rounded hover:bg-[#1e293b] text-slate-400 hover:text-red-400 disabled:opacity-40" title="Drop column">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Add Column */}
              {isAddingColumn ? (
                <div className="p-3 bg-[#0f172a] border border-blue-500/30 rounded-xl space-y-2.5">
                  <div className="font-bold text-blue-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Add New Column</span>
                    <button onClick={() => { setIsAddingColumn(false); setError(null); }} className="text-slate-500 hover:text-slate-300">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-[1.3fr_1fr_0.7fr_auto_auto] gap-2 items-end">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Field Name</label>
                      <input type="text" placeholder="e.g. status" value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })} autoFocus
                        className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Type</label>
                      <select value={newCol.type} onChange={(e) => setNewCol({ ...newCol, type: e.target.value })} className={INPUT_CLS}>
                        {getGroupedTypeOptions(engine).map((group) => (
                          <optgroup key={group.label} label={group.label}>
                            {group.types.map((t) => (<option key={t.label} value={t.label}>{t.label}</option>))}
                          </optgroup>
                        ))}
                        {!getTypeOptions(engine).includes(newCol.type) && (<option value={newCol.type}>{newCol.type}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">
                        {isEnumType(newCol.type) ? 'Values' : 'Length'}
                      </label>
                      {isEnumType(newCol.type) ? (
                        <EnumValuesInput
                          value={newCol.length}
                          onChange={(inner) => setNewCol({ ...newCol, length: inner })}
                          className={INPUT_CLS}
                        />
                      ) : (
                        <input type="text" placeholder="255" value={newCol.length} onChange={(e) => setNewCol({ ...newCol, length: e.target.value })}
                          className={INPUT_CLS} />
                      )}
                    </div>
                    <label className="flex items-center gap-1 text-[10px] text-slate-300 h-8">
                      <input type="checkbox" checked={newCol.nullable} onChange={(e) => setNewCol({ ...newCol, nullable: e.target.checked })} />
                      Null
                    </label>
                    <label className="flex items-center gap-1 text-[10px] text-slate-300 h-8">
                      <input type="checkbox" checked={newCol.pk} onChange={(e) => setNewCol({ ...newCol, pk: e.target.checked })} />
                      PK
                    </label>
                  </div>
                  {supportsColumnComment(engine) && (
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Comment (optional)</label>
                      <input type="text" placeholder="Describe this column…" value={newCol.comment} onChange={(e) => setNewCol({ ...newCol, comment: e.target.value })}
                        className={INPUT_CLS} />
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button onClick={handleAdd} disabled={running || !newCol.name.trim()}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded-lg flex items-center gap-1.5 transition-colors">
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Add Column
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setIsAddingColumn(true); setError(null); setInfo(null); setNewCol({ name: '', type: 'varchar', length: '255', nullable: true, pk: false, comment: '' }); }}
                  className="w-full py-1.5 border border-dashed border-[#1e293b] hover:border-blue-500/50 hover:bg-[#0f172a] rounded-xl text-slate-400 hover:text-blue-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Field / Column
                </button>
              )}
            </div>
          )}

          {/* ── Indexes ──────────────────────────────────────────────────── */}
          {activeTab === 'indexes' && (
            <div className="space-y-2">
              {loadingMeta && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500 py-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading indexes…
                </div>
              )}
              {metaError && !loadingMeta && (
                <div className="text-[11px] text-slate-500 italic py-2">Could not load indexes: {metaError}</div>
              )}
              {!loadingMeta && !metaError && indexes.length === 0 && !isAddingIndex && (
                <div className="p-6 text-center text-slate-500 italic">No indexes on this table.</div>
              )}
              {indexes.map((idx) => {
                const isEditingThis = editingIdxName === idx.name;
                const form = isEditingThis ? editIdx! : null;
                return (
                <div key={idx.name} className="p-2.5 bg-[#0a0f18] border border-[#1e293b] rounded-lg hover:border-slate-700 transition-colors">
                  {isEditingThis && form ? (
                    <div className="space-y-2">
                      <div className="font-bold text-blue-400 flex items-center justify-between">
                        <span className="flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5" /> Edit Index</span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleSaveEditIndex(idx)} disabled={running} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 disabled:opacity-40" title="Save">
                            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => { setEditingIdxName(null); setEditIdx(null); setError(null); }} className="p-1 rounded hover:bg-[#1e293b] text-slate-400" title="Cancel">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Name</label>
                          <input type="text" value={form.name} onChange={(e) => setEditIdx({ ...form, name: e.target.value })} className={INPUT_CLS} />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Method</label>
                          <select value={form.method} onChange={(e) => setEditIdx({ ...form, method: e.target.value })} className={INPUT_CLS}>
                            <option value="BTREE">BTREE</option>
                            <option value="HASH">HASH</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-400 mb-1">Columns</label>
                        <div className="flex flex-wrap gap-1.5">
                          {columns.map((c) => {
                            const checked = form.columns.includes(c.name);
                            return (
                              <button key={c.name} type="button" onClick={() => setEditIdx({
                                ...form,
                                columns: checked ? form.columns.filter((x) => x !== c.name) : [...form.columns, c.name],
                              })}
                                className={`px-2 py-1 rounded text-[10px] font-mono border transition-colors ${
                                  checked ? 'bg-blue-600/30 border-blue-500 text-blue-200' : 'bg-[#06090e] border-[#1e293b] text-slate-400 hover:border-blue-500/50'
                                }`}>
                                {c.name}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-[10px] text-slate-300">
                        <input type="checkbox" checked={form.isUnique} onChange={(e) => setEditIdx({ ...form, isUnique: e.target.checked })} />
                        Unique
                      </label>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Layers className={`w-4 h-4 shrink-0 ${idx.isPrimary ? 'text-amber-400' : idx.isUnique ? 'text-emerald-400' : 'text-purple-400'}`} />
                        <div className="font-bold text-slate-100 flex-1 truncate text-[12px]">{idx.name}</div>
                        {idx.isPrimary && <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-bold">PK</span>}
                        {idx.isUnique && !idx.isPrimary && <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">UNIQUE</span>}
                        {idx.method && <span className="px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 text-[9px] font-bold uppercase">{idx.method}</span>}
                        {!idx.isPrimary && (
                          <div className="flex items-center gap-1">
                            <button onClick={() => startEditIndex(idx)} disabled={running} title="Edit index"
                              className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-blue-400 disabled:opacity-40">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleDropIndex(idx)} disabled={running} title="Drop index"
                              className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-400 disabled:opacity-40">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {idx.columns.map((c, i) => (
                          <span key={i} className="px-1.5 py-0.5 rounded bg-[#1e293b] text-slate-300 text-[10px] font-mono">
                            {c}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                );
              })}

              {isAddingIndex ? (
                <div className="p-3 bg-[#0f172a] border border-blue-500/30 rounded-xl space-y-2">
                  <div className="font-bold text-blue-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Add Index</span>
                    <button onClick={() => { setIsAddingIndex(false); setError(null); }} className="text-slate-500 hover:text-slate-300"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Name (optional)</label>
                      <input type="text" placeholder="auto-generated" value={newIdx.name} onChange={(e) => setNewIdx({ ...newIdx, name: e.target.value })} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Method</label>
                      <select value={newIdx.method} onChange={(e) => setNewIdx({ ...newIdx, method: e.target.value })} className={INPUT_CLS}>
                        <option value="BTREE">BTREE</option>
                        <option value="HASH">HASH</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-400 mb-1">Columns</label>
                    <div className="flex flex-wrap gap-1.5">
                      {columns.map((c) => {
                        const checked = newIdx.columns.includes(c.name);
                        return (
                          <button key={c.name} type="button" onClick={() => setNewIdx((prev) => ({
                            ...prev,
                            columns: checked ? prev.columns.filter((x) => x !== c.name) : [...prev.columns, c.name],
                          }))}
                            className={`px-2 py-1 rounded text-[10px] font-mono border transition-colors ${
                              checked ? 'bg-blue-600/30 border-blue-500 text-blue-200' : 'bg-[#06090e] border-[#1e293b] text-slate-400 hover:border-blue-500/50'
                            }`}>
                            {c.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[10px] text-slate-300">
                    <input type="checkbox" checked={newIdx.isUnique} onChange={(e) => setNewIdx({ ...newIdx, isUnique: e.target.checked })} />
                    Unique
                  </label>
                  <div className="flex justify-end">
                    <button onClick={handleAddIndex} disabled={running || newIdx.columns.length === 0}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded-lg flex items-center gap-1.5 transition-colors">
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Create Index
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setIsAddingIndex(true); setError(null); setInfo(null); setNewIdx({ name: '', columns: [], isUnique: false, method: 'BTREE' }); }}
                  className="w-full py-1.5 border border-dashed border-[#1e293b] hover:border-blue-500/50 hover:bg-[#0f172a] rounded-xl text-slate-400 hover:text-blue-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  Add Index
                </button>
              )}
            </div>
          )}

          {/* ── Foreign Keys ─────────────────────────────────────────────── */}
          {activeTab === 'foreignKeys' && (
            <div className="space-y-2">
              {loadingMeta && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500 py-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading foreign keys…
                </div>
              )}
              {metaError && !loadingMeta && (
                <div className="text-[11px] text-slate-500 italic py-2">Could not load foreign keys: {metaError}</div>
              )}
              {!loadingMeta && !metaError && foreignKeys.length === 0 && !isAddingFk && (
                <div className="p-6 text-center text-slate-500 italic">No foreign key constraints on this table.</div>
              )}
              {foreignKeys.map((fk) => {
                const isEditingThis = editingFkName === fk.constraintName;
                const form = isEditingThis ? editFk! : null;
                return (
                <div key={fk.constraintName} className="p-2.5 bg-[#0a0f18] border border-[#1e293b] rounded-lg hover:border-slate-700 transition-colors">
                  {isEditingThis && form ? (
                    <div className="space-y-2">
                      <div className="font-bold text-blue-400 flex items-center justify-between">
                        <span className="flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5" /> Edit Foreign Key</span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleSaveEditFk(fk)} disabled={running} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 disabled:opacity-40" title="Save">
                            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => { setEditingFkName(null); setEditFk(null); setError(null); }} className="p-1 rounded hover:bg-[#1e293b] text-slate-400" title="Cancel">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Constraint Name</label>
                          <input type="text" value={form.constraintName} onChange={(e) => setEditFk({ ...form, constraintName: e.target.value })} className={INPUT_CLS} />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Local Column</label>
                          <select value={form.column} onChange={(e) => setEditFk({ ...form, column: e.target.value })} className={INPUT_CLS}>
                            <option value="">Select…</option>
                            {columns.map((c) => (<option key={c.name} value={c.name}>{c.name}</option>))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Referenced Table</label>
                          <input type="text" value={form.referencedTable} onChange={(e) => setEditFk({ ...form, referencedTable: e.target.value })} className={INPUT_CLS} />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">Referenced Column</label>
                          <input type="text" value={form.referencedColumn} onChange={(e) => setEditFk({ ...form, referencedColumn: e.target.value })} className={INPUT_CLS} />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">ON UPDATE</label>
                          <select value={form.onUpdate} onChange={(e) => setEditFk({ ...form, onUpdate: e.target.value })} className={INPUT_CLS}>
                            {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((v) => (<option key={v} value={v}>{v}</option>))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-400 mb-1">ON DELETE</label>
                          <select value={form.onDelete} onChange={(e) => setEditFk({ ...form, onDelete: e.target.value })} className={INPUT_CLS}>
                            {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((v) => (<option key={v} value={v}>{v}</option>))}
                          </select>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <Link2 className="w-4 h-4 text-cyan-400 shrink-0" />
                        <div className="font-bold text-slate-100 flex-1 truncate text-[12px]">{fk.constraintName}</div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => startEditFk(fk)} disabled={running} title="Edit foreign key"
                            className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-blue-400 disabled:opacity-40">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDropFk(fk)} disabled={running} title="Drop foreign key"
                            className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-400 disabled:opacity-40">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="px-1.5 py-0.5 rounded bg-[#1e293b] text-slate-300 font-mono">{fk.column}</span>
                        <span className="text-cyan-400">→</span>
                        <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 font-mono">
                          {fk.referencedSchema ? `${fk.referencedSchema}.` : ''}{fk.referencedTable}({fk.referencedColumn})
                        </span>
                        {fk.onUpdate && fk.onUpdate.toUpperCase() !== 'NO ACTION' && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 font-mono">ON UPDATE {fk.onUpdate}</span>
                        )}
                        {fk.onDelete && fk.onDelete.toUpperCase() !== 'NO ACTION' && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-700/40 text-slate-400 font-mono">ON DELETE {fk.onDelete}</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
                );
              })}

              {isAddingFk ? (
                <div className="p-3 bg-[#0f172a] border border-blue-500/30 rounded-xl space-y-2">
                  <div className="font-bold text-blue-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Add Foreign Key</span>
                    <button onClick={() => { setIsAddingFk(false); setError(null); }} className="text-slate-500 hover:text-slate-300"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Constraint Name</label>
                      <input type="text" placeholder="auto" value={newFk.constraintName} onChange={(e) => setNewFk({ ...newFk, constraintName: e.target.value })} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Local Column</label>
                      <select value={newFk.column} onChange={(e) => setNewFk({ ...newFk, column: e.target.value })} className={INPUT_CLS}>
                        <option value="">Select column…</option>
                        {columns.map((c) => (<option key={c.name} value={c.name}>{c.name}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Referenced Table</label>
                      <input type="text" placeholder="e.g. users" value={newFk.referencedTable} onChange={(e) => setNewFk({ ...newFk, referencedTable: e.target.value })} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Referenced Column</label>
                      <input type="text" placeholder="id" value={newFk.referencedColumn} onChange={(e) => setNewFk({ ...newFk, referencedColumn: e.target.value })} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">ON UPDATE</label>
                      <select value={newFk.onUpdate} onChange={(e) => setNewFk({ ...newFk, onUpdate: e.target.value })} className={INPUT_CLS}>
                        {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((v) => (<option key={v} value={v}>{v}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">ON DELETE</label>
                      <select value={newFk.onDelete} onChange={(e) => setNewFk({ ...newFk, onDelete: e.target.value })} className={INPUT_CLS}>
                        {['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'].map((v) => (<option key={v} value={v}>{v}</option>))}
                      </select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={handleAddFk} disabled={running || !newFk.column || !newFk.referencedTable}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded-lg flex items-center gap-1.5 transition-colors">
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Add Foreign Key
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setIsAddingFk(true); setError(null); setInfo(null); setNewFk(emptyFk()); }}
                  className="w-full py-1.5 border border-dashed border-[#1e293b] hover:border-blue-500/50 hover:bg-[#0f172a] rounded-xl text-slate-400 hover:text-blue-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  Add Foreign Key
                </button>
              )}
            </div>
          )}

          {/* ── Enum Types (Postgres only) ──────────────────────────────── */}
          {activeTab === 'enumTypes' && (
            <div className="space-y-2">
              {loadingEnums && (
                <div className="flex items-center gap-2 text-[11px] text-slate-500 py-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading enum types…
                </div>
              )}
              {enumsError && !loadingEnums && (
                <div className="text-[11px] text-slate-500 italic py-2">Could not load enum types: {enumsError}</div>
              )}
              {!loadingEnums && !enumsError && enumTypes.length === 0 && !isAddingEnum && (
                <div className="p-6 text-center text-slate-500 italic">
                  No enum types in {schemaName || 'public'}. Enum types are database objects — created once, then used as a column type across any table.
                </div>
              )}
              {enumTypes.map((t) => {
                const isEditingThis = editingEnumName === t.name;
                const form = isEditingThis ? editEnum! : null;
                return (
                  <div key={t.name} className="p-2.5 bg-[#0a0f18] border border-[#1e293b] rounded-lg hover:border-slate-700 transition-colors">
                    {isEditingThis && form ? (
                      <div className="space-y-2">
                        <div className="font-bold text-blue-400 flex items-center justify-between">
                          <span className="flex items-center gap-1.5"><Pencil className="w-3.5 h-3.5" /> Edit Enum Type</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleSaveEditEnum(t)} disabled={running} className="p-1 rounded hover:bg-emerald-500/20 text-emerald-400 disabled:opacity-40" title="Save">
                              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => { setEditingEnumName(null); setEditEnum(null); setError(null); }} className="p-1 rounded hover:bg-[#1e293b] text-slate-400" title="Cancel">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">Type Name</label>
                            <input type="text" value={form.name} onChange={(e) => setEditEnum({ ...form, name: e.target.value })} className={INPUT_CLS} />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-400 mb-1">Values</label>
                            <EnumValuesInput
                              value={form.valuesInner}
                              onChange={(inner) => setEditEnum({ ...form, valuesInner: inner })}
                              className={INPUT_CLS}
                            />
                          </div>
                        </div>
                        <div className="text-[10px] text-amber-400/80">
                          Removing or reordering values recreates the type and migrates every column using it — you'll see exactly which ones before anything runs.
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <List className="w-4 h-4 text-purple-400 shrink-0" />
                        <div className="font-bold text-slate-100 flex-1 truncate text-[12px]">{t.name}</div>
                        <div className="flex flex-wrap items-center gap-1 max-w-[50%] justify-end">
                          {t.values.map((v) => (
                            <span key={v} className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 font-mono text-[10px]">{v}</span>
                          ))}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => startEditEnum(t)} disabled={running} title="Edit enum type"
                            className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-blue-400 disabled:opacity-40">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleRemoveEnum(t)} disabled={running} title="Drop enum type"
                            className="p-1 rounded hover:bg-[#1e293b] text-slate-500 hover:text-red-400 disabled:opacity-40">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {isAddingEnum ? (
                <div className="p-3 bg-[#0f172a] border border-blue-500/30 rounded-xl space-y-2">
                  <div className="font-bold text-blue-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5" /> Add Enum Type</span>
                    <button onClick={() => { setIsAddingEnum(false); setError(null); }} className="text-slate-500 hover:text-slate-300"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Type Name</label>
                      <input type="text" placeholder="e.g. mood" value={newEnum.name} onChange={(e) => setNewEnum({ ...newEnum, name: e.target.value })}
                        autoCapitalize="off" autoCorrect="off" spellCheck={false} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-[10px] text-slate-400 mb-1">Values</label>
                      <EnumValuesInput
                        value={newEnum.valuesInner}
                        onChange={(inner) => setNewEnum({ ...newEnum, valuesInner: inner })}
                        autoFocus
                        className={INPUT_CLS}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button onClick={handleAddEnum} disabled={running || !newEnum.name.trim() || parseEnumInner(newEnum.valuesInner).length === 0}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold rounded-lg flex items-center gap-1.5 transition-colors">
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Add Enum Type
                    </button>
                  </div>
                </div>
              ) : (
                <button onClick={() => { setIsAddingEnum(true); setError(null); setInfo(null); setNewEnum({ name: '', valuesInner: '' }); }}
                  className="w-full py-1.5 border border-dashed border-[#1e293b] hover:border-blue-500/50 hover:bg-[#0f172a] rounded-xl text-slate-400 hover:text-blue-400 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors">
                  <Plus className="w-3.5 h-3.5" />
                  Add Enum Type
                </button>
              )}
            </div>
          )}

          {/* ── DDL ──────────────────────────────────────────────────────── */}
          {activeTab === 'ddl' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={copyDDL}
                  className="flex items-center gap-1.5 px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-semibold shadow transition-all">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copied ? 'Copied!' : 'Copy DDL Statement'}</span>
                </button>
              </div>
              <pre className="p-4 bg-[#0a0f18] border border-[#1e293b] rounded-xl text-cyan-300 text-xs overflow-x-auto leading-relaxed whitespace-pre-wrap break-all">
                {generateDDL()}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#1e293b] bg-[#06090e] flex justify-end">
          <button onClick={onClose}
            className="px-4 py-1.5 bg-[#1e293b] hover:bg-[#334155] text-slate-200 rounded-xl text-xs font-semibold transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>

    {enumImpact && (
      <ConfirmDialog
        title={`Recreate enum type "${enumImpact.original.name}"?`}
        message={
          <>
            Postgres can't remove or reorder enum values in place — this renames the current type
            aside, creates a new one with the updated values, migrates every column below to it,
            then drops the old type.
            {enumImpact.columns.length > 0 && (
              <> If any of those columns hold a value you removed, the migration will fail — Postgres
              validates every existing row against the new value list.</>
            )}
          </>
        }
        confirmLabel={running ? 'Applying…' : 'Recreate & Migrate'}
        tone="warning"
        loading={running}
        onConfirm={confirmEnumRecreate}
        onClose={() => setEnumImpact(null)}
      >
        {enumImpact.columns.length > 0 ? (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
              {enumImpact.columns.length} column{enumImpact.columns.length === 1 ? '' : 's'} using this type
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {enumImpact.columns.map((c, i) => (
                <div key={i} className="font-mono text-[11px] text-slate-300">
                  {c.schema}.{c.table}.{c.column}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-slate-500 italic">No columns currently use this type.</div>
        )}
      </ConfirmDialog>
    )}
    </>
  );
};

// Re-export the type for callers that store a context object.
export type { SchemaTableNode };
