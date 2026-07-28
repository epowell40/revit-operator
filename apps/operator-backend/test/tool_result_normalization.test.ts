import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearServerPlannedActionsForTests,
  normalizeIncomingToolResults,
  registerServerPlannedActions
} from "../src/revit_batch/tool_result_normalization.js";

test.beforeEach(() => __clearServerPlannedActionsForTests());

test("conditional request effects come from the server-owned planned action body", () => {
  registerServerPlannedActions("session-a", [{
    action_id: "conditional-fix",
    method: "POST",
    path: "/revit/fire-damper-audit",
    body: { command: "fix" }
  }]);

  const normalized = normalizeIncomingToolResults([{
    action_id: "conditional-fix",
    method: "POST",
    path: "/revit/fire-damper-audit",
    status: "done",
    result_json: { ok: true }
  }], "session-a");
  assert.equal(normalized[0]?.request_effect, "apply");
});

test("client request_effect and transport substitutions cannot downgrade a planned conditional mutation", () => {
  registerServerPlannedActions("session-a", [{
    action_id: "conditional-fix",
    method: "POST",
    path: "/revit/fire-damper-audit",
    body: { command: "fix" }
  }]);

  assert.throws(
    () => normalizeIncomingToolResults([{
      action_id: "conditional-fix",
      method: "POST",
      path: "/revit/fire-damper-audit",
      request_effect: "read",
      status: "done"
    }], "session-a"),
    /request_effect does not match server-planned action/
  );
  assert.throws(
    () => normalizeIncomingToolResults([{
      action_id: "conditional-fix",
      method: "POST",
      path: "/revit/rooms",
      request_effect: "read",
      status: "done"
    }], "session-a"),
    /transport metadata does not match server-planned action/
  );
});

test("conditional reads and previews are also classified from their planned bodies", () => {
  registerServerPlannedActions("session-a", [
    { action_id: "audit", method: "POST", path: "/revit/fire-damper-audit", body: { command: "audit" } },
    { action_id: "preview", method: "POST", path: "/revit/list-element-types", body: { action: "rename_types", dryRun: true } }
  ]);
  const normalized = normalizeIncomingToolResults([
    { action_id: "audit", method: "POST", path: "/revit/fire-damper-audit", status: "done" },
    { action_id: "preview", method: "POST", path: "/revit/list-element-types", status: "done" }
  ], "session-a");
  assert.deepEqual(normalized.map(result => result.request_effect), ["read", "preview"]);
});

test("unplanned legacy results remain wire-compatible but client effects are never trusted", () => {
  const normalized = normalizeIncomingToolResults([{
    action_id: "legacy-result",
    method: "POST",
    path: "/revit/fire-damper-audit",
    request_effect: "read",
    status: "done"
  }], "session-without-plan");
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.path, "/revit/fire-damper-audit");
  assert.equal(normalized[0]?.request_effect, undefined);
});

test("planned action ids are scoped to their server session", () => {
  registerServerPlannedActions("session-a", [{
    action_id: "same-id",
    method: "POST",
    path: "/revit/fire-damper-audit",
    body: { command: "fix" }
  }]);
  registerServerPlannedActions("session-b", [{
    action_id: "same-id",
    method: "POST",
    path: "/revit/fire-damper-audit",
    body: { command: "audit" }
  }]);

  const a = normalizeIncomingToolResults([{ action_id: "same-id", method: "POST", path: "/revit/fire-damper-audit", status: "done" }], "session-a");
  const b = normalizeIncomingToolResults([{ action_id: "same-id", method: "POST", path: "/revit/fire-damper-audit", status: "done" }], "session-b");
  assert.equal(a[0]?.request_effect, "apply");
  assert.equal(b[0]?.request_effect, "read");
});
