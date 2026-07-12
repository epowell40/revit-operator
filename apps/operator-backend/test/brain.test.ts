import test from "node:test";
import assert from "node:assert/strict";
import { __testOnlyFinalizeDecision, decide } from "../src/brain.js";
import { decideRule } from "../src/brains/rule_brain.js";
import { shouldOpenZippyBimTool } from "../src/brains/zippybim_intent.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";

function mkReq(text: string): ChatRequest {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "s",
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

test("office-standard room receptacle demo bypasses the general model loop", async () => {
  const res = await decide(mkReq("Lay out the receptacles in Room 403 based on our office standards."));
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
