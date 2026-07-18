import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testOnlyBuildCapabilityRecoveryResponse,
  __testOnlyBuildCandidateVisibleDeterministicPreparationResponse,
  __testOnlyBuildCandidateVisibleRecoveryPrompt,
  __testOnlyBuildCandidateVisibleRoomScopeResponse,
  __testOnlyBuildCandidateVisibleReadyToCompilePrompt,
  __testOnlyBuildCandidateVisibleTerminalGuardResponse,
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
  __testOnlyStartFreshCandidateVisibleSourceForRecoveryTest,
  __testOnlySuppressCandidateVisibleCompileReadyWorkbenchActions,
  __testOnlySuppressCandidateVisibleGuardedWorkbenchActions,
  __testOnlySuppressRepeatedGeminiActions,
  __testOnlySuppressRepeatedOrientActions
} from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { getCodexBaseInstructionsForTest } from "../src/brains/codex_brain.js";

function mkReq(args?: Partial<ChatRequest>): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "session-sidecar",
    message_id: "message-sidecar",
    user_text: "print all power sheets",
    ...args
  };
}

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

test("first candidate-visible compiler failure exposes the exact prior package for one bounded revision", () => {
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
    summary: "candidate_visible_route_outside_spatial_scope:P18_BLUE_MAIN"
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
    summary: "candidate_visible_route_outside_spatial_scope:P18_BLUE_DROP"
  }]);
  __testOnlyNoteRedlineSeedForRecoveryTest(sessionId, "artifacts/redline/frame-after-second-compile.png");

  const terminalAfterSeedDrift = __testOnlyBuildCandidateVisibleRecoveryPrompt(mkReq({
    session_id: sessionId,
    user_text: ""
  }));
  assert.match(terminalAfterSeedDrift ?? "", /TERMINAL GUARD/);
  assert.match(terminalAfterSeedDrift ?? "", /candidate_visible_route_outside_spatial_scope:P18_BLUE_DROP/);

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
    summary: "candidate_visible_route_outside_spatial_scope:P18_CW_MAIN_DROP"
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
    summary: "candidate_visible_route_outside_spatial_scope:P18_HW_MAIN_DROP"
  }]);
  __testOnlyNoteAutomaticRedlineAnalyzeSuccessForRecoveryTest(sessionId, sourcePath);

  const terminalAfterAutomaticAnalysis = __testOnlyBuildCandidateVisibleRecoveryPrompt(req);
  assert.match(terminalAfterAutomaticAnalysis ?? "", /TERMINAL GUARD/);
  assert.match(
    terminalAfterAutomaticAnalysis ?? "",
    /candidate_visible_route_outside_spatial_scope:P18_HW_MAIN_DROP/
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
          frameId: "frame-inventory-capture",
          viewId: 3960410,
          ...frameMapping
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

test("candidate-visible deterministic preparation owns room, exact sheet, frame, and inventory before the planner", () => {
  const sessionId = "session-candidate-visible-deterministic-preparation";
  const sourcePath = "artifacts/uploads/P1.01_ems_lounge_sink_crop.pdf";
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
      filename: "P1.01_ems_lounge_sink_crop.pdf",
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

  const frameResult: any = {
    action_id: "frame",
    path: "/revit/export-view-frame",
    status: "done",
    result_json: { ok: true, frameId: "frame-register", viewId: 3960410, ...frameMapping }
  };
  const inventory = __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
    req,
    [roomResult, sheetResult, frameResult]
  );
  assert.equal(inventory?.actions[0]?.path, "/revit/export-visible-elements");
  assert.equal((inventory?.actions[0]?.body as any)?.viewId, 3960410);

  const inventoryResult: any = {
    action_id: "inventory",
    path: "/revit/export-visible-elements",
    status: "done",
    result_json: { ok: true, frameId: "frame-inventory", viewId: 3960410, ...frameMapping }
  };
  assert.equal(
    __testOnlyBuildCandidateVisibleDeterministicPreparationResponse(
      req,
      [roomResult, sheetResult, frameResult, inventoryResult]
    ),
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
