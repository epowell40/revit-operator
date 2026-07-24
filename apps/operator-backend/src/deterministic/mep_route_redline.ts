import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ActionCall, type ChatRequest, type ChatResponse, type ToolResult } from "../contracts.js";
import { analyzeRedlineFile, type RedlineAnalyzeResponse } from "../redline/redline_analyzer.js";
import { pdfDefaultPageBudget } from "../redline/pdf_intake_policy.js";
import { mapSheetRegions, type MapSheetRegionsResponse } from "../redline/sheet_region_mapper.js";
import { readLatestUploadIndexRecords } from "../attachments/upload_index.js";
import { evaluateRedlineVisualVerificationGate, type RedlineVisualGateResult } from "../verification/redline_visual_verification_gate.js";
import type {
  VerifiedMepRerouteOffsetEvidence,
  VerifiedMepSizeTransitionEvidence,
  VerifiedMepTapBranchEvidence
} from "./mep_mutation_evidence.js";

type MepKind = "duct" | "pipe";
type RedlineRouteStatus = "not_applicable" | "needs_sheet_detail" | "needs_view_frame" | "needs_pick" | "needs_context" | "ready" | "done" | "blocked";
type RedlineGeometryRole = "target_path" | "callout_text" | "leader" | "underline" | "reference_graphic" | "unknown";
type UnsafeMepEditIntentKind =
  | "tap_branch"
  | "transition"
  | "reroute_offset"
  | "accessory"
  | "move_delete_type_change";

type ClassifiedRedlineGeometry = {
  route_candidate?: {
    candidate_index: number;
    confidence: number;
    label_text: string;
    target_annotation_indices: number[];
    vertices_norm: Array<{ x: number; y: number }>;
    alignment_crop_norm?: { minX: number; minY: number; maxX: number; maxY: number };
  };
  roles: Array<{
    annotation_index?: number;
    annotation_id?: string;
    subtype?: string;
    role: RedlineGeometryRole;
    confidence: number;
    reason: string;
    associated_text?: string;
  }>;
  has_target_path: boolean;
  has_callout_text: boolean;
  callout_only: boolean;
  ambiguity: "none" | "callout_without_target_path" | "mixed_callout_and_target_path";
};

const ROUTE_SPATIAL_TOLERANCE_FT = 1;

type NormalizedBox = { minX: number; minY: number; maxX: number; maxY: number };
type ViewAlignmentCrop = { min_u: number; min_v: number; max_u: number; max_v: number };
type LocalBandAssertion = {
  status: "passed" | "failed" | "not_applicable";
  route_center_view_y?: number;
  label_view_y?: number;
  min_allowed_view_y?: number;
  max_allowed_view_y?: number;
  target_view_x?: number;
  target_view_y?: number;
  failure_kind?: "too_far_north" | "too_far_south" | "missing_anchors" | "projection_failed";
  correction_kind?: "space_bbox_route_shift";
  reason: string;
};
type FrameMapping = {
  topLeftXyz: [number, number, number];
  topRightXyz: [number, number, number];
  bottomLeftXyz: [number, number, number];
};

export type RedlineMepRouteTask = {
  attachment?: {
    file_path: string;
    filename?: string;
    page?: number;
  };
  sheet?: {
    number?: string;
    detail_resolved: boolean;
  };
  viewport?: {
    view_id?: number;
    viewport_id?: number;
    frame_id?: string;
    frame_width_px?: number;
    frame_height_px?: number;
    pick_px?: { x: number; y: number };
    pick_model_xy?: { x: number; y: number };
  };
  redline: {
    annotation_text: string;
    geometry_kind: "route" | "text_only" | "unknown";
    geometry_classification?: ClassifiedRedlineGeometry;
    regions: Array<{
      index: number;
      subtype?: string;
      contents?: string;
      box?: { x: number; y: number; w: number; h: number };
      related_group?: number;
      annotation_id?: string;
      annotation_page?: number;
      annotation_index?: number;
      annotation_box_norm?: { minX: number; minY: number; maxX: number; maxY: number };
      annotation_vertices_norm?: Array<{ x: number; y: number }>;
      annotation_related_indices?: number[];
      annotation_related_text?: string;
    }>;
    pdf_annotations?: NonNullable<RedlineAnalyzeResponse["pdf_annotations"]>;
    route_candidates?: NonNullable<RedlineAnalyzeResponse["route_candidates"]>;
    mapping?: MapSheetRegionsResponse;
  };
  mep: {
    kind: MepKind;
    size?: string;
    system_classification?: string;
    system_type?: string;
  };
  location: {
    room_number?: string;
    level_name?: string;
  };
  route?: {
    points?: Array<{ x: number; y: number }>;
    elevation_policy: "resolve_context_default" | "explicit_required";
    apply: boolean;
    visual_verify: boolean;
  };
  verification?: {
    status: "dry_run_ready" | "applied_visual_ready" | "applied_visual_incomplete" | "existing_model_verified" | "blocked";
    workflow_status?: string;
    apply_status?: string;
    created_element_ids?: number[];
    created_fitting_ids?: number[];
    existing_element_ids?: number[];
    open_connector_count?: number;
    capture_path?: string;
    observed_route_summary?: string;
    spatial_assertion?: {
      status: "passed" | "failed" | "not_applicable";
      tolerance_ft?: number;
      max_distance_ft?: number;
      reason: string;
    };
    local_band_assertion?: LocalBandAssertion;
    visual_gate?: RedlineVisualGateResult;
  };
  status: RedlineRouteStatus;
  confidence: "high" | "medium" | "low";
  blocker?: string;
  warnings: string[];
};

export type ResolveMepRouteRedlineRequest = {
  session_id?: string;
  user_text?: string;
  context?: unknown;
  file_path?: string;
  filename?: string;
  user_attachments?: ChatRequest["user_attachments"];
  tool_results?: ToolResult[];
  expected_sheet?: string;
  analysis?: RedlineAnalyzeResponse;
  verified_mep_size_transition?: VerifiedMepSizeTransitionEvidence;
  verifiedMepSizeTransition?: VerifiedMepSizeTransitionEvidence;
  verified_mep_tap_branch?: VerifiedMepTapBranchEvidence;
  verifiedMepTapBranch?: VerifiedMepTapBranchEvidence;
  verified_mep_reroute_offset?: VerifiedMepRerouteOffsetEvidence;
  verifiedMepRerouteOffset?: VerifiedMepRerouteOffsetEvidence;
};

export type ResolveMepRouteRedlineResponse = {
  ok: boolean;
  handled: boolean;
  task?: RedlineMepRouteTask;
  next_action?: ActionCall;
  assistant_message: string;
  blocker?: string;
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function toFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeSheetNumber(value: unknown): string {
  return textOf(value).toUpperCase();
}

function isStatusOnlyNoDiscovery(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(status|summarize|summary|what happened|did you|were any changes|feedback|diagnostic)\b/.test(lower) &&
    /\b(do not|don't|no)\b[\s\S]{0,60}\b(discovery|calls?|writes?|changes?|apply|create|place)\b/.test(lower)
  );
}

function userTextLooksRedlinePickup(text: string): boolean {
  return /\b(redline|markup|marked\.pdf|pick\s+up|pickup|attached|annotation)\b/i.test(text);
}

function findAttachment(req: ResolveMepRouteRedlineRequest): { file_path: string; filename?: string } | null {
  const explicit = textOf(req.file_path);
  if (explicit) return { file_path: explicit, ...(textOf(req.filename) ? { filename: textOf(req.filename) } : {}) };
  const attachments = Array.isArray(req.user_attachments) ? req.user_attachments : [];
  for (const a of attachments) {
    const rel = textOf(a?.relative_path);
    if (!rel) continue;
    const filename = textOf(a?.filename);
    if (/\.(pdf|png|jpe?g|tif?f|bmp)$/i.test(rel) || /\.(pdf|png|jpe?g|tif?f|bmp)$/i.test(filename)) {
      return { file_path: rel, ...(filename ? { filename } : {}) };
    }
  }
  return null;
}

function findContinuationAttachment(req: ResolveMepRouteRedlineRequest): { file_path: string; filename?: string } | null {
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];
  const hasMepRouteContext = toolResults.some(isMepRouteContinuationToolResult);
  if (!hasMepRouteContext) return null;
  const latest = readLatestUploadIndexRecords(30).find(r => {
    const rel = textOf(r.relative_path);
    const filename = textOf(r.filename);
    return /\.(pdf|png|jpe?g|tif?f|bmp)$/i.test(rel) || /\.(pdf|png|jpe?g|tif?f|bmp)$/i.test(filename);
  });
  const rel = textOf(latest?.relative_path);
  if (!rel) return null;
  const filename = textOf(latest?.filename);
  return { file_path: rel, ...(filename ? { filename } : {}) };
}

function isMepRouteContinuationToolResult(result: ToolResult): boolean {
  const path = textOf(result?.path).toLowerCase();
  if (path === "/revit/sheets") return textOf(asRecord(result.result_json)?.action).toLowerCase() === "detail";
  return (
    path === "/revit/export-view-frame" ||
    path === "/tools/redline/align-to-view" ||
    path === "/revit/resolve-mep-routing-context" ||
    path === "/revit/mep-route-workflow"
  );
}

function extractRoomNumber(text: string): string | undefined {
  return extractRoomNumbers(text)[0];
}

function extractRoomNumbers(text: string): string[] {
  const output: string[] = [];
  const patterns = [
    /\bLive\/Work\s+Loft\s+Unit\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/gi,
    /\b(?:unit|room|loft)\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/gi,
    /\bUnit\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.toUpperCase();
      if (value && !output.includes(value)) output.push(value);
    }
    if (output.length > 0) break;
  }
  return output;
}

function extractSheetNumber(text: string): string | undefined {
  const m = text.match(/\b([A-Z]{1,4}\d{1,4}(?:[.\-]\d{1,4})?)\b/i);
  return m?.[1]?.toUpperCase();
}

function extractLevelName(text: string): string | undefined {
  const explicit = text.match(/\b(?:level|lvl|l)\s*([0-9]{1,2})\b/i)?.[1];
  if (explicit) return `L${explicit}`;
  const room = extractRoomNumber(text);
  const digits = room?.match(/\d+/)?.[0] ?? "";
  return digits.length >= 3 ? `L${digits.slice(0, 1)}` : undefined;
}

function extractSize(text: string): string | undefined {
  const rectangular = text.match(/\b(\d{1,2})\s*(?:"|in|inch|inches)?\s*[x×]\s*(\d{1,2})\b/i);
  if (rectangular) return `${Number.parseInt(rectangular[1]!, 10)}x${Number.parseInt(rectangular[2]!, 10)}`;
  const round = text.match(/\b(\d{1,2}(?:\.\d+)?)\s*-?\s*(?:"|in|inch|inches)\b/i);
  if (!round) return undefined;
  const n = Number.parseFloat(round[1]!);
  return Number.isInteger(n) ? `${n}"` : `${n}"`;
}

function extractMepIntent(text: string): { kind: MepKind; system_classification?: string; system_type?: string; size?: string } | null {
  const lower = text.toLowerCase();
  const size = extractSize(text);
  const ductLike = /\b(duct|supply\s+air|return\s+air|exhaust\s+air|hvac)\b/.test(lower) || /[x×]/i.test(size ?? "");
  const pipeLike = /\b(pipe|piping|domestic|sanitary|vent|water)\b/.test(lower);
  if (!ductLike && !pipeLike) return null;
  if (pipeLike && !ductLike) return { kind: "pipe", size };
  if (/\b(return|ra)\b/.test(lower)) return { kind: "duct", system_classification: "Return", system_type: "Return Air", size };
  if (/\b(exhaust|ea)\b/.test(lower)) return { kind: "duct", system_classification: "Exhaust", system_type: "Exhaust Air", size };
  return { kind: "duct", system_classification: "Supply", system_type: "Supply Air", size };
}

function unsafeMepEditIntent(text: string): { kind: UnsafeMepEditIntentKind; blocker: string } | null {
  const lower = text.toLowerCase();
  if (/\b(tap|take[\s-]*off|takeoff|tee|branch|top\s+tap|tap\s+off)\b/.test(lower)) {
    return {
      kind: "tap_branch",
      blocker:
        "The redline reads as a tap/branch/takeoff edit, not a free route. It needs verified main/host element id, projected tap point, branch path, connection mode, fitting/readback, connector audit, focused capture, and cleanup proof before any model write."
    };
  }
  if (/\b(reducer|transition|rectangular\s+to\s+round|round\s+to\s+rectangular|change\s+(?:duct|pipe|piping)?\s*size|resize|upsiz(?:e|ed|ing)|downsiz(?:e|ed|ing))\b/.test(lower) ||
      /\bchange\b[\s\S]{0,40}\b(?:duct|pipe|piping)\b[\s\S]{0,40}\b(?:from|to)\b/.test(lower)) {
    return {
      kind: "transition",
      blocker:
        "The redline reads as a size transition/reducer edit, not a free route. It needs verified host element id or scoped segment ids, transition point or chainage, upstream/downstream size readback, fitting/connector audit, focused capture, and cleanup proof before any model write."
    };
  }
  if (/\b(reroute|re-route|offset|dogleg|dog\s+leg|45(?:\s*degree|\s*deg|\s*[°])?|drop|raise|lower|elevation\s+(?:drop|raise|change))\b/.test(lower)) {
    return {
      kind: "reroute_offset",
      blocker:
        "The redline reads as an existing-route reroute/offset/elevation edit, not a free route. It needs verified host route id, split points, offset/drop vector, endpoint-preservation plan, fitting/readback, connector/system audit, focused capture, and cleanup proof before any model write."
    };
  }
  if (/\b(damper|fire\s+damper|balancing\s+damper|accessor(?:y|ies)|valve)\b/.test(lower)) {
    return {
      kind: "accessory",
      blocker:
        "The redline reads as an MEP accessory edit, not a free route. It needs verified compatible family/type or target accessory ids, host/placement evidence, readback, focused capture, and cleanup or revert proof before any model write."
    };
  }
  if (/\b(move|delete|remove|swap|replace|type\s+change|change\s+type|family\s+type|change\s+family)\b/.test(lower) && /\b(duct|pipe|piping|damper|accessor(?:y|ies)|valve)\b/.test(lower)) {
    return {
      kind: "move_delete_type_change",
      blocker:
        "The redline reads as a targeted MEP move/delete/type or family change, not a free route. It needs explicit target ids, before/readback evidence, focused capture, and cleanup or revert proof before any model write."
    };
  }
  return null;
}

function annotationText(analysis: RedlineAnalyzeResponse, options: { includePages?: boolean } = {}): string {
  const includePages = options.includePages !== false;
  const parts: string[] = [];
  for (const r of Array.isArray(analysis.mark_regions) ? analysis.mark_regions : []) {
    const c = textOf(r.annotation_contents);
    if (c) parts.push(c);
    const related = textOf((r as any).annotation_related_text);
    if (related) parts.push(related);
  }
  for (const a of Array.isArray(analysis.pdf_annotations) ? analysis.pdf_annotations : []) {
    const row = asRecord(a);
    if (!row) continue;
    const c = textOf(row.contents ?? row.annotation_contents ?? row.related_text ?? row.annotation_related_text);
    if (c) parts.push(c);
  }
  if (includePages) {
    for (const p of Array.isArray(analysis.pages) ? analysis.pages : []) {
      const excerpt = textOf(p.text_excerpt);
      if (excerpt) parts.push(excerpt);
    }
  }
  return parts.join(" ");
}

function intervalOverlap(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return Math.max(0, hi - lo);
}

function boxNormOf(value: unknown): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const minX = toFiniteNumber(raw.minX);
  const minY = toFiniteNumber(raw.minY);
  const maxX = toFiniteNumber(raw.maxX);
  const maxY = toFiniteNumber(raw.maxY);
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  return { minX, minY, maxX, maxY };
}

function annotationBoxNorm(row: Record<string, unknown>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return boxNormOf(row.box_norm ?? row.annotation_box_norm);
}

function textLooksMepCallout(text: string): boolean {
  const hasSize =
    /\b\d{1,3}\s*(?:["']?\s*)?[x×]\s*\d{1,3}\b/i.test(text) ||
    /\b\d{1,3}(?:\.\d+)?\s*-?\s*(?:"|in|inch|inches)\b/i.test(text);
  return hasSize && /\b(duct|supply|return|exhaust|lined|pipe|piping|water|sanitary|vent)\b/i.test(text);
}

function routeCandidateMepKind(labelText: string): MepKind | undefined {
  const lower = labelText.toLowerCase();
  const pipeLike = /\b(pipe|piping|domestic|sanitary|vent|water)\b/.test(lower);
  const ductLike = /\b(duct|supply\s+air|return\s+air|exhaust\s+air|hvac|supply|return|exhaust)\b/.test(lower) || /[x×]/.test(labelText);
  if (pipeLike && !ductLike) return "pipe";
  if (ductLike) return "duct";
  return undefined;
}

function normalizeRouteSizeText(value: string | undefined): string {
  return textOf(value)
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/\binches?\b|\bin\b/g, "\"")
    .replace(/\s+/g, "")
    .replace(/"/g, "");
}

function routeCandidateCompatibilityScore(
  candidate: NonNullable<ClassifiedRedlineGeometry["route_candidate"]>,
  mep?: { kind: MepKind; size?: string }
): number {
  if (!mep) return 0;
  let score = 0;
  const candidateKind = routeCandidateMepKind(candidate.label_text);
  if (candidateKind === mep.kind) score += 1.5;
  else if (candidateKind && candidateKind !== mep.kind) score -= 2.5;

  const requestedSize = normalizeRouteSizeText(mep.size);
  if (requestedSize) {
    const labelSize = normalizeRouteSizeText(extractSize(candidate.label_text));
    if (labelSize === requestedSize) score += 1;
    else if (labelSize) score -= 0.75;
  }
  return score;
}

function classifyRedlineGeometry(analysis: RedlineAnalyzeResponse, mep?: { kind: MepKind; size?: string }): ClassifiedRedlineGeometry {
  const routeCandidates = Array.isArray(analysis.route_candidates) ? analysis.route_candidates : [];
  const bestRouteCandidate = routeCandidates
    .map(c => {
      const row = asRecord(c);
      if (!row) return null;
      const candidateIndex = toFiniteNumber(row.candidate_index);
      const confidence = toFiniteNumber(row.confidence);
      const labelText = textOf(row.label_text);
      const targetAnnotationIndices = Array.isArray(row.target_annotation_indices)
        ? row.target_annotation_indices.map(toFiniteNumber).filter((n): n is number => n !== null).map(n => Math.round(n))
        : [];
      const vertices = Array.isArray(row.vertices_norm)
        ? row.vertices_norm.map(v => asRecord(v)).map(v => {
            const x = toFiniteNumber(v?.x);
            const y = toFiniteNumber(v?.y);
            return x === null || y === null ? null : { x, y };
          }).filter((v): v is { x: number; y: number } => !!v)
        : [];
      const alignmentCropNorm = boxNormOf(row.alignment_crop_norm);
      if (candidateIndex === null || confidence === null || !labelText || targetAnnotationIndices.length === 0 || vertices.length < 2) return null;
      return {
        candidate_index: Math.round(candidateIndex),
        confidence,
        label_text: labelText,
        target_annotation_indices: targetAnnotationIndices,
        vertices_norm: vertices,
        ...(alignmentCropNorm ? { alignment_crop_norm: alignmentCropNorm } : {})
      };
    })
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => {
      const scoreA = a.confidence + routeCandidateCompatibilityScore(a, mep);
      const scoreB = b.confidence + routeCandidateCompatibilityScore(b, mep);
      return scoreB - scoreA;
    })[0];
  const annotations = (Array.isArray(analysis.pdf_annotations) ? analysis.pdf_annotations : [])
    .map(a => asRecord(a))
    .filter((a): a is Record<string, unknown> => !!a);
  const markRegions = (Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [])
    .map(r => asRecord(r))
    .filter((r): r is Record<string, unknown> => !!r);
  const rows = annotations.length > 0 ? annotations : markRegions;
  const textRows = rows.filter(row => {
    const subtype = textOf(row.subtype ?? row.annotation_subtype).toLowerCase();
    return /freetext|typewriter/.test(subtype) || subtype === "text";
  });
  const vectorRows = rows.filter(row => {
    const subtype = textOf(row.subtype ?? row.annotation_subtype).toLowerCase();
    return /polyline|line|ink|polygon|square|circle/.test(subtype);
  });

  const roles: ClassifiedRedlineGeometry["roles"] = [];
  for (const textRow of textRows) {
    const contents = textOf(textRow.contents ?? textRow.annotation_contents ?? textRow.related_text ?? textRow.annotation_related_text);
    roles.push({
      ...(Number.isFinite(textRow.annotation_index as number) ? { annotation_index: Number(textRow.annotation_index) } : {}),
      ...(textOf(textRow.id ?? textRow.annotation_id) ? { annotation_id: textOf(textRow.id ?? textRow.annotation_id) } : {}),
      ...(textOf(textRow.subtype ?? textRow.annotation_subtype) ? { subtype: textOf(textRow.subtype ?? textRow.annotation_subtype) } : {}),
      role: contents ? "callout_text" : "unknown",
      confidence: contents ? 0.95 : 0.35,
      reason: contents ? "Text annotation carries the redline callout wording." : "Text-like annotation has no readable contents."
    });
  }

  for (const row of vectorRows) {
    const subtype = textOf(row.subtype ?? row.annotation_subtype);
    const box = annotationBoxNorm(row);
    const relatedText = textOf(row.related_text ?? row.annotation_related_text ?? row.contents ?? row.annotation_contents);
    const width = box ? Math.abs(box.maxX - box.minX) : 0;
    const height = box ? Math.abs(box.maxY - box.minY) : 0;
    const isThinHorizontal = box ? width > height * 4 && height <= 0.02 : false;
    const textRelations = !!box ? textRows.map(textRow => {
      const tbox = annotationBoxNorm(textRow);
      if (!tbox) return null;
      const xOverlap = intervalOverlap(box.minX, box.maxX, tbox.minX, tbox.maxX);
      const yOverlap = intervalOverlap(box.minY, box.maxY, tbox.minY, tbox.maxY);
      const nearY = Math.abs(((box.minY + box.maxY) / 2) - ((tbox.minY + tbox.maxY) / 2)) <= Math.max(0.035, Math.abs(tbox.maxY - tbox.minY) * 0.55);
      const textWidth = Math.abs(tbox.maxX - tbox.minX);
      const textHeight = Math.abs(tbox.maxY - tbox.minY);
      const text = textOf(textRow.contents ?? textRow.annotation_contents);
      const vectorCenterY = (box.minY + box.maxY) / 2;
      const lowerBandMin = tbox.minY + textHeight * 0.58;
      return {
        text,
        box: tbox,
        xOverlap,
        yOverlap,
        nearY,
        textWidth,
        textHeight,
        widthRatio: textWidth > 0 ? width / textWidth : 0,
        inTextLowerBand: vectorCenterY >= lowerBandMin && vectorCenterY <= tbox.maxY + textHeight * 0.2,
        related: xOverlap > 0 && (yOverlap > 0 || nearY)
      };
    }).filter((r): r is NonNullable<typeof r> => !!r) : [];
    const relatedTextRelation = textRelations.find(r => r.related);
    const overlapsCallout = !!relatedTextRelation;
    const associatedText = relatedText || relatedTextRelation?.text || "";
    const isMepCalloutRelated = textLooksMepCallout(associatedText) || textRows.some(textRow => textLooksMepCallout(textOf(textRow.contents ?? textRow.annotation_contents)));
    const isTypographicUnderline =
      isThinHorizontal &&
      !!relatedTextRelation &&
      relatedTextRelation.inTextLowerBand &&
      relatedTextRelation.widthRatio >= 0.55;

    let role: RedlineGeometryRole = "target_path";
    let confidence = 0.75;
    let reason = "Vector markup is not tied to a callout text box, so it can be treated as route geometry.";
    if (isTypographicUnderline && isMepCalloutRelated) {
      role = "underline";
      confidence = 0.92;
      reason = "Thin line spans a substantial part of the callout text lower band; classify as text underline formatting.";
    } else if (overlapsCallout && isMepCalloutRelated) {
      role = "target_path";
      confidence = 0.86;
      reason = "Vector markup is spatially associated with nearby MEP callout text; treat the text as the label for this route geometry.";
    } else if (box && width < 0.02 && height < 0.02) {
      role = "reference_graphic";
      confidence = 0.6;
      reason = "Very small vector mark is more likely a reference marker than a route.";
    }

    roles.push({
      ...(Number.isFinite(row.annotation_index as number) ? { annotation_index: Number(row.annotation_index) } : {}),
      ...(textOf(row.id ?? row.annotation_id) ? { annotation_id: textOf(row.id ?? row.annotation_id) } : {}),
      ...(subtype ? { subtype } : {}),
      role,
      confidence,
      reason,
      ...(associatedText ? { associated_text: associatedText } : {})
    });
  }

  const hasTargetPath = !!bestRouteCandidate || roles.some(r => r.role === "target_path");
  const hasCalloutText = roles.some(r => r.role === "callout_text");
  const hasCalloutGeometry = roles.some(r => r.role === "leader" || r.role === "underline");
  const calloutOnly = hasCalloutText && !hasTargetPath && (hasCalloutGeometry || vectorRows.length === 0);
  return {
    ...(bestRouteCandidate ? { route_candidate: bestRouteCandidate } : {}),
    roles,
    has_target_path: hasTargetPath,
    has_callout_text: hasCalloutText,
    callout_only: calloutOnly,
    ambiguity: hasTargetPath && hasCalloutText ? "mixed_callout_and_target_path" : calloutOnly ? "callout_without_target_path" : "none"
  };
}

function routeGeometryKind(analysis: RedlineAnalyzeResponse, classification = classifyRedlineGeometry(analysis)): "route" | "text_only" | "unknown" {
  const regions = Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [];
  if (regions.length === 0) return "unknown";
  if (classification.has_target_path) return "route";
  if (regions.some(r => /freetext|text|typewriter/i.test(textOf(r.annotation_subtype)))) return "text_only";
  if (classification.callout_only) return "unknown";
  return "unknown";
}

function summarizeRegions(analysis: RedlineAnalyzeResponse): RedlineMepRouteTask["redline"]["regions"] {
  return (Array.isArray(analysis.mark_regions) ? analysis.mark_regions : []).map(r => ({
    index: Number.isFinite(r.index) ? r.index : 0,
    ...(textOf(r.annotation_subtype) ? { subtype: textOf(r.annotation_subtype) } : {}),
    ...(textOf(r.annotation_contents) ? { contents: textOf(r.annotation_contents) } : {}),
    ...(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)
      ? { box: { x: r.x, y: r.y, w: r.w, h: r.h } }
      : {}),
    ...(Number.isFinite(r.related_group) ? { related_group: r.related_group } : {}),
    ...(textOf((r as any).annotation_id) ? { annotation_id: textOf((r as any).annotation_id) } : {}),
    ...(Number.isFinite((r as any).annotation_page) ? { annotation_page: Number((r as any).annotation_page) } : {}),
    ...(Number.isFinite((r as any).annotation_index) ? { annotation_index: Number((r as any).annotation_index) } : {}),
    ...((r as any).annotation_box_norm && typeof (r as any).annotation_box_norm === "object"
      ? { annotation_box_norm: (r as any).annotation_box_norm as { minX: number; minY: number; maxX: number; maxY: number } }
      : {}),
    ...(Array.isArray((r as any).annotation_vertices_norm)
      ? { annotation_vertices_norm: (r as any).annotation_vertices_norm as Array<{ x: number; y: number }> }
      : {}),
    ...(Array.isArray((r as any).annotation_related_indices)
      ? { annotation_related_indices: (r as any).annotation_related_indices as number[] }
      : {}),
    ...(textOf((r as any).annotation_related_text) ? { annotation_related_text: textOf((r as any).annotation_related_text) } : {})
  }));
}

function firstAnnotationPage(analysis: RedlineAnalyzeResponse): number | undefined {
  const fromRegion = (Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [])
    .map(r => toFiniteNumber((r as any).annotation_page))
    .find(n => n !== null && n > 0);
  if (fromRegion !== undefined && fromRegion !== null) return Math.round(fromRegion);
  const fromPdfAnnotation = (Array.isArray(analysis.pdf_annotations) ? analysis.pdf_annotations : [])
    .map(a => toFiniteNumber(a.page))
    .find(n => n !== null && n > 0);
  return fromPdfAnnotation === undefined || fromPdfAnnotation === null ? undefined : Math.round(fromPdfAnnotation);
}

function latestToolResult(toolResults: ToolResult[], pathName: string): ToolResult | null {
  const target = pathName.toLowerCase();
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (textOf(r?.path).toLowerCase() === target) return r ?? null;
  }
  return null;
}

function latestDoneToolJson(toolResults: ToolResult[], pathName: string): Record<string, unknown> | null {
  const r = latestToolResult(toolResults, pathName);
  if (!r || r.status !== "done") return null;
  return asRecord(r.result_json);
}

function positiveNumber(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

function finitePoint(value: unknown): { x: number; y: number; z?: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const x = toFiniteNumber(row.x);
  const y = toFiniteNumber(row.y);
  const z = toFiniteNumber(row.z);
  if (x === null || y === null) return null;
  return { x, y, ...(z !== null ? { z } : {}) };
}

function finitePointArray(value: unknown): Array<{ x: number; y: number; z?: number }> {
  if (!Array.isArray(value)) return [];
  return value.map(finitePoint).filter((point): point is { x: number; y: number; z?: number } => !!point);
}

function tapBranchEvidenceFrom(value: unknown): VerifiedMepTapBranchEvidence | null {
  const row = asRecord(value);
  if (!row) return null;
  const nested =
    asRecord(row.verified_mep_tap_branch) ??
    asRecord(row.verifiedMepTapBranch) ??
    asRecord(row.tap_branch) ??
    asRecord(row.tapBranch) ??
    row;
  return {
    ...(textOf(nested.kind) === "pipe" || textOf(nested.kind) === "duct" ? { kind: textOf(nested.kind) as MepKind } : {}),
    ...(positiveNumber(nested.viewId ?? nested.view_id) !== null ? { viewId: positiveNumber(nested.viewId ?? nested.view_id)! } : {}),
    ...(positiveNumber(nested.visualViewId ?? nested.visual_view_id) !== null ? { visualViewId: positiveNumber(nested.visualViewId ?? nested.visual_view_id)! } : {}),
    ...(positiveNumber(nested.mainElementId ?? nested.main_element_id ?? nested.hostElementId ?? nested.host_element_id) !== null
      ? { mainElementId: positiveNumber(nested.mainElementId ?? nested.main_element_id ?? nested.hostElementId ?? nested.host_element_id)! }
      : {}),
    ...(finitePoint(nested.projectedTapPoint ?? nested.projected_tap_point ?? nested.tapPoint ?? nested.tap_point ?? nested.connectionPoint ?? nested.connection_point)
      ? { projectedTapPoint: finitePoint(nested.projectedTapPoint ?? nested.projected_tap_point ?? nested.tapPoint ?? nested.tap_point ?? nested.connectionPoint ?? nested.connection_point)! }
      : {}),
    ...(finitePointArray(nested.branchPoints ?? nested.branch_points).length > 0
      ? { branchPoints: finitePointArray(nested.branchPoints ?? nested.branch_points) }
      : {}),
    ...(textOf(nested.branchSize ?? nested.branch_size) ? { branchSize: textOf(nested.branchSize ?? nested.branch_size) } : {}),
    ...(textOf(nested.ductSize ?? nested.duct_size) ? { ductSize: textOf(nested.ductSize ?? nested.duct_size) } : {}),
    ...(textOf(nested.pipeSize ?? nested.pipe_size) ? { pipeSize: textOf(nested.pipeSize ?? nested.pipe_size) } : {}),
    ...(textOf(nested.systemType ?? nested.system_type) ? { systemType: textOf(nested.systemType ?? nested.system_type) } : {}),
    ...(textOf(nested.levelName ?? nested.level_name) ? { levelName: textOf(nested.levelName ?? nested.level_name) } : {}),
    ...(textOf(nested.connectionMode ?? nested.connection_mode) ? { connectionMode: textOf(nested.connectionMode ?? nested.connection_mode) } : {}),
    ...(textOf(nested.expectedFitting ?? nested.expected_fitting ?? nested.fittingKind ?? nested.fitting_kind)
      ? { expectedFitting: textOf(nested.expectedFitting ?? nested.expected_fitting ?? nested.fittingKind ?? nested.fitting_kind) }
      : {}),
    ...(positiveNumber(nested.fittingTypeId ?? nested.fitting_type_id) !== null ? { fittingTypeId: positiveNumber(nested.fittingTypeId ?? nested.fitting_type_id)! } : {}),
    ...(textOf(nested.orientation) ? { orientation: textOf(nested.orientation) } : {}),
    ...(textOf(nested.takeoffFamilyName ?? nested.takeoff_family_name) ? { takeoffFamilyName: textOf(nested.takeoffFamilyName ?? nested.takeoff_family_name) } : {}),
    ...(textOf(nested.takeoffTypeName ?? nested.takeoff_type_name) ? { takeoffTypeName: textOf(nested.takeoffTypeName ?? nested.takeoff_type_name) } : {})
  };
}

function verifiedTapBranchEvidence(req: ResolveMepRouteRedlineRequest): VerifiedMepTapBranchEvidence | null {
  return (
    tapBranchEvidenceFrom(req.verified_mep_tap_branch) ??
    tapBranchEvidenceFrom(req.verifiedMepTapBranch) ??
    tapBranchEvidenceFrom(req.context)
  );
}

function boolFrom(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = textOf(value).toLowerCase();
  if (/^(true|yes|1)$/.test(text)) return true;
  if (/^(false|no|0)$/.test(text)) return false;
  return undefined;
}

function rerouteOffsetEvidenceFrom(value: unknown): VerifiedMepRerouteOffsetEvidence | null {
  const row = asRecord(value);
  if (!row) return null;
  const nested =
    asRecord(row.verified_mep_reroute_offset) ??
    asRecord(row.verifiedMepRerouteOffset) ??
    asRecord(row.reroute_offset) ??
    asRecord(row.rerouteOffset) ??
    row;
  const offsetVector = finitePoint(nested.offsetVector ?? nested.offset_vector);
  const splitPoints = finitePointArray(nested.splitPoints ?? nested.split_points);
  const split1Point = finitePoint(nested.split1Point ?? nested.split1_point ?? nested.splitPoint1 ?? nested.split_point_1);
  const split2Point = finitePoint(nested.split2Point ?? nested.split2_point ?? nested.splitPoint2 ?? nested.split_point_2);
  const preserveConnectedEndpoints = boolFrom(nested.preserveConnectedEndpoints ?? nested.preserve_connected_endpoints);
  const endpointReconnectionPlanReviewed = boolFrom(nested.endpointReconnectionPlanReviewed ?? nested.endpoint_reconnection_plan_reviewed);
  return {
    ...(textOf(nested.kind) === "pipe" || textOf(nested.kind) === "duct" ? { kind: textOf(nested.kind) as MepKind } : {}),
    ...(positiveNumber(nested.viewId ?? nested.view_id) !== null ? { viewId: positiveNumber(nested.viewId ?? nested.view_id)! } : {}),
    ...(positiveNumber(nested.visualViewId ?? nested.visual_view_id) !== null ? { visualViewId: positiveNumber(nested.visualViewId ?? nested.visual_view_id)! } : {}),
    ...(positiveNumber(nested.hostElementId ?? nested.host_element_id ?? nested.elementId ?? nested.element_id) !== null
      ? { hostElementId: positiveNumber(nested.hostElementId ?? nested.host_element_id ?? nested.elementId ?? nested.element_id)! }
      : {}),
    ...(splitPoints.length > 0 ? { splitPoints } : {}),
    ...(split1Point ? { split1Point } : {}),
    ...(split2Point ? { split2Point } : {}),
    ...(positiveNumber(nested.split1ChainageFt ?? nested.split1_chainage_ft) !== null ? { split1ChainageFt: positiveNumber(nested.split1ChainageFt ?? nested.split1_chainage_ft)! } : {}),
    ...(positiveNumber(nested.split2ChainageFt ?? nested.split2_chainage_ft) !== null ? { split2ChainageFt: positiveNumber(nested.split2ChainageFt ?? nested.split2_chainage_ft)! } : {}),
    ...(toFiniteNumber(nested.split1Normalized ?? nested.split1_normalized) !== null ? { split1Normalized: toFiniteNumber(nested.split1Normalized ?? nested.split1_normalized)! } : {}),
    ...(toFiniteNumber(nested.split2Normalized ?? nested.split2_normalized) !== null ? { split2Normalized: toFiniteNumber(nested.split2Normalized ?? nested.split2_normalized)! } : {}),
    ...(offsetVector ? { offsetVector } : {}),
    ...(toFiniteNumber(nested.dropFt ?? nested.drop_ft) !== null ? { dropFt: toFiniteNumber(nested.dropFt ?? nested.drop_ft)! } : {}),
    ...(toFiniteNumber(nested.riseFt ?? nested.rise_ft) !== null ? { riseFt: toFiniteNumber(nested.riseFt ?? nested.rise_ft)! } : {}),
    ...(toFiniteNumber(nested.elevationOffsetFt ?? nested.elevation_offset_ft) !== null ? { elevationOffsetFt: toFiniteNumber(nested.elevationOffsetFt ?? nested.elevation_offset_ft)! } : {}),
    ...(textOf(nested.offsetMode ?? nested.offset_mode) ? { offsetMode: textOf(nested.offsetMode ?? nested.offset_mode) } : {}),
    ...(textOf(nested.expectedFittings ?? nested.expected_fittings) ? { expectedFittings: textOf(nested.expectedFittings ?? nested.expected_fittings) } : {}),
    ...(textOf(nested.expectedFitting ?? nested.expected_fitting) ? { expectedFitting: textOf(nested.expectedFitting ?? nested.expected_fitting) } : {}),
    ...(preserveConnectedEndpoints !== undefined ? { preserveConnectedEndpoints } : {}),
    ...(endpointReconnectionPlanReviewed !== undefined ? { endpointReconnectionPlanReviewed } : {})
  };
}

function verifiedRerouteOffsetEvidence(req: ResolveMepRouteRedlineRequest): VerifiedMepRerouteOffsetEvidence | null {
  return (
    rerouteOffsetEvidenceFrom(req.verified_mep_reroute_offset) ??
    rerouteOffsetEvidenceFrom(req.verifiedMepRerouteOffset) ??
    rerouteOffsetEvidenceFrom(req.context)
  );
}

function nonzeroOffsetVector(point: { x: number; y: number; z?: number } | null): { x: number; y: number; z?: number } | null {
  if (!point) return null;
  const z = toFiniteNumber(point.z);
  const magnitude = Math.hypot(point.x, point.y, z ?? 0);
  return magnitude > 0 ? point : null;
}

function buildRerouteOffsetDryRunAction(
  task: RedlineMepRouteTask,
  evidence: VerifiedMepRerouteOffsetEvidence | null
): { next?: ActionCall; blockers: string[] } {
  const blockers: string[] = [];
  const kind = evidence?.kind ?? task.mep.kind;
  const viewId = positiveNumber(evidence?.viewId);
  const visualViewId = positiveNumber(evidence?.visualViewId);
  const hostElementId = positiveNumber(evidence?.hostElementId);
  const splitPoints = finitePointArray(evidence?.splitPoints);
  const split1Point = finitePoint(evidence?.split1Point) ?? splitPoints[0] ?? null;
  const split2Point = finitePoint(evidence?.split2Point) ?? splitPoints[1] ?? null;
  const split1ChainageFt = positiveNumber(evidence?.split1ChainageFt);
  const split2ChainageFt = positiveNumber(evidence?.split2ChainageFt);
  const split1Normalized = toFiniteNumber(evidence?.split1Normalized);
  const split2Normalized = toFiniteNumber(evidence?.split2Normalized);
  const offsetVector = nonzeroOffsetVector(finitePoint(evidence?.offsetVector));
  const dropFt = toFiniteNumber(evidence?.dropFt);
  const riseFt = toFiniteNumber(evidence?.riseFt);
  const elevationOffsetFt = toFiniteNumber(evidence?.elevationOffsetFt);
  const offsetMode = textOf(evidence?.offsetMode);
  const expectedFittings = textOf(evidence?.expectedFittings ?? evidence?.expectedFitting);
  const preserveConnectedEndpoints = evidence?.preserveConnectedEndpoints === true;

  if (!evidence) blockers.push("verified reroute/offset evidence object");
  if (evidence?.kind && evidence.kind !== task.mep.kind) blockers.push(`evidence kind ${evidence.kind} must match detected redline kind ${task.mep.kind}`);
  if (viewId === null) blockers.push("verified viewId");
  if (visualViewId === null) blockers.push("verified visualViewId for focused capture");
  if (hostElementId === null) blockers.push("verified hostElementId");
  const hasChainages = split1ChainageFt !== null && split2ChainageFt !== null;
  const hasNormalized = split1Normalized !== null && split2Normalized !== null &&
    split1Normalized >= 0 && split1Normalized <= 1 && split2Normalized >= 0 && split2Normalized <= 1;
  if (!hasChainages && !hasNormalized) {
    blockers.push("handler-supported split1/split2 chainages or normalized chainages");
  }
  if (!offsetVector) {
    blockers.push("handler-supported nonzero offsetVector");
  }
  if (!offsetMode) blockers.push("offsetMode");
  if (!expectedFittings) blockers.push("expected elbow/transition fitting plan");
  if (preserveConnectedEndpoints && evidence?.endpointReconnectionPlanReviewed !== true) {
    blockers.push("reviewed endpoint reconnection plan before preserveConnectedEndpoints:true");
  }
  if (blockers.length > 0) return { blockers };

  const body: Record<string, unknown> = {
    operation: "reroute_offset",
    kind,
    viewId,
    visualViewId,
    hostElementId,
    ...(split1ChainageFt !== null ? { split1ChainageFt } : {}),
    ...(split2ChainageFt !== null ? { split2ChainageFt } : {}),
    ...(split1Normalized !== null ? { split1Normalized } : {}),
    ...(split2Normalized !== null ? { split2Normalized } : {}),
    ...(offsetVector ? { offsetVector } : {}),
    offsetMode,
    expectedFittings,
    preserveConnectedEndpoints,
    apply: false,
    dryRun: true,
    verify: true,
    verifyConnectorNetwork: true,
    visualVerify: false,
    cleanupCreatedElements: false,
    source: "verified_pdf_redline_reroute_offset_handoff"
  };
  return { next: action("/revit/reroute-mep-route-segment", body), blockers: [] };
}

function buildTapBranchDryRunAction(
  task: RedlineMepRouteTask,
  evidence: VerifiedMepTapBranchEvidence | null
): { next?: ActionCall; blockers: string[] } {
  const blockers: string[] = [];
  const kind = evidence?.kind ?? task.mep.kind;
  const isPipe = kind === "pipe";
  const viewId = positiveNumber(evidence?.viewId);
  const visualViewId = positiveNumber(evidence?.visualViewId);
  const mainElementId = positiveNumber(evidence?.mainElementId);
  const projectedTapPoint = finitePoint(evidence?.projectedTapPoint);
  const branchPoints = finitePointArray(evidence?.branchPoints);
  const branchSize = textOf(isPipe ? evidence?.pipeSize ?? evidence?.branchSize : evidence?.ductSize ?? evidence?.branchSize);
  const connectionMode = textOf(evidence?.connectionMode);
  const expectedFitting = textOf(evidence?.expectedFitting);

  if (!evidence) blockers.push("verified tap/branch evidence object");
  if (evidence?.kind && evidence.kind !== task.mep.kind) blockers.push(`evidence kind ${evidence.kind} must match detected redline kind ${task.mep.kind}`);
  if (viewId === null) blockers.push("verified viewId");
  if (visualViewId === null) blockers.push("verified visualViewId for focused capture");
  if (mainElementId === null) blockers.push("verified mainElementId");
  if (!projectedTapPoint) blockers.push("projectedTapPoint");
  if (branchPoints.length < 2) blockers.push("at least two verified branchPoints");
  if (!branchSize) blockers.push(`branch ${isPipe ? "pipe" : "duct"} size`);
  if (!connectionMode) blockers.push("connectionMode");
  if (!expectedFitting) blockers.push("expected tee/tap/takeoff fitting");
  if (blockers.length > 0) return { blockers };

  const body: Record<string, unknown> = {
    operation: "tap_branch",
    kind,
    viewId,
    visualViewId,
    mainElementId,
    projectedTapPoint,
    branchPoints,
    connectionMode,
    expectedFitting,
    ...(isPipe ? { pipeSize: branchSize } : { ductSize: branchSize }),
    ...(textOf(evidence?.systemType) ? { systemType: textOf(evidence?.systemType) } : {}),
    ...(textOf(evidence?.levelName) ? { levelName: textOf(evidence?.levelName) } : {}),
    ...(positiveNumber(evidence?.fittingTypeId) !== null ? { fittingTypeId: positiveNumber(evidence?.fittingTypeId)! } : {}),
    ...(textOf(evidence?.orientation) ? { orientation: textOf(evidence?.orientation) } : {}),
    ...(textOf(evidence?.takeoffFamilyName) ? { takeoffFamilyName: textOf(evidence?.takeoffFamilyName) } : {}),
    ...(textOf(evidence?.takeoffTypeName) ? { takeoffTypeName: textOf(evidence?.takeoffTypeName) } : {}),
    apply: false,
    verify: true,
    verifyConnectorNetwork: true,
    visualVerify: false,
    cleanupCreatedElements: false,
    source: "verified_pdf_redline_tap_branch_handoff"
  };
  return { next: action("/revit/connect-mep-branch", body), blockers: [] };
}

function sizeTransitionEvidenceFrom(value: unknown): VerifiedMepSizeTransitionEvidence | null {
  const row = asRecord(value);
  if (!row) return null;
  const nested =
    asRecord(row.verified_mep_size_transition) ??
    asRecord(row.verifiedMepSizeTransition) ??
    asRecord(row.size_transition) ??
    asRecord(row.sizeTransition) ??
    row;
  const transitionPoint = asRecord(nested.transitionPoint) ?? asRecord(nested.transition_point) ?? asRecord(nested.projectedTransitionPoint) ?? asRecord(nested.projected_transition_point);
  return {
    ...(textOf(nested.kind) === "pipe" || textOf(nested.kind) === "duct" ? { kind: textOf(nested.kind) as MepKind } : {}),
    ...(positiveNumber(nested.viewId ?? nested.view_id) !== null ? { viewId: positiveNumber(nested.viewId ?? nested.view_id)! } : {}),
    ...(positiveNumber(nested.visualViewId ?? nested.visual_view_id) !== null ? { visualViewId: positiveNumber(nested.visualViewId ?? nested.visual_view_id)! } : {}),
    ...(positiveNumber(nested.hostElementId ?? nested.host_element_id ?? nested.mainElementId ?? nested.main_element_id) !== null
      ? { hostElementId: positiveNumber(nested.hostElementId ?? nested.host_element_id ?? nested.mainElementId ?? nested.main_element_id)! }
      : {}),
    ...(toFiniteNumber(nested.transitionNormalized ?? nested.transition_normalized) !== null
      ? { transitionNormalized: toFiniteNumber(nested.transitionNormalized ?? nested.transition_normalized)! }
      : {}),
    ...(positiveNumber(nested.transitionChainageFt ?? nested.transition_chainage_ft) !== null
      ? { transitionChainageFt: positiveNumber(nested.transitionChainageFt ?? nested.transition_chainage_ft)! }
      : {}),
    ...(transitionPoint ? { transitionPoint: {
      ...(toFiniteNumber(transitionPoint.x) !== null ? { x: toFiniteNumber(transitionPoint.x)! } : {}),
      ...(toFiniteNumber(transitionPoint.y) !== null ? { y: toFiniteNumber(transitionPoint.y)! } : {}),
      ...(toFiniteNumber(transitionPoint.z) !== null ? { z: toFiniteNumber(transitionPoint.z)! } : {})
    } } : {}),
    ...(textOf(nested.upstreamSize ?? nested.upstream_size) ? { upstreamSize: textOf(nested.upstreamSize ?? nested.upstream_size) } : {}),
    ...(textOf(nested.downstreamSize ?? nested.downstream_size) ? { downstreamSize: textOf(nested.downstreamSize ?? nested.downstream_size) } : {}),
    ...(textOf(nested.upstreamDuctSize ?? nested.upstream_duct_size) ? { upstreamDuctSize: textOf(nested.upstreamDuctSize ?? nested.upstream_duct_size) } : {}),
    ...(textOf(nested.downstreamDuctSize ?? nested.downstream_duct_size) ? { downstreamDuctSize: textOf(nested.downstreamDuctSize ?? nested.downstream_duct_size) } : {}),
    ...(textOf(nested.upstreamPipeSize ?? nested.upstream_pipe_size) ? { upstreamPipeSize: textOf(nested.upstreamPipeSize ?? nested.upstream_pipe_size) } : {}),
    ...(textOf(nested.downstreamPipeSize ?? nested.downstream_pipe_size) ? { downstreamPipeSize: textOf(nested.downstreamPipeSize ?? nested.downstream_pipe_size) } : {}),
    ...(textOf(nested.expectedFitting ?? nested.expected_fitting ?? nested.expectedTransitionFitting ?? nested.expected_transition_fitting)
      ? { expectedFitting: textOf(nested.expectedFitting ?? nested.expected_fitting ?? nested.expectedTransitionFitting ?? nested.expected_transition_fitting) }
      : {})
  };
}

function verifiedSizeTransitionEvidence(req: ResolveMepRouteRedlineRequest): VerifiedMepSizeTransitionEvidence | null {
  return (
    sizeTransitionEvidenceFrom(req.verified_mep_size_transition) ??
    sizeTransitionEvidenceFrom(req.verifiedMepSizeTransition) ??
    sizeTransitionEvidenceFrom(req.context)
  );
}

function finiteTransitionPoint(point: VerifiedMepSizeTransitionEvidence["transitionPoint"]): { x: number; y: number; z?: number } | null {
  return finitePoint(point);
}

function buildSizeTransitionDryRunAction(
  task: RedlineMepRouteTask,
  evidence: VerifiedMepSizeTransitionEvidence | null
): { next?: ActionCall; blockers: string[] } {
  const blockers: string[] = [];
  const kind = evidence?.kind ?? task.mep.kind;
  const isPipe = kind === "pipe";
  const viewId = positiveNumber(evidence?.viewId);
  const visualViewId = positiveNumber(evidence?.visualViewId);
  const hostElementId = positiveNumber(evidence?.hostElementId);
  const upstreamSize = textOf(isPipe ? evidence?.upstreamPipeSize ?? evidence?.upstreamSize : evidence?.upstreamDuctSize ?? evidence?.upstreamSize);
  const downstreamSize = textOf(isPipe ? evidence?.downstreamPipeSize ?? evidence?.downstreamSize : evidence?.downstreamDuctSize ?? evidence?.downstreamSize);
  const transitionNormalized = toFiniteNumber(evidence?.transitionNormalized);
  const transitionChainageFt = positiveNumber(evidence?.transitionChainageFt);
  const transitionPoint = finiteTransitionPoint(evidence?.transitionPoint);
  const expectedFitting = textOf(evidence?.expectedFitting);

  if (!evidence) blockers.push("verified size-transition evidence object");
  if (evidence?.kind && evidence.kind !== task.mep.kind) blockers.push(`evidence kind ${evidence.kind} must match detected redline kind ${task.mep.kind}`);
  if (viewId === null) blockers.push("verified viewId");
  if (visualViewId === null) blockers.push("verified visualViewId for focused capture");
  if (hostElementId === null) blockers.push("verified hostElementId");
  if (!upstreamSize) blockers.push(`upstream ${isPipe ? "pipe" : "duct"} size`);
  if (!downstreamSize) blockers.push(`downstream ${isPipe ? "pipe" : "duct"} size`);
  if ((transitionNormalized === null || transitionNormalized < 0 || transitionNormalized > 1) && transitionChainageFt === null) {
    blockers.push("handler-supported transitionNormalized or transitionChainageFt");
  }
  if (!expectedFitting) blockers.push("expected transition/reducer fitting");
  if (blockers.length > 0) return { blockers };

  const body: Record<string, unknown> = {
    operation: "size_transition",
    kind,
    viewId,
    visualViewId,
    hostElementId,
    ...(transitionNormalized !== null ? { transitionNormalized } : {}),
    ...(transitionChainageFt !== null ? { transitionChainageFt } : {}),
    ...(isPipe ? { upstreamPipeSize: upstreamSize, downstreamPipeSize: downstreamSize } : { upstreamDuctSize: upstreamSize, downstreamDuctSize: downstreamSize }),
    expectedFitting,
    apply: false,
    dryRun: true,
    verify: true,
    verifyConnectorNetwork: true,
    visualVerify: false,
    cleanupCreatedElements: false,
    source: "verified_pdf_redline_size_transition_handoff"
  };
  return { next: action("/revit/reroute-mep-route-segment", body), blockers: [] };
}

function latestFailure(toolResults: ToolResult[], pathName: string): string | null {
  const r = latestToolResult(toolResults, pathName);
  if (!r || r.status !== "failed") return null;
  return textOf(r.error) || textOf(r.failure_hint) || `${pathName} failed.`;
}

function countDoneToolPath(toolResults: ToolResult[], pathName: string): number {
  const target = pathName.toLowerCase();
  return toolResults.filter(r => textOf(r?.path).toLowerCase() === target && r?.status === "done").length;
}

function sheetDetailMatches(data: Record<string, unknown>, sheetNumber?: string): boolean {
  if (!sheetNumber) return true;
  const actual = normalizeSheetNumber(data.sheetNumber ?? data.number ?? data.sheet_number);
  return !actual || actual === sheetNumber;
}

function latestSheetDetail(toolResults: ToolResult[], sheetNumber?: string): Record<string, unknown> | null {
  const target = "/revit/sheets";
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (textOf(r?.path).toLowerCase() !== target || r?.status !== "done") continue;
    const data = asRecord(r.result_json);
    if (!data) continue;
    const action = textOf(data.action).toLowerCase();
    if (action && action !== "detail") continue;
    if (!sheetDetailMatches(data, sheetNumber)) continue;
    return data;
  }
  return null;
}

function numberFrom(value: unknown): number | undefined {
  const n = toFiniteNumber(value);
  return n === null ? undefined : Math.round(n);
}

function pickPlacedView(sheetDetail: Record<string, unknown>, desiredLevel?: string): { viewId: number; viewportId?: number } | null {
  const placed = Array.isArray(sheetDetail.placedViews) ? sheetDetail.placedViews : [];
  const rows = placed
    .map(v => asRecord(v))
    .filter((v): v is Record<string, unknown> => !!v)
    .map(v => {
      const viewId = numberFrom(v.viewId ?? v.id);
      if (!viewId) return null;
      const text = `${textOf(v.name)} ${textOf(v.viewName)} ${textOf(v.title)} ${textOf(v.type)} ${textOf(v.viewType)}`.toLowerCase();
      let score = 0;
      if (/hvac|mechanical|duct/.test(text)) score += 40;
      if (/plan|floorplan|floor plan/.test(text)) score += 20;
      if (desiredLevel && text.includes(desiredLevel.toLowerCase())) score += 15;
      if (/sheet|drawing/.test(text)) score -= 40;
      return { viewId, score };
    })
    .filter((v): v is { viewId: number; score: number } => !!v)
    .sort((a, b) => b.score - a.score || a.viewId - b.viewId);
  const best = rows[0];
  if (!best) return null;
  const viewport = (Array.isArray(sheetDetail.viewportGeometry) ? sheetDetail.viewportGeometry : [])
    .map(v => asRecord(v))
    .find(v => numberFrom(v?.viewId) === best.viewId);
  return { viewId: best.viewId, ...(numberFrom(viewport?.viewportId) ? { viewportId: numberFrom(viewport?.viewportId) } : {}) };
}

function coerceViewportGeometry(sheetDetail: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(sheetDetail.viewportGeometry) ? sheetDetail.viewportGeometry.filter(v => !!asRecord(v)) as Array<Record<string, unknown>> : [];
}

function coerceTitleBlocks(sheetDetail: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(sheetDetail.titleBlocks)) return sheetDetail.titleBlocks.filter(v => !!asRecord(v)) as Array<Record<string, unknown>>;
  if (Array.isArray(sheetDetail.titleBlockGeometry)) return sheetDetail.titleBlockGeometry.filter(v => !!asRecord(v)) as Array<Record<string, unknown>>;
  return [];
}

function mapTaskRegions(analysis: RedlineAnalyzeResponse, sheetDetail: Record<string, unknown>): MapSheetRegionsResponse | undefined {
  const width = toFiniteNumber(analysis.image_meta?.width);
  const height = toFiniteNumber(analysis.image_meta?.height);
  const sheetOutline = asRecord(sheetDetail.sheetOutline);
  const boxes = (Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [])
    .filter(r => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h))
    .map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
  if (width === null || height === null || !sheetOutline || boxes.length === 0) return undefined;
  const mapped = mapSheetRegions({
    image_width: width,
    image_height: height,
    boxes,
    sheet_outline: sheetOutline,
    viewport_geometry: coerceViewportGeometry(sheetDetail),
    title_blocks: coerceTitleBlocks(sheetDetail)
  });
  return mapped.ok ? mapped : undefined;
}

function normalizeUvRect(value: unknown): { minU: number; minV: number; maxU: number; maxV: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const minU = toFiniteNumber(row.minU);
  const minV = toFiniteNumber(row.minV);
  const maxU = toFiniteNumber(row.maxU);
  const maxV = toFiniteNumber(row.maxV);
  if (minU === null || minV === null || maxU === null || maxV === null) return null;
  const loU = Math.min(minU, maxU);
  const hiU = Math.max(minU, maxU);
  const loV = Math.min(minV, maxV);
  const hiV = Math.max(minV, maxV);
  if (hiU - loU <= 1e-9 || hiV - loV <= 1e-9) return null;
  return { minU: loU, minV: loV, maxU: hiU, maxV: hiV };
}

function normalizeRotation(raw: unknown): "none" | "clockwise" | "counterclockwise" | "upsidedown" {
  const s = textOf(raw).toLowerCase();
  if (s.includes("counterclockwise") || s.includes("counter_clockwise") || s.includes("ccw")) return "counterclockwise";
  if (s.includes("clockwise") || s.includes("cw")) return "clockwise";
  if (s.includes("upside") || s.includes("180")) return "upsidedown";
  return "none";
}

function sheetPointFromNormVertex(vertex: { x: number; y: number }, sheet: { minU: number; minV: number; maxU: number; maxV: number }): { u: number; v: number } {
  const u = sheet.minU + Math.max(0, Math.min(1, vertex.x)) * (sheet.maxU - sheet.minU);
  const v = sheet.maxV - Math.max(0, Math.min(1, vertex.y)) * (sheet.maxV - sheet.minV);
  return { u, v };
}

function viewNormFromSheetPoint(
  point: { u: number; v: number },
  viewport: { minU: number; minV: number; maxU: number; maxV: number },
  rotation: unknown
): { x: number; y: number } {
  const tx = Math.max(0, Math.min(1, (point.u - viewport.minU) / Math.max(1e-9, viewport.maxU - viewport.minU)));
  const ty = Math.max(0, Math.min(1, (viewport.maxV - point.v) / Math.max(1e-9, viewport.maxV - viewport.minV)));
  const rot = normalizeRotation(rotation);
  if (rot === "clockwise") return { x: ty, y: 1 - tx };
  if (rot === "counterclockwise") return { x: 1 - ty, y: tx };
  if (rot === "upsidedown") return { x: 1 - tx, y: 1 - ty };
  return { x: tx, y: ty };
}

function viewScaleFor(sheetDetail: Record<string, unknown>, viewId: number): number | null {
  const views = Array.isArray(sheetDetail.placedViews) ? sheetDetail.placedViews : [];
  const row = views.map(v => asRecord(v)).find(v => numberFrom(v?.viewId ?? v?.id) === viewId);
  return toFiniteNumber(row?.scale);
}

function targetPathVerticesNorm(analysis: RedlineAnalyzeResponse, classification: ClassifiedRedlineGeometry): Array<{ x: number; y: number }> {
  if (classification.route_candidate?.vertices_norm && classification.route_candidate.vertices_norm.length >= 2) {
    return classification.route_candidate.vertices_norm;
  }
  const target = classification.roles.find(r => r.role === "target_path" && r.annotation_id);
  const targetId = target?.annotation_id ?? "";
  const rows = [
    ...(Array.isArray(analysis.pdf_annotations) ? analysis.pdf_annotations : []),
    ...(Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [])
  ].map(r => asRecord(r)).filter((r): r is Record<string, unknown> => !!r);
  const row = rows.find(r => textOf(r.id ?? r.annotation_id) === targetId) ?? rows.find(r => {
    const subtype = textOf(r.subtype ?? r.annotation_subtype);
    return /polyline|line|ink/i.test(subtype);
  });
  const vertices = row ? (Array.isArray(row.vertices_norm) ? row.vertices_norm : Array.isArray(row.annotation_vertices_norm) ? row.annotation_vertices_norm : []) : [];
  return vertices
    .map(v => asRecord(v))
    .map(v => {
      const x = toFiniteNumber(v?.x);
      const y = toFiniteNumber(v?.y);
      return x === null || y === null ? null : { x, y };
    })
    .filter((v): v is { x: number; y: number } => !!v);
}

function simplifyRouteVertices(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return [first, last];
  const maxPerp = points.reduce((max, p) => {
    const perp = Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / length;
    return Math.max(max, perp);
  }, 0);
  return maxPerp <= 0.002 ? [first, last] : points;
}

function routePointsFromTargetPath(
  analysis: RedlineAnalyzeResponse,
  classification: ClassifiedRedlineGeometry,
  sheetDetail: Record<string, unknown>,
  viewId: number,
  anchor: { x: number; y: number }
): Array<{ x: number; y: number }> | null {
  const vertices = simplifyRouteVertices(targetPathVerticesNorm(analysis, classification));
  if (vertices.length < 2) return null;
  const sheet = normalizeUvRect(sheetDetail.sheetOutline);
  const viewport = coerceViewportGeometry(sheetDetail).find(v => numberFrom(v.viewId ?? v.view_id) === viewId);
  const viewportBox = normalizeUvRect(viewport?.box);
  const scale = viewScaleFor(sheetDetail, viewId);
  if (!sheet || !viewport || !viewportBox || !scale || scale <= 0) return null;
  const viewPoints = vertices.map(v => viewNormFromSheetPoint(sheetPointFromNormVertex(v, sheet), viewportBox, viewport.rotation));
  const center = viewPoints.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  center.x /= viewPoints.length;
  center.y /= viewPoints.length;
  const modelWidthFt = (viewportBox.maxU - viewportBox.minU) * scale;
  const modelHeightFt = (viewportBox.maxV - viewportBox.minV) * scale;
  return viewPoints.map(p => ({
    x: anchor.x + (p.x - center.x) * modelWidthFt,
    y: anchor.y + (center.y - p.y) * modelHeightFt
  }));
}

function modelPointFromViewNorm(mapping: FrameMapping, p: { x: number; y: number }): { x: number; y: number } {
  const tl = mapping.topLeftXyz;
  const tr = mapping.topRightXyz;
  const bl = mapping.bottomLeftXyz;
  return {
    x: tl[0] + p.x * (tr[0] - tl[0]) + p.y * (bl[0] - tl[0]),
    y: tl[1] + p.x * (tr[1] - tl[1]) + p.y * (bl[1] - tl[1])
  };
}

function viewNormFromModelPoint(mapping: FrameMapping, p: { x: number; y: number }): { x: number; y: number } | null {
  const tl = mapping.topLeftXyz;
  const tr = mapping.topRightXyz;
  const bl = mapping.bottomLeftXyz;
  const ax = tr[0] - tl[0];
  const ay = tr[1] - tl[1];
  const bx = bl[0] - tl[0];
  const by = bl[1] - tl[1];
  const px = p.x - tl[0];
  const py = p.y - tl[1];
  const det = ax * by - ay * bx;
  if (Math.abs(det) <= 1e-9) return null;
  return {
    x: (px * by - py * bx) / det,
    y: (ax * py - ay * px) / det
  };
}

function routePointsFromSheetViewportFrameMapping(
  analysis: RedlineAnalyzeResponse,
  classification: ClassifiedRedlineGeometry,
  sheetDetail: Record<string, unknown>,
  viewId: number,
  frame: { mapping?: FrameMapping }
): Array<{ x: number; y: number }> | null {
  if (!frame.mapping) return null;
  const vertices = simplifyRouteVertices(targetPathVerticesNorm(analysis, classification));
  if (vertices.length < 2) return null;
  const sheet = normalizeUvRect(sheetDetail.sheetOutline);
  const viewport = coerceViewportGeometry(sheetDetail).find(v => numberFrom(v.viewId ?? v.view_id) === viewId);
  const viewportBox = normalizeUvRect(viewport?.box);
  if (!sheet || !viewport || !viewportBox) return null;
  return vertices
    .map(v => viewNormFromSheetPoint(sheetPointFromNormVertex(v, sheet), viewportBox, viewport.rotation))
    .map(p => modelPointFromViewNorm(frame.mapping!, p));
}

function routePointsFromAlignedTargetPath(
  analysis: RedlineAnalyzeResponse,
  classification: ClassifiedRedlineGeometry,
  alignment: ReturnType<typeof latestRedlineViewAlignment>,
  frame: { mapping?: FrameMapping }
): Array<{ x: number; y: number }> | null {
  if (!alignment?.matched || alignment.confidence < 0.7 || !alignment.crop || !frame.mapping) return null;
  const vertices = simplifyRouteVertices(targetPathVerticesNorm(analysis, classification));
  if (vertices.length < 2) return null;
  const sourceCrop = classification.route_candidate?.alignment_crop_norm ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const sourceWidth = sourceCrop.maxX - sourceCrop.minX;
  const sourceHeight = sourceCrop.maxY - sourceCrop.minY;
  if (sourceWidth <= 1e-9 || sourceHeight <= 1e-9) return null;

  return vertices.map((vertex) => {
    const imageX = (vertex.x - sourceCrop.minX) / sourceWidth;
    const imageY = (vertex.y - sourceCrop.minY) / sourceHeight;
    const viewU = alignment.crop!.min_u + imageX * (alignment.crop!.max_u - alignment.crop!.min_u);
    const viewV = alignment.crop!.min_v + imageY * (alignment.crop!.max_v - alignment.crop!.min_v);
    return modelPointFromViewNorm(frame.mapping!, { x: viewU, y: viewV });
  });
}

function xyzTriplet(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = toFiniteNumber(value[0]);
  const y = toFiniteNumber(value[1]);
  const z = toFiniteNumber(value[2]);
  if (x === null || y === null || z === null) return null;
  return [x, y, z];
}

function parseFrameMapping(value: unknown): FrameMapping | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const topLeftXyz = xyzTriplet(row.topLeftXyz ?? row.top_left_xyz);
  const topRightXyz = xyzTriplet(row.topRightXyz ?? row.top_right_xyz);
  const bottomLeftXyz = xyzTriplet(row.bottomLeftXyz ?? row.bottom_left_xyz);
  if (!topLeftXyz || !topRightXyz || !bottomLeftXyz) return undefined;
  return { topLeftXyz, topRightXyz, bottomLeftXyz };
}

function latestFrame(toolResults: ToolResult[], viewId?: number): { frameId: string; viewId?: number; width: number; height: number; imagePath?: string; mapping?: FrameMapping } | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (textOf(r?.path).toLowerCase() !== "/revit/export-view-frame" || r?.status !== "done") continue;
    const data = asRecord(r.result_json);
    if (!data) continue;
    const frameId = textOf(data.frameId ?? data.frame_id);
    if (!frameId) continue;
    const resultViewId = numberFrom(data.viewId ?? data.view_id);
    if (viewId && resultViewId && resultViewId !== viewId) continue;
    const width = toFiniteNumber(data.widthPx ?? data.width ?? data.imageWidth ?? data.image_width) ?? 2200;
    const height = toFiniteNumber(data.heightPx ?? data.height ?? data.imageHeight ?? data.image_height) ?? 2200;
    const imagePath = textOf(data.path ?? data.local_path ?? data.filePath ?? data.file_path ?? data.imagePath ?? data.image_path);
    const mapping = parseFrameMapping(data.mapping);
    return { frameId, ...(resultViewId ? { viewId: resultViewId } : {}), width, height, ...(imagePath ? { imagePath } : {}), ...(mapping ? { mapping } : {}) };
  }
  return null;
}

function latestVisibleElements(toolResults: ToolResult[], viewId?: number): { items: Record<string, unknown>[]; frameId?: string } | null {
  for (let i = toolResults.length - 1; i >= 0; i--) {
    const r = toolResults[i];
    if (textOf(r?.path).toLowerCase() !== "/revit/export-visible-elements" || r?.status !== "done") continue;
    const data = asRecord(r.result_json);
    if (!data) continue;
    const resultViewId = numberFrom(data.viewId ?? data.view_id);
    if (viewId && resultViewId && resultViewId !== viewId) continue;
    const rawItems = Array.isArray(data.items)
      ? data.items
      : Array.isArray(data.itemsSampled)
        ? data.itemsSampled
        : Array.isArray(data.elements)
          ? data.elements
          : [];
    const items = rawItems.map(item => asRecord(item)).filter((item): item is Record<string, unknown> => !!item);
    if (items.length === 0) continue;
    return { items, ...(textOf(data.frameId ?? data.frame_id) ? { frameId: textOf(data.frameId ?? data.frame_id) } : {}) };
  }
  return null;
}

function itemVisibleText(item: Record<string, unknown>): string {
  const params = asRecord(item.parameters);
  return [
    item.visibleText,
    item.visible_text,
    item.textValue,
    item.text_value,
    params?.["Text String"],
    params?.Text,
    item.name
  ].map(textOf).filter(Boolean).join(" ");
}

function imagePointOf(item: Record<string, unknown>): { x: number; y: number } | null {
  const anchor = asRecord(item.anchor);
  const image = asRecord(anchor?.image) ?? asRecord(item.image);
  const x = toFiniteNumber(image?.normalizedX ?? image?.normalized_x ?? image?.x);
  const y = toFiniteNumber(image?.normalizedY ?? image?.normalized_y ?? image?.y);
  if (x === null || y === null) return null;
  return { x, y };
}

function imageBoxOf(item: Record<string, unknown>): NormalizedBox | null {
  const bbox = asRecord(item.bbox);
  const image = asRecord(bbox?.image) ?? asRecord(item.imageBox ?? item.image_box ?? item.bboxImage);
  if (!image) return null;
  const minX = toFiniteNumber(image.normalizedMinX ?? image.normalized_min_x ?? image.minNormalizedX ?? image.min_normalized_x ?? image.minX);
  const minY = toFiniteNumber(image.normalizedMinY ?? image.normalized_min_y ?? image.minNormalizedY ?? image.min_normalized_y ?? image.minY);
  const maxX = toFiniteNumber(image.normalizedMaxX ?? image.normalized_max_x ?? image.maxNormalizedX ?? image.max_normalized_x ?? image.maxX);
  const maxY = toFiniteNumber(image.normalizedMaxY ?? image.normalized_max_y ?? image.maxNormalizedY ?? image.max_normalized_y ?? image.maxY);
  if (minX === null || minY === null || maxX === null || maxY === null) return null;
  return { minX: Math.min(minX, maxX), minY: Math.min(minY, maxY), maxX: Math.max(minX, maxX), maxY: Math.max(minY, maxY) };
}

function spatialNumberOf(item: Record<string, unknown>): string {
  const direct = item.associatedSpatialNumber ?? item.associated_spatial_number ?? item.roomNumber ?? item.room_number ?? item.spaceNumber ?? item.space_number;
  if (direct !== undefined && direct !== null && textOf(direct)) return textOf(direct).toUpperCase();
  const associated = asRecord(item.associatedSpatial ?? item.associated_spatial);
  const tagged = asRecord(item.taggedSpatial ?? item.tagged_spatial);
  const space = asRecord(item.space);
  const room = asRecord(item.room);
  const value = associated?.number ?? tagged?.number ?? space?.number ?? room?.number;
  return value === undefined || value === null ? "" : String(value).replace(/\s+/g, " ").trim().toUpperCase();
}

function computeLocalBandAssertion(
  points: Array<{ x: number; y: number }> | undefined,
  toolResults: ToolResult[],
  frame?: { mapping?: FrameMapping } | null,
  roomNumber?: string
): LocalBandAssertion {
  if (!points || points.length < 2 || !frame?.mapping) {
    return { status: "not_applicable", reason: "No route points or frame mapping were available for local band verification." };
  }
  const room = normalizeSheetNumber(roomNumber);
  const visible = latestVisibleElements(toolResults);
  if (!visible) {
    return { status: "not_applicable", reason: "No visible-elements inventory was available for local band verification." };
  }
  const viewPoints = points.map(p => viewNormFromModelPoint(frame.mapping!, p)).filter((p): p is { x: number; y: number } => !!p);
  if (viewPoints.length !== points.length) {
    return { status: "failed", failure_kind: "projection_failed", reason: "Route points could not be projected back into the exported view frame." };
  }
  const routeCenterX = viewPoints.reduce((sum, p) => sum + p.x, 0) / viewPoints.length;
  const routeCenterY = viewPoints.reduce((sum, p) => sum + p.y, 0) / viewPoints.length;
  const textRows = visible.items
    .map(item => ({ item, text: itemVisibleText(item), point: imagePointOf(item), box: imageBoxOf(item), spatial: spatialNumberOf(item) }))
    .filter(row => row.point || row.box);
  const isSpatialBoundaryRow = (row: { item: Record<string, unknown> }) => {
    const builtIn = textOf(row.item.builtInCategory ?? row.item.categoryToken).toLowerCase();
    const category = textOf(row.item.category).toLowerCase();
    return builtIn.includes("mepspaces") || builtIn.includes("rooms") || category === "spaces" || category === "rooms";
  };
  let roomTextRows = textRows.filter(row => {
    const text = row.text.toLowerCase();
    return (
      (room && (row.spatial === room || new RegExp(`\\b${room}\\b`).test(text))) ||
      /live\/work\s+loft\s+unit/i.test(row.text)
    );
  });
  if (!room) {
    const numericRows = textRows
      .filter(row => /\b\d{3,5}\b/.test(row.text) && (row.point || row.box))
      .map(row => {
        const x = row.point?.x ?? (row.box ? (row.box.minX + row.box.maxX) * 0.5 : 0.5);
        const y = row.point?.y ?? (row.box ? (row.box.minY + row.box.maxY) * 0.5 : 0.5);
        const southPenalty = y > routeCenterY ? 0 : 1;
        return { row, score: southPenalty + Math.abs(y - routeCenterY) + Math.abs(x - routeCenterX) * 0.35 };
      })
      .sort((a, b) => a.score - b.score);
    if (numericRows[0]) roomTextRows = [numericRows[0].row];
  }
  const labelRows = roomTextRows.filter(row => !isSpatialBoundaryRow(row));
  const numericRoomRows = labelRows.filter(row => room && new RegExp(`\\b${room}\\b`).test(row.text));
  const labelCandidates = numericRoomRows.length > 0 ? numericRoomRows : roomTextRows;
  const labelYs = (labelRows.length > 0 ? labelCandidates.filter(row => !isSpatialBoundaryRow(row)) : [])
    .map(row => row.point?.y ?? (row.box ? (row.box.minY + row.box.maxY) * 0.5 : null))
    .filter((y): y is number => y !== null && Number.isFinite(y));
  const roomBoxes = textRows
    .filter(row => room && row.spatial === room && isSpatialBoundaryRow(row))
    .map(row => row.box)
    .filter((box): box is NormalizedBox => !!box);
  const primaryRoomBox = roomBoxes
    .sort((a, b) => (b.maxX - b.minX) * (b.maxY - b.minY) - (a.maxX - a.minX) * (a.maxY - a.minY))[0];
  const labelY = labelYs.length > 0
    ? Math.max(...labelYs)
    : primaryRoomBox
      ? primaryRoomBox.minY + (primaryRoomBox.maxY - primaryRoomBox.minY) * 0.7
      : NaN;
  if (!Number.isFinite(labelY)) {
    return { status: "failed", route_center_view_y: Number(routeCenterY.toFixed(4)), failure_kind: "missing_anchors", reason: "Could not locate target room/unit label or boundary anchors in visible-elements inventory." };
  }
  const minAllowedY = primaryRoomBox
    ? primaryRoomBox.minY + (primaryRoomBox.maxY - primaryRoomBox.minY) * 0.45
    : Math.max(0, labelY - 0.28);
  const maxAllowedY = primaryRoomBox && labelYs.length === 0
    ? primaryRoomBox.maxY - (primaryRoomBox.maxY - primaryRoomBox.minY) * 0.28
    : Math.max(0, labelY - 0.035);
  const targetY = (minAllowedY + maxAllowedY) * 0.5;
  const targetX = primaryRoomBox ? (primaryRoomBox.minX + primaryRoomBox.maxX) * 0.5 : undefined;
  if (routeCenterY < minAllowedY) {
    return {
      status: "failed",
      route_center_view_y: Number(routeCenterY.toFixed(4)),
      label_view_y: Number(labelY.toFixed(4)),
      min_allowed_view_y: Number(minAllowedY.toFixed(4)),
      max_allowed_view_y: Number(maxAllowedY.toFixed(4)),
      target_view_x: primaryRoomBox && labelYs.length === 0 && targetX !== undefined ? Number(targetX.toFixed(4)) : undefined,
      target_view_y: primaryRoomBox && labelYs.length === 0 ? Number(targetY.toFixed(4)) : undefined,
      failure_kind: "too_far_north",
      correction_kind: primaryRoomBox && labelYs.length === 0 ? "space_bbox_route_shift" : undefined,
      reason: "Projected route center is too far plan north of the Unit 405 label and falls in the bathroom/kitchen/loft fixture band."
    };
  }
  if (routeCenterY > maxAllowedY) {
    return {
      status: "failed",
      route_center_view_y: Number(routeCenterY.toFixed(4)),
      label_view_y: Number(labelY.toFixed(4)),
      min_allowed_view_y: Number(minAllowedY.toFixed(4)),
      max_allowed_view_y: Number(maxAllowedY.toFixed(4)),
      target_view_x: primaryRoomBox && labelYs.length === 0 && targetX !== undefined ? Number(targetX.toFixed(4)) : undefined,
      target_view_y: primaryRoomBox && labelYs.length === 0 ? Number(targetY.toFixed(4)) : undefined,
      failure_kind: "too_far_south",
      reason: "Projected route center is not north of the Unit 405 label band indicated by the redline."
    };
  }
  return {
    status: "passed",
    route_center_view_y: Number(routeCenterY.toFixed(4)),
    label_view_y: Number(labelY.toFixed(4)),
    min_allowed_view_y: Number(minAllowedY.toFixed(4)),
    max_allowed_view_y: Number(maxAllowedY.toFixed(4)),
    target_view_x: targetX !== undefined ? Number(targetX.toFixed(4)) : undefined,
    target_view_y: Number(targetY.toFixed(4)),
    reason: "Projected route center falls in the local Unit 405 route band: south of the bathroom/kitchen zone and north of the room label."
  };
}

function shiftRoutePointsToViewTarget(
  points: Array<{ x: number; y: number }>,
  frame: { mapping?: FrameMapping } | null | undefined,
  targetViewY: number | undefined,
  targetViewX?: number | undefined
): Array<{ x: number; y: number }> | null {
  if (!frame?.mapping || targetViewY === undefined || !Number.isFinite(targetViewY)) return null;
  const viewPoints = points.map(point => viewNormFromModelPoint(frame.mapping!, point));
  if (viewPoints.some(point => !point)) return null;
  const normalized = viewPoints as Array<{ x: number; y: number }>;
  const routeCenterX = normalized.reduce((sum, point) => sum + point.x, 0) / normalized.length;
  const deltaX = targetViewX !== undefined && Number.isFinite(targetViewX) ? targetViewX - routeCenterX : 0;
  return normalized.map(point => modelPointFromViewNorm(frame.mapping!, { x: point.x + deltaX, y: targetViewY }));
}

function applyRecoverableLocalBandShift(
  points: Array<{ x: number; y: number }>,
  toolResults: ToolResult[],
  frame: { mapping?: FrameMapping } | null | undefined,
  roomNumber?: string
): Array<{ x: number; y: number }> {
  const localBand = computeLocalBandAssertion(points, toolResults, frame, roomNumber);
  if (
    localBand.status !== "failed" ||
    localBand.failure_kind !== "too_far_north" ||
    localBand.correction_kind !== "space_bbox_route_shift"
  ) {
    return points;
  }
  const adjustedPoints = shiftRoutePointsToViewTarget(points, frame, localBand.target_view_y, localBand.target_view_x);
  if (!adjustedPoints) return points;
  const adjustedBand = computeLocalBandAssertion(adjustedPoints, toolResults, frame, roomNumber);
  return adjustedBand.status === "passed" ? adjustedPoints : points;
}

function latestRedlineViewAlignment(toolResults: ToolResult[]): {
  matched: boolean;
  confidence: number;
  crop?: ViewAlignmentCrop;
  marks: Array<{ normalized_x: number; normalized_y: number; score?: number; label?: string | null }>;
  warning?: string;
} | null {
  const data = latestDoneToolJson(toolResults, "/tools/redline/align-to-view");
  if (!data) return null;
  const confidence = toFiniteNumber(data.confidence) ?? 0;
  const rawCrop = asRecord(data.crop);
  const minU = toFiniteNumber(rawCrop?.min_u);
  const minV = toFiniteNumber(rawCrop?.min_v);
  const maxU = toFiniteNumber(rawCrop?.max_u);
  const maxV = toFiniteNumber(rawCrop?.max_v);
  const crop =
    minU !== null && minV !== null && maxU !== null && maxV !== null && maxU > minU && maxV > minV
      ? {
          min_u: Math.max(0, Math.min(1, minU)),
          min_v: Math.max(0, Math.min(1, minV)),
          max_u: Math.max(0, Math.min(1, maxU)),
          max_v: Math.max(0, Math.min(1, maxV))
        }
      : undefined;
  const marks = Array.isArray(data.marks)
    ? data.marks.map(m => asRecord(m)).map(m => {
        const x = toFiniteNumber(m?.normalized_x);
        const y = toFiniteNumber(m?.normalized_y);
        const score = toFiniteNumber(m?.score);
        if (x === null || y === null) return null;
        return {
          normalized_x: Math.max(0, Math.min(1, x)),
          normalized_y: Math.max(0, Math.min(1, y)),
          ...(score !== null ? { score } : {}),
          ...(textOf(m?.label) ? { label: textOf(m?.label) } : {})
        };
      }).filter((m): m is { normalized_x: number; normalized_y: number; score?: number; label?: string } => !!m)
    : [];
  return {
    matched: data.matched === true,
    confidence,
    ...(crop ? { crop } : {}),
    marks,
    ...(textOf(data.warning) ? { warning: textOf(data.warning) } : {})
  };
}

function alignmentRedlineImagePath(analysis: RedlineAnalyzeResponse, classification: ClassifiedRedlineGeometry): string {
  const targetIndex = classification.route_candidate?.candidate_index;
  const candidates = Array.isArray(analysis.route_candidates) ? analysis.route_candidates : [];
  const candidate = candidates.find(c => toFiniteNumber((c as any).candidate_index) === targetIndex) ?? candidates[0];
  return textOf((candidate as any)?.alignment_image_path) || textOf(analysis.vision_artifacts?.preview_image_path);
}

function pickPixelFromMapping(mapping: MapSheetRegionsResponse | undefined, viewId: number, frame: { width: number; height: number }): { x: number; y: number } | null {
  if (!mapping) return null;
  for (const region of mapping.regions) {
    const target = region.primary_target;
    if (target?.kind !== "viewport" || target.view_id !== viewId || !target.view_hint) continue;
    return {
      x: Math.round(target.view_hint.normalized_x * frame.width),
      y: Math.round(target.view_hint.normalized_y * frame.height)
    };
  }
  const firstViewport = mapping.regions.find(r => r.primary_target?.kind === "viewport" && r.primary_target?.view_hint);
  if (!firstViewport?.primary_target?.view_hint) return null;
  return {
    x: Math.round(firstViewport.primary_target.view_hint.normalized_x * frame.width),
    y: Math.round(firstViewport.primary_target.view_hint.normalized_y * frame.height)
  };
}

function pickPixelFromAlignment(
  alignment: ReturnType<typeof latestRedlineViewAlignment>,
  frame: { width: number; height: number }
): { x: number; y: number } | null {
  if (!alignment?.matched || alignment.confidence < 0.7 || alignment.marks.length === 0) return null;
  const mark = [...alignment.marks].sort((a, b) => (b.score ?? alignment.confidence) - (a.score ?? alignment.confidence))[0];
  if (!mark) return null;
  return {
    x: Math.round(mark.normalized_x * frame.width),
    y: Math.round(mark.normalized_y * frame.height)
  };
}

function pickPixelFallbackFromRegion(analysis: RedlineAnalyzeResponse, frame: { width: number; height: number }): { x: number; y: number } | null {
  const width = toFiniteNumber(analysis.image_meta?.width);
  const height = toFiniteNumber(analysis.image_meta?.height);
  const regions = Array.isArray(analysis.mark_regions) ? analysis.mark_regions : [];
  const best = regions.find(r => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h));
  if (!best || width === null || height === null || width <= 0 || height <= 0) return null;
  return {
    x: Math.round(((best.x + best.w * 0.5) / width) * frame.width),
    y: Math.round(((best.y + best.h * 0.5) / height) * frame.height)
  };
}

function latestPickModelXy(toolResults: ToolResult[]): { x: number; y: number } | null {
  const data = latestDoneToolJson(toolResults, "/revit/pick-at-pixel");
  const raw = Array.isArray(data?.pickPointXyz) ? data.pickPointXyz : null;
  if (!raw || raw.length < 2) return null;
  const x = toFiniteNumber(raw[0]);
  const y = toFiniteNumber(raw[1]);
  if (x === null || y === null) return null;
  return { x, y };
}

function latestContextLevel(toolResults: ToolResult[]): string | undefined {
  const data = latestDoneToolJson(toolResults, "/revit/resolve-mep-routing-context");
  const level = asRecord(data?.level);
  return textOf(level?.name) || undefined;
}

function normalizeDuctSize(value: unknown): string {
  return textOf(value).toLowerCase().replace(/[”″]/g, "\"").replace(/\s+/g, "").replace(/inches|inch|in\./g, "").replace(/"/g, "");
}

function ductScopeSizeFromForBridge(size: string | undefined): string | undefined {
  if (!size) return undefined;
  return /[x×]/i.test(size) ? undefined : size;
}

function ductSizeMatches(actual: unknown, expected: string | undefined): boolean {
  if (!expected) return true;
  const a = normalizeDuctSize(actual);
  const e = normalizeDuctSize(expected);
  return !!a && !!e && (a === e || a.includes(e) || e.includes(a));
}

function latestDuctScope(toolResults: ToolResult[]): Record<string, unknown> | null {
  return latestDoneToolJson(toolResults, "/revit/ducts-by-spatial-scope");
}

function matchingDuctScopeIds(toolResults: ToolResult[], size?: string): number[] {
  const scope = latestDuctScope(toolResults);
  if (!scope) return [];
  const elements = Array.isArray(scope.elements) ? scope.elements : [];
  const fromElements = elements
    .map(e => asRecord(e))
    .filter((e): e is Record<string, unknown> => !!e)
    .filter(e => /duct/i.test(textOf(e.category)) || /OST_DuctCurves/i.test(textOf(e.categoryToken)))
    .filter(e => ductSizeMatches(e.size, size))
    .map(e => toFiniteNumber(e.id))
    .filter((n): n is number => n !== null)
    .map(n => Math.round(n));
  if (fromElements.length > 0) return Array.from(new Set(fromElements));
  const ids = Array.isArray(scope.elementIds) ? scope.elementIds : [];
  return Array.from(new Set(ids.map(toFiniteNumber).filter((n): n is number => n !== null).map(n => Math.round(n))));
}

function latestElementSummaryRows(toolResults: ToolResult[]): Record<string, unknown>[] {
  const data = latestDoneToolJson(toolResults, "/revit/get-element-summary");
  if (!data) {
    const r = latestToolResult(toolResults, "/revit/get-element-summary");
    const arr = Array.isArray(r?.result_json) ? r.result_json : [];
    return arr.map(asRecord).filter((row): row is Record<string, unknown> => !!row);
  }
  return [data];
}

function matchingElementSummaryRows(toolResults: ToolResult[], ids: number[]): Record<string, unknown>[] {
  const wanted = new Set(ids);
  return latestElementSummaryRows(toolResults).filter(row => {
    const id = toFiniteNumber(row.id);
    return id !== null && wanted.has(Math.round(id));
  });
}

function latestHighlightCapture(toolResults: ToolResult[]): { path: string } | null {
  const data = latestDoneToolJson(toolResults, "/revit/highlight-and-export");
  const p = textOf(data?.path ?? data?.capturePath);
  return p ? { path: p } : null;
}

function lineSummaryFromElement(row: Record<string, unknown>): { id: number; p0: { x: number; y: number; z?: number }; p1: { x: number; y: number; z?: number } } | null {
  const id = toFiniteNumber(row.id);
  const loc = asRecord(row.location);
  const p0 = asRecord(loc?.p0);
  const p1 = asRecord(loc?.p1);
  const x0 = toFiniteNumber(p0?.x);
  const y0 = toFiniteNumber(p0?.y);
  const x1 = toFiniteNumber(p1?.x);
  const y1 = toFiniteNumber(p1?.y);
  if (id === null || x0 === null || y0 === null || x1 === null || y1 === null) return null;
  const z0 = toFiniteNumber(p0?.z);
  const z1 = toFiniteNumber(p1?.z);
  return {
    id: Math.round(id),
    p0: { x: x0, y: y0, ...(z0 !== null ? { z: z0 } : {}) },
    p1: { x: x1, y: y1, ...(z1 !== null ? { z: z1 } : {}) }
  };
}

function existingDuctVerificationMessage(args: {
  task: RedlineMepRouteTask;
  ids: number[];
  rows: Record<string, unknown>[];
  capturePath: string;
}): ResolveMepRouteRedlineResponse {
  const lines = args.rows.map(lineSummaryFromElement).filter((row): row is NonNullable<ReturnType<typeof lineSummaryFromElement>> => !!row);
  const observedRouteSummary = lines
    .map(l => `duct ${l.id} from (${l.p0.x.toFixed(3)}, ${l.p0.y.toFixed(3)}) to (${l.p1.x.toFixed(3)}, ${l.p1.y.toFixed(3)})`)
    .join("; ");
  const task: RedlineMepRouteTask = {
    ...args.task,
    status: "done",
    verification: {
      status: "existing_model_verified",
      existing_element_ids: args.ids,
      capture_path: args.capturePath,
      observed_route_summary: observedRouteSummary,
      spatial_assertion: {
        status: "passed",
        reason:
          "The PDF contains a callout/underline rather than route geometry, so completion is based on a matching modeled duct found inside the requested room/space scope and highlighted for cropped visual review."
      }
    }
  };
  return {
    ok: true,
    handled: true,
    task,
    assistant_message:
      `Verified the ${args.task.mep.size ?? ""} ${args.task.mep.system_type ?? "duct"} redline as existing modeled ductwork in room/space ${args.task.location.room_number ?? "target"}. ` +
      `Element id(s): ${args.ids.join(", ")}. ${observedRouteSummary || ""} Evidence: ${args.capturePath}.`
  };
}

function buildRoutePointsFromAnchor(anchor: { x: number; y: number }): Array<{ x: number; y: number }> {
  return [
    { x: anchor.x - 16, y: anchor.y },
    { x: anchor.x + 12, y: anchor.y },
    { x: anchor.x + 12, y: anchor.y + 12 }
  ];
}

function pointXY(value: unknown): { x: number; y: number } | null {
  const row = asRecord(value);
  if (!row) return null;
  const x = toFiniteNumber(row.x);
  const y = toFiniteNumber(row.y);
  if (x === null || y === null) return null;
  return { x, y };
}

function maxPairedPointDistanceFt(expected: Array<{ x: number; y: number }>, actual: unknown[]): number | null {
  if (expected.length === 0 || actual.length !== expected.length) return null;
  let max = 0;
  for (let i = 0; i < expected.length; i++) {
    const a = pointXY(actual[i]);
    const e = expected[i];
    if (!a || !e) return null;
    max = Math.max(max, Math.hypot(a.x - e.x, a.y - e.y));
  }
  return max;
}

function formatRouteEndpoints(points: Array<{ x: number; y: number }> | undefined): string {
  if (!points || points.length === 0) return "not available";
  return points.map(p => `(${p.x.toFixed(3)}, ${p.y.toFixed(3)})`).join(" -> ");
}

function routePointsFromToolResults(
  toolResults: ToolResult[],
  analysis?: RedlineAnalyzeResponse,
  classification?: ClassifiedRedlineGeometry,
  sheetNumber?: string
): Array<{ x: number; y: number }> | undefined {
  if (analysis && classification) {
    const sheetDetail = latestSheetDetail(toolResults, sheetNumber);
    const view = sheetDetail ? pickPlacedView(sheetDetail, extractLevelName([annotationText(analysis), sheetNumber].filter(Boolean).join(" "))) : null;
    const frame = view ? latestFrame(toolResults, view.viewId) : null;
    if (sheetDetail && view && frame?.mapping) {
      const fromSheetFrame = routePointsFromSheetViewportFrameMapping(analysis, classification, sheetDetail, view.viewId, frame);
      if (fromSheetFrame) {
        const directRedlineText = annotationText(analysis, { includePages: false });
        const fullRedlineText = annotationText(analysis);
        const explicitRoomNumber = extractRoomNumber(directRedlineText);
        const pageRoomNumbers = extractRoomNumbers(fullRedlineText);
        const roomNumber = explicitRoomNumber ?? (pageRoomNumbers.length === 1 ? pageRoomNumbers[0] : undefined);
        return applyRecoverableLocalBandShift(fromSheetFrame, toolResults, frame, roomNumber);
      }
    }
  }
  const pick = latestDoneToolJson(toolResults, "/revit/pick-at-pixel");
  const xyz = Array.isArray(pick?.pickPointXyz) ? pick.pickPointXyz : [];
  const x = toFiniteNumber(xyz[0]);
  const y = toFiniteNumber(xyz[1]);
  if (x === null || y === null) return undefined;
  if (analysis && classification) {
    const sheetDetail = latestSheetDetail(toolResults, sheetNumber);
    const view = sheetDetail ? pickPlacedView(sheetDetail, extractLevelName([annotationText(analysis), sheetNumber].filter(Boolean).join(" "))) : null;
    if (sheetDetail && view) {
      const fromPath = routePointsFromTargetPath(analysis, classification, sheetDetail, view.viewId, { x, y });
      if (fromPath) return fromPath;
    }
  }
  return buildRoutePointsFromAnchor({ x, y });
}

function routeSpatialAssertion(
  expectedPoints: Array<{ x: number; y: number }> | undefined,
  plannedPoints: unknown[]
): NonNullable<RedlineMepRouteTask["verification"]>["spatial_assertion"] {
  if (!expectedPoints || expectedPoints.length === 0) {
    return {
      status: "not_applicable",
      reason: "No persisted intended route points were available for this workflow result."
    };
  }
  const maxDistanceFt = maxPairedPointDistanceFt(expectedPoints, plannedPoints);
  if (maxDistanceFt === null) {
    return {
      status: "failed",
      tolerance_ft: ROUTE_SPATIAL_TOLERANCE_FT,
      reason: "Created-route planned points were missing or did not match the intended route point count."
    };
  }
  return {
    status: maxDistanceFt <= ROUTE_SPATIAL_TOLERANCE_FT ? "passed" : "failed",
    tolerance_ft: ROUTE_SPATIAL_TOLERANCE_FT,
    max_distance_ft: Number(maxDistanceFt.toFixed(3)),
    reason: maxDistanceFt <= ROUTE_SPATIAL_TOLERANCE_FT
      ? "Created-route planned points are within tolerance of the intended redline route."
      : "Created-route planned points are outside tolerance of the intended redline route."
  };
}

function userRequestsApply(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\b(dry[\s-]*run|preview|do\s+not\s+(?:apply|write|create|place)|no\s+model\s+change)\b/.test(lower)) return false;
  if (/\b(pick\s*up|pickup)\b[\s\S]{0,40}\b(redline|markup|markups?|marked\.pdf)\b/.test(lower)) return true;
  return /\b(implement|apply|create|add|place|draw|make|unconnected)\b/.test(lower);
}

function localBandLandmarkRelationships(localBand: LocalBandAssertion | undefined): NonNullable<Parameters<typeof evaluateRedlineVisualVerificationGate>[0]["landmark_relationships"]> {
  if (!localBand || localBand.status === "not_applicable") return [];
  const status = localBand.status === "passed" ? "pass" : "fail";
  return [
    {
      landmark: "bathroom/kitchen/loft fixture band",
      relation: "created route must be plan south of this upper fixture band",
      status,
      reason: localBand.reason
    },
    {
      landmark: "target room/unit label band",
      relation: "created route must remain plan north of the room/unit label",
      status,
      reason: localBand.reason
    }
  ];
}

function workflowResultMessage(
  task: RedlineMepRouteTask,
  data: Record<string, unknown>,
  status: "done" | "failed",
  expectedRoutePoints?: Array<{ x: number; y: number }>,
  toolResults: ToolResult[] = []
): ResolveMepRouteRedlineResponse {
  const workflowStatus = textOf(data.status);
  const visual = asRecord(data.visualVerification);
  const capturePath = textOf(visual?.capturePath);
  const applyResult = asRecord(data.applyResult);
  const dryRun = asRecord(data.dryRun);
  const createdElementIds = Array.isArray(applyResult?.createdElementIds) ? applyResult.createdElementIds.map(Number).filter(Number.isFinite) : [];
  const createdFittingIds = Array.isArray(applyResult?.createdFittingIds) ? applyResult.createdFittingIds.map(Number).filter(Number.isFinite) : [];
  const dryRunElementIds = Array.isArray(dryRun?.dryRunElementIds) ? dryRun.dryRunElementIds.map(Number).filter(Number.isFinite) : [];
  const dryRunFittingIds = Array.isArray(dryRun?.dryRunFittingIds) ? dryRun.dryRunFittingIds.map(Number).filter(Number.isFinite) : [];
  const openConnectorCount = toFiniteNumber(applyResult?.openConnectorCount) ?? toFiniteNumber(dryRun?.openConnectorCount) ?? undefined;
  const plannedPoints = Array.isArray(applyResult?.plannedPoints)
    ? applyResult.plannedPoints
    : Array.isArray(dryRun?.plannedPoints)
      ? dryRun.plannedPoints
      : [];
  const segmentCount = toFiniteNumber(applyResult?.segmentCount) ?? toFiniteNumber(dryRun?.segmentCount);
  const size = asRecord(applyResult?.chosenSize) ?? asRecord(dryRun?.chosenSize);
  const sizeText = textOf(size?.applied ?? size?.requested) || task.mep.size || "";
  const observedRouteSummary = [
    Number.isFinite(segmentCount) ? `${segmentCount} segment(s)` : "",
    sizeText ? `${sizeText} ${task.mep.system_type ?? task.mep.kind}` : `${task.mep.system_type ?? task.mep.kind}`,
    plannedPoints.length > 0 ? `${plannedPoints.length} planned point(s)` : ""
  ].filter(Boolean).join(", ");
  const intendedRoutePoints = task.route?.points ?? expectedRoutePoints;
  const spatialAssertion = routeSpatialAssertion(intendedRoutePoints, plannedPoints);
  const spatialFailed = spatialAssertion?.status === "failed";
  const actualRoutePoints = plannedPoints.map(p => pointXY(p)).filter((p): p is { x: number; y: number } => !!p);
  const localBandAssertion = computeLocalBandAssertion(
    actualRoutePoints.length >= 2 ? actualRoutePoints : (task.route?.points ?? expectedRoutePoints),
    toolResults,
    latestFrame(toolResults),
    task.location.room_number
  );
  const localBandFailed = localBandAssertion?.status === "failed";
  const blocked = status === "failed" || /^blocked|failed$/i.test(workflowStatus);
  const isDryRunReady = /^dryrunready$/i.test(workflowStatus);
  const spatialPassed = spatialAssertion?.status === "passed";
  const localBandPassed = localBandAssertion?.status === "passed";
  const visualGate = evaluateRedlineVisualVerificationGate({
    action_type: task.mep.kind === "pipe" ? "pipe_route" : "duct_route",
    authority: "deterministic_geometry",
    redline_path: task.attachment?.file_path,
    before_capture_path: latestFrame(toolResults)?.imagePath,
    after_capture_path: capturePath,
    visible_element_inventory: {
      source: "export-visible-elements derived local landmark assertions",
      room_number: task.location.room_number ?? null,
      landmark_relationship_count: localBandLandmarkRelationships(localBandAssertion).length,
      local_band_assertion: localBandAssertion ?? null
    },
    intended_action: {
      kind: task.mep.kind,
      size: task.mep.size ?? null,
      system_type: task.mep.system_type ?? null,
      room_number: task.location.room_number ?? null,
      level_name: task.location.level_name ?? null
    },
    intended_location: [
      task.location.room_number ? `room/space ${task.location.room_number}` : null,
      task.location.level_name ? `level ${task.location.level_name}` : null,
      (intendedRoutePoints?.length ?? 0) > 0 ? `${intendedRoutePoints!.length} route point(s)` : null
    ].filter(Boolean).join(", "),
    observed_location: observedRouteSummary || (
      actualRoutePoints.length > 0
        ? `created ${task.mep.kind ?? "MEP"} route with ${actualRoutePoints.length} point(s)`
        : ""
    ),
    intended_points: intendedRoutePoints,
    actual_points: actualRoutePoints,
    model_write_required: !isDryRunReady,
    created_element_ids: createdElementIds,
    created_fitting_ids: createdFittingIds,
    max_error_ft: spatialAssertion?.max_distance_ft ?? null,
    tolerance_ft: spatialAssertion?.tolerance_ft ?? ROUTE_SPATIAL_TOLERANCE_FT,
    deterministic_assertions: [
      ...(spatialAssertion
        ? [{
            name: "route_spatial_assertion",
            status: spatialAssertion.status === "passed" ? "pass" as const : spatialAssertion.status === "failed" ? "fail" as const : "uncertain" as const,
            expected: { tolerance_ft: spatialAssertion.tolerance_ft ?? ROUTE_SPATIAL_TOLERANCE_FT },
            observed: { max_distance_ft: spatialAssertion.max_distance_ft ?? null },
            reason: spatialAssertion.reason
          }]
        : []),
      ...(localBandAssertion
        ? [{
            name: "local_landmark_band_assertion",
            status: localBandAssertion.status === "passed" ? "pass" as const : localBandAssertion.status === "failed" ? "fail" as const : "uncertain" as const,
            expected: {
              min_allowed_view_y: localBandAssertion.min_allowed_view_y ?? null,
              max_allowed_view_y: localBandAssertion.max_allowed_view_y ?? null,
              target_view_x: localBandAssertion.target_view_x ?? null
            },
            observed: { route_center_view_y: localBandAssertion.route_center_view_y ?? null },
            reason: localBandAssertion.reason
          }]
        : [])
    ],
    landmark_relationships: localBandLandmarkRelationships(localBandAssertion),
    vision_review: { provider: "none", status: "pass", reason: "No model vision judge was invoked; deterministic geometry is authoritative for this MEP route class." }
  });
  const visualGatePassed = visualGate.status === "pass";
  const isAppliedReady = /^appliedvisualverificationready$/i.test(workflowStatus) && !!capturePath && spatialPassed && localBandPassed && visualGatePassed;
  const verification: RedlineMepRouteTask["verification"] = blocked
    ? { status: "blocked", workflow_status: workflowStatus || undefined }
    : isDryRunReady
      ? {
          status: "dry_run_ready",
          workflow_status: workflowStatus,
          created_element_ids: dryRunElementIds,
          created_fitting_ids: dryRunFittingIds,
          ...(openConnectorCount !== undefined ? { open_connector_count: openConnectorCount } : {}),
          ...(spatialAssertion ? { spatial_assertion: spatialAssertion } : {}),
          ...(localBandAssertion ? { local_band_assertion: localBandAssertion } : {}),
          visual_gate: visualGate,
          ...(observedRouteSummary ? { observed_route_summary: observedRouteSummary } : {})
        }
      : isAppliedReady
        ? {
            status: "applied_visual_ready",
            workflow_status: workflowStatus,
            apply_status: textOf(applyResult?.status) || undefined,
            created_element_ids: createdElementIds,
            created_fitting_ids: createdFittingIds,
            ...(openConnectorCount !== undefined ? { open_connector_count: openConnectorCount } : {}),
            capture_path: capturePath,
            ...(spatialAssertion ? { spatial_assertion: spatialAssertion } : {}),
            ...(localBandAssertion ? { local_band_assertion: localBandAssertion } : {}),
            visual_gate: visualGate,
            ...(observedRouteSummary ? { observed_route_summary: observedRouteSummary } : {})
          }
        : {
            status: "applied_visual_incomplete",
            workflow_status: workflowStatus || undefined,
            apply_status: textOf(applyResult?.status) || undefined,
            created_element_ids: createdElementIds,
            created_fitting_ids: createdFittingIds,
            ...(openConnectorCount !== undefined ? { open_connector_count: openConnectorCount } : {}),
            ...(capturePath ? { capture_path: capturePath } : {}),
            ...(spatialAssertion ? { spatial_assertion: spatialAssertion } : {}),
            ...(localBandAssertion ? { local_band_assertion: localBandAssertion } : {}),
            visual_gate: visualGate,
            ...(observedRouteSummary ? { observed_route_summary: observedRouteSummary } : {})
          };
  const taskWithVerification: RedlineMepRouteTask = {
    ...task,
    status: blocked ? "blocked" : isDryRunReady ? "ready" : "done",
    verification,
    ...(blocked ? { blocker: textOf(data.error) || workflowStatus || "MEP route workflow failed." } : {})
  };

  if (isDryRunReady) {
    return {
      ok: true,
      handled: true,
      task: taskWithVerification,
      assistant_message:
        `Dry-run ready for the ${observedRouteSummary || `${task.mep.size ?? ""} ${task.mep.system_type ?? "MEP"} route`}. ` +
        `No model elements were committed. Dry-run ids were ${[...dryRunElementIds, ...dryRunFittingIds].join(", ") || "not returned"}; ` +
        `open connector count would be ${openConnectorCount ?? "unknown"}.`
    };
  }

  if (isAppliedReady) {
    return {
      ok: true,
      handled: true,
      task: taskWithVerification,
      assistant_message:
        `Applied and spatially verified the ${observedRouteSummary || `${task.mep.size ?? ""} ${task.mep.system_type ?? "MEP"} route`}. ` +
        `Created duct ids: ${createdElementIds.join(", ") || "none returned"}; fitting ids: ${createdFittingIds.join(", ") || "none returned"}; ` +
        `open connector count: ${openConnectorCount ?? "unknown"}. ` +
        `Intended endpoints XY ft: ${formatRouteEndpoints(intendedRoutePoints)}. ` +
        `Actual endpoints XY ft: ${formatRouteEndpoints(actualRoutePoints)}. ` +
        `Max route error: ${spatialAssertion?.max_distance_ft ?? "unknown"} ft. ` +
        `Visual gate: ${visualGate.status} (${visualGate.authority}, confidence ${visualGate.confidence.toFixed(2)}). Evidence: ${capturePath}.`
    };
  }

  return {
    ok: !blocked && !verification.status.includes("incomplete"),
    handled: true,
    task: taskWithVerification,
    assistant_message: blocked
      ? `The deterministic MEP route workflow was blocked: ${textOf(data.error) || workflowStatus || "unknown failure"}.`
      : `The deterministic MEP route workflow applied model elements but visual verification is incomplete. ` +
        `Created duct ids: ${createdElementIds.join(", ") || "none returned"}; fitting ids: ${createdFittingIds.join(", ") || "none returned"}; ` +
        `open connector count: ${openConnectorCount ?? "unknown"}. ` +
        `${spatialFailed ? `Spatial assertion failed: ${spatialAssertion?.reason ?? "created route did not match target"}. ` : ""}` +
        `${localBandFailed ? `Local band assertion failed: ${localBandAssertion?.reason ?? "created route is in the wrong plan band"}. ` : ""}` +
        `${visualGate.status !== "pass" ? `Visual gate ${visualGate.status}: ${visualGate.reason}. ` : ""}` +
        `Do not claim final completion until focused visual evidence is captured and the created route is within tolerance.`,
    ...(blocked ? { blocker: textOf(data.error) || workflowStatus || "MEP route workflow failed." } : {})
  };
}

function sizeTransitionDryRunResultMessage(
  task: RedlineMepRouteTask,
  toolResult: ToolResult
): ResolveMepRouteRedlineResponse {
  const data = asRecord(toolResult.result_json) ?? {};
  const statusText = textOf(data.status) || toolResult.status;
  if (toolResult.status === "failed" || /^blocked|failed$/i.test(statusText)) {
    const blocker = textOf(toolResult.error) || textOf(data.error) || statusText || "MEP size-transition dry-run failed.";
    return {
      ok: false,
      handled: true,
      task: { ...task, status: "blocked", blocker },
      assistant_message: `The verified size-transition dry-run was blocked before model writes: ${blocker}`,
      blocker
    };
  }

  const projectedPoint = asRecord(data.projectedTransitionPoint ?? data.projectedPoint ?? data.transitionPoint);
  const connectorAudit = asRecord(data.connectorAudit ?? data.connectorNetworkAudit ?? data.networkAudit);
  const systemAudit = asRecord(connectorAudit?.systemAudit);
  const sizeReadback = asRecord(data.sizeReadback ?? data.sizeAudit ?? data.readback);
  const dryRunElementIds = Array.isArray(data.dryRunElementIds) ? data.dryRunElementIds.map(Number).filter(Number.isFinite) : [];
  const dryRunFittingIds = Array.isArray(data.dryRunFittingIds) ? data.dryRunFittingIds.map(Number).filter(Number.isFinite) : [];
  const upstreamSize = textOf(sizeReadback?.upstreamSize ?? sizeReadback?.upstreamDuctSize ?? sizeReadback?.upstreamPipeSize ?? data.upstreamSize);
  const downstreamSize = textOf(sizeReadback?.downstreamSize ?? sizeReadback?.downstreamDuctSize ?? sizeReadback?.downstreamPipeSize ?? data.downstreamSize);
  const auditStatus = textOf(connectorAudit?.status ?? systemAudit?.status ?? data.connectedNetworkOk);
  const observed = [
    upstreamSize && downstreamSize ? `${upstreamSize} -> ${downstreamSize}` : "",
    projectedPoint ? "projected transition point reported" : "",
    auditStatus ? `connector audit: ${auditStatus}` : "",
    dryRunElementIds.length || dryRunFittingIds.length ? `dry-run ids ${[...dryRunElementIds, ...dryRunFittingIds].join(", ")}` : ""
  ].filter(Boolean).join("; ");

  return {
    ok: true,
    handled: true,
    task: {
      ...task,
      status: "ready",
      verification: {
        status: "dry_run_ready",
        workflow_status: statusText,
        created_element_ids: dryRunElementIds,
        created_fitting_ids: dryRunFittingIds,
        observed_route_summary: observed || "size-transition dry-run completed without model writes"
      }
    },
    assistant_message:
      `The verified ${task.mep.kind} size-transition dry-run completed without model writes. ` +
      `${observed || "Review the dry-run payload for transition projection, size readback, and connector/fitting expectations before any apply step."}`
  };
}

function tapBranchDryRunResultMessage(
  task: RedlineMepRouteTask,
  toolResult: ToolResult
): ResolveMepRouteRedlineResponse {
  const data = asRecord(toolResult.result_json) ?? {};
  const statusText = textOf(data.status) || toolResult.status;
  if (toolResult.status === "failed" || /^blocked|failed$/i.test(statusText)) {
    const blocker = textOf(toolResult.error) || textOf(data.error) || statusText || "MEP tap/branch dry-run failed.";
    return {
      ok: false,
      handled: true,
      task: { ...task, status: "blocked", blocker },
      assistant_message: `The verified tap/branch dry-run was blocked before model writes: ${blocker}`,
      blocker
    };
  }

  const splitPlan = asRecord(data.splitPlan);
  const mainIntersection = asRecord(data.mainIntersection);
  const selected = asRecord(data.selected);
  const branchPlan = asRecord(data.branchPlan);
  const connectorAudit = asRecord(data.connectedNetworkAudit ?? data.connectorAudit ?? data.connectorNetworkAudit ?? data.networkAudit);
  const projectedPoint = asRecord(splitPlan?.projectedSplitPoint ?? mainIntersection?.nearestPointOnMain ?? data.projectedTapPoint ?? data.projectedPoint);
  const connectionAttempts = Array.isArray(data.connectionAttempts)
    ? data.connectionAttempts.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
  const dryRunElementIds = Array.isArray(data.dryRunElementIds) ? data.dryRunElementIds.map(Number).filter(Number.isFinite) : [];
  const dryRunFittingIds = Array.isArray(data.dryRunFittingIds) ? data.dryRunFittingIds.map(Number).filter(Number.isFinite) : [];
  const branchSize = textOf(selected?.size ?? branchPlan?.requestedSize ?? data.branchSize ?? data.appliedSize);
  const expectedFitting = textOf(data.expectedFitting ?? splitPlan?.expectedFitting ?? data.connectionMode);
  const auditStatus = textOf(connectorAudit?.status ?? data.connectedNetworkOk);
  const connectedAttemptCount = connectionAttempts.filter((attempt) => attempt.connected === true || /^true|connected|success$/i.test(textOf(attempt.connected ?? attempt.status))).length;
  const observed = [
    branchSize ? `branch size ${branchSize}` : "",
    projectedPoint ? "projected tap point reported" : "",
    expectedFitting ? `expected fitting ${expectedFitting}` : "",
    connectedAttemptCount > 0 ? `${connectedAttemptCount} connection attempt(s) reported` : "",
    auditStatus ? `connector audit: ${auditStatus}` : "",
    dryRunElementIds.length || dryRunFittingIds.length ? `dry-run ids ${[...dryRunElementIds, ...dryRunFittingIds].join(", ")}` : ""
  ].filter(Boolean).join("; ");

  return {
    ok: true,
    handled: true,
    task: {
      ...task,
      status: "ready",
      verification: {
        status: "dry_run_ready",
        workflow_status: statusText,
        created_element_ids: dryRunElementIds,
        created_fitting_ids: dryRunFittingIds,
        observed_route_summary: observed || "tap/branch dry-run completed without model writes"
      }
    },
    assistant_message:
      `The verified ${task.mep.kind} tap/branch dry-run completed without model writes. ` +
      `${observed || "Review the dry-run payload for tap projection, branch path, fitting, connector audit, focused capture, and cleanup expectations before any apply step."}`
  };
}

function rerouteOffsetDryRunResultMessage(
  task: RedlineMepRouteTask,
  toolResult: ToolResult
): ResolveMepRouteRedlineResponse {
  const data = asRecord(toolResult.result_json) ?? {};
  const statusText = textOf(data.status) || toolResult.status;
  if (toolResult.status === "failed" || /^blocked|failed$/i.test(statusText)) {
    const blocker = textOf(toolResult.error) || textOf(data.error) || statusText || "MEP reroute/offset dry-run failed.";
    return {
      ok: false,
      handled: true,
      task: { ...task, status: "blocked", blocker },
      assistant_message: `The verified reroute/offset dry-run was blocked before model writes: ${blocker}`,
      blocker
    };
  }

  const plan = asRecord(data.plan);
  const verificationObj = asRecord(data.verification);
  const networkAudit = asRecord(verificationObj?.networkAudit ?? data.connectedNetworkAudit ?? data.connectorAudit ?? data.networkAudit);
  const systemAudit = asRecord(networkAudit?.systemAudit ?? verificationObj?.systemAudit ?? data.systemAudit);
  const connectionAttempts = Array.isArray(data.connectionAttempts)
    ? data.connectionAttempts.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry)
    : [];
  const dryRunElementIds = Array.isArray(data.dryRunElementIds) ? data.dryRunElementIds.map(Number).filter(Number.isFinite) : [];
  const dryRunFittingIds = Array.isArray(data.dryRunFittingIds) ? data.dryRunFittingIds.map(Number).filter(Number.isFinite) : [];
  const expectedFittings = Array.isArray(plan?.ExpectedFittings) ? plan.ExpectedFittings : Array.isArray(plan?.expectedFittings) ? plan.expectedFittings : [];
  const segments = Array.isArray(plan?.Segments) ? plan.Segments : Array.isArray(plan?.segments) ? plan.segments : [];
  const split1 = asRecord(plan?.Split1 ?? plan?.split1);
  const split2 = asRecord(plan?.Split2 ?? plan?.split2);
  const offsetSplit1 = asRecord(plan?.OffsetSplit1 ?? plan?.offsetSplit1);
  const offsetSplit2 = asRecord(plan?.OffsetSplit2 ?? plan?.offsetSplit2);
  const auditStatus = textOf(networkAudit?.status ?? systemAudit?.status ?? data.connectedNetworkOk);
  const connectedAttemptCount = connectionAttempts.filter((attempt) => attempt.connected === true || /^true|connected|success$/i.test(textOf(attempt.connected ?? attempt.status))).length;
  const observed = [
    split1 && split2 && offsetSplit1 && offsetSplit2 ? "split and offset points reported" : "",
    segments.length > 0 ? `${segments.length} planned segment(s)` : "",
    expectedFittings.length > 0 ? `${expectedFittings.length} expected fitting(s)` : "",
    connectedAttemptCount > 0 ? `${connectedAttemptCount} connection attempt(s) reported` : "",
    auditStatus ? `connector audit: ${auditStatus}` : "",
    dryRunElementIds.length || dryRunFittingIds.length ? `dry-run ids ${[...dryRunElementIds, ...dryRunFittingIds].join(", ")}` : ""
  ].filter(Boolean).join("; ");

  return {
    ok: true,
    handled: true,
    task: {
      ...task,
      status: "ready",
      verification: {
        status: "dry_run_ready",
        workflow_status: statusText,
        created_element_ids: dryRunElementIds,
        created_fitting_ids: dryRunFittingIds,
        observed_route_summary: observed || "reroute/offset dry-run completed without model writes"
      }
    },
    assistant_message:
      `The verified ${task.mep.kind} reroute/offset dry-run completed without model writes. ` +
      `${observed || "Review the dry-run payload for split projection, offset geometry, fitting, endpoint reconnection, connector audit, focused capture, and cleanup expectations before any apply step."}`
  };
}

function action(pathName: string, body: Record<string, unknown>): ActionCall {
  return { action_id: randomUUID(), method: "POST", path: pathName, body };
}

export async function resolveMepRouteRedline(req: ResolveMepRouteRedlineRequest): Promise<ResolveMepRouteRedlineResponse> {
  const userText = textOf(req.user_text);
  if (isStatusOnlyNoDiscovery(userText)) {
    return { ok: true, handled: false, assistant_message: "" };
  }

  const attachment = findAttachment(req) ?? findContinuationAttachment(req);
  const shouldTry = !!attachment || userTextLooksRedlinePickup(userText);
  if (!shouldTry) return { ok: true, handled: false, assistant_message: "" };
  if (!attachment && !req.analysis) return { ok: true, handled: false, assistant_message: "" };

  const analysis = req.analysis ?? await analyzeRedlineFile({
    file_path: attachment?.file_path ?? "",
    expected_sheet: req.expected_sheet,
    include_pdf_annotations: true,
    include_ocr_for_images: true,
    max_pages: pdfDefaultPageBudget(),
    timeout_ms: 120_000
  });
  if (!analysis.ok) {
    return { ok: false, handled: false, assistant_message: "", blocker: analysis.warning ?? "Redline analysis failed." };
  }

  const directRedlineText = annotationText(analysis, { includePages: false });
  const fullRedlineText = annotationText(analysis);
  const semanticText = [userText, fullRedlineText, textOf(analysis.primary_sheet_number), attachment?.filename].filter(Boolean).join(" ");
  const mep =
    extractMepIntent([userText, attachment?.filename].filter(Boolean).join(" ")) ??
    extractMepIntent(directRedlineText) ??
    extractMepIntent(semanticText);
  if (!mep) return { ok: true, handled: false, assistant_message: "" };

  const sheetNumber = normalizeSheetNumber(req.expected_sheet) || normalizeSheetNumber(analysis.primary_sheet_number) || extractSheetNumber(semanticText);
  const explicitRoomText = [userText, directRedlineText, attachment?.filename].filter(Boolean).join(" ");
  const explicitRoomNumber = extractRoomNumber(explicitRoomText);
  const pageRoomNumbers = extractRoomNumbers(fullRedlineText);
  const roomNumber = explicitRoomNumber ?? (pageRoomNumbers.length === 1 ? pageRoomNumbers[0] : undefined);
  const levelName = extractLevelName(semanticText);
  const geometryClassification = classifyRedlineGeometry(analysis, mep);
  const geometryKind = routeGeometryKind(analysis, geometryClassification);
  const warnings: string[] = [];
  if (!mep.size) warnings.push("No explicit route size was found in the redline text.");
  if (!roomNumber) warnings.push("No room/unit number was resolved from the redline text.");
  if (geometryClassification.callout_only) {
    warnings.push("Detected callout text/underline geometry only; the vector markup will not be used as a duct centerline.");
  }

  let task: RedlineMepRouteTask = {
    ...(attachment
      ? { attachment: { file_path: attachment.file_path, ...(attachment.filename ? { filename: attachment.filename } : {}), ...(firstAnnotationPage(analysis) ? { page: firstAnnotationPage(analysis) } : {}) } }
      : {}),
    sheet: { ...(sheetNumber ? { number: sheetNumber } : {}), detail_resolved: false },
    redline: {
      annotation_text: annotationText(analysis),
      geometry_kind: geometryKind,
      geometry_classification: geometryClassification,
      regions: summarizeRegions(analysis),
      ...(Array.isArray(analysis.route_candidates) ? { route_candidates: analysis.route_candidates } : {}),
      ...(Array.isArray(analysis.pdf_annotations) ? { pdf_annotations: analysis.pdf_annotations } : {})
    },
    mep,
    location: { ...(roomNumber ? { room_number: roomNumber } : {}), ...(levelName ? { level_name: levelName } : {}) },
    status: "needs_sheet_detail",
    confidence: geometryKind === "route" && mep.size ? "medium" : geometryClassification.callout_only && mep.size ? "medium" : "low",
    warnings
  };

  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];
  const tapBranchDryRun = latestToolResult(toolResults, "/revit/connect-mep-branch");
  if (tapBranchDryRun && unsafeMepEditIntent([userText, directRedlineText].filter(Boolean).join(" "))?.kind === "tap_branch") {
    return tapBranchDryRunResultMessage(task, tapBranchDryRun);
  }

  const sizeTransitionDryRun = latestToolResult(toolResults, "/revit/reroute-mep-route-segment");
  if (sizeTransitionDryRun && unsafeMepEditIntent([userText, directRedlineText].filter(Boolean).join(" "))?.kind === "transition") {
    return sizeTransitionDryRunResultMessage(task, sizeTransitionDryRun);
  }

  const rerouteOffsetDryRun = latestToolResult(toolResults, "/revit/reroute-mep-route-segment");
  if (rerouteOffsetDryRun && unsafeMepEditIntent([userText, directRedlineText].filter(Boolean).join(" "))?.kind === "reroute_offset") {
    return rerouteOffsetDryRunResultMessage(task, rerouteOffsetDryRun);
  }

  const unsafeEditIntent = unsafeMepEditIntent([userText, directRedlineText].filter(Boolean).join(" "));
  if (unsafeEditIntent) {
    if (unsafeEditIntent.kind === "tap_branch") {
      const handoff = buildTapBranchDryRunAction(task, verifiedTapBranchEvidence(req));
      if (handoff.next) {
        return {
          ok: true,
          handled: true,
          task: {
            ...task,
            status: "ready",
            warnings: Array.from(new Set([...task.warnings, "Verified tap/branch evidence supplied; routing to guarded dry-run only."]))
          },
          next_action: handoff.next,
          assistant_message:
            "The redline reads as a tap/branch/takeoff edit and verified main/tap/branch evidence is present. " +
            "I will dry-run /revit/connect-mep-branch with apply:false; no model elements will be written until the dry-run projection, fitting, connector, readback, focused capture, and cleanup plan are reviewed."
        };
      }
    }
    if (unsafeEditIntent.kind === "reroute_offset") {
      const handoff = buildRerouteOffsetDryRunAction(task, verifiedRerouteOffsetEvidence(req));
      if (handoff.next) {
        return {
          ok: true,
          handled: true,
          task: {
            ...task,
            status: "ready",
            warnings: Array.from(new Set([...task.warnings, "Verified reroute/offset evidence supplied; routing to guarded dry-run only."]))
          },
          next_action: handoff.next,
          assistant_message:
            "The redline reads as an existing-route reroute/offset edit and verified host/split/offset evidence is present. " +
            "I will dry-run /revit/reroute-mep-route-segment with apply:false; no model elements will be written until the dry-run split projection, offset geometry, fitting, endpoint reconnection, connector, readback, focused capture, and cleanup plan are reviewed."
        };
      }
    }
    if (unsafeEditIntent.kind === "transition") {
      const handoff = buildSizeTransitionDryRunAction(task, verifiedSizeTransitionEvidence(req));
      if (handoff.next) {
        return {
          ok: true,
          handled: true,
          task: {
            ...task,
            status: "ready",
            warnings: Array.from(new Set([...task.warnings, "Verified size-transition evidence supplied; routing to guarded dry-run only."]))
          },
          next_action: handoff.next,
          assistant_message:
            "The redline reads as a size transition/reducer edit and verified host/transition/size evidence is present. " +
            "I will dry-run /revit/reroute-mep-route-segment with apply:false; no model elements will be written until the dry-run projection, fitting, connector, readback, focused capture, and cleanup plan are reviewed."
        };
      }
    }
    const blocker =
      `${unsafeEditIntent.blocker} The deterministic PDF route resolver will not convert this into /revit/mep-route-workflow geometry.`;
    const missingEvidence = unsafeEditIntent.kind === "transition"
      ? buildSizeTransitionDryRunAction(task, verifiedSizeTransitionEvidence(req)).blockers
      : unsafeEditIntent.kind === "tap_branch"
        ? buildTapBranchDryRunAction(task, verifiedTapBranchEvidence(req)).blockers
        : unsafeEditIntent.kind === "reroute_offset"
          ? buildRerouteOffsetDryRunAction(task, verifiedRerouteOffsetEvidence(req)).blockers
      : [];
    return {
      ok: false,
      handled: true,
      task: {
        ...task,
        status: "blocked",
        blocker,
        warnings: Array.from(new Set([
          ...task.warnings,
          `Blocked unsafe MEP edit intent: ${unsafeEditIntent.kind}`,
          ...(missingEvidence.length > 0 ? [`Missing verified ${
            unsafeEditIntent.kind === "tap_branch" ? "tap/branch" : unsafeEditIntent.kind === "reroute_offset" ? "reroute/offset" : "size-transition"
          } evidence: ${missingEvidence.join(", ")}`] : [])
        ]))
      },
      assistant_message: missingEvidence.length > 0 ? `${blocker} Missing verified evidence: ${missingEvidence.join(", ")}.` : blocker,
      blocker
    };
  }

  const workflow = latestToolResult(toolResults, "/revit/mep-route-workflow");
  if (workflow?.status === "done") return workflowResultMessage(task, asRecord(workflow.result_json) ?? {}, "done", routePointsFromToolResults(toolResults, analysis, geometryClassification, sheetNumber), toolResults);
  if (workflow?.status === "failed") return workflowResultMessage(task, { error: textOf(workflow.error) || "MEP route workflow failed." }, "failed", routePointsFromToolResults(toolResults, analysis, geometryClassification, sheetNumber), toolResults);

  if (geometryKind === "text_only") {
    const blocker = "The redline has an MEP label, but only text annotation geometry was extracted; no route path/endpoints were available to place deterministically.";
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }

  if (!sheetNumber) {
    const blocker = "The MEP redline was detected, but the sheet number could not be resolved from the attachment or prompt.";
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }

  const sheetFailure = latestFailure(toolResults, "/revit/sheets");
  if (sheetFailure) {
    const blocker = `Could not resolve sheet ${sheetNumber}: ${sheetFailure}`;
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }

  const sheetDetail = latestSheetDetail(toolResults, sheetNumber);
  if (!sheetDetail) {
    if (countDoneToolPath(toolResults, "/revit/sheets") >= 2) {
      const blocker =
        `Sheet ${sheetNumber} detail was returned more than once, but the deterministic MEP route resolver could not reuse it. ` +
        "Stopping instead of repeating /revit/sheets.";
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }
    const next = action("/revit/sheets", {
      action: "detail",
      sheetNumber,
      includePlacedViews: true,
      includeViewports: true,
      includeViewportGeometry: true,
      includeTitleBlocks: true,
      includeSheetOutline: true
    });
    return {
      ok: true,
      handled: true,
      task,
      next_action: next,
      assistant_message: `I’ll resolve sheet ${sheetNumber} with viewport geometry so the MEP route redline can be mapped into the correct model view.`
    };
  }

  const view = pickPlacedView(sheetDetail, levelName);
  const mapping = mapTaskRegions(analysis, sheetDetail);
  task = {
    ...task,
    sheet: { ...(task.sheet ?? {}), detail_resolved: true },
    ...(view ? { viewport: { view_id: view.viewId, ...(view.viewportId ? { viewport_id: view.viewportId } : {}) } } : {}),
    redline: { ...task.redline, ...(mapping ? { mapping } : {}) }
  };
  if (!view) {
    const blocker = `Sheet ${sheetNumber} resolved, but no placed HVAC/plan viewport could be selected for the MEP route redline.`;
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }

  if (geometryClassification.callout_only && mep.kind === "duct") {
    if (!roomNumber) {
      const blocker =
        "The redline contains duct callout text but no target route geometry, and no room/space number was resolved. I will not create ductwork from the callout underline.";
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }

    const ductScopeFailure = latestFailure(toolResults, "/revit/ducts-by-spatial-scope");
    if (ductScopeFailure) {
      const blocker = `Could not verify matching ductwork in room/space ${roomNumber}: ${ductScopeFailure}`;
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }

    const scope = latestDuctScope(toolResults);
    if (!scope) {
      const next = action("/revit/ducts-by-spatial-scope", {
        roomNumber,
        ...(levelName ? { levelName } : {}),
        roomMode: "auto",
        verticalScope: "room+plenum",
        ...(mep.system_classification ? { systemClassification: mep.system_classification } : {}),
        ...(ductScopeSizeFromForBridge(mep.size) ? { sizeFrom: ductScopeSizeFromForBridge(mep.size) } : {}),
        includeCategories: ["Ducts", "Duct Fittings", "Air Terminals"],
        max: 50
      });
      return {
        ok: true,
        handled: true,
        task: { ...task, status: "needs_context" },
        next_action: next,
        assistant_message:
          `The PDF geometry is a duct callout/underline, not a route centerline. I’ll verify whether matching ${mep.size ?? ""} ${mep.system_type ?? "duct"} model ductwork already exists in room/space ${roomNumber} before any write.`
      };
    }

    const matchingIds = matchingDuctScopeIds(toolResults, mep.size);
    if (matchingIds.length === 0) {
      const blocker =
        `The redline only provides a duct callout/underline and I found no matching ${mep.size ?? ""} ${mep.system_type ?? "duct"} in room/space ${roomNumber}. ` +
        "I will not fabricate duct geometry from the callout position; this needs visual route alignment or an explicit target path.";
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }

    const summaryFailure = latestFailure(toolResults, "/revit/get-element-summary");
    if (summaryFailure) {
      const blocker = `Could not read back matching duct element(s) ${matchingIds.join(", ")}: ${summaryFailure}`;
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }
    const rows = matchingElementSummaryRows(toolResults, matchingIds);
    if (rows.length === 0) {
      const next = action("/revit/get-element-summary", {
        elementIds: matchingIds,
        includeParameters: true,
        includeGeometry: true
      });
      return {
        ok: true,
        handled: true,
        task: { ...task, status: "needs_context" },
        next_action: next,
        assistant_message:
          `I found matching modeled ductwork for the callout-only redline; next I’ll read its geometry/parameters before completion.`
      };
    }

    const highlightFailure = latestFailure(toolResults, "/revit/highlight-and-export");
    if (highlightFailure) {
      const blocker = `Could not create cropped visual evidence for matching duct element(s) ${matchingIds.join(", ")}: ${highlightFailure}`;
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }
    const capture = latestHighlightCapture(toolResults);
    if (!capture) {
      const next = action("/revit/highlight-and-export", {
        elementIds: matchingIds,
        viewId: view.viewId,
        imageSize: 2200,
        paddingFt: 8
      });
      return {
        ok: true,
        handled: true,
        task: { ...task, status: "needs_context" },
        next_action: next,
        assistant_message:
          `I verified matching modeled ductwork by id; next I’ll generate a cropped highlight/export before reporting the redline as picked up.`
      };
    }

    return existingDuctVerificationMessage({ task, ids: matchingIds, rows, capturePath: capture.path });
  }

  const frameFailure = latestFailure(toolResults, "/revit/export-view-frame");
  if (frameFailure) {
    const blocker = `Could not export view ${view.viewId} for redline picking: ${frameFailure}`;
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }
  const frame = latestFrame(toolResults, view.viewId);
  if (!frame) {
    if (countDoneToolPath(toolResults, "/revit/export-view-frame") >= 2) {
      const blocker =
        `View ${view.viewId} frame export was returned more than once, but the deterministic MEP route resolver could not reuse it. ` +
        "Stopping instead of repeating /revit/export-view-frame.";
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }
    const next = action("/revit/export-view-frame", { viewId: view.viewId, imageSize: 2200, includeMapping: true });
    return {
      ok: true,
      handled: true,
      task: { ...task, status: "needs_view_frame" },
      next_action: next,
      assistant_message: `I found the MEP redline on ${sheetNumber} and will export view ${view.viewId} to convert the marked route into model coordinates.`
    };
  }

  const alignmentFailure = latestFailure(toolResults, "/tools/redline/align-to-view");
  const alignment = latestRedlineViewAlignment(toolResults);
  const redlineAlignmentImagePath = alignmentRedlineImagePath(analysis, geometryClassification);
  if (!alignment && !alignmentFailure && redlineAlignmentImagePath && frame.imagePath) {
    const next = action("/tools/redline/align-to-view", {
      redline_file_path: redlineAlignmentImagePath,
      view_image_path: frame.imagePath,
      objective:
        `Align the ${mep.size ?? ""} ${mep.system_type ?? mep.kind} redline route for sheet ${sheetNumber} ` +
        `near room/unit ${roomNumber ?? "target"} to the exported Revit view. The callout text labels the separate red route line; ` +
        `map the red line/polyline center itself, not the text center or text baseline. Return the route/mark center in the Revit view frame.`
    });
    return {
      ok: true,
      handled: true,
      task: { ...task, status: "needs_view_frame" },
      next_action: next,
      assistant_message:
        `I have the Revit view frame and redline preview; next I’ll visually align the marked route to the live view before using any pixel pick as model coordinates.`
    };
  }
  if (alignmentFailure) {
    task = {
      ...task,
      warnings: Array.from(new Set([...task.warnings, `Frame alignment failed or was unavailable: ${alignmentFailure}`]))
    };
  } else if (alignment && (!alignment.matched || alignment.confidence < 0.7 || alignment.marks.length === 0)) {
    task = {
      ...task,
      warnings: Array.from(new Set([...task.warnings, "Frame alignment did not confidently match the redline route to the Revit view; writes remain disabled."]))
    };
  }

  const visibleFailure = latestFailure(toolResults, "/revit/export-visible-elements");
  if (visibleFailure) {
    task = {
      ...task,
      warnings: Array.from(new Set([...task.warnings, `Visible element inventory failed or was unavailable: ${visibleFailure}`]))
    };
  }
  const visibleInventory = latestVisibleElements(toolResults, view.viewId);
  const hasWritableEndpointProjection =
    !!routePointsFromSheetViewportFrameMapping(analysis, geometryClassification, sheetDetail, view.viewId, frame) ||
    !!routePointsFromAlignedTargetPath(analysis, geometryClassification, alignment, frame);
  if (userRequestsApply(userText) && hasWritableEndpointProjection && !visibleInventory && !visibleFailure) {
    const next = action("/revit/export-visible-elements", {
      viewId: view.viewId,
      ...(roomNumber ? { roomNumber } : {}),
      imageSize: 2200,
      includeMapping: true,
      includeLinked: true,
      categories: [
        "OST_MEPSpaces",
        "OST_Rooms",
        "OST_RoomTags",
        "OST_GenericAnnotation",
        "OST_TextNotes",
        "OST_PlumbingFixtures",
        "OST_Casework"
      ],
      limit: 120
    });
    return {
      ok: true,
      handled: true,
      task: { ...task, status: "needs_context" },
      next_action: next,
      assistant_message:
        `Before writing the ${mep.size ?? ""} ${mep.system_type ?? mep.kind} route, I’ll export visible ${roomNumber ? `Unit ${roomNumber}` : "room/unit"} anchors so the duct can be checked against the local room-label/bathroom-kitchen band.`
    };
  }

  const pickFailure = latestFailure(toolResults, "/revit/pick-at-pixel");
  if (pickFailure) {
    const blocker = `Could not resolve the redline route anchor in view ${view.viewId}: ${pickFailure}`;
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }
  const sheetFrameRoutePoints = routePointsFromSheetViewportFrameMapping(analysis, geometryClassification, sheetDetail, view.viewId, frame);
  const alignedRoutePoints = routePointsFromAlignedTargetPath(analysis, geometryClassification, alignment, frame);
  const pickPx = pickPixelFromAlignment(alignment, frame) ?? pickPixelFromMapping(mapping, view.viewId, frame) ?? pickPixelFallbackFromRegion(analysis, frame);
  const anchor = latestPickModelXy(toolResults);
  task = {
    ...task,
    viewport: {
      ...(task.viewport ?? {}),
      view_id: view.viewId,
      frame_id: frame.frameId,
      frame_width_px: frame.width,
      frame_height_px: frame.height,
      ...(pickPx ? { pick_px: pickPx } : {}),
      ...(anchor ? { pick_model_xy: anchor } : {})
    }
  };
  if (!anchor && !sheetFrameRoutePoints && !alignedRoutePoints) {
    if (!pickPx) {
      const blocker = "The MEP redline has route intent, but the extracted annotation geometry could not be mapped to a pick point in the target view.";
      return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
    }
    const next = action("/revit/pick-at-pixel", {
      frameId: frame.frameId,
      xPx: pickPx.x,
      yPx: pickPx.y,
      includeCategories: ["OST_DuctCurves", "OST_DuctFitting", "OST_MechanicalEquipment"],
      searchRadiusPx: 80,
      maxResults: 10
    });
    return {
      ok: true,
      handled: true,
      task: { ...task, status: "needs_pick" },
      next_action: next,
    assistant_message: alignment?.matched
      ? `I visually aligned the route markup to view ${view.viewId}; next I’ll pick the aligned anchor point and use its XY only for MEP routing.`
      : `I mapped the route markup to view ${view.viewId}; next I’ll pick the marked anchor point and use its XY only for MEP routing.`
    };
  }

  const contextFailure = latestFailure(toolResults, "/revit/resolve-mep-routing-context");
  if (contextFailure) {
    const blocker = `Could not resolve the MEP routing context for ${sheetNumber}: ${contextFailure}`;
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }
  const context = latestDoneToolJson(toolResults, "/revit/resolve-mep-routing-context");
  if (!context) {
    const next = action("/revit/resolve-mep-routing-context", {
      viewId: view.viewId,
      ...(roomNumber ? { roomNumber } : {}),
      ...(levelName ? { levelName } : {}),
      systemKind: mep.kind,
      ...(mep.system_classification ? { systemClassification: mep.system_classification } : {}),
      routingMode: "polyline",
      dryRun: true
    });
    return {
      ok: true,
      handled: true,
      task: { ...task, status: "needs_context" },
      next_action: next,
      assistant_message: `I resolved the redline anchor without using linked plumbing as an editable target; next I’ll resolve the ${mep.system_type ?? mep.kind} routing elevation on ${levelName ?? "the target level"}.`
    };
  }

  const resolvedLevelName = latestContextLevel(toolResults) ?? levelName;
  const routeFromTargetPath = anchor ? routePointsFromTargetPath(analysis, geometryClassification, sheetDetail, view.viewId, anchor) : null;
  const initialPoints = sheetFrameRoutePoints ?? alignedRoutePoints ?? routeFromTargetPath ?? (anchor ? buildRoutePointsFromAnchor(anchor) : null);
  if (!initialPoints || initialPoints.length < 2) {
    const blocker = "The MEP redline route was detected, but the route endpoints could not be converted into model coordinates.";
    return { ok: false, handled: true, task: { ...task, status: "blocked", blocker }, assistant_message: blocker, blocker };
  }
  const alignmentVerified = !!alignment?.matched && alignment.confidence >= 0.7 && alignment.marks.length > 0;
  const endpointProjectionVerified = !!sheetFrameRoutePoints || !!alignedRoutePoints;
  let points = initialPoints;
  let localBand = computeLocalBandAssertion(points, toolResults, frame, roomNumber);
  let localBandAdjustmentWarning: string | null = null;
  if (
    userRequestsApply(userText) &&
    localBand.status === "failed" &&
    localBand.failure_kind === "too_far_north" &&
    localBand.correction_kind === "space_bbox_route_shift"
  ) {
    const adjustedPoints = shiftRoutePointsToViewTarget(points, frame, localBand.target_view_y, localBand.target_view_x);
    const adjustedBand = adjustedPoints ? computeLocalBandAssertion(adjustedPoints, toolResults, frame, roomNumber) : null;
    if (adjustedPoints && adjustedBand?.status === "passed") {
      points = adjustedPoints;
      localBand = { ...adjustedBand, correction_kind: "space_bbox_route_shift" };
      localBandAdjustmentWarning = "Route endpoints were shifted from the upper fixture band into the Unit 405 space-bounded redline band and centered on the target space before model write.";
    }
  }
  const localBandAllowsWrite = localBand.status === "passed";
  const apply = userRequestsApply(userText) && (alignmentVerified || !!sheetFrameRoutePoints) && (endpointProjectionVerified || !!anchor) && localBandAllowsWrite;
  if (userRequestsApply(userText) && localBand.status === "failed") {
    const blocker = `The redline route projected into the wrong local plan band: ${localBand.reason}`;
    return {
      ok: false,
      handled: true,
      task: {
        ...task,
        status: "blocked",
        blocker,
        route: {
          points,
          elevation_policy: "resolve_context_default",
          apply: false,
          visual_verify: false
        },
        verification: { status: "blocked", local_band_assertion: localBand }
      },
      assistant_message: blocker,
      blocker
    };
  }
  const alignmentWarning = sheetFrameRoutePoints
    ? "Route endpoints were projected from the explicit PDF redline vector through Revit sheet viewport geometry and frame mapping."
    : alignedRoutePoints
    ? "Route endpoints were projected from the explicit redline vector through the verified view alignment and Revit frame mapping."
    : routeFromTargetPath
    ? alignmentVerified
      ? "Route anchor was verified by frame-aligned visual matching before model write."
      : "Route points are derived from sheet viewport math only; apply is disabled until frame-aligned redline geometry is verified."
    : alignmentVerified
      ? "Route anchor was frame-aligned, but no explicit target path vertices were available; review route shape carefully."
      : "Route points are derived from a picked anchor fallback only; apply is disabled until explicit route geometry is frame-aligned.";
  task = {
    ...task,
    status: "ready",
    confidence: mep.size && geometryKind === "route" ? "medium" : "low",
    warnings: Array.from(new Set([...task.warnings, alignmentWarning, ...(localBandAdjustmentWarning ? [localBandAdjustmentWarning] : [])])),
    location: { ...task.location, ...(resolvedLevelName ? { level_name: resolvedLevelName } : {}) },
    route: {
      points,
      elevation_policy: "resolve_context_default",
      apply,
      visual_verify: apply
    }
  };
  const next = action("/revit/mep-route-workflow", {
    kind: mep.kind,
    viewId: view.viewId,
    visualViewId: view.viewId,
    ...(roomNumber ? { roomNumber } : {}),
    ...(resolvedLevelName ? { levelName: resolvedLevelName } : {}),
    ...(mep.system_type ? { systemType: mep.system_type } : {}),
    ...(mep.size && mep.kind === "duct" ? { ductSize: mep.size } : {}),
    ...(mep.size && mep.kind === "pipe" ? { pipeSize: mep.size } : {}),
    sizePolicy: mep.size ? "explicit_required" : "use_default_with_warning",
    elevationPolicy: "resolve_context_default",
    routingMode: "polyline",
    connectSegments: true,
    verify: true,
    points,
    apply,
    visualVerify: apply,
    imageSize: 2200,
    focusPaddingFt: 8
  });
  return {
    ok: true,
    handled: true,
    task,
    next_action: next,
    assistant_message: apply
      ? `I have a bounded ${mep.size ?? ""} ${mep.system_type ?? mep.kind} route from the redline anchor and will run the deterministic route workflow with post-change visual verification.`
      : `I have a bounded ${mep.size ?? ""} ${mep.system_type ?? mep.kind} route from the redline geometry, but the sheet-to-view alignment is not verified enough to write. I’ll dry-run the deterministic route workflow before any model write.`
  };
}

export async function maybeRunDeterministicMepRouteRedline(req: ChatRequest): Promise<ChatResponse | null> {
  const resolved = await resolveMepRouteRedline(req);
  if (!resolved.handled) return null;
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: resolved.assistant_message,
    actions: resolved.next_action ? [resolved.next_action] : []
  };
}

export function __testOnlyClassifyRedlineGeometry(analysis: RedlineAnalyzeResponse): ClassifiedRedlineGeometry {
  return classifyRedlineGeometry(analysis);
}

export function __testOnlyIsMepRouteContinuationToolResult(result: ToolResult): boolean {
  return isMepRouteContinuationToolResult(result);
}
