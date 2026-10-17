import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { committedRegularSchedulePresentationReadbackPlanV2, regularSchedulePresentationReadbackMatchesV2, regularSchedulePresentationRequestV2 } from '../src/verification/regular_schedule_presentation_v2.js';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import {rowFixture}from './fixtures/schedule-row-height-synthetic.js';
import {codexAssignmentEvidenceContextV2}from '../src/brains/codex_assignment_evidence.js';
import { operationTargetSelectorV2, verificationCapabilityAdmissionV2 } from '../src/verification/verification_capability_admission_v2.js';

// Synthetic contract neighbors. The exact retained83 read failure remains in
// the native fixture and does not become a fabricated successful edit receipt.
function fixture(){
 const input={path:'/revit/configure-schedule',method:'POST',body:{scheduleId:41,dryRun:false,fieldOrder:[20,11,12],appearance:{titleTextTypeId:70,headerTextTypeId:71,bodyTextTypeId:72,showTitle:true,showHeaders:true}}};
 const presentation={schema:'operator.regular_schedule_presentation.v1',complete:true,fieldOrder:[20,11,12],showTitle:true,showHeaders:true,
   title:{id:70,uniqueId:'style:70'},header:{id:71,uniqueId:'style:71'},body:{id:72,uniqueId:'style:72'}};
 const applied={status:'Success',dryRun:false,schedule:{id:41,uniqueId:'view:41'},presentationReadback:presentation,
   transaction:{committed:true,rolledBack:false,pending:false,added_element_ids:[] as number[],deleted_element_ids:[] as number[],modified_element_ids:[41]},changeTracking:{exhaustiveChangeInventory:true}};
 const read={status:'Ok',action:'presentation',read_only:true,schedule:{id:41,uniqueId:'view:41',kind:'schedule'},presentation:structuredClone(presentation)};
 return {input,applied,read};
}
test('native default styles and complete order must match in commit and independent read',()=>{
 const f=fixture();assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false,'generic success and echoed fields cannot verify these edits');
});
test('all requested fields, native identity and exhaustive affected inventory are required',()=>{
 const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
  f=>f.read.presentation.fieldOrder.reverse(),f=>f.read.presentation.fieldOrder.pop(),f=>f.read.presentation.title.id++,
  f=>f.read.presentation.header.id++,f=>f.read.presentation.body.id++,f=>f.read.presentation.title.uniqueId='other',
  f=>f.read.presentation.showHeaders=false,f=>f.read.presentation.showTitle=false,f=>f.read.presentation.complete=false,
  f=>f.read.schedule.id++,f=>f.read.schedule.uniqueId='other',f=>f.read.schedule.kind='panel_schedule',
  f=>f.applied.transaction.pending=true,f=>f.applied.transaction.rolledBack=true,f=>f.applied.transaction.added_element_ids.push(99),
  f=>f.applied.transaction.deleted_element_ids.push(99),f=>f.applied.transaction.modified_element_ids.push(70),
  f=>f.applied.changeTracking.exhaustiveChangeInventory=false,f=>f.applied.presentationReadback.title.id++,
  f=>{(f as any).read={...f.input.body,status:'Ok'};}
 ];for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);}
});
test('mixed edits, partial orders and unsafe IDs cannot fall into generic verification',()=>{
 for(const body of [{scheduleId:41,fieldOrder:[]},{scheduleId:41,fieldOrder:[1,1]},{scheduleId:41,fieldOrder:[1,-1]},
   {scheduleId:41,fieldOrder:[1],addFields:['Count']},{scheduleId:41,appearance:{titleTextTypeId:0}},
   {scheduleId:41,appearance:{bodyTextTypeId:72},filters:[]},{scheduleId:41,fieldOrder:[1],dryRun:true}]){
  assert.equal(regularSchedulePresentationRequestV2({body}),null);
 }
 const f=fixture();const apply={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input};
 const verification={capability_id:'revit_call_tool',method:'POST',path:'/revit/schedules',arguments:{body:{action:'presentation',scheduleId:41}}};
 assert.equal(verificationCapabilityAdmissionV2({apply,verification}).admissible,true);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{...verification,arguments:{body:{action:'list'}}}}).admissible,false);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{...verification,arguments:{body:{action:'presentation',query:'air'}}}}).admissible,false);
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:f.applied}).principal_target_tokens,['id:41','scheduleid:41']);
});
// Ordinary dynamic-tool pipeline with durable evidence, not an external grader.
for(const variant of ['exact','row_heights','row_height_mismatch','field_formats','wrong_style','partial','wrong_order','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit','wide_exact','wide_self','wide_changed','wide_unowned'] as const)
test(`ordinary native presentation edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-presentation-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const fixture85:any=variant.startsWith('row_height')?rowFixture():fixture();
  if(variant==='field_formats'){
   (fixture85.input as any).body={scheduleId:41,fieldFormats:[{field:'Description',heading:'DESCRIPTION',widthFeet:.3},{field:'Count',hidden:true}],dryRun:false};
   const field=(id:number,name:string)=>({fieldId:id,isHidden:false,semanticHash:'b'.repeat(64),attributes:{fieldId:id,name,parameterId:-1,fieldType:'Instance',isCalculated:false,isCombined:false,heading:name,headingOrientation:'Horizontal',horizontalAlignment:'Center',gridWidthFeet:.2,sheetWidthFeet:.2,style:{preservedStyleHash:'c'.repeat(64)},parts:[]}});
   const before={schema:'operator.regular_schedule_field_definition.v1',complete:true,scheduleId:41,uniqueId:'view:41',categoryId:-2008013,coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',configurationHash:'a'.repeat(64),fieldOrder:[20,11,12],fields:[field(20,'Description'),field(11,'Count'),field(12,'Remarks')]};
   const after=structuredClone(before);after.fields[0]!.attributes.heading='DESCRIPTION';after.fields[0]!.attributes.gridWidthFeet=.3;after.fields[0]!.attributes.sheetWidthFeet=.3;after.fields[0]!.semanticHash='d'.repeat(64);after.fields[1]!.isHidden=true;
   Object.assign(fixture85.applied,{definitionBefore:before,definitionAfter:after});Object.assign(fixture85.read,{definition:structuredClone(after)});
  }
  const f={apply_input:fixture85.input,native_read:fixture85.read};
  const goal=createGoal({title:'Pick up the current-rating redline',objective:'Pick up the current-rating redline.',acceptance_criteria:['The requested edit is established.'],status:'active',
    related_session_id:'tag-host-session',created_by:'tag-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(args.path==='/revit/schedules'){
    assert.deepEqual(args.body,{action:'presentation',scheduleId:41});if(variant==='read_schema_rejected')throw Error('read_schema_rejected');
   }},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/schedules';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.native_read):structuredClone(fixture85.applied);
    if(variant.startsWith('wide_')){
      const before={schema:'operator.regular_schedule_presentation_scope.v1',complete:true,coverage:'configuration_cell_text_style_geometry_v1',targetId:41,targetUniqueId:'view:41',totalUnrequestedCells:400,
        unrequestedSchedules:[{scheduleId:42,uniqueId:'view:42',semanticHash:'a'.repeat(64)}],dependencies:[] as any[]};
      if(variant==='wide_self')before.dependencies.push({id:41,uniqueId:'view:41',className:'Autodesk.Revit.DB.ViewSchedule',ownerViewId:-1});
      const after=structuredClone(before);after.dependencies.push({id:900,uniqueId:'generated:900',className:'Autodesk.Revit.DB.Element',ownerViewId:-1});
      if(read){payload.scope=after;if(variant==='wide_changed')payload.scope.unrequestedSchedules[0].semanticHash='b'.repeat(64);if(variant==='wide_unowned')payload.scope.dependencies=[];}
      else{payload.presentationScopeBefore=before;payload.presentationScopeAfter=after;payload.transaction.added_element_ids=[900];payload.transaction.modified_element_ids=[41,42];}
    }

    if(read){
      if(variant==='row_height_mismatch')payload.rowHeights.sections[0].rows[0].heightFeet=.036;
      if(variant==='wrong_style')payload.presentation.header.id=99;
      if(variant==='partial')payload.presentation.complete=false;
      if(variant==='wrong_order')payload.presentation.fieldOrder.reverse();
      if(variant==='wrong_target')payload.schedule.id++;

    }
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:!read&&variant.startsWith('wide_')?['element_id:41','element_id:42','element_id:900']:['element_id:41'],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
      raw_payload_hash:read&&variant==='wrong_digest'?'e'.repeat(64):createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:new Date().toISOString()},observation:{raw_payload:!read&&variant==='unretained_apply'?{status:'Success'}:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  // Ordinary retained owner state, not a privileged verifier principal.
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'tag-task',user_text:goal.objective,
   assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'user-tag-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'tag-turn',tool:'revit_call_tool',arguments:f.apply_input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!;
   const apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(apply.result?.persistent_effect,'applied');assert.equal(calls.filter(c=>c.path==='/revit/configure-schedule').length,1);
   assert.equal(response.success,variant!=='unretained_apply','a mismatched apply observation is refused, never repeated');
   assert.equal(validations.filter(a=>a.path==='/revit/schedules').length,['unretained_apply','paused_after_commit'].includes(variant)?0:1);
   assert.equal(calls.filter(c=>c.path==='/revit/schedules').length,['unretained_apply','read_schema_rejected','paused_after_commit'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,['exact','row_heights','field_formats','wide_exact','wide_self'].includes(variant));
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!['exact','row_heights','field_formats','wide_exact','wide_self','unretained_apply'].includes(variant));
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
   if(variant==='row_height_mismatch'){
    const pending=JSON.parse(codexAssignmentEvidenceContextV2(s)).pending_verification;
    assert.equal(pending[0].latest_check.state,'mismatch');
    assert.deepEqual(pending[0].latest_check.differences[0].observed,['heightFeet:0.036']);
   }
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('native presentation read planning rejects stale bindings, unknowns, pending writes, pause and repeat dispatch',()=>{
 const f=fixture(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input:f.input,request_identity:{path:f.input.path,request_signature:'b'.repeat(64)},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',verification_operation_ids:[],observation_ids:[],
  result:{operation_id:'opv2_'+'a'.repeat(64),binding,status:'succeeded',dispatch_state:'dispatched',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-14T10:00:01Z',request_identity:{request_signature:'b'.repeat(64)},affected_target_identities:['element_id:41'],receipt_id:'receipt:one',native_correlation_id:'native:one'}};
 const snapshot:any={in_flight_operation_ids:[],terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
 assert.deepEqual(committedRegularSchedulePresentationReadbackPlanV2(snapshot,op),{method:'POST',path:'/revit/schedules',body:{action:'presentation',scheduleId:41}});
 for(const mutate of [(s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.input.body.dryRun=true,
  (s:any,o:any)=>o.input.body.dryRun='false',(s:any)=>s.unresolved_unknown_operation_ids=['old'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,run_id:'foreign'},
  (s:any,o:any)=>o.result.native_transaction_state='pending',(s:any,o:any)=>o.result.authority='model',
  (s:any,o:any)=>o.result.dispatch_state='not_started',(s:any,o:any)=>o.result.receipt_id='',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.affected_target_identities=[],
  (s:any,o:any)=>o.verification_operation_ids=['already'],
  (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.completion_proposal={},(s:any)=>s.terminal=true,
  (s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
  (s:any,o:any)=>s.operations.pending={...o,operation_id:'pending',settlement_state:'pending',persistent_effect:'none',result:undefined}]){
  const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedRegularSchedulePresentationReadbackPlanV2(s,o),null);
 }
 const later=structuredClone(snapshot);later.operations.later={...op,operation_id:'later',result:{...op.result}};
 assert(committedRegularSchedulePresentationReadbackPlanV2(later,later.operations[op.operation_id]),'Later settled edits allow a new read, never a proof from the old receipt.');
});

