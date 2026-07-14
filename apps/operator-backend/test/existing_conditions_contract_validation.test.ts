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

test("runtime contract validation accepts hash-bound registration and approved type-catalog artifacts", () => {
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
  assert.doesNotThrow(() => assertExistingConditionsContract("agent_package", packageValue));

  packageValue.type_mapping_artifact = {
    role: "ground_truth_type_mapping",
    path: "approved_type_catalog.json",
    sha256: "d".repeat(64)
  };
  assert.throws(() => assertExistingConditionsContract("agent_package", packageValue), /invalid_existing_conditions_agent_package_contract/);
});

test("runtime contract validation requires source-observation grounding for exact reconstruction", () => {
  const invalid = validAgentPackage();
  invalid.write_policy = { ...(invalid.write_policy as Record<string, unknown>), require_source_observation_grounding: false };
  assert.throws(() => assertExistingConditionsContract("agent_package", invalid), /invalid_existing_conditions_agent_package_contract/);
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
