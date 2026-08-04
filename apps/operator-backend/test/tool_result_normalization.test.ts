import assert from "node:assert/strict";
import test from "node:test";

import {
  __clearServerPlannedActionsForTests,
  normalizeIncomingToolResults,
  registerServerPlannedActions
} from "../src/revit_batch/tool_result_normalization.js";

test.beforeEach(() => __clearServerPlannedActionsForTests());

const conditionalForms = [
  { action_id: "lighting-fix", path: "/revit/lighting-audit", body: { command: "validate_ies", fix: true }, effect: "apply" },
  { action_id: "lighting-visualize", path: "/revit/lighting-audit", body: { command: "photometrics", visualize: true }, effect: "apply" },
  { action_id: "fire-fix", path: "/revit/fire-damper-audit", body: { command: "fix" }, effect: "apply" },
  { action_id: "types-rename", path: "/revit/list-element-types", body: { action: "rename_types" }, effect: "apply" },
  { action_id: "types-purge", path: "/revit/list-element-types", body: { action: "purge_unused_in_family" }, effect: "apply" },
  { action_id: "lighting-read", path: "/revit/lighting-audit", body: { command: "validate_ies", fix: false }, effect: "read" },
  { action_id: "fire-read", path: "/revit/fire-damper-audit", body: { command: "audit" }, effect: "read" },
  { action_id: "types-read", path: "/revit/list-element-types", body: { action: "list" }, effect: "read" },
  { action_id: "types-preview", path: "/revit/list-element-types", body: { action: "rename_types", dryRun: true }, effect: "preview" }
] as const;

function conditionalResult(form: (typeof conditionalForms)[number], requestEffect?: "read" | "preview" | "apply") {
  return {
    action_id: form.action_id,
    method: "POST" as const,
    path: form.path,
    ...(requestEffect ? { request_effect: requestEffect } : {}),
    status: "done" as const
  };
}

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

test("outcome-unknown tool results are retained and never remain retryable", () => {
  const normalized = normalizeIncomingToolResults([{
    action_id: "unknown-write",
    method: "POST",
    path: "/revit/update-schedule-cell",
    status: "done",
    retryable: true,
    outcome_unknown: true
  }], "unknown-write-session");

  assert.equal(normalized[0]?.status, "failed");
  assert.equal(normalized[0]?.outcome_unknown, true);
  assert.equal(normalized[0]?.retryable, false);
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

test("transaction plans remain previews with or without retained server plan state", () => {
  const action = {
    action_id: "transaction-plan-preview",
    method: "POST" as const,
    path: "/revit/transaction-plan",
    body: { actions: [{ method: "POST", path: "/revit/set-parameters" }] }
  };
  registerServerPlannedActions("session-a", [action]);

  const planned = normalizeIncomingToolResults([{
    action_id: action.action_id,
    method: action.method,
    path: action.path,
    status: "done"
  }], "session-a");
  assert.equal(planned[0]?.request_effect, "preview");

  const unplanned = normalizeIncomingToolResults([{
    action_id: "transaction-plan-after-restart",
    method: "POST" as const,
    path: "/revit/transaction-plan",
    status: "done" as const
  }], "session-without-plan");
  assert.equal(unplanned[0]?.request_effect, "preview");

  assert.throws(
    () => normalizeIncomingToolResults([{
      action_id: "transaction-plan-spoof",
      method: "POST" as const,
      path: "/revit/transaction-plan",
      request_effect: "apply" as const,
      status: "done" as const
    }], "session-without-plan"),
    /request_effect does not match server fail-closed policy/
  );
});

test("schedule inspection POSTs remain reads with or without retained server plan state", () => {
  const action = {
    action_id: "schedule-read",
    method: "POST" as const,
    path: "/revit/schedules",
    body: { action: "detail", scheduleId: 2284420, includeFields: true, includeData: true }
  };
  registerServerPlannedActions("session-a", [action]);

  const planned = normalizeIncomingToolResults([{
    action_id: action.action_id,
    method: action.method,
    path: action.path,
    status: "done"
  }], "session-a");
  assert.equal(planned[0]?.request_effect, "read");

  const unplanned = normalizeIncomingToolResults([{
    action_id: "schedule-read-after-restart",
    method: "POST" as const,
    path: "/revit/schedules",
    status: "done" as const
  }], "session-without-plan");
  assert.equal(unplanned[0]?.request_effect, "read");

  assert.throws(
    () => normalizeIncomingToolResults([{
      action_id: "schedule-read-spoof",
      method: "POST" as const,
      path: "/revit/schedules",
      request_effect: "apply" as const,
      status: "done" as const
    }], "session-without-plan"),
    /request_effect does not match server fail-closed policy/
  );
});

test("unplanned known read-only routes remain read-only but client effects are never authoritative", () => {
  const normalized = normalizeIncomingToolResults([{
    action_id: "legacy-result",
    method: "POST",
    path: "/revit/rooms",
    request_effect: "read",
    status: "done"
  }], "session-without-plan");
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0]?.path, "/revit/rooms");
  assert.equal(normalized[0]?.request_effect, "read");

  assert.throws(
    () => normalizeIncomingToolResults([{
      action_id: "spoofed-read",
      method: "POST",
      path: "/revit/rooms",
      request_effect: "apply",
      status: "done"
    }], "session-without-plan"),
    /request_effect does not match server fail-closed policy/
  );
});

test("planned conditional write, read, and preview forms retain body-aware effects", () => {
  registerServerPlannedActions("session-a", conditionalForms.map(form => ({
    action_id: form.action_id,
    method: "POST",
    path: form.path,
    body: form.body
  })));

  const normalized = normalizeIncomingToolResults(conditionalForms.map(form => conditionalResult(form)), "session-a");
  assert.deepEqual(normalized.map(result => result.request_effect), conditionalForms.map(form => form.effect));
});

test("conditional POSTs fail closed after server plan state is cleared", () => {
  registerServerPlannedActions("session-a", conditionalForms.map(form => ({
    action_id: form.action_id,
    method: "POST",
    path: form.path,
    body: form.body
  })));
  __clearServerPlannedActionsForTests();

  const normalized = normalizeIncomingToolResults(conditionalForms.map(form => conditionalResult(form)), "session-a");
  assert.deepEqual(normalized.map(result => result.request_effect), conditionalForms.map(() => "apply"));
});

test("conditional POSTs fail closed after their action records are evicted", () => {
  registerServerPlannedActions("session-a", conditionalForms.map(form => ({
    action_id: form.action_id,
    method: "POST",
    path: form.path,
    body: form.body
  })));
  registerServerPlannedActions("session-a", Array.from({ length: 1_000 }, (_, index) => ({
    action_id: `filler-${index}`,
    method: "POST",
    path: "/revit/rooms"
  })));

  const normalized = normalizeIncomingToolResults(conditionalForms.map(form => conditionalResult(form)), "session-a");
  assert.deepEqual(normalized.map(result => result.request_effect), conditionalForms.map(() => "apply"));
});

test("conditional POSTs fail closed after their session plan is evicted", () => {
  registerServerPlannedActions("oldest-session", conditionalForms.map(form => ({
    action_id: form.action_id,
    method: "POST",
    path: form.path,
    body: form.body
  })));
  for (let index = 0; index < 200; index += 1) {
    registerServerPlannedActions(`newer-session-${index}`, [{
      action_id: `filler-${index}`,
      method: "POST",
      path: "/revit/rooms"
    }]);
  }

  const normalized = normalizeIncomingToolResults(conditionalForms.map(form => conditionalResult(form)), "oldest-session");
  assert.deepEqual(normalized.map(result => result.request_effect), conditionalForms.map(() => "apply"));
});

test("spoofed client effects cannot downgrade conditional POSTs without plan authority", () => {
  for (const form of conditionalForms) {
    assert.throws(
      () => normalizeIncomingToolResults([conditionalResult(form, form.effect === "apply" ? "read" : form.effect)], "missing-session"),
      /request_effect does not match server fail-closed policy/,
      form.action_id
    );
  }
});

test("unknown action ids use conservative server policy instead of client authority", () => {
  registerServerPlannedActions("session-a", [{
    action_id: "known-action",
    method: "POST",
    path: "/revit/rooms"
  }]);

  const normalized = normalizeIncomingToolResults([
    { action_id: "unknown-conditional", method: "POST", path: "/revit/fire-damper-audit", status: "done" },
    { action_id: "unknown-read", method: "POST", path: "/revit/rooms", status: "done" },
    { action_id: "unknown-write", method: "POST", path: "/revit/unrecognized-route", status: "done" },
    { action_id: "unknown-get", method: "GET", path: "/revit/unrecognized-route", status: "done" }
  ], "session-a");

  assert.deepEqual(normalized.map(result => result.request_effect), ["apply", "read", "apply", "read"]);
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
