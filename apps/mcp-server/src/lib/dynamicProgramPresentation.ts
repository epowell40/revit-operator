type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown, limit = 1000): string | null => typeof value === "string" ? value.slice(0, limit) : null;
const count = (value: unknown): number | null => Array.isArray(value) ? value.length : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;
function receipt(value: unknown): RecordValue {
  if (typeof value !== "string" || value.length > 1024 * 1024) return {};
  try { return record(JSON.parse(value)); } catch { return {}; }
}

/** Presentation only: the runner retains the complete, hash-bound result before
 * this projection is built. This view cannot authorize retries or settle effects.
 */
export function presentDynamicProgramResult(value: RecordValue): RecordValue {
  if (value.execution_lane === "native") {
    const outcome = record(value.native_outcome), verification = record(value.verification);
    const rollbackGuidance = value.requested_mode === "apply" && value.execution_ok === false
      && value.execution_status === "failed" && outcome.persistent_effect === "none" && outcome.native_transaction_state === "rolled_back"
      ? " Confirmed rollback means this attempt left no persistent model changes. Inspect current targets and the native cause before correcting source or scope. Reported collateral IDs do not automatically authorize changes to those elements. For authorized general native-code work, submit a fresh request using explicit active_document scope rather than predicting dependent IDs; the host binds it to the current document and exact source. Keep a requested strict listed-elements scope when that is the intended constraint. Verify requested results and review the actual executed code against user intent; an audit of dependent changes is not a failure by itself. Do not replay consumed authorization or use snapshot resume on this lane."
      : "";
    return { schema: text(value.schema, 128), run_id: text(value.run_id, 128), requested_mode: text(value.requested_mode, 32),
      execution_lane: "native", execution_status: text(value.execution_status, 32), execution_ok: value.execution_ok === true,
      native_outcome: Object.keys(outcome).length ? { effect_scope: text(outcome.effect_scope, 32), persistent_effect: text(outcome.persistent_effect, 32),
        native_transaction_state: text(outcome.native_transaction_state, 32), task_verified: false,
        verification_required: true, program_result: text(outcome.program_result, 32768), error: text(outcome.error, 2000) } : null,
      diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics.slice(0, 8) : [],
      affected_target_identities: record(value.canonical_attempt_settlement).affected_target_identities ?? [],
      retained_evidence: { evidence_sha256: text(verification.evidence_sha256, 128) },
      guidance: "Native transaction outcome and generated return text are separate. Independently read back affected targets for writes; use an adequate visual review only for visual obligations. Generated counts do not automatically establish collection completeness. Do not retry unknown effects or treat compiler success as execution. Use native_outcome.program_result for concise result delivery; exact full receipts remain in canonical evidence." + rollbackGuidance };
  }
  if (value.execution_status === "completed" && value.execution_ok === true && value.requested_mode === "read") {
    const entries = Object.entries(record(value.report));
    const logs = Array.isArray(value.logs) ? value.logs : [];
    return {
      schema: text(value.schema, 128), run_id: text(value.run_id, 128), requested_mode: "read",
      execution_status: "completed", execution_ok: true,
      report: Object.fromEntries(entries.slice(0, 64).map(([key, item]) => [key.slice(0, 128), text(item, 1024)])),
      report_omitted_entries: Math.max(0, entries.length - 64),
      logs: logs.slice(0, 8).map(item => text(item, 512)), omitted_log_lines: Math.max(0, logs.length - 8),
      retained_evidence: { evidence_sha256: text(record(value.verification).evidence_sha256, 128),
        detail: "Complete native snapshot, program and receipts remain in canonical evidence. This is a report projection, not additional model-absence or completeness proof." }
    };
  }
  if (value.execution_status !== "failed") return value;
  const evidence = record(value.evidence);
  const preview = receipt(evidence.previewReceipt);
  const apply = receipt(evidence.applyReceipt);
  const worker = record(evidence.workerOutput);
  const iteration = record(value.iteration);
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics.slice(0, 8).map(item => {
    const d = record(item);
    return { code: text(d.code, 128), message: text(d.message, d.code === "PROGRAM_PARTIAL_OUTPUT" ? 2048 : 1000), phase: text(d.phase, 64),
      severity: text(d.severity, 16),
      repair_action: text(d.repair_action, 128), line: integer(d.line), column: integer(d.column), retryable: d.retryable === true };
  }) : [];
  const budgetExceeded = preview.failure === "Dynamic preview changed-element budget exceeded.";
  return {
    schema: text(value.schema, 128), run_id: text(value.run_id, 128), requested_mode: text(value.requested_mode, 32),
    execution_status: "failed", execution_ok: false,
    failure: text(apply.failure) ?? text(preview.failure) ?? text(evidence.failure),
    diagnostics,
    native_preview: { ok: preview.ok === true, operation_count: integer(preview.operation_count),
      affected_element_count: count(preview.projected_changed_element_ids),
      rollback_status: text(preview.rollback_status, 64), rollback_truth: preview.rollback_truth === true },
    native_apply: { outcome: text(apply.outcome, 128), failure: text(apply.failure) },
    guidance: budgetExceeded
      ? "operation_budget also caps Revit's dependent affected elements. Keep the intended direct targets unchanged, inspect the affected-element count, and choose a bounded limit that covers it for a new preview. Changing C# formatting cannot fix this limit."
      : "Inspect the first diagnostic and retained evidence before correcting the request or source. Partial output is unverified program text, not proof of inspected targets, completed calculations, or model changes.",
    retry_policy: "This summary grants no retry authority. An uncertain apply requires authoritative reconciliation; use the retained iteration's exact repair/fact contract when eligible.",
    iteration: { run_id: text(iteration.run_id, 128), attempt: integer(iteration.attempt), resume_mode: text(iteration.resume_mode, 64),
      source_sha256: text(iteration.source_sha256, 128), evidence_sha256: text(iteration.evidence_sha256, 128),
      retryable: iteration.retryable === true, parent: iteration.parent ? {
        run_id: text(record(iteration.parent).run_id, 128),
        source_sha256: text(record(iteration.parent).source_sha256, 128),
        evidence_sha256: text(record(iteration.parent).evidence_sha256, 128)
      } : null },
    program_report_not_completion_evidence: Object.fromEntries(Object.entries(record(worker.report)).slice(0, 8)
      .map(([key, item]) => [key.slice(0, 128), text(item, 256)])),
    retained_evidence: { evidence_sha256: text(record(value.verification).evidence_sha256, 128),
      detail: "Full snapshot, native receipts, source and diagnostics remain in the original runtime evidence and canonical observation. Use focused evidence retrieval if needed." }
  };
}
