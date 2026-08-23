import path from "node:path";
import { readJsonFile } from "./files.js";
import {
  generalRevitExecutionCase,
  type GeneralRevitCapabilityCase
} from "./general_revit_capability_acceptance.js";
import { buildBenchmarkCaseResultV2 } from "./protocol_v2_case.js";
import { finalizeBenchmarkRunEnvelopeV2, validateBenchmarkRunEnvelopeDraftV2 } from "./protocol_v2_envelope.js";
import { sha256File, sha256Value } from "./protocol_v2_hash.js";
import { buildBenchmarkRawReportV2, writeBenchmarkRawReportV2 } from "./protocol_v2_report.js";
import type {
  BenchmarkLaneV2,
  BenchmarkRawReportV2,
  BenchmarkRunEnvelopeDraftV2,
  BenchmarkRunEnvelopeV2
} from "./protocol_v2_types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

export function loadBenchmarkRunEnvelopeDraftV2(filePath: string): BenchmarkRunEnvelopeDraftV2 {
  const draft = readJsonFile<BenchmarkRunEnvelopeDraftV2>(path.resolve(filePath));
  validateBenchmarkRunEnvelopeDraftV2(draft);
  return draft;
}

export function observedProviderRoutesV2(legacyReport: JsonRecord): BenchmarkRunEnvelopeV2["observed_provider_routes"] {
  const telemetry = record(legacyReport.model_call_telemetry);
  return records(telemetry.by_route_model_effort).map((row) => ({
    route: String(row.route || "").trim(),
    model: String(row.model || "").trim(),
    reasoning_effort: String(row.reasoning_effort || "").trim(),
    call_count: Number(row.call_count || 0)
  })).filter((row) => row.route && row.model && row.reasoning_effort && Number.isInteger(row.call_count) && row.call_count > 0);
}

export function assertCompleteProtocolV2Receipts(legacyReport: JsonRecord, selectedCaseIds: readonly string[]): void {
  const telemetry = record(legacyReport.model_telemetry_coverage);
  if (telemetry.complete !== true || Number(telemetry.cases_with_model_receipts || 0) !== selectedCaseIds.length) {
    throw new Error("Benchmark Protocol V2 fails closed on incomplete provider telemetry.");
  }
  const traces = records(legacyReport.task_traces);
  for (const caseId of selectedCaseIds) {
    const trace = traces.find((entry) => entry.case_id === caseId);
    if (!trace) throw new Error(`Benchmark Protocol V2 is missing the raw trace for ${caseId}.`);
    const toolResults = record(trace.tool_results);
    const evaluation = record(record(trace.verification_results).evaluation);
    const rawHash = String(toolResults.raw_sidecar_response_sha256 || "");
    const assignmentProjection = record(toolResults.durable_assignment_projection);
    const durableEvidence = record(toolResults.durable_tool_evidence);
    if (!/^[a-f0-9]{64}$/i.test(rawHash) || !Array.isArray(assignmentProjection.assignments)
      || durableEvidence.schema !== "revit-operator.benchmark-durable-tool-evidence/v1") {
      throw new Error(`Benchmark Protocol V2 is missing canonical Revit receipts for ${caseId}.`);
    }
    if (evaluation.dispatched === true && records(durableEvidence.canonical_attempt_receipts).length === 0) {
      throw new Error(`Benchmark Protocol V2 has no canonical action-attempt receipt for dispatched case ${caseId}.`);
    }
    if (evaluation.dispatched === true && records(trace.tool_calls).length === 0) {
      throw new Error(`Benchmark Protocol V2 has incomplete dispatched-action receipts for ${caseId}.`);
    }
  }
}

export function buildProtocolV2ReportFromFlight(args: {
  draft: BenchmarkRunEnvelopeDraftV2;
  legacyReport: JsonRecord;
  legacyReportRef: string;
  cases: readonly GeneralRevitCapabilityCase[];
  corpusValue?: unknown;
  originalManifestPath?: string;
  requireCompleteReceipts?: boolean;
}): BenchmarkRawReportV2 {
  validateBenchmarkRunEnvelopeDraftV2(args.draft);
  if (args.corpusValue !== undefined && sha256Value(args.corpusValue) !== args.draft.corpus.sha256) {
    throw new Error("Protocol V2 envelope corpus hash does not match the loaded corpus.");
  }
  if (args.originalManifestPath && sha256File(args.originalManifestPath) !== args.draft.corpus.original_case_manifest_sha256) {
    throw new Error("Protocol V2 envelope original case manifest hash does not match the loaded manifest bytes.");
  }
  const legacyRunId = String(args.legacyReport.run_id || "").trim();
  if (legacyRunId !== args.draft.identity.run_id) throw new Error("Protocol V2 envelope run ID does not match the flight report.");
  const traces = records(args.legacyReport.task_traces);
  const byId = new Map(args.cases.map((entry) => [entry.case_id, entry]));
  const traceIds = traces.map((entry) => String(entry.case_id || ""));
  if (args.requireCompleteReceipts !== false) assertCompleteProtocolV2Receipts(args.legacyReport, traceIds);
  for (const caseId of traceIds) {
    const testCase = byId.get(caseId);
    if (!testCase) throw new Error(`Flight contains case ${caseId}, which is absent from the bound corpus.`);
    if (args.draft.corpus.case_hashes[caseId] !== sha256Value(testCase)) {
      throw new Error(`Flight case ${caseId} does not match its immutable envelope hash.`);
    }
  }
  const completedAt = String(record(args.legacyReport.suite_timing).finished_at_utc || args.legacyReport.generated_at || "").trim();
  const envelope = finalizeBenchmarkRunEnvelopeV2(args.draft, observedProviderRoutesV2(args.legacyReport), completedAt);
  const applyRequested = envelope.execution_lane === "committed_apply";
  const judgedAt = String(args.legacyReport.generated_at || completedAt);
  const results = traces.map((trace) => {
    const caseId = String(trace.case_id || "");
    const testCase = generalRevitExecutionCase(byId.get(caseId)!, applyRequested);
    return buildBenchmarkCaseResultV2({
      runId: envelope.identity.run_id,
      lane: envelope.execution_lane,
      testCase,
      trace,
      rawTraceRef: `${path.resolve(args.legacyReportRef)}#task_traces/${caseId}`,
      judgedAt,
      evaluatorVersion: envelope.evaluator_version
    });
  });
  return buildBenchmarkRawReportV2(envelope, results, judgedAt);
}

export function writeProtocolV2ReportFromFlight(args: {
  draftPath: string;
  legacyReportPath: string;
  outputPath: string;
  cases: readonly GeneralRevitCapabilityCase[];
  corpusValue?: unknown;
  originalManifestPath?: string;
  requireCompleteReceipts?: boolean;
}): { report: BenchmarkRawReportV2; json_path: string; markdown_path: string } {
  const draft = loadBenchmarkRunEnvelopeDraftV2(args.draftPath);
  const legacyReport = readJsonFile<JsonRecord>(path.resolve(args.legacyReportPath));
  const report = buildProtocolV2ReportFromFlight({
    draft,
    legacyReport,
    legacyReportRef: args.legacyReportPath,
    cases: args.cases,
    corpusValue: args.corpusValue,
    originalManifestPath: args.originalManifestPath,
    requireCompleteReceipts: args.requireCompleteReceipts
  });
  const written = writeBenchmarkRawReportV2(path.resolve(args.outputPath), report);
  return { report, ...written };
}

export function protocolLaneFromFlags(args: { apply: boolean; controlled: boolean; ambient: boolean }): BenchmarkLaneV2 {
  if (args.controlled && args.ambient) throw new Error("Benchmark Protocol V2 cannot combine controlled and ambient context lanes.");
  if (args.apply) return "committed_apply";
  if (args.ambient) return "ambient_context";
  if (args.controlled) return "controlled_capability";
  return "safe_readiness";
}
