import { describe, it, expect } from 'vitest';
import {
  buildObjectChanges,
  buildObjectRows,
  classifyColumn,
  filterObjects,
  filterRows,
  totalRows,
  filterStatements,
  isDestructiveStatement,
  matchesQuery,
  presentObjectTypes,
  safeObjectKeys,
  scriptText,
  statementKind,
  summarizeObjects,
  summarizeStatements,
  toObjectChange,
  EMPTY_FILTER,
} from '../diffModel';
import type {
  ColumnDiff,
  SchemaDiffResult,
  SyncStatement,
  TableDiff,
} from '../../domain/types';

// --- fixtures --------------------------------------------------------------

function col(partial: Partial<ColumnDiff> & Pick<ColumnDiff, 'name' | 'status'>): ColumnDiff {
  return { ...partial } as ColumnDiff;
}

/** users: new table in source → CREATE TABLE in target. */
const addedTable: TableDiff = {
  name: 'users',
  objectType: 'table',
  status: 'added',
  rowCountSource: 1204,
  columns: [
    col({ name: 'id', status: 'added', sourceDataType: 'int', sourceIsNullable: false, sourceIsPrimaryKey: true }),
    col({ name: 'email', status: 'added', sourceDataType: 'varchar(255)', sourceIsNullable: false }),
  ],
};

/** anamneses: only in target → DROP TABLE. */
const removedTable: TableDiff = {
  name: 'anamneses',
  objectType: 'table',
  status: 'removed',
  rowCountTarget: 500,
  columns: [
    col({ name: 'id', status: 'removed', targetDataType: 'int', targetIsPrimaryKey: true }),
    col({ name: 'note', status: 'removed', targetDataType: 'text' }),
  ],
};

/** patients: mixed alter — one added nullable column, one type change. */
const modifiedTable: TableDiff = {
  schema: 'public',
  name: 'patients',
  objectType: 'table',
  status: 'modified',
  rowCountSource: 820,
  rowCountTarget: 810,
  columns: [
    col({ name: 'id', status: 'unchanged', sourceDataType: 'int', targetDataType: 'int' }),
    col({ name: 'phone_verified_at', status: 'added', sourceDataType: 'datetime', sourceIsNullable: true }),
    col({
      name: 'status',
      status: 'modified',
      sourceDataType: 'varchar(20)',
      targetDataType: 'varchar(10)',
      sourceIsNullable: true,
      targetIsNullable: true,
      changeDescription: 'type: varchar(10) → varchar(20)',
    }),
  ],
};

/** legacy_notes: alter that drops a column → destructive. */
const destructiveAlter: TableDiff = {
  name: 'legacy_notes',
  objectType: 'table',
  status: 'modified',
  columns: [
    col({ name: 'legacy_status', status: 'removed', targetDataType: 'varchar(10)' }),
  ],
};

const unchangedTable: TableDiff = {
  name: 'settings',
  objectType: 'table',
  status: 'unchanged',
  rowCountSource: 10,
  rowCountTarget: 10,
  // The backend omits column detail for identical objects.
  columns: [],
};

const addedView: TableDiff = {
  name: 'patient_summary',
  objectType: 'view',
  status: 'added',
  columns: [col({ name: 'total', status: 'added', sourceDataType: 'int' })],
};

const diff: SchemaDiffResult = {
  sourceEngine: 'mysql',
  targetEngine: 'mysql',
  summary: { added: 2, removed: 1, modified: 2, unchanged: 1 },
  tables: [addedTable, removedTable, modifiedTable, destructiveAlter, unchangedTable, addedView],
};

// --- risk classification ---------------------------------------------------

describe('classifyColumn', () => {
  it('treats every column of an added table as low risk (one CREATE TABLE)', () => {
    expect(classifyColumn(col({ name: 'id', status: 'added', sourceIsNullable: false }), 'added')).toBe('low');
  });

  it('treats every column of a removed table as high risk', () => {
    expect(classifyColumn(col({ name: 'id', status: 'removed' }), 'removed')).toBe('high');
  });

  it('rates a new nullable column low and a new NOT NULL column medium', () => {
    expect(classifyColumn(col({ name: 'a', status: 'added', sourceIsNullable: true }), 'modified')).toBe('low');
    expect(classifyColumn(col({ name: 'a', status: 'added', sourceIsNullable: false }), 'modified')).toBe('medium');
  });

  it('rates dropping a column high', () => {
    expect(classifyColumn(col({ name: 'a', status: 'removed' }), 'modified')).toBe('high');
  });

  it('rates a type change medium', () => {
    const c = col({ name: 'a', status: 'modified', sourceDataType: 'bigint', targetDataType: 'int' });
    expect(classifyColumn(c, 'modified')).toBe('medium');
  });

  it('ignores type case when deciding whether the type changed', () => {
    const c = col({
      name: 'a',
      status: 'modified',
      sourceDataType: 'VARCHAR(20)',
      targetDataType: 'varchar(20)',
      sourceIsNullable: true,
      targetIsNullable: false,
    });
    // Only nullability loosened (NOT NULL → NULL) — safe.
    expect(classifyColumn(c, 'modified')).toBe('low');
  });

  it('rates tightening nullability medium and loosening it low', () => {
    const tighten = col({ name: 'a', status: 'modified', sourceIsNullable: false, targetIsNullable: true });
    const loosen = col({ name: 'a', status: 'modified', sourceIsNullable: true, targetIsNullable: false });
    expect(classifyColumn(tighten, 'modified')).toBe('medium');
    expect(classifyColumn(loosen, 'modified')).toBe('low');
  });

  it('rates a primary-key change high', () => {
    const c = col({
      name: 'id',
      status: 'modified',
      sourceIsPrimaryKey: false,
      targetIsPrimaryKey: true,
    });
    expect(classifyColumn(c, 'modified')).toBe('high');
  });
});

// --- object rollup ---------------------------------------------------------

describe('toObjectChange', () => {
  it('drops unchanged tables', () => {
    expect(toObjectChange(unchangedTable)).toBeNull();
  });

  it('rolls an added table up as low risk and non-destructive', () => {
    const o = toObjectChange(addedTable)!;
    expect(o.status).toBe('added');
    expect(o.risk).toBe('low');
    expect(o.destructive).toBe(false);
    expect(o.changeCount).toBe(2);
  });

  it('rolls a removed table up as high risk and destructive', () => {
    const o = toObjectChange(removedTable)!;
    expect(o.risk).toBe('high');
    expect(o.destructive).toBe(true);
  });

  it('keeps only changed columns for a modified table', () => {
    const o = toObjectChange(modifiedTable)!;
    expect(o.columns.map((c) => c.name)).toEqual(['phone_verified_at', 'status']);
    expect(o.addedColumns).toBe(1);
    expect(o.modifiedColumns).toBe(1);
    expect(o.removedColumns).toBe(0);
    // max(low, medium) = medium
    expect(o.risk).toBe('medium');
    expect(o.destructive).toBe(false);
  });

  it('marks a modified table that drops a column as destructive', () => {
    const o = toObjectChange(destructiveAlter)!;
    expect(o.risk).toBe('high');
    expect(o.destructive).toBe(true);
  });

  it('qualifies the key with the schema so it matches SyncStatement.targetObject', () => {
    expect(toObjectChange(modifiedTable)!.key).toBe('public.patients');
    expect(toObjectChange(addedTable)!.key).toBe('users');
  });

  it('defaults a missing objectType to table', () => {
    const { objectType, ...withoutType } = addedTable;
    expect(objectType).toBe('table');
    expect(toObjectChange(withoutType as TableDiff)!.objectType).toBe('table');
  });

  it('never reports zero changes for a changed object', () => {
    const emptyModified: TableDiff = { name: 't', status: 'modified', columns: [] };
    expect(toObjectChange(emptyModified)!.changeCount).toBe(1);
  });
});

describe('buildObjectChanges', () => {
  it('returns one entry per changed object, tables before views', () => {
    const objects = buildObjectChanges(diff);
    expect(objects.map((o) => o.key)).toEqual([
      'anamneses',
      'legacy_notes',
      'public.patients',
      'users',
      'patient_summary',
    ]);
  });

  it('returns an empty list when nothing changed', () => {
    const identical: SchemaDiffResult = {
      sourceEngine: 'mysql',
      targetEngine: 'mysql',
      summary: { added: 0, removed: 0, modified: 0, unchanged: 1 },
      tables: [unchangedTable],
    };
    expect(buildObjectChanges(identical)).toEqual([]);
  });
});

// --- side-by-side rows -----------------------------------------------------

describe('buildObjectRows', () => {
  const rows = buildObjectRows(diff);

  it('lists every object including the identical ones, tables before views', () => {
    expect(rows.map((r) => r.key)).toEqual([
      'anamneses',
      'legacy_notes',
      'public.patients',
      'settings',
      'users',
      'patient_summary',
    ]);
  });

  it('marks which side each object exists on', () => {
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey['users']).toMatchObject({ inSource: true, inTarget: false });
    expect(byKey['anamneses']).toMatchObject({ inSource: false, inTarget: true });
    expect(byKey['public.patients']).toMatchObject({ inSource: true, inTarget: true });
    expect(byKey['settings']).toMatchObject({ inSource: true, inTarget: true });
  });

  it('carries both row counts and their delta', () => {
    const patients = rows.find((r) => r.key === 'public.patients')!;
    expect(patients.rowCountSource).toBe(820);
    expect(patients.rowCountTarget).toBe(810);
    expect(patients.rowDelta).toBe(-10);
  });

  it('leaves the delta null when a count is missing on either side', () => {
    expect(rows.find((r) => r.key === 'users')!.rowDelta).toBeNull();
    expect(rows.find((r) => r.key === 'anamneses')!.rowDelta).toBeNull();
    expect(rows.find((r) => r.key === 'legacy_notes')!.rowDelta).toBeNull();
  });

  it('attaches the expandable detail only to objects that changed', () => {
    const settings = rows.find((r) => r.key === 'settings')!;
    expect(settings.change).toBeNull();
    expect(settings.changeCount).toBe(0);
    expect(settings.risk).toBe('low');
    expect(settings.destructive).toBe(false);

    const anamneses = rows.find((r) => r.key === 'anamneses')!;
    expect(anamneses.change).not.toBeNull();
    expect(anamneses.change!.columns).toHaveLength(2);
    expect(anamneses.destructive).toBe(true);
  });

  it('returns an empty list for an empty diff', () => {
    expect(
      buildObjectRows({
        sourceEngine: 'mysql',
        targetEngine: 'mysql',
        summary: { added: 0, removed: 0, modified: 0, unchanged: 0 },
        tables: [],
      })
    ).toEqual([]);
  });
});

describe('filterRows', () => {
  const rows = buildObjectRows(diff);

  it('can isolate identical objects', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, status: 'unchanged' }).map((r) => r.key)).toEqual([
      'settings',
    ]);
  });

  it('applies the same status/type/risk filters as the change list', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, status: 'removed' }).map((r) => r.key)).toEqual([
      'anamneses',
    ]);
    expect(filterRows(rows, { ...EMPTY_FILTER, objectType: 'view' }).map((r) => r.key)).toEqual([
      'patient_summary',
    ]);
    expect(filterRows(rows, { ...EMPTY_FILTER, risk: 'high' }).map((r) => r.key)).toEqual([
      'anamneses',
      'legacy_notes',
    ]);
  });

  it('searches object names, and column names where detail exists', () => {
    expect(filterRows(rows, { ...EMPTY_FILTER, query: 'sett' }).map((r) => r.key)).toEqual([
      'settings',
    ]);
    expect(filterRows(rows, { ...EMPTY_FILTER, query: 'phone_verified' }).map((r) => r.key)).toEqual([
      'public.patients',
    ]);
  });
});

describe('totalRows', () => {
  it('sums each side, counting only the objects that exist there', () => {
    const t = totalRows(buildObjectRows(diff));
    // source: users 1204 + patients 820 + settings 10
    expect(t.sourceRows).toBe(2034);
    // target: anamneses 500 + patients 810 + settings 10
    expect(t.targetRows).toBe(1320);
    expect(t.objects).toBe(6);
  });

  it('flags the totals as partial when a count is missing', () => {
    expect(totalRows(buildObjectRows(diff)).partial).toBe(true);
    const complete = buildObjectRows(diff).filter((r) => r.key === 'settings');
    expect(totalRows(complete).partial).toBe(false);
  });

  it('returns zeroes for an empty list', () => {
    expect(totalRows([])).toEqual({ objects: 0, sourceRows: 0, targetRows: 0, partial: false });
  });
});

// --- summary ---------------------------------------------------------------

describe('summarizeObjects', () => {
  it('counts objects by status, rolls up changes and risk', () => {
    const s = summarizeObjects(buildObjectChanges(diff));
    expect(s.affectedObjects).toBe(5);
    expect(s.created).toBe(2); // users + patient_summary
    expect(s.removed).toBe(1); // anamneses
    expect(s.modified).toBe(2); // patients + legacy_notes
    expect(s.totalChanges).toBe(2 + 2 + 2 + 1 + 1);
    expect(s.destructiveObjects).toBe(2); // anamneses + legacy_notes
    expect(s.risk).toEqual({ low: 2, medium: 1, high: 2 });
  });

  it('summarizes a subset when given one (used for the selection footer)', () => {
    const objects = buildObjectChanges(diff);
    const s = summarizeObjects(objects.filter((o) => !o.destructive));
    expect(s.affectedObjects).toBe(3);
    expect(s.destructiveObjects).toBe(0);
  });
});

// --- filtering & search ----------------------------------------------------

describe('filterObjects', () => {
  const objects = buildObjectChanges(diff);

  it('returns everything with the empty filter', () => {
    expect(filterObjects(objects, EMPTY_FILTER)).toHaveLength(5);
  });

  it('filters by change status', () => {
    expect(filterObjects(objects, { ...EMPTY_FILTER, status: 'removed' }).map((o) => o.key)).toEqual([
      'anamneses',
    ]);
  });

  it('filters by object type', () => {
    expect(filterObjects(objects, { ...EMPTY_FILTER, objectType: 'view' }).map((o) => o.key)).toEqual([
      'patient_summary',
    ]);
  });

  it('filters by risk', () => {
    expect(filterObjects(objects, { ...EMPTY_FILTER, risk: 'high' }).map((o) => o.key)).toEqual([
      'anamneses',
      'legacy_notes',
    ]);
  });

  it('combines filters', () => {
    const res = filterObjects(objects, { ...EMPTY_FILTER, status: 'added', objectType: 'table' });
    expect(res.map((o) => o.key)).toEqual(['users']);
  });

  it('searches object names and column names, case-insensitively', () => {
    expect(filterObjects(objects, { ...EMPTY_FILTER, query: 'PATIENT' }).map((o) => o.key)).toEqual([
      'public.patients',
      'patient_summary',
    ]);
    // `phone_verified_at` only exists as a column of patients.
    expect(filterObjects(objects, { ...EMPTY_FILTER, query: 'phone_verified' }).map((o) => o.key)).toEqual([
      'public.patients',
    ]);
  });

  it('matchesQuery is a no-op for blank queries', () => {
    expect(matchesQuery(objects[0], '   ')).toBe(true);
  });
});

describe('presentObjectTypes', () => {
  it('only reports types actually present in the diff', () => {
    expect(presentObjectTypes(buildObjectChanges(diff))).toEqual(['table', 'view']);
    expect(presentObjectTypes([toObjectChange(addedTable)!])).toEqual(['table']);
    expect(presentObjectTypes([])).toEqual([]);
  });
});

// --- selection -------------------------------------------------------------

describe('safeObjectKeys', () => {
  it('excludes every object whose changes drop something', () => {
    expect(safeObjectKeys(buildObjectChanges(diff))).toEqual([
      'public.patients',
      'users',
      'patient_summary',
    ]);
  });
});

// --- sync script -----------------------------------------------------------

const statements: SyncStatement[] = [
  { operation: 'createtable', description: 'Create table `users`', sql: 'CREATE TABLE `users` (\n  `id` int\n);', targetObject: 'users' },
  { operation: 'addcolumn', description: 'Add column `phone_verified_at` to `public.patients`', sql: 'ALTER TABLE `public`.`patients` ADD COLUMN `phone_verified_at` datetime;', targetObject: 'public.patients' },
  { operation: 'altercolumn', description: 'Alter column `status` on `public.patients`', sql: 'ALTER TABLE `public`.`patients` MODIFY COLUMN `status` varchar(20);', targetObject: 'public.patients' },
  { operation: 'dropcolumn', description: 'Drop column `legacy_status` from `legacy_notes`', sql: 'ALTER TABLE `legacy_notes` DROP COLUMN `legacy_status`;', targetObject: 'legacy_notes' },
  { operation: 'droptable', description: 'Drop table `anamneses`', sql: 'DROP TABLE IF EXISTS `anamneses`;', targetObject: 'anamneses' },
];

describe('statementKind / isDestructiveStatement', () => {
  it('buckets statements into create / alter / drop', () => {
    expect(statementKind('createtable')).toBe('create');
    expect(statementKind('addcolumn')).toBe('alter');
    expect(statementKind('altercolumn')).toBe('alter');
    expect(statementKind('dropcolumn')).toBe('drop');
    expect(statementKind('droptable')).toBe('drop');
    expect(statementKind('raw')).toBe('alter');
  });

  it('flags exactly the statements that remove something', () => {
    expect(statements.filter(isDestructiveStatement).map((s) => s.operation)).toEqual([
      'dropcolumn',
      'droptable',
    ]);
  });
});

describe('summarizeStatements', () => {
  it('counts by kind and distinct target objects', () => {
    expect(summarizeStatements(statements)).toEqual({
      total: 5,
      create: 1,
      alter: 2,
      drop: 2,
      destructive: 2,
      objects: 4,
    });
  });

  it('reports zeroes for an empty script', () => {
    expect(summarizeStatements([])).toEqual({
      total: 0,
      create: 0,
      alter: 0,
      drop: 0,
      destructive: 0,
      objects: 0,
    });
  });
});

describe('filterStatements', () => {
  it('returns the full script unchanged when nothing is excluded', () => {
    const res = filterStatements(statements, { selectedKeys: null, excludeDestructive: false });
    expect(res).toEqual(statements);
  });

  it('keeps only statements belonging to the selected objects', () => {
    const res = filterStatements(statements, {
      selectedKeys: new Set(['users', 'public.patients']),
      excludeDestructive: false,
    });
    expect(res.map((s) => s.targetObject)).toEqual(['users', 'public.patients', 'public.patients']);
  });

  it('drops destructive statements when asked', () => {
    const res = filterStatements(statements, { selectedKeys: null, excludeDestructive: true });
    expect(res.some(isDestructiveStatement)).toBe(false);
    expect(res).toHaveLength(3);
  });

  it('applies both filters together', () => {
    const res = filterStatements(statements, {
      selectedKeys: new Set(['legacy_notes', 'users']),
      excludeDestructive: true,
    });
    expect(res.map((s) => s.targetObject)).toEqual(['users']);
  });

  it('never rewrites statement SQL', () => {
    const res = filterStatements(statements, {
      selectedKeys: new Set(['anamneses']),
      excludeDestructive: false,
    });
    expect(res[0].sql).toBe('DROP TABLE IF EXISTS `anamneses`;');
  });

  it('yields an empty script when the selection is empty', () => {
    expect(
      filterStatements(statements, { selectedKeys: new Set(), excludeDestructive: false })
    ).toEqual([]);
  });
});

describe('scriptText', () => {
  it('joins the generated SQL verbatim', () => {
    expect(scriptText(statements.slice(0, 2))).toBe(
      'CREATE TABLE `users` (\n  `id` int\n);\n\nALTER TABLE `public`.`patients` ADD COLUMN `phone_verified_at` datetime;'
    );
  });
});

// --- object keys line up with the generated script -------------------------

describe('object keys ↔ statement targets', () => {
  it('every statement target maps to an object in the diff', () => {
    const keys = new Set(buildObjectChanges(diff).map((o) => o.key));
    for (const s of statements) {
      expect(keys.has(s.targetObject)).toBe(true);
    }
  });
});
