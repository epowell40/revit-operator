import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { readEvidenceRef, storeEvidence } from "../evidence/evidence_store.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import { loadRegisteredRouteSourceEvidenceV1 } from "./registered_route_evidence.js";
import { readTrustedNativeGridLandmarksV1 } from "./registered_structured_interpretation.js";
import type { TrustedGridLandmarks } from "./native_grid_landmarks.js";

type Binding = { session_id: string; assignment_id: string; run_id: string; generation: number };
type Dependencies = {
  read_ref?: typeof readEvidenceRef;
  snapshot?: typeof getAssignmentKernelSnapshotV2;
  load_source?: typeof loadRegisteredRouteSourceEvidenceV1;
  read_landmarks?: typeof readTrustedNativeGridLandmarksV1;
  store?: typeof storeEvidence;
};

function sameBinding(snapshot: ReturnType<typeof getAssignmentKernelSnapshotV2>, binding: Binding): boolean {
  const current = snapshot?.current_binding;
  return Boolean(current && current.session_id === binding.session_id && current.assignment_id === binding.assignment_id
    && current.run_id === binding.run_id && current.generation === binding.generation);
}

function axesMatch(before: TrustedGridLandmarks, after: TrustedGridLandmarks): boolean {
  if (before.truncated || after.truncated || before.axes.length < 3 || before.axes.length !== after.axes.length) return false;
  const current = new Map(after.axes.map(axis => [axis.element_id, axis]));
  if (current.size !== after.axes.length) return false;
  return before.axes.every(axis => {
    const next = current.get(axis.element_id);
    if (!next || next.name !== axis.name) return false;
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    return (distance(axis.start, next.start) <= 0.01 && distance(axis.end, next.end) <= 0.01)
      || (distance(axis.start, next.end) <= 0.01 && distance(axis.end, next.start) <= 0.01);
  });
}

/** Rebinds only a completed, same-conversation PDF registration after fresh native grid verification. */
export function handoffExistingConditionsRegistrationV1(
  binding: Binding,
  originEvidenceId: string,
  currentLandmarkObservationId: string,
  dependencies: Dependencies = {}
): { evidence_ref: EvidenceRefV1; origin_evidence_id: string; project_fingerprint: string; grid_count: number; native_write_allowed: false } {
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(originEvidenceId)) throw new Error("existing_conditions_handoff_origin_evidence_id_invalid");
  if (!/^obsv2_[a-f0-9]{64}$/.test(currentLandmarkObservationId)) throw new Error("existing_conditions_handoff_current_landmark_observation_id_invalid");
  const snapshot = dependencies.snapshot ?? getAssignmentKernelSnapshotV2;
  if (!sameBinding(snapshot(binding.assignment_id), binding)) throw new Error("existing_conditions_handoff_current_assignment_invalid");
  const ref = (dependencies.read_ref ?? readEvidenceRef)(originEvidenceId);
  if (ref.evidence_id !== originEvidenceId || ref.source !== "existing_conditions_registered_interpretation" || ref.trust_level !== "host_observed"
      || ref.session_id !== binding.session_id || !ref.assignment_id || !ref.run_id || !ref.generation
      || ref.assignment_id === binding.assignment_id) throw new Error("existing_conditions_handoff_origin_scope_invalid");
  const originBinding: Binding = {
    session_id: ref.session_id, assignment_id: ref.assignment_id,
    run_id: ref.run_id, generation: ref.generation
  };
  const previous = snapshot(originBinding.assignment_id);
  if (!sameBinding(previous, originBinding) || !previous?.terminal) throw new Error("existing_conditions_handoff_origin_assignment_incomplete");
  const loadSource = dependencies.load_source ?? loadRegisteredRouteSourceEvidenceV1;
  const registered = loadSource(originBinding, originEvidenceId).interpretation;
  if (!registered.registration?.verified || registered.native_write_allowed !== false
      || !Number.isSafeInteger(registered.native_view_id) || registered.native_view_id <= 0) {
    throw new Error("existing_conditions_handoff_origin_registration_invalid");
  }
  const readLandmarks = dependencies.read_landmarks ?? readTrustedNativeGridLandmarksV1;
  const before = readLandmarks(originBinding, registered.landmark_observation_id);
  const after = readLandmarks(binding, currentLandmarkObservationId);
  if (!/^sha256:[a-f0-9]{64}$/.test(before.project_fingerprint ?? "")
      || before.project_fingerprint !== after.project_fingerprint
      || before.frame.view_id !== registered.native_view_id || after.frame.view_id !== registered.native_view_id
      || !axesMatch(before, after)) {
    throw new Error("existing_conditions_handoff_native_project_or_grids_changed");
  }
  const stored = (dependencies.store ?? storeEvidence)({
    scope: { ...binding, attempt_id: `handoff-${originEvidenceId}` },
    source: "existing_conditions_registered_interpretation",
    trust_level: "host_observed",
    verification_relevance: "supporting",
    target_scope: [`existing-conditions-registration-handoff:${originEvidenceId}`, String(registered.native_view_id)],
    bounded_summary: "Carried a registered PDF interpretation into this Assignment after fresh native project and grid verification.",
    relationships: [
      { evidence_id: originEvidenceId, relation: "derived_from" },
      { evidence_id: after.evidence_id, relation: "derived_from" }
    ],
    raw: {
      ...registered,
      handoff: {
        schema_version: 1,
        origin_registration_evidence_id: originEvidenceId,
        current_landmark_observation_id: currentLandmarkObservationId,
        current_landmark_evidence_id: after.evidence_id,
        project_fingerprint: before.project_fingerprint,
        grid_count: after.axes.length
      }
    }
  });
  return {
    evidence_ref: stored.ref, origin_evidence_id: originEvidenceId,
    project_fingerprint: before.project_fingerprint!, grid_count: after.axes.length,
    native_write_allowed: false
  };
}
