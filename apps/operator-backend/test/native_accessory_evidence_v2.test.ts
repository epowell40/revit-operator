import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {committedNativeAccessoryReadbackPlanV2,nativeAccessoryReadRequestMatchesV2,nativeAccessoryIncomingPostconditionV2,nativeAccessoryPostconditionSatisfiedV2} from '../src/verification/native_accessory_evidence_v2.js';
import {verificationCapabilityAdmissionV2} from '../src/verification/verification_capability_admission_v2.js';
import {example} from './native_accessory_preservation.fixtures.js';
import {terminalFlowExample} from './native_accessory_flow.fixtures.js';
import {ancillaryExample} from './native_accessory_ancillary.fixtures.js';
import {browserFixture} from './native_pipe_placement_coverage.fixtures.js';
import {retainedConsequences154} from './native_accessory_consequences.fixtures.js';
import {retainedNativePreservationPayloadV2,retainedNativeAccessoryPayloadV2} from '../src/verification/parameter_schedule_preservation_v2.js';
import {segmented} from './native_segmented_preservation_v2.test.js';
function bound(kind:'duct'|'pipe'='duct',create=()=>example(kind)){
 const f=create(),binding={assignment_id:'native-placement',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{},observations:{}};
 function op(id:string,input:any,payload:any,at:string,work:boolean){
  const stored=storeEvidence({scope:{...binding,attempt_id:id},source:'native-fixture',trust_level:'authoritative_native',raw:payload});
  const digest=payloadDigestV2(payload).digest,request={method:input.method,path:input.path,request_signature:'signature-'+id};
  const o:any={operation_id:id,binding,input,request_identity:request,capability_id:'native:POST:'+input.path,
   requested_effect:work?'apply':'read',persistent_effect:work?'applied':'none',purpose:work?'work':'verification',fulfillment_role:work?'work':'verification',
   admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',opened_at:at,observation_ids:['obs-'+id],verification_operation_ids:[],
   result:{operation_id:id,binding,request_identity:request,status:'succeeded',authority:'native-host',dispatch_state:'dispatched',persistent_effect:work?'applied':'none',
    native_transaction_state:work?'committed':'not_applicable',receipt_id:'receipt-'+id,native_correlation_id:'correlation-'+id,raw_payload_hash:digest,
    result_schema_id:'operator-native/POST:'+input.path+'/v2',completed_at:at,affected_target_identities:work?f.affected:[]}};
  s.operations[id]=o;s.observations['obs-'+id]={observation_id:'obs-'+id,operation_id:id,binding,authority:'native-host',raw_payload_hash:digest,raw_payload_ref:'evidence:'+stored.ref.evidence_id,facts:[]};return o;
 }
 const apply=op('apply',f.input,f.apply,'2026-10-29T12:00:00Z',true),plan=committedNativeAccessoryReadbackPlanV2(s,apply);assert.ok(plan);
 const read=op('read',plan,f.after,'2026-10-29T12:00:01Z',false);read.verification_of_operation_id='apply';
 return {f,s,apply,read};
}
type Bound=ReturnType<typeof bound>;
// Deterministic low-redundancy data crosses the old encoded/retained limits.
const transportRecords=Array.from({length:50_000},(_,i)=>createHash('sha256').update(String(i)).digest('hex')).join('');
function systemSizedExample(damage?:(f:ReturnType<typeof example>)=>void){
 const f=example('pipe');damage?.(f);
 for(const key of ['preservationBefore','preservationAfter'])f.apply[key]=segmented({...f.apply[key],transportRecords});
 f.after={...segmented({...f.after,transportRecords}),canonical_attempt_settlement:{schema:'revit-operator.native-attempt-settlement.v1',requested_effect:'read',effect_state:'none',effect_authority:'native_host',request_dispatched:true,method:'POST',path:'/revit/get-connectors'}} as any;
 assert.ok(Buffer.byteLength(JSON.stringify(f.apply))>2_000_000);return f;
}
function isolated(fn:()=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'native-placement-evidence-'));
 try{fn();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;}}
const retained=(b:Bound)=>nativeAccessoryPostconditionSatisfiedV2(b.s,b.apply,b.read.result,b.f.after);
const incoming=(b:Bound)=>nativeAccessoryIncomingPostconditionV2(b.s,b.apply,b.read.result,b.f.after);
test('native-bound System Browser public-state coverage reaches incoming and retained verification',()=>isolated(()=>{
 const b=bound('pipe',browserFixture);assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
for(const mode of ['Pause','foreign','digest','unknown','missing-before','changed-browser'])test('browser coverage cannot bypass '+mode,()=>isolated(()=>{
 const b=bound('pipe',()=>{const f=browserFixture();
  if(mode==='missing-before')delete f.apply.preservationBefore.nativePlacementState.systemBrowserViews;
  if(mode==='changed-browser')f.after.nativePlacementState.systemBrowserViews.items[0].metadata.parameters[0].value='changed';
  return f;});
 if(mode==='Pause')b.s.execution_control={state:'paused'};
 if(mode==='foreign')b.s.current_binding={...b.s.current_binding,document_fingerprint:'foreign'};
 if(mode==='digest')b.read.result.raw_payload_hash='sha256:'+'0'.repeat(64);
 if(mode==='unknown')b.s.unresolved_unknown_operation_ids=['unknown'];
 assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
test('system-sized packed evidence passes full comparator without widening legacy readers',()=>isolated(()=>{
 const b=bound('pipe',systemSizedExample);assert.equal(incoming(b),true);assert.equal(retained(b),true);
 assert.equal(retainedNativePreservationPayloadV2(b.s,b.apply,true),null);
 assert.ok(retainedNativeAccessoryPayloadV2(b.s,b.apply));
 b.apply.input.path='/revit/set-parameter';assert.equal(retainedNativeAccessoryPayloadV2(b.s,b.apply),null);
}));
for(const [name,damage]of Object.entries({parameter:(f:any):void=>{f.after.nativePlacementState.owners[0].state.parameters='[{"id":1,"storage":"String","value":"changed"}]';},schedule:(f:any):void=>{f.after.nativePlacementState.schedulePreservation.complete=false;}}))test('system-sized valid encoding cannot hide '+name,()=>isolated(()=>{
 const b=bound('pipe',()=>systemSizedExample(damage));assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
for(const name of ['Pause','foreign','digest','unknown'] as const)test('system-sized evidence preserves '+name+' refusal',()=>isolated(()=>{
 const b=bound('pipe',systemSizedExample);
 if(name==='Pause')b.s.execution_control={state:'paused'};
 if(name==='foreign')b.s.current_binding={...b.s.current_binding,document_fingerprint:'foreign'};
 if(name==='digest')b.read.result.raw_payload_hash='sha256:'+'0'.repeat(64);
 if(name==='unknown')b.s.unresolved_unknown_operation_ids=['unknown'];
 assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
function packedExample(kind:'duct'|'pipe'='duct'){
 const f=example(kind);for(const key of ['preservationBefore','preservationAfter']){
  const bytes=Buffer.from(JSON.stringify(f.apply[key]));f.apply[key]={schema:'operator.native_preservation_json.v1',encoding:'gzip-base64',uncompressedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:gzipSync(bytes).toString('base64')};
 }return f;
}
function segmentedFixture(value:any){
 const bytes=Buffer.from(JSON.stringify({...value,transportTestPadding:'x'.repeat(2_000_001)})),segments=[];
 for(let offset=0;offset<bytes.length;offset+=2_000_000){const b=bytes.subarray(offset,offset+2_000_000);segments.push({index:segments.length,uncompressedBytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),data:gzipSync(b).toString('base64')});}
 return {schema:'operator.native_preservation_json.v2',encoding:'segmented-gzip-base64',uncompressedBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),segments};
}
function largeExample(kind:'duct'|'pipe'='pipe',damage?:(f:ReturnType<typeof example>)=>void){const f=example(kind);damage?.(f);
 f.apply.preservationBefore=segmentedFixture(f.apply.preservationBefore);f.apply.preservationAfter=segmentedFixture(f.apply.preservationAfter);f.after=segmentedFixture(f.after) as any;return f;
}
for(const kind of ['duct','pipe'] as const)test(kind+': segmented apply and independent read preserve raw admission and exact comparator',()=>isolated(()=>{
 const b=bound(kind,()=>largeExample(kind));assert.equal(incoming(b),true);assert.equal(retained(b),true);
 assert.equal(nativeAccessoryReadRequestMatchesV2(b.s,b.apply,b.read.input),true);
}));
for(const[name,damage]of Object.entries({remoteParameter:(f:any):void=>{f.after.nativePlacementState.owners[0].state.parameters='[{"id":1,"storage":"String","value":"changed"}]';},
 missingPeer:(f:any)=>{const c=f.after.results.flatMap((r:any)=>r.connectors).find((c:any)=>c.physicalConnectedTo.length>0);assert.ok(c);c.physicalConnectedTo=[];},schedule:(f:any):void=>{f.after.nativePlacementState.schedulePreservation.complete=false;},
 missingScope:(f:any):void=>{f.after.nativePlacementState.requestedElementIds.pop();},unknown:(f:any):void=>{f.apply.transaction.status='unknown';}}))
 test('segmented valid hashes cannot hide '+name,()=>isolated(()=>{
  if(name==='unknown'){const b=bound('pipe',()=>largeExample());b.apply.result.persistent_effect='unknown';assert.equal(incoming(b),false);assert.equal(retained(b),false);return;}
  const b=bound('pipe',()=>largeExample('pipe',damage));assert.equal(incoming(b),false);assert.equal(retained(b),false);
 }));
for(const kind of ['duct','pipe'] as const)test(kind+': lossless packed snapshots retain plan and exact native postcondition',()=>isolated(()=>{
 const b=bound(kind,()=>packedExample(kind));assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
for(const kind of ['duct','pipe'] as const)test(`${kind}: actual plan admission, incoming and retained native observations`,()=>isolated(()=>{
 const b=bound(kind);assert.equal(nativeAccessoryReadRequestMatchesV2(b.s,b.apply,b.read.input),true);
 assert.equal(verificationCapabilityAdmissionV2({apply:{capability_id:'revit_call_tool',path:b.apply.input.path,arguments:b.apply.input},verification:{capability_id:'revit_call_tool',path:b.read.input.path,arguments:b.read.input}}).admissible,true);
 assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
const negatives:Record<string,(b:Bound)=>void>={
 Pause:b=>b.s.execution_control={state:'paused'},unknown:b=>b.s.unresolved_unknown_operation_ids=['other'],
 foreignDocument:b=>b.s.current_binding={...b.s.current_binding,document_fingerprint:'foreign'},
 foreignGeneration:b=>b.read.binding={...b.read.binding,generation:2},invalidatedApply:b=>b.s.input_invalidated_operation_ids=['apply'],
 invalidatedRead:b=>b.s.input_invalidated_operation_ids=['read'],unadmitted:b=>b.apply.admission_state='rejected',
 unsettledApply:b=>b.apply.settlement_state='awaiting_result',failedRead:b=>b.read.result.status='failed',
 wrongAuthority:b=>b.read.result.authority='model',missingReceipt:b=>delete b.apply.result.receipt_id,
 missingCorrelation:b=>delete b.read.result.native_correlation_id,wrongSignature:b=>b.apply.result.request_identity={...b.apply.request_identity,request_signature:'foreign'},
 wrongSchema:b=>b.read.result.result_schema_id='untyped',wrongApplyDigest:b=>b.apply.result.raw_payload_hash='sha256:'+'0'.repeat(64),
 wrongReadDigest:b=>b.read.result.raw_payload_hash='sha256:'+'0'.repeat(64),wrongPayload:b=>b.f.after.results[0].typeId=999,
 missingApplyEvidence:b=>delete b.s.observations['obs-apply'],foreignRef:b=>b.s.observations['obs-apply'].raw_payload_ref=b.s.observations['obs-read'].raw_payload_ref,
 missingReadBinding:b=>delete b.read.binding,discoveryOnly:b=>b.read.purpose='discovery',wrongRole:b=>b.read.fulfillment_role='discovery',
 wrongPair:b=>b.read.verification_of_operation_id='foreign',staleRead:b=>b.read.opened_at='2026-10-29T11:59:59Z',
 invalidTime:b=>b.read.result.completed_at='invalid',pendingWrite:b=>b.s.operations.pending={...b.apply,operation_id:'pending',settlement_state:'awaiting_result',result:undefined},
 newerWrite:b=>b.s.operations.newer={...b.apply,operation_id:'newer',result:{...b.apply.result,completed_at:'2026-10-29T12:00:02Z'}},
 readMutation:b=>b.read.result.persistent_effect='applied',missingFlag:b=>delete b.read.input.body.includeNativePlacementState,
 incompletePhysicalScope:b=>b.read.input.body.elementIds.pop(),scheduleAsConnector:b=>b.read.input.body.elementIds.push(60),
 missingType:b=>b.read.input.body.placementTypeIds=[],missingSystem:b=>b.read.input.body.placementSystemIds=[],
 missingSchedules:b=>b.read.input.body.preservationScheduleIds=[],missingChanged:b=>b.read.input.body.placementChangedIds=[],
 extraInput:b=>b.read.input.body.includeInlineAccessoryState=true,omittedRefs:b=>b.read.input.body.includeAllRefs=false,
 omittedCoordinates:b=>b.read.input.body.includeCoordinateSystem=false,omittedFlex:b=>b.read.input.body.includeFlexGeometry=false,
 openOnly:b=>b.read.input.body.onlyOpenPhysicalConnectors=true,
};
for(const [name,change] of Object.entries(negatives))test(`incoming and retained refuse ${name}`,()=>isolated(()=>{const b=bound();change(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);}));
for(const name of ['Pause','unknown','foreignDocument','foreignGeneration','invalidatedRead','wrongAuthority','wrongReadDigest','staleRead','pendingWrite','missingChanged'])
 test('segmented source guards refuse '+name,()=>isolated(()=>{const b=bound('pipe',()=>largeExample());negatives[name]!(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);}));
test('assigned-versus-calculated native counterpart passes existing incoming and retained boundaries',()=>isolated(()=>{
 const b=bound('duct',terminalFlowExample);assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
for(const [name,change] of Object.entries(negatives))test(`calculated-flow distinction still refuses ${name}`,()=>isolated(()=>{
 const b=bound('duct',terminalFlowExample);change(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
test('incoming receipt is independent of later retained-read storage',()=>isolated(()=>{
 const b=bound(),result=b.read.result;delete b.read.result;delete b.s.observations['obs-read'];b.read.observation_ids=[];b.read.settlement_state='awaiting_result';b.read.dispatch_state='dispatching';
 assert.equal(nativeAccessoryIncomingPostconditionV2(b.s,b.apply,result,b.f.after),true);
 assert.equal(nativeAccessoryPostconditionSatisfiedV2(b.s,b.apply,result,b.f.after),false);
}));
test('untrusted matching bytes never establish native apply authority',()=>isolated(()=>{
 const b=bound(),stored=storeEvidence({scope:{...b.s.current_binding,attempt_id:'apply'},source:'caller',trust_level:'untrusted_caller',raw:b.f.apply});
 b.s.observations['obs-apply'].raw_payload_ref='evidence:'+stored.ref.evidence_id;assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
test('linked verification prevents another automatic read plan',()=>isolated(()=>{
 const b=bound();b.apply.verification_operation_ids=['read'];assert.equal(committedNativeAccessoryReadbackPlanV2(b.s,b.apply),null);
}));

for(const kind of ['duct','pipe'] as const)test(kind+': existing ancillary observations retain native evidence authority',()=>isolated(()=>{
 const b=bound(kind,()=>ancillaryExample(kind));assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
for(const [name,change] of Object.entries(negatives))test('ancillary coverage still refuses '+name,()=>isolated(()=>{
 const b=bound('duct',ancillaryExample);change(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
for(const [name,change] of Object.entries(negatives))test('packed native snapshots still refuse '+name,()=>isolated(()=>{
 const b=bound('duct',packedExample);change(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
test('packed matching bytes still require authoritative native storage',()=>isolated(()=>{
 const b=bound('duct',packedExample),stored=storeEvidence({scope:{...b.s.current_binding,attempt_id:'apply'},source:'caller',trust_level:'untrusted_caller',raw:b.f.apply});
 b.s.observations['obs-apply'].raw_payload_ref='evidence:'+stored.ref.evidence_id;assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));

test('retained154 packed APPLY and later native read pass current incoming/retained boundaries',()=>isolated(()=>{
 const b=bound('duct',retainedConsequences154);assert.equal(incoming(b),true);assert.equal(retained(b),true);
}));
for(const [name,change] of Object.entries(negatives))test('retained154 consequences still refuse '+name,()=>isolated(()=>{
 const b=bound('duct',retainedConsequences154);change(b);assert.equal(incoming(b),false);assert.equal(retained(b),false);
}));
