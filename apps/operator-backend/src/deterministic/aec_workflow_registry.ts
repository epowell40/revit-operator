import type { ChatRequest, ChatResponse } from "../contracts.js";
import type { AecTaskIntentV1 } from "../aec_task_intent.js";
import { interpretAecTaskIntent, type AecTaskIntentInterpreter } from "../aec_task_intent_interpreter.js";
import { maybeRunDeterministicRoomReceptacleAnalog } from "./room_receptacle_analog.js";
import { consumeAecTaskIntentToken } from "../aec_task_intent_cache.js";
import { appendEvent } from "../memory/sqlite_store.js";
import { maybeRunAecSemanticQuery } from "./aec_query_runtime.js";
import type { AecSemanticTaskInterpreter } from "../aec_semantic_task_interpreter.js";
import type { AecSemanticTaskV1 } from "../aec_semantic_task.js";

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

export function adaptSemanticTaskToLegacyWorkflow(task: AecSemanticTaskV1): AecTaskIntentV1 | null {
  if (task.operation !== "layout" || task.subject.semantic_class !== "receptacle" || task.mutation.kind !== "create" || !task.mutation.requested) return null;
  if (!task.scope.rooms.length || task.scope.rooms.length !== 1 || !["room", "mixed"].includes(task.scope.kind)) return null;
  if (task.confidence.value < 0.75 || task.confidence.ambiguity === "material") return null;
  const explicitRoom = task.reference.strategy === "explicit" ? task.reference.source_room : null;
  const referenceKind = explicitRoom || task.reference.strategy === "current_project_precedent" ? "room" : "office_standard";
  return {
    schema: "revit-operator.aec-task-intent.v1",
    operation: "layout",
    object_class: "receptacle",
    target: { document: task.scope.document, view: task.scope.views[0]?.name ?? null, room_number: task.scope.rooms[0], element_ids: task.scope.element_ids },
    reference: { kind: referenceKind, room_number: explicitRoom },
    mutation: { kind: "create", requested: true },
    spatial_constraints: task.subject.terms,
    confidence: task.confidence,
    evidence: { user_text: task.evidence.user_text }
  };
}

export async function maybeRunSemanticAecWorkflow(req: ChatRequest, interpreter?: AecTaskIntentInterpreter, semanticInterpreter?: AecSemanticTaskInterpreter): Promise<ChatResponse | null> {
  const issuedIntent = consumeAecTaskIntentToken(req.context, (req.user_text ?? "").trim());
  if (issuedIntent) { try { appendEvent(req.session_id, "assistant", "aec.task_intent.reused", { message_id: req.message_id, intent: issuedIntent }); } catch { } }
  if (issuedIntent) { const issuedResolution = resolveAecWorkflow(issuedIntent); return issuedResolution ? executeAecWorkflow(req, issuedResolution) : null; }
  if (interpreter && !semanticInterpreter) {
    const legacyIntent = await interpretAecTaskIntent(req, interpreter);
    const legacyResolution = legacyIntent ? resolveAecWorkflow(legacyIntent) : null;
    return legacyResolution ? executeAecWorkflow(req, legacyResolution) : null;
  }
  const semantic = await maybeRunAecSemanticQuery(req, semanticInterpreter);
  if (semantic.response) return semantic.response;
  const adapted = semantic.task ? adaptSemanticTaskToLegacyWorkflow(semantic.task) : null;
  if (adapted) { const adaptedResolution = resolveAecWorkflow(adapted); return adaptedResolution ? executeAecWorkflow(req, adaptedResolution) : null; }
  const intent = semantic.task ? null : await interpretAecTaskIntent(req, interpreter);
  const resolution = intent ? resolveAecWorkflow(intent) : null;
  return resolution ? executeAecWorkflow(req, resolution) : null;
}
