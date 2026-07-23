import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRouteProfileSourceEvidenceV1 } from "../src/existing_conditions/route_profile_source_evidence_gate.js";

const HASH = "a".repeat(64);

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: "e-1",
    source_view_key: "m201",
    source_sha256: HASH,
    kind: "route_annotation" as const,
    association: "direct" as const,
    text: "12x6 flat oval supply air",
    confidence: 0.95,
    ...overrides
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1 as const,
    package_id: "fixture-1",
    primitive_id: "route-1",
    candidate_interpretation_sha256: "b".repeat(64),
    requested_shape: "oval" as const,
    requested_size: "12x6",
    evidence: [evidence()],
    ...overrides
  };
}

test("accepts a directly associated explicit flat-oval profile and size claim", () => {
  const receipt = evaluateRouteProfileSourceEvidenceV1(input());
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.native_write_allowed, true);
  assert.deepEqual(receipt.inferred_shapes, ["oval"]);
  assert.deepEqual(receipt.dispositive_evidence_ids, ["e-1"]);
  assert.deepEqual(receipt.dimension_evidence_ids, ["e-1"]);
});

test("defers oval when the plan has dimensions but oval appears only in an unassociated legend", () => {
  const receipt = evaluateRouteProfileSourceEvidenceV1(input({
    evidence: [
      evidence({ evidence_id: "dimension", kind: "plan_dimension", text: "12x6" }),
      evidence({ evidence_id: "legend", kind: "legend_definition", association: "unassociated", text: "flat oval volume damper" })
    ]
  }));
  assert.equal(receipt.status, "deferred");
  assert.equal(receipt.native_write_allowed, false);
  assert.match(receipt.blockers.join(" "), /ambiguous_from_width_height/);
  assert.deepEqual(receipt.dimension_evidence_ids, ["dimension"]);
});

test("accepts a continuation-linked schedule claim", () => {
  const receipt = evaluateRouteProfileSourceEvidenceV1(input({
    evidence: [evidence({ kind: "linked_schedule", association: "continuation_linked", text: "Route SA-17: 14x8 oval" })],
    requested_size: "14x8"
  }));
  assert.equal(receipt.status, "accepted");
});

test("rejects conflicting explicit rectangular and oval claims", () => {
  const receipt = evaluateRouteProfileSourceEvidenceV1(input({
    evidence: [
      evidence({ evidence_id: "plan", text: "12x6 rectangular" }),
      evidence({ evidence_id: "schedule", kind: "linked_schedule", association: "continuation_linked", text: "12x6 oval" })
    ]
  }));
  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.native_write_allowed, false);
  assert.match(receipt.blockers.join(" "), /conflicting_explicit/);
});

test("accepts a direct round diameter annotation", () => {
  const receipt = evaluateRouteProfileSourceEvidenceV1(input({
    requested_shape: "round",
    requested_size: "8 in",
    evidence: [evidence({ text: "8\"Ø exhaust air" })]
  }));
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(receipt.inferred_shapes, ["round"]);
});
