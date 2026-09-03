import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatResponse } from "../contracts.js";
import { appendEvent } from "../memory/sqlite_store.js";
import { persistence } from "../persistence/persistence_manager.js";
import { appendMessage } from "../session_store.js";
import {
  classifyAssignmentKernelExecutionFailureV2,
  settleAssignmentKernelExecutionFailureV2
} from "./assignment_kernel_v2_execution_failure.js";
import { deriveTerminalResultV2, renderTerminalResultV2 } from "./assignment_kernel_v2_terminal_result.js";
import type { PreparedAssignmentTurn } from "./turn_preparation.js";

export type ChatExecutionFailureBoundaryResultV2 = Readonly<{
  response: ChatResponse | null;
}>;

export function handleChatExecutionFailureBoundaryV2(input: Readonly<{
  assignment: PreparedAssignmentTurn | null;
  message_id: string;
  error: unknown;
  canceled?: boolean;
  persist_terminal_response?: boolean;
  deliver_terminal?: (response: ChatResponse) => void;
}>): ChatExecutionFailureBoundaryResultV2 {
  if (input.assignment?.kernelVersion !== 2 || !input.assignment.bindingV2) return { response: null };
  let snapshot;
  try {
    snapshot = settleAssignmentKernelExecutionFailureV2({
      binding: input.assignment.bindingV2,
      failure_id: `${input.canceled ? "canceled" : "failed"}:${input.message_id}`,
      error_class: classifyAssignmentKernelExecutionFailureV2(input.error, { canceled: input.canceled }),
      phase: "provider_turn"
    }).snapshot;
  } catch (settlementError) {
    try {
      appendEvent(input.assignment.bindingV2.session_id, "assistant", "assignment-kernel-v2.execution-failure-settlement.error", {
        message_id: input.message_id,
        error: settlementError instanceof Error ? settlementError.message : String(settlementError)
      });
    } catch {
      // The original provider failure remains the request error.
    }
    return { response: null };
  }
  if (!snapshot.terminal || !["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome)) {
    return { response: null };
  }
  const response: ChatResponse = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: renderTerminalResultV2(snapshot),
    actions: [],
    assignment_snapshot_v2: snapshot,
    terminal_result_v2: deriveTerminalResultV2(snapshot)
  };
  if (input.persist_terminal_response !== false) {
    try {
      appendMessage(input.assignment.bindingV2.session_id, { role: "assistant", text: response.assistant_message });
      persistence.appendAssistantTurn({
        sessionId: input.assignment.bindingV2.session_id,
        messageId: input.message_id,
        text: response.assistant_message
      });
      persistence.persistChatResponse({
        sessionId: input.assignment.bindingV2.session_id,
        messageId: input.message_id,
        response
      });
    } catch {
      // Exact V2 publication remains the authoritative recovery surface.
    }
  }
  input.deliver_terminal?.(response);
  return { response };
}
