import assert from "node:assert/strict";
import test from "node:test";

import {
  __testOnlyClassifyActionAsWrite,
  __testOnlyCollectRecentPostWriteEvidence,
  __testOnlyToolResultLooksReadOnly
} from "../src/brains/openai_brain.js";
import type { ActionCall, ToolResult } from "../src/contracts.js";

function action(path: string, body: unknown): ActionCall {
  return { action_id: `action:${path}`, method: "POST", path, body };
}

function result(path: string, request_effect: ToolResult["request_effect"]): ToolResult {
  return {
    action_id: `result:${path}:${request_effect}`,
    method: "POST",
    path,
    request_effect,
    status: "done",
    result_json: { ok: true }
  };
}

test("OpenAI action-level decisions inspect conditional request bodies", () => {
  for (const [path, body] of [
    ["/revit/fire-damper-audit", { command: "audit" }],
    ["/revit/lighting-audit", { command: "validate_ies", fix: false }],
    ["/revit/list-element-types", { action: "list" }]
  ] as const) {
    assert.equal(__testOnlyClassifyActionAsWrite(action(path, body)), false, `${path} read body`);
  }

  for (const [path, body] of [
    ["/revit/fire-damper-audit", { command: "fix" }],
    ["/revit/lighting-audit", { command: "photometrics", visualize: true }],
    ["/revit/list-element-types", { action: "rename_types", dryRun: true }],
    ["/revit/list-element-types", { action: "purge_unused_in_family" }]
  ] as const) {
    assert.equal(__testOnlyClassifyActionAsWrite(action(path, body)), true, `${path} mutation body`);
  }
});

test("post-execution decisions honor preserved request effect instead of bodyless path defaults", () => {
  const readResult = result("/revit/fire-damper-audit", "read");
  const previewResult = result("/revit/list-element-types", "preview");
  const applyResult = result("/revit/lighting-audit", "apply");

  assert.equal(__testOnlyToolResultLooksReadOnly(readResult), true);
  assert.equal(__testOnlyToolResultLooksReadOnly(previewResult), false);
  assert.equal(__testOnlyToolResultLooksReadOnly(applyResult), false);

  assert.equal(__testOnlyCollectRecentPostWriteEvidence([readResult]).has_applied_write, false);
  assert.equal(__testOnlyCollectRecentPostWriteEvidence([previewResult]).has_applied_write, false);
  assert.equal(__testOnlyCollectRecentPostWriteEvidence([applyResult]).has_applied_write, true);
});

test("legacy tool results remain wire-compatible and use path fallback", () => {
  const legacyRead: ToolResult = {
    action_id: "legacy-read",
    method: "POST",
    path: "/revit/rooms",
    status: "done",
    result_json: { rooms: [] }
  };
  const legacyConditional: ToolResult = {
    action_id: "legacy-conditional",
    method: "POST",
    path: "/revit/fire-damper-audit",
    status: "done",
    result_json: { ok: true }
  };

  assert.equal(__testOnlyToolResultLooksReadOnly(legacyRead), true);
  assert.equal(__testOnlyToolResultLooksReadOnly(legacyConditional), true);
});
