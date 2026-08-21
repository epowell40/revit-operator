type JsonRecord = Record<string, unknown>;

export type RequestedComputerAgentConfig = {
  outer_model: string | null;
  outer_reasoning_effort: string | null;
  split_planner_executor: boolean;
  planner_model: string | null;
  planner_reasoning_effort: string | null;
  executor_model: string | null;
  executor_reasoning_effort: string | null;
};

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function optionalFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) return null;
  const value = argv[index + 1].trim();
  return value || null;
}

function validatedModel(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${name} must be a bounded provider model id.`);
  }
  return value;
}

function validatedEffort(value: string | null, name: string): string | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (!REASONING_EFFORTS.has(normalized)) {
    throw new Error(`${name} must be one of none, low, medium, high, xhigh, or max.`);
  }
  return normalized;
}

export function requestedComputerAgentConfig(
  argv: string[],
  priorValue: unknown = null
): RequestedComputerAgentConfig {
  const prior = asRecord(priorValue);
  const priorRequested = Object.keys(asRecord(prior.requested)).length > 0 ? asRecord(prior.requested) : prior;
  const value = (name: string, alias: string, legacyName: string): string | null => {
    const explicit = optionalFlag(argv, name) ?? optionalFlag(argv, alias);
    if (explicit !== null) return explicit;
    const priorEntry = priorRequested[legacyName];
    return typeof priorEntry === "string" && priorEntry.trim() ? priorEntry.trim() : null;
  };
  return {
    outer_model: validatedModel(value("--outer-model", "--computer-model", "outer_model"), "--outer-model"),
    outer_reasoning_effort: validatedEffort(value("--outer-effort", "--outer-reasoning-effort", "outer_reasoning_effort"), "--outer-effort"),
    split_planner_executor: true,
    planner_model: validatedModel(value("--planner-model", "--planner-model-id", "planner_model"), "--planner-model"),
    planner_reasoning_effort: validatedEffort(value("--planner-effort", "--planner-reasoning-effort", "planner_reasoning_effort"), "--planner-effort"),
    executor_model: validatedModel(value("--executor-model", "--executor-model-id", "executor_model"), "--executor-model"),
    executor_reasoning_effort: validatedEffort(value("--executor-effort", "--executor-reasoning-effort", "executor_reasoning_effort"), "--executor-effort")
  };
}

export function speedSettingsForRequestedConfig(config: RequestedComputerAgentConfig): JsonRecord | null {
  const values: JsonRecord = {
    speed_mode: true,
    split_planner_executor: config.split_planner_executor,
    outer_model: config.outer_model,
    outer_reasoning_effort: config.outer_reasoning_effort,
    planner_model: config.planner_model,
    planner_reasoning_effort: config.planner_reasoning_effort,
    executor_model: config.executor_model,
    executor_reasoning_effort: config.executor_reasoning_effort
  };
  const configured = Object.entries(values).some(([key, value]) => !["speed_mode", "split_planner_executor"].includes(key) && value !== null);
  if (!configured) return null;
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

function receiptKey(receipt: JsonRecord): string | null {
  const provider = String(receipt.provider || "unknown").trim().toLowerCase();
  const stableId = String(receipt.call_id || receipt.response_id || "").trim();
  return stableId ? `${provider}:${stableId}` : null;
}

function mergeReceipt(left: JsonRecord, right: JsonRecord): JsonRecord {
  const leftTokens = asRecord(left.tokens);
  const rightTokens = asRecord(right.tokens);
  return {
    ...left,
    ...Object.fromEntries(Object.entries(right).filter(([, value]) => value !== null && value !== undefined && value !== "")),
    tokens: {
      ...leftTokens,
      ...Object.fromEntries(Object.entries(rightTokens).filter(([, value]) => value !== null && value !== undefined))
    }
  };
}

export function deduplicateModelCallReceipts(values: unknown[]): JsonRecord[] {
  const receipts = new Map<string, JsonRecord>();
  for (const value of values) {
    const receipt = asRecord(value);
    const key = receiptKey(receipt);
    if (!key) continue;
    receipts.set(key, receipts.has(key) ? mergeReceipt(receipts.get(key)!, receipt) : receipt);
  }
  return [...receipts.values()];
}

export function modelCallReceiptsFromSources(...sources: unknown[]): JsonRecord[] {
  const candidates: unknown[] = [];
  for (const sourceValue of sources) {
    const source = asRecord(sourceValue);
    for (const key of ["modelCallReceipts", "model_call_receipts"] as const) {
      if (Array.isArray(source[key])) candidates.push(...source[key] as unknown[]);
    }
    if (source.model_call_receipt) candidates.push(source.model_call_receipt);
  }
  return deduplicateModelCallReceipts(candidates);
}

function nullableSum(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function completeSum(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

export function aggregateModelCallReceipts(values: unknown[]): JsonRecord {
  const receipts = deduplicateModelCallReceipts(values);
  const buckets = new Map<string, JsonRecord[]>();
  for (const receipt of receipts) {
    const route = String(receipt.route || "unknown");
    const model = String(receipt.model || receipt.requested_model || "unknown");
    const effort = String(receipt.reasoning_effort || "unknown");
    const key = `${route}\u0000${model}\u0000${effort}`;
    const rows = buckets.get(key) || [];
    rows.push(receipt);
    buckets.set(key, rows);
  }
  const byRouteModelEffort = [...buckets.entries()].map(([key, rows]) => {
    const [route, model, reasoningEffort] = key.split("\u0000");
    const tokens = rows.map((receipt) => asRecord(receipt.tokens));
    return {
      route,
      model,
      reasoning_effort: reasoningEffort,
      call_count: rows.length,
      successful_call_count: rows.filter((receipt) => receipt.success === true).length,
      provider_duration_ms: rows.reduce((sum, receipt) => sum + (nonNegativeInteger(receipt.duration_ms) ?? 0), 0),
      input_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.input_tokens))),
      cached_input_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.cached_input_tokens))),
      output_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.output_tokens))),
      reasoning_output_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.reasoning_output_tokens))),
      total_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
      known_total_tokens: nullableSum(tokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
      calls_missing_total_tokens: tokens.filter((entry) => nonNegativeInteger(entry.total_tokens) === null).length,
      cost_usd: null,
      cost_status: "missing_pricing"
    };
  }).sort((left, right) => `${left.route}/${left.model}/${left.reasoning_effort}`.localeCompare(`${right.route}/${right.model}/${right.reasoning_effort}`));
  const allTokens = receipts.map((receipt) => asRecord(receipt.tokens));
  return {
    schema: "revit-operator.model-call-telemetry-summary.v1",
    deduplication: "provider_and_call_or_response_id",
    call_count: receipts.length,
    successful_call_count: receipts.filter((receipt) => receipt.success === true).length,
    provider_duration_ms: receipts.reduce((sum, receipt) => sum + (nonNegativeInteger(receipt.duration_ms) ?? 0), 0),
    input_tokens: completeSum(allTokens.map((entry) => nonNegativeInteger(entry.input_tokens))),
    cached_input_tokens: completeSum(allTokens.map((entry) => nonNegativeInteger(entry.cached_input_tokens))),
    output_tokens: completeSum(allTokens.map((entry) => nonNegativeInteger(entry.output_tokens))),
    reasoning_output_tokens: completeSum(allTokens.map((entry) => nonNegativeInteger(entry.reasoning_output_tokens))),
    total_tokens: completeSum(allTokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
    known_total_tokens: nullableSum(allTokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
    calls_missing_total_tokens: allTokens.filter((entry) => nonNegativeInteger(entry.total_tokens) === null).length,
    token_status: receipts.length === 0 || allTokens.every((entry) => nonNegativeInteger(entry.total_tokens) === null)
      ? "missing"
      : allTokens.some((entry) => nonNegativeInteger(entry.total_tokens) === null) ? "partial" : "complete",
    by_route_model_effort: byRouteModelEffort,
    cost_usd: null,
    cost_status: "missing_pricing",
    pricing_snapshot: null
  };
}

export function modelCallReceiptsFromTraces(traces: unknown[]): JsonRecord[] {
  const receipts = traces.flatMap((traceValue) => {
    const trace = asRecord(traceValue);
    if (Array.isArray(trace.model_call_receipts)) return trace.model_call_receipts;
    return [];
  });
  return deduplicateModelCallReceipts(receipts);
}

export function requestedVsObservedComputerAgent(
  requested: RequestedComputerAgentConfig,
  telemetryValue: unknown
): JsonRecord {
  const telemetry = asRecord(telemetryValue);
  const buckets = Array.isArray(telemetry.by_route_model_effort)
    ? telemetry.by_route_model_effort.map(asRecord)
    : [];
  const definitions = [
    { role: "outer", routes: new Set(["desktop_computer"]), model: requested.outer_model, effort: requested.outer_reasoning_effort },
    { role: "planner", routes: new Set(["planner"]), model: requested.planner_model, effort: requested.planner_reasoning_effort },
    { role: "executor", routes: new Set(["executor", "classic"]), model: requested.executor_model, effort: requested.executor_reasoning_effort }
  ];
  const roles = definitions.map((definition) => {
    const observed = buckets.filter((bucket) => definition.routes.has(String(bucket.route || "")));
    const models = [...new Set(observed.map((bucket) => String(bucket.model || "unknown")))].sort();
    const efforts = [...new Set(observed.map((bucket) => String(bucket.reasoning_effort || "unknown")))].sort();
    const modelMatches = definition.model === null || models.every((model) => model === definition.model);
    const effortMatches = definition.effort === null || efforts.every((effort) => effort === definition.effort);
    return {
      role: definition.role,
      requested_model: definition.model,
      requested_reasoning_effort: definition.effort,
      observed_models: models,
      observed_reasoning_efforts: efforts,
      call_count: observed.reduce((sum, bucket) => sum + (nonNegativeInteger(bucket.call_count) ?? 0), 0),
      provider_duration_ms: observed.reduce((sum, bucket) => sum + (nonNegativeInteger(bucket.provider_duration_ms) ?? 0), 0),
      total_tokens: completeSum(observed.map((bucket) => nonNegativeInteger(bucket.total_tokens))),
      configuration_match: observed.length === 0 ? null : modelMatches && effortMatches,
      cost_usd: null,
      cost_status: "missing_pricing"
    };
  });
  return {
    roles,
    configuration_drift_detected: roles.some((role) => role.configuration_match === false)
  };
}
