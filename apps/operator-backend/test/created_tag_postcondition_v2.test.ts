import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {createHash} from 'node:crypto';
import {createdTagRequestV2,createdTagReadbackMatchesV2,nativeCreatedTagReadTargetsV2,decodeNativeCreatedTagReadV2} from '../src/verification/created_tag_postcondition_v2.js';
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
const retained=()=>JSON.parse(fs.readFileSync('test/fixtures/created-tag-readback-43.json','utf8'));
const nativeLeader=(b:any)=>b.addLeader??(b.placementMode?.trim().toLowerCase()==='geometry_aware');

test('creation cannot certify ignored existing-tag repair arguments',()=>{
 for(const [field,value] of Object.entries({hasLeader:true,tagHeadPositionXyz:[1,2,3],leaderEndXyz:[1,2,3],leaderElbowXyz:[1,2,3],leaderEndCondition:'free'})){
  const f=retained();f.input.body[field]=value;
  assert.equal(createdTagRequestV2(f.input),null,field);
 }
});

test('ordinary creation derives the native leader default without inventing a repair request',()=>{
 for(const [mode,leader] of [[undefined,false],['offset',false],['geometry_aware',true]] as const){
  const f=retained();delete f.input.body.addLeader;
  if(mode===undefined)delete f.input.body.placementMode;else f.input.body.placementMode=mode;
  assert.equal(createdTagRequestV2(f.input)?.hasLeader,leader);
 }
});

test('retained296 mixed-mode request remains unverified despite a real committed tag',()=>{
 const f=JSON.parse(fs.readFileSync('test/fixtures/created-tag-mixed-mode-296.json','utf8').replace(/^\uFEFF/,''));
 assert.equal(f.applied.transaction.committed,true);
 assert.deepEqual(f.applied.tagIds,[1542953]);
 assert.equal(createdTagRequestV2(f.input),null);
 const explicit=structuredClone(f.input);explicit.body.addLeader=true;
 assert.equal(createdTagRequestV2(explicit),null,'Adding the missing leader flag cannot legitimize ignored repair geometry.');
});

test('native leader defaults retain explicit override and reject malformed values/modes',()=>{
 for(const mode of [undefined,'offset','geometry_aware',' GEOMETRY_AWARE '])for(const leader of [true,false]){
  const f=retained();f.input.body.addLeader=leader;f.input.body.placementMode=mode;
  assert.equal(createdTagRequestV2(f.input)?.hasLeader,leader);
 }
 for(const value of ['true',0,1,{}]){const f=retained();f.input.body.addLeader=value;assert.equal(createdTagRequestV2(f.input),null);}
 for(const value of ['somewhere',true,{}]){const f=retained();f.input.body.placementMode=value;assert.equal(createdTagRequestV2(f.input),null);}
 const f=retained();f.input.body.addLeader=null;f.input.body.placementMode=null;
 assert.equal(createdTagRequestV2(f.input)?.hasLeader,false);
});

test('retained49 native SpaceTag association, owner, type and orphan state can be verified separately from apply',()=>{
 const f=JSON.parse(fs.readFileSync('test/fixtures/created-space-tag-readback-49.json','utf8').replace(/^\uFEFF/,''));
 assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.read_input,f.native_read),true);
 assert.deepEqual(nativeCreatedTagReadTargetsV2(f.read_input),['id:1736674']);
});

test('retained51 ordinary default SpaceTag selection needs independent association/type readback',()=>{
 const f=JSON.parse(fs.readFileSync('test/fixtures/created-space-tag-default-readback-51.json','utf8'));
 assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.read_input,f.native_read),true);
 assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.input,f.applied),false);
 for(const mutate of [
  (x:any)=>delete x.applied.tagReadback,
  (x:any)=>x.applied.tagReadback.push(structuredClone(x.applied.tagReadback[0])),
  (x:any)=>x.applied.tagReadback[0].targetElementId++,
  (x:any)=>x.applied.tagReadback[0].viewId++,
  (x:any)=>x.applied.tagReadback[0].tagId++,
  (x:any)=>x.applied.tagReadback[0].tagTypeId=0,
  (x:any)=>x.applied.transaction.committed=false,
  (x:any)=>x.applied.tagFamily={status:'loaded',generatedFamilyPath:'not-covered.rfa'},
  (x:any)=>x.native_read.operations.find((o:any)=>o.member_id?.includes('GetTypeId')).result_preview.id++,
  (x:any)=>x.native_read.operations.find((o:any)=>o.property==='IsOrphaned').result_preview=true,
 ]){const x=structuredClone(f);mutate(x);assert.equal(createdTagReadbackMatchesV2(x.input,x.applied,x.read_input,x.native_read),false);}
});

test('spatial association adapter cannot accept IndependentTag, linked subject or omitted orphan proof',()=>{
 const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/created-space-tag-readback-49.json','utf8').replace(/^\uFEFF/,''));
 for(const mutate of [
  (f:any)=>f.native_read.operations.filter((o:any)=>o.target_type==='Autodesk.Revit.DB.Mechanical.SpaceTag').forEach((o:any)=>o.target_type='Autodesk.Revit.DB.IndependentTag'),
  (f:any)=>delete f.native_read.operations.find((o:any)=>o.property==='IsOrphaned').result_preview,
  (f:any)=>f.native_read.operations.find((o:any)=>o.property==='Space').result_preview.unique_id='linked-subject-not-local',
  (f:any)=>{f.applied.tagReadback[0].tagCategory='Room Tags';f.applied.tagReadback[0].targetCategory='Rooms';},
 ]){const f=fixture();mutate(f);assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.read_input,f.native_read),false);}
});

// Generated neighboring transport vectors. Only retained() is actual live
// evidence; no synthetic positive is presented as a completed Revit test.
function nativeRead(input:any,f:any){
 const original=f.native_read,spatial=f.applied.tagReadback?.find((r:any)=>['Space Tags','Room Tags'].includes(r.tagCategory));
 const subject=spatial?original.operations.find((o:any)=>o.property==='Space'||o.property==='Room').result_preview:original.results.subjects.items[0],identity=original.operations[0].result_preview;
 const nativeClass=spatial?.tagCategory==='Space Tags'?'Autodesk.Revit.DB.Mechanical.SpaceTag':spatial?'Autodesk.Revit.DB.Architecture.RoomTag':'Autodesk.Revit.DB.IndependentTag';
 const operations=input.body.operations.map((o:any)=>{
  if(o.target==='doc')return {id:o.id,op:o.op,member_id:o.memberId,target_type:'Autodesk.Revit.DB.Document',result_preview:o.args[0]===identity.id?identity:subject};
  const value=o.property==='OwnerViewId'?{id:f.input.body.viewId}:o.property==='HasLeader'?nativeLeader(f.input.body):o.property==='TagOrientation'?'Horizontal'
   :o.property==='IsOrphaned'?false:['Space','Room'].includes(o.property)?structuredClone(subject):o.memberId?.includes('GetTypeId')?{id:f.input.body.tagTypeId??f.applied.tagReadback[0].tagTypeId}:{deferred_enumeration:true};
  return {id:o.id,op:o.op,...(o.property?{property:o.property}:{member_id:o.memberId}),target_type:nativeClass,result_preview:value};
 });
 const results=Object.fromEntries(input.body.operations.filter((o:any)=>o.memberId?.includes('GetTaggedLocalElements')).map((o:any)=>[o.id,structuredClone(original.results.subjects)]));
 return {version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:operations.length,operations,results};
}

test('retained43 later type change is not proof of the earlier creation; apply-local readback is not a verifier',()=>{
 const f=retained();assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.read_input,f.native_read),false);
 assert.equal(createdTagReadbackMatchesV2(f.input,f.applied,f.input,f.applied),false);
});

for(const tagKind of ['independent','Space','Room'] as const)
for(const typeSelection of ['explicit','native_default'] as const)
for(const leaderSelection of ['explicit','default_offset','default_geometry'] as const)
for(const variant of ['exact','wrong_type','wrong_owner','wrong_subject','wrong_subject_unique_id','truncated','wrong_class','wrong_orientation','wrong_leader','read_failure','schema_rejected','paused','stale','foreign_authority','partial_apply','missing_created_inventory'] as const)
test(`ordinary ${tagKind} ${typeSelection} ${leaderSelection} tag creation ${variant}: independent native read validates created identity, subject, type and owner`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-created-tag-')),previous=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;__testOnlyResetGoalListCache();
 try{await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','test-only')},async()=>{
  const f=tagKind==='independent'?retained():JSON.parse(fs.readFileSync('test/fixtures/created-space-tag-readback-49.json','utf8').replace(/^\uFEFF/,''));
  f.input.body.orientation='Horizontal'; // Native accepts enum-style case, including retained305.
  if(leaderSelection!=='explicit'){
   delete f.input.body.addLeader;
   if(leaderSelection==='default_offset')delete f.input.body.placementMode;else f.input.body.placementMode='geometry_aware';
   f.applied.placementMode=leaderSelection==='default_offset'?'offset':'geometry_aware';
  }
  if(typeSelection==='native_default'){
   delete f.input.body.tagTypeId;
   // Generated no-family-load neighbor; the actual default-selection replay
   // is the retained51 fixture above, not this transport simulator.
   f.applied.tagFamily=null;
  }
  if(tagKind==='Room'){
   f.applied.tagReadback[0].tagCategory='Room Tags';f.applied.tagReadback[0].targetCategory='Rooms';
   const subject=f.native_read.operations.find((o:any)=>o.property==='Space');subject.property='Room';
   for(const o of f.native_read.operations)if(o.target_type==='Autodesk.Revit.DB.Mechanical.SpaceTag')o.target_type='Autodesk.Revit.DB.Architecture.RoomTag';
  }
  const tagId=f.applied.tagIds[0];
  if(variant==='partial_apply')f.applied.deferredCount=1;if(variant==='missing_created_inventory')f.applied.transaction.added_element_ids=[];
  const goal=createGoal({title:'Tag the marked outdoor device',objective:'Tag the marked outdoor device.',acceptance_criteria:['Requested device has its requested tag.'],status:'active',
   related_session_id:'created-tag-session',created_by:'created-tag-principal',work_budget:{requested_effect:'apply',document_fingerprint:'tag-model'}});
  createAssignmentKernelForGoalV2({goal,run_id:'tag-run'});const binding=getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
  const calls:any[]=[],validations:any[]=[];
  const runtime:any={assignmentKernelV2Binding:()=>binding,queueAssignmentKernelV2TurnStop(){},
   async validateToolArguments(_tool:string,a:any){validations.push(a);if(variant==='schema_rejected'&&a.path==='/revit/native-api-ops')throw Error('read_schema_rejected');},
   async callTool(_tool:string,a:any,context:any){
    calls.push(a);const lease=context.assignmentKernelV2;context.onMcpAccepted();const read=a.path==='/revit/native-api-ops';
    if(read&&variant==='read_failure')throw Error('native_read_failed');const payload=read?nativeRead(a,f):structuredClone(f.applied);
    if(read){
     const prop=(name:string)=>payload.operations.find((o:any)=>o.property===name);
     const type=payload.operations.find((o:any)=>o.member_id?.includes('GetTypeId'));
     const spatialSubject=payload.operations.find((o:any)=>o.property==='Space'||o.property==='Room');
     const refs=spatialSubject?{items:[spatialSubject.result_preview]}:Object.values(payload.results)[0] as any;
     if(variant==='wrong_type')type.result_preview.id=1480833;
     if(variant==='wrong_owner')prop('OwnerViewId').result_preview.id++;
     if(variant==='wrong_subject')refs.items[0].id++;
     if(variant==='wrong_subject_unique_id')refs.items[0].unique_id='different-native-unique-id';
     if(variant==='truncated'){if(spatialSubject)payload.operations.find((o:any)=>o.property==='IsOrphaned').result_preview=true;else refs.truncated=true;}
     if(variant==='wrong_class')prop('OwnerViewId').target_type='Autodesk.Revit.DB.TextNote';
     if(variant==='wrong_orientation')prop('TagOrientation').result_preview='Vertical';
     if(variant==='wrong_leader')prop('HasLeader').result_preview=!nativeLeader(f.input.body);
     // Structural admission and principal target extraction share the same graph.
     const admission=verificationCapabilityAdmissionV2({apply:{path:f.input.path,capability_id:'revit_call_tool',arguments:f.input},verification:{path:a.path,capability_id:'revit_call_tool',arguments:a}});
     assert(admission.admissible);assert.deepEqual(nativeCreatedTagReadTargetsV2(a),['id:'+tagId]);
     if(variant==='exact'){
      assert(decodeNativeCreatedTagReadV2(a,payload));
      assert.deepEqual(operationTargetSelectorV2({operation:{path:a.path,arguments:a},value:payload}).principal_target_tokens,['id:'+tagId]);
     }
    }
    if(!read&&variant==='paused')controlAssignmentExecutionV2({binding,command_id:'pause',expected_command_id:null,action:'pause'});
    const op=getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
    return {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',
     operation_result_v2:{schema:'revit-operator.operation-result/v2',result_id:'result:'+lease.operation_id,operation_id:lease.operation_id,binding,status:'succeeded',dispatch_state:'dispatched',
      persistent_effect:read?'none':'applied',native_transaction_state:read?'not_applicable':'committed',authority:read&&variant==='foreign_authority'?'model':'native-host',
      affected_target_identities:['element_id:'+tagId],result_schema_id:`operator-native/POST:${a.path}/v2`,observation_required:true,
      raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),receipt_id:'receipt:'+lease.operation_id,native_correlation_id:'native:'+lease.operation_id,
      request_identity:lease.request_identity,completed_at:read&&variant==='stale'?'2026-01-01T00:00:00Z':new Date().toISOString()},observation:{raw_payload:payload,
       semantic_facts:[{fact_id:op.fulfillment_role==='verification'?'verification.result_available':'control.result_available',fact_class:op.fulfillment_role==='verification'?'verification':'control',value:true}],verification_relevance:['control']}}};
   }};
  const owner=beginTeammateLoopOwner(runtime,{version:'operator.backend.v1',session_id:binding.session_id,message_id:'tag-create',user_text:goal.objective,assignment_id:binding.assignment_id,assignment_run_id:binding.run_id,assignment_generation:binding.generation} as any,{canonicalSupervisionOnly:true});
  try{
   const response:any=await handleCodexDynamicToolCall(runtime,{id:'create-tag',method:'item/tool/call',params:{namespace:'revit_operator',turnId:'tag-turn',tool:'revit_call_tool',arguments:f.input}} as any);
   __testOnlyResetGoalListCache();const s=getAssignmentKernelSnapshotV2(goal.id)!,apply=Object.values(s.operations).find(o=>o.requested_effect==='apply')!;
   assert.equal(response.success,true);assert.equal(apply.persistent_effect,'applied');assert.equal(calls.filter(a=>a.path==='/revit/tag-elements').length,1);
   const planned=!['paused','partial_apply','missing_created_inventory'].includes(variant);
   assert.equal(validations.filter(a=>a.path==='/revit/native-api-ops').length,planned?(variant==='schema_rejected'?1:2):0,'Reservation and dispatch each validate the read; schema refusal stops before reservation.');
   assert.equal(calls.filter(a=>a.path==='/revit/native-api-ops').length,planned&&variant!=='schema_rejected'?1:0);
   const verified=apply.verification_operation_ids.some(id=>s.operations[id]!.observation_ids.some(oid=>s.observations[oid]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true)));
   assert.equal(verified,variant==='exact');assert.equal(deriveProgressGapsV2(s).some(g=>g.gap_id==='verification:'+apply.operation_id),variant!=='exact');
  }finally{endTeammateLoopOwner(owner);}
 });}finally{__testOnlyResetGoalListCache();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});


test('retained305 native orientation case normalizes without accepting a parameter-only association check',()=>{
 const input=JSON.parse(fs.readFileSync('test/fixtures/created-tag-orientation-305.json','utf8'));
 assert.equal(createdTagRequestV2(input)?.orientation,'horizontal');
 const apply={capability_id:'revit_call_tool',arguments:input,path:input.path} as any;
 const read={capability_id:'revit_call_tool',arguments:{method:'POST',path:'/revit/get-parameters',body:{elementIds:[1542954,1542955]}},path:'/revit/get-parameters'} as any;
 const admission=verificationCapabilityAdmissionV2({apply,verification:read});
 assert.equal(admission.admissible,false);assert.deepEqual(admission.required_semantic_outputs,['tag.created_subject_association']);
 for(const orientation of ['Horizontal',' horizontal ','VERTICAL',' Vertical '])assert.equal(createdTagRequestV2({...input,body:{...input.body,orientation}})?.orientation,orientation.trim().toLowerCase());
 for(const orientation of ['diagonal',{},true,3])assert.equal(createdTagRequestV2({...input,body:{...input.body,orientation}}),null);

});
