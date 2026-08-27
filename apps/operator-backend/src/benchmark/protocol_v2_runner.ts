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
import { verifyVerifiedWorkPacketHash } from "../work_packets/generator.js";
import type { VerifiedWorkPacketV1 } from "../work_packets/contract.js";
import type {
  BenchmarkLaneV2,
  BenchmarkFinalizationFailureV2,
  BenchmarkRawReportV2,
  BenchmarkRunEnvelopeDraftV2,
  BenchmarkRunEnvelopeV2
} from "./protocol_v2_types.js";
import { canonicalAttemptRequestedEffect } from "./durable_tool_evidence.js";
import {
  assignmentRowFromKernelPublicationV2,
  directKernelPublicationsV2,
  expectedDirectKernelAssignmentIdsV2,
  kernelPublicationsV2
} from "./protocol_v2_kernel.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function workPacketStatusMatchesTerminal(packet: JsonRecord, assignment: JsonRecord): boolean {
  const status = String(packet.status || "");
  const kernel = record(assignment.assignment_snapshot_v2);
  if (kernel.schema === "revit-operator.assignment-snapshot/v2") {
    const outcome = String(kernel.outcome || "");
    const terminal = kernel.terminal === true;
    const hasUnknown = records(kernel.unresolved_unknown_operation_ids).length > 0
      || (Array.isArray(kernel.unresolved_unknown_operation_ids) && kernel.unresolved_unknown_operation_ids.length > 0);
    if (status === "verified_complete") return terminal && outcome === "complete" && !hasUnknown;
    if (status === "verified_no_op") return terminal && outcome === "verified_noop" && !hasUnknown;
    if (status === "complete_with_issues") return terminal && outcome === "complete_with_issues";
    if (status === "blocked_truthfully" || status === "awaiting_clarification") return terminal && outcome === "blocked";
    if (status === "failed") return terminal && outcome === "failed";
    if (status === "rolled_back") return terminal;
    return false;
  }
  const control = record(assignment.control_plane);
  const terminal = String(control.terminal_state || "");
  const attempts = records(control.attempts);
  const hasUnknown = attempts.some(attempt => String(record(attempt.effect).state || "") === "unknown");
  if (status === "verified_complete" || status === "verified_no_op") {
    return ["verified", "complete"].includes(terminal) && !hasUnknown;
  }
  if (status === "blocked_truthfully" || status === "awaiting_clarification") return terminal === "blocked";
  if (status === "failed") return terminal === "failed" || terminal === "canceled";
  if (status === "complete_with_issues") return terminal !== "open";
  if (status === "rolled_back") return terminal !== "open";
  return false;
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
  const traces = records(legacyReport.task_traces);
  for (const caseId of selectedCaseIds) {
    const trace = traces.find((entry) => entry.case_id === caseId);
    if (!trace) continue;
    const toolResults = record(trace.tool_results);
    const expectedIds = expectedDirectKernelAssignmentIdsV2(toolResults);
    const receivedIds = new Set(directKernelPublicationsV2(toolResults).map((publication) => String(publication.assignment_id ?? "")));
    const failures = records(record(toolResults.durable_assignment_kernel_v2).failures);
    if (expectedIds.some((assignmentId) => !receivedIds.has(assignmentId)) || failures.length > 0) {
      throw new Error(`Benchmark Protocol V2 v2_publication_missing for ${caseId}.`);
    }
  }
  const allDirect = selectedCaseIds.every((caseId) => {
    const trace = traces.find((entry) => entry.case_id === caseId);
    return trace ? directKernelPublicationsV2(record(trace.tool_results)).length > 0 : false;
  });
  if (!allDirect) {
    const telemetry = record(legacyReport.model_telemetry_coverage);
    if (telemetry.complete !== true || Number(telemetry.cases_with_model_receipts || 0) !== selectedCaseIds.length) {
      throw new Error("Benchmark Protocol V2 fails closed on incomplete provider telemetry.");
    }
  }
  for (const caseId of selectedCaseIds) {
    const trace = traces.find((entry) => entry.case_id === caseId);
    if (!trace) throw new Error(`Benchmark Protocol V2 is missing the raw trace for ${caseId}.`);
    const toolResults = record(trace.tool_results);
    const evaluation = record(record(trace.verification_results).evaluation);
    const rawHash = String(toolResults.raw_sidecar_response_sha256 || "");
    const assignmentProjection = record(toolResults.durable_assignment_projection);
    const assignmentRows = records(assignmentProjection.assignments);
    const directPublications = directKernelPublicationsV2(toolResults);
    const expectedDirectAssignmentIds = expectedDirectKernelAssignmentIdsV2(toolResults);
    if (expectedDirectAssignmentIds.length > 0) {
      const receivedIds = new Set(directPublications.map((publication) => String(publication.assignment_id ?? "")));
      const missingIds = expectedDirectAssignmentIds.filter((assignmentId) => !receivedIds.has(assignmentId));
      const publicationFailures = records(record(toolResults.durable_assignment_kernel_v2).failures);
      if (missingIds.length > 0 || publicationFailures.length > 0) {
        throw new Error(`Benchmark Protocol V2 v2_publication_missing for ${caseId}: ${missingIds.join(",") || "direct publication read failed"}.`);
      }
    }
    const publications = kernelPublicationsV2(toolResults);
    const v2AssignmentRows = publications.map(assignmentRowFromKernelPublicationV2);
    if (directPublications.length > 0) {
      for (const publication of directPublications) {
        const ledger = record(publication.provider_ledger);
        const callIds = Array.isArray(ledger.call_ids) ? ledger.call_ids.map(String) : [];
        const calls = record(ledger.calls);
        const inFlight = Array.isArray(ledger.in_flight_call_ids) ? ledger.in_flight_call_ids.map(String) : [];
        if (callIds.length === 0 || inFlight.length > 0 || callIds.some((id) => record(calls[id]).state !== "completed")) {
          throw new Error(`Benchmark Protocol V2 fails closed on incomplete provider telemetry for ${caseId}.`);
        }
      }
    }
    const activeControls = assignmentRows.map(row => record(row.control_plane)).filter(control =>
      Number(control.in_flight_count || 0) > 0 || control.quiescent === false);
    const activeKernels = publications.map(row => record(row.snapshot))
      .filter(kernel => kernel.schema === "revit-operator.assignment-snapshot/v2"
        && (kernel.quiescent === false || (Array.isArray(kernel.in_flight_operation_ids) && kernel.in_flight_operation_ids.length > 0)));
    if (activeControls.length > 0 || activeKernels.length > 0) {
      const ids = activeControls.flatMap(control => Array.isArray(control.in_flight_attempt_ids) ? control.in_flight_attempt_ids : []).map(String);
      ids.push(...activeKernels.flatMap(kernel => Array.isArray(kernel.in_flight_operation_ids) ? kernel.in_flight_operation_ids : []).map(String));
      const deadline = activeControls.map(control => String(control.next_in_flight_deadline || "")).filter(Boolean).sort()[0] ?? "unknown";
      throw new Error(`Benchmark Protocol V2 settlement still in flight for ${caseId}: attempts=${ids.join(",") || "unknown"}; deadline=${deadline}.`);
    }
    const durableEvidence = record(toolResults.durable_tool_evidence);
    if (!/^[a-f0-9]{64}$/i.test(rawHash)
      || (publications.length === 0 && !Array.isArray(assignmentProjection.assignments))
      || durableEvidence.schema !== "revit-operator.benchmark-durable-tool-evidence/v1") {
      throw new Error(`Benchmark Protocol V2 is missing canonical Revit receipts for ${caseId}.`);
    }
    const canonicalReceipts = records(durableEvidence.canonical_attempt_receipts);
    const kernelOperations = publications.flatMap(row => Object.values(record(record(row.snapshot).operations)).map(record));
    if (evaluation.dispatched === true && canonicalReceipts.length === 0 && kernelOperations.length === 0) {
      throw new Error(`Benchmark Protocol V2 has no canonical action-attempt receipt for dispatched case ${caseId}.`);
    }
    const expectedEffect = String(trace.execution_expected_effect || "");
    if (evaluation.dispatched === true && expectedEffect === "read") {
      const validRead = canonicalReceipts.some(receipt => canonicalAttemptRequestedEffect(receipt) === "read"
        && receipt.dispatch_state === "acknowledged" && receipt.effect_state === "none"
        && ["native_host", "native_receipt", "target_readback", "independent_verifier"].includes(String(receipt.effect_authority || ""))
        && Array.isArray(receipt.receipt_refs) && receipt.receipt_refs.length > 0
        && Array.isArray(receipt.evidence_refs) && receipt.evidence_refs.length > 0
        && ["verified", "complete"].includes(String(receipt.assignment_terminal_state || "")));
      const validKernelRead = publications.some(row => {
        const kernel = record(row.snapshot);
        if (kernel.schema !== "revit-operator.assignment-snapshot/v2" || kernel.terminal !== true) return false;
        const observations = record(kernel.observations);
        return Object.values(record(kernel.operations)).map(record).some(operation =>
          operation.requested_effect === "read" && operation.dispatch_state === "dispatched"
          && operation.dispatch_authority === "native" && operation.persistent_effect === "none"
          && operation.settlement_state === "settled" && String(record(operation.result).receipt_id || "").length > 0
          && Array.isArray(operation.observation_ids) && operation.observation_ids.length > 0
          && operation.observation_ids.every(id => Object.hasOwn(observations, String(id))));
      });
      if (!validRead && !validKernelRead) throw new Error(`Benchmark Protocol V2 has no authoritative canonical read receipt for ${caseId}.`);
    }
    const packetBundle = record(toolResults.durable_work_packets);
    const packets = records(packetBundle.packets);
    if (packetBundle.schema !== "revit-operator.benchmark-work-packets/v1" || packets.length === 0) {
      throw new Error(`Benchmark Protocol V2 is missing a complete Verified Work Packet for ${caseId}.`);
    }
    if (packets.some(packet => !String(packet.packet_id || "").trim() || !String(packet.packet_hash || "").trim()
      || !verifyVerifiedWorkPacketHash(packet as unknown as VerifiedWorkPacketV1))) {
      throw new Error(`Benchmark Protocol V2 Verified Work Packet hash is invalid for ${caseId}.`);
    }
    const terminalAssignments = [...v2AssignmentRows, ...assignmentRows].filter(row => {
      const kernel = record(row.assignment_snapshot_v2);
      return kernel.schema === "revit-operator.assignment-snapshot/v2"
        ? kernel.terminal === true
        : String(record(row.control_plane).terminal_state || "") !== "open";
    });
    const exactBindings = packets.flatMap(packet => {
      const identity = record(packet.identity);
      const assignment = terminalAssignments.find(row => {
        const assignmentId = String(row.id || row.source_record_id || "").replace(/^goal:/, "");
        const kernel = record(row.assignment_snapshot_v2);
        const binding = kernel.schema === "revit-operator.assignment-snapshot/v2" ? record(kernel.current_binding) : record(row.control_plane);
        return identity.assignment_id === assignmentId && identity.run_id === binding.run_id
          && identity.generation === binding.generation;
      });
      return assignment ? [{ packet, assignment }] : [];
    });
    if (exactBindings.length === 0) throw new Error(`Benchmark Protocol V2 Verified Work Packet has a stale or cross-run binding for ${caseId}.`);
    if (!exactBindings.some(({ packet, assignment }) => workPacketStatusMatchesTerminal(packet, assignment))) {
      throw new Error(`Benchmark Protocol V2 Verified Work Packet status contradicts canonical Assignment truth for ${caseId}.`);
    }
  }
}

function finalizationFailureDetails(message: string): {
  code: string; stage: string; missing: string[]; telemetry: BenchmarkFinalizationFailureV2["telemetry_completeness"];
} {
  if (/v2_publication_missing/i.test(message)) return { code: "v2_publication_missing", stage: "v2_publication", missing: ["v2_assignment_publication"], telemetry: "collection_failed" };
  if (/provider telemetry/i.test(message)) return { code: "missing_provider_receipt", stage: "provider_telemetry", missing: ["provider_receipt"], telemetry: "missing" };
  if (/settlement still in flight/i.test(message)) return { code: "assignment_settlement_in_flight", stage: "settlement_barrier", missing: ["settled_revit_receipt"], telemetry: "still_in_flight" };
  if (/missing a complete Verified Work Packet/i.test(message)) return { code: "incomplete_work_packet", stage: "work_packet", missing: ["verified_work_packet"], telemetry: "missing" };
  if (/Work Packet hash is invalid/i.test(message)) return { code: "invalid_work_packet_hash", stage: "work_packet", missing: [], telemetry: "conflicting_or_quarantined" };
  if (/Work Packet has a stale or cross-run binding/i.test(message)) return { code: "stale_work_packet_binding", stage: "work_packet", missing: [], telemetry: "conflicting_or_quarantined" };
  if (/Work Packet status contradicts/i.test(message)) return { code: "work_packet_truth_conflict", stage: "work_packet", missing: [], telemetry: "conflicting_or_quarantined" };
  if (/Revit receipts|action-attempt receipt|canonical read receipt|dispatched-action receipts/i.test(message)) return { code: "missing_revit_receipt", stage: "revit_receipts", missing: ["revit_receipt"], telemetry: "missing" };
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
  const assignmentRows = traces.flatMap(trace => records(record(record(trace.tool_results).durable_assignment_projection).assignments));
  const controls = assignmentRows.map(row => record(row.control_plane));
  const directKernels = traces.flatMap(trace => directKernelPublicationsV2(record(trace.tool_results)))
    .map(publication => record(publication.snapshot));
  const kernels = (directKernels.length > 0 ? directKernels : assignmentRows.map(row => record(row.assignment_snapshot_v2)))
    .filter(kernel => kernel.schema === "revit-operator.assignment-snapshot/v2");
  const inFlightAttemptIds = controls.flatMap(control => Array.isArray(control.in_flight_attempt_ids) ? control.in_flight_attempt_ids : []).map(String);
  inFlightAttemptIds.push(...kernels.flatMap(kernel => Array.isArray(kernel.in_flight_operation_ids) ? kernel.in_flight_operation_ids : []).map(String));
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
    const sourceCase = byId.get(caseId)!;
    const testCase = generalRevitExecutionCase(sourceCase, applyRequested);
    return buildBenchmarkCaseResultV2({
      runId: envelope.identity.run_id,
      lane: envelope.execution_lane,
      testCase,
      sourceCase,
      transformationId: sha256Value(sourceCase) === sha256Value(testCase) ? "identity" : "general_revit_execution_effect",
      transformationVersion: "v1",
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
