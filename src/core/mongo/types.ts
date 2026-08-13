/**
 * MongoDB domain types — mirror the DTOs returned by `commands::mongo` in
 * `src-tauri/src/commands/mongo.rs` field-for-field.
 *
 * Deliberately separate from `QueryResultData`: documents are schemaless
 * JSON, not rows/columns. The connection itself, though, is a normal
 * `DatabaseConnection` (engine `'mongodb'`) — see `core/domain/types.ts` —
 * not a parallel config type like `S3ConnectionConfig`. Unlike Redis, Mongo
 * *does* have a real schema tree (`SchemaGroupNode`/`SchemaTableNode` with
 * `node_type: 'schema'`/`'collection'`) — only the leaf document data is
 * non-tabular.
 *
 * Documents are plain JSON using MongoDB's own Extended JSON v2 (relaxed
 * mode) convention for BSON types with no native JSON representation —
 * `{"$oid": "<hex>"}`, `{"$date": "<iso-string>"}`, etc. The backend
 * (`commands::mongo`'s `document_to_json`/`json_to_document`) round-trips
 * this losslessly; the frontend never needs its own BSON type mapping.
 */

/** A single document, as sent to/from the backend. Arbitrary/schemaless JSON
 *  (using the Extended JSON convention above for BSON-only types). */
export type MongoDocument = Record<string, unknown>;

export interface MongoDatabaseInfo {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
}

export interface MongoCollectionInfo {
  name: string;
  /** An estimate (collection metadata, not a full scan). Always 0 for a view. */
  docCount: number;
  /** True for a MongoDB view (a saved aggregation pipeline, read-only) —
   *  grouped separately from regular collections in the Explorer. */
  isView: boolean;
}

/** A page of documents from `mongo_find_documents`/`mongo_run_aggregation`.
 *  `hasMore` means more documents exist past this page — fetch again with a
 *  larger `skip` (find) or treat as informational (aggregation, which has no
 *  skip/page cursor of its own — see the backend doc comment). */
export interface MongoDocumentPage {
  documents: MongoDocument[];
  hasMore: boolean;
}

// ─── Indexes ────────────────────────────────────────────────────────────────

export interface MongoIndexInfo {
  name: string;
  /** Index key spec, e.g. `{"email": 1}` or `{"createdAt": -1, "status": 1}`. */
  keys: Record<string, number>;
  unique: boolean;
  sparse: boolean;
}

// ─── Schema inference ───────────────────────────────────────────────────────

export interface MongoFieldTypeCount {
  /** MongoDB's own `$type` spelling, e.g. `"objectId"`, `"string"`, `"int"` —
   *  not a JS `typeof`. */
  bsonType: string;
  count: number;
  percentage: number;
}

export interface MongoFieldStat {
  name: string;
  /** Sorted by `count` descending — the first entry is the field's dominant type. */
  types: MongoFieldTypeCount[];
}

/** Result of `mongo_infer_schema` — a lightweight, sampled "schema" for a
 *  schemaless collection. `sampled` is how many documents the percentages
 *  are relative to, NOT the collection's total document count. */
export interface MongoSchemaInference {
  sampled: number;
  fields: MongoFieldStat[];
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface MongoCollectionStats {
  count: number;
  size: number;
  avgObjSize: number;
  storageSize: number;
  totalIndexSize: number;
  indexCount: number;
}

export interface MongoDatabaseStats {
  collections: number;
  views: number;
  objects: number;
  dataSize: number;
  storageSize: number;
  indexes: number;
  indexSize: number;
}
