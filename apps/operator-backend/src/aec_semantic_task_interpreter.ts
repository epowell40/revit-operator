import type { ChatRequest } from "./contracts.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import { appendEvent, getRecentMessages } from "./memory/sqlite_store.js";
import { AEC_SEMANTIC_TASK_MAX_TEXT_CHARS, AEC_SEMANTIC_TASK_V1_SCHEMA, normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "./aec_semantic_task.js";

export type AecSemanticTaskInterpretationInput = {
  user_text: string;
  recent_messages: Array<{ role: "user" | "assistant" | "tool"; text: string }>;
};

export interface AecSemanticTaskInterpreter {
  interpret(input: AecSemanticTaskInterpretationInput): Promise<unknown | null>;
}

const stringArray = { type: "array", items: { type: "string" }, maxItems: 64 } as const;
const schema = {
  type: "object", additionalProperties: false,
  required: ["schema", "operation", "subject", "scope", "reference", "mutation", "outputs", "execution", "confidence", "evidence"],
  properties: {
    schema: { type: "string", enum: [AEC_SEMANTIC_TASK_V1_SCHEMA] },
    operation: { type: "string", enum: ["locate", "count", "list", "inspect", "compare", "focus", "layout", "place", "move", "delete", "tag", "annotate", "view", "sheet", "other"] },
    subject: {
      type: "object", additionalProperties: false,
      required: ["kind", "semantic_class", "terms", "categories", "family_name", "type_name", "system_name", "identifiers"],
      properties: {
        kind: { type: "string", enum: ["exact_identifier", "category", "class", "family", "type", "system", "room", "space", "elements", "generic"] },
        semantic_class: { type: "string", enum: ["receptacle", "light_fixture", "air_terminal", "mechanical_equipment", "electrical_equipment", "plumbing_fixture", "family_instance", "room", "space", "view", "sheet", "other"] },
        terms: stringArray, categories: stringArray,
        family_name: { type: ["string", "null"] }, type_name: { type: ["string", "null"] }, system_name: { type: ["string", "null"] },
        identifiers: {
          type: "array", maxItems: 64,
          items: { type: "object", additionalProperties: false, required: ["parameter", "value", "match"], properties: { parameter: { type: "string" }, value: { type: "string" }, match: { type: "string", enum: ["exact", "case_insensitive_exact", "contains"] } } }
        }
      }
    },
    scope: {
      type: "object", additionalProperties: false,
      required: ["kind", "document", "levels", "rooms", "spaces", "areas", "views", "sheets", "systems", "element_ids", "region"],
      properties: {
        kind: { type: "string", enum: ["document", "level", "room", "space", "area", "view", "sheet", "system", "selection", "region", "mixed", "active_context"] },
        document: { type: ["string", "null"] }, levels: stringArray, rooms: stringArray, spaces: stringArray, areas: stringArray,
        views: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: { type: ["integer", "null"] }, name: { type: ["string", "null"] } } } },
        sheets: stringArray, systems: stringArray, element_ids: { type: "array", items: { type: "integer" }, maxItems: 64 },
        region: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["frame_id", "min_u", "min_v", "max_u", "max_v"], properties: { frame_id: { type: "string" }, min_u: { type: "number" }, min_v: { type: "number" }, max_u: { type: "number" }, max_v: { type: "number" } } }] }
      }
    },
    reference: { type: "object", additionalProperties: false, required: ["strategy", "source_description", "source_room"], properties: { strategy: { type: "string", enum: ["explicit", "current_project_precedent", "office_standard", "code_baseline", "conservative_proposal", "none"] }, source_description: { type: ["string", "null"] }, source_room: { type: ["string", "null"] } } },
    mutation: { type: "object", additionalProperties: false, required: ["kind", "requested"], properties: { kind: { type: "string", enum: ["create", "move", "delete", "update", "none"] }, requested: { type: "boolean" } } },
    outputs: { type: "array", maxItems: 64, items: { type: "string", enum: ["summary", "count", "element_ids", "parameters", "spatial_context", "best_view", "comparison", "verification"] } },
    execution: { type: "object", additionalProperties: false, required: ["max_results", "max_primary_actions", "allow_document_fallback", "requires_visual_verification"], properties: { max_results: { type: "integer", minimum: 1, maximum: 500 }, max_primary_actions: { type: "integer", minimum: 1, maximum: 8 }, allow_document_fallback: { type: "boolean" }, requires_visual_verification: { type: "boolean" } } },
    confidence: { type: "object", additionalProperties: false, required: ["value", "ambiguity", "reasons"], properties: { value: { type: "number", minimum: 0, maximum: 1 }, ambiguity: { type: "string", enum: ["none", "low", "material"] }, reasons: stringArray } },
    evidence: { type: "object", additionalProperties: false, required: ["user_text"], properties: { user_text: { type: "string" } } }
  }
} as const;

const instructions = `Interpret the user's professional Revit/AEC objective into the strict semantic task record. Return facts and scope, never tool names or paths.
Understand paraphrases by meaning. Do not require trigger words. Preserve exact marks, room numbers, level names, sheet numbers, family/type names, and leading zeroes.
For a uniquely named or marked element such as AHU-1, use operation=locate or inspect, subject.kind=exact_identifier, the most likely Revit semantic_class and category, and exact Mark and/or Name identifiers. Alternative exact predicates are allowed and are evaluated as a bounded OR. Request compact identity, parameter, spatial-context, and best-view outputs, and set max_primary_actions=2 when spatial_context or best_view is requested. If the user explicitly asks to show, focus, or take them to that exact element, use operation=focus and max_primary_actions=3 so the runtime can resolve identity, resolve the best view, and activate/focus it without guessing.
Use document scope and allow_document_fallback=true only when the user explicitly requests the whole project/model. Otherwise represent the smallest explicit scope or active_context and keep fallback false.
For count/list questions, identify the requested category/class and room, level, view, sheet, system, selection, or region scope. Never invent scope values. Count normally uses one primary action. List/inspect/locate normally use max_primary_actions=2 so a compact ID-only native result can be enriched with bounded element summaries without scanning again.
For underspecified design/layout work, select the strongest supported reference strategy in this order: explicit source, current-project precedent, office standard, code baseline, conservative proposal. Put a distinct explicitly named source room in reference.source_room; otherwise keep it null. Do not manufacture an explicit source.
Plain room receptacle-layout requests are layout+receptacle+create. They normally use current_project_precedent when no source is named; discovering a suitable analog is execution work, not a reason for material ambiguity.
Tagging and other mutations require visual verification. Read operations never request mutation.
Use ambiguity=material only when a consequential target or requested mutation cannot be grounded safely. Keep max_primary_actions small (normally 1-3) and max_results bounded.`;

function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) for (const content of Array.isArray(item?.content) ? item.content : []) if (typeof content?.text === "string") return content.text;
  return "";
}

export class OpenAiAecSemanticTaskInterpreter implements AecSemanticTaskInterpreter {
  async interpret(input: AecSemanticTaskInterpretationInput): Promise<unknown | null> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) return null;
    const model = (process.env.OPERATOR_AEC_INTENT_MODEL || process.env.OPERATOR_PLANNER_MODEL || process.env.OPERATOR_OPENAI_MODEL || "gpt-5.6-sol").trim();
    const response = await createOpenAiClient(apiKey).responses.create({ model, reasoning: { effort: "medium" }, instructions, input: JSON.stringify(input), text: { format: { type: "json_schema", name: "aec_semantic_task_v1", strict: true, schema } } } as any);
    const raw = outputText(response);
    return raw ? JSON.parse(raw) : null;
  }
}

export async function interpretAecSemanticTask(req: ChatRequest, interpreter: AecSemanticTaskInterpreter = new OpenAiAecSemanticTaskInterpreter()): Promise<AecSemanticTaskV1 | null> {
  const userText = (req.user_text ?? "").trim();
  if (!userText || userText.length > AEC_SEMANTIC_TASK_MAX_TEXT_CHARS || (req.tool_results?.length ?? 0) > 0) return null;
  const recent = getRecentMessages(req.session_id, 8).filter(message => message.text.trim() && message.text.trim() !== userText).slice(-6).map(message => ({ role: message.role, text: message.text.slice(0, AEC_SEMANTIC_TASK_MAX_TEXT_CHARS) }));
  try {
    const value = await interpreter.interpret({ user_text: userText, recent_messages: recent });
    if (value === null) return null;
    const task = normalizeAecSemanticTaskV1(value, userText);
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown", task }); } catch { }
    return task;
  } catch (error) {
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task.rejected", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown", error: error instanceof Error ? error.message.slice(0, 500) : "semantic_task_interpretation_failed" }); } catch { }
    return null;
  }
}

export const __testOnlyAecSemanticTaskSchema = schema;
