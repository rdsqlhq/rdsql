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
      // MySQL/MariaDB ENUM is real inline column syntax. Kept bare (no
      // placeholder values baked into the label) — picking "enum" from the
      // dropdown just sets the base type, and CreateTableModal/
      // TableStructureModal both detect that (see `isEnumType`) and swap in
      // a dedicated `EnumValuesInput` for typing the actual allowed values,
      // instead of expecting the user to hand-write `('a','b')` SQL syntax
      // into a generic "length" field.
      { label: 'enum', engines: ['mysql', 'mariadb'] },
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

// ─── Enum value helpers ─────────────────────────────────────────────────────
//
// A MySQL/MariaDB `enum('a','b')` column's allowed values are the one part
// of a type string that's inherently user data, not a fixed vocabulary like
// every other type's parameters — so unlike `varchar(255)`'s length or
// `numeric(10,2)`'s precision/scale, we don't want the user hand-writing SQL
// string-literal syntax (quoting, doubled-quote escaping) into a plain text
// field. These helpers back a dedicated `EnumValuesInput` control (see
// `components/table/EnumValuesInput.tsx`) that lets them type a plain
// comma-separated list instead.

/** Does this type string look like an inline enum column (`enum`, or
 *  `enum('a','b')`)? Matches the bare keyword too, since that's what a user
 *  gets immediately after picking "enum" from the type dropdown, before
 *  they've typed any values yet. */
export function isEnumType(type: string): boolean {
  return /^enum\b/i.test(type.trim());
}

/** Parse the quoted-list content between an enum type's parens (e.g.
 *  `'a','b'`) into plain, unescaped values. Matches only well-formed
 *  single-quoted segments — this is a read-back of what `buildEnumInner`
 *  itself produces (or what MySQL's own introspection reports), not a
 *  general SQL parser. */
export function parseEnumInner(inner: string): string[] {
  const values: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) {
    values.push(m[1].replace(/''/g, "'"));
  }
  return values;
}

/** Build the quoted-list content for an enum type's parens from plain
 *  values — trims and drops empties (so an in-progress "a, " doesn't emit a
 *  dangling empty member), and doubles any embedded single quote the way
 *  SQL string literals require. */
export function buildEnumInner(values: string[]): string {
  return values
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => `'${v.replace(/'/g, "''")}'`)
    .join(',');
}
