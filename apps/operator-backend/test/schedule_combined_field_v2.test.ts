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
import { operationTargetSelectorV2, verificationCapabilityAdmissionV2 } from '../src/verification/verification_capability_admission_v2.js';

import {scheduleCombinedFieldRequestV2,scheduleCombinedFieldReadbackMatchesV2} from '../src/verification/schedule_combined_field_v2.js';
const localFixture=new URL('./fixtures/schedule-combined-field.json',import.meta.url);
const fixtureFile=fs.existsSync(localFixture)?localFixture:new URL('../../test/fixtures/schedule-combined-field.json',import.meta.url);
const fixture=()=>JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
test('combined definition verifies actual ordered native bindings with no generic echo fallback',()=>{
 const f=fixture();assert.equal(scheduleCombinedFieldReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false);
 const apply={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input};
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:f.applied}).principal_target_tokens,['id:41','scheduleid:41']);
});
test('changes to bindings, preserved columns, filters, scope, receipt or current read refuse verification',()=>{
 const bad:Array<(f:any)=>void>=[
  f=>f.read.definition.fields[0].attributes.parts[0].parameterId=-999,
  f=>f.read.definition.fields[0].attributes.parts.reverse(),
  f=>f.read.definition.fields[0].attributes.parts[1].separator=' / ',
  f=>f.read.definition.fields[0].attributes.parts[0].prefix='fiction',
  f=>f.read.definition.fields[0].attributes.heading='Other',
  f=>f.read.definition.fields[0].attributes.gridWidthFeet=.4,
  f=>f.read.definition.fields[1].isHidden=false,
  f=>f.read.definition.fields[3].attributes.parameterId=-999,
  f=>f.read.definition.fields[3].attributes.style.preservedStyleHash='e'.repeat(64),
  f=>f.read.definition.fieldOrder.reverse(),
  f=>f.read.definition.fields.pop(),f=>f.read.definition.complete=false,
  f=>f.read.definition.configurationHash='e'.repeat(64),
  f=>f.applied.definitionBefore.fields[0].attributes.isCalculated=true,
  f=>f.applied.definitionBefore.fields[0].attributes.parameterId=-1,
  f=>f.applied.requestedIndex=2,f=>f.applied.createdScheduleFieldId=11,
  f=>f.applied.sourceFieldIds.reverse(),f=>f.applied.transaction.pending=true,
  f=>f.applied.changeTracking.exhaustiveChangeInventory=false,
  f=>f.read.scope.unrequestedSchedules[0].semanticHash='e'.repeat(64),
  f=>f.read.scope.dependencies=[],f=>f.read.scope.complete=false,
  f=>f.read.schedule.uniqueId='foreign',f=>f.read.schedule.kind='panel_schedule',
  f=>f.applied.definitionAfter.configurationHash='e'.repeat(64)
 ];
 for(const mutate of bad){const f=fixture();mutate(f);assert.equal(scheduleCombinedFieldReadbackMatchesV2(f.input,f.applied,f.read),false);}
 // Alter both post-commit and fresh state consistently: pre-edit preservation must still detect the damage.
 for(const mutate of [
  (v:any)=>v.fields[3].attributes.parameterId=-999,
  (v:any)=>v.fields[0].attributes.parts[0].parameterId=-999,
  (v:any)=>v.fields[0].attributes.parts[0].suffix='fiction',
  (v:any)=>v.fields[0].attributes.gridWidthFeet=.4,
  (v:any)=>v.fields[1].isHidden=false,
  (v:any)=>v.configurationHash='e'.repeat(64),
  (v:any)=>v.fields[3].attributes.style.preservedStyleHash='e'.repeat(64)
 ]){const f=fixture();mutate(f.applied.definitionAfter);mutate(f.read.definition);assert.equal(scheduleCombinedFieldReadbackMatchesV2(f.input,f.applied,f.read),false);}
});
test('malformed, mixed and preview requests cannot qualify as a verified combined edit',()=>{
 const good=fixture().input.body;
 for(const body of [{...good,dryRun:true},{...good,fieldOrder:[11,12]},
  ...[{name:' '},{sourceFieldIds:[11]},{sourceFieldIds:[11,11]},{sourceFieldIds:[-1,12]},
    {sourceFieldIds:[11,12.5]},{index:201},{index:1.5},{widthFeet:0},{widthFeet:NaN},
    {hideSourceFields:null},{separator:null},{invented:true}].map(extra=>({...good,combinedField:{...good.combinedField,...extra}}))
 ])assert.equal(scheduleCombinedFieldRequestV2(body),null,JSON.stringify(body));
});
// Ordinary dynamic-tool pipeline with durable evidence, not an external grader.
for(const variant of ['exact','wrong_binding','partial','wrong_order','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary combined-field edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-presentation-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const fixture85=fixture();const f={apply_input:fixture85.input,native_read:fixture85.read};
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

    if(read){
      if(variant==='wrong_binding')payload.definition.fields[0].attributes.parts[0].parameterId=-999;
      if(variant==='partial')payload.definition.complete=false;
      if(variant==='wrong_order')payload.definition.fieldOrder.reverse();
      if(variant==='wrong_target')payload.schedule.id++;

    }
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:read?['element_id:41']:['element_id:41','element_id:42','element_id:900'],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
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
   assert.equal(verified,['exact'].includes(variant));
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!['exact','unretained_apply'].includes(variant));
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

