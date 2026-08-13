/**
 * BSON-aware rendering for MongoDB documents.
 *
 * The backend hands documents to the frontend as MongoDB Extended JSON v2
 * (relaxed mode) — see `core/mongo/types.ts`'s module doc. A field like
 * `{"$oid": "507f..."}` is really an `ObjectId`, not a plain object; treating
 * it as generic JSON (as a naive JSON viewer would) loses that distinction
 * and reads as noise. This module recognizes the Extended JSON "envelope"
 * shapes and describes them with their real BSON type, so the document
 * table/tree/editor can render `ObjectId("507f...")` instead of
 * `{ "$oid": "507f..." }`.
 *
 * Both canonical and relaxed Extended JSON envelopes are recognized (a user
 * hand-editing a document, or an aggregation `$match` filter, may type
 * either) — only the *shape* is inspected, not which mode produced it.
 */

export type BsonKind =
  | 'objectId'
  | 'date'
  | 'decimal128'
  | 'long'
  | 'int'
  | 'double'
  | 'binary'
  | 'regex'
  | 'timestamp'
  | 'minKey'
  | 'maxKey'
  | 'javascript'
  | 'undefined'
  | 'symbol'
  | 'dbPointer'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object';

interface BsonDescriptor {
  kind: BsonKind;
  /** Short, copy-pasteable label, e.g. `ObjectId("507f...")`, `NumberLong("9223...")`. */
  label: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `obj` has exactly the given single key — the shape every
 *  Extended JSON envelope uses (`{"$oid": ...}`, `{"$numberLong": ...}`, …). */
function isEnvelope(obj: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === key;
}

/** Inspects a value and, if it's an Extended JSON envelope for a BSON type
 *  with no native JSON representation, returns its kind + display label.
 *  Returns `null` for plain JSON (string/number/boolean/null/array/plain
 *  object) — the caller renders those normally. */
export function describeBson(value: unknown): BsonDescriptor | null {
  if (!isPlainObject(value)) return null;

  if (isEnvelope(value, '$oid') && typeof value.$oid === 'string') {
    return { kind: 'objectId', label: `ObjectId("${value.$oid}")` };
  }
  if (isEnvelope(value, '$date')) {
    const inner = value.$date as unknown;
    const iso =
      typeof inner === 'string'
        ? inner
        : isPlainObject(inner) && typeof (inner as any).$numberLong === 'string'
          ? new Date(Number((inner as any).$numberLong)).toISOString()
          : null;
    return { kind: 'date', label: iso ? `ISODate("${iso}")` : 'ISODate(?)' };
  }
  if (isEnvelope(value, '$numberDecimal') && typeof value.$numberDecimal === 'string') {
    return { kind: 'decimal128', label: `NumberDecimal("${value.$numberDecimal}")` };
  }
  if (isEnvelope(value, '$numberLong') && typeof value.$numberLong === 'string') {
    return { kind: 'long', label: `NumberLong("${value.$numberLong}")` };
  }
  if (isEnvelope(value, '$numberInt') && typeof value.$numberInt === 'string') {
    return { kind: 'int', label: `NumberInt(${value.$numberInt})` };
  }
  if (isEnvelope(value, '$numberDouble') && typeof value.$numberDouble === 'string') {
    return { kind: 'double', label: value.$numberDouble };
  }
  if (isEnvelope(value, '$binary')) {
    const bin = value.$binary as any;
    const base64 = typeof bin?.base64 === 'string' ? bin.base64 : '';
    const preview = base64.length > 24 ? `${base64.slice(0, 24)}…` : base64;
    return { kind: 'binary', label: `BinData(${bin?.subType ?? '0'}, "${preview}")` };
  }
  if (isEnvelope(value, '$regularExpression')) {
    const re = value.$regularExpression as any;
    return { kind: 'regex', label: `/${re?.pattern ?? ''}/${re?.options ?? ''}` };
  }
  if (isEnvelope(value, '$timestamp')) {
    const ts = value.$timestamp as any;
    return { kind: 'timestamp', label: `Timestamp(${ts?.t ?? 0}, ${ts?.i ?? 0})` };
  }
  if (isEnvelope(value, '$minKey')) {
    return { kind: 'minKey', label: 'MinKey' };
  }
  if (isEnvelope(value, '$maxKey')) {
    return { kind: 'maxKey', label: 'MaxKey' };
  }
  if (isEnvelope(value, '$undefined')) {
    return { kind: 'undefined', label: 'undefined' };
  }
  if (isEnvelope(value, '$symbol') && typeof value.$symbol === 'string') {
    return { kind: 'symbol', label: `Symbol("${value.$symbol}")` };
  }
  if (isEnvelope(value, '$dbPointer')) {
    return { kind: 'dbPointer', label: 'DBPointer(...)' };
  }
  if ('$code' in value && typeof value.$code === 'string' && Object.keys(value).length <= 2) {
    return { kind: 'javascript', label: 'Code(...)' };
  }
  return null;
}

/** The BSON (or plain-JSON) kind of any document value, for badge coloring
 *  and grouping in Structure/schema-inference display — mirrors the type
 *  names `commands::mongo::bson_type_name` uses on the backend. */
export function bsonKindOf(value: unknown): BsonKind {
  const envelope = describeBson(value);
  if (envelope) return envelope.kind;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isPlainObject(value)) return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'null';
}

/** A short, single-line display string for any document value — BSON
 *  envelopes render as `Type("...")`, plain scalars render as their normal
 *  JSON text, and objects/arrays render as a compact `{…}`/`[…]` summary
 *  (never their full nested contents — use the tree view for that). */
export function formatBsonValue(value: unknown): string {
  const envelope = describeBson(value);
  if (envelope) return envelope.label;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return `{${keys.length} field${keys.length === 1 ? '' : 's'}}`;
  }
  return String(value);
}

/** Tailwind color classes per BSON kind — used for the small type badge next
 *  to a value in the tree view and Structure tab, mirroring the app's
 *  per-value-type color convention (e.g. `RedisBrowser`'s `TYPE_COLOR`). */
export const BSON_KIND_COLOR: Record<BsonKind, string> = {
  objectId: 'text-amber-400',
  date: 'text-purple-400',
  decimal128: 'text-cyan-400',
  long: 'text-cyan-400',
  int: 'text-cyan-400',
  double: 'text-cyan-400',
  binary: 'text-pink-400',
  regex: 'text-rose-400',
  timestamp: 'text-purple-400',
  minKey: 'text-slate-500',
  maxKey: 'text-slate-500',
  javascript: 'text-orange-400',
  undefined: 'text-slate-500',
  symbol: 'text-emerald-400',
  dbPointer: 'text-slate-500',
  string: 'text-emerald-400',
  number: 'text-cyan-400',
  boolean: 'text-orange-400',
  null: 'text-slate-500',
  array: 'text-blue-400',
  object: 'text-blue-400',
};

/** Best-effort extraction of a document's `_id` as a filter object suitable
 *  for `mongo_update_document`/`mongo_delete_document`/`mongo_get_document` —
 *  the `_id` value (whatever its BSON type) round-trips through
 *  `json_to_document` on the backend unchanged. */
export function idFilter(doc: Record<string, unknown>): Record<string, unknown> {
  return { _id: doc._id };
}
