import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import http from "node:http";
import { authenticateRequest } from "../src/auth.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
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

async function workspace(fn: () => unknown, maxOperations = "256") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-family-retry-"));
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

function setup() {
  const goal = createGoal({ title: "Inspect manufacturer families", objective: "Open named family sessions, exercise capacity recovery, and close them unsaved.",
    acceptance_criteria: ["Family sessions are closed."], status: "active", related_session_id: "family-session", created_by: "local-host",
    work_budget: { requested_effect: "apply", document_fingerprint: "family-document" } });
  createAssignmentKernelForGoalV2({ goal, run_id: "family-run" });
  return { goal, state: () => getAssignmentKernelSnapshotV2(goal.id)!, journal: () => new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events) };
}
type Fixture = ReturnType<typeof setup>;
type Lease = ReturnType<typeof openAssignmentKernelOperationV2>;
const sid = "a".repeat(32);
function call(f: Fixture, id: string, close = false, file = "fourth") {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: [close ? `familyDocumentId:${sid}` : `path:c:/families/${file}.rfa`],
    arguments: { method: "POST", path: close ? "/revit/close-doc" : "/revit/open-family-doc",
      body: close ? { docId: sid, saveChanges: false } : { filePath: `C:/families/${file}.rfa` } } });
}
function settle(f: Fixture, lease: Lease, kind: "open" | "capacity" | "close", mutate?: (result: any, facts: any[]) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const op = f.state().operations[lease.operation_id]!;
  const payload = kind === "capacity" ? { ok: false, code: "family_session_capacity_reached", family_session_receipt: {
    schema: "revit-operator.family-session-open.v1", status: "capacity_rejected", retained_count: 3, limit: 3,
    native_open_started: false, retained_sessions_unchanged: true, model_write_performed: false, file_write_performed: false } }
    : kind === "close" ? { ok: true, closed: true, saved: false, familyDocumentId: sid, family_close_receipt: {
      schema: "revit-operator.family-session-close.v1", session_id: sid, status: "closed", native_close_returned: true, document_closed: true, session_unregistered: true, save_requested: false } }
    : { ok: true, familyDocumentId: sid, family_session_receipt: { schema: "revit-operator.family-session-open.v1", status: "opened",
      session_id: sid, source_kind: "file", source_id: (op.input.body as Record<string, unknown>).filePath, document_valid: true, session_registered: true,
      model_write_performed: false, file_write_performed: false } };
  const facts: any[] = [{ fact_id: "control.field.ok", fact_class: "control", value: kind !== "capacity" },
    { fact_id: "control.field.family_document_id", fact_class: "control", value: sid }];
  if (kind === "close") facts.push({ fact_id: "control.field.closed", fact_class: "control", value: true },
    { fact_id: "control.field.saved", fact_class: "control", value: false });
  const result: any = { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
    binding: lease.binding, status: kind === "capacity" ? "failed_after_dispatch" : "succeeded", dispatch_state: "dispatched", persistent_effect: "none",
    native_transaction_state: "not_applicable", authority: "native-host", result_schema_id: `operator-native/POST:${op.request_identity?.path}/v2`,
    observation_required: true, affected_target_identities: [], raw_payload_hash: createHash("sha256").update(canonicalJsonV2(payload)).digest("hex"),
    receipt_id: `receipt:${lease.operation_id}`, native_correlation_id: `native:${lease.operation_id}`, request_identity: op.request_identity,
    completed_at: new Date().toISOString(), ...(kind === "capacity" ? { error_code: "family_session_capacity_reached" } : {}) };
  mutate?.(result, facts);
  return settleAssignmentKernelOperationV2(lease, { content: [], structuredContent: {
    schema: "revit-operator.assignment-kernel-mcp-result/v2", operation_result_v2: result,
    observation: { raw_payload: payload, semantic_facts: facts, verification_relevance: ["task_result"] } } });
}
function prepare() {
  const f = setup(), opened = call(f, "first", false, "first"); settle(f, opened, "open");
  const failed = call(f, "failed"); settle(f, failed, "capacity");
  return { f, failed };
}
test("runtime derives one capacity retry only after a retained native close; journal replays it cold", () => workspace(() => {
  const { f, failed } = prepare();
  assert.throws(() => call(f, "before-close"), /equivalent_repeat/);
  const closed = call(f, "close", true); settle(f, closed, "close");
  const retry = call(f, "retry"), op = f.state().operations[retry.operation_id]!;
  assert.equal(op.retry_basis, "family_session_capacity_released");
  assert.equal(op.retry_of_operation_id, failed.operation_id);
  assert.equal(op.retry_after_operation_id, closed.operation_id);
  assert.equal(op.dispatch_state, "not_dispatched");
  settle(f, retry, "capacity");
  assert.throws(() => call(f, "reuse"), /equivalent_repeat/);
  assert.deepEqual(new AssignmentJournalV2(f.journal().events()).snapshot(), f.state());
}));
for (const bad of ["unknown", "success", "wrong_code", "wrapper", "saved", "wrong_session", "unclosed", "missing_fact", "consumed_slot"] as const) {
  test(`capacity retry rejects ${bad}`, () => workspace(() => {
    const f = setup(), opened = call(f, "first", false, "first"); settle(f, opened, "open");
    const failed = call(f, "failed"); settle(f, failed, "capacity", r => {
      if (bad === "unknown") r.persistent_effect = "unknown";
      if (bad === "success") r.status = "succeeded";
      if (bad === "wrong_code") r.error_code = "other_failure";
    });
    if (bad !== "unknown") {
      const closed = call(f, "close", true);
      if (bad === "wrapper") {
        assert.throws(() => settle(f, closed, "close", r => { r.authority = "operator-mcp-transport"; }), /operation_non_native_mutation_dispatch_forbidden/);
        return;
      }
      settle(f, closed, "close", (r, facts) => {

        if (bad === "saved") facts.find(x => x.fact_id === "control.field.saved").value = true;
        if (bad === "wrong_session") facts.find(x => x.fact_id === "control.field.family_document_id").value = "b".repeat(32);
        if (bad === "unclosed") facts.find(x => x.fact_id === "control.field.closed").value = false;
        if (bad === "missing_fact") facts.splice(0, facts.length);
      });
      if (bad === "consumed_slot") { const other = call(f, "other", false, "other"); settle(f, other, "open"); }
    }
    assert.throws(() => call(f, "retry"), /equivalent_repeat|unknown_effect/);
  }));
}
test("reducer rechecks claimed close proof instead of trusting retry labels", () => workspace(() => {
  const { f, failed } = prepare(), prior = f.state().operations[failed.operation_id]!;
  const state = f.state();
  const e: AssignmentEventV2 = { schema: "revit-operator.assignment-event/v2", event_id: "forged-retry", assignment_id: state.current_binding.assignment_id,
    assignment_version: state.assignment_version + 1, binding: state.current_binding, actor: "test", occurred_at: new Date().toISOString(),
    event_type: "operation_admitted", operation: { ...prior, operation_id: "forged-retry", delegation_authority_id: "delegation:forged-retry",
      admission_state: "admitted", dispatch_state: "not_dispatched", settlement_state: "open", persistent_effect: "none", result: undefined,
      observation_ids: [], verification_operation_ids: [], settled_at: undefined,
      retry_of_operation_id: prior.operation_id, retry_basis: "family_session_capacity_released", retry_after_operation_id: "missing" } };
  assert.throws(() => f.journal().append(e), { code: "operation_family_capacity_retry_invalid" });
}));
