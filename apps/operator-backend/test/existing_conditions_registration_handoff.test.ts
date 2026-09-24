import assert from "node:assert/strict";
import test from "node:test";
import { handoffExistingConditionsRegistrationV1 } from "../src/existing_conditions/registration_handoff.js";

const originEvidenceId = `ev1_${"a".repeat(32)}`;
const currentObservationId = `obsv2_${"b".repeat(64)}`;
const origin = { session_id: "same-operator-chat", assignment_id: "prior-assignment", run_id: "prior-run", generation: 1 };
const current = { session_id: "same-operator-chat", assignment_id: "follow-up-assignment", run_id: "follow-up-run", generation: 1 };
const axes = [
  { element_id: 101, name: "1", start: { x: 0, y: 0 }, end: { x: 0, y: 10 } },
  { element_id: 102, name: "2", start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
  { element_id: 103, name: "A", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
];
const fingerprint = `sha256:${"c".repeat(64)}`;

function fixture(changes: {
  ref?: Record<string, unknown>;
  previousTerminal?: boolean;
  registered?: Record<string, unknown>;
  currentAxes?: typeof axes;
  currentFingerprint?: string;
  currentViewId?: number;
  currentTruncated?: boolean;
} = {}) {
  let stored: any;
  const previous = { current_binding: origin, terminal: changes.previousTerminal ?? true };
  const now = { current_binding: current, terminal: false };
  const ref = {
    evidence_id: originEvidenceId, source: "existing_conditions_registered_interpretation",
    trust_level: "host_observed", ...origin, ...(changes.ref ?? {})
  };
  const registered = {
    registration: { verified: true }, native_view_id: 123, native_write_allowed: false,
    landmark_observation_id: `obsv2_${"d".repeat(64)}`, package_id: "M104-L4", registered_primitives: [],
    ...(changes.registered ?? {})
  };
  const dependencies: any = {
    snapshot: (id: string) => id === origin.assignment_id ? previous : id === current.assignment_id ? now : null,
    read_ref: () => ref,
    load_source: () => ({ interpretation: registered, sha256: "e".repeat(64) }),
    read_landmarks: (binding: typeof current, id: string) => ({
      frame: { view_id: binding.assignment_id === current.assignment_id ? changes.currentViewId ?? 123 : 123 },
      axes: binding.assignment_id === current.assignment_id ? changes.currentAxes ?? axes : axes,
      project_fingerprint: binding.assignment_id === current.assignment_id ? changes.currentFingerprint ?? fingerprint : fingerprint,
      truncated: binding.assignment_id === current.assignment_id ? changes.currentTruncated ?? false : false,
      operation_id: "read-op", evidence_id: binding.assignment_id === current.assignment_id ? "fresh-evidence" : "old-evidence"
    }),
    store: (input: any) => { stored = input; return { ref: { evidence_id: `ev1_${"f".repeat(32)}` } }; }
  };
  return { dependencies, getStored: () => stored };
}

test("r7 follow-up carries completed same-chat PDF registration only after fresh matching native grids", () => {
  const { dependencies, getStored } = fixture();
  const result = handoffExistingConditionsRegistrationV1(current, originEvidenceId, currentObservationId, dependencies);
  assert.equal(result.evidence_ref.evidence_id, `ev1_${"f".repeat(32)}`);
  assert.equal(result.grid_count, 3);
  assert.equal(result.native_write_allowed, false);
  assert.deepEqual(getStored().scope, { ...current, attempt_id: `handoff-${originEvidenceId}` });
  assert.equal(getStored().raw.handoff.origin_registration_evidence_id, originEvidenceId);
  assert.equal(getStored().raw.handoff.current_landmark_observation_id, currentObservationId);
  assert.deepEqual(getStored().relationships.map((r: any) => r.evidence_id), [originEvidenceId, "fresh-evidence"]);
});

test("handoff rejects another chat, nonterminal origin, unverified registration, and missing current binding", () => {
  for (const changes of [
    { ref: { session_id: "other-chat" } },
    { ref: { evidence_id: `ev1_${"0".repeat(32)}` } },
    { previousTerminal: false },
    { registered: { registration: { verified: false } } },
    { ref: { assignment_id: current.assignment_id } }
  ]) {
    const { dependencies, getStored } = fixture(changes);
    assert.throws(() => handoffExistingConditionsRegistrationV1(current, originEvidenceId, currentObservationId, dependencies));
    assert.equal(getStored(), undefined);
  }
});

test("handoff rejects stale or incomplete native model evidence", () => {
  for (const changes of [
    { currentFingerprint: `sha256:${"0".repeat(64)}` },
    { currentViewId: 456 },
    { currentTruncated: true },
    { currentAxes: axes.slice(0, 2) },
    { currentAxes: [{ ...axes[0]!, start: { x: 1, y: 0 } }, ...axes.slice(1)] }
  ]) {
    const { dependencies, getStored } = fixture(changes);
    assert.throws(() => handoffExistingConditionsRegistrationV1(current, originEvidenceId, currentObservationId, dependencies),
      /native_project_or_grids_changed/);
    assert.equal(getStored(), undefined);
  }
});
