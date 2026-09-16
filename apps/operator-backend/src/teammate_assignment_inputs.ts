import type { ChatRequest } from "./contracts.js";
import { assignmentKernelV2ForBinding } from "./assignments/assignment_kernel_v2_factory.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "./domain/assignment-kernel/outcome.js";

export type TeammateTaskRequest = Pick<ChatRequest, "user_text" | "context"> & Partial<Pick<ChatRequest,
  "session_id" | "assignment_id" | "assignment_run_id" | "assignment_generation">>;

export function normalizedTeammateUserText(req: Pick<ChatRequest, "user_text" | "context">): string {
  const context = req.context && typeof req.context === "object" ? req.context as Record<string, unknown> : {};
  const ui = context.ui && typeof context.ui === "object" ? context.ui as Record<string, unknown> : {};
  const authoritative = typeof ui.authoritative_user_text === "string" && ui.authoritative_user_text.length <= 20_000
    ? ui.authoritative_user_text.trim() : "";
  return (authoritative || `${req.user_text || ""}`).replace(/\s+/g, " ").trim();
}

// Resolve answers from the authenticated journal. Caller context and prose
// cannot manufacture an answer or replace its exact value.
export function canonicalTeammateInputs(req: TeammateTaskRequest): Readonly<Record<string, unknown>> {
  if (!req.session_id || !req.assignment_id || !req.assignment_run_id || !Number.isSafeInteger(req.assignment_generation)) return {};
  const resolved = assignmentKernelV2ForBinding({ session_id: req.session_id, assignment_id: req.assignment_id,
    run_id: req.assignment_run_id, generation: Number(req.assignment_generation) });
  return resolved?.snapshot.input_values ?? {};
}

export function canonicalTeammateFinalVerification(req: TeammateTaskRequest): { id: string; hash: string } | null {
  if (!req.session_id || !req.assignment_id || !req.assignment_run_id || !Number.isSafeInteger(req.assignment_generation)) return null;
  const snapshot = assignmentKernelV2ForBinding({ session_id: req.session_id, assignment_id: req.assignment_id,
    run_id: req.assignment_run_id, generation: Number(req.assignment_generation) })?.snapshot;
  if (!snapshot?.terminal || snapshot.outcome !== "complete" || snapshot.spec.requested_effect !== "apply") return null;
  const applied = Object.values(snapshot.operations).filter(o => o.requested_effect === "apply" && o.persistent_effect === "applied");
  if (!applied.length || !applied.every(o => appliedOperationHasVerifiedPostconditionV2(snapshot, o.operation_id))) return null;
  for (const operation of applied) for (const id of operation.verification_operation_ids) {
    for (const observationId of snapshot.operations[id]?.observation_ids ?? []) {
      const observation = snapshot.observations[observationId];
      if (observation?.facts.some(f => f.fact_id === "verification.postcondition_satisfied" && f.value === true))
        return { id, hash: observation.raw_payload_hash };
    }
  }
  return null;
}
