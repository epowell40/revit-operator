import assert from "node:assert/strict";
import test from "node:test";
import type { ExistingConditionsGroundTruth } from "../src/benchmark/existing_conditions_reconstruction.js";
import {
  compileArchitecturalPlanGeometryPreview,
  type ArchitecturalPlanGeometryPreviewPackage
} from "../src/existing_conditions/architectural_plan_geometry_preview.js";
import { scoreArchitecturalPlanGeometryPreview } from "../src/existing_conditions/architectural_plan_geometry_score.js";

const SOURCE_HASH = "7".repeat(64);

function truth(): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "plan-geometry-score-independent-v1",
    scope_id: "unseen-origin-88",
    discipline: "architectural",
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    snapshot: {
      native_readback: true,
      elements: [
        {
          key: "truth-wall-a",
          kind: "linear_element",
          discipline: "architectural",
          role: "wall",
          category: "Walls",
          endpoints: [{ x: 0, y: 0, z: 30 }, { x: 10, y: 0, z: 30 }]
        },
        {
          key: "truth-wall-b",
          kind: "linear_element",
          discipline: "architectural",
          role: "wall",
          category: "Walls",
          endpoints: [{ x: 10, y: 0, z: 30 }, { x: 10, y: 8, z: 30 }]
        },
        {
          key: "truth-door-a",
          kind: "family_instance",
          discipline: "architectural",
          role: "door",
          category: "Doors",
          location: { x: 4, y: 0, z: 30 },
          host_key: "truth-wall-a"
        },
        {
          key: "truth-window-a",
          kind: "family_instance",
          discipline: "architectural",
          role: "window",
          category: "Windows",
          location: { x: 10, y: 4, z: 30 },
          host_key: "truth-wall-b"
        }
      ],
      connections: [
        { a: "truth-wall-a", b: "truth-wall-b", kind: "wall_junction" },
        { a: "truth-door-a", b: "truth-wall-a", kind: "host" },
        { a: "truth-window-a", b: "truth-wall-b", kind: "host" }
      ],
      open_connector_count: 0
    }
  };
}

function previewInput(): ArchitecturalPlanGeometryPreviewPackage {
  return {
    schema_version: 1,
    fixture_id: "plan-geometry-score-independent-v1",
    scope_id: "unseen-origin-88",
    source_evidence_sha256: SOURCE_HASH,
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    registration: {
      source_evidence_sha256: SOURCE_HASH,
      control_points: [
        { source: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
        { source: { x: 10, y: 0 }, model: { x: 10, y: 0 } },
        { source: { x: 0, y: 10 }, model: { x: 0, y: 10 } }
      ]
    },
    level_name: "L3",
    level_elevation_ft: 30,
    maximum_created_elements: 8,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "preview-wall-random-9",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location"],
        points: [{ x: 10, y: 0 }, { x: 0, y: 0 }]
      },
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "preview-wall-random-2",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location"],
        points: [{ x: 10, y: 8 }, { x: 10, y: 0 }]
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "preview-door-random-4",
        visibility: "clear",
        confidence: 0.94,
        supported_attributes: ["location", "host"],
        point: { x: 4, y: 0 },
        host_wall_observation_id: "preview-wall-random-9"
      },
      {
        kind: "window",
        discipline: "architectural",
        observation_id: "preview-window-random-7",
        visibility: "clear",
        confidence: 0.93,
        supported_attributes: ["location", "host"],
        point: { x: 10, y: 4 },
        host_wall_observation_id: "preview-wall-random-2"
      }
    ]
  };
}

test("geometry-only evaluator accepts identity-perturbed reversed walls and hosted openings without material defaults", () => {
  const preview = compileArchitecturalPlanGeometryPreview(previewInput());
  const score = scoreArchitecturalPlanGeometryPreview(truth(), preview);
  assert.equal(preview.status, "preview_ready");
  assert.equal(preview.preview_elements.every((entry) => entry.unresolved_attributes.length > 0), true);
  assert.equal(score.valid_run, true);
  assert.equal(score.passed, true);
  assert.equal(score.score, 100);
  assert.deepEqual(score.counts, {
    truth: 4,
    preview: 4,
    matched: 4,
    missed: 0,
    false_positive: 0,
    ungrounded_preview: 0
  });
  assert.equal(score.metrics.wall_topology, 1);
  assert.equal(score.metrics.hosting, 1);
});

test("geometry-only evaluator rejects a plausible but wrong bounding rectangle instead of rewarding confidence", () => {
  const input = previewInput();
  const first = input.observations[0];
  const second = input.observations[1];
  if (first?.kind !== "wall" || second?.kind !== "wall") throw new Error("fixture_walls_missing");
  first.points = [{ x: -6, y: -6 }, { x: 16, y: -6 }];
  second.points = [{ x: 16, y: -6 }, { x: 16, y: 14 }];
  const door = input.observations[2];
  const window = input.observations[3];
  if (door?.kind !== "door" || window?.kind !== "window") throw new Error("fixture_openings_missing");
  door.point = { x: 4, y: -6 };
  window.point = { x: 16, y: 4 };
  const score = scoreArchitecturalPlanGeometryPreview(truth(), compileArchitecturalPlanGeometryPreview(input));
  assert.equal(score.valid_run, true);
  assert.equal(score.passed, false);
  assert.equal(score.counts.matched, 0);
  assert.equal(score.counts.missed, 4);
  assert.equal(score.counts.false_positive, 4);
  assert.equal(score.failure_classifications.includes("plan_geometry_mismatch"), true);
});

test("geometry-only evaluator reports missing openings and host topology independently from correct walls", () => {
  const input = previewInput();
  input.observations = input.observations.slice(0, 2);
  const score = scoreArchitecturalPlanGeometryPreview(truth(), compileArchitecturalPlanGeometryPreview(input));
  assert.equal(score.valid_run, true);
  assert.equal(score.passed, false);
  assert.equal(score.counts.matched, 2);
  assert.equal(score.metrics.precision, 1);
  assert.equal(score.metrics.recall, 0.5);
  assert.equal(score.metrics.wall_topology, 1);
  assert.equal(score.metrics.hosting, 0);
  assert.equal(score.failure_classifications.includes("plan_opening_hosting_mismatch"), true);
});

test("geometry-only evaluator invalidates previews that are not registration-grounded and preview-ready", () => {
  const input = previewInput();
  input.observations[0]!.visibility = "partial";
  input.observations[0]!.confidence = 0.8;
  const score = scoreArchitecturalPlanGeometryPreview(truth(), compileArchitecturalPlanGeometryPreview(input));
  assert.equal(score.valid_run, false);
  assert.equal(score.passed, false);
  assert.equal(score.invalid_reasons.includes("preview_not_ready:clarification_required"), true);
  assert.equal(score.invalid_reasons.includes("ungrounded_preview_geometry"), true);
});
