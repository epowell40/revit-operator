import { createServer } from "node:http";
import { handleAssignmentHttpRoute } from "../src/assignments/http_routes.js";
import { finalCodexAssignmentMessageV2 } from "../src/brains/codex_assignment_progress.js";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { storeEvidence, retrieveEvidence } from "../src/evidence/evidence_store.js";
import { steerAssignment, assignmentDirections } from "../src/assignments/task_steering.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner } from "../src/teammate_loop_runtime.js";
import { startCodexProviderTurnWhenActive } from "../src/brains/thin_reference_execution.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createGoal, getGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { __closeForTests, appendEvent, getConversationTurn } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { assignmentSpecFromGoalV2, createAssignmentKernelForGoalV2, assignmentKernelV2ForBinding } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2, appendCurrentAssignmentKernelEventV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, settleAssignmentKernelOperationV2, failAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { selectLocalAdvisoryPolicy } from "../src/assignments/local_advisory_policy.js";
import { manageAssignmentWorkPlan } from "../src/assignments/assignment_work_plan.js";
import { advanceAssignmentKernelProgressV2, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2, recordAssignmentProviderCallStateV2, recordCompletedAssignmentProviderReceiptV2, recordAssignmentProgressEpochV2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2 } from "../src/assignments/assignment_work_allowance_v2.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { requestAssignmentInputV2, supplyAssignmentInputResultV2 } from "../src/assignments/assignment_kernel_v2_lifecycle.js";
import { assertAdvisoryCheckpointContinuationV1 } from "../src/domain/assignment-kernel/reducer.js";
import { createAssignmentKernelV2ModelReceiptRecorder } from "../src/assignments/assignment_kernel_v2_provider_budget.js";
import { localThinReferenceLimits, runThinReferenceTurns } from "../src/brains/thin_reference_execution.js";
import { getThinReferenceCodexProfile } from "../src/brains/codex_turn_profile.js";
import { prepareCodexAssignmentProgressV2 } from "../src/brains/codex_assignment_progress.js";
import { AssignmentJournalV2, canonicalJsonV2, decideAssignmentProgressV2, deriveAssignmentOutcomeV2, type AssignmentSnapshotV2, type AssignmentEventV2 } from "../src/domain/assignment-kernel/index.js";

const local = { operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only", { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" }) };
const proposal = { claimed_completed: ["Drafted a useful partial network."], remaining_work: ["Review terminal connections."], uncertainties: ["Drawing elevation is ambiguous."] };
async function fixture(advisory: boolean | "installation", fn: (f: ReturnType<typeof setup>) => unknown | Promise<unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-advisory-"));
  const env = { OPERATOR_WORKSPACE_ROOT: root, REVIT_OPERATOR_MODE: advisory === "installation" ? "development" : "local",
    OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS: advisory === true ? "experiment" : "",
    OPERATOR_LOCAL_EXECUTOR_PROFILE: advisory === "installation" ? "codex_v2_advisory_v1" : "",
    OPERATOR_ASSIGNMENT_KERNEL_V2: "1", OPERATOR_BRAIN: "codex", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory", OPERATOR_HOSTED_ENABLED: "0" };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env); __testOnlyResetGoalListCache();
  try { await runWithRequestContext(local, () => fn(setup())); }
  finally { __testOnlyResetGoalListCache(); __closeForTests(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true, force: true }); }
}
function setup(effect: "apply" | "preview" = "apply", sessionId = "experiment") {
  const goal = createGoal({ title: "Draft rooms", objective: "Draft ductwork in every room from the PDF and inspect connections.",
    acceptance_criteria: ["The drawing is reconstructed."], status: "active", related_session_id: sessionId, created_by: "local-host",
    work_budget: { requested_effect: effect, document_fingerprint: "disposable-linked-model" } });
  const binding = createAssignmentKernelForGoalV2({ goal, run_id: "experiment-run" });
  return { goal, binding, state: () => getAssignmentKernelSnapshotV2(goal.id)! };
}
function open(f: ReturnType<typeof setup>, id: string, effect: "read" | "apply" = "read", element = 11) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "turn", controller_request_id: id,
    capability_id: "revit_call_tool", classified_effect: effect, target_tokens: [`id:${element}`],
    arguments: { method: "POST", path: effect === "apply" ? "/revit/connect-mep-elements" : "/revit/get-element",
      body: effect === "apply" ? { sourceElementId: element, targetElementIds: [12], dryRun: false } : { elementId: element } } });
}
function settle(f: ReturnType<typeof setup>, lease: ReturnType<typeof open>, effect: "none" | "applied" = "none", transform?: (result: any) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const op = f.state().operations[lease.operation_id]!, payload = { status: "Applied", nativeReceipt: "synthetic test receipt" };
  const envelope = { content: [], structuredContent: {
    schema: "revit-operator.assignment-kernel-mcp-result/v2",
    operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
      binding: lease.binding, status: "succeeded", dispatch_state: "dispatched", persistent_effect: effect,
      native_transaction_state: effect === "applied" ? "committed" : "not_applicable", authority: "native-host",
      result_schema_id: `operator-native/POST:${op.request_identity?.path}/v2`, observation_required: true,
      raw_payload_hash: createHash("sha256").update(canonicalJsonV2(payload)).digest("hex"), receipt_id: `receipt:${lease.operation_id}`,
      native_correlation_id: `native:${lease.operation_id}`, request_identity: op.request_identity, completed_at: new Date().toISOString() },
    observation: { raw_payload: payload, semantic_facts: [{ fact_id: op.fulfillment_role === "supporting_control" ? "control.result_available" : op.fulfillment_role === "verification" ? "verification.result_available" : "task.result_available",
      fact_class: op.fulfillment_role === "supporting_control" ? "control" : op.fulfillment_role === "verification" ? "verification" : "domain", value: true }], verification_relevance: ["task_result"] }
  } };
  transform?.(envelope.structuredContent.operation_result_v2);
  return settleAssignmentKernelOperationV2(lease, envelope);
}
function decide(snapshot: AssignmentSnapshotV2, overrides: Record<string, number> = {}) {
  return decideAssignmentProgressV2({ snapshot, budget: { ...defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), ...overrides }, now: new Date().toISOString() });
}

test("advisory selection is exact-session local-host only and immutable after journal reload", () => fixture(true, f => {
  const stored = f.state().spec.execution_policy!;
  assert.equal(stored.max_provider_calls, 64); assert.equal(stored.max_wall_clock_ms, 20 * 60_000);
  const env = { REVIT_OPERATOR_MODE: "local", OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS: "experiment" };
  for (const mode of ["hosted", "self_hosted", "production", ""]) assert.equal(selectLocalAdvisoryPolicy(f.binding, { ...env, REVIT_OPERATOR_MODE: mode }, local), undefined);
  assert.equal(selectLocalAdvisoryPolicy({ ...f.binding, session_id: "experiment-extra" }, env, local), undefined);
  assert.equal(selectLocalAdvisoryPolicy(f.binding, env, { ...local, principal: {} as any }), undefined);
  assert.equal(selectLocalAdvisoryPolicy(f.binding, env, { operator_backend_auth: createOperatorBackendAuth("shared_token", "test", { OPERATOR_API_BASE_URL: "https://remote.example" }) }), undefined);
  process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = ""; process.env.OPERATOR_ADVISORY_MAX_PROVIDER_CALLS = "200";
  try {
    __testOnlyResetGoalListCache(); assert.deepEqual(f.state().spec.execution_policy, stored);
    assert.deepEqual(localThinReferenceLimits({ session_id: f.binding.session_id, assignment_id: f.binding.assignment_id,
      assignment_run_id: f.binding.run_id, assignment_generation: f.binding.generation }), { max_turns: 8, max_wall_ms: 20 * 60_000 });
    assert.equal(localThinReferenceLimits({ session_id: "foreign", assignment_id: f.binding.assignment_id, assignment_run_id: f.binding.run_id, assignment_generation: 1 }), null);
  } finally { delete process.env.OPERATOR_ADVISORY_MAX_PROVIDER_CALLS; }
  runWithRequestContext({ ...local, principal: {} as any }, () => assert.equal(assignmentKernelV2ForBinding(f.binding), null));
  assert.notEqual(getThinReferenceCodexProfile("experiment", true).threadKey, getThinReferenceCodexProfile("experiment").threadKey);
}));

test("explicit local installation selects new unlisted assignments without changing existing strict history", () => fixture(false, strict => {
  const strictBefore = structuredClone(getGoal(strict.goal.id)!.assignment_kernel_v2!.events);
  assert.equal(strict.state().spec.execution_policy, undefined);
  process.env.REVIT_OPERATOR_MODE = "development";
  process.env.OPERATOR_LOCAL_EXECUTOR_PROFILE = "codex_v2_advisory_v1";
  const first = setup("apply", "ordinary-ui-first"), second = setup("preview", "ordinary-ui-second");
  assert.equal(first.state().spec.execution_policy?.mode, "local_advisory_v1");
  assert.equal(second.state().spec.execution_policy?.mode, "local_advisory_v1");
  assert.equal(second.state().spec.requested_effect, "preview");
  settle(first, open(first, "retained-read"));
  controlAssignmentExecutionV2({ binding: first.binding, command_id: "ordinary-pause", expected_command_id: null, action: "pause" });
  const saved = structuredClone(first.state());
  const savedEvents = structuredClone(getGoal(first.goal.id)!.assignment_kernel_v2!.events);
  process.env.OPERATOR_LOCAL_EXECUTOR_PROFILE = "";
  process.env.OPERATOR_ADVISORY_MAX_PROVIDER_CALLS = "200";
  try {
    __testOnlyResetGoalListCache();
    assert.deepEqual(first.state(), saved);
    assert.deepEqual(getGoal(first.goal.id)!.assignment_kernel_v2!.events, savedEvents);
    assert.deepEqual(getGoal(strict.goal.id)!.assignment_kernel_v2!.events, strictBefore);
    assert.equal(strict.state().spec.execution_policy, undefined);
    assert.equal(first.state().execution_control?.state, "paused");
    assert.deepEqual(localThinReferenceLimits({ session_id: first.binding.session_id, assignment_id: first.binding.assignment_id,
      assignment_run_id: first.binding.run_id, assignment_generation: first.binding.generation }), { max_turns: 8, max_wall_ms: 20 * 60_000 });
  } finally { delete process.env.OPERATOR_ADVISORY_MAX_PROVIDER_CALLS; }
}));

test("installation enrollment rejects nonlocal identities, unavailable profiles and caller fields", () => fixture(false, f => {
  const enabled = { REVIT_OPERATOR_MODE: "development", OPERATOR_BRAIN: "codex", OPERATOR_TOOL_EXPOSURE_PROFILE: "laboratory",
    OPERATOR_ASSIGNMENT_KERNEL_V2: "1", OPERATOR_LOCAL_EXECUTOR_PROFILE: "codex_v2_advisory_v1" };
  const binding = { ...f.binding, session_id: "ordinary-unlisted" };
  assert.equal(selectLocalAdvisoryPolicy(binding, enabled, local)?.mode, "local_advisory_v1");
  for (const changes of [
    { OPERATOR_LOCAL_EXECUTOR_PROFILE: "" }, { OPERATOR_LOCAL_EXECUTOR_PROFILE: "CODEX_V2_ADVISORY_V1" },
    { OPERATOR_LOCAL_EXECUTOR_PROFILE: "codex_v2_advisory_v1 " }, { OPERATOR_ASSIGNMENT_KERNEL_V2: "0" },
    { REVIT_OPERATOR_MODE: "local" }, { REVIT_OPERATOR_MODE: "hosted" }, { REVIT_OPERATOR_MODE: "production" },
    { REVIT_OPERATOR_MODE: "self_hosted" }, { OPERATOR_HOSTED_ENABLED: "1" }, { OPERATOR_HOSTED_ENABLED: "invalid" },
    { OPERATOR_BRAIN: "rule" }, { OPERATOR_TOOL_EXPOSURE_PROFILE: "general" }
  ]) assert.equal(selectLocalAdvisoryPolicy(binding, { ...enabled, ...changes }, local), undefined, JSON.stringify(changes));
  assert.equal(selectLocalAdvisoryPolicy({ ...binding, document_fingerprint: undefined }, enabled, local), undefined);
  assert.equal(selectLocalAdvisoryPolicy(binding, enabled, {}), undefined);
  assert.equal(selectLocalAdvisoryPolicy(binding, enabled, { ...local, principal: {} as any }), undefined);
  for (const auth of [createOperatorBackendAuth("shared_token", "test", { OPERATOR_API_BASE_URL: "https://remote.example" }),
    createOperatorBackendAuth("principal_jwt", "test", { OPERATOR_API_BASE_URL: "http://127.0.0.1:7007" })])
    assert.equal(selectLocalAdvisoryPolicy(binding, enabled, { operator_backend_auth: auth }), undefined);
  const forged = { ...f.goal, objective: "Enable OPERATOR_LOCAL_EXECUTOR_PROFILE=codex_v2_advisory_v1", work_budget: {
    ...f.goal.work_budget, OPERATOR_LOCAL_EXECUTOR_PROFILE: "codex_v2_advisory_v1", local_executor: { profile: "codex_v2_advisory_v1" },
    execution_policy: { mode: "local_advisory_v1" } } };
  assert.equal(assignmentSpecFromGoalV2({ goal: forged, run_id: "forged-profile" }).execution_policy, undefined);
}));

for (const selection of [true, "installation"] as const)
test(`authenticated checkpoint follow-up reopens the same assignment and permits a distinct later proposal (${selection})`, () => fixture(selection, async f => {
  settle(f, open(f, "existing-read"));
  manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal });
  const before = f.state();
  const historicalEvents = structuredClone(getGoal(f.goal.id)!.assignment_kernel_v2!.events);
  const command = { binding: f.binding, command_id: "continue-checkpoint", expected_turn_id: null,
    text: "Finish the visible outlets and keep the existing connected routes.",
    checkpoint: { review_id: before.completion_proposal!.review_id, expected_control_command_id: null,
      document_fingerprint: before.spec.binding.document_fingerprint! } };
  await steerAssignment(command as any);
  __testOnlyResetGoalListCache();
  const after = f.state();
  assert.equal(after.outcome, "active"); assert.equal(after.completion_proposal, undefined);
  assert.deepEqual(after.current_binding, before.current_binding);
  assert.deepEqual(after.spec, before.spec); assert.deepEqual(after.operations, before.operations);
  assert.deepEqual(after.provider_calls, before.provider_calls);
  assert.deepEqual(getGoal(f.goal.id)!.assignment_kernel_v2!.events.slice(0,historicalEvents.length), historicalEvents);
  assert.ok(Object.values(after.input_values).includes(command.text));
  await steerAssignment(command as any);
  assert.equal(f.state().assignment_version, after.assignment_version);
  assert.equal(assignmentDirections(f.binding).length, 1);
  manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal });
  const later = f.state();
  assert.notEqual(later.completion_proposal!.review_id, before.completion_proposal!.review_id);
  await steerAssignment(command as any);
  assert.deepEqual(f.state(), later, "an old exact retry cannot reopen a later checkpoint");
}));

function checkpointCommand(f: ReturnType<typeof setup>, id = "checkpoint-followup") {
  return { binding:f.binding, command_id:id, expected_turn_id:null, text:"Finish the source-visible outlets without changing the connected mains.",
    checkpoint:{review_id:f.state().completion_proposal!.review_id,expected_control_command_id:f.state().execution_control?.command_id ?? null,
      document_fingerprint:f.state().spec.binding.document_fingerprint!} };
}

for (const prefix of ["receipt", "requested", "supplied", "chat"] as const)
test(`checkpoint continuation recovers the ${prefix} crash prefix without duplicate direction or changed history`, () => fixture(true, async f => {
  manageAssignmentWorkPlan({binding:f.binding,action:"propose_completion",completion_proposal:proposal});
  const command=checkpointCommand(f), variable="user_direction_"+createHash("sha256").update(command.command_id).digest("hex").slice(0,32);
  appendEvent(f.binding.session_id,"user","task.steering",{command_id:command.command_id,binding:f.binding,text:command.text,
    thread_id:null,turn_id:null,state:"saved",updated_at:new Date().toISOString(),checkpoint:command.checkpoint});
  if (prefix!=="receipt") requestAssignmentInputV2({binding:f.binding,clarification_id:command.command_id,variable_ids:[variable],new_variable_ids:[variable],question:"Additional direction from the user"});
  if (prefix==="supplied" || prefix==="chat") supplyAssignmentInputResultV2({binding:f.binding,clarification_id:command.command_id,external_values:{[variable]:command.text}});
  if (prefix==="chat") appendEvent(f.binding.session_id,"user","chat.message",{text:command.text,message_id:command.command_id,
    display:{source:"ui_context",message_id:command.command_id,text:command.text},steering:true});
  const before=structuredClone(getGoal(f.goal.id)!.assignment_kernel_v2!.events);
  __testOnlyResetGoalListCache(); await steerAssignment(command); await steerAssignment(command);
  assert.equal(f.state().outcome,"active");assert.equal(f.state().completion_proposal,undefined);
  assert.equal(assignmentDirections(f.binding).length,1);assert.equal(getConversationTurn(f.binding.session_id,command.command_id).length,1);
  const events=getGoal(f.goal.id)!.assignment_kernel_v2!.events;
  assert.deepEqual(events.slice(0,before.length),before);
  assert.equal(events.filter(e=>e.event_type==="review_resolved").length,1);
  assert.equal(events.filter(e=>e.event_type==="input_requested").length,1);
  assert.equal(events.filter(e=>e.event_type==="input_supplied").length,1);
}));

test("checkpoint follow-up rejects stale control/document/review and conflicting retries without releasing work", () => fixture(true, async f => {
  manageAssignmentWorkPlan({binding:f.binding,action:"propose_completion",completion_proposal:proposal});
  const command=checkpointCommand(f);
  await assert.rejects(steerAssignment({...command,checkpoint:{...command.checkpoint,document_fingerprint:"other-model"}}),/document/);
  await assert.rejects(steerAssignment({...command,checkpoint:{...command.checkpoint,review_id:"older-review"}}),/checkpoint/);
  controlAssignmentExecutionV2({binding:f.binding,action:"pause",command_id:"new-pause",expected_command_id:null});
  await assert.rejects(steerAssignment(command),/control changed/);
  assert.equal(assignmentDirections(f.binding).length,0);
  // A direction acknowledged against the current Pause can be saved, but does not resume it.
  const paused={...command,checkpoint:{...command.checkpoint,expected_control_command_id:"new-pause"}};
  await steerAssignment(paused);assert.equal(f.state().execution_control?.state,"paused");
  assert.throws(()=>open(f,"paused-write","apply",15),/paused/);
  await assert.rejects(steerAssignment({...paused,text:"A conflicting correction"}),/different content/);
}));

test("versioned review resolution preserves legacy replay and requires authenticated saved input", () => fixture(true, async f => {
  manageAssignmentWorkPlan({binding:f.binding,action:"propose_completion",completion_proposal:proposal});
  const command=checkpointCommand(f), original=structuredClone(getGoal(f.goal.id)!.assignment_kernel_v2!.events);
  const event=(actor:string,decision:string,continuation?:any):AssignmentEventV2=>({schema:"revit-operator.assignment-event/v2",event_id:"resolution",assignment_id:f.goal.id,
    assignment_version:original.length+1,binding:f.binding,actor,occurred_at:new Date().toISOString(),event_type:"review_resolved",review_id:command.checkpoint.review_id,decision,continuation});
  const make=()=>{const journal=new AssignmentJournalV2(); original.forEach(e=>journal.append(e));return journal;};
  const legacy=make().append(event("operator-runtime","accepted"));
  assert.equal(legacy.outcome,"awaiting_user_review");assert.ok(legacy.completion_proposal);
  assert.throws(()=>make().append(event("operator-work-plan","continue_advisory_checkpoint_v1")),/authenticated user/);
  assert.throws(()=>make().append(event("authenticated-user","continue_advisory_checkpoint_v1")),/saved user direction/);
}));

test("checkpoint continuation guards failure, unknown, unsettled work, remaining input and every immutable budget at reducer boundary", () => fixture(true, f => {
  manageAssignmentWorkPlan({binding:f.binding,action:"propose_completion",completion_proposal:proposal});
  const snapshot=f.state(), command=checkpointCommand(f);
  const continuation={command_id:command.command_id,expected_control_command_id:null,document_fingerprint:command.checkpoint.document_fingerprint,
    direction_variable_id:"user_direction_"+"a".repeat(32),direction_text:command.text};
  const rejects=(change:(s:AssignmentSnapshotV2)=>void,pattern:RegExp)=>{const state=structuredClone(snapshot);change(state);
    assert.throws(()=>assertAdvisoryCheckpointContinuationV1(state,command.checkpoint.review_id,continuation,new Date().toISOString(),true),pattern);};
  rejects(s=>{s.unresolved_unknown_operation_ids=["unknown"];},/Unknown effects/);
  rejects(s=>{s.in_flight_operation_ids=["native"];},/settle/);
  rejects(s=>{s.in_flight_provider_call_ids=["provider"];},/settle/);
  rejects(s=>{s.pending_input_variable_ids=["unanswered"];},/answers/);
  rejects(s=>{s.execution_failure_ids=["failure"];},/failure/);
  rejects(s=>{s.progress_blocker={code:"stopped"} as any;},/failure/);
  rejects(s=>{s.provider_budget_exhausted={} as any;},/failure/);
  rejects(s=>{s.spec.execution_policy!.max_provider_calls=1;s.provider_calls={used:{} as any};},/usage limits/);
  rejects(s=>{s.spec.execution_policy!.max_operations=1;s.operations={used:{} as any};},/usage limits/);
  rejects(s=>{s.spec.execution_policy!.max_total_tokens=1;s.provider_calls={used:{usage:{total_tokens:1}} as any};},/usage limits/);
  rejects(s=>{s.spec.execution_policy!.max_wall_clock_ms=1;s.spec.created_at="2020-01-01T00:00:00.000Z";
    s.provider_calls={used:{admitted_at:"2020-01-01T00:00:00.000Z",completed_at:"2020-01-01T00:00:01.000Z"} as any};},/usage limits/);
  rejects(s=>{s.current_binding.document_fingerprint="other";},/document/);
}));

test("request/goal fields cannot enable policy and strict multi-part apply still requires a plan", () => fixture(false, f => {
  assert.equal(f.state().spec.execution_policy, undefined);
  const fake = assignmentSpecFromGoalV2({ goal: { ...f.goal, work_budget: { ...f.goal.work_budget, execution_policy: { mode: "local_advisory_v1" } } }, run_id: "other" });
  assert.equal(fake.execution_policy, undefined);
  assert.throws(() => open(f, "strict-write", "apply"), /declare_work_plan/);
  assert.throws(() => manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal }), /not_enabled/);
}));

test("missing proof remains visible while useful reads and another distinct edit stay admissible", () => fixture(true, f => {
  const apply = open(f, "endpoint", "apply"); settle(f, apply, "applied");
  assert.equal(f.state().operations[apply.operation_id]!.verification_operation_ids.length, 0);
  for (const id of ["read-one", "read-again"]) settle(f, open(f, id));
  assert.equal(decide(f.state()).decision, "admit_reasoning_turn");
  assert.equal(f.state().outcome, "active"); assert.equal(f.state().terminal, false);
  assert.throws(() => open(f, "replayed-write-different-controller", "apply"), /repeat/);
  settle(f, open(f, "different-native-write", "apply", 13), "applied");
  assert.match(prepareCodexAssignmentProgressV2(f.binding, true).prompt, /propose_completion/);
  assert.doesNotMatch(prepareCodexAssignmentProgressV2(f.binding, true).prompt, /Gap contracts|eligible_criterion_ids/);
}));

test("semantic no-progress and passed criteria cannot produce either a veto or certified completion", () => fixture(true, f => {
  const snapshot = f.state();
  const epochs = Array.from({ length: 8 }, (_, i) => ({ epoch_id: `e${i}`, genuine_progress: false, unresolved_gap_ids: ["same"] } as any));
  const advisory = { ...snapshot, progress_epochs: epochs };
  const strict = structuredClone(advisory); delete strict.spec.execution_policy;
  assert.equal(decide(strict).reason, "no_progress_budget_exhausted");
  assert.equal(decide(advisory).decision, "admit_reasoning_turn");
  const passed = { ...snapshot, criteria: Object.fromEntries(snapshot.spec.criteria.map(c => [c.criterion_id, { criterion_id: c.criterion_id, status: "pass" } as any])) };
  assert.equal(deriveAssignmentOutcomeV2(passed), "active");
  assert.deepEqual(defaultAssignmentWorkBudgetV2(snapshot, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), defaultAssignmentWorkBudgetV2({ ...snapshot, work_plan: { items: [{ kind: "edit" }, { kind: "edit" }] } as any }, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2));
  for (const [name, cap] of [["max_operations", Object.keys(snapshot.operations).length], ["max_provider_calls", 0], ["max_reasoning_turns", 0], ["max_total_tokens", 0], ["max_wall_clock_ms", 0]] as const) {
    assert.equal(decide(advisory, { [name]: cap }).decision, "blocked", name);
    assert.notEqual(decide(advisory, { [name]: cap }).reason, "no_progress_budget_exhausted", name);
  }
}));

for (const stop of ["unknown", "paused", "input", "binding"] as const) test(`advisory preserves ${stop} as a hard execution boundary`, () => fixture(true, f => {
  if (stop === "unknown") { const lease = open(f, "uncertain", "apply"); markAssignmentKernelOperationDispatchStartedV2(lease); failAssignmentKernelOperationV2(lease, new Error("lost native ack"), "dispatched"); }
  if (stop === "paused") controlAssignmentExecutionV2({ binding: f.binding, action: "pause", command_id: "pause", expected_command_id: null });
  if (stop === "input") requestAssignmentInputV2({ binding: f.binding, clarification_id: "floor", variable_ids: ["floor"], new_variable_ids: ["floor"], question: "Which floor?" });
  if (stop === "binding") {
    assert.throws(() => openAssignmentKernelOperationV2({ snapshot: { ...f.state(), current_binding: { ...f.binding, generation: 9 } }, provider_turn_id: "bad", controller_request_id: "bad", capability_id: "revit_call_tool", classified_effect: "apply", arguments: { method: "POST", path: "/revit/connect-mep-elements" } }), /binding/);
  } else {
    assert.throws(() => open(f, "write-after-stop", "apply", 14));
    assert.throws(() => manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal }));
    assert.notEqual(decide(f.state()).decision, "admit_reasoning_turn");
  }
}));

test("completion proposal drains current provider, retains late receipt and never passes criteria", () => fixture(true, f => {
  recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "draining", state: "admitted", provider: "codex", model: "model", gap_ids: [], criterion_ids: [], expected_information: ["Original task work."] });
  const result = manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal });
  assert.equal(result.outcome, "active"); assert.equal(f.state().completion_proposal?.verified, false);
  assert.equal(decide(f.state()).decision, "await_provider");
  assert.throws(() => startCodexProviderTurnWhenActive({ binding: f.binding, readSnapshot: f.state }, async () => { throw new Error("must not dispatch"); }), /advisory_completion_proposed/);
  assert.throws(() => open(f, "post-proposal"), /proposal/);
  recordAssignmentProviderCallStateV2({ binding: f.binding, call_id: "draining", state: "completed", success: true });
  assert.equal(f.state().outcome, "awaiting_user_review"); assert.equal(decide(f.state()).decision, "request_user_review");
  const recorder = createAssignmentKernelV2ModelReceiptRecorder({ binding: f.binding, onStop: () => undefined });
  const receipt = { call_id: "late-receipt", provider: "codex", model: "model", reasoning_effort: "medium", started_at_utc: new Date().toISOString(), duration_ms: 1, success: true,
    tokens: { input_tokens: 3, output_tokens: 2, total_tokens: 5, reasoning_output_tokens: null } } as any;
  recorder.reconcile([receipt, receipt]);
  assert.equal(Object.keys(f.state().provider_calls).length, 2);
  assert.throws(() => recorder.reconcile([{ ...receipt, duration_ms: 2 }]), /conflict/);
  assert.equal(f.state().terminal, false); assert.deepEqual(f.state().criteria, {});
  __testOnlyResetGoalListCache(); assert.deepEqual(f.state().completion_proposal?.remaining_work, proposal.remaining_work);
  assert.throws(() => manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal }), /proposal_pending/);
}));

test("advisory checklist completion records a claim separately from verified item status", () => fixture(true, f => {
  manageAssignmentWorkPlan({ binding: f.binding, action: "declare", declaration: { items: [{ item_id: "room", description: "Room route", source_basis: "PDF page" }], assumptions: [] } });
  const apply = open(f, "edit", "apply"); settle(f, apply, "applied");
  manageAssignmentWorkPlan({ binding: f.binding, action: "complete", item_id: "room", operation_ids: [apply.operation_id] });
  assert.equal(f.state().work_plan_claims?.[0]?.verified, false);
  assert.equal(f.state().work_plan?.items[0]?.completed_at, undefined);
  assert.equal(f.state().outcome, "active");
}));

test("rolled-back preview missing its semantic adapter remains a diagnostic with original failure intact", () => fixture(true, () => {
  const f = setup("preview");
  const lease = openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: "preview", controller_request_id: "preview",
    capability_id: "revit_call_tool", classified_effect: "preview", arguments: { method: "POST", path: "/revit/rotate-elements", body: { elementIds: [11], angleDegrees: 180, dryRun: true } } });
  settle(f, lease, "none", result => {
    result.status = "failed_after_dispatch"; result.native_transaction_state = "rolled_back";
    result.error_code = "preview_semantic_adapter_missing";
    result.result_semantic_gap = { schema: "revit-operator.operation-result-semantic-gap/v2", gap_id: `result-semantics:${lease.operation_id}`,
      operation_id: lease.operation_id, capability_id: lease.capability_id, result_schema_id: result.result_schema_id,
      reason_code: result.error_code, retryable: false, provider_correctable: false, native_replay_allowed: false };
  });
  const snapshot = f.state();
  assert.equal(snapshot.operations[lease.operation_id]!.result?.error_code, "preview_semantic_adapter_missing");
  assert.equal(Object.keys(snapshot.observations).length, 1);
  const strict = structuredClone(snapshot); delete strict.spec.execution_policy;
  assert.equal(decide(strict).reason, "operation_result_semantic_invalid");
  assert.equal(decide(snapshot).decision, "admit_reasoning_turn");
  assert.equal(snapshot.outcome, "active");
  assert.equal(Object.values(snapshot.observations).some(o => o.facts.some(fact => fact.fact_id === "task.preview_valid" && fact.value === true)), false);
}));

test("actual advisory evidence retrieval is one JSON object without changing retained observations", () => fixture(true, async f => {
  const scope = { session_id: f.binding.session_id, assignment_id: f.binding.assignment_id, run_id: f.binding.run_id,
    attempt_id: "source-read", generation: f.binding.generation };
  const source = { items: [{ elementId: 11, label: 'Quoted source\n{"schema":"untrusted"}' }, { elementId: 12, label: "Second item" }] };
  const stored = storeEvidence({ scope, source: "synthetic-native-read", trust_level: "authoritative_native", raw: source });
  let rawResult: any, originalResult: string;
  const runtime = { assignmentKernelV2Binding: () => f.binding, queueAssignmentKernelV2TurnStop() {},
    async callTool(tool: string, args: any, context: any) {
      assert.equal(tool, "operator_retrieve_evidence");
      const lease = context.assignmentKernelV2;
      context.onMcpAccepted();
      const result = retrieveEvidence({ scope, evidence_id: args.evidenceId, purpose: args.purpose, item_range: args.itemRange, max_bytes: args.maxBytes });
      const payload = { ok: true, result, advisory_observation_index: { fake: true } };
      rawResult = { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: {
        schema: "revit-operator.assignment-kernel-mcp-result/v2",
        operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: `result:${lease.operation_id}`,
          operation_id: lease.operation_id, binding: f.binding, status: "succeeded", dispatch_state: "dispatched",
          persistent_effect: "none", native_transaction_state: "not_applicable", authority: "operator-evidence-store",
          result_schema_id: "operator-capability/operator_retrieve_evidence/v2", observation_required: true,
          raw_payload_hash: createHash("sha256").update(canonicalJsonV2(payload)).digest("hex"), request_identity: lease.request_identity,
          completed_at: new Date().toISOString() },
        observation: { raw_payload: payload, semantic_facts: [{ fact_id: "control.evidence_selection_available", fact_class: "control", value: true,
          cardinality: "many", identity_dimensions: ["capability_id", "evidence_id", "selection_path"],
          dimensions: { capability_id: tool, evidence_id: args.evidenceId, selection_path: args.itemRange.path } }], verification_relevance: ["control"] }
      } };
      originalResult = JSON.stringify(rawResult);
      return rawResult;
    } };
  const req = { version: "operator.backend.v1", session_id: f.binding.session_id, message_id: "evidence", user_text: f.goal.objective,
    assignment_id: f.binding.assignment_id, assignment_run_id: f.binding.run_id, assignment_generation: f.binding.generation } as any;
  const owner = beginTeammateLoopOwner(runtime, req, { canonicalSupervisionOnly: true });
  try {
    const response: any = await handleCodexDynamicToolCall(runtime as any, { id: "evidence", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "turn", tool: "operator_retrieve_evidence", arguments: {
        evidenceId: stored.ref.evidence_id, purpose: "Inspect the first retained element", itemRange: { path: "items", start: 0, count: 1, fields: ["elementId", "label"] }, maxBytes: 4000
      } } } as any);
    assert.equal(response.success, true);
    const consumed = JSON.parse(response.contentItems.map((item: any) => item.text).join("\n"));
    assert.equal(response.contentItems.length, 1);
    assert.deepEqual(consumed.result, rawResult.structuredContent.observation.raw_payload.result);
    assert.equal(consumed.model_observation_index, undefined, "advisory metadata cannot acquire strict criterion eligibility");
    const index = consumed.advisory_observation_index;
    assert.equal(index.schema, "revit-operator.advisory-observation-index/v1");
    assert.equal(index.fake, undefined); assert.equal(index.observations.length, 1);
    assert.match(index.usage, /does not certify task completion/);
    const snapshot = f.state(), entry = index.observations[0], observation = snapshot.observations[entry.observation_id]!;
    assert.deepEqual(observation.binding, snapshot.current_binding);
    assert.equal(entry.operation_id, observation.operation_id);
    assert.equal(entry.evidence_id, observation.raw_payload_ref.replace(/^evidence:/, ""));
    assert.equal(entry.capability_id, "operator_retrieve_evidence");
    assert.equal(snapshot.operations[entry.operation_id]!.result!.raw_payload_hash, rawResult.structuredContent.operation_result_v2.raw_payload_hash);
    const retained = retrieveEvidence({ scope: { ...scope, attempt_id: entry.operation_id }, evidence_id: entry.evidence_id, purpose: "Verify original immutable retrieval",
      text_range: { start: 0, length: 10000 }, max_bytes: 10000 });
    assert.deepEqual(JSON.parse(retained.selection as string), rawResult.structuredContent.observation.raw_payload);
    assert.equal(JSON.stringify(rawResult), originalResult!);
    assert.deepEqual(JSON.parse(retrieveEvidence({ scope, evidence_id: stored.ref.evidence_id, purpose: "Verify original source",
      text_range: { start: 0, length: 10000 }, max_bytes: 10000 }).selection as string), source);
  } finally { endTeammateLoopOwner(owner); }
}));

test("actual dynamic work-plan proposal stops the provider and rejects late model tools without dispatch", () => fixture(true, async f => {
  const req = { version: "operator.backend.v1", session_id: f.binding.session_id, message_id: "original", user_text: f.goal.objective,
    assignment_id: f.binding.assignment_id, assignment_run_id: f.binding.run_id, assignment_generation: f.binding.generation } as any;
  const stops: string[] = []; let calls = 0;
  const runtime = { assignmentKernelV2Binding: () => f.binding, queueAssignmentKernelV2TurnStop: (_turn: unknown, reason: string) => stops.push(reason),
    callTool: async (_tool: string, args: any) => {
      calls++;
      return { content: [{ type: "text", text: JSON.stringify(manageAssignmentWorkPlan({ binding: f.binding, action: args.action, completion_proposal: args.completionProposal })) }] };
    } };
  const owner = beginTeammateLoopOwner(runtime, req, { canonicalSupervisionOnly: true });
  try {
    const response: any = await handleCodexDynamicToolCall(runtime as any, { id: "proposal", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "turn", tool: "operator_manage_work_plan", arguments: { action: "propose_completion", completionProposal: proposal } } } as any);
    assert.equal(response.success, true); assert.deepEqual(stops, ["advisory_completion_proposed"]);
    assert.equal(calls, 1); assert.equal(f.state().outcome, "awaiting_user_review");
    let providerStarts = 0;
    assert.throws(() => startCodexProviderTurnWhenActive({ binding: f.binding, readSnapshot: f.state }, async () => { providerStarts++; }), /advisory_completion_proposed/);
    assert.equal(providerStarts, 0);
    const late: any = await handleCodexDynamicToolCall(runtime as any, { id: "late", method: "item/tool/call", params: {
      namespace: "revit_operator", turnId: "turn", tool: "revit_call_tool", arguments: { method: "GET", path: "/revit/context" } } } as any);
    assert.equal(late.success, false); assert.equal(calls, 1);
  } finally { endTeammateLoopOwner(owner); }
}));

test("immutable operation ceiling holds at real admission, and proposal stops autonomous continuation", () => fixture(true, async f => {
  const policy = f.state().spec.execution_policy!;
  const base = f.state();
  const journal = new AssignmentJournalV2();
  const spec = { ...base.spec, execution_policy: { ...policy, max_operations: 1 } };
  const event = (body: any) => ({ schema: "revit-operator.assignment-event/v2", event_id: `e${journal.events().length}`, assignment_id: f.binding.assignment_id,
    assignment_version: journal.events().length + 1, binding: f.binding, actor: "test", occurred_at: new Date().toISOString(), ...body } as AssignmentEventV2);
  journal.append(event({ event_type: "assignment_created", spec }));
  const lease = open(f, "read-one"), operation = f.state().operations[lease.operation_id]!;
  journal.append(event({ event_type: "operation_admitted", operation }));
  assert.throws(() => journal.append(event({ event_type: "operation_admitted", operation: { ...operation, operation_id: "over-budget" } })), { code: "operation_budget_exhausted" });
  settle(f, lease);
  const request = { version: "operator.backend.v1", session_id: f.binding.session_id, message_id: "same-message", user_text: f.goal.objective,
    assignment_id: f.binding.assignment_id, assignment_run_id: f.binding.run_id, assignment_generation: 1 } as any;
  const result = await runThinReferenceTurns({ request, binding: f.binding, limits: { max_turns: 8, max_wall_ms: 20 * 60_000 }, signal: new AbortController().signal,
    inspect: () => advanceAssignmentKernelProgressV2({ binding: f.binding }), invoke: async (_request, turn) => {
      assert.equal(turn, 1); manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: proposal });
      return { version: "operator.backend.v1", assistant_message: "Unverified result proposed.", actions: [], assignment_snapshot_v2: f.state(),
        provider_turn_usage: { schema: "revit-operator.provider-turn-usage/v1", session_id: f.binding.session_id, message_id: "same-message", thread_id: "thread", turn_id: "turn", disposition: "completed", raw_response_ids: [] } };
    } });
  assert.equal(result.turns, 1); assert.equal(result.response.assignment_snapshot_v2?.terminal, false);
  assert.equal(result.response.assignment_snapshot_v2?.outcome, "awaiting_user_review");
}));


test("advisory unfinished items survive authenticated HTTP update, an empty checkpoint and resume without changing authority", () => fixture(true, async f => {
  const server = createServer((req, res) => {
    const token = req.headers["x-operator-token"];
    if (token !== "test-only" && token !== "foreign-test") { res.writeHead(401).end(); return; }
    const context = token === "foreign-test" ? { ...local, principal: { sub: "foreign", user_id: "foreign", tenant_id: "other" } as any } : local;
    void runWithRequestContext(context, async () => {
      const handled = await handleAssignmentHttpRoute(req, res, new URL(req.url!, "http://127.0.0.1"), session => {
        if (session === f.binding.session_id) return true;
        res.writeHead(403).end(); return false;
      });
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const post = (body: Record<string, unknown>, token = "test-only") => fetch("http://127.0.0.1:" + port + "/api/assignments/v2/work-plan", {
    method: "POST", headers: { "content-type": "application/json", "x-operator-token": token }, body: JSON.stringify({ ...f.binding, ...body }) });
  const checkpoint = (remaining_work: string[]) => post({ action: "propose_completion", completion_proposal: {
    claimed_completed: ["Saved a useful draft."], remaining_work, uncertainties: [] } });
  const initial = f.state();
  try {
    assert.equal((await post({ action: "status" }, "")).status, 401);
    assert.equal((await post({ action: "status" }, "foreign-test")).status, 409);
    assert.equal((await post({ action: "status", session_id: "other" })).status, 403);
    assert.deepEqual(f.state(), initial);
    assert.equal((await checkpoint(["Inspect the inlet connection.", "Confirm the concealed outlet."])).status, 200);
    const oldEvents = structuredClone(getGoal(f.goal.id)!.assignment_kernel_v2!.events);
    await steerAssignment(checkpointCommand(f, "continue-unfinished-one"));
    const status = await (await post({ action: "status" })).json() as any;
    assert.equal(status.advisory_followups?.items.length, 2, "accepted checkpoint items must survive the real route and durable store");
    const first = status.advisory_followups.items[0];
    const command = { command_id: "resolve-inlet", item_id: first.item_id, expected_version: first.version,
      disposition: "resolved", reason: "Agent inspected and addressed this item; still unverified." };
    for (const body of [{ action: "update_followup", generation: f.binding.generation + 1, followup: command },
      { action: "update_followup", followup: { ...command, expected_version: 1 } },
      { action: "update_followup", followup: { ...command, reason: "" } },
      { action: "update_followup", followup: { ...command, verified: true } },
      { action: "status", followup: command }]) {
      const before = f.state();assert.equal((await post(body)).status, 409);assert.deepEqual(f.state(), before);
    }
    // Rejected command identities stay quarantined: use a fresh command for the accepted update.
    command.command_id = "resolve-inlet-valid";
    assert.equal((await post({ action: "update_followup", followup: command })).status, 200);
    assert.equal((await checkpoint([])).status, 200);
    const handoff = finalCodexAssignmentMessageV2(f.state(), "Everything is done.");
    assert.match(handoff, /1 saved unfinished report remains/);assert.match(handoff, /Confirm the concealed outlet/);
    assert.match(handoff, /Newly reported remaining work/);assert.doesNotMatch(handoff, /Inspect the inlet connection|Everything is done/);
    const pending = f.state();assert.equal((await post({ action: "update_followup", followup: command })).status, 200);
    assert.deepEqual(f.state(), pending, "exact retry cannot release the next checkpoint");
    await steerAssignment(checkpointCommand(f, "continue-unfinished-two"));
    assert.match(prepareCodexAssignmentProgressV2(f.binding).prompt, /Confirm the concealed outlet/);
    assert.equal((await (await post({ action: "status", followup_start: 1 })).json() as any).advisory_followups.items.length, 0);
    controlAssignmentExecutionV2({ binding: f.binding, command_id: "pause-unfinished", expected_command_id: null, action: "pause" });
    const paused = f.state();assert.equal((await post({ action: "update_followup", followup: command })).status, 200);
    assert.deepEqual(f.state(), paused);
    const other = paused.advisory_followups!.find(x => x.state === "open")!;
    assert.equal((await post({ action: "update_followup", followup: { ...command, command_id: "cannot-resume", item_id: other.item_id, expected_version: other.version } })).status, 409);
    assert.deepEqual(f.state(), paused);assert.deepEqual(paused.spec, initial.spec);
    assert.deepEqual(paused.operations, initial.operations);assert.deepEqual(paused.criteria, initial.criteria);
    assert.deepEqual(paused.provider_calls, initial.provider_calls);assert.equal(paused.work_plan, undefined);
    assert.deepEqual(getGoal(f.goal.id)!.assignment_kernel_v2!.events.slice(0, oldEvents.length), oldEvents);
    assert.deepEqual(new AssignmentJournalV2(getGoal(f.goal.id)!.assignment_kernel_v2!.events).snapshot(), paused);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("advisory compound supersession atomically retains replacements before the same-turn checkpoint", () => fixture(true, async f => {
  manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: {
    claimed_completed: ["Useful draft"], remaining_work: ["Close interior ends and confirm exterior devices."], uncertainties: [] } });
  await steerAssignment(checkpointCommand(f, "split-followup"));
  const before = f.state(), parent = before.advisory_followups![0]!;
  const command = { command_id: "split-compound", item_id: parent.item_id, expected_version: parent.version, disposition: "superseded" as const,
    reason: "Interior ends addressed; the remaining clauses are retained below.", replacements: [
      { kind: "remaining_work" as const, text: "Confirm exterior devices." }, { kind: "uncertainties" as const, text: "Exterior device type remains provisional." }] };
  for (const replacements of [[], [{ kind: "remaining_work", text: "x".repeat(1001) }], [{ kind: parent.kind, text: parent.text }]]) {
    assert.throws(() => manageAssignmentWorkPlan({ binding: f.binding, action: "update_followup", followup: { ...command, command_id: "bad-" + replacements.length + "-" + JSON.stringify(replacements).length, replacements } as any }));
    assert.deepEqual(f.state(), before);
  }
  manageAssignmentWorkPlan({ binding: f.binding, action: "update_followup", followup: command });
  const after = f.state();assert.equal(after.assignment_version, before.assignment_version + 1);assert.equal(after.completion_proposal, undefined);
  const children = after.advisory_followups!.filter(item => item.parent_item_id === parent.item_id);
  assert.equal(children.length, 2);assert.ok(children.every(item => !item.verified && item.source_field === "replacements"));
  assert.equal(after.advisory_followups![0]!.state, "superseded");
  manageAssignmentWorkPlan({ binding: f.binding, action: "propose_completion", completion_proposal: { claimed_completed: ["Closed interior ends."], remaining_work: [], uncertainties: [] } });
  const handoff = finalCodexAssignmentMessageV2(f.state(), "");
  assert.match(handoff, /Confirm exterior devices/);assert.match(handoff, /Exterior device type remains provisional/);
  assert.doesNotMatch(handoff, /Close interior ends and confirm/);
  const pending = f.state();manageAssignmentWorkPlan({ binding: f.binding, action: "update_followup", followup: command });assert.deepEqual(f.state(), pending);
  assert.throws(() => manageAssignmentWorkPlan({ binding: f.binding, action: "update_followup", followup: { ...command, command_id: "new-pending", item_id: children[0]!.item_id, expected_version: children[0]!.version, disposition: "resolved", replacements: undefined } }), /advisory_followup_not_active/);
  assert.deepEqual(f.state(), pending);assert.deepEqual(after.spec, before.spec);
}));

test("rejected advisory proposals cannot partially retain unfinished state, and strict histories do not gain it", () => fixture(true, f => {
  const events = getGoal(f.goal.id)!.assignment_kernel_v2!.events;
  const journal = new AssignmentJournalV2(events), before = journal.snapshot();
  const event = { schema: "revit-operator.assignment-event/v2", event_id: "rejected-followups", assignment_id: f.binding.assignment_id,
    assignment_version: before.assignment_version + 1, binding: before.current_binding, actor: "operator-work-plan", occurred_at: new Date().toISOString(),
    event_type: "review_requested", review_id: "bad-review", work_unit_ids: ["unknown"], reason: "Invalid review", completion_proposal: proposal } as AssignmentEventV2;
  assert.throws(() => journal.append(event), { code: "review_work_unit_unknown" });assert.deepEqual(journal.snapshot(), before);
  assert.throws(() => journal.append({ ...event, binding: { ...before.current_binding, document_fingerprint: "other-document" } }));
  assert.deepEqual(journal.snapshot(), before);
  const strictEvents = structuredClone(events).map(e => e.event_type === "assignment_created" ? { ...e, spec: { ...e.spec, execution_policy: undefined } } : e);
  const strict = new AssignmentJournalV2(strictEvents);
  assert.equal(strict.snapshot().advisory_followups, undefined);
  assert.throws(() => strict.append({ ...event, work_unit_ids: [] } as AssignmentEventV2), { code: "advisory_proposal_not_enabled" });
  assert.equal(strict.snapshot().advisory_followups, undefined);
}));
