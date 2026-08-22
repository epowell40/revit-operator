type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function durationStats(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total_ms: total,
    mean_ms: values.length > 0 ? total / values.length : 0,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: values.length > 0 ? Math.max(...values) : 0
  };
}

export function summarizeGeneralRevitLatency(tracesValue: unknown[], suiteContextValue: unknown): JsonRecord {
  const traces = tracesValue.map(asRecord);
  const byPath = new Map<string, Array<{ duration: number; failed: boolean; caseId: string }>>();
  const byPhase = new Map<string, number[]>();
  let repeatedPathCalls = 0;
  let providerDurationUnknownCalls = 0;
  let providerDurationKnownMs = 0;
  let productRunMs = 0;
  let harnessHealthMs = 0;
  let caseUnattributedMs = 0;

  for (const trace of traces) {
    const caseId = String(trace.case_id || "unknown");
    const toolResults = asRecord(trace.tool_results);
    const durable = asRecord(toolResults.durable_tool_evidence);
    const receipts = Array.isArray(durable.result_receipts) ? durable.result_receipts.map(asRecord) : [];
    const pathCounts = new Map<string, number>();
    for (const receipt of receipts) {
      const path = String(receipt.path || "unknown");
      const duration = numberValue(receipt.duration_ms);
      const rows = byPath.get(path) || [];
      rows.push({ duration, failed: receipt.status === "failed" || receipt.envelope_succeeded === false, caseId });
      byPath.set(path, rows);
      pathCounts.set(path, (pathCounts.get(path) || 0) + 1);
    }
    repeatedPathCalls += [...pathCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

    const efficiency = asRecord(trace.efficiency);
    const caseDuration = numberValue(efficiency.duration_ms);
    const health = numberValue(asRecord(efficiency.harness_health_ms).total);
    const computer = asRecord(efficiency.computer_performance);
    const product = numberValue(computer.product_run_ms);
    productRunMs += product;
    harnessHealthMs += health;
    caseUnattributedMs += Math.max(0, caseDuration - product - health);
    const phases = asRecord(computer.by_phase);
    for (const [phase, value] of Object.entries(phases)) {
      const rows = byPhase.get(phase) || [];
      const phaseRecord = asRecord(value);
      const count = Math.max(1, Math.trunc(numberValue(phaseRecord.count)));
      const total = numberValue(phaseRecord.total_ms);
      for (let index = 0; index < count; index += 1) rows.push(total / count);
      byPhase.set(phase, rows);
    }
    const modelReceipts = Array.isArray(trace.model_call_receipts) ? trace.model_call_receipts.map(asRecord) : [];
    for (const receipt of modelReceipts) {
      if (typeof receipt.duration_ms === "number" && Number.isFinite(receipt.duration_ms)) providerDurationKnownMs += receipt.duration_ms;
      else providerDurationUnknownCalls += 1;
    }
  }

  const allToolRows = [...byPath.values()].flat();
  const suiteContext = asRecord(suiteContextValue);
  const fixtureTransitions = Array.isArray(suiteContext.fixture_transitions)
    ? suiteContext.fixture_transitions.map(asRecord)
    : [];
  const fixtureTransitionMs = fixtureTransitions.reduce((sum, row) => sum
    + numberValue(row.duration_ms ?? row.elapsed_ms), 0);
  return {
    schema: "revit-operator.general-revit-latency-summary.v1",
    case_wall_clock: durationStats(traces.map(trace => numberValue(asRecord(trace.efficiency).duration_ms))),
    product_run_total_ms: productRunMs,
    harness_health_total_ms: harnessHealthMs,
    case_unattributed_total_ms: caseUnattributedMs,
    fixture_transition_total_ms: fixtureTransitionMs,
    provider_duration_known_ms: providerDurationKnownMs,
    provider_duration_unknown_call_count: providerDurationUnknownCalls,
    revit_tool_duration: durationStats(allToolRows.map(row => row.duration)),
    revit_tool_failed_or_rejected_count: allToolRows.filter(row => row.failed).length,
    same_case_repeated_path_call_count: repeatedPathCalls,
    by_revit_path: Object.fromEntries([...byPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, rows]) => [path, {
        ...durationStats(rows.map(row => row.duration)),
        failed_or_rejected_count: rows.filter(row => row.failed).length,
        distinct_case_count: new Set(rows.map(row => row.caseId)).size
      }])),
    by_computer_phase: Object.fromEntries([...byPhase.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([phase, values]) => [phase, durationStats(values)])),
    reconciliation_note: "Computer delegated_model_response includes nested Codex and Revit work, so phase clocks overlap; endpoint and provider clocks are reported separately and are not summed as exclusive wall time."
  };
}

