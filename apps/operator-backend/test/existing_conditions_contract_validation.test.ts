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
      allow_reflection: true,
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
      instance_parameters: { "Receptacle Label": "GFI", "Counter 54in": "1" },
      pixel_point: { x: 25, y: 75 },
      elevation_ft: 1.5,
      placement: { mode: "unhosted_family", family_name: "Receptacle", type_name: "Duplex" }
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", input));
  const provisionalPlanMarker = structuredClone(input) as Record<string, any>;
  provisionalPlanMarker.partial_promotion_policy = "defer_ambiguous_observations";
  provisionalPlanMarker.visible_evidence.push({ role: "native_model_inventory", sha256: "c".repeat(64) });
  provisionalPlanMarker.native_element_references = [{
    reference_key: "power-plan-view",
    element_id: 5302,
    category: "OST_Views",
    role: "registered power plan",
    evidence_role: "native_model_inventory",
    evidence_sha256: "c".repeat(64)
  }];
  delete provisionalPlanMarker.observations[0]!.instance_parameters;
  provisionalPlanMarker.observations[0]!.supported_attributes = [
    "location",
    "provisional plan representation",
    "symbol form",
    "host direction"
  ];
  provisionalPlanMarker.observations[0]!.attribute_evidence = [
    {
      attribute: "provisional plan representation",
      basis: "legible_source_evidence",
      evidence_role: "registered_source_render",
      reference: "source-visible marker location with unresolved native identity"
    },
    {
      attribute: "symbol form",
      basis: "legible_source_evidence",
      evidence_role: "registered_source_render",
      reference: "visible filled circular marker"
    },
    {
      attribute: "host direction",
      basis: "legible_source_evidence",
      evidence_role: "registered_source_render",
      reference: "visible right-facing marker stem"
    }
  ];
  provisionalPlanMarker.observations[0]!.placement = {
    mode: "provisional_plan_symbol",
    view_reference_key: "power-plan-view",
    view_type: "FloorPlan",
    symbol_form: "filled_circle",
    host_direction: "right",
    radius_ft: 0.25,
    stem_length_ft: 0.5
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", provisionalPlanMarker));
  const provisionalPlanMarkerV2 = structuredClone(provisionalPlanMarker);
  provisionalPlanMarkerV2.schema_version = 2;
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", provisionalPlanMarkerV2));
  const invalidProvisionalPlanMarker = structuredClone(provisionalPlanMarker);
  delete invalidProvisionalPlanMarker.observations[0]!.placement.view_type;
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", invalidProvisionalPlanMarker),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const overSpecifiedProvisionalPlanMarker = structuredClone(provisionalPlanMarker);
  overSpecifiedProvisionalPlanMarker.observations[0]!.placement.family_name = "Must not be accepted";
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", overSpecifiedProvisionalPlanMarker),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const representationAwareInput = structuredClone(input) as Record<string, any>;
  representationAwareInput.schema_version = 2;
  representationAwareInput.source_coverage = {
    schema_version: 2,
    scope_id: input.scope_id,
    source_evidence_sha256: input.source_evidence_sha256,
    registered_render_sha256: input.registered_render.sha256,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } },
    disciplines: ["electrical"],
    candidates: [{
      candidate_id: "device-symbol-contract-v2",
      primitive: "point_symbol",
      pixel_bounds: { min: { x: 20, y: 70 }, max: { x: 30, y: 80 } },
      visibility: "clear",
      representation: {
        kind: "single_model_symbol",
        role: "electrical_device",
        evidence: "direct_symbol_geometry",
        symbol_count: 1,
        clipped_by_region: false
      },
      disposition: { status: "resolved", observation_ids: ["device-1"] }
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", representationAwareInput));
  const lightFixture = structuredClone(input) as unknown as {
    visible_evidence: Array<{ role: string; sha256: string }>;
    native_element_references: Array<{
      reference_key: string;
      element_id: number;
      category: string;
      role: string;
      evidence_role: string;
      evidence_sha256: string;
    }>;
    observations: Array<Record<string, unknown>>;
  };
  lightFixture.visible_evidence.push({ role: "native_model_inventory", sha256: "c".repeat(64) });
  lightFixture.native_element_references = [{
    reference_key: "lighting-view",
    element_id: 5301,
    category: "View",
    role: "lighting plan",
    evidence_role: "native_model_inventory",
    evidence_sha256: "c".repeat(64)
  }];
  lightFixture.observations[0]!.kind = "light_fixture";
  delete lightFixture.observations[0]!.instance_parameters;
  lightFixture.observations[0]!.role = "linear light fixture";
  lightFixture.observations[0]!.workset_name = "E-LIGHTING";
  lightFixture.observations[0]!.placement = {
    mode: "unhosted_family",
    family_name: "Linear Light",
    type_name: "Linear 2 Foot",
    annotation_tags: [{
      view_reference_key: "lighting-view",
      family_name: "Lighting Fixture Tag",
      type_name: "Type Mark",
      offset_x_ft: 0.75,
      offset_y_ft: 0.5,
      add_leader: false
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", lightFixture));
  const equipment = structuredClone(input);
  (equipment.observations[0] as Record<string, unknown>).kind = "electrical_equipment";
  (equipment.observations[0] as Record<string, unknown>).role = "panelboard";
  delete (equipment.observations[0] as Record<string, unknown>).instance_parameters;
  (equipment.observations[0] as Record<string, unknown>).placement = {
    mode: "hosted_exemplar",
    source_reference_key: "panel-source",
    host_reference_key: "architectural-link",
    host_category: "OST_RvtLinks",
    copy_distribution_system_from_source: true
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", equipment));
  const conduit = structuredClone(input) as Record<string, unknown>;
  conduit.observations = [{
    kind: "conduit_route",
    discipline: "electrical",
    observation_id: "feeder-conduit-1",
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "one-inch conduit note" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show conduit elevation" },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "feeder designation applies to the selected run" },
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "EMT note applies to the selected run" }
    ],
    service: "feeder",
    pixel_points: [{ x: 20, y: 80 }, { x: 50, y: 80 }, { x: 50, y: 60 }],
    conduit_size: "1 inch",
    conduit_type: "EMT",
    conduit_type_id: 4242,
    elevation_ft: 10
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", conduit));
  const placeholderConduit = structuredClone(conduit) as Record<string, unknown>;
  placeholderConduit.observations = [{
    kind: "conduit_route",
    discipline: "electrical",
    observation_id: "unclassified-conduit-1",
    visibility: "clear",
    confidence: 0.91,
    supported_attributes: ["location", "elevation"],
    attribute_evidence: [
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show conduit elevation" }
    ],
    service: "unclassified",
    pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
    conduit_size_policy: "unresolved_placeholder",
    conduit_type: "EMT",
    type_policy: "unresolved_placeholder",
    elevation_ft: 10
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", placeholderConduit));
  const mechanical = structuredClone(input) as Record<string, unknown>;
  mechanical.discipline = "mechanical";
  mechanical.observations = [{
    kind: "duct_route",
    discipline: "mechanical",
    observation_id: "outside-air-1",
    visibility: "clear",
    confidence: 0.98,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "8 inch diameter label" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show duct elevation" },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "outside-air notation" },
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "round duct graphics" }
    ],
    service: "outside_air",
    pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
    duct_size: "8 inch",
    duct_type: "Round Duct",
    duct_type_id: 139185,
    system_type: "Outside Air",
    elevation_ft: 10
  }, {
    kind: "mechanical_equipment",
    discipline: "mechanical",
    observation_id: "hru-404",
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "type"],
    attribute_evidence: [{
      attribute: "type",
      basis: "legible_source_evidence",
      evidence_role: "registered_source_render",
      reference: "HRU equipment symbol and tag"
    }],
    role: "heat recovery unit",
    pixel_point: { x: 25, y: 75 },
    elevation_ft: 0,
    placement: { mode: "unhosted_family", family_name: "Heat Recovery Unit", type_name: "HRU" }
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", mechanical));
  (mechanical.observations as Array<Record<string, unknown>>).push({
    kind: "air_terminal",
    discipline: "mechanical",
    observation_id: "supply-grille-1",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "type", "host", "airflow", "workset"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "supply grille symbol and type note" },
      { attribute: "host", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "grille center lies on the selected route segment" },
      { attribute: "airflow", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "140 CFM is legible beside the grille" },
      { attribute: "workset", basis: "user_direction", evidence_role: "registered_source_render", reference: "Place mechanical elements on MECH-T-01" }
    ],
    role: "supply grille",
    pixel_point: { x: 50, y: 80 },
    elevation_ft: 10,
    airflow_cfm: 140,
    workset_name: "MECH-T-01",
    placement: {
      mode: "created_route_host",
      family_name: "M_Supply Grille",
      type_name: "16x4 Connection 8 Diameter",
      route_observation_id: "outside-air-1",
      route_segment_index: 0
    }
  });
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", mechanical));
  const invalidCreatedRouteHost = structuredClone(mechanical);
  (invalidCreatedRouteHost.observations as Array<Record<string, unknown>>)[1]!.placement = {
    mode: "created_route_host",
    family_name: "Heat Recovery Unit",
    type_name: "HRU",
    route_observation_id: "outside-air-1",
    route_segment_index: 0
  };
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", invalidCreatedRouteHost),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
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
  const planOnlyPlumbing = structuredClone(input) as unknown as Record<string, unknown>;
  planOnlyPlumbing.schema_version = 2;
  planOnlyPlumbing.discipline = "plumbing";
  (planOnlyPlumbing.visible_evidence as Array<Record<string, unknown>>).push({
    role: "approved_type_catalog",
    sha256: "c".repeat(64)
  });
  planOnlyPlumbing.observations = [{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "unreadable-sanitary-size",
    visibility: "clear",
    confidence: 0.94,
    supported_attributes: ["location", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show Z" },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary line convention" },
      { attribute: "type", basis: "user_direction", evidence_role: "registered_source_render", reference: "use the loaded default pipe type for drafting" }
    ],
    service: "sanitary",
    pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
    pipe_size_policy: "unresolved_placeholder",
    pipe_type: "Default",
    system_type: "Sanitary",
    elevation_ft: 1
  }, {
    kind: "plumbing_fixture",
    discipline: "plumbing",
    observation_id: "connectorless-fixture-graphic",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "type", "service topology"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "water-closet symbol" },
      { attribute: "service topology", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary trace is adjacent to the fixture symbol" }
    ],
    role: "water closet graphic",
    representation_classification: {
      source_graphic: "architectural_fixture",
      native_target: "architectural_fixture",
      basis: "source_observation",
      evidence_role: "registered_source_render",
      reference: "Distinct source-visible architectural water-closet graphic",
      native_target_evidence: {
        basis: "native_model_precedent",
        evidence_role: "approved_type_catalog",
        reference: "Approved exact family/type mapping in the loaded project",
        family_name: "Connectorless Fixture",
        type_name: "Water Closet"
      }
    },
    pixel_point: { x: 20, y: 78 },
    elevation_ft: 0,
    placement: { mode: "unhosted_family", family_name: "Connectorless Fixture", type_name: "Water Closet" },
    service_connection_mode: "plan_proximity",
    service_route_connections: [{ route_observation_id: "unreadable-sanitary-size", route_endpoint: "nearest_plan_segment", maximum_plan_distance_ft: 2 }],
    service_boundary: {
      basis: "source_observation",
      evidence_role: "registered_source_render",
      required_services: ["sanitary"],
      prohibited_services: ["domestic_hot_water"]
    }
  }];
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", planOnlyPlumbing));
  const falseSizeClaim = structuredClone(planOnlyPlumbing);
  (falseSizeClaim.observations as Array<Record<string, unknown>>)[0]!.pipe_size = "2 inch";
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", falseSizeClaim),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const representationMismatch = structuredClone(planOnlyPlumbing);
  const mismatchFixture = (representationMismatch.observations as Array<Record<string, unknown>>)[1]!;
  mismatchFixture.representation_classification = {
    source_graphic: "architectural_fixture",
    native_target: "mep_connection",
    basis: "source_observation",
    evidence_role: "registered_source_render",
    reference: "Architectural silhouette only",
    native_target_evidence: {
      basis: "native_model_precedent",
      evidence_role: "approved_type_catalog",
      reference: "Approved exact family/type mapping in the loaded project",
      family_name: "Connectorless Fixture",
      type_name: "Water Closet"
    }
  };
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", representationMismatch),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const unresolvedRepresentation = structuredClone(planOnlyPlumbing);
  const unresolvedFixture = (unresolvedRepresentation.observations as Array<Record<string, unknown>>)[1]!;
  unresolvedFixture.representation_classification = {
    source_graphic: "unresolved",
    native_target: "mep_connection",
    basis: "source_observation",
    evidence_role: "registered_source_render",
    reference: "Overlapping symbols cannot be separated",
    native_target_evidence: {
      basis: "native_model_precedent",
      evidence_role: "approved_type_catalog",
      reference: "Approved exact family/type mapping in the loaded project",
      family_name: "Connectorless Fixture",
      type_name: "Water Closet"
    }
  };
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", unresolvedRepresentation),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const hostedExemplarFixture = structuredClone(planOnlyPlumbing);
  const hostedFixture = (hostedExemplarFixture.observations as Array<Record<string, unknown>>)[1]!;
  hostedFixture.placement = {
    mode: "hosted_exemplar",
    source_reference_key: "fixture-source",
    host_reference_key: "wall-host",
    host_category: "OST_Walls"
  };
  assert.throws(
    () => assertExistingConditionsContract("registered_mep_observations", hostedExemplarFixture),
    /invalid_existing_conditions_registered_mep_observations_contract/
  );
  const legacyV1Plumbing = structuredClone(planOnlyPlumbing);
  legacyV1Plumbing.schema_version = 1;
  const legacyFixture = (legacyV1Plumbing.observations as Array<Record<string, unknown>>)[1]!;
  delete legacyFixture.representation_classification;
  assert.doesNotThrow(
    () => assertExistingConditionsContract("registered_mep_observations", legacyV1Plumbing)
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
  const newPanelCircuit = structuredClone(newCircuit);
  (newPanelCircuit.observations as Array<Record<string, unknown>>).unshift({
    kind: "electrical_equipment",
    discipline: "electrical",
    observation_id: "panel-p409",
    visibility: "clear",
    confidence: 0.96,
    supported_attributes: ["location", "type"],
    attribute_evidence: [{
      attribute: "type",
      basis: "legible_source_evidence",
      evidence_role: "registered_source_render",
      reference: "Panelboard symbol and P409 tag are legible."
    }],
    role: "panelboard P409",
    pixel_point: { x: 45, y: 55 },
    elevation_ft: 4,
    placement: { mode: "unhosted_family", family_name: "Panelboard", type_name: "Panel P409" }
  });
  ((newPanelCircuit.observations as Array<Record<string, unknown>>).at(-1) as Record<string, unknown>).panel_observation_id = "panel-p409";
  assert.doesNotThrow(() => assertExistingConditionsContract("registered_mep_observations", newPanelCircuit));
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

test("runtime contract validation accepts bounded MEP coverage and rejects an ignored disposition", () => {
  const coverage = {
    schema_version: 1,
    scope_id: "bounded-office",
    source_evidence_sha256: "a".repeat(64),
    registered_render_sha256: "b".repeat(64),
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 10, y: 10 }, max: { x: 90, y: 90 } },
    disciplines: ["electrical"],
    candidates: [{
      candidate_id: "device-symbol-1",
      primitive: "point_symbol",
      pixel_bounds: { min: { x: 20, y: 70 }, max: { x: 30, y: 80 } },
      visibility: "clear",
      disposition: { status: "resolved", observation_ids: ["device-1"] }
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("mep_region_coverage", coverage));

  const invalid = structuredClone(coverage);
  invalid.candidates[0]!.disposition = { status: "ignored", observation_ids: ["device-1"] };
  assert.throws(
    () => assertExistingConditionsContract("mep_region_coverage", invalid),
    /invalid_existing_conditions_mep_region_coverage_contract/
  );
});

test("runtime contract validation accepts representation-aware bounded MEP coverage V2", () => {
  const coverage = {
    schema_version: 2,
    scope_id: "bounded-office-v2",
    source_evidence_sha256: "a".repeat(64),
    registered_render_sha256: "b".repeat(64),
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 10, y: 10 }, max: { x: 90, y: 90 } },
    disciplines: ["electrical"],
    candidates: [{
      candidate_id: "device-symbol-v2-1",
      primitive: "point_symbol",
      pixel_bounds: { min: { x: 20, y: 70 }, max: { x: 30, y: 80 } },
      visibility: "clear",
      representation: {
        kind: "single_model_symbol",
        role: "electrical_device",
        evidence: "direct_symbol_geometry",
        symbol_count: 1,
        clipped_by_region: false
      },
      disposition: { status: "resolved", observation_ids: ["device-1"] }
    }]
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("mep_region_coverage", coverage));

  const missingRepresentation = structuredClone(coverage) as Record<string, any>;
  delete missingRepresentation.candidates[0].representation;
  assert.throws(
    () => assertExistingConditionsContract("mep_region_coverage", missingRepresentation),
    /invalid_existing_conditions_mep_region_coverage_contract/
  );
});

test("candidate and withheld contracts bind bounded MEP coverage receipts", () => {
  const snapshot = {
    native_readback: true,
    elements: [{ key: "device-1", kind: "family_instance", discipline: "electrical", category: "Electrical Fixtures" }],
    connections: [],
    open_connector_count: 0
  };
  const candidate = {
    schema_version: 1,
    fixture_id: "bounded-electrical-v1",
    scope_id: "bounded-office",
    discipline: "electrical",
    visible_evidence: [
      { role: "source_pdf", sha256: "a".repeat(64) },
      { role: "registered_source_render", sha256: "b".repeat(64) }
    ],
    accessed_artifact_roles: ["source_pdf", "registered_source_render"],
    out_of_scope_changed_element_keys: [],
    source_coverage_receipt: {
      schema_version: 1,
      scope_id: "bounded-office",
      source_evidence_sha256: "a".repeat(64),
      registered_render_sha256: "b".repeat(64),
      coordinate_space: "registered_render_pixels_top_left",
      region: { min: { x: 10, y: 10 }, max: { x: 90, y: 90 } },
      region_sha256: "c".repeat(64),
      coverage_contract_sha256: "d".repeat(64),
      coverage_status: "complete",
      disciplines: ["electrical"],
      candidate_count: 1,
      resolved_candidate_ids: ["candidate-1"],
      unresolved_candidate_ids: [],
      covered_observation_ids: ["observation-1"]
    },
    snapshot,
    visual_receipt: {
      post_change_capture_sha256: "e".repeat(64),
      post_change_pdf_sha256: "f".repeat(64),
      evaluator_review: {
        reviewer_role: "evaluator",
        review_status: "pass",
        notes: [],
        receipt_sha256: "1".repeat(64)
      }
    }
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("candidate", candidate));

  const groundTruth = {
    schema_version: 1,
    fixture_id: "bounded-electrical-v1",
    scope_id: "bounded-office",
    discipline: "electrical",
    ground_truth_model: { path: "withheld.rvt", sha256: "9".repeat(64) },
    visible_evidence: candidate.visible_evidence,
    evaluation_policy: {
      bounded_mep_region_coverage: {
        required_coverage_status: "complete",
        source_evidence_sha256: "a".repeat(64),
        registered_render_sha256: "b".repeat(64),
        coverage_contract_sha256: "d".repeat(64),
        region_sha256: "c".repeat(64),
        clear_plan_visible_family_instance_keys: ["device-1"]
      }
    },
    deletion_manifest: {
      requested_element_ids: [1],
      deleted_element_ids: [1],
      dependent_element_ids: [],
      dry_run_receipt_sha256: "8".repeat(64)
    },
    snapshot
  };
  assert.doesNotThrow(() => assertExistingConditionsContract("ground_truth", groundTruth));

  const routeGroundTruth = structuredClone(groundTruth);
  const routePolicy = routeGroundTruth.evaluation_policy.bounded_mep_region_coverage as Record<string, unknown>;
  routePolicy.clear_plan_visible_family_instance_keys = [];
  routePolicy.clear_plan_visible_mep_curve_keys = ["route-1"];
  routePolicy.route_trace_tolerance_ft = 0.25;
  routePolicy.minimum_route_trace_precision = 1;
  routePolicy.minimum_route_trace_recall = 1;
  assert.doesNotThrow(() => assertExistingConditionsContract("ground_truth", routeGroundTruth));

  routePolicy.route_trace_tolerance_ft = 0.26;
  assert.throws(() => assertExistingConditionsContract("ground_truth", routeGroundTruth), /invalid_existing_conditions_ground_truth_contract/);
});
