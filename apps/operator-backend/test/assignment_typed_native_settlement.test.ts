import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleCodexServerRequest } from "../src/brains/codex_brain.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../src/assignments/control_plane.js";
import { ensureAssignmentRunForTurn } from "../src/assignments/turn_journal.js";
import { createGoal, getGoal } from "../src/goals/service.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { readEvidenceRef } from "../src/evidence/evidence_store.js";

async function workspace(fn: () => Promise<void>): Promise<void> {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-typed-native-settlement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { await fn(); }
  finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assignment(sessionId: string, requestedEffect: "read" | "apply" = "read") {
  const goal = createGoal({
    title: "Typed native settlement",
    objective: "Retain authoritative native settlement from a typed MCP operation.",
    acceptance_criteria: ["The exact native result is retained."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: requestedEffect, document_fingerprint: "document-typed" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "typed-native-settlement", true)!;
  return { goal, run };
}

function projection(goalId: string) {
  const goal = getGoal(goalId)!;
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

function nativeSettlement(input: {
  assignmentId: string;
  runId: string;
  generation: number;
  nativeAttemptId: string;
  path: string;
  method?: "GET" | "POST";
  effect?: "none" | "unknown" | "applied";
  authority?: "native_host" | "native_transaction" | "native_rollback";
  requestedEffect?: "read" | "preview" | "apply";
}) {
  return {
    schema: "revit-operator.native-attempt-settlement.v1",
    assignment_id: input.assignmentId,
    attempt_id: input.nativeAttemptId,
    run_id: input.runId,
    generation: input.generation,
    requested_effect: input.requestedEffect ?? (input.effect === "applied" || input.effect === "unknown" ? "apply" : "read"),
    method: input.method ?? "POST",
    path: input.path,
    request_dispatched: true,
    effect_state: input.effect ?? "none",
    effect_reason: input.effect === "applied"
      ? "native_transaction_committed"
      : input.effect === "unknown"
        ? "native_outcome_unknown"
        : input.authority === "native_rollback"
          ? "verified_native_rollback"
          : "read_has_no_persistent_effect",
    effect_authority: input.authority ?? "native_host",
    affected_target_identities: [],
    receipt_refs: [`courier:${input.nativeAttemptId}`],
    evidence_refs: []
  };
}

async function invokeTyped(input: {
  sessionId: string;
  tool: string;
  nativePath: string;
  args?: Record<string, unknown>;
  requestedEffect?: "read" | "apply";
  resultEffect?: "none" | "unknown" | "applied";
  resultAuthority?: "native_host" | "native_transaction" | "native_rollback";
  nativeRequestedEffect?: "read" | "preview" | "apply";
  nativeMethod?: "GET" | "POST";
}) {
  const { goal, run } = assignment(input.sessionId, input.requestedEffect ?? "read");
  const settlement = nativeSettlement({
    assignmentId: goal.id,
    runId: run.runId,
    generation: run.generation,
    nativeAttemptId: `native:${input.sessionId}`,
    path: input.nativePath,
    method: input.nativeMethod,
    effect: input.resultEffect,
    authority: input.resultAuthority,
    requestedEffect: input.nativeRequestedEffect
  });
  const runtime = {
    callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify({
        status: "Ok",
        count: 509,
        items: Array.from({ length: 509 }, (_, index) => ({ elementId: index + 1 })),
        canonical_attempt_settlement: settlement
      }) }]
    })
  };
  const owner = beginTeammateLoopOwner(runtime, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: input.sessionId,
    message_id: `message:${input.sessionId}`,
    user_text: input.requestedEffect === "apply"
      ? "Update the selected Revit item."
      : "Return the requested inventory from the current Revit model.",
    context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
  });
  try {
    const response = await handleCodexServerRequest(runtime as any, {
      id: `request:${input.sessionId}`,
      method: "item/tool/call",
      params: {
        namespace: "revit_operator",
        turnId: `turn:${input.sessionId}`,
        callId: `call:${input.sessionId}`,
        tool: input.tool,
        arguments: input.args ?? {}
      }
    } as any) as any;
    return { response, current: projection(goal.id), settlement };
  } finally {
    endTeammateLoopOwner(owner);
  }
}

test("transport-bound typed find-elements retains its authoritative native route settlement", { concurrency: false }, async () => {
  await workspace(async () => {
    const result = await invokeTyped({
      sessionId: "typed-find-elements",
      tool: "revit_find_elements",
      nativePath: "/revit/find-elements",
      args: { categories: ["OST_DuctTerminal"], limit: 10_000 }
    });
    assert.equal(result.response.success, true, JSON.stringify({ response: result.response, current: result.current }, null, 2));
    assert.equal(result.current.attempts.length, 1);
    assert.equal(result.current.attempts[0]?.effect.state, "none");
    assert.equal(result.current.attempts[0]?.effect.authority, "native_host");
    assert.ok(result.current.attempts[0]?.receipt_refs.includes("courier:native:typed-find-elements"));
    assert.equal(result.current.attempts[0]?.lease.state, "settled");
    assert.equal(readEvidenceRef(result.current.attempts[0]!.evidence_refs[0]!).trust_level, "authoritative_native");
  });
});

test("neighboring typed native reads retain authority independent of result size and alias naming", { concurrency: false }, async () => {
  await workspace(async () => {
    for (const variant of [
      { sessionId: "typed-schedules", tool: "revit_list_schedules", nativePath: "/revit/schedules", args: { action: "list" } },
      { sessionId: "typed-parameters", tool: "revit_get_parameters", nativePath: "/revit/get-parameters", args: { elementIds: [101], names: ["Mark"] } },
      { sessionId: "typed-context", tool: "revit_get_context", nativePath: "/revit/context", nativeMethod: "GET" as const, args: {} }
    ]) {
      const result = await invokeTyped(variant);
      assert.equal(result.current.attempts[0]?.effect.authority, "native_host", variant.tool);
      assert.equal(result.current.attempts[0]?.effect.state, "none", variant.tool);
    }
  });
});

test("unbound typed caller result cannot manufacture native authority", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "typed-caller-only";
    const { goal } = assignment(sessionId);
    const runtime = { callTool: async () => ({ content: [{ type: "text", text: JSON.stringify({ status: "Ok", count: 509 }) }] }) };
    const owner = beginTeammateLoopOwner(runtime, {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: `message:${sessionId}`,
      user_text: "Return the requested inventory from the current Revit model.",
      context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
    });
    try {
      await handleCodexServerRequest(runtime as any, {
        id: `request:${sessionId}`,
        method: "item/tool/call",
        params: { namespace: "revit_operator", turnId: `turn:${sessionId}`, callId: `call:${sessionId}`, tool: "revit_find_elements", arguments: { categories: ["OST_DuctTerminal"] } }
      } as any);
      assert.equal(projection(goal.id).attempts[0]?.effect.authority, "admission_policy");
    } finally {
      endTeammateLoopOwner(owner);
    }
  });
});

test("transport binding cannot substitute one concrete native route for another", { concurrency: false }, async () => {
  await workspace(async () => {
    const result = await invokeTyped({
      sessionId: "generic-route-substitution",
      tool: "revit_call_tool",
      nativePath: "/revit/find-elements",
      args: { method: "POST", path: "/revit/schedules", body: { action: "list" } }
    });
    assert.equal(result.current.attempts[0]?.action_path, "/revit/schedules");
    assert.equal(result.current.attempts[0]?.effect.state, "none");
    assert.equal(result.current.attempts[0]?.effect.authority, "admission_policy");
  });
});

test("transport binding does not downgrade a typed apply settlement or replay unknown effect", { concurrency: false }, async () => {
  await workspace(async () => {
    const applied = await invokeTyped({
      sessionId: "typed-apply",
      tool: "revit_set_text_note_text",
      nativePath: "/revit/set-text-note-text",
      args: { elementId: 101, text: "CURRENT", apply: true },
      requestedEffect: "apply",
      resultEffect: "applied",
      resultAuthority: "native_transaction"
    });
    assert.equal(applied.current.attempts[0]?.effect.state, "applied");
    assert.equal(applied.current.attempts[0]?.effect.authority, "native_transaction");

    const unknown = await invokeTyped({
      sessionId: "typed-apply-unknown",
      tool: "revit_set_text_note_text",
      nativePath: "/revit/set-text-note-text",
      args: { elementId: 101, text: "CURRENT", apply: true },
      requestedEffect: "apply",
      resultEffect: "unknown"
    });
    assert.equal(unknown.current.attempts[0]?.effect.state, "unknown");
    assert.equal(unknown.current.unresolved_unknown_attempt_ids.length, 1);
  });
});

test("transport-bound typed parameter preview retains authoritative rollback truth", { concurrency: false }, async () => {
  await workspace(async () => {
    const preview = await invokeTyped({
      sessionId: "typed-parameter-preview",
      tool: "revit_set_parameters",
      nativePath: "/revit/set-parameter",
      args: { changes: [{ elementId: 42, parameterName: "Comments", value: "CURRENT" }], apply: false },
      requestedEffect: "apply",
      nativeRequestedEffect: "preview",
      resultEffect: "none",
      resultAuthority: "native_rollback"
    });

    assert.equal(preview.response.success, true, JSON.stringify(preview.response, null, 2));
    assert.equal(preview.current.attempts.length, 1);
    assert.equal(preview.current.attempts[0]?.requested_effect, "preview");
    assert.equal(preview.current.attempts[0]?.effect.state, "none");
    assert.equal(preview.current.attempts[0]?.effect.authority, "native_rollback");
    assert.equal(preview.current.unresolved_unknown_attempt_ids.length, 0);
    assert.equal(preview.current.apply_opportunity_consumed, false);
  });
});
