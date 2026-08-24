import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleCodexServerRequest } from "../src/brains/codex_brain.js";
import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent
} from "../src/assignments/control_plane.js";
import { appendAssignmentEvent } from "../src/assignments/control_plane_store.js";
import { assignmentModelReceiptObserver } from "../src/assignments/model_call_budget.js";
import { requireProviderAssignmentBinding } from "../src/assignments/provider_binding.js";
import {
  ensureAssignmentRunForTurn,
  journalAssignmentActions,
  journalAssignmentToolResults
} from "../src/assignments/turn_journal.js";
import { createGoal, getGoal } from "../src/goals/service.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { settleAssignmentTurn } from "../src/assignments/turn_settlement.js";
import { submitReadCompletionClaim } from "../src/assignments/read_completion.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function withWorkspace(fn: (root: string) => Promise<void> | void): Promise<void> {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-async-settlement-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { await fn(root); }
  finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createAssignment(sessionId: string, requestedEffect: "read" | "preview" | "apply" = "read") {
  const goal = createGoal({
    title: "Asynchronous settlement",
    objective: "Complete the admitted Revit work and retain its authoritative result.",
    acceptance_criteria: ["The exact admitted result is retained and verified."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: requestedEffect, document_fingerprint: "document-async" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "test", true)!;
  return { goal, run };
}

function projection(goalId: string) {
  const goal = getGoal(goalId)!;
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

function modelReceipt(callId: string) {
  return {
    schema: "revit-operator.model-call-receipt.v1" as const,
    call_id: callId,
    provider: "openai" as const,
    route: "codex_agent" as const,
    requested_model: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium" as const,
    started_at_utc: "2026-08-23T20:35:00.776Z",
    duration_ms: null,
    success: true,
    response_status: "completed",
    error_code: null,
    tokens: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }
  };
}

function evidenceRefs(root: string): Array<Record<string, unknown>> {
  const directory = path.join(root, "evidence", "refs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name =>
    JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as Record<string, unknown>);
}

test("passing-after: exact q01 ordering cannot terminalize 316 ms before its admitted schedule read settles", { concurrency: false }, async () => {
  await withWorkspace(async root => {
    const sessionId = "async-q01-session";
    const { goal, run } = createAssignment(sessionId, "read");
    requireProviderAssignmentBinding({
      session_id: sessionId,
      assignment_id: run.assignmentId,
      assignment_run_id: run.runId,
      assignment_generation: run.generation
    }, "codex_agent");

    const result = deferred<any>();
    let runtimeCalls = 0;
    const runtime = {
      callTool: async () => {
        runtimeCalls += 1;
        return await result.promise;
      }
    };
    const teammate = beginTeammateLoopOwner(runtime, {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "q01-message",
      user_text: "Count all air devices in the project and break the total down by family and type. Use an existing air-device schedule if that is the best source.",
      context: { revit: { source: { live: true }, process_id: 42, document: { title: "Snowdon Towers Sample HVAC", path: "C:\\Snowdon.rvt" } } }
    });
    try {
      const toolRequest = handleCodexServerRequest(runtime as any, {
        id: "app-request-q01",
        method: "item/tool/call",
        params: {
          namespace: "revit_operator",
          threadId: "thread-q01",
          turnId: "turn-q01",
          callId: "tool-call-q01",
          tool: "revit_call_tool",
          arguments: { method: "POST", path: "/revit/schedules", body: { action: "list", category: "Air Terminals" } }
        }
      } as any);
      await new Promise<void>(resolve => setImmediate(resolve));
      const whileNativePending = projection(goal.id);

      let watchdogInterrupts = 0;
      assignmentModelReceiptObserver(sessionId, () => { watchdogInterrupts += 1; })(modelReceipt("sol-q01"));
      const afterRawProviderReceipt = projection(goal.id);
      const packetsBeforeNativeResult = listVerifiedWorkPackets(goal.id).length;

      result.resolve({
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          count: 509,
          groups: [{ family: "Supply Grille", type: "Double Deflection", count: 266 }],
          canonical_attempt_settlement: {
            schema: "revit-operator.native-attempt-settlement.v1",
            assignment_id: run.assignmentId,
            attempt_id: "native-q01-schedules",
            run_id: run.runId,
            generation: run.generation,
            requested_effect: "read",
            method: "POST",
            path: "/revit/schedules",
            request_dispatched: true,
            effect_state: "none",
            effect_reason: "read_has_no_persistent_effect",
            effect_authority: "native_host",
            affected_target_identities: [],
            receipt_refs: ["courier:5458621911513af6ef7e67a3a2f4570b98b91e0b03dfb97596c735c6af664336"],
            evidence_refs: [],
            settled_at_utc: "2026-08-23T20:35:08.5120503Z"
          }
        }) }]
      });
      await toolRequest;
      const afterNativeResult = projection(goal.id);
      const boundRefs = evidenceRefs(root).filter(ref => {
        return ref.assignment_id === goal.id && ref.run_id === run.runId;
      });

      assert.deepEqual({
        runtime_calls: runtimeCalls,
        pending_attempts: whileNativePending.attempts.length,
        pending_in_flight_count: (whileNativePending as any).in_flight_count ?? null,
        terminal_after_raw_receipt: afterRawProviderReceipt.terminal_state,
        watchdog_interrupts: watchdogInterrupts,
        packets_before_native_result: packetsBeforeNativeResult,
        settled_attempts: afterNativeResult.attempts.length,
        settled_attempt_effect: afterNativeResult.attempts[0]?.effect.state ?? null,
        settled_attempt_evidence_refs: afterNativeResult.attempts[0]?.evidence_refs.length ?? 0,
        assignment_bound_evidence_refs: boundRefs.length
      }, {
        runtime_calls: 1,
        pending_attempts: 1,
        pending_in_flight_count: 1,
        terminal_after_raw_receipt: "open",
        watchdog_interrupts: 0,
        packets_before_native_result: 0,
        settled_attempts: 1,
        settled_attempt_effect: "none",
        settled_attempt_evidence_refs: 1,
        assignment_bound_evidence_refs: 1
      });
      assert.equal(boundRefs[0]?.trust_level, "authoritative_native");
      submitReadCompletionClaim({
        schema: "revit-operator.assignment-read-completion-claim/v1",
        assignment_id: goal.id,
        run_id: run.runId,
        generation: run.generation,
        session_id: sessionId,
        criteria: [{
          criterion: "The exact admitted result is retained and verified.",
          assertion_ids: ["q01-count"]
        }],
        result: {
          kind: "inventory",
          assertions: [{
            assertion_id: "q01-count",
            attempt_id: afterNativeResult.attempts[0]!.attempt_id,
            evidence_id: `${boundRefs[0]!.evidence_id}`,
            operation: "field_equals",
            path: "count",
            expected: 509
          }]
        }
      }, "async-settlement-test");
      assert.equal(settleAssignmentTurn(sessionId, "read").completed, true);
      const terminalGoal = getGoal(goal.id)!;
      assert.equal(terminalGoal.status, "complete");
      assert.equal(terminalGoal.current_phase, "settled");
      assert.match(terminalGoal.finished_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
    } finally {
      endTeammateLoopOwner(teammate);
    }
  });
});

function event(
  assignmentId: string,
  runId: string,
  generation: number,
  kind: AssignmentAttemptEvent["kind"],
  attemptId: string | null,
  data: Record<string, unknown>
): AssignmentAttemptEvent {
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: randomUUID(),
    assignment_id: assignmentId,
    run_id: runId,
    generation,
    attempt_id: attemptId,
    kind,
    occurred_at: new Date().toISOString(),
    actor: "async-settlement-test",
    data
  };
}

test("passing-after: terminal settlement is deferred for every active read, preview, apply, and cancellation lease", { concurrency: false }, async () => {
  await withWorkspace(() => {
    const cases = [
      { name: "delayed_read_success", effect: "read" as const, dispatched: true, terminal: "blocked" as const },
      { name: "delayed_pre_dispatch_failure", effect: "read" as const, dispatched: false, terminal: "failed" as const },
      { name: "delayed_read_failure_after_dispatch", effect: "read" as const, dispatched: true, terminal: "failed" as const },
      { name: "delayed_preview_success", effect: "preview" as const, dispatched: true, terminal: "complete" as const },
      { name: "delayed_apply_success", effect: "apply" as const, dispatched: true, terminal: "complete" as const },
      { name: "apply_timeout_unknown", effect: "apply" as const, dispatched: true, terminal: "failed" as const },
      { name: "cancel_pending_read", effect: "read" as const, dispatched: true, terminal: "canceled" as const },
      { name: "cancel_dispatched_apply", effect: "apply" as const, dispatched: true, terminal: "canceled" as const }
    ];
    const accepted: Record<string, boolean> = {};
    for (const item of cases) {
      const sessionId = `async-${item.name}`;
      const { goal, run } = createAssignment(sessionId, item.effect === "preview" ? "preview" : item.effect);
      journalAssignmentActions(sessionId, [{
        action_id: `attempt:${item.name}`,
        method: "POST",
        path: item.effect === "read" ? "/revit/schedules" : "/revit/set-text-note-text",
        request_effect: item.effect,
        body: item.effect === "apply" ? { elementId: 101, apply: true } : { elementId: 101, dryRun: item.effect === "preview" }
      }], "codex_app_server");
      if (item.dispatched) {
        appendAssignmentEvent(goal.id, event(goal.id, run.runId, run.generation, "dispatch_recorded", `attempt:${item.name}`, {
          dispatch_state: "dispatched",
          dispatch_id: `courier:${item.name}`,
          reason: "mcp_runtime_accepted"
        }));
      }
      const terminal = appendAssignmentEvent(goal.id, event(goal.id, run.runId, run.generation, "assignment_terminal", null, {
        terminal_state: item.terminal,
        reason: `premature:${item.name}`
      }));
      accepted[item.name] = terminal.accepted;
    }
    assert.deepEqual(accepted, Object.fromEntries(cases.map(item => [item.name, false])));
  });
});

test("passing-after: restart reconstructs a pending attempt as non-quiescent with its original deadline", { concurrency: false }, async () => {
  await withWorkspace(() => {
    const sessionId = "async-restart";
    const { goal, run } = createAssignment(sessionId, "read");
    journalAssignmentActions(sessionId, [{
      action_id: "attempt:restart",
      method: "POST",
      path: "/revit/schedules",
      request_effect: "read",
      body: { action: "list" }
    }], "codex_app_server");
    appendAssignmentEvent(goal.id, event(goal.id, run.runId, run.generation, "dispatch_recorded", "attempt:restart", {
      dispatch_state: "dispatched",
      dispatch_id: "courier:restart",
      reason: "mcp_runtime_accepted"
    }));
    const persisted = getGoal(goal.id)!;
    const recovered = reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(persisted.assignment_control_plane).events).projection as any;
    assert.deepEqual({
      in_flight_attempt_ids: recovered.in_flight_attempt_ids ?? null,
      in_flight_count: recovered.in_flight_count ?? null,
      quiescent: recovered.quiescent ?? null
    }, {
      in_flight_attempt_ids: ["attempt:restart"],
      in_flight_count: 1,
      quiescent: false
    });
    assert.match(recovered.next_in_flight_deadline ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("existing fencing baseline: duplicate delivery is idempotent and stale/post-terminal results cannot resurrect", { concurrency: false }, async () => {
  await withWorkspace(() => {
    const sessionId = "async-fencing";
    const { goal, run } = createAssignment(sessionId, "read");
    journalAssignmentActions(sessionId, [{ action_id: "attempt:fence", method: "POST", path: "/revit/schedules", request_effect: "read", body: {} }], "codex");
    const result = {
      action_id: "attempt:fence",
      method: "POST" as const,
      path: "/revit/schedules",
      request_effect: "read" as const,
      status: "done" as const,
      request_dispatched: true,
      result_json: { ok: true, count: 509 }
    };
    journalAssignmentToolResults(sessionId, [result], "mcp");
    journalAssignmentToolResults(sessionId, [result], "mcp-duplicate");
    const afterDuplicate = projection(goal.id);
    assert.equal(afterDuplicate.attempts.length, 1);

    appendAssignmentEvent(goal.id, event(goal.id, run.runId, run.generation, "assignment_terminal", null, {
      terminal_state: "blocked",
      reason: "test_terminal_fence"
    }));
    const beforeLate = projection(goal.id);
    journalAssignmentToolResults(sessionId, [{ ...result, result_json: { ok: true, count: 510 } }], "late-result");
    const afterLate = projection(goal.id);
    assert.equal(afterLate.terminal_state, beforeLate.terminal_state);
    assert.equal(afterLate.attempts[0]?.receipt_refs.length, beforeLate.attempts[0]?.receipt_refs.length);
  });
});
