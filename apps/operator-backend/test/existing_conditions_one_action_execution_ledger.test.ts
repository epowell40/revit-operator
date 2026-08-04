import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "../src/contracts.js";
import {
  enforceExistingConditionsOneActionLoop,
  existingConditionsExecutionLedgerPath,
  maybeBuildExplicitExistingConditionsAction,
  maybeContinueExistingConditionsOneActionLoop,
  readExistingConditionsExecutionLedger
} from "../src/existing_conditions/one_action_execution_ledger.js";
import {
  readExistingConditionsRepairLedger,
  registerExistingConditionsStagedWorkflow
} from "../src/existing_conditions/staged_repair_ledger.js";

function writeVisualArtifact(workspaceRoot: string, fileName: unknown): string {
  const artifactPath = path.join(workspaceRoot, "artifacts", "captures", String(fileName));
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  return artifactPath;
}

function writeCheckpointArtifact(filePath: unknown): string {
  const artifactPath = String(filePath);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, "RVT checkpoint bytes", "utf8");
  return artifactPath;
}

function request(
  sessionId: string,
  toolResults: ChatRequest["tool_results"] = [],
  context?: unknown
): ChatRequest {
  return {
    version: "operator.backend.v1",
    session_id: sessionId,
    message_id: `message-${Date.now()}`,
    user_text: "Continue the existing conditions reconstruction.",
    tool_results: toolResults,
    ...(context === undefined ? {} : { context })
  };
}

function documentContext(name: string): unknown {
  return {
    workflow_intent: "existing_conditions_reconstruction",
    revit: {
      document_title: name,
      document_path: `C:\\workspace\\${name}.rvt`
    }
  };
}

test("strict exact-action request becomes one deterministic bridge action", () => {
  const decision = maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "explicit-action-session",
    message_id: "explicit-action-message",
    user_text:
      'Reference grading only. Perform exactly one POST /revit/get-element-summary with body {"elementIds":[16236085,16236086,15965039],"note":"brace } stays quoted"}. Do not replay another action.'
  });

  assert.ok(decision);
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0]?.method, "POST");
  assert.equal(decision.actions[0]?.path, "/revit/get-element-summary");
  assert.deepEqual(decision.actions[0]?.body, {
    elementIds: [16236085, 16236086, 15965039],
    note: "brace } stays quoted"
  });
  assert.match(decision.assistant_message, /provider planning is bypassed/i);
});

test("literal call request bypasses provider planning for the exact connector path", () => {
  const decision = maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "literal-connector-action-session",
    message_id: "literal-connector-action-message",
    user_text:
      'Read-only check. Call POST /revit/get-connectors with body {"elementIds":[1484508,1484814,1716442],"includeAllRefs":true,"includeCoordinateSystem":true}. This is read-only. Do not use /revit/find-elements-by-parameter.'
  });

  assert.ok(decision);
  assert.equal(decision.actions.length, 1);
  assert.equal(decision.actions[0]?.method, "POST");
  assert.equal(decision.actions[0]?.path, "/revit/get-connectors");
  assert.deepEqual(decision.actions[0]?.body, {
    elementIds: [1484508, 1484814, 1716442],
    includeAllRefs: true,
    includeCoordinateSystem: true
  });
  assert.match(decision.assistant_message, /provider planning is bypassed/i);
});

test("literal call parser rejects explanatory and negated path mentions", () => {
  assert.equal(maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "explanatory-call-session",
    message_id: "explanatory-call-message",
    user_text: "Why did the previous agent call POST /revit/get-connectors with body {\"elementIds\":[1]}?"
  }), null);
  assert.equal(maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "negated-call-session",
    message_id: "negated-call-message",
    user_text: "Do not call POST /revit/get-connectors with body {\"elementIds\":[1]}."
  }), null);
});

test("strict exact-action parser rejects malformed or continuation requests", () => {
  assert.equal(maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "malformed-explicit-action-session",
    message_id: "malformed-explicit-action-message",
    user_text: 'Perform exactly one POST /revit/get-element-summary with body {"elementIds":[1,2]'
  }), null);
  assert.equal(maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "continuation-explicit-action-session",
    message_id: "continuation-explicit-action-message",
    user_text: "Perform exactly one GET /revit/context.",
    tool_results: [{
      action_id: "prior",
      method: "GET",
      path: "/revit/context",
      status: "done"
    }]
  }), null);
});

test("completed strict exact action terminates without provider continuation", () => {
  const decision = maybeBuildExplicitExistingConditionsAction({
    version: "operator.backend.v1",
    session_id: "completed-explicit-action-session",
    message_id: "completed-explicit-action-message",
    user_text: "",
    tool_results: [{
      action_id: "explicit-0123456789abcdef01234567",
      method: "POST",
      path: "/revit/get-element-summary",
      status: "done",
      result_json: [{ id: 101, found: true }]
    }]
  });
  assert.ok(decision);
  assert.equal(decision.actions.length, 0);
  assert.match(decision.assistant_message, /completed/i);
  assert.match(decision.assistant_message, /No further action was dispatched/i);
});

test("natural single bounded export is provider-agnostic, durable, and terminal after one result", () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-one-bounded-export-"));
  try {
    const sessionId = `one-bounded-export-${Date.now()}`;
    const initial = enforceExistingConditionsOneActionLoop({
      req: {
        version: "operator.backend.v1",
        session_id: sessionId,
        message_id: "bounded-export-turn",
        user_text: "Run exactly one bounded export for this area. Do not retry or repeat it.",
        tool_results: []
      },
      decision: {
        version: "operator.backend.v1",
        assistant_message: "I will prepare and run the export.",
        actions: [
          { action_id: "catalog", method: "POST", path: "/revit/tool-search", body: { query: "export-visible-elements" } },
          { action_id: "bounded-export", method: "POST", path: "/revit/export-visible-elements", body: { viewId: 100, modelBounds: [0, 0, 0, 10, 10, 10] } },
          { action_id: "wider-export", method: "POST", path: "/revit/export-visible-elements", body: { viewId: 100, modelBounds: [-10, -10, 0, 20, 20, 10] } }
        ]
      }
    });
    assert.deepEqual(initial.actions.map(action => action.action_id), ["bounded-export"]);
    assert.doesNotMatch(JSON.stringify(initial.actions), /tool-search|wider-export/i);

    const terminal = maybeContinueExistingConditionsOneActionLoop({
      version: "operator.backend.v1",
      session_id: sessionId,
      message_id: "bounded-export-turn:continuation",
      user_text: "",
      tool_results: [{
        action_id: "bounded-export",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: { count: 26, truncated: false }
      }]
    });
    assert.ok(terminal);
    assert.deepEqual(terminal.actions, []);
    assert.match(terminal.assistant_message, /single bounded export completed/i);
    assert.match(terminal.assistant_message, /stopped before any retry or follow-on read/i);

    const newTurn = enforceExistingConditionsOneActionLoop({
      req: {
        version: "operator.backend.v1",
        session_id: sessionId,
        message_id: "new-user-turn",
        user_text: "Now inspect the registered connectors.",
        tool_results: []
      },
      decision: {
        version: "operator.backend.v1",
        assistant_message: "Inspecting connectors.",
        actions: [{ action_id: "connectors-new-turn", method: "POST", path: "/revit/get-connectors", body: { elementIds: [1] } }]
      }
    });
    assert.deepEqual(newTurn.actions.map(action => action.action_id), ["connectors-new-turn"]);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

function response(actions: ChatResponse["actions"]): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: "Continue one repairable step.",
    actions
  };
}

test("compile-only workflow cannot be advanced by the outer one-action loop", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-compile-only-boundary-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "compile-only-outer-loop";
    const workflow = {
      inputFingerprintSha256: "c".repeat(64),
      provisionalObservationIds: ["backbone-1"],
      operations: [{
        action_key: "route:backbone-1",
        observation_ids: ["backbone-1"],
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
    } as any;
    registerExistingConditionsStagedWorkflow({
      sessionId,
      sourceFrameId: "frame-compile-only",
      sourceViewId: 42,
      registrationContextId: "registration-compile-only",
      executionBoundary: "compile_only",
      workflow
    });

    assert.equal(
      maybeContinueExistingConditionsOneActionLoop(request(sessionId)),
      null
    );
    const compileReceipt: ChatResponse = {
      version: "operator.backend.v1",
      assistant_message: "Compiled read-only; no dry-run or write was dispatched.",
      actions: []
    };
    assert.deepEqual(
      enforceExistingConditionsOneActionLoop({
        req: request(sessionId),
        decision: compileReceipt
      }),
      compileReceipt
    );
    assert.deepEqual(
      readExistingConditionsRepairLedger(sessionId).map(entry => entry.event),
      ["workflow_registered"]
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop serializes writes and records a hash-chained ledger", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-one-action-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "one-action-session";
    const result = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([
        {
          action_id: "dry-run",
          method: "POST",
          path: "/revit/move-elements",
          body: { elementIds: [101], translation: [1, 0, 0], dryRun: true }
        },
        {
          action_id: "apply",
          method: "POST",
          path: "/revit/move-elements",
          body: { elementIds: [101], translation: [1, 0, 0], dryRun: false }
        }
      ])
    });
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0]?.action_id, "dry-run");
    assert.match(result.assistant_message, /first of 2 proposed actions/);

    const entries = readExistingConditionsExecutionLedger(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "action_planned");
    assert.equal(entries[0]?.phase, "dry_run");

    fs.appendFileSync(
      existingConditionsExecutionLedgerPath(sessionId),
      `${JSON.stringify({ schema_version: 1, sequence: 999 })}\n`,
      "utf8"
    );
    assert.throws(
      () => readExistingConditionsExecutionLedger(sessionId),
      /invalid_chain_line/
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop observes, clears, and re-observes recoverable Revit dialogs", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-recovery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "recovery-session";
    const afterFailure = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "failed-write",
        method: "POST",
        path: "/revit/move-elements",
        status: "failed",
        error: "bridge request timed out"
      }]),
      decision: response([{
        action_id: "blind-retry",
        method: "POST",
        path: "/revit/move-elements",
        body: { elementIds: [101], translation: [1, 0, 0] }
      }])
    });
    assert.equal(afterFailure.actions[0]?.path, "/revit/computer-use-observe");

    const afterObserve = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: afterFailure.actions[0]!.action_id,
        method: "POST",
        path: "/revit/computer-use-observe",
        status: "done",
        result_json: {
          status: "ok",
          blocked_by_modal: true,
          last_dialog_event: {
            dialog_id: "DocWarnDialog",
            policy_category: "retryable_error"
          }
        }
      }]),
      decision: response([])
    });
    assert.equal(afterObserve.actions[0]?.path, "/revit/computer-use-act");
    assert.equal(
      (afterObserve.actions[0]?.body as Record<string, unknown>)?.button,
      "cancel"
    );

    const afterAct = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: afterObserve.actions[0]!.action_id,
        method: "POST",
        path: "/revit/computer-use-act",
        status: "done",
        result_json: { status: "ok", clicked: true }
      }]),
      decision: response([{
        action_id: "retry-too-soon",
        method: "POST",
        path: "/revit/move-elements",
        body: { elementIds: [101], translation: [1, 0, 0] }
      }])
    });
    assert.equal(afterAct.actions[0]?.path, "/revit/computer-use-observe");

    const entries = readExistingConditionsExecutionLedger(sessionId);
    assert.ok(entries.some(entry => entry.event === "action_failed"));
    assert.ok(entries.filter(entry => entry.phase === "recovery").length >= 5);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop leaves local contract failures to provider payload repair", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-contract-repair-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "contract-repair-session";
    const result = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "malformed-summary",
        method: "POST",
        path: "/revit/get-element-summary",
        status: "failed",
        error: "elementIds must be an array of integers."
      }]),
      decision: response([{
        action_id: "corrected-summary",
        method: "POST",
        path: "/revit/get-element-summary",
        body: { elementIds: [101] }
      }])
    });

    assert.equal(result.actions[0]?.action_id, "corrected-summary");
    assert.equal(result.actions[0]?.path, "/revit/get-element-summary");
    assert.ok(!result.actions.some(action => action.path === "/revit/computer-use-observe"));
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action loop rejects an incomplete unregistered staged workflow before Revit", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-incomplete-provider-workflow-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "incomplete-provider-workflow-session";
    const result = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "provider-incomplete-backbone-batch",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          inputFingerprintSha256: "9".repeat(64),
          operations: [
            {
              action_key: "route:valid-backbone-1",
              path: "/revit/mep-route-workflow",
              depends_on: [],
              expected_created_min: 1,
              expected_created_max: 5,
              apply_body: null,
              deferred_body: null
            },
            {
              action_key: "route:invalid-backbone-2",
              path: "/revit/mep-route-workflow",
              depends_on: ["route:valid-backbone-1"],
              expected_created_min: 1,
              expected_created_max: 5,
              apply_body: null,
              deferred_body: null
            }
          ],
          dryRun: true,
          verify: true,
          maximumCreatedElements: 10
        }
      }])
    });

    assert.equal(result.actions.length, 0);
    assert.match(result.assistant_message, /rejected an incomplete staged-workflow envelope before Revit/i);
    assert.match(result.assistant_message, /operation_apply_body_or_deferred_body_required:route:valid-backbone-1/);
    assert.match(result.assistant_message, /Do not search the Revit tool catalog for the host ledger/i);
    assert.match(result.assistant_message, /existing_conditions_execution_ledger\.jsonl/);
    assert.match(result.assistant_message, /existing_conditions_repair_ledger\.jsonl/);
    assert.deepEqual(readExistingConditionsRepairLedger(sessionId), []);
    const entries = readExistingConditionsExecutionLedger(sessionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "action_failed");
    assert.equal(entries[0]?.error, "operation_apply_body_or_deferred_body_required:route:valid-backbone-1");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop records discovery tools as observe actions", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-observe-phase-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "observe-phase-session";
    enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "discover-summary-tool",
        method: "POST",
        path: "/revit/tool-search",
        body: { query: "element summary" }
      }])
    });

    const entries = readExistingConditionsExecutionLedger(sessionId);
    assert.equal(entries[0]?.phase, "observe");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop suppresses an exact completed-action replay", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-replay-guard-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "replay-guard-session";
    const body = { action: "list", category: "OST_PlumbingFixtures", limit: 150 };
    const first = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "list-types-original",
        method: "POST",
        path: "/revit/list-element-types",
        body
      }])
    });
    assert.equal(first.actions.length, 1);

    enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "list-types-original",
        method: "POST",
        path: "/revit/list-element-types",
        status: "done",
        result_json: { count: 1, types: [{ id: 42, name: "P-18" }] }
      }]),
      decision: response([])
    });

    const replay = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "list-types-repeated",
        method: "POST",
        path: "/revit/list-element-types",
        body
      }])
    });
    assert.equal(replay.actions.length, 0);
    assert.match(replay.assistant_message, /skipped 1 exact completed-action replay/i);
    assert.match(replay.assistant_message, /No action was executed/i);
    assert.match(replay.assistant_message, /current request still needs a new plan/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop reserves an in-flight action", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-in-flight-guard-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "in-flight-guard-session";
    const context = documentContext("candidate");
    const body = { elementIds: [101] };
    const first = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [], context),
      decision: response([{
        action_id: "read-first",
        method: "POST",
        path: "/revit/get-element-summary",
        body
      }])
    });
    assert.equal(first.actions.length, 1);

    const overlapping = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [], context),
      decision: response([{
        action_id: "read-overlap",
        method: "POST",
        path: "/revit/get-element-summary",
        body
      }])
    });
    assert.equal(overlapping.actions.length, 0);
    assert.match(overlapping.assistant_message, /already in flight/i);
    assert.equal(
      readExistingConditionsExecutionLedger(sessionId).filter(entry => entry.event === "action_planned").length,
      1
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("completed readback can run again in a different Revit document", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-document-scoped-readback-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "document-scoped-readback-session";
    const body = { elementIds: [101, 102] };
    const candidateContext = documentContext("candidate");
    const referenceContext = documentContext("reference");
    const first = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [], candidateContext),
      decision: response([{
        action_id: "candidate-read",
        method: "POST",
        path: "/revit/get-element-summary",
        body
      }])
    });
    assert.equal(first.actions.length, 1);
    enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "candidate-read",
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [{ id: 101, found: true }]
      }], candidateContext),
      decision: response([])
    });

    const referenceRead = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [], referenceContext),
      decision: response([{
        action_id: "reference-read",
        method: "POST",
        path: "/revit/get-element-summary",
        body
      }])
    });
    assert.equal(referenceRead.actions.length, 1);
    assert.equal(referenceRead.actions[0]?.action_id, "reference-read");
    const scopes = readExistingConditionsExecutionLedger(sessionId)
      .filter(entry => entry.event === "action_planned")
      .map(entry => entry.document_scope_sha256);
    assert.equal(new Set(scopes).size, 2);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop permits the same readback after a later completed write", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-readback-invalidation-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "readback-invalidation-session";
    const readbackBody = { elementIds: [101] };
    const before = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "read-before",
        method: "POST",
        path: "/revit/get-element-summary",
        body: readbackBody
      }])
    });
    assert.equal(before.actions.length, 1);

    enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "read-before",
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [{ id: 101, found: true }]
      }]),
      decision: response([])
    });

    const write = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "mutate",
        method: "POST",
        path: "/revit/set-parameter",
        body: { elementIds: [101], parameterName: "Offset", value: 0 }
      }])
    });
    assert.equal(write.actions.length, 1);

    enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "mutate",
        method: "POST",
        path: "/revit/set-parameter",
        status: "done",
        result_json: { status: "Success", changed: true }
      }]),
      decision: response([])
    });

    const after = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "read-after",
        method: "POST",
        path: "/revit/get-element-summary",
        body: readbackBody
      }])
    });
    assert.equal(after.actions.length, 1);
    assert.equal(after.actions[0]?.action_id, "read-after");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("one-action execution loop rejects spatial actions outside a persisted registered model rectangle", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-spatial-guard-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "spatial-guard-session";
    const sessionDir = path.dirname(existingConditionsExecutionLedgerPath(sessionId));
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "request_log.jsonl"),
      `${JSON.stringify({
        kind: "user.turn",
        session_id: sessionId,
        user_text: "Use registered model rectangle X 10..20 ft and Y -40..-30 ft for this staged reconstruction."
      })}\n`,
      "utf8"
    );

    const rejected = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "fixture-outside-registration",
        method: "POST",
        path: "/revit/create-family-instance",
        body: { familyName: "Fixture", typeName: "Type A", x: 100, y: 100, z: 0, dryRun: true }
      }])
    });
    assert.equal(rejected.actions.length, 0);
    assert.match(rejected.assistant_message, /outside the persisted registered model rectangle/i);
    assert.match(rejected.assistant_message, /No model write was issued/i);
    const rejectedEntry = readExistingConditionsExecutionLedger(sessionId).at(-1);
    assert.equal(rejectedEntry?.event, "action_failed");
    assert.equal(rejectedEntry?.phase, "dry_run");
    assert.equal(rejectedEntry?.error, "outside_persisted_registered_model_rectangle");

    const accepted = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "fixture-inside-registration",
        method: "POST",
        path: "/revit/create-family-instance",
        body: { familyName: "Fixture", typeName: "Type A", x: 15, y: -35, z: 0, dryRun: true }
      }])
    });
    assert.equal(accepted.actions[0]?.action_id, "fixture-inside-registration");
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("provider-independent loop enforces staged repair readback visual and checkpoint", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-provider-staged-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "provider-staged-session";
    const fingerprint = "f".repeat(64);
    const proposed = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "provider-full-workflow",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          inputFingerprintSha256: fingerprint,
          targetViewId: 123,
          operations: [{
            action_key: "repair:move-retained",
            observation_ids: ["retained-1"],
            path: "/revit/move-elements",
            depends_on: [],
            expected_created_min: 0,
            expected_created_max: 0,
            apply_body: {
              ids: [901, 902],
              mode: "vector",
              vectorX: 1,
              vectorY: 0,
              vectorZ: 0,
              moveTogether: true
            }
          }],
          provisionalObservationIds: [],
          dryRun: true,
          verify: true,
          maximumCreatedElements: 2
        }
      }])
    });
    assert.equal(proposed.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
    assert.equal((proposed.actions[0]?.body as Record<string, unknown>)?.dryRun, true);

    const apply = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: proposed.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "DryRunReady",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          operationOutputs: [{
            action_key: "repair:move-retained",
            created_element_ids: [],
            affected_element_ids: [901, 902]
          }]
        }
      }]),
      decision: response([])
    });
    assert.equal((apply.actions[0]?.body as Record<string, unknown>)?.dryRun, false);
    assert.equal(
      readExistingConditionsExecutionLedger(sessionId).find(entry =>
        entry.event === "action_completed" &&
        entry.action_id === proposed.actions[0]!.action_id
      )?.phase,
      "dry_run"
    );

    const readback = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: apply.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "Applied",
          dryRun: false,
          atomic: true,
          operationOutputs: [{
            action_key: "repair:move-retained",
            created_element_ids: [],
            affected_element_ids: [901, 902]
          }]
        }
      }]),
      decision: response([])
    });
    assert.equal(readback.actions[0]?.path, "/revit/get-element-summary");
    assert.deepEqual((readback.actions[0]?.body as Record<string, unknown>)?.elementIds, [901, 902]);

    const visual = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: readback.actions[0]!.action_id,
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [{ id: 901, found: true }, { id: 902, found: true }]
      }]),
      decision: response([])
    });
    assert.equal(visual.actions[0]?.path, "/revit/highlight-and-export");
    assert.deepEqual(
      (visual.actions[0]?.body as Record<string, unknown>)?.focusElementIds,
      [901, 902]
    );
    assert.equal(
      (visual.actions[0]?.body as Record<string, unknown>)?.focusPaddingFt,
      18
    );
    const visualPath = writeVisualArtifact(
      root,
      (visual.actions[0]?.body as Record<string, unknown>)?.fileName
    );

    const checkpoint = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: visual.actions[0]!.action_id,
        method: "POST",
        path: "/revit/highlight-and-export",
        status: "done",
        result_json: { status: "ok", path: visualPath }
      }]),
      decision: response([])
    });
    assert.equal(checkpoint.actions[0]?.path, "/revit/save-as");
    const checkpointPath = writeCheckpointArtifact(
      (checkpoint.actions[0]?.body as Record<string, unknown>)?.filePath
    );

    const complete = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: checkpoint.actions[0]!.action_id,
        method: "POST",
        path: "/revit/save-as",
        status: "done",
        result_json: {
          status: "Success",
          path: checkpointPath
        }
      }]),
      decision: response([{
        action_id: "provider-replay-after-checkpoint",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          stageKey: "operation:repair:move-retained",
          dryRun: false
        }
      }])
    });
    assert.deepEqual(complete.actions, []);
    assert.match(complete.assistant_message, /accepted and checkpointed/i);
    assert.match(complete.assistant_message, /before provider rediscovery or replay/i);

    const terminalContinuation = maybeContinueExistingConditionsOneActionLoop({
      ...request(sessionId),
      user_text: ""
    });
    assert.ok(terminalContinuation);
    assert.deepEqual(terminalContinuation.actions, []);
    assert.match(terminalContinuation.assistant_message, /accepted and checkpointed/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("staged and verification receipts require the persisted action attempt", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-stale-stage-receipt-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "stale-stage-receipt-session";
    const fingerprint = "a".repeat(64);
    const operation = {
      action_key: "repair:move-retained",
      observation_ids: ["retained-1"],
      path: "/revit/move-elements",
      depends_on: [],
      expected_created_min: 0,
      expected_created_max: 0,
      apply_body: {
        ids: [901],
        mode: "vector",
        vectorX: 1,
        vectorY: 0,
        vectorZ: 0,
        moveTogether: true
      }
    };
    const workflowBody = {
      inputFingerprintSha256: fingerprint,
      targetViewId: 123,
      operations: [operation],
      provisionalObservationIds: [],
      dryRun: true,
      verify: true,
      maximumCreatedElements: 1
    };
    const initial = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "provider-stale-stage",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: workflowBody
      }])
    });
    const dryRunActionId = initial.actions[0]!.action_id;

    const staleStage = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "orphan-stage-result",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "DryRunReady",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          operationOutputs: [{ action_key: "repair:move-retained", created_element_ids: [], affected_element_ids: [901] }]
        }
      }]),
      decision: response([])
    });
    assert.deepEqual(
      readExistingConditionsRepairLedger(sessionId).map(entry => entry.event),
      ["workflow_registered", "stage_registered"]
    );
    assert.deepEqual(staleStage.actions, []);
    assert.match(staleStage.assistant_message, /in flight|duplicate/i);

    const apply = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: dryRunActionId,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "DryRunReady",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          operationOutputs: [{ action_key: "repair:move-retained", created_element_ids: [], affected_element_ids: [901] }]
        }
      }]),
      decision: response([])
    });
    assert.equal((apply.actions[0]?.body as Record<string, unknown>)?.dryRun, false);
    const applyActionId = apply.actions[0]!.action_id;

    const readback = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: applyActionId,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "Applied",
          dryRun: false,
          atomic: true,
          operationOutputs: [{ action_key: "repair:move-retained", created_element_ids: [], affected_element_ids: [901] }]
        }
      }]),
      decision: response([])
    });
    assert.equal(readback.actions[0]?.path, "/revit/get-element-summary");
    const readbackActionId = readback.actions[0]!.action_id;

    const staleReadback = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: "orphan-readback-result",
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [{ id: 901, found: true }]
      }]),
      decision: response([])
    });
    assert.deepEqual(staleReadback.actions, []);
    assert.doesNotMatch(
      readExistingConditionsRepairLedger(sessionId).map(entry => entry.event).join(","),
      /readback_accepted/
    );

    const visual = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: readbackActionId,
        method: "POST",
        path: "/revit/get-element-summary",
        status: "done",
        result_json: [{ id: 901, found: true }]
      }]),
      decision: response([])
    });
    assert.equal(visual.actions[0]?.path, "/revit/highlight-and-export");
    assert.ok(readExistingConditionsRepairLedger(sessionId).some(entry => entry.event === "readback_accepted"));
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("recovered apply warning rejects only the active stage before sidecar observation", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-recovered-stage-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "recovered-stage-session";
    const fingerprint = "d".repeat(64);
    const operation = {
      action_key: "repair:move-retained",
      observation_ids: ["retained-1"],
      path: "/revit/move-elements",
      depends_on: [],
      expected_created_min: 0,
      expected_created_max: 0,
      apply_body: {
        ids: [901],
        mode: "vector",
        vectorX: 1,
        vectorY: 0,
        vectorZ: 0,
        moveTogether: true
      }
    };
    const dryRun = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "provider-workflow",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          inputFingerprintSha256: fingerprint,
          operations: [operation],
          provisionalObservationIds: [],
          dryRun: true,
          verify: true,
          maximumCreatedElements: 1
        }
      }])
    });
    const apply = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: dryRun.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "DryRunReady",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          operationOutputs: [{
            action_key: "repair:move-retained",
            created_element_ids: [],
            affected_element_ids: [901]
          }]
        }
      }]),
      decision: response([])
    });

    const recovered = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: apply.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "failed",
        failure_kind: "runtime_recovery",
        failure_code: "retryable_revit_dialog_recovered",
        error: "Revit warning was cancelled by the sidecar guard.",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:move-retained",
          status: "Blocked",
          dryRun: false,
          error: "retryable_revit_dialog_recovered",
          rollbackVerified: false,
          requiresReadback: true,
          failedOperation: { actionKey: "repair:move-retained" }
        }
      }]),
      decision: response([{
        action_id: "unsafe-blind-retry",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: { inputFingerprintSha256: fingerprint, operations: [operation], dryRun: false }
      }])
    });

    assert.equal(recovered.actions[0]?.path, "/revit/computer-use-observe");
    const repairEntries = readExistingConditionsRepairLedger(sessionId);
    const rejected = repairEntries.find(entry => entry.event === "stage_rejected");
    assert.equal(rejected?.stage_key, "operation:repair:move-retained");
    assert.equal(rejected?.payload.error, "retryable_revit_dialog_recovered");
    assert.equal(rejected?.accepted_progress, false);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("provider-independent loop registers one smaller repair after a blocked dry-run", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-provider-repair-"));
  try {
    const sessionId = "provider-repair-session";
    const fingerprint = "e".repeat(64);
    const operation = {
      action_key: "repair:connect-retained",
      observation_ids: ["connection-1"],
      path: "/revit/repair-mep-connectors",
      depends_on: [],
      expected_created_min: 0,
      expected_created_max: 1,
      apply_body: { connectOpenPair: { first: { elementId: 901 }, second: { elementId: 902 } } }
    };
    const first = enforceExistingConditionsOneActionLoop({
      req: request(sessionId),
      decision: response([{
        action_id: "provider-original",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          inputFingerprintSha256: fingerprint,
          operations: [operation],
          provisionalObservationIds: [],
          dryRun: true,
          verify: true,
          maximumCreatedElements: 2
        }
      }])
    });
    const repaired = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: first.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey: "operation:repair:connect-retained",
          status: "Blocked",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          error: "connector_tolerance_mismatch",
          failedOperation: { actionKey: "repair:connect-retained" }
        }
      }]),
      decision: response([{
        action_id: "provider-smaller-repair",
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        body: {
          inputFingerprintSha256: fingerprint,
          stageKey: "repair:connect-retained:v1",
          repairReason: "Use exact connector identities and a smaller tolerance.",
          operations: [{
            ...operation,
            apply_body: {
              connectOpenPair: { first: { elementId: 901 }, second: { elementId: 902 } },
              maxConnectorDistanceFt: 0.25
            }
          }],
          provisionalObservationIds: [],
          dryRun: true,
          verify: true,
          maximumCreatedElements: 2
        }
      }])
    });
    assert.equal(repaired.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
    assert.equal((repaired.actions[0]?.body as Record<string, unknown>)?.stageKey, "repair:connect-retained:v1");
    assert.equal((repaired.actions[0]?.body as Record<string, unknown>)?.dryRun, true);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("explicit dry-run-only request pauses before apply after an accepted dry-run", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-dry-run-only-pause-"));
  try {
    const sessionId = "dry-run-only-pause-session";
    const fingerprint = "d".repeat(64);
    const workflow = {
      inputFingerprintSha256: fingerprint,
      provisionalObservationIds: ["backbone-observation"],
      operations: [{
        action_key: "route:backbone",
        observation_ids: ["backbone-observation"],
        path: "/revit/mep-route-workflow",
        depends_on: [],
        expected_created_min: 1,
        expected_created_max: 1,
        apply_body: { kind: "pipe", apply: true, points: [{ x: 0, y: 0, z: 9 }, { x: 5, y: 0, z: 9 }] }
      }],
      dryRun: true,
      verify: true,
      maximumCreatedElements: 1,
      benchmarkCredit: false,
      authorizationBasis: "explicit_unscored_user_direction"
    } as any;
    registerExistingConditionsStagedWorkflow({
      sessionId,
      sourceFrameId: "frame-dry-run-only",
      sourceViewId: 3960410,
      registrationContextId: "registration-dry-run-only",
      workflow
    });

    const initialPlan = maybeContinueExistingConditionsOneActionLoop({
      ...request(sessionId),
      user_text: "Dry-run only. Never apply this stage."
    });
    assert.ok(initialPlan);
    const initial = enforceExistingConditionsOneActionLoop({
      req: {
        ...request(sessionId),
        user_text: "Dry-run only. Never apply this stage."
      },
      decision: initialPlan
    });
    assert.ok(initial);
    const stageKey = String((initial.actions[0]?.body as Record<string, unknown>).stageKey);
    const continuationRequest = {
      ...request(sessionId, [{
        action_id: initial.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey,
          status: "DryRunReady",
          dryRun: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          operationResults: [{ actionKey: "route:backbone", status: "DryRunReady" }]
        }
      }]),
      user_text: ""
    };
    const paused = maybeContinueExistingConditionsOneActionLoop(continuationRequest);

    assert.ok(paused);
    assert.equal(paused.actions.length, 0);
    assert.match(paused.assistant_message, /paused before apply as explicitly requested/i);
    assert.match(paused.assistant_message, /No apply action was issued/i);
    const repairLedger = readExistingConditionsRepairLedger(sessionId);
    assert.ok(repairLedger.some(entry => entry.event === "dry_run_accepted"));
    assert.ok(!repairLedger.some(entry => entry.event === "stage_applied"));

    const requestLogPath = path.join(
      process.env.OPERATOR_WORKSPACE_ROOT!,
      "runs",
      "sessions",
      sessionId,
      "request_log.jsonl"
    );
    fs.appendFileSync(
      requestLogPath,
      `${JSON.stringify({
        user_text: "Dry-run only. Never apply this stage."
      })}\n`,
      "utf8"
    );

    const resumed = maybeContinueExistingConditionsOneActionLoop({
      ...request(sessionId),
      user_text: "Apply only the exact rollback-verified stage now."
    });
    assert.ok(resumed);
    assert.equal(resumed.actions.length, 1);
    assert.equal(
      (resumed.actions[0]?.body as Record<string, unknown>).dryRun,
      false
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});

test("clean failed backbone batch can pause after automatic split registration", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "operator-batch-split-pause-"));
  try {
    const sessionId = "batch-split-pause-session";
    const fingerprint = "a".repeat(64);
    const batchKey = "batch:disposable-verification";
    const workflow = {
      inputFingerprintSha256: fingerprint,
      provisionalObservationIds: ["backbone-valid", "backbone-invalid"],
      operations: [
        {
          action_key: "route:backbone-valid",
          observation_ids: ["backbone-valid"],
          path: "/revit/mep-route-workflow",
          depends_on: [],
          expected_created_min: 1,
          expected_created_max: 1,
          execution_mode: "provisional_backbone_batch",
          provisional_batch_key: batchKey,
          apply_body: { kind: "pipe", apply: true, points: [{ x: 0, y: 0, z: 9 }, { x: 5, y: 0, z: 9 }] }
        },
        {
          action_key: "route:backbone-invalid",
          observation_ids: ["backbone-invalid"],
          path: "/revit/mep-route-workflow",
          depends_on: [],
          expected_created_min: 1,
          expected_created_max: 1,
          execution_mode: "provisional_backbone_batch",
          provisional_batch_key: batchKey,
          apply_body: { kind: "pipe", apply: true, points: [] }
        }
      ],
      dryRun: true,
      verify: true,
      maximumCreatedElements: 2,
      benchmarkCredit: false,
      authorizationBasis: "explicit_unscored_user_direction"
    } as any;
    registerExistingConditionsStagedWorkflow({
      sessionId,
      sourceFrameId: "frame-batch-pause",
      sourceViewId: 3960410,
      registrationContextId: "registration-batch-pause",
      workflow
    });

    const initialPlan = maybeContinueExistingConditionsOneActionLoop({
      ...request(sessionId),
      user_text: "If blocked, stop before executing either split stage."
    });
    assert.ok(initialPlan);
    const initial = enforceExistingConditionsOneActionLoop({
      req: {
        ...request(sessionId),
        user_text: "If blocked, stop before executing either split stage."
      },
      decision: initialPlan
    });
    assert.ok(initial);
    assert.equal(initial.actions[0]?.path, "/revit/existing-conditions-mep-draft-workflow");
    const initialBody = initial.actions[0]?.body as Record<string, unknown>;
    const stageKey = String(initialBody.stageKey);

    const continuationRequest = {
      ...request(sessionId, [{
        action_id: initial.actions[0]!.action_id,
        method: "POST",
        path: "/revit/existing-conditions-mep-draft-workflow",
        status: "done",
        result_json: {
          inputFingerprintSha256: fingerprint,
          stageKey,
          status: "Blocked",
          dryRun: true,
          transactionGroupRolledBack: true,
          rollbackVerified: true,
          residualCreatedElementIds: [],
          error: "deliberately_invalid_second_action",
          failedOperation: { actionKey: "route:backbone-invalid" }
        }
      }]),
      user_text: ""
    };
    const paused = maybeContinueExistingConditionsOneActionLoop(continuationRequest);

    assert.ok(paused);
    assert.equal(paused.actions.length, 0);
    assert.match(paused.assistant_message, /automatically reduced to 2 single-action repair stage/i);
    assert.match(paused.assistant_message, /rollback_verified=true/);
    assert.match(paused.assistant_message, /residual_created_element_ids=\[\]/);
    assert.match(paused.assistant_message, /paused before executing any split stage/i);
    const finalized = enforceExistingConditionsOneActionLoop({
      req: continuationRequest,
      decision: paused
    });
    assert.equal(finalized.actions.length, 0);
    assert.match(finalized.assistant_message, /paused before executing any split stage/i);
    const repairs = readExistingConditionsRepairLedger(sessionId).filter(entry =>
      entry.event === "repair_registered" &&
      entry.payload.reason === "automatic_batch_scope_reduction_after_verified_clean_rollback"
    );
    assert.equal(repairs.length, 2);
    assert.ok(repairs.every(entry => entry.stage_key?.startsWith("repair:")));
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
  }
});
