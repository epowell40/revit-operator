import test from "node:test";
import assert from "node:assert/strict";
import { enforceVerificationDisclaimer } from "../src/verification/titleblock_verify_guard.js";

test("enforceVerificationDisclaimer appends Not verified when titleblock apply lacks evidence", () => {
  const req: any = {
    session_id: "s",
    message_id: "m",
    user_text: "",
    tool_results: [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/set-parameter",
        status: "done",
        result_json: { dryRun: false, titleblockImpacts: [{ sheetViewId: 123 }] }
      }
    ]
  };

  const decision: any = { assistant_message: "Answer: Done.", actions: [], web_requests: [] };
  const out = enforceVerificationDisclaimer(req, decision);
  assert.match(out.assistant_message, /Not verified/i);
});

test("enforceVerificationDisclaimer does not append when evidence exists", () => {
  const req: any = {
    session_id: "s",
    message_id: "m",
    user_text: "",
    tool_results: [
      {
        action_id: "a1",
        method: "POST",
        path: "/revit/set-parameter",
        status: "done",
        result_json: { dryRun: false, titleblockImpacts: [{ sheetViewId: 123 }] }
      },
      {
        action_id: "a2",
        method: "POST",
        path: "/revit/capture-sheet-region",
        status: "done",
        attachments: [{ kind: "image", local_path: "x.png" }],
        result_json: {}
      }
    ]
  };

  const decision: any = { assistant_message: "Answer: Done.", actions: [], web_requests: [] };
  const out = enforceVerificationDisclaimer(req, decision);
  assert.equal(out.assistant_message, decision.assistant_message);
});

