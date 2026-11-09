import type { EvidenceRefV1 } from "./evidence_ref.js";
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
  return {evidence_id:ref.evidence_id,fields:[field],
    max_bytes:Math.max(1024,Buffer.byteLength(JSON.stringify({[field]:tx.affected_element_ids}),'utf8')+128),
    observed_count:tx.affected_element_ids.length,
    usage:'Use operator_retrieve_evidence with this evidence_id, fields and max_bytes when the full changed-ID list is needed. Historical native footprint includes deleted and collateral elements; it is not current existence, preservation or task verification. Revalidate relevant identities before correction. Do not repeat the edit or scan receipt text to recover these IDs.'};
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
  // Never slice a program return or error into an apparently complete value.
  // Large values retain the ordinary exact-field retrieval path.
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
  if(Buffer.byteLength(JSON.stringify(projected),"utf8")>maxBytes)return null;
  const lookup=row.requested_mode==='apply'&&row.execution_ok===true&&outcome.native_transaction_state==='committed'
    ?affectedTargetLookup(ref,payload):null;
  if(lookup){const withLookup={...projected,affected_target_lookup:lookup};
    if(Buffer.byteLength(JSON.stringify(withLookup),'utf8')<=maxBytes)return withLookup;}
  return projected;
}
