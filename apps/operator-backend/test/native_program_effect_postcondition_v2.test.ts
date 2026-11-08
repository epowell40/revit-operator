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

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function state(id:number,found=true){const json=JSON.stringify({elementId:id,found,identity:found?'native-'+id:null,geometry:found?{kind:'Line',start:[0,0,0],end:[1,0,0]}:null});
 return {elementId:id,found,complete:true,stateJson:json,stateHash:'sha256:'+sha(json)};}
function fixture(mutate?:(p:any)=>void,trust:any='authoritative_native'){
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
 mutate?.(payload);
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
