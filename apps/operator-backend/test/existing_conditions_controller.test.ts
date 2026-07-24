import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceExistingConditionsController,
  createExistingConditionsControllerState,
  getExistingConditionsControllerNextAction,
  type ExistingConditionsControllerState
} from "../src/existing_conditions/controller.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function initial(maxRepairs = 2): ExistingConditionsControllerState {
  return createExistingConditionsControllerState({
    fixture_id: "snowdon-cross-discipline-v1",
    scope_id: "L4-room-403",
    discipline: "mixed",
    allowed_categories: ["OST_DuctCurves", "OST_DuctTerminal", "OST_PipeCurves", "OST_PlumbingFixtures", "OST_ElectricalFixtures"],
    maximum_created_elements: 12,
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    max_repairs: maxRepairs
  });
}

function inspected(): ExistingConditionsControllerState {
  return advanceExistingConditionsController(initial(), {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: true,
    discovered_element_keys: ["host:1"],
    surrounding_anchor_keys: ["host:2"]
  });
}

function groundedInspected(): ExistingConditionsControllerState {
  let state = createExistingConditionsControllerState({
    fixture_id: "independent-occlusion-challenge-v1",
    scope_id: "bounded-plan-region",
    discipline: "mixed",
    allowed_categories: ["OST_DuctCurves", "OST_ElectricalFixtures", "OST_PipeCurves"],
    maximum_created_elements: 6,
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    require_source_observation_grounding: true
  });
  state = advanceExistingConditionsController(state, {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: true,
    inventory_complete: true,
    discovered_element_keys: [],
    surrounding_anchor_keys: ["host:wall-1"],
    source_observations_complete: true,
    source_observations: [
      {
        observation_id: "duct-partial-1",
        evidence_role: "source_pdf",
        discipline: "mechanical",
        category: "OST_DuctCurves",
        role: "supply duct",
        visibility: "partial",
        confidence: 0.55,
        supported_attributes: ["location", "system"]
      },
      {
        observation_id: "receptacle-clear-1",
        evidence_role: "source_pdf",
        discipline: "electrical",
        category: "OST_ElectricalFixtures",
        role: "receptacle",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: ["location", "type", "host"]
      },
      {
        observation_id: "device-ambiguous-1",
        evidence_role: "source_pdf",
        discipline: "electrical",
        category: "OST_ElectricalFixtures",
        role: "wall device",
        visibility: "partial",
        confidence: 0.85,
        supported_attributes: ["location"]
      },
      {
        observation_id: "pipe-clear-1",
        evidence_role: "source_pdf",
        discipline: "plumbing",
        category: "OST_PipeCurves",
        role: "domestic water pipe",
        visibility: "clear",
        confidence: 0.93,
        supported_attributes: ["location", "system", "size", "elevation"]
      }
    ]
  });
  return state;
}

function planned(withAmbiguity = false): ExistingConditionsControllerState {
  return advanceExistingConditionsController(inspected(), {
    type: "plan_submitted",
    elements: [{ plan_key: "duct-1", category: "OST_DuctCurves", role: "duct", action: "create", confidence: 0.95, assumptions: [] }],
    ambiguities: withAmbiguity ? [{
      id: "size",
      topic: "Duct size",
      description: "The PDF callout is partly occluded.",
      material: true,
      confidence: 0.4,
      choices: ["8 inch", "10 inch"]
    }] : []
  });
}

function dryRunPassed(): ExistingConditionsControllerState {
  return advanceExistingConditionsController(planned(), {
    type: "dry_run_completed",
    passed: true,
    planned_element_keys: ["duct-1"],
    receipt_sha256: HASH_B
  });
}

function applied(): ExistingConditionsControllerState {
  return advanceExistingConditionsController(dryRunPassed(), {
    type: "apply_completed",
    passed: true,
    changed_element_keys: ["host:9001"],
    out_of_scope_changed_element_keys: [],
    receipt_sha256: HASH_C
  });
}

test("controller advances through the complete inspect-plan-dry-run-apply-verify path", () => {
  let state = applied();
  assert.equal(state.phase, "verify_native");
  state = advanceExistingConditionsController(state, {
    type: "native_verification_completed",
    passed: true,
    native_readback: true,
    receipt_sha256: HASH_A
  });
  assert.equal(state.phase, "verify_visual");
  state = advanceExistingConditionsController(state, {
    type: "visual_verification_completed",
    passed: true,
    capture_sha256: HASH_B,
    pdf_sha256: HASH_C
  });
  assert.equal(state.phase, "complete");
  assert.match(getExistingConditionsControllerNextAction(state), /final run receipt/i);
});

test("controller rejects changed visible evidence before planning", () => {
  assert.throws(() => advanceExistingConditionsController(initial(), {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_B }],
    native_readback: true,
    discovered_element_keys: [],
    surrounding_anchor_keys: []
  }), /visible_evidence_changed:source_pdf/);
});

test("controller blocks inspection without native readback", () => {
  const state = advanceExistingConditionsController(initial(), {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: false,
    discovered_element_keys: [],
    surrounding_anchor_keys: []
  });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "inspection_missing_native_readback");
});

test("controller blocks a truncated or otherwise incomplete inspection inventory", () => {
  const state = advanceExistingConditionsController(initial(), {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: true,
    inventory_complete: false,
    discovered_element_keys: ["host:1"],
    surrounding_anchor_keys: []
  });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "inspection_inventory_incomplete");
});

test("low-confidence material ambiguity consolidates into one clarification", () => {
  const state = planned(true);
  assert.equal(state.phase, "clarify");
  assert.match(state.clarification_question ?? "", /Duct size/);
  assert.match(state.clarification_question ?? "", /8 inch \/ 10 inch/);
});

test("controller does not proceed until every material ambiguity is answered", () => {
  const state = planned(true);
  assert.throws(() => advanceExistingConditionsController(state, {
    type: "clarification_answered",
    answers: []
  }), /material_ambiguity_unresolved/);
  const resolved = advanceExistingConditionsController(state, {
    type: "clarification_answered",
    answers: [{ ambiguity_id: "size", resolution: "8 inch" }]
  });
  assert.equal(resolved.phase, "dry_run");
});

test("clarification answers must use an offered engineering choice", () => {
  const state = planned(true);
  assert.throws(() => advanceExistingConditionsController(state, {
    type: "clarification_answered",
    answers: [{ ambiguity_id: "size", resolution: "banana" }]
  }), /clarification_resolution_not_offered_choice:size/);
});

test("source-grounded reconstruction blocks incomplete observation inventory", () => {
  const initialState = createExistingConditionsControllerState({
    fixture_id: "challenge",
    scope_id: "scope",
    discipline: "mechanical",
    allowed_categories: ["OST_DuctCurves"],
    maximum_created_elements: 2,
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    require_source_observation_grounding: true
  });
  const state = advanceExistingConditionsController(initialState, {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: true,
    discovered_element_keys: [],
    surrounding_anchor_keys: [],
    source_observations_complete: false,
    source_observations: []
  });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "source_observation_inventory_incomplete");
});

test("partly occluded source evidence automatically becomes one material clarification before writes", () => {
  const state = advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{
      plan_key: "supply-duct-1",
      discipline: "mechanical",
      category: "OST_DuctCurves",
      role: "supply duct",
      action: "create",
      confidence: 0.9,
      assumptions: [],
      source_observation_ids: ["duct-partial-1"],
      required_source_attributes: ["location", "system", "size", "elevation"]
    }]
  });
  assert.equal(state.phase, "clarify");
  assert.equal(state.ambiguities.length, 1);
  assert.match(state.clarification_question ?? "", /confirm location, system, size, elevation/i);
});

test("open-ended source ambiguity requires a recorded user or evidence basis", () => {
  const clarify = advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{
      plan_key: "supply-duct-1",
      discipline: "mechanical",
      category: "OST_DuctCurves",
      role: "supply duct",
      action: "create",
      confidence: 0.9,
      assumptions: [],
      source_observation_ids: ["duct-partial-1"],
      required_source_attributes: ["location", "system", "size", "elevation"]
    }]
  });
  const ambiguityId = clarify.ambiguities[0]!.id;
  assert.throws(() => advanceExistingConditionsController(clarify, {
    type: "clarification_answered",
    answers: [{ ambiguity_id: ambiguityId, resolution: "Use 8 inch at 9 feet." }]
  }), /clarification_resolution_basis_required/);
  const resolved = advanceExistingConditionsController(clarify, {
    type: "clarification_answered",
    answers: [{ ambiguity_id: ambiguityId, resolution: "Use 8 inch at 9 feet.", basis: "user_direction" }]
  });
  assert.equal(resolved.phase, "dry_run");
  assert.equal(resolved.ambiguities[0]?.resolution_basis, "user_direction");
});

test("source-grounded plans reject invented and mixed-discipline observation citations", () => {
  const baseElement = {
    plan_key: "device-1",
    discipline: "electrical" as const,
    category: "OST_ElectricalFixtures",
    role: "receptacle",
    action: "create" as const,
    confidence: 0.9,
    assumptions: [],
    required_source_attributes: ["location", "type", "host"]
  };
  assert.throws(() => advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{ ...baseElement, source_observation_ids: ["invented-observation"] }]
  }), /plan_source_observation_unknown:device-1:invented-observation/);
  assert.throws(() => advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{ ...baseElement, discipline: "mechanical", source_observation_ids: ["receptacle-clear-1"] }]
  }), /plan_source_observation_discipline_mismatch:device-1:receptacle-clear-1/);
  assert.throws(() => advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{ ...baseElement, source_observation_ids: ["pipe-clear-1"] }]
  }), /plan_source_observation_category_mismatch:device-1:pipe-clear-1/);
});

test("type elevation and host ambiguity are consolidated rather than guessed", () => {
  const state = advanceExistingConditionsController(groundedInspected(), {
    type: "plan_submitted",
    elements: [{
      plan_key: "wall-device-1",
      discipline: "electrical",
      category: "OST_ElectricalFixtures",
      role: "wall device",
      action: "create",
      confidence: 0.88,
      assumptions: [],
      source_observation_ids: ["device-ambiguous-1"],
      required_source_attributes: ["location", "type", "mounting elevation", "host"]
    }]
  });
  assert.equal(state.phase, "clarify");
  assert.equal(state.ambiguities.length, 3);
  assert.match(state.clarification_question ?? "", /wall device type/i);
  assert.match(state.clarification_question ?? "", /wall device mounting elevation/i);
  assert.match(state.clarification_question ?? "", /wall device host/i);
});

test("controller rejects plan categories outside the package allowlist", () => {
  assert.throws(() => advanceExistingConditionsController(inspected(), {
    type: "plan_submitted",
    elements: [{ plan_key: "wall-1", category: "OST_Walls", role: "wall", action: "create", confidence: 1, assumptions: [] }]
  }), /out_of_scope_category:OST_Walls/);
});

test("controller blocks dry-run plan drift", () => {
  const state = advanceExistingConditionsController(planned(), {
    type: "dry_run_completed",
    passed: true,
    planned_element_keys: ["duct-1", "extra-duct"],
    receipt_sha256: HASH_B
  });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "dry_run_plan_drift");
});

test("controller blocks an out-of-scope apply receipt", () => {
  const state = advanceExistingConditionsController(dryRunPassed(), {
    type: "apply_completed",
    passed: true,
    changed_element_keys: ["host:9001", "host:42"],
    out_of_scope_changed_element_keys: ["host:42"],
    receipt_sha256: HASH_C
  });
  assert.equal(state.phase, "blocked");
  assert.match(state.blocker ?? "", /out_of_scope_write:host:42/);
});

test("controller counts only created elements when retained anchors also change", () => {
  let state = createExistingConditionsControllerState({
    fixture_id: "fixture",
    scope_id: "scope",
    discipline: "plumbing",
    allowed_categories: ["OST_PlumbingFixtures", "OST_PipeCurves", "OST_PipeFitting"],
    maximum_created_elements: 2,
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }]
  });
  state = advanceExistingConditionsController(state, {
    type: "inspection_completed",
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    native_readback: true,
    discovered_element_keys: [],
    surrounding_anchor_keys: ["host:10", "host:11"]
  });
  state = advanceExistingConditionsController(state, {
    type: "plan_submitted",
    elements: [
      { plan_key: "fixture", category: "OST_PlumbingFixtures", role: "fixture", action: "create", confidence: 1, assumptions: [] },
      { plan_key: "pipe", category: "OST_PipeCurves", role: "pipe", action: "create", confidence: 1, assumptions: [] }
    ]
  });
  state = advanceExistingConditionsController(state, {
    type: "dry_run_completed",
    passed: true,
    planned_element_keys: ["fixture", "pipe"],
    receipt_sha256: HASH_B
  });
  state = advanceExistingConditionsController(state, {
    type: "apply_completed",
    passed: true,
    changed_element_keys: ["host:10", "host:11", "host:100", "host:101"],
    created_element_keys: ["host:100", "host:101"],
    out_of_scope_changed_element_keys: [],
    receipt_sha256: HASH_C
  });
  assert.equal(state.phase, "verify_native");
  assert.deepEqual(state.apply_receipt?.created_element_keys, ["host:100", "host:101"]);
});

test("controller blocks when a claimed created element is absent from the changed receipt", () => {
  const state = advanceExistingConditionsController(dryRunPassed(), {
    type: "apply_completed",
    passed: true,
    changed_element_keys: ["host:9001"],
    created_element_keys: ["host:9002"],
    out_of_scope_changed_element_keys: [],
    receipt_sha256: HASH_C
  });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "created_element_not_in_changed_elements");
});

test("native verification failure enters bounded repair and repeats verification", () => {
  let state = advanceExistingConditionsController(applied(), {
    type: "native_verification_completed",
    passed: false,
    native_readback: true,
    failure_classifications: ["connectivity_mismatch"],
    receipt_sha256: HASH_A
  });
  assert.equal(state.phase, "repair");
  state = advanceExistingConditionsController(state, {
    type: "repair_completed",
    dry_run_passed: true,
    apply_passed: true,
    changed_element_keys: ["host:9001"],
    out_of_scope_changed_element_keys: [],
    receipt_sha256: HASH_B
  });
  assert.equal(state.phase, "verify_native");
  assert.equal(state.repairs_attempted, 1);
});

test("controller blocks when the repair budget is exhausted", () => {
  let state = createExistingConditionsControllerState({
    fixture_id: "fixture",
    scope_id: "scope",
    discipline: "electrical",
    allowed_categories: ["OST_ElectricalFixtures"],
    maximum_created_elements: 1,
    visible_evidence: [{ role: "source_pdf", sha256: HASH_A }],
    max_repairs: 0
  });
  state = advanceExistingConditionsController(state, { type: "inspection_completed", visible_evidence: [{ role: "source_pdf", sha256: HASH_A }], native_readback: true, discovered_element_keys: [], surrounding_anchor_keys: [] });
  state = advanceExistingConditionsController(state, { type: "plan_submitted", elements: [{ plan_key: "device", category: "OST_ElectricalFixtures", role: "receptacle", action: "create", confidence: 1, assumptions: [] }] });
  state = advanceExistingConditionsController(state, { type: "dry_run_completed", passed: true, planned_element_keys: ["device"], receipt_sha256: HASH_B });
  state = advanceExistingConditionsController(state, { type: "apply_completed", passed: true, changed_element_keys: ["host:1"], out_of_scope_changed_element_keys: [], receipt_sha256: HASH_C });
  state = advanceExistingConditionsController(state, { type: "native_verification_completed", passed: false, native_readback: true, failure_classifications: ["circuit_mismatch"], receipt_sha256: HASH_A });
  assert.equal(state.phase, "blocked");
  assert.equal(state.blocker, "circuit_mismatch");
});

test("terminal controller states cannot accept additional events", () => {
  const blocked = advanceExistingConditionsController(initial(), { type: "block", reason: "user_scope_required" });
  assert.throws(() => advanceExistingConditionsController(blocked, { type: "block", reason: "again" }), /terminal_phase:blocked/);
});
