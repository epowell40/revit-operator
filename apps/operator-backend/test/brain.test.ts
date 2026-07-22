import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testOnlyFinalizeDecision, __testOnlyIsBridgeStatusQuestion, __testOnlyIsExistingConditionsReconstructionRequest, __testOnlyMaybeBuildPersistedExistingConditionsTerminal, __testOnlyMaybeRunSemanticAecWorkflow, __testOnlyMaybeRunTopLevelMepRouteRedline, __testOnlyMaybeRunTopLevelSemanticAecWorkflow, decide } from "../src/brain.js";
import { AEC_TASK_INTENT_V1_SCHEMA } from "../src/aec_task_intent.js";
import { decideRule } from "../src/brains/rule_brain.js";
import { shouldOpenZippyBimTool } from "../src/brains/zippybim_intent.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../src/contracts.js";
import { appendEvent } from "../src/memory/sqlite_store.js";
import { existingConditionsExecutionLedgerPath } from "../src/existing_conditions/one_action_execution_ledger.js";

const testRunId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let testRequestSequence = 0;

function mkReq(text: string): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: `brain-test-${testRunId}-${++testRequestSequence}`,
    message_id: "m",
    user_text: text
  };
}

test("ping maps to /revit/ping", async () => {
  const res = await decideRule(mkReq("ping"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "GET");
  assert.equal(res.actions[0]?.path, "/revit/ping");
});

test("bridge status question pings bridge without opening Revit", async () => {
  const res = await decide(mkReq("is the Revit bridge open?"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "GET");
  assert.equal(res.actions[0]?.path, "/revit/ping");
  assert.doesNotMatch(JSON.stringify(res.actions), /open-model|2026|launch/i);
});

test("bridge running question pings bridge without opening Revit", async () => {
  const res = await decide(mkReq("can you check if the revit bridge is running"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "GET");
  assert.equal(res.actions[0]?.path, "/revit/ping");
  assert.doesNotMatch(JSON.stringify(res.actions), /open-model|2026|launch/i);
});

test("bridge-only status question pings bridge without opening Revit", async () => {
  const res = await decide(mkReq("can you see whether the bridge is responsive now?"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "GET");
  assert.equal(res.actions[0]?.path, "/revit/ping");
  assert.doesNotMatch(JSON.stringify(res.actions), /open-model|2026|launch/i);
});

test("equipment systems and best-view query is not misclassified as bridge status", () => {
  const prompt = "Where is HRU403? Return its exact element identity, family and type, level, room or space, connected systems, and best Revit view. Read only; do not modify the model.";
  assert.equal(__testOnlyIsBridgeStatusQuestion(prompt), false);
  assert.equal(__testOnlyIsBridgeStatusQuestion("Is the Revit bridge connected?"), true);
  assert.equal(__testOnlyIsBridgeStatusQuestion("Can you check whether Revit is reachable?"), true);
});

test("office-standard room receptacle demo bypasses the general model loop", async () => {
  const res = await __testOnlyMaybeRunSemanticAecWorkflow(mkReq("Lay out the receptacles in Room 403 based on our office standards."), { async interpret() { return {
    schema: AEC_TASK_INTENT_V1_SCHEMA, operation: "layout", object_class: "receptacle",
    target: { document: null, view: null, room_number: "403", element_ids: [] },
    reference: { kind: "office_standard", room_number: null }, mutation: { kind: "create", requested: true },
    spatial_constraints: [], confidence: { value: 0.98, ambiguity: "none", reasons: ["explicit"] }, evidence: { user_text: "replaced by authoritative request" }
  }; } });
  assert.ok(res);
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "POST");
  assert.equal(res.actions[0]?.path, "/revit/plan-room-receptacles-from-analog");
  assert.deepEqual(res.actions[0]?.body, { targetRoomNumber: "403", includePreviewImage: true });
});

test("capture maps to /revit/export-image", async () => {
  const res = await decideRule(mkReq("capture view"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "POST");
  assert.equal(res.actions[0]?.path, "/revit/export-image");
});

test("snapshot maps to /revit/state-snapshot", async () => {
  const res = await decideRule(mkReq("state snapshot"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "POST");
  assert.equal(res.actions[0]?.path, "/revit/state-snapshot");
});

test("tool host demo maps to /ui/open", async () => {
  const res = await decideRule(mkReq("open tool host demo"));
  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "POST");
  assert.equal(res.actions[0]?.path, "/ui/open");
  const body = res.actions[0]?.body as { allowedBackendPaths?: string[] } | undefined;
  assert.deepEqual(body?.allowedBackendPaths, ["/health"]);
});

test("pdf floor plan import with attachment opens the zippybim tool", async () => {
  const res = await decide({
    ...mkReq("can you please import this pdf floor plan? thanks."),
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/sample-floor-plan.pdf",
        filename: "sample-floor-plan.pdf",
        mime: "application/pdf"
      }
    ]
  });

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.method, "POST");
  assert.equal(res.actions[0]?.path, "/ui/open");

  const body = res.actions[0]?.body as {
    url?: string;
    allowedBackendPaths?: string[];
    initialPayload?: { attachments?: Array<{ relative_path?: string }> };
  } | undefined;

  assert.match(String(body?.url || ""), /^\/ui\/zippybim-import\?v=/);
  assert.deepEqual(body?.allowedBackendPaths, ["/tools/zippybim/*"]);
  assert.equal(body?.initialPayload?.attachments?.[0]?.relative_path, "artifacts/uploads/sample-floor-plan.pdf");
});

test("redline MEP PDF prompt does not open the zippybim floor plan import tool", async () => {
  const shouldOpen = shouldOpenZippyBimTool({
    ...mkReq("pick up attached redline: 12x10 supply duct on the floor plan"),
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/marked.pdf",
        filename: "marked.pdf",
        mime: "application/pdf"
      }
    ]
  });

  assert.equal(shouldOpen, false);
});

test("explicit existing-conditions reconstruction bypasses the deterministic redline resolver", async () => {
  let calls = 0;
  const req = {
    ...mkReq("Reconstruct the existing conditions in Unit 403 from this unmarked source PDF."),
    session_id: "existing-conditions-text",
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/source-evidence.pdf",
        filename: "source-evidence.pdf",
        mime: "application/pdf"
      }
    ]
  } satisfies ChatRequest;

  const result = await __testOnlyMaybeRunTopLevelMepRouteRedline(req, async () => {
    calls += 1;
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "redline", actions: [] };
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("strict existing-conditions bridge action bypasses the configured provider", { concurrency: false }, async () => {
  const previousBrain = process.env.OPERATOR_BRAIN;
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-explicit-action-route-"));
  process.env.OPERATOR_BRAIN = "gemini";
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  let providerCalls = 0;
  try {
    const req = {
      ...mkReq(
        'Continue the existing-conditions reconstruction. Perform exactly one POST /revit/get-element-summary with body {"elementIds":[101,102]}. Do not run another action.'
      ),
      context: {
        workflow_intent: "existing_conditions_reconstruction",
        revit: {
          document_title: "candidate",
          document_path: "C:\\workspace\\candidate.rvt"
        }
      }
    } satisfies ChatRequest;
    const result = await decide(req, {
      geminiBrain: async () => {
        providerCalls += 1;
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: "provider should not run",
          actions: []
        };
      }
    });
    assert.equal(providerCalls, 0);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.path, "/revit/get-element-summary");
    assert.deepEqual(result.actions[0]?.body, { elementIds: [101, 102] });
  } finally {
    if (previousBrain === undefined) delete process.env.OPERATOR_BRAIN;
    else process.env.OPERATOR_BRAIN = previousBrain;
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("natural recreate and draft existing-conditions phrasing bypasses the deterministic redline resolver", async () => {
  const prompts = [
    "Using only the attached PDF, recreate the source-visible plumbing existing conditions around fixture FIXTURE-A.",
    "Draft the existing conditions from this record drawing PDF.",
    "Model the existing conditions based on the attached scanned sheet."
  ];

  for (const [index, prompt] of prompts.entries()) {
    let calls = 0;
    const req = {
      ...mkReq(prompt),
      session_id: `existing-conditions-natural-${index}`,
      user_attachments: [
        {
          id: `pdf-${index}`,
          relative_path: `artifacts/uploads/source-${index}.pdf`,
          filename: `source-${index}.pdf`,
          mime: "application/pdf"
        }
      ]
    } satisfies ChatRequest;

    const result = await __testOnlyMaybeRunTopLevelMepRouteRedline(req, async () => {
      calls += 1;
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "redline", actions: [] };
    });

    assert.equal(result, null);
    assert.equal(calls, 0);
  }
});

test("existing-conditions intent persists across empty tool-result continuation turns", async () => {
  const initial = { ...mkReq("Existing conditions reconstruction, not a redline."), session_id: "existing-conditions-continuation" };
  assert.equal(__testOnlyIsExistingConditionsReconstructionRequest(initial), true);

  let calls = 0;
  const continuation = {
    ...mkReq(""),
    session_id: initial.session_id,
    message_id: "m-continuation",
    tool_results: []
  } satisfies ChatRequest;
  const result = await __testOnlyMaybeRunTopLevelMepRouteRedline(continuation, async () => {
    calls += 1;
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "redline", actions: [] };
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("persisted existing-conditions history survives an empty in-memory session cache", async () => {
  const sessionId = `existing-conditions-persisted-${Date.now()}`;
  appendEvent(sessionId, "user", "chat.message", {
    text: "Draft the existing conditions from this record drawing PDF."
  });

  const continuation = {
    ...mkReq("Continue from exact view 3960410 and report the alignment diagnostic."),
    session_id: sessionId,
    message_id: "m-persisted-continuation"
  } satisfies ChatRequest;

  let calls = 0;
  const result = await __testOnlyMaybeRunTopLevelSemanticAecWorkflow(
    continuation,
    async () => {
      calls += 1;
      return {
        version: OPERATOR_BACKEND_CONTRACT_VERSION,
        assistant_message: "semantic",
        actions: []
      };
    }
  );

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("persisted alignment terminal is replayed instead of allowing generic planner recovery", () => {
  const sessionId = `existing-conditions-terminal-${Date.now()}`;
  const terminal =
    "The exact-frame native landmark inventory completed, but the current structured alignment failed crop_residual_exceeded. " +
    "Diagnostic: {\"maximum_allowed_crop_residual\":0.08} " +
    "I stopped before source-local compilation instead of restarting generic discovery.";
  appendEvent(sessionId, "user", "chat.message", {
    text: "Draft the existing conditions from this record drawing PDF."
  });
  appendEvent(sessionId, "assistant", "chat.message", { text: terminal });

  const result = __testOnlyMaybeBuildPersistedExistingConditionsTerminal({
    ...mkReq("Continue from the exact view and report the diagnostic. Do not retry or rerun discovery."),
    session_id: sessionId,
    message_id: "m-terminal-continuation"
  });

  assert.equal(result?.assistant_message, terminal);
  assert.deepEqual(result?.actions, []);
});

test("explicit non-negated retry can leave the persisted alignment terminal", () => {
  const sessionId = `existing-conditions-terminal-retry-${Date.now()}`;
  appendEvent(sessionId, "user", "chat.message", {
    text: "Draft the existing conditions from this record drawing PDF."
  });
  appendEvent(sessionId, "assistant", "chat.message", {
    text:
      "The exact-frame native landmark inventory completed, but the current structured alignment failed crop_residual_exceeded. " +
      "I stopped before source-local compilation instead of restarting generic discovery."
  });

  const result = __testOnlyMaybeBuildPersistedExistingConditionsTerminal({
    ...mkReq("Retry with a fresh frame."),
    session_id: sessionId,
    message_id: "m-terminal-retry"
  });

  assert.equal(result, null);
});

test("workflow intent context bypasses the deterministic redline resolver", async () => {
  const req = {
    ...mkReq("Use the attached PDF as source evidence."),
    session_id: "existing-conditions-context",
    context: { benchmark: { workflow_intent: "existing_conditions_reconstruction" } }
  } satisfies ChatRequest;

  assert.equal(__testOnlyIsExistingConditionsReconstructionRequest(req), true);
});

test("persisted request log restores existing-conditions session routing after restart", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-existing-routing-"));
  try {
    const sessionId = `persisted-existing-routing-${Date.now()}-${Math.random()}`;
    const sessionDir = path.dirname(existingConditionsExecutionLedgerPath(sessionId));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "request_log.jsonl"), `${JSON.stringify({
      kind: "user.turn",
      session_id: sessionId,
      user_text: "Start a staged existing-conditions reconstruction from the attached source drawing."
    })}\n`, "utf8");

    assert.equal(__testOnlyIsExistingConditionsReconstructionRequest({
      ...mkReq("Perform exactly one native readback action for element 101."),
      session_id: sessionId
    }), true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("existing-conditions reconstruction bypasses the semantic AEC query registry", async () => {
  let calls = 0;
  const req = {
    ...mkReq("Query bounded native elements for this existing-conditions reconstruction."),
    session_id: "existing-conditions-semantic-bypass",
    context: { workflow_intent: "existing_conditions_reconstruction" }
  } satisfies ChatRequest;

  const result = await __testOnlyMaybeRunTopLevelSemanticAecWorkflow(req, async () => {
    calls += 1;
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "semantic", actions: [] };
  });

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("genuine MEP redline requests still invoke the deterministic redline resolver", async () => {
  let calls = 0;
  const req = {
    ...mkReq("Pick up the attached redline: add the 12 x 10 supply duct where marked."),
    session_id: "genuine-redline",
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/marked.pdf",
        filename: "marked.pdf",
        mime: "application/pdf"
      }
    ]
  } satisfies ChatRequest;
  const expected: ChatResponse = { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: "redline", actions: [] };
  const result = await __testOnlyMaybeRunTopLevelMepRouteRedline(req, async () => {
    calls += 1;
    return expected;
  });

  assert.equal(result, expected);
  assert.equal(calls, 1);
});

test("finalizeDecision replaces blank no-op responses with a fallback explanation", () => {
  const req = {
    ...mkReq("add receptacles where indicated"),
    user_attachments: [
      {
        id: "img-1",
        relative_path: "artifacts/uploads/clipboard.png",
        filename: "clipboard.png",
        mime: "image/png"
      }
    ]
  };

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /internal fallback response/i);
  assert.match(res.assistant_message, /attachment turn/i);
});

test("finalizeDecision blocks text-only completion for modeled duct redlines", () => {
  const req = {
    ...mkReq("Pick up the attached marked.pdf redline: add the 11 x 10 SOUND LINED supply duct near Unit 405."),
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/marked.pdf",
        filename: "marked.pdf",
        mime: "application/pdf"
      }
    ]
  };

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "I will add the redline pickup note.",
    actions: [
      {
        action_id: "text-1",
        method: "POST",
        path: "/revit/create-text",
        body: { text: "11 x 10 SOUND LINED" }
      }
    ]
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /modeled MEP\/ductwork/i);
  assert.match(res.assistant_message, /text note/i);
});

test("finalizeDecision blocks false done messages for modeled duct redlines without model evidence", () => {
  const req = {
    ...mkReq("Pick up the marked.pdf redline for the 11 x 10 SOUND LINED duct."),
    tool_results: [
      {
        action_id: "find-note",
        method: "POST",
        path: "/revit/find-text-notes",
        status: "done",
        result_json: {
          matches: [
            {
              elementId: 1542918,
              category: "Text Notes",
              text: "11 x 10 SOUND LINED"
            }
          ]
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I picked up the redline and created the 11 x 10 SOUND LINED duct note.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /not valid completion/i);
});

test("finalizeDecision preserves read-only discovery actions for modeled PDF reconstruction", () => {
  const req = {
    ...mkReq("Using the attached P1.01.pdf, recreate the visible pipe and fixture existing conditions."),
    user_attachments: [
      {
        id: "pdf-1",
        relative_path: "artifacts/uploads/P1.01.pdf",
        filename: "P1.01.pdf",
        mime: "application/pdf"
      }
    ]
  };

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "I created a bounded plan and will inspect sheet P1.01.",
    actions: [
      {
        action_id: "sheet-detail",
        method: "POST",
        path: "/revit/sheets",
        body: { action: "detail", sheetNumber: "P1.01", includeViewportGeometry: true }
      }
    ]
  });

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.path, "/revit/sheets");
  assert.match(res.assistant_message, /continuing with read-only/i);
});

test("finalizeDecision allows explicit annotation-only duct notes but labels them as not modeled pickup", () => {
  const req = mkReq(
    "Add a red text note for the duct redline reading 11 x 10 SOUND LINED; this is annotation only, not a model element."
  );

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "I will place the requested note.",
    actions: [
      {
        action_id: "text-1",
        method: "POST",
        path: "/revit/create-text",
        body: { text: "11 x 10 SOUND LINED" }
      }
    ]
  });

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.path, "/revit/create-text");
  assert.match(res.assistant_message, /annotation-only work/i);
  assert.match(res.assistant_message, /does not satisfy a modeled ductwork pickup/i);
});

test("finalizeDecision allows modeled duct workflow actions for duct redlines", () => {
  const req = mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405.");

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "I have enough bounded context to place the duct route.",
    actions: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        body: { kind: "duct", ductSize: "11 x 10", apply: true }
      }
    ]
  });

  assert.equal(res.actions.length, 1);
  assert.equal(res.actions[0]?.path, "/revit/mep-route-workflow");
  assert.doesNotMatch(res.assistant_message, /not valid completion/i);
});

test("finalizeDecision requires returned model element ids before completing duct redlines", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          dryRun: true,
          plannedSegments: 3
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /must create or modify an HVAC model element/i);
  assert.match(res.assistant_message, /element id/i);
});

test("finalizeDecision requires passing visual gate before completing modeled redlines", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          createdElementIds: [1543081],
          verification: {
            created_category: "Ducts"
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created and verified the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /passing visual verification gate/i);
});

test("finalizeDecision blocks modeled redline completion when visual gate fails", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          createdElementIds: [1543081],
          verification: {
            visual_gate: {
              status: "fail",
              action_type: "duct_route",
              authority: "deterministic_geometry",
              confidence: 0.95,
              reason: "Route is in the wrong north/south band."
            }
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created and verified the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /gate is `fail`, `uncertain`, or missing/i);
});

test("finalizeDecision rejects contradictory visual gate pass with failed assertions", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          createdElementIds: [1543081],
          verification: {
            visual_gate: {
              status: "pass",
              action_type: "duct_route",
              authority: "deterministic_geometry",
              confidence: 0.9,
              evidence: {
                after_capture_path: "artifacts/captures/after.jpg"
              },
              assertions: [
                {
                  name: "post_change_capture_differs_from_before",
                  status: "fail",
                  reason: "Post-change visual verification reused the before-capture artifact."
                }
              ],
              reason: "Contradictory pass."
            }
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created and verified the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /passing visual verification gate/i);
});

test("finalizeDecision rejects visual gate pass without post-change capture evidence", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          createdElementIds: [1543081],
          verification: {
            visual_gate: {
              status: "pass",
              action_type: "duct_route",
              authority: "deterministic_geometry",
              confidence: 0.9,
              reason: "Missing capture evidence."
            }
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created and verified the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /passing visual verification gate/i);
});

test("finalizeDecision allows modeled redline completion with model ids and passing visual gate", () => {
  const req = {
    ...mkReq("Pick up the redline and create the 11 x 10 SOUND LINED supply duct near Unit 405."),
    tool_results: [
      {
        action_id: "mep-1",
        method: "POST",
        path: "/revit/mep-route-workflow",
        status: "done",
        result_json: {
          createdElementIds: [1543081],
          verification: {
            visual_gate: {
              status: "pass",
              action_type: "duct_route",
              authority: "deterministic_geometry",
              confidence: 0.9,
              evidence: {
                after_capture_path: "artifacts/captures/after.jpg"
              },
              reason: "Deterministic geometry and post-change visual evidence satisfy the redline verification gate."
            }
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I created and verified the 11 x 10 supply duct route.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.doesNotMatch(res.assistant_message, /stopped this redline pickup/i);
});

test("finalizeDecision accepts separate verify-visual gate result after modeled redline write", () => {
  const req = {
    ...mkReq("Pick up the attached redline and place the receptacle where marked."),
    tool_results: [
      {
        action_id: "place-1",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          createdElementIds: [1735601]
        }
      },
      {
        action_id: "gate-1",
        method: "POST",
        path: "/tools/redline/verify-visual",
        status: "done",
        result_json: {
          ok: true,
          gate: {
            status: "pass",
            action_type: "device_placement",
            authority: "hybrid",
            confidence: 0.9,
            evidence: {
              after_capture_path: "artifacts/captures/receptacle-after.jpg"
            },
            reason: "Created device is on the requested wall mark."
          }
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I placed and verified receptacle 1735601.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.doesNotMatch(res.assistant_message, /stopped this redline pickup/i);
});

test("finalizeDecision applies visual gate requirement to receptacle redline wording", () => {
  const req = {
    ...mkReq("Pick up the redline and place the receptacle where marked."),
    tool_results: [
      {
        action_id: "place-1",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          createdElementIds: [1735601]
        }
      }
    ]
  } satisfies ChatRequest;

  const res = __testOnlyFinalizeDecision(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Done - I placed and verified receptacle 1735601.",
    actions: []
  });

  assert.equal(res.actions.length, 0);
  assert.match(res.assistant_message, /passing visual verification gate/i);
});
