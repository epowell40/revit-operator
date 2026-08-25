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
import { classifyMcpResultDisposition } from "../src/assignments/mcp_result_disposition.js";

type Effect = "read" | "apply";

async function workspace(fn: () => void | Promise<void>): Promise<void> {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-mcp-error-settlement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { await fn(); }
  finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assignment(sessionId: string, effect: Effect = "read") {
  const goal = createGoal({
    title: `MCP error settlement ${sessionId}`,
    objective: effect === "read" ? "Return one authoritative structured result." : "Update one exact target.",
    acceptance_criteria: ["The exact requested result is authoritatively established."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: effect, document_fingerprint: "document:mcp-errors" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "mcp-error-test", true)!;
  return { goal, run };
}

function projection(goalId: string) {
  const goal = getGoal(goalId)!;
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

function owner(runtime: object, sessionId: string, effect: Effect = "read") {
  return beginTeammateLoopOwner(runtime, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `message:${sessionId}`,
    user_text: effect === "read" ? "Inspect the live model and return the requested result." : "Update the selected note in place.",
    context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
  });
}

function request(sessionId: string, index: number, tool: string, args: Record<string, unknown>) {
  return {
    id: `request:${sessionId}:${index}`,
    method: "item/tool/call",
    params: {
      namespace: "revit_operator",
      turnId: `turn:${sessionId}`,
      callId: `call:${sessionId}:${index}`,
      tool,
      arguments: args
    }
  } as any;
}

const exactDynamicSchemaError = {
  content: [{
    type: "text",
    text: "MCP error -32602: Input validation error: Invalid arguments for tool operator_run_dynamic_revit_program: category invalid; snapshot_limit too_big; operation_budget too_big"
  }],
  isError: true
};

function nativeSettlement(input: {
  effect: "read" | "preview" | "apply";
  path: string;
  state: "none" | "unknown" | "applied";
  authority: "native_host" | "native_rollback" | "native_receipt";
}) {
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: input.state !== "unknown",
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        assignment_id: null,
        attempt_id: null,
        run_id: null,
        generation: null,
        requested_effect: input.effect,
        method: "POST",
        path: input.path,
        action_signature: null,
        target_fingerprint: null,
        request_dispatched: true,
        effect_state: input.state,
        effect_reason: input.state === "none" ? "authoritative_no_effect" : input.state === "unknown" ? "native_result_missing_after_dispatch" : "committed",
        effect_authority: input.authority,
        affected_target_identities: [],
        receipt_refs: ["native:test-receipt"],
        evidence_refs: [],
        settled_at_utc: new Date().toISOString()
      }
    }) }],
    ...(input.state === "unknown" ? { isError: true } : {})
  };
}

test("Candidate 2 Dynamic Runtime MCP -32602 rejection is none and permits one schema-corrected preview", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "candidate2-dynamic-schema";
    const { goal } = assignment(sessionId);
    const replies = [
      exactDynamicSchemaError,
      nativeSettlement({ effect: "preview", path: "/mcp/operator_run_dynamic_revit_program", state: "none", authority: "native_rollback" })
    ];
    const runtime = { callTool: async () => replies.shift() };
    const lease = owner(runtime, sessionId);
    try {
      const invalid = await handleCodexServerRequest(runtime as any, request(sessionId, 1, "operator_run_dynamic_revit_program", {
        source: "public class Program {}", mode: "preview", category: "Air Terminals", snapshot_limit: 5000, operation_budget: 5000
      })) as any;
      assert.equal(invalid.success, false);
      let current = projection(goal.id);
      assert.equal(current.attempts[0]?.dispatch.state, "not_dispatched");
      assert.equal(current.attempts[0]?.effect.state, "none");
      assert.equal(current.attempts[0]?.effect.authority, "schema_validator");
      assert.equal(current.unresolved_unknown_attempt_ids.length, 0);

      const corrected = await handleCodexServerRequest(runtime as any, request(sessionId, 2, "operator_run_dynamic_revit_program", {
        source: "public class Program {}", mode: "preview", category: "OST_DuctTerminal", snapshot_limit: 1000, operation_budget: 256
      })) as any;
      assert.equal(corrected.success, true);
      current = projection(goal.id);
      assert.equal(current.attempts.length, 2);
      assert.equal(current.attempts[1]?.effect.state, "none");
      assert.equal(current.attempts[1]?.effect.authority, "native_rollback");
      assert.equal(current.quiescent, true);
    } finally { endTeammateLoopOwner(lease); }
  });
});

test("typed Revit and EvidenceRef schema rejections settle as pre-dispatch none", { concurrency: false }, async () => {
  for (const scenario of [
    { session: "typed-schema", tool: "revit_list_schedules", args: { action: "unsupported" } },
    { session: "evidence-schema", tool: "operator_retrieve_evidence", args: { evidenceId: "all", selector: { all: true } } }
  ]) {
    await workspace(async () => {
      const { goal } = assignment(scenario.session);
      const runtime = { callTool: async () => ({
        isError: true,
        content: [{ type: "text", text: `MCP error -32602: Input validation error: Invalid arguments for tool ${scenario.tool}` }]
      }) };
      const lease = owner(runtime, scenario.session);
      try {
        const response = await handleCodexServerRequest(runtime as any, request(scenario.session, 1, scenario.tool, scenario.args)) as any;
        assert.equal(response.success, false);
        const attempt = projection(goal.id).attempts[0]!;
        assert.equal(attempt.dispatch.state, "not_dispatched");
        assert.equal(attempt.effect.state, "none");
        assert.equal(attempt.effect.authority, "schema_validator");
        assert.equal(attempt.terminal_state, "settled");
      } finally { endTeammateLoopOwner(lease); }
    });
  }
});

test("structured JSON-RPC -32602 is recognized without relying on one text rendering", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "structured-schema-code";
    const { goal } = assignment(sessionId);
    const runtime = { callTool: async () => ({ isError: true, error: { code: -32602, message: "Invalid params" }, content: [] }) };
    const lease = owner(runtime, sessionId);
    try {
      await handleCodexServerRequest(runtime as any, request(sessionId, 1, "revit_list_schedules", { action: "invalid" }));
      const attempt = projection(goal.id).attempts[0]!;
      assert.equal(attempt.dispatch.state, "not_dispatched");
      assert.equal(attempt.effect.state, "none");
      assert.equal(attempt.effect.authority, "schema_validator");
    } finally { endTeammateLoopOwner(lease); }
  });
});

test("a nested application-domain -32602 value is not mistaken for an MCP protocol rejection", () => {
  const disposition = classifyMcpResultDisposition({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, diagnostic: { code: -32602, message: "domain-specific failure after dispatch" } }) }]
  });
  assert.equal(disposition.is_error, true);
  assert.equal(disposition.proven_before_native_dispatch, false);
  assert.equal(disposition.failure_code, "mcp_tool_error");
});

test("an isError result with bound native post-dispatch settlement preserves genuine apply uncertainty", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "native-unknown-not-downgraded";
    const { goal } = assignment(sessionId, "apply");
    const replies = [
      nativeSettlement({ effect: "preview", path: "/revit/set-text-note-text", state: "none", authority: "native_rollback" }),
      nativeSettlement({ effect: "apply", path: "/revit/set-text-note-text", state: "unknown", authority: "native_host" })
    ];
    const runtime = { callTool: async () => replies.shift() };
    const lease = owner(runtime, sessionId, "apply");
    try {
      await handleCodexServerRequest(runtime as any, request(sessionId, 1, "revit_call_tool", {
        method: "POST", path: "/revit/set-text-note-text", body: { elementId: 101, text: "Current wording", dryRun: true }
      }));
      await handleCodexServerRequest(runtime as any, request(sessionId, 2, "revit_call_tool", {
        method: "POST", path: "/revit/set-text-note-text", body: { elementId: 101, text: "Current wording", apply: true, confirm: "APPLY" }
      }));
      const current = projection(goal.id);
      assert.equal(current.attempts.at(-1)?.requested_effect, "apply");
      assert.equal(current.attempts.at(-1)?.effect.state, "unknown");
      assert.equal(current.unresolved_unknown_attempt_ids.length, 1);
    } finally { endTeammateLoopOwner(lease); }
  });
});

test("unrelated authoritative read success remains an acknowledged native read", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "unrelated-read-success";
    const { goal } = assignment(sessionId);
    const runtime = { callTool: async () => nativeSettlement({ effect: "read", path: "/revit/schedules", state: "none", authority: "native_host" }) };
    const lease = owner(runtime, sessionId);
    try {
      const response = await handleCodexServerRequest(runtime as any, request(sessionId, 1, "revit_call_tool", {
        method: "POST", path: "/revit/schedules", body: { action: "list" }
      })) as any;
      assert.equal(response.success, true);
      const attempt = projection(goal.id).attempts[0]!;
      assert.equal(attempt.dispatch.state, "acknowledged");
      assert.equal(attempt.effect.state, "none");
      assert.equal(attempt.effect.authority, "native_host");
    } finally { endTeammateLoopOwner(lease); }
  });
});
