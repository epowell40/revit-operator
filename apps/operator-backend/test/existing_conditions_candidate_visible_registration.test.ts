import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  compileCandidateVisibleMepReconstruction,
  deriveCandidateVisibleRegistrationGeometry
} from "../src/existing_conditions/candidate_visible_registration.js";
import {
  buildPdfJsDocumentOptions,
  loadPdfJsForNode
} from "../src/pdf/pdfjs_node.js";
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

function writeSinglePageTextPdf(
  filePath: string,
  text: string,
  x = 20,
  y = 45,
  routeStroke = "0 G",
  routeWidth = 1,
  extraGraphics = ""
): void {
  const escapedText = text.replace(/([\\()])/g, "\\$1");
  const stream =
    `0 G\n1 w\n10 10 m\n90 10 l\n90 90 l\n10 90 l\nh\nS\n` +
    `${routeStroke}\n${routeWidth} w\n20 50 m\n40 50 l\nS\n0 G\n` +
    `${extraGraphics}` +
    `BT\n/F1 10 Tf\n${x} ${y} Td\n(${escapedText}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  fs.writeFileSync(filePath, Buffer.from(pdf, "binary"));
}

async function renderFirstPdfPage(sourcePdfPath: string, renderPath: string): Promise<void> {
  const pdfjs: any = await loadPdfJsForNode();
  const document = await pdfjs.getDocument(
    buildPdfJsDocumentOptions(new Uint8Array(fs.readFileSync(sourcePdfPath)))
  ).promise;
  try {
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context as any, viewport }).promise;
    fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));
  } finally {
    await document.destroy();
  }
}

function placeholderPipeObservation(
  observationId: string,
  pixelPoints: Array<{ x: number; y: number }>
): any {
  return {
    kind: "pipe_route",
    discipline: "plumbing",
    observation_id: observationId,
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
    pixel_points: pixelPoints,
    elevation_ft: 10,
    pipe_size_policy: "unresolved_placeholder",
    type_policy: "unresolved_placeholder",
    system_classification_policy: "unresolved_placeholder",
    pipe_type: "Standard",
    system_type: "Domestic Cold Water"
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

test("tagless durable-landmark compilation proves raster grounding and clips to the aligned native area", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-tagless-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(sourcePdfPath, Buffer.from("%PDF-1.4\ntagless-landmark-test\n"));
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 100, 100);
  context.strokeStyle = "#000";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(0, 50);
  context.lineTo(100, 50);
  context.stroke();
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));
  const taglessAlignment = {
    ...ALIGNMENT,
    provider: "openai" as const,
    model: "gpt-5.6-sol",
    attempted_models: ["gemini-3-flash-preview", "gpt-5.6-sol"],
    fallback_reason:
      "Gemini structured alignment was rejected by native Revit landmark verification for this exact frame."
  };
  const registrationControls = [
    {
      kind: "exterior_corner" as const,
      source_normalized_point: { x: 0.1, y: 0.1 },
      view_normalized_point: { x: 0.3, y: 0.3 },
      score: 0.95,
      crop_residual: 0,
      label: "northwest exterior corner"
    },
    {
      kind: "stair" as const,
      source_normalized_point: { x: 0.9, y: 0.9 },
      view_normalized_point: { x: 0.7, y: 0.7 },
      score: 0.92,
      crop_residual: 0,
      label: "stair core"
    }
  ];
  const landmarkMatches = [
    {
      control_index: 0,
      native_source_scoped_id: "arch-link:wall-1",
      native_built_in_category: "OST_Walls",
      native_model_point: { x: 125, y: 175 },
      native_projected_view_normalized_point: { x: 0.3, y: 0.3 },
      projected_distance_normalized: 0,
      geometry_basis: "projected_geometry" as const
    },
    {
      control_index: 1,
      native_source_scoped_id: "arch-link:stair-1",
      native_built_in_category: "OST_Stairs",
      native_model_point: { x: 170, y: 130 },
      native_projected_view_normalized_point: { x: 0.7, y: 0.7 },
      projected_distance_normalized: 0,
      geometry_basis: "projected_bbox" as const
    }
  ];
  const sourcePdfSha256 = createHash("sha256")
    .update(fs.readFileSync(sourcePdfPath))
    .digest("hex");
  const registeredRenderSha256 = createHash("sha256")
    .update(fs.readFileSync(renderPath))
    .digest("hex");
  const alignmentReceiptSha256 = createHash("sha256")
    .update(JSON.stringify({
      frame_id: FRAME.frame_id,
      view_id: FRAME.view_id,
      matched: taglessAlignment.matched,
      confidence: taglessAlignment.confidence,
      crop: taglessAlignment.crop,
      provider: taglessAlignment.provider,
      model: taglessAlignment.model,
      attempted_models: taglessAlignment.attempted_models,
      fallback_reason: taglessAlignment.fallback_reason,
      registration_controls: registrationControls
    }))
    .digest("hex");
  const inventoryReceiptSha256 = createHash("sha256")
    .update("current-inventory-receipt")
    .digest("hex");
  const landmarkScopeId =
    `aligned-crop-landmarks:${createHash("sha256")
      .update(JSON.stringify({
        frame_id: FRAME.frame_id,
        view_id: FRAME.view_id,
        source_pdf_sha256: sourcePdfSha256,
        registered_render_sha256: registeredRenderSha256,
        alignment_receipt_sha256: alignmentReceiptSha256,
        inventory_receipt_sha256: inventoryReceiptSha256,
        controls: registrationControls,
        landmark_matches: landmarkMatches
      }))
      .digest("hex")}`;
  const verifiedLandmarkScope = {
    source_scoped_id: landmarkScopeId,
    basis: "durable_landmarks_in_aligned_crop" as const,
    maximum_crop_residual: 0,
    source_control_span: 0.8,
    view_control_span: 0.4,
    source_pdf_sha256: sourcePdfSha256,
    registered_render_sha256: registeredRenderSha256,
    alignment_receipt_sha256: alignmentReceiptSha256,
    inventory_receipt_sha256: inventoryReceiptSha256,
    registration_controls: registrationControls,
    landmark_matches: landmarkMatches
  };
  const plannerPayload = {
    schema_version: 2 as const,
    fixture_id: "candidate-visible-tagless-v1",
    scope_id: "aligned-crop-v1",
    discipline: "plumbing" as const,
    coordinate_space: "registered_render_pixels_top_left" as const,
    level_name: "Level 1",
    partial_promotion_policy: "defer_ambiguous_observations" as const,
    maximum_observations: 2,
    observations: [
      placeholderPipeObservation(
        "tagless-cold-water-route",
        [{ x: -10, y: 50 }, { x: 110, y: 50 }]
      )
    ]
  };

  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: taglessAlignment,
    frame: FRAME,
    verified_landmark_scope: verifiedLandmarkScope,
    planner_payload: plannerPayload
  });

  assert.equal(result.workflow.dryRun, true);
  assert.equal(result.package.room_number, undefined);
  assert.equal(
    result.spatial_scope_receipt?.boundary_basis,
    "verified_durable_landmark_area_projected_to_registered_render"
  );
  assert.equal(
    result.spatial_scope_receipt?.native_area_source_scoped_id,
    landmarkScopeId
  );
  assert.equal(
    result.spatial_scope_receipt?.durable_landmark_registration?.registration_controls.length,
    2
  );
  assert.equal(
    result.spatial_scope_receipt?.source_route_raster_verifications?.[0]?.accepted,
    true
  );
  assert.equal(
    result.spatial_scope_receipt?.route_clipping_receipts?.[0]?.observation_id,
    "tagless-cold-water-route"
  );
  assert.deepEqual(
    (result.package.observations[0] as any).pixel_points,
    [{ x: 0, y: 50 }, { x: 100, y: 50 }]
  );
  await assert.rejects(
    () => compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: taglessAlignment,
      frame: FRAME,
      verified_landmark_scope: {
        ...verifiedLandmarkScope,
        inventory_receipt_sha256: createHash("sha256")
          .update("stale-inventory-receipt")
          .digest("hex")
      },
      planner_payload: plannerPayload
    }),
    /candidate_visible_durable_landmark_receipt_hash_mismatch/
  );
});

test("candidate-visible room-local route requests a source enclosure without deleting accurate geometry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-room-enclosure-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writeSinglePageTextPdf(sourcePdfPath, "100");
  await renderFirstPdfPage(sourcePdfPath, renderPath);

  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: {
        room_number: "100",
        source_scoped_id: "loaded-arch-link:100:source-enclosure-required",
        boundary_model_points: [
          { x: 150, y: 175 },
          { x: 170, y: 175 },
          { x: 170, y: 160 },
          { x: 160, y: 160 },
          { x: 160, y: 145 },
          { x: 150, y: 145 }
        ]
      },
      planner_payload: {
        schema_version: 2,
        fixture_id: "source-enclosure-required",
        scope_id: "room-100",
        discipline: "plumbing",
        level_name: "Level 1",
        room_number: "100",
        partial_promotion_policy: "defer_ambiguous_observations",
        maximum_observations: 1,
        observations: [
          placeholderPipeObservation("accurate-source-route", [
            { x: 20, y: 80 },
            { x: 60, y: 80 }
          ])
        ]
      }
    }),
    /candidate_visible_source_room_enclosure_required:100:accurate-source-route:source_uv_bounds=0\.2000,0\.8000,0\.6000,0\.8000:projected_native_scope_uv_bounds=0\.5000,0\.0000,0\.9000,0\.6000:source_room_label_uv=0\.\d{4},0\.\d{4}:preserve_source_geometry_add_spatial_scope_or_defer/
  );
});

test("candidate-visible partial-overlap crop rejects a source enclosure unsupported by the raster", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-room-shape-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writeSinglePageTextPdf(sourcePdfPath, "100");
  await renderFirstPdfPage(sourcePdfPath, renderPath);
  const nativeRoom = {
    room_number: "100",
    source_scoped_id: "loaded-arch-link:100:shape-verified",
    boundary_model_points: [
      { x: 150, y: 175 },
      { x: 170, y: 175 },
      { x: 170, y: 160 },
      { x: 160, y: 160 },
      { x: 160, y: 145 },
      { x: 150, y: 145 }
    ]
  };
  const sourceScope = {
    boundary_pixel_points: [
      { x: 5, y: 20 },
      { x: 75, y: 20 },
      { x: 75, y: 55 },
      { x: 40, y: 55 },
      { x: 40, y: 90 },
      { x: 5, y: 90 }
    ],
    anchor_pixel_point: { x: 28, y: 50 },
    anchor_label: "ROOM 100",
    evidence_reference: "Visible ROOM 100 label inside the traced L-shaped enclosure."
  };
  const basePayload = {
    schema_version: 2 as const,
    fixture_id: "shape-verified-local-room",
    scope_id: "room-100",
    discipline: "plumbing" as const,
    level_name: "Level 1",
    room_number: "100",
    spatial_scope: sourceScope,
    partial_promotion_policy: "defer_ambiguous_observations" as const,
    maximum_observations: 1
  };

  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: nativeRoom,
      planner_payload: {
        ...basePayload,
        observations: [
          placeholderPipeObservation("unregistered-local-route", [
            { x: 20, y: 35 },
            { x: 65, y: 35 }
          ])
        ]
      }
    }),
    /candidate_visible_source_room_enclosure_raster_verification_required:100:.*source_room_label_uv=\d+\.\d{4},\d+\.\d{4}:preserve_source_geometry_retrace_only_unsupported_enclosure_edges/
  );
});

test("candidate-visible room-label translation shifts only registration geometry and fails closed on raster or registration mismatch", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-room-label-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  const unrelatedRenderPath = path.join(directory, "unrelated.png");
  const shiftedRenderPath = path.join(directory, "shifted.png");
  writeSinglePageTextPdf(sourcePdfPath, "100");
  await renderFirstPdfPage(sourcePdfPath, renderPath);
  const unrelatedCanvas = createCanvas(100, 100);
  const unrelatedContext = unrelatedCanvas.getContext("2d");
  unrelatedContext.fillStyle = "#000";
  unrelatedContext.fillRect(0, 0, 100, 100);
  fs.writeFileSync(unrelatedRenderPath, unrelatedCanvas.toBuffer("image/png"));
  const sourceImage = await loadImage(fs.readFileSync(renderPath));
  const shiftedCanvas = createCanvas(100, 100);
  const shiftedContext = shiftedCanvas.getContext("2d");
  shiftedContext.fillStyle = "#fff";
  shiftedContext.fillRect(0, 0, 100, 100);
  shiftedContext.drawImage(sourceImage, 8, 0);
  fs.writeFileSync(shiftedRenderPath, shiftedCanvas.toBuffer("image/png"));

  const originalRoute = [
    { x: 20, y: 50 },
    { x: 40, y: 50 }
  ];
  const plannerPayload = {
    schema_version: 2 as const,
    fixture_id: "room-label-translation",
    scope_id: "room-100",
    discipline: "plumbing" as const,
    level_name: "Level 1",
    room_number: "100",
    spatial_scope: {
      boundary_pixel_points: [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 }
      ],
      anchor_pixel_point: { x: 25, y: 50 },
      anchor_label: "100",
      evidence_reference: "Visible room label 100 inside the traced enclosure."
    },
    partial_promotion_policy: "defer_ambiguous_observations" as const,
    maximum_observations: 1,
    observations: [
      placeholderPipeObservation("immutable-source-route", originalRoute)
    ]
  };
  const nativeRoom = {
    ...verifiedRoomScope(),
    visible_room_label: {
      text: "100",
      source_scoped_id: "host:room-tag-100",
      built_in_category: "OST_RoomTags" as const,
      frame_id: FRAME.frame_id,
      registration_frame_id: FRAME.frame_id,
      view_id: FRAME.view_id,
      model_point: { x: 150, y: 150 }
    }
  };

  const translated = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: structuredClone(plannerPayload)
  });
  const fallback =
    translated.spatial_scope_receipt?.local_room_registration_fallback;
  assert.equal(fallback?.reason, "server_verified_room_label_translation");
  assert.ok(Math.abs(fallback?.translation_x_px ?? 0) > 1);
  assert.ok(Math.abs(fallback?.translation_y_px ?? 0) < 10);
  assert.deepEqual(
    (translated.package.observations[0] as any).pixel_points,
    originalRoute
  );
  assert.deepEqual(
    (translated.spatial_scope_receipt?.source_observations[0] as any).pixel_points,
    originalRoute
  );
  assert.match(
    translated.spatial_scope_receipt?.source_observations_sha256 ?? "",
    /^[a-f0-9]{64}$/
  );
  assert.equal(
    translated.spatial_scope_receipt?.source_route_raster_verifications?.[0]
      ?.accepted,
    true
  );
  assert.equal(
    translated.spatial_scope_receipt?.source_route_raster_verifications?.[0]
      ?.support_modality,
    "monochrome_line"
  );
  const nativeRoutePoints =
    (translated.workflow.operations[0] as any).apply_body.points;
  for (const point of nativeRoutePoints) {
    assert.ok(point.x >= 120 && point.x <= 180);
    assert.ok(point.y >= 120 && point.y <= 180);
  }

  const structuredImageLabelAlignment = {
    ...ALIGNMENT,
    provider: "gemini" as const,
    source_room_labels: [{
      text: "100",
      normalized_x: 0.27,
      normalized_y: 0.52,
      min_u: 0.2,
      min_v: 0.47,
      max_u: 0.34,
      max_v: 0.57,
      score: 0.97
    }]
  };
  const structuredImageLabel = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: renderPath,
    registered_render_path: renderPath,
    alignment: structuredImageLabelAlignment,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: structuredClone(plannerPayload)
  });
  assert.equal(
    structuredImageLabel.spatial_scope_receipt?.local_room_registration_fallback?.reason,
    "server_verified_room_label_translation"
  );
  assert.equal(
    structuredImageLabel.spatial_scope_receipt?.local_room_registration_fallback
      ?.source_room_label_evidence_basis,
    "gemini_structured_source_label"
  );
  assert.deepEqual(
    (structuredImageLabel.package.observations[0] as any).pixel_points,
    originalRoute
  );

  const derivedExactTagScopePayload = structuredClone(plannerPayload);
  derivedExactTagScopePayload.spatial_scope.boundary_pixel_points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ];
  const derivedExactTagScope = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: {
      ...nativeRoom,
      boundary_model_points: [
        { x: 140.83, y: 130 },
        { x: 180.83, y: 130 },
        { x: 180.83, y: 170 },
        { x: 140.83, y: 170 }
      ]
    },
    planner_payload: derivedExactTagScopePayload
  });
  assert.equal(
    derivedExactTagScope.spatial_scope_receipt?.evidence_reference,
    "Verified linked-room boundary projected into the registered source render."
  );
  assert.ok(
    derivedExactTagScope.spatial_scope_receipt?.normalization_warnings?.some(
      (warning) => warning.includes("without planner-authored room geometry")
    )
  );

  const unsupportedBroadScope = structuredClone(plannerPayload);
  unsupportedBroadScope.spatial_scope.boundary_pixel_points = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ];
  const ignoredBroadScope = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: unsupportedBroadScope
  });
  assert.equal(
    ignoredBroadScope.spatial_scope_receipt?.local_room_registration_fallback?.reason,
    "server_verified_room_label_translation"
  );
  assert.ok(
    ignoredBroadScope.spatial_scope_receipt?.normalization_warnings?.some(
      (warning) => warning.includes("Ignored the planner-authored source room trace")
    )
  );

  const unrelatedRaster = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: unrelatedRenderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: structuredClone(plannerPayload)
  });
  assert.notEqual(
    unrelatedRaster.spatial_scope_receipt?.local_room_registration_fallback?.reason,
    "server_verified_room_label_translation"
  );

  const shiftedRaster = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: shiftedRenderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: structuredClone(plannerPayload)
  });
  assert.notEqual(
    shiftedRaster.spatial_scope_receipt?.local_room_registration_fallback?.reason,
    "server_verified_room_label_translation"
  );

  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: {
        ...ALIGNMENT,
        crop: { min_u: 0.8, min_v: 0.8, max_u: 0.95, max_v: 0.95 }
      },
      frame: FRAME,
      verified_room_scope: {
        ...nativeRoom,
        visible_room_label: {
          ...nativeRoom.visible_room_label,
          text: "1100"
        }
      },
      planner_payload: structuredClone(plannerPayload)
    }),
    /candidate_visible_verified_room_scope_not_visible_in_registered_render/
  );
});

test("candidate-visible exact-tag lane accepts a coherent color route and rejects an offset guess", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-color-route-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writeSinglePageTextPdf(
    sourcePdfPath,
    "100",
    20,
    45,
    "0 0 1 RG",
    2,
    "0 0 1 RG\n3 w\n5 90 m\n95 90 l\nS\n0 G\n"
  );
  await renderFirstPdfPage(sourcePdfPath, renderPath);
  const nativeRoom = {
    ...verifiedRoomScope(),
    visible_room_label: {
      text: "100",
      source_scoped_id: "host:room-tag-100",
      built_in_category: "OST_RoomTags" as const,
      frame_id: FRAME.frame_id,
      registration_frame_id: FRAME.frame_id,
      view_id: FRAME.view_id,
      model_point: { x: 150, y: 150 }
    }
  };
  const plannerPayload = {
    schema_version: 2 as const,
    fixture_id: "color-route-verification",
    scope_id: "room-100",
    discipline: "plumbing" as const,
    level_name: "Level 1",
    room_number: "100",
    partial_promotion_policy: "defer_ambiguous_observations" as const,
    maximum_observations: 1,
    observations: [
      placeholderPipeObservation("visible-blue-color-route", [
        { x: 20, y: 50 },
        { x: 40, y: 50 }
      ])
    ]
  };
  const supported = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: plannerPayload
  });
  const verification =
    supported.spatial_scope_receipt?.source_route_raster_verifications?.[0];
  assert.equal(verification?.accepted, true);
  assert.equal(verification?.support_modality, "chromatic_line");
  assert.ok((verification?.coherent_hue_degrees ?? 0) >= 180);
  assert.ok((verification?.coherent_hue_degrees ?? 360) <= 270);

  const offsetGuess = structuredClone(plannerPayload);
  (offsetGuess.observations[0] as any).attribute_evidence.push({
    attribute: "route_centerline",
    basis: "visible_blue_centerline",
    evidence_role: "registered_source_render",
    reference: "The requested route is visibly blue."
  });
  (offsetGuess.observations[0] as any).pixel_points = [
    { x: 20, y: 90 },
    { x: 40, y: 90 }
  ];
  let rejection: Error | null = null;
  try {
    await compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: nativeRoom,
      planner_payload: offsetGuess
    });
  } catch (error) {
    rejection = error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(rejection);
  assert.doesNotMatch(rejection.message, /candidate_retrace_uv=/);

  const nearOffsetGuess = structuredClone(offsetGuess);
  (nearOffsetGuess.observations[0] as any).pixel_points = [
    { x: 20, y: 60 },
    { x: 40, y: 60 }
  ];
  let localRejection: Error | null = null;
  try {
    await compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: nativeRoom,
      planner_payload: nearOffsetGuess
    });
  } catch (error) {
    localRejection = error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(localRejection);
  assert.match(
    localRejection.message,
    /candidate_visible_route_raster_verification_required:visible-blue-color-route:route:support_modality=chromatic_line:.*candidate_retrace_uv=.*candidate_retrace_color=blue.*candidate_retrace_policy_sha256=[a-f0-9]{64}.*candidate_retrace_source_pixel_sha256=[a-f0-9]{64}.*candidate_retrace_reference_geometry_sha256=[a-f0-9]{64}.*candidate_retrace_components=[^:]+.*candidate_retrace_corridor_radius_px=.*candidate_retrace_maximum_reference_distance_px=.*preserve_source_geometry_retrace_to_visible_centerline/
  );
  const retraceMatch = localRejection.message.match(/:candidate_retrace_uv=([^:]+)/);
  assert.ok(retraceMatch);
  const retraceUvPoints = retraceMatch[1]!.split(";").map((point) => {
    const [x, y] = point.split(",").map(Number);
    return { x, y };
  });
  assert.ok(retraceUvPoints.every((point) => point.y >= 0.45 && point.y <= 0.55));
  const recovered = structuredClone(nearOffsetGuess);
  (recovered as any).coordinate_space = "normalized_uv_top_left";
  (recovered.observations[0] as any).pixel_points = retraceUvPoints;
  const recoveredResult = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: recovered
  });
  assert.equal(
    recoveredResult.spatial_scope_receipt
      ?.source_route_raster_verifications?.[0]?.accepted,
    true
  );

  const crossingPdfPath = path.join(directory, "crossing-decoy.pdf");
  const crossingRenderPath = path.join(directory, "crossing-decoy.png");
  writeSinglePageTextPdf(
    crossingPdfPath,
    "100",
    20,
    45,
    "0 0 1 RG",
    2,
    "0 0 1 RG\n3 w\n45 5 m\n45 95 l\nS\n0 G\n"
  );
  await renderFirstPdfPage(crossingPdfPath, crossingRenderPath);
  let crossingRejection: Error | null = null;
  try {
    await compileCandidateVisibleMepReconstruction({
      source_pdf_path: crossingPdfPath,
      registered_render_path: crossingRenderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: nativeRoom,
      planner_payload: nearOffsetGuess
    });
  } catch (error) {
    crossingRejection =
      error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(crossingRejection);
  const crossingRetraceMatch =
    crossingRejection.message.match(/:candidate_retrace_uv=([^:]+)/);
  assert.ok(crossingRetraceMatch);
  const crossingRetracePoints =
    crossingRetraceMatch[1]!.split(";").map((point) => {
      const [x, y] = point.split(",").map(Number);
      return { x, y };
    });
  assert.ok(
    crossingRetracePoints.every(
      (point) => point.y >= 0.45 && point.y <= 0.55
    )
  );

  const ambiguousPdfPath = path.join(directory, "ambiguous.pdf");
  const ambiguousRenderPath = path.join(directory, "ambiguous.png");
  writeSinglePageTextPdf(
    ambiguousPdfPath,
    "100",
    20,
    45,
    "0 0 1 RG",
    2,
    "0 0 1 RG\n2 w\n20 30 m\n40 30 l\nS\n0 G\n"
  );
  await renderFirstPdfPage(ambiguousPdfPath, ambiguousRenderPath);
  let ambiguousRejection: Error | null = null;
  try {
    await compileCandidateVisibleMepReconstruction({
      source_pdf_path: ambiguousPdfPath,
      registered_render_path: ambiguousRenderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: nativeRoom,
      planner_payload: nearOffsetGuess
    });
  } catch (error) {
    ambiguousRejection =
      error instanceof Error ? error : new Error(String(error));
  }
  assert.ok(ambiguousRejection);
  assert.match(
    ambiguousRejection.message,
    /candidate_visible_route_raster_verification_required:visible-blue-color-route:route/
  );
  assert.doesNotMatch(ambiguousRejection.message, /candidate_retrace_uv=/);
});

test("candidate-visible tag conflict uses a stable exterior-wall control before native-room clipping", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-stable-landmark-"));
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  writeSinglePageTextPdf(
    sourcePdfPath,
    "100",
    20,
    45,
    "0 G",
    1,
    "0 G\n2 w\n0 5 m\n58.34 5 l\nS\n" +
      "0 G\n2 w\n20 12 m\n40 12 l\nS\n" +
      "0.75 G\n1 w\n70 15 m\n70 85 l\nS\n" +
      "0.75 G\n1 w\n75 15 m\n75 85 l\nS\n"
  );
  await renderFirstPdfPage(sourcePdfPath, renderPath);
  const nativeRoom = {
    room_number: "100",
    source_scoped_id: "loaded-arch-link:100",
    boundary_model_points: [
      { x: 140, y: 135 },
      { x: 160, y: 135 },
      { x: 160, y: 155 },
      { x: 140, y: 155 }
    ],
    stable_boundary_segments: [{
      stable_kind: "exterior_wall" as const,
      source_scoped_id: "linked-wall:123456:stable-wall-unique-id",
      category: "Walls",
      name: "Exterior - Stable Test Wall",
      start_model_point: { x: 140, y: 135 },
      end_model_point: { x: 160, y: 135 }
    }],
    visible_room_label: {
      text: "100",
      source_scoped_id: "host:room-tag-100",
      built_in_category: "OST_RoomTags" as const,
      frame_id: FRAME.frame_id,
      registration_frame_id: FRAME.frame_id,
      view_id: FRAME.view_id,
      model_point: { x: 150, y: 150 }
    }
  };
  const result = await compileCandidateVisibleMepReconstruction({
    source_pdf_path: sourcePdfPath,
    registered_render_path: renderPath,
    alignment: ALIGNMENT,
    frame: FRAME,
    verified_room_scope: nativeRoom,
    planner_payload: {
      schema_version: 2,
      fixture_id: "stable-landmark-registration",
      scope_id: "room-100",
      discipline: "plumbing",
      coordinate_space: "registered_render_pixels_top_left",
      level_name: "Level 1",
      room_number: "100",
      spatial_scope: {
        boundary_pixel_points: [
          { x: 0, y: 5 },
          { x: 58.34, y: 5 },
          { x: 58.34, y: 95 },
          { x: 0, y: 95 }
        ],
        anchor_pixel_point: { x: 28.34, y: 50 },
        anchor_label: "100",
        evidence_reference: "Visible source room label and stable exterior wall."
      },
      partial_promotion_policy: "defer_ambiguous_observations",
      maximum_observations: 1,
      observations: [
        placeholderPipeObservation("stable-landmark-route", [
          { x: 20, y: 88 },
          { x: 40, y: 88 }
        ])
      ]
    }
  });
  const fallback =
    result.spatial_scope_receipt?.local_room_registration_fallback;
  assert.equal(
    fallback?.reason,
    "server_verified_room_tag_and_stable_boundary_similarity",
    JSON.stringify(fallback)
  );
  assert.equal(
    fallback?.stable_landmark_similarity?.basis,
    "exact_room_tag_plus_stable_native_boundary"
  );
  assert.equal(
    fallback?.stable_landmark_similarity?.axis,
    "horizontal"
  );
  assert.ok((fallback?.scale_x ?? 0) > 1.4);
  assert.ok((fallback?.scale_x ?? 2) < 1.6);
  assert.equal(
    fallback?.stable_landmark_similarity?.native_segment_source_scoped_id,
    "linked-wall:123456:stable-wall-unique-id"
  );
  assert.equal(
    fallback?.stable_landmark_similarity?.source_boundary_edge_index,
    2
  );
  assert.ok(
    (fallback?.stable_landmark_similarity
      ?.post_transform_endpoint_rms_residual_px ?? Number.POSITIVE_INFINITY) < 2
  );
  assert.ok(
    (fallback?.stable_landmark_similarity?.source_native_span_ratio ?? 0) > 0.95
  );
  assert.match(
    fallback?.stable_landmark_similarity?.source_pixel_sha256 ?? "",
    /^[a-f0-9]{64}$/
  );
  assert.ok(
    result.spatial_scope_receipt?.normalization_warnings?.some((warning) =>
      warning.includes("stable exterior-wall control")
    )
  );
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
            { x: 75, y: 40 },
            { x: 75, y: 90 },
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
      index === 1 || index === 2 ? { ...entry, x: 75 } : entry
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
  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
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
    }),
    /candidate_visible_source_room_label_registration_required:100:.*source_room_label_uv=(?:unavailable|\d+\.\d{4},\d+\.\d{4}):preserve_source_geometry_do_not_scale_or_translate_without_exact_room_tag/
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
    /candidate_visible_source_room_label_registration_required:100/
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
    /candidate_visible_source_room_label_registration_required:100/
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

test("candidate-visible provisional plumbing symbol requires an explicit source-graphic classification", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "candidate-visible-provisional-symbol-")
  );
  const sourcePdfPath = path.join(directory, "source.pdf");
  const renderPath = path.join(directory, "source.png");
  fs.writeFileSync(
    sourcePdfPath,
    Buffer.from("%PDF-1.4\ncandidate-visible-provisional-symbol\n")
  );
  const canvas = createCanvas(100, 100);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 100, 100);
  fs.writeFileSync(renderPath, canvas.toBuffer("image/png"));

  await assert.rejects(
    compileCandidateVisibleMepReconstruction({
      source_pdf_path: sourcePdfPath,
      registered_render_path: renderPath,
      alignment: ALIGNMENT,
      frame: FRAME,
      verified_room_scope: verifiedRoomScope(),
      planner_payload: {
        schema_version: 2,
        fixture_id: "provisional-symbol-contract",
        scope_id: "room-100",
        discipline: "plumbing",
        coordinate_space: "normalized_uv_top_left",
        level_name: "Level 1",
        room_number: "100",
        partial_promotion_policy: "defer_ambiguous_observations",
        maximum_observations: 1,
        observations: [{
          kind: "plumbing_fixture",
          discipline: "plumbing",
          observation_id: "fixture-symbol-01",
          visibility: "visible",
          confidence: 0.8,
          pixel_point: { x: 0.5, y: 0.5 },
          role: "fixture symbol",
          placement: { mode: "provisional_plan_symbol" },
          representation_classification: {
            native_target: "plan_only_marker"
          },
          service_route_connections: [],
          supported_attributes: {
            source_symbol_present: true
          },
          attribute_evidence: [{
            attribute: "source_symbol_present",
            evidence_role: "registered_source_render",
            basis: "legible_source_evidence",
            reference: "A source symbol is visible, but its graphic class was omitted."
          }]
        } as any]
      }
    }),
    /candidate_visible_provisional_plan_symbol_source_graphic_required:fixture-symbol-01:set_representation_classification_source_graphic_to_mep_connection_symbol_only_if_source_visible/
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
    verified_room_scope: verifiedRoomScope(),
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
    verified_room_scope: verifiedRoomScope(),
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
      verified_room_scope: verifiedRoomScope(),
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
    verified_room_scope: verifiedRoomScope(),
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
