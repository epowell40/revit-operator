import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA, commitAssignmentKernelObservationV2,
  markAssignmentKernelOperationDispatchStartedV2, openAssignmentKernelOperationV2,
  settleAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { settleAssignmentKernelExecutionFailureV2 } from "../src/assignments/assignment_kernel_v2_execution_failure.js";
import * as journal from "../src/assignments/assignment_kernel_v2_store.js";
import { canonicalJsonV2, OPERATION_RESULT_V2_SCHEMA } from "../src/domain/assignment-kernel/index.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { __testOnlyResetGoalListCache, createGoal, getGoal, getGoalStoragePath } from "../src/goals/service.js";

function workspace(fn: () => void) {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-settlement-batch-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try { fn(); } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function setup(effect: "read" | "apply" = "read") {
  const goal = createGoal({ title: "Inventory elements", objective: "Return the requested inventory.",
    acceptance_criteria: ["The requested result is authoritatively established."], status: "active",
    related_session_id: "session-batch", created_by: "principal-batch",
    work_budget: { requested_effect: effect, document_fingerprint: "document-batch" } });
  createAssignmentKernelForGoalV2({ goal, run_id: "run-batch" });
  const snapshot = journal.getAssignmentKernelSnapshotV2(goal.id)!;
  const lease = openAssignmentKernelOperationV2({ snapshot, controller_request_id: "inventory",
    provider_turn_id: "provider-turn", capability_id: effect === "read" ? "inventory.read" : "element.update", classified_effect: effect, arguments: {} });
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const payload = { elements: [{ id: 42 }], total: 1 };
  const envelope = { structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
    operation_result_v2: { schema: OPERATION_RESULT_V2_SCHEMA, result_id: `result-${lease.operation_id}`,
      operation_id: lease.operation_id, binding: lease.binding, status: "succeeded", dispatch_state: "dispatched",
      persistent_effect: effect === "apply" ? "applied" : "none", native_transaction_state: effect === "apply" ? "committed" : "not_applicable", authority: "native-host",
      result_schema_id: "operator-capability/inventory.read/v2", observation_required: true,
      raw_payload_hash: createHash("sha256").update(canonicalJsonV2(payload)).digest("hex"),
      receipt_id: `receipt-${lease.operation_id}`, native_correlation_id: `native-${lease.operation_id}`,
      request_identity: journal.getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!.request_identity,
      completed_at: "2026-09-26T03:00:05.000Z" },
    observation: { raw_payload: payload, semantic_facts: [
      { fact_id: "task.result_available", fact_class: "domain", value: true },
      { fact_id: "inventory.complete", fact_class: "domain", value: true },
      { fact_id: "inventory.total", fact_class: "domain", value: 1 }
    ], verification_relevance: ["task_result"] } } };
  if (effect === "apply") envelope.structuredContent.observation.semantic_facts = [
    { fact_id: "control.result_available", fact_class: "control", value: true }
  ];
  return { goal, lease, envelope };
}

test("native result and prepared observation settle in one durable write after separate dispatch", () => workspace(() => {
  const { goal, lease, envelope } = setup();
  const before = getGoal(goal.id)!;
  const settled = settleAssignmentKernelOperationV2(lease, envelope);
  const after = getGoal(goal.id)!;
  assert.equal(after.revision! - before.revision!, 2, "one durable native dispatch plus one result/observation settlement");
  const events = (after.assignment_kernel_v2 as journal.AssignmentKernelJournalRecordV2).events;
  assert.deepEqual(events.slice(-3).map(event => event.event_type), ["native_dispatch_recorded", "operation_result_recorded", "observation_retained"]);
  assert.equal(settled.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  __testOnlyResetGoalListCache();
  assert.deepEqual(journal.getAssignmentKernelSnapshotV2(goal.id), settled.snapshot);
}));

function retainedPair(effect: "read" | "apply" = "read") {
  const context = setup(effect);
  const final = settleAssignmentKernelOperationV2(context.lease, context.envelope);
  const file = getGoalStoragePath(context.goal.id)!;
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const events = saved.assignment_kernel_v2.events;
  const [result, observation] = events.slice(-2);
  const toInput = (event: any): any => {
    const { schema, assignment_id, assignment_version, event_id, binding, actor, occurred_at, ...body } = event;
    return { goal_id: assignment_id, event_id, binding, actor, occurred_at, body };
  };
  const prefix = { ...saved, assignment_kernel_v2: { ...saved.assignment_kernel_v2, events: events.slice(0, -2) } };
  const reset = () => { fs.writeFileSync(file, JSON.stringify(prefix)); __testOnlyResetGoalListCache(); };
  reset();
  return { ...context, final, file, prefix, reset, pair: { result_event: toInput(result), observation_event: toInput(observation) } };
}

test("batch replay equals sequential reduction with identical IDs, ordering and duplicate/conflict rules", () => workspace(() => {
  const f = retainedPair();
  journal.appendCurrentAssignmentKernelEventV2(f.pair.result_event);
  const sequential = journal.appendCurrentAssignmentKernelEventV2(f.pair.observation_event);
  f.reset();
  const batched = journal.appendAssignmentKernelObservationSettlementV2(f.pair);
  assert.deepEqual(batched.snapshot, sequential.snapshot);
  assert.deepEqual((batched.goal.assignment_kernel_v2 as any).events, (sequential.goal.assignment_kernel_v2 as any).events);
  assert.equal(sequential.goal.revision! - batched.goal.revision!, 1);
  assert.deepEqual(journal.appendAssignmentKernelObservationSettlementV2(f.pair).snapshot, batched.snapshot);
  const conflict = structuredClone(f.pair);
  conflict.result_event.body.result.receipt_id = "conflicting-receipt";
  assert.throws(() => journal.appendAssignmentKernelObservationSettlementV2(conflict), /assignment_event_id_conflict/);
  assert.deepEqual(journal.getAssignmentKernelSnapshotV2(f.goal.id), batched.snapshot);
}));

test("invalid second event preserves the accepted committed native result and quarantines only observation", () => workspace(() => {
  const f = retainedPair("apply");
  f.pair.observation_event.body.observation.raw_payload_hash = "0".repeat(64);
  assert.throws(() => journal.appendAssignmentKernelObservationSettlementV2(f.pair));
  __testOnlyResetGoalListCache();
  const snapshot = journal.getAssignmentKernelSnapshotV2(f.goal.id)!;
  const operation = snapshot.operations[f.lease.operation_id]!;
  assert.equal(operation.result?.persistent_effect, "applied");
  assert.equal(operation.settlement_state, "retaining_observation");
  assert.equal(operation.observation_ids.length, 0);
  const saved = getGoal(f.goal.id)!.assignment_kernel_v2 as journal.AssignmentKernelJournalRecordV2;
  assert.equal(saved.events.at(-1)!.event_type, "operation_result_recorded");
  assert.equal(saved.quarantined_events.at(-1)!.event.event_type, "observation_retained");
  assert.notEqual(snapshot.outcome, "complete");
}));

test("preparation failure retains result and observation retry without native replay", () => workspace(() => {
  const { goal, lease, envelope } = setup("apply");
  assert.throws(() => settleAssignmentKernelOperationV2(lease, envelope, { storeEvidence() { throw Error("fixture-evidence-unavailable"); } }), /fixture-evidence-unavailable/);
  const pending = journal.getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
  assert.equal(pending.result?.persistent_effect, "applied");
  assert.equal(pending.observation_commit_attempts, 1);
  const recovered = commitAssignmentKernelObservationV2(lease);
  assert.equal(recovered.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  const saved = getGoal(goal.id)!.assignment_kernel_v2 as journal.AssignmentKernelJournalRecordV2;
  assert.equal(saved.events.filter(e => e.event_type === "native_dispatch_recorded").length, 1);
  assert.equal(saved.events.filter(e => e.event_type === "operation_result_recorded").length, 1);
  settleAssignmentKernelOperationV2(lease, envelope, { storeEvidence() { throw Error("duplicate must only rehydrate"); } });
}));

test("a pause arriving during out-of-lock preparation survives settlement and blocks new admission", () => workspace(() => {
  const { goal, lease, envelope } = setup("apply");
  const settled = settleAssignmentKernelOperationV2(lease, envelope, { storeEvidence(input, max) {
    const module = pathToFileURL(path.resolve("src/assignments/assignment_kernel_v2_controls.ts")).href;
    const command = { binding: lease.binding, command_id: "pause-during-preparation", expected_command_id: null, action: "pause" };
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { controlAssignmentExecutionV2 } from ${JSON.stringify(module)}; controlAssignmentExecutionV2(${JSON.stringify(command)});`],
      { encoding: "utf8", env: process.env, timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    return storeEvidence(input, max);
  } });
  assert.equal(settled.snapshot.execution_control?.state, "paused");
  assert.equal(getGoal(goal.id)!.status, "paused");
  assert.throws(() => openAssignmentKernelOperationV2({ snapshot: settled.snapshot,
    controller_request_id: "after-pause", provider_turn_id: "after-pause", capability_id: "operator_retrieve_evidence",
    classified_effect: "evidence_read", arguments: { evidenceId: "different" } }), /paused/);
}));

test("same-size same-revision history edits invalidate warm projections and malformed revisions reject both events", () => workspace(() => {
  const f = retainedPair();
  const prior = fs.readFileSync(f.file, "utf8"), stamp = fs.statSync(f.file);
  const changed = JSON.parse(prior);
  const oldText = changed.assignment_kernel_v2.events[0].spec.source_user_request;
  changed.assignment_kernel_v2.events[0].spec.source_user_request = oldText.replace("requested", "different");
  const bytes = JSON.stringify(changed);
  assert.notEqual(bytes, prior);
  assert.equal(Buffer.byteLength(bytes), Buffer.byteLength(prior));
  fs.writeFileSync(f.file, bytes); fs.utimesSync(f.file, stamp.atime, stamp.mtime);
  const accepted = journal.appendAssignmentKernelObservationSettlementV2(f.pair);
  assert.equal(accepted.snapshot.spec.source_user_request, oldText.replace("requested", "different"));
  f.reset();
  const malformed = JSON.parse(fs.readFileSync(f.file, "utf8"));
  malformed.assignment_kernel_v2.events[1].assignment_version += 10;
  fs.writeFileSync(f.file, JSON.stringify(malformed));
  assert.throws(() => journal.appendAssignmentKernelObservationSettlementV2(f.pair), /version/i);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).assignment_kernel_v2.events.length, f.prefix.assignment_kernel_v2.events.length);
}));

test("a stale observation binding cannot overwrite the fresh durable journal", () => workspace(() => {
  const f = retainedPair();
  f.pair.observation_event.binding = { ...f.lease.binding, generation: f.lease.binding.generation + 1 };
  assert.throws(() => journal.appendAssignmentKernelObservationSettlementV2(f.pair));
  const snapshot = journal.getAssignmentKernelSnapshotV2(f.goal.id)!;
  assert.deepEqual(snapshot.current_binding, f.lease.binding);
  assert.equal(snapshot.operations[f.lease.operation_id]!.settlement_state, "retaining_observation");
}));

test("cancellation arriving during preparation retains the cancellation and late native receipt", () => workspace(() => {
  const { goal, lease, envelope } = setup("apply");
  const settled = settleAssignmentKernelOperationV2(lease, envelope, { storeEvidence(input, max) {
    settleAssignmentKernelExecutionFailureV2({ binding: lease.binding, failure_id: "cancel-during-preparation",
      error_class: "canceled", phase: "provider_turn" });
    return storeEvidence(input, max);
  } });
  assert.equal(settled.snapshot.execution_failures["cancel-during-preparation"]?.error_class, "canceled");
  assert.equal(settled.snapshot.operations[lease.operation_id]!.result?.persistent_effect, "applied");
  assert.equal(settled.snapshot.operations[lease.operation_id]!.settlement_state, "settled");
  assert.notEqual(settled.snapshot.outcome, "complete");
  assert.equal(Object.keys(journal.getAssignmentKernelSnapshotV2(goal.id)!.operations).length, 1);
}));

test("failed atomic replacement does not seed an accepted batch into subsequent reads", () => workspace(() => {
  const f = retainedPair();
  const before = journal.getAssignmentKernelSnapshotV2(f.goal.id)!;
  const rename = fs.renameSync;
  fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (path.resolve(String(target)) === path.resolve(f.file)) throw Error("fixture-replace-failed");
    return rename(source, target);
  }) as typeof fs.renameSync;
  try { assert.throws(() => journal.appendAssignmentKernelObservationSettlementV2(f.pair), /fixture-replace-failed/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(journal.getAssignmentKernelSnapshotV2(f.goal.id), before);
  assert.deepEqual(journal.appendAssignmentKernelObservationSettlementV2(f.pair).snapshot, f.final.snapshot);
}));
