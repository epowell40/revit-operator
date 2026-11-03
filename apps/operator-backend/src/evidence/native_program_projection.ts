import type { EvidenceRefV1 } from "./evidence_ref.js";

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;

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
  return Buffer.byteLength(JSON.stringify(projected), "utf8") <= maxBytes ? projected : null;
}
