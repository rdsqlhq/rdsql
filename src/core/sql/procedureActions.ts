/**
 * Engine-aware Stored Routine SQL generators — PROCEDUREs and FUNCTIONs share
 * one form (HeidiSQL does the same). Mirrors `triggerActions.ts` — pure
 * functions, no SQL executed here. Not supported on SQLite (no routines).
 */
import { quoteIdent } from './ident';
import { isPostgresFamily } from '../connection/engines';
import { ProcedureParam } from './procedureIntrospection';

export interface ProcedureDef {
  name: string;
  schema?: string;
  params: ProcedureParam[];
  body: string;
  /** PROCEDURE (no result) or FUNCTION (returns a value). Defaults to
   *  PROCEDURE when omitted, so older callers still generate what they used to. */
  routineType?: 'PROCEDURE' | 'FUNCTION';
  /** FUNCTION only — the `RETURNS` type. */
  returnType?: string;
  /** MySQL only — raw `DEFINER = <value>` clause content, e.g. `` 'root'@'%' ``.
   *  Blank/omitted = no DEFINER clause (server default: current user). */
  definer?: string;
  /** Both engines. MySQL emits it inline (`COMMENT '...'`); Postgres has no
   *  inline form, so `commentOnRoutineSql` builds a separate `COMMENT ON`. */
  comment?: string;
  /** MySQL: `SQL SECURITY {DEFINER|INVOKER}`. Postgres: `SECURITY {DEFINER|INVOKER}`. */
  sqlSecurity?: 'DEFINER' | 'INVOKER';
  /** MySQL only — `[NOT] DETERMINISTIC`. */
  deterministic?: boolean;
  /** MySQL only — `CONTAINS SQL` / `NO SQL` / `READS SQL DATA` / `MODIFIES SQL DATA`. */
  dataAccess?: string;
}

function qualifiedName(engine: string, name: string, schema?: string): string {
  const ident = quoteIdent(engine, name);
  return schema ? `${quoteIdent(engine, schema)}.${ident}` : ident;
}

function pgParamList(engine: string, params: ProcedureParam[], isFunction: boolean): string {
  return params
    .map((p) => {
      // Postgres CREATE PROCEDURE only accepts IN/INOUT — OUT isn't valid
      // there (use INOUT to return a value). FUNCTION accepts OUT natively,
      // so only downgrade for the PROCEDURE case.
      const mode = !isFunction && p.mode === 'OUT' ? 'INOUT' : p.mode;
      return `${mode} ${quoteIdent(engine, p.name)} ${p.type}`;
    })
    .join(', ');
}

/** MySQL `func_parameter` has no mode keyword at all (every FUNCTION param is
 *  implicitly IN) — PROCEDURE params keep IN/OUT/INOUT. */
function mysqlParamList(engine: string, params: ProcedureParam[], isFunction: boolean): string {
  return params
    .map((p) => `${isFunction ? '' : `${p.mode} `}${quoteIdent(engine, p.name)} ${p.type}`)
    .join(', ');
}

/** MySQL `characteristic` clauses — any order, each optional. */
function mysqlCharacteristics(def: ProcedureDef): string {
  const lines: string[] = [];
  if (def.comment?.trim()) lines.push(`    COMMENT '${def.comment.trim().replace(/'/g, "''")}'`);
  if (def.deterministic) lines.push('    DETERMINISTIC');
  if (def.dataAccess) lines.push(`    ${def.dataAccess}`);
  if (def.sqlSecurity) lines.push(`    SQL SECURITY ${def.sqlSecurity}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/** `CREATE PROCEDURE` / `CREATE FUNCTION`, per `def.routineType`. */
export function createProcedureSql(engine: string, def: ProcedureDef): string {
  const isFunction = def.routineType === 'FUNCTION';
  const name = qualifiedName(engine, def.name, def.schema);
  const body = def.body.trim() || 'BEGIN\nEND';

  if (isPostgresFamily(engine)) {
    const params = pgParamList(engine, def.params, isFunction);
    const returns = isFunction ? `\nRETURNS ${def.returnType?.trim() || 'void'}` : '';
    const security = def.sqlSecurity ? `\nSECURITY ${def.sqlSecurity}` : '';
    return `CREATE ${isFunction ? 'FUNCTION' : 'PROCEDURE'} ${name}(${params})${returns}
LANGUAGE plpgsql${security}
AS $$
${body}
$$;`;
  }

  // MySQL/MariaDB
  const params = mysqlParamList(engine, def.params, isFunction);
  const definer = def.definer?.trim() ? `DEFINER = ${def.definer.trim()} ` : '';
  const returns = isFunction ? `\nRETURNS ${def.returnType?.trim() || 'INT'}` : '';
  const characteristics = mysqlCharacteristics(def);
  return `CREATE ${definer}${isFunction ? 'FUNCTION' : 'PROCEDURE'} ${name}(${params})${returns}${characteristics}
${body};`;
}

/** Edit-in-place: Postgres supports `CREATE OR REPLACE {PROCEDURE|FUNCTION}`
 *  directly. MySQL has no replace form — returns `null`, caller should DROP + CREATE. */
export function replaceProcedureSql(engine: string, def: ProcedureDef): string | null {
  if (!isPostgresFamily(engine)) return null;
  const isFunction = def.routineType === 'FUNCTION';
  const name = qualifiedName(engine, def.name, def.schema);
  const params = pgParamList(engine, def.params, isFunction);
  const returns = isFunction ? `\nRETURNS ${def.returnType?.trim() || 'void'}` : '';
  const security = def.sqlSecurity ? `\nSECURITY ${def.sqlSecurity}` : '';
  const body = def.body.trim() || 'BEGIN\nEND';
  return `CREATE OR REPLACE ${isFunction ? 'FUNCTION' : 'PROCEDURE'} ${name}(${params})${returns}
LANGUAGE plpgsql${security}
AS $$
${body}
$$;`;
}

/** Postgres has no inline COMMENT clause on CREATE — a separate `COMMENT ON`
 *  statement is the only way to set it. Only IN/INOUT/VARIADIC parameter types
 *  belong in the signature (pure OUT params don't participate in overload
 *  resolution, per the Postgres docs), so pure-OUT params are filtered out. */
export function commentOnRoutineSql(engine: string, def: ProcedureDef): string {
  const isFunction = def.routineType === 'FUNCTION';
  const name = qualifiedName(engine, def.name, def.schema);
  const sigTypes = def.params.filter((p) => p.mode !== 'OUT').map((p) => p.type).join(', ');
  const comment = (def.comment || '').trim().replace(/'/g, "''");
  return `COMMENT ON ${isFunction ? 'FUNCTION' : 'PROCEDURE'} ${name}(${sigTypes}) IS '${comment}';`;
}

/** `DROP PROCEDURE` / `DROP FUNCTION`. `paramTypes`, when known (e.g. from a
 *  just-fetched definition), disambiguates overloaded routines on Postgres —
 *  omit it for the common non-overloaded case, where a bare name is enough.
 *  `routineType` picks the right DROP keyword — dropping a FUNCTION with
 *  `DROP PROCEDURE IF EXISTS` silently no-ops instead of actually dropping it. */
export function dropProcedureSql(
  engine: string,
  name: string,
  schema?: string,
  paramTypes?: string[],
  routineType?: string
): string {
  const ref = qualifiedName(engine, name, schema);
  const keyword = routineType === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
  if (isPostgresFamily(engine) && paramTypes && paramTypes.length > 0) {
    return `DROP ${keyword} IF EXISTS ${ref}(${paramTypes.join(', ')});`;
  }
  return `DROP ${keyword} IF EXISTS ${ref};`;
}
