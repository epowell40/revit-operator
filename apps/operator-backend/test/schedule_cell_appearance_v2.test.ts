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
import { committedScheduleCellBackgroundReadbackPlanV2, scheduleCellBackgroundReadbackMatchesV2, scheduleCellBackgroundRequestV2 } from '../src/verification/schedule_cell_appearance_v2.js';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import { operationTargetSelectorV2, verificationCapabilityAdmissionV2 } from '../src/verification/verification_capability_admission_v2.js';

// Synthetic contract neighbors. The exact retained83 read failure remains in
// the native fixture and does not become a fabricated successful edit receipt.
function fixture() {
 const input={path:'/revit/configure-schedule',method:'POST',body:{scheduleId:41,dryRun:false,cellStyles:[{section:'Body',row:4,column:5,expectedText:'0 VA',backgroundColorRgb:[255,255,255]}]}};
 const preserved={complete:true,totalCells:520,textHash:'a'.repeat(64),unrequestedStyleHash:'b'.repeat(64)};
 const before={section:'Body',row:4,column:5,text:'0 VA',allowOverride:true,mergedRange:[4,5,4,5],gridBackgroundColorRgb:[216,216,216],sheetBackgroundColorRgb:[255,255,255],backgroundOverride:false,preservedStyleHash:'c'.repeat(64)};
 const after={...structuredClone(before),gridBackgroundColorRgb:[255,255,255],backgroundOverride:true};
 const applied={schema:'operator.schedule_cell_background_edit.v1',status:'Success',scheduleId:41,uniqueId:'synthetic-view:41',scheduleKind:'PanelSchedule',preservationBefore:preserved,preservationAfter:structuredClone(preserved),
  cells:[{section:'Body',row:4,column:5,before,after}],transaction:{committed:true,rolledBack:false,pending:false,added_element_ids:[] as number[],deleted_element_ids:[] as number[],modified_element_ids:[41]},changeTracking:{exhaustiveChangeInventory:true}};
 const read={schema:'operator.schedule_cell_appearance.v1',status:'Ok',action:'cell_styles',read_only:true,scheduleId:41,uniqueId:applied.uniqueId,scheduleKind:'PanelSchedule',complete:true,cells:[structuredClone(after)],preservation:structuredClone(preserved)};
 return {input,applied,read};
}

test('background checks require fresh complete native colors, cell text, style and unrequested table preservation',()=>{
 const f=fixture();assert.equal(scheduleCellBackgroundReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,f.read,{path:f.input.path}),false,'generic field tokens cannot replace the durable before/preservation comparison');
});

test('neighbor failures do not certify echoes, partial batches, spills or changed notes/electrical display data',()=>{
 const mutations:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['request echo',f=>{(f as any).read={...f.input.body,status:'Ok',complete:true};}],
  ['wrong view',f=>{f.read.scheduleId=99;}],['different native identity',f=>{f.read.uniqueId='wrong';}],
  ['wrong cell',f=>{f.read.cells[0]!.row=3;}],['wrong grid color',f=>{f.read.cells[0]!.gridBackgroundColorRgb=[216,216,216];}],
  ['wrong sheet color',f=>{f.read.cells[0]!.sheetBackgroundColorRgb=[216,216,216];}],
  ['changed text',f=>{f.read.cells[0]!.text='20 VA';}],['changed font/border',f=>{f.read.cells[0]!.preservedStyleHash='d'.repeat(64);}],
  ['table notes changed',f=>{f.read.preservation.textHash='d'.repeat(64);}],['other style spill',f=>{f.read.preservation.unrequestedStyleHash='d'.repeat(64);}],
  ['unsettled',f=>{f.applied.transaction.pending=true;}],['rolled back',f=>{f.applied.transaction.rolledBack=true;}],
  ['new element',f=>{f.applied.transaction.added_element_ids=[500];}],['another existing element modified',f=>{f.applied.transaction.modified_element_ids.push(99);}],
  ['incomplete inventory',f=>{f.applied.changeTracking.exhaustiveChangeInventory=false;}],['partial read',f=>{f.read.complete=false;}],
  ['missing cell',f=>{f.read.cells=[];}],['duplicate cell',f=>{f.read.cells.push(structuredClone(f.read.cells[0]!));}],
  ['missing before',f=>{delete (f.applied.cells[0] as any).before;}],['unobserved old style',f=>{delete (f.applied.cells[0]!.before as any).preservedStyleHash;}]
 ];
 for(const[name,mutate]of mutations){const f=fixture();mutate(f);assert.equal(scheduleCellBackgroundReadbackMatchesV2(f.input,f.applied,f.read),false,name);}
});

test('multiple cells must ALL match and malformed requests do not fall into generic verification',()=>{
 const f=fixture();const c=structuredClone(f.input.body.cellStyles[0]!);c.row=2;f.input.body.cellStyles.push(c);
 const a=structuredClone(f.applied.cells[0]!);a.row=a.before.row=a.after.row=2;f.applied.cells.push(a);f.read.cells.push(structuredClone(a.after));
 assert.equal(scheduleCellBackgroundReadbackMatchesV2(f.input,f.applied,f.read),true);f.read.cells.pop();assert.equal(scheduleCellBackgroundReadbackMatchesV2(f.input,f.applied,f.read),false);
 const bad=fixture();(bad.input.body.cellStyles[0] as any).value='fake';assert.equal(scheduleCellBackgroundRequestV2(bad.input),null);
 assert.equal(postconditionSatisfiedByPayloadV2(bad.input,{status:'Success',value:'fake'},{path:bad.input.path}),false);
});

test('only exact cell appearance reads verify an edit; lists and contextual cell numbers are ineligible',()=>{
 const f=fixture(),apply={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input};
 const verification={capability_id:'revit_call_tool',method:'POST',path:'/revit/schedules',arguments:{body:{action:'cell_styles',scheduleId:41,cells:[{section:'Body',row:4,column:5}]}}};
 assert.equal(verificationCapabilityAdmissionV2({apply,verification}).admissible,true);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{...verification,arguments:{body:{action:'list'}}}}).admissible,false);
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:f.input.body}).principal_target_tokens,['id:41','scheduleid:41']);
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:{cells:[{row:41,column:41}],viewId:41}}).principal_target_tokens,[]);
});

// Ordinary dynamic-tool pipeline with durable evidence, not an external grader.
for(const variant of ['exact','wrong_color','partial','preservation_spill','wrong_target','unretained_apply','wrong_digest','read_failure','read_schema_rejected','paused_after_commit'] as const)
test(`ordinary background edit ${variant} triggers one separate guarded read without a provider recipe`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-host-schedule-check-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try { await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const fixture85=fixture();const f={apply_input:fixture85.input,native_read:fixture85.read};
  const goal=createGoal({title:'Pick up the current-rating redline',objective:'Pick up the current-rating redline.',acceptance_criteria:['The requested edit is established.'],status:'active',
    related_session_id:'tag-host-session',created_by:'tag-host-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-host-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,args:any){validations.push(args);if(args.path==='/revit/schedules'){
    assert.deepEqual(args.body,{action:'cell_styles',scheduleId:41,cells:[{section:'Body',row:4,column:5}]});if(variant==='read_schema_rejected')throw Error('read_schema_rejected');
   }},
   async callTool(_tool:string,args:any,context:any){
    calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();
    const read=args.path==='/revit/schedules';if(read&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=read?structuredClone(f.native_read):structuredClone(fixture85.applied);
    if(read){
      if(variant==='wrong_color')payload.cells[0].gridBackgroundColorRgb=[216,216,216];
      if(variant==='partial')payload.cells=[];
      if(variant==='preservation_spill')payload.preservation.unrequestedStyleHash='d'.repeat(64);
      if(variant==='wrong_target')payload.scheduleId++;

    }
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!read&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:'native-host',
      affected_target_identities:['element_id:41'],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
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
   assert.equal(validations.filter(a=>a.path==='/revit/schedules').length,['unretained_apply','paused_after_commit'].includes(variant)?0:variant==='read_schema_rejected'?1:2,'Reserve only schema-valid reads; the dispatcher validates again before its single native call.');
   assert.equal(calls.filter(c=>c.path==='/revit/schedules').length,['unretained_apply','read_schema_rejected','paused_after_commit'].includes(variant)?0:1);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact');
   assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),!['exact','unretained_apply'].includes(variant));
   assert.equal(Object.values(s.operations).filter(o=>o.requested_effect==='apply').length,1);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('appearance read planning rejects stale bindings, unknowns, pending writes, pause and repeat dispatch',()=>{
 const f=fixture(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input:f.input,request_identity:{path:f.input.path,request_signature:'b'.repeat(64)},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',verification_operation_ids:[],observation_ids:[],
  result:{operation_id:'opv2_'+'a'.repeat(64),binding,status:'succeeded',dispatch_state:'dispatched',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-14T10:00:01Z',request_identity:{request_signature:'b'.repeat(64)},affected_target_identities:['element_id:41'],receipt_id:'receipt:one',native_correlation_id:'native:one'}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
 assert.deepEqual(committedScheduleCellBackgroundReadbackPlanV2(snapshot,op),{method:'POST',path:'/revit/schedules',body:{action:'cell_styles',scheduleId:41,cells:[{section:'Body',row:4,column:5}]}});
 for(const mutate of [(s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.input.body.dryRun=true,
  (s:any,o:any)=>o.input.body.dryRun='false',(s:any)=>s.unresolved_unknown_operation_ids=['old'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.binding={...o.binding,run_id:'foreign'},
  (s:any,o:any)=>o.result.native_transaction_state='pending',(s:any,o:any)=>o.result.authority='model',
  (s:any,o:any)=>o.result.dispatch_state='not_started',(s:any,o:any)=>o.result.receipt_id='',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.affected_target_identities=[],
  (s:any,o:any)=>o.result.affected_target_identities.push('element_id:99'),(s:any,o:any)=>o.verification_operation_ids=['already'],
  (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.completion_proposal={},(s:any)=>s.terminal=true,
  (s:any,o:any)=>s.input_invalidated_operation_ids=[o.operation_id],
  (s:any,o:any)=>s.operations.later={...o,operation_id:'later',result:{...o.result}},
  (s:any,o:any)=>s.operations.pending={...o,operation_id:'pending',settlement_state:'pending',persistent_effect:'none',result:undefined}]){
  const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedScheduleCellBackgroundReadbackPlanV2(s,o),null);
 }
});

test('canonical durable receipt roundtrip cannot change the meaning of preservation fields',()=>{
 const f=fixture();assert.equal(scheduleCellBackgroundReadbackMatchesV2(f.input,JSON.parse(canonicalJsonV2(f.applied)),f.read),true);
});
