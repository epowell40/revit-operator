import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import test from 'node:test';
import {createHash} from 'node:crypto';
import {nativeSchedulePresentationRequestV2,nativeSchedulePresentationMatchesV2,committedNativeSchedulePresentationReadbackPlanV2,nativeSchedulePresentationPostconditionSatisfiedV2} from '../src/verification/native_schedule_presentation_v2.js';
import {verificationCapabilityAdmissionV2,operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {beginTeammateLoopOwner,endTeammateLoopOwner} from '../src/teammate_loop_runtime.js';
import {handleCodexDynamicToolCall} from '../src/brains/codex_dynamic_tool_handler.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {canonicalJsonV2,deriveProgressGapsV2} from '../src/domain/assignment-kernel/index.js';
import {controlAssignmentExecutionV2} from '../src/assignments/assignment_kernel_v2_controls.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
const GET='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)',TABLE_GET='method:Autodesk.Revit.DB.Electrical.PanelScheduleView.GetTableData()',SECTION='method:Autodesk.Revit.DB.TableData.GetSectionData(Autodesk.Revit.DB.SectionType)';
const SET_TEXT='method:Autodesk.Revit.DB.TableSectionData.SetCellText(System.Int32,System.Int32,System.String)',SET_HEIGHT='method:Autodesk.Revit.DB.TableSectionData.SetRowHeight(System.Int32,System.Double)';
const TEXT='method:Autodesk.Revit.DB.TableView.GetCellText(Autodesk.Revit.DB.SectionType,System.Int32,System.Int32)',HEIGHT='method:Autodesk.Revit.DB.TableSectionData.GetRowHeight(System.Int32)';
const call=(id:string,target:string,memberId:string,args:any[])=>({id,op:'call',target,memberId,args});
const digest=(v:any)=>createHash('sha256').update(canonicalJsonV2(v)).digest('hex');
function native(operations:any[],editing:boolean){const handles=new Map<string,string>([['doc','Autodesk.Revit.DB.Document']]);
 const receipts=operations.map(s=>{const target_type=handles.get(s.target);let result_preview:any=null;
  if(s.memberId===GET){handles.set('$'+s.id,'Autodesk.Revit.DB.Electrical.PanelScheduleView');result_preview={id:41,unique_id:'native-schedule-fixture-41',name:'Sample'};}
  else if(s.memberId.endsWith('.GetTableData()')){handles.set('$'+s.id,'Autodesk.Revit.DB.Electrical.PanelScheduleData');result_preview={type:'Autodesk.Revit.DB.Electrical.PanelScheduleData'};}
  else if(s.memberId===SECTION){handles.set('$'+s.id,'Autodesk.Revit.DB.TableSectionData');result_preview={type:'Autodesk.Revit.DB.TableSectionData'};}
  else if(s.memberId===TEXT)result_preview='CU; 3/4"C W/2#12+1#12GRD';
  else if(s.memberId===HEIGHT)result_preview=.033;
  return {id:s.id,op:s.op,member_id:s.memberId,target_type,result_preview};});
 return {version:editing?'operator.native_api_mutation_ops.v1':'operator.native_api_ops.v2',ok:true,read_only:!editing,operation_count:operations.length,
  geometry_cleanup_errors:[] as any[],operations:receipts,results:Object.fromEntries(receipts.filter(s=>s.member_id===TEXT||s.member_id===HEIGHT).map(s=>[s.id,s.result_preview]))};
}
function fixture(){const ops=[call('panel','doc',GET,[41]),call('table','$panel',TABLE_GET,[]),call('footer','$table',SECTION,['Footer']),
 call('legend','$footer',SET_TEXT,[2,1,'CU; 3/4"C W/2#12+1#12GRD']),call('body','$table',SECTION,['Body']),call('height','$body',SET_HEIGHT,[2,.033])];
 const input={method:'POST',path:'/revit/native-api-mutation-ops',body:{operations:ops,transaction:{mode:'commit',maxAffectedElements:4,allowCreate:false,allowedExistingElementIds:[41,42]}}};
 const applied={...native(ops,true),mutation_operation_count:2,transaction:{mode:'commit',status:'committed',committed:true,dry_run:false,existing_scope_matched:true,scope_discovery_only:false,
  scope_baseline:'complete_native_document_ids_before_transaction',scope_baseline_element_count:100,scope_observer_executions:1,
  allowed_existing_element_ids:[41,42],commit_allowed_existing_element_ids:[41,42],unexpected_existing_element_ids:[] as number[],added_element_ids:[] as number[],deleted_element_ids:[] as number[],modified_element_ids:[41,42]}};
 const readOps=[call('schedule','doc',GET,[41]),call('read0','$schedule',TEXT,['Footer',2,1]),call('table','$schedule','method:Autodesk.Revit.DB.TableView.GetTableData()',[]),call('section0','$table',SECTION,['Body']),call('read1','$section0',HEIGHT,[2])];
 const readInput={method:'POST',path:'/revit/native-api-ops',body:{operations:readOps,returns:['$read0','$read1']}};
 return {input,applied,readInput,read:native(readOps,false)};
}
test('complete text and row-height graph matches exact native getter results, not commit label',()=>{
 const f=fixture();assert(nativeSchedulePresentationRequestV2(f.input));assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.applied),false);
});
test('regular schedules use the same native text/height proof; mixed graphs never fall through token matching',()=>{
 const f=fixture();f.input.body.operations[1]!.memberId='method:Autodesk.Revit.DB.ViewSchedule.GetTableData()';
 f.applied.operations[1]!.member_id=f.input.body.operations[1]!.memberId;
 for(const payload of [f.applied,f.read])for(const op of payload.operations){
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleView')op.target_type='Autodesk.Revit.DB.ViewSchedule';
  if(op.target_type==='Autodesk.Revit.DB.Electrical.PanelScheduleData')op.target_type='Autodesk.Revit.DB.TableData';
 }
 assert(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read));
 f.input.body.operations.push(call('other','$footer','method:Autodesk.Revit.DB.Parameter.Set(System.String)',['approved']));
 assert.equal(nativeSchedulePresentationRequestV2(f.input),null);
 assert.equal(postconditionSatisfiedByPayloadV2(f.input,{id:41,value:'approved'},{path:f.input.path}),false);
});
test('exact scope, complete graph, native identities and all values are mandatory',()=>{
 const failures:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
  ['wrong text',f=>f.read.results.read0='wrong'],['wrong height',f=>f.read.results.read1=.02],
  ['echo only',f=>{(f as any).read=f.readInput.body;}],['different UID',f=>f.read.operations[0]!.result_preview.unique_id='foreign'],
  ['missing native result',f=>{delete f.read.results.read1;}],['preview disagrees',f=>f.read.operations.at(-1)!.result_preview=.02],
  ['partial read',f=>f.read.operations.pop()],['wrong receiver',f=>f.read.operations[1]!.target_type='Autodesk.Revit.DB.Element'],
  ['different row',f=>f.readInput.body.operations[1]!.args[1]=3],['extra getter',f=>f.readInput.body.operations.push(call('extra','$schedule',TEXT,['Footer',3,1]))],
  ['rolled back',f=>f.applied.transaction.committed=false],['unknown spill',f=>f.applied.transaction.modified_element_ids.push(99)],
  ['duplicate inventory',f=>f.applied.transaction.modified_element_ids.push(41)],['created',f=>f.applied.transaction.added_element_ids.push(80)],
  ['deleted',f=>f.applied.transaction.deleted_element_ids.push(80)],['missing scope census',f=>f.applied.transaction.scope_baseline='unknown'],
  ['unobserved scope',f=>f.applied.transaction.scope_observer_executions=0],['wrong mutation count',f=>f.applied.mutation_operation_count=1],
  ['unsupported mutation',f=>f.input.body.operations.push(call('other','$panel','method:Autodesk.Revit.DB.Element.LookupParameter(System.String)',['Name']))],
  ['duplicate setter',f=>f.input.body.operations.push(call('again','$footer',SET_TEXT,[2,1,'another']))],
  ['forward handle',f=>f.input.body.operations[2]!.target='$missing'],['nonliteral size',f=>f.input.body.operations.at(-1)!.args[1]='$arg'],
 ];for(const[name,mutate]of failures){const f=fixture();mutate(f);assert.equal(nativeSchedulePresentationMatchesV2(f.input,f.applied,f.readInput,f.read),false,name);}
});
test('capability and target selectors require schedule getters, not lists, placements or generic echoes',()=>{
 const f=fixture(),apply={capability_id:'revit_call_tool',method:'POST',path:f.input.path,arguments:f.input},verification={capability_id:'revit_call_tool',...f.readInput,arguments:f.readInput};
 assert.equal(verificationCapabilityAdmissionV2({apply,verification}).admissible,true);
 assert.deepEqual(verificationCapabilityAdmissionV2({apply,verification}).admissible_readback_paths,['/revit/native-api-ops']);
 assert.equal(verificationCapabilityAdmissionV2({apply,verification:{capability_id:'revit_call_tool',path:'/revit/schedules',arguments:{body:{action:'list'}}}}).admissible,false);
 assert.deepEqual(operationTargetSelectorV2({operation:apply,value:f.input}).principal_target_tokens,['id:41']);
 assert.deepEqual(operationTargetSelectorV2({operation:verification,value:f.read}).principal_target_tokens,['id:41']);
 const unrelated=structuredClone(f.read);unrelated.operations[0]!.result_preview.id=42;
 assert.deepEqual(operationTargetSelectorV2({operation:verification,value:unrelated}).principal_target_tokens,['id:42']);
});
for(const variant of ['exact','wrong_text','wrong_height','foreign_uid','read_failure','wrong_digest','unretained_apply','paused_after_commit'] as const)
test(`ordinary SDK presentation ${variant} gets one separate internal read, never a repeated write`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-schedule-presentation-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=fixture(),goal=createGoal({title:'Compact schedule notes',objective:'Use compact wiring notation.',acceptance_criteria:['The requested schedule changes are established.'],status:'active',related_session_id:'presentation-session',created_by:'presentation-principal',work_budget:{requested_effect:'apply',document_fingerprint:'presentation-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'presentation-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding,calls:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},async validateToolArguments(_tool:string,args:any){if(args.path==='/revit/native-api-ops')assert.deepEqual(args,f.readInput);},
   async callTool(_tool:string,args:any,context:any){calls.push(args);const lease=context.assignmentKernelV2;context.onMcpAccepted();const reading=args.path==='/revit/native-api-ops';
    if(reading&&variant==='read_failure')throw Error('native_read_failed');
    const payload:any=structuredClone(reading?f.read:f.applied);
    if(reading){if(variant==='wrong_text')payload.results.read0='wrong';if(variant==='wrong_height')payload.results.read1=.02;if(variant==='foreign_uid')payload.operations[0].result_preview.unique_id='foreign';}
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    if(!reading&&variant==='paused_after_commit')controlAssignmentExecutionV2({binding,command_id:'user-pause',expected_command_id:null,action:'pause'});
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:reading?'none':'applied',native_transaction_state:reading?'not_applicable':'committed',authority:'native-host',affected_target_identities:reading?[]:['element_id:41','element_id:42'],result_schema_id:`operator-native/POST:${args.path}/v2`,observation_required:true,
      raw_payload_hash:reading&&variant==='wrong_digest'?'e'.repeat(64):digest(payload),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,request_identity:lease.request_identity,completed_at:new Date().toISOString()},
     observation:{raw_payload:!reading&&variant==='unretained_apply'?{ok:true}:payload,semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'presentation-task',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{await handleCodexDynamicToolCall(runtime,{id:'sdk-edit',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'presentation-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const snapshot=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(snapshot.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(calls.filter(c=>c.path===f.input.path).length,1);assert.equal(calls.filter(c=>c.path===f.readInput.path).length,['unretained_apply','paused_after_commit'].includes(variant)?0:1);
   const checked=apply.verification_operation_ids.some(id=>snapshot.operations[id]!.observation_ids.some(oid=>snapshot.observations[oid]!.facts.some(f=>f.fact_id==='verification.postcondition_satisfied'&&f.value===true)));
   assert.equal(checked,variant==='exact');assert.equal(Object.values(snapshot.operations).filter(o=>o.requested_effect==='apply').length,1);
   if(variant==='exact'){
    assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),false);
    const read=Object.values(snapshot.operations).find(o=>o.requested_effect==='read')!;
    assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,apply),null,'One internal read only');
    for(const mutate of [(s:any,a:any,r:any)=>s.unresolved_unknown_operation_ids=['older-unknown'],
      (s:any,a:any,r:any)=>s.input_invalidated_operation_ids=[a.operation_id],
      (s:any,a:any,r:any)=>a.binding={...a.binding,generation:2},
      (s:any,a:any,r:any)=>a.result.native_transaction_state='pending',
      (s:any,a:any,r:any)=>a.result.receipt_id='',
      (s:any,a:any,r:any)=>r.result.binding={...r.result.binding,run_id:'foreign'},
      (s:any,a:any,r:any)=>r.opened_at='2020-01-01T00:00:00Z',
      (s:any,a:any,r:any)=>r.admission_state='not_admitted',
      (s:any,a:any,r:any)=>r.result.request_identity.request_signature='foreign',
      (s:any,a:any,r:any)=>s.operations.later={...a,operation_id:'later'}]){
      const s=structuredClone(snapshot),a=s.operations[apply.operation_id]!,r=s.operations[read.operation_id]!;mutate(s,a,r);
      assert.equal(nativeSchedulePresentationPostconditionSatisfiedV2(s,a,r.result!,f.read),false);
    }
   }
   else if(variant!=='unretained_apply')assert.equal(deriveProgressGapsV2(snapshot).some(g=>g.gap_id==='verification:'+apply.operation_id),true);
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});}
});

test('read planning does not authorize unknown or unretained commits',()=>{
 const f=fixture(),binding={assignment_id:'test',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'op',binding,input:f.input,requested_effect:'apply',persistent_effect:'applied',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',request_identity:{path:f.input.path,request_signature:'sig'},observation_ids:[],verification_operation_ids:[],
 result:{operation_id:'op',binding,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',completed_at:'2026-10-14T23:30:00Z',request_identity:{request_signature:'sig'},receipt_id:'receipt',native_correlation_id:'native',affected_target_identities:['element_id:41','element_id:42']}};
 const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{op},observations:{}};
 assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,op),null);
 snapshot.unresolved_unknown_operation_ids=['older'];assert.equal(committedNativeSchedulePresentationReadbackPlanV2(snapshot,op),null);
});
