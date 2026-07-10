import fs from "node:fs";
import path from "node:path";
import { ensureDir, nowIso, readJsonFile, safeSlug, writeJsonFile, writeTextFile } from "./files.js";
import { cleanupOrRevertArtifactOk, preflightArtifactOk, promotionArtifactExists, resolvePromotionArtifactPath, verificationArtifactOk, writeGrantArtifactActive } from "./redline_promotion_evidence.js";
import type { BenchmarkTaskDefinition } from "./types.js";
import type { RedlineLivePromotionEntry, RedlineLivePromotionManifest } from "./redline_live_readiness.js";
import type {
  RedlineContextClass,
  RedlineCorpusBenchmarkQueueItem,
  RedlineCorpusClassification,
  RedlineCorpusReport,
  RedlineEvidenceRequirement,
  RedlineOperationClass,
  RedlineTargetClass
} from "../redline/corpus_classifier.js";

export type RedlineStructuredActionRecord = {
  redline_id: string;
  source_file_path: string;
  redline_type: string;
  confidence: number;
  classified_with_confidence: boolean;
  actionable: boolean;
  not_actionable: boolean;
  target: {
    strategy: "element_id" | "nearest_element" | "selected_element" | "view_region" | "sheet_location" | "unresolved";
    element_id?: string;
    element_type?: string;
    view_name?: string;
    sheet_number?: string;
    location?: unknown;
  };
  action: {
    skill: string | null;
    benchmark_task_id: string | null;
    benchmark_task_exists: boolean;
    workflow: string | null;
    parameters: Record<string, unknown>;
  };
  required_context: string[];
  missing_live_inputs: string[];
  evidence_requirements: RedlineEvidenceRequirement[];
  live_evidence: {
    reviewed_live_evidence_available: boolean;
    repeatability_ready: boolean;
    promotion_keys: string[];
    blockers: string[];
  };
  dry_run_possible: boolean;
  backend_ready_without_missing_inputs: boolean;
  executable: boolean;
  needs_human_review: boolean;
  human_review_reason: string | null;
  failure_clusters: string[];
  missing_skills: string[];
};

export type RedlineHardeningScorecardMetrics = {
  total_redlines_evaluated: number;
  classified_with_confidence: number;
  actionable: number;
  structured_action_produced: number;
  routed_to_existing_skill_or_benchmark_task: number;
  dry_run_possible: number;
  backend_ready_without_missing_inputs: number;
  executable: number;
  reviewed_live_evidence_available: number;
  repeatability_ready: number;
  needs_human_review: number;
  not_actionable: number;
};

export type RedlineHardeningScorecard = {
  schema_version: 1;
  generated_at: string;
  source: {
    input_path?: string;
    promotion_manifest_path?: string;
    fixture_mode: boolean;
    confidence_threshold: number;
    minimum_reviewed_promotions_per_workflow: number;
  };
  metrics: RedlineHardeningScorecardMetrics;
  top_failure_clusters: Array<{ cluster: string; count: number }>;
  top_required_context: Array<{ context: string; count: number }>;
  top_missing_skills: Array<{ skill: string; count: number }>;
  by_redline_type: Record<string, number>;
  by_benchmark_task: Record<string, number>;
  records: RedlineStructuredActionRecord[];
};

type InputShape =
  | RedlineCorpusReport
  | { items: RedlineCorpusClassification[]; live_benchmark_queue?: RedlineCorpusBenchmarkQueueItem[] }
  | RedlineCorpusClassification[]
  | { classifications: RedlineCorpusClassification[]; live_benchmark_queue?: RedlineCorpusBenchmarkQueueItem[] };

export type RedlineHardeningScorecardOptions = {
  inputPath?: string;
  input?: InputShape;
  benchmarkTasks: BenchmarkTaskDefinition[];
  confidenceThreshold?: number;
  promotionManifestPath?: string;
  minimumReviewedPromotionsPerWorkflow?: number;
  fixtureMode?: boolean;
};

export type RedlineHardeningScorecardWriteOptions = RedlineHardeningScorecardOptions & {
  outputDir: string;
};

export type RedlineHardeningScorecardPaths = {
  json_path: string;
  markdown_path: string;
  scorecard: RedlineHardeningScorecard;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function topCounts(values: string[], limit = 10): Array<{ cluster: string; count: number }> {
  return Object.entries(countBy(values))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([cluster, count]) => ({ cluster, count }));
}

function topMissing(values: string[], limit = 10): Array<{ skill: string; count: number }> {
  return Object.entries(countBy(values))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([skill, count]) => ({ skill, count }));
}

function topRequiredContext(values: string[], limit = 15): Array<{ context: string; count: number }> {
  return Object.entries(countBy(values))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([context, count]) => ({ context, count }));
}

function normalizeInput(input: InputShape): {
  items: RedlineCorpusClassification[];
  queue: RedlineCorpusBenchmarkQueueItem[];
} {
  if (Array.isArray(input)) return { items: input, queue: [] };
  const obj = asObject(input);
  const items = Array.isArray(obj.items)
    ? obj.items as RedlineCorpusClassification[]
    : Array.isArray(obj.classifications)
      ? obj.classifications as RedlineCorpusClassification[]
      : [];
  const queue = Array.isArray(obj.live_benchmark_queue) ? obj.live_benchmark_queue as RedlineCorpusBenchmarkQueueItem[] : [];
  return { items, queue };
}

function itemKey(filePath: string, operation: RedlineOperationClass, target: RedlineTargetClass): string {
  return `${filePath}::${operation}::${target}`;
}

function queueByClassification(queue: RedlineCorpusBenchmarkQueueItem[]): Map<string, RedlineCorpusBenchmarkQueueItem[]> {
  const map = new Map<string, RedlineCorpusBenchmarkQueueItem[]>();
  for (const entry of queue) {
    const key = itemKey(entry.file_path, entry.operation_class, entry.target_class);
    map.set(key, [...(map.get(key) ?? []), entry]);
  }
  return map;
}

function taskWorkflow(task: BenchmarkTaskDefinition | undefined): string | null {
  const workflow = asObject(task?.adapter_config).workflow;
  return typeof workflow === "string" && workflow.trim() ? workflow : null;
}

function taskSkillName(task: BenchmarkTaskDefinition | undefined): string | null {
  const workflow = taskWorkflow(task);
  if (workflow) return workflow;
  if (task?.environment.adapter_id === "revit_workflow") return "revit_workflow";
  return task?.environment.adapter_id ?? null;
}

function normalizedRecommendedBenchmarkTasks(item: RedlineCorpusClassification): string[] {
  const tasks = item.recommended_benchmark_tasks ?? [];
  if (item.operation_class === "parameter_edit" && item.target_class === "model_parameter") {
    return unique(["demo_redline_update_parameter", ...tasks]);
  }
  return tasks;
}

function targetStrategy(target: RedlineTargetClass, context: RedlineContextClass): RedlineStructuredActionRecord["target"]["strategy"] {
  if (target === "sheet") return "sheet_location";
  if (context === "sheet") return "sheet_location";
  if (context === "view" || context === "annotation" || target === "text" || target === "tag") return "view_region";
  if (["duct", "pipe", "mep_accessory", "family_instance", "receptacle", "light", "model_parameter"].includes(target)) return "nearest_element";
  return "unresolved";
}

function looksNonActionable(item: RedlineCorpusClassification): boolean {
  if (item.operation_class !== "unknown" || item.target_class !== "unknown") return false;
  const reason = item.manual_review_reason ?? "";
  return /not actionable|status\/reference|highlight\/status|callout\/reference|no operation or target|composite\/grouped mark/i.test(reason);
}

function missingSkillName(item: RedlineCorpusClassification): string {
  if (
    item.operation_class === "resize" &&
    item.target_class === "schedule" &&
    /row[_ -]?height/i.test([
      item.text_excerpt,
      ...(item.matched_rules ?? [])
    ].filter(Boolean).join(" "))
  ) {
    return "redline_resize_schedule_row_height";
  }
  return `redline_${item.operation_class}_${item.target_class}`;
}

function intentionallyUnsupportedRouteReason(item: RedlineCorpusClassification): string {
  if (item.operation_class === "type_change" && item.target_class === "text") {
    return "Text type-change redlines are intentionally not routed; reclassify as text_edit/text only after human review confirms a wording replacement.";
  }
  return "";
}

function failureClusters(args: {
  item: RedlineCorpusClassification;
  classifiedWithConfidence: boolean;
  taskExists: boolean;
  selectedTaskId: string | null;
  missingLiveInputs: string[];
  notActionable: boolean;
  unsupportedRouteReason?: string;
  rowLinkedPromotionBlocker?: string;
}): string[] {
  const clusters: string[] = [];
  if (args.notActionable) clusters.push("not_actionable");
  if (args.item.manual_review_reason) clusters.push("manual_review");
  if (args.unsupportedRouteReason) clusters.push("unsupported_operation");
  if (!args.classifiedWithConfidence) clusters.push("low_confidence");
  if (args.item.operation_class === "unknown") clusters.push("unknown_operation");
  if (args.item.target_class === "unknown") clusters.push("unknown_target");
  if (!args.selectedTaskId && !args.notActionable) clusters.push("missing_benchmark_route");
  if (args.selectedTaskId && !args.taskExists) clusters.push("mapped_task_missing_from_registry");
  if (args.missingLiveInputs.length > 0) clusters.push("missing_live_inputs");
  if (args.rowLinkedPromotionBlocker) clusters.push(args.rowLinkedPromotionBlocker);
  return unique(clusters);
}

function containsFillPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /__FILL_[A-Z0-9_]+__/i.test(value);
  if (Array.isArray(value)) return value.some(containsFillPlaceholder);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(containsFillPlaceholder);
  return false;
}

function isRunnableOverrideQueueItem(entry: RedlineCorpusBenchmarkQueueItem): boolean {
  const obj = entry as RedlineCorpusBenchmarkQueueItem & {
    ready_to_run?: unknown;
    live_request_status?: unknown;
    status?: unknown;
    placeholder_count?: unknown;
    placeholders?: unknown;
    placeholder_paths?: unknown;
  };
  const ready = obj.ready_to_run === true || String(obj.live_request_status ?? "") === "ready_to_run";
  if (!ready) return false;

  const status = String(obj.status ?? "").trim().toLowerCase();
  if (status && status !== "ready_to_run" && status !== "ready" && status !== "approved") return false;

  const placeholderCount = Number(obj.placeholder_count ?? 0);
  if (Number.isFinite(placeholderCount) && placeholderCount > 0) return false;
  if (Array.isArray(obj.placeholders) && obj.placeholders.length > 0) return false;
  if (Array.isArray(obj.placeholder_paths) && obj.placeholder_paths.length > 0) return false;
  if (containsFillPlaceholder(entry)) return false;
  return true;
}

function queueItemPromotionKeys(entry: RedlineCorpusBenchmarkQueueItem): string[] {
  const obj = entry as RedlineCorpusBenchmarkQueueItem & {
    live_promotion_key?: unknown;
    promotion_key?: unknown;
    run_id?: unknown;
    artifact_dir?: unknown;
  };
  return unique([
    stringValue(obj.live_promotion_key).trim(),
    stringValue(obj.promotion_key).trim(),
    stringValue(obj.run_id).trim(),
    stringValue(obj.artifact_dir).trim()
  ]);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
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

function promotionBlockers(entry: RedlineLivePromotionEntry, baseDir: string): string[] {
  const blockers: string[] = [];
  const runSpecific = Boolean(entry.run_id || entry.artifact_dir);
  if (!runSpecific) blockers.push("promotion_not_run_specific");
  if (entry.status !== "approved") blockers.push("promotion_status_not_approved");
  if (!boolValue(entry.ready_to_run)) blockers.push("ready_to_run_false");
  if (!boolValue(entry.gui_reviewed)) blockers.push("gui_reviewed_false");
  if (!boolValue(entry.write_grant_verified)) blockers.push("write_grant_verified_false");
  if (!boolValue(entry.task_specific_evidence_reviewed)) blockers.push("task_specific_evidence_reviewed_false");
  if (!stringValue(entry.reviewed_by).trim()) blockers.push("reviewed_by_missing");
  if (!stringValue(entry.review_notes).trim()) blockers.push("review_notes_missing");
  const guiPaths = Array.isArray(entry.gui_artifact_paths) ? entry.gui_artifact_paths.filter((value) => typeof value === "string" && value.trim()) : [];
  if (guiPaths.length === 0) blockers.push("gui_artifact_paths_missing");
  for (const guiPath of guiPaths) {
    if (!promotionArtifactExists(guiPath, baseDir)) blockers.push("gui_artifact_path_missing");
  }
  const requiredPathEntries: Array<[string, unknown, (filePath: string) => boolean, string]> = [
    ["write_grant_status_artifact", entry.write_grant_status_artifact, writeGrantArtifactActive, "write_grant_status_artifact_not_active"],
    ["preflight_artifact", entry.preflight_artifact, preflightArtifactOk, "preflight_artifact_not_ok"],
    ["verification_artifact", entry.verification_artifact, verificationArtifactOk, "verification_artifact_not_successful"],
    ["cleanup_or_revert_artifact", entry.cleanup_or_revert_artifact, cleanupOrRevertArtifactOk, "cleanup_or_revert_artifact_missing_cleanup_evidence"]
  ];
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
  return unique(blockers);
}

function promotionKey(entry: RedlineLivePromotionEntry): string {
  return stringValue(entry.key).trim() || stringValue(entry.run_id).trim() || [
    stringValue(entry.task_id).trim(),
    stringValue(entry.workflow).trim(),
    stringValue(entry.artifact_dir).trim()
  ].filter(Boolean).join("::");
}

function taskPromotionKey(taskId: string | null, workflow: string | null): string {
  return `${taskId ?? ""}::${workflow ?? ""}`;
}

function promotionScopesForEntry(entry: RedlineLivePromotionEntry, baseDir: string): string[] {
  const explicitScope = stringValue((entry as RedlineLivePromotionEntry & { promotion_scope?: unknown }).promotion_scope).trim();
  const operationClass = stringValue((entry as RedlineLivePromotionEntry & { operation_class?: unknown }).operation_class).trim();
  const targetClass = stringValue((entry as RedlineLivePromotionEntry & { target_class?: unknown }).target_class).trim();
  const explicitScopes = unique([
    explicitScope,
    explicitScope === "schedule/column_width" ? "resize/schedule" : "",
    operationClass && targetClass ? `${operationClass}/${targetClass}` : ""
  ]);
  const cleanupArtifact = stringValue(entry.cleanup_or_revert_artifact).trim();
  if (!cleanupArtifact) return explicitScopes;
  try {
    const resolved = resolvePromotionArtifactPath(cleanupArtifact, baseDir);
    const obj = asObject(readJsonFile<unknown>(resolved));
    const rows = Array.isArray(obj.rows) ? obj.rows.map(asObject) : [];
    const primitives = rows.map((row) => stringValue(row.primitive)).filter(Boolean);
    const scopes = primitives.flatMap((primitive) => {
      if (/^category_visibility/.test(primitive)) return ["graphics_override/category_graphics"];
      if (/^filter_visibility/.test(primitive)) return ["graphics_override/view_filter"];
      if (/^tag_value_edit/.test(primitive)) return ["text_edit/tag"];
      if (/^configure_schedule/.test(primitive)) return ["text_edit/schedule", "resize/schedule"];
      if (/^schedule/.test(primitive)) return ["text_edit/schedule"];
      if (/^text_note/.test(primitive)) return ["text_edit/text"];
      return [];
    });
    return unique([...explicitScopes, ...scopes]);
  } catch {
    return explicitScopes;
  }
}

function promotionAppliesToItem(entry: RedlineLivePromotionEntry, item: RedlineCorpusReport["items"][number], baseDir: string): boolean {
  const taskId = stringValue(entry.task_id).trim();
  if (taskId !== "demo_documentation_primitives") return true;
  const scopes = promotionScopesForEntry(entry, baseDir);
  if (scopes.length === 0) return false;
  return scopes.includes(`${item.operation_class}/${item.target_class}`);
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`)
  ].join("\n");
}

function scorecardMarkdown(scorecard: RedlineHardeningScorecard): string {
  const metricRows = Object.entries(scorecard.metrics).map(([metric, value]) => [metric, value]);
  const recordRows = scorecard.records.slice(0, 50).map((record) => [
    record.redline_id,
    record.redline_type,
    record.confidence,
    record.action.benchmark_task_id ?? "",
    record.action.workflow ?? record.action.skill ?? "",
    record.dry_run_possible ? "yes" : "no",
    record.backend_ready_without_missing_inputs ? "yes" : "no",
    record.executable ? "yes" : "no",
    record.live_evidence.reviewed_live_evidence_available ? "yes" : "no",
    record.live_evidence.repeatability_ready ? "yes" : "no",
    record.needs_human_review ? "yes" : "no",
    record.missing_live_inputs.join(", "),
    record.failure_clusters.join(", ")
  ]);
  return [
    "# Redline Hardening Scorecard",
    "",
    `Generated: ${scorecard.generated_at}`,
    `Input: ${scorecard.source.input_path ?? "inline/fixture"}`,
    `Promotion manifest: ${scorecard.source.promotion_manifest_path ?? "none"}`,
    `Confidence threshold: ${scorecard.source.confidence_threshold}`,
    `Minimum reviewed promotions per task/scope: ${scorecard.source.minimum_reviewed_promotions_per_workflow}`,
    `Fixture mode: ${scorecard.source.fixture_mode ? "yes" : "no"}`,
    "",
    "## Metrics",
    markdownTable(["metric", "value"], metricRows),
    "",
    "## Top Failure Clusters",
    scorecard.top_failure_clusters.length > 0
      ? markdownTable(["cluster", "count"], scorecard.top_failure_clusters.map((entry) => [entry.cluster, entry.count]))
      : "No failure clusters.",
    "",
    "## Top Required Context",
    scorecard.top_required_context.length > 0
      ? markdownTable(["context", "count"], scorecard.top_required_context.map((entry) => [entry.context, entry.count]))
      : "No missing required context.",
    "",
    "## Top Missing Skills",
    scorecard.top_missing_skills.length > 0
      ? markdownTable(["skill", "count"], scorecard.top_missing_skills.map((entry) => [entry.skill, entry.count]))
      : "No missing skills.",
    "",
    "## Routed Benchmark Tasks",
    markdownTable(["task_id", "count"], Object.entries(scorecard.by_benchmark_task).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    "",
    "## Record Preview",
    recordRows.length > 0
      ? markdownTable(["redline", "type", "confidence", "task", "workflow", "dry_run", "backend_ready", "executable", "live_evidence", "repeatable", "review", "missing_live_inputs", "clusters"], recordRows)
      : "No records.",
    "",
    "## Notes",
    "- `dry_run_possible` means the item maps to an existing benchmark task or workflow that can be evaluated without live Revit using fixtures/mocks.",
    "- `backend_ready_without_missing_inputs` means the item maps to an existing benchmark task and the classification queue did not report missing live inputs.",
    "- `executable` is reserved for promoted runnable overrides that explicitly report `ready_to_run:true`; ordinary corpus classification rows are not executable.",
    "- `reviewed_live_evidence_available` means an optional promotion manifest has approved reviewed live proof for the matched task/workflow and scope. It does not make a corpus row executable.",
    "- `repeatability_ready` means the matched task/workflow/scope has at least the configured number of approved reviewed live promotions.",
    "- Backend dry-run scorecards are not live Revit GUI proof.",
    ""
  ].join("\n");
}

export function generateRedlineHardeningScorecard(options: RedlineHardeningScorecardOptions): RedlineHardeningScorecard {
  const confidenceThreshold = options.confidenceThreshold ?? 0.55;
  const minimumReviewedPromotionsPerWorkflow = options.minimumReviewedPromotionsPerWorkflow ?? 2;
  const input = options.input ?? (options.inputPath ? readJsonFile<InputShape>(options.inputPath) : undefined);
  if (!input) throw new Error("Redline hardening scorecard requires an input report or fixture.");

  const { items, queue } = normalizeInput(input);
  const queueMap = queueByClassification(queue);
  const taskMap = new Map(options.benchmarkTasks.map((task) => [task.task_id, task]));
  const promotionManifest = readPromotionManifest(options.promotionManifestPath);
  const approvedPromotions = promotionManifest.entries
    .map((entry) => ({ entry, blockers: promotionBlockers(entry, promotionManifest.base_dir) }))
    .filter(({ blockers }) => blockers.length === 0);
  const approvedPromotionsByTask = new Map<string, Array<{ entry: RedlineLivePromotionEntry; blockers: string[] }>>();
  for (const promotion of approvedPromotions) {
    const taskId = stringValue(promotion.entry.task_id).trim();
    const workflow = stringValue(promotion.entry.workflow).trim();
    if (taskId || workflow) {
      const key = taskPromotionKey(taskId || null, workflow || null);
      approvedPromotionsByTask.set(key, [...(approvedPromotionsByTask.get(key) ?? []), promotion]);
    }
  }

  const records = items.map((item, index): RedlineStructuredActionRecord => {
    const key = itemKey(item.file_path, item.operation_class, item.target_class);
    const queueItems = queueMap.get(key) ?? [];
    const recommendedTasks = normalizedRecommendedBenchmarkTasks(item);
    const selectedTaskId = recommendedTasks.find((taskId) => taskMap.has(taskId)) ?? recommendedTasks[0] ?? null;
    const selectedTask = selectedTaskId ? taskMap.get(selectedTaskId) : undefined;
    const missingLiveInputs = unique(queueItems.flatMap((entry) => entry.missing_live_inputs));
    const classifiedWithConfidence =
      item.confidence >= confidenceThreshold &&
      item.operation_class !== "unknown" &&
      item.target_class !== "unknown";
    const notActionable = looksNonActionable(item);
    const taskExists = Boolean(selectedTaskId && selectedTask);
    const routed = taskExists;
    const actionable = !notActionable && item.operation_class !== "unknown" && item.target_class !== "unknown";
    const unsupportedRouteReason = intentionallyUnsupportedRouteReason(item);
    const needsHumanReview = Boolean(item.manual_review_reason) || !classifiedWithConfidence || !routed || Boolean(unsupportedRouteReason);
    const workflow = taskWorkflow(selectedTask);
    const skill = taskSkillName(selectedTask);
    const missingSkills = actionable && !routed && !unsupportedRouteReason ? [missingSkillName(item)] : [];
    const taskPromotionMatches = (approvedPromotionsByTask.get(taskPromotionKey(selectedTaskId, workflow)) ?? [])
      .filter((promotion) => promotionAppliesToItem(promotion.entry, item, promotionManifest.base_dir));
    const taskLivePromotions = unique(taskPromotionMatches
      .map((promotion) => promotionKey(promotion.entry)));
    const runnableQueuePromotionKeys = unique(queueItems.filter(isRunnableOverrideQueueItem).flatMap(queueItemPromotionKeys));
    const executablePromotionKeys = runnableQueuePromotionKeys.filter((key) => taskLivePromotions.includes(key));
    const backendReadyWithoutMissingInputs = routed && missingLiveInputs.length === 0 && !needsHumanReview;
    const executable = backendReadyWithoutMissingInputs && executablePromotionKeys.length > 0;
    const reviewedLiveEvidenceAvailable = taskLivePromotions.length > 0;
    const repeatabilityReady = taskPromotionMatches.length >= minimumReviewedPromotionsPerWorkflow;
    const rowLinkedPromotionBlockers = backendReadyWithoutMissingInputs && !executable
      ? runnableQueuePromotionKeys.length > 0
        ? ["row_linked_promotion_not_reviewed"]
        : reviewedLiveEvidenceAvailable
          ? ["row_linked_promotion_key_missing"]
          : ["reviewed_live_promotion_missing"]
      : [];

    return {
      redline_id: safeSlug(`${path.basename(item.file_path)}-${index + 1}`) || `redline-${index + 1}`,
      source_file_path: item.file_path,
      redline_type: notActionable ? "not_actionable" : actionable ? `${item.operation_class}_${item.target_class}` : "unclear",
      confidence: item.confidence,
      classified_with_confidence: classifiedWithConfidence,
      actionable,
      not_actionable: notActionable,
      target: {
        strategy: targetStrategy(item.target_class, item.context_class),
        element_type: item.target_class === "unknown" ? undefined : item.target_class
      },
      action: {
        skill,
        benchmark_task_id: selectedTaskId,
        benchmark_task_exists: taskExists,
        workflow,
        parameters: {
          dry_run: true,
          operation_class: item.operation_class,
          target_class: item.target_class,
          context_class: item.context_class,
          text_excerpt: item.text_excerpt,
          matched_rules: item.matched_rules
        }
      },
      required_context: missingLiveInputs,
      missing_live_inputs: missingLiveInputs,
      evidence_requirements: item.evidence_requirements,
      live_evidence: {
        reviewed_live_evidence_available: reviewedLiveEvidenceAvailable,
        repeatability_ready: repeatabilityReady,
        promotion_keys: taskLivePromotions,
        blockers: rowLinkedPromotionBlockers
      },
      dry_run_possible: routed,
      backend_ready_without_missing_inputs: backendReadyWithoutMissingInputs,
      executable,
      needs_human_review: needsHumanReview,
      human_review_reason: unsupportedRouteReason || (item.manual_review_reason ?? (!classifiedWithConfidence ? "Below confidence threshold or unknown class." : !routed ? "No existing benchmark task route." : null)),
      failure_clusters: failureClusters({
        item,
        classifiedWithConfidence,
        taskExists,
        selectedTaskId,
        missingLiveInputs,
        notActionable,
        unsupportedRouteReason,
        rowLinkedPromotionBlocker: rowLinkedPromotionBlockers[0]
      }),
      missing_skills: missingSkills
    };
  });

  const metrics: RedlineHardeningScorecardMetrics = {
    total_redlines_evaluated: records.length,
    classified_with_confidence: records.filter((record) => record.classified_with_confidence).length,
    actionable: records.filter((record) => record.actionable).length,
    structured_action_produced: records.filter((record) => record.actionable && record.action.benchmark_task_id).length,
    routed_to_existing_skill_or_benchmark_task: records.filter((record) => record.action.benchmark_task_exists).length,
    dry_run_possible: records.filter((record) => record.dry_run_possible).length,
    backend_ready_without_missing_inputs: records.filter((record) => record.backend_ready_without_missing_inputs).length,
    executable: records.filter((record) => record.executable).length,
    reviewed_live_evidence_available: records.filter((record) => record.live_evidence.reviewed_live_evidence_available).length,
    repeatability_ready: records.filter((record) => record.live_evidence.repeatability_ready).length,
    needs_human_review: records.filter((record) => record.needs_human_review).length,
    not_actionable: records.filter((record) => record.not_actionable).length
  };

  return {
    schema_version: 1,
    generated_at: nowIso(),
    source: {
      ...(options.inputPath ? { input_path: options.inputPath } : {}),
      ...(options.promotionManifestPath ? { promotion_manifest_path: options.promotionManifestPath } : {}),
      fixture_mode: options.fixtureMode === true,
      confidence_threshold: confidenceThreshold,
      minimum_reviewed_promotions_per_workflow: minimumReviewedPromotionsPerWorkflow
    },
    metrics,
    top_failure_clusters: topCounts(records.flatMap((record) => record.failure_clusters)),
    top_required_context: topRequiredContext(records.flatMap((record) => record.required_context)),
    top_missing_skills: topMissing(records.flatMap((record) => record.missing_skills)),
    by_redline_type: countBy(records.map((record) => record.redline_type)),
    by_benchmark_task: countBy(records.map((record) => record.action.benchmark_task_id ?? "").filter(Boolean)),
    records
  };
}

export function writeRedlineHardeningScorecard(options: RedlineHardeningScorecardWriteOptions): RedlineHardeningScorecardPaths {
  const scorecard = generateRedlineHardeningScorecard(options);
  ensureDir(options.outputDir);
  const jsonPath = path.join(options.outputDir, "redline_hardening_scorecard.json");
  const markdownPath = path.join(options.outputDir, "redline_hardening_scorecard.md");
  writeJsonFile(jsonPath, scorecard);
  writeTextFile(markdownPath, scorecardMarkdown(scorecard));
  return { json_path: jsonPath, markdown_path: markdownPath, scorecard };
}

export function readRedlineHardeningInput(inputPath: string): InputShape {
  if (!fs.existsSync(inputPath)) throw new Error(`Redline hardening input not found: ${inputPath}`);
  return readJsonFile<InputShape>(inputPath);
}
