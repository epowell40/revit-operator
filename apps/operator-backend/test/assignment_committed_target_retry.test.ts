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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-target-retry-"));
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
  const goal = createGoal({ title: "Connect retained elements", objective: "Connect the selected compatible elements and correct their size if required.",
    acceptance_criteria: ["Connections are established."], status: "active", related_session_id: "retry-session", created_by: "local-host",
    work_budget: { requested_effect: "apply", document_fingerprint: "retry-document" } });
  createAssignmentKernelForGoalV2({ goal, run_id: "retry-run" });
  return { goal, state: () => getAssignmentKernelSnapshotV2(goal.id)!,
    journal: () => new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events) };
}
type Fixture = ReturnType<typeof setup>;
type Lease = ReturnType<typeof openAssignmentKernelOperationV2>;

function connect(f: Fixture, id: string) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: ["id:11", "id:12"],
    arguments: { method: "POST", path: "/revit/connect-mep-elements", body: {
      sourceElementId: 11, targetElementIds: [12], toleranceFt: 0.01, sizeToleranceFt: 0.001,
      requiredConnectionCount: 1, dryRun: false, verify: true } } });
}
function change(f: Fixture, id: string, element = 11) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply", target_tokens: [`id:${element}`],
    arguments: { method: "POST", path: "/revit/set-parameter", body: {
      changes: [{ elementId: element, parameterName: "Duct Radius", value: '4"' }], apply: true, dryRun: false } } });
}
function settle(f: Fixture, lease: Lease, applied = false, element = 11, transform?: (result: any) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const op = f.state().operations[lease.operation_id]!;
  // Producer-shaped native preflight failure followed by a committed parameter change.
  const payload = applied ? { status: "Applied and Verified", changedElementIds: [element],
    diffs: [{ elementId: element, parameterName: "Duct Radius", before: 0.5, after: 1 / 3 }], transaction: { status: "committed" } }
    : { status: "Blocked", blockReason: "Not enough compatible open connector pairs were found within tolerance.", transaction: { status: "not_started" } };
  const envelope = { content: [], structuredContent: {
    schema: "revit-operator.assignment-kernel-mcp-result/v2",
    operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
      binding: lease.binding, status: applied ? "succeeded" : "failed_after_dispatch", dispatch_state: "dispatched", persistent_effect: applied ? "applied" : "none",
      native_transaction_state: applied ? "committed" : "not_started", authority: "native-host",
      result_schema_id: `operator-native/POST:${op.request_identity?.path}/v2`, observation_required: true,
      affected_target_identities: applied ? [`element_id:${element}`] : [],
      raw_payload_hash: createHash("sha256").update(canonicalJsonV2(payload)).digest("hex"), receipt_id: `receipt:${lease.operation_id}`,
      native_correlation_id: `native:${lease.operation_id}`, request_identity: op.request_identity, completed_at: new Date().toISOString(),
      ...(applied ? {} : { error_code: "native_domain_operation_failed" }) },
    observation: { raw_payload: payload, semantic_facts: [{ fact_id: op.fulfillment_role === "supporting_control" ? "control.result_available" : "task.result_available",
      fact_class: op.fulfillment_role === "supporting_control" ? "control" : "domain", value: applied }], verification_relevance: ["task_result"] }
  } };
  transform?.(envelope.structuredContent.operation_result_v2);
  return settleAssignmentKernelOperationV2(lease, envelope);
}
function retryEvent(journal: AssignmentJournalV2, prior: OperationV2, changeId: string): AssignmentEventV2 {
  const state = journal.snapshot();
  return { schema: "revit-operator.assignment-event/v2", event_id: "retry-admission", assignment_id: state.current_binding.assignment_id,
    assignment_version: state.assignment_version + 1, binding: state.current_binding, actor: "test", occurred_at: new Date().toISOString(),
    event_type: "operation_admitted", operation: { ...prior, operation_id: "retry", delegation_authority_id: "delegation:retry",
      admission_state: "admitted", dispatch_state: "not_dispatched", settlement_state: "open", persistent_effect: "none", result: undefined,
      observation_ids: [], verification_operation_ids: [], settled_at: undefined,
      retry_of_operation_id: prior.operation_id, retry_basis: "committed_target_change", retry_after_operation_id: changeId } } as AssignmentEventV2;
}

for (const endpoint of [11, 12]) test(`runtime retries a native no-effect connection after a committed change on endpoint ${endpoint}`, () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const changed = change(f, "resize", endpoint); settle(f, changed, true, endpoint);
  __testOnlyResetGoalListCache();
  const retry = connect(f, "retry"), admitted = f.state().operations[retry.operation_id]!;
  assert.equal(admitted.retry_of_operation_id, failed.operation_id);
  assert.equal(admitted.retry_basis, "committed_target_change");
  assert.equal(admitted.retry_after_operation_id, changed.operation_id);
  assert.equal(admitted.dispatch_state, "not_dispatched", "retry admission itself grants no native dispatch");
  settle(f, retry);
  const journal = f.journal(), prior = journal.snapshot().operations[failed.operation_id]!;
  assert.throws(() => journal.append(retryEvent(journal, prior, changed.operation_id)), { code: "operation_committed_target_retry_invalid" });
  assert.throws(() => connect(f, "repeat-without-another-change"), /equivalent_repeat/);
}));

test("reducer rejects an unrelated committed change claimed as a retry basis", () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const changed = change(f, "unrelated", 99); settle(f, changed, true, 99);
  const journal = f.journal(), prior = journal.snapshot().operations[failed.operation_id]!;
  assert.throws(() => journal.append(retryEvent(journal, prior, changed.operation_id)), { code: "operation_committed_target_retry_invalid" });
}));

test("reducer accepts the exact proof and replays it cold, but rejects reused or missing proof", () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const changed = change(f, "resize"); settle(f, changed, true);
  const journal = f.journal(), prior = journal.snapshot().operations[failed.operation_id]!;
  const proposed = retryEvent(journal, prior, changed.operation_id);
  const missing = structuredClone(proposed);
  if (missing.event_type !== "operation_admitted") throw Error("test admission");
  delete missing.operation.retry_after_operation_id;
  assert.throws(() => journal.append(missing), { code: "operation_committed_target_retry_invalid" });
  const state = journal.append(proposed);
  assert.deepEqual(new AssignmentJournalV2(journal.events()).snapshot(), state);
  assert.throws(() => journal.append({ ...retryEvent(journal, prior, changed.operation_id), event_id: "reuse",
    operation: { ...(proposed as any).operation, operation_id: "retry-again" } } as AssignmentEventV2),
    { code: "operation_native_write_repeat_unsafe" });
}));

for (const neighbor of ["unrelated", "incidental_affected_target", "empty_affected", "pending", "rolled_back", "unknown",
  "missing_receipt", "missing_correlation", "wrapper_completion", "completed_predecessor", "successful_noop_predecessor",
  "stale_change", "clock_relabel", "paused", "unauthorized"] as const) {
  test(`runtime refuses ${neighbor} as permission to repeat`, () => workspace(() => {
    const f = setup();
    const stale = neighbor === "stale_change" || neighbor === "clock_relabel" ? change(f, "stale") : null;
    if (stale) settle(f, stale, true);
    const failed = connect(f, "failed"); settle(f, failed, neighbor === "completed_predecessor", 11, result => {
      if (neighbor === "successful_noop_predecessor") result.status = "succeeded";
    });
    let changed: Lease | null = null;
    if (!stale) {
      changed = change(f, "resize", ["unrelated", "incidental_affected_target"].includes(neighbor) ? 99 : 11);
      if (neighbor !== "pending") settle(f, changed, neighbor !== "rolled_back", neighbor === "unrelated" ? 99 : 11, result => {
        if (neighbor === "empty_affected") result.affected_target_identities = [];
        if (neighbor === "rolled_back") result.native_transaction_state = "rolled_back";
        if (neighbor === "unknown") { result.persistent_effect = "unknown"; result.native_transaction_state = "unknown"; result.status = "failed_after_dispatch"; result.affected_target_identities = []; }
        if (neighbor === "missing_receipt") delete result.receipt_id;
        if (neighbor === "missing_correlation") delete result.native_correlation_id;
        if (neighbor === "wrapper_completion") Object.assign(result, { status: "completed_without_native_dispatch", dispatch_state: "not_dispatched",
          persistent_effect: "none", native_transaction_state: "not_applicable", authority: "operator-mcp-transport", observation_required: false, affected_target_identities: [] });
      });
    }
    if (neighbor === "paused") controlAssignmentExecutionV2({ binding: failed.binding, command_id: "pause", expected_command_id: null, action: "pause" });
    if (neighbor === "unauthorized") {
      runWithRequestContext({}, () => assert.throws(() => connect(f, "retry"), /advisory_execution_requires_local_host/));
    } else if (neighbor === "clock_relabel") {
      // A later timestamp cannot turn an earlier committed event into new state.
      const events = structuredClone(f.journal().events());
      for (const event of events) if (event.event_type === "operation_admitted" && event.operation.operation_id === stale!.operation_id) event.operation.opened_at = "2099-01-01T00:00:00Z";
      const journal = new AssignmentJournalV2(events), prior = journal.snapshot().operations[failed.operation_id]!;
      assert.throws(() => journal.append(retryEvent(journal, prior, stale!.operation_id)), { code: "operation_committed_target_retry_invalid" });
    } else assert.throws(() => connect(f, "retry"), neighbor === "unknown" ? /unknown_effect_requires_reconciliation/ : neighbor === "paused" ? /paused/ : /equivalent_repeat/);
  }));
}

test("committed target retry retains the immutable operation budget", () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const changed = change(f, "resize"); settle(f, changed, true);
  assert.throws(() => connect(f, "retry"), /operation_budget_exhausted/);
}, "2"));

test("a later distinct committed change permits one further failed retry, never reuses the old basis", () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const changed = change(f, "resize"); settle(f, changed, true);
  const retry = connect(f, "retry"); settle(f, retry);
  const nextChange = change(f, "other-endpoint", 12); settle(f, nextChange, true, 12);
  const next = connect(f, "retry-next"), op = f.state().operations[next.operation_id]!;
  assert.equal(op.retry_of_operation_id, retry.operation_id);
  assert.equal(op.retry_after_operation_id, nextChange.operation_id);
}));

test("rolled-back preview cannot supply a committed target correction", () => workspace(() => {
  const f = setup(), failed = connect(f, "failed"); settle(f, failed);
  const preview = openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: "preview",
    capability_id: "revit_call_tool", classified_effect: "preview", target_tokens: ["id:11"],
    arguments: { method: "POST", path: "/revit/set-parameter", body: { changes: [{ elementId: 11, parameterName: "Duct Radius", value: '4"' }], dryRun: true } } });
  settle(f, preview, false, 11, result => { result.native_transaction_state = "rolled_back"; });
  assert.throws(() => connect(f, "retry"), /equivalent_repeat/);
}));

for (const invalid of ["retention_failure", "forged_order", "new_generation", "wrong_document", "wrong_result_binding"] as const) {
  test(`reducer rejects ${invalid} evidence for a committed-target retry`, () => workspace(() => {
    const f = setup();
    const early = invalid === "forged_order" ? change(f, "earlier") : null;
    if (early) settle(f, early, true);
    const failed = connect(f, "failed"); settle(f, failed);
    const changed = early ?? change(f, "resize"); if (!early) settle(f, changed, true);
    const events = [...structuredClone(f.journal().events())];
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (invalid === "retention_failure" && event.event_type === "observation_retained" && event.observation.operation_id === changed.operation_id) {
        events[i] = { ...event, event_type: "observation_retention_failed", operation_id: changed.operation_id, error_code: "retention_failed" } as AssignmentEventV2;
      }
      if (invalid === "forged_order" && event.event_type === "operation_admitted" && event.operation.operation_id === changed.operation_id) {
        event.operation.admitted_assignment_version = 9999; event.operation.settled_assignment_version = 10000;
      }
      if (invalid === "wrong_result_binding" && event.event_type === "operation_result_recorded" && event.result.operation_id === changed.operation_id) event.result.binding = { ...event.result.binding, generation: 99 };
    }
    if (invalid === "wrong_result_binding") {
      assert.throws(() => new AssignmentJournalV2(events), { code: "operation_result_binding_mismatch" }); return;
    }
    const journal = new AssignmentJournalV2(events), prior = journal.snapshot().operations[failed.operation_id]!;
    if (invalid === "new_generation") {
      const common = { schema: "revit-operator.assignment-event/v2" as const, assignment_id: failed.assignment_id, actor: "test", occurred_at: new Date().toISOString() };
      journal.append({ ...common, event_id: "supersede", binding: failed.binding, assignment_version: journal.snapshot().assignment_version + 1,
        event_type: "run_superseded", superseded_by_generation: 2 });
      journal.append({ ...common, event_id: "next-run", binding: { ...failed.binding, generation: 2, run_id: "run-2" },
        assignment_version: journal.snapshot().assignment_version + 1, event_type: "run_started" });
    }
    const proposed = retryEvent(journal, prior, changed.operation_id);
    if (proposed.event_type !== "operation_admitted") throw Error("test admission");
    proposed.operation.binding = journal.snapshot().current_binding;
    if (invalid === "wrong_document") proposed.operation.target = { ...proposed.operation.target, document_fingerprint: "other-document" };
    assert.throws(() => journal.append(proposed), { code: "operation_committed_target_retry_invalid" });
  }));
}

// Minimum native regression fields, with historical task/geometry data omitted.
// The exact unredacted journal replay is private; these tests create no native proof.
const retainedDependency = JSON.parse(fs.readFileSync("test/fixtures/retained-native-failure-dependency.json", "utf8"));
function retainedRequest(f: Fixture, id: string, correction = false) {
  const input = structuredClone(correction ? retainedDependency.correction.input : retainedDependency.failure.input);
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: "apply",
    target_tokens: correction ? ["id:1543209", "id:693820", "id:693822"] : ["id:1542961", "id:1543203"], arguments: input });
}
function retainedEnvelope(f: Fixture, lease: Lease, correction = false, mutate?: (raw: any, result: any) => void) {
  const fixture = correction ? retainedDependency.correction : retainedDependency.failure;
  const raw = structuredClone(fixture.raw), op = f.state().operations[lease.operation_id]!;
  const result = { ...structuredClone(fixture.result), operation_id: lease.operation_id, result_id: `retained:${lease.operation_id}`,
    binding: lease.binding, request_identity: op.request_identity, completed_at: new Date().toISOString() };
  delete result.payload_provenance;
  mutate?.(raw, result);
  result.raw_payload_hash = createHash("sha256").update(canonicalJsonV2(raw)).digest("hex");
  return { content: [], structuredContent: { schema: "revit-operator.assignment-kernel-mcp-result/v2", operation_result_v2: result,
    observation: { raw_payload: raw, semantic_facts: [{ fact_id: "task.result_available", fact_class: "domain", value: correction }],
      verification_relevance: ["task_result"] } } };
}
function settleRetained(f: Fixture, lease: Lease, correction = false, mutate?: (raw: any, result: any) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  return settleAssignmentKernelOperationV2(lease, retainedEnvelope(f, lease, correction, mutate));
}
async function withRetainedHttp(f: Fixture, fn: (post: (route: string, body: any, token?: string) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const server = http.createServer((req, res) => {
    const auth = authenticateRequest(req, { mode: "shared_token", requireAuth: true, sharedToken: "test-only" });
    if (!auth.ok) { res.writeHead(auth.status); res.end(JSON.stringify({ error: auth.error })); return; }
    void runWithRequestContext({ operator_backend_auth: auth.backend_auth }, async () => {
      if (!await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://127.0.0.1"), session => {
        if (session === f.state().current_binding.session_id) return true;
        res.writeHead(403); res.end("{}"); return false;
      })) { res.writeHead(404); res.end("{}"); }
    }).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as any).port;
    await fn(async (route, body, token = "test-only") => {
      const response = await fetch(`http://127.0.0.1:${port}/api/assignments/v2/operations/${route}`, { method: "POST",
        headers: { "content-type": "application/json", "x-operator-token": token, "x-operator-assignment-handoff": "operation_handoff_v1" },
        body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("retained dependency: authenticated result retention permits one explicitly corrected failure dependency", () => workspace(async () => {
  const f = setup(), failed = retainedRequest(f, "retained-failure");
  await withRetainedHttp(f, async post => {
    const body = { ...failed.binding, operation_id: failed.operation_id };
    const before = f.state().assignment_version;
    assert.equal((await post("dispatch", body, "wrong-token")).status, 401);
    assert.equal(f.state().assignment_version, before);
    assert.equal((await post("dispatch", { ...body, generation: 99 })).status, 400);
    assert.equal((await post("dispatch", body)).status, 202);
    const failureEnvelope = retainedEnvelope(f, failed);
    assert.equal((await post("results", { ...body, mcp_result: failureEnvelope })).status, 200);
    assert.throws(() => retainedRequest(f, "unchanged-retry"), /equivalent_repeat/);
    const changed = retainedRequest(f, "retained-correction", true), changeBody = { ...changed.binding, operation_id: changed.operation_id };
    assert.equal((await post("dispatch", changeBody)).status, 202);
    assert.equal((await post("results", { ...changeBody, mcp_result: retainedEnvelope(f, changed, true) })).status, 200);
    __testOnlyResetGoalListCache();
    const retry = retainedRequest(f, "legitimate-retry"), operation = f.state().operations[retry.operation_id]!;
    assert.equal(operation.retry_of_operation_id, failed.operation_id);
    assert.equal(operation.retry_after_operation_id, changed.operation_id);
    assert.equal(operation.dispatch_state, "not_dispatched");
    assert.deepEqual(f.state().operations[failed.operation_id]!.result, failureEnvelope.structuredContent.operation_result_v2);
    assert.deepEqual(new AssignmentJournalV2(f.journal().events()).snapshot(), f.state());
    settleRetained(f, retry);
    assert.throws(() => retainedRequest(f, "reuse"), /equivalent_repeat/);
  });
}));

test("retained dependency: reducer independently admits and cold replays the exact correction", () => workspace(() => {
  const f = setup(), failed = retainedRequest(f, "failure"); settleRetained(f, failed);
  const changed = retainedRequest(f, "correction", true); settleRetained(f, changed, true);
  const events = f.journal().events(), prior = f.state().operations[failed.operation_id]!;
  const journal = new AssignmentJournalV2(events), proposed = retryEvent(journal, prior, changed.operation_id);
  if (proposed.event_type !== "operation_admitted") throw Error("test admission");
  delete (proposed.operation as any).native_failure_context;
  const state = journal.append(proposed);
  assert.deepEqual(new AssignmentJournalV2(journal.events()).snapshot(), state);
  assert.deepEqual(journal.events().slice(0, events.length), events, "retained events are immutable");
}));

for (const neighbor of ["incidental_affected_target", "dependency_not_affected", "target_not_affected", "no_co_named_target", "capture_failed",
  "missing_failure_receipt", "unknown", "rolled_back_correction", "paused", "budget"] as const) {
  test(`retained dependency: runtime rejects ${neighbor}`, () => workspace(() => {
    const f = setup(), failed = retainedRequest(f, "failure");
    settleRetained(f, failed, false, (raw, result) => {
      if (neighbor === "no_co_named_target") for (const row of raw.capturedFailures) row.elementIds = [1543209];
      if (neighbor === "capture_failed") raw.capturedFailures[0].captureErrors = ["element IDs unavailable"];
      if (neighbor === "missing_failure_receipt") delete result.receipt_id;
    });
    const changed = neighbor === "incidental_affected_target" ? change(f, "unrelated", 99) : retainedRequest(f, "correction", true);
    settleRetained(f, changed, true, (_raw, result) => {
      if (neighbor === "dependency_not_affected") result.affected_target_identities = ["element_id:1543203"];
      if (neighbor === "target_not_affected") result.affected_target_identities = ["element_id:1543209"];
      if (neighbor === "unknown") Object.assign(result, { persistent_effect: "unknown", native_transaction_state: "unknown", status: "failed_after_dispatch" });
      if (neighbor === "rolled_back_correction") Object.assign(result, { persistent_effect: "none", native_transaction_state: "rolled_back", status: "failed_after_dispatch" });
    });
    if (neighbor === "paused") controlAssignmentExecutionV2({ binding: failed.binding, command_id: "dependency-pause", expected_command_id: null, action: "pause" });
    assert.throws(() => retainedRequest(f, "retry"), neighbor === "unknown" ? /unknown_effect_requires_reconciliation/
      : neighbor === "paused" ? /paused/ : neighbor === "budget" ? /operation_budget_exhausted/ : /equivalent_repeat/);
  }, neighbor === "budget" ? "2" : "256"));
}

test("retained dependency: diagnostic extraction is bounded, exact, and fails closed", () => workspace(() => {
  const f = setup(), failed = retainedRequest(f, "failure"); settleRetained(f, failed);
  const state = f.state(), operation = state.operations[failed.operation_id]!;
  assert.deepEqual(operation.native_failure_context?.dependencies, [{ element_id: "1543209", target_element_ids: ["1543203"] }]);
  const events = f.journal().events();
  for (const neighbor of ["hash_mismatch", "string_id", "unsafe_id", "capture_errors_missing", "unknown_severity", "definition_missing",
    "empty_message", "over_rows", "over_ids", "missing_raw_transaction", "raw_committed", "raw_applied", "not_guard_rollback"] as const) {
    const changed = structuredClone(events);
    const event = changed.find(event => event.event_type === "operation_result_recorded" && event.result.operation_id === failed.operation_id)!;
    if (event.event_type !== "operation_result_recorded") throw Error("test result");
    const raw = event.observation_commit!.raw_payload as any;
    if (neighbor === "hash_mismatch") raw.capturedFailures[0].elementIds.push(77);
    if (neighbor === "string_id") raw.capturedFailures[0].elementIds.push("77");
    if (neighbor === "unsafe_id") raw.capturedFailures[0].elementIds.push(Number.MAX_SAFE_INTEGER + 1);
    if (neighbor === "capture_errors_missing") delete raw.capturedFailures[0].captureErrors;
    if (neighbor === "unknown_severity") raw.capturedFailures[0].severity = "Unknown";
    if (neighbor === "definition_missing") delete raw.capturedFailures[0].failureDefinitionId;
    if (neighbor === "empty_message") raw.capturedFailures[0].message = " ";
    if (neighbor === "over_rows") raw.capturedFailures = Array.from({ length: 65 }, () => raw.capturedFailures[0]);
    if (neighbor === "over_ids") raw.capturedFailures[0].elementIds = Array.from({ length: 33 }, (_, i) => i + 1);
    if (neighbor === "missing_raw_transaction") delete raw.transaction;
    if (neighbor === "raw_committed") raw.transaction.committed = true;
    if (neighbor === "raw_applied") raw.applied = true;
    if (neighbor === "not_guard_rollback") raw.failureRollbackRequested = false;
    if (neighbor !== "hash_mismatch") {
      const hash = createHash("sha256").update(canonicalJsonV2(raw)).digest("hex");
      event.result.raw_payload_hash = hash;
      for (const retained of changed) if (retained.event_type === "observation_retained" && retained.observation.operation_id === failed.operation_id) retained.observation.raw_payload_hash = hash;
    }
    assert.equal(new AssignmentJournalV2(changed).snapshot().operations[failed.operation_id]!.native_failure_context, undefined, neighbor);
  }
  assert.deepEqual(f.journal().events(), events, "malformed neighbors never alter retained history");
}));

test("retained dependency: admission cannot import context and a fresh binding gets no inherited retry", () => workspace(() => {
  const f = setup(), failed = retainedRequest(f, "failure"); settleRetained(f, failed);
  const changed = retainedRequest(f, "correction", true); settleRetained(f, changed, true);
  const journal = f.journal(), prior = journal.snapshot().operations[failed.operation_id]!;
  const forged = retryEvent(journal, prior, changed.operation_id);
  assert.throws(() => journal.append(forged), { code: "operation_native_failure_context_forbidden" });
  const events = structuredClone(journal.events());
  const first = events.find(event => event.event_type === "operation_admitted" && event.operation.operation_id === failed.operation_id)!;
  if (first.event_type !== "operation_admitted") throw Error("test admission");
  first.operation.native_failure_context = prior.native_failure_context;
  assert.throws(() => new AssignmentJournalV2(events), { code: "operation_native_failure_context_forbidden" });
  const next = setup(), fresh = retainedRequest(next, "fresh-binding");
  assert.notEqual(fresh.assignment_id, failed.assignment_id);
  assert.equal(next.state().operations[fresh.operation_id]!.retry_of_operation_id, undefined);
  assert.equal(next.state().operations[fresh.operation_id]!.native_failure_context, undefined);
}));

for (const changedBinding of ["generation", "document", "principal", "session"] as const) {
  test(`retained dependency: no proof crosses ${changedBinding}`, () => workspace(() => {
    const f = setup(), failed = retainedRequest(f, "failure"); settleRetained(f, failed);
    const changed = retainedRequest(f, "correction", true); settleRetained(f, changed, true);
    const journal = f.journal(), prior = journal.snapshot().operations[failed.operation_id]!;
    const event = retryEvent(journal, prior, changed.operation_id);
    if (event.event_type !== "operation_admitted") throw Error("test admission");
    delete event.operation.native_failure_context;
    event.operation.binding = { ...event.operation.binding, ...(changedBinding === "generation" ? { generation: 2 }
      : changedBinding === "document" ? { document_fingerprint: "other-document" }
      : changedBinding === "principal" ? { principal_id: "other-principal" } : { session_id: "other-session" }) };
    assert.throws(() => journal.append(event), { code: "operation_binding_mismatch" });
  }));
}
