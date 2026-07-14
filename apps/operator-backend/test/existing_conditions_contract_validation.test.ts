import test from "node:test";
import assert from "node:assert/strict";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

function validAgentPackage(): Record<string, unknown> {
  return {
    schema_version: 1,
    fixture_id: "fixture",
    discipline: "electrical",
    task_class: "exact_reconstruction",
    task: "test",
    standards_profile: null,
    acceptance_contract: {
      acceptance_basis: ["hidden_truth_geometry", "scope_safety"],
      allows_multiple_valid_solutions: false,
      requires_exact_element_ids: false,
      requires_exact_coordinates: true
    },
    working_model: { role: "redacted_model", path: "model.rvt", sha256: "a".repeat(64) },
    evidence: [{ role: "source_pdf", path: "source.pdf", sha256: "b".repeat(64), page: 1 }],
    scope: {
      scope_id: "scope",
      view_id: 1,
      sheet_number: null,
      model_bounds_ft: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      image_region_normalized: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 }
    },
    allowed_categories: ["OST_ElectricalFixtures"],
    write_policy: {
      dry_run_required: true,
      bounded_scope_required: true,
      out_of_scope_changes_allowed: false,
      maximum_created_elements: 5,
      max_repairs: 2,
      material_confidence_threshold: 0.75,
      forbidden_artifact_roles: ["ground_truth_model"],
      require_native_readback: true,
      require_source_observation_grounding: true,
      require_post_change_visual_receipt: true,
      require_evaluator_change_receipt: true,
      require_evaluator_access_provenance: true
    },
    output_contract: {
      candidate_snapshot_path: "candidate.json",
      post_change_capture_path: "capture.png",
      post_change_pdf_path: "post.pdf",
      run_receipt_path: "receipt.json",
      controller_state_path: "state.json",
      evaluator_access_provenance_path: "access.json"
    }
  };
}

test("runtime contract validation rejects an incomplete candidate", () => {
  assert.throws(
    () => assertExistingConditionsContract("candidate", { schema_version: 1 }),
    /invalid_existing_conditions_candidate_contract/
  );
});

test("runtime contract validation rejects an agent package with unsupported write policy", () => {
  const packageValue = validAgentPackage();
  packageValue.write_policy = { ...(packageValue.write_policy as Record<string, unknown>), dry_run_required: false };
  assert.throws(
    () => assertExistingConditionsContract("agent_package", packageValue),
    /invalid_existing_conditions_agent_package_contract/
  );
});

test("runtime contract validation accepts an exact reconstruction package", () => {
  assert.doesNotThrow(() => assertExistingConditionsContract("agent_package", validAgentPackage()));
});

test("runtime contract validation accepts hash-bound registration, approved type-catalog, and derived evidence artifacts", () => {
  const packageValue = validAgentPackage();
  packageValue.registration_artifact = {
    role: "source_to_model_registration",
    path: "source_to_model_registration.json",
    sha256: "c".repeat(64)
  };
  packageValue.type_mapping_artifact = {
    role: "approved_type_catalog",
    path: "approved_type_catalog.json",
    sha256: "d".repeat(64)
  };
  packageValue.derived_evidence = [{
    role: "architectural_source_redacted_comparison",
    path: "source_redacted_comparison.png",
    sha256: "e".repeat(64)
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("agent_package", packageValue));

  packageValue.type_mapping_artifact = {
    role: "ground_truth_type_mapping",
    path: "approved_type_catalog.json",
    sha256: "d".repeat(64)
  };
  assert.throws(() => assertExistingConditionsContract("agent_package", packageValue), /invalid_existing_conditions_agent_package_contract/);
});

test("runtime contract validation accepts plan-only architectural observations with unresolved material fields", () => {
  const preview = {
    schema_version: 1,
    fixture_id: "architectural-preview-contract-v1",
    scope_id: "scope",
    source_evidence_sha256: "e".repeat(64),
    visible_evidence: [{ role: "source_pdf", sha256: "e".repeat(64) }],
    registration: {
      source_evidence_sha256: "e".repeat(64),
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
        { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
        { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
      ]
    },
    level_name: "L4",
    level_elevation_ft: 32,
    maximum_created_elements: 2,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-1",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location"],
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }]
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "door-1",
        visibility: "clear",
        confidence: 0.9,
        supported_attributes: ["location", "host"],
        point: { x: 5, y: 0 },
        host_wall_observation_id: "wall-1"
      }
    ]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("architectural_preview", preview));
  const invalid = structuredClone(preview);
  (invalid.observations[0] as Record<string, unknown>).hidden_type_guess = "invented";
  assert.throws(
    () => assertExistingConditionsContract("architectural_preview", invalid),
    /invalid_existing_conditions_architectural_preview_contract/
  );
});

test("runtime contract validation requires source-observation grounding for exact reconstruction", () => {
  const invalid = validAgentPackage();
  invalid.write_policy = { ...(invalid.write_policy as Record<string, unknown>), require_source_observation_grounding: false };
  assert.throws(() => assertExistingConditionsContract("agent_package", invalid), /invalid_existing_conditions_agent_package_contract/);
});

test("runtime contract validation accepts registered MEP pixels and rejects hidden truth fields", () => {
  const input = {
    schema_version: 1,
    fixture_id: "registered-electrical-contract-v1",
    scope_id: "bounded-office",
    discipline: "electrical",
    source_evidence_sha256: "a".repeat(64),
    visible_evidence: [
      { role: "source_pdf", sha256: "a".repeat(64) },
      { role: "registered_source_render", sha256: "b".repeat(64) }
    ],
    native_element_references: [],
    registration: {
      source_evidence_sha256: "a".repeat(64),
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
        { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
        { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
      ]
    },
    coordinate_space: "registered_render_pixels_top_left",
    registered_render: {
      path: "agent-visible.png",
      sha256: "b".repeat(64),
      width_px: 100,
      height_px: 100,
      evidence_role: "registered_source_render",
      access_scope: "agent_visible"
    },
    frame: { model_bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } } },
    level_name: "L4",
    level_elevation_ft: 32,
    maximum_observations: 4,
    observations: [{
      kind: "electrical_device",
      discipline: "electrical",
      observation_id: "device-1",
      visibility: "clear",
      confidence: 0.95,
      supported_attributes: ["location", "type"],
      attribute_evidence: [{
        attribute: "type",
        basis: "legible_source_evidence",
        evidence_role: "registered_source_render",
        reference: "duplex receptacle symbol at selected pixel"
      }],
      role: "duplex receptacle",
      pixel_point: { x: 25, y: 75 },
      elevation_ft: 1.5,
      placement: { mode: "unhosted_family", family_name: "Receptacle", type_name: "Duplex" }
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", input));
  const invalid = structuredClone(input);
  (invalid.observations[0] as Record<string, unknown>).withheld_element_id = 12345;
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", invalid),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
});

test("runtime contract validation requires a standards profile and multi-solution acceptance for compliance", () => {
  const invalid = validAgentPackage();
  invalid.task_class = "standards_compliance_repair";
  assert.throws(() => assertExistingConditionsContract("agent_package", invalid), /invalid_existing_conditions_agent_package_contract/);

  const valid = validAgentPackage();
  valid.task_class = "standards_compliance_repair";
  valid.standards_profile = { role: "standards_profile", path: "standards.json", sha256: "c".repeat(64) };
  valid.acceptance_contract = {
    acceptance_basis: ["engineering_invariants", "system_topology", "scope_safety"],
    allows_multiple_valid_solutions: true,
    requires_exact_element_ids: false,
    requires_exact_coordinates: false
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("agent_package", valid));
});
