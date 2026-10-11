import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeExternalProviderCallV2 } from "../src/assignments/external_provider_lifecycle.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { controlAssignmentExecutionV2 } from "../src/assignments/assignment_kernel_v2_controls.js";
import { createOpenAiModelCallReceipt } from "../src/model_call_telemetry.js";
import { settleAssignmentKernelExecutionFailureV2 } from "../src/assignments/assignment_kernel_v2_execution_failure.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2, failAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";

test("late external receipt settles retained transport failure only after every effect drains", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-late-receipt-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root; __testOnlyResetGoalListCache();
  try {
    for (const upstreamFails of [false,true]) for (const nativeState of ["none", "inflight", "unknown"] as const) {
      const goal = createGoal({ title:"Preview property", objective:"Preview one property and read back after rollback",
        acceptance_criteria:["Native rollback and unchanged value verified"], status:"active", related_session_id:"late-receipt", created_by:"test-principal",
        work_budget:{requested_effect:nativeState === "none" ? "preview" : "apply"} });
      const binding = createAssignmentKernelForGoalV2({goal,run_id:`late-${nativeState}-${upstreamFails}`});
      const snapshot = () => getAssignmentKernelSnapshotV2(goal.id)!;
      let release!: () => void;
      const wait = new Promise<void>(resolve => {release=resolve;});
      const receipt = createOpenAiModelCallReceipt({route:"desktop_computer",requested_model:"gpt-6.1-sol",reasoning_effort:"medium",
        started_at_utc:new Date().toISOString(),duration_ms:323699,response:{id:`late-${nativeState}`,status:"completed",model:"gpt-6.1-sol",usage:{input_tokens:11953,output_tokens:170,total_tokens:12123}}});
      const upstreamError=new Error("late upstream failure");
      const pending = executeExternalProviderCallV2({binding,model:"gpt-6.1-sol",reasoning_effort:"medium",invoke:async()=>{await wait;if(upstreamFails)throw upstreamError;return "late result";},receipt:()=>receipt,errorReceipt:()=>null});
      assert.equal(snapshot().in_flight_provider_call_ids.length,1);
      if (nativeState !== "none") {
        const lease=openAssignmentKernelOperationV2({snapshot:snapshot(),controller_request_id:"native",provider_turn_id:"turn",
          capability_id:"element.update",classified_effect:"apply",arguments:{target_id:"sheet",value:"changed"}});
        markAssignmentKernelOperationDispatchStartedV2(lease);
        if(nativeState === "unknown") failAssignmentKernelOperationV2(lease,new Error("native response lost"),"dispatching");
      }
      const failed=settleAssignmentKernelExecutionFailureV2({binding,failure_id:"transport-lost",error_class:"runtime",phase:"provider_turn"});
      assert.equal(failed.snapshot.terminal,false,"never settle before upstream drain");
      release();
      if(upstreamFails) await assert.rejects(pending,error=>error === upstreamError);
      else assert.equal(await pending,"late result");
      assert.equal(snapshot().terminal,nativeState === "none");
      assert.equal(snapshot().in_flight_provider_call_ids.length,0);
      const call=Object.values(snapshot().provider_calls)[0]!;
      if(upstreamFails) assert.equal(call.usage,undefined,"missing usage never replaced with zero");
      else assert.equal(call.usage!.total_tokens,12123,"late usage retained before settlement");
      if(nativeState === "none") assert.equal(snapshot().outcome,"failed","provider success cannot erase task transport failure");
      else if(nativeState === "inflight") assert.equal(snapshot().in_flight_operation_ids.length,1);
      else assert.equal(snapshot().unresolved_unknown_operation_ids.length,1,"unknown effect retained even after transport quiescence");
    }
  } finally {
    if(previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT=previous;
    __testOnlyResetGoalListCache(); fs.rmSync(root,{recursive:true,force:true});
  }
});

test("external provider admission, drain, usage, and pause use the canonical assignment", async () => {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "external-provider-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    const goal = createGoal({ title: "Verify PDF", objective: "Inspect the existing PDF.",
      acceptance_criteria: ["Return the requested result."], status: "active", related_session_id: "test-external", created_by: "test-principal",
      work_budget: { requested_effect: "read" } });
    const binding = createAssignmentKernelForGoalV2({ goal, run_id: "external-test" });
    const snapshot = () => getAssignmentKernelSnapshotV2(goal.id)!;
    const receipt = createOpenAiModelCallReceipt({ route: "desktop_computer", requested_model: "gpt-6.1-sol",
      reasoning_effort: "medium", started_at_utc: new Date().toISOString(), duration_ms: 7,
      response: { id: "upstream-receipt", status: "completed", model: "gpt-6.1-sol",
        usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17, input_tokens_details: { cached_tokens: 8 } } } });
    let invokes = 0;
    const options = { binding, model: "gpt-6.1-sol", reasoning_effort: "medium", receipt: () => receipt,
      errorReceipt: () => null, invoke: async () => {
        invokes++;
        assert.equal(snapshot().in_flight_provider_call_ids.length, 1);
        assert.equal(snapshot().quiescent, false);
        await assert.rejects(executeExternalProviderCallV2({ ...options, invoke: async () => { throw Error('must not invoke'); } }), /admission_denied/);
        return "response";
      } };
    assert.equal(await executeExternalProviderCallV2(options), "response");
    assert.equal(invokes, 1);
    assert.equal(snapshot().quiescent, true);
    assert.equal(snapshot().outcome, "active", "usage is not task verification");
    assert.equal(Object.values(snapshot().provider_calls)[0]!.usage!.total_tokens, 17);
    assert.equal(Object.values(snapshot().provider_calls)[0]!.usage!.cached_input_tokens, 8);
    controlAssignmentExecutionV2({ binding, command_id: "pause", expected_command_id: null, action: "pause" });
    await assert.rejects(executeExternalProviderCallV2(options), /admission_denied/);
    assert.equal(invokes, 1);
    controlAssignmentExecutionV2({ binding, command_id: "resume", expected_command_id: "pause", action: "resume" });
    const failure = Error("upstream failed without usage");
    await assert.rejects(executeExternalProviderCallV2({ ...options, invoke: async () => { throw failure; } }), error => error === failure);
    assert.equal(snapshot().quiescent, true);
    assert.equal(Object.values(snapshot().provider_calls).filter(call => call.success === false).length, 1);
    assert.equal(Object.values(snapshot().provider_calls).find(call => call.success === false)!.usage, undefined,
      "missing usage must never become zero usage");
    await assert.rejects(executeExternalProviderCallV2({ ...options, binding: { ...binding, generation: 9 } }), /binding_stale/);
    const exhaustedReceipt = createOpenAiModelCallReceipt({ route: "desktop_computer", requested_model: "gpt-6.1-sol",
      reasoning_effort: "medium", started_at_utc: new Date().toISOString(), duration_ms: 8,
      response: { id: "budget-receipt", status: "completed", model: "gpt-6.1-sol",
        usage: { input_tokens: 4_000_000, output_tokens: 1, total_tokens: 4_000_001 } } });
    await executeExternalProviderCallV2({ ...options, invoke: async () => "budget response", receipt: () => exhaustedReceipt });
    await assert.rejects(executeExternalProviderCallV2(options), /admission_denied:blocked/);
    assert.equal(invokes, 1, "exhausted token budget stops the next network call");
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    __testOnlyResetGoalListCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
