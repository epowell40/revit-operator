import type { ChatRequest } from "./contracts.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";

export const SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA = "revit-operator.schedule-value-replacement-intent.v1" as const;

export type ScheduleValueReplacementIntentV1 = {
  schema: typeof SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA;
  sheet_numbers: string[];
  schedule_query: string | null;
  schedule_name_all_terms: string[];
  field_names: string[];
  find: string;
  replace: string;
  expected_value: string | null;
  max_changes: number | null;
  confidence: { value: number; ambiguity: "none" | "low" | "material"; reasons: string[] };
  evidence: { user_text: string };
};

export interface ScheduleValueReplacementIntentInterpreter {
  interpret(input: { user_text: string }): Promise<unknown | null>;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "sheet_numbers", "schedule_query", "schedule_name_all_terms", "field_names", "find", "replace", "expected_value", "max_changes", "confidence", "evidence"],
  properties: {
    schema: { type: "string", enum: [SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA] },
    sheet_numbers: { type: "array", maxItems: 50, items: { type: "string" } },
    schedule_query: { type: ["string", "null"] },
    schedule_name_all_terms: { type: "array", maxItems: 10, items: { type: "string" } },
    field_names: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
    find: { type: "string" },
    replace: { type: "string" },
    expected_value: { type: ["string", "null"] },
    max_changes: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["value", "ambiguity", "reasons"],
      properties: {
        value: { type: "number", minimum: 0, maximum: 1 },
        ambiguity: { type: "string", enum: ["none", "low", "material"] },
        reasons: { type: "array", maxItems: 16, items: { type: "string" } }
      }
    },
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["user_text"],
      properties: { user_text: { type: "string" } }
    }
  }
} as const;

const instructions = `Extract one explicit Revit request to replace a literal substring in schedule-backed values on explicit sheet numbers or in one explicitly named schedule class.
Do not invent sheets, schedule names, fields, find text, replacement text, exact old values, or limits.
sheet_numbers are only explicitly named drawing sheet numbers such as P6.01.
When the user names a schedule class but no sheet number, set schedule_query to the narrow literal schedule-name query and schedule_name_all_terms to every word that must occur in a matching schedule name. Otherwise set schedule_query=null and schedule_name_all_terms=[].
For a fire damper schedule request, use schedule_query="damper" and schedule_name_all_terms=["fire","damper"] so pure smoke-damper or unrelated equipment schedules are excluded.
field_names are the explicitly named schedule column/parameter concepts. For DESIG/designation requests return ["DESIG","Designation"]; include "Mark" only when the user explicitly permits the tag/mark identification field.
find and replace are the exact literal substring pair.
For an explicit one-item test with an exact old designation, set expected_value to that full old value and max_changes to 1. Otherwise keep both null.
Use ambiguity=material unless one bounded scope (explicit sheets or an explicit schedule class), one field concept, and the exact find/replace pair are present.`;

function sourceText(req: ChatRequest): string {
  const delegated = (req.user_text ?? "").trim();
  const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
  const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
  const authoritative = typeof ui?.authoritative_user_text === "string" ? ui.authoritative_user_text.trim() : "";
  return authoritative || delegated;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function looksLikeScheduleValueReplacementRequest(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (!text || !/\b(?:schedule|schedules|scheduled|sheet|sheets)\b/i.test(text)) return false;
  if (!/\b(?:replace|rename|change|update|correct|edit)\b/i.test(text)) return false;
  return /\b(?:designation|desig)\b/i.test(text) && /-[A-Za-z0-9]+-/.test(text);
}

function quotedDashTokens(text: string): string[] {
  const output: string[] = [];
  for (const match of text.matchAll(/(["'])(-[A-Za-z0-9]+-)\1/g)) {
    if (match[2] && !output.includes(match[2])) output.push(match[2]);
  }
  return output;
}

function exactOldDesignation(text: string, find: string): string | null {
  const candidates = [...text.matchAll(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}\b/g)]
    .map(match => match[0])
    .filter(value => value.includes(find));
  return unique(candidates)[0] ?? null;
}

export function parseDirectScheduleValueReplacement(userText: string): ScheduleValueReplacementIntentV1 | null {
  const source = (userText ?? "").trim();
  if (!looksLikeScheduleValueReplacementRequest(source)) return null;
  const sheets = unique([...source.matchAll(/\b[A-Z]{1,4}\d{1,4}\.\d{1,4}\b/gi)].map(match => match[0]!.toUpperCase()));
  const tokens = quotedDashTokens(source);
  const fireDamperSchedule = /\bfire(?:\s*(?:\/|&|\band\b)\s*smoke)?\s+dampers?\b/i.test(source) && /\bschedules?\b/i.test(source);
  if ((sheets.length === 0 && !fireDamperSchedule) || tokens.length < 2 || tokens[0] === tokens[1]) return null;
  const single = /\b(?:one|single|only one|one-item|one item|safe test)\b/i.test(source);
  const expectedValue = single ? exactOldDesignation(source, tokens[0]!) : null;
  const markPermitted = /\b(?:tag|mark)\b/i.test(source);
  return {
    schema: SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA,
    sheet_numbers: sheets,
    schedule_query: fireDamperSchedule && sheets.length === 0 ? "damper" : null,
    schedule_name_all_terms: fireDamperSchedule && sheets.length === 0 ? ["fire", "damper"] : [],
    field_names: markPermitted ? ["DESIG", "Designation", "Mark"] : ["DESIG", "Designation"],
    find: tokens[0]!,
    replace: tokens[1]!,
    expected_value: expectedValue,
    max_changes: single ? 1 : null,
    confidence: {
      value: expectedValue || !single ? 0.99 : 0.7,
      ambiguity: single && !expectedValue ? "material" : "none",
      reasons: [single
        ? "Explicit one-item schedule replacement grammar matched."
        : fireDamperSchedule && sheets.length === 0
          ? "Explicit fire-damper schedule replacement grammar matched."
          : "Explicit sheet-scoped literal schedule replacement grammar matched."]
    },
    evidence: { user_text: source }
  };
}

function nonEmpty(value: unknown, path: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`Invalid ${path}`);
  return value.trim();
}

export function normalizeScheduleValueReplacementIntent(value: unknown, authoritativeUserText: string): ScheduleValueReplacementIntentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schedule value replacement intent");
  const source = value as Record<string, unknown>;
  const confidence = source.confidence && typeof source.confidence === "object" && !Array.isArray(source.confidence) ? source.confidence as Record<string, unknown> : null;
  if (source.schema !== SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA || !confidence) throw new Error("Invalid schedule value replacement intent schema");
  const sheetNumbers = unique(Array.isArray(source.sheet_numbers) ? source.sheet_numbers.filter(item => typeof item === "string").map(String) : []).slice(0, 50);
  const scheduleQuery = nonEmpty(source.schedule_query, "schedule_query", true);
  const scheduleNameAllTerms = unique(Array.isArray(source.schedule_name_all_terms) ? source.schedule_name_all_terms.filter(item => typeof item === "string").map(String) : []).slice(0, 10);
  const fieldNames = unique(Array.isArray(source.field_names) ? source.field_names.filter(item => typeof item === "string").map(String) : []).slice(0, 20);
  const find = nonEmpty(source.find, "find") as string;
  const replace = typeof source.replace === "string" && source.replace.length <= 512 ? source.replace : (() => { throw new Error("Invalid replace"); })();
  if ((sheetNumbers.length === 0 && (!scheduleQuery || scheduleNameAllTerms.length === 0)) || fieldNames.length === 0 || find === replace) throw new Error("Incomplete schedule value replacement intent");
  const confidenceValue = confidence.value;
  if (typeof confidenceValue !== "number" || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) throw new Error("Invalid confidence");
  const ambiguity = String(confidence.ambiguity);
  if (!["none", "low", "material"].includes(ambiguity)) throw new Error("Invalid ambiguity");
  const reasons = Array.isArray(confidence.reasons) ? confidence.reasons.filter(item => typeof item === "string" && item.trim()).slice(0, 16).map(item => String(item).trim()) : [];
  const maxChanges = source.max_changes === null ? null : typeof source.max_changes === "number" && Number.isInteger(source.max_changes) && source.max_changes >= 1 && source.max_changes <= 10000 ? source.max_changes : (() => { throw new Error("Invalid max_changes"); })();
  return {
    schema: SCHEDULE_VALUE_REPLACEMENT_INTENT_SCHEMA,
    sheet_numbers: sheetNumbers,
    schedule_query: scheduleQuery,
    schedule_name_all_terms: scheduleNameAllTerms,
    field_names: fieldNames,
    find,
    replace,
    expected_value: nonEmpty(source.expected_value, "expected_value", true),
    max_changes: maxChanges,
    confidence: { value: confidenceValue, ambiguity: ambiguity as "none" | "low" | "material", reasons },
    evidence: { user_text: authoritativeUserText }
  };
}

function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) for (const content of Array.isArray(item?.content) ? item.content : []) if (typeof content?.text === "string") return content.text;
  return "";
}

export class OpenAiScheduleValueReplacementIntentInterpreter implements ScheduleValueReplacementIntentInterpreter {
  async interpret(input: { user_text: string }): Promise<unknown | null> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) return null;
    const model = (process.env.OPERATOR_AEC_INTENT_MODEL || process.env.OPERATOR_PLANNER_MODEL || process.env.OPERATOR_OPENAI_MODEL || "gpt-5.6-sol").trim();
    const response = await createOpenAiClient(apiKey).responses.create({ model, reasoning: { effort: "medium" }, instructions, input: JSON.stringify(input), text: { format: { type: "json_schema", name: "schedule_value_replacement_intent_v1", strict: true, schema } } } as any);
    const raw = outputText(response);
    return raw ? JSON.parse(raw) : null;
  }
}

export async function interpretScheduleValueReplacementIntent(req: ChatRequest, interpreter: ScheduleValueReplacementIntentInterpreter = new OpenAiScheduleValueReplacementIntentInterpreter()): Promise<ScheduleValueReplacementIntentV1 | null> {
  const userText = sourceText(req);
  if (!looksLikeScheduleValueReplacementRequest(userText) || (req.tool_results?.length ?? 0) > 0) return null;
  const direct = parseDirectScheduleValueReplacement(userText);
  if (direct) return direct;
  try {
    const parsed = await interpreter.interpret({ user_text: userText });
    return parsed === null ? null : normalizeScheduleValueReplacementIntent(parsed, userText);
  } catch {
    return null;
  }
}

export const __testOnlyScheduleValueReplacementIntentSchema = schema;
