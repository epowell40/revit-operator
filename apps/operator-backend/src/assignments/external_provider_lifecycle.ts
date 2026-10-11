import { randomUUID } from "node:crypto";
import type { ModelCallReceipt } from "../contracts.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { deriveProgressGapsV2, decideAssignmentProgressV2 } from "../domain/assignment-kernel/index.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import type { AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, recordAssignmentProviderCallStateV2 } from "./assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2, absoluteAssignmentWorkCallLimitV2 } from "./assignment_work_allowance_v2.js";
import { settleAssignmentKernelExecutionFailureV2 } from "./assignment_kernel_v2_execution_failure.js";

/** Host-owned provider boundary. Neither caller prose nor tool results settle work. */
export async function executeExternalProviderCallV2<T>(input: {
  binding: AssignmentKernelBindingInputV2;
  model: string;
  reasoning_effort: string | null;
  invoke: () => Promise<T>;
  receipt: (result: T) => ModelCallReceipt;
  errorReceipt: (error: unknown) => ModelCallReceipt | null;
}): Promise<T> {
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved) throw new Error("external_provider_binding_stale_or_mismatched");
  const { snapshot, binding } = resolved;
  const decision = decideAssignmentProgressV2({ snapshot,
    budget: defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), now: new Date().toISOString() });
  if (snapshot.terminal || snapshot.provider_budget_exhausted || snapshot.provider_usage_hold
    || !snapshot.quiescent || snapshot.execution_control?.state === "paused"
    || snapshot.unresolved_unknown_operation_ids.length || snapshot.pending_input_variable_ids.length
    || snapshot.pending_review_ids.length || snapshot.completion_proposal
    || snapshot.provider_call_ids.length >= absoluteAssignmentWorkCallLimitV2(snapshot)
    || decision.decision !== "admit_reasoning_turn")
    throw new Error(`external_provider_admission_denied:${decision.decision}`);
  const gaps = deriveProgressGapsV2(snapshot);
  const callId = `external:${randomUUID()}`;
  const record = (state: Parameters<typeof recordAssignmentProviderCallStateV2>[0]["state"], extra = {}) =>
    recordAssignmentProviderCallStateV2({ binding, call_id: callId, state, ...extra });
  record("admitted", { provider: "openai", model: input.model, reasoning_effort: input.reasoning_effort,
    gap_ids: gaps.map(gap => gap.gap_id), criterion_ids: [...new Set(gaps.flatMap(gap => gap.criterion_ids))],
    expected_information: ["Continue the bound external-controller task using its retained evidence."] });
  record("dispatched");
  const retain = (receipt: ModelCallReceipt | null, success: boolean) => {
    if (receipt) storeEvidence({ scope: { session_id: binding.session_id, assignment_id: binding.assignment_id,
      run_id: binding.run_id, generation: binding.generation }, source: "external-provider.receipt",
      trust_level: "host_observed", raw: { canonical_call_id: callId, receipt } });
    if (receipt) record("usage_received", {
      ...(receipt.route === "desktop_computer" ? { upstream_receipt: {
        call_id: receipt.call_id, route: receipt.route, requested_model: receipt.requested_model,
        model: receipt.model, started_at_utc: receipt.started_at_utc, duration_ms: receipt.duration_ms
      } } : {}), usage: {
      input_tokens: receipt.tokens.input_tokens, output_tokens: receipt.tokens.output_tokens,
      reasoning_tokens: receipt.tokens.reasoning_output_tokens, total_tokens: receipt.tokens.total_tokens,
      ...(receipt.tokens.cached_input_tokens == null ? {} : { cached_input_tokens: receipt.tokens.cached_input_tokens }),
      ...(receipt.tokens.cache_write_input_tokens == null ? {} : { cache_write_input_tokens: receipt.tokens.cache_write_input_tokens }),
      estimated_cost_usd: null
    } });
    const drained = record("completed", { success, ...(success ? {} : { error_class: "provider" }) });
    // The caller may have lost its HTTP connection and journaled a failure
    // while this upstream call was still running. Retain late usage first,
    // then re-evaluate that exact failure; never treat provider success as
    // task success or bypass native effects that still require reconciliation.
    const failureId = drained.execution_failure_ids.at(-1);
    const failure = failureId ? drained.execution_failures[failureId] : undefined;
    if (!drained.terminal && failure) {
      settleAssignmentKernelExecutionFailureV2({ binding: drained.current_binding,
        failure_id: failure.failure_id, error_class: failure.error_class, phase: failure.phase });
    }
  };
  let result: T;
  try { result = await input.invoke(); }
  catch (error) { retain(input.errorReceipt(error), false); throw error; }
  // Persistence errors after a successful response must never invoke the provider again.
  const receipt = input.receipt(result);
  retain(receipt, receipt.success);
  return result;
}
