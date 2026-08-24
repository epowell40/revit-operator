import { createHash } from "node:crypto";
import type { ModelCallReceipt } from "../contracts.js";
import { ASSIGNMENT_ATTEMPT_EVENT_SCHEMA, type AssignmentAttemptEvent } from "./control_plane.js";
import { appendAssignmentEvent } from "./control_plane_store.js";
import { currentAssignmentJournalContext } from "./turn_journal.js";

export const ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT = 64;

export function assignmentModelReceiptObserver(
  sessionId: string,
  onTerminal: () => void
): (receipt: ModelCallReceipt) => void {
  let notified = false;
  return receipt => {
    const context = currentAssignmentJournalContext(sessionId);
    if (!context || context.projection.terminal_state !== "open") return;
    const occurredAt = new Date().toISOString();
    const event: AssignmentAttemptEvent = {
      schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
      event_id: `sha256:${createHash("sha256").update(JSON.stringify({
        assignment_id: context.assignmentId,
        run_id: context.runId,
        generation: context.generation,
        call_id: receipt.call_id
      })).digest("hex")}`,
      assignment_id: context.assignmentId,
      run_id: context.runId,
      generation: context.generation,
      attempt_id: null,
      kind: "provider_call_recorded",
      occurred_at: occurredAt,
      actor: "provider_receipt_observer",
      data: {
        call_id: receipt.call_id,
        route: receipt.route,
        provider: receipt.provider,
        model: receipt.model,
        reasoning_effort: receipt.reasoning_effort,
        success: receipt.success
      }
    };
    const recorded = appendAssignmentEvent(context.assignmentId, event);
    if (!notified && recorded.projection.provider_call_count >= ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT) {
      notified = true;
      onTerminal();
      if (recorded.projection.quiescent) {
        appendAssignmentEvent(context.assignmentId, {
          ...event,
          event_id: `${event.event_id}:absolute-limit`,
          attempt_id: null,
          kind: "assignment_terminal",
          data: { terminal_state: "failed", reason: "absolute_model_call_limit_reached" }
        });
      }
    }
  };
}
