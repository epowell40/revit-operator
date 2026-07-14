import assert from "node:assert/strict";
import test from "node:test";
import {
  compileArchitecturalShellPlan,
  type ArchitecturalShellPackage
} from "../src/existing_conditions/architectural_shell_plan.js";

const SOURCE_HASH = "a".repeat(64);

function architecturalPackage(): ArchitecturalShellPackage {
  return {
    schema_version: 1,
    fixture_id: "architectural-shell-independent-v1",
    scope_id: "suite-random-42",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    registration: {
      source_evidence_sha256: SOURCE_HASH,
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 100, y: 200 } },
        { source: { x: 10, y: 0 }, model: { x: 100, y: 220 } },
        { source: { x: 0, y: 10 }, model: { x: 80, y: 200 } }
      ],
      max_rms_error_ft: 0.01
    },
    level_name: "Benchmark L4",
    level_elevation_ft: 32,
    maximum_created_elements: 10,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-random-alpha",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "type", "thickness", "height"],
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }],
        wall_type_name: "Interior - 4 7/8 inch Partition",
        thickness_ft: 4.875 / 12,
        height_ft: 10
      },
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-random-beta",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location", "type", "thickness", "height"],
        points: [{ x: 8, y: 0 }, { x: 11, y: 3 }],
        wall_type_name: "Interior - 4 7/8 inch Partition",
        thickness_ft: 4.875 / 12,
        height_ft: 10
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "door-random-gamma",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "type", "host", "width", "height"],
        point: { x: 3, y: 0 },
        host_wall_observation_id: "wall-random-alpha",
        family_name: "Single-Flush",
        type_name: "36 x 84",
        width_ft: 3,
        height_ft: 7
      },
      {
        kind: "window",
        discipline: "architectural",
        observation_id: "window-random-delta",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "type", "host", "width", "height", "sill height"],
        point: { x: 6, y: 0 },
        host_wall_observation_id: "wall-random-alpha",
        family_name: "Fixed",
        type_name: "24 x 48",
        width_ft: 2,
        height_ft: 4,
        sill_height_ft: 3
      }
    ]
  };
}

test("architectural shell compiles transformed diagonal walls and exact hosted openings", () => {
  const plan = compileArchitecturalShellPlan(architecturalPackage());
  assert.equal(plan.status, "ready");
  assert.equal(plan.action?.path, "/revit/import-zippybim-geometry");
  assert.equal(plan.action?.dry_run_body.dryRun, true);
  assert.equal(plan.action?.apply_body.dryRun, false);
  assert.equal(plan.action?.apply_body.normalizeWallGeometry, false);
  assert.equal(plan.action?.apply_body.requireExactWallTypes, true);
  assert.equal(plan.action?.apply_body.requireExactOpeningTypes, true);
  assert.equal(plan.action?.apply_body.requireSourceWallHosts, true);
  assert.equal(plan.action?.apply_body.requireAllElements, true);
  assert.equal(plan.action?.apply_body.maximumOpeningHostDistanceFeet, 0.5);
  const geometry = plan.action?.apply_body.geometry as { elements: Array<Record<string, unknown>> };
  const alpha = geometry.elements.find((element) => element.id === "wall-random-alpha");
  const beta = geometry.elements.find((element) => element.id === "wall-random-beta");
  const door = geometry.elements.find((element) => element.id === "door-random-gamma");
  const window = geometry.elements.find((element) => element.id === "window-random-delta");
  assert.deepEqual(alpha?.path, [[100, 200], [100, 216]]);
  const betaPath = beta?.path as number[][];
  assert.deepEqual(betaPath[0], [100, 216]);
  assert.ok(Math.abs((betaPath[1]?.[0] ?? 0) - 94) < 1e-9);
  assert.equal(betaPath[1]?.[1], 222);
  assert.equal(door?.hostWallId, "wall-random-alpha");
  assert.equal(door?.chainageFt, 6);
  assert.deepEqual(door?.position, [100, 206]);
  assert.equal(window?.sillHeight, 3);
  assert.deepEqual(plan.wall_junctions, [{
    a_wall_observation_id: "wall-random-alpha",
    b_wall_observation_id: "wall-random-beta"
  }]);
});

test("partial or materially unsupported evidence requires clarification and emits no action", () => {
  const input = architecturalPackage();
  input.observations[2]!.visibility = "partial";
  input.observations[2]!.supported_attributes = ["location", "host"];
  const plan = compileArchitecturalShellPlan(input);
  assert.equal(plan.status, "clarification_required");
  assert.equal(plan.action, null);
  assert.match(plan.clarification_question ?? "", /door door-random-gamma/);
  assert.deepEqual([...(plan.ambiguities[0]?.material_attributes ?? [])].sort(), ["height", "type", "width"]);
});

test("unverified registration blocks architectural writes", () => {
  const input = architecturalPackage();
  input.registration = {
    source_evidence_sha256: SOURCE_HASH,
    control_points: [
      { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
      { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
      { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } },
      { source: { x: 10, y: 10 }, model: { x: 11, y: 10 } }
    ],
    max_rms_error_ft: 0.05,
    max_point_error_ft: 0.1
  };
  const plan = compileArchitecturalShellPlan(input);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.action, null);
  assert.match(plan.blockers[0] ?? "", /registration_error_exceeds_limit/);
});

test("opening must reference a known source wall", () => {
  const input = architecturalPackage();
  const door = input.observations[2];
  if (door?.kind !== "door") throw new Error("fixture_door_missing");
  door.host_wall_observation_id = "invented-wall";
  assert.throws(() => compileArchitecturalShellPlan(input), /references_unknown_host_wall/);
});

test("opening must lie on and fit within its claimed host wall", () => {
  const offHost = architecturalPackage();
  const offHostDoor = offHost.observations[2];
  if (offHostDoor?.kind !== "door") throw new Error("fixture_door_missing");
  offHostDoor.point = { x: 3, y: 2 };
  assert.throws(() => compileArchitecturalShellPlan(offHost), /opening_is_not_on_host_wall/);

  const outside = architecturalPackage();
  const outsideDoor = outside.observations[2];
  if (outsideDoor?.kind !== "door") throw new Error("fixture_door_missing");
  outsideDoor.point = { x: 0.5, y: 0 };
  assert.throws(() => compileArchitecturalShellPlan(outside), /opening_does_not_fit_inside_host_wall/);
});

test("overlapping openings on one wall are rejected", () => {
  const input = architecturalPackage();
  const window = input.observations[3];
  if (window?.kind !== "window") throw new Error("fixture_window_missing");
  window.point = { x: 3.5, y: 0 };
  assert.throws(() => compileArchitecturalShellPlan(input), /architectural_openings_overlap/);
});

test("architectural shell enforces an integer creation budget", () => {
  const input = architecturalPackage();
  input.maximum_created_elements = 4.5;
  assert.throws(() => compileArchitecturalShellPlan(input), /maximum_created_elements_must_be_a_positive_integer/);
});

test("identity and coordinate perturbation preserve action topology without replaying geometry", () => {
  const original = compileArchitecturalShellPlan(architecturalPackage());
  const perturbedInput = architecturalPackage();
  const remap = new Map([
    ["wall-random-alpha", "wall-unseen-901"],
    ["wall-random-beta", "wall-unseen-377"],
    ["door-random-gamma", "door-unseen-512"],
    ["window-random-delta", "window-unseen-884"]
  ]);
  for (const observation of perturbedInput.observations) {
    observation.observation_id = remap.get(observation.observation_id) ?? observation.observation_id;
    if (observation.kind !== "wall") {
      observation.host_wall_observation_id = remap.get(observation.host_wall_observation_id) ?? observation.host_wall_observation_id;
    }
  }
  perturbedInput.registration.control_points = perturbedInput.registration.control_points.map((control) => ({
    source: control.source,
    model: { x: control.model.x + 37, y: control.model.y - 19 }
  }));
  const perturbed = compileArchitecturalShellPlan(perturbedInput);
  assert.equal(perturbed.status, "ready");
  assert.equal(perturbed.action?.path, original.action?.path);
  assert.notEqual(perturbed.input_fingerprint_sha256, original.input_fingerprint_sha256);
  const originalElements = (original.action?.apply_body.geometry as { elements: Array<Record<string, unknown>> }).elements;
  const perturbedElements = (perturbed.action?.apply_body.geometry as { elements: Array<Record<string, unknown>> }).elements;
  assert.deepEqual(perturbedElements.map((element) => element.element), originalElements.map((element) => element.element));
  assert.notDeepEqual(perturbedElements.map((element) => element.id), originalElements.map((element) => element.id));
  assert.notDeepEqual(perturbedElements[0]?.path, originalElements[0]?.path);
  assert.deepEqual(perturbed.wall_junctions.length, original.wall_junctions.length);
});
