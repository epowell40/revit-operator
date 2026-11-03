import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { executeExternalProviderCallV2 } from "../src/assignments/external_provider_lifecycle.js";
import { createOpenAiModelCallReceipt } from "../src/model_call_telemetry.js";
import { recordSidecarExecutionFailureV2 } from "../src/assignments/sidecar_execution_failure.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2,
  failAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";

test("Sidecar execution stop is exact-bound, idempotent and cannot erase uncertain native effects", () => {
  const prior=process.env.OPERATOR_WORKSPACE_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sidecar-failure-"));
  process.env.OPERATOR_WORKSPACE_ROOT=root; __testOnlyResetGoalListCache();
  try {
    for(const unknown of [false,true]) {
      const goal=createGoal({title:"Stop desktop work",objective:"Update and verify a model property",
        acceptance_criteria:["Requested property independently verified"],related_session_id:"session-stop",status:"active",created_by:"principal-test",
        work_budget:{mode:"sidecar_computer",source:"operator_desktop",requested_effect:"apply",document_fingerprint:"fixture"}});
      createAssignmentKernelForGoalV2({goal,run_id:`sidecar:stop-${unknown}`});
      const initial=getAssignmentKernelSnapshotV2(goal.id)!;
      const body={assignment_id:goal.id,assignment_run_id:initial.current_binding.run_id,
        assignment_generation:initial.current_binding.generation,failure_id:"stop-1",failure_kind:"canceled"};
      for(const wrong of [{assignment_generation:999},{assignment_run_id:"other"},{failure_kind:"complete"}]) {
        assert.throws(()=>recordSidecarExecutionFailureV2("session-stop",{...body,...wrong}));
      }
      assert.throws(()=>recordSidecarExecutionFailureV2("other-session",body));
      assert.equal(getAssignmentKernelSnapshotV2(goal.id)!.execution_failure_ids.length,0);
      let operationId:string|undefined;
      if(unknown) {
        const lease=openAssignmentKernelOperationV2({snapshot:initial,controller_request_id:"write",provider_turn_id:"turn",
          capability_id:"element.update",classified_effect:"apply",arguments:{target_id:"element",value:"changed"}});
        operationId=lease.operation_id;
        markAssignmentKernelOperationDispatchStartedV2(lease);
        failAssignmentKernelOperationV2(lease,new Error("native response lost"),"dispatching");
      }
      const result=recordSidecarExecutionFailureV2("session-stop",body);
      assert.equal(result.snapshot.execution_failure_ids.length,1);
      assert.equal(result.snapshot.terminal,!unknown);
      if(unknown) assert.deepEqual(result.snapshot.unresolved_unknown_operation_ids,[operationId]);
      else assert.notEqual(result.snapshot.outcome,"complete");
      const replay=recordSidecarExecutionFailureV2("session-stop",body);
      assert.equal(replay.snapshot.execution_failure_ids.length,1);
      assert.equal(replay.snapshot.terminal,!unknown);
      assert.throws(()=>recordSidecarExecutionFailureV2("session-stop",{...body,failure_kind:"runtime"}),/identity_conflict/);
    }
  } finally {
    __testOnlyResetGoalListCache();
    if(prior===undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("294 admission denial survives the bound Sidecar runtime catch and duplicate delivery", async () => {
  const prior=process.env.OPERATOR_WORKSPACE_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"sidecar-admission-stop-"));
  process.env.OPERATOR_WORKSPACE_ROOT=root; __testOnlyResetGoalListCache();
  try {
    for(const nativeState of ["none","inflight","unknown"] as const) {
      const goal=createGoal({title:"Retain connected move refusal",objective:"Move equipment and verify preserved connections",
        acceptance_criteria:["Requested placement and connections independently verified"],related_session_id:"session-admission",status:"active",created_by:"principal-test",
        work_budget:{mode:"sidecar_computer",source:"operator_desktop",requested_effect:"apply",document_fingerprint:"fixture"}});
      const binding=createAssignmentKernelForGoalV2({goal,run_id:`sidecar:admission-${nativeState}`});
      const snapshot=()=>getAssignmentKernelSnapshotV2(goal.id)!;
      const receipt=createOpenAiModelCallReceipt({route:"desktop_computer",requested_model:"gpt-6.1-sol",reasoning_effort:"medium",
        started_at_utc:new Date().toISOString(),duration_ms:1,response:{id:`budget-${nativeState}`,status:"completed",model:"gpt-6.1-sol",
          usage:{input_tokens:4_000_000,output_tokens:1,total_tokens:4_000_001}}});
      const options={binding,model:"gpt-6.1-sol",reasoning_effort:"medium",receipt:()=>receipt,errorReceipt:()=>null,invoke:async()=>"retained report"};
      await executeExternalProviderCallV2(options);
      if(nativeState!=="none") {
        const lease=openAssignmentKernelOperationV2({snapshot:snapshot(),controller_request_id:"native",provider_turn_id:"turn",
          capability_id:"element.update",classified_effect:"apply",arguments:{target_id:"equipment",value:"changed"}});
        markAssignmentKernelOperationDispatchStartedV2(lease);
        if(nativeState==="unknown") failAssignmentKernelOperationV2(lease,new Error("native response lost"),"dispatching");
      }
      const before=snapshot();
      let dispatched=false;
      await assert.rejects(executeExternalProviderCallV2({...options,invoke:async()=>{dispatched=true;return "must not dispatch";}}),/external_provider_admission_denied/);
      assert.equal(dispatched,false);
      if(nativeState!=="none") {
        assert.equal(snapshot().assignment_version,before.assignment_version,"budget stop cannot outrank native in-flight or unknown reconciliation");
        assert.equal(snapshot().terminal,false);
        continue;
      }
      assert.equal(snapshot().terminal_reason,"token_budget_exhausted");
      const body={assignment_id:goal.id,assignment_run_id:binding.run_id,assignment_generation:binding.generation,
        failure_id:`sidecar-execution:${binding.run_id}`,failure_kind:"runtime"};
      const version=snapshot().assignment_version;
      for(const wrong of [{assignment_generation:999},{assignment_run_id:"other"}])
        assert.throws(()=>recordSidecarExecutionFailureV2(binding.session_id,{...body,...wrong}),/binding_mismatch/);
      for(let repeat=0;repeat<2;repeat++) {
        const result=recordSidecarExecutionFailureV2(binding.session_id,body);
        assert.equal(result.disposition,"terminal_preserved");
        assert.equal(result.snapshot.outcome,"blocked");
        assert.equal(result.snapshot.terminal_reason,"token_budget_exhausted");
        assert.equal(result.snapshot.assignment_version,version);
        assert.equal(result.snapshot.execution_failure_ids.length,0);
      }
      assert.equal(snapshot().spec.execution_policy,undefined,"strict task was not switched to advisory");
    }
    const ordinary=createGoal({title:"Provider transport error",objective:"Read the current native context",
      acceptance_criteria:["Return verified context"],related_session_id:"session-forged-stop",status:"active",created_by:"principal-test",
      work_budget:{mode:"sidecar_computer",source:"operator_desktop",requested_effect:"read"}});
    const ordinaryBinding=createAssignmentKernelForGoalV2({goal:ordinary,run_id:"sidecar:forged-budget-text"});
    await assert.rejects(executeExternalProviderCallV2({binding:ordinaryBinding,model:"gpt-6.1-sol",reasoning_effort:"medium",
      invoke:async()=>{throw Error("external_provider_admission_denied:blocked:token_budget_exhausted");},
      receipt:()=>{throw Error("no receipt");},errorReceipt:()=>null}),/admission_denied/);
    const ordinaryFailure=recordSidecarExecutionFailureV2(ordinaryBinding.session_id,{assignment_id:ordinary.id,
      assignment_run_id:ordinaryBinding.run_id,assignment_generation:ordinaryBinding.generation,
      failure_id:"genuine-provider-failure",failure_kind:"runtime"});
    assert.equal(ordinaryFailure.snapshot.outcome,"failed");
    assert.equal(ordinaryFailure.snapshot.terminal_reason,"assignment_runtime_failed","forged upstream text cannot establish a budget stop");
    assert.equal(ordinaryFailure.snapshot.provider_call_ids.length,1,"real failed provider dispatch remains accounted for");
    assert.equal(Object.values(ordinaryFailure.snapshot.provider_calls)[0]!.usage,undefined,"missing usage stays unknown");
  } finally {
    __testOnlyResetGoalListCache();
    if(prior===undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
