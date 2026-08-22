import { summarizeGeneralRevitCapabilityReport } from "./general_revit_capability_acceptance.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function baselineCaseDeltas(traces: JsonRecord[], baselineReport: JsonRecord | null): JsonRecord[] {
  if (!baselineReport) return [];
  const baselineTraces = new Map((Array.isArray(baselineReport.task_traces) ? baselineReport.task_traces : [])
    .map(asRecord).map((trace) => [String(trace.case_id || ""), trace] as const));
  return traces.flatMap((trace) => {
    const prior = baselineTraces.get(String(trace.case_id || ""));
    if (!prior) return [];
    const currentScore = asRecord(trace.success_failure_score);
    const priorScore = asRecord(prior.success_failure_score);
    if (JSON.stringify(currentScore) === JSON.stringify(priorScore)) return [];
    return [{
      case_id: trace.case_id,
      from_tier: priorScore.tier ?? "not_run",
      to_tier: currentScore.tier ?? "not_run",
      completion_changed: currentScore.completed !== priorScore.completed,
      verification_changed: currentScore.verified !== priorScore.verified
    }];
  });
}

export function groupedSummary(
  traces: JsonRecord[],
  key: "operation_family" | "prompt_specificity" | "preferred_fixture"
): Record<string, unknown> {
  const buckets = new Map<string, JsonRecord[]>();
  for (const trace of traces) {
    const bucket = String(trace[key] || "unknown");
    const rows = buckets.get(bucket) || [];
    rows.push(asRecord(asRecord(trace.verification_results).evaluation));
    buckets.set(bucket, rows);
  }
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, evaluations]) => [bucket, summarizeGeneralRevitCapabilityReport(evaluations as never)]));
}

export function groupedMultiSummary(traces: JsonRecord[], key: "corpus_task_types"): Record<string, unknown> {
  const buckets = new Map<string, JsonRecord[]>();
  for (const trace of traces) {
    const values = Array.isArray(trace[key]) ? trace[key].map(String) : [];
    for (const bucket of values.length > 0 ? values : ["unmapped"]) {
      const rows = buckets.get(bucket) || [];
      rows.push(asRecord(asRecord(trace.verification_results).evaluation));
      buckets.set(bucket, rows);
    }
  }
  return Object.fromEntries([...buckets.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, evaluations]) => [bucket, summarizeGeneralRevitCapabilityReport(evaluations as never)]));
}

export function computerPerformanceSummary(attempt: JsonRecord): JsonRecord {
  const state = asRecord(attempt.computer_state);
  const receipts = Array.isArray(state.performanceReceipts) ? state.performanceReceipts.map(asRecord) : [];
  const byPhase: Record<string, JsonRecord> = {};
  for (const receipt of receipts) {
    const phase = String(receipt.phase || "unknown");
    const current = byPhase[phase] || { count: 0, total_ms: 0, max_ms: 0, request_bytes: 0, response_bytes: 0 };
    const durationMs = numberValue(receipt.duration_ms);
    current.count = numberValue(current.count) + 1;
    current.total_ms = numberValue(current.total_ms) + durationMs;
    current.max_ms = Math.max(numberValue(current.max_ms), durationMs);
    current.request_bytes = numberValue(current.request_bytes) + numberValue(receipt.request_bytes);
    current.response_bytes = numberValue(current.response_bytes) + numberValue(receipt.response_bytes);
    byPhase[phase] = current;
  }
  const progress = asRecord(state.progress);
  const startedAt = Date.parse(String(progress.startedAt || ""));
  const completedAt = Date.parse(String(progress.completedAt || progress.updatedAt || ""));
  return {
    schema: "revit-operator.computer-performance-summary/v1",
    product_run_ms: Number.isFinite(startedAt) && Number.isFinite(completedAt) ? Math.max(0, completedAt - startedAt) : null,
    receipt_count: receipts.length,
    total_request_bytes: receipts.reduce((sum, receipt) => sum + numberValue(receipt.request_bytes), 0),
    total_response_bytes: receipts.reduce((sum, receipt) => sum + numberValue(receipt.response_bytes), 0),
    by_phase: byPhase,
    receipts
  };
}
