import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2,ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA} from '../src/assignments/assignment_kernel_v2_execution.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {advanceAssignmentKernelProgressV2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {canonicalJsonV2,deriveProgressGapsV2,OPERATION_RESULT_V2_SCHEMA} from '../src/domain/assignment-kernel/index.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {panelMoveFixtureV2} from './fixtures/panel_schedule_move_fixture.js';
const fixture=panelMoveFixtureV2;
const digest=(v:unknown)=>createHash('sha256').update(canonicalJsonV2(v)).digest('hex');
function envelope(lease:any,payload:any,apply:boolean,variant:string){return {content:[{type:'text',text:'Retained panel schedule evidence'}],structuredContent:{schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
 operation_result_v2:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:'result-'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,
 status:'succeeded',dispatch_state:'dispatched',persistent_effect:apply?'applied':'none',native_transaction_state:apply?'committed':'not_applicable',authority:!apply&&variant==='non_native'?'model':'native-host',
 result_schema_id:`operator-native/POST:${lease.request_identity.path}/v2`,observation_required:true,raw_payload_hash:digest(payload),receipt_id:'receipt-'+lease.operation_id,
 native_correlation_id:'native-'+lease.operation_id,request_identity:lease.request_identity,affected_target_identities:apply?payload.transaction.modified_element_ids.map((id:number)=>'element_id:'+id):['element_id:'+payload.sheetId],completed_at:apply?'2026-10-13T19:00:01Z':variant==='stale'?'2026-10-13T18:59:59Z':'2026-10-13T19:00:03Z'},
 observation:{raw_payload:payload,semantic_facts:[{fact_id:apply?'task.result_available':lease.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:apply?'domain':lease.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['task_result']}}};}
for(const variant of ['exact','wrong_origin','wrong_anchor_class','wrong_sheet','incomplete_inventory','stale','non_native'] as const)
test(`panel schedule movement shared settlement and restart: ${variant}`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-panel-move-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 t.after(()=>{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const f=fixture(),goal=createGoal({title:'Move panel schedules within sheet border',objective:'Move the selected panel schedules within the sheet border.',acceptance_criteria:['Requested placements are established.'],status:'active',related_session_id:'panel-owner',created_by:'panel-principal',work_budget:{requested_effect:'apply',document_fingerprint:'disposable-panel-model'}});
 createAssignmentKernelForGoalV2({goal,run_id:'panel-run'});const apply=openAssignmentKernelOperationV2({snapshot:getAssignmentKernelSnapshotV2(goal.id)!,controller_request_id:'move',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:f.input.body.ids.map((id:number)=>'id:'+id),arguments:f.input,opened_at:'2026-10-13T19:00:00Z'});
 markAssignmentKernelOperationDispatchStartedV2(apply);settleAssignmentKernelOperationV2(apply,envelope(apply,f.native_apply,true,variant));__testOnlyResetGoalListCache();
 let s=advanceAssignmentKernelProgressV2({binding:apply.binding}).snapshot;
 const read=openAssignmentKernelOperationV2({snapshot:s,controller_request_id:'check',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:f.input.body.ids.map((id:number)=>'id:'+id),arguments:{method:'POST',path:'/revit/sheets',body:{action:'detail',sheetId:f.actual_sheet.sheetId,placementIds:f.input.body.ids,includeViewportGeometry:true}},opened_at:'2026-10-13T19:00:02Z'});
 markAssignmentKernelOperationDispatchStartedV2(read);const payload=structuredClone(f.actual_sheet);
 const panel=payload.placedSchedules.find((p:any)=>p.instanceId===f.input.body.ids[0]);
 if(variant==='wrong_origin')panel.point.v+=.01;
 if(variant==='wrong_anchor_class')panel.placementType='ScheduleSheetInstance';
 if(variant==='wrong_sheet'){payload.sheetId++;payload.sheetElementId++;}
 if(variant==='incomplete_inventory')payload.placedScheduleCount++;
 const result=envelope(read,payload,false,variant);
 result.structuredContent.observation.semantic_facts.push({fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:['element_id:999999']} as any);
 if(variant==='non_native')delete (result.structuredContent.operation_result_v2 as any).affected_target_identities;
 settleAssignmentKernelOperationV2(read,result);__testOnlyResetGoalListCache();const end=getAssignmentKernelSnapshotV2(goal.id)!;
 const proof=end.operations[apply.operation_id]!.verification_operation_ids.some(id=>end.operations[id]!.observation_ids.some(oid=>end.observations[oid]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
 assert.equal(proof,variant==='exact');assert.equal(end.operations[apply.operation_id]!.persistent_effect,'applied');
 const deliverables=end.operations[read.operation_id]!.observation_ids.flatMap(oid=>end.observations[oid]!.facts.filter(f=>f.fact_id==='verification.deliverable_target_identities'));
 assert.deepEqual(deliverables.map(f=>f.value),variant==='exact'?[f.input.body.ids.map((id:number)=>'element_id:'+id)]:[],"Only native checked placements replace forged producer targets");
});
