export const AEC_SEMANTIC_TASK_V1_SCHEMA = "revit-operator.aec-semantic-task.v1" as const;
export const AEC_SEMANTIC_TASK_MAX_TEXT_CHARS = 4000;
export const AEC_SEMANTIC_TASK_MAX_ITEMS = 64;

export type AecSemanticIdentifierV1 = {
  parameter: string;
  value: string;
  match: "exact" | "case_insensitive_exact" | "contains";
};

export type AecSemanticTaskV1 = {
  schema: typeof AEC_SEMANTIC_TASK_V1_SCHEMA;
  operation: "locate" | "count" | "list" | "inspect" | "compare" | "focus" | "layout" | "place" | "move" | "delete" | "tag" | "annotate" | "view" | "sheet" | "other";
  subject: {
    kind: "exact_identifier" | "category" | "class" | "family" | "type" | "system" | "room" | "space" | "elements" | "generic";
    semantic_class: "receptacle" | "light_fixture" | "air_terminal" | "mechanical_equipment" | "electrical_equipment" | "plumbing_fixture" | "family_instance" | "room" | "space" | "view" | "sheet" | "other";
    terms: string[];
    categories: string[];
    family_name: string | null;
    type_name: string | null;
    system_name: string | null;
    identifiers: AecSemanticIdentifierV1[];
  };
  scope: {
    kind: "document" | "level" | "room" | "space" | "area" | "view" | "sheet" | "system" | "selection" | "region" | "mixed" | "active_context";
    document: string | null;
    levels: string[];
    rooms: string[];
    spaces: string[];
    areas: string[];
    views: Array<{ id: number | null; name: string | null }>;
    sheets: string[];
    systems: string[];
    element_ids: number[];
    region: { frame_id: string; min_u: number; min_v: number; max_u: number; max_v: number } | null;
  };
  reference: {
    strategy: "explicit" | "current_project_precedent" | "office_standard" | "code_baseline" | "conservative_proposal" | "none";
    source_description: string | null;
    source_room: string | null;
  };
  mutation: {
    kind: "create" | "move" | "delete" | "update" | "none";
    requested: boolean;
  };
  outputs: Array<"summary" | "count" | "element_ids" | "parameters" | "spatial_context" | "best_view" | "comparison" | "verification">;
  execution: {
    max_results: number;
    max_primary_actions: number;
    allow_document_fallback: boolean;
    requires_visual_verification: boolean;
  };
  confidence: {
    value: number;
    ambiguity: "none" | "low" | "material";
    reasons: string[];
  };
  evidence: { user_text: string };
};

function fail(path: string): never { throw new Error(`Invalid AecSemanticTaskV1 at ${path}`); }

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(path);
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!keys.includes(key)) fail(`${path}.${key}`);
  for (const key of keys) if (!(key in source)) fail(`${path}.${key}`);
  return source;
}

function boundedString(value: unknown, path: string, nullable = false): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") fail(path);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > AEC_SEMANTIC_TASK_MAX_TEXT_CHARS) fail(path);
  return trimmed;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(path);
  return value as T;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > AEC_SEMANTIC_TASK_MAX_ITEMS) fail(path);
  const normalized = value.map((item, index) => boundedString(item, `${path}[${index}]`) as string);
  if (new Set(normalized.map(item => item.toLocaleLowerCase())).size !== normalized.length) fail(path);
  return normalized;
}

function idArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value) || value.length > AEC_SEMANTIC_TASK_MAX_ITEMS) fail(path);
  const ids = value.map((item, index) => {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) fail(`${path}[${index}]`);
    return item as number;
  });
  if (new Set(ids).size !== ids.length) fail(path);
  return ids;
}

function boundedInteger(value: unknown, min: number, max: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(path);
  return value as number;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path);
  return value;
}

function normalizeIdentifiers(value: unknown): AecSemanticIdentifierV1[] {
  if (!Array.isArray(value) || value.length > AEC_SEMANTIC_TASK_MAX_ITEMS) fail("subject.identifiers");
  return value.map((item, index) => {
    const source = record(item, `subject.identifiers[${index}]`, ["parameter", "value", "match"]);
    return {
      parameter: boundedString(source.parameter, `subject.identifiers[${index}].parameter`) as string,
      value: boundedString(source.value, `subject.identifiers[${index}].value`) as string,
      match: enumValue(source.match, ["exact", "case_insensitive_exact", "contains"], `subject.identifiers[${index}].match`)
    };
  });
}

function normalizeViews(value: unknown): Array<{ id: number | null; name: string | null }> {
  if (!Array.isArray(value) || value.length > AEC_SEMANTIC_TASK_MAX_ITEMS) fail("scope.views");
  const views = value.map((item, index) => {
    const source = record(item, `scope.views[${index}]`, ["id", "name"]);
    const id = source.id === null ? null : boundedInteger(source.id, 1, Number.MAX_SAFE_INTEGER, `scope.views[${index}].id`);
    const name = boundedString(source.name, `scope.views[${index}].name`, true);
    if (id === null && name === null) fail(`scope.views[${index}]`);
    return { id, name };
  });
  const keys = views.map(view => `${view.id ?? ""}:${view.name?.toLocaleLowerCase() ?? ""}`);
  if (new Set(keys).size !== keys.length) fail("scope.views");
  return views;
}

function normalizeRegion(value: unknown): AecSemanticTaskV1["scope"]["region"] {
  if (value === null) return null;
  const source = record(value, "scope.region", ["frame_id", "min_u", "min_v", "max_u", "max_v"]);
  const region = {
    frame_id: boundedString(source.frame_id, "scope.region.frame_id") as string,
    min_u: finiteNumber(source.min_u, "scope.region.min_u"),
    min_v: finiteNumber(source.min_v, "scope.region.min_v"),
    max_u: finiteNumber(source.max_u, "scope.region.max_u"),
    max_v: finiteNumber(source.max_v, "scope.region.max_v")
  };
  if (region.min_u > region.max_u || region.min_v > region.max_v) fail("scope.region");
  return region;
}

function selectedScopeKinds(scope: AecSemanticTaskV1["scope"]): string[] {
  const kinds: string[] = [];
  if (scope.levels.length) kinds.push("level");
  if (scope.rooms.length) kinds.push("room");
  if (scope.spaces.length) kinds.push("space");
  if (scope.areas.length) kinds.push("area");
  if (scope.views.length) kinds.push("view");
  if (scope.sheets.length) kinds.push("sheet");
  if (scope.systems.length) kinds.push("system");
  if (scope.element_ids.length) kinds.push("selection");
  if (scope.region) kinds.push("region");
  return kinds;
}

export function normalizeAecSemanticTaskV1(value: unknown, authoritativeUserText?: string): AecSemanticTaskV1 {
  const root = record(value, "root", ["schema", "operation", "subject", "scope", "reference", "mutation", "outputs", "execution", "confidence", "evidence"]);
  if (root.schema !== AEC_SEMANTIC_TASK_V1_SCHEMA) fail("schema");
  const subject = record(root.subject, "subject", ["kind", "semantic_class", "terms", "categories", "family_name", "type_name", "system_name", "identifiers"]);
  const scope = record(root.scope, "scope", ["kind", "document", "levels", "rooms", "spaces", "areas", "views", "sheets", "systems", "element_ids", "region"]);
  const reference = record(root.reference, "reference", ["strategy", "source_description", "source_room"]);
  const mutation = record(root.mutation, "mutation", ["kind", "requested"]);
  const execution = record(root.execution, "execution", ["max_results", "max_primary_actions", "allow_document_fallback", "requires_visual_verification"]);
  const confidence = record(root.confidence, "confidence", ["value", "ambiguity", "reasons"]);
  const evidence = record(root.evidence, "evidence", ["user_text"]);
  if (typeof mutation.requested !== "boolean") fail("mutation.requested");
  if (typeof execution.allow_document_fallback !== "boolean") fail("execution.allow_document_fallback");
  if (typeof execution.requires_visual_verification !== "boolean") fail("execution.requires_visual_verification");
  const confidenceValue = finiteNumber(confidence.value, "confidence.value");
  if (confidenceValue < 0 || confidenceValue > 1) fail("confidence.value");
  const normalized: AecSemanticTaskV1 = {
    schema: AEC_SEMANTIC_TASK_V1_SCHEMA,
    operation: enumValue(root.operation, ["locate", "count", "list", "inspect", "compare", "focus", "layout", "place", "move", "delete", "tag", "annotate", "view", "sheet", "other"], "operation"),
    subject: {
      kind: enumValue(subject.kind, ["exact_identifier", "category", "class", "family", "type", "system", "room", "space", "elements", "generic"], "subject.kind"),
      semantic_class: enumValue(subject.semantic_class, ["receptacle", "light_fixture", "air_terminal", "mechanical_equipment", "electrical_equipment", "plumbing_fixture", "family_instance", "room", "space", "view", "sheet", "other"], "subject.semantic_class"),
      terms: stringArray(subject.terms, "subject.terms"),
      categories: stringArray(subject.categories, "subject.categories"),
      family_name: boundedString(subject.family_name, "subject.family_name", true),
      type_name: boundedString(subject.type_name, "subject.type_name", true),
      system_name: boundedString(subject.system_name, "subject.system_name", true),
      identifiers: normalizeIdentifiers(subject.identifiers)
    },
    scope: {
      kind: enumValue(scope.kind, ["document", "level", "room", "space", "area", "view", "sheet", "system", "selection", "region", "mixed", "active_context"], "scope.kind"),
      document: boundedString(scope.document, "scope.document", true),
      levels: stringArray(scope.levels, "scope.levels"),
      rooms: stringArray(scope.rooms, "scope.rooms"),
      spaces: stringArray(scope.spaces, "scope.spaces"),
      areas: stringArray(scope.areas, "scope.areas"),
      views: normalizeViews(scope.views),
      sheets: stringArray(scope.sheets, "scope.sheets"),
      systems: stringArray(scope.systems, "scope.systems"),
      element_ids: idArray(scope.element_ids, "scope.element_ids"),
      region: normalizeRegion(scope.region)
    },
    reference: {
      strategy: enumValue(reference.strategy, ["explicit", "current_project_precedent", "office_standard", "code_baseline", "conservative_proposal", "none"], "reference.strategy"),
      source_description: boundedString(reference.source_description, "reference.source_description", true),
      source_room: boundedString(reference.source_room, "reference.source_room", true)
    },
    mutation: {
      kind: enumValue(mutation.kind, ["create", "move", "delete", "update", "none"], "mutation.kind"),
      requested: mutation.requested
    },
    outputs: stringArray(root.outputs, "outputs").map((item, index) => enumValue(item, ["summary", "count", "element_ids", "parameters", "spatial_context", "best_view", "comparison", "verification"], `outputs[${index}]`)),
    execution: {
      max_results: boundedInteger(execution.max_results, 1, 500, "execution.max_results"),
      max_primary_actions: boundedInteger(execution.max_primary_actions, 1, 8, "execution.max_primary_actions"),
      allow_document_fallback: execution.allow_document_fallback,
      requires_visual_verification: execution.requires_visual_verification
    },
    confidence: {
      value: confidenceValue,
      ambiguity: enumValue(confidence.ambiguity, ["none", "low", "material"], "confidence.ambiguity"),
      reasons: stringArray(confidence.reasons, "confidence.reasons")
    },
    evidence: {
      user_text: authoritativeUserText === undefined
        ? boundedString(evidence.user_text, "evidence.user_text") as string
        : boundedString(authoritativeUserText, "authoritativeUserText") as string
    }
  };
  if (normalized.mutation.requested !== (normalized.mutation.kind !== "none")) fail("mutation");
  if (["locate", "count", "list", "inspect", "compare", "focus"].includes(normalized.operation) && normalized.mutation.requested) fail("mutation");
  if (normalized.subject.kind === "exact_identifier" && normalized.subject.identifiers.length === 0) fail("subject.identifiers");
  const selected = selectedScopeKinds(normalized.scope);
  if (normalized.scope.kind === "mixed" ? selected.length < 2 : ["document", "active_context"].includes(normalized.scope.kind) ? selected.length !== 0 : selected.length !== 1 || selected[0] !== normalized.scope.kind) fail("scope.kind");
  if (normalized.scope.kind === "document" && !normalized.execution.allow_document_fallback) fail("execution.allow_document_fallback");
  if (normalized.reference.strategy === "explicit" !== (normalized.reference.source_description !== null)) fail("reference.source_description");
  if (normalized.reference.source_room !== null && normalized.reference.strategy !== "explicit") fail("reference.source_room");
  return normalized;
}

export function isAecSemanticTaskV1(value: unknown): value is AecSemanticTaskV1 {
  try { normalizeAecSemanticTaskV1(value); return true; } catch { return false; }
}
