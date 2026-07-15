import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import {
  compileRegisteredMepObservations,
  type RegisteredMepObservationPackage
} from "../src/existing_conditions/registered_mep_observations.js";
import type { BoundedMepRegionCoverageV1 } from "../src/existing_conditions/mep_region_coverage.js";

const SOURCE_HASH = "a".repeat(64);

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function registeredRender(): { path: string; sha256: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registered-mep-"));
  const filePath = path.join(directory, "agent-visible-plan.png");
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 100, 100);
  context.strokeStyle = "#000000";
  context.beginPath();
  context.moveTo(20, 80);
  context.lineTo(80, 80);
  context.stroke();
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, sha256: sha256(buffer) };
}

function registration() {
  return {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
      { source: { x: 10, y: 0 }, model: { x: 110, y: 200 } },
      { source: { x: 0, y: 10 }, model: { x: 100, y: 210 } }
    ],
    max_rms_error_ft: 0.01,
    max_point_error_ft: 0.02
  };
}

function plumbingInput(): RegisteredMepObservationPackage {
  const render = registeredRender();
  return {
    schema_version: 1,
    fixture_id: "registered-plumbing-independent-v1",
    scope_id: "unseen-room-alpha",
    discipline: "plumbing",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: [
      { role: "source_pdf", sha256: SOURCE_HASH },
      { role: "registered_source_render", sha256: render.sha256 }
    ],
    native_element_references: [],
    registration: registration(),
    coordinate_space: "registered_render_pixels_top_left",
    registered_render: {
      path: render.path,
      sha256: render.sha256,
      width_px: 100,
      height_px: 100,
      evidence_role: "registered_source_render",
      access_scope: "agent_visible"
    },
    frame: { model_bounds: { min: { x: 100, y: 200 }, max: { x: 110, y: 210 } } },
    level_name: "L4",
    level_elevation_ft: 32,
    room_number: "R-ALPHA",
    maximum_observations: 10,
    observations: [
      {
        kind: "pipe_route",
        discipline: "plumbing",
        observation_id: "cold-route-random-81",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_evidence: [
          { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "1/2 inch label adjacent to the selected route" },
          { attribute: "elevation", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "9 foot elevation note adjacent to the selected route" },
          { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "domestic cold water abbreviation on the selected route" },
          { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "copper pipe note keyed to the selected route" }
        ],
        service: "domestic_cold_water",
        pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
        pipe_size: "1/2 inch",
        pipe_type: "Copper",
        system_type: "Domestic Cold Water",
        elevation_ft: 9
      },
      {
        kind: "plumbing_fixture",
        discipline: "plumbing",
        observation_id: "fixture-random-42",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "type", "service topology"],
        attribute_evidence: [
          { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "lavatory symbol and keyed fixture note" },
          { attribute: "service topology", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "cold-water route terminates at the selected fixture symbol" }
        ],
        role: "lavatory",
        pixel_point: { x: 20, y: 80 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Fixture A", type_name: "Type Z" },
        service_route_connections: [{ route_observation_id: "cold-route-random-81", route_endpoint: "start" }],
        service_boundary: {
          basis: "source_observation",
          evidence_role: "registered_source_render",
          required_services: ["domestic_cold_water"],
          prohibited_services: ["domestic_hot_water"]
        }
      }
    ]
  };
}

function electricalInput(): RegisteredMepObservationPackage {
  const plumbing = plumbingInput();
  return {
    ...plumbing,
    fixture_id: "registered-electrical-independent-v1",
    scope_id: "unseen-office-beta",
    discipline: "electrical",
    native_element_references: [],
    observations: [{
      kind: "electrical_device",
      discipline: "electrical",
      observation_id: "device-random-17",
      visibility: "clear",
      confidence: 0.96,
      supported_attributes: ["location", "type"],
      attribute_evidence: [
        { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "duplex receptacle symbol at selected pixel" }
      ],
      role: "duplex receptacle",
      pixel_point: { x: 35, y: 65 },
      elevation_ft: 1.5,
      placement: { mode: "unhosted_family", family_name: "Receptacle A", type_name: "Duplex B" }
    }]
  };
}

function electricalCoverage(input: RegisteredMepObservationPackage): BoundedMepRegionCoverageV1 {
  return {
    schema_version: 1 as const,
    scope_id: input.scope_id,
    source_evidence_sha256: input.source_evidence_sha256,
    registered_render_sha256: input.registered_render.sha256,
    coordinate_space: "registered_render_pixels_top_left" as const,
    region: { min: { x: 20, y: 50 }, max: { x: 90, y: 90 } },
    disciplines: ["electrical" as const],
    candidates: [{
      candidate_id: "bounded-device-symbol-random-17",
      primitive: "point_symbol" as const,
      pixel_bounds: { min: { x: 30, y: 60 }, max: { x: 40, y: 70 } },
      visibility: "clear" as const,
      disposition: {
        status: "resolved" as const,
        observation_ids: [input.observations[0]!.observation_id]
      }
    }]
  };
}

test("registered plumbing pixels compile through existing route, placement, and connection authority", async () => {
  const result = await compileRegisteredMepObservations(plumbingInput());
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families",
    "/revit/connect-mep-elements"
  ]);
  assert.deepEqual(result.compiled_plan.actions[0]?.apply_body?.points, [
    { x: 102, y: 202, z: 41 },
    { x: 108, y: 202, z: 41 }
  ]);
  assert.deepEqual(result.compiled_plan.actions[1]?.expected_model_point, { x: 102, y: 202, z: 32 });
});

test("registered fixture pixels compose with concealed native connector bridge geometry", async () => {
  const input = plumbingInput();
  const nativeHash = "b".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: nativeHash });
  input.native_element_references = [{
    reference_key: "retained-cold-anchor-701",
    element_id: 701,
    category: "OST_PipeFitting",
    role: "open cold-water anchor",
    evidence_role: "native_model_inventory",
    evidence_sha256: nativeHash
  }];
  input.observations[0] = {
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "cold-connector-bridge-71",
    evidence_role: "native_model_inventory",
    visibility: "occluded",
    confidence: 0.98,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "location", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "runtime connectors on the placed fixture and explicit retained anchor" },
      { attribute: "size", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "matching half-inch native connectors" },
      { attribute: "elevation", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "runtime connector elevations, not plan-observed" },
      { attribute: "system", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "native Domestic Cold Water classifications" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project Copper pipe precedent" }
    ],
    service: "domestic_cold_water",
    geometry_mode: "native_connector_bridge",
    source_fixture_observation_id: "fixture-random-42",
    target_reference_key: "retained-cold-anchor-701",
    maximum_length_ft: 2,
    pipe_size: "1/2 inch",
    pipe_type: "Copper",
    system_type: "Domestic Cold Water"
  };
  const fixture = input.observations[1];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  fixture.service_route_connections = [{ route_observation_id: "cold-connector-bridge-71", route_endpoint: "native_source" }];
  fixture.service_boundary = {
    basis: "native_model_precedent",
    evidence_role: "native_model_inventory",
    required_services: ["domestic_cold_water"],
    prohibited_services: ["domestic_hot_water"]
  };

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/place-families",
    "/revit/create-pipe-between-connectors"
  ]);
  assert.deepEqual(result.compiled_plan.actions[0]?.expected_model_point, { x: 102, y: 202, z: 32 });
  assert.equal(result.compiled_plan.actions[1]?.deferred_body?.target_element_id, 701);
  assert.match(result.usage_constraints.join("\n"), /plan geometry/i);
});

test("registered downstream vent pixels compile to tee creation plus exact native fixture audit", async () => {
  const input = plumbingInput();
  const nativeHash = "c".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: nativeHash });
  input.native_element_references = [
    {
      reference_key: "retained-sanitary-main-419",
      element_id: 419,
      category: "OST_PipeCurves",
      role: "retained sanitary main",
      evidence_role: "native_model_inventory",
      evidence_sha256: nativeHash
    },
    {
      reference_key: "served-water-closet-827",
      element_id: 827,
      category: "OST_PlumbingFixtures",
      role: "water closet verified downstream",
      evidence_role: "native_model_inventory",
      evidence_sha256: nativeHash
    }
  ];
  input.observations = [{
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "downstream-vent-tee-63",
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "size", "main_elevation", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project vent sizing precedent" },
      { attribute: "main_elevation", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "retained main centerline elevation" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show Z; use a labeled typical vent rise" },
      { attribute: "system", basis: "user_direction", evidence_role: "registered_source_render", reference: "downstream vent continuation" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project PVC-DWV precedent" }
    ],
    service: "vent",
    geometry_mode: "downstream_vent_tee",
    main_reference_key: "retained-sanitary-main-419",
    verification_fixture_reference_keys: ["served-water-closet-827"],
    pixel_points: [{ x: 20, y: 80 }, { x: 20, y: 30 }],
    main_elevation_ft: 1.1666666667,
    elevation_ft: 5.1666666667,
    pipe_size: "2 inch",
    pipe_type: "PVC - DWV",
    system_type: "Vent"
  }];

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/connect-mep-branch",
    "/revit/audit-plumbing-fixture-services"
  ]);
  assert.deepEqual(result.compiled_plan.actions[0]?.apply_body?.branchPoints, [
    { x: 102, y: 202, z: 33.1666666667 },
    { x: 102, y: 207, z: 37.1666666667 }
  ]);
  assert.deepEqual(result.compiled_plan.actions[1]?.deferred_body?.fixture_element_ids, [827]);
  assert.match(result.usage_constraints.join("\n"), /never represents the vent as a direct fixture connector/i);
});

test("registered downstream vent pixels can reference a sanitary route drafted in the same workflow", async () => {
  const input = plumbingInput();
  const nativeHash = "c".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: nativeHash });
  input.observations = [
    {
      kind: "pipe_route",
      discipline: "plumbing",
      observation_id: "sanitary-route-visible-14",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "size", "elevation", "system", "type"],
      attribute_evidence: [
        { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "4 inch sanitary size label" },
        { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show sanitary Z" },
        { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary line convention" },
        { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "approved project DWV type" }
      ],
      service: "sanitary",
      geometry_mode: "source_points",
      pixel_points: [{ x: 10, y: 80 }, { x: 50, y: 80 }, { x: 90, y: 80 }],
      elevation_ft: 1.1666666667,
      pipe_size: "4 inch",
      pipe_type: "PVC - DWV",
      system_type: "Sanitary"
    },
    {
      kind: "plumbing_fixture",
      discipline: "plumbing",
      observation_id: "water-closet-visible-27",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "type", "service topology"],
      attribute_evidence: [
        { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "water closet symbol and keyed fixture note" },
        { attribute: "service topology", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "sanitary route begins at the bottom-outlet fixture symbol" }
      ],
      role: "water closet",
      pixel_point: { x: 10, y: 80 },
      elevation_ft: 0,
      placement: { mode: "unhosted_family", family_name: "WaterClosetConnection", type_name: "Water Closet Connection" },
      service_route_connections: [{ route_observation_id: "sanitary-route-visible-14", route_endpoint: "start" }],
      service_boundary: {
        basis: "source_observation",
        evidence_role: "registered_source_render",
        required_services: ["sanitary"],
        prohibited_services: ["domestic_hot_water"]
      }
    },
    {
      kind: "pipe_route",
      discipline: "plumbing",
      observation_id: "downstream-vent-planned-main-91",
      visibility: "clear",
      confidence: 0.97,
      supported_attributes: ["location", "size", "elevation", "system", "type"],
      attribute_evidence: [
        { attribute: "size", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project vent sizing precedent" },
        { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "plan does not show vent rise Z" },
        { attribute: "system", basis: "user_direction", evidence_role: "registered_source_render", reference: "downstream vent continuation" },
        { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "approved project DWV type" }
      ],
      service: "vent",
      geometry_mode: "downstream_vent_tee",
      main_route_observation_id: "sanitary-route-visible-14",
      verification_fixture_observation_ids: ["water-closet-visible-27"],
      pixel_points: [{ x: 20, y: 80 }, { x: 20, y: 30 }],
      elevation_ft: 5.1666666667,
      pipe_size: "2 inch",
      pipe_type: "PVC - DWV",
      system_type: "Vent"
    }
  ];

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.action_key), [
    "route:sanitary-route-visible-14",
    "place:water-closet-visible-27",
    "route:downstream-vent-planned-main-91",
    "connect:water-closet-visible-27:sanitary-route-visible-14",
    "verify:vent:downstream-vent-planned-main-91"
  ]);
  assert.deepEqual(result.compiled_plan.actions[2]?.deferred_body?.main_element, {
    created_by_action: "route:sanitary-route-visible-14",
    output: "route_segment",
    index: 0
  });
  assert.deepEqual(result.compiled_plan.actions[2]?.apply_body?.branchPoints, [
    { x: 102, y: 202, z: 33.1666666667 },
    { x: 102, y: 207, z: 37.1666666667 }
  ]);
  assert.deepEqual(result.compiled_plan.actions[3]?.deferred_body?.target_elements, [{
    created_by_action: "route:downstream-vent-planned-main-91",
    output: "split_main_start"
  }]);
  assert.deepEqual(result.compiled_plan.actions[4]?.deferred_body?.fixture_elements, [{
    created_by_action: "place:water-closet-visible-27",
    output: "created"
  }]);
  assert.deepEqual(result.compiled_plan.actions[4]?.depends_on, [
    "route:downstream-vent-planned-main-91",
    "place:water-closet-visible-27",
    "connect:water-closet-visible-27:sanitary-route-visible-14"
  ]);
});

test("a plan-absent pipe elevation may proceed only as an explicit declared heuristic", async () => {
  const input = plumbingInput();
  const route = input.observations[0];
  if (route?.kind !== "pipe_route") throw new Error("fixture_setup_failed");
  const elevationClaim = route.attribute_evidence.find((entry) => entry.attribute === "elevation");
  if (!elevationClaim) throw new Error("elevation_claim_setup_failed");
  elevationClaim.basis = "declared_heuristic";
  elevationClaim.reference = "No elevation is shown in plan; assume 9 feet above L4 as a typical plenum routing height.";
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.plan_elements[0]?.assumptions, [
    "elevation inferred by declared heuristic: No elevation is shown in plan; assume 9 feet above L4 as a typical plenum routing height."
  ]);
  assert.match(result.compiled_plan.warnings.join("\n"), /declared heuristic/);
  const convertedRoute = result.converted_package.observations[0];
  assert.equal(convertedRoute?.attribute_provenance?.find((entry) => entry.attribute === "elevation")?.basis, "declared_heuristic");
});

test("declared heuristics cannot invent pipe size, type, or system", async () => {
  const input = plumbingInput();
  const route = input.observations[0];
  if (route?.kind !== "pipe_route") throw new Error("fixture_setup_failed");
  const sizeClaim = route.attribute_evidence.find((entry) => entry.attribute === "size");
  if (!sizeClaim) throw new Error("size_claim_setup_failed");
  sizeClaim.basis = "declared_heuristic";
  await assert.rejects(() => compileRegisteredMepObservations(input), /declared_heuristic_only_allowed_for_pipe_elevation/);
});

test("registered electrical pixels locate devices but render evidence cannot assert circuit membership", async () => {
  const input = electricalInput();
  input.observations.push({
    kind: "electrical_circuit",
    discipline: "electrical",
    observation_id: "circuit-label-only",
    evidence_role: "registered_source_render",
    visibility: "clear",
    confidence: 1,
    supported_attributes: ["circuit"],
    member_observation_ids: ["device-random-17"],
    source_reference_key: "invented-source",
    expected_power_system_id: "invented-system",
    membership_basis: "native_source_power_system"
  });
  await assert.rejects(() => compileRegisteredMepObservations(input), /circuit_membership_cannot_use_render_evidence/);
});

test("registered electrical equipment pixels compile as native electrical equipment", async () => {
  const input = electricalInput();
  input.observations = [{
    kind: "electrical_equipment",
    discipline: "electrical",
    observation_id: "equipment-random-31",
    visibility: "clear",
    confidence: 0.96,
    supported_attributes: ["location", "type"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "panelboard symbol and tag are legible at the selected pixel" }
    ],
    role: "panelboard",
    pixel_point: { x: 45, y: 55 },
    elevation_ft: 4,
    placement: { mode: "unhosted_family", family_name: "Panelboard A", type_name: "Panel B" }
  }];
  input.source_coverage = {
    ...electricalCoverage(input),
    candidates: [{
      candidate_id: "bounded-equipment-symbol-random-31",
      primitive: "point_symbol",
      pixel_bounds: { min: { x: 40, y: 50 }, max: { x: 50, y: 60 } },
      visibility: "clear",
      disposition: { status: "resolved", observation_ids: ["equipment-random-31"] }
    }]
  };
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.equal(result.compiled_plan.plan_elements[0]?.category, "OST_ElectricalEquipment");
  assert.equal(result.converted_package.observations[0]?.kind, "electrical_equipment");
  assert.equal(result.compiled_plan.actions[0]?.path, "/revit/place-families");
});

test("registered MEP observations bind a complete bounded-region coverage receipt", async () => {
  const input = electricalInput();
  input.source_coverage = electricalCoverage(input);
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.equal(result.source_coverage_receipt?.coverage_status, "complete");
  assert.deepEqual(result.source_coverage_receipt?.covered_observation_ids, ["device-random-17"]);
  assert.equal(result.compiled_plan.actions.length, 1);
  assert.match(result.usage_constraints.join("\n"), /partial coverage cannot be reported as complete/i);
});

test("partial bounded-region coverage preserves resolved actions but requires clarification", async () => {
  const input = electricalInput();
  const sourceCoverage = electricalCoverage(input);
  sourceCoverage.candidates.push({
    candidate_id: "unfamiliar-symbol-random-93",
    primitive: "unknown",
    pixel_bounds: { min: { x: 60, y: 60 }, max: { x: 70, y: 70 } },
    visibility: "partial",
    disposition: {
      status: "unresolved",
      reason: "ambiguous_symbol",
      note: "The visible mark does not match an approved device or fixture mapping."
    }
  });
  input.source_coverage = sourceCoverage;
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.source_coverage_receipt?.coverage_status, "partial");
  assert.equal(result.compiled_plan.status, "clarification_required");
  assert.equal(result.compiled_plan.actions.length, 1);
  assert.equal(result.compiled_plan.ambiguities.at(-1)?.id, "bounded-mep-region-coverage");
  assert.match(result.compiled_plan.ambiguities.at(-1)?.description ?? "", /unfamiliar-symbol-random-93/);
});

test("bounded-region coverage rejects observations that were not tied to a source candidate", async () => {
  const input = electricalInput();
  const sourceCoverage = electricalCoverage(input);
  sourceCoverage.candidates = [];
  input.source_coverage = sourceCoverage;
  await assert.rejects(() => compileRegisteredMepObservations(input), /candidates_are_required/);
});

test("registered electrical labels can create a new circuit only with per-member legible evidence", async () => {
  const input = electricalInput();
  input.observations.push({
    kind: "electrical_circuit",
    discipline: "electrical",
    observation_id: "new-circuit-from-legible-label",
    evidence_role: "registered_source_render",
    visibility: "clear",
    confidence: 0.99,
    supported_attributes: ["circuit"],
    member_observation_ids: ["device-random-17"],
    circuit_mode: "create_new_power_system",
    system_type: "PowerCircuit",
    membership_basis: "legible_source_circuit_label",
    panel_circuit_label: "P403/8",
    member_label_evidence: [{
      member_observation_id: "device-random-17",
      evidence_role: "registered_source_render",
      reference: "P403/8 text is legible next to the selected receptacle symbol.",
      label: "P403/8"
    }]
  });
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.action_key), [
    "place:device-random-17",
    "circuit:new-circuit-from-legible-label"
  ]);
  const circuit = result.compiled_plan.actions[1]!;
  assert.equal(circuit.deferred_body?.create_system_type, "PowerCircuit");
  assert.equal(circuit.deferred_body?.source_element_id, undefined);
  assert.equal(circuit.expected_created_min, 1);
});

test("registered new circuit rejects missing or mismatched member label evidence", async () => {
  const input = electricalInput();
  input.observations.push({
    kind: "electrical_circuit",
    discipline: "electrical",
    observation_id: "new-circuit-incomplete-labels",
    evidence_role: "registered_source_render",
    visibility: "clear",
    confidence: 0.99,
    supported_attributes: ["circuit"],
    member_observation_ids: ["device-random-17"],
    circuit_mode: "create_new_power_system",
    system_type: "PowerCircuit",
    membership_basis: "legible_source_circuit_label",
    panel_circuit_label: "P403/8",
    member_label_evidence: []
  });
  await assert.rejects(() => compileRegisteredMepObservations(input), /member_label_evidence_must_cover_every_member/);
});

test("hash and dimension mismatches fail before any MEP plan is compiled", async () => {
  const hashMismatch = plumbingInput();
  hashMismatch.registered_render.sha256 = "b".repeat(64);
  hashMismatch.visible_evidence[1]!.sha256 = "b".repeat(64);
  await assert.rejects(() => compileRegisteredMepObservations(hashMismatch), /render_file_hash_mismatch/);

  const dimensionMismatch = plumbingInput();
  dimensionMismatch.registered_render.width_px = 101;
  await assert.rejects(() => compileRegisteredMepObservations(dimensionMismatch), /render_dimensions_mismatch/);
});

test("out-of-frame, degenerate, duplicate, and wrong-discipline observations fail closed", async () => {
  const outside = plumbingInput();
  const outsideRoute = outside.observations[0];
  if (outsideRoute?.kind !== "pipe_route" || outsideRoute.geometry_mode === "native_connector_bridge") throw new Error("fixture_setup_failed");
  outsideRoute.pixel_points[1] = { x: 101, y: 80 };
  await assert.rejects(() => compileRegisteredMepObservations(outside), /outside_registered_render/);

  const degenerate = plumbingInput();
  const degenerateRoute = degenerate.observations[0];
  if (degenerateRoute?.kind !== "pipe_route" || degenerateRoute.geometry_mode === "native_connector_bridge") throw new Error("fixture_setup_failed");
  degenerateRoute.pixel_points[1] = { ...degenerateRoute.pixel_points[0]! };
  await assert.rejects(() => compileRegisteredMepObservations(degenerate), /route_is_degenerate/);

  const duplicate = plumbingInput();
  duplicate.observations[1]!.observation_id = duplicate.observations[0]!.observation_id;
  await assert.rejects(() => compileRegisteredMepObservations(duplicate), /ids_must_be_unique/);

  const wrongDiscipline = electricalInput();
  wrongDiscipline.discipline = "plumbing";
  await assert.rejects(() => compileRegisteredMepObservations(wrongDiscipline), /outside_package_discipline/);
});

test("partial plotted evidence preserves geometry but produces one clarification and zero writes", async () => {
  const input = plumbingInput();
  const route = input.observations[0];
  if (route?.kind !== "pipe_route") throw new Error("fixture_setup_failed");
  route.visibility = "partial";
  route.confidence = 0.7;
  route.supported_attributes = ["location", "system"];
  route.attribute_evidence = [
    { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "system abbreviation remains legible" }
  ];
  input.observations = [route];
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "clarification_required");
  assert.equal(result.compiled_plan.actions.length, 0);
  assert.deepEqual(result.compiled_plan.ambiguities[0]?.material_attributes, ["size", "elevation", "type"]);
});

test("material attributes cannot be promoted from pixels without an auditable evidence claim", async () => {
  const input = electricalInput();
  const device = input.observations[0];
  if (device?.kind !== "electrical_device") throw new Error("fixture_setup_failed");
  device.attribute_evidence = [];
  await assert.rejects(() => compileRegisteredMepObservations(input), /supported_attribute_lacks_evidence:type/);
});

test("identity perturbation does not change registered geometry or the native tool route", async () => {
  const firstInput = electricalInput();
  const secondInput = electricalInput();
  secondInput.fixture_id = "registered-electrical-randomized-v2";
  secondInput.scope_id = "unseen-office-gamma";
  secondInput.observations[0]!.observation_id = "device-random-93";
  const [first, second] = await Promise.all([
    compileRegisteredMepObservations(firstInput),
    compileRegisteredMepObservations(secondInput)
  ]);
  assert.deepEqual(first.compiled_plan.actions.map((entry) => entry.path), second.compiled_plan.actions.map((entry) => entry.path));
  assert.deepEqual(first.compiled_plan.actions[0]?.expected_model_point, second.compiled_plan.actions[0]?.expected_model_point);
  assert.notEqual(first.input_fingerprint_sha256, second.input_fingerprint_sha256);
});

test("registered render evidence cannot be labeled as evaluator or withheld truth", async () => {
  const input = electricalInput();
  input.registered_render.evidence_role = "evaluator_ground_truth";
  input.visible_evidence[1]!.role = "evaluator_ground_truth";
  await assert.rejects(() => compileRegisteredMepObservations(input), /render_evidence_role_forbidden/);
});

test("CLI emits the validated package, compiled plan, and atomic dry-run workflow", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registered-mep-cli-"));
  const inputPath = path.join(directory, "input.json");
  const compilationPath = path.join(directory, "compilation.json");
  const packagePath = path.join(directory, "package.json");
  const workflowPath = path.join(directory, "workflow.json");
  fs.writeFileSync(inputPath, `${JSON.stringify(plumbingInput(), null, 2)}\n`, "utf8");
  const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
  execFileSync(process.execPath, [
    cli,
    "compile-registered-mep-observations",
    "--input", inputPath,
    "--out", compilationPath,
    "--package-out", packagePath,
    "--workflow-out", workflowPath,
    "--max-created", "4"
  ], { stdio: "pipe" });
  const compilation = JSON.parse(fs.readFileSync(compilationPath, "utf8")) as { compiled_plan: { status: string } };
  const converted = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { observations: Array<{ points?: unknown[] }> };
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8")) as { dryRun: boolean; maximumCreatedElements: number; operations: unknown[] };
  assert.equal(compilation.compiled_plan.status, "ready");
  assert.equal(converted.observations[0]?.points?.length, 2);
  assert.equal(workflow.dryRun, true);
  assert.equal(workflow.maximumCreatedElements, 4);
  assert.equal(workflow.operations.length, 3);
});
