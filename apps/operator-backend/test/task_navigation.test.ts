import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { listTaskNavigation, listTaskNavigationAsync } from "../src/assignments/task_navigation.js";
import { readNavigationProjectionAsync } from "../src/assignments/task_navigation_reader.js";
import { prepareAssignmentTurn } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2, appendCurrentAssignmentKernelEventV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { requestAssignmentInputV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
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

test("canonical review is distinct from a required answer in synchronous and asynchronous task discovery", () => workspace(async () => {
  conversation("review-status", "Inspect the completed schedule"); const review = task("review-status");
  appendCurrentAssignmentKernelEventV2({ goal_id: review.assignment_id, binding: getAssignmentKernelSnapshotV2(review.assignment_id)!.current_binding,
    event_id: "review-status-request", actor: "test", body: { event_type: "review_requested", review_id: "review-status", work_unit_ids: [], reason: "Review the retained work." } });
  assert.equal(getAssignmentKernelSnapshotV2(review.assignment_id)!.outcome, "awaiting_user_review");
  conversation("answer-status", "Set the schedule scope"); const answer = task("answer-status");
  requestAssignmentInputV2({ binding: answer, clarification_id: "scope-question", variable_ids: ["scope_choice"],
    new_variable_ids: ["scope_choice"], question: "Which equipment should the schedule include?" });
  assert.equal(getAssignmentKernelSnapshotV2(answer.assignment_id)!.outcome, "awaiting_user_input");
  const before = [review, answer].map(binding => getAssignmentKernelSnapshotV2(binding.assignment_id));
  for (const page of [listTaskNavigation(), await listTaskNavigationAsync()]) {
    assert.equal(page.tasks.find(row => row.session_id === review.session_id)!.state, "needs_review");
    assert.match(page.tasks.find(row => row.session_id === review.session_id)!.summary, /ready for review/i);
    assert.equal(page.tasks.find(row => row.session_id === answer.session_id)!.state, "needs_input");
    assert.match(page.tasks.find(row => row.session_id === answer.session_id)!.summary, /answer is needed/i);
  }
  assert.deepEqual([review, answer].map(binding => getAssignmentKernelSnapshotV2(binding.assignment_id)), before, "Discovery never resumes or rewrites the tasks.");
  controlAssignmentExecutionV2({ binding: review, action: "pause", command_id: "pause-review", expected_command_id: null });
  assert.equal(listTaskNavigation().tasks.find(row => row.session_id === review.session_id)!.state, "paused");
  assert.equal((await listTaskNavigationAsync()).tasks.find(row => row.session_id === review.session_id)!.state, "paused");
}));

test("async history reader preserves canonical byte validation across concurrent reads and same-stat rewrites", () => workspace(async () => {
  conversation("worker-byte-check", "Review the circuit"); const binding=task("worker-byte-check"), file=getGoalStoragePath(binding.assignment_id)!;
  const original=fs.readFileSync(file,"utf8"), stat=fs.statSync(file);
  const first=readNavigationProjectionAsync(file), concurrent=readNavigationProjectionAsync(file);
  assert.equal(first,concurrent,"Concurrent navigation observers share a read, not duplicate journal replay.");
  const before=await first;assert(before&&!before.invalid);assert.deepEqual(before.binding,getAssignmentKernelSnapshotV2(binding.assignment_id)!.current_binding);
  const record=JSON.parse(original),request=record.assignment_kernel_v2.events[0].spec.source_user_request;
  assert.equal(typeof request,"string");const replacement="B".repeat(request.length);
  const rewritten=original.replaceAll(JSON.stringify(request),JSON.stringify(replacement));
  assert.notEqual(rewritten,original);assert.equal(Buffer.byteLength(rewritten),Buffer.byteLength(original));
  fs.writeFileSync(file,rewritten);fs.utimesSync(file,stat.atime,stat.mtime);
  const changed=await readNavigationProjectionAsync(file);assert(changed&&!changed.invalid);
  assert.equal(changed.title,replacement.slice(0,180));
  const invalid=JSON.parse(rewritten);invalid.assignment_kernel_v2.events[0].binding.generation=0;
  fs.writeFileSync(file,JSON.stringify(invalid));assert.deepEqual(await readNavigationProjectionAsync(file),{invalid:true});
  fs.writeFileSync(file,original);assert.deepEqual(await readNavigationProjectionAsync(file),before);
  assert.equal(fs.readFileSync(file,"utf8"),original,"Projection reads never rewrite canonical records.");
}));

test("async navigation keeps live execution ownership outside its cached journal projection", () => workspace(async () => {
  conversation("async-lost-worker", "Inspect and correct the ductwork");const binding=task("async-lost-worker");
  const lease=openAssignmentKernelOperationV2({snapshot:getAssignmentKernelSnapshotV2(binding.assignment_id)!,controller_request_id:"read",provider_turn_id:"old-provider",capability_id:"inventory.read",classified_effect:"read",arguments:{id:1}});
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const before=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  const state=async()=>(await listTaskNavigationAsync()).tasks.find(row=>row.session_id===binding.session_id)!.state;
  assert.equal(await state(),"unknown");
  const owner=beginAssignmentKernelTerminalBarrierV2({binding,barrier_id:"async-real-owner"});
  try{assert.equal(await state(),"working");}finally{endAssignmentKernelTerminalBarrierV2(owner);}
  assert.equal(await state(),"unknown");assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id),before);
}));

test("async worker projections remain scoped to the requesting principal", () => workspace(async () => {
  const own:RequestPrincipal={sub:"owner-a",user_id:"owner-a",tenant_id:"team",license_id:"team",roles:[],tier:null,claims:{}};
  const foreign:RequestPrincipal={...own,sub:"owner-b",user_id:"owner-b"};
  for(const principal of [own,foreign])runWithRequestContext({principal},()=>{
    const session=createPrincipalBoundSessionId(principal);conversation(session,principal.user_id===own.user_id?"Owned work":"PRIVATE FOREIGN WORK");
    const binding=task(session);controlAssignmentExecutionV2({binding,action:"pause",command_id:"pause",expected_command_id:null});
  });
  await runWithRequestContext({principal:own},async()=>{
    const page=await listTaskNavigationAsync(100);
    assert.equal(page.tasks.length,1);assert.equal(page.tasks[0]!.title,"Owned work");assert.equal(page.tasks[0]!.state,"paused");
    assert(!JSON.stringify(page).includes("PRIVATE FOREIGN WORK"));
  });
}));

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
