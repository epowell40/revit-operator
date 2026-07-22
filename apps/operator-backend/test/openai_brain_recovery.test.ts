import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testOnlyBuildCapabilityRecoveryResponse,
  __testOnlyBuildCandidateVisibleDeterministicPreparationResponse,
  __testOnlyCandidateVisibleDurableLandmarkRegistrationAssessment,
  __testOnlyCandidateVisibleRegistrationCategories,
  __testOnlyCandidateVisibleRoomLabelFromToolResults,
  __testOnlyBuildCandidateVisibleRecoveryPrompt,
  __testOnlyBuildCandidateVisibleRoomScopeResponse,
  __testOnlyBuildCandidateVisibleReadyToCompilePrompt,
  __testOnlyBuildCandidateVisibleTerminalGuardAfterWorkbench,
  __testOnlyBuildCandidateVisibleTerminalGuardResponse,
  __testOnlyCompileRegisteredMepReconstructionForSession,
  __testOnlyCandidateVisibleRecoveryImmutableClaimsSha256,
  __testOnlyCandidateVisibleVerifiedRoomScopeFromToolResults,
  __testOnlyBuildInitialRedlinePreflightAction,
  __testOnlyIsExistingConditionsReconstructionRequest,
  __testOnlyExtractFirstJsonObject,
  __testOnlyExtractResponsesApiOutputText,
  __testOnlyNormalizeNativeRevitActionBodiesForRouting,
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest,
  __testOnlyNoteRedlineSeedForRecoveryTest,
  __testOnlyRehydrateRedlineVisionProgressFromRunBundle,
  __testOnlyRecordCandidateVisibleCompileResults,
  __testOnlyRecordRedlineWorkbenchEvidenceAttempts,
  __testOnlySeedRedlineViewAlignment,
  __testOnlySetCandidateVisibleCompileContext,
  __testOnlyShouldBypassCandidateVisiblePreModelDiscovery,
  __testOnlyShouldUseOpenAiGeometryFallbackAfterGemini,
  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest,
  __testOnlySuppressCandidateVisibleCompileReadyWorkbenchActions,
  __testOnlySuppressCandidateVisibleGuardedWorkbenchActions,
  __testOnlySuppressRepeatedGeminiActions,
  __testOnlySuppressRepeatedOrientActions
} from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { getCodexBaseInstructionsForTest } from "../src/brains/codex_brain.js";
import { ensureWorkspaceLayout } from "../src/workspace.js";

function mkReq(args?: Partial<ChatRequest>): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "session-sidecar",
    message_id: "message-sidecar",
    user_text: "print all power sheets",
    ...args
  };
}

test("candidate-visible native inventory follows Gemini registration-control categories", () => {
  assert.deepEqual(
    __testOnlyCandidateVisibleRegistrationCategories([
      {
        kind: "grid",
        source_normalized_x: 0.1,
        source_normalized_y: 0.1,
        view_normalized_x: 0.2,
        view_normalized_y: 0.2,
        score: 0.9,
        label: "grid 1/F"
      },
      {
        kind: "grid",
        source_normalized_x: 0.8,
        source_normalized_y: 0.8,
        view_normalized_x: 0.7,
        view_normalized_y: 0.7,
        score: 0.9,
        label: "grid 7/A"
      }
    ]),
    ["OST_Grids"]
  );
  assert.deepEqual(
    __testOnlyCandidateVisibleRegistrationCategories([
      {
        kind: "stair" as const,
        source_normalized_x: 0.2,
        source_normalized_y: 0.2,
        view_normalized_x: 0.2,
        view_normalized_y: 0.2,
        score: 0.8,
        label: "north stair"
      },
      {
        kind: "exterior_corner",
        source_normalized_x: 0.8,
        source_normalized_y: 0.8,
        view_normalized_x: 0.8,
        view_normalized_y: 0.8,
        score: 0.8,
        label: "southeast corner"
      }
    ]),
    ["OST_Stairs", "OST_StairsRuns", "OST_StairsLandings", "OST_Walls"]
  );
  assert.deepEqual(
    __testOnlyCandidateVisibleRegistrationCategories([
      {
        kind: "exterior_corner",
        source_normalized_x: 0.1,
        source_normalized_y: 0.1,
        view_normalized_x: 0.1,
        view_normalized_y: 0.1,
        score: 0.98,
        label: "northwest exterior corner"
      },
      {
        kind: "stair" as const,
        source_normalized_x: 0.8,
        source_normalized_y: 0.15,
        view_normalized_x: 0.72,
        view_normalized_y: 0.2,
        score: 0.99,
        label: "Stair 2 core"
      },
      {
        kind: "elevator_core",
        source_normalized_x: 0.2,
        source_normalized_y: 0.85,
        view_normalized_x: 0.25,
        view_normalized_y: 0.78,
        score: 0.98,
        label: "Stair 1 and public elevator core"
      }
    ]),
    [
      "OST_Stairs",
      "OST_StairsRuns",
      "OST_StairsLandings",
      "OST_ShaftOpening"
    ],
    "two separated stair/core controls are sufficient without a whole-crop wall inventory"
  );
});

test("candidate-visible durable landmark assessment reports exact native matching failures", () => {
  const frame = {
    frame_id: "frame-diagnostic",
    view_id: 3960410,
    width_px: 1000,
    height_px: 1000,
    top_left_xyz: [0, 100, 10] as [number, number, number],
    top_right_xyz: [100, 100, 10] as [number, number, number],
    bottom_left_xyz: [0, 0, 10] as [number, number, number],
    target_level_elevation_ft: 10
  };
  const alignment = {
    source_image_path: "registered.png",
    frame_id: frame.frame_id,
    view_id: frame.view_id,
    matched: true,
    confidence: 0.98,
    crop: { min_u: 0, min_v: 0, max_u: 1, max_v: 1 },
    registration_controls: [
      {
        kind: "stair" as const,
        source_normalized_x: 0.1,
        source_normalized_y: 0.1,
        view_normalized_x: 0.1,
        view_normalized_y: 0.1,
        score: 0.99,
        label: "north stair"
      },
      {
        kind: "stair" as const,
        source_normalized_x: 0.8,
        source_normalized_y: 0.8,
        view_normalized_x: 0.8,
        view_normalized_y: 0.8,
        score: 0.99,
        label: "south stair"
      }
    ],
    analysis: "structured control test",
    provider: "openai" as const,
    model: "gpt-5.6-sol",
    attempted_models: ["gemini-3-flash-preview", "gpt-5.6-sol"],
    fallback_reason: "native rejection",
    updated_at_ms: Date.now()
  };
  const expectedModelBounds = [0, 0, -100, 100, 100, 100];
  const frameResult = {
    action_id: "frame",
    path: "/revit/export-view-frame",
    status: "done",
    result_json: {
      ok: true,
      frameId: frame.frame_id,
      viewId: frame.view_id,
      widthPx: frame.width_px,
      heightPx: frame.height_px,
      mapping: {
        topLeftXyz: frame.top_left_xyz,
        topRightXyz: frame.top_right_xyz,
        bottomLeftXyz: frame.bottom_left_xyz
      },
      targetLevel: { elevationFt: frame.target_level_elevation_ft }
    }
  };
  const inventoryResult = (itemsSampled: unknown[]) => ({
    action_id:
      "candidate-visible-broad-inventory:frame-diagnostic:" +
      "scope-ost-stairs+ost-stairsruns+ost-stairslandings:500",
    path: "/revit/export-visible-elements",
    status: "done",
    result_json: {
      ok: true,
      frameId: frame.frame_id,
      viewId: frame.view_id,
      widthPx: frame.width_px,
      heightPx: frame.height_px,
      mapping: {
        topLeftXyz: frame.top_left_xyz,
        topRightXyz: frame.top_right_xyz,
        bottomLeftXyz: frame.bottom_left_xyz
      },
      targetLevel: { elevationFt: frame.target_level_elevation_ft },
      modelBoundsApplied: true,
      modelBoundsFt: {
        min: { x: 0, y: 0, z: -100 },
        max: { x: 100, y: 100, z: 100 }
      },
      truncated: false,
      itemsSampled
    }
  });
  const nativeEntry = (
    sourceScopedId: string,
    normalizedX: number,
    normalizedY: number,
    modelX: number,
    modelY: number
  ) => ({
    sourceScopedId,
    builtInCategory: "OST_Stairs",
    bbox: {
      model: { center: { x: modelX, y: modelY } },
      image: {
        minNormalizedX: normalizedX,
        minNormalizedY: normalizedY,
        maxNormalizedX: normalizedX,
        maxNormalizedY: normalizedY
      }
    }
  });
  const assess = (itemsSampled: unknown[]) =>
    __testOnlyCandidateVisibleDurableLandmarkRegistrationAssessment({
      toolResults: [frameResult, inventoryResult(itemsSampled)] as any,
      frame,
      alignment,
      expectedModelBounds,
      sourcePdfSha256: "source-hash",
      registeredRenderSha256: "render-hash"
    });

  const noCandidate = assess([
    nativeEntry("host:stair-a", 0.4, 0.4, 40, 40),
    nativeEntry("host:stair-b", 0.5, 0.5, 50, 50)
  ]);
  assert.equal(noCandidate.receipt, null);
  assert.equal(noCandidate.failure_reason, "no_candidate_for_control");
  assert.equal(noCandidate.details.control_index, 0);
  assert.equal(
    (noCandidate.details.closest_candidate as any)
      ?.native_source_scoped_id,
    "host:stair-a"
  );

  const precisionBoundary = assess([
    nativeEntry("host:stair-a", 0.16010226595429535, 0.1, 16, 10),
    nativeEntry("host:stair-b", 0.8, 0.8, 80, 80)
  ]);
  assert.ok(precisionBoundary.receipt);
  assert.equal(precisionBoundary.failure_reason, null);

  const ambiguous = assess([
    nativeEntry("host:stair-a", 0.1, 0.1, 10, 10),
    nativeEntry("host:stair-b", 0.105, 0.1, 11, 10),
    nativeEntry("host:stair-c", 0.8, 0.8, 80, 80)
  ]);
  assert.equal(ambiguous.receipt, null);
  assert.equal(
    ambiguous.failure_reason,
    "ambiguous_candidate_for_control"
  );
  assert.equal(
    (ambiguous.details.best_candidate as any)?.native_source_scoped_id,
    "host:stair-a"
  );
  assert.equal(
    (ambiguous.details.second_candidate as any)?.native_source_scoped_id,
    "host:stair-b"
  );
});

test("native landmark rejection promotes Gemini semantics to an OpenAI geometry fallback", () => {
  const alignment = {
    source_image_path: "artifacts/source.png",
    frame_id: "frame-1",
    view_id: 101,
    matched: true,
    confidence: 0.95,
    crop: { min_u: 0, min_v: 0, max_u: 1, max_v: 1 },
    registration_controls: [],
    analysis: "Gemini matched labeled grids.",
    provider: "gemini" as const,
    model: "gemini-3-flash-preview",
    attempted_models: ["gemini-3-flash-preview"],
    fallback_reason: null,
    updated_at_ms: Date.now()
  };
  assert.equal(
    __testOnlyShouldUseOpenAiGeometryFallbackAfterGemini({
      alignment,
      exact_frame_available: true,
      native_landmark_validation_complete: true,
      durable_landmark_receipt_verified: false,
      requested_room_number: null
    }),
    true
  );
  assert.equal(
    __testOnlyShouldUseOpenAiGeometryFallbackAfterGemini({
      alignment,
      exact_frame_available: true,
      native_landmark_validation_complete: false,
      durable_landmark_receipt_verified: false,
      requested_room_number: null
    }),
    false,
    "the provider switch waits for a native result or the bounded retry budget"
  );
  assert.equal(
    __testOnlyShouldUseOpenAiGeometryFallbackAfterGemini({
      alignment,
      exact_frame_available: true,
      native_landmark_validation_complete: true,
      durable_landmark_receipt_verified: true,
      requested_room_number: null
    }),
    false
  );
  assert.equal(
    __testOnlyShouldUseOpenAiGeometryFallbackAfterGemini({
      alignment,
      exact_frame_available: true,
      native_landmark_validation_complete: true,
      durable_landmark_receipt_verified: false,
      requested_room_number: "403"
    }),
    false,
    "verified room scope does not need a second whole-floor landmark registration"
  );
});

test("candidate-visible trial wording remains an existing-conditions request when the PDF was attached first", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText:
      "Using the attached sample plumbing crop, reconstruct only the clearly visible continuous blue route A as existing conditions. Use the exact room tag pair for translation, current linked-room containment, source-raster support, dry-run, apply, readback, and visual verification.",
    rememberedRedlinePath: "artifacts/uploads/sample_plumbing_room_crop.pdf"
  });

  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.file_path, "artifacts/uploads/sample_plumbing_room_crop.pdf");
});

test("clean source-PDF drafting wording enters existing-conditions reconstruction without the exact phrase", () => {
  const req = mkReq({
    session_id: "session-clean-existing-plumbing-intent",
    user_text:
      "Draft the visible existing plumbing in the source PDF into this empty test model.",
    user_attachments: [{
      id: "source-pdf",
      relative_path: "artifacts/uploads/P1.01_sample_plumbing_crop.pdf",
      filename: "P1.01_sample_plumbing_crop.pdf",
      mime: "application/pdf"
    }]
  });

  assert.equal(__testOnlyIsExistingConditionsReconstructionRequest(req), true);
  assert.equal(
    __testOnlyIsExistingConditionsReconstructionRequest(
      mkReq({
        user_text:
          "Change the existing receptacle indicated by the attached redline."
      })
    ),
    false
  );
  assert.equal(
    __testOnlyIsExistingConditionsReconstructionRequest(
      mkReq({
        user_text:
          "Draw a new pipe from the existing plumbing fixture shown in the source PDF."
      })
    ),
    false
  );
  for (const userText of [
    "Draw a new pipe from existing plumbing fixture shown in the source PDF.",
    "Draw a new pipe off the existing plumbing fixture shown in the source PDF.",
    "Model one new branch into the existing plumbing shown in the attached plan."
  ]) {
    assert.equal(
      __testOnlyIsExistingConditionsReconstructionRequest(
        mkReq({ user_text: userText })
      ),
      false,
      userText
    );
  }
});

test("capability recovery falls back to tool discovery and native api search", () => {
  const res = __testOnlyBuildCapabilityRecoveryResponse({
    req: mkReq({
      context: {
        ui: {
          approval_mode: "yolo",
          write_grant: { active: true, mode: "yolo" },
          native_api_policy: { profile: "unrestricted", locked: false }
        }
      }
    }),
    decision: {
      assistant_message: "Answer: I could not find the command.",
      actions: [],
      web_requests: []
    } as any,
    filteredActions: [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/unknown-print-thing"
      }
    ],
    allowlisted: []
  });

  assert.ok(res);
  assert.match(res?.assistant_message || "", /native tool surface/i);
  assert.equal(res?.actions[0]?.method, "POST");
  assert.equal(res?.actions[0]?.path, "/revit/tool-search");
  assert.match(JSON.stringify(res?.actions[0]?.body || {}), /unknown print thing/i);
  assert.equal(res?.actions[1]?.method, "POST");
  assert.equal(res?.actions[1]?.path, "/revit/native-api-search");
  assert.match(JSON.stringify(res?.actions[1]?.body || {}), /unknown print thing/i);
});

test("capability recovery keeps redline discovery queries under native schema limits", () => {
  const res = __testOnlyBuildCapabilityRecoveryResponse({
    req: mkReq({
      user_text:
        "but can you see coordinates of the objects within the room? isn't that enough to place an element close to where it belongs, then iterate through screenshots? are you receiving screenshots of the active view? are you receiving coordinates of the elements in the room?"
    }),
    decision: {
      assistant_message: "Answer: blocked",
      actions: [],
      web_requests: []
    } as any,
    filteredActions: [],
    allowlisted: []
  });

  assert.ok(res);
  for (const action of res?.actions || []) {
    if (action.path === "/revit/tool-search" || action.path === "/revit/native-api-search") {
      assert.ok(String((action.body as any)?.query ?? "").length <= 200);
      assert.match(String((action.body as any)?.query ?? ""), /redline spatial placement/i);
    }
  }
});

test("capability recovery adds UI observation for blocked UI-like situations", () => {
  const res = __testOnlyBuildCapabilityRecoveryResponse({
    req: mkReq({
      user_text: "Revit is stuck on a printer dialog, get past it and keep printing"
    }),
    decision: {
      assistant_message: "Answer: blocked by modal printer dialog",
      actions: [],
      web_requests: []
    } as any,
    filteredActions: [],
    allowlisted: []
  });

  const paths = (res?.actions || []).map((action) => action.path);
  assert.ok(paths.includes("/revit/state-snapshot"));
  assert.ok(paths.includes("/revit/computer-use-observe"));
});

test("existing-conditions evidence attempts suppress duplicate Gemini and orientation calls without blocking new evidence", () => {
  const sessionId = "session-existing-conditions-evidence-attempts";
  const firstGemini = {
    type: "gemini_redline_analyze",
    file_path: "artifacts/uploads/source.pdf",
    image_paths: ["artifacts/uploads/source.pdf"],
    objective: "Extract visible plumbing."
  } as any;
  const firstOrient = {
    type: "redline_orient",
    file_path: "artifacts/uploads/source.pdf",
    expected_sheet: "P1.01",
    sheet_outline: { minU: 0.1, minV: 0.1, maxU: 1.5, maxV: 0.8 },
    viewport_geometry: [],
    title_blocks: [{ elementId: 1, typeName: "STARTING VIEW" }]
  } as any;
  __testOnlyRecordRedlineWorkbenchEvidenceAttempts(sessionId, [firstGemini, firstOrient]);

  const duplicateGemini = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
    ...firstGemini,
    objective: "Use different wording but inspect the same source evidence.",
    region_boxes: [{ x: 0, y: 0, w: 1, h: 1, label: "full frame" }]
  }]);
  assert.equal(duplicateGemini.suppressed_count, 1);
  assert.deepEqual(duplicateGemini.actions, []);

  const incompleteRegionWording = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
    ...firstGemini,
    objective: "Changed objective wording.",
    region_boxes: [{
      x: null,
      y: 0.2,
      w: 0.4,
      h: 0.3,
      label: "Changed label",
      target_hint: "Changed target wording"
    }]
  }]);
  assert.equal(incompleteRegionWording.suppressed_count, 1);
  assert.deepEqual(incompleteRegionWording.actions, []);

  const registeredRenderGemini = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
    ...firstGemini,
    image_paths: ["artifacts/redline/registered/page_0001.png"]
  }]);
  assert.equal(registeredRenderGemini.suppressed_count, 0);
  assert.equal(registeredRenderGemini.actions.length, 1);

  const duplicateOrient = __testOnlySuppressRepeatedOrientActions(sessionId, [{
    ...firstOrient
  }]);
  assert.equal(duplicateOrient.suppressed_count, 1);
  assert.deepEqual(duplicateOrient.actions, []);

  const correctedSheetOrient = __testOnlySuppressRepeatedOrientActions(sessionId, [{
    ...firstOrient,
    sheet_outline: { minU: 0, minV: 0, maxU: 3.5, maxV: 2.5 },
    viewport_geometry: [{ viewId: 3960410 }],
    title_blocks: [{ elementId: 2, typeName: "MECHANICAL" }]
  }]);
  assert.equal(correctedSheetOrient.suppressed_count, 0);
  assert.equal(correctedSheetOrient.actions.length, 1);

  const pageSessionId = "session-existing-conditions-page-selection";
  __testOnlyRecordRedlineWorkbenchEvidenceAttempts(pageSessionId, [{
    ...firstGemini,
    page_start: 0,
    max_pages: 1
  }]);
  const differentPageSelection = __testOnlySuppressRepeatedGeminiActions(pageSessionId, [{
    ...firstGemini,
    page_start: 1,
    max_pages: 1
  }]);
  assert.equal(differentPageSelection.suppressed_count, 0);
  assert.equal(differentPageSelection.actions.length, 1);
});

test("persisted redline evidence attempts rehydrate after a backend restart", () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "redline-evidence-attempt-rehydrate-"));
  const sessionId = "session-redline-evidence-attempt-rehydrate";
  const sourcePath = "artifacts/uploads/source.pdf";
  const sessionDir = path.join(root, "runs", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const attempts = [
    {
      ts: new Date().toISOString(),
      kind: "mcp.tool_call",
      session_id: sessionId,
      tool: "workbench.gemini_redline_analyze",
      server: "operator-backend",
      arguments: {
        type: "gemini_redline_analyze",
        file_path: sourcePath,
        image_paths: [sourcePath],
        objective: "Original wording."
      },
      status: "requested"
    },
    {
      ts: new Date().toISOString(),
      kind: "mcp.tool_call",
      session_id: sessionId,
      tool: "workbench.redline_orient",
      server: "operator-backend",
      arguments: {
        type: "redline_orient",
        file_path: sourcePath,
        expected_sheet: "P1.01",
        sheet_outline: { minU: 0.1, minV: 0.1, maxU: 1.5, maxV: 0.8 },
        viewport_geometry: []
      },
      status: "requested"
    }
  ];
  fs.writeFileSync(
    path.join(sessionDir, "tool_calls.jsonl"),
    attempts.map((attempt) => JSON.stringify(attempt)).join("\n") + "\n",
    "utf8"
  );

  try {
    __testOnlyRehydrateRedlineVisionProgressFromRunBundle(sessionId);
    const gemini = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
      type: "gemini_redline_analyze",
      file_path: sourcePath,
      image_paths: [sourcePath],
      objective: "Changed wording must not bypass the evidence fingerprint."
    } as any]);
    assert.equal(gemini.suppressed_count, 1);

    const orient = __testOnlySuppressRepeatedOrientActions(sessionId, [{
      type: "redline_orient",
      file_path: sourcePath,
      expected_sheet: "P1.01",
      sheet_outline: { minU: 0.1, minV: 0.1, maxU: 1.5, maxV: 0.8 },
      viewport_geometry: []
    } as any]);
    assert.equal(orient.suppressed_count, 1);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate-visible compiler guards suppress repeated vision and generic discovery recovery", () => {
  const sessionId = "session-candidate-visible-guard";
  __testOnlySetCandidateVisibleCompileContext(sessionId, "source.pdf");
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:route-1",
    details: {
      recovery_instruction: "Revise package_json against the exact deterministic compiler error."
    }
  }]);

  const geminiSuppression = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
    type: "gemini_redline_analyze",
    file_path: "source.pdf",
    objective: "Analyze the plumbing source again despite unchanged evidence."
  } as any]);
  assert.equal(geminiSuppression.suppressed_count, 1);
  assert.deepEqual(geminiSuppression.actions, []);

  const recovery = __testOnlyBuildCapabilityRecoveryResponse({
    req: mkReq({
      session_id: sessionId,
      user_text: "Draft existing conditions from this source PDF."
    }),
    decision: {
      assistant_message: "No executable action.",
      actions: [],
      web_requests: []
    } as any,
    filteredActions: [],
    allowlisted: []
  });
  assert.ok(recovery);
  assert.deepEqual(recovery?.actions, []);
  assert.match(recovery?.assistant_message ?? "", /candidate_visible_route_outside_spatial_scope:route-1/);
  assert.match(recovery?.assistant_message ?? "", /stopped generic vision and tool-discovery recovery/i);

  const guardedExistingConditionsReq = mkReq({
    session_id: sessionId,
    user_text: ""
  });
  const oneBoundedRecompile = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    guardedExistingConditionsReq,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: "source.pdf",
        objective: "Re-run unchanged source vision."
      },
      {
        type: "redline_orient",
        file_path: "source.pdf"
      }
    ] as any
  );
  assert.equal(oneBoundedRecompile.suppressed_count, 2);
  assert.deepEqual(
    oneBoundedRecompile.actions.map((action) => action.type),
    ["compile_registered_mep_reconstruction"]
  );

  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "source.pdf",
    "self-induced-new-frame-context-before-second-failure"
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:route-2"
  }]);
  const stoppedAfterSecondFailure = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    guardedExistingConditionsReq,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: "source.pdf",
        objective: "Try the same evidence again."
      },
      {
        type: "redline_orient",
        file_path: "source.pdf"
      }
    ] as any
  );
  assert.equal(stoppedAfterSecondFailure.suppressed_count, 3);
  assert.deepEqual(stoppedAfterSecondFailure.actions, []);
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    sourceImagePath: "artifacts/redline/new-self-induced-frame.png",
    frameId: "self-induced-frame-after-compiler-failure",
    viewId: 3960410,
    crop: { min_u: 0.2, min_v: 0.2, max_u: 0.8, max_v: 0.8 }
  });
  const stillStoppedAfterAlignmentChurn = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    guardedExistingConditionsReq,
    [{
      type: "redline_orient",
      file_path: "source.pdf"
    }] as any
  );
  assert.equal(stillStoppedAfterAlignmentChurn.suppressed_count, 1);
  assert.deepEqual(stillStoppedAfterAlignmentChurn.actions, []);

  const unrelatedRecovery = __testOnlyBuildCapabilityRecoveryResponse({
    req: mkReq({
      session_id: sessionId,
      user_text: "Print all power sheets."
    }),
    decision: {
      assistant_message: "No executable print action.",
      actions: [],
      web_requests: []
    } as any,
    filteredActions: [],
    allowlisted: []
  });
  assert.ok(unrelatedRecovery);
  assert.ok((unrelatedRecovery?.actions.length ?? 0) > 0);
  assert.doesNotMatch(unrelatedRecovery?.assistant_message ?? "", /candidate_visible_route_outside_spatial_scope/);
  const unrelatedWorkbench = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    mkReq({
      session_id: sessionId,
      user_text: "Print all power sheets."
    }),
    [{
      type: "gemini_redline_analyze",
      file_path: "source.pdf",
      objective: "Unrelated placeholder."
    }] as any
  );
  assert.equal(unrelatedWorkbench.suppressed_count, 0);
  assert.equal(unrelatedWorkbench.actions.length, 1);

  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: true,
    summary: "Registered MEP reconstruction compiled; status=partially_ready, promoted=1, deferred=0."
  }]);
  const afterSuccess = __testOnlySuppressRepeatedGeminiActions(sessionId, [{
    type: "gemini_redline_analyze",
    file_path: "source.pdf",
    objective: "Analyze newly changed source evidence."
  } as any]);
  assert.equal(afterSuccess.suppressed_count, 0);
  assert.equal(afterSuccess.actions.length, 1);
});

test("first candidate-visible compiler failure exposes the exact prior package for one bounded revision", async () => {
  const sessionId = "session-candidate-visible-recovery-prompt";
  const packageJson = JSON.stringify({
    schema_version: 2,
    room_number: "100",
    observations: [{
      kind: "pipe_route",
      observation_id: "cw_main",
      pixel_points: [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }]
    }]
  });
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.pdf",
    "recovery-context",
    packageJson
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:cw_main"
  }]);

  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.ok(prompt);
  assert.match(prompt ?? "", /ONE ATTEMPT REMAINS/);
  assert.match(prompt ?? "", /candidate_visible_route_outside_spatial_scope:cw_main/);
  assert.match(prompt ?? "", /exactly one workbench action: compile_registered_mep_reconstruction/);
  assert.match(prompt ?? "", /immutable-claims fingerprint/);
  assert.match(prompt ?? "", /never widen or redraw spatial_scope/);
  assert.match(prompt ?? "", /\"observation_id\":\"cw_main\"/);
  assert.equal(__testOnlyShouldBypassCandidateVisiblePreModelDiscovery(mkReq({
    session_id: sessionId,
    user_text: ""
  })), true);
  assert.equal(__testOnlyBuildCandidateVisibleTerminalGuardResponse(mkReq({
    session_id: sessionId,
    user_text: ""
  })), null);

  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.pdf",
    "recovery-context-2",
    packageJson
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:cw_main"
  }]);
  const terminalPrompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(terminalPrompt ?? "", /TERMINAL GUARD/);
  assert.doesNotMatch(terminalPrompt ?? "", /Previous package_json to revise/);
  const terminalResponse = __testOnlyBuildCandidateVisibleTerminalGuardResponse(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.equal(terminalResponse?.actions.length, 0);
  assert.match(terminalResponse?.assistant_message ?? "", /stopped before any additional source vision/i);
  assert.match(terminalResponse?.assistant_message ?? "", /candidate_visible_route_outside_spatial_scope:cw_main/);
  const terminalAfterWorkbench = __testOnlyBuildCandidateVisibleTerminalGuardAfterWorkbench(
    mkReq({
      session_id: sessionId,
      user_text: ""
    }),
    [{
      index: 2,
      type: "compile_registered_mep_reconstruction",
      ok: false,
      summary: "candidate_visible_route_outside_spatial_scope:cw_main"
    }]
  );
  assert.equal(terminalAfterWorkbench?.actions.length, 0);
  assert.match(
    terminalAfterWorkbench?.assistant_message ?? "",
    /candidate_visible_route_outside_spatial_scope:cw_main/
  );
  assert.equal(
    __testOnlyBuildCandidateVisibleTerminalGuardAfterWorkbench(
      mkReq({
        session_id: sessionId,
        user_text: ""
      }),
      [{
        index: 3,
        type: "analyze_redline",
        ok: false,
        summary: "not a compiler result"
      }]
    ),
    null
  );
  const mutatedThirdPackage = JSON.stringify({
    schema_version: 2,
    room_number: "100",
    observations: [{
      kind: "pipe_route",
      observation_id: "cw_main",
      system: "domestic_hot_water",
      pixel_points: [{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.3 }]
    }]
  });
  await assert.rejects(
    __testOnlyCompileRegisteredMepReconstructionForSession(
      mkReq({
        session_id: sessionId,
        user_text: "fix it"
      }),
      mutatedThirdPackage
    ),
    /candidate_visible_compiler_terminal_guard:.*two_bounded_compile_attempts_exhausted/
  );
});

test("source-room enclosure recovery preserves the route and requests the exact visible room trace", () => {
  const sessionId = "session-candidate-visible-source-room-enclosure";
  const packageJson = JSON.stringify({
    schema_version: 2,
    room_number: "100",
    observations: [{
      kind: "pipe_route",
      observation_id: "room100-orange-plumbing-route",
      pixel_points: [{ x: 0.393, y: 0.353 }, { x: 0.601, y: 0.506 }]
    }]
  });
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.pdf",
    "source-room-enclosure-context",
    packageJson
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary:
      "candidate_visible_source_room_enclosure_required:100:room100-orange-plumbing-route" +
      ":source_uv_bounds=0.3930,0.3530,0.6010,0.5060" +
      ":projected_native_scope_uv_bounds=0.3677,0.0000,0.8763,0.1503" +
      ":source_room_label_uv=0.7511,0.2568" +
      ":preserve_source_geometry_add_spatial_scope_or_defer"
  }]);

  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(prompt ?? "", /Preserve every source-supported observation and its exact source geometry/);
  assert.match(prompt ?? "", /use the exact source_room_label_uv from the error for anchor_pixel_point/);
  assert.match(prompt ?? "", /Do not translate, shorten, or delete a supported route/);
  assert.match(prompt ?? "", /\"observation_id\":\"room100-orange-plumbing-route\"/);
  assert.doesNotMatch(prompt ?? "", /never widen or redraw spatial_scope/);
});

test("source-room enclosure raster recovery preserves route and anchor while revising only weak edges", () => {
  const sessionId = "session-candidate-visible-source-room-raster";
  const packageJson = JSON.stringify({
    schema_version: 2,
    room_number: "100",
    spatial_scope: {
      boundary_pixel_points: [
        { x: 0.535, y: 0.188 },
        { x: 0.655, y: 0.188 },
        { x: 0.655, y: 0.202 }
      ],
      anchor_pixel_point: { x: 0.615, y: 0.235 }
    },
    observations: [{
      kind: "pipe_route",
      observation_id: "room100-orange-plumbing-route",
      pixel_points: [{ x: 0.393, y: 0.353 }, { x: 0.601, y: 0.506 }]
    }]
  });
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.pdf",
    "source-room-raster-context",
    packageJson
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary:
      "candidate_visible_source_room_enclosure_raster_verification_required:100" +
      ":polygon_area_ratio=0.0123:mean_edge_support_ratio=0.2875" +
      ":minimum_edge_support_ratio=0.0000" +
      ":edge_support_ratios=0.9000,0.0000,0.2500" +
      ":required_maximum_polygon_area_ratio=0.7500" +
      ":required_minimum_mean_edge_support_ratio=0.3000" +
      ":required_minimum_each_edge_support_ratio=0.1000" +
      ":source_room_label_uv=0.7511,0.2568" +
      ":preserve_source_geometry_retrace_only_unsupported_enclosure_edges"
  }]);

  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(prompt ?? "", /Preserve every source-supported observation and its exact source geometry/);
  assert.match(prompt ?? "", /Set spatial_scope\.anchor_pixel_point to the exact source_room_label_uv/);
  assert.match(prompt ?? "", /revise only spatial_scope\.boundary_pixel_points/);
  assert.match(prompt ?? "", /Use edge_support_ratios in polygon order to identify weak edges/);
  assert.match(prompt ?? "", /Do not omit spatial_scope, change the route/);
  assert.match(prompt ?? "", /\"anchor_pixel_point\":\{\"x\":0\.615,\"y\":0\.235\}/);
  assert.match(prompt ?? "", /\"observation_id\":\"room100-orange-plumbing-route\"/);
});

test("source-route raster recovery preserves registration and revises only weak route segments", () => {
  const sessionId = "session-candidate-visible-source-route-raster";
  const packageJson = JSON.stringify({
    schema_version: 2,
    room_number: "100",
    spatial_scope: {
      anchor_pixel_point: { x: 0.7511, y: 0.2568 }
    },
    observations: [{
      kind: "pipe_route",
      observation_id: "room100-blue-plumbing-route",
      pixel_points: [
        { x: 0.477, y: 0.249 },
        { x: 0.501, y: 0.249 },
        { x: 0.501, y: 0.225 }
      ]
    }]
  });
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.pdf",
    "source-route-raster-context",
    packageJson
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary:
      "candidate_visible_route_raster_verification_required:" +
      "room100-blue-plumbing-route:route" +
      ":support_modality=chromatic_line" +
      ":mean_support_ratio=0.2100" +
      ":minimum_segment_support_ratio=0.0000" +
      ":segment_support_ratios=0.6300,0.0000" +
      ":required_minimum_mean_support_ratio=0.4500" +
      ":required_minimum_each_segment_support_ratio=0.2000" +
      ":candidate_retrace_uv=0.393000,0.340000;0.474000,0.340000;0.474000,0.615000;0.573000,0.615000" +
      ":candidate_retrace_color=blue" +
      ":candidate_retrace_policy_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
      ":preserve_source_geometry_retrace_to_visible_centerline"
  }]);

  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(prompt ?? "", /Preserve the exact room registration, native room boundary, spatial scope/);
  assert.match(prompt ?? "", /Retrace only the failed route or branch geometry/);
  assert.match(prompt ?? "", /Use segment_support_ratios in polyline order/);
  assert.match(prompt ?? "", /color is useful when support_modality is chromatic_line/);
  assert.match(prompt ?? "", /candidate_retrace_uv is present/);
  assert.match(prompt ?? "", /hash-bound visible-raster proposal/);
  assert.match(prompt ?? "", /let the compiler independently reverify it/);
  assert.match(prompt ?? "", /You may add intermediate vertices/);
  assert.match(prompt ?? "", /do not change scale, rotation, system\/type claims/);
  assert.match(prompt ?? "", /\"observation_id\":\"room100-blue-plumbing-route\"/);
});

test("candidate-visible recovery fingerprint permits only the failed geometry field", () => {
  const failure =
    "candidate_visible_route_raster_verification_required:route-a:route" +
    ":support_modality=chromatic_line";
  const base = {
    schema_version: 2,
    discipline: "plumbing",
    room_number: "100",
    spatial_scope: {
      boundary_pixel_points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 }
      ]
    },
    observations: [
      {
        kind: "pipe_route",
        observation_id: "route-a",
        system: "domestic_cold_water",
        pixel_points: [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.3 }],
        attribute_evidence: [{
          attribute: "system",
          basis: "visible_label",
          reference: "CW"
        }]
      },
      {
        kind: "pipe_route",
        observation_id: "route-b",
        system: "sanitary",
        pixel_points: [{ x: 0.4, y: 0.6 }, { x: 0.7, y: 0.6 }]
      }
    ]
  };
  const fingerprint = (value: unknown) =>
    __testOnlyCandidateVisibleRecoveryImmutableClaimsSha256(
      JSON.stringify(value),
      failure
    );
  const allowed = structuredClone(base);
  allowed.observations[0]!.pixel_points = [
    { x: 0.2, y: 0.31 },
    { x: 0.5, y: 0.31 }
  ];
  assert.equal(fingerprint(allowed), fingerprint(base));

  const changedSystem = structuredClone(base);
  changedSystem.observations[0]!.system = "domestic_hot_water";
  assert.notEqual(fingerprint(changedSystem), fingerprint(base));

  const changedEvidence = structuredClone(base);
  (changedEvidence.observations[0] as any).attribute_evidence[0].reference = "HW";
  assert.notEqual(fingerprint(changedEvidence), fingerprint(base));

  const changedOtherRoute = structuredClone(base);
  changedOtherRoute.observations[1]!.pixel_points[0]!.x = 0.45;
  assert.notEqual(fingerprint(changedOtherRoute), fingerprint(base));

  const deletedObservation = structuredClone(base);
  deletedObservation.observations.pop();
  assert.notEqual(fingerprint(deletedObservation), fingerprint(base));

  const containmentFailure =
    "candidate_visible_route_outside_spatial_scope:route-a";
  const containmentFingerprint = (value: unknown) =>
    __testOnlyCandidateVisibleRecoveryImmutableClaimsSha256(
      JSON.stringify(value),
      containmentFailure
    );
  assert.equal(
    containmentFingerprint(allowed),
    containmentFingerprint(base)
  );
  assert.notEqual(
    containmentFingerprint(changedSystem),
    containmentFingerprint(base)
  );
});

test("missing-observations recovery permits only populating observations", () => {
  const failure = "candidate_visible_observations_are_required";
  const base = {
    schema_version: 2,
    discipline: "plumbing",
    room_number: "120",
    partial_promotion_policy: "defer_ambiguous_observations",
    maximum_observations: 8,
    spatial_scope: {
      boundary_pixel_points: [
        { x: 0.47, y: 0.14 },
        { x: 0.61, y: 0.14 },
        { x: 0.61, y: 0.21 },
        { x: 0.47, y: 0.21 }
      ],
      anchor_pixel_point: { x: 0.555, y: 0.16 },
      anchor_label: "TRAINING ROOM 120"
    },
    observations: [] as Array<Record<string, unknown>>
  };
  const fingerprint = (value: unknown) =>
    __testOnlyCandidateVisibleRecoveryImmutableClaimsSha256(
      JSON.stringify(value),
      failure
    );

  const populated = structuredClone(base);
  populated.observations = [{
    kind: "plumbing_fixture",
    observation_id: "training-room-120-fixture-01",
    pixel_point: { x: 0.496, y: 0.205 },
    placement: { mode: "provisional_plan_symbol" }
  }];
  assert.equal(fingerprint(populated), fingerprint(base));

  const movedScope = structuredClone(populated);
  movedScope.spatial_scope.anchor_pixel_point.x = 0.56;
  assert.notEqual(fingerprint(movedScope), fingerprint(base));

  const changedRoom = structuredClone(populated);
  changedRoom.room_number = "1901";
  assert.notEqual(fingerprint(changedRoom), fingerprint(base));

  const sessionId = "session-missing-observations-recovery";
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.png",
    "missing-observations-context",
    JSON.stringify(base)
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: failure
  }]);
  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(prompt ?? "", /Populate only observations/);
  assert.match(prompt ?? "", /Do not move or redraw spatial_scope/);
  assert.match(prompt ?? "", /SCHEMA BOOTSTRAP RETRY/);

  const missingClassificationFailure =
    "candidate_visible_provisional_plan_symbol_source_graphic_required:" +
    "training-room-120-fixture-01:" +
    "set_representation_classification_source_graphic_to_mep_connection_symbol_only_if_source_visible";
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.png",
    "missing-observations-context-2",
    JSON.stringify(populated)
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: missingClassificationFailure
  }]);
  const semanticRetryPrompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(semanticRetryPrompt ?? "", /ONE ATTEMPT REMAINS/);
  assert.match(
    semanticRetryPrompt ?? "",
    /set representation_classification\.source_graphic exactly to "mep_connection_symbol"/
  );
  assert.equal(
    __testOnlyBuildCandidateVisibleTerminalGuardResponse(mkReq({
      session_id: sessionId,
      user_text: ""
    })),
    null
  );
});

test("provisional plumbing symbol recovery permits only the missing source-graphic classification", () => {
  const failure =
    "candidate_visible_provisional_plan_symbol_source_graphic_required:" +
    "fixture-symbol-01:" +
    "set_representation_classification_source_graphic_to_mep_connection_symbol_only_if_source_visible";
  const base = {
    schema_version: 2,
    room_number: "120",
    spatial_scope: {
      boundary_pixel_points: [
        { x: 0.47, y: 0.14 },
        { x: 0.60, y: 0.14 },
        { x: 0.60, y: 0.22 },
        { x: 0.47, y: 0.22 }
      ]
    },
    observations: [{
      kind: "plumbing_fixture",
      observation_id: "fixture-symbol-01",
      pixel_point: { x: 0.516, y: 0.207 },
      placement: { mode: "provisional_plan_symbol" },
      representation_classification: {
        native_target: "plan_only_marker",
        source_graphic: undefined as string | undefined
      },
      attribute_evidence: [{
        attribute: "source_symbol_present",
        basis: "legible_source_evidence",
        reference: "Visible source symbol."
      }]
    }]
  };
  const fingerprint = (value: unknown) =>
    __testOnlyCandidateVisibleRecoveryImmutableClaimsSha256(
      JSON.stringify(value),
      failure
    );
  const classified = structuredClone(base);
  classified.observations[0]!.representation_classification.source_graphic =
    "mep_connection_symbol";
  assert.equal(fingerprint(classified), fingerprint(base));

  const moved = structuredClone(classified);
  moved.observations[0]!.pixel_point.y = 0.2;
  assert.notEqual(fingerprint(moved), fingerprint(base));

  const changedEvidence = structuredClone(classified);
  changedEvidence.observations[0]!.attribute_evidence[0]!.reference =
    "Different evidence.";
  assert.notEqual(fingerprint(changedEvidence), fingerprint(base));

  const sessionId = "session-provisional-symbol-classification-recovery";
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/uploads/source.png",
    "provisional-symbol-context",
    JSON.stringify(base)
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: failure
  }]);
  const prompt = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(
    prompt ?? "",
    /set representation_classification\.source_graphic exactly to "mep_connection_symbol"/
  );
  assert.match(prompt ?? "", /Preserve the observation identity, pixel_point, spatial_scope/);
  assert.match(prompt ?? "", /Do not move the symbol/);
  assert.match(prompt ?? "", /issue no second compile and report the exact ambiguity/);
});

test("candidate-visible terminal guard survives compile-context and seed drift while first recovery stays source-bound", () => {
  const sessionId = "session-candidate-visible-terminal-seed-drift";
  const sourcePath = "artifacts/uploads/source.pdf";
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    sourcePath,
    "seed-drift-context",
    "{\"schema_version\":2}"
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:ROUTE_A_MAIN"
  }]);

  __testOnlyNoteRedlineSeedForRecoveryTest(sessionId, "artifacts/redline/frame-after-first-compile.png");
  const firstFailureAfterSeedDrift = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.equal(firstFailureAfterSeedDrift, null);

  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    "artifacts/redline/rekeyed-registered-render.png",
    "seed-drift-context-2",
    "{\"schema_version\":2}"
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:ROUTE_A_DROP"
  }]);
  __testOnlyNoteRedlineSeedForRecoveryTest(sessionId, "artifacts/redline/frame-after-second-compile.png");

  const terminalAfterSeedDrift = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(terminalAfterSeedDrift ?? "", /TERMINAL GUARD/);
  assert.match(terminalAfterSeedDrift ?? "", /candidate_visible_route_outside_spatial_scope:ROUTE_A_DROP/);

  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest(
    sessionId,
    "artifacts/uploads/genuinely-new-source.pdf"
  );
  const afterFreshSourceAnalysis = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.equal(afterFreshSourceAnalysis, null);
});

test("automatic same-source analysis cannot clear the candidate-visible compiler guard", () => {
  const sessionId = "session-candidate-visible-automatic-analysis";
  const sourcePath = "artifacts/uploads/source.pdf";
  const req = mkReq({
    session_id: sessionId,
    user_text: ""
  });
  __testOnlySetCandidateVisibleCompileContext(
    sessionId,
    sourcePath,
    "automatic-analysis-context",
    "{\"schema_version\":2}"
  );
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:ROUTE_CW_MAIN_DROP"
  }]);

  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);
  const afterFirstAutomaticAnalysis = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    req,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: sourcePath
      }
    ] as any
  );
  assert.equal(afterFirstAutomaticAnalysis.suppressed_count, 1);
  assert.deepEqual(
    afterFirstAutomaticAnalysis.actions.map((action) => action.type),
    ["compile_registered_mep_reconstruction"]
  );

  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:ROUTE_HW_MAIN_DROP"
  }]);
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);

  const terminalAfterAutomaticAnalysis = __testOnlyBuildCandidateVisibleRecoveryPrompt(req);
  assert.match(terminalAfterAutomaticAnalysis ?? "", /TERMINAL GUARD/);
  assert.match(
    terminalAfterAutomaticAnalysis ?? "",
    /candidate_visible_route_outside_spatial_scope:ROUTE_HW_MAIN_DROP/
  );
  const stopped = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    req,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "redline_orient",
        file_path: sourcePath
      }
    ] as any
  );
  assert.equal(stopped.suppressed_count, 2);
  assert.deepEqual(stopped.actions, []);
});

test("candidate-visible evidence gate suppresses discovery after the source is ready to compile", () => {
  const sessionId = "session-candidate-visible-ready-to-compile";
  const sourcePath = "artifacts/uploads/source.pdf";
  const frameMapping = {
    widthPx: 2200,
    heightPx: 1984,
    mapping: {
      topLeftXyz: [10, 20, 100],
      topRightXyz: [30, 20, 100],
      bottomLeftXyz: [10, 0, 100]
    },
    targetLevel: { elevationFt: 100 }
  };
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    sourceImagePath: "artifacts/redline/source-page.png",
    frameId: "frame-ready",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 }
  });
  const req = mkReq({
    session_id: sessionId,
    user_text: "Draft the visible existing plumbing in room 100 from this source PDF.",
    tool_results: [
      {
        action_id: "room",
        path: "/revit/linked-room-boundaries",
        status: "done",
        result_json: {
          ok: true,
          rooms: [{
            number: "100",
            sourceScopedId: "ARCH-LINK:100",
            area: 100,
            boundaryLoops: [[
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 }
            ]]
          }]
        }
      },
      {
        action_id: "frame",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          ok: true,
          frameId: "frame-ready",
          viewId: 3960410,
          ...frameMapping
        }
      },
      {
        action_id: "candidate-visible-broad-inventory:frame-ready",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          ok: true,
          frameId: "frame-inventory-capture",
          viewId: 3960410,
          ...frameMapping,
          modelBoundsApplied: true,
          modelBoundsFt: {
            min: { x: -1, y: -1, z: -1000 },
            max: { x: 11, y: 11, z: 1000 }
          },
          truncated: false,
          itemsSampled: [{
            sourceScopedId: "loaded-architecture:exterior-wall-west",
            builtInCategory: "OST_Walls",
            category: "Walls",
            bbox: { center: { x: 0, y: 5 } }
          }]
        }
      }
    ] as any
  });

  const prompt = __testOnlyBuildCandidateVisibleReadyToCompilePrompt(req);
  assert.match(prompt ?? "", /READY TO COMPILE/);
  assert.match(prompt ?? "", /exactly one workbench action: compile_registered_mep_reconstruction/);
  assert.match(prompt ?? "", /uploaded source is a local\/cropped room extract/);
  assert.match(prompt ?? "", /include spatial_scope in the same source coordinate space as its observations/);
  assert.match(prompt ?? "", /Never invent a 0\.5\/centroid trace/);
  assert.match(prompt ?? "", /strict verified native-room clipping still applies/);
  assert.match(prompt ?? "", /room tags.*optional evidence/i);
  assert.match(prompt ?? "", /exterior envelope\/corners, stairs and elevator cores, shafts, grids and columns/i);
  assert.match(
    prompt ?? "",
    /representation_classification\.source_graphic="mep_connection_symbol"/
  );
  assert.match(prompt ?? "", /never submit a generic source_symbol_present claim/i);

  const suppression = __testOnlySuppressCandidateVisibleCompileReadyWorkbenchActions(
    req,
    [
      {
        type: "gemini_redline_analyze",
        file_path: sourcePath
      },
      {
        type: "redline_orient",
        file_path: sourcePath
      },
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      }
    ] as any
  );
  assert.equal(suppression.suppressed_count, 2);
  assert.deepEqual(
    suppression.actions.map((action) => action.type),
    ["compile_registered_mep_reconstruction"]
  );
});

test("candidate-visible evidence gate compiles a clean whole-crop source without room data or markup picks", () => {
  const sessionId = "session-candidate-visible-tagless-whole-crop";
  const workspace = ensureWorkspaceLayout();
  const sourcePath = path.join(
    workspace.artifacts,
    "test-candidate-visible-tagless-source.pdf"
  );
  const registeredRenderPath = path.join(
    workspace.artifacts,
    "test-candidate-visible-tagless-render.png"
  );
  fs.writeFileSync(sourcePath, "%PDF-1.4\ncandidate-visible-tagless-source\n");
  fs.writeFileSync(
    registeredRenderPath,
    Buffer.from("candidate-visible-tagless-render")
  );
  const frameMapping = {
    widthPx: 2200,
    heightPx: 1984,
    mapping: {
      topLeftXyz: [10, 20, 100],
      topRightXyz: [30, 20, 100],
      bottomLeftXyz: [10, 0, 100]
    },
    targetLevel: { elevationFt: 100 }
  };
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    sourceImagePath: registeredRenderPath,
    frameId: "frame-tagless",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 },
    registrationControls: [
      {
        kind: "exterior_corner",
        source_normalized_x: 0.1,
        source_normalized_y: 0.2,
        view_normalized_x: 0.18,
        view_normalized_y: 0.26,
        score: 0.91,
        label: "northwest exterior corner"
      },
      {
        kind: "stair",
        source_normalized_x: 0.8,
        source_normalized_y: 0.8,
        view_normalized_x: 0.74,
        view_normalized_y: 0.74,
        score: 0.88,
        label: "stair core"
      }
    ]
  });
  const req = mkReq({
    session_id: sessionId,
    user_text:
      "Draft the visible existing plumbing in the source PDF into this empty test model.",
    tool_results: [
      {
        action_id: "frame",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          ok: true,
          frameId: "frame-tagless",
          viewId: 3960410,
          ...frameMapping
        }
      },
      {
        action_id:
          "candidate-visible-broad-inventory:frame-tagless:scope-ost-walls+ost-stairs+ost-stairsruns+ost-stairslandings",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          ok: true,
          frameId: "frame-tagless-inventory",
          viewId: 3960410,
          ...frameMapping,
          modelBoundsApplied: true,
          modelBoundsFt: {
            min: { x: 10, y: 0, z: 95 },
            max: { x: 30, y: 20, z: 125 }
          },
          truncated: false,
          itemsSampled: [
            {
              sourceScopedId: "loaded-architecture:stair-core-a",
              builtInCategory: "OST_Stairs",
              category: "Stairs",
              bbox: {
                model: { center: { x: 24.8, y: 5.2 } },
                image: {
                  minNormalizedX: 0.72,
                  minNormalizedY: 0.72,
                  maxNormalizedX: 0.76,
                  maxNormalizedY: 0.76
                }
              }
            },
            {
              sourceScopedId: "loaded-architecture:exterior-wall-west",
              builtInCategory: "OST_Walls",
              category: "Walls",
              bbox: {
                model: { center: { x: 13.6, y: 14.8 } },
                image: {
                  minNormalizedX: 0.17,
                  minNormalizedY: 0.24,
                  maxNormalizedX: 0.19,
                  maxNormalizedY: 0.28
                }
              }
            },
            {
              sourceScopedId: "loaded-architecture:unrelated-wall-decoy",
              builtInCategory: "OST_Walls",
              category: "Walls",
              bbox: {
                model: { center: { x: 28, y: 2 } },
                image: {
                  minNormalizedX: 0.88,
                  minNormalizedY: 0.88,
                  maxNormalizedX: 0.92,
                  maxNormalizedY: 0.92
                }
              }
            }
          ]
        }
      }
    ] as any
  });

  const prompt = __testOnlyBuildCandidateVisibleReadyToCompilePrompt(req);
  assert.match(prompt ?? "", /READY TO COMPILE/);
  assert.match(prompt ?? "", /Room\/space records, room tags, and matching names are optional evidence/i);
  assert.match(prompt ?? "", /exterior envelope\/corners, stairs and elevator cores/i);
  assert.match(prompt ?? "", /visible only in the source is an orientation clue/i);
  assert.match(prompt ?? "", /Include room_number only when the user explicitly requested that room/i);

  const noControlSessionId = "session-candidate-visible-tagless-no-controls";
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(
    noControlSessionId,
    sourcePath
  );
  __testOnlySeedRedlineViewAlignment({
    sessionId: noControlSessionId,
    sourceImagePath: registeredRenderPath,
    frameId: "frame-tagless",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 },
    registrationControls: []
  });
  const noControlReq = mkReq({
    session_id: noControlSessionId,
    user_text:
      "Draft the visible existing plumbing in the source PDF into this empty test model.",
    tool_results: req.tool_results
  });
  assert.equal(
    __testOnlyBuildCandidateVisibleReadyToCompilePrompt(noControlReq),
    null
  );

  const emptyInventorySessionId =
    "session-candidate-visible-tagless-empty-inventory";
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(
    emptyInventorySessionId,
    sourcePath
  );
  __testOnlySeedRedlineViewAlignment({
    sessionId: emptyInventorySessionId,
    sourceImagePath: registeredRenderPath,
    frameId: "frame-tagless",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 },
    registrationControls: [
      {
        kind: "exterior_corner",
        source_normalized_x: 0.1,
        source_normalized_y: 0.2,
        view_normalized_x: 0.18,
        view_normalized_y: 0.26,
        score: 0.91,
        label: "northwest exterior corner"
      },
      {
        kind: "stair",
        source_normalized_x: 0.8,
        source_normalized_y: 0.8,
        view_normalized_x: 0.74,
        view_normalized_y: 0.74,
        score: 0.88,
        label: "stair core"
      }
    ]
  });
  const emptyInventoryResults = (req.tool_results ?? []).map((result) =>
    result.path === "/revit/export-visible-elements"
      ? {
          ...result,
          result_json: {
            ...(result.result_json as Record<string, unknown>),
            itemsSampled: []
          }
        }
      : result
  );
  assert.equal(
    __testOnlyBuildCandidateVisibleReadyToCompilePrompt(
      mkReq({
        session_id: emptyInventorySessionId,
        user_text:
          "Draft the visible existing plumbing in the source PDF into this empty test model.",
        tool_results: emptyInventoryResults as any
      })
    ),
    null
  );
});

test("candidate-visible deterministic preparation owns room, exact sheet, frame, and inventory before the planner", () => {
  const sessionId = "session-candidate-visible-deterministic-preparation";
  const sourcePath = "artifacts/uploads/P1.01_sample_plumbing_room_crop.pdf";
  const frameMapping = {
    widthPx: 2200,
    heightPx: 1984,
    mapping: {
      topLeftXyz: [10, 20, 100],
      topRightXyz: [30, 20, 100],
      bottomLeftXyz: [10, 0, 100]
    },
    targetLevel: { elevationFt: 100 }
  };
  const req = mkReq({
    session_id: sessionId,
    user_text: "Draft existing conditions in room 100 from this source PDF.",
    user_attachments: [{
      id: "p210-source",
      relative_path: sourcePath,
      filename: "P1.01_sample_plumbing_room_crop.pdf",
      mime: "application/pdf"
    }]
  });
  const preAnalysisRoom = __testOnlyBuildCandidateVisibleRoomScopeResponse(req, []);
  assert.equal(preAnalysisRoom?.actions[0]?.path, "/revit/linked-room-boundaries");
  assert.match(preAnalysisRoom?.assistant_message ?? "", /before source analysis/i);
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);
  const room = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, []);
  assert.equal(room?.actions[0]?.path, "/revit/linked-room-boundaries");
  assert.equal((room?.actions[0]?.body as any)?.roomNumber, "100");

  const roomResult: any = {
    action_id: "room",
    path: "/revit/linked-room-boundaries",
    status: "done",
    result_json: {
      ok: true,
      rooms: [{
        number: "100",
        sourceScopedId: "ARCH-LINK:100",
        area: 100,
        boundaryLoops: [[
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]]
      }]
    }
  };
  const sheet = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, [roomResult]);
  assert.equal(sheet?.actions[0]?.path, "/revit/sheets");
  assert.equal((sheet?.actions[0]?.body as any)?.sheetNumber, "P1.01");

  const wrongSheet: any = {
    action_id: "wrong-sheet",
    path: "/revit/sheets",
    status: "done",
    result_json: {
      ok: true,
      sheetNumber: "P3.10",
      placedViews: [{ viewId: 999, name: "Wrong plan" }]
    }
  };
  const afterWrongSheet = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, [roomResult, wrongSheet]);
  assert.equal(afterWrongSheet?.actions[0]?.path, "/revit/sheets");
  assert.equal((afterWrongSheet?.actions[0]?.body as any)?.sheetNumber, "P1.01");

  const ambiguousSheet: any = {
    action_id: "ambiguous-sheet",
    path: "/revit/sheets",
    status: "done",
    result_json: {
      ok: true,
      sheetNumber: "P1.01",
      placedViews: [
        { viewId: 3960410, name: "Main plan" },
        { viewId: 3960411, name: "Enlarged plan" }
      ]
    }
  };
  const ambiguous = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, [roomResult, ambiguousSheet]);
  assert.deepEqual(ambiguous?.actions, []);
  assert.match(ambiguous?.assistant_message ?? "", /multiple eligible placed model views/i);

  const sheetResult: any = {
    action_id: "sheet",
    path: "/revit/sheets",
    status: "done",
    result_json: {
      ok: true,
      sheetNumber: "P1.01",
      placedViews: [{ viewId: 3960410, name: "LEVEL 01 - NEW WORK - PLUMBING" }]
    }
  };
  const frame = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, [roomResult, sheetResult]);
  assert.equal(frame?.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((frame?.actions[0]?.body as any)?.viewId, 3960410);
  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest(sessionId, sourcePath);

  const frameResult: any = {
    action_id: "frame",
    path: "/revit/export-view-frame",
    status: "done",
    result_json: { ok: true, frameId: "frame-register", viewId: 3960410, ...frameMapping }
  };
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    frameId: "frame-register",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 }
  });
  const inventoryFromSplitContinuation =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, frameResult]
    );
  assert.equal(
    inventoryFromSplitContinuation?.actions[0]?.path,
    "/revit/export-visible-elements"
  );
  assert.equal(
    (inventoryFromSplitContinuation?.actions[0]?.body as any)?.viewId,
    3960410
  );

  const inventory = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
    req,
    [roomResult, sheetResult, frameResult]
  );
  assert.equal(inventory?.actions[0]?.path, "/revit/export-visible-elements");
  assert.equal((inventory?.actions[0]?.body as any)?.viewId, 3960410);
  assert.equal(
    inventory?.actions[0]?.action_id,
    "candidate-visible-broad-inventory:frame-register:500"
  );
  assert.deepEqual(
    (inventory?.actions[0]?.body as any)?.modelBounds,
    [-1, -1, -1000, 11, 11, 1000]
  );
  const inventoryCategories = (inventory?.actions[0]?.body as any)?.categories;
  for (const stableCategory of [
    "OST_Walls",
    "OST_Stairs",
    "OST_ShaftOpening",
    "OST_Grids",
    "OST_StructuralColumns"
  ]) {
    assert.ok(
      inventoryCategories.includes(stableCategory),
      `expected stable registration category ${stableCategory}`
    );
  }
  for (const noisyOptionalCategory of [
    "OST_GenericModel",
    "OST_RoomTags",
    "OST_TextNotes",
    "OST_GenericAnnotation",
    "OST_SpecialityEquipment",
    "OST_Rooms",
    "OST_MEPSpaces",
    "OST_Doors",
    "OST_Windows",
    "OST_PipeCurves",
    "OST_DuctCurves",
    "OST_ElectricalFixtures",
    "OST_LightingFixtures"
  ]) {
    assert.ok(
      !inventoryCategories.includes(noisyOptionalCategory),
      `expected broad registration inventory to defer noisy optional category ${noisyOptionalCategory}`
    );
  }
  const unrelatedInventoryAttempts: any[] = [
    {
      action_id: "stale-visible-1",
      path: "/revit/export-visible-elements",
      status: "failed",
      result_json: { ok: false }
    },
    {
      action_id: "stale-visible-2",
      path: "/revit/export-visible-elements",
      status: "done",
      result_json: {
        ok: true,
        frameId: "stale-frame",
        viewId: 3960410,
        ...frameMapping
      }
    }
  ];
  const inventoryAfterUnrelatedAttempts =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, sheetResult, frameResult, ...unrelatedInventoryAttempts]
    );
  assert.equal(
    inventoryAfterUnrelatedAttempts?.actions[0]?.action_id,
    "candidate-visible-broad-inventory:frame-register:500"
  );

  const inventoryResult: any = {
    action_id: "candidate-visible-broad-inventory:frame-register",
    path: "/revit/export-visible-elements",
    status: "done",
    result_json: {
      frameId: "frame-inventory",
      viewId: 3960410,
      ...frameMapping,
      modelBoundsApplied: true,
      truncated: false
    }
  };
  const mismatchedBoundsInventoryResult: any = {
    ...inventoryResult,
    result_json: {
      ...inventoryResult.result_json,
      modelBoundsFt: {
        min: { x: -2, y: -1, z: -1000 },
        max: { x: 11, y: 11, z: 1000 }
      }
    }
  };
  const inventoryAfterMismatchedBounds =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, sheetResult, frameResult, mismatchedBoundsInventoryResult]
    );
  assert.equal(
    inventoryAfterMismatchedBounds?.actions[0]?.action_id,
    "candidate-visible-broad-inventory:frame-register:750"
  );
  assert.equal(
    (inventoryAfterMismatchedBounds?.actions[0]?.body as any)?.limit,
    750
  );
  const truncatedSecondInventoryResult: any = {
    ...inventoryResult,
    action_id: "candidate-visible-broad-inventory:frame-register:750",
    result_json: {
      ...inventoryResult.result_json,
      truncated: true
    }
  };
  const inventoryAfterTwoBoundedAttempts =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [
        roomResult,
        sheetResult,
        frameResult,
        mismatchedBoundsInventoryResult,
        truncatedSecondInventoryResult
      ]
    );
  assert.equal(
    inventoryAfterTwoBoundedAttempts?.actions[0]?.action_id,
    "candidate-visible-broad-inventory:frame-register:1500"
  );
  assert.equal(
    (inventoryAfterTwoBoundedAttempts?.actions[0]?.body as any)?.limit,
    1500
  );
  const focusedRoomTagInventory =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, sheetResult, frameResult, inventoryResult]
    );
  assert.equal(
    focusedRoomTagInventory?.actions[0]?.path,
    "/revit/export-visible-elements"
  );
  assert.deepEqual(
    (focusedRoomTagInventory?.actions[0]?.body as any)?.categories,
    ["OST_RoomTags"]
  );
  assert.equal(
    (focusedRoomTagInventory?.actions[0]?.body as any)?.includeLinked,
    false
  );
  assert.deepEqual(
    (focusedRoomTagInventory?.actions[0]?.body as any)?.modelBounds,
    [-1, -1, -1000, 11, 11, 1000]
  );
  assert.equal(
    focusedRoomTagInventory?.actions[0]?.action_id,
    "candidate-visible-focused-room-tags:frame-register:100"
  );
  const unrelatedFocusedAttempts: any[] = [
    {
      action_id: "unrelated-focused-1",
      path: "/revit/export-visible-elements",
      status: "done",
      result_json: {
        ok: true,
        frameId: "frame-room-tags-old-1",
        viewId: 3960410,
        ...frameMapping,
        modelBoundsApplied: true
      }
    },
    {
      action_id: "unrelated-focused-2",
      path: "/revit/export-visible-elements",
      status: "failed",
      result_json: { ok: false }
    }
  ];
  const focusedAfterUnrelatedAttempts =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [
        roomResult,
        sheetResult,
        frameResult,
        inventoryResult,
        ...unrelatedFocusedAttempts
      ]
    );
  assert.equal(
    focusedAfterUnrelatedAttempts?.actions[0]?.action_id,
    "candidate-visible-focused-room-tags:frame-register:100"
  );
  const failedFocusedAttempt = {
    action_id: "candidate-visible-focused-room-tags:frame-register:100",
    path: "/revit/export-visible-elements",
    status: "failed",
    result_json: { ok: false }
  };
  const exhaustedFocusedAttempts =
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [
        roomResult,
        sheetResult,
        frameResult,
        inventoryResult,
        failedFocusedAttempt,
        { ...failedFocusedAttempt }
      ] as any
    );
  assert.equal(exhaustedFocusedAttempts, null);

  const roomTagResult: any = {
    action_id: "candidate-visible-focused-room-tags:frame-register:100",
    path: "/revit/export-visible-elements",
    status: "done",
    result_json: {
      ok: true,
      frameId: "frame-room-tags",
      viewId: 3960410,
      ...frameMapping,
      modelBoundsApplied: true,
      modelBoundsFt: {
        min: { x: -1, y: -1, z: -1000 },
        max: { x: 11, y: 11, z: 1000 }
      },
      truncated: false,
      itemsSampled: [{
        visibleText: "100",
        sourceScopedId: "host:room-tag-100",
        builtInCategory: "OST_RoomTags",
        bbox: { center: { x: 5, y: 5 } }
      }]
    }
  };
  assert.equal(
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, sheetResult, frameResult, inventoryResult, roomTagResult]
    ),
    null
  );
});

test("candidate-visible preparation verifies an explicit target view before filename-derived sheet hints", () => {
  const sessionId = "session-candidate-visible-explicit-view";
  const sourcePath = "artifacts/uploads/room_crop.png";
  const req = mkReq({
    session_id: sessionId,
    user_text: "Draft the visible existing conditions from this crop in target view 12345678.",
    user_attachments: [{
      id: "crop-source",
      relative_path: sourcePath,
      filename: "codex-clipboard-a069-room_crop.png",
      mime: "image/png"
    }],
    context: {
      revit: {
        document: {
          activeView: {
            id: 12345678,
            name: "LEVEL 01 - NEW WORK - PLUMBING Copy 2",
            type: "FloorPlan"
          }
        }
      }
    } as any
  });
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);

  const frame = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(req, []);
  assert.equal(frame?.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((frame?.actions[0]?.body as any)?.viewId, 12345678);

  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(`${sessionId}-unverified`, sourcePath);
  const unverified = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
    {
      ...req,
      session_id: `${sessionId}-unverified`,
      context: {
        revit: {
          document: {
            activeView: { id: 42, name: "Different view", type: "FloorPlan" }
          }
        }
      } as any
    },
    []
  );
  assert.equal(unverified?.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((unverified?.actions[0]?.body as any)?.viewId, 12345678);
  assert.doesNotMatch(unverified?.assistant_message ?? "", /source sheet a069/i);
});

test("candidate-visible stable native controls require a real exterior wall identity", () => {
  const roomResult: any = {
    action_id: "room",
    path: "/revit/linked-room-boundaries",
    status: "done",
    result_json: {
      ok: true,
      rooms: [{
        number: "100",
        name: "TEST ROOM",
        sourceScopedId: "ARCH-LINK:100",
        area: 100,
        boundaryLoops: [[
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]],
        boundarySegments: [
          {
            linkedBoundaryElementId: 123,
            linkedBoundaryElementUniqueId: "wall-unique-123",
            linkedBoundaryElementName: "Exterior Wall - Brick",
            linkedBoundaryElementCategory: "Walls",
            hostStart: { x: 0, y: 0 },
            hostEnd: { x: 10, y: 0 }
          },
          {
            linkedBoundaryElementId: 124,
            linkedBoundaryElementUniqueId: "grid-unique-124",
            linkedBoundaryElementName: "Exterior Grid Decoy",
            linkedBoundaryElementCategory: "Grids",
            hostStart: { x: 0, y: 1 },
            hostEnd: { x: 10, y: 1 }
          },
          {
            linkedBoundaryElementId: 125,
            linkedBoundaryElementUniqueId: "",
            linkedBoundaryElementName: "Exterior Wall - Missing Identity",
            linkedBoundaryElementCategory: "Walls",
            hostStart: { x: 0, y: 2 },
            hostEnd: { x: 10, y: 2 }
          },
          {
            linkedBoundaryElementId: 126,
            linkedBoundaryElementUniqueId: "wall-unique-126",
            linkedBoundaryElementName: "Interior Wall",
            linkedBoundaryElementCategory: "Walls",
            hostStart: { x: 0, y: 3 },
            hostEnd: { x: 10, y: 3 }
          }
        ]
      }]
    }
  };
  const scope = __testOnlyCandidateVisibleVerifiedRoomScopeFromToolResults(
    [roomResult],
    "100"
  );
  assert.deepEqual(scope?.stable_boundary_segments, [{
    stable_kind: "exterior_wall",
    source_scoped_id: "linked-wall:123:wall-unique-123",
    category: "Walls",
    name: "Exterior Wall - Brick",
    start_model_point: { x: 0, y: 0 },
    end_model_point: { x: 10, y: 0 }
  }]);
});

test("candidate-visible room-label evidence requires a unique exact room tag in the registered view", () => {
  const frame = {
    frame_id: "frame-room-label",
    view_id: 3960410,
    width_px: 2200,
    height_px: 1984,
    top_left_xyz: [10, 20, 100] as [number, number, number],
    top_right_xyz: [30, 20, 100] as [number, number, number],
    bottom_left_xyz: [10, 0, 100] as [number, number, number],
    target_level_elevation_ft: 100
  };
  const roomScope = {
    room_number: "100",
    room_name: "TEST ROOM 100",
    source_scoped_id: "ARCH-LINK:100",
    boundary_model_points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
  };
  const resultRoot = {
    frameId: frame.frame_id,
    viewId: frame.view_id,
    widthPx: frame.width_px,
    heightPx: frame.height_px,
    mapping: {
      topLeftXyz: frame.top_left_xyz,
      topRightXyz: frame.top_right_xyz,
      bottomLeftXyz: frame.bottom_left_xyz
    },
    targetLevel: { elevationFt: 100 },
    modelBoundsApplied: true,
    modelBoundsFt: {
      min: { x: -1, y: -1, z: -1000 },
      max: { x: 11, y: 11, z: 1000 }
    },
    truncated: false
  };
  const frameResult = {
    action_id: "frame",
    path: "/revit/export-view-frame",
    status: "done",
    result_json: {
      ok: true,
      frameId: frame.frame_id,
      viewId: frame.view_id,
      widthPx: frame.width_px,
      heightPx: frame.height_px,
      mapping: {
        topLeftXyz: frame.top_left_xyz,
        topRightXyz: frame.top_right_xyz,
        bottomLeftXyz: frame.bottom_left_xyz
      },
      targetLevel: { elevationFt: 100 }
    }
  };
  const toolResult = (itemsSampled: unknown[]) => [
    frameResult,
    {
      action_id: "candidate-visible-focused-room-tags:frame-room-label:100",
      path: "/revit/export-visible-elements",
      status: "done",
      result_json: { ...resultRoot, itemsSampled }
    }
  ] as any;
  const exactTag = {
    visibleText: "100TEST ROOM",
    sourceScopedId: "host:room-tag-100",
    builtInCategory: "OST_RoomTags",
    bbox: { center: { x: 5, y: 5 } }
  };

  const exact = __testOnlyCandidateVisibleRoomLabelFromToolResults({
    toolResults: toolResult([exactTag]),
    room_scope: roomScope,
    frame
  });
  assert.equal(exact?.source_scoped_id, "host:room-tag-100");
  assert.equal(exact?.built_in_category, "OST_RoomTags");
  assert.equal(exact?.frame_id, frame.frame_id);
  assert.equal(exact?.registration_frame_id, frame.frame_id);
  const exactFocusedResult = toolResult([exactTag])[1];
  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: [exactFocusedResult, frameResult] as any,
      room_scope: roomScope,
      frame
    }),
    null
  );
  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: [
        frameResult,
        {
          ...exactFocusedResult,
          result_json: {
            ...(exactFocusedResult as any).result_json,
            ok: false
          }
        }
      ] as any,
      room_scope: roomScope,
      frame
    }),
    null
  );
  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: [
        frameResult,
        {
          ...exactFocusedResult,
          action_id: "unrelated-focused-action"
        }
      ] as any,
      room_scope: roomScope,
      frame
    }),
    null
  );

  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: toolResult([{
        ...exactTag,
        builtInCategory: "OST_TextNotes"
      }]),
      room_scope: roomScope,
      frame
    }),
    null
  );
  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: toolResult([
        exactTag,
        { ...exactTag, sourceScopedId: "host:duplicate-room-tag-100" }
      ]),
      room_scope: roomScope,
      frame
    }),
    null
  );
  assert.equal(
    __testOnlyCandidateVisibleRoomLabelFromToolResults({
      toolResults: toolResult([{
        ...exactTag,
        visibleText: "100A"
      }]),
      room_scope: { ...roomScope, room_name: undefined },
      frame
    }),
    null
  );
});

test("candidate-visible evidence gate rejects empty room scope and inventory from another frame", () => {
  const sessionId = "session-candidate-visible-not-ready-to-compile";
  const sourcePath = "artifacts/uploads/source.pdf";
  const frameMapping = {
    widthPx: 2200,
    heightPx: 1984,
    mapping: {
      topLeftXyz: [10, 20, 100],
      topRightXyz: [30, 20, 100],
      bottomLeftXyz: [10, 0, 100]
    },
    targetLevel: { elevationFt: 100 }
  };
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    sourceImagePath: "artifacts/redline/source-page.png",
    frameId: "frame-ready",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 }
  });
  const base = {
    session_id: sessionId,
    user_text: "Draft existing conditions in room 100 from this source PDF."
  };
  const emptyRoom = mkReq({
    ...base,
    tool_results: [
      {
        action_id: "room",
        path: "/revit/linked-room-boundaries",
        status: "done",
        result_json: { ok: true, rooms: [] }
      },
      {
        action_id: "visible",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { ok: true, frameId: "frame-ready", viewId: 3960410 }
      }
    ] as any
  });
  assert.equal(__testOnlyBuildCandidateVisibleReadyToCompilePrompt(emptyRoom), null);

  const staleInventory = mkReq({
    ...base,
    tool_results: [
      {
        action_id: "room",
        path: "/revit/linked-room-boundaries",
        status: "done",
        result_json: {
          ok: true,
          rooms: [{
            number: "100",
            sourceScopedId: "ARCH-LINK:100",
            area: 100,
            boundaryLoops: [[
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 }
            ]]
          }]
        }
      },
      {
        action_id: "frame",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          ok: true,
          frameId: "frame-ready",
          viewId: 3960410,
          ...frameMapping
        }
      },
      {
        action_id: "visible",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          ok: true,
          frameId: "stale-frame",
          viewId: 999,
          ...frameMapping
        }
      }
    ] as any
  });
  assert.equal(__testOnlyBuildCandidateVisibleReadyToCompilePrompt(staleInventory), null);
});

test("candidate-visible evidence gate cannot reuse another source attachment's alignment", () => {
  const sessionId = "session-candidate-visible-source-epoch";
  const sourceA = "artifacts/uploads/source-a.pdf";
  const sourceB = "artifacts/uploads/source-b.pdf";
  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest(sessionId, sourceA);
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    sourceImagePath: "artifacts/redline/source-a-page.png",
    frameId: "frame-source-a",
    viewId: 3960410,
    crop: { min_u: 0.1, min_v: 0.1, max_u: 0.9, max_v: 0.9 }
  });
  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest(sessionId, sourceB);

  const req = mkReq({
    session_id: sessionId,
    user_text: "Draft existing conditions in room 100 from this source PDF.",
    tool_results: [
      {
        action_id: "room",
        path: "/revit/linked-room-boundaries",
        status: "done",
        result_json: {
          ok: true,
          rooms: [{
            number: "100",
            sourceScopedId: "ARCH-LINK:100",
            area: 100,
            boundaryLoops: [[
              { x: 0, y: 0 },
              { x: 10, y: 0 },
              { x: 10, y: 10 },
              { x: 0, y: 10 }
            ]]
          }]
        }
      },
      {
        action_id: "visible",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { ok: true, frameId: "frame-source-a", viewId: 3960410 }
      }
    ] as any
  });
  assert.equal(__testOnlyBuildCandidateVisibleReadyToCompilePrompt(req), null);
});

test("candidate-visible compiler guard bounds failures from every deterministic compiler layer", () => {
  const sessionId = "session-candidate-visible-mep-draft-plan-guard";
  const sourcePath = "source-mep-plan.pdf";
  const req = mkReq({
    session_id: sessionId,
    user_text: ""
  });
  __testOnlySetCandidateVisibleCompileContext(sessionId, sourcePath, "context-a");
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "mep_draft_plan_not_ready:clarification_required"
  }]);

  const oneRevision = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    req,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: sourcePath
      }
    ] as any
  );
  assert.equal(oneRevision.suppressed_count, 1);
  assert.deepEqual(
    oneRevision.actions.map((action) => action.type),
    ["compile_registered_mep_reconstruction"]
  );

  __testOnlySetCandidateVisibleCompileContext(sessionId, sourcePath, "context-b");
  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 2,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "mep_draft_plan_not_ready:clarification_required"
  }]);
  const stopped = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
    req,
    [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: "{}"
      },
      {
        type: "gemini_redline_analyze",
        file_path: sourcePath
      }
    ] as any
  );
  assert.equal(stopped.suppressed_count, 2);
  assert.deepEqual(stopped.actions, []);
});

test("persisted historical analysis rehydration cannot clear a live compiler guard", () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-visible-guard-rehydrate-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const sessionId = "session-candidate-visible-guard-rehydrate";
  const sourcePath = "artifacts/uploads/source-rehydrate.pdf";
  const sessionDir = path.join(root, "runs", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "tool_outputs.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "mcp.tool_result",
      session_id: sessionId,
      tool: "workbench.analyze_redline",
      server: "operator-backend",
      status: "success",
      result: {
        index: 1,
        summary: "Redline analyzed (pdf); primary_sheet=P1.01.",
        details: {
          ok: true,
          file_path: sourcePath,
          kind: "pdf",
          primary_sheet_number: "P1.01"
        }
      }
    }) + "\n",
    "utf8"
  );

  try {
    __testOnlySetCandidateVisibleCompileContext(sessionId, sourcePath, "live-context");
    __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
      index: 1,
      type: "compile_registered_mep_reconstruction",
      ok: false,
      summary: "candidate_visible_route_outside_spatial_scope:route-1"
    }]);

    __testOnlyRehydrateRedlineVisionProgressFromRunBundle(sessionId);
    const guarded = __testOnlySuppressCandidateVisibleGuardedWorkbenchActions(
      mkReq({
        session_id: sessionId,
        user_text: ""
      }),
      [
        {
          type: "compile_registered_mep_reconstruction",
          package_json: "{}"
        },
        {
          type: "gemini_redline_analyze",
          file_path: sourcePath
        }
      ] as any
    );

    assert.equal(guarded.suppressed_count, 1);
    assert.deepEqual(
      guarded.actions.map((action) => action.type),
      ["compile_registered_mep_reconstruction"]
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("codex instructions explicitly tell the sidecar not to stop at missing commands", () => {
  const instructions = getCodexBaseInstructionsForTest();
  assert.match(instructions, /Execution ladder:/);
  assert.match(instructions, /Do not stop with a vague statement like 'I can't find the command'/);
  assert.match(instructions, /registration must not require rooms, spaces, room tags, or matching room names/i);
  assert.match(instructions, /exterior envelope\/corners, stairs and elevators, shafts, grids and columns/i);
});

test("responses api text extraction still exports a compact helper", () => {
  const extracted = __testOnlyExtractResponsesApiOutputText({ output_text: "ok" });
  assert.equal(extracted, "ok");
});

test("leading JSON recovery respects escaped quotes in nested JSON strings", () => {
  const first = {
    assistant_message: "I am compiling the registered reconstruction.",
    workbench_actions: [
      {
        type: "compile_registered_mep_reconstruction",
        package_json: JSON.stringify({
          observations: [
            {
              id: "pipe-1",
              note: "Route stops at the \"SAMPLE ROOM\" boundary.",
              metadata: { system: "Domestic Cold Water" }
            }
          ]
        })
      }
    ]
  };
  const raw = `${JSON.stringify(first)}\n{"duplicate":"trailing model output"}`;

  const extracted = __testOnlyExtractFirstJsonObject(raw);

  assert.ok(extracted);
  assert.deepEqual(JSON.parse(extracted), first);
});

test("update-panel-parameter aliases are normalized before Revit routing", () => {
  const [action] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/update-panel-parameter",
        body: {
          panelName: "P106/7",
          parameterSemantic: "A.I.C. Rating",
          value: "10,000",
          dryRun: false,
          apply: true,
          confirm: true
        }
      }
    ],
    []
  );

  assert.equal((action?.body as any)?.scheduleQuery, "P106/7");
  assert.equal((action?.body as any)?.exact, true);
  assert.equal((action?.body as any)?.samplePanelName, "P106/7");
  assert.equal((action?.body as any)?.parameterName, "A.I.C. Rating");
  assert.equal("apply" in ((action?.body as any) ?? {}), false);
  assert.equal("confirm" in ((action?.body as any) ?? {}), false);
});

test("update-panel-parameter numeric MCB values are normalized before Revit routing", () => {
  const [withUnitAction, numericAction] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/update-panel-parameter",
        body: {
          panelName: "P105",
          parameterName: "MCB Rating",
          value: "400 A",
          dryRun: false
        }
      },
      {
        action_id: "a2",
        method: "POST",
        path: "/revit/update-panel-parameter",
        body: {
          panelName: "P106",
          parameterName: "MCB Rating",
          value: 400,
          dryRun: false
        }
      }
    ],
    []
  );

  assert.equal((withUnitAction?.body as any)?.value, "400");
  assert.equal((numericAction?.body as any)?.value, "400");
});

test("update-parameter-by-query normalizes sheet query aliases and boolean confirms", () => {
  const [action] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/update-parameter-by-query",
        body: {
          query: { elementType: "Sheets" },
          parameterName: "Checked By",
          value: "EDP",
          dryRun: false,
          apply: true,
          confirm: true
        }
      }
    ],
    []
  );

  assert.equal((action?.body as any)?.category, "OST_Sheets");
  assert.equal("query" in ((action?.body as any) ?? {}), false);
  assert.equal("confirm" in ((action?.body as any) ?? {}), false);
});

test("update-parameter-by-query carries forward required bulk confirmation", () => {
  const [action] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/update-parameter-by-query",
        body: {
          category: "Sheets",
          parameterName: "Checked By",
          value: "EDP",
          dryRun: false,
          apply: true
        }
      }
    ],
    [
      {
        action_id: "prior",
        method: "POST",
        path: "/revit/update-parameter-by-query",
        status: "done",
        result_json: {
          ok: false,
          code: "bulk_confirm_required",
          requiredConfirm: "APPLY 26 CHANGES"
        }
      }
    ] as any
  );

  assert.equal((action?.body as any)?.category, "OST_Sheets");
  assert.equal((action?.body as any)?.confirm, "APPLY 26 CHANGES");
});

test("set-parameter fills sheet name element id from prior sheet detail", () => {
  const [action] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "sheet_update",
        method: "POST",
        path: "/revit/set-parameter",
        body: {
          changes: [
            {
              elementId: null,
              parameterName: "Sheet Name",
              value: "ELECTRICAL COVER SHEET"
            }
          ],
          apply: true
        }
      }
    ],
    [
      {
        action_id: "sheet_detail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          action: "detail",
          sheetElementId: 1709383,
          sheetId: 1709383,
          sheetNumber: "E000",
          sheetName: "COVER SHEET"
        }
      }
    ] as any
  );

  assert.equal((action?.body as any)?.changes?.[0]?.elementId, 1709383);
});
