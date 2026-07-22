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
  readExistingConditionsExecutionLedger
} from "../src/existing_conditions/one_action_execution_ledger.js";
import { readExistingConditionsRepairLedger } from "../src/existing_conditions/staged_repair_ledger.js";

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

function response(actions: ChatResponse["actions"]): ChatResponse {
  return {
    version: "operator.backend.v1",
    assistant_message: "Continue one repairable step.",
    actions
  };
}

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

    const checkpoint = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: visual.actions[0]!.action_id,
        method: "POST",
        path: "/revit/highlight-and-export",
        status: "done",
        result_json: { status: "ok", path: "C:\\evidence\\repair.png" }
      }]),
      decision: response([])
    });
    assert.equal(checkpoint.actions[0]?.path, "/revit/save-as");

    const complete = enforceExistingConditionsOneActionLoop({
      req: request(sessionId, [{
        action_id: checkpoint.actions[0]!.action_id,
        method: "POST",
        path: "/revit/save-as",
        status: "done",
        result_json: {
          status: "Success",
          path: (checkpoint.actions[0]?.body as Record<string, unknown>)?.filePath
        }
      }]),
      decision: response([])
    });
    assert.deepEqual(complete.actions, []);
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
