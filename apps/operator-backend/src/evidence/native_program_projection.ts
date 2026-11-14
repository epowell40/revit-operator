import type { EvidenceRefV1 } from "./evidence_ref.js";
import { selectFieldTextRange } from "./field_text_range.js";
import { selectNativeExecutionAudit } from './native_execution_audit.js';

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

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
