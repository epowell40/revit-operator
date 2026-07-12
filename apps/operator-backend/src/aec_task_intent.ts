export const AEC_TASK_INTENT_V1_SCHEMA = "revit-operator.aec-task-intent.v1" as const;
export const AEC_TASK_INTENT_MAX_TEXT_CHARS = 4000;
export const AEC_TASK_INTENT_MAX_ITEMS = 32;

export type AecTaskIntentV1 = {
  schema: typeof AEC_TASK_INTENT_V1_SCHEMA;
  operation: "layout" | "place" | "move" | "delete" | "inspect" | "other";
  object_class: "receptacle" | "light_fixture" | "family_instance" | "other";
  target: {
    document: string | null;
    view: string | null;
    room_number: string | null;
    element_ids: number[];
  };
  reference: {
    kind: "room" | "office_standard" | "redline" | "user_indicated" | "none";
    room_number: string | null;
  };
  mutation: {
    kind: "create" | "move" | "delete" | "none";
    requested: boolean;
  };
  spatial_constraints: string[];
  confidence: {
    value: number;
    ambiguity: "none" | "low" | "material";
    reasons: string[];
  };
  evidence: {
    user_text: string;
  };
};

function fail(path: string): never { throw new Error(`Invalid AecTaskIntentV1 at ${path}`); }
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path);
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, path: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") fail(path);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > AEC_TASK_INTENT_MAX_TEXT_CHARS) fail(path);
  return trimmed;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path);
  return value as T;
}
function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > AEC_TASK_INTENT_MAX_ITEMS) fail(path);
  return value.map((item, index) => boundedString(item, `${path}[${index}]`) as string);
}
function idArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length > AEC_TASK_INTENT_MAX_ITEMS) fail(path);
  const ids = value.map((item, index) => {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) fail(`${path}[${index}]`);
    return item as number;
  });
  if (new Set(ids).size !== ids.length) fail(path);
  return ids;
}

export function normalizeAecTaskIntentV1(value: unknown, authoritativeUserText?: string): AecTaskIntentV1 {
  const source = record(value, "root");
  if (source.schema !== AEC_TASK_INTENT_V1_SCHEMA) fail("schema");
  const target = record(source.target, "target");
  const reference = record(source.reference, "reference");
  const mutation = record(source.mutation, "mutation");
  const confidence = record(source.confidence, "confidence");
  const evidence = record(source.evidence, "evidence");
  const confidenceValue = confidence.value;
  if (typeof confidenceValue !== "number" || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1) fail("confidence.value");
  if (typeof mutation.requested !== "boolean") fail("mutation.requested");
  const normalizedAuthoritative = authoritativeUserText === undefined
    ? null
    : boundedString(authoritativeUserText, "authoritativeUserText") as string;
  const userText = normalizedAuthoritative ?? boundedString(evidence.user_text, "evidence.user_text") as string;
  const normalized: AecTaskIntentV1 = {
    schema: AEC_TASK_INTENT_V1_SCHEMA,
    operation: enumValue(source.operation, ["layout", "place", "move", "delete", "inspect", "other"], "operation"),
    object_class: enumValue(source.object_class, ["receptacle", "light_fixture", "family_instance", "other"], "object_class"),
    target: {
      document: boundedString(target.document, "target.document", true),
      view: boundedString(target.view, "target.view", true),
      room_number: boundedString(target.room_number, "target.room_number", true),
      element_ids: idArray(target.element_ids, "target.element_ids")
    },
    reference: {
      kind: enumValue(reference.kind, ["room", "office_standard", "redline", "user_indicated", "none"], "reference.kind"),
      room_number: boundedString(reference.room_number, "reference.room_number", true)
    },
    mutation: {
      kind: enumValue(mutation.kind, ["create", "move", "delete", "none"], "mutation.kind"),
      requested: mutation.requested
    },
    spatial_constraints: stringArray(source.spatial_constraints, "spatial_constraints"),
    confidence: {
      value: confidenceValue,
      ambiguity: enumValue(confidence.ambiguity, ["none", "low", "material"], "confidence.ambiguity"),
      reasons: stringArray(confidence.reasons, "confidence.reasons")
    },
    evidence: { user_text: userText }
  };
  if (normalized.reference.kind !== "room" && normalized.reference.room_number !== null) fail("reference.room_number");
  if (normalized.mutation.requested !== (normalized.mutation.kind !== "none")) fail("mutation");
  if (normalized.reference.room_number && normalized.target.room_number && normalized.reference.room_number === normalized.target.room_number) fail("reference.room_number");
  return normalized;
}

export function isAecTaskIntentV1(value: unknown): value is AecTaskIntentV1 {
  try { normalizeAecTaskIntentV1(value); return true; } catch { return false; }
}
