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
    },
    {
      reference_key: "panel-source",
      element_id: 444,
      category: "OST_ElectricalEquipment",
      role: "120/208 V panelboard precedent",
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
        supported_attributes: ["location", "type"],
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
    mode: "hosted_exemplar",
    source_reference_key: "panel-source",
    host_reference_key: "south-wall-host",
    host_category: "OST_Walls",
    copy_distribution_system_from_source: true
  };
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
  assert.throws(() => compileMepDraftPlan(ungrounded), /declared_heuristic_only_allowed_for_pipe_elevation|main_elevation_must_be_native_model_precedent/);
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
