import ts from "typescript";
import { runInNewContext } from "node:vm";
import * as thinReference from "../src/brains/thin_reference_execution.js";
import {codexAssignmentTurnTimeLimits,createCodexAssignmentProgressTimeMonitor} from '../src/codex/assignment_timeout.js';
import {createExecutionDeadlineV2} from '../src/brains/execution_deadline_v2.js';
import { finalCodexAssignmentMessageV2 } from "../src/brains/codex_assignment_progress.js";
import { desktopHelperScopeFromContextV1 } from "../src/assignments/desktop_executor_owner.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { handleCodexDynamicToolCall } from "../src/brains/codex_dynamic_tool_handler.js";
import { decideStreaming } from "../src/brain.js";
import { prepareAssignmentTurn, bindPreparedAssignmentToRequest } from "../src/assignments/turn_preparation.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA } from "../src/assignments/assignment_kernel_v2_execution.js";
import { __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall, __testOnlyResetTeammateLoopState } from "../src/teammate_loop_runtime.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { deriveProgressGapsV2, decideAssignmentProgressV2 } from "../src/domain/assignment-kernel/index.js";
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from "../src/assignments/assignment_kernel_v2_progress.js";
import { defaultAssignmentWorkBudgetV2 } from "../src/assignments/assignment_work_allowance_v2.js";

async function workspace(fn: () => Promise<unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-thin-dynamic-"));
  const keys = ["OPERATOR_WORKSPACE_ROOT", "OPERATOR_ASSIGNMENT_KERNEL_V2", "REVIT_OPERATOR_MODE", "OPERATOR_THIN_REFERENCE_SESSION_IDS", "OPERATOR_BRAIN"], old = keys.map(k => process.env[k]);
  process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_ASSIGNMENT_KERNEL_V2 = "1"; process.env.REVIT_OPERATOR_MODE = "local"; process.env.OPERATOR_THIN_REFERENCE_SESSION_IDS = "thin-native"; process.env.OPERATOR_BRAIN = "codex";
  __testOnlyResetGoalListCache(); __testOnlyResetTeammateLoopState();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth("shared_token", "test-only") }, fn); }
  finally { __testOnlyResetGoalListCache(); __testOnlyResetTeammateLoopState(); __closeForTests(); keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; }); fs.rmSync(root, { recursive: true, force: true }); }
}
function start(prompt = "Reconstruct the missing exhaust duct, connect it to the remaining compatible ductwork, and verify the result.") {
  const prepared = prepareAssignmentTurn({ sessionId: "thin-native", messageId: "original", userText: prompt, toolResults: [], source: "chat", createdBy: null,
    requestContext: { revit: { document: { projectIdentity: { fingerprint: "thin-document" } } } } })!;
  return { binding: prepared.bindingV2!, req: bindPreparedAssignmentToRequest({ version: "operator.backend.v1", session_id: "thin-native", message_id: "original", user_text: prompt } as any, prepared) };
}

test("canonical-only dynamic dispatch retains native transaction and independent parameter/connector verification", () => workspace(async () => {
  const { binding, req } = start();
  const f = JSON.parse(fs.readFileSync("test/fixtures/c37-connected-duct-readback.json", "utf8"));
  let dispatches = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {}, callTool: async (_tool: string, args: any, context: any) => {
    context.onMcpAccepted(); dispatches++;
    const lease = context.assignmentKernelV2, apply = args.path === f.input.path;
    const payload = apply ? { status: "Success", createdElementIds: [1542945], transaction: { status: "committed", committed: true } } : args.path === "/revit/get-parameters" ? f.parameters : f.connectors;
    const receipt = "receipt:" + lease.operation_id;
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: { schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: { schema: "revit-operator.operation-result/v2", result_id: "result:" + lease.operation_id, operation_id: lease.operation_id, binding,
        status: "succeeded", dispatch_state: "dispatched", persistent_effect: apply ? "applied" : "none", native_transaction_state: apply ? "committed" : "not_applicable",
        authority: "native-host", result_schema_id: `operator-native/POST:${args.path}/v2`, observation_required: true, receipt_id: receipt, native_correlation_id: receipt,
        raw_payload_hash: payloadDigestV2(payload).digest, request_identity: lease.request_identity, affected_target_identities: apply ? f.affected : [], completed_at: new Date().toISOString() },
      observation: { raw_payload: payload, semantic_facts: [{ fact_id: apply ? "task.result_available" : "verification.result_available", fact_class: apply ? "domain" : "verification", value: true }], verification_relevance: ["task_result"], evidence_class: "task_result" } } };
  } };
  const legacy = beginTeammateLoopOwner(runtime, req);
  assert.equal(guardTeammateMcpCall(runtime, { tool: "revit_call_tool", arguments: f.input }, getAssignmentKernelSnapshotV2(binding.assignment_id)).allowed, false, "legacy live-context/preview supervision would block this diagnostic fixture");
  endTeammateLoopOwner(legacy);
  const owner = beginTeammateLoopOwner(runtime, req, { canonicalSupervisionOnly: true });
  try {
    assert.equal(guardTeammateMcpCall(runtime, { tool: "revit_call_tool", arguments: f.input }).allowed, false, "no canonical snapshot must fail closed");
    const run = (id: string, args: unknown) => handleCodexDynamicToolCall(runtime as any, { id, method: "item/tool/call", params: { namespace: "revit_operator", turnId: "native-turn", tool: "revit_call_tool", arguments: args } } as any) as Promise<any>;
    assert.equal((await run("apply", f.input)).success, true);
    let snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal(Object.values(snapshot.operations).filter(op => op.persistent_effect === "applied").length, 1);
    assert.equal(snapshot.terminal, false);
    assert(deriveProgressGapsV2(snapshot).some(gap => gap.kind === "verification_required"));
    assert.equal((await run("parameters", { method: "POST", path: "/revit/get-parameters", body: { elementIds: [1542945], includeEmpty: true } })).success, true);
    assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.terminal, false, "parameter read alone cannot claim physical connectivity");
    assert.equal((await run("connectors", { method: "POST", path: "/revit/get-connectors", body: { elementIds: [1542945], includeAllRefs: true } })).success, true);
    snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    assert.equal(snapshot.outcome, "complete"); assert.equal(dispatches, 3);
    assert.deepEqual(snapshot.unresolved_unknown_operation_ids, []);
    assert.equal(owner.state.verified, false, "legacy bookkeeping is not a second verification owner");
  } finally { endTeammateLoopOwner(owner); }
}));

test("thin dynamic lane cannot bypass a V2 pause or read-only assignment", () => workspace(async () => {
  const { binding, req } = start("Count all the air devices in the model.");
  let dispatches = 0;
  const runtime = { assignmentKernelV2Binding: () => binding, queueAssignmentKernelV2TurnStop: () => {}, callTool: async () => { dispatches++; throw new Error("must not dispatch"); } };
  const owner = beginTeammateLoopOwner(runtime, req, { canonicalSupervisionOnly: true });
  try {
    const request = { id: "forbidden-write", method: "item/tool/call", params: { namespace: "revit_operator", turnId: "turn", tool: "revit_call_tool", arguments: { method: "POST", path: "/revit/replace-text-note", body: { elementId: 1, newText: "Unexpected", dryRun: false } } } } as any;
    assert.equal((await handleCodexDynamicToolCall(runtime as any, request) as any).success, false); assert.equal(dispatches, 0);
    controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
    request.params.arguments = { method: "GET", path: "/revit/context" };
    const paused: any = await handleCodexDynamicToolCall(runtime as any, request);
    assert.equal(paused.success, false); assert.match(JSON.stringify(paused), /paused/i); assert.equal(dispatches, 0);
  } finally { endTeammateLoopOwner(owner); }
}));

test("ordinary backend composition does not reintroduce legacy proof guards after a host-selected thin run", () => workspace(async () => {
  const { binding, req } = start();
  const telemetry = { schema: "revit-operator.local-execution-experiment/v1" as const, lane: "thin-reference" as const, turns: 2, stop_reason: "experiment_turn_limit", duration_ms: 100, provider_turns: [] };
  const response = await decideStreaming(req, {}, { codexStreamingBrain: async () => ({ version: "operator.backend.v1", assistant_message: "The experiment remains incomplete.", actions: [], local_execution_experiment: telemetry, assignment_snapshot_v2: getAssignmentKernelSnapshotV2(binding.assignment_id)! }) });
  assert.equal(response.assistant_message, "The experiment remains incomplete.");
  assert.deepEqual(response.local_execution_experiment, telemetry); assert.equal(response.teammate_loop_receipt, undefined);
  assert.equal(getAssignmentKernelSnapshotV2(binding.assignment_id)!.terminal, false);
}));


function actualThinCaller(dependencies: Record<string, unknown>): (request: any, callbacks: any) => Promise<any> {
  const source = fs.readFileSync(path.join(process.cwd(), "src/brains/codex_brain.ts"), "utf8");
  const parsed = ts.createSourceFile("codex_brain.ts", source, ts.ScriptTarget.ES2022, true);
  const fn = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "decideCodexStreaming");
  assert(fn);
  const emitted = ts.transpileModule(fn.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(emitted, { exports, AbortController, setTimeout, clearTimeout, Date, process,
    codexAssignmentTurnTimeLimits,createCodexAssignmentProgressTimeMonitor,createExecutionDeadlineV2,desktopHelperScopeFromContextV1,...thinReference,...dependencies });
  return exports.decideCodexStreaming;
}

for (const freshState of ["active", "paused", "unknown", "input", "budget", "terminal"] as const) {
  test(`actual thin caller exposes the stop note without overriding newer canonical ${freshState}`, () => workspace(async () => {
    const priorAdvisory = process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS;
    process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = "thin-native";
    let prepared: ReturnType<typeof start>;
    try { prepared = start(); } finally {
      if (priorAdvisory === undefined) delete process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS;
      else process.env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS = priorAdvisory;
    }
    const { binding, req } = prepared;
    const original = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
    const prior = structuredClone(original);
    for (let i = 0; i < 4; i++) (prior.operations as any)[`old-${i}`] = {
      operation_id: `old-${i}`, binding, requested_effect: "apply", persistent_effect: "applied", settlement_state: "settled",
      opened_at: new Date(Date.now() - 20).toISOString(), settled_at: new Date().toISOString(),
      advances_criterion_ids: [], verification_operation_ids: [], observation_ids: [], work_unit_id: "work-primary",
      result: { binding, status: "succeeded", authority: "native-host", native_transaction_state: "committed" }
    };
    assert.match(finalCodexAssignmentMessageV2(prior, ""), /Applied 4 model edits/);
    const fresh = structuredClone(prior);
    const fixtureDecision = decideAssignmentProgressV2({ snapshot: fresh, budget: defaultAssignmentWorkBudgetV2(fresh, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2), now: new Date().toISOString() });
    assert.equal(fixtureDecision.decision, "admit_reasoning_turn", JSON.stringify(fixtureDecision));
    if (freshState === "paused") fresh.execution_control = { state: "paused", command_id: "new-pause", changed_at: new Date().toISOString() };
    if (freshState === "unknown") fresh.unresolved_unknown_operation_ids = ["unknown-operation"];
    if (freshState === "input") { fresh.outcome = "awaiting_user_input"; fresh.pending_input_variable_ids = ["room"]; fresh.clarifications = { room: { clarification_id: "question", variable_id: "room", question: "Which room?", requested_at: new Date().toISOString() } }; }
    if (freshState === "budget") {
      (fresh.operations["old-0"] as any).opened_at = new Date(Date.now() - defaultAssignmentWorkBudgetV2(fresh, DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2).max_wall_clock_ms - 1000).toISOString();
      (fresh.spec as any).created_at = fresh.operations["old-0"].opened_at;
      fresh.provider_budget_exhausted = true;
    }
    if (freshState === "terminal") { fresh.terminal = true; fresh.outcome = "failed"; fresh.terminal_reason = "Preserved terminal outcome"; }
    const deltas: string[] = [], done: string[] = [], events: any[] = [];
    const oldUsage = { schema: "revit-operator.provider-turn-usage/v1", session_id: req.session_id, message_id: req.message_id, thread_id: "thread", turn_id: "turn", disposition: "completed", raw_response_ids: ["response"] };
    const run = actualThinCaller({ localThinReferenceLimits: () => ({ max_turns: 8, max_wall_ms: 60000 }), assignmentKernelV2ForBinding: () => ({ binding,snapshot:original }),
      codexTurnAbortKey: () => "caller", thinReferenceAborts: new Map(), conversationWorkProfile: () => ({}),
      runThinReferenceTurns: async () => ({ response: { version: "operator.backend.v1", assistant_message: "Older summary", actions: [], assignment_snapshot_v2: prior, model_call_receipts: [{ call_id: "response" }], provider_turn_usage: oldUsage },
        turns: 4, stop_reason: "completed_turns_without_retained_work", duration_ms: 100, provider_turns: [oldUsage] }),
      currentCodexAssignmentSnapshotV2: () => fresh, finalCodexAssignmentMessageV2, deriveTerminalResultV2: () => ({ preserved: true }),
      appendEvent: (_session: string, _role: string, kind: string, payload: unknown) => events.push({ kind, payload }) });
    const response = await run(req, { onDelta: (text: string) => deltas.push(text), onDone: (text: string) => done.push(text) });
    assert.equal(deltas.length, 1); assert.equal(done.length, 1); assert.equal(response.assistant_message, deltas[0]); assert.equal(done[0], deltas[0]);
    assert.deepEqual(response.assignment_snapshot_v2, fresh); assert.deepEqual(response.model_call_receipts, [{ call_id: "response" }]);
    assert.equal(response.local_execution_experiment.stop_reason, "completed_turns_without_retained_work");
    assert.equal(events[0].kind, "codex.thin-reference.settled"); assert.deepEqual(events[0].payload.provider_turns, [oldUsage]);
    if (freshState === "active") { assert.match(response.assistant_message, /Applied 4 model edits/); assert.match(response.assistant_message, /Automatic continuation stopped.*no new task work/); }
    else assert.equal(response.assistant_message, finalCodexAssignmentMessageV2(fresh, "Older summary"), "canonical message takes precedence over no-work note");
    assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id), original, "presentation neither pauses nor completes the task");
  }));
}

test('actual thin caller timer and runner receive the same native-earned deadline beyond original20minutes',t=>workspace(async()=>{
  const epoch=Date.UTC(2026,9,15),minute=60_000;t.mock.timers.enable({apis:['setTimeout','Date'],now:epoch});
  const {binding,req}=start(),original=getAssignmentKernelSnapshotV2(binding.assignment_id)!;
  const initial=structuredClone(original)as any;initial.spec.execution_policy={mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:binding.session_id,document_fingerprint:binding.document_fingerprint,max_turns:8,max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:20*minute,
    progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:120*minute}};
  const fresh=structuredClone(initial),key='outer-earned',aborts=new Map(),priorTimeout=process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS;delete process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS;
  try{
    const run=actualThinCaller({localThinReferenceLimits:()=>({max_turns:8,max_wall_ms:20*minute}),assignmentKernelV2ForBinding:()=>({binding,snapshot:initial}),codexTurnAbortKey:()=>key,thinReferenceAborts:aborts,conversationWorkProfile:()=>({}),currentCodexAssignmentSnapshotV2:()=>fresh,
      runThinReferenceTurns:async(input:any)=>{
        assert.equal(typeof input.remainingWallMs,'function');t.mock.timers.tick(19*minute);const at=Date.now(),iso=(n:number)=>new Date(n).toISOString();
        fresh.operations.edit={operation_id:'edit',binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',opened_at:iso(at-50),settled_at:iso(at-30),request_identity:{request_signature:'distinct'},input:{body:{changes:[{elementId:1,parameterName:'Comments',value:'Checked'}]}},verification_operation_ids:['read'],result:{binding,authority:'native-host',status:'succeeded',native_transaction_state:'committed',affected_target_identities:['element_id:1']}};
        fresh.operations.read={operation_id:'read',binding,target:{target_id:'id:1'},requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',opened_at:iso(at-30),settled_at:iso(at-10),verification_of_operation_id:'edit',observation_ids:['proof'],result:{binding,authority:'native-host',status:'succeeded'}};
        fresh.observations.proof={operation_id:'read',binding,authority:'native-host',facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},{fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:['element_id:1']}]};
        t.mock.timers.tick(2*minute);assert.equal(input.signal.aborted,false,'Actual caller must rearm instead of aborting at original20minutes');assert.equal(input.remainingWallMs(),4*minute);
        return{response:{version:'operator.backend.v1',assistant_message:'Partial saved.',actions:[],assignment_snapshot_v2:fresh},turns:1,stop_reason:'experiment_turn_limit',duration_ms:21*minute,provider_turns:[]};
      },finalCodexAssignmentMessageV2:()=> 'Partial saved.',appendEvent:()=>{}});
    const response=await run(req,{});assert.equal(response.local_execution_experiment.duration_ms,21*minute);assert.equal(aborts.size,0,'Caller cleanup removes its abort owner and timer');assert.deepEqual(getAssignmentKernelSnapshotV2(binding.assignment_id),original,'No historical journal or budget rewrite');
  }finally{if(priorTimeout===undefined)delete process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS;else process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS=priorTimeout;}
}));
