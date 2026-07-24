import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { executeWorkbenchActions } from "../src/workbench/workbench_runner.js";
import { executeExistingConditionsProviderWorkbenchActions } from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { latestExistingConditionsSourceTargetManifestV1 } from "../src/existing_conditions/source_target_manifest_ledger.js";

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
    assert.match(out[0]?.summary ?? "", /accepted_routes=4, rejected_routes=1, accepted_points=0, rejected_points=0, existing_points=0, source_targets=5, identity_groups=0, junctions=2/);
    const details = out[0]?.details as any;
    assert.equal(details.source_target_manifest.source_accounting_closure, 1);
    assert.equal(details.source_target_manifest.target_count, 5);
    assert.equal(details.source_target_manifest.native_write_allowed, false);
    assert.equal(JSON.stringify(details.source_target_manifest).includes("mark-top"), false);
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

    const failedRegistration = await executeWorkbenchActions([{
      type: "compile_existing_conditions_sheet_interpretation",
      interpretation_file_path: "fixtures/interpretation.json",
      context_file_path: "fixtures/context.json",
      source_image_path: "fixtures/source.png",
      source_view_key: "view",
      receipt_output_path: "artifacts/sheet/receipt-before-ledger-failure.json"
    }, {
      type: "write_file",
      file_path: "artifacts/sheet/must-not-run.txt",
      content: "unsafe continuation"
    }], {
      registerExistingConditionsSourceTargetManifest: async () => {
        throw new Error("source_target_manifest_ledger_locked");
      }
    });
    assert.equal(failedRegistration.length, 1);
    assert.equal(failedRegistration[0]?.ok, false);
    assert.match(failedRegistration[0]?.summary ?? "", /source_target_manifest_ledger_locked/);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "sheet", "receipt-before-ledger-failure.json")), true);
    assert.equal(fs.existsSync(path.join(root, "artifacts", "sheet", "must-not-run.txt")), false);

    const sessionId = "sheet-source-target-manifest-session";
    const providerResponse = await executeExistingConditionsProviderWorkbenchActions({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "compile-sheet-manifest",
      user_text: "Compile this registered existing-conditions sheet without modifying Revit."
    }, [{
      type: "compile_existing_conditions_sheet_interpretation",
      interpretation_file_path: "fixtures/interpretation.json",
      context_file_path: "fixtures/context.json",
      source_image_path: "fixtures/source.png",
      source_view_key: "view"
    }]);
    assert.deepEqual(providerResponse.actions, []);
    assert.match(providerResponse.assistant_message, /source_targets=5/);
    const persistedManifest = latestExistingConditionsSourceTargetManifestV1(sessionId);
    assert.equal(persistedManifest?.manifest.target_count, 5);
    assert.equal(persistedManifest?.manifest.source_accounting_closure, 1);
    assert.equal(persistedManifest?.manifest.native_write_allowed, false);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sheet workbench excludes a source-supported point already visible in the registered candidate frame", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-sheet-candidate-presence-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const symbol = (drawing: any, x: number) => {
      drawing.strokeStyle = "#788cff";
      drawing.lineWidth = 3;
      drawing.beginPath();
      drawing.arc(x, 50, 9, 0, Math.PI * 2);
      drawing.moveTo(x, 34);
      drawing.lineTo(x, 41);
      drawing.moveTo(x, 59);
      drawing.lineTo(x, 66);
      drawing.moveTo(x - 16, 50);
      drawing.lineTo(x - 9, 50);
      drawing.moveTo(x + 9, 50);
      drawing.lineTo(x + 16, 50);
      drawing.stroke();
    };
    const sourceCanvas = createCanvas(100, 100);
    const sourceDrawing = sourceCanvas.getContext("2d");
    sourceDrawing.fillStyle = "white";
    sourceDrawing.fillRect(0, 0, 100, 100);
    symbol(sourceDrawing as any, 25);
    symbol(sourceDrawing as any, 75);
    const candidateCanvas = createCanvas(100, 100);
    const candidateDrawing = candidateCanvas.getContext("2d");
    candidateDrawing.fillStyle = "white";
    candidateDrawing.fillRect(0, 0, 100, 100);
    symbol(candidateDrawing as any, 25);
    const sourceImage = sourceCanvas.toBuffer("image/png");
    const candidateImage = candidateCanvas.toBuffer("image/png");
    const sourceHash = crypto.createHash("sha256").update(sourceImage).digest("hex");
    const candidateHash = crypto.createHash("sha256").update(candidateImage).digest("hex");
    const point = (primitive_id: string, x: number) => ({
      primitive_id,
      source_view_key: "view",
      source_mark_ids: [`mark-${primitive_id}`],
      kind: "point_symbol",
      points: [{ u: x / 99, v: 50 / 99 }],
      endpoints: [],
      claims: {},
      confidence: { geometry: 0.99, classification: 0.5, topology: 1, visibility: 1 }
    });
    const primitives = [point("already-visible", 25), point("missing", 75)];
    const interpretation = {
      schema_version: 1,
      package_id: "candidate-presence",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["view"],
      source_marks: primitives.map(value => ({
        source_mark_id: `mark-${value.primitive_id}`,
        source_view_key: "view",
        disposition: { status: "candidate", primitive_ids: [value.primitive_id] }
      })),
      primitives
    };
    const frame = {
      frame_id: "frame",
      view_id: 123,
      width_px: 100,
      height_px: 100,
      top_left_xyz: [0, 100, 0],
      top_right_xyz: [100, 100, 0],
      bottom_left_xyz: [0, 0, 0],
      target_level_elevation_ft: 0
    };
    const pointPolicy = {
      point_support_mode: "chromatic",
      point_radius_px: 20,
      point_minimum_supported_pixel_count: 8,
      point_provisional_supported_pixel_count: 4,
      point_expected_hue_degrees: 225,
      point_hue_tolerance_degrees: 30
    };
    const context = {
      trusted_views: [{
        source_view: {
          view_key: "view",
          sheet_key: "E-100",
          source_sha256: sourceHash,
          registration_sha256: "b".repeat(64),
          discipline: "electrical",
          level_key: "L1",
          phase_key: "EXISTING",
          role: "main_plan",
          resolution_rank: 1,
          registration: { verified: true, rms_residual_ft: 0.001, maximum_residual_ft: 0.002, confidence: 0.99 }
        },
        frame
      }],
      calibration_profile: {
        schema_version: 1,
        profile_id: "test-calibration",
        provenance: {
          outcomes_sha256: "a".repeat(64),
          prediction_count: 1,
          fixture_count: 1,
          evaluator_receipt_sha256s: ["b".repeat(64)],
          truth_revealed_only_after_seal: true
        },
        bins: [{
          discipline: "electrical",
          primitive_kind: "point_symbol",
          raw_confidence_min: 0.9,
          raw_confidence_max: 1,
          trials: 1,
          successes: 1,
          fixture_count: 1
        }]
      },
      raster_evidence_policy_by_view: { view: pointPolicy },
      candidate_raster_by_view: {
        view: {
          image_path: "fixtures/candidate.png",
          image_sha256: candidateHash,
          frame,
          policy: pointPolicy,
          overlay_output_path: "artifacts/sheet/candidate-overlay.png"
        }
      },
      evidence_receipt_file_paths: ["fixtures/prior-receipt.json"],
      policy: { maximum_registration_residual_ft: 0.03 }
    };
    fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(root, "fixtures", "source.png"), sourceImage);
    fs.writeFileSync(path.join(root, "fixtures", "candidate.png"), candidateImage);
    fs.writeFileSync(path.join(root, "fixtures", "interpretation.json"), JSON.stringify({ interpretation }));
    fs.writeFileSync(path.join(root, "fixtures", "prior-receipt.json"), JSON.stringify({
      raster_evidence: {
        schema_version: 1,
        package_id: "stale-prior-receipt-replaced-by-live-source-check",
        source_view_key: "view",
        image: { path: "fixtures/source.png", sha256: sourceHash, width_px: 100, height_px: 100 },
        policy: pointPolicy,
        route_evidence: [],
        point_evidence: [],
        accepted_primitive_ids: [],
        provisional_primitive_ids: [],
        rejected_primitive_ids: []
      }
    }));
    fs.writeFileSync(path.join(root, "fixtures", "context.json"), JSON.stringify(context));

    const out = await executeWorkbenchActions([{
      type: "compile_existing_conditions_sheet_interpretation",
      interpretation_file_path: "fixtures/interpretation.json",
      context_file_path: "fixtures/context.json",
      source_image_path: "fixtures/source.png",
      source_view_key: "view",
      receipt_output_path: "artifacts/sheet/receipt.json"
    }]);

    assert.equal(out.length, 1);
    assert.match(out[0]?.summary ?? "", /accepted_points=2, rejected_points=0, existing_points=1/);
    const details = out[0]?.details as any;
    assert.deepEqual(details.candidate_presence.existing_candidate_visible_primitive_ids, ["already-visible"]);
    assert.deepEqual(details.candidate_presence.not_present_primitive_ids, ["missing"]);
    assert.ok(details.compilation.compiled_topology.warnings.includes("candidate_presence_existing_candidate_visible:already-visible"));
    assert.equal(fs.existsSync(path.join(root, "artifacts", "sheet", "candidate-overlay.png")), true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sheet workbench hydrates prior evidence and compiles a cross-sheet candidate identity", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-sheet-cross-identity-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const fixtures = path.join(root, "fixtures");
    fs.mkdirSync(fixtures, { recursive: true });
    const symbolImage = (x: number) => {
      const canvas = createCanvas(100, 100);
      const drawing = canvas.getContext("2d");
      drawing.fillStyle = "white";
      drawing.fillRect(0, 0, 100, 100);
      drawing.strokeStyle = "#003fff";
      drawing.lineWidth = 3;
      drawing.beginPath();
      drawing.arc(x, 50, 9, 0, Math.PI * 2);
      drawing.moveTo(x - 14, 50);
      drawing.lineTo(x + 14, 50);
      drawing.stroke();
      return canvas.toBuffer("image/png");
    };
    const sourceA = symbolImage(25);
    const sourceB = symbolImage(75);
    const candidate = symbolImage(25);
    const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
    const hashA = hash(sourceA);
    const hashB = hash(sourceB);
    const candidateHash = hash(candidate);
    fs.writeFileSync(path.join(fixtures, "source-a.png"), sourceA);
    fs.writeFileSync(path.join(fixtures, "source-b.png"), sourceB);
    fs.writeFileSync(path.join(fixtures, "candidate.png"), candidate);
    const policy = { point_support_mode: "chromatic", point_radius_px: 20, point_minimum_supported_pixel_count: 8, point_provisional_supported_pixel_count: 4, point_expected_hue_degrees: 225, point_hue_tolerance_degrees: 30 };
    const candidateFrame = { frame_id: "candidate-frame", view_id: 900, width_px: 100, height_px: 100, top_left_xyz: [0, 100, 0], top_right_xyz: [100, 100, 0], bottom_left_xyz: [0, 0, 0], target_level_elevation_ft: 0 };
    const interpretation = {
      schema_version: 1,
      package_id: "cross-sheet-candidate-identity",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["view-a", "view-b"],
      source_marks: [
        { source_mark_id: "mark-a", source_view_key: "view-a", disposition: { status: "candidate", primitive_ids: ["point-a"] } },
        { source_mark_id: "mark-b", source_view_key: "view-b", disposition: { status: "candidate", primitive_ids: ["point-b"] } }
      ],
      primitives: [
        { primitive_id: "point-a", source_view_key: "view-a", source_mark_ids: ["mark-a"], kind: "point_symbol", points: [{ u: 25 / 99, v: 50 / 99 }], claims: {}, confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 1 } },
        { primitive_id: "point-b", source_view_key: "view-b", source_mark_ids: ["mark-b"], kind: "point_symbol", points: [{ u: 75 / 99, v: 50 / 99 }], claims: {}, confidence: { geometry: 0.9, classification: 0.5, topology: 0.5, visibility: 1 } }
      ]
    };
    const sourceView = (viewKey: string, sheetKey: string, sourceHash: string) => ({ view_key: viewKey, sheet_key: sheetKey, source_sha256: sourceHash, registration_sha256: "b".repeat(64), discipline: "electrical", level_key: "L1", phase_key: "EXISTING", role: "main_plan", resolution_rank: 1, registration: { verified: true, rms_residual_ft: 0.001, maximum_residual_ft: 0.002, confidence: 0.99 } });
    const context = {
      trusted_views: [
        { source_view: sourceView("view-a", "E-100", hashA), frame: { ...candidateFrame, frame_id: "source-a" } },
        { source_view: sourceView("view-b", "E-101", hashB), frame: { ...candidateFrame, frame_id: "source-b", top_left_xyz: [-50, 100, 0], top_right_xyz: [50, 100, 0], bottom_left_xyz: [-50, 0, 0] } }
      ],
      calibration_profile: { schema_version: 1, profile_id: "point-calibration", provenance: { outcomes_sha256: "a".repeat(64), prediction_count: 1, fixture_count: 1, evaluator_receipt_sha256s: ["b".repeat(64)], truth_revealed_only_after_seal: true }, bins: [{ discipline: "electrical", primitive_kind: "point_symbol", raw_confidence_min: 0.4, raw_confidence_max: 0.6, trials: 1, successes: 1, fixture_count: 1 }] },
      evidence_receipt_file_paths: ["fixtures/prior.json"],
      raster_evidence_policy_by_view: { "view-a": policy, "view-b": policy },
      candidate_raster_by_view: {
        "view-a": { image_path: "fixtures/candidate.png", image_sha256: candidateHash, frame: candidateFrame, policy, point_identity_tolerance_px: 3 },
        "view-b": { image_path: "fixtures/candidate.png", image_sha256: candidateHash, frame: candidateFrame, policy, point_identity_tolerance_px: 3 }
      }
    };
    fs.writeFileSync(path.join(fixtures, "interpretation.json"), JSON.stringify({ interpretation }));
    fs.writeFileSync(path.join(fixtures, "context.json"), JSON.stringify(context));
    fs.writeFileSync(path.join(fixtures, "prior.json"), JSON.stringify({
      raster_evidence: { schema_version: 1, package_id: interpretation.package_id, source_view_key: "view-a", image: { path: "source-a.png", sha256: hashA, width_px: 100, height_px: 100 }, policy, route_evidence: [], point_evidence: [{ primitive_id: "point-a", sampled_pixel_count: 100, supported_pixel_count: 20, chromatic_pixel_count: 20, monochrome_pixel_count: 0, dominant_hue_fraction: 1, status: "accepted_raster_support", support_modality: "chromatic_symbol", coherent_hue_degrees: 225 }], accepted_primitive_ids: ["point-a"], provisional_primitive_ids: [], rejected_primitive_ids: [] },
      candidate_presence: { schema_version: 1, package_id: interpretation.package_id, source_view_key: "view-a", source_image_sha256: hashA, candidate_image: { path: "candidate.png", sha256: candidateHash, width_px: 100, height_px: 100, frame_id: candidateFrame.frame_id, view_id: candidateFrame.view_id }, policy, point_evidence: [{ primitive_id: "point-a", source_status: "accepted_raster_support", candidate_status: "accepted_raster_support", mapped_candidate_uv: { u: 25 / 99, v: 50 / 99 }, status: "existing_candidate_visible", supported_pixel_count: 20, coherent_hue_degrees: 225 }], existing_candidate_visible_primitive_ids: ["point-a"], ambiguous_candidate_presence_primitive_ids: [], not_present_primitive_ids: [], source_not_accepted_primitive_ids: [] }
    }));

    const out = await executeWorkbenchActions([{
      type: "compile_existing_conditions_sheet_interpretation",
      interpretation_file_path: "fixtures/interpretation.json",
      context_file_path: "fixtures/context.json",
      source_image_path: "fixtures/source-b.png",
      source_view_key: "view-b",
      receipt_output_path: "artifacts/cross-sheet/receipt.json"
    }]);
    assert.equal(out[0]?.ok, true);
    assert.match(out[0]?.summary ?? "", /accepted_points=1, rejected_points=0, existing_points=1, source_targets=2, identity_groups=1/);
    const details = out[0]?.details as any;
    assert.equal(details.compilation.candidate_identity_groups[0]?.scope, "cross_sheet");
    assert.deepEqual(details.compilation.candidate_identity_groups[0]?.members.map((member: any) => member.primitive_id), ["point-a", "point-b"]);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
