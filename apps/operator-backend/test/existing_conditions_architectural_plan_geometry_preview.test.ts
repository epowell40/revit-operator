import assert from "node:assert/strict";
import test from "node:test";
import {
  compileArchitecturalPlanGeometryPreview,
  promoteArchitecturalPlanGeometryPreview,
  type ArchitecturalPlanGeometryPreviewPackage,
  type ArchitecturalPlanGeometryResolution
} from "../src/existing_conditions/architectural_plan_geometry_preview.js";

const SOURCE_HASH = "f".repeat(64);

function previewPackage(): ArchitecturalPlanGeometryPreviewPackage {
  return {
    schema_version: 1,
    fixture_id: "architectural-preview-independent-v1",
    scope_id: "unseen-suite-73",
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
    level_name: "Independent L4",
    level_elevation_ft: 32,
    geometry_confidence_threshold: 0.75,
    material_confidence_threshold: 0.85,
    maximum_created_elements: 8,
    observations: [
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-preview-alpha",
        visibility: "clear",
        confidence: 0.98,
        supported_attributes: ["location", "type"],
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }],
        wall_type_name: "Interior - 4 7/8 inch Partition"
      },
      {
        kind: "wall",
        discipline: "architectural",
        observation_id: "wall-preview-beta",
        visibility: "clear",
        confidence: 0.97,
        supported_attributes: ["location"],
        points: [{ x: 8, y: 0 }, { x: 8, y: 6 }]
      },
      {
        kind: "door",
        discipline: "architectural",
        observation_id: "door-preview-gamma",
        visibility: "clear",
        confidence: 0.96,
        supported_attributes: ["location", "host", "width"],
        point: { x: 3, y: 0 },
        host_wall_observation_id: "wall-preview-alpha",
        width_ft: 3
      },
      {
        kind: "window",
        discipline: "architectural",
        observation_id: "window-preview-delta",
        visibility: "clear",
        confidence: 0.95,
        supported_attributes: ["location", "host", "width"],
        point: { x: 6, y: 0 },
        host_wall_observation_id: "wall-preview-alpha",
        width_ft: 2
      }
    ]
  };
}

function promotionResolutions(): ArchitecturalPlanGeometryResolution[] {
  return [
    {
      observation_id: "wall-preview-alpha",
      attributes: [
        { attribute: "thickness", value: 4.875 / 12, basis: "project_precedent", evidence_reference: "approved_type_catalog:wall-1279096" },
        { attribute: "height", value: 10, basis: "project_precedent", evidence_reference: "analog-wall-readback:independent-11" }
      ]
    },
    {
      observation_id: "wall-preview-beta",
      attributes: [
        { attribute: "type", value: "Interior - 4 7/8 inch Partition", basis: "project_precedent", evidence_reference: "approved_type_catalog:wall-1279096" },
        { attribute: "thickness", value: 4.875 / 12, basis: "project_precedent", evidence_reference: "approved_type_catalog:wall-1279096" },
        { attribute: "height", value: 10, basis: "project_precedent", evidence_reference: "analog-wall-readback:independent-11" }
      ]
    },
    {
      observation_id: "door-preview-gamma",
      attributes: [
        { attribute: "family", value: "Single-Flush", basis: "project_precedent", evidence_reference: "approved_type_catalog:door-2091085" },
        { attribute: "type", value: "36 x 84", basis: "project_precedent", evidence_reference: "approved_type_catalog:door-2091085" },
        { attribute: "height", value: 7, basis: "project_precedent", evidence_reference: "approved_type_catalog:door-2091085" }
      ]
    },
    {
      observation_id: "window-preview-delta",
      attributes: [
        { attribute: "family", value: "Fixed", basis: "user_direction", evidence_reference: "clarification:window-family" },
        { attribute: "type", value: "24 x 48", basis: "user_direction", evidence_reference: "clarification:window-type" },
        { attribute: "height", value: 4, basis: "legible_source_evidence", evidence_reference: "elevation:A401:detail-3" },
        { attribute: "sill height", value: 3, basis: "legible_source_evidence", evidence_reference: "elevation:A401:detail-3" }
      ]
    }
  ];
}

test("plan geometry preview transforms supported walls and hosted opening centers without inventing vertical or type values", () => {
  const preview = compileArchitecturalPlanGeometryPreview(previewPackage());
  assert.equal(preview.status, "preview_ready");
  assert.equal(preview.native_action, null);
  assert.equal(preview.geometry_ambiguities.length, 0);
  assert.equal(preview.promotion_ambiguities.length, 4);
  assert.match(preview.promotion_question ?? "", /material completion/);
  const wall = preview.preview_elements[0]!;
  const door = preview.preview_elements[2]!;
  assert.deepEqual(wall.geometry.points, [{ x: 100, y: 200 }, { x: 100, y: 216 }]);
  assert.deepEqual(wall.resolved_attributes, { type: "Interior - 4 7/8 inch Partition" });
  assert.deepEqual([...wall.unresolved_attributes].sort(), ["height", "thickness"]);
  assert.deepEqual(door.geometry.point, { x: 100, y: 206 });
  assert.equal(door.geometry.host_wall_observation_id, "wall-preview-alpha");
  assert.equal(door.geometry.chainage_ft, 6);
  assert.equal(door.resolved_attributes.width, 3);
  assert.deepEqual([...door.unresolved_attributes].sort(), ["family", "height", "type"]);
  assert.equal(door.native_write_eligible, false);
  assert.deepEqual(preview.wall_junctions, [{
    a_wall_observation_id: "wall-preview-alpha",
    b_wall_observation_id: "wall-preview-beta"
  }]);
});

test("preview fails closed on ungrounded or low-confidence plan geometry while keeping material ambiguity separate", () => {
  const input = previewPackage();
  input.observations[2]!.supported_attributes = ["location", "width"];
  input.observations[3]!.visibility = "partial";
  input.observations[3]!.confidence = 0.8;
  const preview = compileArchitecturalPlanGeometryPreview(input);
  assert.equal(preview.status, "clarification_required");
  assert.equal(preview.geometry_ambiguities.length, 2);
  assert.match(preview.clarification_question ?? "", /door-preview-gamma plan geometry/);
  assert.match(preview.clarification_question ?? "", /window-preview-delta plan geometry/);
  assert.equal(preview.native_action, null);
});

test("preview blocks transformed coordinates when registration residuals exceed the declared limit", () => {
  const input = previewPackage();
  input.registration.control_points.push({ source: { x: 10, y: 10 }, model: { x: 81, y: 220 } });
  input.registration.max_rms_error_ft = 0.05;
  input.registration.max_point_error_ft = 0.1;
  const preview = compileArchitecturalPlanGeometryPreview(input);
  assert.equal(preview.status, "blocked");
  assert.match(preview.blockers[0] ?? "", /registration_error_exceeds_limit/);
  assert.equal(preview.preview_elements.every((entry) => entry.geometry_grounded === false), true);
});

test("preview rejects hidden material values that the source observation does not claim to support", () => {
  const input = previewPackage();
  const wall = input.observations[1];
  if (wall?.kind !== "wall") throw new Error("fixture_wall_missing");
  wall.height_ft = 10;
  assert.throws(
    () => compileArchitecturalPlanGeometryPreview(input),
    /wall-preview-beta_height_value_is_not_source_supported/
  );
});

test("preview rejects an opening host that was not independently observed as a wall", () => {
  const input = previewPackage();
  const door = input.observations[2];
  if (door?.kind !== "door") throw new Error("fixture_door_missing");
  door.host_wall_observation_id = "invented-wall";
  assert.throws(() => compileArchitecturalPlanGeometryPreview(input), /references_unknown_host_wall/);
});

test("evidence-backed promotion compiles the same preview into an exact native dry-run without overriding source-supported values", () => {
  const promotion = promoteArchitecturalPlanGeometryPreview(previewPackage(), promotionResolutions());
  assert.equal(promotion.compiled_plan.status, "ready");
  assert.equal(promotion.compiled_plan.action?.path, "/revit/import-zippybim-geometry");
  assert.equal(promotion.compiled_plan.action?.dry_run_body.dryRun, true);
  assert.equal(promotion.compiled_plan.action?.apply_body.requireExactWallTypes, true);
  assert.equal(promotion.resolution_receipts.length, 15);
  const wallType = promotion.resolution_receipts.find((entry) =>
    entry.observation_id === "wall-preview-alpha" && entry.attribute === "type"
  );
  assert.deepEqual(wallType, {
    observation_id: "wall-preview-alpha",
    attribute: "type",
    value: "Interior - 4 7/8 inch Partition",
    basis: "legible_source_evidence",
    evidence_reference: "source_pdf"
  });
  const doorWidth = promotion.resolution_receipts.find((entry) =>
    entry.observation_id === "door-preview-gamma" && entry.attribute === "width"
  );
  assert.equal(doorWidth?.basis, "legible_source_evidence");
  const windowSill = promotion.resolution_receipts.find((entry) =>
    entry.observation_id === "window-preview-delta" && entry.attribute === "sill height"
  );
  assert.equal(windowSill?.basis, "legible_source_evidence");
  const geometry = promotion.compiled_plan.action?.apply_body.geometry as { elements: Array<Record<string, unknown>> };
  assert.deepEqual(geometry.elements[0]?.path, [[100, 200], [100, 216]]);
  assert.equal(geometry.elements[2]?.width, 3);
  assert.equal(geometry.elements[3]?.sillHeight, 3);
});

test("promotion rejects missing provenance, unsupported attributes, and attempts to override source-supported values", () => {
  const missing = promotionResolutions();
  missing[0]!.attributes = missing[0]!.attributes.filter((entry) => entry.attribute !== "height");
  assert.throws(
    () => promoteArchitecturalPlanGeometryPreview(previewPackage(), missing),
    /wall-preview-alpha_promotion_missing_attribute:height/
  );

  const unsupported = promotionResolutions();
  unsupported[0]!.attributes.push({
    attribute: "width",
    value: 3,
    basis: "user_direction",
    evidence_reference: "clarification:invalid"
  });
  assert.throws(
    () => promoteArchitecturalPlanGeometryPreview(previewPackage(), unsupported),
    /promotion_attribute_is_not_applicable:width/
  );

  const override = promotionResolutions();
  override[0]!.attributes.push({
    attribute: "type",
    value: "Invented Wall",
    basis: "user_direction",
    evidence_reference: "clarification:override"
  });
  assert.throws(
    () => promoteArchitecturalPlanGeometryPreview(previewPackage(), override),
    /cannot_override_source_supported_value/
  );
});

test("identity and coordinate perturbation preserve preview topology without replaying source-model IDs or positions", () => {
  const original = compileArchitecturalPlanGeometryPreview(previewPackage());
  const perturbed = previewPackage();
  const remap = new Map([
    ["wall-preview-alpha", "wall-unseen-901"],
    ["wall-preview-beta", "wall-unseen-377"],
    ["door-preview-gamma", "door-unseen-512"],
    ["window-preview-delta", "window-unseen-884"]
  ]);
  for (const observation of perturbed.observations) {
    observation.observation_id = remap.get(observation.observation_id) ?? observation.observation_id;
    if (observation.kind !== "wall") {
      observation.host_wall_observation_id = remap.get(observation.host_wall_observation_id) ?? observation.host_wall_observation_id;
    }
  }
  perturbed.registration.control_points = perturbed.registration.control_points.map((control) => ({
    source: control.source,
    model: { x: control.model.x + 51, y: control.model.y - 23 }
  }));
  const result = compileArchitecturalPlanGeometryPreview(perturbed);
  assert.equal(result.status, "preview_ready");
  assert.notEqual(result.input_fingerprint_sha256, original.input_fingerprint_sha256);
  assert.deepEqual(result.preview_elements.map((entry) => entry.kind), original.preview_elements.map((entry) => entry.kind));
  assert.notDeepEqual(result.preview_elements.map((entry) => entry.plan_key), original.preview_elements.map((entry) => entry.plan_key));
  assert.notDeepEqual(result.preview_elements[0]?.geometry.points, original.preview_elements[0]?.geometry.points);
  assert.equal(result.wall_junctions.length, original.wall_junctions.length);
});
