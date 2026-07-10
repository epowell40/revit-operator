import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRunnableRevitWorkflowOverride, findBenchmarkOverridePlaceholders } from "../benchmark/environment.js";
import { readJsonFile, writeJsonFile } from "../benchmark/files.js";
import { loadBenchmarkTasks } from "../benchmark/tasks.js";

type JsonMap = Record<string, unknown>;

export type PromoteCorpusTemplateOptions = {
  templatePath: string;
  key: string;
  outputPath: string;
  allowPlaceholders?: boolean;
  allowUnknownTasks?: boolean;
};

export type PromoteCorpusTemplateRowsOptions = {
  templatePath: string;
  keys: string[];
  outputPath: string;
  allowPlaceholders?: boolean;
  allowUnknownTasks?: boolean;
};

export type ValidateCorpusTemplateRowsOptions = {
  templatePath: string;
  keys: string[];
  filledOutputPath?: string;
  allowUnknownTasks?: boolean;
};

export type ListCorpusTemplateRowsOptions = {
  templatePath: string;
  operation?: string;
  target?: string;
  task?: string;
  contains?: string;
  limit?: number;
};

export type CorpusTemplateRowSummary = {
  key: string;
  benchmark_task_id: string;
  operation_class: string;
  target_class: string;
  file_path: string;
  review_source?: Record<string, string>;
  reviewed_fact_summary?: string;
  placeholder_count: number;
  placeholder_paths: string[];
  placeholder_blocker_counts?: Record<string, number>;
  live_context_hydration?: {
    filled_paths?: string[];
    skipped_placeholders?: Array<{ path: string; reason: string }>;
    note?: string;
  };
  missing_live_inputs: string[];
  evidence_requirements: string[];
  text_excerpt: string;
};

export type RenderChecklistOptions = {
  templatePath?: string;
  filledOutputPath?: string;
};

export type CorpusTemplateRowValidation = CorpusTemplateRowSummary & {
  ready_to_promote: boolean;
  unknown_benchmark_task: boolean;
  blocking_reasons: string[];
  promotion_command: string;
  validate_command: string;
};

export type CorpusTemplateValidationResult = {
  ok: boolean;
  template: string;
  source_batch?: {
    batch_id?: unknown;
    batch_source_template?: unknown;
    live_promotion_status?: unknown;
    live_promotion_blocker?: unknown;
    placeholder_blocker_counts?: unknown;
    hydration_skip_counts?: unknown;
  };
  ready_to_promote: boolean;
  row_count: number;
  placeholder_count: number;
  rows: CorpusTemplateRowValidation[];
};

function markdownEscape(value: unknown): string {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function sourceBatchProvenance(rootObj: JsonMap): CorpusTemplateValidationResult["source_batch"] {
  return rootObj.batch_id ? {
    batch_id: rootObj.batch_id,
    batch_source_template: rootObj.batch_source_template,
    live_promotion_status: rootObj.live_promotion_status,
    live_promotion_blocker: rootObj.live_promotion_blocker,
    placeholder_blocker_counts: rootObj.placeholder_blocker_counts,
    hydration_skip_counts: rootObj.hydration_skip_counts
  } : undefined;
}

function liveContextHydration(value: unknown): CorpusTemplateRowSummary["live_context_hydration"] {
  const hydration = asObject(value);
  if (Object.keys(hydration).length === 0) return undefined;
  const skipped = Array.isArray(hydration.skipped_placeholders)
    ? hydration.skipped_placeholders.map(asObject).map((entry) => ({
      path: String(entry.path ?? ""),
      reason: String(entry.reason ?? "")
    })).filter((entry) => entry.path && entry.reason)
    : undefined;
  const out = {
    filled_paths: Array.isArray(hydration.filled_paths) ? hydration.filled_paths.map(String) : undefined,
    skipped_placeholders: skipped,
    note: typeof hydration.note === "string" ? hydration.note : undefined
  };
  return (out.filled_paths?.length || out.skipped_placeholders?.length || out.note) ? out : undefined;
}

export function placeholderBlockerClass(pathName: string): string {
  if (/viewId|visualViewId/.test(pathName)) return "view_context";
  if (/roomNumber|roomName|spaceNumber|spaceName|targetRoom|targetSpace/.test(pathName)) return "space_or_room_context";
  if (/hostElementId|mainElementId|sourceElementId|elementIds/.test(pathName)) return "live_element_target";
  if (/points|Points|projectedTapPoint|splitPoints|branchPoints|offsetVector|transitionNormalized|transitionChainageFt|vectorX|vectorY|textNote\.(x|y)/.test(pathName)) return "projection_or_geometry";
  if (/sizingScope|engineeringSizingBasis|upstream|downstream/.test(pathName)) return "sizing_scope_readback";
  if (/systemType|levelName|ductSize|pipeSize|fittingTypeId|expectedFitting|connectionMode|orientation|offsetMode|preserveConnectedEndpoints/.test(pathName)) return "system_fitting_topology";
  if (/tag\.|textNote\.text/.test(pathName)) return "annotation_target_or_content";
  if (/categoryVisibility|filterVisibility|viewTemplate|phaseVisibility|linkedModelCategoryVisibility|cadLink|cadGraphicsOverride/.test(pathName)) return "graphics_or_link_target";
  if (/targetTypeId|category|symbolName|symbolId|familyInstance/.test(pathName)) return "family_type_or_category";
  if (/cleanup|revert|capture/.test(pathName)) return "verification_or_cleanup";
  return "other_verified_context";
}

export function blockerCounts(paths: string[]): Record<string, number> {
  return paths.reduce((counts, pathName) => {
    const key = placeholderBlockerClass(pathName);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
}

export function formatBlockerCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  return entries.length > 0 ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "none";
}

function formatReviewSource(source: Record<string, string> | undefined): string {
  const entries = Object.entries(source ?? {}).filter(([, value]) => String(value ?? "").trim());
  return entries.length > 0
    ? entries.map(([key, value]) => {
      const text = String(value);
      const rendered = text.length > 180 ? `${text.slice(0, 180)}...` : text;
      return `${key}=${rendered}`;
    }).join(", ")
    : "none";
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
  return Object.entries(labels)
    .map(([key, label]) => {
      const value = source?.[key]?.trim();
      return value ? `${label}=${value}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function templateRowForKey(tasks: JsonMap, key: string): JsonMap {
  const row = asObject(tasks[key]);
  if (Object.keys(row).length === 0) {
    const available = Object.keys(tasks).slice(0, 20).join(", ");
    throw new Error(`Corpus template key not found: ${key}. Available keys: ${available}`);
  }
  return row;
}

function canonicalBenchmarkTaskId(row: JsonMap, key: string): string {
  const taskId = String(row.benchmark_task_id ?? key).trim();
  const source = asObject(row.corpus_source);
  const operation = String(source.operation_class ?? "");
  const target = String(source.target_class ?? "");
  if (taskId === "demo_parameter_edit" && operation === "parameter_edit" && target === "model_parameter") {
    return "demo_redline_update_parameter";
  }
  return taskId;
}

export function listRedlineCorpusTemplateRows(options: ListCorpusTemplateRowsOptions): CorpusTemplateRowSummary[] {
  const templatePath = path.resolve(options.templatePath);
  const root = readJsonFile<unknown>(templatePath);
  const tasks = asObject(asObject(root).tasks);
  const contains = options.contains?.trim().toLowerCase() ?? "";
  const summaries: CorpusTemplateRowSummary[] = [];
  for (const [key, value] of Object.entries(tasks)) {
    const row = asObject(value);
    const source = asObject(row.corpus_source);
    const request = asObject(row.request);
    const placeholderPaths = findBenchmarkOverridePlaceholders(request, "request");
    const reviewSource = asObject(source.review_source);
    const normalizedReviewSource = Object.keys(reviewSource).length > 0 ? Object.fromEntries(Object.entries(reviewSource).map(([key, value]) => [key, String(value)])) : undefined;
    const factSummary = reviewedFactSummary(normalizedReviewSource);
    const summary: CorpusTemplateRowSummary = {
      key,
      benchmark_task_id: canonicalBenchmarkTaskId(row, key),
      operation_class: String(source.operation_class ?? ""),
      target_class: String(source.target_class ?? ""),
      file_path: String(source.file_path ?? ""),
      review_source: normalizedReviewSource,
      reviewed_fact_summary: factSummary || undefined,
      placeholder_count: placeholderPaths.length,
      placeholder_paths: placeholderPaths,
      placeholder_blocker_counts: blockerCounts(placeholderPaths),
      live_context_hydration: liveContextHydration(row.live_context_hydration),
      missing_live_inputs: Array.isArray(row.missing_live_inputs)
        ? row.missing_live_inputs.map(String)
        : Array.isArray(source.missing_live_inputs) ? source.missing_live_inputs.map(String) : [],
      evidence_requirements: Array.isArray(source.evidence_requirements) ? source.evidence_requirements.map(String) : [],
      text_excerpt: String(source.text_excerpt ?? "")
    };
    if (options.operation && summary.operation_class !== options.operation) continue;
    if (options.target && summary.target_class !== options.target) continue;
    if (options.task && summary.benchmark_task_id !== options.task) continue;
    if (contains) {
      const haystack = `${summary.key} ${summary.benchmark_task_id} ${summary.operation_class} ${summary.target_class} ${summary.file_path} ${summary.text_excerpt}`.toLowerCase();
      if (!haystack.includes(contains)) continue;
    }
    summaries.push(summary);
  }
  const limit = Number.isFinite(options.limit) && options.limit && options.limit > 0 ? options.limit : 50;
  return summaries.slice(0, limit);
}

function commandPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function promotionCommand(templatePath: string | undefined, key: string, filledOutputPath: string | undefined): string {
  return `npm run redline:promote-live-template -- --template ${commandPath(templatePath, "__FILL_TEMPLATE_PATH__")} --key ${key} --output ${commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__")}`;
}

function validateCommand(filledOutputPath: string | undefined): string {
  return `npm run benchmark -- validate-revit-requests --input ${commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__")}`;
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function livePreflightCommand(filledOutputPath: string | undefined): string {
  const inputPath = commandPath(filledOutputPath, "__FILL_FILLED_OVERRIDE_PATH__");
  return `$env:OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON=${powershellSingleQuoted(inputPath)}; npm run benchmark -- preflight-revit`;
}

function evidenceHintForPlaceholder(placeholderPath: string): string {
  const path = placeholderPath.replace(/\[\d+\]/g, "[]");
  if (path === "request.viewId" || path === "request.visualViewId" || path.endsWith(".viewId")) {
    return "Confirm the exact target Revit view or sheet id from live model discovery, then capture that same view for the visual gate.";
  }
  if (path.includes("roomNumber") || path.includes("roomName") || path.includes("spaceNumber") || path.includes("spaceName") || path.includes("targetRoom") || path.includes("targetSpace")) {
    return "Resolve the target room or space from live model room/space tags, visible boundaries, and nearby redline anchors before projecting route geometry.";
  }
  if (path.includes("hostElementId") || path.includes("mainElementId") || path.includes("sourceElementId")) {
    return "Use live Revit element discovery/readback to select the real host or main MEP element; do not infer it from PDF position alone.";
  }
  if (path.includes("projectedTapPoint")) {
    return "Project the reviewed tap mark onto the live main route and verify the tap point is on or near the selected duct or pipe before any branch write.";
  }
  if (path.includes("branchPoints[].") || /branchPoints\[\]\./.test(path) || /branchPoints\[\d+\]\./.test(path)) {
    return "Trace the branch route from the live tap point to the target using at least two model-space points, and dry-run the branch path before apply.";
  }
  if (path.includes("points[].") || path.includes("projectedTapPoint") || path.includes("transitionNormalized") || path.includes("splitPoints[].")) {
    return "Project the reviewed PDF mark into model/view coordinates and verify the projected point against nearby Revit geometry before writing.";
  }
  if (path.includes("sizingScope.elementIds")) {
    return "List the exact live route segments in the marked sizing scope and require per-segment size readback after the write.";
  }
  if (path.includes("sizingScope.region")) {
    return "Describe the bounded live-model sizing region from view/space/element evidence so scoped sizing cannot drift beyond the reviewed mark.";
  }
  if (path.includes("elementIds[]") || path.endsWith(".elementIds")) {
    return "Fill with live-discovered element ids in the affected scope and keep readback evidence for every element that will change.";
  }
  if (path.includes("sizingScope.engineeringSizingBasis")) {
    return "Record the engineering basis from the reviewed redline, such as CFM, requested size, or reviewer notes, before scoped sizing runs.";
  }
  if (path.includes("upstreamDuctSize") || path.includes("downstreamDuctSize") || path.includes("upstreamPipeSize") || path.includes("downstreamPipeSize")) {
    return "Capture existing upstream/downstream size readback from Revit and compare it with the requested redline size after execution.";
  }
  if (path.includes("branchSize") || path.includes("pipeSize") || path.includes("ductSize")) {
    return "Fill branch size from reviewed redline intent plus live system compatibility, then require created branch size readback.";
  }
  if (path.includes("transitionChainageFt")) {
    return "Compute the transition chainage from live route geometry and the projected redline point; keep projection/readback evidence before sizing.";
  }
  if (path.includes("offsetVector")) {
    return "Derive the offset/drop vector from live split points, elevation/clearance notes, and route direction; require dry-run geometry to match before apply.";
  }
  if (path.includes("offsetMode")) {
    return "Choose the offset mode only after dry-run geometry confirms the intended dogleg, 45-degree offset, vertical drop, or rise behavior.";
  }
  if (path.includes("preserveConnectedEndpoints")) {
    return "Set endpoint preservation from dry-run/readback evidence showing whether existing connected endpoints remain connected after the reroute.";
  }
  if (path.includes("expectedFitting")) {
    return "Specify the fitting/takeoff/reducer expectation only after checking the target system/type can create that fitting in Revit.";
  }
  if (path.includes("connectionMode")) {
    return "Choose tee/tap/takeoff connection mode only after dry-run reports the viable routing preference and connection plan for the selected main.";
  }
  if (path.includes("fittingTypeId")) {
    return "Resolve a compatible tee/tap/takeoff fitting type from the live system and require fitting id/readback in connection attempts after apply.";
  }
  if (path.includes("systemType")) {
    return "Select the branch system type from the live main route or target system readback; do not mix duct/pipe systems from PDF text alone.";
  }
  if (path.includes("levelName") || path.includes("levelId")) {
    return "Use live level/elevation readback for the main and branch target so the branch is created on the intended plane or elevation.";
  }
  if (path.includes("tag.elementIds") || path.includes("tag.typeId") || path.includes("tag.value")) {
    return "Select a live taggable element and compatible tag type, then verify tag creation or value readback in the target view.";
  }
  if (path.includes("textNote.")) {
    return "Use the reviewed text value and live target view coordinates, then require text-note id/readback plus focused capture.";
  }
  if (path.includes("sourceTypeGrounding.expectedCurrentTypeId")) {
    return "Read the selected live source element's current type id with a no-write type-change dry-run or parameter readback, then require the same id before apply.";
  }
  if (path.includes("sourceTypeGrounding.expectedCurrentTypeName")) {
    return "Read the selected live source element's current type name and keep it as grounding evidence so the row cannot apply to the wrong existing type.";
  }
  if (path.includes("dryRunPreflightReviewed")) {
    return "Set true only after a no-write `/revit/change-element-type` dry-run confirms the selected element and requested target type can be changed.";
  }
  if (path.includes("targetTypeCompatibilityReviewed")) {
    return "Set true only after reviewing live target-type compatibility evidence for the selected element, including rejected alternatives if any were tested.";
  }
  if (path.includes("targetTypeId")) {
    return "Resolve the exact live target type id with `/revit/list-element-types`, then verify compatibility against the selected element with a no-write type-change dry-run.";
  }
  if (path.includes("familyInstance.") || path.includes("symbolName") || path.includes("symbolId")) {
    return "Resolve the exact live family/type/symbol id from the model and verify it is compatible with the selected element or placement.";
  }
  if (path.includes("linkedModelCategoryVisibility.")) {
    return "Use Revit linked-model/category readback and keep requested-vs-applied evidence; do not claim the linked target changed without API proof.";
  }
  if (path.includes("cadLink.sourcePath")) {
    return "Verify the exact CAD source path exists, then dry-run CAD sheet placement and require owner view id, viewport-on-sheet, sheet-sized viewport box, and elementBoundingBoxInOwnerView evidence before apply.";
  }
  if (path.includes("cadLink.sheet") || path.includes("cadLink.sheetId") || path.includes("cadLink.sheetNumber")) {
    return "Resolve the target sheet from live sheet/view discovery and require the CAD owner view to be placed as a viewport on that sheet with owner-view element bounding-box readback.";
  }
  if (path.includes("cadGraphicsOverride.cadImportOrLinkId")) {
    return "Use CAD link/import readback to fill the applied CAD element id, then verify the owner view, owner-view element bounding box, and sheet viewport before any CAD graphics override.";
  }
  if (path.includes("cadGraphicsOverride.categoryName") || path.includes("cadGraphicsOverride.layerName") || path.includes("cadGraphicsOverride.layerOrSubcategoryName")) {
    return "Select a CAD layer/subcategory from live CAD category readback; do not infer the layer from PDF text alone.";
  }
  if (path.includes("cadGraphicsOverride.lineWeight") || path.includes("cadGraphicsOverride.lineweight")) {
    return "Fill the requested CAD layer lineweight from the reviewed mark and require visibility readback proving the applied layer override matches it.";
  }
  if (path.includes("categoryVisibility.") || path.includes("filterVisibility.") || path.includes("viewTemplate") || path.includes("phaseVisibility.")) {
    return "Verify the live view/category/filter/template/phase target and capture graphics or phase readback after applying the override.";
  }
  if (path.includes("cadLink.") || path.includes("cadGraphicsOverride.")) {
    return "Resolve CAD source, owner view, owner-view element bounding box, sheet viewport placement, layer/subcategory, graphics override readback, and sheet-targeted capture evidence before promotion.";
  }
  if (path.includes("cleanup") || path.includes("revert")) {
    return "Define the cleanup or revert strategy before writing so benchmark teardown can prove the model returned to the expected state.";
  }
  return "Replace with verified live Revit context and keep matching readback or visual evidence before promotion.";
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

export function readOnlyDiscoveryActionsForRow(row: Pick<CorpusTemplateRowSummary, "placeholder_paths" | "missing_live_inputs" | "evidence_requirements" | "review_source">): string[] {
  const placeholders = new Set(row.placeholder_paths);
  const missing = new Set(row.missing_live_inputs);
  const evidence = new Set(row.evidence_requirements);
  const has = (pattern: RegExp) => [...placeholders].some((entry) => pattern.test(entry));
  const actions: string[] = [];
  const add = (action: string) => {
    if (!actions.includes(action)) actions.push(action);
  };

  if (missing.has("open_revit_model")) {
    add("GET /revit/context and verify active_document_name/path match the reviewed corpus source model before filling row values or promoting live readiness.");
    add("If the intended RVT is not already open, locate the matching project RVT and use POST /revit/open-model body={\"filePath\":\"<verified matching RVT path>\",\"audit\":false,\"detach\":false} only after confirming it is the intended project model; do not substitute non-equivalent sample models for corpus executability.");
  }

  if (
    has(/viewId|visualViewId|roomNumber|roomName|spaceNumber|spaceName|targetRoom|targetSpace|hostElementId|mainElementId|sourceElementId|elementIds|points|projectedTapPoint|splitPoints|branchPoints|offsetVector|transitionNormalized|transitionChainageFt|tag\.|textNote\.|familyInstance\.|targetTypeId|symbolName|categoryVisibility|filterVisibility|linkedModelCategoryVisibility|cadLink|cadGraphicsOverride/) ||
    missing.has("target_view_or_sheet_id") ||
    missing.has("view_id") ||
    missing.has("target_room_or_space") ||
    missing.has("host_route_element_id")
  ) {
    add("POST /revit/export-visible-elements body={\"viewId\":\"<filled request.viewId>\",\"includeGeometry\":true,\"includeRooms\":true,\"includeMep\":true}");
  }
  if (
    has(/roomNumber|roomName|spaceNumber|spaceName|targetRoom|targetSpace/) ||
    missing.has("target_room_or_space")
  ) {
    add("POST /revit/rooms body={\"viewId\":\"<filled request.viewId>\",\"roomNumber\":\"<candidate room or space number>\"}");
  }
  if (
    has(/mainElementId|hostElementId|sizingScope\.elementIds|projectedTapPoint|branchPoints|transitionNormalized|transitionChainageFt/) &&
    (has(/ductSize|DuctSize/) || missing.has("main_route_element_id") || missing.has("host_route_element_id") || missing.has("selected_branch_size"))
  ) {
    add("POST /revit/ducts-by-spatial-scope body={\"roomNumber\":\"<verified room or space number>\",\"levelName\":\"<verified level>\",\"roomMode\":\"auto\",\"verticalScope\":\"room+plenum\",\"includeCategories\":[\"Ducts\",\"Duct Fittings\",\"Air Terminals\"],\"max\":50} (do not pass rectangular sizes like 12x10 as sizeFrom; use sizeFrom only for round diameter filters such as 8\\\")");
  }
  if (
    has(/hostElementId|mainElementId|sizingScope\.elementIds|splitPoints|projectedTapPoint|branchPoints|transitionNormalized|transitionChainageFt|upstream|downstream|fittingTypeId|expectedFitting|connectionMode|offsetMode|preserveConnectedEndpoints/) ||
    evidence.has("connector_network_audit") ||
    evidence.has("fitting_readback") ||
    evidence.has("per_segment_size_readback") ||
    missing.has("connector_network_audit")
  ) {
    add("POST /revit/get-connectors body={\"elementIds\":[\"<candidate route element ids>\"]}");
    add("POST /revit/trace-connected-network body={\"startElementId\":\"<selected host/main route element id>\",\"maxDepth\":6}");
  }
  const tapTopologyFacts = reviewedTapTopologyFacts(row.review_source);
  if (tapTopologyFacts) {
    add(`VERIFY reviewed tap topology facts against live geometry and connector readback: ${tapTopologyFacts}`);
  }
  const sizingFacts = reviewedSizingFacts(row.review_source);
  if (sizingFacts) {
    add(`VERIFY reviewed sizing facts against live route segment scope, engineering basis, and per-segment readback: ${sizingFacts}`);
  }
  const accessoryFacts = reviewedAccessoryFacts(row.review_source);
  if (accessoryFacts) {
    add(`VERIFY reviewed accessory facts against live family/symbol compatibility, placement host, model-write readback, visual gate, and cleanup proof: ${accessoryFacts}`);
  }
  const tagFacts = reviewedTagFacts(row.review_source);
  if (tagFacts) {
    add(`VERIFY reviewed tag facts against live taggable element ids, tag type/value readback, focused capture, visual gate, and cleanup proof: ${tagFacts}`);
  }
  const typeFacts = reviewedTypeFacts(row.review_source);
  const hasTypeChangePlaceholders = has(/targetTypeId|targetTypeName|sourceTypeGrounding|dryRunPreflightReviewed|targetTypeCompatibilityReviewed/)
    || missing.has("source_duct_element_id")
    || missing.has("compatible_round_duct_type_id")
    || missing.has("type_readback")
    || missing.has("revert_verification");
  if (typeFacts || hasTypeChangePlaceholders) {
    add("POST /revit/export-visible-elements body={\"viewId\":\"<filled request.viewId>\",\"includeGeometry\":true,\"includeMep\":true,\"includeParameters\":true} and select the exact source element id from visible model evidence.");
    add("POST /revit/get-parameters body={\"elementIds\":[\"<selected source element id>\"],\"includeType\":true} and record the current source type id/name before any dry-run.");
    add("GET /revit/list-element-types?category=<source duct/accessory/device category> and select the live target type id matching the reviewed requested type.");
    add("POST /revit/change-element-type body={\"elementIds\":[\"<filled request.elementIds[0]>\"],\"targetTypeId\":\"<candidate target type id>\",\"dryRun\":true} to prove source current type and target compatibility before any apply.");
    add("POST /revit/change-element-type body={\"elementIds\":[\"<filled request.elementIds[0]>\"],\"targetTypeId\":\"<verified original type id>\",\"dryRun\":true} after target dry-run to prove revert compatibility before any apply.");
    if (typeFacts) {
      add(`VERIFY reviewed type facts against live source element, compatible target type id, requested type readback, focused capture, and revert proof: ${typeFacts}`);
    } else {
      add("VERIFY type-change source and target grounding against live source element, compatible target type id, requested type readback, focused capture, and revert proof before promotion.");
    }
  }
  if (has(/categoryVisibility|filterVisibility|viewTemplate|phaseVisibility|linkedModelCategoryVisibility|cadLink|cadGraphicsOverride/) || evidence.has("graphics_readback")) {
    add("POST /revit/state-snapshot body={\"viewId\":\"<filled request.viewId>\",\"includeVisibility\":true,\"includeLinks\":true}");
  }
  if (has(/categoryVisibility/) || missing.has("category_graphics_readback") || missing.has("requested_category_graphics_override")) {
    add("POST /revit/visibility body={\"viewId\":\"<filled request.viewId>\",\"action\":\"set_category_override\",\"categoryName\":\"<filled request.categoryVisibility.categoryName>\",\"lineWeight\":\"<filled request.categoryVisibility.lineWeight>\",\"dryRun\":true} and verify the dry-run names the target category and requested graphics before any apply.");
    add("POST /revit/visibility body={\"viewId\":\"<filled request.viewId>\",\"action\":\"clear_category_override\",\"categoryName\":\"<filled request.categoryVisibility.categoryName>\",\"dryRun\":true} after apply proof to verify cleanup/revert is available.");
  }
  if (has(/filterVisibility/) || missing.has("filter_graphics_readback") || missing.has("view_filter_name_or_criteria") || missing.has("requested_filter_graphics_override")) {
    add("POST /revit/visibility body={\"viewId\":\"<filled request.viewId>\",\"action\":\"create_view_filter\",\"filterName\":\"<filled request.filterVisibility.filterName>\",\"categoryName\":\"<filled request.filterVisibility.createFilter.categoryName>\",\"ruleParameterName\":\"<filled request.filterVisibility.createFilter.ruleParameterName>\",\"ruleOperator\":\"<filled request.filterVisibility.createFilter.ruleOperator>\",\"ruleValue\":\"<filled request.filterVisibility.createFilter.ruleValue>\",\"lineWeight\":\"<filled request.filterVisibility.lineWeight>\",\"dryRun\":true} and verify rule parameter storage/value before creating a new filter.");
    add("POST /revit/visibility body={\"viewId\":\"<filled request.viewId>\",\"action\":\"apply_view_filter\",\"filterName\":\"<filled or existing filter name>\",\"filterId\":\"<existing or dry-run-created filter id>\",\"lineWeight\":\"<filled request.filterVisibility.lineWeight>\",\"dryRun\":true} and verify the target filter plus requested graphics before any apply.");
    add("POST /revit/visibility body={\"viewId\":\"<filled request.viewId>\",\"action\":\"clear_filter_override\",\"filterName\":\"<filled or existing filter name>\",\"filterId\":\"<existing or applied filter id>\",\"dryRun\":true} after apply proof to verify cleanup/revert is available.");
  }
  if (has(/cadLink|cadGraphicsOverride/) || missing.has("cad_layer_readback") || missing.has("cad_sheet_placement_readback")) {
    add("POST /revit/link-cad body={\"sheetId\":\"<filled request.sheetId or cadLink.sheetId>\",\"sourcePath\":\"<filled request.cadLink.sourcePath>\",\"dryRun\":true}");
    add("VERIFY CAD link/import apply proof includes elementId, ownerViewId, viewportId, viewportBox, elementBoundingBoxInOwnerView, cadCategories, and requested source/sheet readback before marking runnable.");
    add("POST /revit/visibility body={\"viewId\":\"<CAD owner view id from link-cad readback>\",\"action\":\"set_category_override\",\"categoryName\":\"<filled CAD layer/subcategory>\",\"lineWeight\":\"<requested lineweight>\",\"dryRun\":true}");
  }
  if (evidence.has("visual_gate") || missing.has("post_change_visual_capture")) {
    add("POST /revit/export-image body={\"viewId\":\"<filled request.visualViewId>\",\"cropToVisibleElements\":true}");
  }
  if (has(/cadLink|cadGraphicsOverride/) || missing.has("cad_sheet_capture")) {
    add("POST /revit/export-image body={\"viewId\":\"<filled sheet view id>\",\"cropToVisibleElements\":true}");
  }
  return actions;
}

export function renderRedlineCorpusTemplateChecklist(rows: CorpusTemplateRowSummary[], options: RenderChecklistOptions = {}): string {
  const lines = [
    "# Redline Corpus Live Fill Checklist",
    "",
    "Use this checklist to fill verified Revit ids, geometry, readback expectations, visual capture context, and cleanup settings before promoting a corpus row to a runnable live benchmark override.",
    "",
    "| source key | task | operation | target | placeholders | file |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...rows.map((row) => `| ${markdownEscape(row.key)} | ${markdownEscape(row.benchmark_task_id)} | ${markdownEscape(row.operation_class)} | ${markdownEscape(row.target_class)} | ${row.placeholder_count} | ${markdownEscape(row.file_path)} |`)
  ];
  for (const row of rows) {
    const rowBlockerCounts = row.placeholder_blocker_counts ?? blockerCounts(row.placeholder_paths);
    const heading = row.key === row.benchmark_task_id ? row.key : row.benchmark_task_id;
    lines.push(
      "",
      `## ${heading}`,
      "",
      `- Benchmark task: \`${row.benchmark_task_id}\``,
      ...(row.key === row.benchmark_task_id ? [] : [`- Source template key: \`${row.key}\``]),
      `- Operation/target: \`${row.operation_class}\` / \`${row.target_class}\``,
      `- Corpus file: \`${row.file_path}\``,
      `- Review source: \`${formatReviewSource(row.review_source)}\``,
      row.reviewed_fact_summary ? `- Reviewed fact summary: \`${row.reviewed_fact_summary}\`` : "- Reviewed fact summary: _none_",
      `- Placeholder blocker summary: \`${formatBlockerCounts(rowBlockerCounts)}\``,
      `- Text: ${row.text_excerpt || "_No text excerpt._"}`,
      ...(row.live_context_hydration ? [
        `- Live context hydrated: ${row.live_context_hydration.filled_paths?.length ?? 0} path(s)`,
        `- Live context skipped: ${row.live_context_hydration.skipped_placeholders?.length ?? 0} placeholder(s)`
      ] : []),
      "",
      "### Fill These Placeholder Paths",
      "",
      ...(row.placeholder_paths.length > 0 ? row.placeholder_paths.map((entry) => `- \`${entry}\``) : ["- No placeholders remain."]),
      "",
      "### Evidence Hints For Fill Paths",
      "",
      ...(row.placeholder_paths.length > 0 ? row.placeholder_paths.map((entry) => `- \`${entry}\`: ${evidenceHintForPlaceholder(entry)}`) : ["- No placeholder-specific evidence hints needed."]),
      "",
      "### Suggested No-Write Bridge Actions",
      "",
      ...(readOnlyDiscoveryActionsForRow(row).length > 0
        ? readOnlyDiscoveryActionsForRow(row).map((entry) => `- \`${entry}\``)
        : ["- No row-specific read-only bridge actions suggested."]),
      ...(row.live_context_hydration?.skipped_placeholders?.length ? [
        "",
        "### Live Context Hydration Skips",
        "",
        ...row.live_context_hydration.skipped_placeholders.map((entry) => `- \`${entry.path}\`: ${entry.reason}`)
      ] : []),
      "",
      "### Missing Live Inputs",
      "",
      ...(row.missing_live_inputs.length > 0 ? row.missing_live_inputs.map((entry) => `- \`${entry}\``) : ["- No missing live inputs recorded."]),
      "",
      "### Required Evidence Gates",
      "",
      ...(row.evidence_requirements.length > 0 ? row.evidence_requirements.map((entry) => `- \`${entry}\``) : ["- No evidence requirements recorded."]),
      "",
      "### After Filling",
      "",
      "- Promote the filled row only after every placeholder above is replaced with verified live Revit context:",
      `  \`${promotionCommand(options.templatePath, row.key, options.filledOutputPath)}\``,
      "- Validate the filled override before any live apply:",
      `  \`${validateCommand(options.filledOutputPath)}\``,
      "- Preflight the live Revit bridge and required endpoints before any live apply:",
      `  \`${livePreflightCommand(options.filledOutputPath)}\``,
      "- Do not run a live benchmark unless validation reports `placeholder_count: 0`, preflight passes, and the evidence gates above are covered by the request."
    );
  }
  return `${lines.join("\n")}\n`;
}

export function promoteRedlineCorpusTemplateRow(options: PromoteCorpusTemplateOptions): JsonMap {
  return promoteRedlineCorpusTemplateRows({
    templatePath: options.templatePath,
    keys: [options.key],
    outputPath: options.outputPath,
    allowPlaceholders: options.allowPlaceholders,
    allowUnknownTasks: options.allowUnknownTasks
  });
}

export function promoteRedlineCorpusTemplateRows(options: PromoteCorpusTemplateRowsOptions): JsonMap {
  const templatePath = path.resolve(options.templatePath);
  const outputPath = path.resolve(options.outputPath);
  const root = readJsonFile<unknown>(templatePath);
  const rootObj = asObject(root);
  const tasks = asObject(rootObj.tasks);
  const knownTaskIds = new Set(loadBenchmarkTasks().map((task) => task.task_id));
  const outputTasks: Record<string, unknown> = {};
  let placeholderCount = 0;
  for (const key of options.keys) {
    const row = templateRowForKey(tasks, key);
    const benchmarkTaskId = canonicalBenchmarkTaskId(row, key);
    if (!benchmarkTaskId) throw new Error(`Corpus template row ${key} does not specify benchmark_task_id.`);
    if (!options.allowUnknownTasks && !knownTaskIds.has(benchmarkTaskId)) {
      const nearby = [...knownTaskIds].filter((taskId) => taskId.includes(benchmarkTaskId) || benchmarkTaskId.includes(taskId)).slice(0, 8);
      throw new Error([
        `Corpus template row ${key} maps to unknown benchmark task ${benchmarkTaskId}.`,
        "Add a benchmark task first or pass --allow-unknown-tasks for planning-only output.",
        ...(nearby.length > 0 ? [`Nearby task ids: ${nearby.join(", ")}`] : [])
      ].join(" "));
    }
    if (outputTasks[benchmarkTaskId]) throw new Error(`Multiple selected rows map to benchmark task ${benchmarkTaskId}; promote these corpus rows one at a time.`);
    const request = asObject(row.request);
    if (Object.keys(request).length === 0) throw new Error(`Corpus template row ${key} does not contain a request object.`);

    const placeholderPaths = findBenchmarkOverridePlaceholders(request, "request");
    placeholderCount += placeholderPaths.length;
    if (!options.allowPlaceholders && placeholderPaths.length > 0) {
      throw new Error(`Corpus template row ${key} still has placeholders: ${placeholderPaths.slice(0, 12).join(", ")}`);
    }
    outputTasks[benchmarkTaskId] = {
      request,
      corpus_source: row.corpus_source ?? {},
      source_template_key: key
    };
  }

  const promoted = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_template: templatePath,
    source_template_keys: options.keys,
    source_template_key: options.keys.length === 1 ? options.keys[0] : undefined,
    source_batch: sourceBatchProvenance(rootObj),
    ready_to_run: placeholderCount === 0,
    placeholder_count: placeholderCount,
    tasks: outputTasks
  };
  if (placeholderCount === 0) assertRunnableRevitWorkflowOverride(promoted, outputPath);
  writeJsonFile(outputPath, promoted);
  return promoted;
}

export function validateRedlineCorpusTemplateRows(options: ValidateCorpusTemplateRowsOptions): CorpusTemplateValidationResult {
  const templatePath = path.resolve(options.templatePath);
  const root = readJsonFile<unknown>(templatePath);
  const tasks = asObject(asObject(root).tasks);
  const knownTaskIds = new Set(loadBenchmarkTasks().map((task) => task.task_id));
  const benchmarkTaskCounts = new Map<string, number>();
  for (const key of options.keys) {
    const row = templateRowForKey(tasks, key);
    const benchmarkTaskId = canonicalBenchmarkTaskId(row, key);
    if (benchmarkTaskId) benchmarkTaskCounts.set(benchmarkTaskId, (benchmarkTaskCounts.get(benchmarkTaskId) ?? 0) + 1);
  }
  const rows: CorpusTemplateRowValidation[] = [];
  let placeholderCount = 0;

  for (const key of options.keys) {
    const row = templateRowForKey(tasks, key);
    const source = asObject(row.corpus_source);
    const request = asObject(row.request);
    const benchmarkTaskId = canonicalBenchmarkTaskId(row, key);
    const placeholderPaths = findBenchmarkOverridePlaceholders(request, "request");
    const missingLiveInputs = Array.isArray(source.missing_live_inputs) ? source.missing_live_inputs.map(String) : [];
    const evidenceRequirements = Array.isArray(source.evidence_requirements) ? source.evidence_requirements.map(String) : [];
    const unknownBenchmarkTask = !benchmarkTaskId || !knownTaskIds.has(benchmarkTaskId);
    const blockingReasons = [
      ...(Object.keys(request).length === 0 ? ["request object is missing"] : []),
      ...(placeholderPaths.length > 0 ? [`${placeholderPaths.length} placeholder path(s) remain`] : []),
      ...((benchmarkTaskCounts.get(benchmarkTaskId) ?? 0) > 1 ? [`duplicate benchmark task selected: ${benchmarkTaskId}`] : []),
      ...(!options.allowUnknownTasks && unknownBenchmarkTask ? [`unknown benchmark task: ${benchmarkTaskId || "(blank)"}`] : [])
    ];
    if (blockingReasons.length === 0) {
      try {
        assertRunnableRevitWorkflowOverride({
          schema_version: 1,
          ready_to_run: true,
          placeholder_count: 0,
          tasks: {
            [benchmarkTaskId]: {
              request,
              corpus_source: row.corpus_source ?? {},
              source_template_key: key
            }
          }
        }, `${templatePath}#${key}`);
      } catch (error) {
        blockingReasons.push(`request validation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    placeholderCount += placeholderPaths.length;
    rows.push({
      key,
      benchmark_task_id: benchmarkTaskId || key,
      operation_class: String(source.operation_class ?? ""),
      target_class: String(source.target_class ?? ""),
      file_path: String(source.file_path ?? ""),
      placeholder_count: placeholderPaths.length,
      placeholder_paths: placeholderPaths,
      missing_live_inputs: missingLiveInputs,
      evidence_requirements: evidenceRequirements,
      text_excerpt: String(source.text_excerpt ?? ""),
      ready_to_promote: blockingReasons.length === 0,
      unknown_benchmark_task: unknownBenchmarkTask,
      blocking_reasons: blockingReasons,
      promotion_command: promotionCommand(options.templatePath, key, options.filledOutputPath),
      validate_command: validateCommand(options.filledOutputPath)
    });
  }

  const readyToPromote = rows.length > 0 && rows.every((row) => row.ready_to_promote);
  return {
    ok: readyToPromote,
    template: templatePath,
    source_batch: sourceBatchProvenance(asObject(root)),
    ready_to_promote: readyToPromote,
    row_count: rows.length,
    placeholder_count: placeholderCount,
    rows
  };
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const templatePath = flagValue(process.argv, "--template");
  if (process.argv.includes("--list")) {
    if (!templatePath) {
      console.error("Usage: npm run redline:promote-live-template -- --template <redline_corpus_live_request_template.json> --list [--operation text_edit] [--target schedule] [--task demo_documentation_primitives] [--contains value] [--limit 50] [--format markdown] [--output checklist.md]");
      process.exit(2);
    }
    if (!fs.existsSync(path.resolve(templatePath))) throw new Error(`Template file not found: ${templatePath}`);
    const limitRaw = flagValue(process.argv, "--limit");
    const rows = listRedlineCorpusTemplateRows({
      templatePath,
      operation: flagValue(process.argv, "--operation"),
      target: flagValue(process.argv, "--target"),
      task: flagValue(process.argv, "--task"),
      contains: flagValue(process.argv, "--contains"),
      limit: limitRaw ? Number(limitRaw) : undefined
    });
    const outputPath = flagValue(process.argv, "--output");
    const format = flagValue(process.argv, "--format")?.toLowerCase();
    if (format === "markdown" || process.argv.includes("--checklist")) {
      const markdown = renderRedlineCorpusTemplateChecklist(rows, {
        templatePath,
        filledOutputPath: flagValue(process.argv, "--filled-output")
      });
      if (outputPath) {
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(path.resolve(outputPath), markdown, "utf8");
        console.log(JSON.stringify({ ok: true, count: rows.length, output: path.resolve(outputPath) }, null, 2));
      } else {
        console.log(markdown);
      }
      return;
    }
    console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
    return;
  }
  const key = flagValue(process.argv, "--key");
  const keysRaw = flagValue(process.argv, "--keys");
  const outputPath = flagValue(process.argv, "--output");
  const keys = keysRaw ? keysRaw.split(",").map((entry) => entry.trim()).filter(Boolean) : (key ? [key] : []);
  if (process.argv.includes("--validate-filled")) {
    if (!templatePath || keys.length === 0) {
      console.error("Usage: npm run redline:promote-live-template -- --template <template.json> --validate-filled --key <template-task-key> [--filled-output filled-live-override.json] [--allow-unknown-tasks]");
      process.exit(2);
    }
    if (!fs.existsSync(path.resolve(templatePath))) throw new Error(`Template file not found: ${templatePath}`);
    const validation = validateRedlineCorpusTemplateRows({
      templatePath,
      keys,
      filledOutputPath: flagValue(process.argv, "--filled-output") ?? outputPath,
      allowUnknownTasks: process.argv.includes("--allow-unknown-tasks")
    });
    console.log(JSON.stringify(validation, null, 2));
    if (!validation.ready_to_promote) process.exit(1);
    return;
  }
  if (!templatePath || keys.length === 0 || !outputPath) {
    console.error("Usage: npm run redline:promote-live-template -- --template <redline_corpus_live_request_template.json> --key <template-task-key> --output <filled-live-override.json> [--allow-placeholders] [--allow-unknown-tasks]\n       npm run redline:promote-live-template -- --template <template.json> --keys <key1,key2> --output <filled-live-override.json>\n       npm run redline:promote-live-template -- --template <template.json> --validate-filled --key <template-task-key> [--filled-output filled-live-override.json]");
    process.exit(2);
  }
  if (!fs.existsSync(path.resolve(templatePath))) throw new Error(`Template file not found: ${templatePath}`);
  const promoted = promoteRedlineCorpusTemplateRows({
    templatePath,
    keys,
    outputPath,
    allowPlaceholders: process.argv.includes("--allow-placeholders"),
    allowUnknownTasks: process.argv.includes("--allow-unknown-tasks")
  });
  console.log(JSON.stringify({
    ok: true,
    output: path.resolve(outputPath),
    task_ids: Object.keys(asObject(promoted.tasks)),
    placeholder_count: promoted.placeholder_count,
    ready_to_run: promoted.ready_to_run
  }, null, 2));
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
