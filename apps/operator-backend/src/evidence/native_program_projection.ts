import type { EvidenceRefV1 } from "./evidence_ref.js";
import { selectFieldTextRange } from "./field_text_range.js";
import { selectNativeExecutionAudit } from './native_execution_audit.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

/** Historical native identity, not a prediction of collateral safety. Missing
 * types remain unknown even when the type-only baseline was exhaustive. */
function deletedTypeContext(ref: EvidenceRefV1, payload: unknown) {
  const audit = selectNativeExecutionAudit(ref, payload), tx = record(audit?.transaction), context = record(audit?.deleted_type_context);
  if (audit?.success !== true || audit.verified !== false || audit.read_only === true
      || tx?.status !== 'committed' || tx.committed !== true || !context
      || context.schema !== 'operator.deleted-type-context.v1' || context.purpose !== 'diagnostic_only'
      || context.deletion_safety_verified !== false
      || !['complete', 'count_limited', 'time_limited', 'read_errors'].includes(String(context.baseline_coverage))
      || !Array.isArray(tx.deleted_element_ids) || tx.deleted_element_ids.length < 1 || tx.deleted_element_ids.length > 4096
      || tx.deleted_element_ids.some(id => !Number.isSafeInteger(id) || id < 1)
      || new Set(tx.deleted_element_ids).size !== tx.deleted_element_ids.length
      || context.deleted_count !== tx.deleted_element_ids.length
      || !Array.isArray(context.rows) || context.rows.length > 16 || context.rows.length < 1
      || context.returned_count !== context.rows.length
      || !Number.isInteger(context.examined_types) || Number(context.examined_types) < 0 || Number(context.examined_types) > 4096
      || !Number.isInteger(context.captured_types) || Number(context.captured_types) < 0 || Number(context.captured_types) > Number(context.examined_types)
      || !Number.isInteger(context.read_errors) || Number(context.read_errors) < 0 || Number(context.read_errors) > 4097
      || !Number.isSafeInteger(context.elapsed_milliseconds) || Number(context.elapsed_milliseconds) < 0) return null;
  const seen = new Set<number>(), rows: Row[] = [];
  for (const value of context.rows) {
    const row = record(value), id = row?.element_id;
    if (!Number.isSafeInteger(id) || !tx.deleted_element_ids.includes(id) || seen.has(id as number)) return null;
    seen.add(id as number);
    if (row?.state === 'not_observed_as_type') rows.push({element_id:id,state:row.state});
    else if (row?.state === 'observed_type_before_execution'
        && ['unique_id', 'class_name', 'name', 'family_name'].every(key => typeof row[key] === 'string'
          && String(row[key]).length <= (['unique_id','class_name'].includes(key) ? 128 : 512))
        && row.unique_id && row.class_name) rows.push({element_id:id,state:row.state,
          unique_id:row.unique_id,class_name:row.class_name,name:row.name,family_name:row.family_name});
    else return null;
  }
  if (rows.filter(row => row.state === 'observed_type_before_execution').length > Number(context.captured_types)) return null;
  return {schema:context.schema,purpose:context.purpose,baseline_coverage:context.baseline_coverage,
    examined_types:context.examined_types,captured_types:context.captured_types,read_errors:context.read_errors,
    elapsed_milliseconds:context.elapsed_milliseconds,deleted_count:context.deleted_count,deletion_safety_verified:false,
    rows:rows.slice(0,4), returned_count:Math.min(rows.length,4),
    guidance:'These are type identities observed before this execution, not current elements or proof that deletion was safe, unused, or intended. Use them to assess the executed code and requested change without reopening the original model solely to recover names. Unobserved IDs remain unknown. Full retained rows: projection.native_execution_audit.deleted_type_context. This grants no verification or retry.'};
}

/** Point to an existing exact-field reader instead of paging through a JSON-
 * encoded receipt. These are historical changed IDs, not current model proof.
 * Keep the potentially large list outside automatic/cached tool presentation. */
function affectedTargetLookup(ref: EvidenceRefV1, payload: unknown) {
  const audit=selectNativeExecutionAudit(ref,payload),tx=record(audit?.transaction);
  const valid=(v:unknown):v is number[]=>Array.isArray(v)&&v.length<=4096
    &&v.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(v).size===v.length;
  if(audit?.success!==true||audit.verified!==false||tx?.status!=='committed'||tx.committed!==true
    ||!valid(tx.affected_element_ids)||!tx.affected_element_ids.length
    ||!valid(tx.added_element_ids)||!valid(tx.modified_element_ids)||!valid(tx.deleted_element_ids))return null;
  const union=new Set([...tx.added_element_ids,...tx.modified_element_ids,...tx.deleted_element_ids]);
  if(union.size!==tx.affected_element_ids.length||tx.affected_element_ids.some(id=>!union.has(id)))return null;
  const field='projection.native_execution_audit.transaction.affected_element_ids';
  const selector=Buffer.byteLength(JSON.stringify({[field]:tx.affected_element_ids}),'utf8')<=4096
    ?{fields:[field]}:{itemRange:{path:field,start:0,count:256}};
  return {tool:'operator_retrieve_evidence',arguments:{evidenceId:ref.evidence_id,
    purpose:'Read retained historical changed element IDs',...selector,maxBytes:4096},
    observed_count:tx.affected_element_ids.length,
    usage:'Call the named tool with arguments when the changed-ID list is needed. For pages continue itemRange.start at pagination.next_start until has_more is false. Historical native footprint includes deleted and collateral elements; it is not current existence, preservation or task verification. Revalidate relevant identities before correction. Do not repeat the edit or scan receipt text to recover these IDs.'};
}

/** Selected-field presentation of already retained native execution evidence.
 * This neither validates generated claims nor changes settlement/admission.
 * Keep small return values whole instead of spending the budget on compiler
 * metadata and reducing the useful result to a generic 240-character fact.
 */
export function projectNativeProgram(ref: EvidenceRefV1, payload: unknown, maxBytes: number): Row | null {
  if (ref.source !== "assignment_kernel_v2:operator_run_dynamic_revit_program"
      || ref.trust_level !== "authoritative_native") return null;
  const row = record(payload), outcome = record(row?.native_outcome);
  if (!row || row.schema !== "revit-operator.dynamic-revit-program-run.v1" || row.execution_lane !== "native"
      || typeof row.run_id !== "string" || !row.run_id || row.run_id.length > 240
      || !["read", "apply"].includes(String(row.requested_mode))
      || !["completed", "failed"].includes(String(row.execution_status))
      || typeof row.execution_ok !== "boolean" || row.execution_ok !== (row.execution_status === "completed")
      || !outcome || outcome.task_verified !== false || outcome.verification_required !== true
      || outcome.effect_scope !== undefined && !["listed_elements", "active_document"].includes(String(outcome.effect_scope))
      || !["not_started:none", "rolled_back:none", "committed:applied", "unknown:unknown"].includes(`${outcome.native_transaction_state}:${outcome.persistent_effect}`)
      || row.requested_mode === "read" && outcome.native_transaction_state !== "not_started"
      || row.execution_ok === true && !["not_started", "committed"].includes(String(outcome.native_transaction_state))
      || !(outcome.program_result === null || typeof outcome.program_result === "string")
      || !(outcome.error === null || typeof outcome.error === "string")
      || !Array.isArray(row.diagnostics)) return null;
  // Keep a whole return when it fits. Otherwise expose a separately labelled
  // text page, using the same UTF8 offsets as ordinary retained retrieval.
  // Never truncate errors or put a partial value in native_outcome.program_result.
  const projected: Row = {
    schema: "revit-operator.native-program-presentation/v1",
    run_id: row.run_id, requested_mode: row.requested_mode,
    execution_status: row.execution_status, execution_ok: row.execution_ok,
    native_outcome: {
      ...(outcome.effect_scope === undefined ? {} : { effect_scope: outcome.effect_scope }),
      persistent_effect: outcome.persistent_effect, native_transaction_state: outcome.native_transaction_state,
      verification_required: true, task_verified: false,
      program_result: outcome.program_result, error: outcome.error
    },
    diagnostics: row.diagnostics.slice(0, 8),
    coverage: { program_result_complete: true, full_evidence_included: false,
      total_diagnostics: row.diagnostics.length, presented_diagnostics: Math.min(row.diagnostics.length, 8) },
    retry_authorized: false,
    guidance: "Program return text is not task verification or collection-completeness proof. Native outcome is separate. Use these exact returned values without rereading solely to recover omitted compiler metadata. Full evidence remains retrievable. For confirmed rollback, inspect and justify any corrected scope before a fresh admitted request; reported IDs are not automatic permission. Unknown effects require reconciliation."
  };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const deletion = row.requested_mode === 'apply' && row.execution_ok === true && outcome.native_transaction_state === 'committed'
    ? deletedTypeContext(ref, payload) : null;
  if (deletion && size({...projected,deleted_type_context:deletion}) <= maxBytes) projected.deleted_type_context = deletion;
  if (size(projected) <= maxBytes) {
 const lookup=row.requested_mode==='apply'&&row.execution_ok===true&&outcome.native_transaction_state==='committed'?affectedTargetLookup(ref,payload):null;
 const withLookup=lookup?{...projected,affected_target_lookup:lookup}:null;
 return withLookup&&size(withLookup)<=maxBytes?withLookup:projected;
 }
  if (typeof outcome.program_result !== "string" || !outcome.program_result) return null;
  const partialOutcome = { ...(projected.native_outcome as Row) };
  delete partialOutcome.program_result;
  const partial: Row = { ...projected, native_outcome: partialOutcome,
    coverage: { ...(projected.coverage as Row), program_result_complete: false },
    guidance: "program_result_page is an incomplete prefix of retained output, not a complete record or verification. Retrieve remaining needed text with operator_retrieve_evidence using this evidence_id and textRange.path/native_outcome.program_result, start=text_pagination.next_start. Do not rerun code just to recover text. Execution, effects and verification remain separate; unknown effects require reconciliation; no retry is authorized." };
  // Reserve the bounded page metadata as well as JSON escaping. The shared
  // selector finds a UTF8 boundary; the final serialized cap remains decisive.
  const pageBudget = maxBytes - size(partial) - 512;
  if (pageBudget < 64) return null;
  try {
    const page = selectFieldTextRange(outcome.program_result,
      { path: "native_outcome.program_result", start: 0, length: Buffer.byteLength(outcome.program_result, "utf8") }, pageBudget);
    partial.program_result_page = { ...page, complete: false };
    return size(partial) <= maxBytes ? partial : null;
  } catch {
    // An invalid Unicode scalar or insufficient page budget keeps the existing
    // generic presentation and exact retained evidence; never repair raw bytes.
    return null;
  }
}
