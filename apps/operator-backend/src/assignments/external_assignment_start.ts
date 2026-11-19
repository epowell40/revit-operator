import { randomUUID } from "node:crypto";
import { assignmentKernelV2Enabled, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import type { GoalRecord } from "../goals/service.js";
import { createAssignmentKernelForGoalV2 } from "./assignment_kernel_v2_factory.js";
import { ensureAssignmentRunForTurn } from "./turn_journal.js";
import { classifyAutoGoalRequest } from "../goals/auto_goal.js";
import { assertConversationIntakeResolved, retainedIntakeDecision } from "../conversation_intake.js";
import { preparePdfWorkAllowance, type PdfWorkAllowanceV1 } from "./pdf_work_allowance.js";
import {getAssignmentKernelSnapshotV2} from './assignment_kernel_v2_store.js';
import {canonicalAssignmentOutcomeForBinding} from './outcome_handoff.js';
import {advanceAssignmentKernelProgressV2} from './assignment_kernel_v2_progress.js';
import {desktopExecutorOwnsAssignmentV2} from './desktop_executor_owner.js';

/** The controller sends the user's request; the backend owns its effect contract. */
export function normalizeExternalAssignmentRequest(input: Record<string, unknown>): Record<string, unknown> {
  const budget = input.work_budget as Record<string, unknown> | undefined;
  if (input.start_assignment_run !== true || budget?.mode !== "sidecar_computer" || budget?.source !== "operator_desktop") return input;
  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  const source = (typeof budget.source_user_request === "string" ? budget.source_user_request.trim() : "") || objective;
  if (!source || source !== objective) throw new Error("external_assignment_source_request_mismatch");
  const messageId = typeof budget.conversation_message_id === "string" ? budget.conversation_message_id.trim() : "";
  if (messageId) {
    const exact = { session_id: String(input.session_id ?? ""), message_id: messageId, user_text: source };
    assertConversationIntakeResolved(exact);
    const decision = retainedIntakeDecision(exact);
    if (!decision || decision.route === "answer" || !decision.operation_scope)
      throw new Error("external_assignment_semantic_scope_required");
    return { ...input, work_budget: { ...budget, source_user_request: source,
      requested_effect: decision.operation_scope.requested_effect } };
  }
  return { ...input, work_budget: { ...budget, source_user_request: source, requested_effect: classifyAutoGoalRequest(source).requestedEffect } };
}

export type ExternalAssignmentRunBinding = Readonly<{
  assignmentId: string;
  runId: string;
  generation: number;
  kernelVersion: 1 | 2;
}>;

function openInputCheckpoint(snapshot: AssignmentSnapshotV2 | null): snapshot is AssignmentSnapshotV2 {
  return snapshot?.outcome === 'awaiting_user_input' && !snapshot.terminal && snapshot.quiescent
    && snapshot.execution_control?.state !== 'paused' && !snapshot.provider_usage_hold
    && snapshot.unresolved_unknown_operation_ids.length === 0;
}

/** Creation records required inputs. Retain the canonical questions before
 * handing the new run to desktop execution, including an exact start retry. */
function materializeDesktopStartupQuestions(snapshot: AssignmentSnapshotV2 | null) {
  if (!openInputCheckpoint(snapshot) || snapshot.execution_failure_ids.length || snapshot.provider_call_ids.length
      || Object.keys(snapshot.operations).length) return;
  const asked = new Set(Object.values(snapshot.clarifications).filter(c => !c.resolved_at).map(c => c.variable_id));
  if (snapshot.pending_input_variable_ids.some(id => !asked.has(id)) && desktopExecutorOwnsAssignmentV2(snapshot)) {
    advanceAssignmentKernelProgressV2({binding: snapshot.current_binding});
  }
}

/** A task may already be waiting for input when its first run is returned. */
export function externalAssignmentInputHandoff(run: ExternalAssignmentRunBinding, sessionId: string) {
  if (run.kernelVersion !== 2) return {};
  const snapshot = getAssignmentKernelSnapshotV2(run.assignmentId);
  if (!openInputCheckpoint(snapshot)) return {};
  const outcome = canonicalAssignmentOutcomeForBinding({
    session_id: sessionId, assignment_id: run.assignmentId, assignment_run_id: run.runId,
    assignment_generation: run.generation
  });
  if (outcome?.outcome_state !== 'awaiting_user_input' || outcome.terminal_state !== 'open'
      || !outcome.quiescent || !outcome.pending_clarification?.question) return {};
  return { canonical_assignment_outcome: outcome };
}

/** Check before setAgentGoal: a new Sidecar start cannot overwrite the source
 * projection of an existing canonical task, then receive that task's old run. */
export function retainedExternalAssignmentStart(input:Record<string,unknown>,current:GoalRecord|null):ExternalAssignmentRunBinding|null{
  if(input.start_assignment_run!==true||!current)return null;
  const snapshot=getAssignmentKernelSnapshotV2(current.id);if(!snapshot)return null;
  const requested=typeof input.assignment_run_id==='string'?input.assignment_run_id.trim():'';
  const source=typeof input.objective==='string'?input.objective.trim():'';
  if(requested===snapshot.current_binding.run_id&&source===snapshot.spec.source_user_request
    &&input.session_id===snapshot.current_binding.session_id){
    materializeDesktopStartupQuestions(snapshot);
    return {assignmentId:current.id,runId:snapshot.current_binding.run_id,generation:snapshot.current_binding.generation,kernelVersion:2};
  }
  throw Object.assign(new Error('This conversation already has a saved task. Add direction or Resume that task; use New Chat for a separate task.'),
    {code:'external_assignment_requires_continuation'});
}

/** Trusted external-controller edge. V2 and V1 are mutually exclusive writes. */
export function startExternalAssignmentRun(input: Readonly<{
  goal: GoalRecord;
  sessionId: string;
  requestedRunId?: string;
  actor: string;
  source_work_allowance?: PdfWorkAllowanceV1;
}>): ExternalAssignmentRunBinding {
  const runId = input.requestedRunId?.trim() || `external:${randomUUID()}`;
  if (assignmentKernelV2Enabled()) {
    const existing=getAssignmentKernelSnapshotV2(input.goal.id);
    if(existing&&(existing.current_binding.run_id!==runId||existing.current_binding.session_id!==input.sessionId||existing.spec.source_user_request!==input.goal.objective))
      throw Object.assign(new Error('The saved task must continue under its existing run and source; a new start was not admitted.'),{code:'external_assignment_requires_continuation'});
    const binding = createAssignmentKernelForGoalV2({
      goal: input.goal,
      run_id: runId,
      source_work_allowance: input.source_work_allowance,
      document_fingerprint: typeof input.goal.work_budget?.document_fingerprint === "string"
        ? input.goal.work_budget.document_fingerprint
        : undefined
    });
    if (binding.session_id === input.sessionId && input.goal.work_budget?.mode === 'sidecar_computer') {
      materializeDesktopStartupQuestions(getAssignmentKernelSnapshotV2(binding.assignment_id));
    }
    return {
      assignmentId: binding.assignment_id,
      runId: binding.run_id,
      generation: binding.generation,
      kernelVersion: 2
    };
  }
  const legacy = ensureAssignmentRunForTurn(input.sessionId, runId, input.actor, false);
  if (!legacy) throw new Error("assignment_run_creation_failed");
  return { ...legacy, kernelVersion: 1 };
}

/** Resolve the exact source allowance before creating an external assignment. */
export async function prepareExternalAssignmentRequest(input: Record<string,unknown>) {
  const normalizedRequest=normalizeExternalAssignmentRequest(input);
  const sourceAllowance=await preparePdfWorkAllowance(normalizedRequest);
  return {normalizedRequest,sourceAllowance};
}
