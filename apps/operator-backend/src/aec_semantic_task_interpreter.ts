import type { ChatRequest } from "./contracts.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import { appendEvent, getRecentMessages } from "./memory/sqlite_store.js";
import { AEC_SEMANTIC_TASK_MAX_TEXT_CHARS, AEC_SEMANTIC_TASK_V1_SCHEMA, normalizeAecSemanticTaskV1, type AecSemanticTaskV1 } from "./aec_semantic_task.js";

export type AecSemanticTaskInterpretationInput = {
  user_text: string;
  delegated_task_text?: string;
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

const instructions = `Interpret the user's professional Revit/AEC objective into the strict semantic task record. Return facts and scope, never tool names or paths. user_text is the authoritative user request. delegated_task_text, when present, is model-authored planning context only: it may clarify execution ideas but must never add target levels, rooms, views, sheets, elements, or mutations absent from user_text.
Understand paraphrases by meaning. Do not require trigger words. Preserve exact marks, room numbers, level names, sheet numbers, family/type names, and leading zeroes.
For a uniquely named or marked element, preserve the exact identifier supplied by the user and use operation=locate or inspect, subject.kind=exact_identifier, the most likely Revit semantic_class and category, and exact Mark and/or Name identifiers. Do not invent an example identifier when the request does not contain one. Alternative exact predicates are allowed and are evaluated as a bounded OR. Request compact identity, parameter, spatial-context, and best-view outputs, and set max_primary_actions=2 when spatial_context or best_view is requested. If the user explicitly asks to show, focus, or take them to that exact element, use operation=focus and max_primary_actions=3 so the runtime can resolve identity, resolve the best view, and activate/focus it without guessing.
Use document scope and allow_document_fallback=true only when the user explicitly requests the whole project/model. Otherwise represent the smallest explicit scope or active_context and keep fallback false.
For count/list questions, identify the requested category/class and room, level, view, sheet, system, selection, or region scope. Never invent scope values. Count normally uses one primary action. List/inspect/locate normally use max_primary_actions=2 so a compact ID-only native result can be enriched with bounded element summaries without scanning again.
When the user names a concrete object identity that is not itself a canonical Revit category, preserve that literal noun phrase in subject.terms and use subject.kind=class with semantic_class=other unless stronger project evidence grounds a family/type. Do not replace a concrete identity such as "shock arrestors" with a guessed discipline or broad category such as plumbing_fixture; a guessed discipline may be context, but it is not an identity predicate.
Schedule discovery is a document read, not element focus. Requests such as "show me the schedules" or "show me the one for the air handlers" use operation=list, subject.kind=generic, semantic_class=view, terms that preserve "schedule" plus the requested discipline/equipment wording, document scope, no mutation, and one primary action. Do not reinterpret ordinary "show me" schedule discovery as focus or view activation unless the user supplies one exact schedule name or id and explicitly asks to open it.
For discipline-scoped view or sheet work, preserve the discipline in subject.semantic_class even though the objects being arranged are views/sheets: mechanical or HVAC uses mechanical_equipment; electrical power uses electrical_equipment; lighting uses light_fixture; plumbing uses plumbing_fixture; fire alarm uses electrical_equipment with an explicit fire-alarm term. Use semantic_class=view or sheet only when the user supplied no discipline. This structured classification drives bounded view predicates and must not be inferred later from prompt trigger words.
For an inventory comparison between exactly two rooms, levels, views, or sheets, use operation=compare, one category/class subject with canonical categories, the single scope kind containing exactly two resolved values, outputs limited to summary/count/element_ids/comparison, and max_primary_actions=2. Do not use this shape for parameter, geometry, or qualitative design comparisons.
For underspecified design/layout work, select the strongest supported reference strategy in this order: explicit source, current-project precedent, office standard, code baseline, conservative proposal. Put a distinct explicitly named source room in reference.source_room; otherwise keep it null. Do not manufacture an explicit source. Mutation scope contains only the target to be changed; precedent levels, rooms, sheets, and views belong in reference.source_description and must not be copied into scope. A named active project is context, not document-wide mutation scope, so keep scope.document null unless the user explicitly requests the whole document. Scope kind describes concrete target identifiers supplied by the user, not the kinds of objects execution must later discover. For example, work across applicable views and sheets on target Level 4 using Level 3/Level 5 or M103/M105 as precedent is scope.kind=level, levels=["Level 4"], sheets=[], document=null; the precedent identifiers remain only in reference.source_description. Use mixed only when the user explicitly targets at least two different concrete scope fields for mutation.
reference.source_description may describe the grounded explicit source, current-project precedent, office standard, code baseline, or conservative proposal. Keep it null only when no reference evidence is available; strategy=none requires null.
Plain room receptacle-layout requests are layout+receptacle+create. They normally use current_project_precedent when no source is named; discovering a suitable analog is execution work, not a reason for material ambiguity.
Tagging and other mutations require visual verification. Read operations never request mutation.
Use ambiguity=material only when a consequential target or requested mutation cannot be grounded safely. Keep max_primary_actions small (normally 1-3) and max_results bounded.`;

function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) for (const content of Array.isArray(item?.content) ? item.content : []) if (typeof content?.text === "string") return content.text;
  return "";
}

function canonicalizeProviderScopeDiscriminant(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const rawScope = root.scope;
  if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) return value;
  const scope = rawScope as Record<string, unknown>;
  if (scope.kind !== "mixed") return value;
  const selected = [
    typeof scope.document === "string" && scope.document.trim() ? "document" : null,
    Array.isArray(scope.levels) && scope.levels.length ? "level" : null,
    Array.isArray(scope.rooms) && scope.rooms.length ? "room" : null,
    Array.isArray(scope.spaces) && scope.spaces.length ? "space" : null,
    Array.isArray(scope.areas) && scope.areas.length ? "area" : null,
    Array.isArray(scope.views) && scope.views.length ? "view" : null,
    Array.isArray(scope.sheets) && scope.sheets.length ? "sheet" : null,
    Array.isArray(scope.systems) && scope.systems.length ? "system" : null,
    Array.isArray(scope.element_ids) && scope.element_ids.length ? "selection" : null,
    scope.region && typeof scope.region === "object" ? "region" : null
  ].filter((kind): kind is string => !!kind);
  return selected.length === 1 ? { ...root, scope: { ...scope, kind: selected[0] } } : value;
}

function deterministicScheduleInventoryTask(userText: string): AecSemanticTaskV1 | null {
  if (!/\bschedules?\b/i.test(userText)) return null;
  if (!/\b(?:show|list|find|identify|inspect|display|what|which)\b/i.test(userText)) return null;
  if (/\b(?:edit|change|update|replace|set|delete|remove|create|add|rename|configure|move|place|resize|reorder)\b/i.test(userText)) return null;
  const terms = ["schedule"];
  if (/\b(?:ahu|air\s+handlers?|air[- ]handling\s+units?)\b/i.test(userText)) terms.push("air handlers");
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "list",
    subject: { kind: "generic", semantic_class: "view", terms, categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "document", document: "current model", levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "none", requested: false },
    outputs: ["summary"],
    execution: { max_results: 500, max_primary_actions: 1, allow_document_fallback: true, requires_visual_verification: false },
    confidence: { value: 0.99, ambiguity: "none", reasons: ["Explicit read-only schedule inventory request."] },
    evidence: { user_text: userText }
  };
}

function isMutationImpactPreflightRequest(userText: string): boolean {
  const text = userText.trim();
  if (!/\b(?:delete|deleting|deleted|remove|removing|removed|removal|demolish|demolition|take\s+out)\b/i.test(text)) return false;
  return /\b(?:deletion|delete|removal|remove)\s*[- ]?(?:impact|preflight|preview|dry\s*[- ]?run)\b/i.test(text)
    || /\b(?:show|tell|list|preview|check|confirm|explain)\b[^.!?]{0,160}\b(?:what|which|everything)\b[^.!?]{0,80}\b(?:would\s+be\s+)?(?:affected|impacted|deleted|disconnected)\b/i.test(text)
    || /\b(?:what|which|everything)\b[^.!?]{0,120}\b(?:would\s+be\s+)?(?:affected|impacted|deleted|disconnected)\b[^.!?]{0,80}\bbefore\s+(?:deleting|removing)\b/i.test(text);
}

export function deterministicNamedObjectTopologyTask(userText: string): AecSemanticTaskV1 | null {
  const text = userText.trim();
  if (!text || text.length > AEC_SEMANTIC_TASK_MAX_TEXT_CHARS) return null;

  // Negative write constraints are common in read-only requests and must not be
  // mistaken for requested mutations. Any remaining write verb fails closed.
  const mutationCheck = text.replace(
    /\b(?:do\s+not|don't|dont|without)\s+(?:change|modify|edit|update|delete|remove|create|add|move|write)(?:\s+(?:anything|the\s+model|the\s+revit\s+model))?/gi,
    ""
  );
  if (/\b(?:please\s+)?(?:change|modify|edit|update|delete|remove|create|add|move|replace|resize|reroute|write)\b/i.test(mutationCheck)) return null;
  if (/^\s*(?:please\s+)?(?:connect|disconnect)\b/i.test(mutationCheck) || /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:connect|disconnect)\b/i.test(mutationCheck)) return null;

  const patterns = [
    /\bwhat\s+(?:is|are)\s+(?:the\s+)?(.{2,128}?)\s+connected\s+to\b/i,
    /\bwhat\s+(?:does|do)\s+(?:the\s+)?(.{2,128}?)\s+connect\s+to\b/i,
    /\b(?:which|what)\s+(?:pipe\s+|duct\s+|mep\s+|electrical\s+|mechanical\s+)?systems?\s+(?:is|are)\s+(?:the\s+)?(.{2,128}?)\s+connected\s+to\b/i,
    /\b(?:show|summarize|inspect|trace)\s+(?:the\s+)?(.{2,128}?)\s+(?:connectors?|connections?|topology)\b/i,
    /\b(?:are|is)\s+(?:any\s+)?(?:the\s+)?(.{2,128}?)\s+(?:unconnected|disconnected)\b/i
  ];
  const match = patterns.map(pattern => pattern.exec(text)).find((candidate): candidate is RegExpExecArray => candidate !== null);
  if (!match) return null;
  const identity = (match[1] ?? "")
    .replace(/^\s*(?:all|each|every|any)\s+/i, "")
    .replace(/[\s,;:.!?]+$/g, "")
    .trim();
  if (identity.length < 2 || identity.length > 128 || /^(?:it|they|them|these|those|this|that|anything|everything|something)$/i.test(identity)) return null;

  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: "inspect",
    subject: { kind: "class", semantic_class: "other", terms: [identity.toLocaleLowerCase()], categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: "active_context", document: null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "none", requested: false },
    outputs: ["summary", "count", "element_ids", "parameters"],
    execution: { max_results: 500, max_primary_actions: 2, allow_document_fallback: false, requires_visual_verification: false },
    confidence: { value: 0.99, ambiguity: "none", reasons: ["Explicit read-only named-object connector topology question."] },
    evidence: { user_text: text }
  };
}

function deterministicShockArrestorTask(userText: string): AecSemanticTaskV1 | null {
  const identityMatch = userText.match(/\bshock\s+(?:arrest(?:e|o)?rs?|absorbers?)\b/i);
  if (!identityMatch) return null;
  if (/\b(?:edit|change|update|replace|set|delete|remove|create|add|rename|configure|move|place|resize)\b/i.test(userText)) return null;
  if (!/\b(?:find|identify|inspect|list|locate|where|what|tell|show)\b/i.test(userText)) return null;
  const wantsSpatial = /\b(?:where|located?|locations?|rooms?|spaces?|positions?|coordinates?|levels?|floors?|zones?)\b/i.test(userText);
  const explicitDocument = /\b(?:all|each|every)\b/i.test(userText) || /\b(?:this|current|whole|entire)\s+(?:project|model|document)\b/i.test(userText);
  const identity = identityMatch[0].trim().toLocaleLowerCase();
  return {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: wantsSpatial ? "locate" : "inspect",
    subject: { kind: "class", semantic_class: "other", terms: [identity], categories: [], family_name: null, type_name: null, system_name: null, identifiers: [] },
    scope: { kind: explicitDocument ? "document" : "active_context", document: explicitDocument ? "current model" : null, levels: [], rooms: [], spaces: [], areas: [], views: [], sheets: [], systems: [], element_ids: [], region: null },
    reference: { strategy: "none", source_description: null, source_room: null },
    mutation: { kind: "none", requested: false },
    outputs: wantsSpatial ? ["summary", "count", "element_ids", "spatial_context"] : ["summary", "count", "element_ids", "parameters"],
    execution: { max_results: 500, max_primary_actions: 2, allow_document_fallback: explicitDocument, requires_visual_verification: false },
    confidence: { value: 0.99, ambiguity: "none", reasons: ["Explicit named-object read request; literal identity preserved."] },
    evidence: { user_text: userText }
  };
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
  const delegatedText = (req.user_text ?? "").trim();
  const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
  const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
  const authoritativeText = typeof ui?.authoritative_user_text === "string" ? ui.authoritative_user_text.trim() : "";
  const userText = authoritativeText || delegatedText;
  if (!userText || userText.length > AEC_SEMANTIC_TASK_MAX_TEXT_CHARS || (req.tool_results?.length ?? 0) > 0) return null;
  // A deletion-impact preview is mutation-adjacent work even when the user
  // explicitly forbids the eventual write. Keep it out of the read-only query
  // shortcut so the normal agent can ground the active view/selection and run
  // an exact /revit/delete dry-run instead of widening to document inventory.
  if (isMutationImpactPreflightRequest(userText)) {
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task.skipped_mutation_preflight", { message_id: req.message_id, user_text: userText }); } catch { }
    return null;
  }
  const deterministicShockTask = deterministicShockArrestorTask(userText);
  const deterministicScheduleTask = deterministicScheduleInventoryTask(userText);
  const deterministicTopologyTask = deterministicNamedObjectTopologyTask(userText);
  if (deterministicScheduleTask) {
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task", { message_id: req.message_id, interpreter: "deterministic.schedule_inventory", task: deterministicScheduleTask }); } catch { }
    return deterministicScheduleTask;
  }
  if (deterministicTopologyTask) {
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task", { message_id: req.message_id, interpreter: "deterministic.named_object_topology", task: deterministicTopologyTask }); } catch { }
    return deterministicTopologyTask;
  }
  const recent = getRecentMessages(req.session_id, 8).filter(message => message.text.trim() && message.text.trim() !== userText && message.text.trim() !== delegatedText).slice(-6).map(message => ({ role: message.role, text: message.text.slice(0, AEC_SEMANTIC_TASK_MAX_TEXT_CHARS) }));
  try {
    const value = await interpreter.interpret({ user_text: userText, ...(delegatedText && delegatedText !== userText ? { delegated_task_text: delegatedText } : {}), recent_messages: recent });
    if (value === null && !deterministicShockTask) return null;
    const interpretedTask = value === null ? null : normalizeAecSemanticTaskV1(canonicalizeProviderScopeDiscriminant(value), userText);
    const preservesShockIdentity = interpretedTask !== null && interpretedTask.subject.kind !== "category" && interpretedTask.subject.terms.some(term => /\bshock\s+(?:arrest(?:e|o)?rs?|absorbers?)\b/i.test(term));
    const task = deterministicShockTask && !preservesShockIdentity ? deterministicShockTask : interpretedTask;
    if (!task) return null;
    const interpreterName = task === deterministicShockTask ? "deterministic.named_object_guard" : interpreter.constructor?.name || "unknown";
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task", { message_id: req.message_id, interpreter: interpreterName, task }); } catch { }
    return task;
  } catch (error) {
    try { appendEvent(req.session_id, "assistant", "aec.semantic_task.rejected", { message_id: req.message_id, interpreter: interpreter.constructor?.name || "unknown", error: error instanceof Error ? error.message.slice(0, 500) : "semantic_task_interpretation_failed" }); } catch { }
    return null;
  }
}

export const __testOnlyAecSemanticTaskSchema = schema;
