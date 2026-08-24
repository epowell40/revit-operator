import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonFileNew } from "./files.js";
import {
  generalRevitExecutionCase,
  type GeneralRevitCapabilityCase
} from "./general_revit_capability_acceptance.js";
import { buildBenchmarkCaseResultV2 } from "./protocol_v2_case.js";
import { finalizeBenchmarkRunEnvelopeV2, validateBenchmarkRunEnvelopeDraftV2 } from "./protocol_v2_envelope.js";
import { sha256File, sha256Value } from "./protocol_v2_hash.js";
import { validateBenchmarkProtocolV2Contract } from "./protocol_v2_schema.js";
import { buildBenchmarkRawReportV2, writeBenchmarkRawReportV2 } from "./protocol_v2_report.js";
import { BENCHMARK_FINALIZATION_FAILURE_V2_SCHEMA } from "./protocol_v2_types.js";
import type {
  BenchmarkLaneV2,
  BenchmarkFinalizationFailureV2,
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
    const assignmentRows = records(assignmentProjection.assignments);
    const activeControls = assignmentRows.map(row => record(row.control_plane)).filter(control =>
      Number(control.in_flight_count || 0) > 0 || control.quiescent === false);
    if (activeControls.length > 0) {
      const ids = activeControls.flatMap(control => Array.isArray(control.in_flight_attempt_ids) ? control.in_flight_attempt_ids : []).map(String);
      const deadline = activeControls.map(control => String(control.next_in_flight_deadline || "")).filter(Boolean).sort()[0] ?? "unknown";
      throw new Error(`Benchmark Protocol V2 settlement still in flight for ${caseId}: attempts=${ids.join(",") || "unknown"}; deadline=${deadline}.`);
    }
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
    const packetBundle = record(toolResults.durable_work_packets);
    const packets = records(packetBundle.packets);
    if (packetBundle.schema !== "revit-operator.benchmark-work-packets/v1" || packets.length === 0
        || packets.some(packet => !String(packet.packet_id || "").trim() || !String(packet.packet_hash || "").trim())) {
      throw new Error(`Benchmark Protocol V2 is missing a complete Verified Work Packet for ${caseId}.`);
    }
  }
}

function finalizationFailureDetails(message: string): {
  code: string; stage: string; missing: string[]; telemetry: BenchmarkFinalizationFailureV2["telemetry_completeness"];
} {
  if (/provider telemetry/i.test(message)) return { code: "missing_provider_receipt", stage: "provider_telemetry", missing: ["provider_receipt"], telemetry: "missing" };
  if (/settlement still in flight/i.test(message)) return { code: "assignment_settlement_in_flight", stage: "settlement_barrier", missing: ["settled_revit_receipt"], telemetry: "still_in_flight" };
  if (/Verified Work Packet/i.test(message)) return { code: "incomplete_work_packet", stage: "work_packet", missing: ["verified_work_packet"], telemetry: "missing" };
  if (/Revit receipts|action-attempt receipt|dispatched-action receipts/i.test(message)) return { code: "missing_revit_receipt", stage: "revit_receipts", missing: ["revit_receipt"], telemetry: "missing" };
  if (/manifest|corpus hash|case .*hash|ENOENT/i.test(message)) return { code: "path_or_manifest_resolution_failure", stage: "bound_inputs", missing: ["bound_manifest"], telemetry: "collection_failed" };
  if (/evaluator|oracle/i.test(message)) return { code: "evaluator_exception", stage: "evaluation", missing: [], telemetry: "complete" };
  return { code: "finalization_exception", stage: "finalization", missing: [], telemetry: "collection_failed" };
}

function bestEffortFailureArtifact(args: {
  error: unknown;
  draftPath: string;
  retainedDraftPath: string;
  legacyReportPath: string;
  legacyReport: JsonRecord | null;
  draft: BenchmarkRunEnvelopeDraftV2 | null;
  outputPath: string;
}): BenchmarkFinalizationFailureV2 {
  const message = args.error instanceof Error ? args.error.message : String(args.error);
  const details = finalizationFailureDetails(message);
  const traces = records(args.legacyReport?.task_traces);
  const generated: string[] = [];
  const missing: string[] = [];
  const caseStageVectors = traces.map(trace => {
    const caseId = String(trace.case_id || "");
    const packets = records(record(record(trace.tool_results).durable_work_packets).packets);
    (packets.length > 0 ? generated : missing).push(caseId);
    const stages = records(record(trace.protocol_v2_partial).stages);
    return {
      case_id: caseId,
      stages,
      first_failed_or_uncertain_stage: String(record(trace.protocol_v2_partial).first_failed_or_uncertain_stage || "").trim() || null
    };
  });
  const controls = traces.flatMap(trace => records(record(record(trace.tool_results).durable_assignment_projection).assignments)
    .map(row => record(row.control_plane)));
  const inFlightAttemptIds = controls.flatMap(control => Array.isArray(control.in_flight_attempt_ids) ? control.in_flight_attempt_ids : []).map(String);
  const nextDeadline = controls.map(control => String(control.next_in_flight_deadline || "")).filter(Boolean).sort()[0] ?? null;
  const lateReceiptCount = controls.reduce((total, control) => total + Number(control.late_receipt_count || 0), 0);
  const receiptStatus: BenchmarkFinalizationFailureV2["receipt_diagnostics"]["status"] = details.telemetry === "still_in_flight" ? "still_in_flight"
    : details.telemetry === "timed_out" ? "timed_out"
      : details.telemetry === "conflicting_or_quarantined" ? "conflicting_or_quarantined"
        : details.telemetry === "collection_failed" ? "collection_failed"
          : details.missing.length > 0 ? "truly_absent" : "complete";
  const base = {
    schema: BENCHMARK_FINALIZATION_FAILURE_V2_SCHEMA,
    finalization_status: "failed" as const,
    promotion_eligible: false as const,
    failure_code: details.code,
    failing_stage: details.stage,
    missing_receipt_classes: details.missing,
    conflicting_receipt_classes: /conflict|quarantin/i.test(message) ? ["conflicting_or_quarantined_receipt"] : [],
    source_flight: {
      ref: path.resolve(args.legacyReportPath),
      sha256: fs.existsSync(args.legacyReportPath) ? sha256File(args.legacyReportPath) : null,
      run_id: String(args.legacyReport?.run_id || "").trim() || null
    },
    envelope_draft: {
      ref: fs.existsSync(args.retainedDraftPath) ? path.resolve(args.retainedDraftPath) : path.resolve(args.draftPath),
      sha256: fs.existsSync(args.retainedDraftPath) ? sha256File(args.retainedDraftPath)
        : fs.existsSync(args.draftPath) ? sha256File(args.draftPath) : null
    },
    evaluator_version: args.draft?.evaluator_version ?? null,
    case_stage_vectors: caseStageVectors,
    work_packets: { generated_case_ids: [...new Set(generated)], missing_case_ids: [...new Set(missing)] },
    telemetry_completeness: details.telemetry,
    receipt_diagnostics: {
      status: receiptStatus,
      in_flight_attempt_ids: [...new Set(inFlightAttemptIds)],
      next_in_flight_deadline: nextDeadline,
      late_receipt_count: lateReceiptCount
    },
    error: message.slice(0, 2_000),
    generated_at: new Date().toISOString()
  };
  return { ...base, artifact_sha256: sha256Value(base) };
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
  const outputPath = path.resolve(args.outputPath);
  const outputDir = ensureDir(path.dirname(outputPath));
  const retainedDraftPath = path.join(outputDir, "envelope-draft.json");
  const failurePath = path.join(outputDir, "finalization-failure.json");
  let draft: BenchmarkRunEnvelopeDraftV2 | null = null;
  let legacyReport: JsonRecord | null = null;
  try {
    if (fs.existsSync(retainedDraftPath)) throw new Error(`Immutable envelope draft already exists: ${retainedDraftPath}`);
    fs.copyFileSync(path.resolve(args.draftPath), retainedDraftPath, fs.constants.COPYFILE_EXCL);
    draft = loadBenchmarkRunEnvelopeDraftV2(retainedDraftPath);
    legacyReport = readJsonFile<JsonRecord>(path.resolve(args.legacyReportPath));
    const report = buildProtocolV2ReportFromFlight({
      draft,
      legacyReport,
      legacyReportRef: args.legacyReportPath,
      cases: args.cases,
      corpusValue: args.corpusValue,
      originalManifestPath: args.originalManifestPath,
      requireCompleteReceipts: args.requireCompleteReceipts
    });
    const written = writeBenchmarkRawReportV2(outputPath, report);
    return { report, ...written };
  } catch (error) {
    const failure = bestEffortFailureArtifact({
      error, draftPath: args.draftPath, retainedDraftPath, legacyReportPath: args.legacyReportPath,
      legacyReport, draft, outputPath
    });
    validateBenchmarkProtocolV2Contract("finalization_failure", failure);
    try { writeJsonFileNew(failurePath, failure); } catch (publicationError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; immutable failure publication failed: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`);
    }
    throw error;
  }
}

export function protocolLaneFromFlags(args: { apply: boolean; controlled: boolean; ambient: boolean }): BenchmarkLaneV2 {
  if (args.controlled && args.ambient) throw new Error("Benchmark Protocol V2 cannot combine controlled and ambient context lanes.");
  if (args.apply) return "committed_apply";
  if (args.ambient) return "ambient_context";
  if (args.controlled) return "controlled_capability";
  return "safe_readiness";
}
