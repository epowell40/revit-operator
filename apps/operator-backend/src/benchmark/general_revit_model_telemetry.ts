type JsonRecord = Record<string, unknown>;

export type RequestedComputerAgentConfig = {
  agent_model: string | null;
  agent_reasoning_effort: string | null;
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
  const legacyFlags = ["--outer-model", "--computer-model", "--outer-effort", "--outer-reasoning-effort",
    "--planner-model", "--planner-model-id", "--planner-effort", "--planner-reasoning-effort",
    "--executor-model", "--executor-model-id", "--executor-effort", "--executor-reasoning-effort"];
  const usedLegacyFlag = legacyFlags.find(name => argv.includes(name));
  if (usedLegacyFlag) {
    throw new Error(`${usedLegacyFlag} is a removed split-agent option. Use --agent-model and --agent-effort so every model loop is configured identically.`);
  }
  const value = (name: string, legacyName: string): string | null => {
    const explicit = optionalFlag(argv, name);
    if (explicit !== null) return explicit;
    const priorEntry = priorRequested[legacyName];
    return typeof priorEntry === "string" && priorEntry.trim() ? priorEntry.trim() : null;
  };
  const legacyModels = [priorRequested.outer_model, priorRequested.planner_model, priorRequested.executor_model]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(entry => entry.trim());
  const legacyEfforts = [priorRequested.outer_reasoning_effort, priorRequested.planner_reasoning_effort, priorRequested.executor_reasoning_effort]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(entry => entry.trim().toLowerCase());
  return {
    agent_model: validatedModel(
      value("--agent-model", "agent_model") ?? (new Set(legacyModels).size === 1 ? legacyModels[0] : null),
      "--agent-model"
    ),
    agent_reasoning_effort: validatedEffort(
      value("--agent-effort", "agent_reasoning_effort") ?? (new Set(legacyEfforts).size === 1 ? legacyEfforts[0] : null),
      "--agent-effort"
    )
  };
}

export function speedSettingsForRequestedConfig(config: RequestedComputerAgentConfig): JsonRecord | null {
  const values: JsonRecord = {
    speed_mode: true,
    agent_model: config.agent_model,
    agent_reasoning_effort: config.agent_reasoning_effort
  };
  const configured = Object.entries(values).some(([key, value]) => key !== "speed_mode" && value !== null);
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

const PRICING_SNAPSHOT = {
  schema: "revit-operator.openai-pricing-snapshot.v1",
  effective_date: "2026-08-21",
  currency: "USD",
  unit_tokens: 1_000_000,
  long_context_input_threshold_tokens: 272_000,
  rates: {
    "gpt-5.6-sol": { input: 4, cached_input: 0.4, cache_write_input: 5, output: 20 },
    "gpt-5.6-luna": { input: 0.2, cached_input: 0.02, cache_write_input: 0.25, output: 1.2 }
  },
  sources: {
    "gpt-5.6-sol": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    "gpt-5.6-luna": "https://developers.openai.com/api/docs/models/gpt-5.6-luna"
  }
} as const;

function receiptCostUsd(receipt: JsonRecord): number | null {
  const model = String(receipt.model || receipt.requested_model || "");
  const rates = PRICING_SNAPSHOT.rates[model as keyof typeof PRICING_SNAPSHOT.rates];
  const tokens = asRecord(receipt.tokens);
  const input = nonNegativeInteger(tokens.input_tokens);
  const cached = nonNegativeInteger(tokens.cached_input_tokens) ?? 0;
  const cacheWrite = nonNegativeInteger(tokens.cache_write_input_tokens) ?? 0;
  const output = nonNegativeInteger(tokens.output_tokens);
  if (!rates || input === null || output === null || cached + cacheWrite > input) return null;
  const longContext = input > PRICING_SNAPSHOT.long_context_input_threshold_tokens;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const uncached = input - cached - cacheWrite;
  return ((uncached * rates.input + cached * rates.cached_input + cacheWrite * rates.cache_write_input) * inputMultiplier
    + output * rates.output * outputMultiplier) / PRICING_SNAPSHOT.unit_tokens;
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
    const durations = rows.map((receipt) => nonNegativeInteger(receipt.duration_ms));
    return {
      route,
      model,
      reasoning_effort: reasoningEffort,
      call_count: rows.length,
      successful_call_count: rows.filter((receipt) => receipt.success === true).length,
      provider_duration_ms: nullableSum(durations),
      calls_with_provider_duration: durations.filter((value) => value !== null).length,
      calls_missing_provider_duration: durations.filter((value) => value === null).length,
      provider_duration_status: durations.every((value) => value === null)
        ? "missing"
        : durations.some((value) => value === null) ? "partial" : "complete",
      input_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.input_tokens))),
      cached_input_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.cached_input_tokens))),
      output_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.output_tokens))),
      reasoning_output_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.reasoning_output_tokens))),
      total_tokens: completeSum(tokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
      known_total_tokens: nullableSum(tokens.map((entry) => nonNegativeInteger(entry.total_tokens))),
      calls_missing_total_tokens: tokens.filter((entry) => nonNegativeInteger(entry.total_tokens) === null).length,
      cost_usd: rows.every(receipt => receiptCostUsd(receipt) !== null)
        ? rows.reduce((sum, receipt) => sum + receiptCostUsd(receipt)!, 0)
        : null,
      cost_status: rows.every(receipt => receiptCostUsd(receipt) !== null) ? "estimated_from_exact_provider_tokens" : "incomplete"
    };
  }).sort((left, right) => `${left.route}/${left.model}/${left.reasoning_effort}`.localeCompare(`${right.route}/${right.model}/${right.reasoning_effort}`));
  const allTokens = receipts.map((receipt) => asRecord(receipt.tokens));
  const allDurations = receipts.map((receipt) => nonNegativeInteger(receipt.duration_ms));
  return {
    schema: "revit-operator.model-call-telemetry-summary.v1",
    deduplication: "provider_and_call_or_response_id",
    call_count: receipts.length,
    successful_call_count: receipts.filter((receipt) => receipt.success === true).length,
    provider_duration_ms: nullableSum(allDurations),
    calls_with_provider_duration: allDurations.filter((value) => value !== null).length,
    calls_missing_provider_duration: allDurations.filter((value) => value === null).length,
    provider_duration_status: allDurations.every((value) => value === null)
      ? "missing"
      : allDurations.some((value) => value === null) ? "partial" : "complete",
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
    cost_usd: receipts.length > 0 && receipts.every(receipt => receiptCostUsd(receipt) !== null)
      ? receipts.reduce((sum, receipt) => sum + receiptCostUsd(receipt)!, 0)
      : null,
    cost_status: receipts.length > 0 && receipts.every(receipt => receiptCostUsd(receipt) !== null)
      ? "estimated_from_exact_provider_tokens"
      : "incomplete",
    pricing_snapshot: PRICING_SNAPSHOT,
    billing_reconciliation: {
      invoice_actual_usd: null,
      account_credit_delta_usd: null,
      note: "List-price estimate from exact provider usage; not an invoice or credit-ledger measurement."
    }
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
    { role: "agent", routes: new Set(["codex_agent", "desktop_computer", "planner", "executor", "classic"]), model: requested.agent_model, effort: requested.agent_reasoning_effort }
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
      provider_duration_ms: completeSum(observed.map((bucket) => nonNegativeInteger(bucket.provider_duration_ms))),
      calls_with_provider_duration: observed.reduce((sum, bucket) => sum + (nonNegativeInteger(bucket.calls_with_provider_duration) ?? 0), 0),
      calls_missing_provider_duration: observed.reduce((sum, bucket) => sum + (nonNegativeInteger(bucket.calls_missing_provider_duration) ?? 0), 0),
      total_tokens: completeSum(observed.map((bucket) => nonNegativeInteger(bucket.total_tokens))),
      configuration_match: observed.length === 0 ? null : modelMatches && effortMatches,
      cost_usd: completeSum(observed.map((bucket) => typeof bucket.cost_usd === "number" ? bucket.cost_usd : null)),
      cost_status: observed.length > 0 && observed.every((bucket) => bucket.cost_status === "estimated_from_exact_provider_tokens")
        ? "estimated_from_exact_provider_tokens"
        : "incomplete"
    };
  });
  return {
    roles,
    configuration_drift_detected: roles.some((role) => role.configuration_match === false),
    codex_agent_observed: buckets.some((bucket) => String(bucket.route || "") === "codex_agent"),
    desktop_computer_observed: buckets.some((bucket) => String(bucket.route || "") === "desktop_computer"),
    comparable_configuration: roles[0]?.configuration_match === true
      && buckets.some((bucket) => String(bucket.route || "") === "codex_agent")
  };
}
