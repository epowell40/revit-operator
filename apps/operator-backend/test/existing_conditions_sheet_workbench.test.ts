import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { executeWorkbenchActions } from "../src/workbench/workbench_runner.js";

test("sheet workbench rechecks chromatic routes and compiles junctions as one terminal step", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-sheet-wb-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const canvas = createCanvas(120, 80);
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = "white";
    drawing.fillRect(0, 0, 120, 80);
    drawing.strokeStyle = "#00ff00";
    drawing.lineWidth = 3;
    drawing.beginPath();
    drawing.moveTo(10, 20);
    drawing.lineTo(60, 20);
    drawing.lineTo(60, 50);
    drawing.lineTo(100, 50);
    drawing.moveTo(60, 50);
    drawing.lineTo(60, 70);
    drawing.stroke();
    drawing.strokeStyle = "black";
    drawing.beginPath();
    drawing.moveTo(10, 65);
    drawing.lineTo(100, 65);
    drawing.stroke();
    drawing.strokeStyle = "#00ff00";
    drawing.beginPath();
    drawing.moveTo(10, 65);
    drawing.lineTo(25, 65);
    drawing.stroke();
    const image = canvas.toBuffer("image/png");
    const sourceHash = crypto.createHash("sha256").update(image).digest("hex");
    const route = (
      id: string,
      start: [number, number],
      end: [number, number],
      directions: [[number, number], [number, number]]
    ) => ({
      primitive_id: id,
      source_view_key: "view",
      source_mark_ids: [`mark-${id}`],
      kind: "route_segment",
      points: [{ u: start[0] / 120, v: start[1] / 80 }, { u: end[0] / 120, v: end[1] / 80 }],
      endpoints: [
        { endpoint_key: `${id}:start`, point: { u: start[0] / 120, v: start[1] / 80 }, outward_direction_uv: directions[0], boundary: "internal" },
        { endpoint_key: `${id}:end`, point: { u: end[0] / 120, v: end[1] / 80 }, outward_direction_uv: directions[1], boundary: "internal" }
      ],
      claims: {},
      confidence: { geometry: 0.99, classification: 0.8, topology: 0.99, visibility: 0.99 }
    });
    const primitives = [
      route("top", [10, 20], [60, 20], [[-1, 0], [1, 0]]),
      route("drop", [60, 20], [60, 50], [[0, -1], [0, 1]]),
      route("branch", [60, 50], [100, 50], [[-1, 0], [1, 0]]),
      route("continuation", [60, 50], [60, 70], [[0, -1], [0, 1]]),
      route("black-overlap", [10, 65], [100, 65], [[-1, 0], [1, 0]])
    ];
    const interpretation = {
      schema_version: 1,
      package_id: "workbench-sheet",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["view"],
      source_marks: primitives.map(value => ({
        source_mark_id: `mark-${value.primitive_id}`,
        source_view_key: "view",
        disposition: { status: "candidate", primitive_ids: [value.primitive_id] }
      })),
      primitives
    };
    const context = {
      trusted_views: [{
        source_view: {
          view_key: "view",
          sheet_key: "P-100",
          source_sha256: sourceHash,
          registration_sha256: "b".repeat(64),
          discipline: "plumbing",
          level_key: "L1",
          phase_key: "EXISTING",
          role: "main_plan",
          resolution_rank: 1,
          registration: { verified: true, rms_residual_ft: 0.001, maximum_residual_ft: 0.002, confidence: 0.99 }
        },
        frame: {
          frame_id: "frame",
          view_id: 123,
          width_px: 120,
          height_px: 80,
          top_left_xyz: [0, 80, 0],
          top_right_xyz: [120, 80, 0],
          bottom_left_xyz: [0, 0, 0],
          target_level_elevation_ft: 0
        }
      }],
      calibration_profile: {
        schema_version: 1,
        profile_id: "test-calibration",
        provenance: {
          outcomes_sha256: "a".repeat(64),
          prediction_count: 100,
          fixture_count: 4,
          evaluator_receipt_sha256s: ["b".repeat(64)],
          truth_revealed_only_after_seal: true
        },
        bins: [{
          discipline: "plumbing",
          primitive_kind: "route_segment",
          raw_confidence_min: 0.9,
          raw_confidence_max: 1,
          trials: 100,
          successes: 100,
          fixture_count: 4
        }]
      },
      policy: { maximum_registration_residual_ft: 0.03 }
    };
    fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(root, "fixtures", "source.png"), image);
    fs.writeFileSync(path.join(root, "fixtures", "interpretation.json"), JSON.stringify({
      schema_version: 1,
      provider: "gemini",
      interpretation
    }));
    fs.writeFileSync(path.join(root, "fixtures", "context.json"), JSON.stringify(context));

    const out = await executeWorkbenchActions([{
      type: "compile_existing_conditions_sheet_interpretation",
      interpretation_file_path: "fixtures/interpretation.json",
      context_file_path: "fixtures/context.json",
      source_image_path: "fixtures/source.png",
      source_view_key: "view",
      overlay_output_path: "artifacts/sheet/overlay.png",
      receipt_output_path: "artifacts/sheet/receipt.json"
    }]);

    assert.equal(out.length, 1);
    assert.equal(out[0]?.ok, true);
    assert.match(out[0]?.summary ?? "", /accepted_routes=4, rejected_routes=1, junctions=2/);
    const details = out[0]?.details as any;
    const evidence = new Map(details.raster_evidence.route_evidence.map((value: any) => [value.primitive_id, value]));
    assert.equal((evidence.get("black-overlap") as any)?.support_modality, "chromatic_line");
    assert.equal((evidence.get("black-overlap") as any)?.status, "rejected_raster_extent");
    const topology = details.compilation.compiled_topology;
    assert.equal(topology.junctions.filter((value: any) => value.kind === "elbow_or_offset").length, 1);
    assert.equal(topology.junctions.filter((value: any) => value.kind === "tee_or_branch").length, 1);
    assert.equal(topology.component_by_primitive_id.top, topology.component_by_primitive_id.branch);
    assert.notEqual(topology.component_by_primitive_id["black-overlap"], topology.component_by_primitive_id.top);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "sheet", "overlay.png")), true);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "sheet", "receipt.json")), true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
