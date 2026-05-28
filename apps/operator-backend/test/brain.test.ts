import test from "node:test";
import assert from "node:assert/strict";
import { __testOnlyFinalizeDecision, decide } from "../src/brain.js";
import { decideRule } from "../src/brains/rule_brain.js";
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
