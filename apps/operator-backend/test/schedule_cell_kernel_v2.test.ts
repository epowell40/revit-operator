import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {postconditionSatisfiedByPayloadV2 as stagedCompare} from '../src/postcondition_verification_v2.js';
import {verificationCapabilityAdmissionForPathsV2} from '../src/verification/verification_capability_admission_v2.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2,ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA} from '../src/assignments/assignment_kernel_v2_execution.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {advanceAssignmentKernelProgressV2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {canonicalJsonV2,deriveProgressGapsV2,OPERATION_RESULT_V2_SCHEMA} from '../src/domain/assignment-kernel/index.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import { scheduleCellNativeReadbackV2 } from './fixtures/schedule_cell_readback_v2.js';
import { scheduleCellTp105ReadbackV2 } from './fixtures/schedule_cell_tp105_readback_v2.js';
const native: any = scheduleCellNativeReadbackV2;
const applyInput={method:'POST',path:'/revit/update-schedule-cell',body:{scheduleId:1357215,rowKey:'MAIN1',rowField:'Name',targetField:'Current Rating',expectedValue:'1200 A',value:'1600 A',apply:true,dryRun:false}};
const digest=(v:unknown)=>createHash('sha256').update(canonicalJsonV2(v)).digest('hex');
function workspace(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-schedule-kernel-staged-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();t.after(()=>{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('operator-schedule-kernel-staged-'));fs.rmSync(root,{recursive:true,force:true});});}
function envelope(lease:any,payload:unknown,effect:'applied'|'none',completed_at:string){const verification=lease.fulfillment_role==='verification';return {content:[{type:'text',text:'Retained native projection'}],structuredContent:{schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
 operation_result_v2:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:'result-'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,
 status:'succeeded',dispatch_state:'dispatched',persistent_effect:effect,native_transaction_state:effect==='applied'?'committed':'not_applicable',authority:'native-host',
 result_schema_id:`operator-native/POST:${lease.request_identity.path}/v2`,observation_required:true,raw_payload_hash:digest(payload),receipt_id:'receipt-'+lease.operation_id,
 native_correlation_id:'native-'+lease.operation_id,request_identity:lease.request_identity,completed_at},
 observation:{raw_payload:payload,semantic_facts:effect==='applied'?[{fact_id:'task.result_available',fact_class:'domain',value:true},{fact_id:'inventory.complete',fact_class:'domain',value:true}]:[{fact_id:verification?'verification.result_available':'control.result_available',fact_class:verification?'verification':'control',value:true}],verification_relevance:['task_result']}}};}

test('retained TP105 aggregate read stays supporting; separate exact-source read closes only its edit',t=>{
 workspace(t);const goal=createGoal({title:'TP105 redline',objective:'Pick up current-rating redline.',acceptance_criteria:['The requested result is established.'],status:'active',related_session_id:'retained-owner',created_by:'retained-principal',work_budget:{requested_effect:'apply',document_fingerprint:'disposable'}});
 createAssignmentKernelForGoalV2({goal,run_id:'retained-run'});
 const input={...applyInput,body:{...applyInput.body,scheduleId:1661304,rowKey:'TP105',value:'200 A',expectedValue:'100 A'}};
 const apply=openAssignmentKernelOperationV2({snapshot:getAssignmentKernelSnapshotV2(goal.id)!,controller_request_id:'apply',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:['id:1661304'],arguments:input,opened_at:'2026-10-12T20:00:00Z'});
 markAssignmentKernelOperationDispatchStartedV2(apply);const commit=envelope(apply,{status:'Updated',sourceElementId:1654884},'applied','2026-10-12T20:00:01Z');
 Object.assign(commit.structuredContent.operation_result_v2,{affected_target_identities:['element_id:1654884']});settleAssignmentKernelOperationV2(apply,commit);
 for(const aggregate of [true,false]) {
  const current=advanceAssignmentKernelProgressV2({binding:apply.binding}).snapshot;
  const read=openAssignmentKernelOperationV2({snapshot:current,controller_request_id:aggregate?'batched':'exact',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:aggregate?['id:1654884','id:1662159']:['id:1654884'],arguments:{method:'POST',path:'/revit/get-parameters',body:aggregate?{elementIds:[1654884,1662159],names:['Name','Current Rating']}:{elementId:1654884,names:['Name','Current Rating']}},opened_at:aggregate?'2026-10-12T20:00:02Z':'2026-10-12T20:00:04Z'});
  markAssignmentKernelOperationDispatchStartedV2(read);
  const payload=aggregate?{items:[scheduleCellTp105ReadbackV2,native]}:scheduleCellTp105ReadbackV2;
  settleAssignmentKernelOperationV2(read,envelope(read,payload,'none',aggregate?'2026-10-12T20:00:03Z':'2026-10-12T20:00:05Z'));
  __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),aggregate);
  assert.equal(s.operations[read.operation_id]!.fulfillment_role,aggregate?'supporting_control':'verification');
 }
});

test('retained schedule field failure receives exact native parameter verification, with typed parameter read admission',()=>{
 const contract={path:applyInput.path,affected_target_identities:['element_id:1662159']};
 assert.equal(stagedCompare(applyInput,native,contract),true);
 assert(verificationCapabilityAdmissionForPathsV2(applyInput.path,'/revit/get-parameters').admissible);
 for(const route of ['/revit/get-element-summary','/revit/context','/revit/native-api-catalog'])
  assert.equal(verificationCapabilityAdmissionForPathsV2(applyInput.path,route).admissible,false,route);
});

for(const variant of ['exact','wrong_target','wrong_row','wrong_field','wrong_unit','echo','stale','stale_opened','non_native','no_affected_identity'] as const)
 test(`shared kernel retains schedule-cell proof across restart: ${variant}`,t=>{
  workspace(t);const goal=createGoal({title:'Update MAIN1',objective:'Update the selected schedule cell.',acceptance_criteria:['The requested result is authoritatively established.'],status:'active',related_session_id:'staged-owner',created_by:'staged-principal',work_budget:{requested_effect:'apply',document_fingerprint:'staged-disposable'}});
  createAssignmentKernelForGoalV2({goal,run_id:'staged-run'});const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
  const apply=openAssignmentKernelOperationV2({snapshot,controller_request_id:'apply',provider_turn_id:'apply-turn',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:['id:1357215'],arguments:applyInput,opened_at:'2026-10-12T11:20:00.000Z'});
  markAssignmentKernelOperationDispatchStartedV2(apply);
  const commit=envelope(apply,{status:'Updated',sourceElementId:1662159},'applied','2026-10-12T11:20:01.000Z');
  Object.assign(commit.structuredContent.operation_result_v2,{affected_target_identities:variant==='no_affected_identity'?[]:['element_id:1662159']});
  settleAssignmentKernelOperationV2(apply,commit);__testOnlyResetGoalListCache();
  const state=advanceAssignmentKernelProgressV2({binding:apply.binding}).snapshot;
  assert(deriveProgressGapsV2(state).some(g=>g.gap_id===`verification:${apply.operation_id}`));
  const read=openAssignmentKernelOperationV2({snapshot:state,controller_request_id:'read',provider_turn_id:'read-turn',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:['id:1662159'],
   arguments:{method:'POST',path:'/revit/get-parameters',body:{elementId:1662159,names:['Name','Current Rating']}},opened_at:variant==='stale_opened'?'2026-10-12T11:20:00.500Z':'2026-10-12T11:20:02.000Z'});
  markAssignmentKernelOperationDispatchStartedV2(read);
  const payload=structuredClone(native);
  if(variant==='wrong_target')payload.id++;
  if(variant==='wrong_row')payload.parameters.Name='MAIN2';
  if(variant==='wrong_field')payload.parameterDetails[1].name='Unrelated';
  if(variant==='wrong_unit')payload.parameterDetails[1].valueString='1600 CFM';
  const result=envelope(read,variant==='echo'?{request:payload}:payload,'none',variant==='stale'?'2026-10-12T11:19:59.000Z':'2026-10-12T11:20:03.000Z');
  if(variant==='non_native')Object.assign(result.structuredContent.operation_result_v2,{authority:'dynamic-runtime'});
  const settled=settleAssignmentKernelOperationV2(read,result).snapshot;
  const proof=()=>!deriveProgressGapsV2(getAssignmentKernelSnapshotV2(goal.id)!).some(g=>g.gap_id===`verification:${apply.operation_id}`);
  assert.equal(proof(),variant==='exact',variant);__testOnlyResetGoalListCache();assert.equal(proof(),variant==='exact',variant+' durable');
  assert.equal(settled.operations[apply.operation_id].persistent_effect,'applied');
  assert.equal(Object.values(settled.operations).filter(o=>o.requested_effect==='apply').length,1);
 });
