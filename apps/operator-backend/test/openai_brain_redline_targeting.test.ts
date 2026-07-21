import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  __testOnlyBuildExplicitCircuitPlacementSourceGuardResponse,
  __testOnlyBuildFastPreflightViewMismatchFallback,
  __testOnlyBuildRedlineExecutionBridge,
  __testOnlyBuildRedlineExecutionBridgeAsync,
  __testOnlyBuildInitialRedlinePreflightAction,
  __testOnlyBuildMepRedlineActionGuardResponse,
  __testOnlyBuildMepRedlineDuctScopeRecoveryResponse,
  __testOnlyBuildMepRedlineRouteRecoveryResponse,
  __testOnlyBuildPlacementRunState,
  __testOnlyBuildPlacementWorkItem,
  __testOnlyBuildRegisteredMepWorkflowHandoffResponse,
  __testOnlyBuildSpatialRedlineRefinementBridge,
  __testOnlyBuildSpatialPlacementPreviewPlan,
  __testOnlyExtractResponsesApiOutputText,
  __testOnlyExtractLatestFrameImageContext,
  __testOnlyExtractLatestRedlineSpatialTargetingFromToolResults,
  __testOnlyFinalizeOpenAiResponseForRequest,
  __testOnlyGetAugmentedToolResults,
  __testOnlyHydrateTargetProfileFromVisibleInventory,
  __testOnlyInferRedlineTargetingProfile,
  __testOnlyIsFastElectricalPlacementRedline,
  __testOnlyNormalizeNativeRevitActionBodiesForRouting,
  __testOnlyNoteRegisteredMepWorkflow,
  __testOnlyRecordCandidateVisibleCompileResults,
  __testOnlyRefineAlignmentMarksWithImageMarkCrop,
  __testOnlyResolveRedlineAlignmentImagePath,
  __testOnlySeedRedlineFrameAlignedHint,
  __testOnlySeedRedlineRawImageMarkHint,
  __testOnlySetCandidateVisibleCompileContext,
  __testOnlySeedRedlineViewAlignment,
  __testOnlyShouldPrioritizeHostedPlacementBridge
} from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ActionCall, type ChatRequest, type ToolResult } from "../src/contracts.js";
import { compactIncomingToolResult } from "../src/tool_result_compaction.js";
import {
  alignRedlineToView,
  __testOnlyBuildViewAlignmentPrompt,
  __testOnlyExtractViewAlignmentResponseText
} from "../src/redline/view_alignment.js";
import { ensureWorkspaceLayout } from "../src/workspace.js";

const RED_MARK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAAAjklEQVR4nO3QgQmAQAwEwfRfo71oCf6C+CgzpIDLzsmy2T3gS8QKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECm5iHTPr99bmbcQKxArECsQKxArECsQKxArECsQKxArECsQKxAr+/+GDxArECsQKxArECsQKxArECsQKxArECsQKxArECi60AYGwUqdYywAAAABJRU5ErkJggg==";

test("existing-conditions native handoff restores the exact persisted compiler workflow", () => {
  const sessionId = `registered-mep-handoff-${Date.now()}`;
  const fingerprint = "a".repeat(64);
  const workflow = {
    inputFingerprintSha256: fingerprint,
    provisionalObservationIds: ["route-1"],
    operations: [
      {
        action_key: "route:route-1",
        observation_ids: ["route-1"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 2,
        apply_body: { kind: "pipe", apply: true }
      }
    ],
    dryRun: true,
    verify: true,
    maximumCreatedElements: 2,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  } as any;
  __testOnlyNoteRegisteredMepWorkflow(sessionId, "frame-1", 3960410, workflow);
  const req = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `${sessionId}:message`,
    user_text: "Draft the existing conditions from this record drawing."
  } as ChatRequest;

  const [dryRun] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [{
      action_id: "bad-envelope",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      body: {
        schema_version: 1,
        source_frame_id: "frame-1",
        compiled_plan: {},
        dryRun: true
      }
    }],
    [],
    req
  );
  assert.equal((dryRun?.body as any)?.stageKey, "operation:route:route-1");
  assert.equal((dryRun?.body as any)?.operations.length, 1);
  assert.deepEqual((dryRun?.body as any)?.priorActionOutputs, []);

  const [apply] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [{
      action_id: "bad-envelope-apply",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      body: {
        compiled_plan: {},
        dryRun: false
      }
    }],
    [{
      action_id: "verified-dry-run",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:route:route-1",
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        error: null,
        operationOutputs: [{
          action_key: "route:route-1",
          created_element_ids: [101]
        }]
      }
    }],
    req
  );
  assert.equal((apply?.body as any)?.dryRun, false);
  assert.deepEqual((apply?.body as any)?.operations, workflow.operations);
});

test("registered existing-conditions compiler hands off exact dry-run then exact apply without another model decision", () => {
  const sessionId = `registered-mep-direct-handoff-${Date.now()}`;
  const fingerprint = "b".repeat(64);
  const workflow = {
    inputFingerprintSha256: fingerprint,
    provisionalObservationIds: ["route-1"],
    operations: [
      {
        action_key: "route:route-1",
        observation_ids: ["route-1"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 1,
        apply_body: { kind: "pipe", apply: true }
      }
    ],
    dryRun: true,
    verify: true,
    maximumCreatedElements: 1,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  } as any;
  __testOnlyNoteRegisteredMepWorkflow(sessionId, "frame-direct", 3960410, workflow);

  const dryRun = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, []);
  assert.ok(dryRun);
  assert.equal(dryRun.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
  assert.equal((dryRun.actions[0]?.body as any)?.stageKey, "operation:route:route-1");
  assert.equal((dryRun.actions[0]?.body as any)?.operations.length, 1);
  assert.deepEqual((dryRun.actions[0]?.body as any)?.priorActionOutputs, []);

  const apply = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, [
    {
      action_id: "verified-dry-run",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:route:route-1",
        status: "DryRunReady",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        error: null,
        operationOutputs: [{
          action_key: "route:route-1",
          created_element_ids: [101]
        }]
      }
    }
  ]);
  assert.ok(apply);
  assert.equal((apply.actions[0]?.body as any)?.dryRun, false);
  assert.deepEqual((apply.actions[0]?.body as any)?.operations, workflow.operations);

  const readback = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, [
    {
      action_id: "verified-apply",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:route:route-1",
        status: "Applied",
        dryRun: false,
        atomic: true,
        error: null,
        createdElementIds: [201],
        operationOutputs: [{
          action_key: "route:route-1",
          created_element_ids: [201]
        }]
      }
    }
  ]);
  assert.ok(readback);
  assert.equal(readback.actions[0]?.path, "/revit/get-element-summary");
  assert.deepEqual((readback.actions[0]?.body as any)?.elementIds, [201]);

  const visual = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, [{
    action_id: "verified-readback",
    method: "POST",
    path: "/revit/get-element-summary",
    status: "done",
    result_json: {
      status: "ok",
      items: [{ id: 201, category: "Pipes" }]
    }
  }]);
  assert.ok(visual);
  assert.equal(visual.actions[0]?.path, "/revit/highlight-and-export");
  assert.deepEqual((visual.actions[0]?.body as any)?.elementIds, [201]);

  const complete = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, [{
    action_id: "verified-visual",
    method: "POST",
    path: "/revit/highlight-and-export",
    status: "done",
    result_json: {
      status: "ok",
      path: "C:\\evidence\\route.png"
    }
  }]);
  assert.ok(complete);
  assert.deepEqual(complete.actions, []);
  assert.match(complete.assistant_message, /accepted and persisted/i);
  assert.doesNotMatch(complete.assistant_message, /will not compile or apply a second geometry set/i);
});

test("registered existing-conditions apply guard is scoped to one user message", () => {
  const sessionId = `registered-mep-message-scope-${Date.now()}`;
  const firstFingerprint = "d".repeat(64);
  const secondFingerprint = "e".repeat(64);
  const workflowFor = (fingerprint: string) => ({
    inputFingerprintSha256: fingerprint,
    provisionalObservationIds: ["route-1"],
    operations: [
      {
        action_key: "route:route-1",
        observation_ids: ["route-1"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 1,
        apply_body: { kind: "pipe", apply: true }
      }
    ],
    dryRun: true,
    verify: true,
    maximumCreatedElements: 1,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  } as any);
  __testOnlyNoteRegisteredMepWorkflow(
    sessionId,
    "frame-first",
    3960410,
    workflowFor(firstFingerprint)
  );
  const firstApplyReceipt = {
    action_id: "verified-first-apply",
    method: "POST" as const,
    path: "/revit/existing-conditions-mep-draft-workflow",
    status: "done" as const,
    result_json: {
      inputFingerprintSha256: firstFingerprint,
      stageKey: "operation:route:route-1",
      status: "Applied",
      dryRun: false,
      atomic: true,
      error: null,
      createdElementIds: [301],
      operationOutputs: [{
        action_key: "route:route-1",
        created_element_ids: [301]
      }]
    }
  };
  const firstReadback = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(
    sessionId,
    [firstApplyReceipt],
    "message-first",
    [firstApplyReceipt]
  );
  assert.ok(firstReadback);
  assert.equal(firstReadback.actions[0]?.path, "/revit/get-element-summary");

  __testOnlyNoteRegisteredMepWorkflow(
    sessionId,
    "frame-second",
    3960410,
    workflowFor(secondFingerprint)
  );
  const secondDryRun = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(
    sessionId,
    [firstApplyReceipt],
    "message-second",
    []
  );
  assert.ok(secondDryRun);
  assert.equal(secondDryRun.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
  assert.equal((secondDryRun.actions[0]?.body as any)?.inputFingerprintSha256, secondFingerprint);
  assert.equal((secondDryRun.actions[0]?.body as any)?.dryRun, true);
});

test("registered existing-conditions compiler does not replay a failed matching dry-run", () => {
  const sessionId = `registered-mep-failed-handoff-${Date.now()}`;
  const fingerprint = "c".repeat(64);
  __testOnlyNoteRegisteredMepWorkflow(sessionId, "frame-failed", 3960410, {
    inputFingerprintSha256: fingerprint,
    provisionalObservationIds: ["route-1"],
    operations: [
      {
        action_key: "route:route-1",
        observation_ids: ["route-1"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 1,
        apply_body: { kind: "pipe", apply: true }
      }
    ],
    dryRun: true,
    verify: true,
    maximumCreatedElements: 1,
    benchmarkCredit: false,
    authorizationBasis: "explicit_unscored_user_direction"
  } as any);

  const response = __testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, [
    {
      action_id: "blocked-dry-run",
      method: "POST",
      path: "/revit/existing-conditions-mep-draft-workflow",
      status: "done",
      result_json: {
        inputFingerprintSha256: fingerprint,
        stageKey: "operation:route:route-1",
        status: "Blocked",
        dryRun: true,
        rollbackVerified: true,
        residualCreatedElementIds: [],
        error: "route_failed"
      }
    }
  ]);
  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /preserved as rejected/i);
  assert.match(response.assistant_message, /route_failed/i);
});

test("registered existing-conditions compiler never hands off a stale workflow after a newer compile guard failure", () => {
  const sessionId = `registered-mep-stale-after-guard-${Date.now()}`;
  __testOnlySetCandidateVisibleCompileContext(sessionId, "source.pdf", "registration-context-a");
  __testOnlyNoteRegisteredMepWorkflow(
    sessionId,
    "frame-stale",
    3960410,
    {
      inputFingerprintSha256: "f".repeat(64),
      provisionalObservationIds: ["stale-route"],
      operations: [{
        action_key: "route:stale-route",
        observation_ids: ["stale-route"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 1,
        apply_body: { kind: "pipe", apply: true }
      }],
      dryRun: true,
      verify: true,
      maximumCreatedElements: 1,
      benchmarkCredit: false,
      authorizationBasis: "explicit_unscored_user_direction"
    } as any,
    "registration-context-a"
  );
  assert.ok(__testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, []));

  __testOnlyRecordCandidateVisibleCompileResults(sessionId, [{
    index: 1,
    type: "compile_registered_mep_reconstruction",
    ok: false,
    summary: "candidate_visible_route_outside_spatial_scope:new-route"
  }]);

  assert.equal(__testOnlyBuildRegisteredMepWorkflowHandoffResponse(sessionId, []), null);
});

test("redline view alignment extracts structured Responses API output", () => {
  const text = __testOnlyExtractViewAlignmentResponseText({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{\"matched\":true,\"confidence\":0.8,\"analysis\":\"ok\",\"crop\":null,\"marks\":[]}"
          }
        ]
      }
    ]
  });
  assert.match(text, /"matched":true/);

  const parsedText = __testOnlyExtractViewAlignmentResponseText({
    output_parsed: { matched: true, confidence: 0.8, analysis: "ok", crop: null, marks: [] }
  });
  assert.match(parsedText, /"confidence":0.8/);
});

test("redline alignment crop projection corrects drifting view mark", () => {
  const marks = __testOnlyRefineAlignmentMarksWithImageMarkCrop({
    alignment: {
      confidence: 0.78,
      crop: { min_u: 0.456, min_v: 0.56, max_u: 0.565, max_v: 0.88 },
      marks: [{ normalized_x: 0.462, normalized_y: 0.801, score: 0.78, label: "model drift" }]
    },
    rawHint: {
      normalized_x: 0.055,
      normalized_y: 0.666,
      side: "left",
      source: "raw_image_mark",
      score: 0.72,
      image_width: 762,
      image_height: 635
    }
  });

  assert.equal(marks[0]?.normalized_x, 0.461995);
  assert.ok(Math.abs((marks[0]?.normalized_y ?? 0) - 0.77312) < 0.00001);
  assert.match(marks[0]?.label ?? "", /projected through matched view crop/);
});

test("view alignment treats room data and markup as optional and prioritizes durable common landmarks", () => {
  const prompt = __testOnlyBuildViewAlignmentPrompt(
    "Draft the visible existing plumbing from this old black-and-white record plan."
  );

  assert.match(prompt, /black-and-white/i);
  assert.match(prompt, /room tags, room names, or space names/i);
  assert.match(prompt, /exterior envelope and corners; stairs and elevator cores; shafts; grids and columns/i);
  assert.match(prompt, /clean record drawing can be a valid match with marks=\[\]/i);
  assert.match(prompt, /do not classify colored lines, symbols, or fixtures as markups/i);
  assert.match(prompt, /interior partitions that changed/i);
  assert.match(prompt, /registration_controls/i);
  assert.match(prompt, /at least two spatially separated controls/i);
  assert.match(prompt, /source_room_labels/i);
  assert.match(prompt, /semantic source evidence, not a registration control/i);
});

test("view alignment tries Gemini structured image output before OpenAI fallback", { concurrency: false }, async () => {
  const workspace = ensureWorkspaceLayout();
  const sourcePath = path.join(workspace.artifacts, "test-gemini-alignment-source.png");
  const viewPath = path.join(workspace.artifacts, "test-gemini-alignment-view.png");
  const png = Buffer.from(RED_MARK_PNG_BASE64, "base64");
  fs.writeFileSync(sourcePath, png);
  fs.writeFileSync(viewPath, png);
  const receivedBodies: Array<Record<string, any>> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      receivedBodies.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
              matched: true,
              confidence: 0.91,
              analysis: "Matched exterior corner and stair.",
              crop: { min_u: 0.1, min_v: 0.2, max_u: 0.9, max_v: 0.8 },
               registration_controls: [
                {
                  kind: "exterior_corner",
                  source_normalized_x: 0.1,
                  source_normalized_y: 0.1,
                  view_normalized_x: 0.18,
                  view_normalized_y: 0.26,
                  score: 0.93,
                  label: "northwest exterior corner"
                },
                {
                  kind: "stair",
                  source_normalized_x: 0.8,
                  source_normalized_y: 0.8,
                  view_normalized_x: 0.74,
                  view_normalized_y: 0.68,
                  score: 0.9,
                  label: "stair core"
                 }
               ],
               source_room_labels: [{
                 text: "TRAINING ROOM 120",
                 normalized_x: 0.52,
                 normalized_y: 0.17,
                 min_u: 0.50,
                 min_v: 0.15,
                 max_u: 0.54,
                 max_v: 0.19,
                 score: 0.96
               }],
               marks: []
              })
            }]
          }
        }]
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const prior = {
    key: process.env.OPERATOR_GEMINI_API_KEY,
    baseUrl: process.env.OPERATOR_GEMINI_BASE_URL,
    model: process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL,
    enabled: process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED
  };
  try {
    process.env.OPERATOR_GEMINI_API_KEY = "test-key";
    process.env.OPERATOR_GEMINI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL = "gemini-3-image-test";
    process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED = "1";
    const result = await alignRedlineToView({
      redline_file_path: sourcePath,
      view_image_relative_path: viewPath,
      objective: "Register old existing-conditions plan to current Revit view."
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3-image-test");
    assert.deepEqual(result.attempted_models, ["gemini-3-image-test"]);
    assert.equal(result.registration_controls.length, 2);
    assert.deepEqual(result.source_room_labels, [{
      text: "TRAINING ROOM 120",
      normalized_x: 0.52,
      normalized_y: 0.17,
      min_u: 0.5,
      min_v: 0.15,
      max_u: 0.54,
      max_v: 0.19,
      score: 0.96
    }]);
    const receivedBody = receivedBodies[0];
    assert.ok(receivedBody);
    assert.equal(
      receivedBody?.generationConfig?.responseMimeType,
      "application/json"
    );
    assert.deepEqual(
      receivedBody?.generationConfig?.responseJsonSchema?.required,
      ["matched", "confidence", "analysis", "crop", "registration_controls", "source_room_labels", "marks"]
    );
    assert.ok(
      receivedBody?.generationConfig?.responseJsonSchema?.properties?.registration_controls,
      "Gemini must receive the strict registration-control response schema"
    );
    assert.ok(
      receivedBody?.generationConfig?.responseJsonSchema?.properties?.source_room_labels,
      "Gemini must receive the strict source-room-label response schema"
    );
  } finally {
    for (const [key, value] of Object.entries({
      OPERATOR_GEMINI_API_KEY: prior.key,
      OPERATOR_GEMINI_BASE_URL: prior.baseUrl,
      OPERATOR_GEMINI_ALIGNMENT_MODEL: prior.model,
      OPERATOR_GEMINI_ALIGNMENT_ENABLED: prior.enabled
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("view alignment preserves failed Gemini provenance through OpenAI fallback and no-key failure", { concurrency: false }, async () => {
  const workspace = ensureWorkspaceLayout();
  const sourcePath = path.join(
    workspace.artifacts,
    "test-gemini-failure-provenance-source.png"
  );
  const viewPath = path.join(
    workspace.artifacts,
    "test-gemini-failure-provenance-view.png"
  );
  const png = Buffer.from(RED_MARK_PNG_BASE64, "base64");
  fs.writeFileSync(sourcePath, png);
  fs.writeFileSync(viewPath, png);
  const requestPaths: string[] = [];
  const server = http.createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    if ((request.url ?? "").startsWith("/models/")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider unavailable" } }));
      return;
    }
    if (request.url === "/responses") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "resp_after_gemini_failure",
        object: "response",
        status: "completed",
        model: "gpt-5.6-sol",
        output: [{
          id: "msg_after_gemini_failure",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              matched: true,
              confidence: 0.97,
              analysis: "Matched by durable geometry.",
              crop: {
                min_u: 0.1,
                min_v: 0.1,
                max_u: 0.9,
                max_v: 0.9
              },
              registration_controls: [
                {
                  kind: "stair",
                  source_normalized_x: 0.1,
                  source_normalized_y: 0.1,
                  view_normalized_x: 0.18,
                  view_normalized_y: 0.18,
                  score: 0.95,
                  label: "north stair"
                },
                {
                  kind: "stair",
                  source_normalized_x: 0.8,
                  source_normalized_y: 0.8,
                  view_normalized_x: 0.74,
                  view_normalized_y: 0.74,
                  score: 0.95,
                  label: "south stair"
                }
              ],
              marks: []
            }),
            annotations: []
          }]
        }]
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected request" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const prior = {
    operatorOpenAiKey: process.env.OPERATOR_OPENAI_API_KEY,
    openAiKey: process.env.OPENAI_API_KEY,
    openAiBaseUrl: process.env.OPERATOR_OPENAI_BASE_URL,
    geminiKey: process.env.OPERATOR_GEMINI_API_KEY,
    geminiBaseUrl: process.env.OPERATOR_GEMINI_BASE_URL,
    geminiModel: process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL,
    geminiEnabled: process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED
  };
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_API_KEY = "";
    process.env.OPERATOR_OPENAI_BASE_URL =
      `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_API_KEY = "test-gemini-key";
    process.env.OPERATOR_GEMINI_BASE_URL =
      `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL =
      "gemini-3-image-provenance-test";
    process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED = "1";

    const fallback = await alignRedlineToView({
      redline_file_path: sourcePath,
      view_image_relative_path: viewPath,
      model: "gpt-5.6-sol"
    });
    assert.equal(fallback.ok, true, JSON.stringify(fallback));
    assert.equal(fallback.provider, "openai");
    assert.deepEqual(fallback.attempted_models, [
      "gemini-3-image-provenance-test",
      "gpt-5.6-sol"
    ]);
    assert.match(
      fallback.fallback_reason ?? "",
      /Gemini gemini-3-image-provenance-test returned HTTP 500/
    );

    process.env.OPERATOR_OPENAI_API_KEY = "";
    const noOpenAiKey = await alignRedlineToView({
      redline_file_path: sourcePath,
      view_image_relative_path: viewPath
    });
    assert.equal(noOpenAiKey.ok, false);
    assert.deepEqual(noOpenAiKey.attempted_models, [
      "gemini-3-image-provenance-test"
    ]);
    assert.match(
      noOpenAiKey.fallback_reason ?? "",
      /Gemini gemini-3-image-provenance-test returned HTTP 500/
    );
    assert.equal(
      requestPaths.filter((requestPath) =>
        requestPath.startsWith("/models/")
      ).length,
      2
    );
    assert.equal(
      requestPaths.filter((requestPath) => requestPath === "/responses").length,
      1
    );
  } finally {
    for (const [key, value] of Object.entries({
      OPERATOR_OPENAI_API_KEY: prior.operatorOpenAiKey,
      OPENAI_API_KEY: prior.openAiKey,
      OPERATOR_OPENAI_BASE_URL: prior.openAiBaseUrl,
      OPERATOR_GEMINI_API_KEY: prior.geminiKey,
      OPERATOR_GEMINI_BASE_URL: prior.geminiBaseUrl,
      OPERATOR_GEMINI_ALIGNMENT_MODEL: prior.geminiModel,
      OPERATOR_GEMINI_ALIGNMENT_ENABLED: prior.geminiEnabled
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("view alignment gives pre-provider image failures terminal provenance", async () => {
  const result = await alignRedlineToView({
    redline_file_path: "artifacts/missing-existing-conditions-source.png",
    view_image_relative_path: "artifacts/missing-revit-frame.png"
  });

  assert.equal(result.ok, false);
  assert.equal(result.matched, false);
  assert.deepEqual(result.attempted_models, []);
  assert.equal(
    result.fallback_reason,
    "Alignment input unavailable before provider invocation: source image and Revit view preview."
  );
});

test("view alignment can skip Gemini for a native-rejected OpenAI geometry retry", { concurrency: false }, async () => {
  const workspace = ensureWorkspaceLayout();
  const sourcePath = path.join(workspace.artifacts, "test-openai-only-alignment-source.png");
  const viewPath = path.join(workspace.artifacts, "test-openai-only-alignment-view.png");
  const png = Buffer.from(RED_MARK_PNG_BASE64, "base64");
  fs.writeFileSync(sourcePath, png);
  fs.writeFileSync(viewPath, png);
  const requestPaths: string[] = [];
  const server = http.createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    if (request.method !== "POST" || request.url !== "/responses") {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unexpected provider request" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    const alignmentJson = JSON.stringify({
      matched: true,
      confidence: 0.98,
      analysis: "Matched exterior envelope and stair geometry.",
      crop: { min_u: 0.05, min_v: 0.06, max_u: 0.84, max_v: 0.88 },
      registration_controls: [
        {
          kind: "exterior_corner",
          source_normalized_x: 0.1,
          source_normalized_y: 0.1,
          view_normalized_x: 0.13,
          view_normalized_y: 0.14,
          score: 0.96,
          label: "northwest exterior corner"
        },
        {
          kind: "stair",
          source_normalized_x: 0.8,
          source_normalized_y: 0.8,
          view_normalized_x: 0.68,
          view_normalized_y: 0.72,
          score: 0.94,
          label: "south stair"
        }
      ],
      marks: []
    });
    response.end(JSON.stringify({
      id: "resp_geometry_retry",
      object: "response",
      status: "completed",
      model: "gpt-5.6-sol",
      output: [{
        id: "msg_geometry_retry",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{
          type: "output_text",
          text: alignmentJson,
          annotations: []
        }]
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const prior = {
    openAiKey: process.env.OPERATOR_OPENAI_API_KEY,
    openAiBaseUrl: process.env.OPERATOR_OPENAI_BASE_URL,
    geminiKey: process.env.OPERATOR_GEMINI_API_KEY,
    geminiBaseUrl: process.env.OPERATOR_GEMINI_BASE_URL,
    geminiEnabled: process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED
  };
  try {
    process.env.OPERATOR_OPENAI_API_KEY = "test-openai-key";
    process.env.OPERATOR_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_API_KEY = "test-gemini-key";
    process.env.OPERATOR_GEMINI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED = "1";
    const result = await alignRedlineToView({
      redline_file_path: sourcePath,
      view_image_relative_path: viewPath,
      objective: "Retry geometry after native rejection.",
      provider_preference: "openai_only",
      prior_attempted_models: ["gemini-3-flash-preview"],
      openai_fallback_reason:
        "Gemini structured alignment was rejected by native Revit landmark verification for this exact frame.",
      model: "gpt-5.6-sol"
    });
    assert.deepEqual(requestPaths, ["/responses"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.provider, "openai");
    assert.equal(result.model, "gpt-5.6-sol");
    assert.deepEqual(result.attempted_models, [
      "gemini-3-flash-preview",
      "gpt-5.6-sol"
    ]);
    assert.match(result.fallback_reason ?? "", /native Revit landmark verification/i);
  } finally {
    for (const [key, value] of Object.entries({
      OPERATOR_OPENAI_API_KEY: prior.openAiKey,
      OPERATOR_OPENAI_BASE_URL: prior.openAiBaseUrl,
      OPERATOR_GEMINI_API_KEY: prior.geminiKey,
      OPERATOR_GEMINI_BASE_URL: prior.geminiBaseUrl,
      OPERATOR_GEMINI_ALIGNMENT_ENABLED: prior.geminiEnabled
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("view alignment accepts a full-sheet source above the legacy 1.5 MB image cap when budgeted", { concurrency: false }, async () => {
  const workspace = ensureWorkspaceLayout();
  const sourcePath = path.join(workspace.artifacts, "test-gemini-full-sheet-source.png");
  const viewPath = path.join(workspace.artifacts, "test-gemini-full-sheet-view.png");
  fs.writeFileSync(sourcePath, Buffer.alloc(1_600_000, 7));
  fs.writeFileSync(viewPath, Buffer.from(RED_MARK_PNG_BASE64, "base64"));
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              matched: false,
              confidence: 0.2,
              analysis: "Full sheet reached Gemini but controls were insufficient.",
              crop: null,
              registration_controls: [],
              marks: []
            })
          }]
        }
      }]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const prior = {
    key: process.env.OPERATOR_GEMINI_API_KEY,
    baseUrl: process.env.OPERATOR_GEMINI_BASE_URL,
    model: process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL,
    enabled: process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED
  };
  try {
    process.env.OPERATOR_GEMINI_API_KEY = "test-key";
    process.env.OPERATOR_GEMINI_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.OPERATOR_GEMINI_ALIGNMENT_MODEL = "gemini-3-image-test";
    process.env.OPERATOR_GEMINI_ALIGNMENT_ENABLED = "1";
    const result = await alignRedlineToView({
      redline_file_path: sourcePath,
      view_image_relative_path: viewPath,
      objective: "Register a full existing-conditions sheet.",
      max_image_bytes: 8_388_608
    });
    assert.equal(requestCount, 1);
    assert.equal(result.ok, true);
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-3-image-test");
    assert.equal(result.matched, false);
  } finally {
    for (const [key, value] of Object.entries({
      OPERATOR_GEMINI_API_KEY: prior.key,
      OPERATOR_GEMINI_BASE_URL: prior.baseUrl,
      OPERATOR_GEMINI_ALIGNMENT_MODEL: prior.model,
      OPERATOR_GEMINI_ALIGNMENT_ENABLED: prior.enabled
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});

test("redline auto-align uses the analyzed page preview for a PDF seed", () => {
  const resolved = __testOnlyResolveRedlineAlignmentImagePath({
    seedFilePath: "uploads/existing-conditions/P1.01.pdf",
    workbenchResults: [
      {
        index: 0,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "uploads/existing-conditions/P1.01.pdf",
          vision_artifacts: {
            annotated_image_path: "artifacts/redline/P1.01_annotated.png",
            preview_image_path: "artifacts/redline/page_0001.png",
            crop_image_paths: ["artifacts/redline/P1.01_crop_01.png"]
          }
        }
      }
    ] as any
  });

  assert.equal(resolved, "artifacts/redline/page_0001.png");
});

test("redline auto-align retains the analyzed PDF preview across continuation turns", () => {
  const sessionId = "persisted-pdf-preview";
  __testOnlyResolveRedlineAlignmentImagePath({
    sessionId,
    seedFilePath: "uploads/existing-conditions/P1.01.pdf",
    persistedImagePaths: [
      "artifacts/redline/P1.01_annotated.png",
      "artifacts/redline/page_0001.png"
    ]
  });

  const resolved = __testOnlyResolveRedlineAlignmentImagePath({
    sessionId,
    seedFilePath: "uploads/existing-conditions/P1.01.pdf",
    workbenchResults: []
  });

  assert.equal(resolved, "artifacts/redline/page_0001.png");
});

test("redline auto-align keeps a directly attached image instead of an analyzed derivative", () => {
  const resolved = __testOnlyResolveRedlineAlignmentImagePath({
    seedFilePath: "uploads/redline.png",
    workbenchResults: [
      {
        index: 0,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "uploads/redline.png",
          vision_artifacts: {
            preview_image_path: "artifacts/redline/page_0001.png"
          }
        }
      }
    ] as any
  });

  assert.equal(resolved, "uploads/redline.png");
});

test("redline auto-align can read export-view-frame result path without attachment wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-frame-path-"));
  try {
    const framePath = path.join(root, "view-frame.png");
    fs.writeFileSync(framePath, Buffer.from(RED_MARK_PNG_BASE64, "base64"));
    const context = __testOnlyExtractLatestFrameImageContext(
      [
        {
          action_id: "frame-path",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-path",
            viewId: 1363433,
            widthPx: 100,
            heightPx: 50,
            path: framePath,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        }
      ] as any,
      1363433
    );

    assert.ok(context);
    assert.equal(context.image_local_path, framePath);
    assert.match(context.image_data_url ?? "", /^data:image\/png;base64,/);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows can briefly hold SQLite/workspace files during async cleanup.
    }
  }
});

test("redline auto-align can use compacted native frame attachment bytes on hosted backend", () => {
  const payload = RED_MARK_PNG_BASE64 + "A".repeat(650_000);
  const compacted = compactIncomingToolResult({
    action_id: "hosted-frame",
    method: "POST",
    path: "/revit/export-view-frame",
    status: "done",
    result_json: {
      frameId: "hosted-frame",
      viewId: 1363433,
      widthPx: 100,
      heightPx: 50,
      path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.png",
      mapping: {
        topLeftXyz: [0, 10, 0],
        topRightXyz: [10, 10, 0],
        bottomLeftXyz: [0, 0, 0]
      }
    },
    attachments: [
      {
        kind: "image",
        mime: "image/png",
        filename: "view-frame.png",
        local_path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.png",
        data_base64: payload
      }
    ]
  });

  const context = __testOnlyExtractLatestFrameImageContext([compacted], 1363433);

  assert.ok(context);
  assert.equal(context.image_local_path, "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.png");
  assert.equal(context.image_data_url, `data:image/png;base64,${payload}`);
});

test("goal-mode routing preserves export-view-frame image attachments through tool result normalization", () => {
  const payload = RED_MARK_PNG_BASE64 + "A".repeat(650_000);
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "hosted-goal-attachment-normalization",
    message_id: "hosted-goal-attachment-normalization:assistant:1",
    user_text: "",
    tool_results: [
      {
        action_id: "hosted-frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "hosted-frame",
          viewId: 1363433,
          widthPx: 100,
          heightPx: 50,
          path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.png",
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        },
        attachments: [
          {
            kind: "image",
            mime: "image/png",
            filename: "view-frame.png",
            local_path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.png",
            data_base64: payload
          }
        ]
      }
    ]
  };

  const normalized = __testOnlyGetAugmentedToolResults(req, 10);
  const context = __testOnlyExtractLatestFrameImageContext(normalized, 1363433);

  assert.ok(context);
  assert.equal(context.image_data_url, `data:image/png;base64,${payload}`);
});

test("redline frame extraction accepts snake-case native frame payloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-frame-snake-"));
  try {
    const framePath = path.join(root, "view-frame-snake.png");
    fs.writeFileSync(framePath, Buffer.from(RED_MARK_PNG_BASE64, "base64"));
    const context = __testOnlyExtractLatestFrameImageContext(
      [
        {
          action_id: "frame-snake",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frame_id: "frame-snake",
            view_id: 1363337,
            width_px: 100,
            height_px: 50,
            local_path: framePath,
            mapping: {
              top_left_xyz: [0, 10, 0],
              top_right_xyz: [10, 10, 0],
              bottom_left_xyz: [0, 0, 0]
            }
          }
        }
      ] as any,
      1363337
    );

    assert.ok(context);
    assert.equal(context.frame.frame_id, "frame-snake");
    assert.equal(context.frame.width_px, 100);
    assert.deepEqual(context.frame.top_left_xyz, [0, 10, 0]);
    assert.equal(context.image_local_path, framePath);
    assert.match(context.image_data_url ?? "", /^data:image\/png;base64,/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("responses stream finalResponse text is recovered from message content when output_text is absent", () => {
  const text = __testOnlyExtractResponsesApiOutputText({
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "{\"assistant_message\":\"hello\",\"actions\":[]}"
          }
        ]
      }
    ]
  });

  assert.equal(text, "{\"assistant_message\":\"hello\",\"actions\":[]}");
});

test("native Revit routing normalizes linked-host apply after a successful preview", () => {
  const actions: ActionCall[] = [
    {
      action_id: "apply",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      body: {
        exemplarElementId: 1556486,
        hostElementId: 1362762,
        orientationSourceElementId: 1556486,
        matchOrientationFromSource: true,
        dryRun: false,
        includePreviewImage: true,
        placements: [{ label: "mark 1", pointXyz: [-42.986979, -27.622897, 32.166667] }]
      }
    }
  ];
  const toolResults: ToolResult[] = [
    {
      action_id: "preview",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      status: "done",
      result_json: {
        dryRun: true,
        status: "Planned",
        placements: [
          {
            placementReference: { basis: "linked_face_reference", linkedElementId: 123 },
            hostLocalFrame: { basis: "linked_room_boundary", hostElementId: 1362762 }
          }
        ],
        placementValidation: { valid: true }
      }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, toolResults);
  const body = normalized[0]?.body as any;
  assert.equal(body.matchOrientationFromSource, false);
  assert.equal("orientationSourceElementId" in body, false);
  assert.equal(body.includePreviewImage, false);
});

test("native Revit routing projects frame-aligned redline marks onto the resolved host wall", () => {
  const sessionId = "frame-aligned-host-target-normalization";
  __testOnlySeedRedlineFrameAlignedHint({
    sessionId,
    viewId: 1363337,
    normalizedX: 0.494,
    normalizedY: 0.73,
    score: 0.9
  });

  const req: Partial<ChatRequest> = {
    session_id: sessionId,
    user_text: "add receptacle where indicated and circuit to P405/1"
  };
  const toolResults: ToolResult[] = [
    {
      action_id: "frame",
      method: "POST",
      path: "/revit/export-view-frame",
      status: "done",
      result_json: {
        frameId: "frame",
        viewId: 1363337,
        widthPx: 2200,
        heightPx: 1031,
        mapping: {
          topLeftXyz: [-137.61963, 72.132123, -467.883333],
          topRightXyz: [116.539865, 72.132123, -467.883333],
          bottomLeftXyz: [-137.61963, -46.914844, -467.883333]
        }
      }
    },
    {
      action_id: "wall",
      method: "POST",
      path: "/revit/resolve-room-wall",
      status: "done",
      result_json: {
        room: { number: "405", requestedSide: "left" },
        walls: [
          {
            hostElementId: 1362762,
            supportsPlacement: true,
            placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
            hostContext: {
              hostElementId: 1362762,
              projectedPoint: [-19.760417, -13.671875, 32.166667],
              tangent: [0, -1, 0],
              curveLengthFt: 26.541667
            },
            wallPlacement: {
              projectedPoint: [-19.760417, -13.671875, 32.166667],
              tangent: [0, -1, 0],
              curveLengthFt: 26.541667
            }
          }
        ]
      }
    }
  ] as any;
  const actions: ActionCall[] = [
    {
      action_id: "apply",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      body: {
        exemplarElementId: 1554033,
        hostElementId: 1362762,
        roomNumber: "405",
        roomSide: "left",
        dryRun: false,
        placements: [{ pointXyz: [-19.760417, -17.171875, 32.166667], label: "mark 1" }],
        previewViewId: 1363337
      }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, toolResults, req);
  const body = normalized[0]?.body as any;
  assert.equal(body.placements[0].targetSource, "frame_aligned_redline_projection");
  assert.deepEqual(body.placements[0].pointXyz.map((n: number) => Number(n.toFixed(6))), [-19.760417, -14.772163, 32.166667]);
});

test("native Revit routing audits against frame-aligned redline target instead of self-reported placement", () => {
  const sessionId = "frame-aligned-host-audit-normalization";
  __testOnlySeedRedlineFrameAlignedHint({
    sessionId,
    viewId: 1363337,
    normalizedX: 0.494,
    normalizedY: 0.73,
    score: 0.9
  });

  const req: Partial<ChatRequest> = {
    session_id: sessionId,
    user_text: "add receptacle where indicated and circuit to P405/1"
  };
  const toolResults: ToolResult[] = [
    {
      action_id: "frame",
      method: "POST",
      path: "/revit/export-view-frame",
      status: "done",
      result_json: {
        frameId: "frame",
        viewId: 1363337,
        widthPx: 2200,
        heightPx: 1031,
        mapping: {
          topLeftXyz: [-137.61963, 72.132123, -467.883333],
          topRightXyz: [116.539865, 72.132123, -467.883333],
          bottomLeftXyz: [-137.61963, -46.914844, -467.883333]
        }
      }
    },
    {
      action_id: "wall",
      method: "POST",
      path: "/revit/resolve-room-wall",
      status: "done",
      result_json: {
        room: { number: "405", requestedSide: "left" },
        walls: [
          {
            hostElementId: 1362762,
            supportsPlacement: true,
            placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
            hostContext: {
              hostElementId: 1362762,
              projectedPoint: [-19.760417, -13.671875, 32.166667],
              tangent: [0, -1, 0],
              curveLengthFt: 26.541667
            }
          }
        ]
      }
    }
  ] as any;
  const actions: ActionCall[] = [
    {
      action_id: "audit",
      method: "POST",
      path: "/revit/audit-hosted-instance-placement",
      body: {
        elementIds: [1735508],
        roomNumber: "405",
        roomSide: "left",
        hostElementId: 1362762,
        targetPointXyz: [-19.760417, -17.171875, 32.166667],
        targetToleranceFt: 0.5
      }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, toolResults, req);
  const body = normalized[0]?.body as any;
  assert.equal(body.targetSource, "frame_aligned_redline_projection");
  assert.deepEqual(body.targetPointXyz.map((n: number) => Number(n.toFixed(6))), [-19.760417, -14.772163, 32.166667]);
});

test("native Revit routing prefers raw wall-local redline chainage over coarse frame projection", () => {
  const sessionId = "wall-local-redline-chainage-precedence";
  __testOnlySeedRedlineFrameAlignedHint({
    sessionId,
    viewId: 1363337,
    normalizedX: 0.494,
    normalizedY: 0.73,
    score: 0.9
  });
  __testOnlySeedRedlineRawImageMarkHint({
    sessionId,
    normalizedX: 0.291,
    normalizedY: 0.509,
    wallLocalNormalizedChainage: 0.782328,
    wallLocalAxis: "vertical"
  });

  const req: Partial<ChatRequest> = {
    session_id: sessionId,
    user_text: "add receptacle where indicated and circuit to P405/1"
  };
  const toolResults: ToolResult[] = [
    {
      action_id: "frame",
      method: "POST",
      path: "/revit/export-view-frame",
      status: "done",
      result_json: {
        frameId: "frame",
        viewId: 1363337,
        widthPx: 2200,
        heightPx: 1031,
        mapping: {
          topLeftXyz: [-137.61963, 72.132123, -467.883333],
          topRightXyz: [116.539865, 72.132123, -467.883333],
          bottomLeftXyz: [-137.61963, -46.914844, -467.883333]
        }
      }
    },
    {
      action_id: "wall",
      method: "POST",
      path: "/revit/resolve-room-wall",
      status: "done",
      result_json: {
        room: { number: "405", requestedSide: "left" },
        walls: [
          {
            hostElementId: 1362762,
            supportsPlacement: true,
            placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
            hostContext: {
              hostElementId: 1362762,
              projectedPoint: [-19.760417, -13.671875, 32.166667],
              tangent: [0, -1, 0],
              curveLengthFt: 26.541667
            },
            wallPlacement: {
              projectedPoint: [-19.760417, -13.671875, 32.166667],
              tangent: [0, -1, 0],
              curveLengthFt: 26.541667
            }
          }
        ]
      }
    }
  ] as any;
  const actions: ActionCall[] = [
    {
      action_id: "apply",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      body: {
        exemplarElementId: 1554033,
        hostElementId: 1362762,
        roomNumber: "405",
        roomSide: "left",
        dryRun: false,
        placements: [{ pointXyz: [-19.760417, -17.171875, 32.166667], label: "mark 1" }],
        previewViewId: 1363337
      }
    },
    {
      action_id: "audit",
      method: "POST",
      path: "/revit/audit-hosted-instance-placement",
      body: {
        elementIds: [1735508],
        roomNumber: "405",
        roomSide: "left",
        hostElementId: 1362762,
        targetPointXyz: [-19.760417, -17.171875, 32.166667],
        targetToleranceFt: 0.5
      }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, toolResults, req);
  const applyBody = normalized[0]?.body as any;
  const auditBody = normalized[1]?.body as any;
  assert.equal(applyBody.placements[0].targetSource, "redline_wall_local_chainage");
  assert.equal("pointXyz" in applyBody.placements[0], false);
  assert.equal(Number(applyBody.placements[0].targetNormalizedChainage.toFixed(6)), 0.782328);
  assert.equal(Number(applyBody.placements[0].targetChainageFt.toFixed(6)), 20.764289);
  assert.equal(auditBody.targetSource, "redline_wall_local_chainage");
  assert.equal("targetPointXyz" in auditBody, false);
  assert.equal(Number(auditBody.targetNormalizedChainage.toFixed(6)), 0.782328);
});

test("final response normalization applies wall-local redline targets to deterministic bridge actions", () => {
  const sessionId = "wall-local-redline-finalizer";
  __testOnlySeedRedlineRawImageMarkHint({
    sessionId,
    normalizedX: 0.291,
    normalizedY: 0.509,
    wallLocalNormalizedChainage: 0.782328,
    wallLocalAxis: "vertical"
  });
  const req = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `${sessionId}:message`,
    user_text: "add receptacle where indicated and circuit to P405/1",
    tool_results: [
      {
        action_id: "wall",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          room: { number: "405", requestedSide: "left" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                projectedPoint: [-19.760417, -13.671875, 32.166667],
                tangent: [0, -1, 0],
                curveLengthFt: 26.541667
              },
              wallPlacement: {
                projectedPoint: [-19.760417, -13.671875, 32.166667],
                tangent: [0, -1, 0],
                curveLengthFt: 26.541667
              }
            }
          ]
        }
      }
    ]
  } satisfies ChatRequest;
  const response = __testOnlyFinalizeOpenAiResponseForRequest(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "",
    actions: [
      {
        action_id: "apply",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        body: {
          exemplarElementId: 1554033,
          hostElementId: 1362762,
          roomNumber: "405",
          roomSide: "left",
          dryRun: false,
          placements: [{ pointXyz: [-19.760417, -16.671875, 32.166667], label: "mark 1" }],
          previewViewId: 1363337
        }
      }
    ]
  });

  const body = response.actions[0]?.body as any;
  assert.equal(body.placements[0].targetSource, "redline_wall_local_chainage");
  assert.equal("pointXyz" in body.placements[0], false);
  assert.equal(Number(body.placements[0].targetNormalizedChainage.toFixed(6)), 0.782328);
});

test("native Revit routing flattens dialog guard schema and removes invalid electrical device category", () => {
  const actions: ActionCall[] = [
    {
      action_id: "guard",
      method: "POST",
      path: "/revit/computer-use-guard",
      body: {
        match: { dialogIdContains: "DocWarnDialog", messageContains: "duplicate" },
        timeoutMs: 5000
      }
    },
    {
      action_id: "room",
      method: "POST",
      path: "/revit/room-contents",
      body: {
        categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
        includeCategories: ["OST_ElectricalDevices"]
      }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, []);
  const guardBody = normalized[0]?.body as any;
  assert.equal(guardBody.dialogIdContains, "DocWarnDialog");
  assert.equal(guardBody.messageContains, "duplicate");
  assert.equal(guardBody.ttlMs, 5000);
  assert.equal("match" in guardBody, false);
  assert.equal("timeoutMs" in guardBody, false);

  const roomBody = normalized[1]?.body as any;
  assert.deepEqual(roomBody.categories, ["OST_ElectricalFixtures"]);
  assert.deepEqual(roomBody.includeCategories, ["OST_ElectricalFixtures"]);
});

test("native Revit routing repairs common discovery action body aliases", () => {
  const actions: ActionCall[] = [
    {
      action_id: "doc",
      method: "POST",
      path: "/revit/tool-doc",
      body: { path: "/revit/native-api-call" }
    },
    {
      action_id: "examples",
      method: "POST",
      path: "/revit/tool-examples",
      body: { tool: "/revit/place-family-instance-on-host" }
    },
    {
      action_id: "search",
      method: "POST",
      path: "/revit/tool-search",
      body: { query: "place receptacle", maxResults: 10 }
    },
    {
      action_id: "native-search",
      method: "POST",
      path: "/revit/native-api-search",
      body: { query: "NewFamilyInstance", limit: 20 }
    }
  ];

  const normalized = __testOnlyNormalizeNativeRevitActionBodiesForRouting(actions, []);
  assert.deepEqual(normalized[0]?.body, { path: "/revit/native-api-call", method: "POST" });
  assert.deepEqual(normalized[1]?.body, { tool: "/revit/place-family-instance-on-host", path: "/revit/place-family-instance-on-host", method: "POST" });
  assert.equal((normalized[2]?.body as any)?.max, 10);
  assert.equal((normalized[3]?.body as any)?.max, 20);
});

test("existing-conditions reconstruction stays on the explicit sheet placed view", () => {
  const actions = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "room-view",
        method: "POST",
        path: "/revit/resolve-room-plan-view",
        body: {
          roomNumber: "100",
          preferViewNameContains: "lighting"
        }
      },
      {
        action_id: "wrong-frame",
        method: "POST",
        path: "/revit/export-view-frame",
        body: {
          viewId: 6472944,
          includeMapping: true
        }
      },
      {
        action_id: "view-list",
        method: "GET",
        path: "/revit/views"
      },
      {
        action_id: "sheet-examples",
        method: "POST",
        path: "/revit/tool-examples",
        body: {
          path: "/revit/sheets",
          method: "POST"
        }
      }
    ],
    [
      {
        action_id: "sheet-detail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          sheetNumber: "P1.01",
          placedViews: [
            {
              viewId: 3960410,
              name: "LEVEL 01 - BUILDING 200 - NEW WORK - PLUMBING",
              viewType: "FloorPlan"
            }
          ]
        }
      }
    ],
    {
      session_id: "existing-conditions-sheet-anchor",
      user_text:
        "Using only P1.01_existing_conditions.pdf, recreate the visible plumbing existing conditions in room 100."
    }
  );

  assert.deepEqual(
    actions.map((action) => [action.path, action.body]),
    [
      ["/revit/export-view-frame", { viewId: 3960410, imageSize: 2200, includeMapping: true }],
      ["/revit/export-view-frame", { viewId: 3960410, imageSize: 2200, includeMapping: true }],
      ["/revit/export-view-frame", { viewId: 3960410, imageSize: 2200, includeMapping: true }],
      ["/revit/export-view-frame", { viewId: 3960410, imageSize: 2200, includeMapping: true }]
    ]
  );
});

test("verified existing-conditions room scope is not replaced by another identical room-boundary read", () => {
  const roomResult = {
    action_id: "room-scope",
    method: "POST",
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
  } as ToolResult;
  const [action] = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [{
      action_id: "generic-fallback",
      method: "POST",
      path: "/revit/rank-similar-devices-on-wall",
      body: { roomNumber: "100" }
    }],
    [roomResult],
    {
      session_id: "existing-conditions-room-scope-loop-guard",
      user_text: "Draft existing conditions in room 100 from the attached P1.01 source PDF."
    }
  );

  assert.equal(action?.path, "/revit/rank-similar-devices-on-wall");
});

test("verified existing-conditions alignment advances placed-view discovery to visible inventory", () => {
  const sessionId = "existing-conditions-aligned-inventory";
  __testOnlySeedRedlineViewAlignment({
    sessionId,
    frameId: "frame-p210",
    viewId: 3960410,
    confidence: 0.82,
    crop: { min_u: 0.2, min_v: 0.15, max_u: 0.8, max_v: 0.85 }
  });

  const actions = __testOnlyNormalizeNativeRevitActionBodiesForRouting(
    [
      {
        action_id: "generic-view-list",
        method: "GET",
        path: "/revit/views"
      }
    ],
    [
      {
        action_id: "sheet-detail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          sheetNumber: "P1.01",
          placedViews: [
            {
              viewId: 3960410,
              name: "LEVEL 01 - BUILDING 200 - NEW WORK - PLUMBING",
              viewType: "FloorPlan"
            }
          ]
        }
      }
    ],
    {
      session_id: sessionId,
      user_text:
        "Using only P1.01_existing_conditions.pdf, recreate the visible plumbing existing conditions in room 100."
    }
  );

  assert.equal(actions[0]?.path, "/revit/export-visible-elements");
  assert.equal(actions[0]?.method, "POST");
  assert.deepEqual(actions[0]?.body, {
    viewId: 3960410,
    imageSize: 2200,
    includeMapping: true,
    includeLinked: true,
    categories: [
      "OST_Walls",
      "OST_Doors",
      "OST_Windows",
      "OST_Rooms",
      "OST_MEPSpaces",
      "OST_RoomTags",
      "OST_Casework",
      "OST_PlumbingFixtures"
    ],
    limit: 500
  });
});

test("redline targeting infers electrical mutation requests as resolve-only model targeting", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "change the indicated receptacles to gfci type"
  });

  assert.deepEqual(profile.categories, ["OST_ElectricalFixtures", "OST_ElectricalDevices"]);
  assert.equal(profile.pick_preference, "modelGeometry");
  assert.equal(profile.scope_label, "electrical-device");
  assert.equal(profile.resolve_only, true);
  assert.equal(profile.room_number, null);
  assert.equal(profile.spatial_side, null);
});

test("redline targeting keeps delete-like annotation intent in delete mode", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "delete the crossed-out keynote",
    annotationRegionHints: [{ region_index: 1, subtype: "StrikeOut", is_delete_like: true, contents: "" }]
  });

  assert.deepEqual(profile.categories, [
    "OST_TextNotes",
    "OST_Lines",
    "OST_GenericAnnotation",
    "OST_DetailComponents",
    "OST_TitleBlocks",
    "OST_RasterImages"
  ]);
  assert.equal(profile.pick_preference, "annotation");
  assert.equal(profile.resolve_only, false);
});

test("redline execution bridge applies a dry-run-proven delete set", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "delete the crossed-out keynote",
    toolResults: [
      {
        action_id: "delete-preview",
        method: "POST",
        path: "/revit/delete",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6101],
          impactedIds: [6101]
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions.length, 1);
  assert.equal(response.actions[0]?.path, "/revit/delete");
  assert.deepEqual((response.actions[0]?.body as any)?.ids, [6101]);
  assert.equal((response.actions[0]?.body as any)?.apply, true);
  assert.match(response.assistant_message, /Dry-run delete verified/i);
});

test("redline execution bridge blocks delete apply when dry-run omits target ids", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "delete the crossed-out keynote",
    toolResults: [
      {
        action_id: "delete-preview",
        method: "POST",
        path: "/revit/delete",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6101],
          impactedIds: []
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /stopped before applying/i);
  assert.match(response.assistant_message, /6101/);
});

test("redline execution bridge finalizes delete only with prior dry-run evidence", () => {
  const appliedWithoutPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "delete the crossed-out keynote",
    toolResults: [
      {
        action_id: "delete-apply",
        method: "POST",
        path: "/revit/delete",
        status: "done",
        result_json: {
          status: "Deleted",
          requestedIds: [6101],
          deletedIds: [6101]
        }
      }
    ]
  });
  assert.ok(appliedWithoutPreview);
  assert.equal(appliedWithoutPreview.actions.length, 0);
  assert.match(appliedWithoutPreview.assistant_message, /cannot prove a prior dry-run/i);

  const appliedWithPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "delete the crossed-out keynote",
    toolResults: [
      {
        action_id: "delete-preview",
        method: "POST",
        path: "/revit/delete",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6101],
          impactedIds: [6101]
        }
      },
      {
        action_id: "delete-apply",
        method: "POST",
        path: "/revit/delete",
        status: "done",
        result_json: {
          status: "Deleted",
          requestedIds: [6101],
          deletedIds: [6101]
        }
      }
    ]
  });

  assert.ok(appliedWithPreview);
  assert.equal(appliedWithPreview.actions.length, 0);
  assert.match(appliedWithPreview.assistant_message, /Deleted the redline-targeted element id/i);
});

test("redline execution bridge applies a dry-run-proven move set", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "move the selected redline target 1 foot right",
    toolResults: [
      {
        action_id: "move-preview",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6201],
          movedIds: [6201],
          request: {
            ids: [6201],
            mode: "vector",
            vectorX: 1,
            vectorY: 0,
            vectorZ: 0,
            behavior: "allOrNothing"
          }
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions.length, 1);
  assert.equal(response.actions[0]?.path, "/revit/move-elements");
  assert.deepEqual((response.actions[0]?.body as any)?.ids, [6201]);
  assert.equal((response.actions[0]?.body as any)?.vectorX, 1);
  assert.equal((response.actions[0]?.body as any)?.vectorY, 0);
  assert.equal((response.actions[0]?.body as any)?.apply, true);
  assert.match(response.assistant_message, /Dry-run move verified/i);
});

test("redline execution bridge blocks move apply when dry-run omits target ids or vector", () => {
  const omittedTarget = __testOnlyBuildRedlineExecutionBridge({
    userText: "move the selected redline target 1 foot right",
    toolResults: [
      {
        action_id: "move-preview",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6201],
          movedIds: [],
          request: { ids: [6201], mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0 }
        }
      }
    ]
  });
  assert.ok(omittedTarget);
  assert.equal(omittedTarget.actions.length, 0);
  assert.match(omittedTarget.assistant_message, /stopped before applying/i);
  assert.match(omittedTarget.assistant_message, /6201/);

  const missingVector = __testOnlyBuildRedlineExecutionBridge({
    userText: "move the selected redline target 1 foot right",
    toolResults: [
      {
        action_id: "move-preview",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6201],
          movedIds: [6201]
        }
      }
    ]
  });
  assert.ok(missingVector);
  assert.equal(missingVector.actions.length, 0);
  assert.match(missingVector.assistant_message, /replayable model-space vector/i);
});

test("redline execution bridge finalizes move only with prior dry-run evidence", () => {
  const appliedWithoutPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "move the selected redline target 1 foot right",
    toolResults: [
      {
        action_id: "move-apply",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Moved",
          requestedIds: [6201],
          movedIds: [6201]
        }
      }
    ]
  });
  assert.ok(appliedWithoutPreview);
  assert.equal(appliedWithoutPreview.actions.length, 0);
  assert.match(appliedWithoutPreview.assistant_message, /cannot prove a prior dry-run/i);

  const appliedWithPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "move the selected redline target 1 foot right",
    toolResults: [
      {
        action_id: "move-preview",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6201],
          movedIds: [6201],
          request: { ids: [6201], mode: "vector", vectorX: 1, vectorY: 0, vectorZ: 0 }
        }
      },
      {
        action_id: "move-apply",
        method: "POST",
        path: "/revit/move-elements",
        status: "done",
        result_json: {
          status: "Moved",
          requestedIds: [6201],
          movedIds: [6201]
        }
      }
    ]
  });

  assert.ok(appliedWithPreview);
  assert.equal(appliedWithPreview.actions.length, 0);
  assert.match(appliedWithPreview.assistant_message, /Moved the redline-targeted element id/i);
});

test("redline execution bridge applies a dry-run-proven rotate set", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "rotate the selected redline target 90 degrees",
    toolResults: [
      {
        action_id: "rotate-preview",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6301],
          rotatedIds: [6301],
          request: {
            ids: [6301],
            angleDegrees: 90,
            axis: { mode: "zThroughPoint", pointX: 1, pointY: 2, pointZ: 0 },
            behavior: "allOrNothing"
          }
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions.length, 1);
  assert.equal(response.actions[0]?.path, "/revit/rotate-elements");
  assert.deepEqual((response.actions[0]?.body as any)?.ids, [6301]);
  assert.equal((response.actions[0]?.body as any)?.angleDegrees, 90);
  assert.equal((response.actions[0]?.body as any)?.axis?.mode, "zThroughPoint");
  assert.equal((response.actions[0]?.body as any)?.axis?.pointX, 1);
  assert.equal((response.actions[0]?.body as any)?.axis?.pointY, 2);
  assert.equal((response.actions[0]?.body as any)?.dryRun, false);
  assert.match(response.assistant_message, /Dry-run rotate verified/i);
});

test("redline execution bridge blocks rotate apply when dry-run omits target ids or axis", () => {
  const omittedTarget = __testOnlyBuildRedlineExecutionBridge({
    userText: "rotate the selected redline target 90 degrees",
    toolResults: [
      {
        action_id: "rotate-preview",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6301],
          rotatedIds: [],
          request: {
            ids: [6301],
            angleDegrees: 90,
            axis: { mode: "zThroughPoint", pointX: 1, pointY: 2, pointZ: 0 }
          }
        }
      }
    ]
  });
  assert.ok(omittedTarget);
  assert.equal(omittedTarget.actions.length, 0);
  assert.match(omittedTarget.assistant_message, /stopped before applying/i);
  assert.match(omittedTarget.assistant_message, /6301/);

  const missingAxis = __testOnlyBuildRedlineExecutionBridge({
    userText: "rotate the selected redline target 90 degrees",
    toolResults: [
      {
        action_id: "rotate-preview",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6301],
          rotatedIds: [6301],
          request: { ids: [6301], angleDegrees: 90 }
        }
      }
    ]
  });
  assert.ok(missingAxis);
  assert.equal(missingAxis.actions.length, 0);
  assert.match(missingAxis.assistant_message, /rotation axis and angle/i);
});

test("redline execution bridge finalizes rotate only with prior dry-run evidence", () => {
  const appliedWithoutPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "rotate the selected redline target 90 degrees",
    toolResults: [
      {
        action_id: "rotate-apply",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Rotated",
          requestedIds: [6301],
          rotatedIds: [6301]
        }
      }
    ]
  });
  assert.ok(appliedWithoutPreview);
  assert.equal(appliedWithoutPreview.actions.length, 0);
  assert.match(appliedWithoutPreview.assistant_message, /cannot prove a prior dry-run/i);

  const appliedWithPreview = __testOnlyBuildRedlineExecutionBridge({
    userText: "rotate the selected redline target 90 degrees",
    toolResults: [
      {
        action_id: "rotate-preview",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Dry Run",
          requestedIds: [6301],
          rotatedIds: [6301],
          request: {
            ids: [6301],
            angleDegrees: 90,
            axis: { mode: "zThroughPoint", pointX: 1, pointY: 2, pointZ: 0 }
          }
        }
      },
      {
        action_id: "rotate-apply",
        method: "POST",
        path: "/revit/rotate-elements",
        status: "done",
        result_json: {
          status: "Rotated",
          requestedIds: [6301],
          rotatedIds: [6301]
        }
      }
    ]
  });

  assert.ok(appliedWithPreview);
  assert.equal(appliedWithPreview.actions.length, 0);
  assert.match(appliedWithPreview.assistant_message, /Rotated the redline-targeted element id/i);
});

test("redline targeting captures spatial cues for mutation targeting", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "change the receptacles on the north corridor to gfci"
  });

  assert.equal(profile.scope_label, "spatial electrical-device");
  assert.deepEqual(profile.spatial_terms, ["directional", "zone"]);
  assert.equal(profile.region_padding_ft >= 0.08, true);
  assert.equal(profile.spatial_side, "top");
  assert.equal(profile.spatial_side_source, "north");
});

test("redline targeting captures room and cardinal wall anchors", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  assert.equal(profile.room_number, "403");
  assert.equal(profile.spatial_side, "bottom");
  assert.equal(profile.spatial_side_source, "south");
  assert.equal(profile.scope_label, "spatial electrical-device");
});

test("redline targeting uses explicit panel circuit as a room hint when OCR is missing", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated, circuit to p405/1"
  });

  assert.equal(profile.room_number, "405");
});

test("redline targeting correction text prefers intended redline room over wrong placed room", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "why did you place it in unit 408? the redline was in unit 405."
  });

  assert.equal(profile.room_number, "405");
});

test("redline targeting treats unit-style attachment names as room hints without suffix bleed", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to P403/1\nartifacts/uploads/20260523_unit403_single_receptacle_redline.png"
  });

  assert.equal(profile.room_number, "403");
});

test("redline targeting treats separated OCR unit labels as room hints", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle\nLive/Work Loft\nUnit\n405"
  });

  assert.equal(profile.room_number, "405");
});

test("fast electrical redline path is not disabled by unit filenames or panel circuit text", () => {
  assert.equal(
    __testOnlyIsFastElectricalPlacementRedline({
      userText: "add receptacle where indicated and circuit to P403/1",
      userAttachments: [
        {
          id: "unit403-redline-test",
          relative_path: "artifacts/uploads/20260523_unit403_single_receptacle_redline.png",
          filename: "20260523_unit403_single_receptacle_redline.png",
          mime: "image/png"
        }
      ]
    }),
    true
  );
});

test("fast electrical redline path accepts native pane image bundles", () => {
  const attachments = [
    {
      id: "clipboard-redline",
      relative_path: "artifacts/uploads/clipboard_20260524_001025_518.png",
      filename: "clipboard_20260524_001025_518.png",
      mime: "image/png"
    },
    {
      id: "active-view-context",
      relative_path: "artifacts/uploads/active_view_context.png",
      filename: "active_view_context.png",
      mime: "image/png"
    }
  ] as any;

  assert.equal(
    __testOnlyIsFastElectricalPlacementRedline({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      userAttachments: attachments
    }),
    true
  );

  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: attachments
  });
  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.file_path, "artifacts/uploads/clipboard_20260524_001025_518.png");
  assert.equal(action?.include_ocr_for_images, true);
});

test("fast electrical redline path uses remembered native upload anchors", () => {
  assert.equal(
    __testOnlyIsFastElectricalPlacementRedline({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      rememberedRedlinePath: "artifacts/uploads/clipboard_20260524_001025_518.png"
    }),
    true
  );
});

test("initial redline preflight re-analyzes remembered native upload anchors", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    rememberedRedlinePath: "artifacts/uploads/clipboard_20260524_001025_518.png"
  });

  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.file_path, "artifacts/uploads/clipboard_20260524_001025_518.png");
  assert.equal(action?.include_ocr_for_images, true);
});

test("initial redline preflight schedules analyze_redline before the first model pass", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText: "please process this redline markup",
    userAttachments: [
      {
        id: "att-1",
        filename: "E2.1_room-403_markup.png",
        relative_path: "artifacts/uploads/E2.1_room-403_markup.png"
      }
    ] as any
  });

  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.file_path, "artifacts/uploads/E2.1_room-403_markup.png");
  assert.equal(action?.expected_sheet, "E2.1");
});

test("fast electrical image-only redlines still run image preflight so room/sheet text is available", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText: "please add two receptacles from this redline in the current view",
    userAttachments: [
      {
        id: "att-1",
        filename: "room-403-markup.png",
        relative_path: "artifacts/uploads/room-403-markup.png"
      }
    ] as any
  });

  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.include_ocr_for_images, true);
});

test("fast electrical image-only redlines with 'where indicated' prompts still get OCR preflight", () => {
  const action = __testOnlyBuildInitialRedlinePreflightAction({
    userText: "add receptacles where indicated.",
    userAttachments: [
      {
        id: "att-1",
        filename: "clipboard.png",
        relative_path: "artifacts/uploads/clipboard.png"
      }
    ] as any
  });

  assert.ok(action);
  assert.equal(action?.type, "analyze_redline");
  assert.equal(action?.include_ocr_for_images, true);
});

test("fast electrical view mismatch defers to normal redline recovery instead of blocking", () => {
  const fallback = __testOnlyBuildFastPreflightViewMismatchFallback({
    diagnosticsText: "candidate_views=L4 - Power#1363337:miss:0.28",
    checkedViews: [
      { view_id: 1363337, view_name: "L4 - Power", matched: false, confidence: 0.28, analysis: "red mark not confidently aligned" }
    ],
    toolResults: [
      {
        action_id: "frame-miss",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-miss", viewId: 1363337 }
      }
    ] as any
  });

  assert.equal(fallback.blocked_reason, null);
  assert.equal(fallback.direct_response, null);
  assert.match(fallback.preflight_package_text, /continue with native redline analyze\/orient/i);
  assert.equal(fallback.tool_results[0]?.path, "/revit/export-view-frame");
});

test("spatial redline placement on a sheet targets the placed model view instead of sheet-owned elements", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated, circuit to P403/1.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "DrawingSheet"
          }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 3.5, maxV: 2.5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337 }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
});

test("redline execution bridge resolves a room plan view from upload OCR before stalling", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "please do the markup",
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/redline.png",
          ocr: { text_excerpt: "POWER PLAN ROOM 403 ADD RECEPTACLE" }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "403");
  assert.equal((response.actions[0]?.body as any)?.preferViewNameContains, "power");
});

test("redline execution bridge resolves a room plan view for spatial additions before asking for confirmation", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add a receptacle on the south wall of room 403 from this redline"
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "403");
});

test("redline execution bridge leaves duct route redlines to MEP workflow instead of hosted placement", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "pick up attached redline: 12x10 supply duct in room 405",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363433,
            name: "L4 - HVAC",
            type: "FloorPlan"
          }
        }
      }
    }
  });

  assert.equal(response, null);
});

test("MEP redline guard blocks selected duct resize when PDF annotation is a new 12x10 duct", () => {
  const response = __testOnlyBuildMepRedlineActionGuardResponse({
    req: {
      user_text:
        "On sheet/view M104 Plan HVAC L4, pick up the attached redline note. The current active selection is a duct; update it to 11\" x 10\".",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "bad-resize",
        method: "POST",
        path: "/revit/resize-ductwork-by-scope",
        body: {
          elementIds: [1465136],
          sizeTo: "11x10",
          apply: true
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/tool-search");
  assert.match(response.assistant_message, /12x10 supply duct/i);
  assert.match(response.assistant_message, /modify an existing duct/i);
  assert.doesNotMatch(JSON.stringify(response.actions), /resize-ductwork-by-scope/i);
});

test("MEP redline guard allows a matching 12x10 duct route workflow", () => {
  const response = __testOnlyBuildMepRedlineActionGuardResponse({
    req: {
      user_text: "pick up attached redline",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "route",
        method: "POST",
        path: "/revit/mep-route-workflow",
        body: {
          discipline: "duct",
          ductSize: "12x10",
          apply: false,
          points: [
            { x: 0, y: 0, z: 0 },
            { x: 4, y: 0, z: 0 }
          ]
        }
      }
    ]
  });

  assert.equal(response, null);
});

test("MEP redline recovery queries duct spatial scope before generic hosted-device recovery", () => {
  const response = __testOnlyBuildMepRedlineDuctScopeRecoveryResponse({
    req: {
      user_text:
        "Continue redline pickup for marked.pdf. The visible redline says \"12x10 supply duct\" near Live/Work Loft Unit 405. Do not use /revit/pick-at-pixel.",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    redlineTargetProfile: { room_number: "405" },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "resolve-room",
        method: "POST",
        path: "/revit/resolve-room-plan-view",
        status: "done",
        result_json: { roomNumber: "405", bestViewId: 1363433, bestViewName: "L4" }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/ducts-by-spatial-scope");
  const body = response.actions[0]?.body as any;
  assert.equal(body.roomNumber, "405");
  assert.equal(body.systemClassification, "Supply");
  assert.equal(body.verticalScope, "room+plenum");
  assert.deepEqual(body.includeCategories, ["Ducts", "Duct Fittings", "Air Terminals"]);
});

test("MEP redline route recovery resolves routing context when room 405 has no matching supply duct", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        "Pick up the redline from M104. The red markup reads \"12x10 supply\" near Live/Work Loft Unit 405. If no exact duct target is found, do not use pick-at-pixel.",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "Redline orientation completed; primary_sheet=M104, mapped_regions=1.",
        details: {
          analysis: {
            mark_regions: [
              {
                index: 1,
                source: "pdf_annotation",
                annotation_subtype: "PolyLine",
                annotation_contents: "12x10 supply duct"
              }
            ]
          },
          mapping: {
            regions: [
              {
                index: 1,
                primary_target: {
                  kind: "viewport",
                  view_id: 1363433,
                  score: 1,
                  view_hint: { normalized_x: 0.549, normalized_y: 0.68, rotation: "none" }
                }
              }
            ]
          }
        }
      }
    ] as any,
    actions: [],
    toolResults: [
      {
        action_id: "duct_scope_405",
        method: "POST",
        path: "/revit/ducts-by-spatial-scope",
        status: "done",
        result_json: {
          query: "405",
          systemClassification: "Supply",
          elementIds: [],
          elements: [],
          counts: { matchedCount: 0 }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-mep-routing-context");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.systemKind, "duct");
  assert.equal(body.systemClassification, "Supply");
  assert.match(response.assistant_message, /No matching editable supply duct/i);
});

test("MEP redline route recovery redirects duct resize tool search to routing context", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text: "Continue the redline pickup for Unit 405. Apply the 12x10 supply duct markup.",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ],
      context: {
        revit: {
          document: {
            activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
          }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "wrong-search",
        method: "POST",
        path: "/revit/tool-search",
        body: { query: "duct modify size set parameter supply duct dimensions change duct size resize ductwork" }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-mep-routing-context");
  assert.equal((response.actions[0]?.body as any).roomNumber, "405");
  assert.doesNotMatch(JSON.stringify(response.actions), /resize ductwork/i);
});

test("MEP redline route recovery uses sheet detail view id before generic frame export", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        'The user asked to "pick up redline" and provided one reference attachment showing sheet M104 / Plan HVAC L4.',
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (pdf); primary_sheet=M104.",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "generic-frame-export",
        method: "POST",
        path: "/revit/export-view-frame",
        body: { viewId: 1363433, imageSize: 2200, includeMapping: true }
      }
    ],
    toolResults: [
      {
        action_id: "sheet-detail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          action: "detail",
          sheetNumber: "M104",
          placedViews: [{ viewId: 1363433, name: "L4", viewType: "FloorPlan" }],
          viewportGeometry: [{ viewportId: 1411539, viewId: 1363433 }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-mep-routing-context");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.systemKind, "duct");
  assert.equal(body.systemClassification, "Supply");
  assert.doesNotMatch(JSON.stringify(response.actions), /export-view-frame/i);
});

test("MEP redline route recovery creates workflow after route tool discovery and explicit unconnected apply", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        'Implement the explicit redline on marked.pdf: add a 12" x 10" rectangular SUPPLY AIR duct on L4/M104 following the red route in/above Live/Work Loft Unit 405. If exact existing-duct connectors cannot be resolved, place the duct segments unconnected.',
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (pdf); primary_sheet=M104.",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "repeat-search",
        method: "POST",
        path: "/revit/tool-search",
        body: { query: "create 12x10 supply duct route workflow frame-linked points room 405" }
      }
    ],
    toolResults: [
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: { frameId: "frame-1", viewId: 1363433, widthPx: 2200, heightPx: 1223 }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 },
          recommendedElevation: { zFt: 38.8333, mode: "between_levels_midpoint", confidence: "low" }
        }
      },
      {
        action_id: "search",
        method: "POST",
        path: "/revit/tool-search",
        status: "done",
        result_json: {
          matches: [
            { method: "POST", path: "/revit/create-mep-route", title: "Create MEP Route" },
            { method: "POST", path: "/revit/mep-route-workflow", title: "MEP Route Workflow" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/mep-route-workflow");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.levelName, "L4");
  assert.equal(body.systemType, "Supply Air");
  assert.equal(body.ductSize, "12x10");
  assert.equal(body.apply, true);
  assert.equal(body.visualVerify, true);
  assert.equal(body.points.length, 3);
  assert.equal(body.points[0].z, undefined);
  assert.equal(body.points[1].z, undefined);
  assert.equal(body.points[2].z, undefined);
  assert.doesNotMatch(JSON.stringify(response.actions), /tool-search/i);
});

test("MEP redline route recovery creates workflow directly once context and pick anchor exist", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        "Pick up the attached redline on M104. Add the 12x10 supply duct at Live/Work Loft Unit 405.",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (pdf); primary_sheet=M104.",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        body: { viewId: 1363433, imageSize: 2200, includeMapping: true }
      }
    ],
    toolResults: [
      {
        action_id: "sheet-detail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          action: "detail",
          sheetNumber: "M104",
          placedViews: [{ viewId: 1363433, name: "L4", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "pick",
        method: "POST",
        path: "/revit/pick-at-pixel",
        status: "done",
        result_json: { pickPointXyz: [-2.718, -9.101, -467.883], best: null, hits: [] }
      },
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: {
          status: "Ok",
          view: { id: 1363433, name: "L4", type: "FloorPlan" },
          level: { id: 1362791, name: "L4", elevation: 32.1667 }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/mep-route-workflow");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363433);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.ductSize, "12x10");
  assert.equal(body.apply, true);
  assert.doesNotMatch(JSON.stringify(response.actions), /tool-search/i);
});

test("MEP redline route recovery stops repeated tool-search when endpoints are still missing", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        "Continue the attached M104 redline pickup for Live/Work Loft Unit 405. Add the 12x10 supply duct.",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (pdf); primary_sheet=M104.",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [
      {
        action_id: "repeat-search",
        method: "POST",
        path: "/revit/tool-search",
        body: { query: "create 12x10 supply duct route workflow frame-linked points room 405" }
      }
    ],
    toolResults: [
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: { status: "Ok", view: { id: 1363433 }, level: { name: "L4" } }
      },
      {
        action_id: "search",
        method: "POST",
        path: "/revit/tool-search",
        status: "done",
        result_json: {
          matches: [{ method: "POST", path: "/revit/mep-route-workflow", title: "MEP Route Workflow" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /stopping instead of repeating tool-search/i);
});

test("MEP redline route recovery does not override status-only no-discovery turns", () => {
  const response = __testOnlyBuildMepRedlineRouteRecoveryResponse({
    req: {
      user_text:
        "Do not make additional discovery calls. Based on the previous session, provide a concise status: did you find explicit redline instructions and were any Revit changes applied?",
      user_attachments: [
        {
          id: "marked",
          filename: "marked.pdf",
          relative_path: "artifacts/uploads/marked.pdf",
          mime: "application/pdf"
        }
      ]
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed",
        details: {
          mark_regions: [
            {
              index: 1,
              source: "pdf_annotation",
              annotation_subtype: "PolyLine",
              annotation_contents: "12x10 supply duct"
            }
          ]
        }
      }
    ] as any,
    actions: [],
    toolResults: [
      {
        action_id: "context",
        method: "POST",
        path: "/revit/resolve-mep-routing-context",
        status: "done",
        result_json: { status: "Ok", view: { id: 1363433 }, level: { name: "L4" } }
      }
    ] as any
  });

  assert.equal(response, null);
});

test("redline execution bridge exports a resolved non-active plan view when no sheet or viewport anchor exists", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "please do the markup",
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/redline.png",
          ocr: { text_excerpt: "POWER PLAN ROOM 403 ADD RECEPTACLE" }
        }
      }
    ] as any,
    toolResults: [
      {
        path: "/revit/resolve-room-plan-view",
        status: "done",
        result_json: {
          roomNumber: "403",
          bestViewId: 1363337,
          bestViewName: "Level 4 Power Plan",
          bestViewType: "EngineeringPlan"
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
});

test("redline execution bridge prefers power plan over generic active floor plan for electrical redlines", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark to visible unit area",
        details: {
          mapping: {
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    view_hint: { normalized_x: 0.45, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "views",
        method: "GET",
        path: "/revit/views",
        status: "done",
        result_json: [
          { id: 1363433, name: "L4", type: "FloorPlan" },
          { id: 1391195, name: "E104 - POWER PLAN L4", type: "EngineeringPlan" },
          { id: 1400000, name: "L4 - RCP", type: "CeilingPlan" }
        ]
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-view-frame");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1391195);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge lists views before exporting a generic active floor plan for electrical redlines", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    }
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/views");
  assert.doesNotMatch(JSON.stringify(response.actions), /export-view-frame/i);
});

test("redline execution bridge resolves preferred power view when OCR room is known but active model view is generic", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/clipboard_20260524_011111_123.png",
          ocr: { text_excerpt: "Live/Work Loft Unit 405" }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.preferViewNameContains, "power");
  assert.doesNotMatch(JSON.stringify(response.actions), /export-view-frame/i);
});

test("redline execution bridge switches to preferred power view after room is inferred from a generic exported frame", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/clipboard_20260524_001025_518.png",
          ocr: { text_excerpt: "Live/Work Loft Unit 405" }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frame_id: "frame-generic-405",
          view_id: 1363433,
          width_px: 1000,
          height_px: 800,
          mapping: {
            top_left_xyz: [0, 10, 0],
            top_right_xyz: [10, 10, 0],
            bottom_left_xyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frame_id: "inventory-generic-405",
          view_id: 1363433,
          visible_elements: [
            {
              element_id: 1411041,
              category: "Spaces",
              built_in_category: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit", kind: "Space" }
            },
            {
              element_id: 1003,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Duplex Receptacle",
              type_name: "Duplex",
              room_number: "405",
              electrical_circuit: { primary_label: "P405/1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.preferViewNameContains, "power");
  assert.match(response.assistant_message, /exported frame\/inventory/i);
  assert.doesNotMatch(JSON.stringify(response.actions), /export-visible-elements/i);
});

test("redline execution bridge switches to preferred power view after placement discovery on a generic view", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "room-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          hostIdsBySide: { left: [2002] }
        }
      },
      {
        action_id: "rank-405",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
        }
      },
      {
        action_id: "placement-context-405",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1411041, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2002, projectedPoint: [4.7, 1.4, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2002, chainageFt: 0.2, normalizedChainage: 0.071429, curveLengthFt: 2.8 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          electricalCircuit: { primaryLabel: "P405/1" },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.preferViewNameContains, "power");
  assert.doesNotMatch(JSON.stringify(response.actions), /create-similar-from-instance/i);
});

test("redline execution bridge falls back to visible inventory when frame exists but no pick hints were recovered", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add two receptacles from this redline in the current view",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "Level 4 Power Plan",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-1",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-visible-elements");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
  assert.ok(((response.actions[0]?.body as any)?.categories ?? []).includes("OST_TextNotes"));
  assert.ok(((response.actions[0]?.body as any)?.categories ?? []).includes("OST_RoomTags"));
  assert.ok(((response.actions[0]?.body as any)?.categories ?? []).includes("OST_ElectricalFixtures"));
});

test("redline execution bridge returns a concrete no-pick diagnosis after inventory fallback is exhausted", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add two receptacles from this redline in the current view",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "Level 4 Power Plan",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-1",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-1",
          viewId: 1363337,
          count: 2,
          items: [
            { elementId: 10, category: "Electrical Devices", builtInCategory: "OST_ElectricalDevices" }
          ]
        }
      },
      {
        action_id: "inventory-2",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-2",
          viewId: 1363337,
          count: 2,
          items: [
            { elementId: 10, category: "Electrical Devices", builtInCategory: "OST_ElectricalDevices" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /did not recover usable pick locations/i);
});

test("redline execution bridge requests richer spatial inventory before no-pick blocking", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1391195,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-electrical-only",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-electrical-only",
          viewId: 1391195,
          count: 2,
          items: [
            { elementId: 1556501, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-visible-elements");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1391195);
  assert.ok((body.categories ?? []).includes("OST_GenericAnnotation"));
  assert.ok((body.categories ?? []).includes("OST_RoomTags"));
  assert.ok((body.categories ?? []).includes("OST_MEPSpaces"));
  assert.doesNotMatch(response.assistant_message, /did not recover usable pick locations/i);
});

test("redline execution bridge requests generic annotation inventory from active sheet placed view before no-pick blocking", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "DrawingSheet"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }],
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }]
        }
      },
      {
        action_id: "frame-placed-view",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-placed-view",
          viewId: 1363337,
          widthPx: 1200,
          heightPx: 900,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-placed-view-electrical-only",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-placed-view-electrical-only",
          viewId: 1363337,
          count: 1,
          items: [
            { elementId: 1556501, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-visible-elements");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363337);
  assert.ok((body.categories ?? []).includes("OST_GenericAnnotation"));
  assert.ok((body.categories ?? []).includes("OST_TextNotes"));
  assert.equal(body.includeText, true);
  assert.equal(body.includeRoomTags, true);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("redline execution bridge does not treat unlabeled room categories as usable spatial context", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1391195,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-unlabeled-spaces",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-unlabeled-spaces",
          viewId: 1391195,
          count: 3,
          items: [
            {
              elementId: 4001,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Space"
            },
            {
              elementId: 1556501,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle"
            }
          ],
          summary: {
            spaceCounts: [{ key: "", count: 3 }]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-visible-elements");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1391195);
  assert.ok((body.categories ?? []).includes("OST_RoomTags"));
  assert.ok((body.categories ?? []).includes("OST_MEPSpaces"));
  assert.doesNotMatch(response.assistant_message, /did not recover usable pick locations/i);
});

test("redline execution bridge infers adjacent-room context from rich visible inventory", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1391195,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-rich",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-rich",
          viewId: 1391195,
          count: 7,
          itemsSampled: [
            {
              elementId: 4005,
              category: "MEP Spaces",
              builtInCategory: "OST_MEPSpaces",
              space: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.43, normalizedY: 0.52 } },
              bbox: { image: { minX: 0.08, minY: 0.14, maxX: 0.86, maxY: 0.91 } }
            },
            {
              elementId: 5005,
              category: "Space Tags",
              builtInCategory: "OST_MEPSpaceTags",
              visibleText: "Live/Work Loft Unit 405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.55 } }
            },
            {
              elementId: 1556501,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              space: { number: "405", name: "Live/Work Loft Unit" },
              parameters: { Panel: "P405", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.51 } }
            }
          ],
          summary: {
            roomCounts: [],
            spaceCounts: [{ key: "405", count: 3 }]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /did not recover usable pick locations/i);
});

test("redline execution bridge infers adjacent-room context from a sheet placed-view inventory", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1391195,
            name: "E104 - POWER PLAN L4",
            type: "DrawingSheet"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [
            {
              viewportId: 1483922,
              viewId: 1363337,
              rotation: "None",
              box: { minU: 0, minV: 0, maxU: 10, maxV: 5 }
            }
          ],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "frame-placed-view",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-placed-view",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-placed-view",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-placed-view",
          viewId: 1363337,
          count: 5,
          items: [
            {
              elementId: 4005,
              category: "MEP Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              space: { number: "405", name: "Live/Work Loft Unit" },
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.43, normalizedY: 0.52, insideFrame: true } },
              bbox: { image: { minX: 0.08, minY: 0.14, maxX: 0.86, maxY: 0.91 } }
            },
            {
              elementId: 5005,
              category: "Space Tags",
              builtInCategory: "OST_MEPSpaceTags",
              visibleText: "Live/Work Loft Unit 405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              parameters: { Panel: "L4PA", "Circuit Number": "7" },
              anchor: { image: { normalizedX: 0.07, normalizedY: 0.52, insideFrame: true } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "L4PB", "Circuit Number": "9" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.52, insideFrame: true } }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("redline execution bridge infers room from matching visible panel circuit before no-pick blocker", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-1",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-1",
          viewId: 1363337,
          count: 2,
          items: [
            {
              elementId: 1556486,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              space: { number: "403", name: "Live/Work Unit 403" },
              parameters: { panel: "P403", circuitNumber: "1" }
            },
            {
              elementId: 1521375,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              space: { number: "408", name: "Live/Work Unit 408" },
              parameters: { panel: "P408", circuitNumber: "7" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "403");
  assert.doesNotMatch(response.assistant_message, /did not recover usable pick locations/i);
});

test("redline execution bridge recovers room-wall targeting from tool results when the follow-up prompt is spatially ambiguous", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacles where indicated",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        action_id: "wall-1",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          requestedSide: "bottom",
          room: { number: "403", requestedSide: "bottom" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: {
                id: 1362762,
                category: "RVT Links",
                builtInCategory: "OST_RvtLinks"
              },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementCategory: "Walls",
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        action_id: "room-1",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608],
          elements: [
            {
              id: 1556608,
              hostId: 1362762,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              point: [5, 5, 0]
            }
          ]
        }
      },
      {
        action_id: "frame-1",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          viewId: 1363337,
          count: 1,
          items: [
            {
              elementId: 1556608,
              hostElementId: 1362762,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              center: [5, 5, 0]
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.equal(response.actions.some((action) => action.path === "/revit/place-family-instance-on-host"), false);
  assert.match(response.assistant_message, /no measured redline-to-view target/i);
});

test("spatial placement preview plan derives create-similar offsets from mapped redline hints", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    spatialViewId: 31309289,
    viewportHints: [
      { view_id: 31309289, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 31309289, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    frame: {
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [0, 10, 0],
      top_right_xyz: [10, 10, 0],
      bottom_left_xyz: [0, 0, 0]
    },
    placementContext: {
      element_id: 12345,
      host_element_id: 67890,
      create_similar_body: {
        exemplarElementId: 12345,
        hostElementId: 67890,
        orientationSourceElementId: 1556608,
        matchOrientationFromSource: true,
        dryRun: true,
        includePreviewImage: true
      },
      place_on_host_body: {
        sourceElementId: 12345,
        hostElementId: 67890,
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [5, 5, 2],
      wall_projected_point: [5, 5, 0],
      wall_tangent: [1, 0, 0]
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  assert.equal(plan.requested_count, 2);
  assert.equal(plan.heuristic, false);
  assert.deepEqual(plan.body.placements, [
    { alongHostOffsetFt: -2, label: "mark 1" },
    { alongHostOffsetFt: 2, label: "mark 2" }
  ]);
  assert.equal(plan.body.previewViewId, 31309289);
});

test("spatial placement preview plan treats copy twice as a two-device create-similar addition", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "pick the existing bottom-wall Unit 403 receptacle whose tag text is P403/1 as source and copy it twice with same host and parameters",
    spatialViewId: 1363337,
    viewportHints: [],
    frame: {
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [0, 10, 0],
      top_right_xyz: [10, 10, 0],
      bottom_left_xyz: [0, 0, 0]
    },
    placementContext: {
      element_id: 1002,
      host_element_id: 2002,
      supported_host: true,
      source_host_supported: true,
      host_support_reason: "same_room_wall",
      place_on_host_body: null,
      create_similar_body: {
        exemplarElementId: 1002,
        hostElementId: 2002,
        roomNumber: "403",
        roomSide: "bottom",
        dryRun: true
      },
      center: [5, 0.5, 0],
      insertion_point: [5, 0.5, 0],
      wall_projected_point: [5, 0, 0],
      wall_tangent: [1, 0, 0],
      placement_host_category: "Walls",
      placement_host_built_in_category: "OST_Walls",
      room_number: "403",
      requested_room_side: "bottom",
      requested_room_wall_host_ids: [2002],
      orientation_rotation_radians: 0,
      host_local_frame_basis: "WallCurve",
      host_chainage_ft: 5,
      host_normalized_chainage: 0.5,
      host_curve_length_ft: 10,
      host_orientation_relative_radians: 0
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  assert.equal(plan.requested_count, 2);
  const placements = (plan.body as any).placements;
  assert.equal(Array.isArray(placements), true);
  assert.equal(placements.length, 2);
  assert.equal((plan.body as any).matchElectricalCircuitFromSource, true);
  assert.equal((plan.body as any).requireElectricalCircuitMatch, true);
});

test("spatial placement preview plan derives single host-aware placement offset from mapped hint", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add a receptacle near the existing one on room 403 south wall",
    spatialViewId: 31309289,
    viewportHints: [{ view_id: 31309289, normalized_x: 0.7, normalized_y: 0.5, score: 0.95 }],
    frame: {
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [0, 10, 0],
      top_right_xyz: [10, 10, 0],
      bottom_left_xyz: [0, 0, 0]
    },
    placementContext: {
      element_id: 12345,
      host_element_id: 67890,
      place_on_host_body: {
        sourceElementId: 12345,
        hostElementId: 67890,
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [5, 5, 2],
      wall_projected_point: [5, 5, 0],
      wall_tangent: [1, 0, 0]
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/place-family-instance-on-host");
  assert.equal(plan.requested_count, 1);
  assert.equal(plan.heuristic, false);
  assert.equal(plan.body.alongHostOffsetFt, 2);
  assert.equal(plan.body.previewViewId, 31309289);
});

test("spatial placement preview plan prefers host-local chainage when the host frame exposes chainage data", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    spatialViewId: 31309289,
    viewportHints: [
      { view_id: 31309289, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 31309289, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    frame: {
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [0, 10, 0],
      top_right_xyz: [10, 10, 0],
      bottom_left_xyz: [0, 0, 0]
    },
    placementContext: {
      element_id: 12345,
      host_element_id: 67890,
      create_similar_body: {
        exemplarElementId: 12345,
        hostElementId: 67890,
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [5, 5, 2],
      wall_projected_point: [5, 5, 0],
      wall_tangent: [1, 0, 0],
      host_chainage_ft: 5,
      host_curve_length_ft: 10,
      host_normalized_chainage: 0.5,
      supported_host: true
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  assert.deepEqual(plan.body.placements, [
    { targetChainageFt: 3, targetNormalizedChainage: 0.3, label: "mark 1" },
    { targetChainageFt: 7, targetNormalizedChainage: 0.7, label: "mark 2" }
  ]);
});

test("spatial placement preview plan emits explicit world points for link-hosted exemplars", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    spatialViewId: 31309289,
    viewportHints: [
      { view_id: 31309289, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 31309289, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    frame: {
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [0, 10, 0],
      top_right_xyz: [10, 10, 0],
      bottom_left_xyz: [0, 0, 0]
    },
    placementContext: {
      element_id: 12345,
      host_element_id: 67890,
      create_similar_body: {
        exemplarElementId: 12345,
        hostElementId: 67890,
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [5, 5, 2],
      wall_projected_point: [5, 5, 0],
      wall_tangent: [1, 0, 0],
      placement_host_built_in_category: "OST_RvtLinks",
      supported_host: true
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  assert.deepEqual(plan.body.placements, [
    { pointXyz: [3, 5, 2], label: "mark 1" },
    { pointXyz: [7, 5, 2], label: "mark 2" }
  ]);
  assert.equal("orientationSourceElementId" in plan.body, false);
  assert.equal(plan.body.matchOrientationFromSource, false);
});

test("spatial placement preview plan uses frame-aligned target instead of raw room-snippet chainage", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add receptacle where indicated and circuit to P405/1",
    spatialViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.427, normalized_y: 0.668, score: 0.9, source: "view_alignment", frame_aligned: true }
    ],
    frame: {
      width_px: 2200,
      height_px: 1031,
      top_left_xyz: [-137.62, 72.13, 0],
      top_right_xyz: [116.54, 72.13, 0],
      bottom_left_xyz: [-137.62, -46.91, 0]
    },
    placementContext: {
      element_id: 1554033,
      host_element_id: 1362762,
      create_similar_body: {
        exemplarElementId: 1554033,
        hostElementId: 1362762,
        roomNumber: "405",
        roomSide: "left",
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [-19.7604166667, -6.921875, 32.166667],
      wall_projected_point: [-19.7604166667, -6.921875, 32.166667],
      wall_tangent: [0, -1, 0],
      placement_host_built_in_category: "OST_RvtLinks",
      room_number: "405",
      requested_room_side: "left",
      host_chainage_ft: 8.421875,
      host_normalized_chainage: 0.317308,
      host_curve_length_ft: 26.5416666667,
      supported_host: true
    },
    imageMarkHint: {
      normalized_x: 0.427,
      normalized_y: 0.668,
      raw_normalized_x: 0.29,
      raw_normalized_y: 0.5,
      side: "left",
      score: 0.9,
      source: "view_alignment",
      raw_image_width: 1184,
      raw_image_height: 715
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  assert.deepEqual((plan.body as any).placements, [
    { targetChainageFt: 5.421875, targetNormalizedChainage: 0.204278, label: "mark 1" }
  ]);
  assert.equal("orientationSourceElementId" in plan.body, false);
  assert.equal(plan.body.matchOrientationFromSource, false);
});

test("spatial placement preview plan does not let wall-local fallback override frame alignment", () => {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add receptacle where indicated and circuit to P405/1",
    spatialViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.464, normalized_y: 0.609, score: 0.9, source: "view_alignment", frame_aligned: true }
    ],
    frame: {
      width_px: 2200,
      height_px: 1031,
      top_left_xyz: [-137.62, 72.13, 0],
      top_right_xyz: [116.54, 72.13, 0],
      bottom_left_xyz: [-137.62, -46.91, 0]
    },
    placementContext: {
      element_id: 1554033,
      host_element_id: 1362762,
      create_similar_body: {
        exemplarElementId: 1554033,
        hostElementId: 1362762,
        roomNumber: "405",
        roomSide: "left",
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [-19.7604166667, -6.921875, 32.166667],
      wall_projected_point: [-19.7604166667, -6.921875, 32.166667],
      wall_tangent: [0, -1, 0],
      placement_host_built_in_category: "OST_RvtLinks",
      room_number: "405",
      requested_room_side: "left",
      host_chainage_ft: 8.421875,
      host_normalized_chainage: 0.317308,
      host_curve_length_ft: 26.5416666667,
      supported_host: true
    },
    imageMarkHint: {
      normalized_x: 0.464,
      normalized_y: 0.609,
      raw_normalized_x: 0.293,
      raw_normalized_y: 0.507,
      side: "left",
      score: 0.9,
      source: "view_alignment",
      raw_image_width: 1184,
      raw_image_height: 715,
      wall_local_normalized_chainage: 0.778903,
      wall_local_axis: "vertical",
      wall_local_span_px: [1, 465],
      wall_local_source: "nearby_visible_wall_line"
    }
  });

  assert.ok(plan);
  assert.equal(plan.path, "/revit/create-similar-from-instance");
  const placement = (plan.body as any).placements[0];
  assert.equal(placement.targetNormalizedChainage, 0.07241);
  assert.ok(Math.abs(placement.targetChainageFt - 1.921875) < 0.001);
  assert.equal(placement.label, "mark 1");
  assert.equal("pointXyz" in placement, false);
});

test("spatial redline apply preserves room side from resolved linked wall context", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated in room 403 and circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated in room 403 and circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    toolResults: [
      {
        action_id: "room-contents",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          resolvedSpatial: { id: 1390984, number: "403", type: "Space", confidence: 0.98 }
        }
      },
      {
        action_id: "room-wall",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { id: 1390984, number: "403", requestedSide: "bottom" },
          requestedSide: "bottom",
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementBuiltInCategory: "OST_Walls",
                linkedElementCategory: "Walls",
                projectedPoint: { x: -34.986979, y: -27.622897, z: 32.166667 },
                tangent: { x: 1, y: 0, z: 0 }
              }
            }
          ]
        }
      },
      {
        action_id: "placement-context",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1556486,
          room: { number: "403", requestedSide: "bottom" },
          insertionPoint: { x: -34.986979, y: -27.622897, z: 32.166667 },
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          placementHostContext: {
            hostElementId: 1362762,
            linkedElementBuiltInCategory: "OST_Walls",
            linkedElementCategory: "Walls",
            projectedPoint: { x: -34.986979, y: -27.622897, z: 32.166667 },
            tangent: { x: 1, y: 0, z: 0 }
          },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "using_requested_room_side_link_host" } },
          suggestedPlacement: {
            placeOnHost: {
              body: {
                sourceElementId: 1556486,
                hostElementId: 1362762,
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [-50, -20, 32.166667],
            topRightXyz: [-20, -20, 32.166667],
            bottomLeftXyz: [-50, -30, 32.166667]
          }
        }
      },
      {
        action_id: "preview",
        method: "POST",
        path: "/revit/place-family-instance-on-host",
        status: "done",
        result_json: {
          status: "Planned",
          dryRun: true,
          placementValidation: { valid: true }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.ok(response.actions.some((action) => action.path === "/revit/computer-use-guard" && (action.body as any)?.dialogIdContains === "Project_Not_Saved_Recently"));
  assert.ok(response.actions.some((action) => action.path === "/revit/computer-use-guard" && (action.body as any)?.dialogIdContains === "DocWarnDialog"));
  const applyAction = response.actions.find((action) => action.path === "/revit/place-family-instance-on-host");
  assert.ok(applyAction);
  const body = applyAction.body as any;
  assert.equal(body.dryRun, false);
  assert.equal(body.roomNumber, "403");
  assert.equal(body.roomSide, "bottom");
});

test("spatial redline refinement prefers an earlier supported same-room placement context over a later unsupported refresh", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: {
            hostElementId: 1362762,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: false,
              reason: "using_requested_room_side_link_host"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          placementHost: null,
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host:Grids"
            }
          },
          suggestedPlacement: null
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const placements = (response.actions[1]?.body as any)?.placements;
  assert.equal(Array.isArray(placements), true);
  assert.equal(Array.isArray(placements?.[0]?.pointXyz), true);
  assert.equal("alongHostOffsetFt" in placements[0], false);
});

test("spatial redline refinement can preview link-host placement from resolve-room-wall before placement-context", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403" },
          walls: [
            {
              hostElementId: 1362762,
              category: "RVT Links",
              hostBuiltInCategory: "OST_RvtLinks",
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: {
                id: 1362762,
                category: "RVT Links",
                builtInCategory: "OST_RvtLinks",
                name: "Architectural Link"
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0],
                basis: "linked_room_boundary"
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const placements = (response.actions[1]?.body as any)?.placements;
  assert.equal(Array.isArray(placements), true);
  assert.equal(Array.isArray(placements?.[0]?.pointXyz), true);
  assert.equal("alongHostOffsetFt" in placements[0], false);
});

test("spatial redline refinement retries link-host create-similar with explicit points after basis failure", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: {
            hostElementId: 1362762,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: false,
              reason: "using_requested_room_side_link_host"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "failed",
        error: "One or more errors occurred. | alongHostOffsetFt requires a wall host or an explicit pointXyz basis."
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const placements = (response.actions[1]?.body as any)?.placements;
  assert.equal(Array.isArray(placements?.[0]?.pointXyz), true);
  assert.equal("alongHostOffsetFt" in placements[0], false);
});

test("spatial redline refinement schedules focused verification after applied placement and reports unresolved marks", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        action_id: "write-1",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" },
            { index: 2, label: "mark 3" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-view-region");
  assert.deepEqual((response.actions[0]?.body as any)?.region?.focusElementIds, [201, 202]);
  assert.match(response.assistant_message, /201, 202/);
  assert.match(response.assistant_message, /mark 3/);
});

test("placement work item becomes apply-ready after a successful low-risk dry-run preview", () => {
  const workItem = __testOnlyBuildPlacementWorkItem({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: {
                id: 1362762,
                category: "RVT Links",
                builtInCategory: "OST_RvtLinks"
              },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementCategory: "Walls",
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          room: { number: "403" },
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: {
            hostElementId: 1362762,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: false,
              reason: "using_requested_room_side_link_host"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        attachments: [{ kind: "image", local_path: "artifacts/previews/preview-403.png" }],
        result_json: {
          dryRun: true,
          status: "PreviewReady",
          placements: [{ label: "mark 1" }, { label: "mark 2" }]
        }
      }
    ] as any
  });

  assert.ok(workItem);
  assert.equal(workItem?.stage, "apply");
  assert.equal(workItem?.apply_ready, true);
  assert.equal(workItem?.family_strategy, "create_similar_from_exemplar");
  assert.equal(workItem?.placement_basis, "pointXyz");
  assert.match(workItem?.recommended_next_action ?? "", /dryRun=false/i);
});

test("placement run state prefers resolved room plan view over a generic active model view", () => {
  const runState = __testOnlyBuildPlacementRunState({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363433,
            name: "L4",
            type: "FloorPlan"
          }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/resolve-room-plan-view",
        status: "done",
        result_json: {
          roomNumber: "405",
          bestViewId: 1391195,
          bestViewName: "E104 - POWER PLAN L4",
          bestViewType: "EngineeringPlan"
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          room: { number: "405" },
          insertionPoint: [4.8, 1.6, 0],
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 2002,
            projectedPoint: [4.7, 1.4, 0],
            tangent: [0, 1, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 2002,
            chainageFt: 0.2,
            normalizedChainage: 0.071429,
            curveLengthFt: 2.8
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(runState);
  assert.equal(runState?.view_id, 1391195);
  assert.equal(runState?.stage, "preview");
  assert.equal(runState?.exemplar_element_id, 1002);
});

test("redline execution bridge preserves analyze-redline mark side into room-wall targeting when path metadata is missing", async () => {
  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (image); primary_sheet=none.",
        details: {
          image_meta: { width: 762, height: 636 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
        }
      }
    ] as any,
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1555916],
          boundaryLoops: [
            [
              { start: [-20, -30, 0], end: [-20, 2, 0] },
              { start: [-20, 2, 0], end: [4, 2, 0] },
              { start: [4, 2, 0], end: [4, -30, 0] },
              { start: [4, -30, 0], end: [-20, -30, 0] }
            ]
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 762,
          heightPx: 636,
          mapping: {
            topLeftXyz: [-20, 2, 0],
            topRightXyz: [4, 2, 0],
            bottomLeftXyz: [-20, -30, 0]
          }
        }
      },
      {
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          compaction: "visible-elements-inventory-summary",
          viewId: 1363337,
          count: 1,
          itemsSampled: [
            {
              elementId: 1555916,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              familyName: "Duplex Receptacle",
              space: { number: "405", name: "Live/Work Loft Unit 405" },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  const action = response?.actions?.[0];
  const body = action?.body as Record<string, unknown> | undefined;
  assert.equal(action?.path, "/revit/resolve-room-wall");
  assert.equal(body?.roomNumber, "405");
  assert.equal(body?.side, "left");
});

test("placement run state records verification progress before the explicit hosted audit runs", () => {
  const runState = __testOnlyBuildPlacementRunState({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362999,
          targetCandidates: [{ elementId: 1556608, hostElementId: 1362999, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362999, hostOffsetFt: 0, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          room: { number: "403" },
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 1362999,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 1362999,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362999
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed.png"
        }
      }
    ] as any
  });

  assert.ok(runState);
  assert.equal(runState?.stage, "verify");
  assert.equal(runState?.verification_captured, true);
  assert.equal(runState?.explicit_audit_complete, false);
  assert.deepEqual(runState?.created_element_ids, [201, 202]);
  assert.match(runState?.recommended_next_action ?? "", /audit-hosted-instance-placement/i);
});

test("placement run state stays in correct mode when audit failure requires delete-and-replace recovery", () => {
  const runState = __testOnlyBuildPlacementRunState({
    userText: "add receptacles where indicated on the south wall of room 403",
    context: {
      revit: {
        document: {
          activeView: {
            id: 1363337,
            name: "L4 - Power",
            type: "EngineeringPlan"
          }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403", requestedSide: "bottom" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementCategory: "Walls",
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [ -34.986979, -27.622897, 32.166667 ],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [ -34.986979, -27.622897, 32.166667 ],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [-50, -20, 0],
            topRightXyz: [0, -20, 0],
            bottomLeftXyz: [-50, -35, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556486,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556486, hostElementId: 1362762, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362762, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          room: { number: "403" },
          insertionPoint: [-48.229167, -19.708333, 33.666667],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          placementHostContext: {
            hostElementId: 1362762,
            linkedElementBuiltInCategory: "OST_Walls",
            projectedPoint: [-34.986979, -27.622897, 32.166667],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "linked_room_boundary",
            hostElementId: 1362762,
            projectedPoint: [-34.986979, -27.622897, 32.166667],
            tangent: [1, 0, 0],
            chainageFt: 0,
            normalizedChainage: 0,
            curveLengthFt: 26.979167
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "source_link_host_supported"
            }
          },
          suggestedPlacement: {
            placeOnHost: {
              body: {
                sourceElementId: 1556486,
                hostElementId: 1362762
              }
            },
            createSimilar: {
              body: {
                exemplarElementId: 1556486,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/place-family-instance-on-host",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementId: 1735504
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed-bad.png"
        }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          auditedIds: [1735504],
          validIds: [],
          invalidIds: [1735504],
          offRoomIds: [],
          offWallIds: [1735504],
          unsupportedIds: [1735504],
          missingIds: [],
          items: [
            {
              elementId: 1735504,
              placementContext: {
                elementId: 1735504,
                insertionPoint: [41.41562, -16.488164, 32.166667],
                center: [41.41562, -16.488164, 32.166667],
                room: null,
                host: null,
                placementHost: null,
                placementHostContext: null,
                diagnostics: {
                  hostPlacementSupport: {
                    supported: false,
                    sourceHostSupported: false,
                    reason: "no_supported_host_found"
                  }
                },
                requestedRoomWalls: [
                  {
                    hostElementId: 1362762,
                    hostContext: {
                      hostElementId: 1362762,
                      linkedElementBuiltInCategory: "OST_Walls",
                      projectedPoint: [-34.986979, -27.622897, 32.166667],
                      tangent: [1, 0, 0]
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(runState);
  assert.equal(runState?.stage, "correct");
  assert.equal(runState?.correction_ready, true);
  assert.deepEqual(runState?.unresolved_created_ids, [1735504]);
  assert.match(runState?.recommended_next_action ?? "", /delete unresolved created ids/i);
});

test("spatial redline refinement auto-recovers audited hard mismatches with delete-and-replace", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacles where indicated on the south wall of room 403"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacles where indicated on the south wall of room 403",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.31, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403", requestedSide: "bottom" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementCategory: "Walls",
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [-50, -20, 0],
            topRightXyz: [0, -20, 0],
            bottomLeftXyz: [-50, -35, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556486,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556486, hostElementId: 1362762, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362762, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          room: { number: "403" },
          insertionPoint: [-48.229167, -19.708333, 33.666667],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          placementHostContext: {
            hostElementId: 1362762,
            linkedElementBuiltInCategory: "OST_Walls",
            projectedPoint: [-34.986979, -27.622897, 32.166667],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "linked_room_boundary",
            hostElementId: 1362762,
            projectedPoint: [-34.986979, -27.622897, 32.166667],
            tangent: [1, 0, 0],
            chainageFt: 0,
            normalizedChainage: 0,
            curveLengthFt: 26.979167
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "source_link_host_supported"
            }
          },
          suggestedPlacement: {
            placeOnHost: {
              body: {
                sourceElementId: 1556486,
                hostElementId: 1362762
              }
            },
            createSimilar: {
              body: {
                exemplarElementId: 1556486,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/place-family-instance-on-host",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementId: 1735504
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed-bad.png"
        }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          auditedIds: [1735504],
          validIds: [],
          invalidIds: [1735504],
          offRoomIds: [],
          offWallIds: [1735504],
          unsupportedIds: [1735504],
          missingIds: [],
          items: [
            {
              elementId: 1735504,
              placementContext: {
                elementId: 1735504,
                insertionPoint: [41.41562, -16.488164, 32.166667],
                center: [41.41562, -16.488164, 32.166667],
                diagnostics: {
                  hostPlacementSupport: {
                    supported: false,
                    sourceHostSupported: false,
                    reason: "no_supported_host_found"
                  }
                },
                requestedRoomWalls: [
                  {
                    hostElementId: 1362762,
                    hostContext: {
                      hostElementId: 1362762,
                      linkedElementBuiltInCategory: "OST_Walls",
                      projectedPoint: [-34.986979, -27.622897, 32.166667],
                      tangent: [1, 0, 0]
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/delete");
  assert.deepEqual((response.actions[0]?.body as any)?.ids, [1735504]);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  assert.equal((response.actions[1]?.body as any)?.dryRun, false);
  assert.match(response.assistant_message, /attempting correction 1\/2/i);
});

test("spatial redline refinement recovers room-id source failures with same-circuit exemplar", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to P403/1",
    geminiIntents: [
      {
        intent: "Add a new duplex receptacle",
        proposed_action: "Place a new duplex receptacle on the south wall of Room 403 and assign it to P403/1",
        confidence: 0.9
      }
    ]
  }) as any;
  targetProfile.room_number = "403";
  targetProfile.spatial_side = "bottom";
  targetProfile.spatial_side_source = "south";

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.31, normalized_y: 0.88, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1127,
          mapping: {
            topLeftXyz: [-60, -15, 32.166667],
            topRightXyz: [-10, -15, 32.166667],
            bottomLeftXyz: [-60, -35, 32.166667]
          }
        }
      },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: []
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403", requestedSide: "south" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/place-family-instance-on-host",
        method: "POST",
        status: "failed",
        error: "One or more errors occurred. | Unable to resolve family symbol. Provide familySymbolId, symbolName, or sourceElementId."
      },
      {
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            {
              id: 1556486,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P403", "Circuit Number": "1", "Family and Type": "629794" }
            },
            {
              id: 1557116,
              name: "GFCI",
              category: "Electrical Fixtures",
              parameters: { Panel: "P403", "Circuit Number": "5", "Family and Type": "629792" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  assert.equal((response.actions[1]?.body as any)?.exemplarElementId, 1556486);
  assert.equal((response.actions[1]?.body as any)?.hostElementId, 1362762);
  assert.equal((response.actions[1]?.body as any)?.dryRun, true);
  assert.equal((response.actions[1]?.body as any)?.matchElectricalCircuitFromSource, true);
  assert.ok(Array.isArray((response.actions[1]?.body as any)?.placements));
  assert.ok(Array.isArray((response.actions[1]?.body as any)?.placements?.[0]?.pointXyz));
});

test("spatial redline refinement recovers invalid place-on-host previews with create-similar", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to P403/1"
  }) as any;
  targetProfile.room_number = "403";
  targetProfile.spatial_side = "bottom";
  targetProfile.spatial_side_source = "south";

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.31, normalized_y: 0.88, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1127,
          mapping: {
            topLeftXyz: [-137.601819, 82.286405, 32.166667],
            topRightXyz: [116.522054, 82.286405, 32.166667],
            bottomLeftXyz: [-137.601819, -47.83796, 32.166667]
          }
        }
      },
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [
          { id: 1390984, number: "403", name: "Live/Work Unit 403", spatialKind: "Space" }
        ]
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403", requestedSide: "south" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [-34.986979, -27.622897, 32.166667],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/place-family-instance-on-host",
        method: "POST",
        status: "done",
        result_json: {
          status: "InvalidPreview",
          dryRun: true,
          placementValidation: {
            valid: false,
            reason: "invalidIds=[1735510], offRoomIds=[], offWallIds=[1735510], unsupportedIds=[1735510], missingIds=[]",
            invalidIds: [1735510],
            offWallIds: [1735510],
            unsupportedIds: [1735510]
          }
        }
      },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486, 1556507, 1556608, 1556784]
        }
      },
      {
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            {
              id: 1407026,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P408", "Circuit Number": "1", "Family and Type": "629794" }
            },
            {
              id: 1556486,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P403", "Circuit Number": "1", "Family and Type": "629794" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  assert.equal((response.actions[1]?.body as any)?.exemplarElementId, 1556486);
  assert.equal((response.actions[1]?.body as any)?.hostElementId, 1362762);
  assert.equal((response.actions[1]?.body as any)?.dryRun, true);
  assert.equal((response.actions[1]?.body as any)?.matchElectricalCircuitFromSource, true);
  assert.ok(Array.isArray((response.actions[1]?.body as any)?.placements?.[0]?.pointXyz));
});

test("explicit circuit placement guard rejects raw visible-element source before write", () => {
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "sess-circuit-guard",
    message_id: "msg-circuit-guard",
    user_text: "add receptacle where indicated and circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "FloorPlan" }
        }
      }
    }
  };

  const response = __testOnlyBuildExplicitCircuitPlacementSourceGuardResponse({
    req,
    actions: [
      {
        action_id: "bad-placement",
        method: "POST",
        path: "/revit/place-family-instance-on-host",
        body: {
          sourceElementId: 1407026,
          hostElementId: 1362762,
          targetNormalizedChainage: 0.5,
          roomNumber: "403",
          roomSide: "south",
          dryRun: true,
          includePreviewImage: true
        }
      }
    ],
    toolResults: [
      {
        action_id: "find",
        method: "POST",
        path: "/revit/find-elements",
        status: "done",
        result_json: {
          scope: { kind: "view", viewIds: [1363337] },
          elementIds: [1407026, 1556486]
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-parameters");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds.slice(0, 2), [1407026, 1556486]);
  assert.match(response.assistant_message, /Raw visible-element order is not a safe exemplar source/i);
});

test("explicit circuit placement guard rewrites mismatched source to verified same-circuit exemplar", () => {
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "sess-circuit-rewrite",
    message_id: "msg-circuit-rewrite",
    user_text: "add receptacle where indicated and circuit to P403/1"
  };

  const response = __testOnlyBuildExplicitCircuitPlacementSourceGuardResponse({
    req,
    actions: [
      {
        action_id: "bad-placement",
        method: "POST",
        path: "/revit/place-family-instance-on-host",
        body: {
          sourceElementId: 1407026,
          hostElementId: 1362762,
          pointXyz: [-34.986979, -27.622897, 32.166667],
          orientationSourceElementId: 1407026,
          dryRun: true,
          includePreviewImage: true
        }
      }
    ],
    toolResults: [
      {
        action_id: "params",
        method: "POST",
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            {
              id: 1407026,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P408", "Circuit Number": "1", "Family and Type": "629794" }
            },
            {
              id: 1556486,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P403", "Circuit Number": "1", "Family and Type": "629794" }
            }
          ]
        }
      }
    ]
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-guard");
  assert.equal((response.actions[0]?.body as any)?.dialogIdContains, "DocWarnDialog");
  assert.equal((response.actions[0]?.body as any)?.button, "default");
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const body = response.actions[1]?.body as any;
  assert.equal(body.exemplarElementId, 1556486);
  assert.equal("orientationSourceElementId" in body, false);
  assert.equal(body.matchOrientationFromSource, false);
  assert.equal(body.matchElectricalCircuitFromSource, true);
  assert.equal(body.requireElectricalCircuitMatch, true);
  assert.equal(body.dryRun, true);
  assert.deepEqual(body.placements, [{ pointXyz: [-34.986979, -27.622897, 32.166667], label: "mark 1" }]);
  assert.equal("sourceElementId" in body, false);
  assert.match(response.assistant_message, /P408\/1/i);
});

test("spatial redline refinement auto-applies the previewed plan before stopping", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: {
                id: 1362762,
                category: "RVT Links",
                builtInCategory: "OST_RvtLinks"
              },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementCategory: "Walls",
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              },
              wallPlacement: {
                hostElementId: 1362762,
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: {
            hostElementId: 1362762,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: false,
              reason: "using_requested_room_side_link_host"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362762
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        attachments: [{ kind: "image", local_path: "artifacts/previews/preview-403.png" }],
        result_json: {
          dryRun: true,
          status: "PreviewReady",
          placements: [{ label: "mark 1" }, { label: "mark 2" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.ok(response.actions.some((action) => action.path === "/revit/computer-use-guard" && (action.body as any)?.dialogIdContains === "Project_Not_Saved_Recently"));
  assert.ok(response.actions.some((action) => action.path === "/revit/computer-use-guard" && (action.body as any)?.dialogIdContains === "DocWarnDialog"));
  const applyAction = response.actions.find((action) => action.path === "/revit/create-similar-from-instance");
  assert.ok(applyAction);
  assert.equal((applyAction.body as any)?.dryRun, false);
  assert.match(response.assistant_message, /apply the same create-similar request/i);
});

test("spatial redline refinement does not apply an invalid native placement preview", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add a receptacle on the south wall of room 403 to match the existing device"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add a receptacle on the south wall of room 403 to match the existing device",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.5, normalized_y: 0.8, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              requiresExplicitPointXyz: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [5, 5, 0],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556486,
          recommendedHostElementId: 1362762,
          targetCandidates: [{ elementId: 1556486 }],
          hostCandidates: [{ elementId: 1362762 }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          insertionPoint: [5, 5, 0],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: { hostElementId: 1362762, projectedPoint: [5, 5, 0], tangent: [1, 0, 0] },
          diagnostics: { hostPlacementSupport: { supported: true, reason: "using_requested_room_side_link_host" } },
          suggestedPlacement: { createSimilar: { body: { exemplarElementId: 1556486, hostElementId: 1362762 } } }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        attachments: [{ kind: "image", local_path: "artifacts/previews/preview-403.png" }],
        result_json: {
          dryRun: true,
          status: "InvalidPreview",
          placementValidation: {
            valid: false,
            reason: "invalidIds=[1735730], offWallIds=[1735730], unsupportedIds=[1735730]"
          },
          placements: [{ label: "mark 1" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /did not apply/i);
  assert.match(response.assistant_message, /unsupported/i);
});

test("spatial redline refinement tries one alternate native placement route after invalid preview", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated in room 403, circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated in room 403, circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.28, normalized_y: 0.82, score: 0.92 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { number: "403" },
          walls: [
            {
              hostElementId: 1362762,
              supportsPlacement: true,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                linkedElementId: 1454635,
                linkedElementBuiltInCategory: "OST_Walls",
                projectedPoint: [-34.98, -27.62, 32.16],
                tangent: [1, 0, 0]
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          insertionPoint: [-49.03125, -19.708333, 33.666667],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: { hostElementId: 1362762, projectedPoint: [-48.229167, -27.622897, 32.166667], tangent: [1, 0, 0] },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" } },
          suggestedPlacement: {
            createSimilar: { body: { exemplarElementId: 1556486, hostElementId: 1362762 } },
            placeOnHost: { body: { sourceElementId: 1556486, hostElementId: 1362762 } }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          dryRun: true,
          status: "InvalidPreview",
          placementValidation: { valid: false, reason: "invalidIds=[1735730], unsupportedIds=[1735730]" },
          placements: [{ label: "mark 1" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.at(-1)?.path, "/revit/place-family-instance-on-host");
  assert.equal((response.actions.at(-1)?.body as any)?.dryRun, true);
  assert.match(response.assistant_message, /alternate native hosted placement route once/i);
});

test("spatial redline refinement blocks after both native placement preview routes fail", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated in room 403, circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated in room 403, circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.28, normalized_y: 0.82, score: 0.92 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          insertionPoint: [-49.03125, -19.708333, 33.666667],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: { hostElementId: 1362762, projectedPoint: [-48.229167, -27.622897, 32.166667], tangent: [1, 0, 0] },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" } },
          suggestedPlacement: {
            createSimilar: { body: { exemplarElementId: 1556486, hostElementId: 1362762 } },
            placeOnHost: { body: { sourceElementId: 1556486, hostElementId: 1362762 } }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          dryRun: true,
          status: "InvalidPreview",
          placementValidation: { valid: false, reason: "invalidIds=[1735730], unsupportedIds=[1735730]" },
          placements: [{ label: "mark 1" }]
        }
      },
      {
        path: "/revit/place-family-instance-on-host",
        status: "done",
        result_json: {
          dryRun: true,
          status: "InvalidPreview",
          placementValidation: { valid: false, reason: "invalidIds=[1735731], unsupportedIds=[1735731]" },
          placements: [{ label: "mark 1" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /will not keep rediscovering tools/i);
});

test("spatial redline refinement does not repeat create-similar after same-circuit invalid preview", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated in room 403, circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated in room 403, circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.28, normalized_y: 0.82, score: 0.92 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556486,
          insertionPoint: [-49.03125, -19.708333, 33.666667],
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          wallPlacement: { hostElementId: 1362762, projectedPoint: [-48.229167, -27.622897, 32.166667], tangent: [1, 0, 0] },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" } },
          suggestedPlacement: {
            createSimilar: { body: { exemplarElementId: 1556486, hostElementId: 1362762 } },
            placeOnHost: { body: { sourceElementId: 1556486, hostElementId: 1362762 } }
          }
        }
      },
      {
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            {
              id: 1556486,
              name: "Standard",
              category: "Electrical Fixtures",
              parameters: { Panel: "P403", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          dryRun: true,
          status: "InvalidPreview",
          placementValidation: { valid: false, reason: "invalidIds=[1735730], unsupportedIds=[1735730]" },
          placements: [{ label: "mark 1" }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.at(-1)?.path, "/revit/place-family-instance-on-host");
  assert.match(response.assistant_message, /alternate native hosted placement route once/i);
});

test("spatial redline refinement keeps going when room lookup misses but room-contents resolves a space", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.7, normalized_y: 0.8, score: 0.95 }],
    toolResults: [
      { path: "/revit/rooms", status: "done", result_json: [] },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486, 1556507]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.match(response.assistant_message, /resolved space 403/i);
});

test("spatial redline refinement keeps going from room detail when room-contents fails", () => {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    targetViewId: 1363337,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "405",
      spatial_side: "left",
      spatial_side_source: "left"
    },
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: { roomNumber: "405", id: 1390985, name: "Live/Work Loft Unit" }
      },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" }
    ] as any,
    viewportHints: []
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|room-contents/i);
});

test("spatial redline refinement ranks exemplars after room wall resolves when room-contents fails", () => {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    targetViewId: 1391195,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "405",
      spatial_side: "left",
      spatial_side_source: "left"
    },
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: { roomNumber: "405", id: 1390985, name: "Live/Work Loft Unit" }
      },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementIds: [1362765],
          selectedWall: {
            elementId: 1362765,
            side: "left",
            projectedPointXyz: [-60.0, -8.0, 33.66],
            tangentXyz: [0, 1, 0]
          }
        }
      }
    ] as any,
    viewportHints: []
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rank-similar-devices-on-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1391195);
  assert.equal((response.actions[0]?.body as any)?.roomSide, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|stopped before guessing/i);
});

test("spatial redline refinement passes mapped target point into same-wall exemplar ranking", () => {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    targetViewId: 1391195,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "405",
      spatial_side: "left",
      spatial_side_source: "left"
    },
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: { roomNumber: "405", id: 1390985, name: "Live/Work Loft Unit" }
      },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" },
      { path: "/revit/room-contents", status: "failed", error: "native room-contents unavailable" },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementIds: [1362765],
          selectedWall: { elementId: 1362765, side: "left" }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1391195,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any,
    viewportHints: [{ view_id: 1391195, normalized_x: 0.25, normalized_y: 0.6, score: 0.96 }]
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rank-similar-devices-on-wall");
  const body = response.actions[0]?.body as any;
  assert.deepEqual(body.targetPointXyz, { x: 2.5, y: 4, z: 0 });
  assert.equal(body.roomNumber, "405");
  assert.equal(body.roomSide, "left");
});

test("spatial redline refinement infers room side from rooms boundary when exemplar host is unsupported", () => {
  const userText = "add receptacle where indicated and circuit to P403/1 artifacts/uploads/20260523_unit403_single_receptacle_redline.png";
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText,
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/resolve-room-plan-view",
        status: "done",
        result_json: {
          roomNumber: "403",
          bestViewId: 1363337,
          roomBbox: {
            minXyz: [-49.03, -27.62, 32.16],
            maxXyz: [-20.73, 2.24, 40.16]
          }
        }
      },
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [
          {
            id: 1390984,
            number: "403",
            name: "Live/Work Unit 403",
            boundary: {
              viewId: 1363337,
              sideClassification: {
                left: { hostElementIds: [] },
                right: { hostElementIds: [] },
                top: { hostElementIds: [] },
                bottom: { hostElementIds: [1362762] }
              }
            },
            boundaryLoops: [
              [
                { start: { x: -49.03, y: -27.62, z: 32.16 }, end: { x: -20.73, y: -27.62, z: 32.16 } },
                { start: { x: -20.73, y: -27.62, z: 32.16 }, end: { x: -20.73, y: 2.24, z: 32.16 } },
                { start: { x: -20.73, y: 2.24, z: 32.16 }, end: { x: -49.03, y: 2.24, z: 32.16 } },
                { start: { x: -49.03, y: 2.24, z: 32.16 }, end: { x: -49.03, y: -27.62, z: 32.16 } }
              ]
            ]
          }
        ]
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1556608,
          candidates: [{ elementId: 1556608, roomNumber: "403" }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          center: { x: -35.31, y: -27.54, z: 33.66 },
          insertionPoint: { x: -35.31, y: -27.54, z: 33.66 },
          room: { number: "403" },
          host: { id: 1496312, category: "Grids" },
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host"
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.side, "bottom");
  assert.match(response.assistant_message, /nearest room side \(bottom\)/i);
});

test("spatial redline refinement falls back to room-scoped locate when candidate clustering returns no targets", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.97, normalized_y: 0.81, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486, 1556507]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2400,
          heightPx: 2170,
          mapping: {
            topLeftXyz: [-59.2083, 12.4167, -467.8833],
            topRightXyz: [-10.5625, 12.4167, -467.8833],
            bottomLeftXyz: [-59.2083, -37.7188, -467.8833]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: null,
          recommendedHostElementId: null,
          targetCandidates: [],
          hostCandidates: []
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/locate-elements");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1556486, 1556507]);
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "403");
});

test("spatial redline refinement uses room-contents coordinates instead of re-running locate-elements", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.31, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608, 1556784],
          elements: [
            {
              id: 1556608,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              hostId: 1362762,
              point: [3, 5, 0]
            },
            {
              id: 1556784,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              hostId: 1362762,
              point: [7, 5, 0]
            }
          ]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: null,
          recommendedHostElementId: 1362762,
          targetCandidates: [],
          hostCandidates: [{ elementId: 1362762 }]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1556608);
});

test("spatial redline refinement picks the nearest summary candidate in view-plane space after an empty cluster", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.97, normalized_y: 0.81, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556486, 1556507]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2400,
          heightPx: 2170,
          mapping: {
            topLeftXyz: [-59.2083, 12.4167, -467.8833],
            topRightXyz: [-10.5625, 12.4167, -467.8833],
            bottomLeftXyz: [-59.2083, -37.7188, -467.8833]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: null,
          recommendedHostElementId: null,
          targetCandidates: [],
          hostCandidates: []
        }
      },
      {
        path: "/revit/locate-elements",
        status: "done",
        result_json: {
          items: []
        }
      },
      {
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [
          { id: 1556486, found: true, category: "Electrical Fixtures", name: "Far", location: { type: "point", x: -49.0313, y: -19.7083, z: 33.6667 } },
          { id: 1556507, found: true, category: "Electrical Fixtures", name: "Near", location: { type: "point", x: -20.7396, y: -19.7083, z: 33.6667 } }
        ]
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1556507);
});

test("spatial redline refinement rejects a weak cluster recommendation and re-ranks room-scoped locate candidates", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.97, normalized_y: 0.81, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [
          {
            id: 1390984,
            number: "403",
            boundary: {
              viewId: 1363337,
              sideClassification: {
                left: { hostElementIds: [] },
                right: { hostElementIds: [] },
                top: { hostElementIds: [] },
                bottom: { hostElementIds: [1362999] }
              }
            }
          }
        ]
      },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608, 1556507]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2400,
          heightPx: 2170,
          mapping: {
            topLeftXyz: [-59.2083, 12.4167, -467.8833],
            topRightXyz: [-10.5625, 12.4167, -467.8833],
            bottomLeftXyz: [-59.2083, -37.7188, -467.8833]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          searchRadiusFt: 8,
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [
            {
              elementId: 1556608,
              hostElementId: 5550001,
              roomNumber: "403",
              distanceFt: 6.2,
              score: 0.89,
              hostPlacementSupported: false,
              onRecommendedHost: false,
              onRequestedRoomSide: false
            }
          ],
          hostCandidates: [
            {
              elementId: 1362762,
              distanceFt: 5.8,
              hostOffsetFt: 500.05,
              supportsPlacement: false,
              onRequestedRoomSide: false
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/locate-elements");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1556608, 1556507]);
});

test("spatial redline refinement prefers a same-wall locate candidate over a weak cluster exemplar", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.97, normalized_y: 0.81, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [
          {
            id: 1390984,
            number: "403",
            boundary: {
              viewId: 1363337,
              sideClassification: {
                left: { hostElementIds: [] },
                right: { hostElementIds: [] },
                top: { hostElementIds: [] },
                bottom: { hostElementIds: [1362999] }
              }
            }
          }
        ]
      },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608, 1556507]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2400,
          heightPx: 2170,
          mapping: {
            topLeftXyz: [-59.2083, 12.4167, -467.8833],
            topRightXyz: [-10.5625, 12.4167, -467.8833],
            bottomLeftXyz: [-59.2083, -37.7188, -467.8833]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          searchRadiusFt: 8,
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362762,
          targetCandidates: [
            {
              elementId: 1556608,
              hostElementId: 5550001,
              roomNumber: "403",
              distanceFt: 6.2,
              score: 0.89,
              hostPlacementSupported: false,
              onRecommendedHost: false,
              onRequestedRoomSide: false
            }
          ],
          hostCandidates: [
            {
              elementId: 1362762,
              distanceFt: 5.8,
              hostOffsetFt: 500.05,
              supportsPlacement: false,
              onRequestedRoomSide: false
            }
          ]
        }
      },
      {
        path: "/revit/locate-elements",
        status: "done",
        result_json: {
          items: [
            {
              elementId: 1556608,
              hostId: 5550001,
              roomNumber: "403",
              nearDistanceFt: 2.5
            },
            {
              elementId: 1556507,
              hostId: 1362999,
              roomNumber: "403",
              nearDistanceFt: 3.1
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1556507);
  assert.match(response.assistant_message, /rejected the weak cluster recommendation/i);
});

test("spatial redline refinement uses coordinate-aware locate results before pixel clustering when mapped hints already exist", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.9, normalized_y: 0.8, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [
          {
            id: 1390984,
            number: "403",
            boundary: {
              viewId: 1363337,
              sideClassification: {
                left: { hostElementIds: [] },
                right: { hostElementIds: [] },
                top: { hostElementIds: [] },
                bottom: { hostElementIds: [1362999] }
              }
            }
          }
        ]
      },
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608, 1556507]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/locate-elements",
        status: "done",
        result_json: {
          items: [
            {
              elementId: 1556608,
              hostId: 5550001,
              roomNumber: "403",
              nearDistanceFt: 2.5,
              center: { x: 2, y: 2, z: 0 }
            },
            {
              elementId: 1556507,
              hostId: 1362999,
              roomNumber: "403",
              nearDistanceFt: 1.5,
              center: { x: 9, y: 2, z: 0 }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1556507);
  assert.doesNotMatch(response.assistant_message, /pick-candidate-cluster/i);
});

test("spatial redline refinement audits created elements after screenshot verification before completion", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.9 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          searchRadiusFt: 8,
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362999,
          targetCandidates: [
            {
              elementId: 1556608,
              hostElementId: 1362999,
              roomNumber: "403",
              distanceFt: 2.2,
              score: 0.95,
              hostPlacementSupported: true,
              onRecommendedHost: true,
              onRequestedRoomSide: true
            }
          ],
          hostCandidates: [
            {
              elementId: 1362999,
              distanceFt: 2.0,
              hostOffsetFt: 3.5,
              supportsPlacement: true,
              onRequestedRoomSide: true
            }
          ]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          room: { number: "403" },
          placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362999
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        action_id: "write-1",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        action_id: "verify-1",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed.png"
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/audit-hosted-instance-placement");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [201, 202]);
  assert.match(response.assistant_message, /explicit hosted placement audit/i);
});

test("redline execution bridge requests circuit readback after hosted placement audit lacks electrical evidence", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 403 where indicated, circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              targetChainageFt: 4.25,
              targetNormalizedChainage: 0.25,
              placementPoint: { x: -19.760417, y: -23.421875, z: 32.166667 }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-403.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-42.9, -27.6, 32.166667],
                room: { number: "403" },
                placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-parameters");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1735601]);
  assert.match(response.assistant_message, /circuit readback/i);
});

test("redline execution bridge finalizes hosted placement after audit includes circuit evidence", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 403 where indicated, circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              targetChainageFt: 4.25,
              targetNormalizedChainage: 0.25,
              placementPoint: { x: -19.760417, y: -23.421875, z: 32.166667 }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-403.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P403/1", panel: "P403", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-42.9, -27.6, 32.166667],
                room: { number: "403" },
                placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P403/1", panel: "P403", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735601/i);
  assert.match(response.assistant_message, /1735601=P403\/1/i);
});

test("redline execution bridge corrects explicit circuit mismatch after valid hosted placement", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 403 where indicated, circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-403.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-42.9, -27.6, 32.166667],
                room: { number: "403" },
                placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/assign-electrical-circuit");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1735601]);
  assert.equal((response.actions[0]?.body as any)?.panelName, "P403");
  assert.equal((response.actions[0]?.body as any)?.circuitNumber, "1");
  assert.equal((response.actions[0]?.body as any)?.parameterOnlyFallback, false);
  assert.match(response.assistant_message, /correct the electrical system membership/i);
});

test("redline execution bridge corrects same-circuit mismatch from the source exemplar", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: {
            id: 1556486,
            name: "adjacent receptacle",
            electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
          },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/assign-electrical-circuit");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1735601]);
  assert.equal((response.actions[0]?.body as any)?.sourceElementId, 1556486);
  assert.equal((response.actions[0]?.body as any)?.parameterOnlyFallback, undefined);
  assert.match(response.assistant_message, /P405\/1/i);
});

test("redline execution bridge reads source circuit before completing same-circuit placement", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: { id: 1556486, name: "adjacent receptacle" },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-parameters");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1556486, 1735601]);
  assert.match(response.assistant_message, /source receptacle circuit readback/i);
});

test("redline execution bridge accepts ranked source circuit evidence for same-circuit completion", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/rank-similar-devices-on-wall",
        method: "POST",
        status: "done",
        result_json: {
          recommendedElementId: 1556486,
          candidates: [
            {
              elementId: 1556486,
              hostElementId: 1362765,
              hostPlacementSupported: true,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: { id: 1556486, name: "adjacent receptacle" },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735601/i);
  assert.match(response.assistant_message, /1735601=P405\/1/i);
});

test("redline execution bridge does not reuse stale completion after a later placement failure", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated, circuit to P405/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735535],
          placements: [
            {
              index: 0,
              elementId: 1735535,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735535],
          validIds: [1735535],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735535,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735535,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "failed",
        error: "Can't rotate element into this position.",
        result_json: { status: "Failed", error: "Can't rotate element into this position." }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.doesNotMatch(response.assistant_message, /Placed and verified receptacle 1735535/i);
  assert.match(response.assistant_message, /later placement attempt failed|Latest placement failure/i);
});

test("redline execution bridge accepts ranked adjacent circuit when apply result omits source id", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/rank-similar-devices-on-wall",
        method: "POST",
        status: "done",
        result_json: {
          recommendedElementId: 1555916,
          candidates: [
            {
              elementId: 1555916,
              hostElementId: 1362762,
              hostPlacementSupported: true,
              roomSide: "left",
              electricalCircuit: { panel: "P405", circuitNumber: "1", primaryLabel: "P405/1" }
            }
          ]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735901],
          placements: [
            {
              index: 0,
              elementId: 1735901,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405-no-source.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735901],
          validIds: [1735901],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735901,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735901,
                insertionPoint: [-58.0, -12.1, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735901/i);
  assert.match(response.assistant_message, /1735901=P405\/1/i);
});

test("redline execution bridge finalizes same-circuit placement after source circuit readback", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: { id: 1556486, name: "adjacent receptacle" },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      },
      {
        path: "/revit/get-parameters",
        method: "POST",
        status: "done",
        result_json: {
          items: [
            {
              id: 1556486,
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              id: 1735601,
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735601/i);
  assert.match(response.assistant_message, /1735601=P405\/1/i);
});

test("redline execution bridge accepts elements-shaped source circuit readback", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: { id: 1556486, name: "adjacent receptacle" },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
              }
            }
          ]
        }
      },
      {
        path: "/revit/get-parameters",
        method: "POST",
        status: "done",
        result_json: {
          elements: [
            {
              elementId: 1556486,
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1735601,
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735601/i);
  assert.match(response.assistant_message, /1735601=P405\/1/i);
});

test("redline execution bridge uses workbench red-mark side when same-circuit prompt omits room side", async () => {
  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (image); red mark detected.",
        details: {
          ok: true,
          file_path: "artifacts/uploads/clipboard_405.png",
          kind: "image",
          image_meta: { width: 762, height: 636 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "rooms",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: [{ id: 1390985, number: "405", name: "Live/Work Loft Unit 405", spatialKind: "Space" }]
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61963, 72.132123, -467.883333],
            topRightXyz: [116.539865, 72.132123, -467.883333],
            bottomLeftXyz: [-137.61963, -46.914844, -467.883333]
          }
        }
      },
      {
        action_id: "visible",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { frameId: "visible-405", viewId: 1363337, count: 144, items: [] }
      },
      {
        action_id: "room-contents",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390985,
          roomNumber: "405",
          resolvedSpatial: { id: 1390985, number: "405", kind: "Space" },
          elements: []
        }
      },
      {
        action_id: "rank",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1555916,
          request: { roomNumber: "405", roomSide: "", targetPointXyz: null },
          recommendedCreateSimilarRequest: {
            exemplarElementId: 1555916,
            hostElementId: 1362762,
            roomNumber: "405",
            roomSide: "",
            placements: null,
            matchOrientationFromSource: true,
            matchElectricalCircuitFromSource: true,
            requireElectricalCircuitMatch: false,
            requiresExplicitTarget: true,
            dryRun: true,
            includePreviewImage: true
          },
          candidates: [
            {
              elementId: 1555916,
              hostElementId: 1362762,
              hostPlacementSupported: true,
              electricalCircuit: { panel: "P405", circuitNumber: "1", primaryLabel: "P405/1" }
            }
          ]
        }
      },
      {
        action_id: "placement-context",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1555916,
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" } },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1555916,
                hostElementId: 1362762,
                roomNumber: "405",
                roomSide: "",
                referenceElementId: 1555916,
                matchOrientationFromSource: true,
                orientationSourceElementId: 1555916,
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("redline execution bridge finalizes after circuit assignment readback matches source exemplar", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          exemplar: {
            id: 1556486,
            name: "adjacent receptacle",
            electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
          },
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-405.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735601],
          validIds: [1735601],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735601,
              electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" },
              placementContext: {
                elementId: 1735601,
                insertionPoint: [-61.2, -14.3, 32.166667],
                room: { number: "405" },
                placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "P407/1", panel: "P407", circuitNumber: "1" }
              }
            }
          ]
        }
      },
      {
        path: "/revit/assign-electrical-circuit",
        method: "POST",
        status: "done",
        result_json: {
          applied: true,
          results: [
            {
              elementId: 1735601,
              ok: true,
              after: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.deepEqual(response.actions, []);
  assert.match(response.assistant_message, /Placed and verified receptacle 1735601/i);
  assert.match(response.assistant_message, /1735601=P405\/1/i);
});

test("spatial redline routing prioritizes hosted placement completion over sheet rediscovery", () => {
  const profile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to P403/1 in room 403",
    geminiIntents: [],
    annotationRegionHints: []
  });
  const toolResults: ToolResult[] = [
    {
      action_id: "sheet",
      method: "POST",
      path: "/revit/sheets",
      status: "done",
      result_json: { status: "Ok", sheetNumber: "E403" }
    },
    {
      action_id: "apply",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      status: "done",
      result_json: {
        status: "Placed",
        dryRun: false,
        elementIds: [1735001],
        placementValidation: {
          valid: true,
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: []
        }
      }
    },
    {
      action_id: "audit",
      method: "POST",
      path: "/revit/audit-hosted-instance-placement",
      status: "done",
      result_json: { status: "Ok", validIds: [1735001], invalidIds: [], offRoomIds: [], offWallIds: [] }
    }
  ];

  assert.equal(__testOnlyShouldPrioritizeHostedPlacementBridge({ profile, toolResults }), true);
  assert.equal(__testOnlyShouldPrioritizeHostedPlacementBridge({ profile, toolResults: toolResults.slice(0, 1) }), false);
});

test("redline execution bridge repairs missing-id hosted audit after placement write", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 403 where indicated, circuit to P403/1",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        path: "/revit/export-view-frame",
        method: "POST",
        status: "done",
        result_json: { frameId: "frame-403", viewId: 1363337, widthPx: 2200, heightPx: 1100 }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735601],
          placements: [
            {
              index: 0,
              elementId: 1735601,
              label: "mark 1",
              targetChainageFt: 4.25,
              targetNormalizedChainage: 0.25,
              placementPoint: { x: -19.760417, y: -23.421875, z: 32.166667 }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        status: "done",
        result_json: { imagePath: "artifacts/checks/placed-403.png" }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        method: "POST",
        status: "failed",
        error: "elementIds is required."
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/audit-hosted-instance-placement");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1735601]);
  assert.equal((response.actions[0]?.body as any)?.targetChainageFt, 4.25);
  assert.equal((response.actions[0]?.body as any)?.targetNormalizedChainage, 0.25);
  assert.deepEqual((response.actions[0]?.body as any)?.targetPointXyz, [-19.760417, -23.421875, 32.166667]);
  assert.equal((response.actions[0]?.body as any)?.targetToleranceFt, 0.5);
  assert.match(response.assistant_message, /explicit hosted placement audit/i);
});

test("spatial redline refinement recovers interrupted apply after valid preview by observing dialog", () => {
  const userText = "add receptacle in Unit 403 where indicated, circuit to P403/1 artifacts/uploads/clipboard_20260523_173431_801.png";
  const targetProfile = __testOnlyInferRedlineTargetingProfile({ userText });

  const previewBody = {
    exemplarElementId: 1556608,
    hostElementId: 1362762,
    roomNumber: "403",
    roomSide: "bottom",
    matchOrientationFromSource: false,
    matchElectricalCircuitFromSource: true,
    requireElectricalCircuitMatch: true,
    dryRun: true,
    previewViewId: 1363337,
    placements: [{ pointXyz: [-42.986979, -27.622897, 32.166667], label: "mark 1" }]
  };

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText,
    targetProfile,
    targetViewId: 1363337,
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1556608,
          candidates: [{ elementId: 1556608, roomNumber: "403" }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          insertionPoint: [-35.314714, -27.541667, 33.666667],
          room: { number: "403" },
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          hostLocalFrame: {
            basis: "linked_room_wall",
            hostElementId: 1362762,
            projectedPoint: [-35.314714, -27.622897, 32.166667],
            tangent: [1, 0, 0],
            chainageFt: 13.7,
            normalizedChainage: 0.5,
            curveLengthFt: 28.3
          },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
          suggestedPlacement: { createSimilar: { body: previewBody } }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Planned",
          dryRun: true,
          placementValidation: { valid: true },
          placements: [{ temporaryElementId: 1735605, label: "mark 1" }]
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "failed",
        error: "fetch failed"
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.match(response.assistant_message, /interrupted after a valid placement preview/i);
});

test("spatial redline refinement retries interrupted apply after known modal was dismissed", () => {
  const userText = "add receptacle in Unit 403 where indicated, circuit to P403/1 artifacts/uploads/clipboard_20260523_173431_801.png";
  const targetProfile = __testOnlyInferRedlineTargetingProfile({ userText });

  const previewBody = {
    exemplarElementId: 1556608,
    hostElementId: 1362762,
    roomNumber: "403",
    roomSide: "bottom",
    matchOrientationFromSource: false,
    matchElectricalCircuitFromSource: true,
    requireElectricalCircuitMatch: true,
    dryRun: true,
    previewViewId: 1363337,
    placements: [{ pointXyz: [-42.986979, -27.622897, 32.166667], label: "mark 1" }]
  };

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText,
    targetProfile,
    targetViewId: 1363337,
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1031,
          mapping: {
            topLeftXyz: [-137.61, 72.13, 0],
            topRightXyz: [116.53, 72.13, 0],
            bottomLeftXyz: [-137.61, -46.91, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1556608,
          candidates: [{ elementId: 1556608, roomNumber: "403" }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          insertionPoint: [-35.314714, -27.541667, 33.666667],
          room: { number: "403" },
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          hostLocalFrame: {
            basis: "linked_room_wall",
            hostElementId: 1362762,
            projectedPoint: [-35.314714, -27.622897, 32.166667],
            tangent: [1, 0, 0],
            chainageFt: 13.7,
            normalizedChainage: 0.5,
            curveLengthFt: 28.3
          },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
          suggestedPlacement: { createSimilar: { body: previewBody } }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        status: "done",
        result_json: {
          status: "Planned",
          dryRun: true,
          placementValidation: { valid: true },
          placements: [{ temporaryElementId: 1735605, label: "mark 1" }]
        }
      },
      { path: "/revit/create-similar-from-instance", method: "POST", status: "failed", error: "fetch failed" },
      { path: "/revit/computer-use-observe", method: "POST", status: "done", result_json: { blocked_by_modal: true, top_most_title: "Project Not Saved Recently" } },
      { path: "/revit/computer-use-act", method: "POST", status: "done", result_json: { clicked: true, clicked_button: "Cancel" } }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.at(-1)?.path, "/revit/create-similar-from-instance");
  assert.equal((response.actions.at(-1)?.body as any)?.dryRun, false);
  assert.ok(response.actions.some((action) => action.path === "/revit/computer-use-guard" && (action.body as any)?.dialogIdContains === "Project_Not_Saved_Recently"));
});

test("spatial redline refinement auto-corrects post-apply off-wall mismatches before stopping", { concurrency: false }, () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.92 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362999,
          targetCandidates: [{ elementId: 1556608, hostElementId: 1362999, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362999, hostOffsetFt: 0, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          center: [5, 5, 0],
          insertionPoint: [5, 5, 0],
          room: { number: "403" },
          placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 1362999,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 1362999,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362999
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        action_id: "write-1",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        action_id: "verify-1",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed.png"
        }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        status: "done",
        result_json: {
          auditedIds: [201, 202],
          validIds: [202],
          invalidIds: [201],
          offRoomIds: [201],
          offWallIds: [201],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 201,
              placementContext: {
                elementId: 201,
                insertionPoint: [0, 5, 0],
                room: { number: "402" },
                placementHost: { id: 5550001, category: "Walls", builtInCategory: "OST_Walls" },
                requestedRoomWalls: [{ hostElementId: 1362999 }],
                diagnostics: {
                  hostPlacementSupport: {
                    supported: false,
                    sourceHostSupported: false,
                    reason: "off_requested_wall"
                  }
                }
              }
            },
            {
              elementId: 202,
              placementContext: {
                elementId: 202,
                insertionPoint: [7, 5, 0],
                room: { number: "403" },
                placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
                requestedRoomWalls: [{ hostElementId: 1362999 }],
                diagnostics: {
                  hostPlacementSupport: {
                    supported: true,
                    sourceHostSupported: true,
                    reason: "same_room_wall"
                  }
                }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/adjust-hosted-instance-on-host");
  assert.equal((response.actions[0]?.body as any)?.elementId, 201);
  assert.equal((response.actions[0]?.body as any)?.targetChainageFt, 3);
  assert.match(response.assistant_message, /nudge 201 \+3\.00ft/i);
});

test("spatial redline refinement reports unresolved created ids when post-apply mismatches cannot be auto-corrected", { concurrency: false }, () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.92 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362999,
          targetCandidates: [{ elementId: 1556608, hostElementId: 1362999, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362999, hostOffsetFt: 0, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          center: [5, 5, 0],
          insertionPoint: [5, 5, 0],
          room: { number: "403" },
          placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 1362999,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 1362999,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362999
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        action_id: "write-1",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        action_id: "verify-1",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/placed.png"
        }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        status: "done",
        result_json: {
          auditedIds: [201, 202],
          validIds: [202],
          invalidIds: [201],
          offRoomIds: [201],
          offWallIds: [201],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 201,
              placementContext: {
                elementId: 201,
                insertionPoint: [40, 5, 0],
                room: { number: "402" },
                placementHost: { id: 5550001, category: "Walls", builtInCategory: "OST_Walls" },
                requestedRoomWalls: [{ hostElementId: 1362999 }],
                diagnostics: {
                  hostPlacementSupport: {
                    supported: false,
                    sourceHostSupported: false,
                    reason: "off_requested_wall"
                  }
                }
              }
            },
            {
              elementId: 202,
              placementContext: {
                elementId: 202,
                insertionPoint: [7, 5, 0],
                room: { number: "403" },
                placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
                requestedRoomWalls: [{ hostElementId: 1362999 }],
                diagnostics: {
                  hostPlacementSupport: {
                    supported: true,
                    sourceHostSupported: true,
                    reason: "same_room_wall"
                  }
                }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /Unresolved created ids: 201\./i);
  assert.match(response.assistant_message, /Off-room ids: 201\./i);
});

test("spatial redline refinement auto-corrects along-wall placement drift after verification", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [
      { view_id: 1363337, normalized_x: 0.3, normalized_y: 0.5, score: 0.95 },
      { view_id: 1363337, normalized_x: 0.7, normalized_y: 0.5, score: 0.92 }
    ],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: 1362999,
          targetCandidates: [{ elementId: 1556608, hostElementId: 1362999, roomNumber: "403", score: 0.95 }],
          hostCandidates: [{ elementId: 1362999, hostOffsetFt: 0, supportsPlacement: true, onRequestedRoomSide: true }]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          center: [5, 5, 0],
          insertionPoint: [5, 5, 0],
          room: { number: "403" },
          placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 1362999,
            projectedPoint: [5, 5, 0],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 1362999,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: {
              supported: true,
              sourceHostSupported: true,
              reason: "same_room_wall"
            }
          },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1556608,
                hostElementId: 1362999
              }
            }
          }
        }
      },
      {
        path: "/revit/create-similar-from-instance",
        method: "POST",
        action_id: "write-1",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [201, 202],
          placements: [
            { index: 0, elementId: 201, label: "mark 1" },
            { index: 1, elementId: 202, label: "mark 2" }
          ]
        }
      },
      {
        path: "/revit/export-view-region",
        method: "POST",
        action_id: "verify-1",
        status: "done",
        result_json: {
          imagePath: "artifacts/checks/off-target.png"
        }
      },
      {
        path: "/revit/audit-hosted-instance-placement",
        status: "done",
        result_json: {
          auditedIds: [201, 202],
          validIds: [201, 202],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 201,
              placementContext: {
                elementId: 201,
                center: [1.0, 5, 0],
                insertionPoint: [1.0, 5, 0],
                room: { number: "403" },
                placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
                diagnostics: {
                  hostPlacementSupport: {
                    supported: true,
                    sourceHostSupported: true,
                    reason: "same_room_wall"
                  }
                }
              }
            },
            {
              elementId: 202,
              placementContext: {
                elementId: 202,
                center: [9.5, 5, 0],
                insertionPoint: [9.5, 5, 0],
                room: { number: "403" },
                placementHost: { id: 1362999, category: "Walls", builtInCategory: "OST_Walls" },
                diagnostics: {
                  hostPlacementSupport: {
                    supported: true,
                    sourceHostSupported: true,
                    reason: "same_room_wall"
                  }
                }
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/adjust-hosted-instance-on-host");
  assert.equal(response.actions[1]?.path, "/revit/adjust-hosted-instance-on-host");
  assert.equal(response.actions[2]?.path, "/revit/export-view-region");
  assert.equal((response.actions[0]?.body as any)?.elementId, 201);
  assert.equal((response.actions[0]?.body as any)?.targetChainageFt, 3);
  assert.equal((response.actions[1]?.body as any)?.elementId, 202);
  assert.equal((response.actions[1]?.body as any)?.targetChainageFt, 7);
  assert.match(response.assistant_message, /along-wall correction/i);
});

test("spatial redline refinement stops when placement context remains unsupported", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add two receptacles on the south wall of room 403 to match the existing devices",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.7, normalized_y: 0.8, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1556608]
        }
      },
      { path: "/revit/resolve-room-wall", status: "done", result_json: { status: "Ok" } },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 2400,
          heightPx: 2170,
          mapping: {
            topLeftXyz: [-59.2083, 12.4167, -467.8833],
            topRightXyz: [-10.5625, 12.4167, -467.8833],
            bottomLeftXyz: [-59.2083, -37.7188, -467.8833]
          }
        }
      },
      {
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          recommendedExemplarElementId: 1556608,
          recommendedHostElementId: null,
          targetCandidates: [{ elementId: 1556608 }],
          hostCandidates: []
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1556608,
          placementHost: null,
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host:Grids"
            }
          },
          suggestedPlacement: null
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions.length, 0);
  assert.match(response.assistant_message, /stopped before placement/i);
});

test("spatial redline refinement uses ranked create-similar request after unsupported placement context", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          schema: "operator.similar_device_rank.v1",
          request: { roomNumber: "405", roomSide: "left" },
          recommendedElementId: 1002,
          recommendedCreateSimilarRequest: {
            exemplarElementId: 1002,
            hostElementId: 2002,
            roomNumber: "405",
            roomSide: "left",
            placements: [{ targetChainageFt: 6.5, targetNormalizedChainage: 0.65, label: "mark 1" }],
            dryRun: true,
            includePreviewImage: true,
            matchElectricalCircuitFromSource: true,
            requireElectricalCircuitMatch: false
          },
          candidates: [
            {
              elementId: 1002,
              host: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
              hostPlacementSupported: true,
              hostMatchesRequestedRoomSide: true
            }
          ]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1002,
          placementHost: { id: 9999, category: "Grids", builtInCategory: "OST_Grids" },
          room: { number: "405" },
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host:Grids"
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-guard");
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const body = response.actions[1]?.body as any;
  assert.equal(body.exemplarElementId, 1002);
  assert.equal(body.hostElementId, 2002);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.roomSide, "left");
  assert.equal(body.requireElectricalCircuitMatch, true);
  assert.deepEqual(body.placements, [{ targetChainageFt: 6.5, targetNormalizedChainage: 0.65, label: "mark 1" }]);
});

test("spatial redline refinement refuses heuristic placement when where-indicated target is unmeasured", () => {
  const userText = "add receptacle where indicated in room 405 on the left wall";
  const targetProfile = __testOnlyInferRedlineTargetingProfile({ userText });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText,
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/rooms",
        status: "done",
        result_json: [{ id: 1390985, number: "405", name: "Live/Work Loft Unit 405", spatialKind: "Space" }]
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { id: 1390985, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          requestedSide: "left",
          walls: [
            {
              hostElementId: 1362762,
              boundaryElementId: 748858,
              boundaryLengthFt: 26.541667,
              wallPlacement: {
                basis: "linked_room_boundary",
                hostElementId: 1362762,
                projectedPoint: [-19.760417, -13.671875, 32.166667],
                tangent: [0, -1, 0],
                curveLengthFt: 26.541667,
                chainageFt: 13.671875,
                normalizedChainage: 0.51511,
                supportsPlacement: true
              },
              hostContext: {
                hostKind: "linked_host",
                hostElementId: 1362762,
                boundaryElementId: 748858,
                linkedElementId: 748858,
                supportsPlacement: true
              }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1127,
          mapping: {
            topLeftXyz: [-137.6018, 82.2864, -467.8833],
            topRightXyz: [116.5221, 82.2864, -467.8833],
            bottomLeftXyz: [-137.6018, -47.838, -467.8833]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1555720,
          insertionPoint: [-19.760417, -13.671875, 32.166667],
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" } },
          hostLocalFrame: {
            basis: "linked_room_boundary",
            hostElementId: 1362762,
            projectedPoint: [-19.760417, -13.671875, 32.166667],
            tangent: [0, -1, 0],
            curveLengthFt: 26.541667,
            chainageFt: 13.671875,
            normalizedChainage: 0.51511,
            supportsPlacement: true
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1555720,
                hostElementId: 1362762,
                roomNumber: "405",
                roomSide: "left",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.match(response.assistant_message, /no measured redline-to-view target/i);
});

test("spatial redline refinement synthesizes ranked host-local target when rank request lacks explicit placement", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          schema: "operator.similar_device_rank.v1",
          request: { roomNumber: "405", roomSide: "left" },
          recommendedElementId: 1002,
          recommendedCreateSimilarRequest: {
            exemplarElementId: 1002,
            hostElementId: 2002,
            roomNumber: "405",
            roomSide: "left",
            requiresExplicitTarget: true,
            notes: "Ranking found the exemplar, but no target point/chainage was supplied.",
            dryRun: true,
            includePreviewImage: true,
            matchElectricalCircuitFromSource: true,
            requireElectricalCircuitMatch: false
          },
          candidates: [
            {
              elementId: 1002,
              host: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
              hostPlacementSupported: true,
              hostMatchesRequestedRoomSide: true,
              hostLocalFrame: {
                basis: "WallCurve",
                hostElementId: 2002,
                projectedPoint: [0, 4, 0],
                tangent: [0, 1, 0],
                chainageFt: 4,
                normalizedChainage: 0.4,
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1002,
          placementHost: { id: 9999, category: "Grids", builtInCategory: "OST_Grids" },
          room: { number: "405" },
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host:Grids"
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.match(response.assistant_message, /no measured redline-to-view target/i);
});

test("spatial redline refinement synthesizes create-similar from ranked host when placement context is unsupported", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          schema: "operator.similar_device_rank.v1",
          request: { room_number: "405", room_side: "left" },
          recommended_element_id: 1002,
          candidates: [
            {
              element_id: 1002,
              host_id: 2002,
              room_side: "left",
              host_placement_supported: true,
              electrical_circuit: { primary_label: "P405/1" },
              host_local_frame: {
                basis: "WallCurve",
                host_element_id: 2002,
                projected_point: [0, 4, 0],
                tangent: [0, 1, 0],
                chainage_ft: 4,
                normalized_chainage: 0.4,
                curve_length_ft: 10
              }
            }
          ]
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          elementId: 1002,
          placementHost: { id: 9999, category: "Grids", builtInCategory: "OST_Grids" },
          room: { number: "405" },
          diagnostics: {
            hostPlacementSupport: {
              supported: false,
              sourceHostSupported: false,
              reason: "unsupported_source_host:Grids"
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.match(response.assistant_message, /no measured redline-to-view target/i);
});

test("spatial redline refinement infers marked room side from mapped view hint before blocking", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.02, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: { recommendedElementId: 1001, candidates: [{ elementId: 1001 }] }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.match(response.assistant_message, /near the left side/i);
});

test("spatial redline refinement lets mapped mark location outrank broad ranked exemplar", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.02, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          elements: [
            { id: 1001, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2001, point: [8.5, 5, 0] },
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: { recommendedElementId: 1001, candidates: [{ elementId: 1001 }, { elementId: 1002 }] }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1002);
  assert.equal((response.actions[0]?.body as any)?.roomSide, "left");
});

test("redline execution bridge ranks same-room exemplars after empty pick cluster finds only a host wall", async () => {
  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (image); primary_sheet=none.",
        details: {
          image_meta: { width: 1400, height: 717 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 632, y: 591, w: 30, h: 20, area: 600 }]
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1400,
          heightPx: 717,
          mapping: {
            topLeftXyz: [-137.6, 82.2, -467.8],
            topRightXyz: [116.5, 82.2, -467.8],
            bottomLeftXyz: [-137.6, -47.8, -467.8]
          }
        }
      },
      {
        action_id: "rooms-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: [
          {
            id: 1390985,
            number: "405",
            name: "Live/Work Loft Unit 405",
            spatialKind: "Space",
            location: { x: -8.33, y: -13.67, z: 32.16 },
            boundaryLoops: [
              [
                { start: [-19.25, -29.56, 32.16], end: [3.09, -29.56, 32.16], elementId: 1362762 },
                { start: [3.09, -29.56, 32.16], end: [3.09, 1.5, 32.16], elementId: 1362762 }
              ]
            ]
          }
        ]
      },
      {
        action_id: "cluster-empty-targets",
        method: "POST",
        path: "/revit/pick-candidate-cluster",
        status: "done",
        result_json: {
          status: "Ok",
          frameId: "frame-405",
          pickPoint: { xPx: 1018, yPx: 953, model: { x: -19.95, y: -27.84, z: -467.8 } },
          room: { id: 1390985, number: "405", requestedSide: "bottom" },
          recommendedExemplarElementId: null,
          recommendedHostElementId: 1362762,
          targetCandidates: [],
          hostCandidates: [
            {
              rank: 1,
              elementId: 1362762,
              category: "RVT Links",
              builtInCategory: "OST_RvtLinks",
              supportsPlacement: true,
              onRequestedRoomSide: true,
              hostOffsetFt: 500.0
            }
          ],
          diagnostics: { emptyReason: "no_target_candidates_within_view_plane_radius" }
        }
      },
      {
        action_id: "wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          room: { id: 1390985, number: "405", requestedSide: "bottom" },
          requestedSide: "bottom",
          count: 1,
          walls: [
            {
              rank: 1,
              hostElementId: 1362762,
              boundaryElementId: 1524790,
              supportsPlacement: true,
              boundaryLengthFt: 22.34,
              placementHost: { id: 1362762, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              hostContext: {
                hostElementId: 1362762,
                projectedPoint: { x: -8.33, y: -29.56, z: 32.16 },
                tangent: { x: 1, y: 0, z: 0 },
                curveLengthFt: 22.34,
                supportsPlacement: true
              },
              wallPlacement: {
                projectedPoint: { x: -8.33, y: -29.56, z: 32.16 },
                tangent: { x: 1, y: 0, z: 0 },
                curveLengthFt: 22.34,
                chainageFt: 10.91,
                normalizedChainage: 0.49,
                supportsPlacement: true
              }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rank-similar-devices-on-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.match(String((response.actions[0]?.body as any)?.roomSide), /bottom|south/);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("spatial redline refinement reads circuit parameters for room candidates before explicit-circuit placement", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle in room 403 where indicated and circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle in room 403 where indicated and circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.02, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          elements: [
            { id: 1001, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2001, point: [8.5, 5, 0] },
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-parameters");
  assert.deepEqual((response.actions[0]?.body as any)?.elementIds, [1001, 1002]);
  assert.match(response.assistant_message, /near the red mark/i);
});

test("spatial redline refinement prefers nearest located same-circuit exemplar over first circuit match", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle in room 403 where indicated and circuit to P403/1"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle in room 403 where indicated and circuit to P403/1",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.02, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          elements: [
            { id: 1001, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2001, point: [8.5, 5, 0] },
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            {
              id: 1001,
              category: "Electrical Fixtures",
              name: "Duplex Receptacle",
              parameters: { Panel: "P403", "Circuit Number": "1" }
            },
            {
              id: 1002,
              category: "Electrical Fixtures",
              name: "Duplex Receptacle",
              parameters: { Panel: "P403", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1002);
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "403");
  assert.equal((response.actions[0]?.body as any)?.roomSide, "left");
});

test("spatial redline refinement preserves ranked adjacent device room side into placement preview", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle"
  });

  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle",
    targetProfile,
    targetViewId: 1363337,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [
            {
              elementId: 1002,
              hostElementId: 2002,
              roomSide: "left",
              electricalCircuit: { primaryLabel: "P405/1" }
            }
          ]
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 2002,
            projectedPoint: [0, 0, 0],
            tangent: [0, 1, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 2002,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" }
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.match(response.assistant_message, /no measured redline-to-view target/i);
});

test("redline execution bridge infers room side from mapped mark when prompt omits room and circuit ids", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          file_path: "artifacts/uploads/clipboard.png",
          analysis: {
            file_path: "artifacts/uploads/clipboard.png",
            ocr: { text_excerpt: "LIVE/WORK LOFT UNIT 405" }
          },
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.02, normalized_y: 0.5 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: { recommendedElementId: 1001, candidates: [{ elementId: 1001 }, { elementId: 1002 }] }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge selects adjacent marked exemplar when prompt omits explicit room and circuit", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          file_path: "artifacts/uploads/clipboard.png",
          analysis: {
            file_path: "artifacts/uploads/clipboard.png",
            ocr: { text_excerpt: "LIVE/WORK LOFT UNIT 405" }
          },
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.02, normalized_y: 0.5 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          elements: [
            { id: 1001, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2001, point: [8.5, 5, 0] },
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: { recommendedElementId: 1001, candidates: [{ elementId: 1001 }, { elementId: 1002 }] }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/get-placement-context");
  assert.equal((response.actions[0]?.body as any)?.elementId, 1002);
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.roomSide, "left");
});

test("redline execution bridge auto-remaps red pixels before returning no-pick blocker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_unit405.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-unit405",
        filename: "clipboard_unit405.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [
            {
              viewportId: 1483922,
              viewId: 1363337,
              rotation: "None",
              box: { minU: 0, minV: 0, maxU: 10, maxV: 5 }
            }
          ],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "room",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        action_id: "rank",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: { recommendedElementId: 1001, candidates: [{ elementId: 1001 }, { elementId: 1002 }] }
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1001,
          center: { x: 8.5, y: 5, z: 0 },
          insertionPoint: { x: 8.5, y: 5, z: 0 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 3001, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
          placementHostContext: null,
          wallPlacement: null,
          hostLocalFrame: null,
          diagnostics: {
            hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "source_link_host_supported" }
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1001,
                hostElementId: 3001,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      },
      {
        action_id: "inventory",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { viewId: 1363337, count: 2, items: [] }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge rehydrates persisted workbench red mark on continuation turns", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-rehydrate-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const sessionId = "redline-rehydrate-continuation";
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
        summary: "Redline analyzed (image); primary_sheet=none.",
        details: {
          ok: true,
          file_path: "artifacts/uploads/clipboard_unit405.png",
          kind: "image",
          image_meta: { width: 762, height: 636 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
        }
      },
      error: null
    }) + "\n",
    "utf8"
  );

  try {
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      sessionId,
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
          }
        }
      },
      toolResults: [
        {
          action_id: "room",
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390985,
            roomNumber: "405",
            spatialKind: "Space",
            resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
            elementIds: [1001, 1002],
            boundaryLoops: [
              [
                { start: [0, 0, 0], end: [10, 0, 0] },
                { start: [10, 0, 0], end: [10, 10, 0] },
                { start: [10, 10, 0], end: [0, 10, 0] },
                { start: [0, 10, 0], end: [0, 0, 0] }
              ]
            ]
          }
        },
        {
          action_id: "frame",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-405",
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        }
      ] as any
    });

    assert.ok(response);
    assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
    assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
    assert.equal((response.actions[0]?.body as any)?.side, "left");
    assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows can briefly hold workspace files during async cleanup.
    }
  }
});

test("redline execution bridge rehydrates run bundle again when tool outputs arrive later", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-rehydrate-late-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const sessionId = "redline-rehydrate-late-tool-output";
  const sessionDir = path.join(root, "runs", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "request_log.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "user.turn",
      session_id: sessionId,
      user_text: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      user_attachments: [
        {
          id: "att-late",
          relative_path: "artifacts/uploads/clipboard_late_unit405.png",
          filename: "clipboard_late_unit405.png",
          bytes: 100,
          mime: "image/png"
        }
      ]
    }) + "\n",
    "utf8"
  );

  try {
    await __testOnlyBuildRedlineExecutionBridgeAsync({
      sessionId,
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
          }
        }
      },
      toolResults: []
    });

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
          summary: "Redline analyzed (image); primary_sheet=none.",
          details: {
            ok: true,
            file_path: "artifacts/uploads/clipboard_late_unit405.png",
            kind: "image",
            image_meta: { width: 762, height: 636 },
            mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
          }
        },
        error: null
      }) + "\n",
      "utf8"
    );

    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      sessionId,
      userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
          }
        }
      },
      toolResults: [
        {
          action_id: "contents-405",
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390985,
            roomNumber: "405",
            spatialKind: "Space",
            resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
            elementIds: [1001, 1002],
            boundaryLoops: [
              [
                { start: [0, 0, 0], end: [10, 0, 0] },
                { start: [10, 0, 0], end: [10, 10, 0] },
                { start: [10, 10, 0], end: [0, 10, 0] },
                { start: [0, 10, 0], end: [0, 0, 0] }
              ]
            ]
          }
        },
        {
          action_id: "frame-405",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-405",
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        }
      ] as any
    });

    assert.ok(response);
    assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
    assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
    assert.equal((response.actions[0]?.body as any)?.side, "left");
    assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows can briefly hold workspace files during async cleanup.
    }
  }
});

test("redline execution bridge detects uploaded image red mark when workbench omitted mark regions", async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-image-fallback-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRelPath = "artifacts/uploads/clipboard_unit405_red_mark.png";
  const uploadFullPath = path.join(root, uploadRelPath.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(uploadFullPath), { recursive: true });
  fs.writeFileSync(uploadFullPath, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  try {
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      sessionId: "redline-image-fallback-no-workbench-mark",
      userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
          }
        }
      },
      userAttachments: [
        {
          id: "att-red-mark",
          relative_path: uploadRelPath,
          filename: "clipboard_unit405_red_mark.png",
          bytes: fs.statSync(uploadFullPath).size,
          mime: "image/png"
        }
      ] as any,
      workbenchResults: [
        {
          index: 1,
          type: "analyze_redline",
          ok: true,
          summary: "Redline analyzed (image); primary_sheet=none.",
          details: {
            ok: true,
            file_path: uploadRelPath,
            kind: "image",
            image_meta: { width: 100, height: 50 },
            ocr: { ok: false, text_excerpt: "", text_chars: 0 }
          }
        }
      ] as any,
      toolResults: [
        {
          action_id: "contents-405",
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390985,
            roomNumber: "405",
            spatialKind: "Space",
            resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
            elementIds: [1001, 1002],
            boundaryLoops: [
              [
                { start: [0, 0, 0], end: [10, 0, 0] },
                { start: [10, 0, 0], end: [10, 10, 0] },
                { start: [10, 10, 0], end: [0, 10, 0] },
                { start: [0, 10, 0], end: [0, 0, 0] }
              ]
            ]
          }
        },
        {
          action_id: "frame-405",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-405",
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        }
      ] as any
    });

    assert.ok(response);
    assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
    assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
    assert.equal((response.actions[0]?.body as any)?.side, "left");
    assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // Windows can briefly hold workspace files during async cleanup.
    }
  }
});

test("redline execution bridge blocks uploaded screenshot placement until the mark is view-aligned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-place-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_unit405.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-unit405-placement",
        filename: "clipboard_unit405.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "room",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        action_id: "rank",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
        }
      },
      {
        action_id: "room-wall",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2002,
              supportsPlacement: true,
              placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2002,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 2002,
            projectedPoint: [0, 0, 0],
            tangent: [0, 1, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 2002,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" }
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                roomSide: "left",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      },
      {
        action_id: "inventory",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { viewId: 1363337, count: 1, items: [] }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/computer-use-observe");
  assert.equal(response.actions.some((action) => action.path === "/revit/create-similar-from-instance"), false);
  assert.match(response.assistant_message, /measured redline-to-view target/i);
  assert.doesNotMatch(response.assistant_message, /placed and verified/i);
});

test("redline execution bridge does not use uploaded screenshot marks as synthetic ranking coordinates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-synthetic-hint-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_20260524_011111_456.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-synthetic-hint",
        filename: "clipboard_20260524_011111_456.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "rooms-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          number: "405",
          id: 1390985,
          name: "Live/Work Loft Unit"
        }
      },
      {
        action_id: "room-wall",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2002,
              supportsPlacement: true,
              hostContext: {
                hostElementId: 2002,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { viewId: 1363337, count: 1, items: [] }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rank-similar-devices-on-wall");
  const body = response.actions[0]?.body as any;
  assert.equal(body.roomNumber, "405");
  assert.equal(body.roomSide, "left");
  assert.equal(body.targetPointXyz, undefined);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge promotes active-view mark regions into room targeting without OCR", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-active-view-mark-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_active_view_room405.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  const frameAbs = path.join(root, "artifacts/frames/l4-power.png");
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.mkdirSync(path.dirname(frameAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));
  fs.writeFileSync(frameAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-active-view-room405",
        filename: "clipboard_active_view_room405.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "detected red mark without OCR",
        details: {
          file_path: uploadRel,
          image_meta: { width: 1400, height: 717 },
          ocr: { ok: false, text_excerpt: "", text_chars: 0 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 630, y: 584, w: 35, h: 44, area: 633 }]
        }
      }
    ],
    toolResults: [
      {
        action_id: "inventory",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-visible",
          viewId: 1363337,
          viewName: "L4 - Power",
          widthPx: 2200,
          heightPx: 1127,
          count: 2,
          items: [
            {
              id: 1390985,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1390985, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1390985, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.5087, normalizedY: 0.7374, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.4637, minNormalizedY: 0.6151, maxNormalizedX: 0.5536, maxNormalizedY: 0.8595 } }
            },
            {
              id: 1555720,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Standard",
              space: { id: 1390985, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1390985, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.4637, normalizedY: 0.7838, insideFrame: true } }
            }
          ]
        }
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-active-405",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1127,
          path: frameAbs,
          mapping: {
            topLeftXyz: [-126.0, 82.0, 32.1667],
            topRightXyz: [128.0, 82.0, 32.1667],
            bottomLeftXyz: [-126.0, -48.0, 32.1667]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.notEqual(response.actions.length, 0);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any).roomNumber, "405");
});

test("redline execution bridge handles filename-neutral clipboard mark with OCR room and adjacent circuit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-neutral-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_20260524_011111_123.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-neutral",
        filename: "clipboard_20260524_011111_123.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          file_path: uploadRel,
          analysis: {
            file_path: uploadRel,
            ocr: { text_excerpt: "Live/Work Loft\nUnit\n405" }
          },
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.02, normalized_y: 0.5 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "room",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        action_id: "rank",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
        }
      },
      {
        action_id: "room-wall",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2002,
              supportsPlacement: true,
              placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2002,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 2002,
            projectedPoint: [0, 0, 0],
            tangent: [0, 1, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 2002,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" }
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                roomSide: "left",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const body = response.actions[1]?.body as any;
  assert.equal(body.exemplarElementId, 1002);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.roomSide, "left");
  assert.equal(body.matchElectricalCircuitFromSource, true);
  assert.equal(body.requireElectricalCircuitMatch, true);
  assert.equal(typeof body.placements[0]?.targetNormalizedChainage, "number");
  assert.doesNotMatch(`${response.assistant_message}\n${JSON.stringify(body)}`, /clipboard_unit405/i);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge infers room from visible adjacent devices when OCR and explicit circuit are absent", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            },
            {
              elementId: 3001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "403", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.18, normalizedY: 0.12, insideFrame: true } },
              parameters: { Panel: "P403", "Circuit Number": "5" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge does not treat OCR-only circuit labels as explicit same-circuit requests", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "ocr saw neighboring circuit label",
        details: {
          ocr: { text_excerpt: "P407/1" }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(JSON.stringify(response.actions.map((action) => ({ path: action.path, body: action.body }))), /407/);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge prioritizes marked adjacent device over noisy room summaries", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.06, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-noisy-summary",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-noisy-summary",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-noisy-summary",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-noisy-summary",
          viewId: 1363337,
          count: 90,
          summary: {
            roomCounts: [
              { key: "407", count: 48 },
              { key: "405", count: 2 }
            ],
            spaceCounts: [{ key: "407", count: 48 }]
          },
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge treats generic visible unit labels as room evidence near the mark", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-label",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-label",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-label",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 5005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.35, normalizedY: 0.64, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
  assert.doesNotMatch(JSON.stringify(response.actions.map((action) => action.body)), /"roomNumber":"407"/);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge reads split unit labels from text parameters for no-pick adjacent circuit routing", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-split-unit-label",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-split-unit-label",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-split-unit-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-split-unit-label",
          viewId: 1363337,
          count: 5,
          summary: {
            roomCounts: [
              { key: "407", count: 44 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 6105,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              parameters: { "Text String": "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.47, normalizedY: 0.49, insideFrame: true } }
            },
            {
              elementId: 6106,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              parameters: { "Text String": "405" },
              anchor: { image: { normalizedX: 0.47, normalizedY: 0.62, insideFrame: true } }
            },
            {
              elementId: 1505,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2707,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit 407", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
  assert.doesNotMatch(JSON.stringify(response.actions.map((action) => action.body)), /"roomNumber":"407"/);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("redline execution bridge treats generic visible circuit labels as room evidence near the mark", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-circuit-label",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-circuit-label",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-circuit-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-circuit-label",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 6005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "P405/1",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.viewId, 1363337);
  assert.doesNotMatch(JSON.stringify(response.actions.map((action) => action.body)), /"roomNumber":"407"/);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge prioritizes adjacent receptacle evidence over noisy summaries without explicit circuit", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-adjacent-noisy-summary",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-adjacent-noisy-summary",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-adjacent-noisy-summary",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-adjacent-noisy-summary",
          viewId: 1363337,
          count: 120,
          summary: {
            roomCounts: [
              { key: "407", count: 60 },
              { key: "405", count: 2 }
            ],
            spaceCounts: [{ key: "407", count: 58 }]
          },
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.match(response.assistant_message, /left wall hint/i);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge carries adjacent-inferred side into room wall resolution", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-adjacent-left",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-adjacent-left",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-adjacent-left",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-adjacent-left",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        action_id: "rooms-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          boundary: { viewId: 1363337, sideClassification: { left: { hostElementIds: [2002] } } }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-wall");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.side, "left");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge hydrates native requestedRoomSide from resolved room wall results", () => {
  const targeting = __testOnlyExtractLatestRedlineSpatialTargetingFromToolResults(
    [
      {
        action_id: "room-wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2002,
              supportsPlacement: true,
              placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2002,
                projectedPoint: { x: 4.7, y: 1.4, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 2.8
              }
            }
          ]
        }
      }
    ] as any
  );

  assert.equal(targeting.room_number, "405");
  assert.equal(targeting.spatial_side, "left");
  assert.equal(targeting.spatial_side_source, "left");
});

test("redline execution bridge requests richer inventory before no-pick when adjacent circuit room is unresolved", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-adjacent-unresolved",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-adjacent-unresolved",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-summary-only",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-summary-only",
          viewId: 1363337,
          count: 120,
          summary: {
            roomCounts: [
              { key: "407", count: 60 },
              { key: "405", count: 2 }
            ],
            spaceCounts: [{ key: "407", count: 58 }]
          },
          items: [
            { elementId: 6001, category: "Lines", builtInCategory: "OST_Lines" }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/export-visible-elements");
  const body = response.actions[0]?.body as any;
  assert.equal(body.viewId, 1363337);
  assert.equal(body.limit, 500);
  assert.equal(body.prioritizeSpatialContext, true);
  assert.doesNotMatch(response.assistant_message, /no_pick_hints|did not recover usable pick locations/i);
});

test("redline execution bridge uses OCR room text before returning no-pick when prompt omits circuit id", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "ocr extracted room label",
        details: {
          ocr: {
            text_excerpt: "E104 - POWER PLAN L4\nLive/Work Loft\nUnit\n405\nP405/1"
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-empty",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          count: 0,
          items: []
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge accepts alternate visible inventory element schema for adjacent-circuit room inference", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405-elements",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405-elements",
          viewId: 1363337,
          count: 3,
          elements: [
            {
              id: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              image: { normalized_x: 0.06, normalized_y: 0.54 },
              panel: "P405",
              circuitNumber: "1"
            },
            {
              id: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              normalizedX: 0.93,
              normalizedY: 0.52,
              Panel: "P407",
              Circuit: "1"
            },
            {
              id: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              imagePoint: { normalizedX: 0.46, normalizedY: 0.84 },
              panel: "P405",
              circuit: "1"
            },
            {
              id: 3001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "403", name: "Live/Work Unit" },
              imagePoint: { normalizedX: 0.18, normalizedY: 0.12 },
              panel: "P403",
              circuit: "5"
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge accepts snake-case native visible inventory schema", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-snake-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frame_id: "inventory-snake-405",
          view_id: 1363337,
          count: 4,
          visible_elements: [
            {
              element_id: 1411041,
              category: "Spaces",
              built_in_category: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit", kind: "Space" },
              bbox: {
                image: {
                  normalized_min_x: 0.0,
                  normalized_min_y: 0.1,
                  normalized_max_x: 0.62,
                  normalized_max_y: 0.9
                }
              }
            },
            {
              element_id: 1002,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit" },
              image_point: { normalized_x: 0.06, normalized_y: 0.54 },
              parameter_groups: { electrical: { panel: "P405", circuit_number: "1" } }
            },
            {
              element_id: 1003,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              room_number: "405",
              image_point: { normalized_x: 0.46, normalized_y: 0.84 },
              electrical_circuit: { primary_label: "P405/1" }
            },
            {
              element_id: 2001,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              room_number: "407",
              image_point: { normalized_x: 0.93, normalized_y: 0.52 },
              panel: "P407",
              circuit_number: "1"
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge infers room from visible room labels when device spatial metadata is missing", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405-labels",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405-labels",
          viewId: 1363337,
          count: 5,
          items: [
            {
              elementId: 9001,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.52, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 9002,
              category: "Text Notes",
              builtInCategory: "OST_TextNotes",
              visibleText: "Live/Work Loft Unit",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.45, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge switches from generic view when visible MEP space elements infer the room", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: {
              region_count: 1,
              viewport_regions: 1,
              titleblock_regions: 0,
              sheet_regions: 0,
              unique_view_ids: [1363433]
            },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.45, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-live-shape",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-live-shape",
          viewId: 1363433,
          widthPx: 2198,
          heightPx: 1223,
          mapping: {
            topLeftXyz: [-120, 50, 32.166667],
            topRightXyz: [93, 50, 32.166667],
            bottomLeftXyz: [-120, -68, 32.166667]
          }
        }
      },
      {
        action_id: "inventory-live-space-shape",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-live-space-shape",
          viewId: 1363433,
          count: 8,
          scanned: 5858,
          truncated: true,
          items: [
            {
              id: 1411040,
              elementId: 1411040,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 403",
              space: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              associatedSpatial: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              anchor: { image: { normalizedX: 0.39821578465051427, normalizedY: 0.7104215901907143, insideFrame: true } }
            },
            {
              id: 1411041,
              elementId: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.5230085696666141, normalizedY: 0.7186052800588484, insideFrame: true } }
            },
            {
              id: 1411042,
              elementId: 1411042,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              associatedSpatial: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              anchor: { image: { normalizedX: 0.6672303908859258, normalizedY: 0.7184294775419878, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: { displayValue: "P405" }, "Circuit Number": { value: 1 } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.53, insideFrame: true } },
              parameters: { Panel: { displayValue: "P407" }, "Circuit Number": { value: 1 } }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/resolve-room-plan-view");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.equal((response.actions[0]?.body as any)?.preferViewNameContains, "power");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge uses visible space containment when adjacent circuit label does not encode room", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.48, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-panel",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-panel",
          viewId: 1363433,
          widthPx: 2200,
          heightPx: 1223,
          mapping: {
            topLeftXyz: [-120, 50, 32.166667],
            topRightXyz: [93, 50, 32.166667],
            bottomLeftXyz: [-120, -68, 32.166667]
          }
        }
      },
      {
        action_id: "inventory-generic-panel",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-panel",
          viewId: 1363433,
          count: 5,
          items: [
            {
              id: 1411040,
              elementId: 1411040,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 403",
              space: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              associatedSpatial: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.82, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.25, minNormalizedY: 0.58, maxNormalizedX: 0.465, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411041,
              elementId: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.54, normalizedY: 0.71, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.47, minNormalizedY: 0.58, maxNormalizedX: 0.61, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411042,
              elementId: 1411042,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              associatedSpatial: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.72, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.62, minNormalizedY: 0.58, maxNormalizedX: 0.82, maxNormalizedY: 0.86 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge uses bbox-only space containment for adjacent device room inference", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-bbox-only-space",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-bbox-only-space",
          viewId: 1363433,
          widthPx: 2200,
          heightPx: 1223,
          mapping: {
            topLeftXyz: [-120, 50, 32.166667],
            topRightXyz: [93, 50, 32.166667],
            bottomLeftXyz: [-120, -68, 32.166667]
          }
        }
      },
      {
        action_id: "inventory-bbox-only-space",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-bbox-only-space",
          viewId: 1363433,
          count: 4,
          items: [
            {
              elementId: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.06, minNormalizedY: 0.2, maxNormalizedX: 0.55, maxNormalizedY: 0.9 } }
            },
            {
              elementId: 1411042,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.56, minNormalizedY: 0.2, maxNormalizedX: 0.95, maxNormalizedY: 0.9 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge preserves room-relative side into generic-panel create-similar preview", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.48, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-panel",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-panel",
          viewId: 1363433,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-panel",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-panel",
          viewId: 1363433,
          count: 4,
          items: [
            {
              id: 1411040,
              elementId: 1411040,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 403",
              space: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              associatedSpatial: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.82, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.25, minNormalizedY: 0.58, maxNormalizedX: 0.465, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411041,
              elementId: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.54, normalizedY: 0.71, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.47, minNormalizedY: 0.58, maxNormalizedX: 0.61, maxNormalizedY: 0.86 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      },
      {
        action_id: "room-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          boundaryLoops: [
            [
              { start: [4.7, 1.4, 0], end: [6.1, 1.4, 0] },
              { start: [6.1, 1.4, 0], end: [6.1, 4.2, 0] },
              { start: [6.1, 4.2, 0], end: [4.7, 4.2, 0] },
              { start: [4.7, 4.2, 0], end: [4.7, 1.4, 0] }
            ]
          ],
          hostIdsBySide: { left: [2002], right: [2007], bottom: [2005] }
        }
      },
      {
        action_id: "contents-405",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1411041,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1411041, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          boundaryLoops: [
            [
              { start: [4.7, 1.4, 0], end: [6.1, 1.4, 0] },
              { start: [6.1, 1.4, 0], end: [6.1, 4.2, 0] },
              { start: [6.1, 4.2, 0], end: [4.7, 4.2, 0] },
              { start: [4.7, 4.2, 0], end: [4.7, 1.4, 0] }
            ]
          ],
          elements: [
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [4.8, 1.6, 0] }
          ]
        }
      },
      {
        action_id: "rank-405",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "left", electricalCircuit: { panel: "L4PA", circuitNumber: "7" } }]
        }
      },
      {
        action_id: "room-wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [4.7, 1.6, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        action_id: "placement-context-405",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 4.8, y: 1.6, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1411041, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2002, projectedPoint: [4.7, 1.4, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2002, chainageFt: 0.2, normalizedChainage: 0.071429, curveLengthFt: 2.8 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          electricalCircuit: { panel: "L4PA", circuitNumber: "7", primaryLabel: "L4PA/7" },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[1]?.path, "/revit/create-similar-from-instance");
  const body = response.actions[1]?.body as any;
  assert.equal(body.exemplarElementId, 1002);
  assert.equal(body.hostElementId, 2002);
  assert.equal(body.roomNumber, "405");
  assert.equal(body.roomSide, "left");
  assert.equal(body.matchElectricalCircuitFromSource, true);
  assert.equal(body.requireElectricalCircuitMatch, true);
  assert.equal(typeof body.placements[0]?.targetNormalizedChainage, "number");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge prefers visible room label nearest the red mark when adjacent units are visible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-nearest-room-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const uploadRel = "artifacts/uploads/clipboard_adjacent_units.png";
  const uploadAbs = path.join(root, ...uploadRel.split("/"));
  fs.mkdirSync(path.dirname(uploadAbs), { recursive: true });
  fs.writeFileSync(uploadAbs, Buffer.from(RED_MARK_PNG_BASE64, "base64"));

  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    userAttachments: [
      {
        id: "clipboard-adjacent-units",
        filename: "clipboard_adjacent_units.png",
        relative_path: uploadRel,
        mime: "image/png"
      }
    ],
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-adjacent-labels",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-adjacent-labels",
          viewId: 1363337,
          count: 5,
          items: [
            {
              elementId: 9003,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "403",
              taggedSpatial: { number: "403", name: "Live/Work Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.5, insideFrame: true } }
            },
            {
              elementId: 9005,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.5, insideFrame: true } }
            },
            {
              elementId: 9007,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "407",
              taggedSpatial: { number: "407", name: "Live/Work Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.5, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.07, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("fast electrical redline inventory hydration infers room and side from adjacent visible receptacle", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle."
  });
  assert.equal(targetProfile.room_number, null);

  const hydrated = __testOnlyHydrateTargetProfileFromVisibleInventory({
    targetProfile,
    semanticCorpus: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    markHint: { normalized_x: 0.035, normalized_y: 0.655, side: "left", score: 0.86 },
    mappedMarkSide: "left",
    toolResults: [
      {
        action_id: "inventory-fast-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          count: 5,
          items: [
            {
              elementId: 9405,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.50, insideFrame: true } }
            },
            {
              elementId: 1405,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.04, normalizedY: 0.65, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1407,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.equal(hydrated.room_number, "405");
  assert.equal(hydrated.spatial_side, "left");
  assert.equal(hydrated.spatial_side_source, "left");
});

test("fast electrical redline inventory hydration uses generic unit labels as anchors for unlabeled adjacent receptacles", () => {
  const targetProfile = __testOnlyInferRedlineTargetingProfile({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle."
  });
  assert.equal(targetProfile.room_number, null);

  const hydrated = __testOnlyHydrateTargetProfileFromVisibleInventory({
    targetProfile,
    semanticCorpus: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    mappedMarkSide: "left",
    toolResults: [
      {
        action_id: "inventory-generic-label-unlabeled-device-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          count: 6,
          items: [
            {
              elementId: 9403,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Unit 403",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.52, insideFrame: true } }
            },
            {
              elementId: 9405,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 9407,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Unit 407",
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 1405,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            }
          ]
        }
      }
    ] as any
  });

  assert.equal(hydrated.room_number, "405");
  assert.equal(hydrated.spatial_side, "left");
  assert.equal(hydrated.spatial_side_source, "left");
});

test("fast electrical redline inventory hydration can override weak wrong room with marked adjacent receptacle", () => {
  const targetProfile = {
    ...__testOnlyInferRedlineTargetingProfile({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle."
    }),
    room_number: "407"
  };

  const hydrated = __testOnlyHydrateTargetProfileFromVisibleInventory({
    targetProfile,
    semanticCorpus: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.\nvision saw Unit 407 in the crop",
    markHint: { normalized_x: 0.035, normalized_y: 0.655, side: "left", score: 0.86 },
    mappedMarkSide: "left",
    allowRoomOverride: true,
    toolResults: [
      {
        action_id: "inventory-wrong-room-fast-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          count: 5,
          items: [
            {
              elementId: 9405,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { number: "405", name: "Live/Work Loft Unit", kind: "Space" },
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.00, minNormalizedY: 0.35, maxNormalizedX: 0.55, maxNormalizedY: 0.88 } },
              anchor: { image: { normalizedX: 0.30, normalizedY: 0.60, insideFrame: true } }
            },
            {
              elementId: 1405,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.04, normalizedY: 0.65, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 9407,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { number: "407", name: "Live/Work Unit", kind: "Space" },
              associatedSpatial: { number: "407", name: "Live/Work Unit", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.55, minNormalizedY: 0.35, maxNormalizedX: 1.00, maxNormalizedY: 0.88 } },
              anchor: { image: { normalizedX: 0.78, normalizedY: 0.60, insideFrame: true } }
            },
            {
              elementId: 1407,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ],
          summary: {
            roomCounts: [{ key: "407", count: 12 }, { key: "405", count: 5 }],
            spaceCounts: [{ key: "407", count: 11 }, { key: "405", count: 5 }]
          }
        }
      }
    ] as any
  });

  assert.equal(hydrated.room_number, "405");
  assert.equal(hydrated.spatial_side, "left");
});

test("fast electrical redline inventory hydration preserves explicit user room over adjacent evidence", () => {
  const targetProfile = {
    ...__testOnlyInferRedlineTargetingProfile({
      userText: "add receptacle in room 407 where indicated and circuit to same circuit as adjacent receptacle."
    }),
    room_number: "407"
  };

  const hydrated = __testOnlyHydrateTargetProfileFromVisibleInventory({
    targetProfile,
    semanticCorpus: "add receptacle in room 407 where indicated and circuit to same circuit as adjacent receptacle.",
    markHint: { normalized_x: 0.035, normalized_y: 0.655, side: "left", score: 0.86 },
    mappedMarkSide: "left",
    allowRoomOverride: false,
    toolResults: [
      {
        action_id: "inventory-explicit-room-407",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "frame-407",
          viewId: 1363337,
          items: [
            {
              elementId: 1405,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.04, normalizedY: 0.65, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as any
  });

  assert.equal(hydrated.room_number, "407");
});

test("redline execution bridge infers room from compacted visible inventory samples", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-405",
          viewId: 1363337,
          count: 3,
          itemsSampled: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameterGroups: { electrical: { panel: "P405", circuitNumber: "1" } }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { panel: "P405", circuitNumber: "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameterGroups: { electrical: { panel: "P407", circuitNumber: "1" } }
            }
          ],
          itemsOmitted: 0
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});

test("redline execution bridge infers room from compacted visible inventory summary when sampled devices lack room anchors", () => {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-405",
          viewId: 1363337,
          count: 80,
          itemsSampled: [
            {
              elementId: 9001,
              category: "Walls",
              builtInCategory: "OST_Walls",
              name: "Wall projection",
              anchor: { image: { normalizedX: 0.05, normalizedY: 0.5, insideFrame: true } }
            },
            {
              elementId: 9002,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              name: "Room tag leader",
              anchor: { image: { normalizedX: 0.5, normalizedY: 0.5, insideFrame: true } }
            }
          ],
          itemsOmitted: 78,
          summary: {
            categoryCounts: [
              { key: "OST_Walls", count: 20 },
              { key: "OST_GenericAnnotation", count: 16 }
            ],
            roomCounts: [
              { key: "405", count: 12 },
              { key: "407", count: 3 }
            ],
            spaceCounts: [
              { key: "405", count: 10 },
              { key: "407", count: 2 }
            ]
          }
        }
      }
    ] as any
  });

  assert.ok(response);
  assert.equal(response.actions[0]?.path, "/revit/rooms");
  assert.equal((response.actions[0]?.body as any)?.roomNumber, "405");
  assert.doesNotMatch(response.assistant_message, /no_pick_hints/i);
});
