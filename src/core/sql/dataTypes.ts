/**
 * Shared, engine-aware SQL data type options for the Create Table and Table
 * Structure modals. Types are grouped by category for easy browsing, and each
 * entry lists which engines support it so the dropdown can filter out types
 * that would be rejected by the target database.
 */

import { engineFamily } from '../connection/engines';

export interface DataTypeOption {
  label: string;
  /** Engines where this type is valid. Empty = all engines. */
  engines?: string[];
}

export interface DataTypeGroup {
  label: string;
  types: DataTypeOption[];
}

/** Full type list grouped by category. The dropdown renders optgroups from this. */
export const DATA_TYPE_GROUPS: DataTypeGroup[] = [
  {
    label: 'Numeric',
    types: [
      { label: 'bigint' },
      { label: 'integer' },
      { label: 'smallint' },
      { label: 'serial', engines: ['postgres', 'postgresql'] },
      { label: 'bigserial', engines: ['postgres', 'postgresql'] },
      { label: 'numeric(10,2)' },
      { label: 'decimal(10,2)' },
      { label: 'double precision', engines: ['postgres', 'postgresql'] },
      { label: 'double', engines: ['mysql', 'mariadb'] },
      { label: 'float' },
      { label: 'real', engines: ['postgres', 'postgresql', 'sqlite', 'mssql'] },
      { label: 'money', engines: ['postgres', 'postgresql', 'mssql'] },
      { label: 'smallmoney', engines: ['mssql'] },
      { label: 'tinyint', engines: ['mysql', 'mariadb', 'sqlite', 'mssql'] },
      { label: 'mediumint', engines: ['mysql', 'mariadb'] },
      { label: 'int unsigned', engines: ['mysql', 'mariadb'] },
    ],
  },
  {
    label: 'Text / String',
    types: [
      { label: 'varchar(255)' },
      { label: 'varchar(1000)' },
      { label: 'char(1)' },
      { label: 'text' },
      { label: 'tinytext', engines: ['mysql', 'mariadb'] },
      { label: 'mediumtext', engines: ['mysql', 'mariadb'] },
      { label: 'longtext', engines: ['mysql', 'mariadb'] },
      { label: 'citext', engines: ['postgres', 'postgresql'] },
      { label: 'nvarchar(255)', engines: ['mssql'] },
      { label: 'nvarchar(max)', engines: ['mssql'] },
      { label: 'varchar(max)', engines: ['mssql'] },
      { label: 'nchar(1)', engines: ['mssql'] },
      { label: 'ntext', engines: ['mssql'] },
    ],
  },
  {
    label: 'Binary / Blob',
    types: [
      { label: 'blob', engines: ['mysql', 'mariadb', 'sqlite'] },
      { label: 'tinyblob', engines: ['mysql', 'mariadb'] },
      { label: 'mediumblob', engines: ['mysql', 'mariadb'] },
      { label: 'longblob', engines: ['mysql', 'mariadb'] },
      { label: 'bytea', engines: ['postgres', 'postgresql'] },
      { label: 'binary(255)', engines: ['mysql', 'mariadb', 'mssql'] },
      { label: 'varbinary(255)', engines: ['mysql', 'mariadb', 'mssql'] },
      { label: 'varbinary(max)', engines: ['mssql'] },
      { label: 'image', engines: ['mssql'] },
    ],
  },
  {
    label: 'Date / Time',
    types: [
      { label: 'date' },
      { label: 'time' },
      { label: 'timestamp' },
      { label: 'timestamptz', engines: ['postgres', 'postgresql'] },
      { label: 'datetime', engines: ['mysql', 'mariadb', 'sqlite', 'mssql'] },
      { label: 'datetime2', engines: ['mssql'] },
      { label: 'smalldatetime', engines: ['mssql'] },
      { label: 'datetimeoffset', engines: ['mssql'] },
      { label: 'interval', engines: ['postgres', 'postgresql'] },
      { label: 'year', engines: ['mysql', 'mariadb'] },
    ],
  },
  {
    label: 'Boolean',
    types: [
      { label: 'boolean' },
      { label: 'bool', engines: ['postgres', 'postgresql', 'mysql', 'mariadb'] },
      { label: 'bit', engines: ['mssql'] },
    ],
  },
  {
    label: 'UUID / Unique ID',
    types: [
      { label: 'uuid', engines: ['postgres', 'postgresql', 'sqlite', 'cloudflare-d1'] },
      { label: 'autoincrement', engines: ['mysql', 'mariadb', 'sqlite'] },
      { label: 'uniqueidentifier', engines: ['mssql'] },
    ],
  },
  {
    label: 'JSON / Structured',
    types: [
      { label: 'json', engines: ['postgres', 'postgresql', 'mysql', 'mariadb', 'sqlite', 'cloudflare-d1'] },
      { label: 'jsonb', engines: ['postgres', 'postgresql'] },
      { label: 'xml', engines: ['postgres', 'postgresql', 'mysql', 'mariadb', 'mssql'] },
    ],
  },
  {
    label: 'Enum / Array',
    types: [
      // MySQL/MariaDB ENUM is real inline column syntax — the label is a
      // literal placeholder the user edits in place (same pattern as
      // `numeric(10,2)`/`varchar(255)`: TableStructureModal's `splitType`
      // regex captures everything between the first `(` and its matching
      // `)` as an editable "length" field, so `enum('a','b')` splits into
      // base `enum` + editable `'a','b'`, and rejoins correctly on save).
      { label: "enum('value1','value2')", engines: ['mysql', 'mariadb'] },
      // Postgres has no bare enum column type at all — `CREATE TYPE x AS
      // ENUM (...)` must run as a separate statement first, then the type
      // name becomes the column type. That two-step flow isn't wired up
      // here, so deliberately not offering a plain "enum" option for
      // Postgres/SQLite — it would look like a normal type picked from
      // this list but fail as invalid DDL the moment it's used, which is
      // worse than the option not existing at all.
      //
      // Postgres arrays ARE real, valid bare column syntax though (unlike
      // enum) — `int[]`/`text[]` need no separate statement, so they're
      // safe to offer directly.
      { label: 'integer[]', engines: ['postgres', 'postgresql'] },
      { label: 'text[]', engines: ['postgres', 'postgresql'] },
      { label: 'uuid[]', engines: ['postgres', 'postgresql'] },
    ],
  },
  {
    label: 'Network / Geo',
    types: [
      { label: 'inet', engines: ['postgres', 'postgresql'] },
      { label: 'cidr', engines: ['postgres', 'postgresql'] },
      { label: 'macaddr', engines: ['postgres', 'postgresql'] },
      { label: 'point', engines: ['postgres', 'postgresql', 'mysql', 'mariadb'] },
      { label: 'polygon', engines: ['postgres', 'postgresql', 'mysql', 'mariadb'] },
    ],
  },
];

/** Does a type's `engines` allow-list cover the given connection engine?
 *  Matched by wire-protocol FAMILY, not literal engine id — a type entry
 *  written as `engines: ['postgres', 'postgresql']` must also show up for
 *  `cockroachdb`/`yugabytedb` (Postgres-wire-compatible), and one written as
 *  `engines: ['mysql', 'mariadb']` must show up for `tidb`/`planetscale`
 *  (MySQL-wire-compatible) — those engine ids were never in the literal
 *  lists, so a straight string match silently hid engine-appropriate types
 *  (e.g. `jsonb`/`serial`/`uuid` for CockroachDB, `tinyint`/blob variants for
 *  TiDB) for every engine outside the big two. */
function typeAllowsEngine(t: DataTypeOption, engine: string): boolean {
  if (!t.engines || t.engines.length === 0) return true;
  const fam = engineFamily(engine);
  return t.engines.some((e) => engineFamily(e) === fam);
}

/**
 * Returns the flat list of type labels filtered to the given engine, for
 * components that want a simple array (e.g. backward-compat with the old
 * TYPE_OPTIONS constant).
 */
export function getTypeOptions(engine?: string): string[] {
  const eng = engine || '';
  return DATA_TYPE_GROUPS.flatMap((g) =>
    g.types.filter((t) => typeAllowsEngine(t, eng)).map((t) => t.label)
  );
}

/**
 * Returns the grouped type options filtered to the given engine, for
 * components that render optgroups.
 */
export function getGroupedTypeOptions(engine?: string): DataTypeGroup[] {
  const eng = engine || '';
  return DATA_TYPE_GROUPS.map((g) => ({
    label: g.label,
    types: g.types.filter((t) => typeAllowsEngine(t, eng)),
  })).filter((g) => g.types.length > 0);
}
