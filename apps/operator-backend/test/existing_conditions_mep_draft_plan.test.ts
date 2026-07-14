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
    native_element_references: [],
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
  assert.deepEqual(plan.actions[1]?.dry_run_body?.instances, [{ x: 98, y: 204, z: 0 }]);
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
