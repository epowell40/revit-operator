import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeConversation } from "../src/conversation_intake.js";
import { normalizeExternalAssignmentRequest, startExternalAssignmentRun } from "../src/assignments/external_assignment_start.js";
import { createGoal, __testOnlyResetGoalListCache } from "../src/goals/service.js";
import { getAssignmentKernelSnapshotV2 } from "../src/assignments/assignment_kernel_v2_store.js";
import { manageAssignmentWorkPlan } from "../src/assignments/assignment_work_plan.js";
import { openAssignmentKernelOperationV2 } from "../src/assignments/assignment_kernel_v2_execution.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { runWithRequestContext } from "../src/request_context.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

test("external computer tasks use exact semantic scope, retain protections and permit the declared edit checklist", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"external-semantic-"));
  const prior=[process.env.OPERATOR_WORKSPACE_ROOT,process.env.OPERATOR_ASSIGNMENT_KERNEL_V2];
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_ASSIGNMENT_KERNEL_V2="1";
  __closeForTests();__testOnlyResetGoalListCache();
  try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth("shared_token","fixture")},async()=>{
    // Retained failure family: scoped protection and no printing were mistaken
    // for a global read-only limit, rejecting the agent's work-plan declaration.
    for(const [n,source,effect,modelEffect,protectedClauses] of [
      [0,"Add the indicated receptacle and circuit it to the adjacent circuit. Inspect before editing. Do not change linked-model geometry, unrelated sheets, or prior work. Do not print, deploy, or publish anything.","apply","apply",["Do not change linked-model geometry, unrelated sheets, or prior work.","Do not print, deploy, or publish anything."]],
      [1,"Inspect the receptacle. Do not change the model.","read","read",["Do not change the model."]],
      [2,"Preview moving the indicated device. Do not commit the change.","preview","preview",["Do not commit the change."]],
      [3,"Export this inventory. Do not change the Revit model.","apply","read",["Do not change the Revit model."]]
    ] as const){
      const sid=`session-${n}`,mid=`message-${n}`;
      const operation_scope={schema:"revit-operator.interpreted-operation-scope/v1",requested_effect:effect,model_effect:modelEffect,protected_clauses:protectedClauses,prerequisites:[]};
      assert.equal((await routeConversation({version:"operator.backend.v1",session_id:sid,message_id:mid,user_text:source,intake_attachment_count:1},
        {interpret:async()=>({value:{route:"task",answer:null,basis:"needs_tools",requested_effect:effect==="read"?"read":"change",
          entire_request_answered:false,confidence:.99,reason:"Whole request scope",question_kind:"action",identity_fields:[],read_evidence:effect==="read"?"other":"not_applicable",operation_scope}})})).routing_status,"accepted");
      const request={session_id:sid,objective:source,start_assignment_run:true,work_budget:{mode:"sidecar_computer",source:"operator_desktop",
        source_user_request:source,conversation_message_id:mid,requested_effect:effect==="apply"?"read":"apply",document_fingerprint:"fixture"}};
      const normalized:any=normalizeExternalAssignmentRequest(request);
      assert.equal(normalized.work_budget.requested_effect,effect,"caller effect hints cannot override retained intake");
      const goal=createGoal({title:"Work",objective:source,acceptance_criteria:["Requested outcome"],related_session_id:sid,status:"active",created_by:"test",work_budget:normalized.work_budget});
      const run=startExternalAssignmentRun({goal,sessionId:sid,actor:"test",requestedRunId:`sidecar:${n}`});
      const snapshot=getAssignmentKernelSnapshotV2(run.assignmentId)!;
      assert.deepEqual(snapshot.spec.interpreted_scope?.scope,operation_scope);
      assert.equal(snapshot.spec.requested_effect,effect);
      if(n===0){
        manageAssignmentWorkPlan({binding:snapshot.current_binding,action:"declare",declaration:{items:[
          {item_id:"add_device",description:"Add indicated device",source_basis:"Marked drawing"},
          {item_id:"circuit",description:"Connect adjacent circuit",source_basis:"Marked drawing",depends_on:["add_device"]}],assumptions:[]}});
        assert.equal(getAssignmentKernelSnapshotV2(run.assignmentId)!.work_plan!.items.length,2);
      }
      if(modelEffect==="read")assert.throws(()=>openAssignmentKernelOperationV2({snapshot,controller_request_id:"edit",provider_turn_id:"turn",capability_id:"element.update",classified_effect:"apply",arguments:{elementId:42}}),/effect|work_unit|model_write/);
      for(const delta of [{session_id:"other"},{objective:source+" Changed"},{work_budget:{...request.work_budget,conversation_message_id:"missing"}}])
        assert.throws(()=>normalizeExternalAssignmentRequest({...request,...delta}),/scope_required|source_request_mismatch|classification|question/);
    }
  }); } finally {
    __closeForTests();__testOnlyResetGoalListCache();
    for(const [key,value] of [["OPERATOR_WORKSPACE_ROOT",prior[0]],["OPERATOR_ASSIGNMENT_KERNEL_V2",prior[1]]])
      if(value===undefined)delete process.env[key!];else process.env[key!]=value;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
