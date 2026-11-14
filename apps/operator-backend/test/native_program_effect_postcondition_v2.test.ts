import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/index.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {dynamicProgramParameterPostconditionSatisfiedV2 as match} from '../src/verification/native_program_parameter_postcondition_v2.js';
import {committedNativeProgramEffectReadbackPlanV2 as plan} from '../src/verification/native_program_effect_postcondition_v2.js';
import {verificationCapabilityGuidanceV2 as guidance} from '../src/verification/verification_capability_admission_v2.js';
import {nativeDraftingInspectionTargetsV2} from '../src/assignments/native_drafting_inspection.js';
import {retainWorkPlanInspectionV2} from '../src/assignments/work_plan_inspection.js';
import {completeWorkPlanItemV2} from '../src/domain/assignment-kernel/work_plan.js';
import {qualifiedLargeInspectionDiscoveryV2} from '../src/assignments/large_inspection_discovery.js';
import {nativeProgramResultScopeNoticeV2} from '../src/verification/native_program_effect_postcondition_v2.js';
import {verifiedDeliverableTargetGroupsV2} from '../src/verification/verified_deliverable_targets_v2.js';
import {checkedEditIsCurrentV2,checkedReadIsCurrentV2} from '../src/verification/current_postcondition_v2.js';
import {codexAssignmentEvidenceContextV2} from '../src/brains/codex_assignment_evidence.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function state(id:number,found=true){const json=JSON.stringify({elementId:id,found,identity:found?'native-'+id:null,geometry:found?{kind:'Line',start:[0,0,0],end:[1,0,0]}:null});
 return {elementId:id,found,complete:true,stateJson:json,stateHash:'sha256:'+sha(json)};}
function fixture(mutate?:(p:any,input:any)=>void,trust:any='authoritative_native'){
 const binding={assignment_id:'assignment',run_id:'run',session_id:'session',generation:1,principal_id:'local:shared-token',document_fingerprint:'c'.repeat(64)};
 const source='public class Draw { public static string Execute(Autodesk.Revit.DB.Document d) { return "not verification"; } }';
 const input:any={mode:'apply',source,native_program:{entry_type:'Draw',effect_scope:'active_document'}};
 const fingerprint='sha256:'+binding.document_fingerprint,sourceHash='sha256:'+sha(source);
 const observation={scope:'native_drafting_effect_state_v1',documentFingerprint:fingerprint,documentSessionId:'native-session',complete:true,
  requestedElementIds:[41,42,43],items:[state(41),state(42),state(43,false)]};
 const receipt={schema:'dynamic-revit-native-execution-receipt/v1',preparation_id:'prep',source_hash:sourceHash,success:true,verified:false,
  document_fingerprint:fingerprint,document_session_id:'native-session',effect_observation:observation,
  transaction:{status:'committed',committed:true,added_element_ids:[41],modified_element_ids:[42],deleted_element_ids:[43],affected_element_ids:[41,42,43]}};
 const payload:any={schema:'revit-operator.dynamic-revit-program-run.v1',execution_lane:'native',requested_mode:'apply',execution_status:'completed',execution_ok:true,
  iteration:{source_sha256:sourceHash},native_outcome:{persistent_effect:'applied',native_transaction_state:'committed',task_verified:false,verification_required:true},
  evidence:{schema:'dynamic-revit-native-program-evidence/v1',ok:true,nativeExecutionReceipt:JSON.stringify(receipt),snapshotReceipt:JSON.stringify({Schema:'dynamic-revit-native-preparation/v1',PreparationId:'prep',SourceHash:sourceHash,Document:{ProjectFingerprint:fingerprint,SessionId:'native-session'}})}};
 mutate?.(payload,input);
 const ref=storeEvidence({scope:{...binding,attempt_id:'apply'},source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:trust,raw:payload}).ref;
 const request={capability_id:'operator_run_dynamic_revit_program',request_signature:sha(canonicalJsonV2({capability_id:'operator_run_dynamic_revit_program',input}))};
 const subject:any={operation_id:'apply',binding,input,capability_id:'operator_run_dynamic_revit_program',requested_effect:'apply',admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',persistent_effect:'applied',observation_ids:['obs'],verification_operation_ids:[],request_identity:request,
  result:{operation_id:'apply',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',result_schema_id:'operator-dynamic-runtime/mcp-program/v2',receipt_id:'native-apply',native_correlation_id:'native-apply',request_identity:request,raw_payload_hash:payloadDigestV2(payload).digest,affected_target_identities:['element_id:41','element_id:42','element_id:43'],completed_at:'2026-11-08T10:00:01Z'}};
 const body={elementIds:[41,42,43],includeNativeProgramEffectState:true};
 const op:any={operation_id:'read',binding,input:{method:'POST',path:'/revit/get-element-summary',body},request_identity:{method:'POST',path:'/revit/get-element-summary',request_signature:'read-signature'},purpose:'verification',fulfillment_role:'verification',verification_of_operation_id:'apply',requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',opened_at:'2026-11-08T10:00:02Z'};
 const fresh:any={nativeProgramEffectState:structuredClone(observation)};
 const result:any={operation_id:'read',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',request_identity:op.request_identity,receipt_id:'native-read',native_correlation_id:'native-read',raw_payload_hash:payloadDigestV2(fresh).digest,completed_at:'2026-11-08T10:00:03Z'};
 const snapshot:any={current_binding:binding,terminal:false,outcome:'active',operations:{apply:subject,read:op},observations:{obs:{operation_id:'apply',binding,authority:'native-host',evidence_class:'task_result',raw_payload_hash:subject.result.raw_payload_hash,raw_payload_ref:'evidence:'+ref.evidence_id}},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[]};
 return {snapshot,subject,op,result,fresh,payload};
}
function workspace(fn:()=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT,p=fs.mkdtempSync(path.join(os.tmpdir(),'native-effect-state-'));process.env.OPERATOR_WORKSPACE_ROOT=p;
 try{fn();}finally{__closeForTests();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(p,{recursive:true,force:true});}}

function inspectionFixture(){
 const f=fixture();assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 f.subject.verification_operation_ids=['read'];f.op.settlement_state='settled';f.op.result=f.result;f.op.observation_ids=['verified'];
 f.snapshot.observations.verified={operation_id:'read',binding:f.subject.binding,authority:'native-host',facts:[
  {fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},
  {fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:['element_id:41','element_id:42','element_id:43']} ]};
 const data:any={result:[{id:41,found:true,uniqueId:'uid41',className:'DetailLine',typeId:10},{id:42,found:true,uniqueId:'uid42',className:'DetailLine',typeId:10},{id:43,found:false,error:'Element not found'}],nativeProgramEffectState:structuredClone(f.fresh.nativeProgramEffectState)};
 data.nativeProgramEffectState.nativeVersion={ProcessId:1234,Epoch:'epoch',DocumentSessionId:'native-session',Sequence:1};
 const op:any={...f.op,operation_id:'inspection',purpose:'discovery',opened_at:'2026-11-08T10:00:05Z',verification_of_operation_id:undefined,observation_ids:['inspection-observation']};
 op.result={...f.result,operation_id:op.operation_id,result_schema_id:'operator-native/POST:/revit/get-element-summary/v2',raw_payload_hash:payloadDigestV2(data).digest,completed_at:'2026-11-08T10:00:06Z'};
 const stored=storeEvidence({scope:{...f.subject.binding,attempt_id:op.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:data}).ref;
 f.snapshot.operations.inspection=op;f.snapshot.observations['inspection-observation']={operation_id:op.operation_id,binding:op.binding,authority:'native-host',raw_payload_hash:op.result.raw_payload_hash,raw_payload_ref:'evidence:'+stored.evidence_id};
 f.snapshot.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[
  {item_id:'drawing',kind:'edit',declared_at:'2026-11-08T09:00:00Z',completed_at:'2026-11-08T10:00:04Z',operation_ids:['apply']},
  {item_id:'inspection',kind:'inspection',depends_on:['drawing'],declared_at:'2026-11-08T09:00:00Z',operation_ids:[]} ]};
 return {...f,data,inspection:op};
}

test('final native inspection covers corrected drawing including verified deletion without erasing expected targets',()=>workspace(()=>{
 const f=inspectionFixture();assert.deepEqual(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),[41,42,43]);
 const proof=retainWorkPlanInspectionV2(f.snapshot,['inspection']);assert.deepEqual(proof.target_ids,['element_id:41','element_id:42','element_id:43']);
 const completed=completeWorkPlanItemV2(f.snapshot,'inspection',['inspection'],'2026-11-08T10:00:07Z',proof);
 assert.equal(completed.items[1]!.completed_at,'2026-11-08T10:00:07Z');assert.equal(f.snapshot.work_plan.items[1].completed_at,undefined,'pure replay does not mutate history');
}));

function mixedInspectionFixture(){
 const f=inspectionFixture();
 // PNG14: an unchanged WorkPlaneGrid has ordinary identity coverage but no
 // native program state. Two verified deletions in the same read remain exact.
 f.data.result[1].className='Element';
 f.data.nativeProgramEffectState.complete=false;
 f.data.nativeProgramEffectState.items[1]={elementId:42,complete:false,found:null,stateJson:null,stateHash:null,reason:'unsupported_native_effect_class:Element'};
 const stored=storeEvidence({scope:{...f.inspection.binding,attempt_id:f.inspection.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:f.data}).ref;
 f.inspection.result.raw_payload_hash=payloadDigestV2(f.data).digest;
 f.snapshot.observations['inspection-observation'].raw_payload_hash=f.inspection.result.raw_payload_hash;
 f.snapshot.observations['inspection-observation'].raw_payload_ref='evidence:'+stored.evidence_id;
 return f;
}

test('mixed final inspection composes surviving identity coverage and verified deletion coverage from one read',()=>workspace(()=>{
 const f=mixedInspectionFixture(),before=JSON.stringify(f.data);
 assert.deepEqual(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),[41,42,43]);
 const proof=retainWorkPlanInspectionV2(f.snapshot,['inspection']);
 assert.deepEqual(proof.target_ids,['element_id:41','element_id:42','element_id:43']);
 const completed=completeWorkPlanItemV2(f.snapshot,'inspection',['inspection'],'2026-11-08T10:00:07Z',proof);
 assert.ok(completed.items[1]!.completed_at);
 assert.equal(JSON.stringify(f.data),before,'raw partial observation is never promoted to complete');
 assert.equal(f.snapshot.work_plan.items[1].completed_at,undefined,'history remains unchanged');
 assert.equal(match(f.snapshot,f.subject,{...f.result,raw_payload_hash:payloadDigestV2(f.data).digest},f.data),false,'inspection coverage is not verification of an edit');
}));

test('mixed inspection rejects unavailable deletion, read failures, malformed coverage, and unverified absence',()=>workspace(()=>{
 for(const mutate of [
  (f:any)=>f.data.nativeProgramEffectState.items[1].reason='native_state_read_failed:failed',
  (f:any)=>f.data.nativeProgramEffectState.items[1].reason='native_state_item_oversize',
  (f:any)=>f.data.nativeProgramEffectState.items[1].found=false,
  (f:any)=>f.data.nativeProgramEffectState.items[1].stateJson='{}',
  (f:any)=>f.data.nativeProgramEffectState.items[1].stateHash='sha256:bad',
  (f:any)=>f.data.nativeProgramEffectState.items[1].reason='unsupported_native_effect_class:Foreign',
  (f:any)=>f.data.nativeProgramEffectState.items[1].elementId=43,
  (f:any)=>f.data.nativeProgramEffectState.requestedElementIds=[41,43,42],
  (f:any)=>f.data.nativeProgramEffectState.items.pop(),
  (f:any)=>f.data.nativeProgramEffectState.complete=true,
  (f:any)=>f.data.nativeProgramEffectState.items[2]={...f.data.nativeProgramEffectState.items[1],elementId:43},
  (f:any)=>f.data.nativeProgramEffectState.items[0].stateHash='wrong',
  (f:any)=>f.data.result[1].uniqueId='',
  (f:any)=>f.subject.verification_operation_ids=[],
  (f:any)=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (f:any)=>f.inspection.opened_at='2026-11-08T09:00:00Z',
  (f:any)=>f.data.nativeProgramEffectState.documentFingerprint='foreign',
  (f:any)=>delete f.data.nativeProgramEffectState.nativeVersion,
 ]){const f=mixedInspectionFixture();mutate(f);assert.equal(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),null);}
 const f=mixedInspectionFixture();f.inspection.result.raw_payload_hash='foreign';
 assert.throws(()=>retainWorkPlanInspectionV2(f.snapshot,['inspection']));
}));

test('inspection absence requires actual verified deletion plus complete fresh bound native state',()=>workspace(()=>{
 for(const mutate of [
  (f:any)=>f.subject.verification_operation_ids=[],(f:any)=>f.subject.result.status='failed',
  (f:any)=>f.subject.input.source+='foreign',(f:any)=>f.inspection.input={...f.inspection.input,body:{elementIds:[41,42,43]}},
  (f:any)=>f.data.nativeProgramEffectState.complete=false,(f:any)=>f.data.nativeProgramEffectState.items[2].stateHash='wrong',
  (f:any)=>f.data.nativeProgramEffectState.documentFingerprint='foreign',(f:any)=>delete f.data.nativeProgramEffectState.nativeVersion,
  (f:any)=>f.data.result[2].found=true,(f:any)=>f.data.result[2].error='Read failed',
  (f:any)=>f.data.result[0].uniqueId='',(f:any)=>f.data.result[0].className='IndependentTag',
  (f:any)=>f.inspection.opened_at='2026-11-08T09:00:00Z',(f:any)=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (f:any)=>f.inspection.result.request_identity={...f.inspection.request_identity,request_signature:'foreign'},
  (f:any)=>f.snapshot.input_invalidated_operation_ids=['inspection'],
  (f:any)=>f.snapshot.operations.later={...f.subject,operation_id:'later',result:{...f.subject.result,completed_at:'2026-11-08T10:00:08Z'}},
 ]){const f=inspectionFixture();mutate(f);assert.equal(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),null);}
}));

test('bounded large inspection preserves unique identity across chunks and rejects unsupported missing rows',()=>workspace(()=>{
 const f=inspectionFixture(),extra=Array.from({length:550},(_,i)=>i+100);
 f.inspection.input=structuredClone(f.inspection.input);
 f.inspection.input.body.elementIds.push(...extra);
 f.data.result.push(...extra.map(id=>({id,found:true,uniqueId:'uid'+id,className:'DetailLine',typeId:10})));
 f.data.nativeProgramEffectState.requestedElementIds.push(...extra);
 f.data.nativeProgramEffectState.items.push(...extra.map(id=>state(id)));
 assert.equal(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data)?.length,553);
 f.data.result.at(-1).uniqueId=f.data.result[0].uniqueId;
 assert.equal(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),null,'duplicate identity across chunks');
 f.data.result.at(-1).uniqueId='uid649';f.data.result.at(-1).found=false;f.data.result.at(-1).error='Element not found';
 f.data.nativeProgramEffectState.items[f.data.nativeProgramEffectState.items.length-1]=state(649,false);
 assert.equal(nativeDraftingInspectionTargetsV2(f.snapshot,f.inspection,f.data),null,'absence without a verified deletion');
}));

function largeDiscoveryFixture(){
 const f=inspectionFixture(),extra=Array.from({length:550},(_,i)=>i+100);
 f.inspection.input=structuredClone(f.inspection.input);f.inspection.input.body.elementIds.push(...extra);
 f.data.result.push(...extra.map(id=>({id,found:true,uniqueId:'uid'+id,className:'DetailLine',typeId:10})));
 f.data.nativeProgramEffectState.requestedElementIds.push(...extra);
 f.data.nativeProgramEffectState.items.push(...extra.map(id=>state(id)));
 Object.assign(f.inspection,{admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled'});
 const stored=storeEvidence({scope:{...f.subject.binding,attempt_id:f.inspection.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:f.data}).ref;
 f.inspection.result.raw_payload_hash=payloadDigestV2(f.data).digest;
 f.snapshot.observations['inspection-observation'].raw_payload_hash=f.inspection.result.raw_payload_hash;
 f.snapshot.observations['inspection-observation'].raw_payload_ref='evidence:'+stored.evidence_id;
 return f;
}

test('large fresh native inspection is discoverable without completing work or changing verification',()=>workspace(()=>{
 const f=largeDiscoveryFixture(),before=JSON.stringify(f.snapshot);
 assert.equal(qualifiedLargeInspectionDiscoveryV2(f.snapshot,f.inspection),true);
 assert.equal(JSON.stringify(f.snapshot),before);
}));

test('large inspection discovery keeps native trust, freshness, Pause and unknown boundaries',()=>workspace(()=>{
 const changes=[
  (f:any)=>f.snapshot.terminal=true,
  (f:any)=>f.snapshot.outcome='blocked',
  (f:any)=>f.snapshot.execution_control={state:'paused'},
  (f:any)=>f.snapshot.provider_usage_hold={reason:'pending'},
  (f:any)=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (f:any)=>f.snapshot.in_flight_operation_ids=['pending'],
  (f:any)=>f.snapshot.input_invalidated_operation_ids=['inspection'],
  (f:any)=>f.inspection.result.raw_payload_hash='foreign',
  (f:any)=>f.inspection.result.binding={...f.inspection.binding,generation:2},
  (f:any)=>f.inspection.result.status='failed_after_dispatch',
  (f:any)=>delete f.inspection.result.receipt_id,
  (f:any)=>f.inspection.opened_at='2026-11-08T09:00:00Z',
  (f:any)=>f.inspection.input.body.elementIds.push(41),
  (f:any)=>f.inspection.input.body.elementIds=Array.from({length:4097},(_,i)=>i+1),
  (f:any)=>delete f.inspection.input.body.includeNativeProgramEffectState,
  (f:any)=>f.snapshot.work_plan.items.find((i:any)=>i.kind==='inspection').completed_at='2026-11-08T10:00:04Z',
  (f:any)=>f.snapshot.work_plan.items.find((i:any)=>i.kind==='inspection').deferrals=[{reason:'deferred'}],
  (f:any)=>f.subject.persistent_effect='unknown',
  (f:any)=>f.subject.result.completed_at='2026-11-08T10:00:07Z',
 ];
 for(const change of changes){const f=largeDiscoveryFixture();change(f);assert.equal(qualifiedLargeInspectionDiscoveryV2(f.snapshot,f.inspection),false,String(change));}
}));

function opaqueFixture(change?:(receipt:any)=>void){
 const f=fixture(p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);
  r.document_revision_before=6;
  const prepared=JSON.parse(p.evidence.snapshotReceipt);prepared.Scope={DocumentRevision:6};p.evidence.snapshotReceipt=JSON.stringify(prepared);
  r.effect_observation.nativeVersion={ProcessId:1234,Epoch:'native-epoch',DocumentSessionId:'native-session',Sequence:7};
  const json=JSON.stringify({elementId:42,found:true,uniqueId:'native-42',className:'Element',name:'',ownerViewId:-1,typeUniqueId:null,parameters:[],
   shape:{kind:'opaque_element_public_state',category:null,typeId:-1,location:null,box:null,privateStateInspected:false}});
  r.effect_observation.items[1]={elementId:42,found:true,complete:true,stateJson:json,stateHash:'sha256:'+sha(json)};
  change?.(r);p.evidence.nativeExecutionReceipt=JSON.stringify(r);
 });
 f.fresh.nativeProgramEffectState=JSON.parse(f.payload.evidence.nativeExecutionReceipt).effect_observation;
 f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;return f;
}

// Electrical rehosting changes several native classes in one commit. Public
// observations are not exhaustive geometry/connection proof: continuity must
// be native-version-bound, even when all exposed values happen to match.
function publicElementFixture(className='FamilyInstance',change?:(receipt:any)=>void){
 return opaqueFixture(r=>{
  const item=r.effect_observation.items[1],s=JSON.parse(item.stateJson);
  s.className=className;
  s.shape={kind:'public_element_observation',category:'Electrical Fixtures',typeId:55,
   location:{kind:'point',point:{x:1,y:2,z:3},rotation:0},box:null,
   observedFields:['identity','parameters','location','modelBoundingBox'],
   privateStateInspected:false,geometryTopologyInspected:false};
  item.stateJson=JSON.stringify(s);item.stateHash='sha256:'+sha(item.stateJson);change?.(r);
 });
}
test('general native public-state contract covers sheet collateral without claiming class-specific inspection',()=>workspace(()=>{
 // Exact classes rejected by full43b SheetEdit, plus an unrelated native class.
 for(const cls of ['ViewSchedule','ViewSheet','ScheduleSheetInstance','Viewport','ViewSheetSet','Wall']){
  const f=publicElementFixture(cls,r=>{const i=r.effect_observation.items[1],s=JSON.parse(i.stateJson);
   s.shape.nativeType={assembly:'RevitAPI',fullName:'Autodesk.Revit.DB.'+cls,baseType:'Autodesk.Revit.DB.Element'};
   i.stateJson=JSON.stringify(s);i.stateHash='sha256:'+sha(i.stateJson);
  });
  assert.ok(plan(f.snapshot,f.subject),cls);assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true,cls);
  f.fresh.nativeProgramEffectState.nativeVersion.Sequence++;
  f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;
  assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false,'Same public values never replace continuity');
 }
}));
test('generic native descriptors never promote foreign, malformed or incomplete observations',()=>workspace(()=>{
 for(const change of [
  (s:any)=>s.shape.nativeType.assembly='GeneratedProgram',
  (s:any)=>s.shape.nativeType.fullName='Generated.ViewSheet',
  (s:any)=>s.shape.nativeType.fullName='Autodesk.Revit.DB.Viewport',
  (s:any)=>s.shape.nativeType.baseType='System.Object',
  (s:any)=>s.className='Element',
  (s:any)=>delete s.shape.observedFields,
  (s:any)=>s.shape.geometryTopologyInspected=true,
 ]){
  const f=publicElementFixture('ViewSheet',r=>{const i=r.effect_observation.items[1],s=JSON.parse(i.stateJson);
   s.shape.nativeType={assembly:'RevitAPI',fullName:'Autodesk.Revit.DB.ViewSheet',baseType:'Autodesk.Revit.DB.Element'};change(s);
   i.stateJson=JSON.stringify(s);i.stateHash='sha256:'+sha(i.stateJson);
  });assert.equal(plan(f.snapshot,f.subject),null);
 }
 // A native descriptor cannot repair the actual historical incomplete receipt.
 const f=publicElementFixture('ViewSheet',r=>{r.effect_observation.complete=false;});
 assert.equal(plan(f.snapshot,f.subject),null);
}));
test('public electrical effect observations require unchanged native version and explicit limited scope',()=>workspace(()=>{
 for(const cls of ['View','Space','FamilyInstance','ElectricalSystem','IndependentTag']){
  const f=publicElementFixture(cls);assert.ok(plan(f.snapshot,f.subject));assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
  for(const key of ['ProcessId','Epoch','DocumentSessionId','Sequence']){
   const changed=publicElementFixture(cls);changed.fresh.nativeProgramEffectState.nativeVersion[key]=key==='Sequence'?8:key==='ProcessId'?4321:'foreign';
   changed.result.raw_payload_hash=payloadDigestV2(changed.fresh).digest;
   assert.equal(match(changed.snapshot,changed.subject,changed.result,changed.fresh),false,cls+':'+key);
  }
 }
 for(const change of [(r:any)=>delete r.effect_observation.nativeVersion,(r:any)=>delete r.document_revision_before]){
  const f=publicElementFixture('FamilyInstance',change);assert.equal(plan(f.snapshot,f.subject),null);
 }
 for(const cls of ['ForeignClass','Element','Wall']){const f=publicElementFixture(cls);assert.equal(plan(f.snapshot,f.subject),null);}
 for(const field of ['privateStateInspected','geometryTopologyInspected']){
  const f=publicElementFixture('FamilyInstance',r=>{const item=r.effect_observation.items[1],s=JSON.parse(item.stateJson);s.shape[field]=true;item.stateJson=JSON.stringify(s);item.stateHash='sha256:'+sha(item.stateJson);});
  assert.equal(plan(f.snapshot,f.subject),null,'Unsupported coverage claim: '+field);
 }
}));

test('native region contours, fill and sketch/dimension references must persist independently of equal bounding boxes',()=>workspace(()=>{
 const shapes=[{kind:'filled_region',box:[0,0,1,1],boundaries:[[[0,0],[1,0],[0,1]]],regionType:{foreground:{solid:true},foregroundColor:{r:0,g:0,b:0}}},
  {kind:'sketch',profile:[[[0,0],[1,0],[0,1]]],memberIds:[11,12,13]},
  {kind:'dimension',curve:{kind:'Line',isBound:false,origin:[0,0,0],direction:[1,0,0]},value:1,locked:true,references:[{elementId:11,stable:'native-reference'}]}];
 for(const shape of shapes){const f=fixture(p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt),json=JSON.stringify({elementId:42,found:true,shape});
   r.effect_observation.items[1]={elementId:42,found:true,complete:true,stateJson:json,stateHash:'sha256:'+sha(json)};p.evidence.nativeExecutionReceipt=JSON.stringify(r);});
  f.fresh.nativeProgramEffectState=JSON.parse(f.payload.evidence.nativeExecutionReceipt).effect_observation;
  f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
  const item=f.fresh.nativeProgramEffectState.items[1],s=JSON.parse(item.stateJson);
  if(shape.kind==='filled_region')s.shape.boundaries[0][1][0]=0.9;
  if(shape.kind==='sketch')s.shape.memberIds[0]=99;
  if(shape.kind==='dimension')s.shape.references[0].stable='other-native-reference';
  item.stateJson=JSON.stringify(s);item.stateHash='sha256:'+sha(item.stateJson);f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;
  assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);
 }
}));

test('opaque native internals require trusted unchanged native continuity, never pretend field inspection',()=>workspace(()=>{
 const f=opaqueFixture();assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 for(const change of [
  (r:any)=>delete r.effect_observation.nativeVersion,
  (r:any)=>r.document_revision_before=7,
  (r:any)=>delete r.document_revision_before,
  (r:any)=>r.effect_observation.nativeVersion.DocumentSessionId='foreign',
  (r:any)=>r.effect_observation.nativeVersion.Sequence=-1,
  (r:any)=>r.effect_observation.nativeVersion.ProcessId=0,
 ]){const x=opaqueFixture(change);assert.equal(match(x.snapshot,x.subject,x.result,x.fresh),false);assert.equal(plan(x.snapshot,x.subject),null);}
 for(const key of ['ProcessId','Epoch','DocumentSessionId','Sequence']){const x=opaqueFixture();
  x.fresh.nativeProgramEffectState.nativeVersion[key]=key==='Sequence'?8:key==='ProcessId'?4321:'foreign';
  x.result.raw_payload_hash=payloadDigestV2(x.fresh).digest;assert.equal(match(x.snapshot,x.subject,x.result,x.fresh),false);}
 const missing=opaqueFixture();delete missing.fresh.nativeProgramEffectState.nativeVersion;
 missing.result.raw_payload_hash=payloadDigestV2(missing.fresh).digest;assert.equal(match(missing.snapshot,missing.subject,missing.result,missing.fresh),false);
 for(const change of [
  (s:any)=>s.shape.privateStateInspected=true,(s:any)=>s.className='FamilyInstance',
  (s:any)=>s.shape.category='Ducts',(s:any)=>s.shape.typeId=45,(s:any)=>s.shape.box={min:[0,0,0]},
  (s:any)=>s.shape.location={x:0},(s:any)=>s.typeUniqueId='type-45',(s:any)=>delete s.parameters,
  (s:any)=>s.shape.kind='pretend_known_geometry',
 ]){const x=opaqueFixture(r=>{const item=r.effect_observation.items[1],s=JSON.parse(item.stateJson);change(s);
   item.stateJson=JSON.stringify(s);item.stateHash='sha256:'+sha(item.stateJson);});
  assert.equal(match(x.snapshot,x.subject,x.result,x.fresh),false);}
 const changed=opaqueFixture();changed.fresh.nativeProgramEffectState.items[0]=state(41,false);
 changed.result.raw_payload_hash=payloadDigestV2(changed.fresh).digest;assert.equal(match(changed.snapshot,changed.subject,changed.result,changed.fresh),false,'continuity never replaces public field equality');
 for(const mutate of [(x:any)=>x.snapshot.execution_control={state:'paused'},(x:any)=>x.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (x:any)=>x.subject.result.raw_payload_hash='foreign',(x:any)=>x.subject.input.source+='//changed']){
  const x=opaqueFixture();mutate(x);assert.equal(match(x.snapshot,x.subject,x.result,x.fresh),false);
 }
}));

test('host-captured actual native drafting state matches a distinct linked native read, including deletion',()=>workspace(()=>{
 const f=fixture();assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 assert.deepEqual(plan(f.snapshot,f.subject),f.op.input);f.subject.verification_operation_ids=['read'];assert.equal(plan(f.snapshot,f.subject),null,'never repeat automatic read');
 const historical=fixture(p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);delete r.effect_observation;p.evidence.nativeExecutionReceipt=JSON.stringify(r);});
 assert.equal(match(historical.snapshot,historical.subject,historical.result,historical.fresh),false,'no historical backfill');
}));

test('partial, forged, changed, missing, stale, foreign, Pause and unknown observations remain unverified',()=>workspace(()=>{
 const mutations:Array<(f:any)=>void>=[f=>f.fresh.nativeProgramEffectState.complete=false,f=>f.fresh.nativeProgramEffectState.items[0].complete=false,
  f=>f.fresh.nativeProgramEffectState.items[0].stateHash='sha256:'+'0'.repeat(64),f=>f.fresh.nativeProgramEffectState.items.pop(),
  f=>f.fresh.nativeProgramEffectState.items[2]=state(43),f=>f.fresh.nativeProgramEffectState.documentSessionId='foreign',
  f=>f.fresh.nativeProgramEffectState.requestedElementIds=[41,42],f=>f.op.input.body.elementIds=[41],f=>f.op.input.body.includeNativeProgramEffectState=false,
  f=>f.op.verification_of_operation_id='other',f=>f.op.purpose='discovery',f=>f.result.authority='assistant',f=>f.result.request_identity={...f.result.request_identity,request_signature:'foreign'},
  f=>f.op.input.path='/revit/other',f=>f.fresh.success=false,
  f=>f.op.opened_at='2026-11-08T09:00:00Z',f=>f.snapshot.execution_control={state:'paused'},f=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  f=>f.snapshot.operations.later={...f.subject,operation_id:'later',opened_at:'2026-11-08T10:00:02Z'},f=>f.snapshot.input_invalidated_operation_ids=['apply']];
 for(const mutate of mutations){const f=fixture();mutate(f);f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);}
 for(const trust of ['host_observed','untrusted_caller']){const f=fixture(undefined,trust);assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);}
}));

test('model-visible guidance distinguishes native persistence from task and file proof without replay',()=>{
 const text=guidance({capability_id:'operator_run_dynamic_revit_program',arguments:{native_program:{entry_type:'Draw'}}});
 assert.match(text!,/every actual affected ID/);assert.match(text!,/not arbitrary C# semantic correctness/);assert.match(text!,/code\/intent review/);
 assert.match(text!,/historical calls without that witness remain unverified/);assert.match(text!,/Never.*replay/);
});

test('native commit and immutable source guards cannot be replaced with a program report or parameter-check fallback',()=>workspace(()=>{
 const mutations:Array<(p:any)=>void>=[p=>p.execution_lane='snapshot',p=>p.execution_ok=false,p=>p.iteration.source_sha256='sha256:'+'0'.repeat(64),
 p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.committed=false;p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
 p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.effect_observation.complete=false;p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
 p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.effect_observation.items[0].stateJson='echo';p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
 p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.modified_element_ids.push(99);p.evidence.nativeExecutionReceipt=JSON.stringify(r);}];
 for(const mutate of mutations){const f=fixture(mutate);assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);}
 const f=fixture();f.subject.input.native_program.parameter_checks=[];assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false,'explicit checks may never fall back to persistence');
}));

test('scoped result persistence tolerates unavailable dependent notifications without claiming their preservation',()=>workspace(()=>{
 const f=fixture((p,input)=>{
  input.native_program.result_targets={element_ids:[42,43]};
  const r=JSON.parse(p.evidence.nativeExecutionReceipt);
  r.effect_observation.complete=false;
  r.effect_observation.items[0]={elementId:41,complete:false,found:null,stateJson:null,stateHash:null,reason:'native_state_read_failed:InvalidOperationException.get_Red'};
  p.evidence.nativeExecutionReceipt=JSON.stringify(r);
 });
 const before=JSON.stringify(f.payload);
 f.op.input.body.elementIds=[42,43];
 f.fresh.nativeProgramEffectState.requestedElementIds=[42,43];
 f.fresh.nativeProgramEffectState.items=f.fresh.nativeProgramEffectState.items.slice(1);
 f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;
 assert.deepEqual(plan(f.snapshot,f.subject)?.body.elementIds,[42,43]);
 assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 assert.equal(JSON.stringify(f.payload),before,'do not promote partial source evidence or erase footprint');
 assert.deepEqual(verifiedDeliverableTargetGroupsV2(f.snapshot,f.subject,f.result),[['element_id:42','element_id:43']]);
 const notice=nativeProgramResultScopeNoticeV2(f.snapshot,f.subject)!;
 assert.equal(notice.notification_count,3);assert.equal(notice.other_notification_count,1);
 assert.match(notice.notice,/not certified harmless or preserved/);
}));

function scopedFixture(declaration:any={element_ids:[42,43]},mutate?:(r:any)=>void,trust='authoritative_native'){
 const f=fixture((p,input)=>{
  input.native_program.result_targets=declaration;
  const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.program_result=JSON.stringify({created:[41],checked:[42,43]});
  mutate?.(r);p.evidence.nativeExecutionReceipt=JSON.stringify(r);
 },trust);
 const targets=declaration?.result_field==='created'?[41,43]:[42,43];
 f.op.input.body.elementIds=targets;
 f.fresh.nativeProgramEffectState.requestedElementIds=targets;
 f.fresh.nativeProgramEffectState.items=f.fresh.nativeProgramEffectState.items.filter((i:any)=>targets.includes(i.elementId));
 f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;return f;
}

function checkedScopedFixture(scoped=true){
 const f=scoped?scopedFixture():fixture();
 assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 f.subject.target={target_id:'document',semantic_scope:{}};
 f.subject.verification_operation_ids=['read'];
 Object.assign(f.op,{settlement_state:'settled',result:f.result,observation_ids:['verified']});
 f.snapshot.observations.verified={operation_id:'read',binding:f.subject.binding,authority:'native-host',raw_payload_hash:f.result.raw_payload_hash,
  facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]};
 return f;
}
function laterTouch(f:ReturnType<typeof checkedScopedFixture>,ids:number[]){
 f.snapshot.operations.later={...f.subject,operation_id:'later',verification_operation_ids:[],observation_ids:[],
  target:{target_id:'element_id:'+ids[0],semantic_scope:{}},opened_at:'2026-11-08T10:00:04Z',
  result:{...f.subject.result,operation_id:'later',completed_at:'2026-11-08T10:00:05Z',affected_target_identities:ids.map(id=>'element_id:'+id)}};
}

test('checked requested results stay current across incidental notification overlap, without rewriting history',()=>workspace(()=>{
 const f=checkedScopedFixture();assert.equal(checkedEditIsCurrentV2(f.snapshot,'apply'),true);
 laterTouch(f,[41]);const before=JSON.stringify(f.snapshot);
 assert.equal(checkedReadIsCurrentV2(f.snapshot,'read'),true);
 assert.equal(checkedEditIsCurrentV2(f.snapshot,'apply'),true);
 assert.equal(JSON.stringify(f.snapshot),before);
 assert.deepEqual(f.subject.result.affected_target_identities,['element_id:41','element_id:42','element_id:43']);
 const legacy=checkedScopedFixture(false);laterTouch(legacy,[41]);
 assert.equal(checkedEditIsCurrentV2(legacy.snapshot,'apply'),false,'unscoped legacy proof keeps full footprint');
}));

test('requested-result freshness still rejects actual target touches, unknown and in-flight writes',()=>workspace(()=>{
 for(const id of [42,43])for(const mode of ['applied','unknown','in-flight']){
  const f=checkedScopedFixture();laterTouch(f,[id]);
  if(mode==='unknown')f.snapshot.operations.later.persistent_effect='unknown';
  if(mode==='in-flight'){f.snapshot.in_flight_operation_ids=['later'];f.snapshot.operations.later.result=undefined;}
  assert.equal(checkedEditIsCurrentV2(f.snapshot,'apply'),false,`${id}/${mode}`);
 }
 const f=checkedScopedFixture();laterTouch(f,[]);f.snapshot.operations.later.target={target_id:'',semantic_scope:{}};
 assert.equal(checkedEditIsCurrentV2(f.snapshot,'apply'),false,'unknown target footprint remains conservative');
}));

test('actor feedback retains checked requested results while incidental notifications overlap',()=>workspace(()=>{
 const f=checkedScopedFixture();laterTouch(f,[41]);
 f.snapshot.spec={requested_effect:'apply',execution_policy:{verification_mode:'advisory'}};
 for(const [id,o] of Object.entries(f.snapshot.observations) as Array<[string,any]>){
  o.observation_id=id;o.observed_at='2026-11-08T10:00:03Z';o.raw_payload_ref??='evidence:read';o.facts??=[];o.eligible_criterion_ids=[];
 }
 const before=JSON.stringify(f.snapshot);
 const feedback=()=>JSON.parse(codexAssignmentEvidenceContextV2(f.snapshot));
 let visible=feedback();
 assert.equal(visible.pending_verification.some((o:any)=>o.operation_id==='apply'),false);
 assert.equal(visible.verified_postconditions.some((o:any)=>o.operation_id==='apply'),true);
 assert.equal(JSON.stringify(f.snapshot),before,'projection cannot settle or rewrite the task');
 laterTouch(f,[42]);visible=feedback();
 assert.equal(visible.pending_verification.some((o:any)=>o.operation_id==='apply'),true);
 assert.equal(visible.verified_postconditions.some((o:any)=>o.operation_id==='apply'),false);
 f.snapshot.execution_control={state:'paused'};
 assert.deepEqual(feedback().verified_postconditions,[],'Pause still suppresses active verified guidance');
}));

test('freshness narrowing requires trusted source, selector, binding, digest and exact checked read scope',()=>workspace(()=>{
 for(const mutate of [
  (f:any)=>f.subject.input.source+='foreign',
  (f:any)=>f.subject.input.native_program.result_targets=null,
  (f:any)=>f.subject.input.native_program.result_targets={element_ids:[42]},
  (f:any)=>f.subject.input.native_program.parameter_checks=[],
  (f:any)=>f.subject.result.raw_payload_hash='foreign',
  (f:any)=>f.snapshot.observations.obs.authority='model',
  (f:any)=>f.snapshot.observations.obs.raw_payload_ref='evidence:missing',
  (f:any)=>f.subject.result.binding={...f.subject.binding,run_id:'foreign'},
  (f:any)=>f.snapshot.input_invalidated_operation_ids=['apply'],
  (f:any)=>f.snapshot.input_invalidated_operation_ids=['read'],
  (f:any)=>f.op.input.body.elementIds=[42],
  (f:any)=>f.op.input.body.includeNativeProgramEffectState=false,
  (f:any)=>f.op.input.body.extra=true,
  (f:any)=>f.op.request_identity.path='/revit/get-parameters',
  (f:any)=>f.snapshot.observations.verified.raw_payload_hash='foreign',
 ]){const f=checkedScopedFixture();mutate(f);assert.equal(checkedEditIsCurrentV2(f.snapshot,'apply'),false,String(mutate));}
}));

test('created result IDs are selectors only and require actual native matching state',()=>workspace(()=>{
 const f=scopedFixture({element_ids:[43],result_field:'created'});
 assert.deepEqual(plan(f.snapshot,f.subject)?.body.elementIds,[41,43]);
 assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 f.fresh.nativeProgramEffectState.items[0]=state(41,false);f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;
 assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);
}));

test('scoped checks reject out-of-footprint, malformed and conflicting selectors',()=>workspace(()=>{
 for(const declaration of [null,{},[],{element_ids:[]},{element_ids:[42,43,99]},
  {element_ids:[42,43,43]},{element_ids:['42',43]},{element_ids:[42.1,43]},
  {result_field:'missing'}, {result_field:'nested.ids'},{result_field:'constructor'},
  {element_ids:[42,43],unexpected:true},{element_ids:Array.from({length:257},(_,i)=>i+1)}]){
  const f=scopedFixture(declaration);assert.equal(plan(f.snapshot,f.subject),null,JSON.stringify(declaration));
  assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false);
 }
 for(const mutate of [
  (r:any)=>r.effect_observation.items[1].complete=false,
  (r:any)=>r.effect_observation.items[1].stateHash='bad',
  (r:any)=>r.effect_observation.items[0].elementId=42,
  (r:any)=>r.effect_observation.items.pop(),
  (r:any)=>r.effect_observation.documentSessionId='other',
  (r:any)=>r.transaction.deleted_element_ids.push(99),
  (r:any)=>r.effect_observation.complete=false,
 ]){const f=scopedFixture(undefined,mutate);assert.equal(plan(f.snapshot,f.subject),null,String(mutate));}
 for(const output of ['not json','{}','{"checked":[999]}','{"checked":[42,43,43]}']){
  const f=scopedFixture({result_field:'checked'},r=>r.program_result=output);assert.equal(plan(f.snapshot,f.subject),null);
 }
}));

test('scoped checks retain source binding, Pause, unknown, current-version and mismatched-result safeguards',()=>workspace(()=>{
 for(const mutate of [
  (f:any)=>f.subject.input.source+='foreign',
  (f:any)=>f.subject.input.native_program.result_targets={element_ids:[41,42,43]},
  (f:any)=>f.subject.result.raw_payload_hash='wrong',
  (f:any)=>f.snapshot.current_binding={...f.snapshot.current_binding,run_id:'foreign'},
  (f:any)=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  (f:any)=>f.snapshot.execution_control={state:'paused'},
  (f:any)=>f.fresh.nativeProgramEffectState.items[0]=state(42,false),
  (f:any)=>f.fresh.nativeProgramEffectState.requestedElementIds=[41,42,43],
  (f:any)=>f.op.opened_at='2026-11-08T09:00:00Z',
  (f:any)=>f.snapshot.operations.other={...f.subject,operation_id:'other',opened_at:'2026-11-08T10:00:02Z'},
 ]){const f=scopedFixture();mutate(f);f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),false,String(mutate));}
 const f=scopedFixture(undefined,undefined,'model_report');assert.equal(plan(f.snapshot,f.subject),null);
}));

test('requested-target inspection completes without crediting dependent notification identities',()=>workspace(()=>{
 const f=scopedFixture();assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true);
 f.subject.verification_operation_ids=['read'];f.op.result=f.result;f.op.settlement_state='settled';f.op.observation_ids=['verified'];
 const identities=verifiedDeliverableTargetGroupsV2(f.snapshot,f.subject,f.result)[0];
 f.snapshot.observations.verified={operation_id:'read',binding:f.subject.binding,authority:'native-host',facts:[
  {fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true},
  {fact_id:'verification.deliverable_target_identities',fact_class:'verification',value:identities}]};
 f.snapshot.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[
  {item_id:'edit',kind:'edit',declared_at:'2026-11-08T09:00:00Z',completed_at:'2026-11-08T10:00:04Z',operation_ids:['apply']},
  {item_id:'review',kind:'inspection',depends_on:['edit'],declared_at:'2026-11-08T09:00:00Z',operation_ids:[]}]};
 f.snapshot.operations.review={...f.op,operation_id:'review',opened_at:'2026-11-08T10:00:05Z',result:{...f.result,raw_payload_hash:'fresh'},observation_ids:['inspected']};
 f.snapshot.observations.inspected={operation_id:'review',binding:f.subject.binding,authority:'native-host',raw_payload_hash:'fresh'};
 const proof={observation_ids:['inspected'],target_ids:identities};
 assert.ok(completeWorkPlanItemV2(f.snapshot,'review',['review'],'2026-11-08T10:00:06Z',proof).items[1]!.completed_at);
 assert.deepEqual(identities,['element_id:42','element_id:43']);
}));

test('dependent deletions remain explicit audit warnings and never become checked deliverables',()=>workspace(()=>{
 const f=scopedFixture({element_ids:[42]});
 f.op.input.body.elementIds=[42];f.fresh.nativeProgramEffectState.requestedElementIds=[42];
 f.fresh.nativeProgramEffectState.items=f.fresh.nativeProgramEffectState.items.filter((i:any)=>i.elementId===42);
 f.result.raw_payload_hash=payloadDigestV2(f.fresh).digest;
 assert.equal(match(f.snapshot,f.subject,f.result,f.fresh),true,'proves only requested state persistence');
 const notice=nativeProgramResultScopeNoticeV2(f.snapshot,f.subject)!;
 assert.equal(notice.other_deleted_count,1);assert.deepEqual(notice.other_deleted_sample,[43]);
 assert.deepEqual(verifiedDeliverableTargetGroupsV2(f.snapshot,f.subject,f.result),[['element_id:42']]);
 assert.match(notice.notice,/existing code\/visual review path/);
 assert.match(notice.notice,/not certified harmless or preserved/);
}));
