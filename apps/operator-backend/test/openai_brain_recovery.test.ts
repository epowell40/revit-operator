import test from "node:test";
import assert from "node:assert/strict";
import {
  __testOnlyBuildCapabilityRecoveryResponse,
  __testOnlyExtractResponsesApiOutputText
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

test("codex instructions explicitly tell the sidecar not to stop at missing commands", () => {
  const instructions = getCodexBaseInstructionsForTest();
  assert.match(instructions, /Execution ladder:/);
  assert.match(instructions, /Do not stop with a vague statement like 'I can't find the command'/);
});

test("responses api text extraction still exports a compact helper", () => {
  const extracted = __testOnlyExtractResponsesApiOutputText({ output_text: "ok" });
  assert.equal(extracted, "ok");
});
