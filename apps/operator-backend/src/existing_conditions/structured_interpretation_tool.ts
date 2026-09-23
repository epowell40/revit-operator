import crypto from "node:crypto";
import { findSessionUploadById, type UploadIndexRecord } from "../attachments/upload_index.js";
import { readRegisteredPdfAttachment } from "../attachments/read_attachment.js";
import {
  normalizeStructuredExistingConditionsInterpretationV1,
  type ExistingConditionsInterpretationRegionV1,
  type StructuredExistingConditionsInterpretationRequestV1
} from "../vision/structured_existing_conditions_interpretation.js";

export type ExistingConditionsStructuredInterpretationToolInputV1 = {
  schema_version: 1;
  session_id: string;
  package_id: string;
  objective: string;
  views: Array<{
    view_key: string;
    attachment_id: string;
    page: number;
    analysis_role: "sheet_context" | "region_detail";
    region?: ExistingConditionsInterpretationRegionV1;
    parent_context_view_key?: string;
    sheet_hint?: string;
    discipline_hint?: "architectural" | "mechanical" | "plumbing" | "electrical";
  }>;
  response: unknown;
  maximum_source_marks?: number;
  maximum_primitives?: number;
};

type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };
type StoredEvidenceSummary = { evidence_id: string; content_hash: string; trust_level: string; verification_relevance: string };

export type ExistingConditionsStructuredInterpretationToolDependencies = {
  find_upload?: (sessionId: string, attachmentId: string) => UploadIndexRecord | null;
  render_attachment?: (sessionId: string, args: { attachment_id: string; pages: number[]; region?: ExistingConditionsInterpretationRegionV1 }) => Promise<{ content: Content[] }>;
};

export function summarizeExistingConditionsStructuredInterpretationV1(
  result: Awaited<ReturnType<typeof validateExistingConditionsStructuredInterpretationV1>>,
  evidenceRef: StoredEvidenceSummary
): Record<string, unknown> {
  return {
    schema_version: 1,
    package_id: result.receipt.package_id,
    source_binding_sha256: result.receipt.source_binding_sha256,
    interpretation_sha256: result.receipt.interpretation_sha256,
    native_write_allowed: false,
    source_view_count: result.source_views.length,
    region_detail_count: result.receipt.views.filter(view => view.analysis_role === "region_detail").length,
    source_mark_count: result.interpretation.source_marks.length,
    primitive_count: result.interpretation.primitives.length,
    open_questions: result.open_questions,
    evidence_ref: evidenceRef
  };
}

function clean(value: unknown): string { return String(value ?? "").trim(); }
function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}
function boundedRegion(value: unknown, label: string): ExistingConditionsInterpretationRegionV1 {
  const region = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = {
    min_u: region.min_u, min_v: region.min_v, max_u: region.max_u, max_v: region.max_v
  } as Record<string, unknown>;
  for (const [name, coordinate] of Object.entries(result)) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
      throw new Error(`${label}_${name}_must_be_between_zero_and_one`);
    }
  }
  const typed = result as ExistingConditionsInterpretationRegionV1;
  if (typed.min_u >= typed.max_u || typed.min_v >= typed.max_v) throw new Error(`${label}_must_have_positive_area`);
  return typed;
}
function imageSha256(content: Content[], viewKey: string): string {
  const images = content.filter((item): item is Extract<Content, { type: "image" }> => item.type === "image");
  if (images.length !== 1) throw new Error(`existing_conditions_interpretation_render_count_invalid:${viewKey}`);
  const bytes = Buffer.from(images[0]!.data, "base64");
  if (bytes.length === 0) throw new Error(`existing_conditions_interpretation_render_empty:${viewKey}`);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function trustedPageGeometry(content: Content[], viewKey: string, attachmentId: string, page: number, sourceHash: string) {
  const candidates = content.filter((item): item is Extract<Content, { type: "text" }> => item.type === "text").flatMap(item => {
    try {
      const value = JSON.parse(item.text);
      return value?.attachment_id === attachmentId && value?.page === page && value?.sha256 === sourceHash && value?.page_geometry ? [value.page_geometry] : [];
    } catch { return []; }
  });
  if (candidates.length !== 1) throw new Error(`existing_conditions_interpretation_page_geometry_missing_or_ambiguous:${viewKey}`);
  const geometry = candidates[0];
  if (!geometry || typeof geometry.width_points !== "number" || !Number.isFinite(geometry.width_points) || geometry.width_points <= 0
      || typeof geometry.height_points !== "number" || !Number.isFinite(geometry.height_points) || geometry.height_points <= 0
      || !Number.isFinite(geometry.rotation_degrees)) throw new Error(`existing_conditions_interpretation_page_geometry_invalid:${viewKey}`);
  return { width_points: geometry.width_points as number, height_points: geometry.height_points as number, rotation_degrees: geometry.rotation_degrees as number };
}

export async function validateExistingConditionsStructuredInterpretationV1(
  input: ExistingConditionsStructuredInterpretationToolInputV1,
  dependencies: ExistingConditionsStructuredInterpretationToolDependencies = {}
): Promise<ReturnType<typeof normalizeStructuredExistingConditionsInterpretationV1> & {
  source_views: Array<{ view_key: string; attachment_id: string; page: number; source_artifact_sha256: string; image_sha256: string }>;
}> {
  if (!input || input.schema_version !== 1) throw new Error("existing_conditions_interpretation_tool_requires_schema_v1");
  const sessionId = requiredText(input.session_id, "existing_conditions_interpretation_session_id");
  const packageId = requiredText(input.package_id, "existing_conditions_interpretation_package_id");
  const objective = requiredText(input.objective, "existing_conditions_interpretation_objective");
  for (const [name, value] of [["maximum_source_marks", input.maximum_source_marks], ["maximum_primitives", input.maximum_primitives]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 1000)) throw new Error(`existing_conditions_interpretation_${name}_must_be_1_through_1000`);
  }
  const findUpload = dependencies.find_upload ?? findSessionUploadById;
  const renderAttachment = dependencies.render_attachment ?? ((boundSessionId, args) => readRegisteredPdfAttachment(boundSessionId, args));
  if (!Array.isArray(input.views) || input.views.length < 2 || input.views.length > 12) throw new Error("existing_conditions_interpretation_views_must_have_2_through_12_items");
  const viewKeys = input.views.map((view, index) => requiredText(view.view_key, `existing_conditions_interpretation_view_${index}_key`));
  if (new Set(viewKeys).size !== viewKeys.length) throw new Error("existing_conditions_interpretation_duplicate_view_key");

  const checkedViews = input.views.map((view, index) => {
    const viewKey = viewKeys[index]!;
    const attachmentId = requiredText(view.attachment_id, `existing_conditions_interpretation_view_${viewKey}_attachment_id`);
    if (!Number.isSafeInteger(view.page) || view.page < 1) throw new Error(`existing_conditions_interpretation_view_page_invalid:${viewKey}`);
    const upload = findUpload(sessionId, attachmentId);
    if (!upload || upload.id !== attachmentId || upload.session_id !== sessionId) throw new Error(`existing_conditions_interpretation_attachment_not_registered:${viewKey}`);
    const sourceHash = clean(upload.sha256).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error(`existing_conditions_interpretation_attachment_hash_invalid:${viewKey}`);
    if (clean(upload.mime).toLowerCase() !== "application/pdf" && !/\.pdf$/i.test(clean(upload.filename))) throw new Error(`existing_conditions_interpretation_attachment_must_be_pdf:${viewKey}`);
    if (view.analysis_role !== "sheet_context" && view.analysis_role !== "region_detail") throw new Error(`existing_conditions_interpretation_role_invalid:${viewKey}`);
    const region = view.analysis_role === "sheet_context"
      ? { min_u: 0, min_v: 0, max_u: 1, max_v: 1 }
      : boundedRegion(view.region, `existing_conditions_interpretation_detail_region_${viewKey}`);
    return { view, viewKey, attachmentId, sourceHash, region };
  });
  const checkedByKey = new Map(checkedViews.map(view => [view.viewKey, view]));
  for (const checked of checkedViews) {
    if (checked.view.analysis_role !== "region_detail") continue;
    const parent = checkedByKey.get(requiredText(checked.view.parent_context_view_key, `existing_conditions_interpretation_detail_parent_${checked.viewKey}`));
    if (!parent || parent.view.analysis_role !== "sheet_context" || parent.sourceHash !== checked.sourceHash || parent.view.page !== checked.view.page) {
      throw new Error(`existing_conditions_interpretation_detail_parent_source_mismatch:${checked.viewKey}`);
    }
  }
  const sourceViews: Array<{ view_key: string; attachment_id: string; page: number; source_artifact_sha256: string; image_sha256: string }> = [];
  const boundViews: StructuredExistingConditionsInterpretationRequestV1["views"] = [];
  for (const { view, viewKey, attachmentId, sourceHash, region } of checkedViews) {
    const rendered = await renderAttachment(sessionId, { attachment_id: attachmentId, pages: [view.page], ...(view.analysis_role === "region_detail" ? { region } : {}) });
    const rasterHash = imageSha256(rendered.content, viewKey);
    const pageGeometry = trustedPageGeometry(rendered.content, viewKey, attachmentId, view.page, sourceHash);
    sourceViews.push({ view_key: viewKey, attachment_id: attachmentId, page: view.page, source_artifact_sha256: sourceHash, image_sha256: rasterHash });
    boundViews.push({
      view_key: viewKey,
      analysis_role: view.analysis_role,
      source_artifact_sha256: sourceHash,
      source_page: view.page,
      image_sha256: rasterHash,
      page_geometry: pageGeometry,
      page_region: region,
      ...(view.parent_context_view_key ? { parent_context_view_key: view.parent_context_view_key } : {}),
      ...(view.sheet_hint ? { sheet_hint: view.sheet_hint } : {}),
      ...(view.discipline_hint ? { discipline_hint: view.discipline_hint } : {})
    });
  }
  const normalized = normalizeStructuredExistingConditionsInterpretationV1({
    request: {
      schema_version: 1,
      package_id: packageId,
      objective,
      views: boundViews,
      ...(input.maximum_source_marks === undefined ? {} : { maximum_source_marks: input.maximum_source_marks }),
      ...(input.maximum_primitives === undefined ? {} : { maximum_primitives: input.maximum_primitives })
    },
    raw: input.response
  });
  return { ...normalized, source_views: sourceViews };
}
