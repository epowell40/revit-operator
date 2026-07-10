import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonFile, writeTextFile } from "../benchmark/files.js";
import { analyzeRedlineFile, type RedlineAnalyzeResponse } from "./redline_analyzer.js";

export type RedlineOperationClass =
  | "add"
  | "delete"
  | "move"
  | "rotate"
  | "text_edit"
  | "tag"
  | "type_change"
  | "graphics_override"
  | "route"
  | "tap_branch"
  | "reroute_offset"
  | "size_transition"
  | "resize"
  | "parameter_edit"
  | "unknown";

export type RedlineTargetClass =
  | "text"
  | "tag"
  | "model_parameter"
  | "receptacle"
  | "light"
  | "duct"
  | "pipe"
  | "mep_accessory"
  | "family_instance"
  | "cad_link"
  | "view_filter"
  | "view_template"
  | "category_graphics"
  | "schedule"
  | "sheet"
  | "unknown";

export type RedlineContextClass = "host_model" | "linked_model" | "cad_import" | "annotation" | "view" | "template" | "schedule" | "sheet" | "unknown";

export type RedlineEvidenceRequirement =
  | "model_write"
  | "visual_gate"
  | "delete_effect_ids"
  | "move_effect_ids"
  | "type_readback"
  | "fitting_readback"
  | "connector_network_audit"
  | "projection_readback"
  | "graphics_readback"
  | "cad_source_target_readback"
  | "schedule_readback"
  | "parameter_readback"
  | "annotation_inventory"
  | "sizing_scope_readback"
  | "per_segment_size_readback"
  | "cleanup_effect_ids";

export type RedlineCorpusSourceKind = "sidecar_text" | "sidecar_json" | "analyzer" | "filename";

export type RedlineCorpusInput = {
  file_path: string;
  text?: string;
  operation_class?: RedlineOperationClass;
  target_class?: RedlineTargetClass;
  context_class?: RedlineContextClass;
};

export type RedlineCorpusClassification = {
  file_path: string;
  sidecar_path?: string;
  operation_class: RedlineOperationClass;
  target_class: RedlineTargetClass;
  context_class: RedlineContextClass;
  modeled_mep: boolean;
  requires_model_write: boolean;
  requires_visual_gate: boolean;
  evidence_requirements: RedlineEvidenceRequirement[];
  recommended_benchmark_tasks: string[];
  source_kind: RedlineCorpusSourceKind;
  matched_rules: string[];
  confidence: number;
  manual_review_reason?: string;
  text_excerpt: string;
};

export type RedlineCorpusBenchmarkQueueItem = {
  task_id: string;
  file_path: string;
  operation_class: RedlineOperationClass;
  target_class: RedlineTargetClass;
  context_class: RedlineContextClass;
  requires_model_write: boolean;
  requires_visual_gate: boolean;
  evidence_requirements: RedlineEvidenceRequirement[];
  missing_live_inputs: string[];
  live_request_status: "needs_live_request_override";
  confidence: number;
  text_excerpt: string;
};

export type RedlineCorpusLiveOverrideTemplateTask = {
  benchmark_task_id: string;
  request: Record<string, unknown>;
  ready_to_run: false;
  placeholder_paths: string[];
  corpus_source: {
    file_path: string;
    operation_class: RedlineOperationClass;
    target_class: RedlineTargetClass;
    context_class: RedlineContextClass;
    confidence: number;
    missing_live_inputs: string[];
    requires_model_write: boolean;
    requires_visual_gate: boolean;
    evidence_requirements: RedlineEvidenceRequirement[];
    text_excerpt: string;
  };
};

export type RedlineCorpusLiveOverrideTemplate = {
  schema_version: 1;
  generated_at: string;
  source_dir?: string;
  status: "template_requires_verified_revit_ids";
  ready_to_run: false;
  placeholder_count: number;
  placeholder_task_count: number;
  instructions: string[];
  tasks: Record<string, RedlineCorpusLiveOverrideTemplateTask>;
};

export type RedlineCorpusReport = {
  schema_version: 1;
  generated_at: string;
  source_dir?: string;
  input_count: number;
  classified_count: number;
  by_operation: Record<string, number>;
  by_target: Record<string, number>;
  by_context: Record<string, number>;
  by_evidence_requirement: Record<string, number>;
  by_model_write_requirement: Record<"required" | "not_required", number>;
  by_visual_gate_requirement: Record<"required" | "not_required", number>;
  manual_review_count: number;
  manual_review_items: RedlineCorpusClassification[];
  by_recommended_task: Record<string, number>;
  live_benchmark_queue: RedlineCorpusBenchmarkQueueItem[];
  items: RedlineCorpusClassification[];
};

export type RedlineCorpusReportPaths = {
  jsonPath: string;
  csvPath: string;
  queueJsonPath: string;
  queueCsvPath: string;
  liveOverrideTemplatePath: string;
  reviewMarkdownPath: string;
};

export type RedlineCorpusAnalyzeOptions = {
  useAnalyzer?: boolean;
  maxPages?: number;
  timeoutMs?: number;
};

type Rule = {
  name: string;
  pattern: RegExp;
};

const OPERATION_RULES: Array<{ value: RedlineOperationClass; rules: Rule[] }> = [
  { value: "delete", rules: [{ name: "operation.delete", pattern: /\b(delete|remove|demo|demolish|omit|take\s*out)\b/i }] },
  { value: "move", rules: [{ name: "operation.move", pattern: /\b(move|shift|relocate|slide|align\s+with|center\s+on)\b/i }] },
  { value: "rotate", rules: [{ name: "operation.rotate", pattern: /\b(rotate|turn|flip)\b/i }] },
  { value: "tap_branch", rules: [{ name: "operation.tap_branch", pattern: /\b(tap|tap\s+out|take\s*off|branch|tee\s+off|connect\s+to\s+(?:main|existing)|top\s+of\s+(?:pipe|duct)|racked|rack)\b/i }] },
  { value: "reroute_offset", rules: [{ name: "operation.reroute_offset", pattern: /\b(reroute|re-route|offset|drop|rise|raise|lower|dogleg|45\s*(?:deg|degree)|go\s+around)\b/i }] },
  { value: "size_transition", rules: [{ name: "operation.size_transition", pattern: /\b(?:transition|reducer|increaser)\b|\b(?:resize|size|change|increase|decrease|reduce|make|revise|update)\b.*\b(?:part\s*way|mid\s*run|downstream|upstream|after\s+this\s+point|from\s+\S+\s+to\s+\S+|\d+\s*(?:x|×)\s*\d+|\d+\s*(?:in|inch|\"|dia|ø)|cfm|gpm)\b|\b\d+\s*(?:x|×)\s*\d+\b.*\b(?:cfm|duct|sa|ra|ea|oa)\b/i }] },
  { value: "type_change", rules: [{ name: "operation.type_change", pattern: /\b(change|swap|convert|replace|switch|make)\b.*\b(type|family|designation|round|rectangular|device|fixture|diffuser|grille|register|air\s*device)\b|\brectangular\s+to\s+round\b|\b(?:C|S|R|E|L)\d+\b.*\b(?:diffuser|grille|register|air\s*device|cfm)\b/i }] },
  { value: "route", rules: [{ name: "operation.route", pattern: /\b(route|run|extend|connect|pick\s+up|new\s+(duct|pipe)|draw\s+(duct|pipe))\b/i }] },
  { value: "graphics_override", rules: [{ name: "operation.graphics_override", pattern: /\b(line\s*weight|lineweight|halftone|hidden\s+line|thin|light|future|override|monochrome|color|display|graphic|phase\s+filter|phase\s+mapping|visibility|show|hide)\b/i }] },
  { value: "resize", rules: [{ name: "operation.resize", pattern: /\b(resize|size|increase|decrease|enlarge|reduce)\b/i }] },
  { value: "parameter_edit", rules: [{ name: "operation.parameter_edit", pattern: /\b(parameter|mark|comments?|panel|circuit|tag\s+value|schedule\s+value)\b/i }] },
  { value: "tag", rules: [{ name: "operation.tag", pattern: /\b(label|tag)\s+(?:all|these|this)|\b(?:all|these)\s+(?:sizes|ducts?|pipes?)\s+(?:tagged|labeled|labelled)\b/i }] },
  { value: "text_edit", rules: [{ name: "operation.text_edit", pattern: /\b(change|revise|update|edit|replace|correct)\b.*\b(text|note|wording|label|schedule|cell|row)\b|\bnot\s+used\b/i }] },
  { value: "add", rules: [{ name: "operation.add", pattern: /\b(add|provide|install|place|new|show|tag)\b/i }] }
];

const TARGET_RULES: Array<{ value: RedlineTargetClass; rules: Rule[] }> = [
  { value: "cad_link", rules: [{ name: "target.cad_link", pattern: /\b(cad|dwg|xref|linked\s+cad|import(ed)?\s+cad)\b/i }] },
  { value: "view_filter", rules: [{ name: "target.view_filter", pattern: /\b(view\s+filter|filter)\b|\bdashed\s+lines?\s+for\s+ducts?\b|\bvisibility\s+graphics\b.{0,80}\bdashed\s+lines?\b/i }] },
  { value: "view_template", rules: [{ name: "target.view_template", pattern: /\bview\s+templates?\b|\btemplates?\s+views?\b|\b(?:apply|assign|create|duplicate)\s+(?:the\s+)?(?:view\s+)?templates?\b|\b(?:remove|delete|update|change|edit|override)\s+(?:the\s+)?view\s+templates?\b|\btemplates?\b.{0,60}\b(?:visibility|graphics?|scale|detail\s+level|halftone|line\s*weight|lineweight|override|setting)\b/i }] },
  { value: "category_graphics", rules: [{ name: "target.category_graphics", pattern: /\b(category|line\s*weight|lineweight|hidden\s+line|future\s+work|monochrome|furniture|ada\s+clearance|clearance\s+lines?|plumbing\s+fixtures?|\bFFU'?s?\b)\b/i }] },
  { value: "mep_accessory", rules: [{ name: "target.mep_accessory", pattern: /\b(manual\s+balancing\s+dampers?|balancing\s+dampers?|dampers?|duct\s+accessor(?:y|ies)|pipe\s+accessor(?:y|ies)|air\s*device|diffuser|grille|register)\b/i }] },
  { value: "receptacle", rules: [{ name: "target.receptacle", pattern: /\b(receptacle|outlet|duplex|gfi|gfci)\b/i }] },
  { value: "light", rules: [{ name: "target.light", pattern: /\b(light|lighting|fixture|downlight|luminaire)\b/i }] },
  { value: "duct", rules: [{ name: "target.duct", pattern: /\b(duct|ductwork|supply\s+air|return\s+air|exhaust\s+air|round\s+duct|rectangular\s+duct|\bsa\b|\bra\b|\bea\b|\boa\b)\b/i }] },
  { value: "pipe", rules: [{ name: "target.pipe", pattern: /\b(pipe|piping|domestic\s+(cold|hot)\s+water|sanitary|vent|chw|hhw)\b/i }] },
  { value: "tag", rules: [{ name: "target.tag", pattern: /\b(tag|keynote|room\s+tag|equipment\s+tag)\b/i }] },
  { value: "text", rules: [{ name: "target.text", pattern: /\b(text|note|annotation|label)\b/i }] },
  { value: "schedule", rules: [{ name: "target.schedule", pattern: /\b(schedule|column|field|sort|filter)\b/i }] },
  { value: "sheet", rules: [{ name: "target.sheet", pattern: /\b(sheet|viewport|titleblock|title\s+block)\b/i }] }
];

function firstMatching<T extends string>(text: string, entries: Array<{ value: T; rules: Rule[] }>): { value: T | "unknown"; matched: string[] } {
  for (const entry of entries) {
    const matched = entry.rules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.name);
    if (matched.length > 0) return { value: entry.value, matched };
  }
  return { value: "unknown", matched: [] };
}

function inferMepTargetFromFilePath(filePath: string): { target: "duct" | "pipe" | null; matched: string[] } {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);
  if (/\bduct(?:\s+markup)?\b|\bductwork\b/i.test(basename)) return { target: "duct", matched: ["target.file_context.duct"] };
  if (/\bplumb(?:ing)?\b|\bpipe|piping\b/i.test(basename)) return { target: "pipe", matched: ["target.file_context.pipe"] };
  return { target: null, matched: [] };
}

function refineTextLikeIntent(
  text: string,
  filePath: string,
  operation: RedlineOperationClass | "unknown",
  target: RedlineTargetClass | "unknown",
  matchedRules: string[]
): { operation: RedlineOperationClass | "unknown"; target: RedlineTargetClass | "unknown"; matchedRules: string[] } {
  const matched = [...matchedRules];
  const fileContextTarget = inferMepTargetFromFilePath(filePath);
  const hasRouteVerb = /\b(route|run|extend|connect|pick\s+up|new\s+(?:duct|pipe)|draw\s+(?:duct|pipe))\b/i.test(text);
  const hasTypeSwap = /\b(change|swap|convert|replace)\b.*\b(type|family|device|fixture|diffuser|grille|register|air\s*device|round|rectangular)\b|\b(?:C|S|R|E|L)\d+\b.*\b(?:to|diffuser|grille|register|air\s*device|cfm)\b/i.test(text);
  const hasScheduleCue = /\b(schedule|cell|row|column|header|schedule\s+value|schedule\s+cell)\b/i.test(text);
  const hasTagValueCue = /\b(tag\s+(?:value|text|label)|label\s+text|tagged\s+as)\b/i.test(text);
  const hasTagDirectiveCue = /\b(?:tag|keynote|diamond\s+note)\b/i.test(text);
  const hasMepSizeLabelCue =
    /\b(?:label|tag|show|add)\b.{0,80}\b(?:duct|ductwork|pipe|piping)\b.{0,80}\b(?:sizes?|size\s+labels?|tags?)\b/i.test(text) ||
    /\b(?:label|tag|show|add)\b.{0,80}\b\d{1,3}\s*(?:x|×)\s*\d{1,3}\b.{0,80}\b(?:duct|ductwork|pipe|piping)\b/i.test(text);
  const hasModelParameterCue = /\b(type\s+mark|mark|comments?|panel|circuit|parameter)\b/i.test(text);
  const hasPlainTextCue = /\b(plain\s+text|text\s+note|note\s+wording|general\s+note)\b/i.test(text);
  const hasAddTextNoteCue = /\b(?:add|provide|place|show|create)\b.{0,60}\b(?:plain\s+text|text\s+note|general\s+note|note)\b/i.test(text);
  const hasDeleteTextNoteCue = /\b(?:delete|remove|omit|take\s*out)\b.{0,80}\b(?:plain\s+text|text\s+note|general\s+note|note)\b|\b(?:plain\s+text|text\s+note|general\s+note|note)\b.{0,80}\b(?:delete|remove|omit|take\s*out)\b/i.test(text);
  const hasMepSizeOnlyCue = /\b\d+\s*(?:x|×)\s*\d+\b|\b\d+\s*(?:in|inch|\"|dia|ø)\b|\b\d+\s*cfm\b/i.test(text);
  const hasSizeAllMepCue = /\b(?:size|resize)\s+(?:all|these|this|the)\s+(?:ductwork|ducts?|piping|pipes?)\b|\b(?:ductwork|ducts?|piping|pipes?)\s+(?:need|needs|shall|should)\s+to\s+be\s+(?:sized|resized)\b/i.test(text);
  const hasMepTargetCue = target === "duct" || target === "pipe" || /\b(duct|ductwork|pipe|piping|supply\s+air|return\s+air|exhaust\s+air|\bsa\b|\bra\b|\bea\b|\boa\b)\b/i.test(text);
  const hasExplicitPipeCue = /\b(?:pipe|piping|plumbing|domestic\s+(?:cold|hot)\s+water|sanitary|vent|chw|hhw)\b/i.test(text);
  const hasExplicitDuctCue = /\b(?:duct|ductwork|supply\s+air|return\s+air|exhaust\s+air|\bsa\b|\bra\b|\bea\b|\boa\b)\b/i.test(text);
  const hasDuctTapCue =
    /\b(?:tap|take\s*off|takeoff|branch)\b/i.test(text) &&
    /\b(?:duct|ductwork|supply\s+air|return\s+air|exhaust\s+air|airflow|\bsa\b|\bra\b|\bea\b|\boa\b)\b/i.test(text);
  const hasPipeBranchMainCue =
    /\b(?:branches?|taps?|take\s*offs?|takeoffs?)\s+off\s+(?:the\s+)?main\b/i.test(text) &&
    (target === "pipe" || /\b(?:pipe|piping|plumbing|domestic\s+(?:cold|hot)\s+water|sanitary|vent|chw|hhw)\b/i.test(text));
  const hasCadLinkReloadCue =
    /\b(?:reload(?:ed|ing)?|refresh|update|confirm|verify)\b/i.test(text) &&
    /\b(?:cad\s+files?|cad\s+links?|links?|dwg|xrefs?)\b/i.test(text);
  const hasCadLinkHideCue =
    /\b(?:hide|hidden)\b/i.test(text) &&
    /\b(?:cad\s+link|cad\s+links|cad\s+markers?|cad\s+points?|link\s+markers?|dwg|xref)\b/i.test(text);
  const hasGraphicsCue = operation === "graphics_override" || /\b(line\s*weight|lineweight|halftone|hidden\s+line|thin|light|override|visibility|graphic|dashed)\b/i.test(text);
  const hasPhaseGraphicsCue =
    /\bphase(?:\s+filter|\s+mapping)?|demo\s+work|demolition\s+work|removal\s+view|existing\s+phase|new\s+construction\b/i.test(text) ||
    (hasGraphicsCue && /\b(?:future\s+new\s+work|future\s+work|new\s+work)\b/i.test(text));
  const hasCadLayerGraphicsCue =
    hasGraphicsCue &&
    /\blayers?\b/i.test(text) &&
    /\b(?:line\s*weight|lineweight|lw|override|visibility|hide|show|halftone)\b/i.test(text);
  const hasFfuGraphicsCue = hasGraphicsCue && /\b(?:entire\s+)?FFU'?s?\b/i.test(text);
  const hasFfuHalftoneCue = hasFfuGraphicsCue && /\bhalftone\b/i.test(text);
  const hasContourVisibilityCue =
    /\b(?:contours?|countours?)\b/i.test(text) &&
    (/\b(?:add|show|turn|bring|put|restore)\b.{0,40}\bback\s+in\b/i.test(text) ||
      /\bback\s+in\b.{0,40}\b(?:contours?|countours?)\b/i.test(text));
  const hasOverUnderDuctGraphicsCue =
    hasGraphicsCue &&
    /\bducts?\b/i.test(text) &&
    /\b(?:pass(?:es)?\s+underneath|go\s+over\s+or\s+under|over\s+or\s+under|dashed\s+lines?)\b/i.test(text);
  const hasMepElevationMoveCue =
    (target === "duct" || target === "pipe") &&
    (/\b(?:raise|lower|drop|rise|elevate|move)\b.{0,80}\b(?:duct|ductwork|pipe|piping)\b|\b(?:duct|ductwork|pipe|piping)\b.{0,80}\b(?:raise|lower|drop|rise|elevate|elevation|b\.?o\.?d\.?|bottom\s+of\s+duct|bottom\s+of\s+pipe)\b/i.test(text)) &&
    !/\b(?:offset|reroute|re-route|dogleg|45\s*(?:deg|degree)|go\s+around|under\s+the\s+crossing|around\s+the\s+conflict|split|transition|reducer|tap|take\s*off|takeoff|branch|tee)\b/i.test(text);

  if (hasAddTextNoteCue && !hasTagDirectiveCue) {
    matched.push("intent_refine.add_text_note");
    return { operation: "add", target: "text", matchedRules: unique(matched) };
  }

  if (hasDeleteTextNoteCue && !hasTagDirectiveCue) {
    matched.push("intent_refine.delete_text_note");
    return { operation: "delete", target: "text", matchedRules: unique(matched) };
  }

  if (hasPlainTextCue) {
    matched.push("intent_refine.plain_text");
    return { operation: "text_edit", target: "text", matchedRules: unique(matched) };
  }

  if (hasPhaseGraphicsCue) {
    matched.push("intent_refine.phase_graphics");
    const phaseTarget = ["category_graphics", "view_filter", "view_template", "cad_link"].includes(target) ? target : "category_graphics";
    return { operation: "graphics_override", target: phaseTarget as RedlineTargetClass, matchedRules: unique(matched) };
  }

  if (hasDuctTapCue) {
    matched.push("intent_refine.duct_tap_branch");
    return { operation: "tap_branch", target: "duct", matchedRules: unique(matched) };
  }

  if (operation === "tap_branch" && target === "unknown" && fileContextTarget.target) {
    matched.push(...fileContextTarget.matched);
    matched.push(`intent_refine.${fileContextTarget.target}_tap_branch_from_file_context`);
    return { operation: "tap_branch", target: fileContextTarget.target, matchedRules: unique(matched) };
  }

  if (hasPipeBranchMainCue) {
    matched.push("intent_refine.pipe_branch_main");
    if (/\b\d+\s+branches?\s+off\s+(?:the\s+)?main\b/i.test(text)) matched.push("intent_refine.pipe_branch_count");
    return { operation: "tap_branch", target: "pipe", matchedRules: unique(matched) };
  }

  if (hasCadLinkReloadCue) {
    matched.push("intent_refine.cad_link_reload");
    matched.push("intent_refine.cad_link_target");
    return { operation: "graphics_override", target: "cad_link", matchedRules: unique(matched) };
  }

  if (hasCadLinkHideCue) {
    matched.push("intent_refine.cad_link_hide");
    matched.push("intent_refine.cad_link_target");
    return { operation: "graphics_override", target: "cad_link", matchedRules: unique(matched) };
  }

  if (hasCadLayerGraphicsCue) {
    matched.push("intent_refine.cad_layer_graphics");
    matched.push("intent_refine.cad_link_target");
    return { operation: "graphics_override", target: "cad_link", matchedRules: unique(matched) };
  }

  if (hasFfuHalftoneCue) {
    matched.push("intent_refine.ffu_halftone_view_filter");
    return { operation: "graphics_override", target: "view_filter", matchedRules: unique(matched) };
  }

  if (hasContourVisibilityCue) {
    matched.push("intent_refine.contour_visibility_view_filter");
    matched.push("intent_refine.contour_visibility_target");
    return { operation: "graphics_override", target: "view_filter", matchedRules: unique(matched) };
  }

  if (hasFfuGraphicsCue) {
    matched.push("intent_refine.ffu_category_graphics");
    return { operation: "graphics_override", target: "category_graphics", matchedRules: unique(matched) };
  }

  if (hasOverUnderDuctGraphicsCue) {
    matched.push("intent_refine.over_under_duct_view_filter");
    return { operation: "graphics_override", target: "view_filter", matchedRules: unique(matched) };
  }

  if (hasMepElevationMoveCue) {
    matched.push("intent_refine.mep_elevation_move");
    return { operation: "move", target, matchedRules: unique(matched) };
  }

  if (hasRouteVerb && hasExplicitPipeCue && target !== "duct") {
    matched.push("intent_refine.pipe_route_target_over_fixture");
    return { operation: "route", target: "pipe", matchedRules: unique(matched) };
  }

  if (hasRouteVerb && hasExplicitDuctCue && target !== "pipe") {
    matched.push("intent_refine.duct_route_target_over_fixture");
    return { operation: "route", target: "duct", matchedRules: unique(matched) };
  }

  if (hasRouteVerb && (target === "duct" || target === "pipe")) {
    matched.push("intent_refine.route_over_size");
    return { operation: "route", target, matchedRules: unique(matched) };
  }

  if (hasScheduleCue) {
    matched.push("intent_refine.schedule_text");
    return { operation: "text_edit", target: "schedule", matchedRules: unique(matched) };
  }

  if (hasTagValueCue) {
    matched.push("intent_refine.tag_text");
    return { operation: "text_edit", target: "tag", matchedRules: unique(matched) };
  }

  if (hasMepSizeLabelCue && !hasTypeSwap) {
    matched.push("intent_refine.mep_size_label_tag");
    return { operation: "tag", target: "tag", matchedRules: unique(matched) };
  }

  if (hasTagDirectiveCue && !hasTypeSwap) {
    matched.push("intent_refine.tag_directive");
    const refinedOperation = /\b(?:delete|remove|take\s+out|omit)\b/i.test(text)
      ? "delete"
      : /\b(?:move|shift|relocate)\b/i.test(text)
        ? "move"
        : /\b(?:add|provide|place|show|new)\b/i.test(text)
          ? "add"
          : "tag";
    return { operation: refinedOperation, target: "tag", matchedRules: unique(matched) };
  }

  if (hasModelParameterCue && target === "mep_accessory" && !hasScheduleCue && !hasTagValueCue && !hasTypeSwap) {
    matched.push("intent_refine.mep_accessory_parameter");
    return { operation: "parameter_edit", target: "mep_accessory", matchedRules: unique(matched) };
  }

  if (hasModelParameterCue && !hasScheduleCue && !hasTagValueCue && !hasTypeSwap) {
    matched.push("intent_refine.model_parameter");
    return { operation: "parameter_edit", target: "model_parameter", matchedRules: unique(matched) };
  }

  if (hasModelParameterCue && /\b(type\s+mark|comments?|panel|circuit|parameter)\b/i.test(text) && !hasScheduleCue && !hasTagValueCue && !/\b(family|device|fixture|diffuser|grille|register|air\s*device|round|rectangular)\b/i.test(text)) {
    matched.push("intent_refine.model_parameter_over_type_word");
    return { operation: "parameter_edit", target: "model_parameter", matchedRules: unique(matched) };
  }

  if (hasTypeSwap && !["category_graphics", "view_filter", "view_template", "cad_link"].includes(target)) {
    matched.push("intent_refine.type_change_over_size");
    const refinedTarget = /\b(diffuser|grille|register|air\s*device|device|fixture)\b/i.test(text) ? "mep_accessory" : target;
    return { operation: "type_change", target: refinedTarget as RedlineTargetClass | "unknown", matchedRules: unique(matched) };
  }

  if (hasSizeAllMepCue && hasMepTargetCue && !/\b(label|tag)\b/i.test(text)) {
    matched.push("intent_refine.size_all_mep");
    const refinedTarget = /\b(pipe|piping)\b/i.test(text) ? "pipe" : target;
    return { operation: "size_transition", target: refinedTarget as RedlineTargetClass | "unknown", matchedRules: unique(matched) };
  }

  if (hasMepSizeOnlyCue && hasMepTargetCue && !hasScheduleCue && !hasTagValueCue && !hasModelParameterCue) {
    matched.push("intent_refine.mep_size_only");
    return { operation: "size_transition", target, matchedRules: unique(matched) };
  }

  return { operation, target, matchedRules: unique(matched) };
}

function inferContext(text: string, target: RedlineTargetClass): { value: RedlineContextClass; matched: string[] } {
  if (/\b(linked\s+model|revit\s+link|architectural\s+link|linked\s+arch|xref)\b/i.test(text)) return { value: "linked_model", matched: ["context.linked_model"] };
  if (target === "cad_link" || /\b(cad|dwg|xref)\b/i.test(text)) return { value: "cad_import", matched: ["context.cad_import"] };
  if (target === "view_template") return { value: "template", matched: ["context.template"] };
  if (target === "view_filter" || target === "category_graphics") return { value: "view", matched: ["context.view"] };
  if (target === "schedule") return { value: "schedule", matched: ["context.schedule"] };
  if (target === "sheet") return { value: "sheet", matched: ["context.sheet"] };
  if (target === "text" || target === "tag") return { value: "annotation", matched: ["context.annotation"] };
  if (target === "model_parameter") return { value: "host_model", matched: ["context.host_model"] };
  if (["duct", "pipe", "receptacle", "light", "mep_accessory", "family_instance"].includes(target)) return { value: "host_model", matched: ["context.host_model"] };
  return { value: "unknown", matched: [] };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function hasExplicitMepSize(text: string): boolean {
  return /\b\d+\s*(?:x|×)\s*\d+\b|\b\d+\s*(?:in|inch|"|dia|ø)\b/i.test(text);
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractRequestedMepFacts(text: string, target: RedlineTargetClass): { sizes: string[]; airflow: string[]; existingSize?: string; requestedSize?: string; systemHint?: string } {
  const sizes: string[] = [];
  const airflow: string[] = [];
  const seenSize = new Set<string>();
  const seenAirflow = new Set<string>();
  let existingSize: string | undefined;
  let requestedSize: string | undefined;
  let systemHint: string | undefined;
  const addSize = (value: string): void => {
    const normalized = normalizeExtractedText(value.replace(/×/g, "x"));
    const key = normalized.toLowerCase();
    if (!normalized || seenSize.has(key)) return;
    seenSize.add(key);
    sizes.push(normalized);
  };
  const addAirflow = (value: string): void => {
    const normalized = normalizeExtractedText(value.toUpperCase());
    const key = normalized.toLowerCase();
    if (!normalized || seenAirflow.has(key)) return;
    seenAirflow.add(key);
    airflow.push(normalized);
  };

  if (target === "duct") {
    if (/\bsupply\s+air\b|\bsa\b|\bsupply\b/i.test(text)) systemHint = "supply air";
    else if (/\breturn\s+air\b|\bra\b|\breturn\b/i.test(text)) systemHint = "return air";
    else if (/\bexhaust\s+air\b|\bea\b|\bexhaust\b/i.test(text)) systemHint = "exhaust air";
    else if (/\boutside\s+air\b|\boa\b/i.test(text)) systemHint = "outside air";
    const ductTransition = /\bfrom\s+(\d{1,3}\s*(?:x|×)\s*\d{1,3})\s+to\s+(\d{1,3}\s*(?:x|×)\s*\d{1,3})\b/i.exec(text);
    if (ductTransition?.[1]) existingSize = normalizeExtractedText(ductTransition[1].replace(/×/g, "x"));
    if (ductTransition?.[2]) {
      requestedSize = normalizeExtractedText(ductTransition[2].replace(/×/g, "x"));
      addSize(ductTransition[2]);
    }
    for (const match of text.matchAll(/\b\d{1,3}\s*(?:x|×)\s*\d{1,3}\b/gi)) addSize(match[0]);
  }
  if (target === "pipe") {
    if (/\bdomestic\s+cold\s+water\b|\bdcw\b|\bcold\s+water\b/i.test(text)) systemHint = "domestic cold water";
    else if (/\bdomestic\s+hot\s+water\b|\bdhw\b|\bhot\s+water\b/i.test(text)) systemHint = "domestic hot water";
    else if (/\bsanitary\b|\bsan\b/i.test(text)) systemHint = "sanitary";
    else if (/\bvent\b/i.test(text)) systemHint = "vent";
    else if (/\bchw\b|\bchilled\s+water\b/i.test(text)) systemHint = "chilled water";
    else if (/\bhhw\b|\bheating\s+hot\s+water\b/i.test(text)) systemHint = "heating hot water";
    const pipeSizePattern = String.raw`(?:\d+\s*[- ]\s*)?\d+\s*\/\s*\d+\s*(?:"|in\b|inch(?:es)?\b)?|\d+(?:\.\d+)?\s*-?\s*(?:"|in\b|inch(?:es)?\b|dia\b|ø)`;
    const pipeTransition = new RegExp(String.raw`\bfrom\s+(${pipeSizePattern})\s+to\s+(${pipeSizePattern})`, "i").exec(text);
    if (pipeTransition?.[1]) existingSize = normalizeExtractedText(pipeTransition[1]);
    if (pipeTransition?.[2]) {
      requestedSize = normalizeExtractedText(pipeTransition[2]);
      addSize(pipeTransition[2]);
    }
    for (const match of text.matchAll(/\b(?:\d+\s*[- ]\s*)?\d+\s*\/\s*\d+\s*(?:"|in\b|inch(?:es)?\b)?|\b\d+(?:\.\d+)?\s*-?\s*(?:"|in\b|inch(?:es)?\b|dia\b|ø)\b/gi)) {
      addSize(match[0]);
    }
  }
  if (target === "duct") {
    for (const match of text.matchAll(/\b\d{2,6}\s*cfm\b/gi)) addAirflow(match[0]);
  }
  return { sizes, airflow, existingSize, requestedSize: requestedSize ?? sizes[0], systemHint };
}

function lengthToFeet(value: string, unit: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (!unit) return n;
  const normalized = unit.toLowerCase();
  if (normalized === "\"" || normalized.startsWith("in")) return n / 12;
  return n;
}

function extractRequestedMepElevationMove(text: string): { deltaFt?: number; hint?: string } {
  const explicitHint = cleanRequestedDocumentationText(/\belevation=([^;]+)/i.exec(text)?.[1] ?? "");
  if (explicitHint) return { hint: explicitHint };

  const directionMatch = /\b(raise|rise|elevate|lower|drop)\b.{0,40}\b(?:by\s+)?(\d+(?:\.\d+)?)\s*(ft|feet|in|inch|inches|")\b/i.exec(text);
  if (directionMatch) {
    const verb = directionMatch[1] ?? "";
    const value = directionMatch[2] ?? "";
    const unit = directionMatch[3];
    const feet = lengthToFeet(value, unit);
    if (Number.isFinite(feet)) {
      const signed = /\b(lower|drop|down)\b/i.test(verb) ? -feet : feet;
      return { deltaFt: Number(signed.toFixed(4)), hint: directionMatch[0].replace(/\s+/g, " ") };
    }
  }
  const moveDirectionMatch = /\b(?:move|shift)\b.{0,40}\b(up|down)\b.{0,20}\b(?:by\s+)?(\d+(?:\.\d+)?)\s*(ft|feet|in|inch|inches|")\b/i.exec(text);
  if (moveDirectionMatch) {
    const direction = moveDirectionMatch[1] ?? "";
    const feet = lengthToFeet(moveDirectionMatch[2] ?? "", moveDirectionMatch[3]);
    if (Number.isFinite(feet)) {
      const signed = /down/i.test(direction) ? -feet : feet;
      return { deltaFt: Number(signed.toFixed(4)), hint: moveDirectionMatch[0].replace(/\s+/g, " ") };
    }
  }

  const absolute =
    /\b(?:bottom\s+of\s+(?:duct|pipe)|b\.?o\.?d\.?|elevation)\b.{0,40}\b(?:at|to|=)?\s*(\d+(?:\.\d+)?)\s*(ft|feet|in|inch|inches|")?(?:\s+(?:above|below)\s+(?:floor|ceiling|slab|aff))?/i.exec(text);
  if (absolute?.[0]) return { hint: absolute[0].replace(/\s+/g, " ") };
  return {};
}

function cleanRequestedDocumentationText(value: string): string {
  return value
    .replace(/[.;,:)\]]+\s*$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGraphicsStyleIntent(value: string): string {
  return cleanRequestedDocumentationText(value)
    .replace(/\s+lineweight$/i, "")
    .trim();
}

function cleanReplacementDocumentationText(value: string): string {
  return cleanRequestedDocumentationText(value)
    .replace(/\s+\bin\s+(?:the\s+)?(?:text\s+note|note|label|schedule|cell|row)$/i, "")
    .trim();
}

function extractRequestedDocumentationText(text: string, target: RedlineTargetClass): string | undefined {
  if (target !== "schedule" && target !== "text" && target !== "tag") return undefined;
  const patterns = [
    /\brequested_text=([^;]+)/i,
    /\b(?:read|shown)\b.*?:\s+"([^"]+)"/i,
    /\bcorrection\s+["'`]([^"'`]+)["'`]/i,
    /\bword\s+["'`]([^"'`]+)["'`]\s+is\s+written\b/i,
    /\b(?:text\s+)?change\s+to\s+["'`]([^"'`]+)["'`]/i,
    /\b(?:text|note)\s+wording\b.*?\b(?:to\s+)?(?:say|says|read|reads)\s+["'`]?([^"'`.,;:]+)["'`]?/i,
    /\b(?:add|provide|place|show|create)\b.*?\b(?:text\s+note|general\s+note|note)\b.*?\b(?:reading|reads|read|saying|says|say)\s+["'`]?([^"'`.,;:]+)["'`]?/i,
    /\b(?:from|replace)\s+["'`]?([^"'`.,;:]+?)["'`]?\s+(?:to|with)\s+["'`]?([^"'`.,;:]+)["'`]?/i,
    /\b(?:change|revise|update|edit|correct|set)\b.*?\b(?:to|as|say|says|read|reads)\s+["'`]?([^"'`.,;:]+)["'`]?/i,
    /\b(?:text|note|cell|value|tag|label)\b.*?\b(?:to|as|say|says|read|reads)\s+["'`]?([^"'`.,;:]+)["'`]?/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const candidate = cleanReplacementDocumentationText(match?.[2] ?? match?.[1] ?? "");
    if (candidate) return candidate;
  }
  const notUsed = /\bnot\s+used\b/i.exec(text)?.[0];
  if (notUsed) return notUsed.toUpperCase();
  if (target === "schedule" && /\bvalue\s+update\s+in\s+schedule\b/i.test(text)) {
    const valueOnly = /\b\d+(?:\.\d+)?\/\d+(?:\.\d+)?\b/.exec(text)?.[0];
    if (valueOnly) return valueOnly;
  }
  return undefined;
}

function extractExistingDocumentationText(text: string, target: RedlineTargetClass): string | undefined {
  if (target !== "schedule" && target !== "text" && target !== "tag") return undefined;
  const explicit = /\bexisting_text=([^;]+)/i.exec(text)?.[1];
  if (explicit) return cleanRequestedDocumentationText(explicit);
  const replacement = /\b(?:from|replace)\s+["'`]?([^"'`.,;:]+?)["'`]?\s+(?:to|with)\s+["'`]?([^"'`.,;:]+)["'`]?/i.exec(text);
  if (replacement?.[1]) return cleanRequestedDocumentationText(replacement[1]);
  const strikeout = /\b(?:strike(?:out)?|struck\s+through|cross(?:ed)?\s+out)\b(?:\s+(?:text|word|label))?\s+["'`]?([^"'`.,;:]+)["'`]?/i.exec(text);
  if (strikeout?.[1]) return cleanRequestedDocumentationText(strikeout[1]);
  return undefined;
}

function extractScheduleFilterFacts(text: string): { field?: string; op?: string; value?: string; category?: string; fields?: string[] } {
  const explicitField = cleanRequestedDocumentationText(/\bschedule_filter_field=([^;]+)/i.exec(text)?.[1] ?? "");
  const explicitOp = cleanRequestedDocumentationText(/\bschedule_filter_op=([^;]+)/i.exec(text)?.[1] ?? "");
  const explicitValue = cleanRequestedDocumentationText(/\bschedule_filter_value=([^;]+)/i.exec(text)?.[1] ?? "");

  const designationFieldCue = /\b(?:equipment\s+)?designation\b|\bmark\b/i.test(text);
  const airflowFieldCue = /\bair\s*flow|airflow|cfm\b/i.test(text);
  const field = explicitField || (designationFieldCue ? "Mark" : airflowFieldCue ? "Airflow" : "");

  const operatorMatch =
    /\b(?:starts\s+with|begins\s+with|starting\s+with|beginning\s+with|prefix(?:ed)?\s+(?:with|as)|prefixed\s+by)\b/i.exec(text)
    ?? /\b(?:contains|includes)\b/i.exec(text)
    ?? /\b(?:equals|equal\s+to|is)\b/i.exec(text);
  const rawOp = explicitOp || operatorMatch?.[0] || "";
  const op = /\b(?:starts|begins|prefix)\b/i.test(rawOp)
    ? "begins_with"
    : /\b(?:contains|includes)\b/i.test(rawOp)
      ? "contains"
      : /\b(?:equals|equal|is)\b/i.test(rawOp)
        ? "equals"
        : "";

  const prefixValue =
    /\b(?:starts\s+with|begins\s+with|starting\s+with|beginning\s+with|prefix(?:ed)?\s+(?:with|as)|prefixed\s+by)\s+["'`]?([A-Za-z0-9][A-Za-z0-9._/-]*-?)["'`]?/i.exec(text)?.[1]
    ?? /\bfilter(?:ed)?\b.{0,80}\b(?:to|for|by)\b.{0,40}\b["'`]?([A-Za-z0-9][A-Za-z0-9._/-]*-?)["'`]?/i.exec(text)?.[1]
    ?? /\bdesignation\b.{0,80}\b["'`]?([A-Z]{1,6}-\d*-?)["'`]?/i.exec(text)?.[1]
    ?? /\b(?:VAV|P|HRU|AHU|EF|FSD)-\d*-?/i.exec(text)?.[0];
  const value = explicitValue || cleanRequestedDocumentationText(prefixValue ?? "");

  const category = /\b(?:vav|pump|equipment|mechanical\s+equipment|ahu|hru|ef)\b/i.test(text)
    ? "OST_MechanicalEquipment"
    : "";
  const fields = field ? ["Family and Type", field] : [];
  return {
    field: field || undefined,
    op: op || undefined,
    value: value || undefined,
    category: category || undefined,
    fields: fields.length > 0 ? fields : undefined
  };
}

function extractRequestedGraphicsFacts(text: string): { lineWeight?: number; styleIntent?: string; targetHint?: string; visibilityIntentHint?: string } {
  const lineWeightText = /\brequested_lineweight=([^;]+)/i.exec(text)?.[1]
    ?? /\b(?:line\s*weight|lineweight|lw)\s*(?:to|=|:)?\s*(\d{1,2})\b/i.exec(text)?.[1];
  const parsedLineWeight = lineWeightText ? Number(lineWeightText.trim()) : undefined;
  const lineWeight = parsedLineWeight !== undefined && Number.isInteger(parsedLineWeight) && parsedLineWeight >= 1 && parsedLineWeight <= 16 ? parsedLineWeight : undefined;
  const targetHint = cleanRequestedDocumentationText(/\bgraphics_target_hint=([^;]+)/i.exec(text)?.[1] ?? "");
  const visibilityIntentHint = cleanRequestedDocumentationText(/\bvisibility_intent=([^;]+)/i.exec(text)?.[1] ?? "");
  const styleIntentText = /\bgraphics_style_intent=([^;]+)/i.exec(text)?.[1];
  const styleIntent = cleanGraphicsStyleIntent(styleIntentText ?? "");
  if (styleIntent || targetHint || visibilityIntentHint) {
    return {
      lineWeight,
      styleIntent: styleIntent || undefined,
      targetHint: targetHint || undefined,
      visibilityIntentHint: visibilityIntentHint || undefined
    };
  }
  let extractedTargetHint: string | undefined;
  const targetPatterns = [
    /\ball\s+mechanical\s+equipment\b/i,
    /\bmechanical\s+equipment\b/i,
    /\bentire\s+FFU\b/i,
    /\bFFU'?s\b/i,
    /\bducts?\s+that\s+pass\s+underneath\s+one\s+another\b/i,
    /\bducts?\s+go\s+over\s+or\s+under\s+one\s+another\b/i,
    /\bducts?\b/i,
    /\bfuture(?:\s+new\s+work|\s+work)?\b/i,
    /\bnew\s+work\b/i,
    /\b(?:contours?|countours?)\b/i,
    /\bcad\s+link\s+markers?\/points?\b/i,
    /\bcad\s+(?:markers?|points?)\b/i,
    /\blink\s+markers?\b/i,
    /\blayers?\b/i
  ];
  for (const pattern of targetPatterns) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      extractedTargetHint = cleanRequestedDocumentationText(match[0].toLowerCase()).replace(/\bcountours?\b/g, "contours");
      break;
    }
  }
  if (extractedTargetHint === "contours" && /\bback\s+in\b/i.test(text)) {
    return {
      lineWeight,
      styleIntent: "show",
      targetHint: extractedTargetHint,
      visibilityIntentHint: "show"
    };
  }
  const stylePatterns = [
    /\b(light\s+hidden(?:\s+line(?:weight)?)?)\b/i,
    /\b(hidden\s+line(?:weight)?)\b/i,
    /\bhalftone\b/i,
    /\bmonochrome\b/i,
    /\bdashed(?:\s+lines?)?\b/i,
    /\bhide\b|\bhidden\b/i,
    /\bfuture(?:\s+new\s+work|\s+work)?\b/i
  ];
  for (const pattern of stylePatterns) {
    const match = pattern.exec(text);
    if (match?.[0]) {
      const extractedStyle = cleanGraphicsStyleIntent(match[0].toLowerCase());
      return {
        lineWeight,
        styleIntent: extractedStyle,
        targetHint: extractedTargetHint,
        visibilityIntentHint: lineWeight ? `lineweight ${lineWeight}` : extractedStyle
      };
    }
  }
  return {
    lineWeight,
    targetHint: extractedTargetHint,
    visibilityIntentHint: lineWeight ? `lineweight ${lineWeight}` : undefined
  };
}

function extractRequestedLinkedAndPhaseFacts(text: string): { linkedModelCategoryHint?: string; linkedVisibilityIntentHint?: string; phaseNameHint?: string; phaseFilterHint?: string; phaseMappingIntentHint?: string } {
  const linkedModelCategoryHint = cleanRequestedDocumentationText(/\blinked_model_category=([^;]+)/i.exec(text)?.[1] ?? "");
  const linkedVisibilityIntentHint = cleanRequestedDocumentationText(/\blinked_visibility_intent=([^;]+)/i.exec(text)?.[1] ?? "");
  const phaseNameHint = cleanRequestedDocumentationText(/\bphase_name=([^;]+)/i.exec(text)?.[1] ?? "");
  const phaseFilterHint = cleanRequestedDocumentationText(/\bphase_filter=([^;]+)/i.exec(text)?.[1] ?? "");
  const phaseMappingIntentHint = cleanRequestedDocumentationText(/\bphase_mapping_intent=([^;]+)/i.exec(text)?.[1] ?? "");
  if (linkedModelCategoryHint || linkedVisibilityIntentHint || phaseNameHint || phaseFilterHint || phaseMappingIntentHint) {
    return {
      linkedModelCategoryHint: linkedModelCategoryHint || undefined,
      linkedVisibilityIntentHint: linkedVisibilityIntentHint || undefined,
      phaseNameHint: phaseNameHint || undefined,
      phaseFilterHint: phaseFilterHint || undefined,
      phaseMappingIntentHint: phaseMappingIntentHint || undefined
    };
  }

  let linkedModelCategory: string | undefined;
  let linkedVisibilityIntent: string | undefined;
  if (/\b(?:linked\s+model|revit\s+link|architectural\s+link|linked\s+arch)\b/i.test(text)) {
    const categoryPatterns = [
      /\b(plumbing\s+fixtures?)\b/i,
      /\b(furniture)\b/i,
      /\b(mechanical\s+equipment)\b/i,
      /\b(ducts?|ductwork)\b/i,
      /\b(pipes?|piping)\b/i,
      /\b(receptacles?|electrical\s+fixtures?)\b/i,
      /\b(walls?|doors?|windows?|ceilings?|floors?)\b/i
    ];
    for (const pattern of categoryPatterns) {
      const match = pattern.exec(text);
      if (match?.[1]) {
        linkedModelCategory = cleanRequestedDocumentationText(match[1].toLowerCase());
        break;
      }
    }
    const graphicsFacts = extractRequestedGraphicsFacts(text);
    const visibilityMatch =
      /\b(show|hide|halftone|override|lineweight\s*\d{1,2}|line\s*weight\s*\d{1,2})\b/i.exec(text)?.[0]
      ?? graphicsFacts.styleIntent
      ?? (graphicsFacts.lineWeight ? `lineweight ${graphicsFacts.lineWeight}` : undefined);
    linkedVisibilityIntent = visibilityMatch ? cleanRequestedDocumentationText(visibilityMatch.toLowerCase()) : undefined;
  }

  let phaseName: string | undefined;
  let phaseFilter: string | undefined;
  let phaseMappingIntent: string | undefined;
  if (/\bphase(?:\s+filter|\s+mapping)?|demo(?:lition)?\s+work|removal\s+view|existing\s+phase|new\s+construction|new\s+work\b/i.test(text)) {
    phaseName = cleanRequestedDocumentationText(
      /\b(existing|new\s+construction|demolition\s+work|demo\s+work|demo(?:lition)?)\b/i.exec(text)?.[1] ?? ""
    );
    phaseFilter = cleanRequestedDocumentationText(
      /\bphase\s+filter\s+(?:to|as|=|:)?\s*["'`]?([^"'`.;,:]+)["'`]?/i.exec(text)?.[1] ?? ""
    );
    const mapping = /\bphase\s+mapping\b/i.exec(text)?.[0] ?? /\bmatch\b.{0,80}\b(?:linked\s+model|architectural\s+linked\s+model)\b.{0,80}\bphase/i.exec(text)?.[0];
    phaseMappingIntent = mapping ? cleanRequestedDocumentationText(mapping.toLowerCase()) : undefined;
  }

  return {
    linkedModelCategoryHint: linkedModelCategory,
    linkedVisibilityIntentHint: linkedVisibilityIntent,
    phaseNameHint: phaseName || undefined,
    phaseFilterHint: phaseFilter || undefined,
    phaseMappingIntentHint: phaseMappingIntent
  };
}

function extractRequestedFamilyInstanceFacts(text: string, target: RedlineTargetClass): { requestedKindHint?: string; requestedSizeHint?: string } {
  if (target !== "mep_accessory" && target !== "family_instance" && target !== "light" && target !== "receptacle") return {};
  const requestedKindHint = cleanRequestedDocumentationText(/\brequested_accessory_kind=([^;]+)/i.exec(text)?.[1] ?? "");
  const requestedSizeHint = cleanRequestedDocumentationText(/\brequested_accessory_size=([^;]+)/i.exec(text)?.[1] ?? "");
  if (requestedKindHint || requestedSizeHint) return { requestedKindHint: requestedKindHint || undefined, requestedSizeHint: requestedSizeHint || undefined };
  if (target !== "mep_accessory") return {};
  const sizeHint = /\b\d{1,3}\s*(?:x|×)\s*\d{1,3}\b/i.exec(text)?.[0]?.replace(/×/g, "x").replace(/\s+/g, "");
  if (/\b(?:remove|delete|take\s+out)\s+(?:this\s+|the\s+)?access\s+doors?\b/i.test(text)) return { requestedKindHint: "access door", requestedSizeHint: sizeHint };
  if (/\b(?:move|shift|relocate)\b.{0,80}\bdampers?\b/i.test(text)) return { requestedKindHint: "damper", requestedSizeHint: sizeHint };
  const accessoryPatterns = [
    /\bfire\s+smoke\s+dampers?\b/i,
    /\bfire\s+dampers?\b/i,
    /\bsmoke\s+dampers?\b/i,
    /\bbubble[-\s]*tight\s+isolation\s+dampers?\b/i,
    /\bmanual\s+balancing\s+dampers?\b/i,
    /\bbalancing\s+dampers?\b/i,
    /\bdampers?\b/i,
    /\bFSD\b/i,
    /\bbutterfly\s+valves?\b/i,
    /\bball\s+valves?\b/i,
    /\baccess\s+doors?\b/i,
    /\btransfer\s+grilles?\b/i,
    /\bface\s+grilles?\b/i,
    /\bdiffusers?\b/i,
    /\bair\s+devices?\b/i,
    /\bVAV(?:\s+boxes?)?\b/i,
    /\broom\s+pressure\s+monitors?\b/i
  ];
  for (const pattern of accessoryPatterns) {
    const match = pattern.exec(text);
    if (match?.[0]) return { requestedKindHint: cleanRequestedDocumentationText(match[0].toLowerCase()), requestedSizeHint: sizeHint };
  }
  return { requestedSizeHint: sizeHint };
}

function extractRequestedTagFacts(text: string): { requestedTagKindHint?: string; requestedTagValueHint?: string; requestedNoteNumberHint?: string; targetScopeHint?: string } {
  const requestedTagKindHint = cleanRequestedDocumentationText(/\brequested_tag_kind=([^;]+)/i.exec(text)?.[1] ?? "");
  const requestedTagValueHint = cleanRequestedDocumentationText(/\brequested_tag_value=([^;]+)/i.exec(text)?.[1] ?? "");
  const requestedNoteNumberHint = cleanRequestedDocumentationText(/\brequested_tag_note_number=([^;]+)/i.exec(text)?.[1] ?? "");
  const targetScopeHint = cleanRequestedDocumentationText(/\btag_target_scope=([^;]+)/i.exec(text)?.[1] ?? "");
  if (requestedTagKindHint || requestedTagValueHint || requestedNoteNumberHint || targetScopeHint) {
    return {
      requestedTagKindHint: requestedTagKindHint || undefined,
      requestedTagValueHint: requestedTagValueHint || undefined,
      requestedNoteNumberHint: requestedNoteNumberHint || undefined,
      targetScopeHint: targetScopeHint || undefined
    };
  }
  const noteNumber =
    /\b(?:diamond\s+note|keynote)\s*(?:number|#|no\.?)?\s*(\d{1,3})\b/i.exec(text)?.[1]
    ?? /\b(?:note|tag)\s*(?:number|#)\s*(\d{1,3})\b/i.exec(text)?.[1];
  let tagValue: string | undefined;
  const mepSizeLabel = /\b(\d{1,3}\s*(?:x|×)\s*\d{1,3})\b.{0,80}\b(?:duct|ductwork)\b/i.exec(text)?.[1];
  if (mepSizeLabel && /\b(?:label|tag|show|add)\b/i.test(text)) tagValue = cleanRequestedDocumentationText(mepSizeLabel.replace(/×/g, "x"));
  const tagValuePatterns = [
    /\b(?:tag|prefix|label)\s+(?:to|as)\s+([A-Z]{1,4}\d?(?:-[A-Z0-9]+)*(?:,\d{2})*)\b/i,
    /\b(?:change|update|revise)\b.{0,80}\b(?:tag|prefix|label)\b.{0,40}\bto\s+([A-Z]{1,4}\d?(?:-[A-Z0-9]+)*(?:,\d{2})*)\b/i,
    /\b([A-Z]{1,4}\d?-\d-[A-Z]{1,4}-\d{2}(?:,\d{2})*)\b/i,
    /\b(?:tag|label|designate)\b.{0,30}\bas\s+([A-Z]{2,8})\b/i
  ];
  for (const pattern of tagValuePatterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      tagValue = cleanRequestedDocumentationText(match[1].toUpperCase());
      break;
    }
  }
  let tagKind: string | undefined;
  if (/\b(?:label|tag|show|add)\b.{0,80}\b(?:duct|ductwork)\b.{0,80}\b(?:sizes?|size\s+labels?|tags?)\b/i.test(text) || (tagValue && /\bduct|ductwork\b/i.test(text))) {
    tagKind = "duct size label";
  } else if (/\b(?:label|tag|show|add)\b.{0,80}\b(?:pipe|piping)\b.{0,80}\b(?:sizes?|size\s+labels?|tags?)\b/i.test(text)) {
    tagKind = "pipe size label";
  }
  const kindPatterns = [
    /\bfire\s+smoke\s+dampers?\b/i,
    /\bfire\s+dampers?\b/i,
    /\bsmoke\s+dampers?\b/i,
    /\bhard[-\s]*duct\s+low\s+pressure\s+ducts?\b/i,
    /\bexisting\s+piping\b/i,
    /\bsection\s+(?:view\s+)?callouts?\b/i,
    /\bduplicate\s+tags?\b/i,
    /\bkeynotes?\b/i,
    /\bdiamond\s+notes?\b/i,
    /\bduct\s+tags?\b/i,
    /\bpipe\s+tags?\b/i,
    /\bequipment\s+tags?\b/i
  ];
  if (!tagKind) {
    for (const pattern of kindPatterns) {
      const match = pattern.exec(text);
      if (match?.[0]) {
        tagKind = cleanRequestedDocumentationText(match[0].toLowerCase());
        break;
      }
    }
  }
  const scope = cleanRequestedDocumentationText(
    /\ball\s+hard[-\s]*duct\s+low\s+pressure\s+ducts?\b/i.exec(text)?.[0]
      ?? /\ball\s+(?:duct|ductwork)\s+sizes?\b/i.exec(text)?.[0]
      ?? /\ball\s+(?:pipe|piping)\s+sizes?\b/i.exec(text)?.[0]
      ?? /\ball\s+existing\s+piping\b/i.exec(text)?.[0]
      ?? /\ball\s+tags?\s+from\s+[^.;]+/i.exec(text)?.[0]
      ?? /\b(?:off|from)\s+the\s+duct\b/i.exec(text)?.[0]
      ?? ""
  );
  return {
    requestedTagKindHint: tagKind,
    requestedTagValueHint: tagValue,
    requestedNoteNumberHint: noteNumber,
    targetScopeHint: scope || undefined
  };
}

function extractRequestedTypeChangeFacts(text: string): { existingTypeHint?: string; requestedTypeHint?: string } {
  const existingTypeHint = cleanRequestedDocumentationText(/\bexisting_type=([^;]+)/i.exec(text)?.[1] ?? "");
  const requestedTypeHint = cleanRequestedDocumentationText(/\brequested_type=([^;]+)/i.exec(text)?.[1] ?? "");
  if (existingTypeHint || requestedTypeHint) {
    return {
      existingTypeHint: existingTypeHint || undefined,
      requestedTypeHint: requestedTypeHint || undefined
    };
  }

  const replacement =
    /\b(?:from|replace)\s+["'`]?([^"'`.,;:]+?)["'`]?\s+(?:to|with)\s+["'`]?([^"'`.,;:]+?)["'`]?(?:\b|[.;,:])/i.exec(text)
    ?? /\b(?:change|swap|convert|revise|update|switch|make)\b.{0,80}\b(?:type|family|designation|diffuser|grille|register|air\s*device)\b.{0,40}\b(?:to|with|as)\s+["'`]?([^"'`.,;:]+?)["'`]?(?:\b|[.;,:])/i.exec(text);
  let existingType = "";
  let requestedType = "";
  if (replacement?.[2]) {
    existingType = cleanRequestedDocumentationText(replacement[1] ?? "");
    requestedType = cleanRequestedDocumentationText(replacement[2]);
  } else if (replacement?.[1]) {
    requestedType = cleanRequestedDocumentationText(replacement[1]);
  }
  if (!existingType && !requestedType && /\brectangular\s+to\s+round\b/i.test(text)) {
    existingType = "rectangular";
    requestedType = "round";
  }
  if (!requestedType || /^(?:a|fire|change|switch|make)$/i.test(requestedType)) {
    const directRequestedType =
      /\bchange\s+designation\s+to\s+(fire\s+smoke\s+damper|FSD)\b/i.exec(text)?.[1]
      ?? /\bswitch\s+to\s+(?:a\s+)?(\d{1,3}\s*(?:x|×)\s*\d{1,3}\s+air\s+device|air\s+device)\b/i.exec(text)?.[1]
      ?? /\bmake\s+(?:this|these)?\s*(?:a\s+)?((?:\d{1,3}\s*(?:x|×)\s*\d{1,3}\s+)?rectangular(?:\s+\d{1,3}\s*(?:x|×)\s*\d{1,3})?(?:\s+ducts?)?)\b/i.exec(text)?.[1]
      ?? /\bmake\s+these\s+(\d{1,3}\s*"?\s+wide\s+rectangular\s+ducts?)\b/i.exec(text)?.[1]
      ?? /\bextend\s+(hard\s+round\s+duct)\b/i.exec(text)?.[1];
    requestedType = cleanRequestedDocumentationText(directRequestedType ?? "").replace(/×/g, "x");
  }
  if (/^\d{1,3}$/.test(requestedType)) {
    const rectangularSize =
      /\brectangular\s+(\d{1,3})\s*"?\s*(?:x|×)\s*(\d{1,3})\s*"?/i.exec(text)
      ?? /\brectangular\s+duct\s*(\d{1,3})\s*"?\s*(?:x|×)\s*(\d{1,3})\s*"?/i.exec(text);
    if (rectangularSize?.[2]) requestedType = `rectangular ${rectangularSize[1]}x${rectangularSize[2]}`;
  }
  const airDeviceSwap = /\b([A-Z]\d+)\b.{0,80}\b(?:to|with|as)\s+\b([A-Z]\d+)\b/i.exec(text);
  if (airDeviceSwap?.[2] && /\b(diffuser|grille|register|air\s*device|cfm)\b/i.test(text)) {
    existingType = existingType || airDeviceSwap[1] || "";
    requestedType = requestedType || airDeviceSwap[2] || "";
  }
  return {
    existingTypeHint: existingType || undefined,
    requestedTypeHint: requestedType || undefined
  };
}

function asksForScopedMepSizing(text: string, operation: RedlineOperationClass, target: RedlineTargetClass): boolean {
  if (operation !== "size_transition" || (target !== "duct" && target !== "pipe")) return false;
  if (/\b(?:size|resize)\s+(?:all|these|this|the)\s+(?:ductwork|ducts?|piping|pipes?)\b|\b(?:ductwork|ducts?|piping|pipes?)\s+(?:need|needs|shall|should)\s+to\s+be\s+(?:sized|resized)\b/i.test(text)) return true;
  const airflowDrivenSizing =
    target === "duct" &&
    /\b(?:size|resize|calculate|revise|update|provide|set)\b.*\b\d+\s*cfm\b|\b\d+\s*cfm\b.*\b(?:supply|return|exhaust|airflow|ductwork|ducts?)\b/i.test(text);
  return airflowDrivenSizing && !hasExplicitMepSize(text);
}

function evidenceFor(operation: RedlineOperationClass, target: RedlineTargetClass): RedlineEvidenceRequirement[] {
  const requirements: RedlineEvidenceRequirement[] = [];
  const modeledTargets = ["duct", "pipe", "receptacle", "light", "mep_accessory", "family_instance"];
  const tagMutation = target === "tag" && ["add", "delete", "move", "tag", "text_edit"].includes(operation);
  if (operation === "tag") requirements.push("annotation_inventory");
  if (tagMutation) requirements.push("visual_gate");
  if (modeledTargets.includes(target)) requirements.push("model_write", "visual_gate");
  if (operation === "parameter_edit") requirements.push("parameter_readback");
  if (target === "model_parameter") requirements.push("model_write", "parameter_readback");
  if (operation === "delete") requirements.push("delete_effect_ids");
  if (operation === "move") requirements.push("move_effect_ids");
  if (operation === "text_edit") requirements.push("annotation_inventory");
  if (operation === "text_edit" && target === "text") requirements.push("visual_gate");
  if (operation === "add" && target === "text") requirements.push("annotation_inventory", "visual_gate", "cleanup_effect_ids");
  if (operation === "type_change") requirements.push("model_write", "type_readback", "visual_gate");
  if (operation === "route") requirements.push("model_write", "visual_gate", "projection_readback", "connector_network_audit", "cleanup_effect_ids");
  if (operation === "tap_branch") requirements.push("model_write", "visual_gate", "projection_readback", "fitting_readback", "connector_network_audit", "cleanup_effect_ids");
  if (operation === "reroute_offset") requirements.push("model_write", "visual_gate", "projection_readback", "fitting_readback", "connector_network_audit", "cleanup_effect_ids");
  if (operation === "size_transition") requirements.push("model_write", "visual_gate", "projection_readback", "fitting_readback", "connector_network_audit", "cleanup_effect_ids");
  if (operation === "graphics_override" || ["view_filter", "view_template", "category_graphics"].includes(target)) requirements.push("graphics_readback");
  if (target === "cad_link") requirements.push("cad_source_target_readback", "graphics_readback");
  if (target === "schedule") requirements.push("schedule_readback");
  if (target === "text" || target === "tag") requirements.push("annotation_inventory");
  if (["add", "move", "route"].includes(operation) && requirements.includes("model_write")) requirements.push("cleanup_effect_ids");
  return unique(requirements);
}

function contextualEvidenceFor(text: string, operation: RedlineOperationClass, target: RedlineTargetClass): RedlineEvidenceRequirement[] {
  const requirements: RedlineEvidenceRequirement[] = [];
  if (asksForScopedMepSizing(text, operation, target)) requirements.push("sizing_scope_readback", "per_segment_size_readback");
  return requirements;
}

function recommendedBenchmarkTasks(operation: RedlineOperationClass, target: RedlineTargetClass): string[] {
  if (operation === "graphics_override" || ["cad_link", "view_filter", "view_template", "category_graphics"].includes(target)) return ["demo_documentation_primitives"];
  if (operation === "route" && target === "pipe") return ["demo_redline_mep_pipe_route"];
  if (operation === "route" && target === "duct") return ["demo_redline_mep_route"];
  if (operation === "tap_branch" && target === "pipe") return ["demo_redline_mep_pipe_tap_branch"];
  if (operation === "tap_branch" && target === "duct") return ["demo_redline_mep_duct_tap_branch"];
  if (operation === "reroute_offset" && target === "pipe") return ["demo_redline_mep_pipe_reroute"];
  if (operation === "reroute_offset" && target === "duct") return ["demo_redline_mep_duct_reroute"];
  if (operation === "size_transition" && target === "pipe") return ["demo_redline_mep_pipe_size_transition"];
  if (operation === "size_transition" && target === "duct") return ["demo_redline_mep_duct_size_transition"];
  if (operation === "add" && target === "tag") return ["demo_redline_add_tag"];
  if (operation === "add" && target === "receptacle") return ["demo_redline_add_receptacle", "demo_redline_receptacles"];
  if (operation === "add" && target === "light") return ["demo_redline_add_light"];
  if (operation === "add" && target === "mep_accessory") return ["demo_redline_add_mep_accessory"];
  if (operation === "add" && target === "family_instance") return ["demo_redline_add_family_instance"];
  if (operation === "add" && target === "duct") return ["demo_redline_mep_route"];
  if (operation === "add" && target === "pipe") return ["demo_redline_mep_pipe_route"];
  if (operation === "add" && target === "text") return ["demo_documentation_primitives"];
  if (operation === "text_edit" && target === "schedule") return ["demo_documentation_primitives"];
  if (operation === "text_edit" && target === "tag") return ["demo_documentation_primitives"];
  if (operation === "text_edit" && target === "mep_accessory") return ["demo_redline_text_edit_mep_accessory"];
  if (operation === "text_edit" && target === "text") return ["demo_documentation_primitives"];
  if (operation === "parameter_edit" && target === "mep_accessory") return ["demo_redline_text_edit_mep_accessory"];
  if (operation === "parameter_edit" && target === "model_parameter") return ["demo_redline_update_parameter"];
  if (operation === "tag" && target === "duct") return ["demo_documentation_primitives"];
  if (operation === "tag" && target === "pipe") return ["demo_documentation_primitives"];
  if (operation === "tag" && target === "tag") return ["demo_documentation_primitives"];
  if (operation === "delete" && target === "text") return ["demo_redline_delete_text"];
  if (operation === "delete" && target === "tag") return ["demo_redline_delete_tag"];
  if (operation === "delete" && target === "receptacle") return ["demo_redline_delete_receptacle"];
  if (operation === "delete" && target === "light") return ["demo_redline_delete_light"];
  if (operation === "delete" && target === "mep_accessory") return ["demo_redline_delete_mep_accessory"];
  if (operation === "delete" && target === "family_instance") return ["demo_redline_delete_family_instance"];
  if (operation === "delete" && target === "duct") return ["demo_redline_delete_duct_route"];
  if (operation === "delete" && target === "pipe") return ["demo_redline_delete_pipe_route"];
  if (operation === "move" && target === "text") return ["demo_redline_move_text"];
  if (operation === "move" && target === "tag") return ["demo_redline_move_tag"];
  if (operation === "move" && target === "receptacle") return ["demo_redline_move_receptacle"];
  if (operation === "move" && target === "light") return ["demo_redline_move_light"];
  if (operation === "move" && target === "mep_accessory") return ["demo_redline_move_mep_accessory"];
  if (operation === "move" && target === "family_instance") return ["demo_redline_move_family_instance"];
  if (operation === "move" && target === "duct") return ["demo_redline_move_duct_route"];
  if (operation === "move" && target === "pipe") return ["demo_redline_move_pipe_route"];
  if (operation === "rotate" && target === "text") return ["demo_redline_rotate_text"];
  if (operation === "type_change" && target === "duct") return ["demo_redline_type_change_duct"];
  if (operation === "type_change" && target === "mep_accessory") return ["demo_redline_type_change_mep_accessory"];
  if (operation === "type_change" && ["receptacle", "light", "family_instance"].includes(target)) return ["demo_redline_type_change_device"];
  return [];
}

function manualReviewReason(args: {
  operation: RedlineOperationClass;
  target: RedlineTargetClass;
  confidence: number;
  recommendedTasks: string[];
  matchedRules?: string[];
}): string | undefined {
  if (args.operation === "unknown" && args.target === "unknown") return "No operation or target rule matched.";
  if (args.operation === "unknown") return "No operation rule matched.";
  if (args.target === "unknown") return "No target rule matched.";
  if (args.confidence < 0.55) return "Low confidence classification.";
  if (args.recommendedTasks.length === 0) return "No benchmark gate currently maps to this operation/target pair.";
  return undefined;
}

function nonActionableStatusMarkupReason(text: string): string | undefined {
  const hasExplicitDirective =
    /\b(add|delete|remove|move|shift|relocate|route|reroute|connect|tap|branch|change|revise|resize|lineweight|line\s*weight|hide|show|provide|install|place|tag|label|set|update|replace|correct)\b/i.test(text);
  const hasStatusMetadata =
    /\bsubtype\s+highlight\b|\bcolor\s+(?:yellow|green|blue|orange|white)\b|\bhighlight(?:er|ed)?\b|\bstatus\s+(?:mark|markup|highlight)\b/i.test(text);
  const hasCompletionOrReferenceText =
    /\b(no\s+action\s+required|not\s+actionable|already\s+(?:done|complete|completed)|completed|done|verified|reviewed|for\s+reference\s+only|reference\s+only|highlight\s+only|status\s+only)\b/i.test(text);
  const hasBareMepOrValueText =
    /\b(?:duct|pipe|piping|damper|diffuser|grille|vav|receptacle|light|fixture|cfm|gpm|mbh|btuh|\d{1,3}\s*(?:x|×)\s*\d{1,3})\b/i.test(text);

  if (hasExplicitDirective) return undefined;
  if (hasCompletionOrReferenceText) return "Status/reference text is not an actionable redline directive.";
  if (hasStatusMetadata && hasBareMepOrValueText) return "Highlight/status markup with model terms but no explicit action verb.";
  return undefined;
}

function compositeAnnotationIndexCount(text: string): number {
  const match = /\bannotation[_\s-]?indices\b\s*[:=]?\s*"?([0-9|,;\s]+)"?/i.exec(text);
  if (!match?.[1]) return 0;
  return match[1].split(/[|,;\s]+/).map((entry) => entry.trim()).filter(Boolean).length;
}

function compositeNumericField(text: string, field: string): number {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped.replace(/_/g, "[_\\s-]?")}\\b\\s*[:=]?\\s*(\\d+)`, "i").exec(text);
  return match?.[1] ? Number(match[1]) : 0;
}

function nonActionableCompositeGroupReason(text: string): string | undefined {
  const hasCompositeCue =
    /\b(?:composite[_\s-]?group|group[_\s-]?index|annotation[_\s-]?indices|group[_\s-]?member[_\s-]?count|mark[_\s-]?count|text[_\s-]?mark[_\s-]?count|geometry[_\s-]?only[_\s-]?count)\b/i.test(text) ||
    /\bbucket\s*[:=]?\s*composite[_\s-]?group\b/i.test(text);
  if (!hasCompositeCue) return undefined;

  if (/\b(?:general\s+note\s+only|for\s+reference|reference\s+only|no\s+(?:new\s+)?work(?:\s+shown|\s+requirements?)?|no\s+change|existing\s+to\s+remain|revision\s+cloud\s+only|cloud\s+only|status\s+note)\b/i.test(text)) {
    return "Composite/grouped mark reads as status/reference text rather than a Revit change.";
  }

  const annotationCount = compositeAnnotationIndexCount(text);
  const markCount = compositeNumericField(text, "mark_count") || compositeNumericField(text, "group_member_count");
  const textMarkCount = compositeNumericField(text, "text_mark_count");
  const geometryOnlyCount = compositeNumericField(text, "geometry_only_count");
  if (annotationCount >= 8 || markCount >= 8) {
    return "Composite/grouped mark has too many members for one safe live request; split or confirm one action before promotion.";
  }
  if (geometryOnlyCount > textMarkCount && annotationCount > 3) {
    return "Composite/grouped mark is geometry-heavy and requires region review before promotion.";
  }

  const coordinatedTapRequest = /\btap\b/i.test(text) && /\bconnect\b/i.test(text);
  const hasConnector = /\b(?:and|also|plus|then)\b/i.test(text);
  const actionMatches = text.match(/\b(?:add|remove|delete|move|reroute|route|tap|connect|change|resize|hide|show|label|tag|update|replace)\b/gi) ?? [];
  const uniqueActions = new Set(actionMatches.map((entry) => entry.toLowerCase()));
  if (!coordinatedTapRequest && hasConnector && uniqueActions.size > 1) {
    return "Composite/grouped mark mixes multiple directives; split the group before live benchmark promotion.";
  }

  return undefined;
}

function nonActionableMepCalloutReason(text: string): string | undefined {
  const hasExplicitDirective =
    /\b(add|delete|remove|move|shift|relocate|route|reroute|connect|tap|branch|change|revise|resize|size|lineweight|line\s*weight|hide|show|provide|install|place|tag|label|set|update|replace|correct)\b/i.test(text);
  if (hasExplicitDirective) return undefined;
  const hasMepFact =
    /\b(?:duct|ductwork|pipe|piping|supply\s+air|return\s+air|exhaust\s+air|domestic\s+(?:cold|hot)\s+water|sanitary|vent|cfm|gpm|\d{1,3}\s*(?:x|×)\s*\d{1,3}|\d+(?:\.\d+)?\s*-?\s*(?:"|in\b|inch(?:es)?\b|dia\b|ø))\b/i.test(text);
  if (!hasMepFact) return undefined;
  if (/\b(callout_only|route_geometry_not_detected|reference_only|existing\s+only)\b/i.test(text)) {
    return "MEP callout/reference text has size/system facts but no route geometry or action directive.";
  }
  if (/\bexisting\b/i.test(text)) {
    return "Existing MEP size/system callout has no action directive; verify existing model evidence or keep in review.";
  }
  return undefined;
}

function nonActionableMatchedRule(reason: string): string {
  if (/Composite\/grouped mark/i.test(reason)) return "non_actionable.composite_group";
  if (reason.includes("callout") || reason.includes("Existing MEP")) return "non_actionable.mep_callout_or_reference";
  return "non_actionable.status_or_highlight_markup";
}

function missingLiveInputsForTask(taskId: string): string[] {
  if (taskId === "demo_documentation_primitives") {
    return [
      "open_revit_model",
      "target_view_or_sheet_id",
      "graphics_override_request",
      "existing_cad_link_inventory",
      "cad_reload_readback_or_no_write_block",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_mep_route" || taskId === "demo_redline_mep_pipe_route") {
    return [
      "open_revit_model",
      "view_id",
      "level_or_route_plane",
      "system_type",
      "route_points",
      "dry_run_route_projection",
      "dry_run_size_preview",
      "endpoint_or_connector_grounding",
      "connector_system_audit",
      "committed_route_readback",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_mep_duct_tap_branch" || taskId === "demo_redline_mep_pipe_tap_branch") {
    return [
      "open_revit_model",
      "view_id",
      "main_route_element_id",
      "projected_tap_point",
      "branch_points",
      "selected_system_type",
      "selected_level",
      "selected_branch_size",
      "expected_tee_or_tap_fitting",
      "connector_network_audit",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_mep_duct_reroute" || taskId === "demo_redline_mep_pipe_reroute") {
    return [
      "open_revit_model",
      "view_id",
      "host_route_element_id",
      "projected_split_points",
      "offset_vector_or_drop_height",
      "offset_mode_or_angle",
      "connected_endpoint_policy",
      "expected_elbow_or_transition_fittings",
      "connector_network_audit",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_mep_duct_size_transition" || taskId === "demo_redline_mep_pipe_size_transition") {
    return [
      "open_revit_model",
      "view_id",
      "host_route_element_id",
      "projected_transition_point_or_chainage",
      "dry_run_transition_projection",
      "upstream_size",
      "downstream_size",
      "dry_run_size_preview",
      "expected_transition_fitting",
      "connector_network_audit",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_parameter_edit" || taskId === "demo_redline_update_parameter" || taskId === "demo_redline_text_edit_mep_accessory") {
    const isAccessoryParameterEdit = taskId === "demo_redline_text_edit_mep_accessory";
    return [
      "open_revit_model",
      "view_id",
      isAccessoryParameterEdit ? "existing_mep_accessory_element_id" : "target_element_id",
      ...(isAccessoryParameterEdit ? ["accessory_category_family_type_readback"] : []),
      "parameter_name",
      "requested_parameter_value",
      "parameter_readback",
      "post_change_visual_capture",
      "cleanup_or_revert_verification"
    ];
  }
  if (taskId === "demo_redline_delete_duct_route" || taskId === "demo_redline_delete_pipe_route" || taskId === "demo_redline_move_duct_route" || taskId === "demo_redline_move_pipe_route") {
    if (taskId === "demo_redline_delete_duct_route" || taskId === "demo_redline_delete_pipe_route") {
      return [
        "open_revit_model",
        "view_id",
        "existing_route_element_ids",
        "existing_route_category",
        "existing_route_kind",
        "existing_route_system",
        "delete_dry_run_preflight",
        "connected_network_impact_audit",
        "post_dry_run_visual_capture",
        "restore_safe_apply_or_close_without_saving_plan"
      ];
    }
    return [
      "open_revit_model",
      "view_id",
      "existing_route_element_ids",
      "existing_route_category",
      "existing_route_kind",
      "existing_route_system",
      "move_vector_or_elevation_delta",
      "dry_run_move_preflight_review",
      "connected_network_audit",
      "post_move_readback",
      "post_move_visual_capture",
      "reverse_move_revert_readback"
    ];
  }
  if (taskId === "demo_redline_type_change_duct") {
    return [
      "open_revit_model",
      "view_id",
      "source_duct_element_id",
      "compatible_round_duct_type_id",
      "source_type_grounding",
      "target_type_compatibility_preflight",
      "type_readback",
      "post_change_visual_capture",
      "revert_verification"
    ];
  }
  if (taskId === "demo_redline_type_change_device") {
    return [
      "open_revit_model",
      "view_id",
      "source_element_id",
      "compatible_target_type_id",
      "source_type_grounding",
      "target_type_compatibility_preflight",
      "type_readback",
      "post_change_visual_capture",
      "revert_verification"
    ];
  }
  if (taskId === "demo_redline_type_change_mep_accessory") {
    return [
      "open_revit_model",
      "view_id",
      "source_mep_accessory_element_id",
      "source_accessory_family_type_category_readback",
      "compatible_accessory_target_type_id",
      "source_type_grounding",
      "target_type_compatibility_preflight",
      "type_readback",
      "post_change_visual_capture",
      "revert_verification"
    ];
  }
  if (/^demo_redline_(add|delete|move)_(receptacle|light|family_instance|mep_accessory)$/.test(taskId)) {
    return [
      "open_revit_model",
      "view_id",
      "family_or_symbol_name",
      "level_or_host_context",
      "model_write_id_readback",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (/^demo_redline_(add|delete|move)_tag$/.test(taskId)) {
    return [
      "open_revit_model",
      "view_id",
      "taggable_element_id",
      "annotation_inventory",
      "requested_tag_type_or_value",
      "tag_readback",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_delete_text") {
    return [
      "open_revit_model",
      "view_id",
      "existing_text_note_id",
      "existing_text_note_original_text",
      "annotation_inventory",
      "delete_dry_run_impact",
      "post_change_visual_capture",
      "restore_safe_apply_plan_or_apply_block"
    ];
  }
  if (/^demo_redline_(move|rotate)_text$/.test(taskId)) {
    return [
      "open_revit_model",
      "view_id",
      "annotation_location",
      "annotation_inventory",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  if (taskId === "demo_redline_receptacles") {
    return [
      "open_revit_model",
      "view_id",
      "exemplar_receptacle_id",
      "host_context",
      "room_or_chainage_target",
      "post_change_visual_capture",
      "cleanup_verification"
    ];
  }
  return ["open_revit_model", "task_specific_live_request_override", "post_change_visual_capture", "cleanup_verification"];
}

function contextualMissingLiveInputs(item: RedlineCorpusClassification): string[] {
  const text = item.text_excerpt;
  const out: string[] = [];
  const modeledMepGeometryRequest =
    ["route", "tap_branch", "reroute_offset", "size_transition"].includes(item.operation_class) &&
    ["duct", "pipe"].includes(item.target_class);
  if (item.target_class === "schedule") {
    const scheduleFilterFacts = extractScheduleFilterFacts(text);
    out.push(
      "schedule_id_or_category",
      "schedule_field_or_cell_reference",
      "requested_schedule_text_or_value",
      "schedule_readback"
    );
    if (scheduleFilterFacts.field || scheduleFilterFacts.op || scheduleFilterFacts.value) {
      if (!scheduleFilterFacts.field) out.push("schedule_filter_field");
      if (!scheduleFilterFacts.op) out.push("schedule_filter_operator");
      if (!scheduleFilterFacts.value) out.push("schedule_filter_value");
      out.push("schedule_config_readback");
    }
  }
  if (item.target_class === "text") {
    out.push(
      "target_text_view_id",
      "existing_text_note_id",
      "existing_text_note_original_text",
      "text_note_or_region_reference",
      "requested_text_note_value",
      "annotation_readback",
      "text_note_revert_readback"
    );
  }
  if (item.target_class === "tag") {
    if (item.operation_class === "delete") {
      out.push(
        "tag_target_view_id",
        "existing_visible_tag_id",
        "existing_tag_category",
        "existing_tag_text_or_tagged_element",
        "annotation_inventory",
        "tag_readback",
        "delete_dry_run_preflight",
        "restore_safe_apply_or_close_without_saving_plan"
      );
    } else {
      out.push(
        "tag_target_view_id",
        "taggable_element_ids",
        "annotation_inventory",
        "requested_tag_type_or_value",
        "tag_readback"
      );
    }
    if (item.operation_class === "text_edit") {
      out.push(
        "existing_tag_id",
        "tag_value_source_parameter",
        "existing_tag_value",
        "tag_value_revert_readback"
      );
    }
  }
  if (item.target_class === "mep_accessory" && ["add", "move", "delete"].includes(item.operation_class)) {
    if (item.operation_class !== "delete") out.push("accessory_placement_host_or_basis");
    if (item.operation_class === "move") {
      out.push(
        "existing_accessory_element_id",
        "existing_accessory_family_or_type",
        "existing_accessory_category",
        "dry_run_move_preflight_review",
        "post_move_readback",
        "reverse_move_revert_readback"
      );
    }
    if (item.operation_class === "delete") {
      out.push(
        "existing_accessory_element_id",
        "existing_accessory_family_or_type",
        "existing_accessory_category",
        "delete_dry_run_preflight",
        "restore_safe_apply_or_close_without_saving_plan"
      );
    }
  }
  if (["receptacle", "light", "family_instance"].includes(item.target_class) && ["move", "delete"].includes(item.operation_class)) {
    out.push(
      "existing_family_instance_element_id",
      "existing_family_or_type",
      "existing_family_instance_category"
    );
    if (item.operation_class === "move") {
      out.push(
        "move_vector_or_offset",
        "dry_run_move_preflight_review",
        "post_move_readback",
        "reverse_move_revert_readback"
      );
    }
    if (item.operation_class === "delete") {
      out.push(
        "delete_dry_run_preflight",
        "restore_safe_apply_or_close_without_saving_plan"
      );
    }
  }
  if (["duct", "pipe"].includes(item.target_class) && item.operation_class === "delete") {
    out.push(
      "existing_route_element_ids",
      "existing_route_category",
      "existing_route_kind",
      "existing_route_system",
      "delete_dry_run_preflight",
      "connected_network_impact_audit",
      "restore_safe_apply_or_close_without_saving_plan"
    );
  }
  if (["duct", "pipe"].includes(item.target_class) && item.operation_class === "move") {
    out.push(
      "existing_route_element_ids",
      "existing_route_category",
      "existing_route_kind",
      "existing_route_system",
      "move_vector_or_elevation_delta",
      "dry_run_move_preflight_review",
      "connected_network_audit",
      "post_move_readback",
      "reverse_move_revert_readback"
    );
  }
  if (item.target_class === "cad_link") {
    out.push(
      "cad_import_or_link_id",
      "cad_layer_or_subcategory_name",
      "requested_cad_lineweight",
      "cad_layer_graphics_readback"
    );
  }
  if (item.target_class === "view_filter") {
    out.push(
      "view_filter_name_or_criteria",
      "requested_filter_graphics_override",
      "filter_graphics_readback"
    );
  }
  if (item.target_class === "view_template") {
    out.push(
      "view_template_id_or_name",
      "template_controlled_view_id",
      "template_graphics_readback"
    );
  }
  if (item.target_class === "category_graphics") {
    out.push(
      "category_name",
      "requested_category_graphics_override",
      "category_graphics_readback"
    );
  }
  if (item.context_class === "linked_model" && item.target_class === "category_graphics") {
    out.push(
      "linked_model_instance_or_type_id",
      "linked_model_name",
      "linked_model_category_or_subcategory",
      "requested_linked_model_visibility_or_lineweight",
      "linked_model_category_graphics_readback"
    );
  }
  if (/\bphase(?:\s+filter|\s+mapping)?|demo(?:lition)?|removal|existing|new\s+construction|new\s+work\b/i.test(text)) {
    out.push(
      "target_phase_name_or_id",
      "target_phase_filter_name_or_id",
      "linked_model_phase_mapping_readback",
      "phase_filter_graphics_readback"
    );
  }
  if (/\b1\s*\/\s*16\b|\b1\/16\b|\bscale\b|\bsmall\s+scale\b/i.test(text)) {
    out.push(
      "plan_scale_context",
      "scale_specific_target_view_id",
      "scale_specific_graphics_readback"
    );
  }
  if (/\bfuture\b|\bnew\s+work\b|\bhidden\s+line\b|\blight\s+hidden\b|\bhalftone\b/i.test(text)) {
    out.push(
      "future_or_new_work_element_scope",
      "requested_hidden_line_or_halftone_style"
    );
  }
  if (modeledMepGeometryRequest && /\btop\s+of\s+(?:pipe|duct)|tap\s+out|racked|rack|parallel\s+pipes?\b/i.test(text)) {
    out.push(
      "top_tap_orientation_evidence",
      "parallel_pipe_rack_context"
    );
  }
  if (modeledMepGeometryRequest && /\bdogleg|45\s*(?:deg|degree)|under|over|clearance|drop|offset\b/i.test(text)) {
    out.push(
      "drop_or_offset_height",
      "offset_angle_or_fitting_preference",
      "clearance_reference_element"
    );
  }
  if (modeledMepGeometryRequest && /\bmain\s+(?:duct|pipe)|existing\s+(?:duct|pipe|main)|connect(?:ed)?\s+to\s+(?:main|existing)\b/i.test(text)) {
    out.push(
      "host_segment_id_or_selection_region",
      "connected_endpoint_policy"
    );
  }
  if (asksForScopedMepSizing(text, item.operation_class, item.target_class)) {
    out.push(
      "sizing_scope_element_ids_or_region",
      "engineering_sizing_basis",
      "per_segment_size_readback"
    );
  }
  if (item.operation_class === "size_transition" && item.target_class === "duct" && /\b\d+\s*cfm\b/i.test(text)) {
    out.push("requested_cfm_or_airflow_basis");
  }
  return unique(out);
}

function liveBenchmarkQueue(items: RedlineCorpusClassification[]): RedlineCorpusBenchmarkQueueItem[] {
  const queue: RedlineCorpusBenchmarkQueueItem[] = [];
  for (const item of items) {
    if (item.manual_review_reason) continue;
    for (const taskId of item.recommended_benchmark_tasks) {
      queue.push({
        task_id: taskId,
        file_path: item.file_path,
        operation_class: item.operation_class,
        target_class: item.target_class,
        context_class: item.context_class,
        requires_model_write: item.requires_model_write,
        requires_visual_gate: item.requires_visual_gate,
        evidence_requirements: item.evidence_requirements,
        missing_live_inputs: unique([...missingLiveInputsForTask(taskId), ...contextualMissingLiveInputs(item)]),
        live_request_status: "needs_live_request_override",
        confidence: item.confidence,
        text_excerpt: item.text_excerpt
      });
    }
  }
  return queue.sort((a, b) => `${a.task_id}|${a.file_path}`.localeCompare(`${b.task_id}|${b.file_path}`));
}

function placeholderRequestForQueueItem(item: RedlineCorpusBenchmarkQueueItem): Record<string, unknown> {
  const base = {
    viewId: "__FILL_VERIFIED_VIEW_ID__",
    imageSize: 1800,
    corpusSourceFile: item.file_path,
    corpusOperationClass: item.operation_class,
    corpusTargetClass: item.target_class,
    cleanupCreatedElements: true
  };
  if (item.task_id === "demo_documentation_primitives") {
    const requestedDocumentationText = extractRequestedDocumentationText(item.text_excerpt, item.target_class);
    const existingDocumentationText = extractExistingDocumentationText(item.text_excerpt, item.target_class);
    const requestedGraphicsFacts = extractRequestedGraphicsFacts(item.text_excerpt);
    const linkedAndPhaseFacts = extractRequestedLinkedAndPhaseFacts(item.text_excerpt);
    const requestedTagFacts = extractRequestedTagFacts(item.text_excerpt);
    const scheduleFilterFacts = extractScheduleFilterFacts(item.text_excerpt);
    const request: Record<string, unknown> = {
      corpusSourceFile: item.file_path,
      viewId: "__FILL_VERIFIED_VIEW_OR_SHEET_ID__",
      visualViewId: "__FILL_VERIFIED_POST_CHANGE_CAPTURE_VIEW_OR_SHEET_ID__",
      visualVerify: true,
      cleanupCreatedElements: true,
      documentationIntent: item.text_excerpt,
    };
    const needsSchedule = item.target_class === "schedule";
    const needsTextNote = item.target_class === "text" || (item.operation_class === "text_edit" && item.target_class !== "schedule");
    const needsTag = item.operation_class === "tag" || item.target_class === "tag";
    const needsCad = item.target_class === "cad_link" || item.context_class === "cad_import";
    const needsCadReload =
      needsCad &&
      /\b(?:reload(?:ed|ing)?|refresh|update|confirm|verify)\b/i.test(item.text_excerpt) &&
      /\b(?:cad\s+files?|cad\s+links?|links?|dwg|xrefs?)\b/i.test(item.text_excerpt);
    const needsLinkedModelCategory = item.context_class === "linked_model" && item.target_class === "category_graphics";
    const needsPhase = /\bphase(?:\s+filter|\s+mapping)?|demo(?:lition)?|removal|existing|new\s+construction|new\s+work\b/i.test(item.text_excerpt);
    const needsViewFilter = item.target_class === "view_filter";
    const needsViewTemplate = item.target_class === "view_template";
    const needsCategoryGraphics =
      item.target_class === "category_graphics" &&
      item.context_class !== "linked_model" &&
      item.context_class !== "cad_import";
    const needsGeneralGraphics =
      item.operation_class === "graphics_override" &&
      !needsCad &&
      !needsLinkedModelCategory &&
      !needsViewFilter &&
      !needsViewTemplate &&
      !needsCategoryGraphics;

    if (needsSchedule) {
      request.schedule = {
        useExisting: true,
        scheduleId: "__FILL_EXISTING_SCHEDULE_VIEW_ID__",
        name: "__FILL_SCHEDULE_NAME_OR_BENCHMARK_SAFE_NAME__",
        category: scheduleFilterFacts.category ?? "__FILL_SCHEDULE_CATEGORY__",
        fields: scheduleFilterFacts.fields ?? ["__FILL_SCHEDULE_FIELD_NAME__"]
      };
      request.configureSchedule = {
        requireExistingScheduleTarget: true,
        addFields: ["__FILL_OPTIONAL_FIELD_TO_ADD__"],
        filters: [
          {
            field: scheduleFilterFacts.field ?? "__FILL_FIELD_OR_COLUMN_NAME__",
            op: scheduleFilterFacts.op ?? "__FILL_FILTER_OPERATOR_IF_NEEDED__",
            value: scheduleFilterFacts.value ?? "__FILL_FILTER_VALUE_IF_NEEDED__"
          }
        ],
        sortGroup: [
          {
            field: "__FILL_SORT_FIELD_IF_NEEDED__",
            ascending: true
          }
        ],
        columnWidths: [
          {
            field: "__FILL_COLUMN_WIDTH_FIELD_IF_NEEDED__",
            widthFeet: "__FILL_COLUMN_WIDTH_FEET_IF_NEEDED__"
          }
        ],
        targetFieldName: "__FILL_TARGET_SCHEDULE_FIELD_OR_COLUMN__",
        targetRowKey: "__FILL_TARGET_SCHEDULE_ROW_KEY_OR_ELEMENT_ID__",
        targetCellId: "__FILL_TARGET_SCHEDULE_CELL_ID_IF_AVAILABLE__",
        requestedTextOrValue: requestedDocumentationText ?? "__FILL_REQUESTED_SCHEDULE_TEXT_OR_VALUE__",
        readbackRequired: true
      };
    }

    if (needsTextNote) {
      request.textNote = item.operation_class === "text_edit"
        ? {
            editExisting: true,
            viewId: "__FILL_TEXT_NOTE_VIEW_ID__",
            textNoteId: "__FILL_EXISTING_TEXT_NOTE_ID__",
            expectedExistingText: existingDocumentationText ?? "__FILL_EXISTING_TEXT_NOTE_TEXT_OR_SEARCH_SNIPPET__",
            text: requestedDocumentationText ?? "__FILL_REQUESTED_TEXT_NOTE_VALUE__",
            readbackRequired: true,
            revertAfterVerify: true
          }
        : {
            viewId: "__FILL_TEXT_NOTE_VIEW_ID__",
            x: "__FILL_TEXT_NOTE_X__",
            y: "__FILL_TEXT_NOTE_Y__",
            text: requestedDocumentationText ?? "__FILL_REQUESTED_TEXT_NOTE_VALUE__",
            readbackRequired: true
          };
    }

    if (needsTag) {
      request.tag = item.operation_class === "text_edit"
        ? {
            editExistingValue: true,
            ...(requestedTagFacts.requestedTagKindHint ? { requestedTagKindHint: requestedTagFacts.requestedTagKindHint } : {}),
            ...(requestedTagFacts.requestedTagValueHint ? { requestedTagValueHint: requestedTagFacts.requestedTagValueHint } : {}),
            ...(requestedTagFacts.requestedNoteNumberHint ? { requestedNoteNumberHint: requestedTagFacts.requestedNoteNumberHint } : {}),
            ...(requestedTagFacts.targetScopeHint ? { targetScopeHint: requestedTagFacts.targetScopeHint } : {}),
            viewId: "__FILL_TAG_TARGET_VIEW_ID__",
            existingTagIds: ["__FILL_EXISTING_VISIBLE_TAG_ID__"],
            elementIds: ["__FILL_TAGGED_ELEMENT_ID__"],
            valueSourceParameterName: "__FILL_TAG_VALUE_SOURCE_PARAMETER__",
            expectedExistingValue: existingDocumentationText ?? "__FILL_EXISTING_TAG_VALUE__",
            requestedTagValueHint: requestedTagFacts.requestedTagValueHint ?? requestedDocumentationText ?? "__FILL_REQUESTED_TAG_VALUE__",
            readbackRequired: true,
            revertAfterVerify: true
          }
        : {
            ...(requestedTagFacts.requestedTagKindHint ? { requestedTagKindHint: requestedTagFacts.requestedTagKindHint } : {}),
            ...(requestedTagFacts.requestedTagValueHint ? { requestedTagValueHint: requestedTagFacts.requestedTagValueHint } : {}),
            ...(requestedTagFacts.requestedNoteNumberHint ? { requestedNoteNumberHint: requestedTagFacts.requestedNoteNumberHint } : {}),
            ...(requestedTagFacts.targetScopeHint ? { targetScopeHint: requestedTagFacts.targetScopeHint } : {}),
            viewId: "__FILL_TAG_TARGET_VIEW_ID__",
            elementIds: ["__FILL_TAGGABLE_ELEMENT_ID__"],
            tagTypeId: "__FILL_OPTIONAL_TAG_TYPE_ID__",
            onlyUntagged: false,
            addLeader: "__FILL_TRUE_IF_LEADER_REQUIRED__",
            readbackRequired: true
          };
    }

    if (needsCategoryGraphics || needsGeneralGraphics) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.categoryVisibility = {
        action: "set_category_override",
        ...(requestedGraphicsFacts.targetHint ? { requestedTargetHint: requestedGraphicsFacts.targetHint } : {}),
        ...(requestedGraphicsFacts.visibilityIntentHint ? { visibilityIntentHint: requestedGraphicsFacts.visibilityIntentHint } : {}),
        categoryName: "__FILL_CATEGORY_NAME__",
        lineWeight: requestedGraphicsFacts.lineWeight ?? "__FILL_LINEWEIGHT__",
        readbackRequired: true,
        revertAfterVerify: true
      };
    }

    if (needsViewFilter || needsGeneralGraphics || /\bfuture\b|\bnew\s+work\b|\bhidden\s+line\b|\blight\s+hidden\b|\bhalftone\b/i.test(item.text_excerpt)) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.filterVisibility = {
        ...(requestedGraphicsFacts.targetHint ? { requestedTargetHint: requestedGraphicsFacts.targetHint } : {}),
        ...(requestedGraphicsFacts.visibilityIntentHint ? { visibilityIntentHint: requestedGraphicsFacts.visibilityIntentHint } : {}),
        filterName: "__FILL_FILTER_NAME__",
        createFilter: {
          categoryName: "__FILL_FILTER_CATEGORY__",
          ruleParameterName: "__FILL_FILTER_PARAMETER__",
          ruleOperator: "__FILL_FILTER_RULE_OPERATOR__",
          ruleValue: "__FILL_FILTER_VALUE__"
        },
        action: "apply_view_filter",
        lineWeight: requestedGraphicsFacts.lineWeight ?? "__FILL_LINEWEIGHT__",
        readbackRequired: true,
        revertAfterVerify: true
      };
    }

    if (needsViewTemplate) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.templateCategoryVisibility = {
        action: "set_category_override",
        requireExistingTemplateTarget: true,
        existingTemplateId: "__FILL_EXISTING_VIEW_TEMPLATE_ID__",
        existingTemplateName: "__FILL_EXISTING_VIEW_TEMPLATE_NAME__",
        controlledViewId: "__FILL_TEMPLATE_CONTROLLED_VIEW_ID__",
        ...(requestedGraphicsFacts.targetHint ? { requestedTargetHint: requestedGraphicsFacts.targetHint } : {}),
        ...(requestedGraphicsFacts.visibilityIntentHint ? { visibilityIntentHint: requestedGraphicsFacts.visibilityIntentHint } : {}),
        categoryName: "__FILL_TEMPLATE_CATEGORY_NAME__",
        lineWeight: requestedGraphicsFacts.lineWeight ?? "__FILL_LINEWEIGHT__",
        readbackRequired: true,
        revertAfterVerify: true
      };
    }

    if (needsCadReload) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.cadReload = {
        preflightOnly: true,
        existingCadLinkIds: ["__FILL_EXISTING_CAD_IMPORT_OR_LINK_ID__"],
        expectedCadLinkName: "__FILL_EXISTING_CAD_LINK_NAME_OR_DWG_BASENAME__",
        expectedSourcePath: "__FILL_EXISTING_CAD_SOURCE_PATH_IF_AVAILABLE__",
        ownerViewId: "__FILL_CAD_OWNER_VIEW_ID__",
        targetSheetId: "__FILL_TARGET_SHEET_ID_IF_SHEET_SPECIFIC__",
        readbackRequired: true,
        applyReload: false
      };
    } else if (needsCad) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.cadLink = {
        sourcePath: "__FILL_DWG_PATH_IF_CAD_COMMENT__",
        ownerViewBoundingBoxRequired: true
      };
      request.cadGraphicsOverride = {
        ...(requestedGraphicsFacts.targetHint ? { requestedTargetHint: requestedGraphicsFacts.targetHint } : {}),
        ...(requestedGraphicsFacts.visibilityIntentHint ? { visibilityIntentHint: requestedGraphicsFacts.visibilityIntentHint } : {}),
        cadImportOrLinkId: "__FILL_CAD_IMPORT_OR_LINK_ID__",
        layerOrSubcategoryName: "__FILL_CAD_LAYER_OR_SUBCATEGORY_NAME__",
        lineWeight: requestedGraphicsFacts.lineWeight ?? "__FILL_CAD_LINEWEIGHT__",
        readbackRequired: true
      };
    }

    if (needsLinkedModelCategory) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.linkedModelCategoryVisibility = {
        ...(linkedAndPhaseFacts.linkedModelCategoryHint ? { linkedModelCategoryHint: linkedAndPhaseFacts.linkedModelCategoryHint } : {}),
        ...(linkedAndPhaseFacts.linkedVisibilityIntentHint ? { linkedVisibilityIntentHint: linkedAndPhaseFacts.linkedVisibilityIntentHint } : {}),
        linkedModelInstanceOrTypeId: "__FILL_LINKED_MODEL_INSTANCE_OR_TYPE_ID__",
        linkedModelName: "__FILL_LINKED_MODEL_NAME__",
        categoryName: "__FILL_LINKED_MODEL_CATEGORY_OR_SUBCATEGORY__",
        lineWeight: requestedGraphicsFacts.lineWeight ?? "__FILL_LINKED_MODEL_LINEWEIGHT__",
        readbackRequired: true,
        revertAfterVerify: true
      };
    }

    if (needsPhase) {
      request.graphicsOverrideIntent = item.text_excerpt;
      request.phaseVisibility = {
        ...(linkedAndPhaseFacts.phaseNameHint ? { phaseNameHint: linkedAndPhaseFacts.phaseNameHint } : {}),
        ...(linkedAndPhaseFacts.phaseFilterHint ? { phaseFilterHint: linkedAndPhaseFacts.phaseFilterHint } : {}),
        ...(linkedAndPhaseFacts.phaseMappingIntentHint ? { phaseMappingIntentHint: linkedAndPhaseFacts.phaseMappingIntentHint } : {}),
        phaseName: "__FILL_TARGET_PHASE_NAME_OR_ID__",
        phaseFilterName: "__FILL_TARGET_PHASE_FILTER_NAME_OR_ID__",
        originalPhaseName: "__FILL_ORIGINAL_PHASE_NAME_OR_ID__",
        originalPhaseFilterName: "__FILL_ORIGINAL_PHASE_FILTER_NAME_OR_ID__",
        readbackRequired: true,
        revertAfterVerify: true
      };
    }

    return request;
  }
  if (item.task_id === "demo_redline_mep_route" || item.task_id === "demo_redline_mep_pipe_route") {
    const isPipe = item.task_id === "demo_redline_mep_pipe_route";
    const requestedFacts = extractRequestedMepFacts(item.text_excerpt, item.target_class);
    const requestedSize = requestedFacts.requestedSize ?? requestedFacts.sizes[0];
    const requestedAirflow = requestedFacts.airflow[0];
    return {
      ...base,
      imageSize: 2200,
      kind: isPipe ? "pipe" : "duct",
      visualViewId: "__FILL_VERIFIED_VIEW_ID_FOR_FOCUSED_CAPTURE__",
      roomNumber: "__FILL_ROOM_OR_SPACE_NUMBER__",
      levelName: "__FILL_LEVEL_NAME__",
      systemType: requestedFacts.systemHint ?? "__FILL_SYSTEM_TYPE__",
      ...(requestedAirflow ? { requestedAirflowHint: requestedAirflow } : {}),
      ...(isPipe ? { pipeSize: requestedSize ?? "__FILL_PIPE_SIZE__" } : { ductSize: requestedSize ?? "__FILL_DUCT_SIZE__" }),
      routingMode: "polyline",
      connectSegments: true,
      dryRunFirst: true,
      dryRunPreviewReviewed: "__FILL_DRY_RUN_ROUTE_PREVIEW_REVIEWED_TRUE__",
      endpointGrounding: {
        connectorIds: ["__FILL_ENDPOINT_CONNECTOR_ID_1__", "__FILL_ENDPOINT_CONNECTOR_ID_2__"],
        hostElementIds: ["__FILL_OPTIONAL_ENDPOINT_HOST_ELEMENT_ID_1__", "__FILL_OPTIONAL_ENDPOINT_HOST_ELEMENT_ID_2__"],
        allowOpenEndsForDisposableBenchmark: "__FILL_TRUE_ONLY_FOR_DISPOSABLE_STANDALONE_ROUTE__",
        openEndPolicy: "__FILL_ENDPOINT_GROUNDING_OR_OPEN_END_POLICY__"
      },
      verify: true,
      apply: true,
      visualVerify: true,
      focusPaddingFt: 8,
      toleranceFt: 1,
      points: [
        { x: "__FILL_X1__", y: "__FILL_Y1__" },
        { x: "__FILL_X2__", y: "__FILL_Y2__" }
      ]
    };
  }
  if (item.task_id === "demo_redline_mep_duct_tap_branch" || item.task_id === "demo_redline_mep_pipe_tap_branch") {
    const isPipe = item.task_id.includes("pipe");
    const requestedFacts = extractRequestedMepFacts(item.text_excerpt, item.target_class);
    const requestedSize = requestedFacts.requestedSize ?? requestedFacts.sizes[0];
    const requestedAirflow = requestedFacts.airflow[0];
    return {
      ...base,
      imageSize: 2200,
      toolPath: "/revit/connect-mep-branch",
      kind: isPipe ? "pipe" : "duct",
      mainElementId: "__FILL_MAIN_ROUTE_ELEMENT_ID__",
      projectedTapPoint: { x: "__FILL_TAP_X__", y: "__FILL_TAP_Y__", z: "__FILL_TAP_Z__" },
      connectionMode: "__FILL_TEE_OR_TAP__",
      fittingTypeId: "__FILL_COMPATIBLE_TEE_OR_TAP_FITTING_TYPE_ID__",
      systemType: requestedFacts.systemHint ?? "__FILL_SYSTEM_TYPE__",
      levelName: "__FILL_LEVEL_NAME__",
      ...(requestedAirflow ? { requestedAirflowHint: requestedAirflow } : {}),
      ...(isPipe ? { pipeSize: requestedSize ?? "__FILL_BRANCH_PIPE_SIZE__", orientation: "__FILL_TOP_OR_SIDE_TAP_ORIENTATION__" } : { ductSize: requestedSize ?? "__FILL_BRANCH_DUCT_SIZE__" }),
      branchPoints: [
        { x: "__FILL_BRANCH_X1__", y: "__FILL_BRANCH_Y1__", z: "__FILL_BRANCH_Z1__" },
        { x: "__FILL_BRANCH_X2__", y: "__FILL_BRANCH_Y2__", z: "__FILL_BRANCH_Z2__" }
      ],
      dryRunFirst: true,
      verifyConnectorNetwork: true,
      visualVerify: true,
      visualViewId: "__FILL_VERIFIED_VIEW_ID__",
      cleanupCreatedElements: true
    };
  }
  if (item.task_id === "demo_redline_mep_duct_reroute" || item.task_id === "demo_redline_mep_pipe_reroute") {
    const isPipe = item.task_id.includes("pipe");
    return {
      ...base,
      imageSize: 2200,
      toolPath: "/revit/reroute-mep-route-segment",
      kind: isPipe ? "pipe" : "duct",
      hostElementId: "__FILL_HOST_ROUTE_ELEMENT_ID__",
      splitPoints: [
        { x: "__FILL_SPLIT1_X__", y: "__FILL_SPLIT1_Y__", z: "__FILL_SPLIT1_Z__" },
        { x: "__FILL_SPLIT2_X__", y: "__FILL_SPLIT2_Y__", z: "__FILL_SPLIT2_Z__" }
      ],
      offsetVector: { x: "__FILL_OFFSET_DX__", y: "__FILL_OFFSET_DY__", z: "__FILL_OFFSET_DZ__" },
      offsetMode: "__FILL_DOGLEG_45_OR_VERTICAL_DROP__",
      preserveConnectedEndpoints: "__FILL_TRUE_ONLY_IF_DRY_RUN_ENDPOINT_PLAN_MATCHES__",
      expectedFittings: "__FILL_ELBOW_OR_TRANSITION_FITTING_EXPECTATION__",
      dryRunFirst: true,
      verifyConnectorNetwork: true,
      visualVerify: true,
      visualViewId: "__FILL_VERIFIED_VIEW_ID__",
      cleanupCreatedElements: true
    };
  }
  if (item.task_id === "demo_redline_mep_duct_size_transition" || item.task_id === "demo_redline_mep_pipe_size_transition") {
    const isPipe = item.task_id.includes("pipe");
    const requestedFacts = extractRequestedMepFacts(item.text_excerpt, item.target_class);
    const requestedSize = requestedFacts.requestedSize ?? requestedFacts.sizes[0];
    const requestedAirflow = requestedFacts.airflow[0];
    return {
      ...base,
      imageSize: 2200,
      toolPath: "/revit/reroute-mep-route-segment",
      operation: "size_transition",
      kind: isPipe ? "pipe" : "duct",
      hostElementId: "__FILL_HOST_ROUTE_ELEMENT_ID__",
      sizingScope: {
        elementIds: ["__FILL_SCOPE_ELEMENT_ID_1__", "__FILL_SCOPE_ELEMENT_ID_2__"],
        region: "__FILL_OPTIONAL_MARKED_REGION_OR_ROOM_SPACE_BAND__",
        engineeringSizingBasis: requestedAirflow ? `Corpus requested airflow: ${requestedAirflow}` : "__FILL_ENGINEERING_SIZING_BASIS__",
        perSegmentReadbackRequired: true
      },
      transitionPoint: {
        x: "__FILL_PROJECTED_TRANSITION_POINT_X__",
        y: "__FILL_PROJECTED_TRANSITION_POINT_Y__",
        z: "__FILL_OPTIONAL_PROJECTED_TRANSITION_POINT_Z__"
      },
      transitionNormalized: "__FILL_TRANSITION_NORMALIZED_0_TO_1__",
      transitionChainageFt: "__FILL_OPTIONAL_TRANSITION_CHAINAGE_FT__",
      ...(isPipe
        ? { upstreamPipeSize: "__FILL_UPSTREAM_PIPE_SIZE__", downstreamPipeSize: requestedSize ?? "__FILL_DOWNSTREAM_PIPE_SIZE__" }
        : { upstreamDuctSize: "__FILL_UPSTREAM_DUCT_SIZE__", downstreamDuctSize: requestedSize ?? "__FILL_DOWNSTREAM_DUCT_SIZE__" }),
      expectedFitting: "__FILL_TRANSITION_FITTING_EXPECTATION__",
      dryRunFirst: true,
      verifyConnectorNetwork: true,
      visualVerify: true,
      visualViewId: "__FILL_VERIFIED_VIEW_ID__",
      cleanupCreatedElements: true
    };
  }
  if (item.task_id === "demo_parameter_edit" || item.task_id === "demo_redline_update_parameter" || item.task_id === "demo_redline_text_edit_mep_accessory") {
    const isAccessoryParameterEdit = item.task_id === "demo_redline_text_edit_mep_accessory";
    return {
      ...base,
      elementIds: [isAccessoryParameterEdit ? "__FILL_EXISTING_MEP_ACCESSORY_ELEMENT_ID__" : "__FILL_TARGET_ELEMENT_ID__"],
      parameterName: "__FILL_PARAMETER_NAME__",
      value: "__FILL_REQUESTED_PARAMETER_VALUE__",
      oldValue: "__FILL_CURRENT_PARAMETER_VALUE_FOR_REVERT__",
      ...(isAccessoryParameterEdit
        ? {
            targetKind: "mep_accessory",
            targetGrounding: {
              expectedCategory: "__FILL_OST_DUCTACCESSORY_OR_OST_PIPEACCESSORY__",
              expectedFamilyName: "__FILL_EXISTING_ACCESSORY_FAMILY_NAME__",
              expectedTypeName: "__FILL_EXISTING_ACCESSORY_TYPE_NAME__"
            }
          }
        : {}),
      dryRunFirst: true,
      readbackRequired: true,
      revertAfterVerify: true,
      visualVerify: true,
      visualViewId: "__FILL_VERIFIED_VIEW_ID__"
    };
  }
  if (item.task_id === "demo_redline_delete_duct_route" || item.task_id === "demo_redline_delete_pipe_route" || item.task_id === "demo_redline_move_duct_route" || item.task_id === "demo_redline_move_pipe_route") {
    const isPipe = item.task_id.includes("pipe");
    const elevationMove = extractRequestedMepElevationMove(item.text_excerpt);
    const hasElevationMove = item.task_id.includes("_move_") && (elevationMove.deltaFt !== undefined || elevationMove.hint);
    if (item.task_id === "demo_redline_delete_duct_route" || item.task_id === "demo_redline_delete_pipe_route") {
      return {
        ...base,
        imageSize: 2200,
        targetKind: isPipe ? "pipe_route" : "duct_route",
        kind: isPipe ? "pipe" : "duct",
        existingTarget: {
          deleteExisting: true,
          elementIds: [isPipe ? "__FILL_EXISTING_PIPE_ROUTE_ELEMENT_ID__" : "__FILL_EXISTING_DUCT_ROUTE_ELEMENT_ID__"],
          expectedKind: isPipe ? "pipe" : "duct",
          expectedCategory: isPipe ? "OST_PipeCurves" : "OST_DuctCurves",
          expectedSystemName: "__FILL_EXISTING_ROUTE_SYSTEM_NAME__",
          readbackRequired: true,
          connectedNetworkAuditRequired: true
        },
        applyExistingDelete: false,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    return {
      ...base,
      imageSize: 2200,
      targetKind: isPipe ? "pipe_route" : "duct_route",
      kind: isPipe ? "pipe" : "duct",
      existingTarget: {
        moveExisting: true,
        elementIds: [isPipe ? "__FILL_EXISTING_PIPE_ROUTE_ELEMENT_ID__" : "__FILL_EXISTING_DUCT_ROUTE_ELEMENT_ID__"],
        expectedKind: isPipe ? "pipe" : "duct",
        expectedCategory: isPipe ? "OST_PipeCurves" : "OST_DuctCurves",
        expectedSystemName: "__FILL_EXISTING_ROUTE_SYSTEM_NAME__",
        readbackRequired: true,
        connectedNetworkAuditRequired: true
      },
      dryRunPreflightReviewed: "__FILL_DRY_RUN_ROUTE_MOVE_PREFLIGHT_REVIEWED_TRUE__",
      visualVerify: true,
      revertAfterVerify: true,
      visualViewId: "__FILL_VERIFIED_VIEW_ID__",
      ...(item.task_id.includes("_move_")
        ? {
            move: {
              vectorX: hasElevationMove ? 0 : "__FILL_DX__",
              vectorY: hasElevationMove ? 0 : "__FILL_DY__",
              vectorZ: elevationMove.deltaFt ?? (hasElevationMove ? "__FILL_ELEVATION_DELTA_FT_OR_TARGET_Z__" : 0),
              ...(elevationMove.hint ? { requestedElevationHint: elevationMove.hint } : {}),
              behavior: "allOrNothing"
            }
          }
        : {})
    };
  }
  if (item.task_id === "demo_redline_type_change_duct" || item.task_id === "demo_redline_type_change_device" || item.task_id === "demo_redline_type_change_mep_accessory") {
    const typeFacts = extractRequestedTypeChangeFacts(item.text_excerpt);
    const isAccessory = item.task_id === "demo_redline_type_change_mep_accessory";
    return {
      viewId: "__FILL_VERIFIED_VIEW_ID__",
      visualViewId: "__FILL_VERIFIED_VIEW_ID__",
      imageSize: 1800,
      elementIds: [isAccessory ? "__FILL_SOURCE_MEP_ACCESSORY_ELEMENT_ID__" : "__FILL_SOURCE_ELEMENT_ID__"],
      ...(typeFacts.existingTypeHint ? { existingTypeHint: typeFacts.existingTypeHint } : {}),
      ...(typeFacts.requestedTypeHint ? { requestedTypeHint: typeFacts.requestedTypeHint } : {}),
      targetTypeId: "__FILL_COMPATIBLE_TARGET_TYPE_ID__",
      category: item.task_id === "demo_redline_type_change_duct" ? "OST_DuctCurves" : isAccessory ? "__FILL_MEP_ACCESSORY_CATEGORY__" : "__FILL_SOURCE_CATEGORY__",
      ...(isAccessory ? {
        sourceFamilyGrounding: {
          expectedFamilyName: "__FILL_SOURCE_ACCESSORY_FAMILY_NAME__",
          expectedTypeName: "__FILL_SOURCE_ACCESSORY_TYPE_NAME__",
          expectedCategory: "__FILL_SOURCE_ACCESSORY_CATEGORY__"
        }
      } : {}),
      sourceTypeGrounding: {
        expectedCurrentTypeId: "__FILL_SOURCE_CURRENT_TYPE_ID__",
        expectedCurrentTypeName: "__FILL_SOURCE_CURRENT_TYPE_NAME__"
      },
      dryRunPreflightReviewed: "__FILL_DRY_RUN_TYPE_CHANGE_PREFLIGHT_REVIEWED_TRUE__",
      targetTypeCompatibilityReviewed: "__FILL_TARGET_TYPE_COMPATIBILITY_REVIEWED_TRUE__",
      visualVerify: true,
      revertAfterVerify: true,
      corpusSourceFile: item.file_path
    };
  }
  if (item.task_id === "demo_redline_receptacles") {
    return {
      viewId: "__FILL_VERIFIED_VIEW_ID__",
      cleanupCreatedElements: true,
      placements: [
        {
          exemplarElementId: "__FILL_EXEMPLAR_RECEPTACLE_ID__",
          hostElementId: "__FILL_HOST_OR_LINK_ID__",
          targetChainageFt: "__FILL_TARGET_CHAINAGE_FT__",
          matchOrientationFromSource: true,
          matchElectricalCircuitFromSource: true,
          parameterOverrides: {
            Comments: "CORPUS REDLINE",
            Mark: "__FILL_MARK__"
          }
        }
      ],
      corpusSourceFile: item.file_path
    };
  }
  if (/^demo_redline_(delete|move|rotate)_(text)$/.test(item.task_id)) {
    if (item.task_id === "demo_redline_delete_text") {
      const existingTextHint = extractExistingDocumentationText(item.text_excerpt, item.target_class);
      return {
        ...base,
        imageSize: 1800,
        targetKind: "text_note",
        textNote: {
          viewId: "__FILL_VERIFIED_VIEW_ID__",
          textNoteId: "__FILL_EXISTING_VISIBLE_TEXT_NOTE_ID__",
          expectedExistingText: existingTextHint ?? "__FILL_EXISTING_TEXT_NOTE_VALUE__",
          readbackRequired: true
        },
        existingTarget: {
          deleteExisting: true,
          elementIds: ["__FILL_EXISTING_VISIBLE_TEXT_NOTE_ID__"],
          expectedCategory: "OST_TextNotes",
          expectedText: existingTextHint ?? "__FILL_EXISTING_TEXT_NOTE_VALUE__",
          readbackRequired: true
        },
        applyExistingDelete: false,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    return {
      ...base,
      targetKind: "text_note",
      textNote: {
        viewId: "__FILL_VERIFIED_VIEW_ID__",
        x: "__FILL_TEXT_NOTE_X__",
        y: "__FILL_TEXT_NOTE_Y__",
        text: "__FILL_DISPOSABLE_TEXT_NOTE_VALUE__"
      },
      ...(item.task_id.includes("_move_") ? { move: { vectorX: "__FILL_DX__", vectorY: "__FILL_DY__", vectorZ: 0 } } : {}),
      ...(item.task_id.includes("_rotate_")
        ? { rotate: { angleDegrees: "__FILL_ROTATION_DEGREES__", axis: { pointX: "__FILL_AXIS_X__", pointY: "__FILL_AXIS_Y__", pointZ: 0 } } }
        : {})
    };
  }
  if (/^demo_redline_(add|delete|move)_(tag)$/.test(item.task_id)) {
    const requestedTagFacts = extractRequestedTagFacts(item.text_excerpt);
    if (item.task_id === "demo_redline_delete_tag") {
      return {
        ...base,
        imageSize: 1800,
        targetKind: "tag",
        tag: {
          ...(requestedTagFacts.requestedTagKindHint ? { requestedTagKindHint: requestedTagFacts.requestedTagKindHint } : {}),
          ...(requestedTagFacts.requestedTagValueHint ? { expectedTagText: requestedTagFacts.requestedTagValueHint } : {}),
          ...(requestedTagFacts.requestedNoteNumberHint ? { expectedTagText: requestedTagFacts.requestedNoteNumberHint } : {}),
          ...(requestedTagFacts.targetScopeHint ? { targetScopeHint: requestedTagFacts.targetScopeHint } : {}),
          existingTagIds: ["__FILL_EXISTING_VISIBLE_TAG_ID__"],
          elementIds: ["__FILL_TAGGED_ELEMENT_ID_OR_REMOVE_IF_TEXT_GROUNDED__"],
          readbackRequired: true
        },
        existingTarget: {
          deleteExisting: true,
          elementIds: ["__FILL_EXISTING_VISIBLE_TAG_ID__"],
          expectedCategory: "__FILL_EXISTING_TAG_CATEGORY__",
          expectedTagText: requestedTagFacts.requestedTagValueHint ?? requestedTagFacts.requestedNoteNumberHint ?? "__FILL_EXISTING_TAG_VISIBLE_TEXT_OR_REMOVE_IF_TAGGED_ELEMENT_GROUNDED__",
          taggedElementIds: ["__FILL_TAGGED_ELEMENT_ID_OR_REMOVE_IF_TEXT_GROUNDED__"],
          readbackRequired: true
        },
        applyExistingDelete: false,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    if (item.task_id === "demo_redline_move_tag") {
      return {
        ...base,
        imageSize: 1800,
        targetKind: "tag",
        tag: {
          ...(requestedTagFacts.requestedTagKindHint ? { requestedTagKindHint: requestedTagFacts.requestedTagKindHint } : {}),
          ...(requestedTagFacts.requestedTagValueHint ? { expectedTagText: requestedTagFacts.requestedTagValueHint } : {}),
          ...(requestedTagFacts.requestedNoteNumberHint ? { expectedTagText: requestedTagFacts.requestedNoteNumberHint } : {}),
          ...(requestedTagFacts.targetScopeHint ? { targetScopeHint: requestedTagFacts.targetScopeHint } : {}),
          existingTagIds: ["__FILL_EXISTING_VISIBLE_TAG_ID__"],
          elementIds: ["__FILL_TAGGED_ELEMENT_ID_OR_REMOVE_IF_TEXT_GROUNDED__"],
          readbackRequired: true
        },
        existingTarget: {
          moveExisting: true,
          elementIds: ["__FILL_EXISTING_VISIBLE_TAG_ID__"],
          expectedCategory: "__FILL_EXISTING_TAG_CATEGORY__",
          expectedTagText: requestedTagFacts.requestedTagValueHint ?? requestedTagFacts.requestedNoteNumberHint ?? "__FILL_EXISTING_TAG_VISIBLE_TEXT_OR_REMOVE_IF_TAGGED_ELEMENT_GROUNDED__",
          taggedElementIds: ["__FILL_TAGGED_ELEMENT_ID_OR_REMOVE_IF_TEXT_GROUNDED__"],
          readbackRequired: true
        },
        move: {
          vectorX: "__FILL_DX__",
          vectorY: "__FILL_DY__",
          vectorZ: 0,
          behavior: "allOrNothing"
        },
        dryRunPreflightReviewed: "__FILL_DRY_RUN_TAG_MOVE_PREFLIGHT_REVIEWED_TRUE__",
        visualVerify: true,
        revertAfterVerify: true,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    return {
      ...base,
      targetKind: "tag",
      tag: {
        ...(requestedTagFacts.requestedTagKindHint ? { requestedTagKindHint: requestedTagFacts.requestedTagKindHint } : {}),
        ...(requestedTagFacts.requestedTagValueHint ? { requestedTagValueHint: requestedTagFacts.requestedTagValueHint } : {}),
        ...(requestedTagFacts.requestedNoteNumberHint ? { requestedNoteNumberHint: requestedTagFacts.requestedNoteNumberHint } : {}),
        ...(requestedTagFacts.targetScopeHint ? { targetScopeHint: requestedTagFacts.targetScopeHint } : {}),
        viewId: "__FILL_VERIFIED_VIEW_ID__",
        elementIds: ["__FILL_TAGGABLE_ELEMENT_ID__"],
        tagTypeName: "__FILL_TAG_TYPE_NAME_OR_FAMILY_SYMBOL__",
        onlyUntagged: false,
        addLeader: false,
        readbackRequired: true
      },
      visualVerify: true,
      ...(item.task_id.includes("_move_") ? { move: { vectorX: "__FILL_DX__", vectorY: "__FILL_DY__", vectorZ: 0 } } : {})
    };
  }
  if (/^demo_redline_(add|delete|move)_(receptacle|light|family_instance|mep_accessory)$/.test(item.task_id)) {
    const familyFacts = extractRequestedFamilyInstanceFacts(item.text_excerpt, item.target_class);
    const familyTargetLabel = item.target_class === "receptacle"
      ? "RECEPTACLE"
      : item.target_class === "light"
        ? "LIGHT_FIXTURE"
        : "FAMILY_INSTANCE";
    const familyCategoryPlaceholder = item.target_class === "receptacle"
      ? "__FILL_EXISTING_RECEPTACLE_CATEGORY__"
      : item.target_class === "light"
        ? "__FILL_EXISTING_LIGHT_FIXTURE_CATEGORY__"
        : "__FILL_EXISTING_FAMILY_INSTANCE_CATEGORY__";
    if (
      item.task_id === "demo_redline_delete_receptacle" ||
      item.task_id === "demo_redline_delete_light" ||
      item.task_id === "demo_redline_delete_family_instance"
    ) {
      return {
        ...base,
        imageSize: 2200,
        targetKind: "family_instance",
        existingTarget: {
          deleteExisting: true,
          elementIds: [`__FILL_EXISTING_${familyTargetLabel}_ELEMENT_ID__`],
          expectedFamilyName: familyFacts.requestedKindHint ?? `__FILL_EXISTING_${familyTargetLabel}_FAMILY_NAME__`,
          expectedTypeName: `__FILL_EXISTING_${familyTargetLabel}_TYPE_NAME__`,
          expectedCategory: familyCategoryPlaceholder,
          readbackRequired: true
        },
        applyExistingDelete: false,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    if (
      item.task_id === "demo_redline_move_receptacle" ||
      item.task_id === "demo_redline_move_light" ||
      item.task_id === "demo_redline_move_family_instance"
    ) {
      return {
        ...base,
        imageSize: 2200,
        targetKind: "family_instance",
        existingTarget: {
          moveExisting: true,
          elementIds: [`__FILL_EXISTING_${familyTargetLabel}_ELEMENT_ID__`],
          expectedFamilyName: familyFacts.requestedKindHint ?? `__FILL_EXISTING_${familyTargetLabel}_FAMILY_NAME__`,
          expectedTypeName: `__FILL_EXISTING_${familyTargetLabel}_TYPE_NAME__`,
          expectedCategory: familyCategoryPlaceholder,
          readbackRequired: true
        },
        move: {
          vectorX: "__FILL_DX__",
          vectorY: "__FILL_DY__",
          vectorZ: 0,
          behavior: "allOrNothing"
        },
        dryRunPreflightReviewed: "__FILL_DRY_RUN_FAMILY_INSTANCE_MOVE_PREFLIGHT_REVIEWED_TRUE__",
        visualVerify: true,
        revertAfterVerify: true,
        visualViewId: "__FILL_VERIFIED_VIEW_ID__",
        corpusSourceFile: item.file_path
      };
    }
    if (item.task_id === "demo_redline_delete_mep_accessory") {
      return {
        ...base,
        imageSize: 2200,
        targetKind: "mep_accessory",
        existingTarget: {
          deleteExisting: true,
          elementIds: ["__FILL_EXISTING_MEP_ACCESSORY_ELEMENT_ID__"],
          expectedFamilyName: familyFacts.requestedKindHint ?? "__FILL_EXISTING_ACCESSORY_FAMILY_NAME__",
          expectedTypeName: "__FILL_EXISTING_ACCESSORY_TYPE_NAME__",
          expectedCategory: "__FILL_EXISTING_ACCESSORY_CATEGORY__",
          readbackRequired: true
        },
        applyExistingDelete: false,
        corpusSourceFile: item.file_path
      };
    }
    if (item.task_id === "demo_redline_move_mep_accessory") {
      return {
        ...base,
        imageSize: 2200,
        targetKind: "mep_accessory",
        existingTarget: {
          moveExisting: true,
          elementIds: ["__FILL_EXISTING_MEP_ACCESSORY_ELEMENT_ID__"],
          expectedFamilyName: familyFacts.requestedKindHint ?? "__FILL_EXISTING_ACCESSORY_FAMILY_NAME__",
          expectedTypeName: "__FILL_EXISTING_ACCESSORY_TYPE_NAME__",
          expectedCategory: "__FILL_EXISTING_ACCESSORY_CATEGORY__",
          readbackRequired: true
        },
        move: {
          vectorX: "__FILL_DX__",
          vectorY: "__FILL_DY__",
          vectorZ: 0,
          behavior: "allOrNothing"
        },
        dryRunPreflightReviewed: "__FILL_DRY_RUN_MOVE_PREFLIGHT_REVIEWED_TRUE__",
        visualVerify: true,
        revertAfterVerify: true,
        corpusSourceFile: item.file_path
      };
    }
    return {
      ...base,
      targetKind: item.target_class === "mep_accessory" ? "mep_accessory" : item.target_class,
      familyInstance: {
        ...(familyFacts.requestedKindHint ? { requestedKindHint: familyFacts.requestedKindHint } : {}),
        ...(familyFacts.requestedSizeHint ? { requestedSizeHint: familyFacts.requestedSizeHint } : {}),
        familyName: "__FILL_FAMILY_NAME__",
        symbolName: "__FILL_SYMBOL_OR_TYPE_NAME__",
        levelName: "__FILL_LEVEL_NAME__",
        ...(item.target_class === "mep_accessory"
          ? {
              hostElementId: "__FILL_HOST_ROUTE_OR_REMOVE_AND_SET_ALLOW_UNHOSTED_POINT_PLACEMENT_TRUE__",
              placementBasis: "__FILL_HOSTED_ACCESSORY_OR_VERIFIED_UNHOSTED_POINT_BASIS__"
            }
          : {}),
        x: "__FILL_X__",
        y: "__FILL_Y__",
        z: "__FILL_Z__"
      },
      ...(item.task_id.includes("_move_") ? { move: { vectorX: "__FILL_DX__", vectorY: "__FILL_DY__", vectorZ: 0 } } : {})
    };
  }
  return base;
}

function collectPlaceholderPaths(value: unknown, prefix = "request"): string[] {
  const paths: string[] = [];
  const visit = (entry: unknown, currentPath: string): void => {
    if (typeof entry === "string") {
      if (entry.includes("__FILL_")) paths.push(currentPath);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      visit(child, `${currentPath}.${key}`);
    }
  };
  visit(value, prefix);
  return paths;
}

function liveOverrideTemplate(report: RedlineCorpusReport): RedlineCorpusLiveOverrideTemplate {
  const tasks: Record<string, RedlineCorpusLiveOverrideTemplateTask> = {};
  const taskCounts: Record<string, number> = {};
  for (const item of report.live_benchmark_queue) {
    const next = (taskCounts[item.task_id] ?? 0) + 1;
    taskCounts[item.task_id] = next;
    const key = next === 1 ? item.task_id : `${item.task_id}__corpus_${String(next).padStart(3, "0")}`;
    const request = placeholderRequestForQueueItem(item);
    const placeholderPaths = collectPlaceholderPaths(request);
    tasks[key] = {
      benchmark_task_id: item.task_id,
      request,
      ready_to_run: false,
      placeholder_paths: placeholderPaths,
      corpus_source: {
        file_path: item.file_path,
        operation_class: item.operation_class,
        target_class: item.target_class,
        context_class: item.context_class,
        confidence: item.confidence,
        missing_live_inputs: item.missing_live_inputs,
        requires_model_write: item.requires_model_write,
        requires_visual_gate: item.requires_visual_gate,
        evidence_requirements: item.evidence_requirements,
        text_excerpt: item.text_excerpt
      }
    };
  }
  const placeholderPaths = Object.values(tasks).flatMap((task) => task.placeholder_paths);
  return {
    schema_version: 1,
    generated_at: report.generated_at,
    source_dir: report.source_dir,
    status: "template_requires_verified_revit_ids",
    ready_to_run: false,
    placeholder_count: placeholderPaths.length,
    placeholder_task_count: Object.values(tasks).filter((task) => task.placeholder_paths.length > 0).length,
    instructions: [
      "This file is a fill-in template, not a runnable live override yet.",
      "Replace every __FILL_* placeholder with ids, types, levels, points, and paths discovered from the currently open Revit model.",
      "For keys ending in __corpus_###, use benchmark_task_id as the real runnable benchmark task id when promoting one filled request into OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON.",
      "Do not run this as an OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON override until placeholder_count is 0 in the filled copy.",
      "Do not mark modeled redline work complete unless the live run produces actual model write evidence and a passing visual gate.",
      "Rows that stayed in manual_review_items were intentionally excluded."
    ],
    tasks
  };
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function markdownTable(headers: string[], rows: unknown[][]): string {
  const header = `| ${headers.map(markdownCell).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function sortedCountRows(counts: Record<string, number>): unknown[][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => [key, count]);
}

function redlineCorpusReviewMarkdown(report: RedlineCorpusReport): string {
  const manualRows = report.manual_review_items.slice(0, 20).map((item) => [
    path.basename(item.file_path),
    item.operation_class,
    item.target_class,
    item.context_class,
    item.confidence,
    item.manual_review_reason ?? ""
  ]);
  const queueRows = report.live_benchmark_queue.slice(0, 20).map((item) => [
    item.task_id,
    path.basename(item.file_path),
    item.operation_class,
    item.target_class,
    item.context_class,
    item.requires_model_write ? "yes" : "no",
    item.requires_visual_gate ? "yes" : "no",
    item.missing_live_inputs.join(", ")
  ]);
  const sections = [
    "# Redline Corpus Review",
    "",
    `Generated: ${report.generated_at}`,
    `Source: ${report.source_dir ?? ""}`,
    "",
    "## Classification Summary",
    markdownTable(["metric", "value"], [
      ["input_count", report.input_count],
      ["classified_count", report.classified_count],
      ["manual_review_count", report.manual_review_count],
      ["live_benchmark_queue_count", report.live_benchmark_queue.length]
    ]),
    "",
    "## by_operation",
    markdownTable(["operation", "count"], sortedCountRows(report.by_operation)),
    "",
    "## by_target",
    markdownTable(["target", "count"], sortedCountRows(report.by_target)),
    "",
    "## by_context",
    markdownTable(["context", "count"], sortedCountRows(report.by_context)),
    "",
    "## by_evidence_requirement",
    markdownTable(["evidence_requirement", "count"], sortedCountRows(report.by_evidence_requirement)),
    "",
    "## by_model_write_requirement",
    markdownTable(["model_write_requirement", "count"], sortedCountRows(report.by_model_write_requirement)),
    "",
    "## by_visual_gate_requirement",
    markdownTable(["visual_gate_requirement", "count"], sortedCountRows(report.by_visual_gate_requirement)),
    "",
    "## by_recommended_task",
    markdownTable(["task_id", "count"], sortedCountRows(report.by_recommended_task)),
    "",
    "## Manual Review Items",
    manualRows.length > 0
      ? markdownTable(["file", "operation", "target", "context", "confidence", "reason"], manualRows)
      : "No manual-review items.",
    "",
    "## Live Queue Preview",
    queueRows.length > 0
      ? markdownTable(["task_id", "file", "operation", "target", "context", "model_write", "visual_gate", "missing_live_inputs"], queueRows)
      : "No live benchmark queue items.",
    "",
    "## Promotion Rules",
    "- Manual-review rows are excluded from the live benchmark queue until a human labels them.",
    "- `redline_corpus_live_request_template.json` is a scaffold marked `template_requires_verified_revit_ids`; copy it to `local-work` and fill verified ids, points, types, levels, and file paths before use.",
    "- Run `npm run benchmark -- validate-revit-requests --input <filled-override>` before a live benchmark. The filled copy must have `placeholder_count` 0 and no `__FILL_*` placeholders.",
    "- Modeled duct, pipe, and MEP accessory redlines still require actual model write evidence plus a passing visual gate before completion can be reported.",
    ""
  ];
  return sections.join("\n");
}

export function classifyRedlineCorpusText(input: RedlineCorpusInput): RedlineCorpusClassification {
  const text = (input.text ?? "").replace(/\s+/g, " ").trim();
  const nonActionableReason = !input.operation_class && !input.target_class
    ? nonActionableCompositeGroupReason(text) ?? nonActionableStatusMarkupReason(text) ?? nonActionableMepCalloutReason(text)
    : undefined;
  if (nonActionableReason) {
    return {
      file_path: input.file_path,
      operation_class: "unknown",
      target_class: "unknown",
      context_class: "unknown",
      modeled_mep: false,
      requires_model_write: false,
      requires_visual_gate: false,
      evidence_requirements: [],
      recommended_benchmark_tasks: [],
      source_kind: "filename",
      matched_rules: [nonActionableMatchedRule(nonActionableReason)],
      confidence: 0.9,
      manual_review_reason: nonActionableReason,
      text_excerpt: text.slice(0, 500)
    };
  }
  const op = firstMatching(text, OPERATION_RULES);
  const target = firstMatching(text, TARGET_RULES);
  const refined = refineTextLikeIntent(text, input.file_path, op.value, target.value, [...op.matched, ...target.matched]);
  let operation = input.operation_class ?? refined.operation as RedlineOperationClass;
  const targetClass = input.target_class ?? refined.target as RedlineTargetClass;
  const matchedRulesForClassification = [...refined.matchedRules];
  const graphicsTargets = ["cad_link", "view_filter", "view_template", "category_graphics"];
  if (
    !input.operation_class &&
    !input.target_class &&
    ["route", "tap_branch", "reroute_offset", "size_transition", "type_change"].includes(operation) &&
    graphicsTargets.includes(targetClass)
  ) {
    operation = "graphics_override";
    matchedRulesForClassification.push("intent_refine.graphics_target_over_modeled_operation");
  }
  const context = input.context_class ? { value: input.context_class, matched: ["review_label.context"] } : inferContext(text, targetClass);
  const evidence = unique([...evidenceFor(operation, targetClass), ...contextualEvidenceFor(text, operation, targetClass)]);
  const matchedRules = unique([
    ...matchedRulesForClassification,
    ...context.matched,
    ...(input.operation_class ? ["review_label.operation"] : []),
    ...(input.target_class ? ["review_label.target"] : [])
  ]);
  const modeledMep = ["duct", "pipe", "mep_accessory"].includes(targetClass);
  const inferredTargetFromFileContext = matchedRules.some((rule) => /^target\.file_context\./.test(rule));
  const maxConfidence = inferredTargetFromFileContext ? 0.9 : 0.95;
  const confidence = Math.min(maxConfidence, 0.25 + matchedRules.length * 0.18 + (evidence.length > 0 ? 0.12 : 0));
  const recommendedTasks = recommendedBenchmarkTasks(operation, targetClass);
  const roundedConfidence = Number(confidence.toFixed(2));
  const reviewReason = manualReviewReason({ operation, target: targetClass, confidence: roundedConfidence, recommendedTasks, matchedRules });
  return {
    file_path: input.file_path,
    operation_class: operation,
    target_class: targetClass,
    context_class: context.value,
    modeled_mep: modeledMep,
    requires_model_write: evidence.includes("model_write"),
    requires_visual_gate: evidence.includes("visual_gate"),
    evidence_requirements: evidence,
    recommended_benchmark_tasks: recommendedTasks,
    source_kind: "filename",
    matched_rules: matchedRules,
    confidence: roundedConfidence,
    ...(reviewReason ? { manual_review_reason: reviewReason } : {}),
    text_excerpt: text.slice(0, 500)
  };
}

const JSON_TEXT_KEYS = new Set([
  "action",
  "annotation_contents",
  "annotation_related_text",
  "comments",
  "contents",
  "description",
  "extracted_text",
  "intent",
  "label",
  "notes",
  "objective",
  "ocr_text",
  "operation",
  "related_text",
  "summary",
  "target",
  "text",
  "type"
]);

function collectJsonText(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 80 || depth > 8 || value === null || value === undefined) return out;
  if (typeof value === "string") {
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length >= 2) out.push(trimmed);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonText(entry, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (JSON_TEXT_KEYS.has(key.toLowerCase()) || Array.isArray(entry) || (entry && typeof entry === "object")) {
      collectJsonText(entry, out, depth + 1);
    }
    if (out.length >= 80) break;
  }
  return out;
}

function readSidecarText(filePath: string): { text: string; sidecar?: string; sourceKind: RedlineCorpusSourceKind } | null {
  const txt = `${filePath}.txt`;
  if (fs.existsSync(txt)) return { text: fs.readFileSync(txt, "utf8"), sidecar: txt, sourceKind: "sidecar_text" };
  const siblingTxt = filePath.replace(/\.[^.]+$/, ".txt");
  if (siblingTxt !== filePath && fs.existsSync(siblingTxt)) return { text: fs.readFileSync(siblingTxt, "utf8"), sidecar: siblingTxt, sourceKind: "sidecar_text" };
  const json = `${filePath}.json`;
  if (fs.existsSync(json)) {
    const value = JSON.parse(fs.readFileSync(json, "utf8"));
    return { text: unique(collectJsonText(value)).join("\n"), sidecar: json, sourceKind: "sidecar_json" };
  }
  return null;
}

function analyzerText(analyzed: RedlineAnalyzeResponse): string {
  const parts: string[] = [];
  parts.push(path.basename(analyzed.file_path));
  if (analyzed.primary_sheet_number) parts.push(`sheet ${analyzed.primary_sheet_number}`);
  for (const candidate of analyzed.sheet_candidates ?? []) {
    if (candidate.sheet_number) parts.push(`sheet ${candidate.sheet_number}`);
    if (candidate.evidence) parts.push(candidate.evidence);
  }
  for (const page of analyzed.pages ?? []) {
    if (page.text_excerpt) parts.push(page.text_excerpt);
    for (const candidate of page.sheet_candidates ?? []) {
      if (candidate.sheet_number) parts.push(`sheet ${candidate.sheet_number}`);
      if (candidate.evidence) parts.push(candidate.evidence);
    }
    for (const sample of page.annotation_summary?.sample ?? []) {
      if (sample.contents) parts.push(sample.contents);
      if (sample.is_delete_like) parts.push("delete");
    }
  }
  if (analyzed.ocr?.text_excerpt) parts.push(analyzed.ocr.text_excerpt);
  for (const region of analyzed.mark_regions ?? []) {
    if (region.annotation_contents) parts.push(region.annotation_contents);
    if (region.annotation_related_text) parts.push(region.annotation_related_text);
    if (region.annotation_is_delete_like) parts.push("delete");
  }
  for (const annotation of analyzed.pdf_annotations ?? []) {
    if (annotation.contents) parts.push(annotation.contents);
    if (annotation.related_text) parts.push(annotation.related_text);
    if (annotation.is_delete_like) parts.push("delete");
  }
  for (const route of analyzed.route_candidates ?? []) {
    if (route.label_text) parts.push(route.label_text);
    if (route.mep_kind_hint) parts.push(route.mep_kind_hint);
    if (route.size_text) parts.push(route.size_text);
    if (typeof route.airflow_cfm === "number") parts.push(`${route.airflow_cfm} CFM`);
    if (route.system_hint) parts.push(route.system_hint);
    if (route.geometry_role) parts.push(route.geometry_role);
    if (route.actionability) parts.push(route.actionability);
    for (const blocker of route.intent_blockers ?? []) parts.push(blocker);
    if (route.reason) parts.push(route.reason);
  }
  parts.push(...(analyzed.orientation_hints ?? []));
  return unique(parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean)).join("\n");
}

function countBy(items: RedlineCorpusClassification[], key: keyof Pick<RedlineCorpusClassification, "operation_class" | "target_class" | "context_class">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[String(item[key])] = (out[String(item[key])] ?? 0) + 1;
  return out;
}

function countQueueByTask(items: RedlineCorpusBenchmarkQueueItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.task_id] = (out[item.task_id] ?? 0) + 1;
  return out;
}

function countEvidenceRequirements(items: RedlineCorpusClassification[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    for (const requirement of item.evidence_requirements) out[requirement] = (out[requirement] ?? 0) + 1;
  }
  return out;
}

function countBooleanRequirement(items: RedlineCorpusClassification[], key: "requires_model_write" | "requires_visual_gate"): Record<"required" | "not_required", number> {
  const out: Record<"required" | "not_required", number> = { required: 0, not_required: 0 };
  for (const item of items) out[item[key] ? "required" : "not_required"] += 1;
  return out;
}

export function classifyRedlineCorpusDirectory(sourceDir: string): RedlineCorpusReport {
  const files = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir)
        .filter((name) => /\.(pdf|png|jpg|jpeg)$/i.test(name))
        .map((name) => path.join(sourceDir, name))
        .sort((a, b) => a.localeCompare(b))
    : [];
  const items = files.map((filePath) => {
    const sidecar = readSidecarText(filePath);
    if (sidecar) return { ...classifyRedlineCorpusText({ file_path: filePath, text: sidecar.text }), sidecar_path: sidecar.sidecar, source_kind: sidecar.sourceKind };
    return { ...classifyRedlineCorpusText({ file_path: filePath, text: path.basename(filePath) }), source_kind: "filename" as const };
  });
  return buildRedlineCorpusReport({ sourceDir, items });
}

export function buildRedlineCorpusReport(args: { sourceDir: string; items: RedlineCorpusClassification[] }): RedlineCorpusReport {
  const { sourceDir, items } = args;
  const manualReviewItems = items.filter((item) => item.manual_review_reason);
  const queue = liveBenchmarkQueue(items);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_dir: sourceDir,
    input_count: items.length,
    classified_count: items.length,
    by_operation: countBy(items, "operation_class"),
    by_target: countBy(items, "target_class"),
    by_context: countBy(items, "context_class"),
    by_evidence_requirement: countEvidenceRequirements(items),
    by_model_write_requirement: countBooleanRequirement(items, "requires_model_write"),
    by_visual_gate_requirement: countBooleanRequirement(items, "requires_visual_gate"),
    manual_review_count: manualReviewItems.length,
    manual_review_items: manualReviewItems,
    by_recommended_task: countQueueByTask(queue),
    live_benchmark_queue: queue,
    items
  };
}

export async function classifyRedlineCorpusDirectoryWithAnalyzer(sourceDir: string, options: RedlineCorpusAnalyzeOptions = {}): Promise<RedlineCorpusReport> {
  const files = fs.existsSync(sourceDir)
    ? fs.readdirSync(sourceDir)
        .filter((name) => /\.(pdf|png|jpg|jpeg)$/i.test(name))
        .map((name) => path.join(sourceDir, name))
        .sort((a, b) => a.localeCompare(b))
    : [];
  const items: RedlineCorpusClassification[] = [];
  for (const filePath of files) {
    const sidecar = readSidecarText(filePath);
    if (sidecar) {
      items.push({ ...classifyRedlineCorpusText({ file_path: filePath, text: sidecar.text }), sidecar_path: sidecar.sidecar, source_kind: sidecar.sourceKind });
      continue;
    }
    try {
      const analyzed = await analyzeRedlineFile({
        file_path: filePath,
        include_pdf_annotations: true,
        include_ocr_for_images: true,
        max_pages: options.maxPages,
        timeout_ms: options.timeoutMs
      });
      if (analyzed.ok) {
        items.push({ ...classifyRedlineCorpusText({ file_path: filePath, text: analyzerText(analyzed) }), source_kind: "analyzer" });
        continue;
      }
      items.push({
        ...classifyRedlineCorpusText({ file_path: filePath, text: path.basename(filePath) }),
        source_kind: "filename",
        manual_review_reason: `Analyzer failed: ${analyzed.warning ?? "unknown error"}`
      });
    } catch (error) {
      items.push({
        ...classifyRedlineCorpusText({ file_path: filePath, text: path.basename(filePath) }),
        source_kind: "filename",
        manual_review_reason: `Analyzer failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  return buildRedlineCorpusReport({ sourceDir, items });
}

export function writeRedlineCorpusReport(report: RedlineCorpusReport, outputDir: string): RedlineCorpusReportPaths {
  ensureDir(outputDir);
  const jsonPath = path.join(outputDir, "redline_corpus_classification.json");
  const csvPath = path.join(outputDir, "redline_corpus_classification.csv");
  const queueJsonPath = path.join(outputDir, "redline_corpus_live_benchmark_queue.json");
  const queueCsvPath = path.join(outputDir, "redline_corpus_live_benchmark_queue.csv");
  const liveOverrideTemplatePath = path.join(outputDir, "redline_corpus_live_request_template.json");
  const reviewMarkdownPath = path.join(outputDir, "redline_corpus_review.md");
  writeJsonFile(jsonPath, report);
  const rows = [
    ["file_path", "source_kind", "operation_class", "target_class", "context_class", "requires_model_write", "requires_visual_gate", "evidence_requirements", "recommended_benchmark_tasks", "confidence", "manual_review_reason", "matched_rules"].join(","),
    ...report.items.map((item) => [
      item.file_path,
      item.source_kind,
      item.operation_class,
      item.target_class,
      item.context_class,
      String(item.requires_model_write),
      String(item.requires_visual_gate),
      item.evidence_requirements.join("|"),
      item.recommended_benchmark_tasks.join("|"),
      String(item.confidence),
      item.manual_review_reason ?? "",
      item.matched_rules.join("|")
    ].map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`).join(","))
  ];
  writeTextFile(csvPath, rows.join("\n") + "\n");
  writeJsonFile(queueJsonPath, {
    schema_version: 1,
    generated_at: report.generated_at,
    source_dir: report.source_dir,
    queue_count: report.live_benchmark_queue.length,
    by_evidence_requirement: report.by_evidence_requirement,
    by_model_write_requirement: report.by_model_write_requirement,
    by_visual_gate_requirement: report.by_visual_gate_requirement,
    by_recommended_task: report.by_recommended_task,
    items: report.live_benchmark_queue
  });
  const queueRows = [
    ["task_id", "file_path", "operation_class", "target_class", "context_class", "requires_model_write", "requires_visual_gate", "missing_live_inputs", "evidence_requirements", "confidence"].join(","),
    ...report.live_benchmark_queue.map((item) => [
      item.task_id,
      item.file_path,
      item.operation_class,
      item.target_class,
      item.context_class,
      String(item.requires_model_write),
      String(item.requires_visual_gate),
      item.missing_live_inputs.join("|"),
      item.evidence_requirements.join("|"),
      String(item.confidence)
    ].map((value) => `"${String(value).replaceAll("\"", "\"\"")}"`).join(","))
  ];
  writeTextFile(queueCsvPath, queueRows.join("\n") + "\n");
  writeJsonFile(liveOverrideTemplatePath, liveOverrideTemplate(report));
  writeTextFile(reviewMarkdownPath, redlineCorpusReviewMarkdown(report));
  return { jsonPath, csvPath, queueJsonPath, queueCsvPath, liveOverrideTemplatePath, reviewMarkdownPath };
}
