import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "../src/contracts.js";
import {
  enforceExistingConditionsOneActionLoop,
  existingConditionsExecutionLedgerPath,
  readExistingConditionsExecutionLedger
} from "../src/existing_conditions/one_action_execution_ledger.js";

function request(
  sessionId: string,
  toolResults: ChatRequest["tool_results"] = []
): ChatRequest {
  return {
    version: "operator.backend.v1",
    session_id: sessionId,
    message_id: `message-${Date.now()}`,
    user_text: "Continue the existing conditions reconstruction.",
    tool_results: toolResults
  };
}

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
        action_id: "observe",
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
        action_id: "act",
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
