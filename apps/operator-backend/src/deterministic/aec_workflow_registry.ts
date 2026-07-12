import type { ChatRequest, ChatResponse } from "../contracts.js";
import type { AecTaskIntentV1 } from "../aec_task_intent.js";
import { interpretAecTaskIntent, type AecTaskIntentInterpreter } from "../aec_task_intent_interpreter.js";
import { maybeRunDeterministicRoomReceptacleAnalog } from "./room_receptacle_analog.js";
import { consumeAecTaskIntentToken } from "../aec_task_intent_cache.js";
import { appendEvent } from "../memory/sqlite_store.js";

export type AecWorkflowId = "electrical.receptacle_layout_from_analog";
export type AecWorkflowResolution = { workflow_id: AecWorkflowId; intent: AecTaskIntentV1 };

export function resolveAecWorkflow(intent: AecTaskIntentV1): AecWorkflowResolution | null {
  if (intent.confidence.value < 0.75 || intent.confidence.ambiguity === "material") return null;
  if (intent.operation !== "layout" || intent.object_class !== "receptacle") return null;
  if (!intent.mutation.requested || intent.mutation.kind !== "create") return null;
  if (!intent.target.room_number || intent.target.element_ids.length > 0) return null;
  if (intent.reference.kind !== "office_standard" && intent.reference.kind !== "room") return null;
  return { workflow_id: "electrical.receptacle_layout_from_analog", intent };
}

export function executeAecWorkflow(req: ChatRequest, resolution: AecWorkflowResolution): ChatResponse | null {
  switch (resolution.workflow_id) {
    case "electrical.receptacle_layout_from_analog":
      return maybeRunDeterministicRoomReceptacleAnalog(req, resolution.intent);
  }
}

export async function maybeRunSemanticAecWorkflow(req: ChatRequest, interpreter?: AecTaskIntentInterpreter): Promise<ChatResponse | null> {
  const issuedIntent = consumeAecTaskIntentToken(req.context, (req.user_text ?? "").trim());
  if (issuedIntent) { try { appendEvent(req.session_id, "assistant", "aec.task_intent.reused", { message_id: req.message_id, intent: issuedIntent }); } catch { } }
  const intent = issuedIntent ?? await interpretAecTaskIntent(req, interpreter);
  const resolution = intent ? resolveAecWorkflow(intent) : null;
  return resolution ? executeAecWorkflow(req, resolution) : null;
}
