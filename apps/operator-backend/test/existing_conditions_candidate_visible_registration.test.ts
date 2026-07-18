import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  compileCandidateVisibleMepReconstruction,
  deriveCandidateVisibleRegistrationGeometry
} from "../src/existing_conditions/candidate_visible_registration.js";
import { executeWorkbenchActions } from "../src/workbench/workbench_runner.js";

const FRAME = {
  frame_id: "frame-visible-1",
  view_id: 42,
  width_px: 1000,
  height_px: 1000,
  top_left_xyz: [100, 200, -400.05] as [number, number, number],
  top_right_xyz: [200, 200, -400.05] as [number, number, number],
  bottom_left_xyz: [100, 100, -400.05] as [number, number, number],
  target_level_elevation_ft: 100
};

const ALIGNMENT = {
  matched: true,
  confidence: 0.92,
  crop: { min_u: 0.25, min_v: 0.25, max_u: 0.75, max_v: 0.75 }
};

function verifiedRoomScope(roomNumber = "100") {
  return {
    room_number: roomNumber,
    source_scoped_id: `loaded-arch-link:${roomNumber}`,
    boundary_model_points: [
      { x: 120, y: 120 },
      { x: 180, y: 120 },
      { x: 180, y: 180 },
      { x: 120, y: 180 }
    ]
  };
}

test("candidate-visible registration composes source pixels through the aligned Revit frame", () => {
  const result = deriveCandidateVisibleRegistrationGeometry({
    alignment: ALIGNMENT,
    frame: FRAME,
    render_width_px: 100,
    render_height_px: 100
  });

  assert.deepEqual(result.control_points, [
    { source: { x: 0, y: 0 }, model: { x: 125, y: 175 } },
    { source: { x: 100, y: 0 }, model: { x: 175, y: 175 } },
    { source: { x: 0, y: 100 }, model: { x: 125, y: 125 } }
  ]);
  assert.deepEqual(result.model_bounds, {
    min: { x: 125, y: 125 },
    max: { x: 175, y: 175 }
  });
});

test("candidate-visible MEP compilation emits a dry-run atomic workflow without planner-authored hashes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-mep-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ncandidate-visible-test\n"));
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 100, 100);
  context.strokeStyle = "#000";
  context.beginPath();
  context.moveTo(10, 50);
  context.lineTo(90, 50);
  context.stroke();
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: verifiedRoomScope(),
    planner_payload: {
      schema_version: 2,
      fixture_id: "candidate-visible-plumbing-v1",
      scope_id: "bounded-room-v1",
      discipline: "plumbing",
      level_name: "Level 1",
      room_number: "100",
      spatial_scope: {
        boundary_pixel_points: [
          { x: 5, y: 40 },
          { x: 95, y: 40 },
          { x: 95, y: 80 },
          { x: 5, y: 80 }
        ],
        anchor_pixel_point: { x: 50, y: 70 },
        anchor_label: "TEST ROOM 100",
        evidence_reference: "Visible TEST ROOM 100 label enclosed by the traced room walls."
      },
      partial_promotion_policy: "defer_ambiguous_observations",
      maximum_observations: 4,
      observations: [
        {
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "cold-water-route-1",
          visibility: "clear",
          confidence: 0.95,
          supported_attributes: ["location", "size", "elevation", "system", "type"],
          attribute_evidence: [
            { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible 1/2 inch route label" },
            { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "Plan omits elevation; use a disclosed 9 foot plenum drafting assumption" },
            { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible domestic cold-water label" },
            { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible copper pipe type note" }
          ],
          service: "domestic_cold_water",
          pixel_points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
          pipe_size: "1/2 inch",
          pipe_type: "Copper",
          system_type: "Domestic Cold Water",
          elevation_ft: 9
        }
      ]
    }
  });

  assert.equal(result.compilation.registration.verified, true);
  assert.equal(result.compilation.compiled_plan.status, "partially_ready");
  assert.equal(result.workflow.dryRun, true);
  assert.equal(result.workflow.verify, true);
  assert.equal(result.workflow.operations.length, 1);
  assert.equal(result.workflow.operations[0]?.path, "/revit/mep-route-workflow");
  assert.equal(result.package.level_elevation_ft, 100);
  assert.equal(result.package.target_view_reference_key, "candidate_visible_aligned_view");
  assert.equal(result.compilation.compiled_plan.target_view_id, 42);
  assert.equal(result.workflow.targetViewId, 42);
  assert.equal(result.workflow.applyTargetViewPhase, true);
  assert.equal(result.workflow.requireAllCreatedElementsVisibleInTargetView, true);
  assert.equal(result.spatial_scope_receipt?.anchor_label, "TEST ROOM 100");
  assert.equal(result.spatial_scope_receipt?.native_room_source_scoped_id, "loaded-arch-link:100");
  assert.deepEqual(result.spatial_scope_receipt?.checked_observation_ids, ["cold-water-route-1"]);
  assert.equal(result.workflow.operations[0]?.apply_body?.viewId, 42);
  assert.equal("levelName" in (result.workflow.operations[0]?.apply_body ?? {}), false);
  assert.deepEqual(result.workflow.operations[0]?.apply_body?.points, [
    { x: 130, y: 150, z: 109 },
    { x: 170, y: 150, z: 109 }
  ]);
  assert.equal(result.package.native_element_references.some((entry) =>
    entry.reference_key === "candidate_visible_aligned_view" &&
    entry.element_id === 42
  ), true);
  assert.equal(result.planner_normalization_warnings.some((entry) =>
    entry.includes("Injected verified target-level elevation 100 ft")
  ), true);
  assert.match(result.package.source_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.match(result.package.registered_render.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.registration_context_id, /^[a-f0-9]{64}$/);
});

test("candidate-visible room scope rejects adjacent geometry and replaces overbroad planner scope with the native projection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-scope-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ncandidate-visible-scope-test\n"));
  const canvas = createCanvas(100, 100);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  const basePayload = {
    schema_version: 2 as const,
    fixture_id: "scope-gate-v1",
    scope_id: "room-100",
    discipline: "plumbing" as const,
    level_name: "Level 1",
    level_elevation_ft: 100,
    room_number: "100",
    spatial_scope: {
      boundary_pixel_points: [
        { x: 5, y: 40 },
        { x: 45, y: 40 },
        { x: 45, y: 90 },
        { x: 5, y: 90 }
      ],
      anchor_pixel_point: { x: 25, y: 70 },
      anchor_label: "SAMPLE ROOM 100",
      evidence_reference: "Visible room label and enclosing wall boundary."
    },
    partial_promotion_policy: "defer_ambiguous_observations" as const,
    maximum_observations: 2
  };
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        ...verifiedRoomScope(),
        boundary_model_points: [
          { x: 120, y: 120 },
          { x: 150, y: 120 },
          { x: 150, y: 180 },
          { x: 120, y: 180 }
        ]
      },
      planner_payload: {
        ...basePayload,
        observations: [{
          kind: "plumbing_fixture",
          discipline: "plumbing",
          observation_id: "adjacent-room-fixture",
          visibility: "clear",
          confidence: 0.9,
          pixel_point: { x: 75, y: 65 },
          role: "source-visible fixture",
          placement: { mode: "provisional_plan_symbol" },
          representation_classification: {
            source_graphic: "mep_connection_symbol",
            native_target: "plan_only_marker"
          },
          service_route_connections: [],
          supported_attributes: ["location", "provisional plan representation", "symbol form"],
          attribute_evidence: []
        } as any]
      }
    }),
    /candidate_visible_point_outside_spatial_scope:adjacent-room-fixture/
  );
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        ...verifiedRoomScope(),
        boundary_model_points: [
          { x: 120, y: 120 },
          { x: 150, y: 120 },
          { x: 150, y: 180 },
          { x: 120, y: 180 }
        ]
      },
      planner_payload: {
        ...basePayload,
        observations: [{
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "adjacent-room-route",
          visibility: "clear",
          confidence: 0.9,
          supported_attributes: ["location", "elevation"],
          attribute_evidence: [{
            attribute: "elevation",
            basis: "declared_heuristic",
            evidence_role: "registered_source_render",
            reference: "Plan omits elevation."
          }],
          service: "unclassified",
          pixel_points: [{ x: 65, y: 55 }, { x: 90, y: 55 }],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any]
      }
    }),
    /candidate_visible_route_outside_spatial_scope:adjacent-room-route:zero_intersection:source_uv_bounds=0\.6500,0\.5500,0\.9000,0\.5500:authoritative_scope_uv_bounds=0\.0000,0\.0000,0\.5000,1\.0000:reobserve_source_geometry_do_not_translate_to_fit/
  );
  const boundedResult = await compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        ...verifiedRoomScope(),
        boundary_model_points: [
          { x: 120, y: 120 },
          { x: 160, y: 120 },
          { x: 160, y: 180 },
          { x: 120, y: 180 }
        ]
      },
      planner_payload: {
        ...basePayload,
        spatial_scope: {
          ...basePayload.spatial_scope,
          boundary_pixel_points: [
            { x: 5, y: 40 },
            { x: 95, y: 40 },
            { x: 95, y: 90 },
            { x: 5, y: 90 }
          ]
        },
        observations: [{
          kind: "plumbing_fixture",
          discipline: "plumbing",
          observation_id: "inside-point-with-overbroad-room-boundary",
          visibility: "clear",
          confidence: 0.9,
          pixel_point: { x: 25, y: 65 },
          role: "source-visible fixture",
          placement: { mode: "provisional_plan_symbol" },
          representation_classification: {
            source_graphic: "mep_connection_symbol",
            native_target: "plan_only_marker"
          },
          service_route_connections: [],
          supported_attributes: ["location", "provisional plan representation", "symbol form"],
          attribute_evidence: []
        } as any]
      }
    });
  assert.equal(
    boundedResult.spatial_scope_receipt?.boundary_basis,
    "verified_native_room_projected_to_registered_render"
  );
  assert.deepEqual(
    boundedResult.spatial_scope_receipt?.source_observed_boundary_pixel_points,
    basePayload.spatial_scope.boundary_pixel_points.map((entry, index) =>
      index === 1 || index === 2 ? { ...entry, x: 95 } : entry
    )
  );
  assert.equal(
    Math.max(...(boundedResult.spatial_scope_receipt?.boundary_pixel_points ?? []).map((entry) => entry.x)),
    70
  );
  assert.equal(
    boundedResult.spatial_scope_receipt?.normalization_warnings?.some((entry) =>
      entry.includes("authoritative spatial scope")
    ),
    true
  );
  const locallyRegisteredResult = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: {
      room_number: "100",
      source_scoped_id: "loaded-arch-link:100:disjoint-local-registration",
      boundary_model_points: [
        { x: 155, y: 125 },
        { x: 170, y: 125 },
        { x: 170, y: 175 },
        { x: 155, y: 175 }
      ]
    },
    planner_payload: {
      ...basePayload,
      spatial_scope: {
        boundary_pixel_points: [
          { x: 5, y: 10 },
          { x: 35, y: 10 },
          { x: 35, y: 90 },
          { x: 5, y: 90 }
        ],
        anchor_pixel_point: { x: 20, y: 50 },
        anchor_label: "SAMPLE ROOM 100",
        evidence_reference: "Visible room label and enclosing source walls."
      },
      observations: [{
        kind: "pipe_route",
        discipline: "plumbing",
        observation_id: "room-local-source-route",
        visibility: "clear",
        confidence: 0.9,
        supported_attributes: ["location", "elevation"],
        attribute_evidence: [{
          attribute: "elevation",
          basis: "declared_heuristic",
          evidence_role: "registered_source_render",
          reference: "Plan omits elevation."
        }],
        service: "unclassified",
        pixel_points: [{ x: 10, y: 55 }, { x: 30, y: 55 }],
        elevation_ft: 10,
        pipe_size_policy: "unresolved_placeholder",
        type_policy: "unresolved_placeholder",
        system_classification_policy: "unresolved_placeholder",
        pipe_type: "Standard",
        system_type: "Domestic Cold Water"
      } as any]
    }
  });
  assert.deepEqual(
    (locallyRegisteredResult.package.observations[0] as any).pixel_points,
    [{ x: 65, y: 56.25 }, { x: 85, y: 56.25 }]
  );
  assert.equal(
    locallyRegisteredResult.spatial_scope_receipt?.local_room_registration_fallback?.reason,
    "source_scope_disjoint_from_projected_native_room"
  );
  assert.deepEqual(
    locallyRegisteredResult.spatial_scope_receipt?.source_observed_boundary_pixel_points,
    [
      { x: 5, y: 10 },
      { x: 35, y: 10 },
      { x: 35, y: 90 },
      { x: 5, y: 90 }
    ]
  );
  assert.equal(
    locallyRegisteredResult.spatial_scope_receipt?.normalization_warnings?.some((entry) =>
      entry.includes("local room-coordinate basis")
    ),
    true
  );
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        room_number: "100",
        source_scoped_id: "loaded-arch-link:100:contained-low-overlap-registration",
        boundary_model_points: [
          { x: 155, y: 145 },
          { x: 160, y: 145 },
          { x: 160, y: 155 },
          { x: 155, y: 155 }
        ]
      },
      planner_payload: {
        ...basePayload,
        spatial_scope: {
          boundary_pixel_points: [
            { x: 5, y: 10 },
            { x: 95, y: 10 },
            { x: 95, y: 90 },
            { x: 5, y: 90 }
          ],
          anchor_pixel_point: { x: 50, y: 50 },
          anchor_label: "SAMPLE ROOM 100",
          evidence_reference: "An overbroad trace may include adjacent-room geometry."
        },
        observations: [{
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "adjacent-route-inside-overbroad-source-polygon",
          visibility: "clear",
          confidence: 0.9,
          supported_attributes: ["location", "elevation"],
          attribute_evidence: [{
            attribute: "elevation",
            basis: "declared_heuristic",
            evidence_role: "registered_source_render",
            reference: "Plan omits elevation."
          }],
          service: "unclassified",
          pixel_points: [{ x: 20, y: 50 }, { x: 40, y: 50 }],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any]
      }
    }),
    /candidate_visible_route_outside_spatial_scope:adjacent-route-inside-overbroad-source-polygon/
  );
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        room_number: "100",
        source_scoped_id: "loaded-arch-link:100:disjoint-local-registration-outside-route",
        boundary_model_points: [
          { x: 155, y: 125 },
          { x: 170, y: 125 },
          { x: 170, y: 175 },
          { x: 155, y: 175 }
        ]
      },
      planner_payload: {
        ...basePayload,
        spatial_scope: {
          boundary_pixel_points: [
            { x: 5, y: 10 },
            { x: 35, y: 10 },
            { x: 35, y: 90 },
            { x: 5, y: 90 }
          ],
          anchor_pixel_point: { x: 20, y: 50 },
          anchor_label: "SAMPLE ROOM 100",
          evidence_reference: "Visible room label and enclosing source walls."
        },
        observations: [{
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "source-local-route-still-outside-source-room",
          visibility: "clear",
          confidence: 0.9,
          supported_attributes: ["location", "elevation"],
          attribute_evidence: [{
            attribute: "elevation",
            basis: "declared_heuristic",
            evidence_role: "registered_source_render",
            reference: "Plan omits elevation."
          }],
          service: "unclassified",
          pixel_points: [{ x: -20, y: 55 }, { x: -10, y: 55 }],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any]
      }
    }),
    /candidate_visible_route_outside_spatial_scope:source-local-route-still-outside-source-room/
  );
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        room_number: "100",
        source_scoped_id: "loaded-arch-link:100:concave-local-registration-notch",
        boundary_model_points: [
          { x: 155, y: 125 },
          { x: 170, y: 125 },
          { x: 170, y: 175 },
          { x: 155, y: 175 }
        ]
      },
      planner_payload: {
        ...basePayload,
        spatial_scope: {
          boundary_pixel_points: [
            { x: 5, y: 10 },
            { x: 35, y: 10 },
            { x: 35, y: 40 },
            { x: 15, y: 40 },
            { x: 15, y: 90 },
            { x: 5, y: 90 }
          ],
          anchor_pixel_point: { x: 10, y: 50 },
          anchor_label: "SAMPLE ROOM 100",
          evidence_reference: "Visible concave room label and enclosing source walls."
        },
        observations: [{
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "source-local-route-in-concave-notch",
          visibility: "clear",
          confidence: 0.9,
          supported_attributes: ["location", "elevation"],
          attribute_evidence: [{
            attribute: "elevation",
            basis: "declared_heuristic",
            evidence_role: "registered_source_render",
            reference: "Plan omits elevation."
          }],
          service: "unclassified",
          pixel_points: [{ x: 20, y: 60 }, { x: 30, y: 60 }],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any]
      }
    }),
    /candidate_visible_route_outside_spatial_scope:source-local-route-in-concave-notch/
  );
  const clippedCrossingResult = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: {
      ...verifiedRoomScope(),
      boundary_model_points: [
        { x: 120, y: 120 },
        { x: 160, y: 120 },
        { x: 160, y: 180 },
        { x: 120, y: 180 }
      ]
    },
    planner_payload: {
      ...basePayload,
      observations: [{
        kind: "pipe_route",
        discipline: "plumbing",
        observation_id: "full-width-source-main",
        visibility: "clear",
        confidence: 0.9,
        supported_attributes: ["location", "elevation"],
        attribute_evidence: [{
          attribute: "elevation",
          basis: "declared_heuristic",
          evidence_role: "registered_source_render",
          reference: "Plan omits elevation."
        }],
        service: "unclassified",
        pixel_points: [{ x: 10, y: 55 }, { x: 90, y: 55 }],
        elevation_ft: 10,
        pipe_size_policy: "unresolved_placeholder",
        type_policy: "unresolved_placeholder",
        system_classification_policy: "unresolved_placeholder",
        pipe_type: "Standard",
        system_type: "Domestic Cold Water"
      } as any]
    }
  });
  assert.deepEqual(
    (clippedCrossingResult.package.observations[0] as any).pixel_points,
    [{ x: 10, y: 55 }, { x: 70, y: 55 }]
  );
  assert.deepEqual(
    clippedCrossingResult.spatial_scope_receipt?.route_clipping_receipts?.[0],
    {
      observation_id: "full-width-source-main",
      geometry_role: "route",
      source_point_count: 2,
      retained_point_count: 2,
      source_length_px: 80,
      retained_length_px: 60,
      retained_part_index: 0,
      retained_part_count: 1,
      dropped_part_count: 0,
      source_start_pixel_point: { x: 10, y: 55 },
      source_end_pixel_point: { x: 90, y: 55 },
      retained_start_pixel_point: { x: 10, y: 55 },
      retained_end_pixel_point: { x: 70, y: 55 }
    }
  );
  assert.equal(
    clippedCrossingResult.spatial_scope_receipt?.normalization_warnings?.some((entry) =>
      entry.includes("disjoint out-of-scope portions were not reconnected")
    ),
    true
  );
  const subpixelCrossingResult = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: {
      ...verifiedRoomScope(),
      boundary_model_points: [
        { x: 120, y: 120 },
        { x: 160, y: 120 },
        { x: 160, y: 180 },
        { x: 120, y: 180 }
      ]
    },
    planner_payload: {
      ...basePayload,
      observations: [{
        ...(clippedCrossingResult.package.observations[0] as any),
        observation_id: "subpixel-outside-source-main",
        pixel_points: [{ x: 10, y: 55 }, { x: 70.5, y: 55 }]
      }]
    }
  });
  assert.deepEqual(
    (subpixelCrossingResult.package.observations[0] as any).pixel_points,
    [{ x: 10, y: 55 }, { x: 70, y: 55 }]
  );
  assert.equal(
    subpixelCrossingResult.spatial_scope_receipt?.route_clipping_receipts?.[0]?.retained_length_px,
    60
  );

  const concaveResult = await compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        room_number: "100",
        source_scoped_id: "loaded-arch-link:100:concave",
        boundary_model_points: [
          { x: 130, y: 165 },
          { x: 170, y: 165 },
          { x: 170, y: 130 },
          { x: 155, y: 130 },
          { x: 155, y: 150 },
          { x: 145, y: 150 },
          { x: 145, y: 130 },
          { x: 130, y: 130 }
        ]
      },
      planner_payload: {
        ...basePayload,
        observations: [{
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "route-crossing-concave-room-notch",
          visibility: "clear",
          confidence: 0.9,
          supported_attributes: ["location", "elevation"],
          attribute_evidence: [{
            attribute: "elevation",
            basis: "declared_heuristic",
            evidence_role: "registered_source_render",
            reference: "Plan omits elevation."
          }],
          service: "unclassified",
          pixel_points: [{ x: 20, y: 70 }, { x: 80, y: 70 }],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any]
      }
    });
  assert.deepEqual(
    (concaveResult.package.observations[0] as any).pixel_points,
    [{ x: 20, y: 70 }, { x: 40, y: 70 }]
  );
  assert.equal(
    concaveResult.spatial_scope_receipt?.route_clipping_receipts?.[0]?.retained_part_count,
    2
  );
  assert.equal(
    concaveResult.spatial_scope_receipt?.route_clipping_receipts?.[0]?.dropped_part_count,
    1
  );
  assert.deepEqual(
    concaveResult.workflow.operations[0]?.apply_body?.points,
    [
      { x: 135, y: 140, z: 110 },
      { x: 145, y: 140, z: 110 }
    ]
  );
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        ...verifiedRoomScope(),
        boundary_model_points: [
          { x: 300, y: 300 },
          { x: 310, y: 300 },
          { x: 310, y: 310 },
          { x: 300, y: 310 }
        ]
      },
      planner_payload: {
        ...basePayload,
        observations: [{
          kind: "plumbing_fixture",
          discipline: "plumbing",
          observation_id: "misregistered-room-fixture",
          visibility: "clear",
          confidence: 0.9,
          pixel_point: { x: 25, y: 65 },
          role: "source-visible fixture",
          placement: { mode: "provisional_plan_symbol" },
          representation_classification: {
            source_graphic: "mep_connection_symbol",
            native_target: "plan_only_marker"
          },
          service_route_connections: [],
          supported_attributes: ["location", "provisional plan representation", "symbol form"],
          attribute_evidence: []
        } as any]
      }
    }),
    /candidate_visible_verified_room_scope_not_visible_in_registered_render/
  );
});

test("workbench exposes registered MEP compilation as a bounded read-only planning action", async () => {
  let received = "";
  const results = await executeWorkbenchActions(
    [{
      type: "compile_registered_mep_reconstruction",
      package_json: "{\"fixture_id\":\"bounded\"}",
      maximum_created_elements: 8
    }],
    {
      compileRegisteredMepReconstruction: async (action) => {
        received = action.package_json;
        return {
          compiled_plan: {
            status: "partially_ready",
            promoted_observation_ids: ["route-1"],
            deferred_observation_ids: ["fixture-1"]
          },
          workflow: { dryRun: true }
        };
      }
    }
  );

  assert.equal(received, "{\"fixture_id\":\"bounded\"}");
  assert.equal(results[0]?.ok, true);
  assert.match(results[0]?.summary ?? "", /promoted=1, deferred=1/);
});

test("workbench executes at most one registered reconstruction compiler action per batch", async () => {
  let compileCalls = 0;
  const results = await executeWorkbenchActions(
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{\"fixture_id\":\"first\"}"
      },
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{\"fixture_id\":\"second\"}"
      },
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{\"fixture_id\":\"third\"}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: "source.pdf"
      }
    ] as any,
    {
      compileRegisteredMepReconstruction: async () => {
        compileCalls++;
        throw new Error("candidate_visible_route_outside_spatial_scope:first");
      }
    }
  );

  assert.equal(compileCalls, 1);
  assert.equal(results.length, 1);
  assert.match(results[0]?.summary ?? "", /candidate_visible_route_outside_spatial_scope:first/);
});

test("candidate-visible adapter normalizes common vision-planner aliases without inventing source-system credit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-aliases-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ncandidate-visible-alias-test\n"));
  const canvas = createCanvas(100, 100);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    planner_payload: {
      schema_version: 2,
      fixture_id: "alias-normalization-v1",
      scope_id: "bounded-alias-scope",
      discipline: "plumbing",
      level_name: "Level 1",
      level_elevation_ft: 0,
      partial_promotion_policy: "defer_ambiguous_observations",
      maximum_observations: 2,
      observations: [
        {
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "planner-route-1",
          visibility: "visible_clipped",
          confidence: 0.8,
          supported_attributes: ["route_geometry"],
          attribute_evidence: [
            {
              attribute: "route_geometry",
              evidence_role: "registered_source_render",
              legible_source_evidence: "Visible clipped route in the bounded source crop"
            }
          ],
          service: "unresolved",
          pixel_points: [[10, 50], [90, 50]],
          elevation_ft: {
            basis: "declared_heuristic",
            reference: "Plan has no elevation; use a reasonable plenum elevation."
          },
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "unresolved_placeholder"
        } as any,
        {
          kind: "plumbing_fixture",
          discipline: "plumbing",
          observation_id: "planner-fixture-1",
          visibility: "visible",
          confidence: 0.9,
          pixel_point: [50, 60],
          role: "source-visible fixture",
          placement: { mode: "provisional_plan_symbol" },
          representation_classification: {
            source_graphic: "mep_connection_symbol",
            native_target: "plan_only_marker"
          },
          service_route_connections: ["planner-route-1"],
          attribute_evidence: [
            {
              attribute: "fixture_label",
              evidence_role: "registered_source_render",
              legible_source_evidence: "Visible fixture symbol and label"
            }
          ]
        } as any
      ]
    }
  });

  const route = result.package.observations[0];
  assert.equal(route?.kind, "pipe_route");
  if (route?.kind !== "pipe_route") throw new Error("route_setup_failed");
  if (!("pixel_points" in route) || !("elevation_ft" in route)) throw new Error("source_point_route_setup_failed");
  assert.equal(route.visibility, "partial");
  assert.equal(route.service, "unclassified");
  assert.deepEqual(route.pixel_points, [{ x: 10, y: 50 }, { x: 90, y: 50 }]);
  assert.equal(route.elevation_ft, 10);
  assert.equal(route.pipe_type, "Standard");
  assert.equal(route.system_type, "Domestic Cold Water");
  assert.equal(result.compilation.compiled_plan.status, "partially_ready");
  assert.equal(result.workflow.operations.some((entry) => entry.path === "/revit/draw-detail-curves"), true);
  assert.equal(result.package.native_element_references.some((entry) =>
    entry.reference_key === "candidate_visible_aligned_view" &&
    entry.evidence_role === "candidate_visible_frame_mapping"
  ), true);
  assert.equal(result.planner_normalization_warnings.length > 0, true);
});

test("candidate-visible adapter maps service evidence to system from normalized source coordinates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-raster-scale-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ncandidate-visible-raster-scale-test\n"));
  const canvas = createCanvas(438, 438);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    planner_payload: {
      schema_version: 2,
      fixture_id: "raster-scale-v1",
      scope_id: "bounded-raster-scale-scope",
      discipline: "plumbing",
      coordinate_space: "normalized_uv_top_left",
      level_name: "Level 1",
      level_elevation_ft: 0,
      partial_promotion_policy: "defer_ambiguous_observations",
      maximum_observations: 2,
      observations: [
        {
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "route-a",
          visibility: "partial",
          confidence: 0.9,
          supported_attributes: ["service", "pixel_points", "elevation"],
          attribute_evidence: [
            {
              attribute: "service",
              evidence_role: "registered_source_render",
              basis: "legible_source_evidence",
              reference: "Printed CW label and matching line pattern."
            },
            {
              attribute: "pixel_points",
              evidence_role: "registered_source_render",
              basis: "legible_source_evidence",
              reference: "Visible route from both crop boundaries."
            },
            {
              attribute: "elevation",
              evidence_role: "registered_source_render",
              basis: "declared_heuristic",
              reference: "Plan does not show elevation; use disclosed plenum assumption."
            }
          ],
          service: "cold_water",
          pixel_points: [[1 / 650, 149 / 650], [649 / 650, 149 / 650]],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "explicit_required",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any,
        {
          kind: "pipe_route",
          discipline: "plumbing",
          observation_id: "route-b",
          visibility: "partial",
          confidence: 0.9,
          supported_attributes: ["service", "pixel_points", "elevation"],
          attribute_evidence: [
            {
              attribute: "service",
              evidence_role: "registered_source_render",
              basis: "legible_source_evidence",
              reference: "Printed CW label and matching line pattern."
            },
            {
              attribute: "pixel_points",
              evidence_role: "registered_source_render",
              basis: "legible_source_evidence",
              reference: "Visible route from both crop boundaries."
            },
            {
              attribute: "elevation",
              evidence_role: "registered_source_render",
              basis: "declared_heuristic",
              reference: "Plan does not show elevation; use disclosed plenum assumption."
            }
          ],
          service: "cold_water",
          pixel_points: [[1 / 650, 157 / 650], [649 / 650, 157 / 650]],
          elevation_ft: 10,
          pipe_size_policy: "unresolved_placeholder",
          type_policy: "unresolved_placeholder",
          system_classification_policy: "explicit_required",
          pipe_type: "Standard",
          system_type: "Domestic Cold Water"
        } as any
      ]
    }
  });

  const route = result.package.observations[0];
  assert.equal(route?.kind, "pipe_route");
  if (route?.kind !== "pipe_route" || !("pixel_points" in route)) throw new Error("scaled_route_setup_failed");
  assert.equal(route.supported_attributes.includes("system"), true);
  assert.equal(route.attribute_evidence.some((entry) => entry.attribute === "system"), true);
  assert.ok(route.pixel_points[1]!.x < 438);
  assert.ok(Math.abs(route.pixel_points[1]!.x - 437.326) < 0.01);
  assert.ok(result.planner_normalization_warnings.some((entry) =>
    entry.includes("Mapped normalized planner UV coordinates")
  ));
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      planner_payload: {
        ...(result.package as any),
        planner_raster_width_px: 650,
        planner_raster_height_px: 650
      }
    }),
    /candidate_visible_planner_raster_dimensions_are_not_allowed/
  );
});

test("candidate-visible adapter normalizes generic route, point, and created-branch geometry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-generic-normalized-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ncandidate-visible-generic-normalized-test\n"));
  const canvas = createCanvas(100, 100);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    planner_payload: {
      schema_version: 2,
      fixture_id: "generic-normalized-v1",
      scope_id: "generic-normalized-scope",
      discipline: "mechanical",
      coordinate_space: "normalized_uv_top_left",
      level_name: "Level 1",
      partial_promotion_policy: "defer_ambiguous_observations",
      maximum_observations: 2,
      observations: [
        {
          kind: "duct_route",
          discipline: "mechanical",
          observation_id: "normalized-duct-route",
          visibility: "clear",
          confidence: 0.95,
          supported_attributes: ["location", "size", "elevation", "system", "type"],
          attribute_evidence: [
            { attribute: "size", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible 8 inch route label." },
            { attribute: "elevation", basis: "declared_heuristic", evidence_role: "registered_source_render", reference: "Plan omits elevation; use 10 feet." },
            { attribute: "system", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible outside-air notation." },
            { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible round duct graphics." }
          ],
          service: "outside_air",
          pixel_points: [{ x: 0.2, y: 0.8 }, { x: 0.8, y: 0.8 }],
          duct_size: "8 inch",
          duct_type: "Round Duct",
          system_type: "Outside Air",
          elevation_ft: 10
        },
        {
          kind: "air_terminal",
          discipline: "mechanical",
          observation_id: "normalized-created-branch-terminal",
          visibility: "clear",
          confidence: 0.95,
          supported_attributes: ["location", "type", "host"],
          attribute_evidence: [
            { attribute: "type", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible grille type." },
            { attribute: "host", basis: "legible_source_evidence", evidence_role: "registered_source_render", reference: "Visible branch joins route and grille." }
          ],
          role: "supply grille",
          pixel_point: { x: 0.5, y: 0.6 },
          elevation_ft: 10,
          placement: {
            mode: "created_route_branch",
            family_name: "M_Supply Grille",
            type_name: "16x4 Connection 8 Diameter",
            route_observation_id: "normalized-duct-route",
            route_segment_index: 0,
            pixel_branch_points: [{ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.6 }],
            branch_size: "16x4",
            tee_family_name: "Rectangular Tee",
            tee_type_name: "Standard"
          }
        }
      ] as any
    }
  });

  assert.deepEqual((result.package.observations[0] as any).pixel_points, [
    { x: 20, y: 80 },
    { x: 80, y: 80 }
  ]);
  assert.deepEqual((result.package.observations[1] as any).pixel_point, { x: 50, y: 60 });
  assert.deepEqual((result.package.observations[1] as any).placement.pixel_branch_points, [
    { x: 50, y: 80 },
    { x: 50, y: 60 }
  ]);
});
