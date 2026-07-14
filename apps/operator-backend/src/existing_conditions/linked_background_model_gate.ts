export type RevitModelHealthLink = {
  typeId?: unknown;
  name?: unknown;
  instanceCount?: unknown;
  loaded?: unknown;
  path?: unknown;
};

export type LinkedBackgroundModelGatePolicy = {
  expected_name_tokens: string[];
  require_exactly_one_match: boolean;
  minimum_instance_count: number;
  require_loaded: boolean;
  require_source_path: boolean;
};

export const DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY: LinkedBackgroundModelGatePolicy = {
  expected_name_tokens: ["architectural"],
  require_exactly_one_match: true,
  minimum_instance_count: 1,
  require_loaded: true,
  require_source_path: true
};

export type LinkedBackgroundModelGateMatch = {
  type_id: number | null;
  name: string;
  instance_count: number;
  loaded: boolean;
  source_path: string | null;
  passed: boolean;
  failure_classifications: string[];
};

export type LinkedBackgroundModelGateReceipt = {
  schema_version: 1;
  artifact_role: "linked_background_model_gate";
  passed: boolean;
  failure_classifications: string[];
  document: {
    title: string | null;
    path: string | null;
  };
  policy: LinkedBackgroundModelGatePolicy;
  matched_link_type_count: number;
  matches: LinkedBackgroundModelGateMatch[];
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedTokens(tokens: string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter(Boolean))];
}

export function auditLinkedBackgroundModelHealth(
  modelHealth: unknown,
  policy: LinkedBackgroundModelGatePolicy = DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY
): LinkedBackgroundModelGateReceipt {
  const root = record(modelHealth);
  const document = record(root?.document);
  const links = record(root?.links);
  const revit = record(links?.revit);
  const items = Array.isArray(revit?.items) ? revit.items : [];
  const tokens = normalizedTokens(policy.expected_name_tokens);
  const failures: string[] = [];

  if (String(root?.status ?? "").trim().toLowerCase() !== "ok") failures.push("model_health_status_not_ok");
  if (tokens.length === 0) failures.push("expected_link_name_tokens_missing");

  const matchingItems = items
    .map((item) => record(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .filter((item) => {
      const name = text(item.name)?.toLowerCase() ?? "";
      return tokens.length > 0 && tokens.every((token) => name.includes(token));
    });

  if (matchingItems.length === 0) failures.push("expected_background_link_not_found");
  if (policy.require_exactly_one_match && matchingItems.length > 1) failures.push("expected_background_link_ambiguous");

  const matches = matchingItems.map((item): LinkedBackgroundModelGateMatch => {
    const matchFailures: string[] = [];
    const instanceCount = nonnegativeInteger(item.instanceCount);
    const loaded = item.loaded === true;
    const sourcePath = text(item.path);
    if (instanceCount < policy.minimum_instance_count) matchFailures.push("background_link_has_no_placed_instance");
    if (policy.require_loaded && !loaded) matchFailures.push("background_link_unloaded");
    if (policy.require_source_path && !sourcePath) matchFailures.push("background_link_source_path_missing");
    return {
      type_id: typeof item.typeId === "number" && Number.isInteger(item.typeId) ? item.typeId : null,
      name: text(item.name) ?? "",
      instance_count: instanceCount,
      loaded,
      source_path: sourcePath,
      passed: matchFailures.length === 0,
      failure_classifications: matchFailures
    };
  });

  for (const classification of matches.flatMap((match) => match.failure_classifications)) {
    if (!failures.includes(classification)) failures.push(classification);
  }

  return {
    schema_version: 1,
    artifact_role: "linked_background_model_gate",
    passed: failures.length === 0,
    failure_classifications: failures,
    document: {
      title: text(document?.title),
      path: text(document?.path)
    },
    policy: {
      ...policy,
      expected_name_tokens: tokens
    },
    matched_link_type_count: matches.length,
    matches
  };
}
