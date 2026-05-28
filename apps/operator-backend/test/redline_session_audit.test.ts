import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRedlineSessionAudit } from "../src/benchmark/redline_session_audit.js";

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function tempSessionDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redline-session-audit-"));
}

test("redline session audit passes a complete hosted placement run bundle", () => {
  const sessionDir = tempSessionDir();
  writeJsonl(path.join(sessionDir, "request_log.jsonl"), [
    {
      kind: "user.turn",
      session_id: "session-ok",
      user_text: "add receptacle where indicated and circuit to same circuit as adjacent receptacle",
      user_attachments: [{ relative_path: "artifacts/uploads/clipboard.png", mime: "image/png" }]
    }
  ]);
  writeJsonl(path.join(sessionDir, "agent_log.jsonl"), [
    { kind: "assistant.turn", text: "Got it - I'll place and verify it." },
    { kind: "assistant.turn", text: "Placed and verified receptacle 6001 in room 405 on the adjacent source circuit." }
  ]);
  writeJsonl(path.join(sessionDir, "tool_calls.jsonl"), [
    { kind: "revit.action", action: { path: "/revit/export-visible-elements", body: { includeMapping: true } } },
    { kind: "revit.action", action: { path: "/revit/rooms", body: { roomNumber: "405" } } },
    { kind: "revit.action", action: { path: "/revit/rank-similar-devices-on-wall", body: { roomNumber: "405", roomSide: "left" } } },
    { kind: "revit.action", action: { path: "/revit/create-similar-from-instance", body: { dryRun: true, exemplarElementId: 5001 } } },
    { kind: "revit.action", action: { path: "/revit/create-similar-from-instance", body: { dryRun: false, exemplarElementId: 5001 } } },
    { kind: "revit.action", action: { path: "/revit/export-view-region", body: { elementIds: [6001] } } },
    { kind: "revit.action", action: { path: "/revit/audit-hosted-instance-placement", body: { elementIds: [6001] } } },
    { kind: "revit.action", action: { path: "/revit/get-parameters", body: { elementIds: [5001, 6001] } } }
  ]);
  writeJsonl(path.join(sessionDir, "tool_outputs.jsonl"), [
    { kind: "revit.result", tool_result: { path: "/revit/export-visible-elements", status: "done", result_json: { elements: [] } } },
    { kind: "revit.result", tool_result: { path: "/revit/rooms", status: "done", result_json: { rooms: [{ number: "405" }] } } },
    { kind: "revit.result", tool_result: { path: "/revit/rank-similar-devices-on-wall", status: "done", result_json: { candidates: [{ elementId: 5001 }] } } },
    { kind: "revit.result", tool_result: { path: "/revit/create-similar-from-instance", status: "done", result_json: { ok: true, dryRun: true } } },
    { kind: "revit.result", tool_result: { path: "/revit/create-similar-from-instance", status: "done", result_json: { ok: true, createdElementIds: [6001] } } },
    { kind: "revit.result", tool_result: { path: "/revit/export-view-region", status: "done", result_json: { imagePath: "capture.png" } } },
    { kind: "revit.result", tool_result: { path: "/revit/audit-hosted-instance-placement", status: "done", result_json: { ok: true, items: [{ elementId: 6001, roomNumber: "405" }] } } },
    {
      kind: "revit.result",
      tool_result: {
        path: "/revit/get-parameters",
        status: "done",
        result_json: { elements: [{ elementId: 6001, parameters: { Panel: "P405", "Circuit Number": "1" } }] }
      }
    }
  ]);

  const audit = buildRedlineSessionAudit({ sessionDir });

  assert.equal(audit.ok, true);
  assert.deepEqual(audit.summary.created_element_ids, [6001]);
  assert.equal(audit.summary.revit_action_count, 8);
});

test("redline session audit flags no-pick blockers and missing placement evidence", () => {
  const sessionDir = tempSessionDir();
  writeJsonl(path.join(sessionDir, "request_log.jsonl"), [
    {
      kind: "user.turn",
      session_id: "session-no-pick",
      user_text: "add receptacle where indicated",
      user_attachments: [{ relative_path: "artifacts/uploads/clipboard.png", mime: "image/png" }]
    }
  ]);
  writeJsonl(path.join(sessionDir, "agent_log.jsonl"), [
    { kind: "assistant.turn", text: "I exported the Revit view frame successfully, but the redline bridge still did not recover usable pick locations. blocked_reason=no_pick_hints." }
  ]);
  writeJsonl(path.join(sessionDir, "tool_calls.jsonl"), [
    { kind: "revit.action", action: { path: "/revit/export-view-frame", body: { viewId: 1391195 } } }
  ]);
  writeJsonl(path.join(sessionDir, "tool_outputs.jsonl"), [
    { kind: "revit.result", tool_result: { path: "/revit/export-view-frame", status: "done", result_json: { imagePath: "frame.png" } } }
  ]);

  const audit = buildRedlineSessionAudit({ sessionDir });
  const checks = new Map(audit.checks.map((entry) => [entry.key, entry]));

  assert.equal(audit.ok, false);
  assert.equal(checks.get("no_no_pick_blocker")?.passed, false);
  assert.equal(checks.get("create_similar_applied")?.passed, false);
  assert.equal(checks.get("hosted_audit_done")?.passed, false);
});
