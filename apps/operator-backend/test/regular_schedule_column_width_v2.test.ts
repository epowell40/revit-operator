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

const localFixture=new URL('./fixtures/schedule-column-width.json',import.meta.url);
const fixtureFile=fs.existsSync(localFixture)?localFixture:new URL('../../test/fixtures/schedule-column-width.json',import.meta.url);
const fixture=()=>JSON.parse(fs.readFileSync(fixtureFile,'utf8'));
test('widths require complete before/after definitions and a fresh native read, never generic echoed success',()=>{
 const f=fixture();assert(regularSchedulePresentationRequestV2(f.input));assert(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read));
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false);
 const old=structuredClone(f.applied);delete old.definitionBefore;delete old.definitionAfter;
 assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,old,f.read),false,'Retained122 legacy-width receipt has no preservation definition; never retro-verify it.');
});
test('requested widths, all other field bindings/styles, configuration, scope and receipt must be preserved',()=>{
 const mutations:Array<(f:any)=>void>=[
  f=>f.read.definition.fields[0].attributes.sheetWidthFeet=.4,
  f=>f.read.definition.fields[2].attributes.gridWidthFeet=.4,
  f=>f.read.definition.fields[1].attributes.parameterId=-999,
  f=>f.read.definition.fields[1].isHidden=true,
  f=>f.read.definition.fields[1].attributes.style.preservedStyleHash='e'.repeat(64),
  f=>f.read.definition.fieldOrder.reverse(),f=>f.read.definition.fields.pop(),
  f=>f.read.definition.complete=false,f=>f.read.definition.configurationHash='e'.repeat(64),
  f=>f.applied.transaction.deleted_element_ids=[18],f=>f.applied.transaction.pending=true,
  f=>f.read.scope.unrequestedSchedules[0].semanticHash='e'.repeat(64),
  f=>f.read.scope.dependencies=[],f=>f.read.scope.complete=false,
  f=>f.applied.changeTracking.exhaustiveChangeInventory=false,
  f=>{for(const d of [f.applied.definitionAfter,f.read.definition])d.fields[1].attributes.parameterId=-999;},
  f=>{for(const d of [f.applied.definitionAfter,f.read.definition])d.fields[1].attributes.name='Other';},
  f=>{for(const d of [f.applied.definitionAfter,f.read.definition])d.fields[1].isHidden=true;},
  f=>{for(const d of [f.applied.definitionAfter,f.read.definition])d.configurationHash='e'.repeat(64);},
  f=>{f.applied.definitionBefore.fields[1].attributes.name='Manufacturer';}
 ];for(const mutate of mutations){const f=fixture();mutate(f);assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);}
 const f=fixture();f.input.body.fieldOrder=[18,12,11];for(const p of [f.applied.definitionAfter,f.read.definition]){p.fieldOrder=[18,12,11];p.fields.reverse();}for(const p of [f.applied.presentationReadback,f.read.presentation])p.fieldOrder=[18,12,11];
 assert(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),'Requested width+complete order can be verified together.');
});
test('malformed, duplicate, mixed structural or preview width requests cannot qualify',()=>{
 const good=fixture().input.body;
 for(const body of [{...good,dryRun:true},{...good,filters:[]},{...good,addFields:['Count']},{...good,appearance:{titleTextTypeId:70}},
  ...[null,[],[{}],[{field:' ',widthFeet:.2}],[{field:'Remarks',widthFeet:0}],[{field:'Remarks',widthFeet:'0.2'}],
  [{field:'Remarks',widthFeet:NaN}],[{field:'Remarks',widthFeet:101}],[{field:'Remarks',widthFeet:.2,invented:true}],
  [{field:'Remarks',widthFeet:.2},{field:' remarks ',widthFeet:.3}]].map(columnWidths=>({...good,columnWidths}))])
  assert.equal(regularSchedulePresentationRequestV2({body}),null,JSON.stringify(body));
});
// Ordinary dynamic-tool pipeline with durable evidence, not an external grader.
for(const variant of ['exact','wrong_binding','partial','wrong_order','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary column-width edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
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
      if(variant==='wrong_binding')payload.definition.fields[0].attributes.gridWidthFeet=.9;
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

