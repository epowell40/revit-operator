import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
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
