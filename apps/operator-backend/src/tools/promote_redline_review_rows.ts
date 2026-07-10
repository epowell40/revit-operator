import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBenchmarkOverridePlaceholders } from "../benchmark/environment.js";
import {
  buildRedlineCorpusReport,
  classifyRedlineCorpusText,
  writeRedlineCorpusReport,
  type RedlineContextClass,
  type RedlineOperationClass,
  type RedlineTargetClass
} from "../redline/corpus_classifier.js";
import {
  blockerCounts,
  formatBlockerCounts,
  type CorpusTemplateRowSummary,
  listRedlineCorpusTemplateRows,
  readOnlyDiscoveryActionsForRow,
  renderRedlineCorpusTemplateChecklist
} from "./promote_redline_corpus_template.js";

type CsvRow = Record<string, string>;

export type PromoteReviewedRowsOptions = {
  inputPath: string;
  outputDir: string;
  statuses?: string[];
  limit?: number;
  checklistOutputPath?: string;
  filledOutputPath?: string;
  liveContextPath?: string;
  requireGroupActionability?: string[];
  operationTargets?: string[];
  benchmarkTasks?: string[];
};

const DEFAULT_PROMOTION_STATUSES = new Set(["promote", "approved", "ready", "live_candidate", "benchmark_candidate"]);
const PROMOTABLE_GROUP_ACTIONABILITY = new Set(["", "likely_single_action"]);
const OPERATION_VALUES = new Set([
  "add", "delete", "move", "rotate", "text_edit", "tag", "type_change", "graphics_override", "route",
  "tap_branch", "reroute_offset", "size_transition", "resize", "parameter_edit", "unknown"
]);
const TARGET_VALUES = new Set([
  "text", "tag", "model_parameter", "receptacle", "light", "duct", "pipe", "mep_accessory",
  "family_instance", "cad_link", "view_filter", "view_template", "category_graphics", "schedule", "sheet", "unknown"
]);
const CONTEXT_VALUES = new Set(["host_model", "linked_model", "cad_import", "annotation", "view", "template", "schedule", "sheet", "unknown"]);

type PromotionManifestRow = CorpusTemplateRowSummary & {
  live_discovery_plan: string[];
  placeholder_blocker_counts: Record<string, number>;
  live_promotion_status: string;
  live_promotion_blocker: string;
  reviewed_fact_summary?: string;
};

type PromotionSelectionAudit = {
  status_matched_count: number;
  selected_count: number;
  skipped_by_group_actionability_count: number;
  skipped_by_group_actionability: Record<string, number>;
  required_group_actionability?: string[];
  skipped_by_required_group_actionability_count?: number;
  skipped_by_required_group_actionability?: Record<string, number>;
  required_operation_targets?: string[];
  skipped_by_operation_target_count?: number;
  skipped_by_operation_target?: Record<string, number>;
  required_benchmark_task_ids?: string[];
  skipped_by_benchmark_task_count?: number;
  skipped_by_benchmark_task?: Record<string, number>;
};

type HydrationSkip = { path: string; reason: string };

type HydrationTaskSummary = {
  key: string;
  benchmark_task_id: string;
  before_placeholder_count: number;
  after_placeholder_count: number;
  filled_paths: string[];
  skipped_placeholders: HydrationSkip[];
};

type PromotionBatch = {
  batch_id: string;
  row_count: number;
  keys: string[];
  benchmark_task_ids: string[];
  operation_target_counts: Record<string, number>;
  live_promotion_status: string;
  live_promotion_blocker: string;
  placeholder_count: number;
  placeholder_blocker_counts: Record<string, number>;
  hydration_skip_counts: Record<string, number>;
  reviewed_fact_summaries: Array<{ key: string; reviewed_fact_summary: string }>;
  batch_template_path: string;
  batch_checklist_path: string;
  filled_output_path?: string;
  template_validation_command: string;
  promotion_command: string;
  validation_command: string;
  preflight_command: string;
};

function markdownEscape(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function commandPath(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonPlaceholderString(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text && !text.includes("__FILL_") ? text : undefined;
}

function groupActionability(row: CsvRow): string {
  return (row.review_group_actionability || "").trim().toLowerCase();
}

function groupActionabilityAuditKey(value: string): string {
  return value || "blank";
}

function isCompositeGroupReviewRow(row: CsvRow): boolean {
  return Boolean(
    (row.group_index || "").trim() ||
    (row.annotation_indices || "").trim() ||
    /composite[_-]?group/i.test(row.bucket || "") ||
    /composite[_-]?group/i.test(row.source_kind || "")
  );
}

function normalizedRequiredGroupActionability(values: string[] | undefined): Set<string> | undefined {
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    for (const part of String(raw).split(",")) {
      const value = part.trim().toLowerCase();
      if (!value) continue;
      normalized.push(value === "blank" || value === "legacy_blank" ? "" : value);
    }
  }
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function rowOperationTarget(row: CsvRow): string {
  const operation = (row.review_operation || row.operation_class || "").trim().toLowerCase();
  const target = (row.review_target || row.target_class || "").trim().toLowerCase();
  return `${operation || "unknown"}/${target || "unknown"}`;
}

function normalizedOperationTargets(values: string[] | undefined): Set<string> | undefined {
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    for (const part of String(raw).split(",")) {
      const value = part.trim().toLowerCase();
      if (!value) continue;
      normalized.push(value);
    }
  }
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function normalizedBenchmarkTasks(values: string[] | undefined): Set<string> | undefined {
  const normalized: string[] = [];
  for (const raw of values ?? []) {
    for (const part of String(raw).split(",")) {
      const value = part.trim();
      if (!value) continue;
      normalized.push(value);
    }
  }
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

function classificationTaskIds(item: { recommended_benchmark_tasks?: string[] }): string[] {
  return Array.isArray(item.recommended_benchmark_tasks) && item.recommended_benchmark_tasks.length > 0
    ? item.recommended_benchmark_tasks
    : ["unknown"];
}

function reviewRowEligibleForPromotion(
  row: CsvRow,
  statuses: Set<string>,
  requiredGroupActionability?: Set<string>,
  operationTargets?: Set<string>
): boolean {
  const status = (row.review_status || "").trim().toLowerCase();
  if (!statuses.has(status)) return false;
  const actionability = groupActionability(row);
  if (!PROMOTABLE_GROUP_ACTIONABILITY.has(actionability)) return false;
  if (requiredGroupActionability && isCompositeGroupReviewRow(row) && !requiredGroupActionability.has(actionability)) return false;
  if (operationTargets && !operationTargets.has(rowOperationTarget(row))) return false;
  return true;
}

function promotionSelectionAudit(
  rows: CsvRow[],
  statuses: Set<string>,
  selectedCount: number,
  requiredGroupActionability?: Set<string>,
  operationTargets?: Set<string>
): PromotionSelectionAudit {
  const statusMatchedRows = rows.filter((row) => statuses.has((row.review_status || "").trim().toLowerCase()));
  const skippedByGroupActionability = statusMatchedRows.reduce((counts, row) => {
    const actionability = groupActionability(row);
    if (!actionability || PROMOTABLE_GROUP_ACTIONABILITY.has(actionability)) return counts;
    counts[actionability] = (counts[actionability] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const audit: PromotionSelectionAudit = {
    status_matched_count: statusMatchedRows.length,
    selected_count: selectedCount,
    skipped_by_group_actionability_count: Object.values(skippedByGroupActionability).reduce((sum, count) => sum + count, 0),
    skipped_by_group_actionability: skippedByGroupActionability
  };
  if (requiredGroupActionability) {
    const skippedByRequiredGroupActionability = statusMatchedRows.reduce((counts, row) => {
      if (!isCompositeGroupReviewRow(row)) return counts;
      const actionability = groupActionability(row);
      if (!PROMOTABLE_GROUP_ACTIONABILITY.has(actionability) || requiredGroupActionability.has(actionability)) return counts;
      const key = groupActionabilityAuditKey(actionability);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    audit.required_group_actionability = [...requiredGroupActionability].map(groupActionabilityAuditKey);
    audit.skipped_by_required_group_actionability_count = Object.values(skippedByRequiredGroupActionability).reduce((sum, count) => sum + count, 0);
    audit.skipped_by_required_group_actionability = skippedByRequiredGroupActionability;
  }
  if (operationTargets) {
    const skippedByOperationTarget = statusMatchedRows.reduce((counts, row) => {
      const actionability = groupActionability(row);
      if (!PROMOTABLE_GROUP_ACTIONABILITY.has(actionability)) return counts;
      if (requiredGroupActionability && isCompositeGroupReviewRow(row) && !requiredGroupActionability.has(actionability)) return counts;
      const key = rowOperationTarget(row);
      if (operationTargets.has(key)) return counts;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    audit.required_operation_targets = [...operationTargets];
    audit.skipped_by_operation_target_count = Object.values(skippedByOperationTarget).reduce((sum, count) => sum + count, 0);
    audit.skipped_by_operation_target = skippedByOperationTarget;
  }
  return audit;
}

function requestHasPlaceholder(request: Record<string, unknown>, pathName: string): boolean {
  const current = request[pathName];
  return typeof current === "string" && current.includes("__FILL_");
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function livePreflightCommand(filledOutputPath: string | undefined): string {
  const inputPath = commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__");
  return `$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON=${powershellSingleQuoted(inputPath)}; npm run benchmark -- preflight-revit`;
}

const missingInputsCoveredByHydratedPath: Record<string, string[]> = {
  "request.viewId": ["view_id", "target_view_or_sheet_id"],
  "request.visualViewId": ["view_id", "target_view_or_sheet_id"],
  "request.categoryVisibility.categoryName": ["category_name"],
  "request.tag.viewId": ["view_id", "target_view_or_sheet_id"],
  "request.tag.elementIds[0]": ["taggable_element_id", "taggable_element_ids"],
  "request.tag.existingTagIds[0]": ["existing_tag_id", "annotation_inventory"],
  "request.tag.valueSourceParameterName": ["tag_value_source_parameter"],
  "request.tag.expectedExistingValue": ["existing_tag_value"],
  "request.tag.requestedTagValueHint": ["requested_tag_type_or_value"],
  "request.tag.tagTypeId": ["requested_tag_type_or_value"],
  "request.tag.tagTypeName": ["requested_tag_type_or_value"],
  "request.textNote.viewId": ["view_id", "target_view_or_sheet_id"],
  "request.textNote.textNoteId": ["text_note_or_region_reference", "existing_text_note_id"],
  "request.textNote.expectedExistingText": ["text_note_or_region_reference", "existing_text_note_original_text"],
  "request.textNote.text": ["requested_text_note_value"],
  "request.roomNumber": ["target_room_or_space"],
  "request.levelName": ["level_or_route_plane", "selected_level"],
  "request.systemType": ["system_type", "selected_system_type"],
  "request.ductSize": ["selected_branch_size"],
  "request.pipeSize": ["selected_branch_size"],
  "request.familyInstance.familyName": ["family_or_symbol_name"],
  "request.familyInstance.symbolName": ["family_or_symbol_name"],
  "request.familyInstance.levelName": ["selected_level", "family_symbol_or_type", "level_or_host_context"],
  "request.familyInstance.hostElementId": ["level_or_host_context", "accessory_placement_host_or_basis"],
  "request.familyInstance.placementBasis": ["level_or_host_context", "accessory_placement_host_or_basis"],
  "request.familyInstance.x": ["level_or_host_context", "accessory_placement_host_or_basis"],
  "request.familyInstance.y": ["level_or_host_context", "accessory_placement_host_or_basis"],
  "request.familyInstance.z": ["level_or_host_context", "accessory_placement_host_or_basis"]
};

export function removeHydratedMissingInputs(missingLiveInputs: unknown, filledPaths: string[]): string[] | undefined {
  if (!Array.isArray(missingLiveInputs)) return undefined;
  const covered = new Set(filledPaths.flatMap((pathName) => missingInputsCoveredByHydratedPath[pathName] ?? []));
  return missingLiveInputs
    .map((entry) => String(entry))
    .filter((entry) => !covered.has(entry));
}

function hydrationSkipCounts(rows: Array<{ live_context_hydration?: { skipped_placeholders?: HydrationSkip[] } }>): Record<string, number> {
  return rows.reduce((counts, row) => {
    for (const skip of row.live_context_hydration?.skipped_placeholders ?? []) {
      counts[skip.path] = (counts[skip.path] ?? 0) + 1;
    }
    return counts;
  }, {} as Record<string, number>);
}

function formatHydrationSkipCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "none";
}

function livePromotionStatus(placeholderCount: number): { status: string; blocker: string } {
  if (placeholderCount > 0) {
    return {
      status: "blocked_unfilled_placeholders",
      blocker: `Fill and validate ${placeholderCount} placeholder(s) with verified Revit context before any live run.`
    };
  }
  return {
    status: "ready_for_no_write_validation",
    blocker: "Run benchmark request validation and live Revit bridge preflight before any model write."
  };
}

function formatReviewSource(source: Record<string, string> | undefined): string {
  const entries = Object.entries(source ?? {}).filter(([, value]) => String(value ?? "").trim());
  return entries.length
    ? entries.map(([key, value]) => {
      const text = String(value);
      const rendered = text.length > 180 ? `${text.slice(0, 180)}...` : text;
      return `${key}=${rendered}`;
    }).join(", ")
    : "none";
}

function reviewedTapTopologyFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_requested_branch_count ? `branch_count=${source.review_requested_branch_count}` : "",
    source?.review_requested_connection_kind ? `connection_kind=${source.review_requested_connection_kind}` : "",
    source?.review_tap_placement_hint ? `tap_placement=${source.review_tap_placement_hint}` : "",
    source?.review_clearance_hint ? `clearance=${source.review_clearance_hint}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedSizingFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_existing_size ? `existing_size=${source.review_existing_size}` : "",
    source?.review_requested_size ? `size=${source.review_requested_size}` : "",
    source?.review_requested_size_candidates ? `size_candidates=${source.review_requested_size_candidates}` : "",
    source?.review_requested_size_basis ? `size_basis=${source.review_requested_size_basis}` : "",
    source?.review_requested_airflow ? `airflow=${source.review_requested_airflow}` : "",
    source?.review_elevation_hint ? `elevation=${source.review_elevation_hint}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedAccessoryFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_requested_accessory_kind ? `accessory_kind=${source.review_requested_accessory_kind}` : "",
    source?.review_requested_accessory_size ? `accessory_size=${source.review_requested_accessory_size}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedTagFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_requested_tag_kind ? `tag_kind=${source.review_requested_tag_kind}` : "",
    source?.review_requested_tag_value ? `tag_value=${source.review_requested_tag_value}` : "",
    source?.review_requested_tag_note_number ? `tag_note_number=${source.review_requested_tag_note_number}` : "",
    source?.review_tag_target_scope ? `tag_target=${source.review_tag_target_scope}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedTypeFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_existing_type ? `existing_type=${source.review_existing_type}` : "",
    source?.review_requested_type ? `requested_type=${source.review_requested_type}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedTextFacts(source: Record<string, string> | undefined): string {
  const facts = [
    source?.review_requested_text ? `requested_text=${source.review_requested_text}` : "",
    source?.review_existing_text ? `existing_text=${source.review_existing_text}` : ""
  ].filter(Boolean);
  return facts.join(", ");
}

function reviewedFactSummary(source: Record<string, string> | undefined): string {
  const labels: Record<string, string> = {
    review_existing_size: "existing_size",
    review_requested_size: "size",
    review_requested_size_candidates: "size_candidates",
    review_requested_size_basis: "size_basis",
    review_requested_airflow: "airflow",
    review_elevation_hint: "elevation",
    review_requested_branch_count: "branch_count",
    review_requested_connection_kind: "connection_kind",
    review_tap_placement_hint: "tap_placement",
    review_clearance_hint: "clearance",
    review_requested_text: "requested_text",
    review_existing_text: "existing_text",
    review_requested_lineweight: "lineweight",
    review_graphics_style_intent: "graphics_style",
    review_graphics_target_hint: "graphics_target",
    review_visibility_intent: "visibility",
    review_requested_accessory_kind: "accessory_kind",
    review_requested_accessory_size: "accessory_size",
    review_requested_tag_kind: "tag_kind",
    review_requested_tag_value: "tag_value",
    review_requested_tag_note_number: "tag_note_number",
    review_tag_target_scope: "tag_target",
    review_existing_type: "existing_type",
    review_requested_type: "requested_type",
    review_linked_model_category: "linked_model_category",
    review_linked_visibility_intent: "linked_visibility",
    review_phase_name: "phase",
    review_phase_filter: "phase_filter",
    review_phase_mapping_intent: "phase_mapping"
  };
  const facts = REVIEW_FACT_SOURCE_KEYS
    .map((key) => {
      const value = source?.[key]?.trim();
      return value ? `${labels[key] ?? key}=${value}` : "";
    })
    .filter(Boolean);
  return facts.join(", ");
}

function discoveryPlanForRow(row: CorpusTemplateRowSummary): string[] {
  const placeholders = new Set(row.placeholder_paths);
  const missing = new Set(row.missing_live_inputs);
  const evidence = new Set(row.evidence_requirements);
  const steps: string[] = [];
  const add = (step: string) => {
    if (!steps.includes(step)) steps.push(step);
  };

  if (missing.has("open_revit_model")) {
    add("Open the intended Revit model and confirm the active document before filling any row values.");
  }
  if (placeholders.has("request.viewId") || placeholders.has("request.visualViewId") || missing.has("target_view_or_sheet_id") || missing.has("view_id")) {
    add("Discover the target Revit view or sheet id and use the same focused target for post-change capture.");
  }
  if ([...placeholders].some((entry) => /roomNumber|roomName|spaceNumber|spaceName|targetRoom|targetSpace/.test(entry)) || missing.has("target_room_or_space")) {
    add("Resolve the target room or space from live room/space tags, visible boundaries, and nearby redline anchors before projecting route geometry.");
  }
  if ([...placeholders].some((entry) => /hostElementId|mainElementId|sourceElementId/.test(entry)) || missing.has("host_route_element_id")) {
    add("Use live element discovery to select the real host/main route element id in the target view.");
  }
  if ([...placeholders].some((entry) => /points|projectedTapPoint|transitionNormalized|transitionChainageFt|splitPoints|offsetVector/.test(entry)) || missing.has("projected_split_points") || missing.has("projected_transition_point")) {
    add("Project the reviewed PDF mark into model coordinates and verify the projected tap, split, transition, route, or offset points against nearby Revit geometry.");
  }
  if (missing.has("dry_run_route_projection") || missing.has("dry_run_route_preview")) {
    add("Run `/revit/mep-route-workflow` with `apply:false` first and review planned points, route elevation, size preview, open connector count, warnings, and proposed ids before filling any apply-capable route override.");
  }
  if (missing.has("endpoint_or_connector_grounding")) {
    add("Verify endpoint connector ids or endpoint host elements for the route, or explicitly document a disposable standalone open-end policy before allowing route apply.");
  }
  if ([...placeholders].some((entry) => /sizingScope|upstreamDuctSize|downstreamDuctSize|upstreamPipeSize|downstreamPipeSize/.test(entry)) || missing.has("engineering_sizing_basis") || evidence.has("per_segment_size_readback")) {
    add("Collect route segment ids, upstream/downstream sizes, engineering sizing basis, and per-segment size readback for scoped sizing.");
  }
  const sizingFacts = reviewedSizingFacts(row.review_source);
  if ((row.operation_class === "size_transition" || row.operation_class === "resize") && sizingFacts) {
    add(`Verify reviewed sizing facts against live route segment scope, engineering basis, and per-segment readback before filling: ${sizingFacts}.`);
  }
  if ([...placeholders].some((entry) => /systemType|levelName|ductSize|pipeSize|fittingTypeId|expectedFitting/.test(entry)) || evidence.has("fitting_readback")) {
    add("Resolve compatible system, level, size, and fitting/takeoff expectations from Revit before any modeled MEP write.");
  }
  const tapTopologyFacts = reviewedTapTopologyFacts(row.review_source);
  if (row.operation_class === "tap_branch" && tapTopologyFacts) {
    add(`Verify reviewed tap/branch topology facts against live route geometry before filling: ${tapTopologyFacts}.`);
  }
  if (evidence.has("connector_network_audit") || missing.has("connector_network_audit")) {
    add("Run connector/network readback for the affected route before and after the filled live run.");
  }
  if ([...placeholders].some((entry) => /categoryVisibility|filterVisibility|viewTemplate|phaseVisibility|linkedModelCategoryVisibility/.test(entry)) || evidence.has("graphics_readback")) {
    add("Resolve exact view/category/filter/template/link/phase targets and capture requested-vs-applied graphics readback.");
  }
  if ([...placeholders].some((entry) => /cadLink|cadGraphicsOverride/.test(entry))) {
    add("Resolve CAD import/link id, source path, layer/subcategory, and lineweight readback from the live model.");
  }
  if ([...placeholders].some((entry) => /tag\.|textNote\.|familyInstance\.|targetTypeId|symbolName/.test(entry))) {
    add("Resolve compatible annotation, taggable element, family, symbol, or target type ids and capture post-change readback.");
  }
  const accessoryFacts = reviewedAccessoryFacts(row.review_source);
  if ((row.target_class === "mep_accessory" || row.target_class === "family_instance") && accessoryFacts) {
    add(`Verify reviewed accessory facts against live family/symbol compatibility, placement host, model-write readback, visual gate, and cleanup proof before filling: ${accessoryFacts}.`);
  }
  const tagFacts = reviewedTagFacts(row.review_source);
  if ((row.operation_class === "tag" || row.target_class === "tag") && tagFacts) {
    add(`Verify reviewed tag facts against live taggable element ids, tag type/value readback, focused capture, visual gate, and cleanup proof before filling: ${tagFacts}.`);
  }
  const textFacts = reviewedTextFacts(row.review_source);
  if (row.operation_class === "text_edit" && row.target_class === "text" && textFacts) {
    add(`Verify reviewed text replacement facts against the exact visible TextNote id, owner-view readback, grouped PDF annotation proof, focused capture, and revert proof before filling: ${textFacts}.`);
  }
  const typeFacts = reviewedTypeFacts(row.review_source);
  if (row.operation_class === "type_change" && typeFacts) {
    add(`Verify reviewed type facts against live source element, current source type readback, compatible target type id, no-write dry-run compatibility preview, focused capture, and revert proof before filling: ${typeFacts}.`);
  }
  if (evidence.has("visual_gate") || missing.has("post_change_visual_capture")) {
    add("Capture focused before/after visual evidence for the selected target view or sheet and require the visual gate to pass.");
  }
  if (evidence.has("cleanup_effect_ids") || missing.has("cleanup_verification")) {
    add("Define cleanup or revert expectations and verify cleanup effect ids after the live run.");
  }
  if (steps.length === 0) {
    add("Inspect placeholders, missing live inputs, and evidence gates manually before considering this row filled.");
  }
  return steps;
}

function writePromotionManifest(options: {
  outputDir: string;
  inputPath: string;
  selectedCount: number;
  selectionAudit: PromotionSelectionAudit;
  templatePath: string;
  reviewMarkdownPath: string;
  checklistOutputPath?: string;
  filledOutputPath?: string;
  rows: CorpusTemplateRowSummary[];
}): { manifestPath: string; discoveryPlanPath: string; batchPlanPath: string; batchPlanMarkdownPath: string } {
  const benchmarkTaskCounts = options.rows.reduce((counts, row) => {
    counts[row.benchmark_task_id] = (counts[row.benchmark_task_id] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const operationTargetCounts = options.rows.reduce((counts, row) => {
    const key = `${row.operation_class || "unknown"}/${row.target_class || "unknown"}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const rows: PromotionManifestRow[] = options.rows.map((row) => {
    const promotionStatus = livePromotionStatus(row.placeholder_count);
    const factSummary = reviewedFactSummary(row.review_source);
    return {
      live_promotion_status: promotionStatus.status,
      live_promotion_blocker: promotionStatus.blocker,
      ...(factSummary ? { reviewed_fact_summary: factSummary } : {}),
      key: row.key,
      benchmark_task_id: row.benchmark_task_id,
      operation_class: row.operation_class,
      target_class: row.target_class,
      file_path: row.file_path,
      review_source: row.review_source,
      placeholder_count: row.placeholder_count,
      placeholder_paths: row.placeholder_paths,
      placeholder_blocker_counts: blockerCounts(row.placeholder_paths),
      live_context_hydration: row.live_context_hydration,
      missing_live_inputs: row.missing_live_inputs,
      evidence_requirements: row.evidence_requirements,
      live_discovery_plan: discoveryPlanForRow(row),
      text_excerpt: row.text_excerpt
    };
  });
  const discoveryPlanCounts = rows.reduce((counts, row) => {
    for (const step of row.live_discovery_plan) counts[step] = (counts[step] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const placeholderBlockerCounts = rows.reduce((counts, row) => {
    for (const [key, count] of Object.entries(row.placeholder_blocker_counts)) counts[key] = (counts[key] ?? 0) + count;
    return counts;
  }, {} as Record<string, number>);
  const aggregateHydrationSkipCounts = hydrationSkipCounts(rows);
  const aggregatePromotionStatus = livePromotionStatus(options.rows.reduce((sum, row) => sum + row.placeholder_count, 0));
  const batchPlan = buildPromotionBatchPlan({
    outputDir: options.outputDir,
    rows,
    templatePath: options.templatePath,
    filledOutputPath: options.filledOutputPath
  });
  const batchPlanPath = path.join(options.outputDir, "redline_corpus_live_promotion_batches.json");
  fs.writeFileSync(batchPlanPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    input: options.inputPath,
    live_template: options.templatePath,
    intended_filled_override: options.filledOutputPath,
    selection_audit: options.selectionAudit,
    batch_count: batchPlan.length,
    batches: batchPlan
  }, null, 2) + "\n", "utf8");
  const batchPlanMarkdownPath = path.join(options.outputDir, "redline_corpus_live_promotion_batches.md");
  fs.writeFileSync(batchPlanMarkdownPath, renderPromotionBatchMarkdown({
    templatePath: options.templatePath,
    filledOutputPath: options.filledOutputPath,
    selectionAudit: options.selectionAudit,
    batches: batchPlan
  }), "utf8");
  const manifestPath = path.join(options.outputDir, "redline_corpus_reviewed_promotion_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    input: options.inputPath,
    selected_count: options.selectedCount,
    selection_audit: options.selectionAudit,
    live_template: options.templatePath,
    review_markdown: options.reviewMarkdownPath,
    fill_checklist: options.checklistOutputPath,
    intended_filled_override: options.filledOutputPath,
    live_promotion_status: aggregatePromotionStatus.status,
    live_promotion_blocker: aggregatePromotionStatus.blocker,
    live_benchmark_queue_count: options.rows.length,
    placeholder_count: options.rows.reduce((sum, row) => sum + row.placeholder_count, 0),
    placeholder_task_count: options.rows.filter((row) => row.placeholder_count > 0).length,
    placeholder_blocker_counts: placeholderBlockerCounts,
    benchmark_task_counts: benchmarkTaskCounts,
    operation_target_counts: operationTargetCounts,
    discovery_plan_counts: discoveryPlanCounts,
    hydration_skip_counts: aggregateHydrationSkipCounts,
    promotion_batch_plan: {
      batch_count: batchPlan.length,
      batch_plan_path: batchPlanPath,
      batch_plan_markdown_path: batchPlanMarkdownPath,
      batches: batchPlan.map((batch) => ({
        batch_id: batch.batch_id,
        row_count: batch.row_count,
        keys: batch.keys,
        benchmark_task_ids: batch.benchmark_task_ids,
        live_promotion_status: batch.live_promotion_status,
        live_promotion_blocker: batch.live_promotion_blocker,
        placeholder_count: batch.placeholder_count,
        placeholder_blocker_counts: batch.placeholder_blocker_counts,
        hydration_skip_counts: batch.hydration_skip_counts,
        reviewed_fact_summaries: batch.reviewed_fact_summaries,
        batch_template_path: batch.batch_template_path,
        batch_checklist_path: batch.batch_checklist_path,
        filled_output_path: batch.filled_output_path
      }))
    },
    rows
  }, null, 2) + "\n", "utf8");
  const discoveryPlanPath = path.join(options.outputDir, "redline_corpus_live_discovery_plan.md");
  fs.writeFileSync(discoveryPlanPath, renderDiscoveryPlanMarkdown({
    inputPath: options.inputPath,
    templatePath: options.templatePath,
    checklistOutputPath: options.checklistOutputPath,
    filledOutputPath: options.filledOutputPath,
    batchPlanMarkdownPath,
    selectionAudit: options.selectionAudit,
    rows,
    discoveryPlanCounts,
    placeholderBlockerCounts,
    hydrationSkipCounts: aggregateHydrationSkipCounts
  }), "utf8");
  return { manifestPath, discoveryPlanPath, batchPlanPath, batchPlanMarkdownPath };
}

function batchOutputPath(baseOutputPath: string | undefined, batchIndex: number): string | undefined {
  if (!baseOutputPath) return undefined;
  const parsed = path.parse(baseOutputPath);
  const suffix = `batch-${String(batchIndex + 1).padStart(2, "0")}`;
  return path.join(parsed.dir, `${parsed.name}.${suffix}${parsed.ext || ".json"}`);
}

function buildPromotionBatchPlan(options: {
  outputDir: string;
  rows: PromotionManifestRow[];
  templatePath: string;
  filledOutputPath?: string;
}): PromotionBatch[] {
  const sourceTemplate = JSON.parse(fs.readFileSync(options.templatePath, "utf8")) as {
    schema_version?: number;
    generated_at?: string;
    source_dir?: string;
    status?: string;
    ready_to_run?: boolean;
    instructions?: string[];
    tasks?: Record<string, unknown>;
  };
  const batches: PromotionManifestRow[][] = [];
  for (const row of options.rows) {
    let targetBatch = batches.find((batch) => !batch.some((entry) => entry.benchmark_task_id === row.benchmark_task_id));
    if (!targetBatch) {
      targetBatch = [];
      batches.push(targetBatch);
    }
    targetBatch.push(row);
  }
  return batches.map((batch, index) => {
    const batchId = `batch-${String(index + 1).padStart(2, "0")}`;
    const batchTemplatePath = path.join(options.outputDir, `redline_corpus_live_request_template.${batchId}.json`);
    const batchChecklistPath = path.join(options.outputDir, `redline_corpus_live_fill_checklist.${batchId}.md`);
    const filledOutputPath = batchOutputPath(options.filledOutputPath, index);
    const keys = batch.map((row) => row.key);
    const operationTargetCounts = batch.reduce((counts, row) => {
      const key = `${row.operation_class || "unknown"}/${row.target_class || "unknown"}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    const tasks = keys.reduce((out, key) => {
      if (sourceTemplate.tasks && Object.prototype.hasOwnProperty.call(sourceTemplate.tasks, key)) {
        out[key] = sourceTemplate.tasks[key];
      }
      return out;
    }, {} as Record<string, unknown>);
    const placeholderCount = batch.reduce((sum, row) => sum + row.placeholder_count, 0);
    const placeholderBlockerCounts = batch.reduce((counts, row) => {
      for (const [key, count] of Object.entries(row.placeholder_blocker_counts)) counts[key] = (counts[key] ?? 0) + count;
      return counts;
    }, {} as Record<string, number>);
    const batchHydrationSkipCounts = hydrationSkipCounts(batch);
    const reviewedFactSummaries = batch
      .filter((row) => row.reviewed_fact_summary)
      .map((row) => ({
        key: row.key,
        reviewed_fact_summary: row.reviewed_fact_summary as string
      }));
    const promotionStatus = livePromotionStatus(placeholderCount);
    fs.writeFileSync(batchTemplatePath, JSON.stringify({
      ...sourceTemplate,
      generated_at: new Date().toISOString(),
      status: "batch_template_requires_verified_revit_ids",
      ready_to_run: false,
      live_promotion_status: promotionStatus.status,
      live_promotion_blocker: promotionStatus.blocker,
      placeholder_count: placeholderCount,
      placeholder_task_count: batch.filter((row) => row.placeholder_count > 0).length,
      placeholder_blocker_counts: placeholderBlockerCounts,
      hydration_skip_counts: batchHydrationSkipCounts,
      batch_id: batchId,
      batch_source_template: options.templatePath,
      instructions: [
        "This file is a collision-free batch fill template, not a runnable live override yet.",
        "Fill only the rows in this batch with verified Revit ids, types, levels, points, and paths from the currently open model.",
        "Promote this batch with the generated --keys command only after placeholder_count is 0 and benchmark validation passes.",
        "Do not mark modeled redline work complete unless the live run produces actual model write evidence and a passing visual gate.",
        ...(sourceTemplate.instructions ?? [])
      ],
      tasks
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(batchChecklistPath, renderRedlineCorpusTemplateChecklist(batch, {
      templatePath: batchTemplatePath,
      filledOutputPath
    }), "utf8");
    return {
      batch_id: batchId,
      row_count: batch.length,
      keys,
      benchmark_task_ids: batch.map((row) => row.benchmark_task_id),
      operation_target_counts: operationTargetCounts,
      live_promotion_status: promotionStatus.status,
      live_promotion_blocker: promotionStatus.blocker,
      placeholder_count: placeholderCount,
      placeholder_blocker_counts: placeholderBlockerCounts,
      hydration_skip_counts: batchHydrationSkipCounts,
      reviewed_fact_summaries: reviewedFactSummaries,
      batch_template_path: batchTemplatePath,
      batch_checklist_path: batchChecklistPath,
      filled_output_path: filledOutputPath,
      template_validation_command: `npm run benchmark -- validate-revit-requests --input ${batchTemplatePath}`,
      promotion_command: `npm run redline:promote-live-template -- --template ${batchTemplatePath} --keys ${keys.join(",")} --output ${commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__")}`,
      validation_command: `npm run benchmark -- validate-revit-requests --input ${commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__")}`,
      preflight_command: livePreflightCommand(filledOutputPath)
    };
  });
}

function renderPromotionBatchMarkdown(options: {
  templatePath: string;
  filledOutputPath?: string;
  selectionAudit: PromotionSelectionAudit;
  batches: PromotionBatch[];
}): string {
  const skippedActionabilityRows = Object.entries(options.selectionAudit.skipped_by_group_actionability);
  const skippedRequiredActionabilityRows = Object.entries(options.selectionAudit.skipped_by_required_group_actionability ?? {});
  const skippedOperationTargetRows = Object.entries(options.selectionAudit.skipped_by_operation_target ?? {});
  const skippedBenchmarkTaskRows = Object.entries(options.selectionAudit.skipped_by_benchmark_task ?? {});
  const lines = [
    "# Redline Corpus Live Promotion Batches",
    "",
    "This is a no-write batching plan. Each batch contains at most one row for each benchmark task id, so filled rows can be promoted without duplicate task collisions. Do not run a live benchmark until the selected batch validates with `placeholder_count: 0` and the required evidence gates are covered.",
    "",
    `- Live request template: \`${options.templatePath}\``,
    options.filledOutputPath ? `- Intended filled override prefix: \`${options.filledOutputPath}\`` : "- Intended filled override prefix: _not supplied_",
    `- Reviewed rows with promotion status: ${options.selectionAudit.status_matched_count}`,
    `- Selected rows: ${options.selectionAudit.selected_count}`,
    `- Skipped by composite-group actionability: ${options.selectionAudit.skipped_by_group_actionability_count}`,
    options.selectionAudit.required_group_actionability
      ? `- Required composite-group actionability: ${options.selectionAudit.required_group_actionability.map(markdownEscape).join(", ")}`
      : "- Required composite-group actionability: _not enforced_",
    `- Skipped by required composite-group actionability: ${options.selectionAudit.skipped_by_required_group_actionability_count ?? 0}`,
    options.selectionAudit.required_operation_targets
      ? `- Required operation/target pairs: ${options.selectionAudit.required_operation_targets.map(markdownEscape).join(", ")}`
      : "- Required operation/target pairs: _not enforced_",
    `- Skipped by operation/target filter: ${options.selectionAudit.skipped_by_operation_target_count ?? 0}`,
    options.selectionAudit.required_benchmark_task_ids
      ? `- Required benchmark task ids: ${options.selectionAudit.required_benchmark_task_ids.map(markdownEscape).join(", ")}`
      : "- Required benchmark task ids: _not enforced_",
    `- Skipped by benchmark task filter: ${options.selectionAudit.skipped_by_benchmark_task_count ?? 0}`,
    "",
    "## Selection Audit",
    "",
    "| selection bucket | rows |",
    "| --- | ---: |",
    `| selected for live-template scaffolding | ${options.selectionAudit.selected_count} |`,
    ...(skippedActionabilityRows.length > 0
      ? skippedActionabilityRows.map(([key, count]) => `| skipped: ${markdownEscape(key)} | ${count} |`)
      : ["| skipped by composite-group actionability | 0 |"]),
    ...(skippedRequiredActionabilityRows.length > 0
      ? skippedRequiredActionabilityRows.map(([key, count]) => `| skipped by required actionability: ${markdownEscape(key)} | ${count} |`)
      : []),
    ...(skippedOperationTargetRows.length > 0
      ? skippedOperationTargetRows.map(([key, count]) => `| skipped by operation/target filter: ${markdownEscape(key)} | ${count} |`)
      : []),
    ...(skippedBenchmarkTaskRows.length > 0
      ? skippedBenchmarkTaskRows.map(([key, count]) => `| skipped by benchmark task filter: ${markdownEscape(key)} | ${count} |`)
      : []),
    "",
    "Rows skipped by composite-group actionability are not failures. Split-prone groups must be split or relabeled before promotion; non-actionable groups must stay out of live-template scaffolds unless a reviewer supplies a concrete operation and target.",
    "",
    "## Batches",
    "",
    "| batch | rows | status | placeholders | benchmark tasks | output |",
    "| --- | ---: | --- | ---: | --- | --- |",
    ...options.batches.map((batch) => `| ${batch.batch_id} | ${batch.row_count} | ${markdownEscape(batch.live_promotion_status)} | ${batch.placeholder_count} | ${markdownEscape(batch.benchmark_task_ids.join(", "))} | ${batch.filled_output_path ? `\`${batch.filled_output_path}\`` : "_not supplied_"} |`)
  ];
  for (const batch of options.batches) {
    lines.push(
      "",
      `## ${batch.batch_id}`,
      "",
      `- Keys: \`${batch.keys.join(",")}\``,
      `- Benchmark task ids: \`${batch.benchmark_task_ids.join(",")}\``,
      `- Live promotion status: \`${batch.live_promotion_status}\``,
      `- Live promotion blocker: ${batch.live_promotion_blocker}`,
      `- Placeholder count before fill: ${batch.placeholder_count}`,
      `- Placeholder blocker counts: \`${formatBlockerCounts(batch.placeholder_blocker_counts)}\``,
      `- Live context hydration skip counts: \`${formatHydrationSkipCounts(batch.hydration_skip_counts)}\``,
      `- Reviewed fact summaries: ${batch.reviewed_fact_summaries.length > 0 ? batch.reviewed_fact_summaries.map((entry) => `\`${entry.key}: ${markdownEscape(entry.reviewed_fact_summary)}\``).join("; ") : "_none_"}`,
      `- Batch fill template: \`${batch.batch_template_path}\``,
      `- Batch fill checklist: \`${batch.batch_checklist_path}\``,
      "",
      "Expected blocked template validation before filling:",
      "",
      "```powershell",
      batch.template_validation_command,
      "```",
      "",
      "Promotion command after filling this batch:",
      "",
      "```powershell",
      batch.promotion_command,
      "```",
      "",
      "No-write validation command before any live run:",
      "",
      "```powershell",
      batch.validation_command,
      "```",
      "",
      "Live Revit bridge preflight command after validation passes:",
      "",
      "```powershell",
      batch.preflight_command,
      "```"
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderDiscoveryPlanMarkdown(options: {
  inputPath: string;
  templatePath: string;
  checklistOutputPath?: string;
  filledOutputPath?: string;
  batchPlanMarkdownPath?: string;
  selectionAudit: PromotionSelectionAudit;
  rows: PromotionManifestRow[];
  discoveryPlanCounts: Record<string, number>;
  placeholderBlockerCounts: Record<string, number>;
  hydrationSkipCounts: Record<string, number>;
}): string {
  const skippedActionabilityRows = Object.entries(options.selectionAudit.skipped_by_group_actionability);
  const skippedRequiredActionabilityRows = Object.entries(options.selectionAudit.skipped_by_required_group_actionability ?? {});
  const skippedOperationTargetRows = Object.entries(options.selectionAudit.skipped_by_operation_target ?? {});
  const skippedBenchmarkTaskRows = Object.entries(options.selectionAudit.skipped_by_benchmark_task ?? {});
  const lines = [
    "# Redline Corpus Live Discovery Plan",
    "",
    "This is a no-write worksheet for filling reviewed corpus live-template rows. Do not run a live benchmark from the generated template until every placeholder is replaced with verified Revit context and validation reports `placeholder_count: 0`.",
    "",
    `- Reviewed rows: \`${options.inputPath}\``,
    `- Live request template: \`${options.templatePath}\``,
    options.checklistOutputPath ? `- Fill checklist: \`${options.checklistOutputPath}\`` : "- Fill checklist: _not requested_",
    options.filledOutputPath ? `- Intended filled override: \`${options.filledOutputPath}\`` : "- Intended filled override: _not supplied_",
    options.batchPlanMarkdownPath ? `- Collision-free batch plan: \`${options.batchPlanMarkdownPath}\`` : "- Collision-free batch plan: _not generated_",
    `- Reviewed rows with promotion status: ${options.selectionAudit.status_matched_count}`,
    `- Selected rows: ${options.selectionAudit.selected_count}`,
    `- Skipped by composite-group actionability: ${options.selectionAudit.skipped_by_group_actionability_count}`,
    options.selectionAudit.required_group_actionability
      ? `- Required composite-group actionability: ${options.selectionAudit.required_group_actionability.map(markdownEscape).join(", ")}`
      : "- Required composite-group actionability: _not enforced_",
    `- Skipped by required composite-group actionability: ${options.selectionAudit.skipped_by_required_group_actionability_count ?? 0}`,
    options.selectionAudit.required_operation_targets
      ? `- Required operation/target pairs: ${options.selectionAudit.required_operation_targets.map(markdownEscape).join(", ")}`
      : "- Required operation/target pairs: _not enforced_",
    `- Skipped by operation/target filter: ${options.selectionAudit.skipped_by_operation_target_count ?? 0}`,
    options.selectionAudit.required_benchmark_task_ids
      ? `- Required benchmark task ids: ${options.selectionAudit.required_benchmark_task_ids.map(markdownEscape).join(", ")}`
      : "- Required benchmark task ids: _not enforced_",
    `- Skipped by benchmark task filter: ${options.selectionAudit.skipped_by_benchmark_task_count ?? 0}`,
    "",
    "## Selection Audit",
    "",
    "| selection bucket | rows |",
    "| --- | ---: |",
    `| selected for live-template scaffolding | ${options.selectionAudit.selected_count} |`,
    ...(skippedActionabilityRows.length > 0
      ? skippedActionabilityRows.map(([key, count]) => `| skipped: ${markdownEscape(key)} | ${count} |`)
      : ["| skipped by composite-group actionability | 0 |"]),
    ...(skippedRequiredActionabilityRows.length > 0
      ? skippedRequiredActionabilityRows.map(([key, count]) => `| skipped by required actionability: ${markdownEscape(key)} | ${count} |`)
      : []),
    ...(skippedOperationTargetRows.length > 0
      ? skippedOperationTargetRows.map(([key, count]) => `| skipped by operation/target filter: ${markdownEscape(key)} | ${count} |`)
      : []),
    ...(skippedBenchmarkTaskRows.length > 0
      ? skippedBenchmarkTaskRows.map(([key, count]) => `| skipped by benchmark task filter: ${markdownEscape(key)} | ${count} |`)
      : []),
    "",
    "Rows skipped by composite-group actionability are not failures. Split-prone groups must be split or relabeled before promotion; non-actionable groups must stay out of live-template scaffolds unless a reviewer supplies a concrete operation and target.",
    "",
    "## Discovery Work Summary",
    "",
    "| discovery/readback step | rows |",
    "| --- | ---: |",
    ...Object.entries(options.discoveryPlanCounts).map(([step, count]) => `| ${markdownEscape(step)} | ${count} |`),
    "",
    "## Placeholder Blocker Summary",
    "",
    "| blocker class | remaining placeholders |",
    "| --- | ---: |",
    ...Object.entries(options.placeholderBlockerCounts).map(([key, count]) => `| ${markdownEscape(key)} | ${count} |`),
    "",
    "## Live Context Hydration Skip Summary",
    "",
    "| placeholder path | skipped rows |",
    "| --- | ---: |",
    ...(Object.keys(options.hydrationSkipCounts).length > 0
      ? Object.entries(options.hydrationSkipCounts).map(([key, count]) => `| ${markdownEscape(key)} | ${count} |`)
      : ["| _none_ | 0 |"]),
    "",
    "## Rows",
    "",
    "| key | task | operation | target | status | placeholders | file |",
    "| --- | --- | --- | --- | --- | ---: | --- |",
    ...options.rows.map((row) => `| ${markdownEscape(row.key)} | ${markdownEscape(row.benchmark_task_id)} | ${markdownEscape(row.operation_class)} | ${markdownEscape(row.target_class)} | ${markdownEscape(row.live_promotion_status)} | ${row.placeholder_count} | ${markdownEscape(row.file_path)} |`)
  ];

  for (const row of options.rows) {
    lines.push(
      "",
      `### ${row.key}`,
      "",
      `- Benchmark task: \`${row.benchmark_task_id}\``,
      `- Operation/target: \`${row.operation_class}\` / \`${row.target_class}\``,
      `- Source PDF: \`${row.file_path}\``,
      `- Review source: \`${formatReviewSource(row.review_source)}\``,
      row.reviewed_fact_summary ? `- Reviewed fact summary: \`${row.reviewed_fact_summary}\`` : "- Reviewed fact summary: _none_",
      `- Live promotion status: \`${row.live_promotion_status}\``,
      `- Live promotion blocker: ${row.live_promotion_blocker}`,
      `- Placeholder blocker summary: \`${formatBlockerCounts(row.placeholder_blocker_counts)}\``,
      ...(row.live_context_hydration ? [
        `- Live context hydrated: ${row.live_context_hydration.filled_paths?.length ?? 0} path(s)`,
        `- Live context skipped: ${row.live_context_hydration.skipped_placeholders?.length ?? 0} placeholder(s)`
      ] : []),
      `- Text: ${row.text_excerpt || "_No text excerpt._"}`,
      "",
      "#### No-Write Discovery Steps",
      "",
      ...row.live_discovery_plan.map((step) => `- [ ] ${step}`),
      "",
      "#### Suggested No-Write Bridge Actions",
      "",
      ...(readOnlyDiscoveryActionsForRow(row).length > 0
        ? readOnlyDiscoveryActionsForRow(row).map((entry) => `- \`${entry}\``)
        : ["- No row-specific read-only bridge actions suggested."]),
      "",
      "#### Placeholder Paths To Fill",
      "",
      ...(row.placeholder_paths.length > 0 ? row.placeholder_paths.map((entry) => `- \`${entry}\``) : ["- No placeholders remain."]),
      ...(row.live_context_hydration?.skipped_placeholders?.length ? [
        "",
        "#### Live Context Hydration Skips",
        "",
        ...row.live_context_hydration.skipped_placeholders.map((entry) => `- \`${entry.path}\`: ${entry.reason}`)
      ] : []),
      "",
      "#### Evidence Gates",
      "",
      ...(row.evidence_requirements.length > 0 ? row.evidence_requirements.map((entry) => `- \`${entry}\``) : ["- No evidence requirements recorded."])
    );
  }
  lines.push(
    "",
    "## Validation",
    "",
    options.filledOutputPath
      ? `After filling, run \`npm run benchmark -- validate-revit-requests --input ${options.filledOutputPath}\` and do not proceed unless it reports \`placeholder_count: 0\`. Then run \`${livePreflightCommand(options.filledOutputPath)}\` and do not proceed to a live benchmark unless the bridge preflight passes for the filled request tasks.`
      : "After filling, run `npm run benchmark -- validate-revit-requests --input <filled override>` and do not proceed unless it reports `placeholder_count: 0`."
  );
  return `${lines.join("\n")}\n`;
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === "\"" && next === "\"") {
        cell += "\"";
        i++;
      } else if (ch === "\"") {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [headers = [], ...dataRows] = rows;
  return dataRows
    .filter((entries) => entries.some((entry) => entry.trim()))
    .map((entries) => {
      const out: CsvRow = {};
      headers.forEach((header, index) => {
        out[header.trim()] = entries[index]?.trim() ?? "";
      });
      return out;
    });
}

function normalizedStatusSet(statuses?: string[]): Set<string> {
  const values = statuses?.length ? statuses : [...DEFAULT_PROMOTION_STATUSES];
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function typedValue<T extends string>(value: string, allowed: Set<string>): T | undefined {
  const normalized = value.trim();
  return normalized && allowed.has(normalized) && normalized !== "unknown" ? normalized as T : undefined;
}

function rowText(row: CsvRow): string {
  return [
    row.review_existing_text ? `existing_text=${row.review_existing_text};` : "",
    row.review_requested_text ? `requested_text=${row.review_requested_text};` : "",
    row.review_requested_size ? `requested size ${row.review_requested_size}` : "",
    row.review_requested_airflow ? `requested airflow ${row.review_requested_airflow}` : "",
    row.review_elevation_hint ? `elevation hint ${row.review_elevation_hint}` : "",
    row.review_requested_branch_count ? `requested_branch_count=${row.review_requested_branch_count};` : "",
    row.review_requested_connection_kind ? `requested_connection_kind=${row.review_requested_connection_kind};` : "",
    row.review_tap_placement_hint ? `tap_placement_hint=${row.review_tap_placement_hint};` : "",
    row.review_clearance_hint ? `clearance_hint=${row.review_clearance_hint};` : "",
    row.review_requested_lineweight ? `requested_lineweight=${row.review_requested_lineweight};` : "",
    row.review_graphics_style_intent ? `graphics_style_intent=${row.review_graphics_style_intent};` : "",
    row.review_graphics_target_hint ? `graphics_target_hint=${row.review_graphics_target_hint};` : "",
    row.review_visibility_intent ? `visibility_intent=${row.review_visibility_intent};` : "",
    row.review_requested_accessory_kind ? `requested_accessory_kind=${row.review_requested_accessory_kind};` : "",
    row.review_requested_accessory_size ? `requested_accessory_size=${row.review_requested_accessory_size};` : "",
    row.review_requested_tag_kind ? `requested_tag_kind=${row.review_requested_tag_kind};` : "",
    row.review_requested_tag_value ? `requested_tag_value=${row.review_requested_tag_value};` : "",
    row.review_requested_tag_note_number ? `requested_tag_note_number=${row.review_requested_tag_note_number};` : "",
    row.review_tag_target_scope ? `tag_target_scope=${row.review_tag_target_scope};` : "",
    row.review_existing_type ? `existing_type=${row.review_existing_type};` : "",
    row.review_requested_type ? `requested_type=${row.review_requested_type};` : "",
    row.review_linked_model_category ? `linked_model_category=${row.review_linked_model_category};` : "",
    row.review_linked_visibility_intent ? `linked_visibility_intent=${row.review_linked_visibility_intent};` : "",
    row.review_phase_name ? `phase_name=${row.review_phase_name};` : "",
    row.review_phase_filter ? `phase_filter=${row.review_phase_filter};` : "",
    row.review_phase_mapping_intent ? `phase_mapping_intent=${row.review_phase_mapping_intent};` : "",
    row.review_notes,
    row.text_excerpt,
    row.bucket_reason,
    row.bucket,
    row.subtype ? `subtype ${row.subtype}` : "",
    row.color_family ? `color ${row.color_family}` : ""
  ].filter(Boolean).join(" ");
}

const REVIEW_FACT_SOURCE_KEYS = [
  "review_existing_size",
  "review_requested_size",
  "review_requested_size_candidates",
  "review_requested_size_basis",
  "review_requested_airflow",
  "review_elevation_hint",
  "review_requested_branch_count",
  "review_requested_connection_kind",
  "review_tap_placement_hint",
  "review_clearance_hint",
  "review_requested_text",
  "review_existing_text",
  "review_requested_lineweight",
  "review_graphics_style_intent",
  "review_graphics_target_hint",
  "review_visibility_intent",
  "review_requested_accessory_kind",
  "review_requested_accessory_size",
  "review_requested_tag_kind",
  "review_requested_tag_value",
  "review_requested_tag_note_number",
  "review_tag_target_scope",
  "review_existing_type",
  "review_requested_type",
  "review_linked_model_category",
  "review_linked_visibility_intent",
  "review_phase_name",
  "review_phase_filter",
  "review_phase_mapping_intent"
] as const;

function reviewSourceForRow(row: CsvRow): Record<string, string> {
  const sourceKind = row.group_index || row.annotation_indices ? "composite_group" : row.index ? "mark" : "review_row";
  const entries: Record<string, string> = {
    source_kind: sourceKind,
    file: row.file || row.file_path || "",
    page: row.page || "",
    index: row.index || "",
    group_index: row.group_index || "",
    annotation_indices: row.annotation_indices || "",
    review_group_actionability: row.review_group_actionability || "",
    review_primary_annotation_indices: row.review_primary_annotation_indices || "",
    bucket: row.bucket || "",
    bucket_reason: row.bucket_reason || "",
    review_status: row.review_status || "",
    review_operation: row.review_operation || "",
    review_target: row.review_target || "",
    review_context: row.review_context || "",
    review_notes: row.review_notes || ""
  };
  for (const key of REVIEW_FACT_SOURCE_KEYS) {
    entries[key] = row[key] || "";
  }
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => String(value ?? "").trim()));
}

function templateTraceKey(args: { filePath: string; operation: string; target: string; text: string }): string {
  return [
    path.basename(args.filePath),
    args.operation,
    args.target,
    args.text.replace(/\s+/g, " ").trim().slice(0, 500)
  ].join("|");
}

function attachReviewSourceToTemplate(templatePath: string, rows: CsvRow[]): void {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  const templateTasks = asObject(template.tasks);
  const traceByKey = new Map<string, Record<string, string>[]>();
  for (const row of rows) {
    const filePath = row.file || row.file_path || "";
    const operation = typedValue<RedlineOperationClass>(row.review_operation || row.operation_class || "", OPERATION_VALUES) ?? "";
    const target = typedValue<RedlineTargetClass>(row.review_target || row.target_class || "", TARGET_VALUES) ?? "";
    const key = templateTraceKey({ filePath, operation, target, text: rowText(row) });
    const current = traceByKey.get(key) ?? [];
    current.push(reviewSourceForRow(row));
    traceByKey.set(key, current);
  }
  let changed = false;
  for (const task of Object.values(templateTasks).map(asObject)) {
    const source = asObject(task.corpus_source);
    const key = templateTraceKey({
      filePath: String(source.file_path ?? ""),
      operation: String(source.operation_class ?? ""),
      target: String(source.target_class ?? ""),
      text: String(source.text_excerpt ?? "")
    });
    const candidates = traceByKey.get(key);
    const reviewSource = candidates?.shift();
    if (!reviewSource) continue;
    source.review_source = reviewSource;
    task.corpus_source = source;
    changed = true;
  }
  if (changed) fs.writeFileSync(templatePath, JSON.stringify(template, null, 2) + "\n", "utf8");
}

function applyReviewedCompositeTextGrounding(templatePath: string): void {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  const templateTasks = asObject(template.tasks);
  let changed = false;
  for (const task of Object.values(templateTasks).map(asObject)) {
    if (String(task.benchmark_task_id ?? "") !== "demo_documentation_primitives") continue;
    const source = asObject(task.corpus_source);
    const reviewSource = asObject(source.review_source) as Record<string, string>;
    if (String(source.operation_class ?? "") !== "text_edit" || String(source.target_class ?? "") !== "text") continue;
    if (String(reviewSource.source_kind ?? "") !== "composite_group") continue;
    const textNote = asObject(asObject(task.request).textNote);
    if (Object.keys(textNote).length === 0) continue;
    const expected = nonPlaceholderString(reviewSource.review_existing_text);
    const requested = nonPlaceholderString(reviewSource.review_requested_text);
    if (expected) textNote.expectedExistingText = expected;
    if (requested) textNote.text = requested;
    textNote.compositeGroupEdit = true;
    textNote.groupGrounding = {
      sourceKind: "composite_group",
      groupIndex: reviewSource.group_index || "__FILL_COMPOSITE_GROUP_INDEX__",
      annotationIndices: reviewSource.review_primary_annotation_indices || reviewSource.annotation_indices || "__FILL_COMPOSITE_GROUP_ANNOTATION_INDICES__",
      reviewGroupActionability: reviewSource.review_group_actionability || "__FILL_LIKELY_SINGLE_ACTION_REVIEW__"
    };
    textNote.groupVisualProofReviewed = "__FILL_COMPOSITE_GROUP_VISUAL_PROOF_REVIEWED_TRUE__";
    task.request = { ...asObject(task.request), textNote };
    const missing = new Set(asArray(task.missing_live_inputs).map(String).filter(Boolean));
    missing.add("composite_group_annotation_grounding");
    missing.add("composite_group_visual_proof_review");
    task.missing_live_inputs = [...missing];
    task.placeholder_paths = findBenchmarkOverridePlaceholders(task.request, "request");
    changed = true;
  }
  if (changed) fs.writeFileSync(templatePath, JSON.stringify(template, null, 2) + "\n", "utf8");
}

function discoveryTaskKeyForBenchmarkTask(taskId: string): string | undefined {
  if (taskId === "demo_redline_mep_route" || taskId === "demo_redline_mep_duct_reroute" || taskId === "demo_redline_mep_duct_size_transition" || taskId === "demo_redline_mep_duct_tap_branch") {
    return "demo_redline_mep_route";
  }
  if (taskId === "demo_redline_mep_pipe_route" || taskId === "demo_redline_mep_pipe_reroute" || taskId === "demo_redline_mep_pipe_size_transition" || taskId === "demo_redline_mep_pipe_tap_branch") {
    return "demo_redline_mep_pipe_route";
  }
  if (taskId === "demo_documentation_primitives") return "demo_documentation_primitives";
  return taskId;
}

function setIfPlaceholder(request: Record<string, unknown>, pathName: string, value: unknown, filledPaths: string[]): void {
  if (value === undefined || value === null) return;
  const current = request[pathName];
  if (typeof current !== "string" || !current.includes("__FILL_")) return;
  request[pathName] = value;
  filledPaths.push(`request.${pathName}`);
}

function setNestedIfPlaceholder(request: Record<string, unknown>, parentPath: string, pathName: string, value: unknown, filledPaths: string[]): void {
  if (value === undefined || value === null) return;
  const parent = asObject(request[parentPath]);
  const current = parent[pathName];
  if (typeof current !== "string" || !current.includes("__FILL_")) return;
  parent[pathName] = value;
  request[parentPath] = parent;
  filledPaths.push(`request.${parentPath}.${pathName}`);
}

function setNestedArrayIfPlaceholder(request: Record<string, unknown>, parentPath: string, pathName: string, values: unknown[], filledPaths: string[]): void {
  if (values.length === 0) return;
  const parent = asObject(request[parentPath]);
  const current = asArray(parent[pathName]);
  if (current.length === 0 || !current.every((entry) => typeof entry === "string" && entry.includes("__FILL_"))) return;
  parent[pathName] = values;
  request[parentPath] = parent;
  filledPaths.push(...values.map((_, index) => `request.${parentPath}.${pathName}[${index}]`));
}

function setNestedAlternateIfPlaceholder(
  request: Record<string, unknown>,
  parentPath: string,
  placeholderPath: string,
  replacementPath: string,
  value: unknown,
  filledPaths: string[]
): void {
  if (value === undefined || value === null) return;
  const parent = asObject(request[parentPath]);
  const current = parent[placeholderPath];
  if (typeof current !== "string" || !current.includes("__FILL_")) return;
  delete parent[placeholderPath];
  parent[replacementPath] = value;
  request[parentPath] = parent;
  filledPaths.push(`request.${parentPath}.${replacementPath}`);
}

function setNestedBoolIfPlaceholder(request: Record<string, unknown>, parentPath: string, pathName: string, value: unknown, filledPaths: string[]): void {
  const bool = typeof value === "boolean" ? value : undefined;
  if (bool === undefined) return;
  const parent = asObject(request[parentPath]);
  const current = parent[pathName];
  if (typeof current !== "string" || !current.includes("__FILL_")) return;
  parent[pathName] = bool;
  request[parentPath] = parent;
  filledPaths.push(`request.${parentPath}.${pathName}`);
}

function discoveredCandidateLevelName(discoveryMeta: Record<string, unknown>): string | undefined {
  const fallbackElementId = positiveNumber(discoveryMeta.fallbackEditableElementId);
  const candidates = asArray(discoveryMeta.candidateMechanicalEquipment).map(asObject);
  const matchedCandidate = candidates.find((candidate) => positiveNumber(candidate.id) === fallbackElementId);
  return nonPlaceholderString(matchedCandidate?.level) ?? candidates.map((candidate) => nonPlaceholderString(candidate.level)).find(Boolean);
}

function roomContextHydrationSkip(discoveryMeta: Record<string, unknown>): HydrationSkip {
  const rawWarnings = asObject(discoveryMeta.rawWarnings);
  const mechanicalWarnings = asArray(rawWarnings.mechanicalEquipment).map(String).filter(Boolean);
  const unresolvedWarning = mechanicalWarnings.find((entry) => /room resolution unresolved|no_room_at_point|unresolved/i.test(entry));
  return {
    path: "request.roomNumber",
    reason: unresolvedWarning
      ? `Live discovery did not resolve room/space context (${unresolvedWarning}); keep this blocked until room or space tags/boundaries are verified in the target view.`
      : "Live discovery did not provide a verified room/space value; keep this blocked until room or space tags/boundaries are verified in the target view."
  };
}

function normalizeCategoryCandidate(value: string): string {
  return value
    .toLowerCase()
    .replace(/\ball\b/g, "")
    .replace(/\bcategory\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function discoveredCategoryNameForHint(discoveryMeta: Record<string, unknown>, hint: unknown): string | undefined {
  const normalizedHint = normalizeCategoryCandidate(nonPlaceholderString(hint) ?? "");
  if (!normalizedHint) return undefined;
  const categoryNames = Array.from(new Set([
    ...asArray(discoveryMeta.candidateMechanicalEquipment)
      .map(asObject)
      .map((candidate) => nonPlaceholderString(candidate.category))
      .filter(Boolean) as string[]
  ]));
  const exactMatch = categoryNames.find((categoryName) => normalizeCategoryCandidate(categoryName) === normalizedHint);
  if (exactMatch) return exactMatch;
  if (/\b(ffu|fan filter|fan powered|air device)\b/i.test(normalizedHint)) {
    return categoryNames.find((categoryName) => normalizeCategoryCandidate(categoryName) === "mechanical equipment");
  }
  return undefined;
}

function normalizedAccessoryText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedAccessorySize(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[″"]/g, "")
    .trim();
}

function accessorySymbolCandidates(discoveryMeta: Record<string, unknown>): Record<string, unknown>[] {
  const keys = [
    "candidateAccessorySymbols",
    "candidateFamilySymbols",
    "candidateElementTypes",
    "familySymbols",
    "elementTypes",
    "listElementTypes"
  ];
  return keys.flatMap((key) => asArray(discoveryMeta[key]).map(asObject));
}

function accessorySymbolCandidateFromDiscovery(
  discoveryMeta: Record<string, unknown>,
  familyInstance: Record<string, unknown>
): Record<string, unknown> | undefined {
  const kindHint = normalizedAccessoryText(familyInstance.requestedKindHint);
  const sizeHint = normalizedAccessorySize(familyInstance.requestedSizeHint);
  if (!kindHint && !sizeHint) return undefined;
  const kindTerms = kindHint.split(" ").filter((term) => term && !["accessory", "equipment", "mep", "mechanical"].includes(term));
  const matches = accessorySymbolCandidates(discoveryMeta).filter((candidate) => {
    const familyName = nonPlaceholderString(candidate.familyName ?? candidate.family_name ?? candidate.family) ?? "";
    const symbolName = nonPlaceholderString(candidate.symbolName ?? candidate.symbol_name ?? candidate.typeName ?? candidate.type_name ?? candidate.name) ?? "";
    if (!familyName && !symbolName) return false;
    const category = normalizedAccessoryText(candidate.category ?? candidate.categoryName ?? candidate.builtInCategory ?? candidate.built_in_category);
    if (category && !/(accessor|damper|mechanical equipment|ost ductaccessory|ost pipeaccessory|ost duct accessory|ost pipe accessory)/i.test(category)) return false;
    const haystack = normalizedAccessoryText(`${familyName} ${symbolName}`);
    const sizeHaystack = normalizedAccessorySize(`${familyName} ${symbolName}`);
    if (kindTerms.length > 0 && !kindTerms.every((term) => haystack.includes(term))) return false;
    if (sizeHint && !sizeHaystack.includes(sizeHint)) return false;
    return true;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function discoveredTrustedViewIds(discoveryMeta: Record<string, unknown>): Set<number> {
  const trusted = new Set<number>();
  for (const source of [discoveryMeta.candidateSheets, discoveryMeta.candidateViews]) {
    for (const entry of asArray(source).map(asObject)) {
      const id = positiveNumber(entry.id);
      const viewId = positiveNumber(entry.viewId);
      if (id !== undefined) trusted.add(id);
      if (viewId !== undefined) trusted.add(viewId);
    }
  }
  return trusted;
}

function isDocumentationGraphicsRequest(request: Record<string, unknown>): boolean {
  return [
    "categoryVisibility",
    "filterVisibility",
    "viewTemplateVisibility",
    "templateCategoryVisibility",
    "linkedModelCategoryVisibility",
    "phaseVisibility",
    "cadLink",
    "cadGraphicsOverride",
    "linkedModelGraphicsOverride"
  ].some((key) => Object.keys(asObject(request[key])).length > 0);
}

function hydrateReviewedTemplateWithLiveContext(templatePath: string, liveContextPath: string): {
  before_placeholder_count: number;
  after_placeholder_count: number;
  filled_path_count: number;
  filled_paths: string[];
  task_summaries: HydrationTaskSummary[];
} {
  const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  const discovery = JSON.parse(fs.readFileSync(liveContextPath, "utf8")) as Record<string, unknown>;
  const templateTasks = asObject(template.tasks);
  const discoveryTasks = asObject(discovery.tasks);
  const discoveryMeta = asObject(discovery._discovery);
  const candidateTargetView = asObject(discoveryMeta.candidateTargetView);
  const trustedViewIds = discoveredTrustedViewIds(discoveryMeta);
  const fallbackLevelName = discoveredCandidateLevelName(discoveryMeta);
  const filledPaths: string[] = [];
  const taskSummaries: HydrationTaskSummary[] = [];
  let beforePlaceholderCount = 0;

  for (const [key, value] of Object.entries(templateTasks)) {
    const row = asObject(value);
    const taskId = String(row.benchmark_task_id ?? key);
    const sourceKey = discoveryTaskKeyForBenchmarkTask(taskId);
    const sourceRequest = asObject(asObject(discoveryTasks[sourceKey ?? ""]).request);
    const request = asObject(row.request);
    if (Object.keys(request).length === 0) continue;
    const beforeRowPlaceholders = findBenchmarkOverridePlaceholders(request, "request");
    beforePlaceholderCount += beforeRowPlaceholders.length;
    const rowFilled: string[] = [];
    const rowSkipped: HydrationSkip[] = [];
    const sourceTag = asObject(sourceRequest.tag);
    const sourceTextNote = asObject(sourceRequest.textNote);
    const sourceFamilyInstance = asObject(sourceRequest.familyInstance);
    const sourceExistingTarget = asObject(sourceRequest.existingTarget ?? sourceRequest.existing_target ?? sourceRequest.targetElement ?? sourceRequest.target_element);
    const categoryVisibility = asObject(request.categoryVisibility);
    const rawViewId = positiveNumber(sourceRequest.viewId) ?? positiveNumber(sourceRequest.visualViewId) ?? positiveNumber(sourceTag.viewId) ?? positiveNumber(candidateTargetView.id);
    const requestNeedsTrustedViewId = isDocumentationGraphicsRequest(request);
    const viewId = requestNeedsTrustedViewId && (rawViewId === undefined || !trustedViewIds.has(rawViewId))
      ? undefined
      : rawViewId;
    setIfPlaceholder(request, "viewId", viewId, rowFilled);
    setIfPlaceholder(request, "visualViewId", viewId, rowFilled);
    setNestedIfPlaceholder(request, "tag", "viewId", viewId, rowFilled);
    setNestedArrayIfPlaceholder(request, "tag", "elementIds", asArray(sourceTag.elementIds).map(positiveNumber).filter((id): id is number => id !== undefined), rowFilled);
    setNestedArrayIfPlaceholder(request, "tag", "existingTagIds", asArray(sourceTag.existingTagIds ?? sourceTag.tagIds).map(positiveNumber).filter((id): id is number => id !== undefined), rowFilled);
    setNestedIfPlaceholder(request, "tag", "valueSourceParameterName", nonPlaceholderString(sourceTag.valueSourceParameterName ?? sourceTag.parameterName), rowFilled);
    setNestedIfPlaceholder(request, "tag", "expectedExistingValue", nonPlaceholderString(sourceTag.expectedExistingValue ?? sourceTag.originalValue ?? sourceTag.existingValue), rowFilled);
    setNestedIfPlaceholder(request, "tag", "requestedTagValueHint", nonPlaceholderString(sourceTag.requestedTagValueHint ?? sourceTag.tagValue ?? sourceTag.value ?? sourceTag.text), rowFilled);
    setNestedIfPlaceholder(request, "tag", "tagTypeId", positiveNumber(sourceTag.tagTypeId ?? sourceTag.typeId), rowFilled);
    setNestedAlternateIfPlaceholder(request, "tag", "tagTypeId", "tagTypeName", nonPlaceholderString(sourceTag.tagTypeName ?? sourceTag.typeName), rowFilled);
    setNestedIfPlaceholder(request, "tag", "tagTypeName", nonPlaceholderString(sourceTag.tagTypeName ?? sourceTag.typeName), rowFilled);
    setNestedIfPlaceholder(request, "textNote", "viewId", viewId, rowFilled);
    setNestedIfPlaceholder(request, "textNote", "textNoteId", positiveNumber(sourceTextNote.textNoteId ?? sourceTextNote.elementId ?? sourceTextNote.id), rowFilled);
    setNestedIfPlaceholder(request, "textNote", "expectedExistingText", nonPlaceholderString(sourceTextNote.expectedExistingText ?? sourceTextNote.originalText ?? sourceTextNote.textContains), rowFilled);
    setNestedIfPlaceholder(request, "textNote", "text", nonPlaceholderString(sourceTextNote.text ?? sourceTextNote.newText ?? sourceTextNote.replacementText), rowFilled);
    setNestedIfPlaceholder(
      request,
      "categoryVisibility",
      "categoryName",
      discoveredCategoryNameForHint(discoveryMeta, categoryVisibility.requestedTargetHint),
      rowFilled
    );
    if (Object.keys(sourceRequest).length > 0) {
      setIfPlaceholder(request, "roomNumber", nonPlaceholderString(sourceRequest.roomNumber), rowFilled);
      setIfPlaceholder(request, "levelName", nonPlaceholderString(sourceRequest.levelName) ?? fallbackLevelName, rowFilled);
      setIfPlaceholder(request, "systemType", nonPlaceholderString(sourceRequest.systemType), rowFilled);
      setIfPlaceholder(request, "ductSize", nonPlaceholderString(sourceRequest.ductSize), rowFilled);
      setIfPlaceholder(request, "pipeSize", nonPlaceholderString(sourceRequest.pipeSize), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "familyName", nonPlaceholderString(sourceFamilyInstance.familyName), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "symbolName", nonPlaceholderString(sourceFamilyInstance.symbolName ?? sourceFamilyInstance.typeName), rowFilled);
      const familyInstanceRequest = asObject(request.familyInstance);
      const accessorySymbolCandidate = accessorySymbolCandidateFromDiscovery(discoveryMeta, familyInstanceRequest);
      setNestedIfPlaceholder(request, "familyInstance", "familyName", nonPlaceholderString(accessorySymbolCandidate?.familyName ?? accessorySymbolCandidate?.family_name ?? accessorySymbolCandidate?.family), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "symbolName", nonPlaceholderString(accessorySymbolCandidate?.symbolName ?? accessorySymbolCandidate?.symbol_name ?? accessorySymbolCandidate?.typeName ?? accessorySymbolCandidate?.type_name ?? accessorySymbolCandidate?.name), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "levelName", nonPlaceholderString(sourceFamilyInstance.levelName) ?? nonPlaceholderString(sourceRequest.levelName) ?? fallbackLevelName, rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "hostElementId", positiveNumber(sourceFamilyInstance.hostElementId ?? sourceFamilyInstance.hostId), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "placementBasis", nonPlaceholderString(sourceFamilyInstance.placementBasis), rowFilled);
      setNestedBoolIfPlaceholder(request, "familyInstance", "allowUnhostedPointPlacement", sourceFamilyInstance.allowUnhostedPointPlacement, rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "x", finiteNumber(sourceFamilyInstance.x), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "y", finiteNumber(sourceFamilyInstance.y), rowFilled);
      setNestedIfPlaceholder(request, "familyInstance", "z", finiteNumber(sourceFamilyInstance.z), rowFilled);
      setNestedArrayIfPlaceholder(
        request,
        "existingTarget",
        "elementIds",
        [
          ...asArray(sourceExistingTarget.elementIds ?? sourceExistingTarget.element_ids ?? sourceExistingTarget.ids).map(positiveNumber).filter((id): id is number => id !== undefined),
          ...[sourceExistingTarget.elementId, sourceExistingTarget.element_id, sourceRequest.targetElementId, sourceRequest.target_element_id]
            .map(positiveNumber)
            .filter((id): id is number => id !== undefined)
        ],
        rowFilled
      );
      setNestedIfPlaceholder(request, "existingTarget", "expectedFamilyName", nonPlaceholderString(sourceExistingTarget.expectedFamilyName ?? sourceExistingTarget.expected_family_name ?? sourceExistingTarget.familyName ?? sourceExistingTarget.family_name), rowFilled);
      setNestedIfPlaceholder(request, "existingTarget", "expectedTypeName", nonPlaceholderString(sourceExistingTarget.expectedTypeName ?? sourceExistingTarget.expected_type_name ?? sourceExistingTarget.typeName ?? sourceExistingTarget.type_name), rowFilled);
      setNestedIfPlaceholder(request, "existingTarget", "expectedCategory", nonPlaceholderString(sourceExistingTarget.expectedCategory ?? sourceExistingTarget.expected_category ?? sourceExistingTarget.category ?? sourceExistingTarget.categoryName ?? sourceExistingTarget.builtInCategory ?? sourceExistingTarget.built_in_category), rowFilled);
    }
    const afterRowPlaceholders = findBenchmarkOverridePlaceholders(request, "request");
    taskSummaries.push({
      key,
      benchmark_task_id: taskId,
      before_placeholder_count: beforeRowPlaceholders.length,
      after_placeholder_count: afterRowPlaceholders.length,
      filled_paths: rowFilled,
      skipped_placeholders: rowSkipped
    });
    if (requestHasPlaceholder(request, "roomNumber")) rowSkipped.push(roomContextHydrationSkip(discoveryMeta));
    if (rowFilled.length === 0 && rowSkipped.length === 0) continue;
    row.request = request;
    row.placeholder_paths = afterRowPlaceholders;
    const sourceMissingInputs = asObject(row.corpus_source).missing_live_inputs;
    const updatedMissingInputs = removeHydratedMissingInputs(row.missing_live_inputs ?? sourceMissingInputs, rowFilled);
    if (updatedMissingInputs) row.missing_live_inputs = updatedMissingInputs;
    row.ready_to_run = false;
    row.live_context_hydration = {
      source: path.resolve(liveContextPath),
      discovery_task: sourceKey,
      filled_paths: rowFilled,
      skipped_placeholders: rowSkipped,
      note: "Only shared live context was copied; geometry, host/main elements, fittings, connector audits, visual gates, and cleanup proof remain gated."
    };
    filledPaths.push(...rowFilled.map((entry) => `${key}.${entry}`));
  }

  const allPlaceholders = Object.values(templateTasks).flatMap((task) => findBenchmarkOverridePlaceholders(asObject(task).request, "request"));
  template.placeholder_count = allPlaceholders.length;
  template.placeholder_task_count = Object.values(templateTasks).filter((task) => findBenchmarkOverridePlaceholders(asObject(task).request, "request").length > 0).length;
  template.ready_to_run = false;
  template.live_context_hydration = {
    source: path.resolve(liveContextPath),
    filled_path_count: filledPaths.length,
    note: "Hydration is no-write context only and does not make this template runnable."
  };
  fs.writeFileSync(templatePath, JSON.stringify(template, null, 2) + "\n", "utf8");
  return {
    before_placeholder_count: beforePlaceholderCount,
    after_placeholder_count: allPlaceholders.length,
    filled_path_count: filledPaths.length,
    filled_paths: filledPaths,
    task_summaries: taskSummaries
  };
}

export function promoteReviewedRedlineRows(options: PromoteReviewedRowsOptions) {
  const inputPath = path.resolve(options.inputPath);
  const outputDir = path.resolve(options.outputDir);
  const statuses = normalizedStatusSet(options.statuses);
  const requiredGroupActionability = normalizedRequiredGroupActionability(options.requireGroupActionability);
  const operationTargets = normalizedOperationTargets(options.operationTargets);
  const benchmarkTasks = normalizedBenchmarkTasks(options.benchmarkTasks);
  const rows = parseCsv(fs.readFileSync(inputPath, "utf8"));
  const selectedBeforeTaskFilter = rows.filter((row) => reviewRowEligibleForPromotion(row, statuses, requiredGroupActionability, operationTargets));
  const classified = selectedBeforeTaskFilter.map((row, index) => {
    const filePath = row.file || row.file_path || `${inputPath}#row-${index + 1}`;
    return {
      row,
      item: classifyRedlineCorpusText({
        file_path: filePath,
        text: rowText(row),
        operation_class: typedValue<RedlineOperationClass>(row.review_operation || row.operation_class || "", OPERATION_VALUES),
        target_class: typedValue<RedlineTargetClass>(row.review_target || row.target_class || "", TARGET_VALUES),
        context_class: typedValue<RedlineContextClass>(row.review_context || row.context_class || "", CONTEXT_VALUES)
      })
    };
  });
  const skippedByBenchmarkTask = benchmarkTasks
    ? classified.reduce((counts, entry) => {
      const taskIds = classificationTaskIds(entry.item);
      if (taskIds.some((taskId) => benchmarkTasks.has(taskId))) return counts;
      for (const taskId of taskIds) counts[taskId] = (counts[taskId] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>)
    : undefined;
  const selected = benchmarkTasks
    ? classified.filter((entry) => classificationTaskIds(entry.item).some((taskId) => benchmarkTasks.has(taskId)))
    : classified;
  const limited = Number.isFinite(options.limit) && options.limit && options.limit > 0 ? selected.slice(0, options.limit) : selected;
  const selectionAudit = promotionSelectionAudit(rows, statuses, limited.length, requiredGroupActionability, operationTargets);
  if (benchmarkTasks) {
    selectionAudit.required_benchmark_task_ids = [...benchmarkTasks];
    selectionAudit.skipped_by_benchmark_task_count = Object.values(skippedByBenchmarkTask ?? {}).reduce((sum, count) => sum + count, 0);
    selectionAudit.skipped_by_benchmark_task = skippedByBenchmarkTask ?? {};
  }
  const limitedRows = limited.map((entry) => entry.row);
  const items = limited.map((entry) => entry.item);
  const report = buildRedlineCorpusReport({ sourceDir: inputPath, items });
  const paths = writeRedlineCorpusReport(report, outputDir);
  attachReviewSourceToTemplate(paths.liveOverrideTemplatePath, limitedRows);
  applyReviewedCompositeTextGrounding(paths.liveOverrideTemplatePath);
  const hydration = options.liveContextPath
    ? hydrateReviewedTemplateWithLiveContext(paths.liveOverrideTemplatePath, path.resolve(options.liveContextPath))
    : undefined;
  const templateRows = listRedlineCorpusTemplateRows({
    templatePath: paths.liveOverrideTemplatePath,
    limit: Number.MAX_SAFE_INTEGER
  });
  let checklistOutputPath: string | undefined;
  if (options.checklistOutputPath) {
    checklistOutputPath = path.resolve(options.checklistOutputPath);
    const checklist = renderRedlineCorpusTemplateChecklist(templateRows, {
      templatePath: paths.liveOverrideTemplatePath,
      filledOutputPath: options.filledOutputPath
    });
    fs.mkdirSync(path.dirname(checklistOutputPath), { recursive: true });
    fs.writeFileSync(checklistOutputPath, checklist, "utf8");
  }
  const promotionArtifacts = writePromotionManifest({
    outputDir,
    inputPath,
    selectedCount: limited.length,
    selectionAudit,
    templatePath: paths.liveOverrideTemplatePath,
    reviewMarkdownPath: paths.reviewMarkdownPath,
    checklistOutputPath,
    filledOutputPath: options.filledOutputPath,
    rows: templateRows
  });
  return {
    ok: true,
    input: inputPath,
    output: outputDir,
    selected_count: limited.length,
    selection_audit: selectionAudit,
    report,
    paths: {
      ...paths,
      checklistOutputPath,
      promotionManifestPath: promotionArtifacts.manifestPath,
      discoveryPlanPath: promotionArtifacts.discoveryPlanPath,
      promotionBatchPlanPath: promotionArtifacts.batchPlanPath,
      promotionBatchPlanMarkdownPath: promotionArtifacts.batchPlanMarkdownPath
    },
    hydration
  };
}

export function reportReviewedRedlineHydration(options: Omit<PromoteReviewedRowsOptions, "outputDir" | "checklistOutputPath" | "filledOutputPath">) {
  if (!options.liveContextPath) {
    throw new Error("Hydration report requires --live-context.");
  }
  const tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-reviewed-hydration-report-"));
  try {
    const result = promoteReviewedRedlineRows({
      ...options,
      outputDir: tempOutputDir
    });
    const templateRows = listRedlineCorpusTemplateRows({
      templatePath: result.paths.liveOverrideTemplatePath,
      limit: Number.MAX_SAFE_INTEGER
    });
    const placeholderBlockerCounts = templateRows.reduce((counts, row) => {
      for (const [key, count] of Object.entries(blockerCounts(row.placeholder_paths))) counts[key] = (counts[key] ?? 0) + count;
      return counts;
    }, {} as Record<string, number>);
    const templateRowsByKey = new Map(templateRows.map((row) => [row.key, row]));
    const taskSummaries = (result.hydration?.task_summaries ?? []).map((summary) => {
      const row = templateRowsByKey.get(summary.key);
      return {
        ...summary,
        review_source: row?.review_source,
        reviewed_fact_summary: reviewedFactSummary(row?.review_source) || undefined,
        reviewed_tap_topology_facts: reviewedTapTopologyFacts(row?.review_source) || undefined,
        remaining_placeholder_paths: row?.placeholder_paths ?? [],
        placeholder_blocker_counts: row ? blockerCounts(row.placeholder_paths) : {},
        discovery_steps: row ? discoveryPlanForRow(row) : [],
        suggested_read_only_actions: row ? readOnlyDiscoveryActionsForRow(row) : []
      };
    });
    const discoverySteps = Array.from(new Set(taskSummaries.flatMap((summary) => summary.discovery_steps)));
    const suggestedReadOnlyActions = Array.from(new Set(taskSummaries.flatMap((summary) => summary.suggested_read_only_actions)));
    const nextFillCandidates = [...taskSummaries]
      .sort((a, b) =>
        a.after_placeholder_count - b.after_placeholder_count ||
        a.remaining_placeholder_paths.length - b.remaining_placeholder_paths.length ||
        a.key.localeCompare(b.key)
      )
      .slice(0, 10)
      .map((summary) => ({
        key: summary.key,
        benchmark_task_id: summary.benchmark_task_id,
        after_placeholder_count: summary.after_placeholder_count,
        review_source: summary.review_source,
        reviewed_fact_summary: summary.reviewed_fact_summary,
        reviewed_tap_topology_facts: summary.reviewed_tap_topology_facts,
        placeholder_blocker_counts: summary.placeholder_blocker_counts,
        remaining_placeholder_paths: summary.remaining_placeholder_paths,
        filled_path_count: summary.filled_paths.length
      }));
    const afterPlaceholderCount = result.hydration?.after_placeholder_count ?? templateRows.reduce((sum, row) => sum + row.placeholder_count, 0);
    const promotionStatus = livePromotionStatus(afterPlaceholderCount);
    return {
      ok: true,
      mode: "hydration_report_only",
      selected_count: result.selected_count,
      selection_audit: result.selection_audit,
      before_placeholder_count: result.hydration?.before_placeholder_count ?? null,
      after_placeholder_count: afterPlaceholderCount,
      filled_path_count: result.hydration?.filled_path_count ?? 0,
      filled_paths: result.hydration?.filled_paths ?? [],
      placeholder_blocker_counts: placeholderBlockerCounts,
      discovery_steps: discoverySteps,
      suggested_read_only_actions: suggestedReadOnlyActions,
      next_fill_candidates: nextFillCandidates,
      live_promotion_status: promotionStatus.status,
      live_promotion_blocker: promotionStatus.blocker,
      task_summaries: taskSummaries
    };
  } finally {
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const inputPath = flagValue(process.argv, "--input");
  const outputDir = flagValue(process.argv, "--output");
  const hydrationReportOnly = process.argv.includes("--hydration-report-only") || process.argv.includes("--dry-run-hydration");
  if (!inputPath || (!outputDir && !hydrationReportOnly)) {
    console.error("Usage: npm run redline:promote-reviewed-rows -- --input <redline_corpus_mark_review_queue.csv> --output <output-folder> [--status promote,approved,ready] [--limit 20] [--require-group-actionability likely_single_action] [--operation-target reroute_offset/duct,tap_branch/duct] [--benchmark-task demo_redline_mep_pipe_route] [--checklist-output fill-checklist.md] [--filled-output filled-live-override.json] [--live-context demo-live-requests.json] [--hydration-report-only]");
    process.exit(2);
  }
  const sharedOptions = {
    inputPath,
    statuses: flagValue(process.argv, "--status")?.split(",").map((entry) => entry.trim()).filter(Boolean),
    limit: flagValue(process.argv, "--limit") ? Number(flagValue(process.argv, "--limit")) : undefined,
    requireGroupActionability: flagValue(process.argv, "--require-group-actionability")?.split(",").map((entry) => entry.trim()).filter(Boolean),
    operationTargets: flagValue(process.argv, "--operation-target")?.split(",").map((entry) => entry.trim()).filter(Boolean),
    benchmarkTasks: flagValue(process.argv, "--benchmark-task")?.split(",").map((entry) => entry.trim()).filter(Boolean),
    liveContextPath: flagValue(process.argv, "--live-context")
  };
  if (hydrationReportOnly) {
    console.log(JSON.stringify(reportReviewedRedlineHydration(sharedOptions), null, 2));
    return;
  }
  const result = promoteReviewedRedlineRows({
    ...sharedOptions,
    outputDir: outputDir as string,
    checklistOutputPath: flagValue(process.argv, "--checklist-output"),
    filledOutputPath: flagValue(process.argv, "--filled-output")
  });
  console.log(JSON.stringify({
    ok: true,
    selected_count: result.selected_count,
    selection_audit: result.selection_audit,
    live_benchmark_queue_count: result.report.live_benchmark_queue.length,
    live_request_template: result.paths.liveOverrideTemplatePath,
    review_markdown: result.paths.reviewMarkdownPath,
    fill_checklist: result.paths.checklistOutputPath,
    promotion_manifest: result.paths.promotionManifestPath,
    discovery_plan: result.paths.discoveryPlanPath,
    promotion_batches: result.paths.promotionBatchPlanPath,
    promotion_batches_markdown: result.paths.promotionBatchPlanMarkdownPath,
    live_context_hydration: result.hydration
  }, null, 2));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
