export const AEC_INTENT_EVIDENCE_V1_SCHEMA = "revit-operator.aec-intent-evidence.v1" as const;
export const AEC_INTENT_EVIDENCE_MAX_STRING_CHARS = 4_000;
export const AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS = 512;
export const AEC_INTENT_EVIDENCE_MAX_URI_CHARS = 2_048;
export const AEC_INTENT_EVIDENCE_MAX_HASH_CHARS = 256;
export const AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS = 1_000;
type TargetStatus = "resolved" | "ambiguous" | "unresolved";
type Gate = "dry_run" | "apply" | "readback" | "visual" | "revert";
type Id = string | number;

export type AecIntentEvidenceV1 = {
  schema: typeof AEC_INTENT_EVIDENCE_V1_SCHEMA; id: string; revision: number; created_at: string;
  correlation: { session_id?: string; goal_id?: string; run_id?: string; request_id?: string };
  origin: { host: { kind: "operator" | "codex" | "claude" | "other"; name?: string; version?: string }; producer: { kind: "deterministic" | "provider" | "bridge" | "user"; name: string; version?: string }; provider?: { name: string; model?: string; request_id?: string } };
  evidence: Array<{ id: string; kind: "pdf_annotation" | "pdf_page" | "image" | "sheet_region" | "view_frame" | "revit_readback" | "user_text" | "tool_result" | "other"; source: { kind: "request" | "adapter" | "provider" | "bridge"; field: string }; text?: string; text_truncated?: boolean; uri?: string; sha256?: string; captured_at?: string; page?: { number: number; label?: string; normalized_box?: { min_x: number; min_y: number; max_x: number; max_y: number } }; frame?: { id?: string; view_id?: Id; coordinate_frame: string; units: string }; confidence?: number }>;
  coordinate_frames: Array<{ id: string; kind: "pdf_page_normalized" | "image_pixel" | "sheet_uv" | "revit_view" | "revit_model" | "other"; units: "normalized" | "px" | "ft" | "in" | "mm" | "unknown"; transform_evidence_ids?: string[] }>;
  target: { status: TargetStatus; document?: { id?: string; path?: string; fingerprint?: string }; sheet?: { number?: string; id?: Id }; view?: { id?: Id; name?: string; frame_id?: string }; location?: { level?: string; room_or_space?: string; element_ids?: Id[] } };
  intent: { domain: "mep" | "redline" | "spatial" | "other"; action: string; proposed_actions: Array<{ tool: string; body: Record<string, unknown>; requires_apply: boolean }> };
  constraints: string[]; assumptions: string[]; open_questions: string[];
  confidence: { value: number; basis: "deterministic" | "provider" | "mixed"; reasons: string[] };
  verification: { required: Gate[]; observed: Array<{ gate: Gate; status: "pass" | "fail" | "uncertain" | "not_run"; evidence_ids?: string[]; reason?: string }> }; supersedes?: string;
};
export type AecIntentEvidenceValidation = { ok: true; value: AecIntentEvidenceV1 } | { ok: false; errors: string[] };

const gates = new Set<Gate>(["dry_run", "apply", "readback", "visual", "revert"]);
const statuses = new Set<TargetStatus>(["resolved", "ambiguous", "unresolved"]);
const evidenceKinds = new Set<AecIntentEvidenceV1["evidence"][number]["kind"]>(["pdf_annotation", "pdf_page", "image", "sheet_region", "view_frame", "revit_readback", "user_text", "tool_result", "other"]);
const frameKinds = new Set(["pdf_page_normalized", "image_pixel", "sheet_uv", "revit_view", "revit_model", "other"]);
const frameUnits = new Set(["normalized", "px", "ft", "in", "mm", "unknown"]);
const hostKinds = new Set(["operator", "codex", "claude", "other"]);
const producerKinds = new Set(["deterministic", "provider", "bridge", "user"]);
const sourceKinds = new Set(["request", "adapter", "provider", "bridge"]);

function fail(label: string): never { throw new Error(`${label} is invalid.`); }
function deepJson(value: unknown, label: string): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { if (value.length > AEC_INTENT_EVIDENCE_MAX_STRING_CHARS) fail(`${label} exceeds ${AEC_INTENT_EVIDENCE_MAX_STRING_CHARS} characters`); return value; }
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`); return value; }
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") fail(`${label} contains a non-JSON value`);
  if (Array.isArray(value)) {
    if (value.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail(`${label} exceeds ${AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS} items`);
    const keys = Reflect.ownKeys(value); if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key))) || Object.keys(value).length !== value.length) fail(`${label} must be a dense JSON array`);
    return value.map((item, index) => deepJson(item, `${label}[${index}]`));
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain JSON object`);
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(`${label}.${key} must be an enumerable JSON property`);
    out[key] = deepJson(descriptor.value, `${label}.${key}`);
  }
  return out;
}
function object(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object`); return value as Record<string, unknown>; }
function requiredString(value: unknown, label: string, max = AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS): string { if (typeof value !== "string" || !value.trim() || value.length > max) fail(label); return value; }
function optionalString(source: Record<string, unknown>, key: string, label: string, max = AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS, empty = false): string | undefined { const value = source[key]; if (value === undefined) return undefined; if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) fail(`${label}.${key}`); return value; }
function finite(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value)) fail(label); return value; }
function id(value: unknown, label: string): Id { return typeof value === "string" ? requiredString(value, label) : finite(value, label); }
function optionalId(source: Record<string, unknown>, key: string, label: string): Id | undefined { return source[key] === undefined ? undefined : id(source[key], `${label}.${key}`); }
function stringArray(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail(label); return value.map((item, index) => requiredString(item, `${label}[${index}]`, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS)); }
function optionalStringFields(source: Record<string, unknown>, label: string, keys: string[], max = AEC_INTENT_EVIDENCE_MAX_IDENTIFIER_CHARS): Record<string, string> { const out: Record<string, string> = {}; for (const key of keys) { const value = optionalString(source, key, label, max); if (value !== undefined) out[key] = value; } return out; }
function utc(value: unknown, label: string): string {
  const input = requiredString(value, label, 32); const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(input); if (!match) fail(`${label} must be a canonical UTC timestamp`);
  const [year, month, day, hour, minute, second, millisecond] = match.slice(1).map((part, index) => index === 6 && part === undefined ? 0 : Number(part)); const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second || date.getUTCMilliseconds() !== millisecond) fail(`${label} must be calendar-correct UTC`);
  return input;
}
function put(key: string, value: unknown): Record<string, unknown> { return value === undefined ? {} : { [key]: value }; }

export function normalizeAecIntentEvidenceV1(input: unknown): AecIntentEvidenceV1 {
  const source = object(deepJson(input, "AecIntentEvidenceV1"), "AecIntentEvidenceV1");
  if (source.schema !== AEC_INTENT_EVIDENCE_V1_SCHEMA) fail("Unsupported AecIntentEvidenceV1 schema");
  const revision = finite(source.revision, "AecIntentEvidenceV1.revision"); if (!Number.isInteger(revision) || revision < 1) fail("AecIntentEvidenceV1.revision");
  const correlation = optionalStringFields(object(source.correlation, "AecIntentEvidenceV1.correlation"), "AecIntentEvidenceV1.correlation", ["session_id", "goal_id", "run_id", "request_id"]);
  const origin = object(source.origin, "AecIntentEvidenceV1.origin"), host = object(origin.host, "AecIntentEvidenceV1.origin.host"), producer = object(origin.producer, "AecIntentEvidenceV1.origin.producer");
  if (typeof host.kind !== "string" || !hostKinds.has(host.kind)) fail("AecIntentEvidenceV1.origin.host.kind"); if (typeof producer.kind !== "string" || !producerKinds.has(producer.kind)) fail("AecIntentEvidenceV1.origin.producer.kind");
  const provider = origin.provider === undefined ? undefined : (() => { const item = object(origin.provider, "AecIntentEvidenceV1.origin.provider"); return { name: requiredString(item.name, "AecIntentEvidenceV1.origin.provider.name"), ...put("model", optionalString(item, "model", "AecIntentEvidenceV1.origin.provider")), ...put("request_id", optionalString(item, "request_id", "AecIntentEvidenceV1.origin.provider")) }; })();
  if (!Array.isArray(source.evidence) || source.evidence.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail("AecIntentEvidenceV1.evidence");
  const evidence = source.evidence.map((raw, index) => { const label = `AecIntentEvidenceV1.evidence[${index}]`, item = object(raw, label), sourceItem = object(item.source, `${label}.source`); if (typeof item.kind !== "string" || !evidenceKinds.has(item.kind as any) || typeof sourceItem.kind !== "string" || !sourceKinds.has(sourceItem.kind)) fail(label); const confidence = item.confidence === undefined ? undefined : finite(item.confidence, `${label}.confidence`); if (confidence !== undefined && (confidence < 0 || confidence > 1)) fail(`${label}.confidence`); if (item.text_truncated !== undefined && typeof item.text_truncated !== "boolean") fail(`${label}.text_truncated`);
    const page = item.page === undefined ? undefined : (() => { const p = object(item.page, `${label}.page`), number = finite(p.number, `${label}.page.number`); if (!Number.isInteger(number) || number < 1) fail(`${label}.page.number`); const box = p.normalized_box === undefined ? undefined : (() => { const b = object(p.normalized_box, `${label}.page.normalized_box`), min_x = finite(b.min_x, `${label}.page.normalized_box.min_x`), min_y = finite(b.min_y, `${label}.page.normalized_box.min_y`), max_x = finite(b.max_x, `${label}.page.normalized_box.max_x`), max_y = finite(b.max_y, `${label}.page.normalized_box.max_y`); if ([min_x, min_y, max_x, max_y].some((n) => n < 0 || n > 1) || min_x > max_x || min_y > max_y) fail(`${label}.page.normalized_box`); return { min_x, min_y, max_x, max_y }; })(); return { number, ...put("label", optionalString(p, "label", `${label}.page`)), ...put("normalized_box", box) }; })();
    const frame = item.frame === undefined ? undefined : (() => { const f = object(item.frame, `${label}.frame`); return { ...put("id", optionalString(f, "id", `${label}.frame`)), ...put("view_id", optionalId(f, "view_id", `${label}.frame`)), coordinate_frame: requiredString(f.coordinate_frame, `${label}.frame.coordinate_frame`), units: requiredString(f.units, `${label}.frame.units`) }; })();
    return { id: requiredString(item.id, `${label}.id`), kind: item.kind as AecIntentEvidenceV1["evidence"][number]["kind"], source: { kind: sourceItem.kind as any, field: requiredString(sourceItem.field, `${label}.source.field`) }, ...put("text", optionalString(item, "text", label, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, true)), ...put("text_truncated", item.text_truncated), ...put("uri", optionalString(item, "uri", label, AEC_INTENT_EVIDENCE_MAX_URI_CHARS, true)), ...put("sha256", optionalString(item, "sha256", label, AEC_INTENT_EVIDENCE_MAX_HASH_CHARS)), ...put("captured_at", item.captured_at === undefined ? undefined : utc(item.captured_at, `${label}.captured_at`)), ...put("page", page), ...put("frame", frame), ...put("confidence", confidence) };
  });
  if (!Array.isArray(source.coordinate_frames) || source.coordinate_frames.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail("AecIntentEvidenceV1.coordinate_frames");
  const coordinate_frames = source.coordinate_frames.map((raw, index) => { const label = `AecIntentEvidenceV1.coordinate_frames[${index}]`, item = object(raw, label); if (typeof item.kind !== "string" || !frameKinds.has(item.kind) || typeof item.units !== "string" || !frameUnits.has(item.units)) fail(label); return { id: requiredString(item.id, `${label}.id`), kind: item.kind as AecIntentEvidenceV1["coordinate_frames"][number]["kind"], units: item.units as AecIntentEvidenceV1["coordinate_frames"][number]["units"], ...put("transform_evidence_ids", item.transform_evidence_ids === undefined ? undefined : stringArray(item.transform_evidence_ids, `${label}.transform_evidence_ids`)) }; });
  const target = object(source.target, "AecIntentEvidenceV1.target"); if (typeof target.status !== "string" || !statuses.has(target.status as TargetStatus)) fail("AecIntentEvidenceV1.target.status");
  const document = target.document === undefined ? undefined : optionalStringFields(object(target.document, "AecIntentEvidenceV1.target.document"), "AecIntentEvidenceV1.target.document", ["id", "path", "fingerprint"], AEC_INTENT_EVIDENCE_MAX_URI_CHARS);
  const sheet = target.sheet === undefined ? undefined : (() => { const item = object(target.sheet, "AecIntentEvidenceV1.target.sheet"); return { ...put("number", optionalString(item, "number", "AecIntentEvidenceV1.target.sheet")), ...put("id", optionalId(item, "id", "AecIntentEvidenceV1.target.sheet")) }; })();
  const view = target.view === undefined ? undefined : (() => { const item = object(target.view, "AecIntentEvidenceV1.target.view"); return { ...put("id", optionalId(item, "id", "AecIntentEvidenceV1.target.view")), ...put("name", optionalString(item, "name", "AecIntentEvidenceV1.target.view")), ...put("frame_id", optionalString(item, "frame_id", "AecIntentEvidenceV1.target.view")) }; })();
  const location = target.location === undefined ? undefined : (() => { const item = object(target.location, "AecIntentEvidenceV1.target.location"), ids = item.element_ids === undefined ? undefined : (() => { if (!Array.isArray(item.element_ids) || item.element_ids.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail("AecIntentEvidenceV1.target.location.element_ids"); return item.element_ids.map((entry, i) => id(entry, `AecIntentEvidenceV1.target.location.element_ids[${i}]`)); })(); return { ...optionalStringFields(item, "AecIntentEvidenceV1.target.location", ["level", "room_or_space"]), ...put("element_ids", ids) }; })();
  const intent = object(source.intent, "AecIntentEvidenceV1.intent"); if (typeof intent.domain !== "string" || !["mep", "redline", "spatial", "other"].includes(intent.domain) || !Array.isArray(intent.proposed_actions) || intent.proposed_actions.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS) fail("AecIntentEvidenceV1.intent");
  const proposed_actions = intent.proposed_actions.map((raw, index) => { const item = object(raw, `AecIntentEvidenceV1.intent.proposed_actions[${index}]`); if (typeof item.requires_apply !== "boolean") fail(`AecIntentEvidenceV1.intent.proposed_actions[${index}].requires_apply`); return { tool: requiredString(item.tool, `AecIntentEvidenceV1.intent.proposed_actions[${index}].tool`, AEC_INTENT_EVIDENCE_MAX_URI_CHARS), body: object(item.body, `AecIntentEvidenceV1.intent.proposed_actions[${index}].body`), requires_apply: item.requires_apply }; });
  const confidence = object(source.confidence, "AecIntentEvidenceV1.confidence"), confidenceValue = finite(confidence.value, "AecIntentEvidenceV1.confidence.value"); if (confidenceValue < 0 || confidenceValue > 1 || !["deterministic", "provider", "mixed"].includes(String(confidence.basis))) fail("AecIntentEvidenceV1.confidence");
  const verification = object(source.verification, "AecIntentEvidenceV1.verification"); if (!Array.isArray(verification.required) || !Array.isArray(verification.observed) || verification.required.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS || verification.observed.length > AEC_INTENT_EVIDENCE_MAX_ARRAY_ITEMS || verification.required.some((gate) => typeof gate !== "string" || !gates.has(gate as Gate))) fail("AecIntentEvidenceV1.verification.required");
  const observed = verification.observed.map((raw, index) => { const label = `AecIntentEvidenceV1.verification.observed[${index}]`, item = object(raw, label); if (typeof item.gate !== "string" || !gates.has(item.gate as Gate) || !["pass", "fail", "uncertain", "not_run"].includes(String(item.status))) fail(label); return { gate: item.gate as Gate, status: item.status as "pass" | "fail" | "uncertain" | "not_run", ...put("evidence_ids", item.evidence_ids === undefined ? undefined : stringArray(item.evidence_ids, `${label}.evidence_ids`)), ...put("reason", optionalString(item, "reason", label, AEC_INTENT_EVIDENCE_MAX_STRING_CHARS, true)) }; });
  return { schema: AEC_INTENT_EVIDENCE_V1_SCHEMA, id: requiredString(source.id, "AecIntentEvidenceV1.id"), revision, created_at: utc(source.created_at, "AecIntentEvidenceV1.created_at"), correlation, origin: { host: { kind: host.kind as AecIntentEvidenceV1["origin"]["host"]["kind"], ...optionalStringFields(host, "AecIntentEvidenceV1.origin.host", ["name", "version"]) }, producer: { kind: producer.kind as AecIntentEvidenceV1["origin"]["producer"]["kind"], name: requiredString(producer.name, "AecIntentEvidenceV1.origin.producer.name"), ...optionalStringFields(producer, "AecIntentEvidenceV1.origin.producer", ["version"]) }, ...put("provider", provider) }, evidence, coordinate_frames, target: { status: target.status as TargetStatus, ...put("document", document), ...put("sheet", sheet), ...put("view", view), ...put("location", location) }, intent: { domain: intent.domain as AecIntentEvidenceV1["intent"]["domain"], action: requiredString(intent.action, "AecIntentEvidenceV1.intent.action", AEC_INTENT_EVIDENCE_MAX_STRING_CHARS), proposed_actions }, constraints: stringArray(source.constraints, "AecIntentEvidenceV1.constraints"), assumptions: stringArray(source.assumptions, "AecIntentEvidenceV1.assumptions"), open_questions: stringArray(source.open_questions, "AecIntentEvidenceV1.open_questions"), confidence: { value: confidenceValue, basis: confidence.basis as AecIntentEvidenceV1["confidence"]["basis"], reasons: stringArray(confidence.reasons, "AecIntentEvidenceV1.confidence.reasons") }, verification: { required: [...verification.required] as Gate[], observed }, ...put("supersedes", optionalString(source, "supersedes", "AecIntentEvidenceV1")) } as AecIntentEvidenceV1;
}
export function validateAecIntentEvidenceV1(input: unknown): AecIntentEvidenceValidation { try { return { ok: true, value: normalizeAecIntentEvidenceV1(input) }; } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }; } }
export function toSerializableAecIntentEvidenceV1(input: AecIntentEvidenceV1): Record<string, unknown> { return normalizeAecIntentEvidenceV1(input) as unknown as Record<string, unknown>; }
