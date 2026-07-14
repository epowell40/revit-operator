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
  if (outsideRoute?.kind !== "pipe_route") throw new Error("fixture_setup_failed");
  outsideRoute.pixel_points[1] = { x: 101, y: 80 };
  await assert.rejects(() => compileRegisteredMepObservations(outside), /outside_registered_render/);

  const degenerate = plumbingInput();
  const degenerateRoute = degenerate.observations[0];
  if (degenerateRoute?.kind !== "pipe_route") throw new Error("fixture_setup_failed");
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
