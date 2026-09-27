import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexTurnCompletions } from "../src/codex/turn_completions.js";
import { CodexTurnFailedError } from "../src/codex/turn_error.js";
import { recordCodexProviderUsageHoldV2 } from "../src/assignments/assignment_kernel_v2_usage_hold.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { appendCurrentAssignmentKernelEventV2, getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { advanceAssignmentKernelProgressV2, recordCompletedAssignmentProviderReceiptV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { deriveProgressGapsV2 } from "../src/domain/assignment-kernel/index.js";
import { settleAssignmentKernelExecutionFailureV2 } from "../src/assignments/assignment_kernel_v2_execution_failure.js";
import { beginAssignmentKernelTerminalBarrierV2, endAssignmentKernelTerminalBarrierV2 } from "../src/assignments/assignment_kernel_v2_terminal_barrier.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { startCodexProviderTurnWhenActive, runThinReferenceTurns } from "../src/brains/thin_reference_execution.js";
import { finalCodexAssignmentMessageV2 } from "../src/brains/codex_assignment_progress.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { listTaskNavigation } from "../src/assignments/task_navigation.js";
import { registerActiveProviderTurn } from "../src/codex/active_turns.js";
import { steerAssignment, assignmentDirections } from "../src/assignments/task_steering.js";

const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only-usage") };

async function fixture(fn: (input: { root: string; binding: ReturnType<typeof createAssignmentKernelForGoalV2> }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-usage-boundary-"));
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    await runWithRequestContext(local, async () => {
    const goal = createGoal({ title: "Retained usage interruption", objective: "Read current sheets",
      acceptance_criteria: ["Current sheets are established"], status: "active", related_session_id: "usage-session",
      created_by: "usage-owner", work_budget: { requested_effect: "read", document_fingerprint: "disposable-model" } });
    await fn({ root, binding: createAssignmentKernelForGoalV2({ goal, run_id: "usage-run" }) });
    });
  } finally {
    __closeForTests(); __testOnlyResetGoalListCache();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("operator-usage-boundary-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function observed(code: unknown = "usageLimitExceeded") {
  const transport = new CodexTurnCompletions();
  transport.observe("thread", "turn", "failed", { message: "Quota-like diagnostic", codexErrorInfo: code });
  const error = await transport.wait({ threadId: "thread", turnId: "turn", timeoutMs: 0 }).catch(error => error);
  return { error, is_current_failure: (failure: unknown) => transport.isCurrentFailure(failure), transport };
}

test("actual app-server failure persists a nonterminal hold without inventing a response receipt", () => fixture(async ({ root, binding }) => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const fixtureFile = [path.join(testDir, "fixtures", "codex_app_server_fixture.js"),
    path.join(testDir, "..", "..", "test", "fixtures", "codex_app_server_fixture.js")].find(candidate => fs.existsSync(candidate));
  assert.ok(fixtureFile, "Codex app-server fixture must be available in source and compiled tests");
  const client = new CodexAppServer({ cwd: root, codexHome: path.join(root, ".codex"), command: process.execPath,
    commandPrefixArgs: [fixtureFile], spawnEnv: { ...process.env, CODEX_FIXTURE_STATE_PATH: path.join(root, "protocol-state.json"),
      CODEX_FIXTURE_TRACE_PATH: path.join(root, "trace.jsonl"), CODEX_FIXTURE_TURN_ERROR: JSON.stringify({ message: "Limit", codexErrorInfo: "usageLimitExceeded" }) } });
  try {
    await client.ensureStarted();
    const thread = await client.startThread({ cwd: root, sandbox: "read-only", approvalPolicy: "never" });
    const turn = await client.startTurn({ threadId: thread.thread.id, input: [{ type: "text", text: "fixture", text_elements: [] }] });
    const error = await client.waitForTurnCompleted({ threadId: thread.thread.id, turnId: turn.turn.id, timeoutMs: 1000 }).catch(error => error);
    const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "message-1", thread_id: thread.thread.id, turn_id: turn.turn.id,
      error, is_current_failure: failure => client.isCurrentTurnFailure(failure), worker_identity: {
        provider: "openai_codex", configured_billing_mode: "chatgpt", requested_model: "gpt-6-astra", requested_reasoning_effort: "medium",
        reported_model: null, reported_model_source: null } })!;
    assert.equal(held.terminal, false); assert.equal(held.outcome, "active");
    assert.equal(held.provider_call_ids.length, 0); assert.equal(held.execution_failure_ids.length, 0);
    assert.equal(Object.keys(held.operations).length, 0);
    assert.equal(held.provider_usage_hold?.provider_turn_id, turn.turn.id);
    assert.match(finalCodexAssignmentMessageV2(held, ""), /ChatGPT sign-in/);
    assert.match(finalCodexAssignmentMessageV2(held, ""), /may be unsaved/);
    await client.stopAndWait();
    assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id)?.provider_usage_hold, held.provider_usage_hold);
    let dispatched = 0;
    assert.throws(() => startCodexProviderTurnWhenActive({ binding, readSnapshot: () => getAssignmentKernelSnapshotV2(binding.assignment_id) },
      async () => { dispatched++; }), /provider_usage_hold/);
    const result = await runThinReferenceTurns({ request: { version: "operator.backend.v1", session_id: binding.session_id,
      message_id: "unrequested-reconnect", user_text: "Continue" }, binding, limits: { max_turns: 2, max_wall_ms: 1000 }, signal: new AbortController().signal,
      inspect: () => advanceAssignmentKernelProgressV2({ binding }), invoke: async () => { dispatched++; throw new Error("Unexpected invocation"); } });
    assert.equal(result.turns, 0); assert.equal(dispatched, 0);
    assert.equal(result.stop_reason, advanceAssignmentKernelProgressV2({ binding }).decision.reason);
  } finally { await client.stopAndWait(); }
}));

test("lookalikes, neighboring typed codes, foreign turns and replaced transport never create a hold", () => fixture(async ({ binding }) => {
  for (const code of [null, "rateLimitExceeded", "sessionBudgetExceeded", "unauthorized", { httpConnectionFailed: { httpStatusCode: 429 } }]) {
    const receipt = await observed(code);
    assert.equal(recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn", ...receipt }), null);
  }
  const receipt = await observed();
  assert.equal(recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "foreign", turn_id: "turn", ...receipt }), null);
  assert.equal(recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn", ...receipt,
    error: new CodexTurnFailedError("thread", "turn", { message: "limit", codexErrorInfo: "usageLimitExceeded" }) }), null);
  receipt.transport.reset(new Error("new process"));
  assert.equal(recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn", ...receipt }), null);
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.assignment_version, 1);
}));

test("explicit Resume waits for current provider cleanup and retains the exact run and cumulative work", () => fixture(async ({ binding }) => {
  const receipt = await observed();
  const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn", ...receipt })!;
  const barrier = beginAssignmentKernelTerminalBarrierV2({ binding, barrier_id: "current-finally" });
  const control = { binding, command_id: "resume-1", expected_command_id: null, action: "resume" as const,
    expected_hold_id: held.provider_usage_hold!.hold_id, expected_assignment_version: held.assignment_version };
  try { assert.throws(() => controlAssignmentExecutionV2(control), /settling|drain|provider|quiescen/i); }
  finally { endAssignmentKernelTerminalBarrierV2(barrier); }
  const resumed = controlAssignmentExecutionV2(control);
  assert.equal(resumed.provider_usage_hold, undefined);
  assert.deepEqual(resumed.current_binding, held.current_binding);
  assert.deepEqual(resumed.provider_calls, held.provider_calls);
  assert.deepEqual(resumed.operations, held.operations);
  assert.deepEqual(resumed.spec, held.spec);
  assert.equal(resumed.execution_control?.state, "running");
  assert.equal(controlAssignmentExecutionV2(control).assignment_version, resumed.assignment_version, "exact duplicate control is idempotent");
  assert.throws(() => controlAssignmentExecutionV2({ ...control, command_id: "delayed-resume", expected_command_id: "resume-1" }), /hold|stale/);
  assert.throws(() => recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn",
    occurred_at: held.provider_usage_hold!.recorded_at, ...receipt }), /retired|reused/,
    "a still-cached old transport failure cannot reuse an already released hold event");
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.provider_usage_hold, undefined);
}));

test("historical terminal provider failure remains terminal and cannot gain a new resumable hold", () => fixture(async ({ binding }) => {
  const failed = settleAssignmentKernelExecutionFailureV2({ binding, failure_id: "old-failure", error_class: "resource_exhausted", phase: "provider_turn" }).snapshot;
  assert.equal(failed.terminal, true);
  assert.equal(recordCodexProviderUsageHoldV2({ binding, attempt_id: "attempt", thread_id: "thread", turn_id: "turn", ...await observed() }), null);
  assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), failed);
}));

test("late honest usage settlement keeps the current cumulative budget exhausted on explicit Resume", () => fixture(async ({ binding }) => {
  const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "budget-attempt", thread_id: "thread", turn_id: "turn", ...await observed() })!;
  const tokens = held.provider_usage_hold!.resume_budget.max_total_tokens;
  const settled = recordCompletedAssignmentProviderReceiptV2({ binding, call_id: "synthetic-boundary-receipt", controller_turn_id: "turn",
    provider: "openai", model: "test-model", reasoning_effort: "medium", gap_ids: deriveProgressGapsV2(held).map(gap => gap.gap_id),
    criterion_ids: held.spec.criteria.map(criterion => criterion.criterion_id), expected_information: ["Inspect sheets"],
    admitted_at: held.spec.created_at, completed_at: new Date().toISOString(), provider_duration_ms: 5,
    usage: { input_tokens: tokens, output_tokens: 0, reasoning_tokens: 0, total_tokens: tokens, estimated_cost_usd: null }, success: true });
  assert.throws(() => controlAssignmentExecutionV2({ binding, command_id: "budget-resume", action: "resume", expected_command_id: null,
    expected_hold_id: held.provider_usage_hold!.hold_id, expected_assignment_version: settled.assignment_version }), /current_budget_exhausted/);
  assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), settled);
}));

test("held steering is retained without sending work to a failed turn that is still cleaning up", () => fixture(async ({ binding }) => {
  const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "steering-attempt", thread_id: "thread", turn_id: "turn", ...await observed() })!;
  let sends = 0;
  const unregister = registerActiveProviderTurn({ sessionId: binding.session_id, messageId: "steering-attempt", threadId: "thread", turnId: "turn", binding,
    interruptionRequested: () => false, interrupt: async () => {}, steer: async () => { sends++; return { turnId: "turn" }; } });
  try {
    const command = { binding, command_id: "held-direction", expected_turn_id: "turn", text: "List sheets by their existing sheet number." };
    assert.equal((await steerAssignment(command)).state, "saved");
    assert.equal((await steerAssignment(command)).state, "saved");
    assert.equal(sends, 0);
    assert.equal(assignmentDirections(binding)[0]?.text, command.text);
    const after = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.deepEqual(after.provider_usage_hold, held.provider_usage_hold);
    assert.deepEqual(after.operations, held.operations);
    assert.deepEqual(after.provider_calls, held.provider_calls);
  } finally { unregister(); }
}));

test("owned HTTP Resume fences survive journal reload and saved navigation never starts work", () => fixture(async ({ binding }) => {
  const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "http-attempt", thread_id: "thread", turn_id: "turn", ...await observed() })!;
  const control = { ...binding, command_id: "http-resume", expected_command_id: null, action: "resume",
    expected_hold_id: held.provider_usage_hold!.hold_id, expected_assignment_version: held.assignment_version };
  let authenticated = true;
  const server = http.createServer((req, res) => {
    void runWithRequestContext(authenticated ? local : {}, () => handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://localhost"), () => true));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/assignments/v2/execution-control`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    __testOnlyResetGoalListCache();
    assert.equal(listTaskNavigation().tasks.find(task => task.assignment_id === binding.assignment_id)?.state, "waiting_for_usage");
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.assignment_version, held.assignment_version);
    authenticated = false;
    const foreign = await post(control); assert.equal(foreign.status, 409); assert.match(await foreign.text(), /foreign_principal/);
    authenticated = true;
    for (const patch of [{ session_id: "other-chat" }, { run_id: "other-run" }, { generation: 2 }, { document_fingerprint: "other-model" },
      { expected_hold_id: "other-hold" }, { expected_assignment_version: held.assignment_version - 1 }]) {
      const rejected = await post({ ...control, command_id: `stale-${Object.keys(patch)[0]}`, ...patch });
      assert.equal(rejected.status, 409);
      assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.assignment_version, held.assignment_version);
    }
    const response = await post(control); assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.assignment_snapshot_v2.provider_usage_hold, undefined);
    assert.deepEqual(body.assignment_snapshot_v2.current_binding, held.current_binding);
    assert.equal(body.assignment_snapshot_v2.execution_control.command_id, control.command_id);
    assert.equal((await post(control)).status, 200, "exact duplicate acknowledgement remains idempotent");
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.assignment_version, held.assignment_version + 1);
    assert.equal(listTaskNavigation().tasks.find(task => task.assignment_id === binding.assignment_id)?.state, "ready");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

for (const kind of ["failure", "progress_blocker", "provider_budget_exhausted"] as const) test(`persisted held ${kind} stays blocked in navigation and final text`, () => fixture(async ({ binding }) => {
  const held = recordCodexProviderUsageHoldV2({ binding, attempt_id: "blocked-attempt", thread_id: "thread", turn_id: "turn", ...await observed() })!;
  if (kind === "provider_budget_exhausted") recordCompletedAssignmentProviderReceiptV2({ binding, call_id: "late-counted-response", controller_turn_id: "turn",
    provider: "openai", model: "test-model", reasoning_effort: "medium", gap_ids: deriveProgressGapsV2(held).map(gap => gap.gap_id),
    criterion_ids: held.spec.criteria.map(criterion => criterion.criterion_id), expected_information: ["Inspect sheets"],
    admitted_at: held.spec.created_at, completed_at: new Date().toISOString(), provider_duration_ms: 5,
    usage: { input_tokens: 1, output_tokens: 0, reasoning_tokens: 0, total_tokens: 1, estimated_cost_usd: null }, success: true });
  const body = kind === "failure" ? { event_type: "execution_failure_recorded" as const, failure: {
    schema: "revit-operator.assignment-execution-failure/v2" as const, failure_id: "cleanup-failed", binding,
    error_class: "runtime" as const, phase: "response_handoff" as const, code: "assignment_runtime_failed" as const
  } } : kind === "progress_blocker" ? { event_type: "progress_blocked" as const, code: "no_progress_budget_exhausted", gap_ids: [] }
    : { event_type: "provider_budget_exhausted" as const, limit: 1 };
  const snapshot = appendCurrentAssignmentKernelEventV2({ goal_id: binding.assignment_id, binding, event_id: "independent-blocker", actor: "assignment-execution-controller", body }).snapshot;
  __testOnlyResetGoalListCache();
  const reloaded = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.deepEqual(reloaded, snapshot); assert.equal(snapshot.terminal, false); assert.ok(snapshot.provider_usage_hold);
  const display = { state: listTaskNavigation().tasks.find(task => task.assignment_id === binding.assignment_id)?.state,
    final_message: finalCodexAssignmentMessageV2(reloaded, "") };
  if (process.env.BLOCKER_REVIEW_OUTPUT_DIR) fs.writeFileSync(path.join(process.env.BLOCKER_REVIEW_OUTPUT_DIR, kind + ".json"), JSON.stringify({ snapshot: reloaded, observed: display }, null, 2));
  assert.equal(display.state, "failed"); assert.match(display.final_message, /separate task issue/); assert.doesNotMatch(display.final_message, /Resume when usage/);
  assert.throws(() => controlAssignmentExecutionV2({ binding, command_id: "blocked-resume", action: "resume", expected_command_id: null,
    expected_hold_id: held.provider_usage_hold!.hold_id, expected_assignment_version: reloaded.assignment_version }), /blocked|exhausted/);
}));
