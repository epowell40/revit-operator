import type { ChatRequest } from "../contracts.js";
import { isIndependentAssistantTurn } from "./assistant_turn.js";

/** Intake optimization only. This cannot authorize a tool or certify model state. */
export function assistantContextPolicy(request: Partial<ChatRequest>) {
  // Before reading Revit, assume a model could be open. Ambiguous references
  // such as "What size is this?" must retain their normal live-context path.
  const independent = isIndependentAssistantTurn({ ...request, context: { revit: {} } });
  return {
    schema: "revit-operator.chat-context-policy.v1" as const,
    session_id: request.session_id,
    message_id: request.message_id,
    requires_revit_context: !independent
  };
}
