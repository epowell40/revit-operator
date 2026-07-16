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

function electricalConduitInput(): RegisteredMepObservationPackage {
  const input = electricalInput();
  input.fixture_id = "registered-electrical-conduit-independent-v1";
  input.scope_id = "unseen-electrical-corridor-delta";
  input.visible_evidence.push({ role: "native_model_inventory", sha256: "b".repeat(64) });
  input.observations = [{
    kind: "conduit_route",
    discipline: "electrical",
    observation_id: "feeder-conduit-random-52",
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "one-inch conduit size note adjacent to the selected run" },
      { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "No elevation is shown in plan; assume 10 feet above L4 in the plenum." },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "feeder designation applies to the selected run" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "exact project EMT conduit type inventory entry 4242" }
    ],
    service: "feeder",
    pixel_points: [{ x: 20, y: 80 }, { x: 50, y: 80 }, { x: 50, y: 60 }],
    conduit_size: "1 inch",
    conduit_type: "EMT",
    conduit_type_id: 4242,
    elevation_ft: 10
  }];
  return input;
}

function mechanicalInput(): RegisteredMepObservationPackage {
  const plumbing = plumbingInput();
  return {
    ...plumbing,
    fixture_id: "registered-mechanical-independent-v1",
    scope_id: "unseen-mechanical-room-gamma",
    discipline: "mechanical",
    native_element_references: [],
    observations: [
      {
        kind: "duct_route",
        discipline: "mechanical",
        observation_id: "outside-air-route-random-63",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "size", "elevation", "system", "type"],
        attribute_evidence: [
          { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "8 inch diameter label adjacent to the selected route" },
          { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "No elevation is shown in plan; assume 10 feet above L4 in the plenum." },
          { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "outside-air system notation on the selected route" },
          { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "round duct graphics and diameter symbol" }
        ],
        service: "outside_air",
        pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
        duct_size: "8 inch",
        duct_type: "Round Duct",
        system_type: "Outside Air",
        elevation_ft: 10
      },
      {
        kind: "mechanical_equipment",
        discipline: "mechanical",
        observation_id: "hru-random-28",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "type"],
        attribute_evidence: [
          { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "HRU equipment symbol and tag at the selected pixel" }
        ],
        role: "heat recovery unit",
        pixel_point: { x: 20, y: 80 },
        elevation_ft: 0,
        placement: { mode: "unhosted_family", family_name: "Heat Recovery Unit", type_name: "HRU" }
      }
    ]
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
  assert.deepEqual(result.compiled_plan.actions[1]?.dry_run_body?.instances, [{
    x: 102,
    y: 202,
    z: 32,
    coordinateMode: "absolute_model"
  }]);
});

test("registered plumbing pixels preserve domestic hot-water return without coercing it to hot water", async () => {
  const input = plumbingInput();
  const route = input.observations[0];
  if (route?.kind !== "pipe_route") assert.fail("plumbing route fixture invalid");
  route.service = "domestic_hot_water_return";
  route.system_type = "Domestic Hot Water Recirc";
  route.pipe_size = "3/4 inch";
  input.observations = [route];

  const compiled = await compileRegisteredMepObservations(input);
  assert.equal(compiled.compiled_plan.status, "ready");
  assert.equal(compiled.converted_package.observations[0]?.kind, "pipe_route");
  assert.equal(compiled.converted_package.observations[0]?.service, "domestic_hot_water_return");
  assert.equal(compiled.compiled_plan.actions[0]?.dry_run_body?.systemType, "Domestic Hot Water Recirc");
  assert.equal(compiled.compiled_plan.actions[0]?.dry_run_body?.pipeSize, "3/4 inch");
});

test("registered plumbing pixels preserve unreadable sizes and connectorless fixtures as plan-only drafting evidence", async () => {
  const input = plumbingInput();
  const route = input.observations[0];
  const fixture = input.observations[1];
  if (route?.kind !== "pipe_route" || route.geometry_mode === "native_connector_bridge"
    || route.geometry_mode === "created_route_connector_bridge") throw new Error("route_setup_failed");
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  delete route.pipe_size;
  route.pipe_size_policy = "unresolved_placeholder";
  route.supported_attributes = route.supported_attributes.filter((attribute) => attribute !== "size");
  route.attribute_evidence = route.attribute_evidence.filter((entry) => entry.attribute !== "size");
  fixture.service_connection_mode = "plan_proximity";
  fixture.service_route_connections = [{
    route_observation_id: route.observation_id,
    route_endpoint: "nearest_plan_segment",
    maximum_plan_distance_ft: 1
  }];

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families"
  ]);
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.sizePolicy, "placeholder_allowed");
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.pipeSize, undefined);
  assert.match(result.compiled_plan.warnings.join("\n"), /one-inch drafting placeholder/i);
  assert.match(result.usage_constraints.join("\n"), /no native connection action/i);
});

test("registered plumbing branch pixels compile an atomic tee from a shared main", async () => {
  const input = plumbingInput();
  input.observations.push({
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "cold-branch-random-73",
    geometry_mode: "source_branch_tee",
    main_route_observation_id: "cold-route-random-81",
    visibility: "clear",
    confidence: 0.97,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "1/2 inch branch label is legible" },
      { attribute: "elevation", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "9 foot elevation note applies to this branch" },
      { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "cold-water line convention is visible" },
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "copper pipe note applies to the branch" }
    ],
    service: "domestic_cold_water",
    pixel_points: [{ x: 50, y: 80 }, { x: 50, y: 60 }],
    pipe_size: "1/2 inch",
    pipe_type: "Copper",
    system_type: "Domestic Cold Water",
    elevation_ft: 9,
    tee_family_name: "Tee - Generic",
    tee_type_name: "Standard"
  });
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.action_key), [
    "route:cold-route-random-81",
    "place:fixture-random-42",
    "route:cold-branch-random-73",
    "connect:fixture-random-42:cold-route-random-81"
  ]);
  const branch = result.compiled_plan.actions[2]!;
  assert.equal(branch.path, "/revit/connect-mep-branch");
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 105, y: 202, z: 41 },
    { x: 105, y: 204, z: 41 }
  ]);
  assert.deepEqual(branch.deferred_body?.main_element, {
    created_by_action: "route:cold-route-random-81",
    output: "route_segment",
    index: 0
  });
});

test("registered mechanical pixels compile duct routing and equipment placement without plumbing coercion", async () => {
  const result = await compileRegisteredMepObservations(mechanicalInput());
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families"
  ]);
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.kind, "duct");
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.ductSize, "8 inch");
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.ductType, "Round Duct");
  assert.deepEqual(result.compiled_plan.actions[0]?.apply_body?.points, [
    { x: 102, y: 202, z: 42 },
    { x: 108, y: 202, z: 42 }
  ]);
  assert.equal(result.compiled_plan.plan_elements[0]?.category, "OST_DuctCurves");
  assert.equal(result.compiled_plan.plan_elements[1]?.category, "OST_MechanicalEquipment");
  assert.match(result.compiled_plan.warnings.join("\n"), /elevation inferred by declared heuristic/);
});

test("registered mechanical hydronic pixels compile exact heating supply and return pipe systems", async () => {
  const input = mechanicalInput();
  input.fixture_id = "registered-mechanical-hydronic-independent-v1";
  input.visible_evidence.push({ role: "native_model_inventory", sha256: "f".repeat(64) });
  input.observations = [
    {
      kind: "pipe_route",
      discipline: "mechanical",
      observation_id: "heating-supply-random-51",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "size", "elevation", "system", "type", "workset"],
      attribute_evidence: [
        { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "3/4 inch label applies to the selected solid run" },
        { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "No elevation is shown in plan; assume 10 feet above the level in the plenum." },
        { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "HS label identifies the solid heating supply run" },
        { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "project pipe-type note applies to the selected run" },
        { attribute: "workset", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "retained hydronic routes use the mechanical piping workset" }
      ],
      service: "heating_hot_water_supply",
      pixel_points: [{ x: 20, y: 70 }, { x: 80, y: 70 }],
      pipe_size: "3/4 inch",
      pipe_type: "Small Radius Elbows",
      system_type: "Heating Hot Water Supply",
      workset_name: "MECH-PIPING",
      elevation_ft: 10
    },
    {
      kind: "pipe_route",
      discipline: "mechanical",
      observation_id: "heating-return-random-62",
      visibility: "clear",
      confidence: 0.98,
      supported_attributes: ["location", "size", "elevation", "system", "type", "workset"],
      attribute_evidence: [
        { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "3/4 inch label applies to the selected dashed run" },
        { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "No elevation is shown in plan; assume 10 feet above the level in the plenum." },
        { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "HR label identifies the dashed heating return run" },
        { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "project pipe-type note applies to the selected run" },
        { attribute: "workset", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "retained hydronic routes use the mechanical piping workset" }
      ],
      service: "heating_hot_water_return",
      pixel_points: [{ x: 20, y: 80 }, { x: 80, y: 80 }],
      pipe_size: "3/4 inch",
      pipe_type: "Small Radius Elbows",
      system_type: "Heating Hot Water Return",
      workset_name: "MECH-PIPING",
      elevation_ft: 10
    }
  ];
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.apply_body?.kind), ["pipe", "pipe"]);
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.apply_body?.systemType), [
    "Heating Hot Water Supply",
    "Heating Hot Water Return"
  ]);
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.apply_body?.worksetName), ["MECH-PIPING", "MECH-PIPING"]);
  assert.deepEqual(result.compiled_plan.plan_elements.map((entry) => entry.discipline), ["mechanical", "mechanical"]);
});

test("registered electrical linework compiles a source-grounded native conduit route", async () => {
  const result = await compileRegisteredMepObservations(electricalConduitInput());
  assert.equal(result.compiled_plan.status, "ready");
  assert.equal(result.compiled_plan.actions.length, 1);
  const route = result.compiled_plan.actions[0];
  assert.equal(route?.path, "/revit/mep-route-workflow");
  assert.equal(route?.apply_body?.kind, "conduit");
  assert.equal(route?.apply_body?.diameter, "1 inch");
  assert.equal(route?.apply_body?.conduitType, "EMT");
  assert.equal(route?.apply_body?.conduitTypeId, 4242);
  assert.equal(route?.apply_body?.sizePolicy, "explicit_required");
  assert.deepEqual(route?.apply_body?.points, [
    { x: 102, y: 202, z: 42 },
    { x: 105, y: 202, z: 42 },
    { x: 105, y: 204, z: 42 }
  ]);
  assert.equal(result.compiled_plan.plan_elements[0]?.category, "OST_Conduit");
  assert.match(result.compiled_plan.plan_elements[0]?.assumptions.join("\n") ?? "", /does not establish panel association, circuit membership, or endpoint connectivity/);
  assert.match(result.usage_constraints.join("\n"), /never establishes panel association, circuit membership, or endpoint connectivity/);
  assert.match(result.compiled_plan.warnings.join("\n"), /elevation inferred by declared heuristic/);
});

test("registered top-left pixels round-trip through reflected registration", async () => {
  const input = electricalConduitInput();
  input.registration = {
    source_evidence_sha256: SOURCE_HASH,
    allow_reflection: true,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 100, y: 210 } },
      { source: { x: 100, y: 0 }, model: { x: 200, y: 210 } },
      { source: { x: 0, y: 100 }, model: { x: 100, y: 110 } }
    ],
    max_rms_error_ft: 0.001,
    max_point_error_ft: 0.001
  };
  input.frame = { model_bounds: { min: { x: 100, y: 110 }, max: { x: 200, y: 210 } } };
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.registration.reflection_applied, true);
  assert.deepEqual(result.compiled_plan.actions[0]?.apply_body?.points, [
    { x: 120, y: 130, z: 42 },
    { x: 150, y: 130, z: 42 },
    { x: 150, y: 150, z: 42 }
  ]);
});

test("conduit proximity to a panel label cannot substitute for service evidence", async () => {
  const unresolved = electricalConduitInput();
  const route = unresolved.observations[0];
  if (route?.kind !== "conduit_route") throw new Error("fixture_setup_failed");
  route.supported_attributes = route.supported_attributes.filter((attribute) => attribute !== "system");
  route.attribute_evidence = route.attribute_evidence.filter((claim) => claim.attribute !== "system");
  const result = await compileRegisteredMepObservations(unresolved);
  assert.equal(result.compiled_plan.status, "clarification_required");
  assert.equal(result.compiled_plan.actions.length, 0);
  assert.ok(result.compiled_plan.ambiguities[0]?.material_attributes?.includes("system"));

  const unsupported = electricalConduitInput();
  const unsupportedRoute = unsupported.observations[0];
  if (unsupportedRoute?.kind !== "conduit_route") throw new Error("fixture_setup_failed");
  unsupportedRoute.attribute_evidence = unsupportedRoute.attribute_evidence.filter((claim) => claim.attribute !== "system");
  await assert.rejects(
    () => compileRegisteredMepObservations(unsupported),
    /supported_attribute_lacks_evidence:system/
  );
});

test("unclassified conduit can preserve plan geometry with a non-scored size placeholder", async () => {
  const input = electricalConduitInput();
  const route = input.observations[0];
  if (route?.kind !== "conduit_route") throw new Error("fixture_setup_failed");
  route.service = "unclassified";
  route.conduit_size_policy = "unresolved_placeholder";
  delete route.conduit_size;
  route.supported_attributes = route.supported_attributes.filter((attribute) => !["size", "system"].includes(attribute));
  route.attribute_evidence = route.attribute_evidence.filter((claim) => !["size", "system"].includes(claim.attribute));

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.equal(result.compiled_plan.actions.length, 1);
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.sizePolicy, "placeholder_allowed");
  assert.equal(result.compiled_plan.actions[0]?.apply_body?.diameter, undefined);
  assert.match(result.compiled_plan.plan_elements[0]?.assumptions.join("\n") ?? "", /one-inch drafting placeholder/);
  assert.match(result.compiled_plan.warnings.join("\n"), /size receives no source-evidence credit/);
  assert.match(result.usage_constraints.join("\n"), /cannot establish feeder, panel, or circuit meaning/);
});

test("registered air terminal pixels can target an explicit segment of a newly drafted duct route", async () => {
  const input = mechanicalInput();
  input.observations.push({
    kind: "air_terminal",
    discipline: "mechanical",
    observation_id: "supply-grille-random-41",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "type", "host", "airflow", "workset"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "supply grille symbol and type note at the selected pixel" },
      { attribute: "host", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "grille center lies on the selected outside-air route segment" },
      { attribute: "airflow", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "140 CFM is legible beside the selected grille" },
      { attribute: "workset", basis: "user_direction", evidence_role: "registered_source_render", reference: "Place reconstructed mechanical elements on MECH-T-01." }
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
      route_observation_id: "outside-air-route-random-63",
      route_segment_index: 0
    }
  });
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  const terminalAction = result.compiled_plan.actions[2]!;
  assert.equal(terminalAction.action_key, "place:supply-grille-random-41");
  assert.deepEqual(terminalAction.depends_on, ["route:outside-air-route-random-63"]);
  assert.deepEqual(terminalAction.deferred_body?.host_element, {
    created_by_action: "route:outside-air-route-random-63",
    output: "route_segment",
    index: 0
  });
  assert.deepEqual(terminalAction.expected_model_point, { x: 105, y: 202, z: 42 });
  assert.equal(terminalAction.apply_body?.worksetName, "MECH-T-01");
  assert.deepEqual(terminalAction.apply_body?.instances, [{
    x: 105,
    y: 202,
    z: 42,
    coordinateMode: "absolute_model",
    parameters: { Flow: String(140 / 60) }
  }]);
});

test("registered air terminal branch pixels compile a tee branch and terminal connection without hidden geometry", async () => {
  const input = mechanicalInput();
  input.observations.push({
    kind: "air_terminal",
    discipline: "mechanical",
    observation_id: "supply-grille-branch-random-17",
    visibility: "clear",
    confidence: 0.95,
    supported_attributes: ["location", "type", "host"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "supply grille symbol and keyed type are legible" },
      { attribute: "host", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "branch centerline visibly joins the selected duct segment and grille" }
    ],
    role: "supply grille",
    pixel_point: { x: 50, y: 60 },
    elevation_ft: 10,
    placement: {
      mode: "created_route_branch",
      family_name: "M_Supply Grille",
      type_name: "16x4 Connection 8 Diameter",
      route_observation_id: "outside-air-route-random-63",
      route_segment_index: 0,
      pixel_branch_points: [{ x: 50, y: 80 }, { x: 50, y: 60 }],
      branch_size: "16x4",
      tee_family_name: "Rectangular Tee",
      tee_type_name: "Standard"
    }
  });
  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.action_key), [
    "route:outside-air-route-random-63",
    "place:hru-random-28",
    "place:supply-grille-branch-random-17",
    "branch:supply-grille-branch-random-17",
    "connect:supply-grille-branch-random-17"
  ]);
  const branch = result.compiled_plan.actions[3]!;
  assert.deepEqual(branch.apply_body?.branchPoints, [
    { x: 105, y: 202, z: 42 },
    { x: 105, y: 204, z: 42 }
  ]);
  assert.deepEqual(result.converted_package.observations[2]?.kind === "air_terminal"
    && result.converted_package.observations[2].placement.mode === "created_route_branch"
    ? result.converted_package.observations[2].placement.branch_points
    : null, [
    { x: 5, y: 2 },
    { x: 5, y: 4 }
  ]);
  assert.equal(result.compiled_plan.actions[4]?.path, "/revit/connect-mep-elements");
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

test("registered fixture pixels compose with a concealed bridge to a created route endpoint", async () => {
  const input = plumbingInput();
  const nativeHash = "d".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: nativeHash });
  input.observations.splice(1, 0, {
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: "created-route-cold-bridge-19",
    evidence_role: "native_model_inventory",
    visibility: "occluded",
    confidence: 0.98,
    supported_attributes: ["location", "size", "elevation", "system", "type"],
    attribute_evidence: [
      { attribute: "location", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "runtime fixture and created-route connectors" },
      { attribute: "size", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "matching native half-inch connectors" },
      { attribute: "elevation", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "runtime connector elevations" },
      { attribute: "system", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "native Domestic Cold Water connectors" },
      { attribute: "type", basis: "native_model_precedent", evidence_role: "native_model_inventory", reference: "project pipe type" }
    ],
    service: "domestic_cold_water",
    geometry_mode: "created_route_connector_bridge",
    source_fixture_observation_id: "fixture-random-42",
    target_route_observation_id: "cold-route-random-81",
    target_route_endpoint: "end",
    maximum_length_ft: 3,
    pipe_size: "1/2 inch",
    pipe_type: "Copper",
    system_type: "Domestic Cold Water"
  });
  const fixture = input.observations[2];
  if (fixture?.kind !== "plumbing_fixture") throw new Error("fixture_setup_failed");
  fixture.service_route_connections = [{ route_observation_id: "created-route-cold-bridge-19", route_endpoint: "native_source" }];
  fixture.service_boundary = {
    basis: "native_model_precedent",
    evidence_role: "native_model_inventory",
    required_services: ["domestic_cold_water"],
    prohibited_services: ["domestic_hot_water"]
  };

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.deepEqual(result.compiled_plan.actions.map((entry) => entry.path), [
    "/revit/mep-route-workflow",
    "/revit/place-families",
    "/revit/create-pipe-between-connectors"
  ]);
  assert.deepEqual(result.compiled_plan.actions[2]?.deferred_body?.target_element, {
    created_by_action: "route:cold-route-random-81",
    output: "route_end"
  });
  assert.match(result.usage_constraints.join("\n"), /created_route_connector_bridge/);
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
  await assert.rejects(() => compileRegisteredMepObservations(input), /declared_heuristic_only_allowed_for_route_elevation/);
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
    supported_attributes: ["location", "type", "panel name"],
    attribute_evidence: [
      { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "panelboard symbol and tag are legible at the selected pixel" },
      { attribute: "panel name", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "P431 panel tag is legible at the selected pixel" }
    ],
    role: "panelboard",
    panel_name: "P431",
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
  assert.deepEqual(result.compiled_plan.actions[0]?.apply_body?.instances, [{
    x: 104.5,
    y: 204.5,
    z: 36,
    coordinateMode: "absolute_model",
    parameters: { "Panel Name": "P431" }
  }]);
});

test("registered electrical pixels compile an exact loaded family type onto a hash-bound native wall host", async () => {
  const input = electricalInput();
  const hostHash = "b".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: hostHash });
  input.native_element_references = [{
    reference_key: "room404-west-wall",
    element_id: 1313708,
    category: "OST_Walls",
    role: "Room 404 west wall host",
    evidence_role: "native_model_inventory",
    evidence_sha256: hostHash
  }];
  const device = input.observations[0];
  if (!device || device.kind !== "electrical_device") throw new Error("fixture_setup_failed");
  device.supported_attributes.push("host");
  device.attribute_evidence.push({
    attribute: "host",
    basis: "native_model_precedent",
    evidence_role: "native_model_inventory",
    reference: "Exact Room 404 wall host resolved from the active target model."
  });
  device.supported_attributes.push("instance parameters");
  device.attribute_evidence.push({
    attribute: "instance parameters",
    basis: "legible_source_evidence",
    evidence_role: "registered_source_render",
    reference: "The source plan prints GFI and +54 inches beside the receptacle symbol."
  });
  device.instance_parameters = { "Receptacle Label": "GFI", "Counter 54in": "1" };
  device.supported_attributes.push("spatial membership");
  device.attribute_evidence.push({
    attribute: "spatial membership",
    basis: "legible_source_evidence",
    evidence_role: "registered_source_render",
    reference: "The device symbol is visibly outside the target room boundary but inside the registered crop."
  });
  device.placement = {
    mode: "hosted_family_symbol",
    family_name: "Receptacle A",
    type_name: "Duplex B",
    host_reference_key: "room404-west-wall",
    host_category: "OST_Walls",
    require_room_membership_validation: false
  };

  const result = await compileRegisteredMepObservations(input);
  assert.equal(result.compiled_plan.status, "ready");
  assert.equal(result.compiled_plan.actions[0]?.path, "/revit/place-family-instance-on-host");
  assert.equal(result.compiled_plan.actions[0]?.dry_run_body?.hostElementId, 1313708);
  assert.equal(result.compiled_plan.actions[0]?.dry_run_body?.familyName, "Receptacle A");
  assert.deepEqual(result.compiled_plan.actions[0]?.dry_run_body?.parameterOverrides, {
    "Receptacle Label": "GFI",
    "Counter 54in": "1"
  });
  assert.equal(Object.hasOwn(result.compiled_plan.actions[0]?.dry_run_body ?? {}, "sourceElementId"), false);
  assert.equal(Object.hasOwn(result.compiled_plan.actions[0]?.dry_run_body ?? {}, "roomNumber"), false);
});

test("registered hosted observations cannot disable room validation without explicit spatial-membership evidence", async () => {
  const input = electricalInput();
  const hostHash = "b".repeat(64);
  input.visible_evidence.push({ role: "native_model_inventory", sha256: hostHash });
  input.native_element_references = [{
    reference_key: "room404-west-wall",
    element_id: 1313708,
    category: "OST_Walls",
    role: "Room 404 west wall host",
    evidence_role: "native_model_inventory",
    evidence_sha256: hostHash
  }];
  const device = input.observations[0];
  if (!device || device.kind !== "electrical_device") throw new Error("fixture_setup_failed");
  device.supported_attributes.push("host");
  device.attribute_evidence.push({
    attribute: "host",
    basis: "native_model_precedent",
    evidence_role: "native_model_inventory",
    reference: "Exact Room 404 wall host resolved from the active target model."
  });
  device.placement = {
    mode: "hosted_family_symbol",
    family_name: "Receptacle A",
    type_name: "Duplex B",
    host_reference_key: "room404-west-wall",
    host_category: "OST_Walls",
    require_room_membership_validation: false
  };

  await assert.rejects(
    compileRegisteredMepObservations(input),
    /adjacent_scope_requires_spatial_membership_support/
  );
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
  if (outsideRoute?.kind !== "pipe_route"
    || outsideRoute.geometry_mode === "native_connector_bridge"
    || outsideRoute.geometry_mode === "created_route_connector_bridge") throw new Error("fixture_setup_failed");
  outsideRoute.pixel_points[1] = { x: 101, y: 80 };
  await assert.rejects(() => compileRegisteredMepObservations(outside), /outside_registered_render/);

  const degenerate = plumbingInput();
  const degenerateRoute = degenerate.observations[0];
  if (degenerateRoute?.kind !== "pipe_route"
    || degenerateRoute.geometry_mode === "native_connector_bridge"
    || degenerateRoute.geometry_mode === "created_route_connector_bridge") throw new Error("fixture_setup_failed");
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
