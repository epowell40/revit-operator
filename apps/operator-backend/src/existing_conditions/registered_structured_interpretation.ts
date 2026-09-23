import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import type { CandidateVisibleFrameMapping } from "./candidate_visible_registration.js";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import type { StructuredExistingConditionsInterpretationReceiptV1 } from "../vision/structured_existing_conditions_interpretation.js";
import type { SheetPixelInterpretationInputV1, SheetPixelPrimitiveV1 } from "./sheet_pixel_interpretation.js";
import type { SheetTopologySourceMarkV1 } from "./sheet_topology_compiler.js";

type Binding = { session_id: string; assignment_id: string; run_id: string; generation: number };
type InterpretationEvidence = {
  ref: EvidenceRefV1;
  payload: {
    receipt: StructuredExistingConditionsInterpretationReceiptV1;
    interpretation: SheetPixelInterpretationInputV1;
    open_questions?: string[];
  };
};
type TrustedFrameObservation = { frame: CandidateVisibleFrameMapping; operation_id: string; evidence_id: string };

export type RegisterStructuredExistingConditionsInterpretationInputV1 = Binding & {
  schema_version: 1;
  interpretation_evidence_id: string;
  frame_observation_id: string;
  controls: Array<{
    control_id: string;
    source_page_uv: { u: number; v: number };
    candidate_view_uv: { u: number; v: number };
  }>;
  allow_reflection?: boolean;
  max_rms_error_ft?: number;
  max_point_error_ft?: number;
};

export type RegisteredStructuredExistingConditionsInterpretationV1 = {
  schema_version: 1;
  interpretation_evidence_id: string;
  frame_observation_id: string;
  frame_operation_id: string;
  frame_evidence_id: string;
  package_id: string;
  native_view_id: number;
  registration: ExistingConditionsRegistrationReceipt;
  native_write_allowed: false;
  open_questions: string[];
  source_marks: SheetTopologySourceMarkV1[];
  registered_primitives: Array<{
    primitive_id: string;
    source_view_key: string;
    source_mark_ids: string[];
    kind: SheetPixelPrimitiveV1["kind"];
    claims: SheetPixelPrimitiveV1["claims"];
    confidence: SheetPixelPrimitiveV1["confidence"];
    source_artifact_sha256: string;
    source_page: number;
    model_points: ExistingConditionsPlanPoint[];
    model_endpoints: Array<{
      endpoint_key: string;
      point: ExistingConditionsPlanPoint;
      outward_direction_xy: [number, number];
      boundary: "internal" | "view_boundary" | "sheet_continuation";
      continuation_key?: string;
      continuation_kind?: "same_level_run" | "vertical_riser";
    }>;
  }>;
};

export type RegisteredStructuredInterpretationDependencies = {
  read_interpretation?: (binding: Binding, evidenceId: string) => InterpretationEvidence;
  read_frame?: (binding: Binding, observationId: string) => TrustedFrameObservation;
};

export function summarizeRegisteredStructuredExistingConditionsInterpretationV1(
  result: RegisteredStructuredExistingConditionsInterpretationV1,
  evidenceRef: { evidence_id: string; content_hash: string; trust_level: string; verification_relevance: string }
): Record<string, unknown> {
  return {
    schema_version: 1,
    interpretation_evidence_id: result.interpretation_evidence_id,
    frame_observation_id: result.frame_observation_id,
    frame_operation_id: result.frame_operation_id,
    frame_evidence_id: result.frame_evidence_id,
    package_id: result.package_id,
    native_view_id: result.native_view_id,
    registration: result.registration,
    native_write_allowed: false,
    registered_primitive_count: result.registered_primitives.length,
    open_questions: result.open_questions,
    evidence_ref: evidenceRef
  };
}

function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function clean(value: unknown): string { return String(value ?? "").trim(); }
function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label}_must_be_between_zero_and_one`);
  return value;
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}
function tuple3(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label}_must_have_three_values`);
  return [finite(value[0], `${label}_0`), finite(value[1], `${label}_1`), finite(value[2], `${label}_2`)];
}

function frameCandidate(value: unknown): CandidateVisibleFrameMapping | null {
  const row = object(value);
  const mapping = object(row.mapping);
  const hasMapping = Object.keys(mapping).length > 0;
  if (hasMapping && (mapping.mode !== "2d_affine" || mapping.modelUnits !== "feet")) return null;
  const frameId = clean(row.frameId ?? row.frame_id);
  const viewId = row.viewId ?? row.view_id;
  const width = row.widthPx ?? row.width_px ?? mapping.rasterWidthPx;
  const height = row.heightPx ?? row.height_px ?? mapping.rasterHeightPx;
  if (hasMapping && (width !== mapping.rasterWidthPx || height !== mapping.rasterHeightPx)) return null;
  const topLeft = row.topLeftXyz ?? row.top_left_xyz ?? mapping.topLeftXyz;
  const topRight = row.topRightXyz ?? row.top_right_xyz ?? mapping.topRightXyz;
  const bottomLeft = row.bottomLeftXyz ?? row.bottom_left_xyz ?? mapping.bottomLeftXyz;
  const level = row.targetLevelElevationFt ?? row.target_level_elevation_ft ?? object(row.targetLevel).elevationFt ?? (hasMapping ? undefined : 0);
  if (!frameId || !Number.isSafeInteger(viewId) || viewId <= 0 || !Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 || !Array.isArray(topLeft) || !Array.isArray(topRight) || !Array.isArray(bottomLeft)) return null;
  return { frame_id: frameId, view_id: viewId, width_px: width, height_px: height, top_left_xyz: tuple3(topLeft, "trusted_frame_top_left"), top_right_xyz: tuple3(topRight, "trusted_frame_top_right"), bottom_left_xyz: tuple3(bottomLeft, "trusted_frame_bottom_left"), target_level_elevation_ft: finite(level, "trusted_frame_target_level_elevation_ft") };
}

function extractTrustedFrame(payload: unknown): CandidateVisibleFrameMapping {
  const root = object(payload);
  const candidates = [root, object(root.raw_payload), object(root.payload), object(root.native_result), object(root.result), object(root.data), object(object(root.observation).raw_payload), object(object(root.structuredContent).observation).raw_payload];
  const frames = candidates.map(frameCandidate).filter((value): value is CandidateVisibleFrameMapping => value !== null);
  const unique = new Map(frames.map(frame => [JSON.stringify(frame), frame]));
  if (unique.size !== 1) throw new Error("existing_conditions_registration_trusted_frame_missing_or_ambiguous");
  return [...unique.values()][0]!;
}

function readInterpretation(binding: Binding, evidenceId: string): InterpretationEvidence {
  const ref = readEvidenceRef(evidenceId);
  if (ref.source !== "existing_conditions_structured_interpretation" || ref.trust_level !== "host_observed"
      || ref.session_id !== binding.session_id || ref.assignment_id !== binding.assignment_id || ref.run_id !== binding.run_id || ref.generation !== binding.generation) {
    throw new Error("existing_conditions_registration_interpretation_evidence_scope_invalid");
  }
  const payload = JSON.parse(readAuthoritativeEvidence(ref, { ...binding, attempt_id: ref.attempt_id }).toString("utf8"));
  if (object(payload).receipt?.native_write_allowed !== false) throw new Error("existing_conditions_registration_interpretation_receipt_invalid");
  return { ref, payload } as InterpretationEvidence;
}

function readFrame(binding: Binding, observationId: string): TrustedFrameObservation {
  const snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id);
  const current = snapshot?.current_binding;
  if (!snapshot || !current || current.session_id !== binding.session_id || current.assignment_id !== binding.assignment_id || current.run_id !== binding.run_id || current.generation !== binding.generation) throw new Error("existing_conditions_registration_assignment_binding_invalid");
  const observation = snapshot.observations[observationId];
  if (!observation || !observation.raw_payload_ref.startsWith("evidence:")) throw new Error("existing_conditions_registration_frame_observation_missing");
  const operation = Object.values(snapshot.operations).find(candidate => candidate.observation_ids.includes(observationId));
  if (!operation || operation.result?.status !== "succeeded" || operation.result.persistent_effect !== "none" || operation.result.request_identity?.method !== "POST" || operation.result.request_identity?.path !== "/revit/export-view-frame") throw new Error("existing_conditions_registration_frame_operation_invalid");
  const evidenceId = observation.raw_payload_ref.slice("evidence:".length);
  const ref = readEvidenceRef(evidenceId);
  if (ref.trust_level !== "authoritative_native" || ref.session_id !== binding.session_id || ref.assignment_id !== binding.assignment_id || ref.run_id !== binding.run_id || ref.generation !== binding.generation) throw new Error("existing_conditions_registration_frame_evidence_scope_invalid");
  const payload = JSON.parse(readAuthoritativeEvidence(ref, { ...binding, attempt_id: operation.operation_id }).toString("utf8"));
  return { frame: extractTrustedFrame(payload), operation_id: operation.operation_id, evidence_id: evidenceId };
}

function viewUvToModel(frame: CandidateVisibleFrameMapping, point: { u: number; v: number }, label: string): ExistingConditionsPlanPoint {
  const u = unit(point?.u, `${label}_u`), v = unit(point?.v, `${label}_v`);
  return {
    x: frame.top_left_xyz[0] + u * (frame.top_right_xyz[0] - frame.top_left_xyz[0]) + v * (frame.bottom_left_xyz[0] - frame.top_left_xyz[0]),
    y: frame.top_left_xyz[1] + u * (frame.top_right_xyz[1] - frame.top_left_xyz[1]) + v * (frame.bottom_left_xyz[1] - frame.top_left_xyz[1])
  };
}

export function registerStructuredExistingConditionsInterpretationV1(
  input: RegisterStructuredExistingConditionsInterpretationInputV1,
  dependencies: RegisteredStructuredInterpretationDependencies = {}
): RegisteredStructuredExistingConditionsInterpretationV1 {
  if (!input || input.schema_version !== 1) throw new Error("existing_conditions_registration_requires_schema_v1");
  const binding: Binding = { session_id: clean(input.session_id), assignment_id: clean(input.assignment_id), run_id: clean(input.run_id), generation: input.generation };
  if (!binding.session_id || !binding.assignment_id || !binding.run_id || !Number.isSafeInteger(binding.generation) || binding.generation < 1) throw new Error("existing_conditions_registration_binding_invalid");
  const interpretationEvidenceId = clean(input.interpretation_evidence_id);
  const frameObservationId = clean(input.frame_observation_id);
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(interpretationEvidenceId)) throw new Error("existing_conditions_registration_interpretation_evidence_id_invalid");
  if (!/^[A-Za-z0-9._:-]{1,240}$/.test(frameObservationId)) throw new Error("existing_conditions_registration_frame_observation_id_invalid");
  const interpretation = (dependencies.read_interpretation ?? readInterpretation)(binding, interpretationEvidenceId);
  const frameObservation = (dependencies.read_frame ?? readFrame)(binding, frameObservationId);
  if (!Array.isArray(input.controls) || input.controls.length < 3 || input.controls.length > 12) throw new Error("existing_conditions_registration_requires_3_through_12_controls");
  const ids = input.controls.map((control, index) => {
    const id = clean(control.control_id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw new Error(`existing_conditions_registration_control_${index}_id_invalid`);
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("existing_conditions_registration_control_ids_must_be_unique");
  const sourceViews = interpretation.payload.receipt?.views;
  if (!Array.isArray(sourceViews) || sourceViews.length === 0) throw new Error("existing_conditions_registration_page_geometry_missing");
  const aspects = sourceViews.map(view => {
    const geometry = view.page_geometry;
    const width = geometry?.width_points, height = geometry?.height_points;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || typeof height !== "number" || !Number.isFinite(height) || height <= 0) throw new Error("existing_conditions_registration_page_geometry_invalid");
    return width / height;
  });
  const pageAspect = aspects[0]!;
  if (aspects.some(aspect => Math.abs(aspect / pageAspect - 1) > 1e-6)) throw new Error("existing_conditions_registration_page_aspects_inconsistent");
  const controls = input.controls.map((control, index) => ({
    source: { x: unit(control.source_page_uv?.u, `existing_conditions_registration_control_${index}_source_u`) * pageAspect, y: unit(control.source_page_uv?.v, `existing_conditions_registration_control_${index}_source_v`) },
    model: viewUvToModel(frameObservation.frame, control.candidate_view_uv, `existing_conditions_registration_control_${index}_candidate`)
  }));
  for (const [name, value] of [["max_rms_error_ft", input.max_rms_error_ft], ["max_point_error_ft", input.max_point_error_ft]] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100)) {
      throw new Error(`existing_conditions_registration_${name}_must_be_positive_and_at_most_100`);
    }
  }
  const registration = { ...solveExistingConditionsRegistration({
    source_evidence_sha256: interpretation.ref.content_hash.replace(/^sha256:/, ""),
    control_points: controls,
    ...(input.allow_reflection === undefined ? {} : { allow_reflection: input.allow_reflection }),
    ...(input.max_rms_error_ft === undefined ? {} : { max_rms_error_ft: input.max_rms_error_ft }),
    ...(input.max_point_error_ft === undefined ? {} : { max_point_error_ft: input.max_point_error_ft })
  }), source_coordinate_scale_x: pageAspect };
  if (!registration.verified) {
    const controlResiduals = controls.map((control, index) => {
      const mapped = transformExistingConditionsPlanPoint(registration, { x: control.source.x / pageAspect, y: control.source.y });
      const label = /^[A-Za-z0-9_-]{1,50}$/.test(ids[index] ?? "") ? ids[index] : `control_${index}`;
      return `${label}:${Math.hypot(mapped.x - control.model.x, mapped.y - control.model.y).toFixed(3)}`;
    });
    const leaveOneOut = controls.length >= 4 ? controls.flatMap((_, excludedIndex) => {
      try {
        const candidate = solveExistingConditionsRegistration({
          source_evidence_sha256: interpretation.ref.content_hash.replace(/^sha256:/, ""),
          control_points: controls.filter((_, index) => index !== excludedIndex),
          ...(input.allow_reflection === undefined ? {} : { allow_reflection: input.allow_reflection }),
          ...(input.max_rms_error_ft === undefined ? {} : { max_rms_error_ft: input.max_rms_error_ft }),
          ...(input.max_point_error_ft === undefined ? {} : { max_point_error_ft: input.max_point_error_ft })
        });
        return candidate.verified ? [{ excludedIndex, candidate }] : [];
      } catch {
        return [];
      }
    }).sort((a, b) => a.candidate.rms_error_ft - b.candidate.rms_error_ft
      || a.candidate.maximum_error_ft - b.candidate.maximum_error_ft) : [];
    const best = leaveOneOut[0];
    const suggestion = best
      ? `:best_leave_one_out=${/^[A-Za-z0-9_-]{1,50}$/.test(ids[best.excludedIndex] ?? "") ? ids[best.excludedIndex] : `control_${best.excludedIndex}`}:rms=${Number(best.candidate.rms_error_ft.toFixed(3))}:max=${Number(best.candidate.maximum_error_ft.toFixed(3))}`
      : "";
    throw new Error(`existing_conditions_registration_residual_exceeds_limit:rms=${registration.rms_error_ft}:max=${registration.maximum_error_ft}:controls=${controlResiduals.join(",")}${suggestion}`);
  }
  const pagePrimitives = interpretation.payload.receipt?.page_primitives;
  if (!Array.isArray(pagePrimitives)) throw new Error("existing_conditions_registration_page_primitives_missing");
  const source = interpretation.payload.interpretation;
  if (source?.schema_version !== 1 || source.package_id !== interpretation.payload.receipt.package_id || !Array.isArray(source.primitives) || !Array.isArray(source.source_marks)) throw new Error("existing_conditions_registration_source_semantics_missing");
  const sourceById = new Map(source.primitives.map(primitive => [primitive.primitive_id, primitive]));
  if (sourceById.size !== source.primitives.length || sourceById.size !== pagePrimitives.length) throw new Error("existing_conditions_registration_source_primitive_set_mismatch");
  const boundViewByKey = new Map(sourceViews.map(view => [view.view_key, view]));
  const registeredPrimitives = pagePrimitives.map(primitive => {
    const semantic = sourceById.get(primitive.primitive_id);
    const view = boundViewByKey.get(primitive.source_view_key);
    if (!semantic || !view || semantic.source_view_key !== primitive.source_view_key || semantic.points.length !== primitive.points.length || (semantic.endpoints ?? []).length !== primitive.endpoints.length) throw new Error(`existing_conditions_registration_primitive_semantics_mismatch:${primitive.primitive_id}`);
    const endpointsByKey = new Map((semantic.endpoints ?? []).map(endpoint => [endpoint.endpoint_key, endpoint]));
    if (endpointsByKey.size !== primitive.endpoints.length) throw new Error(`existing_conditions_registration_endpoint_semantics_mismatch:${primitive.primitive_id}`);
    const scale = view.local_to_page_uv;
    if (!scale || !Number.isFinite(scale.u_scale) || !Number.isFinite(scale.v_scale) || scale.u_scale <= 0 || scale.v_scale <= 0) throw new Error(`existing_conditions_registration_view_scale_missing:${primitive.source_view_key}`);
    return {
      primitive_id: primitive.primitive_id,
      source_view_key: primitive.source_view_key,
      source_mark_ids: [...semantic.source_mark_ids],
      kind: semantic.kind,
      claims: semantic.claims,
      confidence: semantic.confidence,
      source_artifact_sha256: primitive.source_artifact_sha256,
      source_page: primitive.source_page,
      model_points: primitive.points.map(point => transformExistingConditionsPlanPoint(registration, { x: point.u, y: point.v })),
      model_endpoints: primitive.endpoints.map(endpoint => {
        const meaning = endpointsByKey.get(endpoint.endpoint_key);
        if (!meaning) throw new Error(`existing_conditions_registration_endpoint_semantics_mismatch:${primitive.primitive_id}:${endpoint.endpoint_key}`);
        const point = transformExistingConditionsPlanPoint(registration, { x: endpoint.point.u, y: endpoint.point.v });
        const offset = transformExistingConditionsPlanPoint(registration, {
          x: endpoint.point.u + meaning.outward_direction_uv[0] * scale.u_scale,
          y: endpoint.point.v + meaning.outward_direction_uv[1] * scale.v_scale
        });
        const length = Math.hypot(offset.x - point.x, offset.y - point.y);
        if (!Number.isFinite(length) || length < 1e-9) throw new Error(`existing_conditions_registration_endpoint_direction_invalid:${primitive.primitive_id}:${endpoint.endpoint_key}`);
        return {
          endpoint_key: endpoint.endpoint_key,
          point,
          outward_direction_xy: [(offset.x - point.x) / length, (offset.y - point.y) / length] as [number, number],
          boundary: meaning.boundary,
          ...(meaning.continuation_key ? { continuation_key: meaning.continuation_key } : {}),
          ...(meaning.continuation_kind ? { continuation_kind: meaning.continuation_kind } : {})
        };
      })
    };
  });
  return {
    schema_version: 1,
    interpretation_evidence_id: interpretation.ref.evidence_id,
    frame_observation_id: frameObservationId,
    frame_operation_id: frameObservation.operation_id,
    frame_evidence_id: frameObservation.evidence_id,
    package_id: source.package_id,
    native_view_id: frameObservation.frame.view_id,
    registration,
    native_write_allowed: false,
    open_questions: Array.isArray(interpretation.payload.open_questions) ? interpretation.payload.open_questions.map(String).slice(0, 200) : [],
    source_marks: source.source_marks,
    registered_primitives: registeredPrimitives
  };
}
