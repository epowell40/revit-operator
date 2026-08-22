import { createHash } from "node:crypto";
import type { ChatRequest, ChatResponse } from "../contracts.js";
import { getActiveGoalForSession } from "../goals/service.js";
import type { ProviderDynamicProgramV1 } from "../dynamic_runtime/provider_dynamic_program.js";
import { journalAssignmentActions, journalAssignmentToolResults } from "./turn_journal.js";
import { settleAssignmentTurn } from "./turn_settlement.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Projects the trusted Dynamic Runtime supervisor receipt through the same
 * Assignment attempt/effect reducer used by typed and generic Revit calls. */
export function journalProviderDynamicRuntimeSettlement(
  req: ChatRequest,
  program: ProviderDynamicProgramV1,
  response: ChatResponse
): void {
  const receipt = response.dynamic_program_execution_receipt;
  if (!receipt) return;
  const goal = getActiveGoalForSession(req.session_id);
  const declared = `${goal?.work_budget?.requested_effect || ""}`;
  const requestedEffect: "read" | "preview" | "apply" = program.apply ? "apply" : declared === "preview" ? "preview" : "read";
  const attemptId = `dynamic:${digest({ message_id: req.message_id, source: program.source, receipt }).slice(0, 32)}`;
  const action = {
    action_id: attemptId,
    method: "POST" as const,
    path: "/revit/dynamic-program",
    request_effect: requestedEffect,
    body: { category: program.category, parameters: program.parameters, limit: program.limit, apply: program.apply }
  };
  journalAssignmentActions(req.session_id, [action], "dynamic_runtime_supervisor");
  const completed = receipt.status === "completed";
  const nativeSettlement = {
    schema: "revit-operator.native-attempt-settlement.v1",
    attempt_id: attemptId,
    requested_effect: requestedEffect,
    method: "POST",
    path: "/revit/dynamic-program",
    request_dispatched: receipt.request_dispatched,
    effect_state: completed ? (program.apply ? "applied" : "none") : receipt.outcome_unknown ? "unknown" : "none",
    effect_reason: completed
      ? program.apply ? "trusted_dynamic_runtime_apply_receipt" : "trusted_dynamic_runtime_no_persistent_effect"
      : receipt.failure || "dynamic_runtime_not_completed",
    effect_authority: completed ? "native_receipt" : receipt.outcome_unknown ? "native_host" : "transport_pre_dispatch",
    affected_target_identities: [],
    receipt_refs: [
      ...(receipt.evidence_sha256 ? [`dynamic-evidence:sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`] : []),
      ...(receipt.evidence_binding_sha256 ? [`dynamic-binding:${receipt.evidence_binding_sha256}`] : [])
    ],
    evidence_refs: receipt.evidence_sha256 ? [`dynamic-evidence:sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`] : []
  };
  journalAssignmentToolResults(req.session_id, [{
    action_id: attemptId,
    method: "POST",
    path: "/revit/dynamic-program",
    request_effect: requestedEffect,
    status: completed ? "done" : "failed",
    request_dispatched: receipt.request_dispatched,
    outcome_unknown: receipt.outcome_unknown,
    reconciliation_required: receipt.outcome_unknown,
    result_json: { dynamic_program_execution_receipt: receipt, canonical_attempt_settlement: nativeSettlement },
    error: receipt.failure ?? undefined
  }], "dynamic_runtime_supervisor");
  if (completed && program.apply && receipt.evidence_sha256) {
    settleAssignmentTurn(req.session_id, "apply", {
      schema: "revit-operator.teammate-loop-receipt.v1",
      turn_kind: "mutation", context_state: "live", stage: "report", preview_action_ids: [],
      apply_action_id: attemptId, verification_action_ids: [attemptId], apply_attempts: 1, verified: true,
      verification_mode: "trusted_dynamic_program_receipt", verification_action_id: attemptId,
      verification_evidence_sha256: `sha256:${receipt.evidence_sha256.replace(/^sha256:/, "")}`, blocked_reason: null
    });
  }
}
