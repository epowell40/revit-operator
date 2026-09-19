import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { listTaskNavigation, listTaskNavigationAsync } from "../src/assignments/task_navigation.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { __testOnlyResetGoalListCache, getGoalStoragePath } from "../src/goals/service.js";
import { appendEvent, __closeForTests } from "../src/memory/sqlite_store.js";
import { runWithRequestContext, createPrincipalBoundSessionId, type RequestPrincipal } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { beginAssignmentKernelTerminalBarrierV2, endAssignmentKernelTerminalBarrierV2 } from "../src/assignments/assignment_kernel_v2_terminal_barrier.js";

const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") };
async function workspace(fn: () => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-task-navigation-"));
  const keys = ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2"] as const;
  const previous = keys.map(key => process.env[key]);
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1";
  __testOnlyResetGoalListCache();
  try { await runWithRequestContext(local, fn); }
  finally {
    __closeForTests();
    __testOnlyResetGoalListCache();
    keys.forEach((key,index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("operator-task-navigation-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function conversation(session: string, text: string) {
  assert.equal(appendEvent(session, "user", "chat.message", { display: { text }, raw_prompt: "PRIVATE ENRICHMENT" }), true);
}
function task(session: string) {
  const prepared = prepareAssignmentTurn({ sessionId: session, messageId: "first", userText: "Reconstruct the ductwork in all four rooms.",
    toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "test-model" } } } } })!;
  return prepared.bindingV2!;
}

test("C51 orphaned native operations are unknown; live ownership changes cached navigation without changing evidence", () => workspace(() => {
  conversation("lost-worker", "Run the read-only diagnostic program"); const binding = task("lost-worker");
  for (const id of ["first", "second"]) {
    const lease = openAssignmentKernelOperationV2({ snapshot: getAssignmentKernelSnapshotV2(binding.assignment_id)!,
      controller_request_id: id, provider_turn_id: "old-provider", capability_id: "inventory.read", classified_effect: "read", arguments: { id } });
    markAssignmentKernelOperationDispatchStartedV2(lease);
  }
  const before = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  assert.equal(before.in_flight_operation_ids.length, 2); assert.equal(before.quiescent, false);
  const state = () => listTaskNavigation().tasks.find(row => row.session_id === "lost-worker")!.state;
  assert.equal(state(), "unknown");
  const wrong = beginAssignmentKernelTerminalBarrierV2({ binding: { ...before.current_binding, generation: before.current_binding.generation + 1 }, barrier_id: "wrong-generation" });
  try { assert.equal(state(), "unknown"); } finally { endAssignmentKernelTerminalBarrierV2(wrong); }
  const owner = beginAssignmentKernelTerminalBarrierV2({ binding: before.current_binding, barrier_id: "real-owner" });
  try { assert.equal(state(), "working"); } finally { endAssignmentKernelTerminalBarrierV2(owner); }
  assert.equal(state(), "unknown"); assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), before);
  controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause-orphan", expected_command_id: null });
  assert.equal(state(), "unknown", "an orphaned operation must not claim it is actively finishing");
}));

test("task navigation retains old paused work beyond recent chat limits and opening never resumes", () => workspace(() => {
  conversation("old-work", "Draft the north wing"); const binding = task("old-work");
  controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause-1", expected_command_id: null });
  for (let i = 0; i < 205; i++) conversation(`recent-${i}`, `Question ${i}`);
  const before = getAssignmentKernelSnapshotV2(binding.assignment_id);
  const result = listTaskNavigation(20);
  assert.equal(result.tasks.length, 20);
  assert.equal(result.tasks[0].session_id, "old-work");
  assert.equal(result.tasks[0].state, "paused");
  assert.equal(result.tasks.filter(row => row.session_id === "old-work").length, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE ENRICHMENT"), false);
  assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), before);
  __testOnlyResetGoalListCache(); assert.deepEqual(listTaskNavigation(20), result);
}));

test("task navigation filters principal ownership before limiting and never exposes raw-only prompts", () => workspace(() => {
  const principal: RequestPrincipal = { sub: "a", user_id: "a", tenant_id: "team", license_id: "team", roles: [], tier: null, claims: {} };
  const foreign = { ...principal, sub: "b", user_id: "b" };
  runWithRequestContext({ principal }, () => {
    const own = createPrincipalBoundSessionId(principal), other = createPrincipalBoundSessionId(foreign);
    conversation(own, "My saved question"); conversation(other, "Foreign question");
    appendEvent(createPrincipalBoundSessionId(principal), "user", "chat.message", { user_text: "Hidden raw prompt" });
    assert.deepEqual(listTaskNavigation(1).tasks.map(row => row.title), ["My saved question"]);
  });
  assert.throws(() => runWithRequestContext({}, () => listTaskNavigation()), /authenticated principal/);
}));

test("task discovery HTTP returns owned conversation status without running a turn", () => workspace(async () => {
  conversation("http-history", "Can you see the model?");
  let authorized = true;
  const server = http.createServer((req,res) => {
    void runWithRequestContext(authorized ? local : {}, () => handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),() => true));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/task-navigation`;
    const result = await fetch(url); assert.equal(result.status,200);
    const body = await result.json() as any;
    assert.equal(body.tasks[0].title,"Can you see the model?"); assert.equal(body.tasks[0].assignment_id,null);
    authorized = false; assert.equal((await fetch(url)).status,403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("conversational read tasks require a user-facing answer regardless of question wording", () => workspace(() => {
  for (const [index, userText] of ["Is this the mechanical model?", "Which sheets look relevant to HVAC?", "Count all air devices."].entries()) {
    const prepared = prepareAssignmentTurn({ sessionId: `answer-${index}`, messageId: "question", userText,
      toolResults: [], source: "chat", createdBy: null,
      requestContext: { ui: { response_style: "conversation" }, revit: { document: { projectIdentity: { fingerprint: "test-model" } } } } })!;
    const snapshot = getAssignmentKernelSnapshotV2(prepared.assignmentId)!;
    assert.equal(snapshot.spec.result_delivery_required, true);
    assert.equal(snapshot.spec.result_assessment_required, true);
  }
}));

test("one invalid historical journal is isolated and repaired canonical bytes replace its cached warning", () => workspace(() => {
  conversation("broken", "Old duct task"); const broken = task("broken");
  conversation("healthy", "Current duct task"); const healthy = task("healthy");
  controlAssignmentExecutionV2({ binding: healthy, action: "pause", command_id: "keep-paused", expected_command_id: null });
  const file = getGoalStoragePath(broken.assignment_id)!;
  const original = fs.readFileSync(file, "utf8"), stamp = fs.statSync(file);
  const bad = JSON.parse(original); bad.assignment_kernel_v2.events[0].event_type = "invalid_historical_event";
  fs.writeFileSync(file, JSON.stringify(bad)); fs.utimesSync(file, stamp.atime, stamp.mtime);
  const result = listTaskNavigation();
  assert.equal(result.tasks.find(row => row.session_id === "broken")?.state, "unknown");
  assert.equal(result.tasks.find(row => row.session_id === "healthy")?.state, "paused");
  fs.writeFileSync(file, original); fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.notEqual(listTaskNavigation().tasks.find(row => row.session_id === "broken")?.state, "unknown");
}));

test("progressive discovery publishes readable titles before journal validation and allows canceling discovery", () => workspace(async () => {
  conversation("progressive", "Draft the north wing"); const binding = task("progressive");
  controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause", expected_command_id: null });
  const pages: any[] = [];
  const final = await listTaskNavigationAsync(100, page => { pages.push(page); return true; });
  assert.equal(pages[0].loading, true); assert.equal(pages[0].tasks[0].title, "Draft the north wing");
  assert.equal(pages[0].tasks[0].state, "loading");
  assert.equal(final.loading, false); assert.equal(final.tasks[0].state, "paused");
  let calls = 0;
  const stopped = await listTaskNavigationAsync(100, () => { calls++; return false; });
  assert.equal(calls, 1); assert.equal(stopped.loading, true);
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)?.execution_control?.state, "paused");
}));

test("task discovery HTTP streams an initial catalogue and a final canonical status page", () => workspace(async () => {
  conversation("stream-history", "Keep my history available"); const binding = task("stream-history");
  controlAssignmentExecutionV2({ binding, action: "pause", command_id: "pause", expected_command_id: null });
  const server = http.createServer((req,res) => {
    void runWithRequestContext(local, () => handleAssignmentHttpRoute(req,res,new URL(req.url!,"http://localhost"),() => true));
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/task-navigation?stream=1`);
    assert.match(response.headers.get("content-type")!, /application\/x-ndjson/);
    const pages = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(pages[0].loading,true); assert.equal(pages.at(-1).loading,false);
    assert.equal(pages.at(-1).tasks[0].state,"paused");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));
