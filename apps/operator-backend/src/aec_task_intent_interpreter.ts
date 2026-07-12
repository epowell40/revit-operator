import type { ChatRequest } from "./contracts.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import { appendEvent, getRecentMessages } from "./memory/sqlite_store.js";
import { AEC_TASK_INTENT_MAX_TEXT_CHARS, AEC_TASK_INTENT_V1_SCHEMA, normalizeAecTaskIntentV1, type AecTaskIntentV1 } from "./aec_task_intent.js";

export type AecTaskIntentInterpretationInput = {
  user_text: string;
  recent_messages: Array<{ role: "user" | "assistant" | "tool"; text: string }>;
};

export interface AecTaskIntentInterpreter {
  interpret(input: AecTaskIntentInterpretationInput): Promise<unknown | null>;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "operation", "object_class", "target", "reference", "mutation", "spatial_constraints", "confidence", "evidence"],
  properties: {
    schema: { type: "string", enum: [AEC_TASK_INTENT_V1_SCHEMA] },
    operation: { type: "string", enum: ["layout", "place", "move", "delete", "inspect", "other"] },
    object_class: { type: "string", enum: ["receptacle", "light_fixture", "family_instance", "other"] },
    target: {
      type: "object", additionalProperties: false, required: ["document", "view", "room_number", "element_ids"],
      properties: { document: { type: ["string", "null"] }, view: { type: ["string", "null"] }, room_number: { type: ["string", "null"] }, element_ids: { type: "array", items: { type: "integer" }, maxItems: 32 } }
    },
    reference: {
      type: "object", additionalProperties: false, required: ["kind", "room_number"],
      properties: { kind: { type: "string", enum: ["room", "office_standard", "redline", "user_indicated", "none"] }, room_number: { type: ["string", "null"] } }
    },
    mutation: {
      type: "object", additionalProperties: false, required: ["kind", "requested"],
      properties: { kind: { type: "string", enum: ["create", "move", "delete", "none"] }, requested: { type: "boolean" } }
    },
    spatial_constraints: { type: "array", items: { type: "string" }, maxItems: 32 },
    confidence: {
      type: "object", additionalProperties: false, required: ["value", "ambiguity", "reasons"],
      properties: { value: { type: "number", minimum: 0, maximum: 1 }, ambiguity: { type: "string", enum: ["none", "low", "material"] }, reasons: { type: "array", items: { type: "string" }, maxItems: 32 } }
    },
    evidence: { type: "object", additionalProperties: false, required: ["user_text"], properties: { user_text: { type: "string" } } }
  }
} as const;

const instructions = `Interpret the user's Revit/AEC task semantically. Return facts, never tool names or tool paths.
Use layout+receptacle+create when the user wants a room's receptacle/outlet design completed, whether they say office standards, typical layouts, match another unit, mirror an analogous room, or otherwise paraphrase the same professional objective.
Use reference.kind=room only when the user identifies a distinct source/example room; put it in reference.room_number. Use office_standard when a standard/typical/project practice is requested without an explicit source room.
When the target room and requested layout are explicit but the user refers only to an unspecified comparable/typical/adjacent unit, use reference.kind=room with room_number=null and ambiguity=low or none. Deterministic read-only planning is responsible for selecting the unique suitable analog; the missing source number alone is not material ambiguity.
The target room is the room being changed. Do not confuse it with a comparison room.
Use place for one or a bounded set of new devices, move for existing devices, inspect for read-only questions, and other for unsupported/non-AEC requests.
Mark ambiguity=material when the requested mutation or target cannot be grounded safely. Do not invent room numbers, element IDs, documents, views, references, or constraints.
Preserve exact identifiers as strings, including leading zeroes.`;

function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string") return content.text;
    }
  }
  return "";
}

export class OpenAiAecTaskIntentInterpreter implements AecTaskIntentInterpreter {
  async interpret(input: AecTaskIntentInterpretationInput): Promise<unknown | null> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) return null;
    const model = (process.env.OPERATOR_AEC_INTENT_MODEL || process.env.OPERATOR_PLANNER_MODEL || process.env.OPERATOR_OPENAI_MODEL || "gpt-5.6-sol").trim();
    const response = await createOpenAiClient(apiKey).responses.create({
      model,
      reasoning: { effort: "medium" },
      instructions,
      input: JSON.stringify(input),
      text: { format: { type: "json_schema", name: "aec_task_intent_v1", strict: true, schema } }
    } as any);
    const raw = outputText(response);
    return raw ? JSON.parse(raw) : null;
  }
}

export async function interpretAecTaskIntent(req: ChatRequest, interpreter: AecTaskIntentInterpreter = new OpenAiAecTaskIntentInterpreter()): Promise<AecTaskIntentV1 | null> {
  const userText = (req.user_text ?? "").trim();
  if (!userText || userText.length > AEC_TASK_INTENT_MAX_TEXT_CHARS || (req.tool_results?.length ?? 0) > 0) return null;
  const recent = getRecentMessages(req.session_id, 8)
    .filter(message => message.text.trim() && message.text.trim() !== userText)
    .slice(-6)
    .map(message => ({ role: message.role, text: message.text.slice(0, AEC_TASK_INTENT_MAX_TEXT_CHARS) }));
  try {
    const value = await interpreter.interpret({ user_text: userText, recent_messages: recent });
    if (value === null) {
      try { appendEvent(req.session_id, "assistant", "aec.task_intent.unavailable", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown" }); } catch { }
      return null;
    }
    const intent = normalizeAecTaskIntentV1(value, userText);
    try { appendEvent(req.session_id, "assistant", "aec.task_intent", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown", intent }); } catch { }
    return intent;
  } catch (error) {
    try { appendEvent(req.session_id, "assistant", "aec.task_intent.rejected", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown", error: error instanceof Error ? error.message.slice(0, 500) : "intent_interpretation_failed" }); } catch { }
    return null;
  }
}

export const __testOnlyAecTaskIntentSchema = schema;
