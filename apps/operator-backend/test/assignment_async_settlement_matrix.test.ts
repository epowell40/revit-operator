import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleCodexServerRequest } from "../src/brains/codex_brain.js";
import { assignmentModelReceiptObserver, ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT } from "../src/assignments/model_call_budget.js";
import { appendAssignmentEvent } from "../src/assignments/control_plane_store.js";
import { normalizeAssignmentControlPlane, reduceAssignmentControlPlane } from "../src/assignments/control_plane.js";
import {
  cancelAssignmentInFlight,
  requestAssignmentTerminal,
  settleAssignmentExpiredWork
} from "../src/assignments/settlement_barrier.js";
import {
  currentAssignmentJournalContext,
  ensureAssignmentRunForTurn,
  journalAssignmentActions,
  journalAssignmentToolResults
} from "../src/assignments/turn_journal.js";
import { createGoal, getGoal } from "../src/goals/service.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ModelCallReceipt } from "../src/contracts.js";
import { listVerifiedWorkPackets } from "../src/work_packets/store.js";
import { projectGoalAssignment } from "../src/assignments/projection.js";
import { recoverAssignmentToolLeasesAfterRestart } from "../src/assignments/async_tool_settlement.js";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason?: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function workspace(fn: (root: string) => void | Promise<void>): Promise<void> {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-settlement-matrix-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { await fn(root); }
  finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assignment(sessionId: string, effect: "read" | "preview" | "apply") {
  const goal = createGoal({
    title: `Settlement ${effect}`,
    objective: `Complete one ${effect} operation truthfully.`,
    acceptance_criteria: ["The exact result is retained."],
    status: "active",
    related_session_id: sessionId,
    work_budget: { mode: "auto_goal", requested_effect: effect, document_fingerprint: "document-matrix" }
  });
  const run = ensureAssignmentRunForTurn(sessionId, `run:${sessionId}`, "matrix", true)!;
  return { goal, run };
}

function projection(goalId: string) {
  const goal = getGoal(goalId)!;
  return reduceAssignmentControlPlane(goal.id, normalizeAssignmentControlPlane(goal.assignment_control_plane).events).projection;
}

function openAndDispatch(sessionId: string, effect: "read" | "preview" | "apply", id: string) {
  journalAssignmentActions(sessionId, [{
    action_id: id,
    method: "POST",
    path: effect === "read" ? "/revit/schedules" : "/revit/set-text-note-text",
    request_effect: effect,
    body: effect === "read" ? { action: "list" } : { elementId: 101, dryRun: effect === "preview", apply: effect === "apply" }
  }], "matrix");
  const context = currentAssignmentJournalContext(sessionId)!;
  appendAssignmentEvent(context.assignmentId, {
    schema: "revit-operator.assignment-attempt-event/v1",
    event_id: `dispatch:${id}`,
    assignment_id: context.assignmentId,
    run_id: context.runId,
    generation: context.generation,
    attempt_id: id,
    kind: "dispatch_recorded",
    occurred_at: new Date().toISOString(),
    actor: "matrix",
    data: { dispatch_state: "dispatched", dispatch_id: `courier:${id}`, reason: "accepted" }
  });
}

function receipt(index: number): ModelCallReceipt {
  return {
    schema: "revit-operator.model-call-receipt.v1",
    call_id: `call-${index}`,
    provider: "openai",
    route: index % 2 ? "codex_agent" : "desktop_computer",
    requested_model: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    reasoning_effort: "medium",
    started_at_utc: new Date().toISOString(),
    duration_ms: null,
    success: true,
    response_status: "completed",
    error_code: null,
    tokens: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 }
  };
}

function owner(runtime: object, sessionId: string, effect: "read" | "apply" = "read") {
  return beginTeammateLoopOwner(runtime, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: sessionId,
    message_id: `message:${sessionId}`,
    user_text: effect === "read"
      ? "Count the air devices using the existing schedule."
      : "Replace the selected outdated note with the current wording.",
    context: { revit: { source: { live: true }, process_id: 42, document: { title: "Disposable", path: "C:\\Disposable.rvt" } } }
  });
}

function toolRequest(runtime: object, sessionId: string, pending: Deferred<any>) {
  const lease = owner(runtime, sessionId, "read");
  const request = handleCodexServerRequest(runtime as any, {
    id: `request:${sessionId}`,
    method: "item/tool/call",
    params: {
      namespace: "revit_operator",
      turnId: `turn:${sessionId}`,
      callId: `call:${sessionId}`,
      tool: "revit_call_tool",
      arguments: { method: "POST", path: "/revit/schedules", body: { action: "list" } }
    }
  } as any);
  return { owner: lease, request, pending };
}

test("read, preview, and apply deadlines preserve strict effect semantics without replay", { concurrency: false }, async () => {
  await workspace(() => {
    const read = assignment("deadline-read", "read");
    openAndDispatch("deadline-read", "read", "read-timeout");
    const readDeadline = new Date(projection(read.goal.id).attempts[0]!.lease.deadline_at);
    const readSettled = settleAssignmentExpiredWork(read.goal.id, readDeadline);
    assert.equal(readSettled.attempts[0]?.effect.state, "none");
    assert.equal(readSettled.attempts[0]?.lease.state, "timed_out_read");
    assert.equal(readSettled.quiescent, true);

    const preview = assignment("deadline-preview", "preview");
    openAndDispatch("deadline-preview", "preview", "preview-timeout");
    const previewSettled = settleAssignmentExpiredWork(preview.goal.id, new Date(projection(preview.goal.id).attempts[0]!.lease.deadline_at));
    assert.equal(previewSettled.attempts[0]?.effect.state, "none");
    assert.match(previewSettled.attempts[0]?.effect.reason ?? "", /preview_deadline/);

    const apply = assignment("deadline-apply", "apply");
    openAndDispatch("deadline-apply", "apply", "apply-timeout");
    const applySettled = settleAssignmentExpiredWork(apply.goal.id, new Date(projection(apply.goal.id).attempts[0]!.lease.deadline_at));
    assert.equal(applySettled.attempts[0]?.effect.state, "unknown");
    assert.equal(applySettled.attempts[0]?.lease.state, "effect_unknown");
    assert.equal(applySettled.quiescent, true);
    journalAssignmentActions("deadline-apply", [{
      action_id: "apply-replay", method: "POST", path: "/revit/set-text-note-text", request_effect: "apply",
      body: { elementId: 101, apply: true }
    }], "blind-replay");
    assert.equal(projection(apply.goal.id).attempts.length, 1);
  });
});

test("fake-clock q01 sequence records the 4,183 ms native span and 316 ms provider-to-result lateness without sleeping", () => {
  const assignmentId = "fake-clock-q01";
  const runId = "fake-clock-run";
  const attemptId = "fake-clock-attempt";
  const rows: Array<{ kind: any; at: string; attempt: string | null; data: Record<string, unknown> }> = [
    { kind: "run_started", at: "2026-08-23T20:35:04.000Z", attempt: null, data: {} },
    { kind: "attempt_opened", at: "2026-08-23T20:35:04.100Z", attempt: attemptId, data: {
      requested_effect: "read", action_path: "/revit/schedules", tool_identity: "revit_call_tool",
      action_signature: "sha256:fake-clock", target_fingerprint: "sha256:fixture",
      canonical_method: "POST", deadline_at: "2026-08-23T20:39:04.100Z"
    } },
    { kind: "admission_recorded", at: "2026-08-23T20:35:04.200Z", attempt: attemptId, data: { admission_state: "admitted", authority: "teammate_gate" } },
    { kind: "dispatch_recorded", at: "2026-08-23T20:35:04.329Z", attempt: attemptId, data: { dispatch_state: "dispatched", dispatch_id: "courier:q01" } },
    { kind: "provider_call_recorded", at: "2026-08-23T20:35:08.196Z", attempt: null, data: { call_id: "sol-q01" } },
    { kind: "lease_recorded", at: "2026-08-23T20:35:08.512Z", attempt: attemptId, data: { lease_state: "retaining_evidence" } },
    { kind: "effect_recorded", at: "2026-08-23T20:35:08.600Z", attempt: attemptId, data: {
      effect_state: "none", effect_authority: "native_host", reason: "read_has_no_persistent_effect",
      receipt_refs: ["courier:q01"], evidence_refs: ["ev1_q01"], settlement_pending_evidence: true
    } },
    { kind: "lease_recorded", at: "2026-08-23T20:35:08.700Z", attempt: attemptId, data: { lease_state: "retaining_evidence", evidence_retention_settled: true } },
    { kind: "attempt_terminal", at: "2026-08-23T20:35:08.701Z", attempt: attemptId, data: { lease_state: "settled" } }
  ];
  const reduced = reduceAssignmentControlPlane(assignmentId, rows.map((row, index) => ({
    schema: "revit-operator.assignment-attempt-event/v1" as const,
    event_id: `fake-clock:${index}`,
    assignment_id: assignmentId,
    run_id: runId,
    generation: 1,
    attempt_id: row.attempt,
    kind: row.kind,
    occurred_at: row.at,
    actor: "fake-clock",
    data: row.data
  }))).projection;
  assert.equal(Date.parse("2026-08-23T20:35:08.512Z") - Date.parse("2026-08-23T20:35:04.329Z"), 4_183);
  assert.equal(reduced.attempts[0]?.lease.receipt_lateness_ms, 316);
  assert.equal(reduced.attempts[0]?.effect.state, "none");
  assert.equal(reduced.quiescent, true);
});

test("cancellation is effect-safe before dispatch and remains bounded after read/apply dispatch", { concurrency: false }, async () => {
  await workspace(() => {
    const before = assignment("cancel-before", "apply");
    journalAssignmentActions("cancel-before", [{
      action_id: "cancel-before-attempt", method: "POST", path: "/revit/set-text-note-text", request_effect: "apply",
      body: { elementId: 101, apply: true }
    }], "matrix");
    const canceledBefore = cancelAssignmentInFlight(before.goal.id);
    assert.equal(canceledBefore.deferred, false);
    assert.equal(canceledBefore.projection.attempts[0]?.effect.state, "none");
    assert.equal(canceledBefore.projection.attempts[0]?.lease.state, "canceled_before_dispatch");

    const read = assignment("cancel-read", "read");
    openAndDispatch("cancel-read", "read", "cancel-read-attempt");
    assert.equal(cancelAssignmentInFlight(read.goal.id).deferred, true);
    journalAssignmentToolResults("cancel-read", [{
      action_id: "cancel-read-attempt", method: "POST", path: "/revit/schedules", request_effect: "read",
      status: "done", request_dispatched: true, result_json: { ok: true, count: 509 }
    }], "late-within-deadline");
    assert.equal(projection(read.goal.id).quiescent, true);

    const apply = assignment("cancel-apply", "apply");
    openAndDispatch("cancel-apply", "apply", "cancel-apply-attempt");
    const canceledApply = cancelAssignmentInFlight(apply.goal.id);
    assert.equal(canceledApply.deferred, true);
    assert.equal(canceledApply.projection.attempts[0]?.effect.state, "unknown");
    const bounded = settleAssignmentExpiredWork(apply.goal.id, new Date(canceledApply.projection.attempts[0]!.lease.deadline_at));
    assert.equal(bounded.quiescent, true);
    assert.equal(bounded.unresolved_unknown_attempt_ids.length, 1);
  });
});

test("raw provider receipts count resource use but cannot consume semantic watchdog state during an active lease", { concurrency: false }, async () => {
  await workspace(() => {
    const active = assignment("provider-active", "read");
    openAndDispatch("provider-active", "read", "provider-active-attempt");
    const before = projection(active.goal.id).progress;
    let interrupts = 0;
    const observe = assignmentModelReceiptObserver("provider-active", () => { interrupts += 1; });
    for (let index = 0; index < 4; index += 1) observe(receipt(index));
    const after = projection(active.goal.id);
    assert.equal(after.provider_call_count, 4);
    assert.equal(after.terminal_state, "open");
    assert.equal(after.progress.repeated_no_progress_count, before.repeated_no_progress_count);
    assert.equal(after.progress.diagnosis_used, before.diagnosis_used);
    assert.equal(interrupts, 0);

    const capped = assignment("provider-cap", "read");
    let capInterrupts = 0;
    const cap = assignmentModelReceiptObserver("provider-cap", () => { capInterrupts += 1; });
    for (let index = 0; index < ASSIGNMENT_ABSOLUTE_MODEL_CALL_LIMIT; index += 1) cap(receipt(index));
    assert.equal(capInterrupts, 1);
    assert.equal(getGoal(capped.goal.id)?.status, "failed");
    assert.equal(projection(capped.goal.id).terminal_reason, "absolute_model_call_limit_reached");
  });
});

test("a true post-terminal result is retained as a linked incident and never reopens the original packet", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "post-terminal-late";
    const { goal } = assignment(sessionId, "read");
    const pending = deferred<any>();
    const runtime = { callTool: async () => await pending.promise };
    const active = toolRequest(runtime, sessionId, pending);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const inFlight = projection(goal.id);
      settleAssignmentExpiredWork(goal.id, new Date(inFlight.attempts[0]!.lease.deadline_at));
      assert.equal(requestAssignmentTerminal(goal.id, "blocked", "read_result_deadline_elapsed").accepted, true);
      const packetBefore = listVerifiedWorkPackets(goal.id)[0]!;
      pending.resolve({ content: [{ type: "text", text: JSON.stringify({ ok: true, count: 509 }) }] });
      const response = await active.request as any;
      assert.equal(response.success, false);
      const terminal = projection(goal.id);
      const log = normalizeAssignmentControlPlane(getGoal(goal.id)?.assignment_control_plane);
      assert.equal(terminal.terminal_state, "blocked");
      assert.equal(terminal.attempts[0]?.evidence_refs.length, 0);
      assert.equal(log.quarantined_events.some(entry => entry.event.kind === "late_receipt_recorded"), true);
      assert.equal(listVerifiedWorkPackets(goal.id)[0]?.packet_hash, packetBefore.packet_hash);
      assert.equal(projectGoalAssignment(getGoal(goal.id)!).control_plane?.late_receipt_count, 1);
    } finally {
      endTeammateLoopOwner(active.owner);
    }
  });
});

test("native receipt survives an evidence-retention failure and the Assignment remains packetable", { concurrency: false }, async () => {
  await workspace(async () => {
    const sessionId = "evidence-retention-failure";
    const { goal, run } = assignment(sessionId, "read");
    const runtime = { callTool: async () => ({
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        value: "sk-this-secret-like-test-value-must-not-be-stored",
        canonical_attempt_settlement: {
          schema: "revit-operator.native-attempt-settlement.v1",
          assignment_id: run.assignmentId,
          attempt_id: "native-evidence-failure",
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
          receipt_refs: ["courier:evidence-failure"],
          evidence_refs: [],
          settled_at_utc: new Date().toISOString()
        }
      }) }]
    }) };
    const lease = owner(runtime, sessionId, "read");
    try {
      const response = await handleCodexServerRequest(runtime as any, {
        id: "request:evidence-failure",
        method: "item/tool/call",
        params: {
          namespace: "revit_operator", turnId: "turn:evidence-failure", callId: "call:evidence-failure",
          tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/schedules", body: { action: "list" } }
        }
      } as any) as any;
      assert.equal(response.success, false);
      const current = projection(goal.id);
      assert.equal(current.quiescent, true);
      assert.equal(current.attempts[0]?.effect.state, "none");
      assert.equal(current.attempts[0]?.effect.authority, "native_host");
      assert.ok(current.attempts[0]!.receipt_refs.some(ref => ref.includes("evidence-failure")));
      assert.equal(current.attempts[0]?.evidence_refs.length, 0);
      assert.equal(requestAssignmentTerminal(goal.id, "failed", "evidence_retention_failed").accepted, true);
      assert.equal(listVerifiedWorkPackets(goal.id).length, 1);
    } finally {
      endTeammateLoopOwner(lease);
    }
  });
});

test("duplicate and stale-generation deliveries cannot create a second canonical attempt", { concurrency: false }, async () => {
  await workspace(() => {
    const { goal, run } = assignment("duplicate-stale", "read");
    openAndDispatch("duplicate-stale", "read", "stable-attempt");
    const result = {
      action_id: "stable-attempt", method: "POST" as const, path: "/revit/schedules", request_effect: "read" as const,
      status: "done" as const, request_dispatched: true, result_json: { ok: true, count: 509 }
    };
    journalAssignmentToolResults("duplicate-stale", [result], "delivery");
    journalAssignmentToolResults("duplicate-stale", [result], "delivery");
    assert.equal(projection(goal.id).attempts.length, 1);
    const terminal = requestAssignmentTerminal(goal.id, "complete", "read_complete");
    assert.equal(terminal.accepted, true);
    const stale = appendAssignmentEvent(goal.id, {
      schema: "revit-operator.assignment-attempt-event/v1",
      event_id: "stale-late-result",
      assignment_id: goal.id,
      run_id: run.runId,
      generation: run.generation - 1,
      attempt_id: "stable-attempt",
      kind: "effect_recorded",
      occurred_at: new Date().toISOString(),
      actor: "stale-result",
      data: { effect_state: "none", effect_authority: "native_host", reason: "stale" }
    });
    assert.equal(stale.accepted, false);
    assert.equal(projection(goal.id).terminal_state, "complete");
  });
});

test("restart recovery finds one durable courier completion, settles the original attempt, and never replays", { concurrency: false }, async () => {
  await workspace(root => {
    const sessionId = "restart-courier";
    const { goal, run } = assignment(sessionId, "read");
    openAndDispatch(sessionId, "read", "restart-original-attempt");
    const before = projection(goal.id);
    const attempt = before.attempts[0]!;
    const jobId = "5".repeat(64);
    const jobRoot = path.join(root, "artifacts", "revit-courier", "jobs", jobId);
    fs.mkdirSync(jobRoot, { recursive: true });
    const completedAt = new Date(Date.parse(attempt.lease.opened_at) + 4_183).toISOString();
    fs.writeFileSync(path.join(jobRoot, "job.json"), JSON.stringify({
      version: "revit-operator.revit-tool-job.v1",
      id: jobId,
      session_id: sessionId,
      message_id: "message:restart-courier",
      turn_token: "test-only-token",
      correlation_id: jobId,
      idempotency_key: jobId,
      method: "POST",
      path: "/revit/schedules",
      created_at: new Date(Date.parse(attempt.lease.opened_at) + 10).toISOString(),
      expires_at: attempt.lease.deadline_at,
      status: "succeeded",
      claim: null,
      finished_at: completedAt,
      error: null
    }), "utf8");
    const nativeResult = {
      ok: true,
      count: 509,
      canonical_attempt_settlement: {
        schema: "revit-operator.native-attempt-settlement.v1",
        assignment_id: goal.id,
        attempt_id: attempt.attempt_id,
        run_id: run.runId,
        generation: run.generation,
        requested_effect: "read",
        method: "POST",
        path: "/revit/schedules",
        action_signature: attempt.action_signature,
        target_fingerprint: attempt.target_fingerprint,
        request_dispatched: true,
        effect_state: "none",
        effect_reason: "read_has_no_persistent_effect",
        effect_authority: "native_host",
        affected_target_identities: [],
        receipt_refs: [`courier:${jobId}`],
        evidence_refs: [],
        settled_at_utc: completedAt
      }
    };
    fs.writeFileSync(path.join(jobRoot, "result.json"), JSON.stringify({
      version: "revit-operator.revit-tool-result.v1",
      id: jobId,
      correlation_id: jobId,
      status: "succeeded",
      finished_at: completedAt,
      result: nativeResult,
      error: null,
      retryable: false,
      outcome_unknown: false
    }), "utf8");
    const recovered = recoverAssignmentToolLeasesAfterRestart(goal.id, new Date(completedAt));
    assert.equal(recovered.attempts.length, 1);
    assert.equal(recovered.attempts[0]?.attempt_id, "restart-original-attempt");
    assert.equal(recovered.attempts[0]?.effect.state, "none");
    assert.equal(recovered.attempts[0]?.lease.native_correlation_id, jobId);
    assert.equal(recovered.attempts[0]?.evidence_refs.length, 1);
    assert.equal(recovered.quiescent, true);
  });
});
