import type { ChatRequest } from "./contracts.js";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";

export const SCHEDULE_CELL_UPDATE_INTENT_SCHEMA = "revit-operator.schedule-cell-update-intent.v1" as const;

export type ScheduleCellUpdateIntentV1 = {
  schema: typeof SCHEDULE_CELL_UPDATE_INTENT_SCHEMA;
  schedule_name: string | null;
  row_key: string;
  row_field: string | null;
  target_field: string;
  expected_value: string | null;
  value: string;
  confidence: { value: number; ambiguity: "none" | "low" | "material"; reasons: string[] };
  evidence: { user_text: string };
};

export interface ScheduleCellUpdateIntentInterpreter {
  interpret(input: { user_text: string }): Promise<unknown | null>;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "schedule_name", "row_key", "row_field", "target_field", "expected_value", "value", "confidence", "evidence"],
  properties: {
    schema: { type: "string", enum: [SCHEDULE_CELL_UPDATE_INTENT_SCHEMA] },
    schedule_name: { type: ["string", "null"] },
    row_key: { type: "string" },
    row_field: { type: ["string", "null"] },
    target_field: { type: "string" },
    expected_value: { type: ["string", "null"] },
    value: { type: "string" },
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

const instructions = `Extract one explicit request to update an existing Revit schedule row. Do not invent identifiers, fields, schedule names, old values, new values, or units.
row_key is the exact visible item identifier such as AHU-1, SA-3, room number, sheet number, or equipment designation.
row_field is the explicitly named identifier column (Mark, DESIG, Designation, Number, Name, etc.); keep it null when the user only supplies the identifier value.
target_field is the exact schedule column/parameter concept to change, such as Supply Air, Airflow, Name, or Cooling Capacity.
expected_value is the current/old value only when the user states it (for example the 10,000 in "from 10,000 to 20,000").
value is the requested new value. Preserve unit suffixes when supplied. Do not convert values to Revit internal units.
schedule_name is an explicitly named schedule only; phrases such as "the schedule" or "on the scheduled" do not name one.
Use ambiguity=material when the row identifier, target field, or new value is absent or when there is more than one plausible parse.`;

function nonEmpty(value: unknown, path: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 512) throw new Error(`Invalid ${path}`);
  return value.trim();
}

export function normalizeScheduleCellUpdateIntent(value: unknown, authoritativeUserText: string): ScheduleCellUpdateIntentV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid schedule cell update intent");
  const source = value as Record<string, unknown>;
  const confidence = source.confidence && typeof source.confidence === "object" && !Array.isArray(source.confidence) ? source.confidence as Record<string, unknown> : null;
  if (source.schema !== SCHEDULE_CELL_UPDATE_INTENT_SCHEMA || !confidence) throw new Error("Invalid schedule cell update intent schema");
  const confidenceValue = confidence.value;
  if (typeof confidenceValue !== "number" || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) throw new Error("Invalid schedule cell update confidence");
  if (!['none', 'low', 'material'].includes(String(confidence.ambiguity))) throw new Error("Invalid schedule cell update ambiguity");
  const reasons = Array.isArray(confidence.reasons) ? confidence.reasons.filter(item => typeof item === "string" && item.trim()).slice(0, 16).map(item => String(item).trim()) : [];
  return {
    schema: SCHEDULE_CELL_UPDATE_INTENT_SCHEMA,
    schedule_name: nonEmpty(source.schedule_name, "schedule_name", true),
    row_key: nonEmpty(source.row_key, "row_key") as string,
    row_field: nonEmpty(source.row_field, "row_field", true),
    target_field: nonEmpty(source.target_field, "target_field") as string,
    expected_value: nonEmpty(source.expected_value, "expected_value", true),
    value: nonEmpty(source.value, "value") as string,
    confidence: { value: confidenceValue, ambiguity: confidence.ambiguity as "none" | "low" | "material", reasons },
    evidence: { user_text: authoritativeUserText }
  };
}

export function looksLikeScheduleCellUpdateRequest(userText: string): boolean {
  const text = (userText ?? "").trim();
  if (!text) return false;
  return /\b(?:schedule|scheduled|schedule\s+row|schedule\s+cell)\b/i.test(text) &&
    /\b(?:change|set|update|revise|correct|edit)\b/i.test(text);
}

export function parseDirectScheduleCellUpdate(userText: string): ScheduleCellUpdateIntentV1 | null {
  const source = (userText ?? "").trim().replace(/[.?!]+$/, "");
  if (!looksLikeScheduleCellUpdateRequest(source)) return null;
  const withoutSuffix = source.replace(/\s+(?:on|in)\s+(?:the\s+)?(?:[\w &/.-]+\s+)?schedule\s*$/i, "").trim();
  const fromPattern = /^(?:please\s+)?(?:change|update|revise|correct|edit)\s+([A-Za-z0-9][A-Za-z0-9._\/-]*\d[A-Za-z0-9._\/-]*)\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+)$/i;
  const setPattern = /^(?:please\s+)?set\s+([A-Za-z0-9][A-Za-z0-9._\/-]*\d[A-Za-z0-9._\/-]*)\s+(.+?)\s+to\s+(.+)$/i;
  const from = withoutSuffix.match(fromPattern);
  const set = withoutSuffix.match(setPattern);
  const match = from ?? set;
  if (!match) return null;
  const rowKey = match[1].trim();
  const targetField = match[2].trim();
  const expectedValue = from ? match[3].trim() : null;
  const nextValue = from ? match[4].trim() : match[3].trim();
  if (!rowKey || !targetField || !nextValue) return null;
  return {
    schema: SCHEDULE_CELL_UPDATE_INTENT_SCHEMA,
    schedule_name: null,
    row_key: rowKey,
    row_field: null,
    target_field: targetField,
    expected_value: expectedValue,
    value: nextValue,
    confidence: { value: 0.99, ambiguity: "none", reasons: ["Direct bounded schedule update grammar matched."] },
    evidence: { user_text: source }
  };
}

function outputText(response: any): string {
  if (typeof response?.output_text === "string") return response.output_text;
  for (const item of Array.isArray(response?.output) ? response.output : []) for (const content of Array.isArray(item?.content) ? item.content : []) if (typeof content?.text === "string") return content.text;
  return "";
}

export class OpenAiScheduleCellUpdateIntentInterpreter implements ScheduleCellUpdateIntentInterpreter {
  async interpret(input: { user_text: string }): Promise<unknown | null> {
    const apiKey = resolveOpenAiApiKey();
    if (!apiKey) return null;
    const model = (process.env.OPERATOR_AEC_INTENT_MODEL || process.env.OPERATOR_PLANNER_MODEL || process.env.OPERATOR_OPENAI_MODEL || "gpt-5.6-sol").trim();
    const response = await createOpenAiClient(apiKey).responses.create({ model, reasoning: { effort: "medium" }, instructions, input: JSON.stringify(input), text: { format: { type: "json_schema", name: "schedule_cell_update_intent_v1", strict: true, schema } } } as any);
    const raw = outputText(response);
    return raw ? JSON.parse(raw) : null;
  }
}

export async function interpretScheduleCellUpdateIntent(req: ChatRequest, interpreter: ScheduleCellUpdateIntentInterpreter = new OpenAiScheduleCellUpdateIntentInterpreter()): Promise<ScheduleCellUpdateIntentV1 | null> {
  const delegated = (req.user_text ?? "").trim();
  const context = req.context && typeof req.context === "object" && !Array.isArray(req.context) ? req.context as Record<string, unknown> : null;
  const ui = context?.ui && typeof context.ui === "object" && !Array.isArray(context.ui) ? context.ui as Record<string, unknown> : null;
  const authoritative = typeof ui?.authoritative_user_text === "string" ? ui.authoritative_user_text.trim() : "";
  const userText = authoritative || delegated;
  if (!looksLikeScheduleCellUpdateRequest(userText) || (req.tool_results?.length ?? 0) > 0) return null;
  const direct = parseDirectScheduleCellUpdate(userText);
  if (direct) return direct;
  try {
    const parsed = await interpreter.interpret({ user_text: userText });
    return parsed === null ? null : normalizeScheduleCellUpdateIntent(parsed, userText);
  } catch {
    return null;
  }
}

export const __testOnlyScheduleCellUpdateIntentSchema = schema;
