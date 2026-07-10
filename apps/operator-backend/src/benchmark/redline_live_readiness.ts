import fs from "node:fs";
import path from "node:path";
import { nowIso, readJsonFile, recursiveFindRunJsonFiles, writeJsonFile, writeTextFile } from "./files.js";
import { cleanupOrRevertArtifactOk, preflightArtifactOk, promotionArtifactExists, resolvePromotionArtifactPath, verificationArtifactOk, writeGrantArtifactActive } from "./redline_promotion_evidence.js";
import type { BenchmarkRunRecord } from "./types.js";

type JsonMap = Record<string, unknown>;

export type RedlineLiveReadinessRecord = {
  task_id: string;
  config_id: string;
  repeat_index: number;
  run_id: string;
  workflow: string;
  execution_source: "live" | "mock" | "injected" | "unknown";
  success: boolean;
  verification_passed: number;
  verification_total: number;
  tool_calls: number;
  revit_transactions: number;
  computer_use_actions: number;
  artifact_dir: string;
  failure_reason: string | null;
  failure_classification?: string;
  bridge_proof_candidate: boolean;
  promotion?: RedlineLivePromotionMatch;
};

export type RedlineLiveReadinessReport = {
  generated_at: string;
  artifacts_dir: string;
  promotion_manifest_path?: string;
  minimum_reviewed_promotions_per_workflow: number;
  metrics: {
    total_runs: number;
    discovered_run_json_files: number;
    missing_result_files: number;
    non_redline_runs: number;
    analyzed_redline_runs: number;
    redline_workflow_runs: number;
    live_runs: number;
    live_successes: number;
    live_failures: number;
    live_with_revit_transactions: number;
    live_all_emitted_verifications_passed: number;
    bridge_proof_candidates: number;
    reviewed_live_promotions: number;
    workflows_with_reviewed_live_promotions: number;
    workflows_meeting_repeatability_minimum: number;
  };
  records: RedlineLiveReadinessRecord[];
  by_workflow: Record<string, {
    total: number;
    live: number;
    live_successes: number;
    live_full_verification: number;
    reviewed_live_promotions: number;
    repeatability_ready: boolean;
  }>;
};

export type WriteRedlineLiveReadinessOptions = {
  artifactsDir: string;
  outputDir?: string;
  promotionManifestPath?: string;
  minimumReviewedPromotionsPerWorkflow?: number;
};

export type RedlineLivePromotionEntry = {
  key?: string;
  run_id?: string;
  task_id?: string;
  workflow?: string;
  artifact_dir?: string;
  status?: string;
  ready_to_run?: boolean;
  gui_reviewed?: boolean;
  write_grant_verified?: boolean;
  task_specific_evidence_reviewed?: boolean;
  gui_artifact_paths?: string[];
  write_grant_status_artifact?: string;
  preflight_artifact?: string;
  verification_artifact?: string;
  cleanup_or_revert_artifact?: string;
  promotion_scope?: string;
  operation_class?: string;
  target_class?: string;
  expected_document_name?: string;
  expected_view_id?: string | number;
  expected_view_name?: string;
  reviewed_by?: string;
  review_notes?: string;
};

export type RedlineLivePromotionManifest = {
  schema_version?: number;
  generated_at?: string;
  source_artifacts_dir?: string;
  promotions?: RedlineLivePromotionEntry[];
};

export type RedlineLivePromotionMatch = {
  key: string;
  status: string;
  ready_to_run: boolean;
  gui_reviewed: boolean;
  write_grant_verified: boolean;
  task_specific_evidence_reviewed: boolean;
  approved: boolean;
  blocker: string | null;
  evidence_paths: string[];
  expected_document_name: string;
  expected_view_id: string;
  expected_view_name: string;
  reviewed_by: string;
  review_notes: string;
};

export type WriteRedlineLivePromotionManifestOptions = {
  artifactsDir: string;
  outputPath: string;
  reviewedBy?: string;
  reviewNotes?: string;
};

export type WriteApprovedRedlineLivePromotionManifestOptions = {
  candidateManifestPath: string;
  outputPath: string;
  runId?: string;
  artifactDir?: string;
  reviewedBy: string;
  reviewNotes: string;
  preflightArtifact: string;
  writeGrantStatusArtifact?: string;
};

export type MergeRedlineLivePromotionManifestOptions = {
  inputPaths: string[];
  outputPath: string;
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function executionSource(value: unknown): RedlineLiveReadinessRecord["execution_source"] {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "live" || normalized === "mock" || normalized === "injected") return normalized;
  return "unknown";
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function normalizePathKey(value: string): string {
  return path.resolve(value).toLowerCase();
}

function workflowIsRedline(workflow: string, taskId: string): boolean {
  return workflow.startsWith("redline_") || taskId.startsWith("demo_redline_");
}

function hasRedlineDocumentationEvidence(taskId: string, verifications: JsonMap[]): boolean {
  if (taskId !== "demo_documentation_primitives") return false;
  const names = verifications.map((entry) => stringValue(entry.name));
  return names.some((name) => name.startsWith("tag_value_")) ||
    names.some((name) => name.startsWith("text_note_")) ||
    names.some((name) => name.startsWith("schedule_")) ||
    names.some((name) => name.startsWith("category_visibility_")) ||
    names.some((name) => name.startsWith("filter_visibility_"));
}

function markdownTable(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const escape = (value: string | number | boolean | null | undefined) => String(value ?? "").replace(/\|/g, "\\|");
  return [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`)
  ].join("\n");
}

function readPromotionManifest(manifestPath?: string): { entries: RedlineLivePromotionEntry[]; base_dir: string } {
  if (!manifestPath) return { entries: [], base_dir: "" };
  const manifest = readJsonFile<RedlineLivePromotionManifest>(manifestPath);
  if (manifest.schema_version !== 1) throw new Error(`Invalid redline live promotion manifest schema_version: ${String(manifest.schema_version)}`);
  return {
    entries: Array.isArray(manifest.promotions) ? manifest.promotions : [],
    base_dir: path.dirname(manifestPath)
  };
}

function readFullPromotionManifest(manifestPath: string): { manifest: RedlineLivePromotionManifest; base_dir: string } {
  const manifest = readJsonFile<RedlineLivePromotionManifest>(manifestPath);
  if (manifest.schema_version !== 1) throw new Error(`Invalid redline live promotion manifest schema_version: ${String(manifest.schema_version)}`);
  return { manifest, base_dir: path.dirname(manifestPath) };
}

function findPromotionEntry(record: RedlineLiveReadinessRecord, entries: RedlineLivePromotionEntry[]): RedlineLivePromotionEntry | undefined {
  const artifactKey = normalizePathKey(record.artifact_dir);
  return entries.find((entry) => {
    const hasRunId = typeof entry.run_id === "string" && entry.run_id.trim().length > 0;
    const hasArtifactDir = typeof entry.artifact_dir === "string" && entry.artifact_dir.trim().length > 0;
    if (!hasRunId && !hasArtifactDir) return false;
    if (hasRunId && entry.run_id !== record.run_id) return false;
    if (hasArtifactDir && normalizePathKey(entry.artifact_dir ?? "") !== artifactKey) return false;
    if (entry.task_id && entry.task_id !== record.task_id) return false;
    if (entry.workflow && entry.workflow !== record.workflow) return false;
    return true;
  });
}

function promotionEvidenceBlockers(entry: RedlineLivePromotionEntry, baseDir: string): { blockers: string[]; evidencePaths: string[] } {
  const blockers: string[] = [];
  const guiPaths = Array.isArray(entry.gui_artifact_paths) ? entry.gui_artifact_paths.filter((value) => typeof value === "string" && value.trim()) : [];
  const requiredPathEntries: Array<[string, unknown, (filePath: string) => boolean, string]> = [
    ["write_grant_status_artifact", entry.write_grant_status_artifact, writeGrantArtifactActive, "write_grant_status_artifact_not_active"],
    ["preflight_artifact", entry.preflight_artifact, preflightArtifactOk, "preflight_artifact_not_ok"],
    ["verification_artifact", entry.verification_artifact, verificationArtifactOk, "verification_artifact_not_successful"],
    ["cleanup_or_revert_artifact", entry.cleanup_or_revert_artifact, cleanupOrRevertArtifactOk, "cleanup_or_revert_artifact_missing_cleanup_evidence"]
  ];
  if (guiPaths.length === 0) blockers.push("gui_artifact_paths_missing");
  for (const guiPath of guiPaths) {
    if (!promotionArtifactExists(guiPath, baseDir)) blockers.push("gui_artifact_path_missing");
  }
  for (const [name, value, validator, invalidBlocker] of requiredPathEntries) {
    const filePath = stringValue(value).trim();
    if (!filePath) {
      blockers.push(`${name}_missing`);
    } else {
      const resolved = resolvePromotionArtifactPath(filePath, baseDir);
      if (!fs.existsSync(resolved)) {
        blockers.push(`${name}_not_found`);
      } else if (!validator(resolved)) {
        blockers.push(invalidBlocker);
      }
    }
  }
  if (!stringValue(entry.expected_document_name).trim()) blockers.push("expected_document_name_missing");
  if (!String(entry.expected_view_id ?? "").trim() && !stringValue(entry.expected_view_name).trim()) blockers.push("expected_view_missing");
  return {
    blockers,
    evidencePaths: [
      ...guiPaths,
      ...requiredPathEntries.map(([, value]) => stringValue(value).trim()).filter(Boolean)
    ]
  };
}

function assertExistingArtifact(filePath: string, baseDir: string, name: string): string {
  const trimmed = stringValue(filePath).trim();
  if (!trimmed) throw new Error(`${name} is required.`);
  const resolved = resolvePromotionArtifactPath(trimmed, baseDir);
  if (!fs.existsSync(resolved)) throw new Error(`${name} not found: ${resolved}`);
  return resolved;
}

function candidateEvidenceBlockers(entry: RedlineLivePromotionEntry, baseDir: string): string[] {
  const blockers: string[] = [];
  const guiPaths = Array.isArray(entry.gui_artifact_paths) ? entry.gui_artifact_paths.filter((value) => typeof value === "string" && value.trim()) : [];
  if (guiPaths.length === 0) blockers.push("gui_artifact_paths_missing");
  for (const guiPath of guiPaths) {
    if (!promotionArtifactExists(guiPath, baseDir)) blockers.push("gui_artifact_path_missing");
  }
  const verificationArtifact = stringValue(entry.verification_artifact).trim();
  const cleanupArtifact = stringValue(entry.cleanup_or_revert_artifact).trim();
  if (!verificationArtifact) blockers.push("verification_artifact_missing");
  else if (!promotionArtifactExists(verificationArtifact, baseDir)) blockers.push("verification_artifact_not_found");
  if (!cleanupArtifact) blockers.push("cleanup_or_revert_artifact_missing");
  else if (!promotionArtifactExists(cleanupArtifact, baseDir)) blockers.push("cleanup_or_revert_artifact_not_found");
  if (!stringValue(entry.expected_document_name).trim()) blockers.push("expected_document_name_missing");
  if (!String(entry.expected_view_id ?? "").trim() && !stringValue(entry.expected_view_name).trim()) blockers.push("expected_view_missing");
  return blockers;
}

function expectedDocumentNameFromPreflight(preflightArtifact: string): string {
  const preflight = asObject(readJsonFile<JsonMap>(preflightArtifact));
  const contextBody = asObject(asObject(preflight.context).body);
  const readiness = asObject(contextBody.readiness);
  const document = asObject(contextBody.document);
  return stringValue(preflight.active_document_name).trim() ||
    stringValue(readiness.active_document_name).trim() ||
    stringValue(document.title).trim();
}

function promotionMatch(record: RedlineLiveReadinessRecord, entries: RedlineLivePromotionEntry[], manifestBaseDir: string): RedlineLivePromotionMatch | undefined {
  const entry = findPromotionEntry(record, entries);
  if (!entry) return undefined;
  const status = stringValue(entry.status) || "unknown";
  const readyToRun = boolValue(entry.ready_to_run);
  const guiReviewed = boolValue(entry.gui_reviewed);
  const writeGrantVerified = boolValue(entry.write_grant_verified);
  const taskEvidenceReviewed = boolValue(entry.task_specific_evidence_reviewed);
  const reviewedBy = stringValue(entry.reviewed_by).trim();
  const reviewNotes = stringValue(entry.review_notes).trim();
  const runSpecific = Boolean(entry.run_id || entry.artifact_dir);
  const blockers: string[] = [];
  const evidence = status === "approved" ? promotionEvidenceBlockers(entry, manifestBaseDir) : { blockers: [], evidencePaths: [] };
  if (!record.bridge_proof_candidate) blockers.push("missing_bridge_proof_candidate");
  if (!runSpecific) blockers.push("promotion_not_run_specific");
  if (status !== "approved") blockers.push("promotion_status_not_approved");
  if (!readyToRun) blockers.push("ready_to_run_not_true");
  if (!guiReviewed) blockers.push("gui_review_missing");
  if (!writeGrantVerified) blockers.push("write_grant_review_missing");
  if (!taskEvidenceReviewed) blockers.push("task_specific_evidence_review_missing");
  if (status === "approved" && !reviewedBy) blockers.push("reviewed_by_missing");
  if (status === "approved" && !reviewNotes) blockers.push("review_notes_missing");
  blockers.push(...evidence.blockers);
  return {
    key: stringValue(entry.key) || entry.run_id || entry.artifact_dir || `${record.task_id}:${record.workflow}`,
    status,
    ready_to_run: readyToRun,
    gui_reviewed: guiReviewed,
    write_grant_verified: writeGrantVerified,
    task_specific_evidence_reviewed: taskEvidenceReviewed,
    approved: blockers.length === 0,
    blocker: blockers.length > 0 ? blockers.join(",") : null,
    evidence_paths: evidence.evidencePaths,
    expected_document_name: stringValue(entry.expected_document_name).trim(),
    expected_view_id: String(entry.expected_view_id ?? "").trim(),
    expected_view_name: stringValue(entry.expected_view_name).trim(),
    reviewed_by: reviewedBy,
    review_notes: reviewNotes
  };
}

function existingFilePath(filePath: string): string | undefined {
  const resolved = path.resolve(filePath);
  return fs.existsSync(resolved) ? resolved : undefined;
}

function existingEvidencePath(filePath: string): string | undefined {
  const trimmed = stringValue(filePath).trim();
  if (!trimmed) return undefined;
  const resolved = path.resolve(trimmed);
  if (fs.existsSync(resolved)) return resolved;
  const parsed = path.parse(resolved);
  if (!parsed.dir || !parsed.name || !parsed.ext || !fs.existsSync(parsed.dir)) return undefined;
  const sibling = fs.readdirSync(parsed.dir).find((entry) => {
    const siblingParsed = path.parse(entry);
    return siblingParsed.ext.toLowerCase() === parsed.ext.toLowerCase() && siblingParsed.name.startsWith(`${parsed.name} `);
  });
  return sibling ? path.join(parsed.dir, sibling) : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => stringValue(value).trim()).filter(Boolean)));
}

function promotionScopeFromSummary(record: RedlineLiveReadinessRecord, summaryRows: JsonMap[]): { promotion_scope?: string; operation_class?: string; target_class?: string } {
  const primitives = summaryRows.map((row) => stringValue(row.primitive)).filter(Boolean);
  const hasPrimitive = (pattern: RegExp) => primitives.some((primitive) => pattern.test(primitive));
  let operationClass = "";
  let targetClass = "";
  if (record.task_id === "demo_documentation_primitives") {
    if (hasPrimitive(/^category_visibility/)) {
      operationClass = "graphics_override";
      targetClass = "category_graphics";
    } else if (hasPrimitive(/^filter_visibility/)) {
      operationClass = "graphics_override";
      targetClass = "view_filter";
    } else if (hasPrimitive(/^schedule|configure_schedule/)) {
      operationClass = "text_edit";
      targetClass = "schedule";
    } else if (hasPrimitive(/^text_note/)) {
      operationClass = "text_edit";
      targetClass = "text";
    }
  } else if (record.task_id === "demo_redline_type_change_duct") {
    operationClass = "type_change";
    targetClass = "duct";
  } else if (record.task_id === "demo_redline_update_parameter") {
    operationClass = "parameter_edit";
    targetClass = "model_parameter";
  } else if (record.task_id === "demo_redline_mep_pipe_size_transition") {
    operationClass = "change_size";
    targetClass = "pipe";
  } else if (record.task_id === "demo_redline_mep_pipe_tap_branch") {
    operationClass = "tap_branch";
    targetClass = "pipe";
  } else if (record.task_id === "demo_redline_mep_duct_tap_branch") {
    operationClass = "tap_branch";
    targetClass = "duct";
  } else if (record.task_id === "demo_redline_mep_pipe_reroute") {
    operationClass = "reroute_offset";
    targetClass = "pipe";
  } else if (record.task_id === "demo_redline_mep_duct_reroute") {
    operationClass = "reroute_offset";
    targetClass = "duct";
  } else if (record.task_id === "demo_redline_mep_pipe_route") {
    operationClass = "route_creation";
    targetClass = "pipe";
  } else if (record.task_id === "demo_redline_mep_route") {
    operationClass = "route_creation";
    targetClass = "duct";
  } else if (record.task_id === "demo_redline_delete_pipe_route") {
    operationClass = "delete";
    targetClass = "pipe";
  } else if (record.task_id === "demo_redline_delete_duct_route") {
    operationClass = "delete";
    targetClass = "duct";
  } else if (record.task_id === "demo_redline_delete_text") {
    operationClass = "delete";
    targetClass = "text";
  } else if (record.task_id === "demo_redline_move_tag") {
    operationClass = "move";
    targetClass = "tag";
  } else if (record.task_id === "demo_redline_add_tag") {
    operationClass = "add";
    targetClass = "tag";
  } else if (record.task_id === "demo_redline_rotate_text") {
    operationClass = "rotate";
    targetClass = "text";
  }
  return operationClass && targetClass
    ? { promotion_scope: `${operationClass}/${targetClass}`, operation_class: operationClass, target_class: targetClass }
    : {};
}

function generatedCandidateEvidence(record: RedlineLiveReadinessRecord): Partial<RedlineLivePromotionEntry> {
  const artifactsDir = path.join(record.artifact_dir, "artifacts");
  const workflowResultPath = existingFilePath(path.join(record.artifact_dir, "revit_workflow_result.json"));
  const moveSummaryPath = existingFilePath(path.join(artifactsDir, "redline_move_summary.json"));
  const moveVisualGatePath = existingFilePath(path.join(artifactsDir, "redline_move_visual_gate.json"));
  const addSummaryPath = existingFilePath(path.join(artifactsDir, "redline_add_summary.json"));
  const addVisualGatePath = existingFilePath(path.join(artifactsDir, "redline_add_visual_gate.json"));
  const deleteSummaryPath = existingFilePath(path.join(artifactsDir, "redline_delete_summary.json"));
  const deleteVisualGatePath = existingFilePath(path.join(artifactsDir, "redline_delete_visual_gate.json"));
  const rotateSummaryPath = existingFilePath(path.join(artifactsDir, "redline_rotate_summary.json"));
  const rotateVisualGatePath = existingFilePath(path.join(artifactsDir, "redline_rotate_visual_gate.json"));
  const documentationSummaryPath = existingFilePath(path.join(artifactsDir, "documentation_primitives_summary.json"));
  const updateParameterSummaryPath = existingFilePath(path.join(artifactsDir, "redline_update_parameter_summary.json"));
  const typeChangeSummaryPath = existingFilePath(path.join(artifactsDir, "redline_type_change_summary.json"));
  const sizeTransitionSummaryPath = existingFilePath(path.join(artifactsDir, "redline_mep_size_transition_summary.json"));
  const rerouteSummaryPath = existingFilePath(path.join(artifactsDir, "redline_mep_reroute_summary.json"));
  const routeSummaryPath = existingFilePath(path.join(artifactsDir, "redline_mep_route_summary.json"));
  const routeVisualGatePath = existingFilePath(path.join(artifactsDir, "redline_visual_gate.json"));
  const branchSummaryPath =
    existingFilePath(path.join(artifactsDir, "redline_mep_pipe_tap_branch_summary.json")) ??
    existingFilePath(path.join(artifactsDir, "redline_mep_tap_branch_summary.json"));
  const summaryPath = moveSummaryPath ?? addSummaryPath ?? deleteSummaryPath ?? rotateSummaryPath ?? documentationSummaryPath ?? updateParameterSummaryPath ?? typeChangeSummaryPath ?? sizeTransitionSummaryPath ?? branchSummaryPath ?? rerouteSummaryPath ?? routeSummaryPath;
  const visualGatePath = moveVisualGatePath ?? addVisualGatePath ?? deleteVisualGatePath ?? rotateVisualGatePath ?? routeVisualGatePath;
  const visualGate = visualGatePath ? asObject(readJsonFile<JsonMap>(visualGatePath)) : {};
  const summary = summaryPath ? asObject(readJsonFile<JsonMap>(summaryPath)) : {};
  const rawWorkflowResult = asObject(summary.rawWorkflowResult);
  const rawVisualVerification = asObject(rawWorkflowResult.visualVerification);
  const rawVisualCapture = asObject(rawVisualVerification.capture);
  const rawRoutingContext = asObject(rawWorkflowResult.routingContext);
  const rawRoutingView = asObject(rawRoutingContext.view);
  const summaryRows = Array.isArray(summary.rows) ? summary.rows.map(asObject) : [];
  const documentationCaptureRow = summaryRows.find((row) => stringValue(row.primitive) === "post_change_capture") ?? {};
  const documentationFinalCaptureRow = summaryRows.find((row) => stringValue(row.primitive) === "final_capture") ?? {};
  const documentationGraphicsCaptureRows = summaryRows.filter((row) => {
    const primitive = stringValue(row.primitive);
    return primitive === "category_visibility_post_apply_capture" || primitive === "filter_visibility_post_apply_capture";
  });
  const documentationTagValueRow = summaryRows.find((row) => stringValue(row.primitive) === "tag_value_edit") ?? {};
  const documentationScheduleRows = summaryRows.filter((row) => stringValue(row.primitive).startsWith("schedule_"));
  const summaryRawResults = Array.isArray(summary.rawResults) ? summary.rawResults.map(asObject) : [];
  const summaryRawDocumentTitle = summaryRawResults.map((row) => stringValue(row.documentTitle)).find(Boolean);
  const guiArtifactPaths = uniqueStrings([
    stringValue(visualGate.beforeCapturePath),
    stringValue(visualGate.afterCapturePath),
    stringValue(visualGate.finalCapturePath),
    stringValue(summary.beforeCapturePath),
    stringValue(summary.afterCapturePath),
    stringValue(summary.finalCapturePath),
    stringValue(summary.capturePath),
    stringValue(summary.postChangeCapturePath),
    stringValue(summary.finalCapturePath),
    stringValue(asObject(visualGate.evidence).after_capture_path),
    stringValue(rawVisualVerification.capturePath),
    stringValue(rawVisualCapture.path),
    stringValue(documentationCaptureRow.path),
    stringValue(documentationFinalCaptureRow.path),
    ...documentationGraphicsCaptureRows.map((row) => stringValue(row.path)),
    ...documentationScheduleRows.map((row) => stringValue(row.csvPath))
  ].map((filePath) => existingEvidencePath(filePath)));
  const expectedDocumentName =
    stringValue(asObject(asObject(summary.rawFinalAfterRevert).source).hostDocumentTitle) ||
    stringValue(asObject(asObject(summary.rawAfterMove).source).hostDocumentTitle) ||
    stringValue(asObject(asObject(summary.rawFinalCapture).source).hostDocumentTitle) ||
    summaryRawDocumentTitle;
  const expectedViewId =
    summary.viewId ??
    visualGate.viewId ??
    summary.postChangeCaptureViewId ??
    rawRoutingView.id ??
    documentationCaptureRow.reportedViewId ??
    documentationCaptureRow.id ??
    documentationCaptureRow.parent ??
    documentationTagValueRow.parent ??
    summary.scheduleId;
  const expectedViewName =
    stringValue(summary.viewName) ||
    stringValue(rawRoutingView.name) ||
    stringValue(summary.scheduleName);
  return {
    ...(guiArtifactPaths.length > 0 ? { gui_artifact_paths: guiArtifactPaths } : {}),
    ...(workflowResultPath ? { verification_artifact: workflowResultPath } : {}),
    ...(summaryPath ? { cleanup_or_revert_artifact: summaryPath } : {}),
    ...promotionScopeFromSummary(record, summaryRows),
    ...(expectedDocumentName ? { expected_document_name: expectedDocumentName } : {}),
    ...(String(expectedViewId ?? "").trim() ? { expected_view_id: expectedViewId as string | number } : {}),
    ...(expectedViewName ? { expected_view_name: expectedViewName } : {})
  };
}

export function generateRedlineLiveReadinessReport(artifactsDir: string, options: { promotionManifestPath?: string; minimumReviewedPromotionsPerWorkflow?: number } = {}): RedlineLiveReadinessReport {
  const runJsonFiles = recursiveFindRunJsonFiles(artifactsDir);
  const records: RedlineLiveReadinessRecord[] = [];
  const promotionManifest = readPromotionManifest(options.promotionManifestPath);
  const promotionEntries = promotionManifest.entries;
  const minimumReviewedPromotionsPerWorkflow = Math.max(1, Math.floor(numberValue(options.minimumReviewedPromotionsPerWorkflow) || 2));
  let missingResultFiles = 0;
  let nonRedlineRuns = 0;

  for (const runJsonPath of runJsonFiles) {
    const run = readJsonFile<BenchmarkRunRecord>(runJsonPath);
    const resultPath = path.join(run.artifact_dir, "revit_workflow_result.json");
    if (!fs.existsSync(resultPath)) {
      missingResultFiles += 1;
      continue;
    }
    const result = readJsonFile<JsonMap>(resultPath);
    const workflow = stringValue(result.workflow);
    const verifications = Array.isArray(result.verification_results) ? result.verification_results.map(asObject) : [];
    const isRedlineRun = workflowIsRedline(workflow, run.task_id) || hasRedlineDocumentationEvidence(run.task_id, verifications);
    if (!isRedlineRun) {
      nonRedlineRuns += 1;
      continue;
    }
    const verificationPassed = verifications.filter((entry) => boolValue(entry.ok)).length;
    const verificationTotal = verifications.length;
    const execution = executionSource(result.execution_source);
    const success = boolValue(result.success);
    const revitTransactions = numberValue(result.revit_transactions);
    const bridgeProofCandidate = execution === "live" && success && revitTransactions > 0 && verificationTotal > 0 && verificationPassed === verificationTotal;
    const record: RedlineLiveReadinessRecord = {
      task_id: run.task_id,
      config_id: run.config_id,
      repeat_index: run.repeat_index,
      run_id: run.run_id,
      workflow,
      execution_source: execution,
      success,
      verification_passed: verificationPassed,
      verification_total: verificationTotal,
      tool_calls: numberValue(result.tool_calls),
      revit_transactions: revitTransactions,
      computer_use_actions: numberValue(result.computer_use_actions),
      artifact_dir: run.artifact_dir,
      failure_reason: stringValue(result.failure_reason) || null,
      ...(stringValue(result.failure_classification) ? { failure_classification: stringValue(result.failure_classification) } : {}),
      bridge_proof_candidate: bridgeProofCandidate
    };
    const promotion = promotionMatch(record, promotionEntries, promotionManifest.base_dir);
    if (promotion) record.promotion = promotion;
    records.push(record);
  }

  const byWorkflow: RedlineLiveReadinessReport["by_workflow"] = {};
  for (const record of records) {
    const entry = byWorkflow[record.workflow] ?? {
      total: 0,
      live: 0,
      live_successes: 0,
      live_full_verification: 0,
      reviewed_live_promotions: 0,
      repeatability_ready: false
    };
    entry.total += 1;
    if (record.execution_source === "live") entry.live += 1;
    if (record.execution_source === "live" && record.success) entry.live_successes += 1;
    if (record.execution_source === "live" && record.success && record.verification_total > 0 && record.verification_passed === record.verification_total) {
      entry.live_full_verification += 1;
    }
    if (record.promotion?.approved === true) entry.reviewed_live_promotions += 1;
    byWorkflow[record.workflow] = entry;
  }
  for (const entry of Object.values(byWorkflow)) {
    entry.repeatability_ready = entry.reviewed_live_promotions >= minimumReviewedPromotionsPerWorkflow;
  }

  const liveRecords = records.filter((record) => record.execution_source === "live");
  const liveSuccesses = liveRecords.filter((record) => record.success);
  const liveAllEmittedVerificationsPassed = liveSuccesses.filter((record) => record.verification_total > 0 && record.verification_passed === record.verification_total);
  const bridgeProofCandidates = records.filter((record) => record.bridge_proof_candidate);
  const reviewedPromotionWorkflows = Object.values(byWorkflow).filter((entry) => entry.reviewed_live_promotions > 0);
  return {
    generated_at: nowIso(),
    artifacts_dir: artifactsDir,
    ...(options.promotionManifestPath ? { promotion_manifest_path: options.promotionManifestPath } : {}),
    minimum_reviewed_promotions_per_workflow: minimumReviewedPromotionsPerWorkflow,
    metrics: {
      total_runs: runJsonFiles.length,
      discovered_run_json_files: runJsonFiles.length,
      missing_result_files: missingResultFiles,
      non_redline_runs: nonRedlineRuns,
      analyzed_redline_runs: records.length,
      redline_workflow_runs: records.length,
      live_runs: liveRecords.length,
      live_successes: liveSuccesses.length,
      live_failures: liveRecords.length - liveSuccesses.length,
      live_with_revit_transactions: liveRecords.filter((record) => record.revit_transactions > 0).length,
      live_all_emitted_verifications_passed: liveAllEmittedVerificationsPassed.length,
      bridge_proof_candidates: bridgeProofCandidates.length,
      reviewed_live_promotions: records.filter((record) => record.promotion?.approved === true).length,
      workflows_with_reviewed_live_promotions: reviewedPromotionWorkflows.length,
      workflows_meeting_repeatability_minimum: reviewedPromotionWorkflows.filter((entry) => entry.repeatability_ready).length
    },
    records,
    by_workflow: byWorkflow
  };
}

function redlineLiveReadinessMarkdown(report: RedlineLiveReadinessReport): string {
  const recordRows = report.records.map((record) => [
    record.task_id,
    record.workflow,
    record.execution_source,
    record.success ? "yes" : "no",
    `${record.verification_passed}/${record.verification_total}`,
    record.revit_transactions,
    record.bridge_proof_candidate ? "yes" : "no",
    record.promotion?.approved ? "yes" : "no",
    record.promotion?.blocker ?? "",
    record.failure_classification ?? "",
    record.failure_reason ?? ""
  ]);
  const workflowRows = Object.entries(report.by_workflow)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([workflow, entry]) => [
      workflow,
      entry.total,
      entry.live,
      entry.live_successes,
      entry.live_full_verification,
      entry.reviewed_live_promotions,
      entry.repeatability_ready ? "yes" : "no"
    ]);
  return [
    "# Redline Live Readiness Report",
    "",
    `Generated: ${report.generated_at}`,
    `Artifacts: ${report.artifacts_dir}`,
    ...(report.promotion_manifest_path ? [`Promotion manifest: ${report.promotion_manifest_path}`] : []),
    `Minimum reviewed promotions per workflow: ${report.minimum_reviewed_promotions_per_workflow}`,
    "",
    "## Metrics",
    "",
    markdownTable(["metric", "value"], Object.entries(report.metrics)),
    "",
    "## By Workflow",
    "",
    workflowRows.length > 0
      ? markdownTable(["workflow", "total", "live", "live_successes", "live_full_verification", "reviewed_live_promotions", "repeatability_ready"], workflowRows)
      : "_No redline workflow runs found._",
    "",
    "## Runs",
    "",
    recordRows.length > 0
      ? markdownTable(["task_id", "workflow", "source", "success", "verification", "transactions", "bridge_proof", "reviewed_promotion", "promotion_blocker", "failure_class", "failure"], recordRows)
      : "_No redline workflow runs found._",
    "",
    "## Notes",
    "",
    "- This report summarizes live benchmark evidence only.",
    "- It does not change corpus fixture scorecard `executable` counts.",
    "- `bridge_proof_candidates` means live bridge/model-write evidence with all emitted verifier rows passing; it is not a corpus scorecard executable claim.",
    "- `reviewed_live_promotions` requires bridge proof plus an approved promotion manifest entry with GUI review, write-grant review, task-specific evidence review, and `ready_to_run:true`.",
    "- `repeatability_ready` is a reporting gate only. It requires at least the configured minimum reviewed promotions for a workflow and does not change fixture/corpus executable counts.",
    "- True executable readiness still requires grounded promoted overrides, task-specific evidence gates, write-grant proof, GUI/computer-use review, and review of run artifacts."
  ].join("\n");
}

export function writeRedlineLiveReadinessReport(options: WriteRedlineLiveReadinessOptions): {
  json_path: string;
  markdown_path: string;
  report: RedlineLiveReadinessReport;
} {
  const report = generateRedlineLiveReadinessReport(options.artifactsDir, {
    promotionManifestPath: options.promotionManifestPath,
    minimumReviewedPromotionsPerWorkflow: options.minimumReviewedPromotionsPerWorkflow
  });
  const outputDir = options.outputDir ?? path.join(options.artifactsDir, "redline_live_readiness");
  const jsonPath = path.join(outputDir, "redline_live_readiness.json");
  const markdownPath = path.join(outputDir, "redline_live_readiness.md");
  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, redlineLiveReadinessMarkdown(report));
  return { json_path: jsonPath, markdown_path: markdownPath, report };
}

export function writeRedlineLivePromotionManifest(options: WriteRedlineLivePromotionManifestOptions): {
  manifest_path: string;
  manifest: RedlineLivePromotionManifest;
  candidate_count: number;
  approved_count: number;
} {
  const report = generateRedlineLiveReadinessReport(options.artifactsDir);
  const promotions = report.records
    .filter((record) => record.bridge_proof_candidate)
    .map((record): RedlineLivePromotionEntry => {
      const candidateEvidence = generatedCandidateEvidence(record);
      return {
        key: `${record.task_id}:${record.run_id}`,
        run_id: record.run_id,
        task_id: record.task_id,
        workflow: record.workflow,
        artifact_dir: record.artifact_dir,
        status: "candidate",
        ready_to_run: false,
        gui_reviewed: false,
        write_grant_verified: false,
        task_specific_evidence_reviewed: false,
        ...candidateEvidence,
        reviewed_by: options.reviewedBy ?? "",
        review_notes: options.reviewNotes ?? "Candidate generated from live bridge proof; review artifacts before approval."
      };
    });
  const manifest: RedlineLivePromotionManifest = {
    schema_version: 1,
    generated_at: nowIso(),
    source_artifacts_dir: options.artifactsDir,
    promotions
  };
  writeJsonFile(options.outputPath, manifest);
  return {
    manifest_path: options.outputPath,
    manifest,
    candidate_count: promotions.length,
    approved_count: 0
  };
}

export function writeApprovedRedlineLivePromotionManifest(options: WriteApprovedRedlineLivePromotionManifestOptions): {
  manifest_path: string;
  manifest: RedlineLivePromotionManifest;
  approved_count: number;
} {
  const reviewedBy = options.reviewedBy.trim();
  const reviewNotes = options.reviewNotes.trim();
  if (!reviewedBy) throw new Error("reviewed_by is required.");
  if (!reviewNotes) throw new Error("review_notes is required.");
  const hasRunSelector = typeof options.runId === "string" && options.runId.trim().length > 0;
  const hasArtifactSelector = typeof options.artifactDir === "string" && options.artifactDir.trim().length > 0;
  if (!hasRunSelector && !hasArtifactSelector) {
    throw new Error("A run-specific selector is required: provide --run-id or --artifact-dir.");
  }

  const candidateSource = readFullPromotionManifest(options.candidateManifestPath);
  const candidateBaseDir = candidateSource.base_dir;
  const artifactSelector = hasArtifactSelector ? normalizePathKey(options.artifactDir ?? "") : "";
  const matches = (candidateSource.manifest.promotions ?? []).filter((entry) => {
    if (hasRunSelector && entry.run_id !== options.runId) return false;
    if (hasArtifactSelector && normalizePathKey(entry.artifact_dir ?? "") !== artifactSelector) return false;
    return true;
  });
  if (matches.length === 0) throw new Error("No candidate promotion matched the requested run selector.");
  if (matches.length > 1) throw new Error("Multiple candidate promotions matched the requested run selector; use a narrower selector.");

  const candidate = matches[0];
  if (stringValue(candidate.status) !== "candidate") {
    throw new Error(`Only candidate promotions can be approved; found status: ${stringValue(candidate.status) || "unknown"}`);
  }
  const preflightArtifact = assertExistingArtifact(options.preflightArtifact, ".", "preflight_artifact");
  const writeGrantStatusArtifact = assertExistingArtifact(options.writeGrantStatusArtifact ?? options.preflightArtifact, ".", "write_grant_status_artifact");
  if (!preflightArtifactOk(preflightArtifact)) throw new Error("preflight_artifact must show ok preflight with active write grant.");
  if (!writeGrantArtifactActive(writeGrantStatusArtifact)) throw new Error("write_grant_status_artifact must show an active write grant.");
  const expectedDocumentName = stringValue(candidate.expected_document_name).trim() || expectedDocumentNameFromPreflight(preflightArtifact);
  const candidateWithPreflightContext: RedlineLivePromotionEntry = {
    ...candidate,
    expected_document_name: expectedDocumentName
  };
  const evidenceBlockers = candidateEvidenceBlockers(candidateWithPreflightContext, candidateBaseDir);
  if (evidenceBlockers.length > 0) {
    throw new Error(`Candidate promotion is missing required evidence: ${evidenceBlockers.join(",")}`);
  }

  const approvedEntry: RedlineLivePromotionEntry = {
    ...candidateWithPreflightContext,
    status: "approved",
    ready_to_run: true,
    gui_reviewed: true,
    write_grant_verified: true,
    task_specific_evidence_reviewed: true,
    write_grant_status_artifact: writeGrantStatusArtifact,
    preflight_artifact: preflightArtifact,
    reviewed_by: reviewedBy,
    review_notes: reviewNotes
  };
  const manifest: RedlineLivePromotionManifest = {
    schema_version: 1,
    generated_at: nowIso(),
    source_artifacts_dir: candidateSource.manifest.source_artifacts_dir,
    promotions: [approvedEntry]
  };
  writeJsonFile(options.outputPath, manifest);
  return {
    manifest_path: options.outputPath,
    manifest,
    approved_count: 1
  };
}

export function mergeRedlineLivePromotionManifests(options: MergeRedlineLivePromotionManifestOptions): {
  manifest_path: string;
  manifest: RedlineLivePromotionManifest;
  merged_count: number;
} {
  if (options.inputPaths.length === 0) throw new Error("At least one promotion manifest input is required.");
  const promotions: RedlineLivePromotionEntry[] = [];
  const seen = new Set<string>();
  for (const inputPath of options.inputPaths) {
    const source = readFullPromotionManifest(inputPath);
    for (const entry of source.manifest.promotions ?? []) {
      if (stringValue(entry.status) !== "approved") {
        throw new Error(`Cannot merge non-approved promotion from ${inputPath}: ${entry.run_id ?? entry.key ?? "unknown"}`);
      }
      const identity = entry.run_id || entry.artifact_dir || entry.key;
      if (!identity) throw new Error(`Cannot merge promotion without run_id, artifact_dir, or key from ${inputPath}.`);
      const duplicateKey = normalizePathKey(`${entry.workflow ?? ""}:${identity}`);
      if (seen.has(duplicateKey)) throw new Error(`Duplicate promotion identity: ${identity}`);
      seen.add(duplicateKey);
      promotions.push(entry);
    }
  }
  const manifest: RedlineLivePromotionManifest = {
    schema_version: 1,
    generated_at: nowIso(),
    promotions
  };
  writeJsonFile(options.outputPath, manifest);
  return {
    manifest_path: options.outputPath,
    manifest,
    merged_count: promotions.length
  };
}
