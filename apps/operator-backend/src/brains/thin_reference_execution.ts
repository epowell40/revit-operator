import { assignmentDirections } from "../assignments/task_steering.js";
import { trustedLocalExperimentHost } from "../assignments/local_advisory_policy.js";
import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../assignments/assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2 } from "../assignments/assignment_work_allowance_v2.js";
import type { ChatRequest, ChatResponse, ModelCallReceipt } from "../contracts.js";
import type { AssignmentBindingV2, AssignmentSnapshotV2, ProgressDecisionV2 } from "../domain/assignment-kernel/index.js";
import { decideAssignmentProgressV2, sameAssignmentBindingV2 } from "../domain/assignment-kernel/index.js";
import { advisoryVerificationV2 } from "../domain/assignment-kernel/execution_policy.js";
import { getRequestContext } from "../request_context.js";

export type ThinReferenceLimits = Readonly<{ max_turns: number; max_wall_ms: number }>;

export class CodexProviderStartStopped extends Error {
  constructor(readonly reason: string, readonly snapshot: AssignmentSnapshotV2 | null) {
    super(`Provider turn was not started: ${reason}.`);
    this.name = "CodexProviderStartStopped";
  }
}

/** Recheck after asynchronous image/thread setup, immediately before dispatch.
 * The callback must start the bound turn directly, without more setup awaits. */
export function startCodexProviderTurnWhenActive<T>(input: Readonly<{
  signal?: AbortSignal;
  binding?: AssignmentBindingV2 | null;
  readSnapshot: () => AssignmentSnapshotV2 | null;
}>, dispatch: () => Promise<T>): Promise<T> {
  const snapshot = input.binding ? input.readSnapshot() : null;
  const reason = input.signal?.aborted
    ? input.signal.reason === "experiment_wall_limit" ? "experiment_wall_limit" : "request_interrupted"
    : input.binding && (!snapshot || !sameAssignmentBindingV2(snapshot.current_binding, input.binding)) ? "assignment_binding_changed"
    : snapshot?.execution_control?.state === "paused" ? "user_requested_pause"
    : snapshot?.provider_usage_hold ? "provider_usage_hold"
    : snapshot?.completion_proposal ? "advisory_completion_proposed"
    : snapshot?.terminal ? "assignment_terminal"
    : snapshot && snapshot.outcome !== "active" ? snapshot.outcome
    : null;
  if (reason) throw new CodexProviderStartStopped(reason, snapshot);
  return dispatch();
}

/** Machine-owned experiment selection. No request/context field enables it. */
export function localThinReferenceLimits(
  req: Pick<ChatRequest, "session_id"> & Partial<Pick<ChatRequest, "assignment_id" | "assignment_run_id" | "assignment_generation">>,
  env: NodeJS.ProcessEnv = process.env,
  context = getRequestContext()
): ThinReferenceLimits | null {
  const retained = req.assignment_id ? getAssignmentKernelSnapshotV2(req.assignment_id) : null;
  const policy = retained?.spec.execution_policy;
  if (policy) {
    if (!trustedLocalExperimentHost(env, context)) throw new Error("advisory_execution_requires_local_host");
    if (retained!.current_binding.session_id !== req.session_id
        || retained!.current_binding.run_id !== req.assignment_run_id || retained!.current_binding.generation !== req.assignment_generation) return null;
    return { max_turns: policy.max_turns, max_wall_ms: policy.max_wall_clock_ms };
  }
  if (!["local", "development"].includes(env.REVIT_OPERATOR_MODE ?? "")) return null;
  if (context?.principal || context?.operator_backend_auth?.mode !== "shared_token") return null;
  let hostname: string;
  try { hostname = new URL(context.operator_backend_auth.allowed_origin).hostname; } catch { return null; }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) return null;
  const allowed = (env.OPERATOR_THIN_REFERENCE_SESSION_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
  if (!allowed.includes(req.session_id)) return null;
  const bounded = (value: string | undefined, fallback: number, max: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
  };
  return {
    max_turns: bounded(env.OPERATOR_THIN_REFERENCE_MAX_TURNS, 8, 16),
    max_wall_ms: bounded(env.OPERATOR_THIN_REFERENCE_MAX_WALL_MS, 30 * 60_000, 60 * 60_000)
  };
}

type Progress = Readonly<{ snapshot: AssignmentSnapshotV2; decision: ProgressDecisionV2 }>;
export type ThinReferenceRunResult = Readonly<{
  response: ChatResponse;
  turns: number;
  stop_reason: string;
  duration_ms: number;
  provider_turns: NonNullable<ChatResponse["provider_turn_usage"]>[];
}>;
const activeAssignments = new Set<string>();

/** Reporting only: an interrupted provider is never replayed or changed to a
 * completed turn. Recognize review only from the current, drained host state. */
function incompleteProviderStopReason(snapshot: AssignmentSnapshotV2, binding: AssignmentBindingV2,
  disposition: NonNullable<ChatResponse["provider_turn_usage"]>["disposition"] | undefined): string {
  if (!sameAssignmentBindingV2(snapshot.current_binding, binding)) return "assignment_binding_changed";
  if (snapshot.execution_control?.state === "paused") return "user_requested_pause";
  const failureId = snapshot.execution_failure_ids.at(-1);
  if (failureId) return snapshot.execution_failures[failureId]?.code ?? "provider_turn_not_completed";
  if (snapshot.progress_blocker) return snapshot.progress_blocker.code;
  if (snapshot.provider_budget_exhausted) return "provider_budget_exhausted";
  if (snapshot.unresolved_unknown_operation_ids.length) return "unknown_effect_requires_reconciliation";
  if (snapshot.in_flight_operation_ids.length) return "operation_still_in_flight";
  if (snapshot.in_flight_provider_call_ids.length || !snapshot.quiescent) return "provider_turn_not_completed";
  if (snapshot.provider_usage_hold) return "provider_usage_hold";
  if (snapshot.pending_input_variable_ids.length) return "awaiting_user_input";
  if (snapshot.terminal) return snapshot.terminal_reason ?? "assignment_terminal";
  const decision = decideAssignmentProgressV2({ snapshot,
    budget: defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), now: new Date().toISOString() });
  if (decision.decision === "blocked") return decision.reason;
  const proposal = snapshot.completion_proposal;
  if (disposition === "interrupted" && advisoryVerificationV2(snapshot)
      && snapshot.outcome === "awaiting_user_review" && decision.decision === "request_user_review"
      && proposal?.verified === false && snapshot.pending_review_ids.includes(proposal.review_id)) {
    return "advisory_completion_proposed";
  }
  return "provider_turn_not_completed";
}

export const THIN_REFERENCE_NO_WORK_STOP = "completed_turns_without_retained_work";

function directionsIdentity(binding: AssignmentBindingV2): string | null {
  try {
    return JSON.stringify(assignmentDirections(binding).map(({ command_id, text, state }) => ({ command_id, text, state })));
  } catch { return null; } // Unreadable directions cannot prove another empty turn.
}

function completedTurnOnlyRecordedUsage(before: AssignmentSnapshotV2, after: AssignmentSnapshotV2,
  usage: ChatResponse["provider_turn_usage"], messageId: string): boolean {
  if (!usage || usage.disposition !== "completed" || !usage.thread_id || !usage.turn_id
      || usage.session_id !== after.current_binding.session_id || usage.message_id !== messageId
      || !sameAssignmentBindingV2(before.current_binding, after.current_binding) || !after.quiescent) return false;
  if (!Array.isArray(usage.raw_response_ids) || !usage.raw_response_ids.length
      || usage.raw_response_ids.some(id => typeof id !== "string" || !id.trim())
      || new Set(usage.raw_response_ids).size !== usage.raw_response_ids.length) return false;
  const calls = after.provider_call_ids.filter(id => !before.provider_calls[id]);
  const rawIds = new Set(usage.raw_response_ids);
  const epochs = after.progress_epochs.slice(before.progress_epochs.length);
  // In the validated journal each event can add at most one provider identity
  // OR one epoch. Exact accounting excludes every operation, observation,
  // input, plan and control event without hashing large task snapshots.
  // Other provider lifecycle shapes are unsupported here, not "no work".
  return calls.length > 0 && calls.length === rawIds.size && epochs.length > 0
    && after.assignment_version - before.assignment_version === calls.length + epochs.length
    && calls.every(id => rawIds.has(id) && after.provider_calls[id]?.state === "completed"
      && after.provider_calls[id]?.success === true && after.provider_calls[id]?.controller_turn_id === usage.turn_id
      && sameAssignmentBindingV2(after.provider_calls[id]!.binding, after.current_binding))
    && epochs.every(epoch => sameAssignmentBindingV2(epoch.binding, after.current_binding)
      && !epoch.genuine_progress && !epoch.progress_reasons.length && !epoch.admitted_operation_ids.length
      && !epoch.new_observation_ids.length && !epoch.new_fact_identities.length && !epoch.criterion_deltas.length
      && epoch.before_assignment_version >= before.assignment_version && epoch.after_assignment_version < after.assignment_version)
    && epochs.some(epoch => epoch.before_assignment_version === before.assignment_version
      && epoch.after_assignment_version === after.assignment_version - 1);
}

/** Display only, after refreshing canonical state; no lifecycle transition. */
export function thinReferenceNoWorkStopNote(reason: string, binding: AssignmentBindingV2,
  snapshot: AssignmentSnapshotV2 | null): string {
  if (reason !== THIN_REFERENCE_NO_WORK_STOP || !snapshot || !snapshot.quiescent
      || !sameAssignmentBindingV2(snapshot.current_binding, binding)) return "";
  const decision = decideAssignmentProgressV2({ snapshot,
    budget: defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), now: new Date().toISOString() });
  return decision.decision === "admit_reasoning_turn"
    ? "Automatic continuation stopped after repeated completed turns recorded no new task work. The task and its usage are preserved; you can add a direction to continue."
    : "";
}


/** One request owns sequential provider turns; the existing V2 owner owns all
 * operations and admission. A disconnect ends this run, never replays it. */
export async function runThinReferenceTurns(input: Readonly<{
  request: ChatRequest;
  binding: AssignmentBindingV2;
  limits: ThinReferenceLimits;
  signal: AbortSignal;
  inspect: () => Progress;
  invoke: (request: ChatRequest, turn: number) => Promise<ChatResponse>;
  onContinue?: (turn: number) => void;
  now?: () => number;
}>): Promise<ThinReferenceRunResult> {
  const key = JSON.stringify(input.binding);
  if (activeAssignments.has(key)) throw new Error("thin_reference_assignment_already_running");
  activeAssignments.add(key);
  const now = input.now ?? Date.now, started = now();
  let turns = 0, stopReason = "not_started", emptyCompletedTurns = 0;
  let lastTurnStart: AssignmentSnapshotV2 | null = null, lastDirections: string | null = null;
  let response: ChatResponse = { version: "operator.backend.v1", assistant_message: "Task stopped before another provider turn. Its progress is saved.", actions: [] };
  const receipts = new Map<string, ModelCallReceipt>();
  const providerTurns: NonNullable<ChatResponse["provider_turn_usage"]>[] = [];
  try {
    while (true) {
      if (input.signal.aborted) { stopReason = input.signal.reason === "experiment_wall_limit" ? "experiment_wall_limit" : "request_interrupted"; break; }
      if (now() - started >= input.limits.max_wall_ms) { stopReason = "experiment_wall_limit"; break; }
      const current = input.inspect();
      response = { ...response, assignment_snapshot_v2: current.snapshot };
      if (!sameAssignmentBindingV2(current.snapshot.current_binding, input.binding)) { stopReason = "assignment_binding_changed"; break; }
      if (current.snapshot.unresolved_unknown_operation_ids.length) { stopReason = "unknown_effect_requires_reconciliation"; break; }
      if (current.snapshot.in_flight_operation_ids.length) { stopReason = "operation_still_in_flight"; break; }
      if (current.snapshot.terminal || current.snapshot.execution_control?.state === "paused"
          || current.snapshot.outcome !== "active" || current.decision.decision !== "admit_reasoning_turn") {
        stopReason = current.decision.reason; break;
      }
      if (turns >= input.limits.max_turns) { stopReason = "experiment_turn_limit"; break; }
      const directions = directionsIdentity(input.binding);
      if (lastTurnStart) {
        emptyCompletedTurns = lastDirections !== null && directions === lastDirections
          && completedTurnOnlyRecordedUsage(lastTurnStart, current.snapshot, response.provider_turn_usage, input.request.message_id)
          ? emptyCompletedTurns + 1 : 0;
        if (emptyCompletedTurns >= DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2.max_no_progress_epochs) {
          stopReason = THIN_REFERENCE_NO_WORK_STOP; break;
        }
      }
      if (input.signal.aborted) { stopReason = "request_interrupted"; break; }
      if (turns) input.onContinue?.(turns + 1);
      const request = turns ? {
        ...input.request,
        user_text: "Continue the same unfinished task from its saved state and the previous tool results. Inspect existing effects before retrying. Finish the requested deliverable or record the specific missing input or blocker.",
        // A lost provider thread can be replaced on any turn. Re-send the
        // original bounded source set so recovery retains both handles/pixels.
        user_attachments: input.request.user_attachments,
        tool_results: []
      } : input.request;
      response = await input.invoke(request, ++turns);
      for (const receipt of response.model_call_receipts ?? []) receipts.set(receipt.call_id, receipt);
      if (response.provider_turn_usage) providerTurns.push(response.provider_turn_usage);
      // Errors, interruptions and lost acknowledgements are not new work.
      if (response.provider_turn_usage?.disposition !== "completed") {
        // The work-plan proposal intentionally interrupts the provider after
        // draining its tool call. Its response snapshot can predate settlement.
        // Read/derive only: reporting must not advance criteria or persist a
        // new lifecycle transition after the provider has stopped.
        const settled = getAssignmentKernelSnapshotV2(input.binding.assignment_id);
        response = { ...response, assignment_snapshot_v2: settled ?? undefined };
        stopReason = input.signal.aborted
          ? input.signal.reason === "experiment_wall_limit" ? "experiment_wall_limit" : "request_interrupted"
          : now() - started >= input.limits.max_wall_ms ? "experiment_wall_limit"
          : settled ? incompleteProviderStopReason(settled, input.binding, response.provider_turn_usage?.disposition)
          : "assignment_binding_changed";
        break;
      }
      if (response.actions.length) { stopReason = "pending_client_actions"; break; }
      lastTurnStart = current.snapshot; lastDirections = directions;
    }
    return { response: { ...response, model_call_receipts: [...receipts.values()] }, turns,
      stop_reason: stopReason, duration_ms: Math.max(0, now() - started), provider_turns: providerTurns };
  } finally { activeAssignments.delete(key); }
}
