import { steerAssignment } from "../src/assignments/task_steering.js";
import { decideAssignmentProgressV2 } from "../src/domain/assignment-kernel/index.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexProviderStartStopped, localThinReferenceLimits, runThinReferenceTurns, startCodexProviderTurnWhenActive } from "../src/brains/thin_reference_execution.js";
import { getThinReferenceCodexProfile, getCodexThreadStartProfile } from "../src/brains/codex_turn_profile.js";
import { prepareCodexAssignmentProgressV2, checkpointCodexAssignmentProgressV2 } from "../src/brains/codex_assignment_progress.js";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { advanceAssignmentKernelProgressV2, recordCompletedAssignmentProviderReceiptV2, recordAssignmentProviderCallStateV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { requestAssignmentInputV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { settleAssignmentKernelExecutionFailureV2 } from "../src/assignments/assignment_kernel_v2_execution_failure.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { failAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, openAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { appendEvent, __closeForTests } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import type { ChatRequest, ChatResponse } from "../src/contracts.js";
import { buildCodexTurnInput } from "../src/brains/codex_turn_input.js";
import { storeAttachmentUpload } from "../src/attachments/upload_store.js";
import { manageAssignmentWorkPlan } from "../src/assignments/assignment_work_plan.js";

async function fixture(fn: (value: ReturnType<typeof start>) => Promise<unknown>, advisory = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-thin-reference-"));
  const keys = ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2", "REVIT_OPERATOR_MODE", "OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS"], prior = keys.map(k => process.env[k]);
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  process.env.REVIT_OPERATOR_MODE = "local";
  process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = advisory ? "thin-session" : "";
  __testOnlyResetGoalListCache();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, () => fn(start())); }
  finally { __testOnlyResetGoalListCache(); __closeForTests(); keys.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; }); fs.rmSync(root, { recursive: true, force: true }); }
}
function start() {
  const userText = "Replace selected note with exact literal 'Verified text'.";
  const prepared = prepareAssignmentTurn({ sessionId: "thin-session", messageId: "original", userText, toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "thin-model" } } } } })!;
  const binding = prepared.bindingV2!;
  const request = bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: binding.session_id, message_id: "original", user_text: userText } as ChatRequest, prepared);
  return { binding, request, inspect: () => advanceAssignmentKernelProgressV2({ binding }),
    signal: new AbortController().signal, limits: { max_turns: 3, max_wall_ms: 60_000 } };
}
function completed(request: ChatRequest, turn: number): ChatResponse {
  return { version: "operator.backend.v1", assistant_message: "Progress saved.", actions: [],
    model_call_receipts: [{ call_id: `receipt-${turn}` } as any],
    provider_turn_usage: { schema: "revit-operator.provider-turn-usage/v1", session_id: request.session_id, message_id: request.message_id,
      thread_id: "provider-thread", turn_id: `turn-${turn}`, disposition: "completed", raw_response_ids: [`raw-${turn}`] } };
}
function nativeUnknown(f: ReturnType<typeof start>) {
  const snapshot = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!;
  const lease = openAssignmentKernelOperationV2({ snapshot, provider_turn_id: "provider", controller_request_id: "edit",
    capability_id: "revit_call_tool", classified_effect: "apply", arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1, newText: "Verified text", dryRun: false } } });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  return lease;
}

const reviewProposal = { claimed_completed: ["Saved a best-effort draft."], remaining_work: ["Review unresolved connections."], uncertainties: ["Drawing elevation is ambiguous."] };
function interrupted(request: ChatRequest, turn: number): ChatResponse {
  return { ...completed(request, turn), provider_turn_usage: { ...completed(request, turn).provider_turn_usage!, disposition: "interrupted" } };
}
function propose(f: ReturnType<typeof start>, drain = true) {
  recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "proposal-provider", state: "admitted", provider: "codex", model: "same-model", gap_ids: [], criterion_ids: [], expected_information: ["Original task work."] });
  manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: reviewProposal });
  if (drain) recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "proposal-provider", state: "completed", success: true });
}

test("retained contractfix proposal stop reports canonical unverified review while preserving interrupted provider truth", () => fixture(async f => {
  const before = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!;
  let settledVersion = -1;
  const result = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => {
    assert.equal(turn, 1); propose(f);
    settledVersion = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!.assignment_version;
    // The invoke response deliberately has the old snapshot. Only the durable
    // post-turn state can identify the host's intentional stop.
    return { ...interrupted(request, turn), assignment_snapshot_v2: before };
  } });
  const snapshot = result.response.assignment_snapshot_v2!;
  // Exact causal projection of retained 203535 -> 203539 -> 203540; original
  // journal SHA256 531b27005127625195ec92334821e0088728fa82b6525796b18d64f7b48fb2af.
  // Model claims/IDs are replaced with neutral local test values, not graded.
  assert.deepEqual({ outcome: snapshot.outcome, terminal: snapshot.terminal, quiescent: snapshot.quiescent,
    verified: snapshot.completion_proposal?.verified, reviews: snapshot.pending_review_ids.length,
    inputs: snapshot.pending_input_variable_ids.length, operations: snapshot.in_flight_operation_ids.length,
    providers: snapshot.in_flight_provider_call_ids.length, unknowns: snapshot.unresolved_unknown_operation_ids.length,
    budget: snapshot.provider_budget_exhausted, failures: snapshot.execution_failure_ids.length },
  { outcome: "awaiting_user_review", terminal: false, quiescent: true, verified: false, reviews: 1, inputs: 0, operations: 0, providers: 0, unknowns: 0, budget: false, failures: 0 });
  assert.equal(result.stop_reason, "advisory_completion_proposed");
  assert.equal(result.turns, 1); assert.equal(result.provider_turns[0].disposition, "interrupted");
  assert.equal(result.response.provider_turn_usage?.disposition, "interrupted");
  assert.deepEqual(result.response.model_call_receipts?.map(r => r.call_id), ["receipt-1"]);
  assert.deepEqual(snapshot.criteria, before.criteria);
  assert.equal(snapshot.assignment_version, settledVersion, "reporting must not append lifecycle events");
}, true));

for (const stop of ["pause", "cancel", "failure", "budget", "input", "unknown", "operation", "provider", "no-proposal"] as const) {
  test(`interrupted provider retains canonical ${stop} instead of reporting a completion proposal`, () => fixture(async f => {
    const result = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => {
      const decision = f.inspect().decision;
      if (decision.decision !== "admit_reasoning_turn") throw new Error("fixture requires reasoning admission");
      const progress = { gap_ids: decision.gap_ids, criterion_ids: decision.criterion_ids, expected_information: decision.expected_information };
      if (stop === "pause") controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "user-pause", expected_command_id: null });
      if (stop === "cancel" || stop === "failure") settleAssignmentKernelExecutionFailureV2({ binding: f.binding, failure_id: stop, error_class: stop === "cancel" ? "canceled" : "provider", phase: "provider_turn" });
      if (stop === "input") requestAssignmentInputV2({ binding: f.binding, clarification_id: "question", variable_ids: ["floor_name"], new_variable_ids: ["floor_name"], question: "Which floor?" });
      if (stop === "unknown" || stop === "operation") { const lease = nativeUnknown(f); if (stop === "unknown") failAssignmentKernelOperationV2(lease, new Error("lost acknowledgement"), "dispatched"); }
      if (stop === "provider") recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "still-running", state: "admitted", provider: "codex", model: "same-model", ...progress });
      if (stop === "budget") for (let i = 0; i < 32; i++) recordCompletedAssignmentProviderReceiptV2({ binding: f.binding, call_id: `spent-${i}`, provider: "codex", model: "same-model", reasoning_effort: "medium", ...progress, admitted_at: new Date().toISOString(), provider_duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, reasoning_tokens: null, estimated_cost_usd: null }, success: true });
      return interrupted(request, turn);
    } });
    const expected = { pause: "user_requested_pause", cancel: "execution_canceled", failure: "provider_execution_failed", budget: "provider_call_budget_exhausted", input: "awaiting_user_input", unknown: "unknown_effect_requires_reconciliation", operation: "operation_still_in_flight", provider: "provider_turn_not_completed", "no-proposal": "provider_turn_not_completed" };
    assert.equal(result.stop_reason, expected[stop]);
    assert.equal(result.turns, 1); assert.equal(result.provider_turns[0].disposition, "interrupted");
  }));
}

for (const stop of ["draining", "external-cancel", "wall", "failed-provider", "missing-provider-usage", "forged-response"] as const) {
  test(`proposal reporting cannot mask ${stop}`, () => fixture(async f => {
    const abort = new AbortController(); let elapsed = 0;
    const result = await runThinReferenceTurns({ ...f, signal: abort.signal, now: () => elapsed, invoke: async (request, turn) => {
      if (stop !== "forged-response") propose(f, stop !== "draining");
      if (stop === "external-cancel") abort.abort("user_cancel");
      if (stop === "wall") elapsed = f.limits.max_wall_ms;
      const response = interrupted(request, turn);
      if (stop === "failed-provider") response.provider_turn_usage = { ...response.provider_turn_usage!, disposition: "failed" };
      if (stop === "missing-provider-usage") delete response.provider_turn_usage;
      if (stop === "forged-response") response.assignment_snapshot_v2 = { ...getAssignmentKernelSnapshotV2(f.binding.assignment_id)!, outcome: "awaiting_user_review", completion_proposal: { ...reviewProposal, review_id: "forged", proposed_at: new Date().toISOString(), verified: false }, pending_review_ids: ["forged"] };
      return response;
    } });
    assert.equal(result.stop_reason, stop === "external-cancel" ? "request_interrupted" : stop === "wall" ? "experiment_wall_limit" : "provider_turn_not_completed");
    assert.equal(result.turns, 1);
  }, true));
}

test("thin experiment needs explicit machine session selection, local mode, loopback shared-token auth", () => {
  const env = { REVIT_OPERATOR_MODE: "local", OPERATOR_THIN_REFERENCE_SESSION_IDS: "chosen,another" };
  const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test", { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" }) };
  assert.ok(localThinReferenceLimits({ session_id: "chosen" }, env, local));
  for (const mode of ["production", "hosted", "self_hosted", ""]) assert.equal(localThinReferenceLimits({ session_id: "chosen" }, { ...env, REVIT_OPERATOR_MODE: mode }, local), null);
  assert.equal(localThinReferenceLimits({ session_id: "chosen-plus" }, env, local), null);
  assert.equal(localThinReferenceLimits({ session_id: "chosen" }, env, { ...local, principal: {} as any }), null);
  assert.equal(localThinReferenceLimits({ session_id: "chosen" }, env, { operator_backend_auth: createOperatorBackendAuth("principal_jwt", "test") }), null);
  assert.equal(localThinReferenceLimits({ session_id: "chosen" }, env, { operator_backend_auth: createOperatorBackendAuth("shared_token", "test", { OPERATOR_API_BASE_URL: "https://remote.example" }) }), null);
  assert.equal(localThinReferenceLimits({ session_id: "chosen" }, {}, local), null);
  const thin = getThinReferenceCodexProfile("chosen"), normal = getCodexThreadStartProfile({ session_id: "chosen" }, { baseInstructions: "base", developerInstructions: "dev" });
  assert.notEqual(thin.threadKey, normal.threadKey); assert.equal(thin.dynamicToolMode, normal.dynamicToolMode); assert.equal(thin.sandbox, normal.sandbox);
});

test("C160-style completed provider turn with active assignment and no actions schedules the next turn", () => fixture(async f => {
  let active = 0, maxActive = 0;
  const result = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => {
    active++; maxActive = Math.max(active, maxActive);
    assert.equal(request.assignment_id, f.binding.assignment_id); assert.equal(request.message_id, "original");
    if (turn === 2) { assert.match(request.user_text!, /Continue the same/); controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "pause", expected_command_id: null }); }
    await Promise.resolve(); active--; return completed(request, turn);
  } });
  assert.equal(result.turns, 2); assert.equal(maxActive, 1);
  assert.equal(result.response.assignment_snapshot_v2?.execution_control?.state, "paused");
  assert.deepEqual(result.response.model_call_receipts?.map(r => r.call_id), ["receipt-1", "receipt-2"]);
  assert.equal(result.provider_turns.length, 2);
}));

for (const state of ["terminal", "paused", "input", "unknown", "operation", "provider", "exhausted"] as const) test(`continuation obeys durable ${state} before another provider dispatch`, () => fixture(async f => {
  const result = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => {
    assert.equal(turn, 1, "must never dispatch a second provider turn");
    const decision = f.inspect().decision;
    assert.equal(decision.decision, "admit_reasoning_turn");
    if (decision.decision !== "admit_reasoning_turn") throw new Error("fixture requires reasoning admission");
    const progress = { gap_ids: decision.gap_ids, criterion_ids: decision.criterion_ids, expected_information: decision.expected_information };
    if (state === "terminal") settleAssignmentKernelExecutionFailureV2({ binding: f.binding, failure_id: "canceled", error_class: "canceled", phase: "provider_turn" });
    if (state === "paused") controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "pause", expected_command_id: null });
    if (state === "input") requestAssignmentInputV2({ binding: f.binding, clarification_id: "question", variable_ids: ["floor_name"], new_variable_ids: ["floor_name"], question: "Which floor?" });
    if (state === "unknown" || state === "operation") { const lease = nativeUnknown(f); if (state === "unknown") failAssignmentKernelOperationV2(lease, new Error("lost acknowledgement"), "dispatched"); }
    if (state === "provider") recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "pending-provider", state: "admitted", provider: "codex", model: "same-model", ...progress });
    if (state === "exhausted") for (let i = 0; i < 32; i++) recordCompletedAssignmentProviderReceiptV2({ binding: f.binding, call_id: `spent-${i}`, provider: "codex", model: "same-model", reasoning_effort: "medium", ...progress, admitted_at: new Date().toISOString(), provider_duration_ms: 1, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, reasoning_tokens: null, estimated_cost_usd: null }, success: true });
    return completed(request, turn);
  } });
  assert.equal(result.turns, 1); assert.notEqual(result.stop_reason, "experiment_turn_limit");
}));

test("disconnect, interruption and a lost provider result are never replayed", () => fixture(async f => {
  const abort = new AbortController();
  const result = await runThinReferenceTurns({ ...f, signal: abort.signal, invoke: async (request, turn) => { abort.abort(); return completed(request, turn); } });
  assert.equal(result.turns, 1); assert.equal(result.stop_reason, "request_interrupted");
  const interrupted = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => ({ ...completed(request, turn), provider_turn_usage: { ...completed(request, turn).provider_turn_usage!, disposition: "interrupted" } }) });
  assert.equal(interrupted.turns, 1);
  let attempts = 0;
  await assert.rejects(runThinReferenceTurns({ ...f, invoke: async () => { attempts++; throw new Error("transport disconnected"); } }), /transport disconnected/);
  assert.equal(attempts, 1);
}));

test("loop has independent bounded turn and elapsed limits without claiming task completion", () => fixture(async f => {
  const turns = await runThinReferenceTurns({ ...f, invoke: async (request, turn) => completed(request, turn) });
  assert.equal(turns.turns, 3); assert.equal(turns.stop_reason, "experiment_turn_limit"); assert.equal(turns.response.assignment_snapshot_v2?.terminal, false);
  let now = 0;
  const wall = await runThinReferenceTurns({ ...f, now: () => now, invoke: async (request, turn) => { now = 60_000; return completed(request, turn); } });
  assert.equal(wall.turns, 1); assert.equal(wall.stop_reason, "experiment_wall_limit");
  const concise = prepareCodexAssignmentProgressV2(f.binding, true);
  assert.match(concise.prompt, /CURRENT TASK/); assert.doesNotMatch(concise.prompt, /model-observation-index|eligible_criterion_ids/);
}));

test("concurrent entry cannot dispatch twice for the same assignment", () => fixture(async f => {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => entered = resolve);
  const first = runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 1 }, invoke: async (request, turn) => { entered(); await new Promise<void>(resolve => release = resolve); return completed(request, turn); } });
  await ready;
  await assert.rejects(runThinReferenceTurns({ ...f, invoke: async () => { throw new Error("duplicate dispatch"); } }), /already_running/);
  release(); await first;
}));

test("thin input still transports source pixels and attachment receipts without duplicate turn-contract instructions", () => fixture(async f => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=", "base64");
  const attachment = storeAttachmentUpload({ session_id: f.request.session_id, filename: "source.png", data_base64: png.toString("base64") });
  const input = await buildCodexTurnInput({ ...f.request, user_attachments: [attachment] }, ["Saved task."], true);
  assert.equal(input.filter(item => item.type === "image").length, 1);
  const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(text, /VISUAL INPUT COVERAGE/); assert.match(text, /source.png/);
  assert.doesNotMatch(text, /HOST-ENFORCED TEAMMATE|TABULAR AUDIT/);
}));

test("a replacement provider thread on continuation two receives the original source pixels and handles", () => fixture(async f => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN8sAAAAASUVORK5CYII=", "base64");
  const attachment = storeAttachmentUpload({ session_id: f.request.session_id, filename: "original-source.png", data_base64: png.toString("base64") });
  const request = { ...f.request, user_attachments: [attachment] };
  const result = await runThinReferenceTurns({ ...f, request, limits: { ...f.limits, max_turns: 2 }, invoke: async (turnRequest, turn) => {
    // Build the second provider request independently: no prior provider
    // history survives the missing-thread replacement, and thin omits UI history.
    if (turn === 2) {
      const input = await buildCodexTurnInput(turnRequest, ["Current saved task."], true);
      assert.deepEqual(turnRequest.user_attachments, [attachment]);
      const images = input.filter(item => item.type === "image");
      assert.equal(images.length, 1); assert.ok("url" in images[0]); assert.equal(images[0].url, `data:image/png;base64,${png.toString("base64")}`);
      const text = input.filter(item => item.type === "text").map(item => item.text).join("\n");
      assert.match(text, /original-source.png/); assert.ok(text.includes(attachment.id));
      assert.ok(text.includes(attachment.sha256!));
    }
    return completed(turnRequest, turn);
  } });
  assert.equal(result.turns, 2);
}));

for (const setup of ["initial-thread", "missing-thread-recovery"] as const) {
  for (const stop of ["pause", "cancel", "wall-limit"] as const) test(`${stop} during asynchronous ${setup} setup prevents bound provider dispatch`, () => fixture(async f => {
    const controller = new AbortController();
    let release!: () => void, dispatches = 0;
    const setupComplete = new Promise<void>(resolve => release = resolve);
    const pending = (async () => {
      await setupComplete;
      return startCodexProviderTurnWhenActive({ signal: controller.signal, binding: f.binding,
        readSnapshot: () => getAssignmentKernelSnapshotV2(f.binding.assignment_id) }, async () => { dispatches++; return { turn: { id: "unexpected" } }; });
    })();
    if (stop === "pause") controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "pause-during-setup", expected_command_id: null });
    else controller.abort(stop === "wall-limit" ? "experiment_wall_limit" : "request_interrupted");
    release();
    await assert.rejects(pending, (error: unknown) => error instanceof CodexProviderStartStopped && error.reason === (
      stop === "pause" ? "user_requested_pause" : stop === "wall-limit" ? "experiment_wall_limit" : "request_interrupted"));
    assert.equal(dispatches, 0);
  }));
}

test("start-time guard admits one active bound dispatch and rejects a stale binding", () => fixture(async f => {
  let calls = 0;
  const result = await startCodexProviderTurnWhenActive({ binding: f.binding, signal: f.signal, readSnapshot: () => getAssignmentKernelSnapshotV2(f.binding.assignment_id) }, async () => { calls++; return "started"; });
  assert.equal(result, "started"); assert.equal(calls, 1);
  assert.throws(() => startCodexProviderTurnWhenActive({ binding: { ...f.binding, generation: f.binding.generation + 1 }, signal: f.signal,
    readSnapshot: () => getAssignmentKernelSnapshotV2(f.binding.assignment_id) }, async () => { calls++; return "unexpected"; }), /assignment_binding_changed/);
  assert.equal(calls, 1);
}));


function receiptOnlyTurn(f: ReturnType<typeof start>, request: ChatRequest, turn: number, options: { checkpoint?: boolean; wrongTurn?: boolean; idPrefix?: string } = {}): ChatResponse {
  const before = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!;
  const callId = `${options.idPrefix ?? "empty"}-${turn}`, turnId = `turn-${turn}`;
  recordCompletedAssignmentProviderReceiptV2({ binding: f.binding, call_id: callId, controller_turn_id: options.wrongTurn ? "foreign" : turnId,
    provider: "fixture", model: "fixture", reasoning_effort: "medium", gap_ids: [], criterion_ids: [], expected_information: ["Continue retained work."],
    admitted_at: new Date().toISOString(), provider_duration_ms: null, usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, reasoning_tokens: 0, estimated_cost_usd: null }, success: true });
  const response = { ...completed(request, turn), model_call_receipts: [{ call_id: callId } as any],
    provider_turn_usage: { ...completed(request, turn).provider_turn_usage!, raw_response_ids: [callId] } };
  if (options.checkpoint !== false) checkpointCodexAssignmentProgressV2({ binding: f.binding, turn_start: before, receipts: response.model_call_receipts });
  return response;
}

test("eight receipt-only completed turns stop after the existing four allowance without changing task or cumulative usage", () => fixture(async f => {
  const before = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!;
  const run = (idPrefix: string) => runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 8 }, invoke: async (request, turn) => receiptOnlyTurn(f, request, turn, { idPrefix }) });
  const result = await run("first");
  assert.equal(result.turns, 4); assert.equal(result.stop_reason, "completed_turns_without_retained_work");
  const after = getAssignmentKernelSnapshotV2(f.binding.assignment_id)!;
  assert.deepEqual(after.spec, before.spec); assert.deepEqual(after.current_binding, before.current_binding);
  assert.deepEqual(after.operations, before.operations); assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.execution_control, before.execution_control); assert.equal(after.terminal, false); assert.equal(after.outcome, "active");
  assert.equal(after.completion_proposal, undefined); assert.equal(after.provider_call_ids.length, 4);
  assert.equal(after.assignment_version - before.assignment_version, 8, "only four receipts and four host epochs");
  assert.equal(after.progress_epochs.length, 4); assert(after.progress_epochs.every(epoch => !epoch.genuine_progress));
  assert.equal(result.response.model_call_receipts!.length, 4);
  const next = await run("explicit-followup");
  assert.equal(next.turns, 4); assert.equal(getAssignmentKernelSnapshotV2(f.binding.assignment_id)!.provider_call_ids.length, 8, "new run does not reset usage");
}, true));

for (const changed of ["plan", "direction", "receipt-only-direction", "control", "operation"] as const) {
  test(`retained ${changed} change resets empty completed-turn streak`, () => fixture(async f => {
    const result = await runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 8 }, invoke: async (request, turn) => {
      if (turn === 3) {
        if (changed === "plan") manageAssignmentWorkPlan({ binding: f.binding, action: "declare", declaration: { items: [{ item_id: "note", description: "Correct the note", source_basis: "User request" }], assumptions: [] } });
        if (changed === "direction") await steerAssignment({ binding: f.binding, command_id: "new-direction", text: "Keep the original task and check the note.", expected_turn_id: null });
        if (changed === "receipt-only-direction") appendEvent(f.binding.session_id, "user", "task.steering", { binding: f.binding, command_id: "saved-prefix", text: "A genuinely new direction.", state: "saved", updated_at: new Date().toISOString() });
        if (changed === "control") controlAssignmentExecutionV2({ binding: f.binding, action: "resume", command_id: "new-control", expected_command_id: null });
        if (changed === "operation") {
          const lease = openAssignmentKernelOperationV2({ snapshot: getAssignmentKernelSnapshotV2(f.binding.assignment_id)!, provider_turn_id: "turn-3", controller_request_id: "attempt",
            capability_id: "revit_call_tool", classified_effect: "read", arguments: { method: "GET", path: "/revit/context" } });
          failAssignmentKernelOperationV2(lease, new Error("Rejected before dispatch"), "not_dispatched");
        }
      }
      return receiptOnlyTurn(f, request, turn);
    } });
    assert.equal(result.turns, 7); assert.equal(result.stop_reason, "completed_turns_without_retained_work");
  }, true));
}

for (const unsupported of ["no-epoch", "wrong-turn", "repeated-old-usage", "unaccounted-epoch", "empty-ids", "duplicate-ids", "invalid-ids", "blank-id", "old-epoch"] as const) {
  test(`unproven ${unsupported} cannot count as a completed no-work turn`, () => fixture(async f => {
    const result = await runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 6 }, invoke: async (request, turn) => {
      const response = receiptOnlyTurn(f, request, turn, { checkpoint: unsupported !== "no-epoch" && !(unsupported === "old-epoch" && turn > 1), wrongTurn: unsupported === "wrong-turn" });
      if (unsupported === "empty-ids") response.provider_turn_usage!.raw_response_ids = [];
      if (unsupported === "duplicate-ids") response.provider_turn_usage!.raw_response_ids = [`empty-${turn}`, `empty-${turn}`];
      if (unsupported === "invalid-ids") response.provider_turn_usage!.raw_response_ids = null as any;
      if (unsupported === "blank-id") response.provider_turn_usage!.raw_response_ids = [" "];
      if (unsupported === "repeated-old-usage") response.provider_turn_usage = { ...response.provider_turn_usage!, raw_response_ids: ["stale-call"] };
      if (unsupported === "unaccounted-epoch") recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: `empty-${turn}`, state: "response_transport_completed" });
      return response;
    } });
    assert.equal(result.turns, 6); assert.equal(result.stop_reason, "experiment_turn_limit");
  }, true));
}

for (const stop of ["pause", "input", "review", "unknown", "provider", "budget"] as const) {
  test(`fresh canonical ${stop} wins over the fourth empty-turn stop`, () => fixture(async f => {
    let returned = 0;
    const result = await runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 8 },
      inspect: () => { const current = f.inspect(); return stop === "budget" && returned === 4
        ? { snapshot: current.snapshot, decision: decideAssignmentProgressV2({ snapshot: current.snapshot, budget: { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_provider_calls: 4 }, now: new Date().toISOString() }) } : current; },
      invoke: async (request, turn) => {
        const response = receiptOnlyTurn(f, request, turn); returned = turn;
        if (turn === 4) {
          if (stop === "pause") controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "new-pause", expected_command_id: null });
          if (stop === "input") requestAssignmentInputV2({ binding: f.binding, clarification_id: "needed", variable_ids: ["room"], new_variable_ids: ["room"], question: "Which room?" });
          if (stop === "review") propose(f);
          if (stop === "unknown") { const lease = nativeUnknown(f); failAssignmentKernelOperationV2(lease, new Error("Lost response"), "dispatched"); }
          if (stop === "provider") recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "pending-provider", state: "admitted", provider: "fixture", model: "fixture", gap_ids: [], criterion_ids: [], expected_information: ["Pending work"] });
        }
        return response;
      } });
    assert.equal(result.turns, 4); assert.notEqual(result.stop_reason, "completed_turns_without_retained_work");
    assert.notEqual(result.stop_reason, "experiment_turn_limit");
  }, true));
}

test("the fourth active invocation remains awaited through deliberation or compaction, preserving cancellation", () => fixture(async f => {
  const abort = new AbortController(); let release!: () => void, entered!: () => void, settled = false;
  const ready = new Promise<void>(resolve => entered = resolve);
  const pending = runThinReferenceTurns({ ...f, signal: abort.signal, limits: { ...f.limits, max_turns: 8 }, invoke: async (request, turn) => {
    if (turn === 4) { entered(); await new Promise<void>(resolve => release = resolve); }
    return receiptOnlyTurn(f, request, turn);
  } }).then(result => { settled = true; return result; });
  await ready; await Promise.resolve(); assert.equal(settled, false); assert.equal(abort.signal.aborted, false);
  controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "pause-active", expected_command_id: null });
  release(); const result = await pending;
  assert.notEqual(result.stop_reason, "completed_turns_without_retained_work"); assert.equal(result.turns, 4);
}, true));

test("configured turn cap retains precedence over the fourth empty completion", () => fixture(async f => {
  const result = await runThinReferenceTurns({ ...f, limits: { ...f.limits, max_turns: 4 }, invoke: async (request, turn) => receiptOnlyTurn(f, request, turn) });
  assert.equal(result.turns, 4); assert.equal(result.stop_reason, "experiment_turn_limit");
}, true));
