import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoal, getGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2,
  settleAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { AssignmentJournalV2, canonicalJsonV2, type OperationV2, type AssignmentEventV2 } from "../src/domain/assignment-kernel/index.js";

async function workspace(fn: () => void, maxOperations = "256") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-document-checkpoint-"));
  const env = { OPERATOR_WORKSPACE_ROOT: root, REVIT_OPERATOR_MODE: "development", OPERATOR_LOCAL_EXECUTOR_PROFILE: "codex_v2_advisory_v1",
    OPERATOR_ASSIGNMENT_KERNEL_V2: "1", OPERATOR_BRAIN: "codex", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory", OPERATOR_HOSTED_ENABLED: "0",
    OPERATOR_ADVISORY_MAX_OPERATIONS: maxOperations };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env); __testOnlyResetGoalListCache();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only",
    { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" }) }, fn); }
  finally {
    __testOnlyResetGoalListCache(); __closeForTests();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const filePath = "C:/fixture/working-draft.rvt", documentFingerprint = "a".repeat(64);
function setup() {
  const goal = createGoal({ title: "Retain model edits", objective: "Edit the model and save the working document after changes.",
    acceptance_criteria: ["The changed document is saved."], status: "active", related_session_id: "checkpoint-session", created_by: "local-host",
    work_budget: { requested_effect: "apply", document_fingerprint: documentFingerprint } });
  createAssignmentKernelForGoalV2({ goal, run_id: "checkpoint-run" });
  return { goal, state: () => getAssignmentKernelSnapshotV2(goal.id)!,
    journal: () => new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events) };
}
type Fixture = ReturnType<typeof setup>;
type Lease = ReturnType<typeof openAssignmentKernelOperationV2>;
function save(f: Fixture, id: string, extra = {}) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: [`path:${filePath.toLowerCase()}`],
    arguments: { method: "POST", path: "/revit/save-as", body: { filePath, overwrite: true, dryRun: false, ...extra } } });
}
function change(f: Fixture, id: string, element = 11, value = id) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: [`id:${element}`],
    arguments: { method: "POST", path: "/revit/set-parameter", body: {
      changes: [{ elementId: element, parameterName: "Comments", value }], dryRun: false } } });
}
function settle(f: Fixture, lease: Lease, artifact = false, transform?: (result: any, payload: any) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const op = f.state().operations[lease.operation_id]!;
  const identity = { session_id: "native-document", project_fingerprint: documentFingerprint, path: filePath };
  const receipt = { schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: "/revit/save-as",
    phase: "apply", status: "complete", expected_output_paths: [filePath], expected_export_calls: 1, export_calls: [true],
    outputs: [{ path: filePath, size_bytes: 123456, sha256: "b".repeat(64), fresh_output: true, stable_read: true }],
    save_document: { native_save_returned: true, same_document: true, document_session_changed: false,
      before: identity, after: identity, document_path_changed: false, project_binding_changed: false } };
  const payload: any = artifact ? { status: "Saved", artifact_receipt: receipt }
    : { status: "Applied", transaction: { status: "committed" }, modifiedElementIds: [11] };
  const result: any = { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
    binding: lease.binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: "applied",
    native_transaction_state: artifact ? "not_applicable" : "committed", authority: "native-host",
    result_schema_id: `operator-native/POST:${op.request_identity?.path}/v2`, observation_required: true,
    affected_target_identities: artifact ? [`artifact_path:${filePath}`] : ["element_id:11"],
    receipt_id: `receipt:${lease.operation_id}`, native_correlation_id: `native:${lease.operation_id}`,
    request_identity: op.request_identity, completed_at: new Date().toISOString(), ...(artifact ? { native_artifact_receipt: receipt } : {}) };
  transform?.(result, payload);
  result.raw_payload_hash = createHash("sha256").update(canonicalJsonV2(payload)).digest("hex");
  return settleAssignmentKernelOperationV2(lease, { content: [], structuredContent: {
    schema: "revit-operator.assignment-kernel-mcp-result/v2", operation_result_v2: result,
    observation: { raw_payload: payload, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: true }], verification_relevance: ["task_result"] }
  } });
}
function proposal(journal: AssignmentJournalV2, prior: OperationV2, changed: string): AssignmentEventV2 {
  const state = journal.snapshot();
  return { schema: "revit-operator.assignment-event/v2", event_id: "checkpoint-admission", assignment_id: state.current_binding.assignment_id,
    assignment_version: state.assignment_version + 1, binding: state.current_binding, actor: "test", occurred_at: new Date().toISOString(),
    event_type: "operation_admitted", operation: { ...prior, operation_id: "next-checkpoint", delegation_authority_id: "delegation:next-checkpoint",
      admission_state: "admitted", dispatch_state: "not_dispatched", settlement_state: "open", persistent_effect: "none", result: undefined,
      observation_ids: [], verification_operation_ids: [], settled_at: undefined,
      checkpoint_of_operation_id: prior.operation_id, checkpoint_after_operation_id: changed } } as AssignmentEventV2;
}

test("runtime admits a fresh document checkpoint after a later committed edit, preserving ordinary write deduplication", () => workspace(() => {
  const f = setup(), first = save(f, "save-first"); settle(f, first, true);
  const edit = change(f, "edit"); settle(f, edit);
  __testOnlyResetGoalListCache();
  const next = save(f, "save-next"), op = f.state().operations[next.operation_id]!;
  assert.equal((op as any).checkpoint_of_operation_id, first.operation_id);
  assert.equal((op as any).checkpoint_after_operation_id, edit.operation_id);
  assert.equal(op.retry_of_operation_id, undefined);
  assert.equal(op.dispatch_state, "not_dispatched");
  assert.throws(() => save(f, "while-pending"), /equivalent_repeat|repeat_unsafe/);
  settle(f, next, true);
  assert.throws(() => save(f, "without-edit"), /equivalent_repeat|repeat_unsafe/);
  assert.throws(() => change(f, "repeat-edit", 11, "edit"), /equivalent_repeat|repeat_unsafe/);
}));

test("reducer independently validates checkpoint proof and replays its immutable history", () => workspace(() => {
  const f = setup(), first = save(f, "save-first"); settle(f, first, true);
  const edit = change(f, "edit"); settle(f, edit);
  const j = f.journal(), event = proposal(j, j.snapshot().operations[first.operation_id]!, edit.operation_id);
  const state = j.append(event);
  assert.equal(state.operations["next-checkpoint"]!.admitted_assignment_version, event.assignment_version);
  assert.equal(state.operations["next-checkpoint"]!.settled_assignment_version, undefined);
  assert.deepEqual(new AssignmentJournalV2(j.events()).snapshot(), state);
  assert.throws(() => j.append({ ...proposal(j, j.snapshot().operations[first.operation_id]!, edit.operation_id), event_id: "reuse",
    operation: { ...(event as any).operation, operation_id: "reuse" } } as AssignmentEventV2), { code: "operation_document_checkpoint_invalid" });
}));

test("a second successful checkpoint requires a distinct subsequent edit", () => workspace(() => {
  const f = setup(), first = save(f, "first"); settle(f, first, true);
  const edit = change(f, "edit"); settle(f, edit);
  const second = save(f, "second"); settle(f, second, true);
  const later = change(f, "later", 12); settle(f, later);
  const third = save(f, "third"), op = f.state().operations[third.operation_id]!;
  assert.equal(op.checkpoint_of_operation_id, second.operation_id);
  assert.equal(op.checkpoint_after_operation_id, later.operation_id);
}));

for (const neighbor of ["no_change", "unsettled", "unknown", "no_effect", "rolled_back", "wrapper", "no_actual_targets", "paused", "different_save_after_edit"] as const) {
  test(`runtime rejects checkpoint continuation for ${neighbor}`, () => workspace(() => {
    const f = setup(), first = save(f, "first"); settle(f, first, true);
    if (neighbor !== "no_change") {
      const edit = change(f, "edit");
      const finish = () => settle(f, edit, false, result => {
        if (neighbor === "unknown") Object.assign(result, { status: "timed_out", persistent_effect: "unknown", native_transaction_state: "unknown" });
        if (neighbor === "no_effect") Object.assign(result, { status: "failed_after_dispatch", persistent_effect: "none", native_transaction_state: "not_started", affected_target_identities: [] });
        if (neighbor === "rolled_back") Object.assign(result, { status: "failed_after_dispatch", persistent_effect: "none", native_transaction_state: "rolled_back", affected_target_identities: [] });
        if (neighbor === "wrapper") Object.assign(result, { authority: "operator-mcp-transport", status: "failed_after_dispatch", persistent_effect: "none", native_transaction_state: "not_applicable", affected_target_identities: [] });
        if (neighbor === "no_actual_targets") result.affected_target_identities = [];
      });
      if (neighbor === "wrapper") assert.throws(finish, /operation_non_native_mutation_dispatch_forbidden/);
      else if (neighbor !== "unsettled") finish();
    }
    if (neighbor === "paused") controlAssignmentExecutionV2({ binding: f.state().current_binding, action: "pause", command_id: "pause", expected_command_id: null });
    if (neighbor === "different_save_after_edit") { const other = save(f, "other-save", { compact: true }); settle(f, other, true); }
    assert.throws(() => save(f, "repeat"), neighbor === "unknown" ? /unknown_effect_requires_reconciliation/
      : neighbor === "paused" ? /paused/ : /equivalent_repeat|repeat_unsafe/);
  }));
}

test("checkpoint continuation retains the original operation budget", () => workspace(() => {
  const f = setup(), first = save(f, "first"); settle(f, first, true);
  const edit = change(f, "edit"); settle(f, edit);
  assert.throws(() => save(f, "repeat"), /operation_budget_exhausted/);
}, "2"));

for (const priorState of ["failed", "unknown"] as const) test(`a ${priorState} prior save cannot become checkpoint authority`, () => workspace(() => {
  const f = setup(), first = save(f, "first");
  settle(f, first, true, (result, payload) => {
    delete result.native_artifact_receipt; delete payload.artifact_receipt;
    Object.assign(result, { status: "failed_after_dispatch", persistent_effect: priorState === "unknown" ? "unknown" : "none",
      native_transaction_state: priorState === "unknown" ? "unknown" : "not_started", affected_target_identities: [] });
  });
  if (priorState === "failed") { const edit = change(f, "edit"); settle(f, edit); }
  assert.throws(() => save(f, "repeat"), /equivalent_repeat|unknown_effect_requires_reconciliation/);
}));

for (const invalid of ["missing_receipt", "unstable_file", "incomplete_outputs", "wrong_output_hash", "different_document", "wrong_native_authority"] as const) {
  test(`native settlement rejects checkpoint authority with ${invalid}`, () => workspace(() => {
    const f = setup(), first = save(f, "first");
    assert.throws(() => settle(f, first, true, (result, payload) => {
      const receipt = result.native_artifact_receipt;
      if (invalid === "missing_receipt") { delete result.native_artifact_receipt; delete payload.artifact_receipt; }
      if (invalid === "unstable_file") receipt.outputs[0].stable_read = false;
      if (invalid === "incomplete_outputs") receipt.outputs = [];
      if (invalid === "wrong_output_hash") receipt.outputs[0].sha256 = "invalid";
      if (invalid === "different_document") receipt.save_document.same_document = false;
      if (invalid === "wrong_native_authority") result.authority = "operator-mcp-transport";
    }), /artifact_authority_invalid|apply_authority_invalid|artifact.*invalid|operation_non_native_mutation_dispatch_forbidden/);
    assert.throws(() => save(f, "repeat"), /unknown_effect_requires_reconciliation|equivalent_repeat|repeat_unsafe/);
  }));
}

for (const invalid of ["missing_basis", "mixed_retry", "wrong_target", "wrong_capability", "wrong_input", "wrong_signature", "non_checkpoint_write", "forged_timestamps_and_versions"] as const) {
  test(`reducer rejects caller-supplied checkpoint claim with ${invalid}`, () => workspace(() => {
    const f = setup();
    const earlier = invalid === "forged_timestamps_and_versions" ? change(f, "early") : undefined;
    if (earlier) settle(f, earlier);
    const first = save(f, "first"); settle(f, first, true);
    const edit = earlier ?? change(f, "edit"); if (!earlier) settle(f, edit);
    const events = [...structuredClone(f.journal().events())];
    for (const event of events) if (invalid === "forged_timestamps_and_versions" && event.event_type === "operation_admitted" && event.operation.operation_id === edit.operation_id) {
      event.occurred_at = "2099-01-01T00:00:00Z"; event.operation.opened_at = event.occurred_at;
      event.operation.admitted_assignment_version = 99999; event.operation.settled_assignment_version = 100000;
    }
    const j = new AssignmentJournalV2(events), event = proposal(j, j.snapshot().operations[first.operation_id]!, edit.operation_id);
    if (event.event_type !== "operation_admitted") throw Error("admission fixture");
    const op = event.operation;
    if (invalid === "missing_basis") delete op.checkpoint_after_operation_id;
    if (invalid === "mixed_retry") { op.retry_of_operation_id = first.operation_id; op.retry_basis = "changed_plan"; }
    if (invalid === "wrong_target") op.target = { ...op.target, document_fingerprint: "other-document" };
    if (invalid === "wrong_capability") { op.capability_id = "other"; op.request_identity = { ...op.request_identity!, capability_id: "other" }; }
    if (invalid === "wrong_input") op.input = { ...op.input, body: { filePath: "C:/fixture/other.rvt", overwrite: true } };
    if (invalid === "wrong_signature") op.request_identity = { ...op.request_identity!, request_signature: "different" };
    if (invalid === "non_checkpoint_write") { op.input = { method: "POST", path: "/revit/delete-elements", body: { ids: [11] } }; op.request_identity = { ...op.request_identity!, path: "/revit/delete-elements" }; }
    assert.throws(() => j.append(event), { code: "operation_document_checkpoint_invalid" });
  }));
}

for (const invalid of ["change_other_document", "change_unretained", "change_missing_receipt", "change_result_mismatch", "new_generation", "different_session", "export_is_not_save"] as const) {
  test(`reducer fails closed for ${invalid} checkpoint history`, () => workspace(() => {
    const f = setup(), first = save(f, "first"); settle(f, first, true);
    const edit = change(f, "edit"); settle(f, edit);
    const events = [...structuredClone(f.journal().events())];
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.event_type === "operation_admitted" && e.operation.operation_id === edit.operation_id && invalid === "change_other_document")
        e.operation.target = { ...e.operation.target, document_fingerprint: "other-document" };
      if (e.event_type === "operation_result_recorded" && e.result.operation_id === edit.operation_id) {
        if (invalid === "change_missing_receipt") delete e.result.receipt_id;
        if (invalid === "change_result_mismatch") e.result.request_identity = { ...e.result.request_identity!, request_signature: "forged" };
      }
      if (e.event_type === "observation_retained" && e.observation.operation_id === edit.operation_id && invalid === "change_unretained")
        events[i] = { ...e, event_type: "observation_retention_failed", operation_id: edit.operation_id, error_code: "retention_failed" } as AssignmentEventV2;
    }
    if (invalid === "change_result_mismatch") {
      assert.throws(() => new AssignmentJournalV2(events), { code: "operation_result_request_identity_mismatch" }); return;
    }
    const j = new AssignmentJournalV2(events), event = proposal(j, j.snapshot().operations[first.operation_id]!, edit.operation_id);
    if (event.event_type !== "operation_admitted") throw Error("admission fixture");
    if (invalid === "new_generation") event.operation.binding = { ...event.operation.binding, generation: 2 };
    if (invalid === "different_session") event.operation.binding = { ...event.operation.binding, session_id: "other-session" };
    if (invalid === "export_is_not_save") {
      event.operation.input = { method: "POST", path: "/revit/export-pdf", body: { filePath } };
      event.operation.request_identity = { ...event.operation.request_identity!, path: "/revit/export-pdf" };
    }
    assert.throws(() => j.append(event), { code: ["new_generation", "different_session"].includes(invalid)
      ? "operation_binding_mismatch" : "operation_document_checkpoint_invalid" });
  }));
}

test("a save receipt for a changed project binding cannot authorize a checkpoint in the old assignment", () => workspace(() => {
  const f = setup(), first = save(f, "first");
  settle(f, first, true, result => {
    const saved = result.native_artifact_receipt.save_document;
    saved.after = { ...saved.after, project_fingerprint: "c".repeat(64) };
    saved.project_binding_changed = true;
  });
  const edit = change(f, "edit"); settle(f, edit);
  assert.throws(() => save(f, "repeat"), /equivalent_repeat|repeat_unsafe/);
}));

for (const boundary of ["reducer", "runtime"] as const) test(`${boundary} ignores unrelated legacy writes without request identities when deriving a later checkpoint`, () => workspace(() => {
  const f = setup(), legacy = change(f, "legacy"); settle(f, legacy);
  const first = save(f, "first"); settle(f, first, true);
  const edit = change(f, "edit"); settle(f, edit);
  const goal = structuredClone(getGoal(f.goal.id)!);
  for (const event of goal.assignment_kernel_v2!.events) {
    if (event.event_type === "operation_admitted" && event.operation.operation_id === legacy.operation_id) delete event.operation.request_identity;
    if (event.event_type === "operation_result_recorded" && event.result.operation_id === legacy.operation_id) delete event.result.request_identity;
  }
  const journal = new AssignmentJournalV2(goal.assignment_kernel_v2!.events);
  assert.equal(journal.snapshot().operations[legacy.operation_id]!.settlement_state, "settled", "legacy history remains valid");
  let admitted: OperationV2;
  if (boundary === "reducer") {
    const event = proposal(journal, journal.snapshot().operations[first.operation_id]!, edit.operation_id);
    admitted = journal.append(event).operations["next-checkpoint"]!;
  } else {
    fs.writeFileSync(path.join(process.env.OPERATOR_WORKSPACE_ROOT!, "artifacts", "goals", goal.id, "goal.json"), JSON.stringify(goal));
    __testOnlyResetGoalListCache();
    const next = save(f, "next"); admitted = f.state().operations[next.operation_id]!;
  }
  assert.equal(admitted.checkpoint_of_operation_id, first.operation_id);
  assert.equal(admitted.checkpoint_after_operation_id, edit.operation_id);
  assert.equal(admitted.dispatch_state, "not_dispatched");
}));

for (const boundary of ["reducer", "runtime"] as const) test(`${boundary} checkpoints committed moves with failed readback without claiming successful edits`, () => workspace(() => {
  const f = setup(), first = save(f, "first"); settle(f, first, true);
  const edits: Lease[] = [];
  for (const element of [11, 12]) {
    const edit = openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: `move-${element}`,
      capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: [`id:${element}`],
      arguments: { method: "POST", path: "/revit/move-elements", body: {
        ids: [element], mode: "vector", vectorX: 0, vectorY: -1, vectorZ: 0, dryRun: false, behavior: "allOrNothing" } } });
    settle(f, edit, false, (result, payload) => {
      Object.assign(result, { status: "failed_after_dispatch", error_code: "native_domain_operation_failed", affected_target_identities: [`element_id:${element}`] });
      delete payload.modifiedElementIds;
      Object.assign(payload, { movedIds: [element], applied: true, success: false, verified: false, ok: false,
        error: "Native location readback is unavailable.", status: "Committed With Errors", rolledBack: false,
        skipped: [], warnings: [], snapshots: [], movedTogether: false,
        transaction: { status: "committed", committed: true, modified_element_ids: [element], affected_element_ids: [element], added_element_ids: [], deleted_element_ids: [] },
        changeTracking: { documentChangedObserved: true, exhaustiveChangeInventory: true, eventCount: 1, matchingEventCount: 1, distinctWrapperMatchCount: 1, captureFailureCount: 0 } });
    });
    edits.push(edit);
  }
  const before = f.state(), lastEdit = edits[1]!, journal = f.journal();
  const next = boundary === "runtime" ? save(f, "next") : undefined;
  const state = boundary === "reducer"
    ? journal.append(proposal(journal, before.operations[first.operation_id]!, lastEdit.operation_id)) : f.state();
  const admitted = state.operations[next?.operation_id ?? "next-checkpoint"]!;
  assert.equal(admitted.checkpoint_of_operation_id, first.operation_id);
  assert.equal(admitted.checkpoint_after_operation_id, lastEdit.operation_id);
  assert.equal(admitted.retry_of_operation_id, undefined);
  assert.equal(admitted.dispatch_state, "not_dispatched");
  for (const edit of edits) {
    assert.deepEqual(state.operations[edit.operation_id], before.operations[edit.operation_id]);
    assert.equal(state.operations[edit.operation_id]!.result!.status, "failed_after_dispatch");
  }
  if (next) {
    settle(f, next, true);
    assert.throws(() => save(f, "no-new-edit"), /equivalent_repeat|repeat_unsafe/);
    const oldMove = before.operations[lastEdit.operation_id]!;
    assert.throws(() => openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: "repeat-move",
      capability_id: oldMove.capability_id, classified_effect: "apply", target_tokens: [oldMove.target.target_id!], arguments: oldMove.input }), /equivalent_repeat|repeat_unsafe/);
  } else assert.deepEqual(new AssignmentJournalV2(journal.events()).snapshot(), state);
}));

for (const boundary of ["reducer", "runtime"] as const) for (const invalid of ["failed_prior_save", "failed_change_without_targets"] as const)
  test(`${boundary} rejects ${invalid} as checkpoint proof`, () => workspace(() => {
    const f = setup(), first = save(f, "first");
    settle(f, first, true, result => {
      if (invalid === "failed_prior_save") Object.assign(result, { status: "failed_after_dispatch", error_code: "native_domain_operation_failed" });
    });
    const edit = change(f, "edit");
    settle(f, edit, false, result => Object.assign(result, { status: "failed_after_dispatch", error_code: "native_domain_operation_failed",
      ...(invalid === "failed_change_without_targets" ? { affected_target_identities: [] } : {}) }));
    if (boundary === "runtime") assert.throws(() => save(f, "next"), /equivalent_repeat|repeat_unsafe/);
    else {
      const journal = f.journal();
      assert.throws(() => journal.append(proposal(journal, journal.snapshot().operations[first.operation_id]!, edit.operation_id)),
        { code: "operation_document_checkpoint_invalid" });
    }
  }));
