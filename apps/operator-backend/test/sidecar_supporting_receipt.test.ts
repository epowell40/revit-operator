import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGoal, __testOnlyResetGoalListCache, getActiveGoalForSession } from "../src/goals/service.js";
import { createAssignmentKernelForGoalV2 } from "../src/assignments/assignment_kernel_v2_factory.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { recordSidecarSupportingReceiptV2 } from "../src/assignments/sidecar_supporting_receipt.js";
import { recordSidecarExecutionFailureV2 } from "../src/assignments/sidecar_execution_failure.js";
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2,
  failAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";

test("late V2 computer receipts persist without a legacy active goal and cannot verify, reopen or clear uncertain work", () => {
 const prior=process.env.OPERATOR_WORKSPACE_ROOT;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"sidecar-receipt-"));
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try {for(const unknown of [false,true]){
  const sid=`receipt-${unknown}`;
  const goal=createGoal({title:"Read and edit",objective:"Apply and verify a model edit",acceptance_criteria:["Verified edit"],related_session_id:sid,status:"active",created_by:"test",
    work_budget:{mode:"sidecar_computer",source:"operator_desktop",requested_effect:"apply",document_fingerprint:"fixture"}});
  createAssignmentKernelForGoalV2({goal,run_id:`sidecar:receipt-${unknown}`});
  const initial=getAssignmentKernelSnapshotV2(goal.id)!;
  const binding={assignment_id:goal.id,assignment_run_id:initial.current_binding.run_id,assignment_generation:initial.current_binding.generation};
  if(unknown){const lease=openAssignmentKernelOperationV2({snapshot:initial,controller_request_id:"edit",provider_turn_id:"turn",capability_id:"element.update",classified_effect:"apply",arguments:{value:"changed"}});markAssignmentKernelOperationDispatchStartedV2(lease);failAssignmentKernelOperationV2(lease,new Error("lost native receipt"),"dispatching");}
  recordSidecarExecutionFailureV2(sid,{...binding,failure_id:"stop",failure_kind:"runtime"});
  if(!unknown)assert.equal(getActiveGoalForSession(sid),null);
  const before=getAssignmentKernelSnapshotV2(goal.id)!;
  const body={...binding,receipt:{call_id:"call_1",tool_name:"delegate_revit_task",status:"success",request_effect:"apply",request_dispatched:true,result_ok:true},summary:"Everything verified",work_item:{status:"complete"}};
  const result=recordSidecarSupportingReceiptV2(sid,body);
  assert.equal(result.evidence_ref.trust_level,"untrusted_caller");
  assert.equal(result.evidence_ref.verification_relevance,"supporting");
  assert.equal(result.evidence_ref.assignment_id,goal.id);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),before);
  const replay=recordSidecarSupportingReceiptV2(sid,body);
  assert.equal(replay.evidence_ref.content_hash,result.evidence_ref.content_hash);
  for(const wrong of [{assignment_generation:999},{assignment_run_id:"stale"},{assignment_id:"other"}])assert.throws(()=>recordSidecarSupportingReceiptV2(sid,{...body,...wrong}),/binding_mismatch/);
  assert.throws(()=>recordSidecarSupportingReceiptV2("other-session",body),/binding_mismatch/);
  assert.throws(()=>recordSidecarSupportingReceiptV2(sid,{...body,receipt:{...body.receipt,status:"complete"}}),/request_invalid/);
  assert.throws(()=>recordSidecarSupportingReceiptV2(sid,{...body,receipt:{...body.receipt,payload:"x".repeat(33000)}}),/request_invalid/);
  assert.deepEqual(getAssignmentKernelSnapshotV2(goal.id),before);
 }}finally{__testOnlyResetGoalListCache();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}
});
