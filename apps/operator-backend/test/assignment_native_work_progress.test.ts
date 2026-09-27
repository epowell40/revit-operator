import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AssignmentJournalV2, type AssignmentEventV2, type AssignmentSnapshotV2, type OperationV2,
  type OperationResultV2, type ObservationV2, type AssignmentSpecV2 } from "../src/domain/assignment-kernel/index.js";
import { buildHostProgressEpochV2 } from "../src/assignments/supporting_discovery_progress.js";
import { deriveProgressGapsV2, decideAssignmentProgressV2 } from "../src/domain/assignment-kernel/progress/controller.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { appliedOperationHasVerifiedPostconditionV2 } from "../src/domain/assignment-kernel/outcome.js";

type Stage = { operation: OperationV2; result: OperationResultV2; observation: ObservationV2 };
const fixture = JSON.parse(fs.readFileSync("test/fixtures/native-progress-repaired-thin.json", "utf8")) as {
  spec: AssignmentSpecV2; declaration: unknown; stages: Stage[]; prelude: AssignmentEventV2[];
};
function append(j: AssignmentJournalV2, body: object, at = "2026-09-26T01:12:50.072Z") {
  const v = j.events().length + 1;
  return j.append({ schema: "revit-operator.assignment-event/v2", event_id: `progress-replay-${v}`,
    assignment_id: fixture.spec.binding.assignment_id, assignment_version: v, binding: fixture.spec.binding,
    occurred_at: at, actor: "retained-native-progress-replay", ...body } as AssignmentEventV2);
}
function journal() {
  // Preserve all earlier native facts and active work-unit states. Without
  // these a shortened fixture accidentally earns "new field" progress.
  return new AssignmentJournalV2(fixture.prelude);
}
function settle(j: AssignmentJournalV2, stage: Stage) {
  append(j, { event_type: "operation_admitted", operation: stage.operation }, stage.operation.opened_at);
  append(j, { event_type: "native_dispatch_recorded", operation_id: stage.operation.operation_id,
    native_correlation_id: stage.result.native_correlation_id }, stage.operation.opened_at);
  append(j, { event_type: "operation_result_recorded", result: stage.result }, stage.result.completed_at);
  return append(j, { event_type: "observation_retained", observation: stage.observation }, stage.observation.observed_at);
}
function epoch(before: AssignmentSnapshotV2, after: AssignmentSnapshotV2) {
  return buildHostProgressEpochV2({ before, after, stated_gap_ids: deriveProgressGapsV2(before).map(g => g.gap_id),
    recorded_at: "2026-09-26T01:12:50.072Z" });
}
function replay() {
  const j = journal();
  const transitions = fixture.stages.map(stage => { const before = j.snapshot(); return { before, after: settle(j, stage), stage }; });
  return { j, transitions };
}

test("retained repaired-thin native commits and exact readbacks are progress without completing the drawing", () => {
  const { transitions } = replay();
  for (const { before, after, stage } of transitions) {
    const e = epoch(before, after);
    if (stage.operation.requested_effect === "apply") assert(e.progress_reasons.includes("native_change_committed"));
    if (stage.operation.purpose === "verification") {
      assert(e.progress_reasons.includes("verification_observation_added"));
      assert.equal(appliedOperationHasVerifiedPostconditionV2(after, stage.operation.verification_of_operation_id!), false,
        "a useful connector read does not certify the requested geometry or close its proof gap");
    }
    if (stage.operation.requested_effect === "preview") assert.equal(e.genuine_progress, false, "rollback alone buys no progress");
    assert.equal(after.terminal, false);
    assert.deepEqual(after.criteria, {});
  }
});

test("journal/controller replay admits work after two readbacks and two previews with original hard limits", () => {
  const j = journal();
  for (const stage of fixture.stages) {
    const before = j.snapshot(), after = settle(j, stage);
    append(j, { event_type: "progress_epoch_recorded", epoch: epoch(before, after) });
  }
  const state = new AssignmentJournalV2(j.events()).snapshot();
  const decision = (snapshot: AssignmentSnapshotV2, budget = DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2) =>
    decideAssignmentProgressV2({ snapshot, budget, now: "2026-09-26T01:12:50.135Z" });
  assert.equal(decision(state).decision, "admit_reasoning_turn");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_operations: 1 }).reason, "operation_budget_exhausted");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_total_tokens: 0 }).reason, "token_budget_exhausted");
  assert.equal(decision(state, { ...DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, max_wall_clock_ms: 1 }).reason, "execution_lease_exhausted");
  assert.equal(decision({ ...state, unresolved_unknown_operation_ids: [fixture.stages[0]!.operation.operation_id] }).decision, "reconcile_operation");
  const noProgress = epoch(state, state);
  const stalled = { ...state, progress_epochs: [...state.progress_epochs,
    ...Array.from({ length: DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2.max_no_progress_epochs }, (_, i) =>
      ({ ...noProgress, epoch_id: `unchanged-repeat-${i}` }))] };
  assert.equal(decision(stalled).reason, "no_progress_budget_exhausted", "unchanged repeated work still hits the same stall limit");
});

test("readback repeats and authority, target, binding, settlement, and receipt substitutions earn no new progress", () => {
  const { transitions } = replay();
  const read = [...transitions].reverse().find(t => t.stage.operation.purpose === "verification")!;
  const id = read.stage.operation.operation_id, obsId = read.stage.observation.observation_id;
  const variants = ["failed", "unknown", "preview", "nonnative", "stale", "unlinked", "payload_mismatch", "wrong_subject",
    "wrong_target", "before_commit", "missing_subject_link"];
  for (const variant of variants) {
    const bad = structuredClone(read.after), op = bad.operations[id]!, obs = bad.observations[obsId]!;
    if (variant === "failed") op.result!.status = "failed_after_dispatch";
    if (variant === "unknown") op.persistent_effect = "unknown";
    if (variant === "preview") op.requested_effect = "preview";
    if (variant === "nonnative") op.result!.authority = "operator-mcp-transport";
    if (variant === "stale") obs.binding = { ...obs.binding, generation: 0 };
    if (variant === "unlinked") op.observation_ids = [];
    if (variant === "payload_mismatch") obs.raw_payload_hash = "different";
    if (variant === "wrong_subject") op.verification_of_operation_id = "missing";
    if (variant === "wrong_target") op.target = { ...op.target, target_id: "id:999999" };
    if (variant === "before_commit") op.opened_at = fixture.spec.created_at;
    if (variant === "missing_subject_link") bad.operations[op.verification_of_operation_id!]!.verification_operation_ids = [];
    assert.equal(epoch(read.before, bad).genuine_progress, false, variant);
  }
  const cloned = structuredClone(read.after);
  const repeated = { ...cloned, operations: { ...cloned.operations }, observations: { ...cloned.observations } };
  const original = repeated.operations[id]!;
  const cloneId = "repeated-native-verification", cloneObsId = "repeated-observation";
  repeated.operations[cloneId] = { ...original, operation_id: cloneId, observation_ids: [cloneObsId],
    input: { ...original.input, body: { ...(original.input.body as object), requestId: "new", timestamp: "new", limit: 9999 } },
    result: { ...original.result!, operation_id: cloneId, receipt_id: "another", raw_payload_hash: "another" } };
  repeated.observations[cloneObsId] = { ...repeated.observations[obsId]!, observation_id: cloneObsId, operation_id: cloneId, raw_payload_hash: "another" };
  const subject = repeated.operations[original.verification_of_operation_id!]!;
  subject.verification_operation_ids = [...subject.verification_operation_ids, cloneId];
  assert.equal(epoch(read.after, repeated).genuine_progress, false, "new receipts and presentation knobs cannot credit the same read twice");
});

test("a duplicate native receipt or unconfirmed apply cannot masquerade as another committed edit", () => {
  const { transitions } = replay();
  const apply = [...transitions].reverse().find(t => t.stage.operation.requested_effect === "apply")!;
  const id = apply.stage.operation.operation_id;
  for (const variant of ["failed", "unknown", "rollback", "nonnative", "no_receipt", "empty_targets", "stale", "unlinked", "duplicate_receipt"]) {
    const bad = structuredClone(apply.after), op = bad.operations[id]!;
    if (variant === "failed") op.result!.status = "failed_after_dispatch";
    if (variant === "unknown") op.persistent_effect = "unknown";
    if (variant === "rollback") op.result!.native_transaction_state = "rolled_back";
    if (variant === "nonnative") op.result!.authority = "dynamic-runtime";
    if (variant === "no_receipt") { op.result!.receipt_id = undefined; op.result!.native_correlation_id = undefined; }
    if (variant === "empty_targets") op.result!.affected_target_identities = [];
    if (variant === "stale") op.binding = { ...op.binding, generation: 0 };
    if (variant === "unlinked") op.observation_ids = [];
    if (variant === "duplicate_receipt") op.result!.receipt_id = fixture.stages[0]!.result.receipt_id;
    assert.equal(epoch(apply.before, bad).genuine_progress, false, variant);
  }
});
