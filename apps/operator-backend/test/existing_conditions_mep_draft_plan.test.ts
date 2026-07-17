import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAtomicMepDraftWorkflowRequest,
  compileMepDraftPlan,
  type MepDraftPackage
} from "../src/existing_conditions/mep_draft_plan.js";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint
} from "../src/existing_conditions/registration.js";

const SOURCE_HASH = "a".repeat(64);
const MODEL_HASH = "b".repeat(64);
function fixtureRepresentationClassification(
  sourceGraphic: "architectural_fixture" | "mep_connection_symbol",
  nativeTarget: "architectural_fixture" | "mep_connection",
  familyName: string,
  typeName: string
) {
  return {
    source_graphic: sourceGraphic,
    native_target: nativeTarget,
    basis: "source_observation" as const,
    evidence_role: "source_pdf",
    reference: sourceGraphic === "architectural_fixture"
      ? "Distinct source-visible architectural fixture graphic"
      : "Distinct source-visible MEP connection symbol",
    native_target_evidence: {
      basis: "native_model_precedent" as const,
      evidence_role: "native_model_inventory",
      reference: "Approved exact family/type mapping in the loaded project",
      family_name: familyName,
      type_name: typeName
    }
  };
}

function visibleEvidence() {
  return [
    { role: "source_pdf", sha256: SOURCE_HASH },
    { role: "native_model_inventory", sha256: MODEL_HASH }
  ];
}

function nativeReferences() {
  return [
    {
      reference_key: "receptacle-source",
      element_id: 111,
      category: "OST_ElectricalFixtures",
      role: "duplex receptacle",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH,
      power_system_ids: ["system-333"]
    },
    {
      reference_key: "south-wall-host",
      element_id: 222,
      category: "OST_Walls",
      role: "south wall",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH
    },
    {
      reference_key: "circuit-source",
      element_id: 333,
      category: "OST_ElectricalFixtures",
      role: "P403/6 exemplar",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH,
      power_system_ids: ["system-333"]
    },
    {
      reference_key: "panel-source",
      element_id: 444,
      category: "OST_ElectricalEquipment",
      role: "120/208 V panelboard precedent",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH
    },
    {
      reference_key: "hru-existing",
      element_id: 555,
      category: "OST_MechanicalEquipment",
      role: "existing HRU with native electrical connector",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH
    }
  ];
}

function registration() {
  return {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
      { source: { x: 10, y: 0 }, model: { x: 100, y: 220 } },
      { source: { x: 0, y: 10 }, model: { x: 80, y: 200 } }
    ],
    max_rms_error_ft: 0.01
  };
}

function plumbingTopologyPackage(): MepDraftPackage {
  return {
    schema_version: 1,
    fixture_id: "independent-plumbing-topology-v1",
    scope_id: "independent-restroom-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "pipe_route",
        observation_id: "route-cw-random-81",
        discipline: "plumbing",
        service: "domestic_cold_water",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        pipe_size: "3/4 inch",
        pipe_type: "Copper Type L",
        system_type: "Domestic Cold Water",
        elevation_ft: 8.5
      },
      {
        kind: "plumbing_fixture",
        observation_id: "fixture-random-29",
        discipline: "plumbing",
        role: "source-defined cold-water fixture",
        representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "Benchmark Fixture", "Cold Only"),
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "service_topology"],
        point: { x: 0, y: 0 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Benchmark Fixture", type_name: "Cold Only" },
        service_route_connections: [{ route_observation_id: "route-cw-random-81", route_endpoint: "start" }],
        service_boundary: {
          basis: "source_observation",
          evidence_role: "source_pdf",
          required_services: ["domestic_cold_water"],
          prohibited_services: ["domestic_hot_water"]
        }
      }
    ]
  };
}

test("plumbing fixture representation gate prevents architectural graphics from becoming MEP connection families", () => {
  const mismatch = plumbingTopologyPackage();
  const fixture = mismatch.observations[1];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  fixture.representation_classification = {
    ...fixture.representation_classification,
    source_graphic: "architectural_fixture",
    native_target: "mep_connection",
    basis: "source_observation",
    evidence_role: "source_pdf",
    reference: "Visible sink bowl and countertop outline only"
  };
  assert.throws(
    () => compileMepDraftPlan(mismatch),
    /architectural_fixture_cannot_create_mep_connection/
  );

  const unresolved = plumbingTopologyPackage();
  const unresolvedFixture = unresolved.observations[1];
  if (unresolvedFixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  unresolvedFixture.representation_classification = {
    ...unresolvedFixture.representation_classification,
    source_graphic: "unresolved",
    native_target: "mep_connection",
    basis: "source_observation",
    evidence_role: "source_pdf",
    reference: "Overlapping fixture silhouette and route endpoint cannot be separated"
  };
  assert.throws(
    () => compileMepDraftPlan(unresolved),
    /source_graphic_unresolved_no_native_placement/
  );

  const grounded = compileMepDraftPlan(plumbingTopologyPackage());
  assert.equal(grounded.status, "ready");
  assert.equal(grounded.actions.some((entry) => entry.action_key === "place:fixture-random-29"), true);
});

function provisionalElectricalMarkerPackage(
  symbolForm: "hollow_circle" | "filled_circle" | "unclassified_circle" = "hollow_circle",
  hostDirection: "left" | "right" | "up" | "down" | "unresolved" = "left"
): MepDraftPackage {
  return {
    schema_version: 1,
    fixture_id: "source-visible-provisional-power-marker-v1",
    scope_id: "record-drawing-power-scope-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [
      ...nativeReferences(),
      {
        reference_key: "power-plan-view",
        element_id: 777,
        category: "OST_Views",
        role: "registered source power plan",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      }
    ],
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 12,
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [
      {
        kind: "electrical_device",
        observation_id: "power-device-marker-random-71",
        discipline: "electrical",
        role: "source-visible electrical device, exact family/type unresolved",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: [
          "location",
          "provisional plan representation",
          "symbol form",
          ...(hostDirection === "unresolved" ? [] : ["host direction"])
        ],
        point: { x: 4, y: 6 },
        elevation_ft: 0,
        placement: {
          mode: "provisional_plan_symbol",
          view_reference_key: "power-plan-view",
          view_type: "FloorPlan",
          symbol_form: symbolForm,
          host_direction: hostDirection,
          ...(hostDirection === "unresolved" ? { stem_length_ft: 0 } : {})
        }
      }
    ]
  };
}

test("source-visible electrical locations compile to explicitly provisional view-specific markers", () => {
  const plan = compileMepDraftPlan(provisionalElectricalMarkerPackage());
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.provisional_observation_ids, ["power-device-marker-random-71"]);
  assert.deepEqual(plan.promoted_observation_ids, ["power-device-marker-random-71"]);
  assert.equal(plan.plan_elements[0]?.category, "OST_Lines");
  assert.match(plan.plan_elements[0]?.assumptions.join(" ") ?? "", /no modeled electrical device/i);
  assert.match(plan.warnings.join(" "), /view-specific DetailCurves only/i);

  const action = plan.actions[0];
  assert.equal(action?.action_key, "place:power-device-marker-random-71");
  assert.equal(action?.path, "/revit/draw-detail-curves");
  assert.equal(action?.expected_created_min, 3);
  assert.equal(action?.expected_created_max, 3);
  assert.equal(action?.provisional_plan_representation?.modeled_device_created, false);
  assert.equal(action?.provisional_plan_representation?.benchmark_credit, false);
  assert.equal(action?.apply_body?.expectedViewType, "FloorPlan");
  assert.equal(action?.apply_body?.expectedLevelName, "Benchmark L2");
  assert.equal(action?.apply_body?.projectToViewPlane, true);
  assert.deepEqual(action?.apply_body?.curves, [
    {
      kind: "arc",
      a: { xyz: [87.75, 208, 12] },
      b: { xyz: [88.25, 208, 12] },
      c: { xyz: [88, 208.25, 12] }
    },
    {
      kind: "arc",
      a: { xyz: [88.25, 208, 12] },
      b: { xyz: [87.75, 208, 12] },
      c: { xyz: [88, 207.75, 12] }
    },
    {
      kind: "line",
      a: { xyz: [88, 207.75, 12] },
      b: { xyz: [88, 207.25, 12] }
    }
  ]);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
  assert.equal(workflow.maximumCreatedElements, 3);
  assert.equal(workflow.operations[0]?.provisional_plan_representation?.complete_scope_credit, false);
});

test("provisional power markers preserve source-visible symbol form without claiming family type", () => {
  const filled = compileMepDraftPlan(provisionalElectricalMarkerPackage("filled_circle", "right"));
  assert.equal(filled.actions[0]?.expected_created_max, 12);
  const filledCurves = filled.actions[0]?.apply_body?.curves as Array<{
    kind: string;
    a?: { xyz: number[] };
    b?: { xyz: number[] };
  }>;
  assert.equal(filledCurves.length, 12);
  assert.equal(filledCurves[3]?.kind, "line");
  assert.ok(Math.abs((filledCurves[3]?.a?.xyz[1] ?? 0) - 207.8) < 1e-9);
  assert.ok(Math.abs((filledCurves[3]?.b?.xyz[1] ?? 0) - 207.8) < 1e-9);
  assert.ok((filledCurves[3]?.a?.xyz[0] ?? 0) < 88);
  assert.ok((filledCurves[3]?.b?.xyz[0] ?? 0) > 88);

  const unresolved = compileMepDraftPlan(provisionalElectricalMarkerPackage("unclassified_circle", "unresolved"));
  assert.equal(unresolved.actions[0]?.expected_created_max, 3);
  assert.equal((unresolved.actions[0]?.apply_body?.curves as unknown[])?.length, 3);
});

test("provisional host directions follow reflected source registration", () => {
  const reflected = provisionalElectricalMarkerPackage("hollow_circle", "up");
  reflected.registration = {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
      { source: { x: 10, y: 0 }, model: { x: 110, y: 200 } },
      { source: { x: 0, y: 10 }, model: { x: 100, y: 190 } }
    ],
    max_rms_error_ft: 0.001,
    max_point_error_ft: 0.001,
    allow_reflection: true
  };
  const action = compileMepDraftPlan(reflected).actions[0];
  const curves = action?.apply_body?.curves as Array<{
    kind: string;
    a?: { xyz: number[] };
    b?: { xyz: number[] };
  }>;
  assert.deepEqual(curves[2], {
    kind: "line",
    a: { xyz: [104, 193.75, 12] },
    b: { xyz: [104, 193.25, 12] }
  });
});

test("provisional power markers fail closed on scope, view, parameters, and circuit claims", () => {
  const noPolicy = provisionalElectricalMarkerPackage();
  delete noPolicy.partial_promotion_policy;
  assert.throws(
    () => compileMepDraftPlan(noPolicy),
    /provisional_plan_symbol_requires_partial_promotion_policy/
  );

  const wrongView = provisionalElectricalMarkerPackage();
  wrongView.native_element_references.at(-1)!.category = "OST_Walls";
  assert.throws(
    () => compileMepDraftPlan(wrongView),
    /provisional_view_reference_category_mismatch/
  );

  for (const forbiddenAttribute of ["type", "host", "circuit", "panel", "instance parameters"]) {
    const overclaim = provisionalElectricalMarkerPackage();
    overclaim.observations[0]!.supported_attributes.push(forbiddenAttribute);
    assert.throws(
      () => compileMepDraftPlan(overclaim),
      /provisional_plan_symbol_forbidden_supported_attributes/
    );
  }

  const missingViewType = provisionalElectricalMarkerPackage();
  const missingViewTypeDevice = missingViewType.observations[0];
  if (!missingViewTypeDevice || missingViewTypeDevice.kind !== "electrical_device") throw new Error("test_setup_failed");
  delete (missingViewTypeDevice.placement as { view_type?: string }).view_type;
  assert.throws(
    () => compileMepDraftPlan(missingViewType),
    /provisional_view_type_invalid/
  );

  const withParameters = provisionalElectricalMarkerPackage();
  const parameterDevice = withParameters.observations[0];
  if (!parameterDevice || parameterDevice.kind !== "electrical_device") throw new Error("test_setup_failed");
  parameterDevice.instance_parameters = { GFI: "Yes" };
  assert.throws(
    () => compileMepDraftPlan(withParameters),
    /provisional_plan_symbol_cannot_set_instance_parameters/
  );

  const circuitMember = provisionalElectricalMarkerPackage();
  circuitMember.observations.push({
    kind: "electrical_circuit",
    observation_id: "circuit-random-72",
    discipline: "electrical",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["circuit"],
    member_observation_ids: ["power-device-marker-random-71"],
    circuit_mode: "match_source_power_system",
    source_reference_key: "circuit-source",
    expected_power_system_id: "system-333",
    membership_basis: "native_source_power_system"
  });
  assert.throws(
    () => compileMepDraftPlan(circuitMember),
    /provisional_plan_symbol_cannot_be_circuit_member/
  );
});

test("plumbing fixture representation classification must cite visible evidence", () => {
  const input = plumbingTopologyPackage();
  const fixture = input.observations[1];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  fixture.representation_classification = {
    ...fixture.representation_classification,
    evidence_role: "withheld_native_truth"
  };
  assert.throws(
    () => compileMepDraftPlan(input),
    /representation_classification_evidence_role_unknown/
  );

  const familyMismatch = plumbingTopologyPackage();
  const mismatchedFixture = familyMismatch.observations[1];
  if (mismatchedFixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  mismatchedFixture.representation_classification.native_target_evidence.family_name = "Different Family";
  assert.throws(
    () => compileMepDraftPlan(familyMismatch),
    /native_target_family_type_mismatch/
  );

  const punctuationCollision = plumbingTopologyPackage();
  const punctuationFixture = punctuationCollision.observations[1];
  if (punctuationFixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  punctuationFixture.representation_classification.native_target_evidence.family_name = "Benchmark-Fixture";
  assert.throws(
    () => compileMepDraftPlan(punctuationCollision),
    /native_target_family_type_mismatch/
  );

  const sourceAsTargetPrecedent = plumbingTopologyPackage();
  const sourceBackedFixture = sourceAsTargetPrecedent.observations[1];
  if (sourceBackedFixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  sourceBackedFixture.representation_classification.native_target_evidence.evidence_role = "source_pdf";
  assert.throws(
    () => compileMepDraftPlan(sourceAsTargetPrecedent),
    /native_target_precedent_cannot_use_source_observation/
  );

  const nativeAsSource = plumbingTopologyPackage();
  const nativeBackedFixture = nativeAsSource.observations[1];
  if (nativeBackedFixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  nativeBackedFixture.evidence_role = "native_model_inventory";
  nativeBackedFixture.representation_classification.evidence_role = "native_model_inventory";
  assert.throws(
    () => compileMepDraftPlan(nativeAsSource),
    /source_classification_cannot_use_native_evidence/
  );
});

test("registration solves scale rotation translation and reports residual", () => {
  const receipt = solveExistingConditionsRegistration(registration());
  assert.equal(receipt.verified, true);
  assert.ok(Math.abs(receipt.scale - 2) < 1e-9);
  assert.ok(Math.abs(receipt.rotation_degrees - 90) < 1e-9);
  assert.ok(receipt.rms_error_ft < 1e-9);
  const transformed = transformExistingConditionsPlanPoint(receipt, { x: 4, y: 3 });
  assert.ok(Math.abs(transformed.x - 94) < 1e-9);
  assert.ok(Math.abs(transformed.y - 208) < 1e-9);
});

test("registration explicitly supports top-left raster Y reflection", () => {
  const reflectedInput = {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
      { source: { x: 10, y: 0 }, model: { x: 110, y: 200 } },
      { source: { x: 0, y: 10 }, model: { x: 100, y: 190 } }
    ],
    max_rms_error_ft: 0.001,
    max_point_error_ft: 0.001
  };
  const blocked = solveExistingConditionsRegistration(reflectedInput);
  assert.equal(blocked.verified, false);
  assert.equal(blocked.reflection_applied, false);

  const receipt = solveExistingConditionsRegistration({ ...reflectedInput, allow_reflection: true });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.reflection_applied, true);
  assert.ok(receipt.rms_error_ft < 1e-9);
  const transformed = transformExistingConditionsPlanPoint(receipt, { x: 4, y: 3 });
  assert.ok(Math.abs(transformed.x - 104) < 1e-9);
  assert.ok(Math.abs(transformed.y - 197) < 1e-9);
});

test("registration rejects degenerate source controls", () => {
  assert.throws(() => solveExistingConditionsRegistration({
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 1, y: 1 }, model: { x: 0, y: 0 } },
      { source: { x: 1, y: 1 }, model: { x: 10, y: 10 } },
      { source: { x: 1, y: 1 }, model: { x: 20, y: 20 } }
    ]
  }), /non_collinear|degenerate/);
});

test("registration rejects a localized control-point error even when RMS tolerance is loose", () => {
  const receipt = solveExistingConditionsRegistration({
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
      { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
      { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } },
      { source: { x: 10, y: 10 }, model: { x: 10.8, y: 10 } }
    ],
    max_rms_error_ft: 1,
    max_point_error_ft: 0.25
  });
  assert.equal(receipt.rms_error_ft < receipt.max_rms_error_ft, true);
  assert.equal(receipt.maximum_error_ft > receipt.max_point_error_ft, true);
  assert.equal(receipt.verified, false);
});

test("plumbing plan compiles registered routes fixture placement and deferred native joins", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "plumbing-independent-layout-v1",
    scope_id: "level-4-room-403",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32.1666666666667,
    room_number: "403",
    observations: [
      {
        kind: "pipe_route",
        observation_id: "cold-1",
        discipline: "plumbing",
        service: "domestic_cold_water",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        points: [{ x: 2, y: 1 }, { x: 6, y: 1 }],
        pipe_size: "1/2 inch",
        pipe_type: "Copper",
        system_type: "Domestic Cold Water",
        elevation_ft: 9,
        connect_to_existing: true,
        require_existing_endpoint_connections: true
      },
      {
        kind: "plumbing_fixture",
        observation_id: "lav-1",
        discipline: "plumbing",
        role: "lavatory",
        representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "SinkConnection", "Vanity"),
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "service_topology"],
        point: { x: 2, y: 1 },
        elevation_ft: 0,
        placement: {
          mode: "unhosted_family",
          family_name: "SinkConnection",
          type_name: "Vanity"
        },
        service_route_connections: [{ route_observation_id: "cold-1", route_endpoint: "start" }],
        service_boundary: {
          basis: "source_observation",
          evidence_role: "source_pdf",
          required_services: ["domestic_cold_water"],
          prohibited_services: ["domestic_hot_water"]
        }
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families",
    "/revit/connect-mep-elements"
  ]);
  const route = plan.actions[0]!;
  assert.equal(route.dry_run_body?.apply, false);
  assert.equal(route.apply_body?.apply, true);
  assert.deepEqual(route.dry_run_body?.points, [
    { x: 98, y: 204, z: 41.1666666666667 },
    { x: 98, y: 212, z: 41.1666666666667 }
  ]);
  assert.deepEqual(plan.actions[1]?.dry_run_body?.instances, [{
    x: 98,
    y: 204,
    z: 32.1666666666667,
    coordinateMode: "absolute_model"
  }]);
  assert.deepEqual(plan.actions[1]?.expected_model_point, { x: 98, y: 204, z: 32.1666666666667 });
  const connect = plan.actions[2]!;
  assert.deepEqual(connect.depends_on, ["place:lav-1", "route:cold-1"]);
  assert.equal(connect.deferred_body?.required_connection_count, 1);
  assert.equal(connect.deferred_body?.target_elements?.[0]?.output, "route_start");
  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.dryRun, true);
  assert.equal(workflow.inputFingerprintSha256, plan.input_fingerprint_sha256);
  assert.deepEqual(workflow.operations.map((entry) => entry.action_key), ["route:cold-1", "place:lav-1", "connect:lav-1:cold-1"]);
  assert.equal(workflow.operations[2]?.apply_body, undefined);
  assert.equal(workflow.operations[2]?.deferred_body?.required_connection_count, 1);
});

test("plumbing plan preserves domestic hot-water return as an explicit native route service", () => {
  const input = plumbingTopologyPackage();
  input.observations = [{
    kind: "pipe_route",
    observation_id: "route-hwr-independent-17",
    discipline: "plumbing",
    service: "domestic_hot_water_return",
    visibility: "clear",
    confidence: 0.98,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    points: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
    pipe_size: "3/4 inch",
    pipe_type: "Copper Type L",
    system_type: "Domestic Hot Water Recirc",
    elevation_ft: 8.5
  }];

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.equal(plan.plan_elements[0]?.role, "domestic hot water return");
  assert.equal(plan.actions[0]?.path, "/revit/mep-route-workflow");
  assert.equal(plan.actions[0]?.dry_run_body?.systemType, "Domestic Hot Water Recirc");
  assert.equal(plan.actions[0]?.dry_run_body?.pipeSize, "3/4 inch");
});

test("plumbing source branch compiles an exact tee against a prior route segment", () => {
  const input = plumbingTopologyPackage();
  input.observations = [
    input.observations[0]!,
    {
      kind: "pipe_route",
      observation_id: "route-cw-branch-random-32",
      discipline: "plumbing",
      service: "domestic_cold_water",
      geometry_mode: "source_branch_tee",
      main_route_observation_id: "route-cw-random-81",
      visibility: "clear",
      confidence: 0.96,
      supported_attributes: ["location", "size", "elevation", "system", "type"],
      points: [{ x: 2, y: 0 }, { x: 2, y: 3 }],
      pipe_size: "1/2 inch",
      pipe_type: "Copper Type L",
      system_type: "Domestic Cold Water",
      elevation_ft: 8.5,
      tee_family_name: "Tee - Generic",
      tee_type_name: "Standard"
    }
  ];
  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:route-cw-random-81",
    "route:route-cw-branch-random-32"
  ]);
  const branch = plan.actions[1]!;
  assert.equal(branch.path, "/revit/connect-mep-branch");
  assert.deepEqual(branch.depends_on, ["route:route-cw-random-81"]);
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 100, y: 204, z: 8.5 },
    { x: 94, y: 204, z: 8.5 }
  ]);
  assert.equal(branch.apply_body?.branchSystemType, "Domestic Cold Water");
  assert.equal(branch.apply_body?.branchPipeType, "Copper Type L");
  assert.equal(branch.apply_body?.teeFamilyName, "Tee - Generic");
  assert.equal(branch.apply_body?.teeTypeName, "Standard");
  assert.deepEqual(branch.deferred_body?.main_element, {
    created_by_action: "route:route-cw-random-81",
    output: "route_segment",
    index: 0
  });

  const offMain = structuredClone(input);
  const offMainBranch = offMain.observations[1];
  if (offMainBranch?.kind !== "pipe_route" || offMainBranch.geometry_mode !== "source_branch_tee") assert.fail("branch invalid");
  offMainBranch.points[0] = { x: 2, y: 1 };
  assert.throws(() => compileMepDraftPlan(offMain), /planned_main_tee_point_off_route/);

  const wrongService = structuredClone(input);
  const wrongServiceBranch = wrongService.observations[1];
  if (wrongServiceBranch?.kind !== "pipe_route" || wrongServiceBranch.geometry_mode !== "source_branch_tee") assert.fail("branch invalid");
  wrongServiceBranch.service = "domestic_hot_water";
  wrongServiceBranch.system_type = "Domestic Hot Water";
  assert.throws(() => compileMepDraftPlan(wrongService), /main_route_service_type_mismatch/);
});

test("connectorless plumbing graphics compile as non-scored placeholder routes and plan-proximity topology", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "connectorless-plan-proximity-v1",
    scope_id: "room-404-source-visible-plumbing",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "404",
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [
      {
        kind: "pipe_route",
        observation_id: "sanitary-visible-main",
        discipline: "plumbing",
        service: "sanitary",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "Plan shows no Z; use a low-weight drafting offset." }
        ],
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
        pipe_size_policy: "unresolved_placeholder",
        pipe_type: "Default",
        system_type: "Sanitary",
        elevation_ft: 1
      },
      {
        kind: "plumbing_fixture",
        observation_id: "connectorless-water-closet-graphic",
        discipline: "plumbing",
        role: "water closet graphic",
        representation_classification: fixtureRepresentationClassification("architectural_fixture", "architectural_fixture", "Connectorless Fixture", "Water Closet"),
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "service topology"],
        point: { x: 2, y: 0.5 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Connectorless Fixture", type_name: "Water Closet" },
        service_connection_mode: "plan_proximity",
        service_route_connections: [{
          route_observation_id: "sanitary-visible-main",
          route_endpoint: "nearest_plan_segment",
          maximum_plan_distance_ft: 2
        }],
        service_boundary: {
          basis: "source_observation",
          evidence_role: "source_pdf",
          required_services: ["sanitary"],
          prohibited_services: ["domestic_hot_water"]
        }
      },
      {
        kind: "pipe_route",
        observation_id: "visible-downstream-vent",
        discipline: "plumbing",
        service: "vent",
        geometry_mode: "downstream_vent_tee",
        main_route_observation_id: "sanitary-visible-main",
        verification_fixture_observation_ids: ["connectorless-water-closet-graphic"],
        verification_mode: "plan_topology_only",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "Plan shows the vent takeoff but no Z; use a low-weight rise." }
        ],
        points: [{ x: 3, y: 0 }, { x: 3, y: 2 }],
        pipe_size_policy: "unresolved_placeholder",
        pipe_type: "Default",
        system_type: "Vent",
        elevation_ft: 5
      }
    ]
  });
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.provisional_observation_ids, [
    "sanitary-visible-main",
    "visible-downstream-vent"
  ]);
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:sanitary-visible-main",
    "place:connectorless-water-closet-graphic",
    "route:visible-downstream-vent"
  ]);
  assert.equal(plan.actions[0]?.dry_run_body?.sizePolicy, "placeholder_allowed");
  assert.equal(plan.actions[0]?.dry_run_body?.pipeSize, undefined);
  assert.equal(plan.actions[2]?.apply_body?.branchSize, undefined);
  assert.doesNotMatch(plan.actions.map((entry) => entry.path).join("\n"), /connect-mep-elements|audit-plumbing-fixture-services/);
  assert.match(plan.warnings.join("\n"), /one-inch drafting placeholder/i);
  assert.match(plan.warnings.join("\n"), /plan proximity only/i);

  const source = structuredClone(({
    schema_version: 1,
    fixture_id: "bad-unresolved-size-v1",
    scope_id: "bad",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    observations: [{
      kind: "pipe_route" as const,
      observation_id: "bad-route",
      discipline: "plumbing" as const,
      service: "sanitary" as const,
      visibility: "clear" as const,
      confidence: 0.9,
      supported_attributes: ["location", "size", "elevation", "system", "type"],
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      pipe_size: "2 inch",
      pipe_size_policy: "unresolved_placeholder" as const,
      pipe_type: "Default",
      system_type: "Sanitary",
      elevation_ft: 1
    }]
  }) satisfies MepDraftPackage);
  assert.throws(() => compileMepDraftPlan(source), /unresolved_placeholder_must_omit_pipe_size/);
});

test("mechanical plan compiles explicit duct routes and unhosted equipment placement", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "mechanical-independent-layout-v1",
    scope_id: "level-4-room-404",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "404",
    observations: [
      {
        kind: "duct_route",
        observation_id: "outside-air-1",
        discipline: "mechanical",
        service: "outside_air",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "No elevation is shown in plan; assume 10 feet above L4 in the plenum." }
        ],
        points: [{ x: 2, y: 1 }, { x: 6, y: 1 }],
        duct_size: "8 inch",
        duct_type: "Round Duct",
        duct_type_id: 139185,
        system_type: "Outside Air",
        elevation_ft: 10
      },
      {
        kind: "mechanical_equipment",
        observation_id: "hru-404",
        discipline: "mechanical",
        role: "heat recovery unit",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "type", "host"],
        point: { x: 2, y: 1 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Heat Recovery Unit", type_name: "HRU" }
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.path), ["/revit/mep-route-workflow", "/revit/place-families"]);
  assert.deepEqual(plan.actions[0]?.apply_body?.points, [
    { x: 98, y: 204, z: 42 },
    { x: 98, y: 212, z: 42 }
  ]);
  assert.equal(plan.actions[0]?.apply_body?.kind, "duct");
  assert.equal(plan.actions[0]?.apply_body?.ductSize, "8 inch");
  assert.equal(plan.actions[0]?.apply_body?.ductTypeId, 139185);
  assert.equal(plan.actions[1]?.dry_run_body?.familyName, "Heat Recovery Unit");
  assert.equal(plan.actions[1]?.dry_run_body?.allowUnhostedWorkPlanePlacement, undefined);
  assert.deepEqual(plan.actions[1]?.dry_run_body?.instances, [{
    x: 98,
    y: 204,
    z: 32,
    coordinateMode: "absolute_model"
  }]);
  assert.deepEqual(plan.actions[1]?.expected_model_point, { x: 98, y: 204, z: 32 });
  assert.equal(plan.plan_elements[0]?.category, "OST_DuctCurves");
  assert.equal(plan.plan_elements[1]?.category, "OST_MechanicalEquipment");
});

test("mechanical plan compiles hydronic supply and return as native pipe routes without plumbing coercion", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "mechanical-hydronic-independent-v1",
    scope_id: "level-3-corridor-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L3",
    level_elevation_ft: 24,
    observations: [
      {
        kind: "pipe_route",
        observation_id: "heating-supply-random-31",
        discipline: "mechanical",
        service: "heating_hot_water_supply",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type", "workset"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "No elevation is shown in plan; use a declared plenum offset." },
          { attribute: "workset", basis: "native_model_precedent", reference: "Retained hydronic routes use the mechanical piping workset." }
        ],
        points: [{ x: 2, y: 1 }, { x: 8, y: 1 }],
        pipe_size: "3/4 inch",
        pipe_type: "Small Radius Elbows",
        system_type: "Heating Hot Water Supply",
        workset_name: "MECH-PIPING",
        elevation_ft: 10
      },
      {
        kind: "pipe_route",
        observation_id: "heating-return-random-44",
        discipline: "mechanical",
        service: "heating_hot_water_return",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type", "workset"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "No elevation is shown in plan; use a declared plenum offset." },
          { attribute: "workset", basis: "native_model_precedent", reference: "Retained hydronic routes use the mechanical piping workset." }
        ],
        points: [{ x: 2, y: 2 }, { x: 8, y: 2 }],
        pipe_size: "3/4 inch",
        pipe_type: "Small Radius Elbows",
        system_type: "Heating Hot Water Return",
        workset_name: "MECH-PIPING",
        elevation_ft: 10
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.apply_body?.kind), ["pipe", "pipe"]);
  assert.deepEqual(plan.actions.map((entry) => entry.apply_body?.systemType), [
    "Heating Hot Water Supply",
    "Heating Hot Water Return"
  ]);
  assert.deepEqual(plan.actions.map((entry) => entry.apply_body?.worksetName), ["MECH-PIPING", "MECH-PIPING"]);
  assert.deepEqual(plan.plan_elements.map((entry) => entry.category), ["OST_PipeCurves", "OST_PipeCurves"]);
  assert.deepEqual(plan.source_observations.map((entry) => entry.discipline), ["mechanical", "mechanical"]);
});

function createdRouteHostedTerminalPackage(): MepDraftPackage {
  return {
    schema_version: 1,
    fixture_id: "mechanical-created-route-host-v1",
    scope_id: "level-4-room-404",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "404",
    observations: [
      {
        kind: "duct_route",
        observation_id: "supply-trunk-visible-1",
        discipline: "mechanical",
        service: "supply_air",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "elevation", basis: "declared_heuristic", reference: "No elevation is shown in plan; assume 10 feet above L4." }
        ],
        points: [{ x: 2, y: 1 }, { x: 6, y: 1 }, { x: 8, y: 1 }],
        duct_size: "8 inch",
        duct_type: "Round Duct",
        system_type: "Supply Air",
        elevation_ft: 10
      },
      {
        kind: "air_terminal",
        observation_id: "supply-grille-visible-1",
        discipline: "mechanical",
        role: "supply grille",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type", "host"],
        point: { x: 7, y: 1 },
        elevation_ft: 10,
        placement: {
          mode: "created_route_host",
          family_name: "M_Supply Grille",
          type_name: "16x4 Connection 8 Diameter",
          route_observation_id: "supply-trunk-visible-1",
          route_segment_index: 1,
          rotation_degrees: 90
        }
      }
    ]
  };
}

function createdRouteBranchTerminalPackage(): MepDraftPackage {
  const input = createdRouteHostedTerminalPackage();
  input.fixture_id = "mechanical-created-route-branch-v1";
  const terminal = input.observations[1];
  if (terminal?.kind !== "air_terminal") assert.fail("terminal fixture invalid");
  terminal.point = { x: 7, y: 3 };
  terminal.placement = {
    mode: "created_route_branch",
    family_name: "M_Supply Grille",
    type_name: "16x4 Connection 8 Diameter",
    route_observation_id: "supply-trunk-visible-1",
    route_segment_index: 1,
    branch_points: [{ x: 7, y: 1 }, { x: 7, y: 3 }],
    branch_size: "16x4",
    tee_family_name: "Rectangular Tee",
    tee_type_name: "Standard",
    rotation_degrees: 90
  };
  return input;
}

test("air terminal carries source-grounded airflow and workset into atomic family placement", () => {
  const input = createdRouteHostedTerminalPackage();
  const terminal = input.observations[1];
  if (terminal?.kind !== "air_terminal") assert.fail("terminal fixture invalid");
  terminal.airflow_cfm = 140;
  terminal.workset_name = "MECH-T-01";
  terminal.supported_attributes.push("airflow", "workset");
  terminal.attribute_provenance = [
    ...(terminal.attribute_provenance ?? []),
    { attribute: "airflow", basis: "source_observation", reference: "140 CFM is legible beside the selected terminal." },
    { attribute: "workset", basis: "native_model_precedent", reference: "Retained Level 03 mechanical elements use MECH-T-01." }
  ];

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  const placement = plan.actions.find((entry) => entry.action_key === "place:supply-grille-visible-1")!;
  assert.equal(placement.apply_body?.worksetName, "MECH-T-01");
  assert.deepEqual(placement.apply_body?.instances, [{
    x: 98,
    y: 214,
    z: 42,
    coordinateMode: "absolute_model",
    rotationDegrees: 90,
    parameters: { Flow: String(140 / 60) }
  }]);
});

test("unhosted air terminal explicitly opts into work-plane placement without weakening other families", () => {
  const input = createdRouteHostedTerminalPackage();
  const terminal = input.observations[1];
  if (terminal?.kind !== "air_terminal") assert.fail("terminal fixture invalid");
  terminal.placement = {
    mode: "unhosted_family",
    family_name: "M_Supply Grille",
    type_name: "16x4 Connection 8 Diameter"
  };

  const plan = compileMepDraftPlan(input);
  const placement = plan.actions.find((entry) => entry.action_key === "place:supply-grille-visible-1")!;
  assert.equal(placement.apply_body?.allowUnhostedWorkPlanePlacement, true);
  assert.equal(placement.dry_run_body?.allowUnhostedWorkPlanePlacement, true);
});

test("air terminal compiles a source-grounded branch tee and native terminal connection", () => {
  const plan = compileMepDraftPlan(createdRouteBranchTerminalPackage());
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:supply-trunk-visible-1",
    "place:supply-grille-visible-1",
    "branch:supply-grille-visible-1",
    "connect:supply-grille-visible-1"
  ]);
  const placement = plan.actions[1]!;
  assert.equal(placement.path, "/revit/place-families");
  assert.deepEqual(placement.depends_on, ["route:supply-trunk-visible-1"]);
  assert.deepEqual(placement.apply_body?.instances, [{
    x: 94,
    y: 214,
    z: 42,
    coordinateMode: "absolute_model",
    rotationDegrees: 90
  }]);
  const branch = plan.actions[2]!;
  assert.equal(branch.path, "/revit/connect-mep-branch");
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 98, y: 214, z: 42 },
    { x: 94, y: 214, z: 42 }
  ]);
  assert.equal(branch.apply_body?.branchSize, "16x4");
  assert.equal(branch.apply_body?.teeFamilyName, "Rectangular Tee");
  assert.deepEqual(branch.deferred_body?.main_element, {
    created_by_action: "route:supply-trunk-visible-1",
    output: "route_segment",
    index: 1
  });
  const connection = plan.actions[3]!;
  assert.equal(connection.path, "/revit/connect-mep-elements");
  assert.deepEqual(connection.depends_on, ["place:supply-grille-visible-1", "branch:supply-grille-visible-1"]);
  assert.deepEqual(connection.deferred_body?.target_elements, [{
    created_by_action: "branch:supply-grille-visible-1",
    output: "route_end"
  }]);
  assert.deepEqual(buildAtomicMepDraftWorkflowRequest(plan).operations.map((entry) => entry.action_key),
    plan.actions.map((entry) => entry.action_key));
});

test("created route branch rejects off-main starts and terminal endpoint mismatches", () => {
  const offMain = createdRouteBranchTerminalPackage();
  const offMainTerminal = offMain.observations[1];
  if (offMainTerminal?.kind !== "air_terminal" || offMainTerminal.placement.mode !== "created_route_branch") assert.fail("terminal fixture invalid");
  offMainTerminal.placement.branch_points[0] = { x: 7, y: 2 };
  assert.throws(() => compileMepDraftPlan(offMain), /branch_start_off_host_route_segment/);

  const endpointMismatch = createdRouteBranchTerminalPackage();
  const endpointTerminal = endpointMismatch.observations[1];
  if (endpointTerminal?.kind !== "air_terminal" || endpointTerminal.placement.mode !== "created_route_branch") assert.fail("terminal fixture invalid");
  endpointTerminal.placement.branch_points[1] = { x: 7, y: 2 };
  assert.throws(() => compileMepDraftPlan(endpointMismatch), /branch_end_must_match_terminal_point/);
});

test("air terminal can resolve a specific duct segment created earlier in the atomic workflow", () => {
  const plan = compileMepDraftPlan(createdRouteHostedTerminalPackage());
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:supply-trunk-visible-1",
    "place:supply-grille-visible-1"
  ]);
  const placement = plan.actions[1]!;
  assert.equal(placement.path, "/revit/place-families");
  assert.deepEqual(placement.depends_on, ["route:supply-trunk-visible-1"]);
  assert.deepEqual(placement.deferred_body?.host_element, {
    created_by_action: "route:supply-trunk-visible-1",
    output: "route_segment",
    index: 1
  });
  assert.deepEqual(placement.apply_body?.instances, [{
    x: 98,
    y: 214,
    z: 42,
    coordinateMode: "absolute_model",
    rotationDegrees: 90
  }]);
  assert.deepEqual(placement.expected_model_point, { x: 98, y: 214, z: 42 });
  assert.deepEqual(buildAtomicMepDraftWorkflowRequest(plan).operations[1]?.deferred_body?.host_element,
    placement.deferred_body?.host_element);
});

test("created route host placement rejects unknown, non-duct, out-of-range, and off-segment references", () => {
  const unknown = createdRouteHostedTerminalPackage();
  const terminal = unknown.observations[1];
  if (terminal?.kind !== "air_terminal" || terminal.placement.mode !== "created_route_host") assert.fail("terminal fixture invalid");
  terminal.placement.route_observation_id = "missing-route";
  assert.throws(() => compileMepDraftPlan(unknown), /host_route_observation_must_be_duct_route:missing-route/);

  const nonDuct = createdRouteHostedTerminalPackage();
  const nonDuctTerminal = nonDuct.observations[1];
  if (nonDuctTerminal?.kind !== "air_terminal" || nonDuctTerminal.placement.mode !== "created_route_host") assert.fail("terminal fixture invalid");
  nonDuctTerminal.placement.route_observation_id = "supply-grille-visible-1";
  assert.throws(() => compileMepDraftPlan(nonDuct), /host_route_observation_must_be_duct_route:supply-grille-visible-1/);

  const outOfRange = createdRouteHostedTerminalPackage();
  const outOfRangeTerminal = outOfRange.observations[1];
  if (outOfRangeTerminal?.kind !== "air_terminal" || outOfRangeTerminal.placement.mode !== "created_route_host") assert.fail("terminal fixture invalid");
  outOfRangeTerminal.placement.route_segment_index = 2;
  assert.throws(() => compileMepDraftPlan(outOfRange), /host_route_segment_index_out_of_range:2/);

  const offSegment = createdRouteHostedTerminalPackage();
  const offSegmentTerminal = offSegment.observations[1];
  if (offSegmentTerminal?.kind !== "air_terminal") assert.fail("terminal fixture invalid");
  offSegmentTerminal.point = { x: 7, y: 2 };
  assert.throws(() => compileMepDraftPlan(offSegment), /point_off_host_route_segment/);
});

test("provisional duct attributes preserve route geometry but cannot establish terminal topology", () => {
  for (const mode of ["created_route_host", "created_route_branch"] as const) {
    for (const unresolvedAttribute of ["type", "size"] as const) {
      const input = mode === "created_route_host"
        ? createdRouteHostedTerminalPackage()
        : createdRouteBranchTerminalPackage();
      input.partial_promotion_policy = "defer_ambiguous_observations";
      const route = input.observations[0];
      if (route?.kind !== "duct_route") assert.fail("duct route fixture invalid");
      if (unresolvedAttribute === "type") {
        route.type_policy = "unresolved_placeholder";
        route.supported_attributes = route.supported_attributes.filter((attribute) => attribute !== "type");
      } else {
        route.duct_size_policy = "unresolved_placeholder";
        delete route.duct_size;
        route.supported_attributes = route.supported_attributes.filter((attribute) => attribute !== "size");
      }
      assert.throws(
        () => compileMepDraftPlan(input),
        /provisional_duct_cannot_establish_terminal_topology:supply-trunk-visible-1/
      );
    }
  }

  const routeOnly = createdRouteHostedTerminalPackage();
  routeOnly.partial_promotion_policy = "defer_ambiguous_observations";
  routeOnly.observations = [routeOnly.observations[0]!];
  const route = routeOnly.observations[0];
  if (route?.kind !== "duct_route") assert.fail("duct route fixture invalid");
  route.type_policy = "unresolved_placeholder";
  route.supported_attributes = route.supported_attributes.filter((attribute) => attribute !== "type");
  const plan = compileMepDraftPlan(routeOnly);
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), ["route:supply-trunk-visible-1"]);
});

test("created route host placement is restricted to air terminals", () => {
  const input = createdRouteHostedTerminalPackage();
  const terminal = input.observations[1];
  if (terminal?.kind !== "air_terminal") assert.fail("terminal fixture invalid");
  input.observations[1] = { ...terminal, kind: "mechanical_equipment" };
  assert.throws(() => compileMepDraftPlan(input), /created_route_host_requires_air_terminal/);
});

test("electrical plan compiles host-aware devices before factual circuit assignment", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-independent-layout-v1",
    scope_id: "level-4-room-403",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    room_number: "403",
    observations: [
      {
        kind: "electrical_device",
        observation_id: "receptacle-a",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: ["location", "type", "host"],
        point: { x: 3, y: 4 },
        elevation_ft: 1.5,
        placement: {
          mode: "hosted_exemplar",
          source_reference_key: "receptacle-source",
          host_reference_key: "south-wall-host",
          host_category: "OST_Walls",
          target_chainage_ft: 7.25,
          room_side: "south",
          match_orientation_from_source: false
        }
      },
      {
        kind: "electrical_circuit",
        observation_id: "circuit-p403-6",
        discipline: "electrical",
        evidence_role: "native_model_inventory",
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["circuit"],
        member_observation_ids: ["receptacle-a"],
        source_reference_key: "circuit-source",
        expected_power_system_id: "system-333",
        membership_basis: "native_source_power_system",
        panel_circuit_label: "P403/6"
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.actions[0]?.path, "/revit/place-family-instance-on-host");
  assert.deepEqual(plan.actions[0]?.expected_model_point, { x: 92, y: 206, z: 1.5 });
  assert.deepEqual(plan.actions[0]?.dry_run_body?.pointXyz, [92, 206, 1.5]);
  assert.equal(plan.actions[0]?.dry_run_body?.matchOrientationFromSource, false);
  assert.equal(plan.actions[0]?.dry_run_body?.copyRotation, false);
  assert.equal(plan.actions[0]?.dry_run_body?.copyFacingHandState, false);
  assert.equal(plan.actions[1]?.path, "/revit/assign-electrical-circuit");
  assert.deepEqual(plan.actions[1]?.depends_on, ["place:receptacle-a"]);
  assert.equal(plan.actions[1]?.deferred_body?.source_element_id, 333);
  const workflow = buildAtomicMepDraftWorkflowRequest(plan, { dry_run: false, maximum_created_elements: 2 });
  assert.equal(workflow.dryRun, false);
  assert.equal(workflow.maximumCreatedElements, 2);
});

test("electrical plan compiles an exact loaded family type onto an exact native host without a source exemplar", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "electrical-hosted-family-symbol-v1",
    scope_id: "level-4-room-404",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "404",
    observations: [{
      kind: "electrical_device",
      observation_id: "room404-west-receptacle",
      discipline: "electrical",
      role: "duplex receptacle",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "type", "host"],
      point: { x: 3, y: 4 },
      elevation_ft: 1.5,
      placement: {
        mode: "hosted_family_symbol",
        family_name: "Duplex Receptacle",
        type_name: "Standard",
        host_reference_key: "south-wall-host",
        host_category: "OST_Walls",
        room_side: "south"
      }
    }]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.equal(plan.actions[0]?.path, "/revit/place-family-instance-on-host");
  assert.deepEqual(plan.actions[0]?.dry_run_body, {
    familyName: "Duplex Receptacle",
    symbolName: "Standard",
    levelName: "L4",
    hostElementId: 222,
    pointXyz: [92, 206, 33.5],
    matchOrientationFromSource: false,
    copyRotation: false,
    copyFacingHandState: false,
    includePreviewImage: true,
    roomNumber: "404",
    roomSide: "south",
    dryRun: true
  });
  assert.equal(Object.hasOwn(plan.actions[0]?.dry_run_body ?? {}, "sourceElementId"), false);

  const missingHost = structuredClone(input);
  const missingObservation = missingHost.observations[0];
  if (!missingObservation || missingObservation.kind !== "electrical_device") throw new Error("test_setup_failed");
  const missingPlacement = missingObservation.placement;
  if (missingPlacement.mode !== "hosted_family_symbol") throw new Error("test_setup_failed");
  missingPlacement.host_reference_key = "missing-host";
  assert.throws(() => compileMepDraftPlan(missingHost), /host_reference_unknown/);

  const wrongCategory = structuredClone(input);
  const wrongCategoryObservation = wrongCategory.observations[0];
  if (!wrongCategoryObservation || wrongCategoryObservation.kind !== "electrical_device") throw new Error("test_setup_failed");
  const wrongCategoryPlacement = wrongCategoryObservation.placement;
  if (wrongCategoryPlacement.mode !== "hosted_family_symbol") throw new Error("test_setup_failed");
  wrongCategoryPlacement.host_category = "OST_Ceilings";
  assert.throws(() => compileMepDraftPlan(wrongCategory), /host_reference_category_mismatch/);
});

test("electrical device placement carries source-grounded non-membership instance parameters", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "electrical-gfi-parameters-v1",
    scope_id: "level-3-patient-toilet",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L3",
    level_elevation_ft: 32,
    room_number: "PT-101",
    observations: [{
      kind: "electrical_device",
      observation_id: "patient-toilet-gfi",
      discipline: "electrical",
      role: "GFI duplex receptacle",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "type", "host", "instance parameters"],
      attribute_provenance: [{
        attribute: "instance parameters",
        basis: "source_observation",
        reference: "The registered power plan prints GFI and +54 inches at the device."
      }],
      point: { x: 3, y: 4 },
      elevation_ft: 4.5,
      instance_parameters: {
        "Receptacle Label": "GFI",
        "Counter 54in": "1"
      },
      placement: {
        mode: "hosted_family_symbol",
        family_name: "262726_Receptacles",
        type_name: "Duplex Receptacle",
        host_reference_key: "south-wall-host",
        host_category: "OST_Walls",
        room_side: "top"
      }
    }]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions[0]?.dry_run_body?.parameterOverrides, {
    "Receptacle Label": "GFI",
    "Counter 54in": "1"
  });

  const missingEvidence = structuredClone(input);
  const missingEvidenceDevice = missingEvidence.observations[0];
  if (!missingEvidenceDevice || missingEvidenceDevice.kind !== "electrical_device") throw new Error("test_setup_failed");
  missingEvidenceDevice.attribute_provenance = [];
  assert.throws(() => compileMepDraftPlan(missingEvidence), /instance_parameters_require_source_or_directed_evidence/);

  const fakeCircuit = structuredClone(input);
  const fakeCircuitDevice = fakeCircuit.observations[0];
  if (!fakeCircuitDevice || fakeCircuitDevice.kind !== "electrical_device") throw new Error("test_setup_failed");
  fakeCircuitDevice.instance_parameters = { "Circuit Number": "47" };
  assert.throws(() => compileMepDraftPlan(fakeCircuit), /instance_parameter_cannot_assert_circuit_membership/);

  for (const alias of ["Branch Circuit", "CKT #", "Panel Name", "Panelboard", "Power-System", "Electrical_Data"]) {
    const aliasedCircuit = structuredClone(input);
    const aliasedDevice = aliasedCircuit.observations[0];
    if (!aliasedDevice || aliasedDevice.kind !== "electrical_device") throw new Error("test_setup_failed");
    aliasedDevice.instance_parameters = { [alias]: "A" };
    assert.throws(() => compileMepDraftPlan(aliasedCircuit), /instance_parameter_cannot_assert_circuit_membership/);
  }
});

test("electrical hosted symbol can resolve an exact wall inside an exact linked-model host", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "electrical-explicit-linked-wall-v1",
    scope_id: "bounded-linked-wall-device",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [
      ...nativeReferences(),
      {
        reference_key: "orientation-source",
        element_id: 112,
        category: "OST_ElectricalFixtures",
        role: "parallel-wall receptacle orientation precedent",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      },
      {
        reference_key: "power-view",
        element_id: 902,
        category: "OST_Views",
        role: "power plan annotation view",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      },
      {
        reference_key: "architectural-link",
        element_id: 900,
        category: "OST_RvtLinks",
        role: "loaded architectural link",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      },
      {
        reference_key: "linked-wall",
        element_id: 901,
        category: "OST_Walls",
        role: "exact wall inside architectural link",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      }
    ],
    registration: registration(),
    level_name: "L3",
    level_elevation_ft: 32,
    observations: [{
      kind: "electrical_device",
      observation_id: "linked-wall-receptacle",
      discipline: "electrical",
      role: "duplex receptacle",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "type", "host"],
      point: { x: 3, y: 4 },
      elevation_ft: 1.5,
      placement: {
        mode: "hosted_family_symbol",
        family_name: "Receptacle",
        type_name: "Duplex",
        metadata_source_reference_key: "receptacle-source",
        orientation_source_reference_key: "orientation-source",
        annotation_tags: [
          {
            view_reference_key: "power-view",
            family_name: "Receptacle Tag",
            type_name: "Condition Label",
            offset_x_ft: 0.5,
            offset_y_ft: 0.75,
            add_leader: false
          },
          {
            view_reference_key: "power-view",
            family_name: "Receptacle Tag",
            type_name: "Mounting Label",
            offset_x_ft: 0.5,
            offset_y_ft: 0.25,
            add_leader: false
          },
          {
            view_reference_key: "power-view",
            family_name: "Receptacle Tag",
            type_name: "Protection Label",
            offset_x_ft: 0.5,
            offset_y_ft: -0.25,
            add_leader: false
          },
          {
            view_reference_key: "power-view",
            family_name: "Receptacle Tag",
            type_name: "Circuit Label",
            offset_x_ft: 0,
            offset_y_ft: -0.75,
            add_leader: false
          }
        ],
        host_reference_key: "architectural-link",
        linked_host_reference_key: "linked-wall",
        host_category: "OST_RvtLinks"
      }
    }]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.equal(plan.actions[0]?.dry_run_body?.hostElementId, 900);
  assert.equal(plan.actions[0]?.dry_run_body?.linkedHostElementId, 901);
  assert.equal(plan.actions[0]?.dry_run_body?.sourceElementId, 111);
  assert.equal(plan.actions[0]?.dry_run_body?.orientationSourceElementId, 112);
  assert.equal(plan.actions[0]?.dry_run_body?.matchOrientationFromSource, true);
  assert.deepEqual(plan.actions[0]?.dry_run_body?.parameterNamesToCopy, ["Workset"]);
  const tagAction = plan.actions.find((entry) => entry.action_key === "tag:linked-wall-receptacle:1");
  assert.equal(tagAction?.path, "/revit/tag-elements");
  assert.deepEqual(tagAction?.depends_on, ["place:linked-wall-receptacle"]);
  assert.equal(tagAction?.apply_body?.viewId, 902);
  assert.equal(tagAction?.apply_body?.tagTypeName, "Condition Label");
  assert.deepEqual(tagAction?.deferred_body?.tag_element, { created_by_action: "place:linked-wall-receptacle", output: "created" });
  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.operations.filter((entry) => entry.path === "/revit/tag-elements").length, 4);
  assert.equal(workflow.maximumCreatedElements, 5);

  const wrongLinkedCategory = structuredClone(input);
  wrongLinkedCategory.native_element_references.find((entry) => entry.reference_key === "linked-wall")!.category = "OST_Ceilings";
  assert.throws(() => compileMepDraftPlan(wrongLinkedCategory), /linked_host_reference_category_mismatch/);

  const wrongMetadataCategory = structuredClone(input);
  wrongMetadataCategory.native_element_references.find((entry) => entry.reference_key === "receptacle-source")!.category = "OST_MechanicalEquipment";
  assert.throws(() => compileMepDraftPlan(wrongMetadataCategory), /metadata_source_reference_category_mismatch/);

  const wrongOrientationCategory = structuredClone(input);
  wrongOrientationCategory.native_element_references.find((entry) => entry.reference_key === "orientation-source")!.category = "OST_MechanicalEquipment";
  assert.throws(() => compileMepDraftPlan(wrongOrientationCategory), /orientation_source_reference_category_mismatch/);

  const wrongTagViewCategory = structuredClone(input);
  wrongTagViewCategory.native_element_references.find((entry) => entry.reference_key === "power-view")!.category = "OST_Walls";
  assert.throws(() => compileMepDraftPlan(wrongTagViewCategory), /annotation_tag_view_reference_category_mismatch/);

  const missingExactLinkedWall = structuredClone(input);
  const missingExactLinkedWallDevice = missingExactLinkedWall.observations[0];
  if (!missingExactLinkedWallDevice || missingExactLinkedWallDevice.kind !== "electrical_device"
    || missingExactLinkedWallDevice.placement.mode !== "hosted_family_symbol") throw new Error("test_setup_failed");
  delete missingExactLinkedWallDevice.placement.linked_host_reference_key;
  assert.throws(() => compileMepDraftPlan(missingExactLinkedWall), /revit_link_host_requires_exact_linked_wall_reference/);
});

test("electrical equipment retains its native category and can participate in a factual circuit", () => {
  const references = [
    ...nativeReferences(),
    {
      reference_key: "equipment-source",
      element_id: 444,
      category: "OST_ElectricalEquipment",
      role: "wall-mounted electrical equipment",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH,
      power_system_ids: ["system-333"]
    }
  ];
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-equipment-layout-v1",
    scope_id: "level-4-room-409-equipment",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: references,
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    room_number: "409",
    observations: [
      {
        kind: "electrical_equipment",
        observation_id: "equipment-a",
        discipline: "electrical",
        role: "electrical equipment",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type", "host"],
        point: { x: 3, y: 4 },
        elevation_ft: 4,
        placement: {
          mode: "hosted_exemplar",
          source_reference_key: "equipment-source",
          host_reference_key: "south-wall-host",
          host_category: "OST_Walls"
        }
      },
      {
        kind: "electrical_circuit",
        observation_id: "equipment-circuit",
        discipline: "electrical",
        evidence_role: "native_model_inventory",
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["circuit"],
        member_observation_ids: ["equipment-a"],
        source_reference_key: "equipment-source",
        expected_power_system_id: "system-333",
        membership_basis: "native_source_power_system",
        panel_circuit_label: "P409/6"
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.plan_elements[0]?.category, "OST_ElectricalEquipment");
  assert.equal(plan.actions[0]?.path, "/revit/place-family-instance-on-host");
  assert.deepEqual(plan.actions[1]?.depends_on, ["place:equipment-a"]);
});

test("a new circuit can target a panelboard created earlier in the same atomic graph", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-new-panel-circuit-v1",
    scope_id: "level-4-room-409-new-panel-circuit",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    room_number: "409",
    observations: [
      {
        kind: "electrical_equipment",
        observation_id: "panel-p409",
        discipline: "electrical",
        role: "panelboard P409",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "host"],
        point: { x: 2, y: 3 },
        elevation_ft: 4,
        placement: {
          mode: "hosted_exemplar",
          source_reference_key: "panel-source",
          host_reference_key: "south-wall-host",
          host_category: "OST_Walls",
          copy_distribution_system_from_source: true
        }
      },
      {
        kind: "electrical_device",
        observation_id: "receptacle-p409-1",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type"],
        point: { x: 4, y: 5 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family", family_name: "Receptacle", type_name: "Standard" }
      },
      {
        kind: "electrical_circuit",
        observation_id: "new-p409-1",
        discipline: "electrical",
        evidence_role: "source_pdf",
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["circuit"],
        member_observation_ids: ["receptacle-p409-1"],
        circuit_mode: "create_new_power_system",
        system_type: "PowerCircuit",
        membership_basis: "user_direction",
        user_direction_reference: "The bounded test directs one member to the new panel circuit.",
        panel_circuit_label: "P409/1",
        panel_observation_id: "panel-p409"
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "place:panel-p409",
    "place:receptacle-p409-1",
    "circuit:new-p409-1"
  ]);
  assert.deepEqual(plan.actions[2]?.depends_on, ["place:receptacle-p409-1", "place:panel-p409"]);
  assert.deepEqual(plan.actions[2]?.deferred_body?.element_ids, [{ created_by_action: "place:receptacle-p409-1" }]);
  assert.deepEqual(plan.actions[2]?.deferred_body?.panel_element, { created_by_action: "place:panel-p409" });
  assert.deepEqual(plan.actions[0]?.apply_body?.parameterNamesToCopy, ["Distribution System"]);
});

test("a new circuit can use a hash-bound existing native equipment member without duplicating it", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-existing-hru-circuit-v1",
    scope_id: "level-4-room-404-existing-hru-circuit",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    room_number: "404",
    observations: [
      {
        kind: "electrical_equipment",
        observation_id: "panel-p404",
        discipline: "electrical",
        role: "panelboard P404",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "host"],
        point: { x: 2, y: 3 },
        elevation_ft: 4,
        placement: {
          mode: "hosted_exemplar",
          source_reference_key: "panel-source",
          host_reference_key: "south-wall-host",
          host_category: "OST_Walls",
          copy_distribution_system_from_source: true
        }
      },
      {
        kind: "electrical_circuit",
        observation_id: "new-p404-12-14-16",
        discipline: "electrical",
        evidence_role: "source_pdf",
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["circuit"],
        member_observation_ids: [],
        native_member_reference_keys: ["hru-existing"],
        circuit_mode: "create_new_power_system",
        system_type: "PowerCircuit",
        membership_basis: "legible_source_circuit_label",
        panel_circuit_label: "P404/12,14,16",
        panel_observation_id: "panel-p404",
        member_label_evidence: [],
        native_member_label_evidence: [{
          native_member_reference_key: "hru-existing",
          evidence_role: "source_pdf",
          reference: "The source leader terminates at the existing HRU power connection.",
          label: "P404/12,14,16"
        }]
      }
    ]
  });

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions[1]?.depends_on, ["place:panel-p404"]);
  assert.deepEqual(plan.actions[1]?.deferred_body?.element_ids, []);
  assert.deepEqual(plan.actions[1]?.deferred_body?.existing_element_ids, [555]);
  assert.deepEqual(plan.actions[1]?.deferred_body?.panel_element, { created_by_action: "place:panel-p404" });
});

test("a created panel circuit rejects missing distribution precedent and self-membership", () => {
  const base: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "electrical-invalid-new-panel-circuit-v1",
    scope_id: "level-4-room-409-invalid-new-panel-circuit",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "electrical_equipment",
        observation_id: "panel-p409",
        discipline: "electrical",
        role: "panelboard P409",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "host"],
        point: { x: 2, y: 3 },
        elevation_ft: 4,
        placement: { mode: "unhosted_family", family_name: "Panelboard", type_name: "P409 Type" }
      },
      {
        kind: "electrical_device",
        observation_id: "receptacle-p409-1",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type"],
        point: { x: 4, y: 5 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family", family_name: "Receptacle", type_name: "Standard" }
      },
      {
        kind: "electrical_circuit",
        observation_id: "new-p409-1",
        discipline: "electrical",
        evidence_role: "source_pdf",
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["circuit"],
        member_observation_ids: ["receptacle-p409-1"],
        circuit_mode: "create_new_power_system",
        system_type: "PowerCircuit",
        membership_basis: "user_direction",
        user_direction_reference: "bounded invalid-case test",
        panel_circuit_label: "P409/1",
        panel_observation_id: "panel-p409"
      }
    ]
  };
  assert.throws(() => compileMepDraftPlan(base), /created_panel_requires_native_distribution_system_precedent/);
  const circuit = base.observations[2];
  const panel = base.observations[0];
  if (circuit?.kind !== "electrical_circuit" || circuit.circuit_mode !== "create_new_power_system"
    || panel?.kind !== "electrical_equipment") throw new Error("invalid_panel_test_setup_failed");
  panel.placement = {
    mode: "hosted_family_symbol",
    family_name: "Lighting and Appliance Panelboard - 208V MCB",
    type_name: "100 A",
    host_reference_key: "south-wall-host",
    host_category: "OST_Walls",
    ensure_distribution_system: {
      name: "120/208 Wye",
      electrical_phase: "ThreePhase",
      phase_configuration: "Wye",
      num_wires: 4,
      voltage_line_to_line: { name: "208", actual_value: 208, min_value: 200, max_value: 220 },
      voltage_line_to_ground: { name: "120", actual_value: 120, min_value: 110, max_value: 130 }
    }
  };
  panel.panel_name = "P409";
  panel.supported_attributes.push("panel name");
  panel.attribute_provenance = [
    ...(panel.attribute_provenance ?? []),
    { attribute: "panel name", basis: "source_observation", reference: "legible P409 panel tag" }
  ];
  const validPlan = compileMepDraftPlan(base);
  const panelAction = validPlan.actions.find((entry) => entry.action_key === "place:panel-p409");
  const circuitAction = validPlan.actions.find((entry) => entry.action_key === "circuit:new-p409-1");
  assert.deepEqual(panelAction?.apply_body?.ensureDistributionSystem, {
    name: "120/208 Wye",
    electricalPhase: "ThreePhase",
    phaseConfiguration: "Wye",
    numWires: 4,
    voltageLineToLine: { name: "208", actualValue: 208, minValue: 200, maxValue: 220 },
    voltageLineToGround: { name: "120", actualValue: 120, minValue: 110, maxValue: 130 }
  });
  assert.deepEqual(panelAction?.apply_body?.parameterOverrides, { "Panel Name": "P409" });
  assert.deepEqual(circuitAction?.depends_on, ["place:receptacle-p409-1", "place:panel-p409"]);
  assert.deepEqual(circuitAction?.deferred_body?.panel_element, { created_by_action: "place:panel-p409" });
  circuit.member_observation_ids = ["panel-p409"];
  assert.throws(() => compileMepDraftPlan(base), /panel_observation_cannot_be_circuit_member/);
});

test("electrical plan creates a new native power circuit without a retained circuit member", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-new-circuit-v1",
    scope_id: "level-4-room-403-new-circuit",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    room_number: "403",
    observations: [
      {
        kind: "electrical_device",
        observation_id: "receptacle-new-a",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: ["location", "type"],
        point: { x: 3, y: 4 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family", family_name: "Receptacle A", type_name: "Duplex B" }
      },
      {
        kind: "electrical_device",
        observation_id: "receptacle-new-b",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.93,
        supported_attributes: ["location", "type"],
        point: { x: 4, y: 4 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family", family_name: "Receptacle A", type_name: "Duplex B" }
      },
      {
        kind: "electrical_circuit",
        observation_id: "new-circuit-p403-8",
        discipline: "electrical",
        evidence_role: "native_model_inventory",
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["circuit"],
        member_observation_ids: ["receptacle-new-a", "receptacle-new-b"],
        circuit_mode: "create_new_power_system",
        system_type: "PowerCircuit",
        membership_basis: "user_direction",
        user_direction_reference: "User directed these two new devices to one new circuit.",
        panel_circuit_label: "P403/8"
      }
    ]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "place:receptacle-new-a",
    "place:receptacle-new-b",
    "circuit:new-circuit-p403-8"
  ]);
  const circuit = plan.actions[2]!;
  assert.equal(circuit.path, "/revit/assign-electrical-circuit");
  assert.deepEqual(circuit.depends_on, ["place:receptacle-new-a", "place:receptacle-new-b"]);
  assert.equal(circuit.deferred_body?.source_element_id, undefined);
  assert.equal(circuit.deferred_body?.create_system_type, "PowerCircuit");
  assert.equal(circuit.expected_created_min, 1);
  assert.equal(circuit.expected_created_max, 1);
  const workflow = buildAtomicMepDraftWorkflowRequest(plan, { maximum_created_elements: 3 });
  assert.equal(workflow.operations[2]?.deferred_body?.create_system_type, "PowerCircuit");
});

test("new source-labeled circuit requires matching legible evidence for every member", () => {
  const input = {
    schema_version: 1 as const,
    fixture_id: "electrical-label-evidence-v1",
    scope_id: "label-evidence-scope",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "electrical_device" as const,
        observation_id: "labeled-receptacle-a",
        discipline: "electrical" as const,
        role: "duplex receptacle",
        visibility: "clear" as const,
        confidence: 0.94,
        supported_attributes: ["location", "type"],
        point: { x: 3, y: 4 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family" as const, family_name: "Receptacle A", type_name: "Duplex B" }
      },
      {
        kind: "electrical_circuit" as const,
        observation_id: "labeled-new-circuit",
        discipline: "electrical" as const,
        evidence_role: "source_pdf",
        visibility: "clear" as const,
        confidence: 0.98,
        supported_attributes: ["circuit"],
        member_observation_ids: ["labeled-receptacle-a"],
        circuit_mode: "create_new_power_system" as const,
        system_type: "PowerCircuit" as const,
        membership_basis: "legible_source_circuit_label" as const,
        panel_circuit_label: "P403/8",
        member_label_evidence: [{
          member_observation_id: "labeled-receptacle-a",
          evidence_role: "source_pdf",
          reference: "Label adjacent to the receptacle symbol",
          label: "P403/6"
        }]
      }
    ]
  };
  assert.throws(() => compileMepDraftPlan(input), /member_label_evidence_label_mismatch/);
});

test("hosted registered placement may use its world point without an invented chainage", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-world-point-host-v1",
    scope_id: "level-4-room-403-point-authority",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "403",
    observations: [{
      kind: "electrical_device",
      observation_id: "receptacle-from-registered-pixel",
      discipline: "electrical",
      role: "GFCI duplex receptacle",
      visibility: "clear",
      confidence: 0.94,
      supported_attributes: ["location", "type", "host"],
      point: { x: 3, y: 4 },
      elevation_ft: 4,
      placement: {
        mode: "hosted_exemplar",
        source_reference_key: "receptacle-source",
        host_reference_key: "south-wall-host",
        host_category: "OST_Walls",
        match_orientation_from_source: true
      }
    }]
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions[0]?.dry_run_body?.pointXyz, [92, 206, 36]);
  assert.equal(Object.hasOwn(plan.actions[0]?.dry_run_body ?? {}, "targetChainageFt"), false);
});

test("partial evidence or unsupported material attributes consolidates clarification and emits no writes", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "plumbing-ambiguous-v1",
    scope_id: "bounded-region",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [{
      kind: "pipe_route",
      observation_id: "sanitary-occluded",
      discipline: "plumbing",
      service: "sanitary",
      visibility: "partial",
      confidence: 0.8,
      supported_attributes: ["location", "system"],
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      pipe_size: "2 inch",
      pipe_type: "PVC-DWV",
      system_type: "Sanitary",
      elevation_ft: 7
    }]
  };
  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "clarification_required");
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(plan.ambiguities[0]?.material_attributes, ["size", "elevation", "type"]);
  assert.throws(() => buildAtomicMepDraftWorkflowRequest(plan), /not_ready/);
});

test("explicit iterative drafting promotes independent geometry and defers ambiguous observations without benchmark credit", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "plumbing-partial-promotion-v1",
    scope_id: "bounded-region",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [
      {
        kind: "pipe_route",
        observation_id: "cold-water-clear",
        discipline: "plumbing",
        service: "domestic_cold_water",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
        pipe_size: "1 inch",
        pipe_type: "Copper",
        system_type: "Domestic Cold Water",
        elevation_ft: 9
      },
      {
        kind: "pipe_route",
        observation_id: "sanitary-occluded",
        discipline: "plumbing",
        service: "sanitary",
        visibility: "partial",
        confidence: 0.8,
        supported_attributes: ["location", "system"],
        points: [{ x: 0, y: 2 }, { x: 4, y: 2 }],
        pipe_size: "2 inch",
        pipe_type: "PVC-DWV",
        system_type: "Sanitary",
        elevation_ft: 7
      }
    ]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.promoted_observation_ids, ["cold-water-clear"]);
  assert.deepEqual(plan.deferred_observation_ids, ["sanitary-occluded"]);
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), ["route:cold-water-clear"]);
  assert.deepEqual(plan.ambiguities[0]?.material_attributes, ["size", "elevation", "type"]);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.deepEqual(workflow.operations.map((entry) => entry.action_key), ["route:cold-water-clear"]);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
});

test("partial promotion prunes clear actions whose created-host dependency is ambiguous", () => {
  const input = createdRouteHostedTerminalPackage();
  input.partial_promotion_policy = "defer_ambiguous_observations";
  const route = input.observations[0];
  if (route?.kind !== "duct_route") assert.fail("duct fixture invalid");
  route.supported_attributes = ["location", "elevation", "system", "type"];

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "clarification_required");
  assert.deepEqual(plan.promoted_observation_ids, []);
  assert.deepEqual(plan.deferred_observation_ids, ["supply-trunk-visible-1", "supply-grille-visible-1"]);
  assert.deepEqual(plan.actions, []);
  assert.match(plan.warnings.join("\n"), /depends on unresolved evidence: supply-grille-visible-1/);
  assert.throws(() => buildAtomicMepDraftWorkflowRequest(plan), /not_ready/);
});

test("partial promotion policy rejects unknown runtime values", () => {
  const input = createdRouteHostedTerminalPackage() as unknown as Record<string, unknown>;
  input.partial_promotion_policy = "best_effort_without_receipts";
  assert.throws(() => compileMepDraftPlan(input as MepDraftPackage), /partial_promotion_policy_invalid/);
});

test("plumbing service boundaries block an incomplete fixture cluster without hard-coding fixture roles", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "plumbing-service-boundary-v1",
    scope_id: "bounded-region",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "pipe_route",
        observation_id: "cold-only",
        discipline: "plumbing",
        service: "domestic_cold_water",
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        points: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
        pipe_size: "1/2 inch",
        pipe_type: "Copper",
        system_type: "Domestic Cold Water",
        elevation_ft: 9
      },
      {
        kind: "plumbing_fixture",
        observation_id: "fixture-a",
        discipline: "plumbing",
        role: "source-defined fixture",
        representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "Fixture", "Type A"),
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["location", "type", "service_topology"],
        point: { x: 0, y: 0 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Fixture", type_name: "Type A" },
        service_route_connections: [{ route_observation_id: "cold-only", route_endpoint: "start" }],
        service_boundary: {
          basis: "source_observation",
          evidence_role: "source_pdf",
          required_services: ["domestic_cold_water", "sanitary"],
          prohibited_services: ["domestic_hot_water"]
        }
      }
    ]
  };
  assert.throws(() => compileMepDraftPlan(input), /missing_required_services:sanitary/);
});

test("electrical circuit plans reject stale or caller-asserted source membership", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "electrical-native-membership-v1",
    scope_id: "bounded-region",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [{
      reference_key: "source-device",
      element_id: 700,
      category: "OST_ElectricalFixtures",
      role: "circuit exemplar",
      evidence_role: "native_model_inventory",
      evidence_sha256: MODEL_HASH,
      power_system_ids: ["system-real"]
    }],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "electrical_device",
        observation_id: "new-device",
        discipline: "electrical",
        role: "receptacle",
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["location", "type"],
        point: { x: 1, y: 1 },
        elevation_ft: 1.5,
        placement: { mode: "unhosted_family", family_name: "Receptacle", type_name: "Standard" }
      },
      {
        kind: "electrical_circuit",
        observation_id: "circuit-claim",
        discipline: "electrical",
        evidence_role: "native_model_inventory",
        visibility: "clear",
        confidence: 1,
        supported_attributes: ["circuit"],
        member_observation_ids: ["new-device"],
        source_reference_key: "source-device",
        expected_power_system_id: "system-from-label-only",
        membership_basis: "native_source_power_system",
        panel_circuit_label: "P403/6"
      }
    ]
  };
  assert.throws(() => compileMepDraftPlan(input), /source_power_system_not_exactly_verified/);
  input.native_element_references[0]!.evidence_sha256 = "c".repeat(64);
  assert.throws(() => compileMepDraftPlan(input), /native_evidence_hash_mismatch/);
});

test("bad registration blocks every discipline action", () => {
  const plan = compileMepDraftPlan({
    schema_version: 1,
    fixture_id: "electrical-bad-registration-v1",
    scope_id: "bounded-region",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: {
      source_evidence_sha256: SOURCE_HASH,
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
        { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
        { source: { x: 0, y: 10 }, model: { x: 100, y: 100 } }
      ],
      max_rms_error_ft: 0.01
    },
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [{
      kind: "electrical_device",
      observation_id: "device-1",
      discipline: "electrical",
      role: "receptacle",
      visibility: "clear",
      confidence: 1,
      supported_attributes: ["location", "type"],
      point: { x: 1, y: 1 },
      elevation_ft: 1.5,
      placement: { mode: "unhosted_family", family_name: "Duplex Receptacle", type_name: "Standard" }
    }]
  });
  assert.equal(plan.status, "blocked");
  assert.equal(plan.actions.length, 0);
  assert.match(plan.blockers[0] ?? "", /registration_error_exceeds_limit/);
});

test("identity perturbation changes only plan identities, not transformed geometry or tool routes", () => {
  const base: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "anti-overfit-a",
    scope_id: "region-a",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "L4",
    level_elevation_ft: 0,
    observations: [{
      kind: "electrical_device",
      observation_id: "device-a",
      discipline: "electrical",
      role: "receptacle",
      visibility: "clear",
      confidence: 1,
      supported_attributes: ["location", "type"],
      point: { x: 2, y: 5 },
      elevation_ft: 1.5,
      placement: { mode: "unhosted_family", family_name: "Family A", type_name: "Type A" }
    }]
  };
  const first = compileMepDraftPlan(base);
  const second = compileMepDraftPlan({
    ...base,
    fixture_id: "anti-overfit-b",
    scope_id: "region-b",
    observations: [{ ...base.observations[0]!, observation_id: "randomized-77" }]
  });
  assert.equal(first.actions[0]?.path, second.actions[0]?.path);
  assert.deepEqual(first.actions[0]?.expected_model_point, second.actions[0]?.expected_model_point);
  assert.notEqual(first.actions[0]?.action_key, second.actions[0]?.action_key);
});

test("plumbing topology must be a source-supported material attribute", () => {
  const input = plumbingTopologyPackage();
  const fixture = input.observations[1];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  fixture.supported_attributes = ["location", "type"];
  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "clarification_required");
  assert.equal(plan.actions.length, 0);
  assert.deepEqual(plan.ambiguities[0]?.material_attributes, ["service topology"]);
});

test("plumbing topology rejects two fixtures claiming one physical route endpoint", () => {
  const input = plumbingTopologyPackage();
  const fixture = input.observations[1];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  input.observations.push({
    ...fixture,
    observation_id: "fixture-random-93",
    point: { x: 0.25, y: 0.25 }
  });
  assert.throws(() => compileMepDraftPlan(input), /pipe_route_endpoint_claimed_multiple_times/);
});

test("plumbing holdout changes geometry origin without changing the topology tool graph", () => {
  const first = compileMepDraftPlan(plumbingTopologyPackage());
  const shiftedInput = plumbingTopologyPackage();
  shiftedInput.fixture_id = "independent-plumbing-topology-v2";
  shiftedInput.scope_id = "unseen-restroom-zeta";
  shiftedInput.registration = {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 500, y: -100 } },
      { source: { x: 10, y: 0 }, model: { x: 500, y: -80 } },
      { source: { x: 0, y: 10 }, model: { x: 480, y: -100 } }
    ],
    max_rms_error_ft: 0.01
  };
  const shifted = compileMepDraftPlan(shiftedInput);
  assert.deepEqual(first.actions.map((entry) => entry.path), shifted.actions.map((entry) => entry.path));
  assert.notDeepEqual(first.actions[0]?.apply_body?.points, shifted.actions[0]?.apply_body?.points);
  assert.notEqual(first.input_fingerprint_sha256, shifted.input_fingerprint_sha256);
});

test("host and circuit topology reject wrong categories and multi-circuit membership", () => {
  const hosted: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "independent-electrical-host-v1",
    scope_id: "unseen-office-beta",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 0,
    observations: [
      {
        kind: "electrical_device",
        observation_id: "device-random-44",
        discipline: "electrical",
        role: "duplex receptacle",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type", "host"],
        point: { x: 3, y: 2 },
        elevation_ft: 1.5,
        placement: {
          mode: "hosted_exemplar",
          source_reference_key: "receptacle-source",
          host_reference_key: "south-wall-host",
          host_category: "OST_Ceilings",
          target_chainage_ft: 3.5
        }
      }
    ]
  };
  assert.throws(() => compileMepDraftPlan(hosted), /host_reference_category_mismatch/);

  const device = hosted.observations[0];
  if (device?.kind !== "electrical_device" || device.placement.mode !== "hosted_exemplar") throw new Error("device_setup_failed");
  device.placement.host_category = "OST_Walls";
  hosted.observations.push(
    {
      kind: "electrical_circuit",
      observation_id: "circuit-random-11",
      discipline: "electrical",
      evidence_role: "native_model_inventory",
      visibility: "clear",
      confidence: 1,
      supported_attributes: ["circuit"],
      member_observation_ids: [device.observation_id],
      source_reference_key: "circuit-source",
      expected_power_system_id: "system-333",
      membership_basis: "native_source_power_system"
    },
    {
      kind: "electrical_circuit",
      observation_id: "circuit-random-92",
      discipline: "electrical",
      evidence_role: "native_model_inventory",
      visibility: "clear",
      confidence: 1,
      supported_attributes: ["circuit"],
      member_observation_ids: [device.observation_id],
      source_reference_key: "circuit-source",
      expected_power_system_id: "system-333",
      membership_basis: "native_source_power_system"
    }
  );
  assert.throws(() => compileMepDraftPlan(hosted), /electrical_device_assigned_to_multiple_circuits/);
});

function concealedLavatoryClusterPackage(): MepDraftPackage {
  const bridge = (
    observation_id: string,
    service: "domestic_cold_water" | "domestic_hot_water" | "sanitary",
    target_reference_key: string,
    pipe_size: string,
    pipe_type: string,
    system_type: string
  ): MepDraftPackage["observations"][number] => ({
    kind: "pipe_route",
    observation_id,
    discipline: "plumbing",
    service,
    geometry_mode: "native_connector_bridge",
    source_fixture_observation_id: "fixture-visible-31",
    target_reference_key,
    maximum_length_ft: 2,
    visibility: "occluded",
    confidence: 0.98,
    evidence_role: "native_model_inventory",
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_provenance: [
      { attribute: "location", basis: "native_model_precedent", reference: `runtime connector pair ${target_reference_key}` },
      { attribute: "elevation", basis: "native_model_precedent", reference: `runtime connector pair ${target_reference_key}` },
      { attribute: "size", basis: "native_model_precedent", reference: `open connector ${target_reference_key}` },
      { attribute: "system", basis: "native_model_precedent", reference: `open connector ${target_reference_key}` },
      { attribute: "type", basis: "native_model_precedent", reference: "project pipe-type precedent" }
    ],
    pipe_size,
    pipe_type,
    system_type
  });
  return {
    schema_version: 1,
    fixture_id: "concealed-lavatory-cluster-v1",
    scope_id: "unseen-unit-lavatory-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [
      { reference_key: "anchor-cold-947", element_id: 947, category: "OST_PipeFitting", role: "open cold-water anchor", evidence_role: "native_model_inventory", evidence_sha256: MODEL_HASH },
      { reference_key: "anchor-hot-632", element_id: 632, category: "OST_PipeFitting", role: "open hot-water anchor", evidence_role: "native_model_inventory", evidence_sha256: MODEL_HASH },
      { reference_key: "anchor-sanitary-418", element_id: 418, category: "OST_PipeFitting", role: "open sanitary anchor", evidence_role: "native_model_inventory", evidence_sha256: MODEL_HASH }
    ],
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 20,
    observations: [
      bridge("bridge-cold-17", "domestic_cold_water", "anchor-cold-947", "1/2 inch", "Copper", "Domestic Cold Water"),
      bridge("bridge-hot-53", "domestic_hot_water", "anchor-hot-632", "1/2 inch", "Copper", "Domestic Hot Water"),
      bridge("bridge-sanitary-88", "sanitary", "anchor-sanitary-418", "2 inch", "PVC - DWV", "Sanitary"),
      {
        kind: "plumbing_fixture",
        observation_id: "fixture-visible-31",
        discipline: "plumbing",
        role: "lavatory",
        representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "Fixture Connections", "Vanity"),
        visibility: "clear",
        confidence: 0.99,
        supported_attributes: ["location", "type", "service_topology"],
        point: { x: 2, y: 3 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Fixture Connections", type_name: "Vanity", rotation_degrees: -90 },
        service_route_connections: [
          { route_observation_id: "bridge-cold-17", route_endpoint: "native_source" },
          { route_observation_id: "bridge-hot-53", route_endpoint: "native_source" },
          { route_observation_id: "bridge-sanitary-88", route_endpoint: "native_source" }
        ],
        service_boundary: {
          basis: "native_model_precedent",
          evidence_role: "native_model_inventory",
          required_services: ["domestic_cold_water", "domestic_hot_water", "sanitary"],
          prohibited_services: ["vent"]
        }
      }
    ]
  };
}

test("concealed plumbing fixture cluster resolves hidden offsets only through explicit native connector bridges", () => {
  const plan = compileMepDraftPlan(concealedLavatoryClusterPackage());
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.path), [
    "/revit/place-families",
    "/revit/create-pipe-between-connectors",
    "/revit/create-pipe-between-connectors",
    "/revit/create-pipe-between-connectors"
  ]);
  assert.deepEqual(plan.actions.slice(1).map((entry) => entry.depends_on), [
    ["place:fixture-visible-31"],
    ["place:fixture-visible-31"],
    ["place:fixture-visible-31"]
  ]);
  assert.deepEqual(plan.actions.slice(1).map((entry) => entry.deferred_body?.target_element_id), [947, 632, 418]);
  assert.equal(plan.actions.some((entry) => entry.path === "/revit/connect-mep-elements"), false);
  assert.equal(plan.plan_elements.filter((entry) => entry.plan_key.startsWith("bridge-")).every((entry) =>
    entry.assumptions.some((value) => /not observed in the source plan/.test(value))), true);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.dryRun, true);
  assert.deepEqual(workflow.operations.map((entry) => entry.action_key), [
    "place:fixture-visible-31",
    "route:bridge-cold-17",
    "route:bridge-hot-53",
    "route:bridge-sanitary-88"
  ]);
  assert.equal(workflow.operations[1]?.apply_body?.service, "domestic_cold_water");
  assert.equal(workflow.operations[1]?.deferred_body?.source_element?.created_by_action, "place:fixture-visible-31");
});

test("connector bridges reject hidden geometry claims without native provenance or an exact anchor", () => {
  const missingProvenance = concealedLavatoryClusterPackage();
  const route = missingProvenance.observations[0];
  if (route?.kind !== "pipe_route" || route.geometry_mode !== "native_connector_bridge") throw new Error("route_setup_failed");
  route.attribute_provenance = route.attribute_provenance?.filter((entry) => entry.attribute !== "elevation");
  assert.throws(() => compileMepDraftPlan(missingProvenance), /elevation_must_be_native_model_precedent/);

  const unknownAnchor = concealedLavatoryClusterPackage();
  const secondRoute = unknownAnchor.observations[0];
  if (secondRoute?.kind !== "pipe_route" || secondRoute.geometry_mode !== "native_connector_bridge") throw new Error("route_setup_failed");
  secondRoute.target_reference_key = "not-in-inventory";
  assert.throws(() => compileMepDraftPlan(unknownAnchor), /target_reference_unknown/);
});

test("created-route connector bridge composes a placed fixture with a source-grounded route endpoint", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "created-route-fixture-bridge-v1",
    scope_id: "unseen-lavatory-beta",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [],
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 20,
    observations: [
      {
        kind: "pipe_route",
        observation_id: "cold-route-visible-71",
        discipline: "plumbing",
        service: "domestic_cold_water",
        geometry_mode: "source_points",
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        elevation_ft: 9,
        visibility: "clear",
        confidence: 0.98,
        evidence_role: "source_pdf",
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "size", basis: "native_model_precedent", reference: "native fixture connector size" },
          { attribute: "elevation", basis: "declared_heuristic", reference: "plan does not show pipe elevation" },
          { attribute: "system", basis: "source_observation", reference: "cold-water line convention" },
          { attribute: "type", basis: "native_model_precedent", reference: "project pipe type" }
        ],
        pipe_size: "1/2 inch",
        pipe_type: "Default",
        system_type: "Domestic Cold Water"
      },
      {
        kind: "pipe_route",
        observation_id: "cold-concealed-stub-83",
        discipline: "plumbing",
        service: "domestic_cold_water",
        geometry_mode: "created_route_connector_bridge",
        source_fixture_observation_id: "lavatory-visible-29",
        target_route_observation_id: "cold-route-visible-71",
        target_route_endpoint: "end",
        maximum_length_ft: 3,
        visibility: "occluded",
        confidence: 0.98,
        evidence_role: "native_model_inventory",
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "location", basis: "native_model_precedent", reference: "runtime fixture and created-route connectors" },
          { attribute: "size", basis: "native_model_precedent", reference: "matching native connectors" },
          { attribute: "elevation", basis: "native_model_precedent", reference: "runtime connector elevations" },
          { attribute: "system", basis: "native_model_precedent", reference: "native Domestic Cold Water connectors" },
          { attribute: "type", basis: "native_model_precedent", reference: "project pipe type" }
        ],
        pipe_size: "1/2 inch",
        pipe_type: "Default",
        system_type: "Domestic Cold Water"
      },
      {
        kind: "plumbing_fixture",
        observation_id: "lavatory-visible-29",
        discipline: "plumbing",
        role: "lavatory",
        representation_classification: fixtureRepresentationClassification("architectural_fixture", "architectural_fixture", "Sink Vanity-Round", "19\" x 19\""),
        visibility: "clear",
        confidence: 0.99,
        evidence_role: "source_pdf",
        supported_attributes: ["location", "type", "service topology"],
        point: { x: 10, y: 2 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Sink Vanity-Round", type_name: "19\" x 19\"" },
        service_route_connections: [{ route_observation_id: "cold-concealed-stub-83", route_endpoint: "native_source" }],
        service_boundary: {
          basis: "native_model_precedent",
          evidence_role: "native_model_inventory",
          required_services: ["domestic_cold_water"],
          prohibited_services: ["domestic_hot_water"]
        }
      }
    ]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families",
    "/revit/create-pipe-between-connectors"
  ]);
  assert.deepEqual(plan.actions[2]?.depends_on, ["place:lavatory-visible-29", "route:cold-route-visible-71"]);
  assert.deepEqual(plan.actions[2]?.deferred_body?.target_element, {
    created_by_action: "route:cold-route-visible-71",
    output: "route_end"
  });
  assert.equal(plan.actions.some((entry) => entry.path === "/revit/connect-mep-elements"), false);

  const mismatch = structuredClone(input);
  const bridge = mismatch.observations[1];
  if (bridge?.kind !== "pipe_route" || bridge.geometry_mode !== "created_route_connector_bridge") throw new Error("bridge_setup_failed");
  bridge.pipe_size = "3/4 inch";
  assert.throws(() => compileMepDraftPlan(mismatch), /target_route_service_size_type_mismatch/);
});

function downstreamVentPackage(): MepDraftPackage {
  return {
    schema_version: 1,
    fixture_id: "downstream-vent-tee-independent-v1",
    scope_id: "unseen-restroom-vent-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [
      { reference_key: "sanitary-main-random-41", element_id: 941, category: "OST_PipeCurves", role: "retained sanitary main", evidence_role: "native_model_inventory", evidence_sha256: MODEL_HASH },
      { reference_key: "fixture-random-73", element_id: 873, category: "OST_PlumbingFixtures", role: "water closet served downstream", evidence_role: "native_model_inventory", evidence_sha256: MODEL_HASH }
    ],
    registration: registration(),
    level_name: "Benchmark L2",
    level_elevation_ft: 20,
    observations: [
      {
        kind: "pipe_route",
        observation_id: "vent-tee-random-59",
        discipline: "plumbing",
        service: "vent",
        geometry_mode: "downstream_vent_tee",
        main_reference_key: "sanitary-main-random-41",
        verification_fixture_reference_keys: ["fixture-random-73"],
        points: [{ x: 2, y: 3 }, { x: 5, y: 3 }],
        main_elevation_ft: 1.1666666667,
        elevation_ft: 5.1666666667,
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "size", "main_elevation", "elevation", "system", "type"],
        attribute_provenance: [
          { attribute: "location", basis: "source_observation", reference: "registered plan branch path" },
          { attribute: "size", basis: "native_model_precedent", reference: "project vent sizing precedent" },
          { attribute: "main_elevation", basis: "native_model_precedent", reference: "retained sanitary main centerline" },
          { attribute: "elevation", basis: "declared_heuristic", reference: "typical downstream vent rise above ceiling" },
          { attribute: "system", basis: "user_direction", reference: "downstream vent continuation" },
          { attribute: "type", basis: "native_model_precedent", reference: "project DWV pipe type" }
        ],
        pipe_size: "2 inch",
        pipe_type: "PVC - DWV",
        system_type: "Vent"
      }
    ]
  };
}

test("downstream vent tee compiles a native branch plus mandatory exact-fixture reachability audit", () => {
  const plan = compileMepDraftPlan(downstreamVentPackage());
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.path), [
    "/revit/connect-mep-branch",
    "/revit/audit-plumbing-fixture-services"
  ]);
  const branch = plan.actions[0]!;
  assert.equal(branch.apply_body?.mainElementId, 941);
  assert.equal(branch.apply_body?.connectionMode, "tee");
  assert.equal(branch.apply_body?.branchSystemType, "Vent");
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 94, y: 204, z: 21.1666666667 },
    { x: 94, y: 210, z: 25.1666666667 }
  ]);
  const audit = plan.actions[1]!;
  assert.deepEqual(audit.depends_on, ["route:vent-tee-random-59"]);
  assert.deepEqual(audit.deferred_body?.fixture_element_ids, [873]);
  assert.equal(audit.deferred_body?.require_downstream_vent, true);
  assert.equal(plan.plan_elements[0]?.assumptions.some((entry) => /no direct fixture Vent connector/i.test(entry)), true);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.deepEqual(workflow.operations.map((entry) => entry.action_key), [
    "route:vent-tee-random-59",
    "verify:vent:vent-tee-random-59"
  ]);
});

test("downstream vent tee rejects direct fixture service wiring and ungrounded main elevation", () => {
  const direct = downstreamVentPackage();
  direct.observations.push({
    kind: "plumbing_fixture",
    observation_id: "fixture-visible-random-12",
    discipline: "plumbing",
    role: "water closet",
    representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "Fixture Connections", "Water Closet"),
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "type", "service_topology"],
    point: { x: 1, y: 1 },
    elevation_ft: 0,
    placement: { mode: "unhosted_family", family_name: "Fixture Connections", type_name: "Water Closet" },
    service_route_connections: [{ route_observation_id: "vent-tee-random-59", route_endpoint: "start" }],
    service_boundary: {
      basis: "native_model_precedent",
      evidence_role: "native_model_inventory",
      required_services: ["vent"],
      prohibited_services: []
    }
  });
  assert.throws(() => compileMepDraftPlan(direct), /downstream_vent_cannot_be_direct_fixture_connection/);

  const ungrounded = downstreamVentPackage();
  const route = ungrounded.observations[0];
  if (route?.kind !== "pipe_route" || route.geometry_mode !== "downstream_vent_tee") throw new Error("route_setup_failed");
  route.attribute_provenance = route.attribute_provenance?.map((entry) => entry.attribute === "main_elevation"
    ? { ...entry, basis: "declared_heuristic" as const }
    : entry);
  assert.throws(() => compileMepDraftPlan(ungrounded), /declared_heuristic_only_allowed_for_route_elevation|main_elevation_must_be_native_model_precedent/);
});

function plannedMainDownstreamVentPackage(): MepDraftPackage {
  const input = downstreamVentPackage();
  input.fixture_id = "planned-sanitary-main-downstream-vent-v1";
  input.native_element_references = input.native_element_references.filter((entry) => entry.reference_key !== "sanitary-main-random-41");
  const vent = input.observations[0];
  if (vent?.kind !== "pipe_route" || vent.geometry_mode !== "downstream_vent_tee") throw new Error("vent_setup_failed");
  const plannedVent = vent as unknown as Record<string, unknown>;
  delete plannedVent.main_reference_key;
  delete plannedVent.main_elevation_ft;
  plannedVent.main_route_observation_id = "sanitary-route-visible-22";
  vent.supported_attributes = vent.supported_attributes.filter((attribute) => attribute !== "main_elevation");
  vent.attribute_provenance = vent.attribute_provenance?.filter((entry) => entry.attribute !== "main_elevation");
  input.observations.unshift({
    kind: "pipe_route",
    observation_id: "sanitary-route-visible-22",
    discipline: "plumbing",
    service: "sanitary",
    geometry_mode: "source_points",
    points: [{ x: 0, y: 3 }, { x: 4, y: 3 }, { x: 8, y: 3 }],
    elevation_ft: 1.1666666667,
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_provenance: [
      { attribute: "location", basis: "source_observation", reference: "registered sanitary route centerline" },
      { attribute: "size", basis: "source_observation", reference: "sanitary size label" },
      { attribute: "elevation", basis: "declared_heuristic", reference: "plan does not show sanitary Z" },
      { attribute: "system", basis: "source_observation", reference: "sanitary line convention" },
      { attribute: "type", basis: "native_model_precedent", reference: "approved project DWV type" }
    ],
    pipe_size: "4 inch",
    pipe_type: "PVC - DWV",
    system_type: "Sanitary"
  });
  return input;
}

test("downstream vent tee resolves one newly drafted sanitary route segment inside the atomic graph", () => {
  const plan = compileMepDraftPlan(plannedMainDownstreamVentPackage());
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:sanitary-route-visible-22",
    "route:vent-tee-random-59",
    "verify:vent:vent-tee-random-59"
  ]);
  const branch = plan.actions[1]!;
  assert.deepEqual(branch.depends_on, ["route:sanitary-route-visible-22"]);
  assert.equal(branch.apply_body?.mainElementId, undefined);
  assert.deepEqual(branch.deferred_body?.main_element, {
    created_by_action: "route:sanitary-route-visible-22",
    output: "route_segment",
    index: 0
  });
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 94, y: 204, z: 21.1666666667 },
    { x: 94, y: 210, z: 25.1666666667 }
  ]);
  assert.equal(plan.plan_elements[1]?.assumptions.some((entry) => /created earlier in the same atomic workflow/i.test(entry)), true);
});

test("planned sanitary main vent takeoff rejects off-route and segment-junction ambiguity", () => {
  const offRoute = plannedMainDownstreamVentPackage();
  const offRouteVent = offRoute.observations[1];
  if (offRouteVent?.kind !== "pipe_route" || offRouteVent.geometry_mode !== "downstream_vent_tee") throw new Error("vent_setup_failed");
  offRouteVent.points[0] = { x: 2, y: 5 };
  assert.throws(() => compileMepDraftPlan(offRoute), /planned_main_tee_point_off_route/);

  const ambiguous = plannedMainDownstreamVentPackage();
  const ambiguousVent = ambiguous.observations[1];
  if (ambiguousVent?.kind !== "pipe_route" || ambiguousVent.geometry_mode !== "downstream_vent_tee") throw new Error("vent_setup_failed");
  ambiguousVent.points[0] = { x: 4, y: 3 };
  assert.throws(() => compileMepDraftPlan(ambiguous), /planned_main_tee_segment_ambiguous/);
});

test("new fixture, sanitary route, and downstream vent audit form one ordered atomic graph", () => {
  const input = plannedMainDownstreamVentPackage();
  input.native_element_references = [];
  const vent = input.observations[1];
  if (vent?.kind !== "pipe_route" || vent.geometry_mode !== "downstream_vent_tee") throw new Error("vent_setup_failed");
  vent.verification_fixture_reference_keys = [];
  vent.verification_fixture_observation_ids = ["water-closet-visible-77"];
  input.observations.push({
    kind: "plumbing_fixture",
    observation_id: "water-closet-visible-77",
    discipline: "plumbing",
    role: "water closet",
    representation_classification: fixtureRepresentationClassification("mep_connection_symbol", "mep_connection", "WaterClosetConnection", "Water Closet Connection"),
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "type", "service topology"],
    attribute_provenance: [
      { attribute: "location", basis: "source_observation", reference: "registered water-closet symbol" },
      { attribute: "type", basis: "native_model_precedent", reference: "approved fixture-connection family mapping" },
      { attribute: "service topology", basis: "source_observation", reference: "fixture joins plotted sanitary route" }
    ],
    point: { x: 0, y: 3 },
    elevation_ft: 0,
    placement: { mode: "unhosted_family", family_name: "WaterClosetConnection", type_name: "Water Closet Connection" },
    service_route_connections: [{ route_observation_id: "sanitary-route-visible-22", route_endpoint: "start" }],
    service_boundary: {
      basis: "source_observation",
      evidence_role: "source_pdf",
      required_services: ["sanitary"],
      prohibited_services: ["domestic_hot_water"]
    }
  });

  const plan = compileMepDraftPlan(input);
  assert.deepEqual(plan.actions.map((entry) => entry.action_key), [
    "route:sanitary-route-visible-22",
    "place:water-closet-visible-77",
    "route:vent-tee-random-59",
    "connect:water-closet-visible-77:sanitary-route-visible-22",
    "verify:vent:vent-tee-random-59"
  ]);
  assert.deepEqual(plan.actions[2]?.depends_on, ["route:sanitary-route-visible-22"]);
  assert.deepEqual(plan.actions[3]?.depends_on, [
    "place:water-closet-visible-77",
    "route:sanitary-route-visible-22",
    "route:vent-tee-random-59"
  ]);
  assert.deepEqual(plan.actions[3]?.deferred_body?.target_elements, [{
    created_by_action: "route:vent-tee-random-59",
    output: "split_main_start"
  }]);
  const audit = plan.actions[4]!;
  assert.deepEqual(audit.depends_on, [
    "route:vent-tee-random-59",
    "place:water-closet-visible-77",
    "connect:water-closet-visible-77:sanitary-route-visible-22"
  ]);
  assert.deepEqual(audit.deferred_body?.fixture_elements, [{
    created_by_action: "place:water-closet-visible-77",
    output: "created"
  }]);
  assert.deepEqual(audit.deferred_body?.fixture_element_ids, []);
});

test("light fixtures use the lighting category, work-plane placement, plan tags, and explicit circuit evidence", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "independent-lighting-layout-v1",
    scope_id: "unseen-lighting-bay-alpha",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: [
      ...nativeReferences(),
      {
        reference_key: "lighting-precedent",
        element_id: 777,
        category: "OST_LightingFixtures",
        role: "loaded linear lighting type and circuit precedent",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH,
        power_system_ids: ["system-777"]
      },
      {
        reference_key: "lighting-view",
        element_id: 778,
        category: "View",
        role: "lighting plan",
        evidence_role: "native_model_inventory",
        evidence_sha256: MODEL_HASH
      }
    ],
    registration: registration(),
    level_name: "Benchmark L3",
    level_elevation_ft: 30,
    observations: [
      {
        kind: "light_fixture",
        observation_id: "light-random-67",
        discipline: "electrical",
        role: "linear light fixture",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "type", "elevation", "workset"],
        attribute_provenance: [
          { attribute: "location", basis: "source_observation", reference: "registered source symbol center" },
          { attribute: "type", basis: "native_model_precedent", reference: "loaded same-family lighting precedent" },
          { attribute: "elevation", basis: "native_model_precedent", reference: "same-family level-offset precedent" },
          { attribute: "workset", basis: "native_model_precedent", reference: "same-category project workset precedent" }
        ],
        point: { x: 3, y: 4 },
        elevation_ft: 0.5,
        workset_name: "E-LIGHTING",
        placement: {
          mode: "unhosted_family",
          family_name: "Linear Light",
          type_name: "Linear 2 Foot",
          rotation_degrees: 0,
          annotation_tags: [{
            view_reference_key: "lighting-view",
            family_name: "Lighting Fixture Tag",
            type_name: "Type Mark",
            offset_x_ft: 0.75,
            offset_y_ft: 0.5,
            add_leader: false
          }]
        }
      },
      {
        kind: "electrical_circuit",
        observation_id: "lighting-circuit-random-68",
        discipline: "electrical",
        evidence_role: "native_model_inventory",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["circuit"],
        member_observation_ids: ["light-random-67"],
        source_reference_key: "lighting-precedent",
        expected_power_system_id: "system-777",
        membership_basis: "native_source_power_system"
      }
    ]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "ready");
  assert.equal(plan.plan_elements[0]?.category, "OST_LightingFixtures");
  assert.equal(plan.actions[0]?.path, "/revit/place-families");
  assert.equal(plan.actions[0]?.apply_body?.allowUnhostedWorkPlanePlacement, true);
  assert.equal(plan.actions[0]?.apply_body?.worksetName, "E-LIGHTING");
  const circuit = plan.actions.find((entry) => entry.path === "/revit/assign-electrical-circuit");
  assert.deepEqual(circuit?.depends_on, ["place:light-random-67"]);
  const tag = plan.actions.find((entry) => entry.path === "/revit/tag-elements");
  assert.deepEqual(tag?.depends_on, ["place:light-random-67", "circuit:lighting-circuit-random-68"]);
  assert.equal(tag?.apply_body?.viewId, 778);
  assert.deepEqual(tag?.deferred_body?.tag_element, { created_by_action: "place:light-random-67", output: "created" });
});

test("explicit iterative drafting emits clear unclassified pipe and duct geometry as unscored provisional systems", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "black-white-provisional-routes-v1",
    scope_id: "bounded-monochrome-routes",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "Benchmark L3",
    level_elevation_ft: 30,
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [
      {
        kind: "pipe_route",
        observation_id: "unclassified-pipe-geometry-1",
        discipline: "plumbing",
        service: "unclassified",
        system_classification_policy: "unresolved_placeholder",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "elevation", "type"],
        attribute_provenance: [
          { attribute: "location", basis: "source_observation", reference: "clear monochrome route centerline" },
          { attribute: "elevation", basis: "declared_heuristic", reference: "plan does not expose elevation; route placed at 10 feet above level" },
          { attribute: "type", basis: "native_model_precedent", reference: "loaded project drafting pipe type" }
        ],
        points: [{ x: 1, y: 1 }, { x: 6, y: 1 }, { x: 6, y: 4 }],
        pipe_size_policy: "unresolved_placeholder",
        pipe_type: "Generic Pipe",
        system_type: "Domestic Cold Water",
        elevation_ft: 10
      },
      {
        kind: "duct_route",
        observation_id: "unclassified-duct-geometry-1",
        discipline: "mechanical",
        service: "unclassified",
        system_classification_policy: "unresolved_placeholder",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "size", "elevation", "type"],
        attribute_provenance: [
          { attribute: "location", basis: "source_observation", reference: "clear monochrome double-line route" },
          { attribute: "size", basis: "source_observation", reference: "legible 8 inch route label" },
          { attribute: "elevation", basis: "declared_heuristic", reference: "plan does not expose elevation; route placed at 10 feet above level" },
          { attribute: "type", basis: "native_model_precedent", reference: "loaded round project duct type" }
        ],
        points: [{ x: 2, y: 2 }, { x: 2, y: 8 }],
        duct_size: "8 inch",
        duct_type: "Round",
        system_type: "Supply Air",
        elevation_ft: 10
      }
    ]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.provisional_observation_ids, [
    "unclassified-pipe-geometry-1",
    "unclassified-duct-geometry-1"
  ]);
  assert.deepEqual(plan.promoted_observation_ids, [
    "unclassified-pipe-geometry-1",
    "unclassified-duct-geometry-1"
  ]);
  assert.equal(plan.deferred_observation_ids.length, 0);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0]?.apply_body?.systemType, "Domestic Cold Water");
  assert.equal(plan.actions[1]?.apply_body?.systemType, "Supply Air");
  for (const action of plan.actions) {
    assert.deepEqual(action.provisional_system_classification, {
      policy: "unresolved_placeholder",
      native_system_type_role: "editable_native_drafting_container",
      benchmark_credit: false,
      complete_scope_credit: false
    });
  }
  assert.match(plan.warnings.join("\n"), /editable provisional drafting container/i);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
  assert.deepEqual(workflow.provisionalObservationIds, [
    "unclassified-pipe-geometry-1",
    "unclassified-duct-geometry-1"
  ]);
  assert.deepEqual(workflow.operations.map((operation) => operation.observation_ids), [
    ["unclassified-pipe-geometry-1"],
    ["unclassified-duct-geometry-1"]
  ]);
  assert.ok(workflow.operations.every((operation) =>
    operation.provisional_system_classification?.policy === "unresolved_placeholder"));
});

test("explicit iterative drafting preserves pipe duct and conduit geometry with provisional native types and duct size", () => {
  const input: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "provisional-route-containers-v1",
    scope_id: "bounded-monochrome-route-containers",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "Benchmark L3",
    level_elevation_ft: 30,
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [
      {
        kind: "pipe_route",
        observation_id: "pipe-visible-type-unresolved",
        discipline: "plumbing",
        service: "sanitary",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "size", "elevation", "system"],
        points: [{ x: 1, y: 1 }, { x: 6, y: 1 }],
        pipe_size: "2 inch",
        pipe_type: "Generic Pipe",
        type_policy: "unresolved_placeholder",
        system_type: "Sanitary",
        elevation_ft: 10
      },
      {
        kind: "duct_route",
        observation_id: "duct-visible-size-type-unresolved",
        discipline: "mechanical",
        service: "supply_air",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "elevation", "system"],
        points: [{ x: 2, y: 2 }, { x: 2, y: 8 }],
        duct_size_policy: "unresolved_placeholder",
        duct_type: "Rectangular",
        type_policy: "unresolved_placeholder",
        system_type: "Supply Air",
        elevation_ft: 10
      },
      {
        kind: "conduit_route",
        observation_id: "conduit-visible-type-unresolved",
        discipline: "electrical",
        service: "branch_circuit",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: ["location", "size", "elevation", "system"],
        points: [{ x: 3, y: 3 }, { x: 8, y: 3 }],
        conduit_size: "1 inch",
        conduit_type: "EMT",
        type_policy: "unresolved_placeholder",
        elevation_ft: 10
      }
    ]
  };

  const plan = compileMepDraftPlan(input);
  assert.equal(plan.status, "partially_ready");
  assert.deepEqual(plan.provisional_observation_ids, [
    "pipe-visible-type-unresolved",
    "duct-visible-size-type-unresolved",
    "conduit-visible-type-unresolved"
  ]);
  assert.equal(plan.actions.length, 3);
  assert.equal(plan.actions[0]?.apply_body?.pipeType, "Generic Pipe");
  assert.equal(plan.actions[1]?.apply_body?.ductType, "Rectangular");
  assert.equal(plan.actions[1]?.apply_body?.ductSize, undefined);
  assert.equal(plan.actions[1]?.apply_body?.sizePolicy, "use_default_with_warning");
  assert.equal(plan.actions[2]?.apply_body?.conduitType, "EMT");
  assert.deepEqual(plan.actions[0]?.provisional_route_attributes, {
    unresolved_attributes: ["type"],
    native_type_role: "editable_native_drafting_container",
    benchmark_credit: false,
    complete_scope_credit: false,
    external_topology_credit: false
  });
  assert.deepEqual(plan.actions[1]?.provisional_route_attributes, {
    unresolved_attributes: ["size", "type"],
    native_type_role: "editable_native_drafting_container",
    native_size_role: "editable_default_drafting_placeholder",
    benchmark_credit: false,
    complete_scope_credit: false,
    external_topology_credit: false
  });
  assert.match(plan.warnings.join("\n"), /8x8 drafting placeholder/i);
  assert.match(plan.warnings.join("\n"), /editable native drafting container/i);

  const workflow = buildAtomicMepDraftWorkflowRequest(plan);
  assert.equal(workflow.benchmarkCredit, false);
  assert.equal(workflow.authorizationBasis, "explicit_unscored_user_direction");
  assert.deepEqual(
    workflow.operations[1]?.provisional_route_attributes,
    plan.actions[1]?.provisional_route_attributes
  );

  const noPartialPolicy = structuredClone(input);
  delete noPartialPolicy.partial_promotion_policy;
  assert.throws(
    () => compileMepDraftPlan(noPartialPolicy),
    /provisional_route_attributes_require_partial_promotion_policy/
  );

  const claimsType = structuredClone(input);
  claimsType.observations[0]!.supported_attributes.push("type");
  assert.throws(() => compileMepDraftPlan(claimsType), /unresolved_type_cannot_claim_type_support/);

  const suppliesPlaceholderDuctSize = structuredClone(input);
  const duct = suppliesPlaceholderDuctSize.observations[1]!;
  if (duct.kind !== "duct_route") throw new Error("duct_setup_failed");
  duct.duct_size = "12x10";
  assert.throws(
    () => compileMepDraftPlan(suppliesPlaceholderDuctSize),
    /unresolved_placeholder_must_omit_duct_size/
  );

  const connectsPlaceholderDuct = structuredClone(input);
  const connectingDuct = connectsPlaceholderDuct.observations[1]!;
  if (connectingDuct.kind !== "duct_route") throw new Error("duct_setup_failed");
  connectingDuct.connect_to_existing = true;
  assert.throws(
    () => compileMepDraftPlan(connectsPlaceholderDuct),
    /provisional_duct_attributes_cannot_connect_to_existing/
  );
});

test("unclassified routes fail closed without explicit provisional policy and cannot prove fixture service", () => {
  const base: MepDraftPackage = {
    schema_version: 1,
    fixture_id: "black-white-provisional-route-negative-v1",
    scope_id: "bounded-monochrome-route-negative",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: visibleEvidence(),
    native_element_references: nativeReferences(),
    registration: registration(),
    level_name: "Benchmark L3",
    level_elevation_ft: 30,
    partial_promotion_policy: "defer_ambiguous_observations",
    observations: [{
      kind: "pipe_route",
      observation_id: "unclassified-pipe-negative-1",
      discipline: "plumbing",
      service: "unclassified",
      system_classification_policy: "unresolved_placeholder",
      visibility: "clear",
      confidence: 0.96,
      supported_attributes: ["location", "elevation", "type"],
      points: [{ x: 1, y: 1 }, { x: 6, y: 1 }],
      pipe_size_policy: "unresolved_placeholder",
      pipe_type: "Generic Pipe",
      system_type: "Domestic Cold Water",
      elevation_ft: 10
    }]
  };

  const noPolicy = structuredClone(base);
  delete noPolicy.partial_promotion_policy;
  assert.throws(() => compileMepDraftPlan(noPolicy), /unresolved_system_requires_partial_promotion_policy/);

  const claimsSystem = structuredClone(base);
  claimsSystem.observations[0]!.supported_attributes.push("system");
  assert.throws(() => compileMepDraftPlan(claimsSystem), /unclassified_route_cannot_claim_system_support/);

  const connectsToExisting = structuredClone(base);
  const connectingRoute = connectsToExisting.observations[0]!;
  if (connectingRoute.kind !== "pipe_route") throw new Error("route_setup_failed");
  Object.assign(connectingRoute, { connect_to_existing: true });
  assert.throws(() => compileMepDraftPlan(connectsToExisting), /unclassified_route_cannot_connect_to_existing/);

  const classifiedPlaceholder = structuredClone(base);
  const route = classifiedPlaceholder.observations[0]!;
  if (route.kind !== "pipe_route") throw new Error("route_setup_failed");
  route.service = "sanitary";
  assert.throws(() => compileMepDraftPlan(classifiedPlaceholder), /classified_route_requires_explicit_system/);

  const invalidDuctService = createdRouteHostedTerminalPackage();
  const invalidDuct = invalidDuctService.observations[0]!;
  if (invalidDuct.kind !== "duct_route") throw new Error("route_setup_failed");
  invalidDuct.service = "mystery_air" as never;
  assert.throws(() => compileMepDraftPlan(invalidDuctService), /duct_service_invalid/);

  const provisionalTerminalTopology = createdRouteHostedTerminalPackage();
  provisionalTerminalTopology.partial_promotion_policy = "defer_ambiguous_observations";
  const provisionalDuct = provisionalTerminalTopology.observations[0]!;
  if (provisionalDuct.kind !== "duct_route") throw new Error("route_setup_failed");
  provisionalDuct.service = "unclassified";
  provisionalDuct.system_classification_policy = "unresolved_placeholder";
  provisionalDuct.supported_attributes = provisionalDuct.supported_attributes.filter(
    (attribute) => attribute !== "system"
  );
  provisionalDuct.attribute_provenance = provisionalDuct.attribute_provenance?.filter(
    (entry) => entry.attribute !== "system"
  );
  assert.throws(
    () => compileMepDraftPlan(provisionalTerminalTopology),
    /unclassified_duct_cannot_establish_terminal_topology/
  );

  const alternateContainer = structuredClone(base);
  const alternateRoute = alternateContainer.observations[0]!;
  if (alternateRoute.kind !== "pipe_route") throw new Error("route_setup_failed");
  alternateRoute.system_type = "Sanitary";
  assert.notEqual(
    compileMepDraftPlan(base).input_fingerprint_sha256,
    compileMepDraftPlan(alternateContainer).input_fingerprint_sha256
  );
});

test("MEP draft fingerprints bind iterative promotion policy", () => {
  const defaultPlan = compileMepDraftPlan(plumbingTopologyPackage());
  const iterative = plumbingTopologyPackage();
  iterative.partial_promotion_policy = "defer_ambiguous_observations";
  const iterativePlan = compileMepDraftPlan(iterative);
  assert.notEqual(defaultPlan.input_fingerprint_sha256, iterativePlan.input_fingerprint_sha256);
});
