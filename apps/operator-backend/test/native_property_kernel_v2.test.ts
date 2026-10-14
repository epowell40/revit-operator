import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {advanceAssignmentKernelProgressV2} from '../src/assignments/assignment_kernel_v2_progress.js';
import {openAssignmentKernelOperationV2,markAssignmentKernelOperationDispatchStartedV2,settleAssignmentKernelOperationV2,ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA} from '../src/assignments/assignment_kernel_v2_execution.js';
import {canonicalJsonV2,OPERATION_RESULT_V2_SCHEMA} from '../src/domain/assignment-kernel/index.js';
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
for(const variant of ['exact','false','wrong_target','missing_scalar','summary_echo','stale','foreign_authority'] as const)
test(`native getter settlement/restart: ${variant}`,t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-native-getter-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 t.after(()=>{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
 const desired=variant!=='false';const goal=createGoal({title:'Set schedule row shading',objective:'Set schedule row shading.',acceptance_criteria:['Requested schedule appearance established.'],status:'active',related_session_id:'getter-owner',created_by:'getter-principal',work_budget:{requested_effect:'apply',document_fingerprint:'getter-model'}});
 createAssignmentKernelForGoalV2({goal,run_id:'getter-run'});
 function result(lease:any,payload:any,apply:boolean){return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
 operation_result_v2:{schema:OPERATION_RESULT_V2_SCHEMA,result_id:'r-'+lease.operation_id,operation_id:lease.operation_id,binding:lease.binding,status:'succeeded',dispatch_state:'dispatched',persistent_effect:apply?'applied':'none',native_transaction_state:apply?'committed':'not_applicable',authority:!apply&&variant==='foreign_authority'?'model':'native-host',result_schema_id:`operator-native/POST:${lease.request_identity.path}/v2`,observation_required:true,raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt-'+lease.operation_id,native_correlation_id:'native-'+lease.operation_id,request_identity:lease.request_identity,...(!apply&&variant==='foreign_authority'?{}:{affected_target_identities:['element_id:101']}),completed_at:apply?'2026-10-13T19:00:01Z':variant==='stale'?'2026-10-13T18:59:59Z':'2026-10-13T19:00:03Z'},
 observation:{raw_payload:payload,semantic_facts:[{fact_id:apply?'task.result_available':'verification.result_available',fact_class:apply?'domain':'verification',value:true}],verification_relevance:['task_result']}}};}
 const apply=openAssignmentKernelOperationV2({snapshot:getAssignmentKernelSnapshotV2(goal.id)!,controller_request_id:'apply',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'apply',target_tokens:['id:101'],arguments:{method:'POST',path:'/revit/configure-schedule',body:{scheduleId:101,appearance:{stripedRows:desired},dryRun:false}},opened_at:'2026-10-13T19:00:00Z'});
 markAssignmentKernelOperationDispatchStartedV2(apply);settleAssignmentKernelOperationV2(apply,result(apply,{status:'Success',scheduleId:101},true));__testOnlyResetGoalListCache();
 const snapshot=advanceAssignmentKernelProgressV2({binding:apply.binding}).snapshot;
 const input={method:'POST',path:'/revit/native-api-ops',body:{operations:[{id:'schedule',op:'call',target:'doc',memberId:GET,args:[101]},{id:'striped',op:'get_property',target:'$schedule',property:'HasStripedRows'}],returns:['schedule','striped']}};
 const read=openAssignmentKernelOperationV2({snapshot,controller_request_id:'read',provider_turn_id:'turn',capability_id:'revit_call_tool',classified_effect:'read',target_tokens:['id:101'],arguments:input,opened_at:'2026-10-13T19:00:02Z'});markAssignmentKernelOperationDispatchStartedV2(read);
 const payload:any={version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:2,operations:[{id:'schedule',op:'call',member_id:GET,target_type:'Autodesk.Revit.DB.Document',result_preview:{id:101,unique_id:'native-schedule-uid'}},{id:'striped',op:'get_property',property:'HasStripedRows',target_type:'Autodesk.Revit.DB.ViewSchedule',result_preview:desired}],results:{schedule:{id:101,unique_id:'native-schedule-uid'},striped:desired}};
 if(variant==='wrong_target')payload.operations[0].result_preview.id=102;
 if(variant==='missing_scalar')delete payload.results.striped;
 if(variant==='summary_echo'){delete payload.results.striped;delete payload.operations[1].result_preview;payload.results.schedule.HasStripedRows=desired;}
 settleAssignmentKernelOperationV2(read,result(read,payload,false));__testOnlyResetGoalListCache();const final=getAssignmentKernelSnapshotV2(goal.id)!;
 const checked=final.operations[apply.operation_id]!.verification_operation_ids.some(id=>final.operations[id]!.observation_ids.some(oid=>final.observations[oid]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
 assert.equal(checked,variant==='exact'||variant==='false');assert.equal(final.operations[apply.operation_id]!.persistent_effect,'applied');
});
