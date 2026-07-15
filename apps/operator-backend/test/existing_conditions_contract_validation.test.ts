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

test("ground-truth contracts declare whether elevation is actually observable", () => {
  const groundTruth = {
    schema_version: 1,
    fixture_id: "plan-observable-elevation-v1",
    scope_id: "bounded-plan",
    ground_truth_model: { path: "withheld.rvt", sha256: "a".repeat(64) },
    visible_evidence: [{ role: "source_pdf", sha256: "b".repeat(64) }],
    evaluation_policy: { elevation_evidence: "not_visible" },
    deletion_manifest: {
      requested_element_ids: [1],
      deleted_element_ids: [1],
      dependent_element_ids: [],
      dry_run_receipt_sha256: "c".repeat(64)
    },
    snapshot: {
      native_readback: true,
      elements: [{ key: "pipe-1", kind: "mep_curve", category: "Pipes" }],
      connections: [],
      open_connector_count: 2
    }
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("ground_truth", groundTruth));
  groundTruth.evaluation_policy.elevation_evidence = "hidden_truth_strict";
  assert.throws(() => assertExistingConditionsContract("ground_truth", groundTruth), /invalid_existing_conditions_ground_truth_contract/);
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
  const hostedWithoutInventedChainage = structuredClone(input);
  const hostedObservation = hostedWithoutInventedChainage.observations[0];
  hostedObservation.supported_attributes = ["location", "type", "host"];
  hostedObservation.attribute_evidence.push({
    attribute: "host",
    basis: "native_model_precedent",
    evidence_role: "native_model_inventory",
    reference: "adjacent same-type hosted exemplar"
  });
  hostedWithoutInventedChainage.visible_evidence.push({ role: "native_model_inventory", sha256: "c".repeat(64) });
  (hostedObservation as Record<string, unknown>).placement = {
    mode: "hosted_exemplar",
    source_reference_key: "device-source",
    host_reference_key: "wall-host",
    host_category: "OST_RvtLinks"
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", hostedWithoutInventedChainage));
  const downstreamVent = structuredClone(input) as unknown as Record<string, unknown>;
  downstreamVent.discipline = "plumbing";
  (downstreamVent.visible_evidence as Array<{ role: string; sha256: string }>).push({ role: "native_model_inventory", sha256: "c".repeat(64) });
  downstreamVent.native_element_references = [
    { reference_key: "sanitary-main", element_id: 41, category: "OST_PipeCurves", role: "retained sanitary main", evidence_role: "native_model_inventory", evidence_sha256: "c".repeat(64) },
    { reference_key: "served-fixture", element_id: 73, category: "OST_PlumbingFixtures", role: "served water closet", evidence_role: "native_model_inventory", evidence_sha256: "c".repeat(64) }
  ];
  downstreamVent.observations = [{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "downstream-vent-1",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "size", "main_elevation", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project sizing precedent" },
      { attribute: "main_elevation", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "retained main centerline" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "typical vent rise" },
      { attribute: "system", basis: "user_direction", evidence_role: "registered_source_render", reference: "vent continuation" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project DWV type" }
    ],
    service: "vent",
    geometry_mode: "downstream_vent_tee",
    main_reference_key: "sanitary-main",
    verification_fixture_reference_keys: ["served-fixture"],
    pixel_points: [{ x: 20, y: 80 }, { x: 20, y: 30 }],
    main_elevation_ft: 1.1666666667,
    elevation_ft: 5.1666666667,
    pipe_size: "2 inch",
    pipe_type: "PVC - DWV",
    system_type: "Vent"
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", downstreamVent));
  const plannedMainVent = structuredClone(downstreamVent) as Record<string, unknown>;
  const plannedObservations = plannedMainVent.observations as Array<Record<string, unknown>>;
  const plannedVent = plannedObservations[0]!;
  delete plannedVent.main_reference_key;
  delete plannedVent.main_elevation_ft;
  plannedVent.main_route_observation_id = "planned-sanitary-main";
  plannedVent.supported_attributes = (plannedVent.supported_attributes as string[]).filter((entry) => entry !== "main_elevation");
  plannedVent.attribute_evidence = (plannedVent.attribute_evidence as Array<Record<string, unknown>>)
    .filter((entry) => entry.attribute !== "main_elevation");
  plannedObservations.unshift({
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "planned-sanitary-main",
    visibility: "clear",
    confidence: 0.96,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary size label" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show Z" },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary line convention" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "approved DWV type" }
    ],
    service: "sanitary",
    pixel_points: [{ x: 10, y: 80 }, { x: 90, y: 80 }],
    elevation_ft: 1.1666666667,
    pipe_size: "4 inch",
    pipe_type: "PVC - DWV",
    system_type: "Sanitary"
  });
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", plannedMainVent));
  plannedVent.main_reference_key = "sanitary-main";
  plannedVent.main_elevation_ft = 1.1666666667;
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", plannedMainVent),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const newCircuit = structuredClone(input);
  (newCircuit.observations as Array<Record<string, unknown>>).push({
    kind: "electrical_circuit",
    discipline: "electrical",
    observation_id: "new-circuit-1",
    evidence_role: "registered_source_render",
    visibility: "clear",
    confidence: 0.99,
    supported_attributes: ["circuit"],
    member_observation_ids: ["device-1"],
    circuit_mode: "create_new_power_system",
    system_type: "PowerCircuit",
    membership_basis: "legible_source_circuit_label",
    panel_circuit_label: "P403/8",
    member_label_evidence: [{
      member_observation_id: "device-1",
      evidence_role: "registered_source_render",
      reference: "P403/8 is legible beside device-1.",
      label: "P403/8"
    }]
  });
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", newCircuit));
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
