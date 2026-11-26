import { assignmentKernelV2ForBinding } from './assignment_kernel_v2_factory.js';
import { assignmentKernelTerminalSettlementDeferredV2 } from './assignment_kernel_v2_terminal_barrier.js';
import { getRequestAssignmentPrincipalId } from '../request_context.js';
import type { GoalRecord } from '../goals/service.js';

/** A new objective in the same chat is not steering of the previous objective.
 * Reread the authenticated report boundary; never inherit or broaden its scope. */
export function assertNextChatRequest(value: unknown, current: GoalRecord | null, sessionId: string) {
  const next = value as Record<string, any> | null;
  if (!next || !current || !getRequestAssignmentPrincipalId()
      || next.assignment_id !== current.id || next.session_id !== sessionId
      || typeof next.run_id !== 'string' || !Number.isSafeInteger(next.generation))
    throw new Error('The previous task changed. Refresh this chat before sending the next request.');
  const resolved = assignmentKernelV2ForBinding({ assignment_id: current.id, session_id: sessionId,
    run_id: next.run_id, generation: next.generation });
  const s = resolved?.snapshot;
  if (!s || s.assignment_version !== next.assignment_version || s.terminal
      || s.outcome !== 'awaiting_user_review' || !s.quiescent
      || s.execution_control?.state === 'paused' || s.provider_usage_hold
      || (s.execution_control?.command_id ?? null) !== next.control_command_id
      || s.current_binding.document_fingerprint !== next.document_fingerprint
      || s.completion_proposal?.review_id !== next.review_id
      || s.pending_review_ids.length !== 1 || s.pending_review_ids[0] !== next.review_id
      || s.in_flight_operation_ids.length || s.in_flight_provider_call_ids.length
      || s.unresolved_unknown_operation_ids.length || s.pending_input_variable_ids.length
      || assignmentKernelTerminalSettlementDeferredV2(resolved!.binding))
    throw new Error('The previous task is paused, still settling, or has changed. Its work must be reconciled before a new request.');
  return resolved!;
}
