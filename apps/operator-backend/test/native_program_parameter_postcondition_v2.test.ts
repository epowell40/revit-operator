import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/index.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {nativeProgramParameterChecksV2 as checks,committedNativeProgramParameterReadbackPlanV2 as plan,
 nativeProgramParameterPostconditionSatisfiedV2 as satisfied} from '../src/verification/native_program_parameter_postcondition_v2.js';
import {nativeProgramResultPresentationV2 as presentation} from '../src/assignments/native_program_result_presentation_v2.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';

const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
function fixture(mutator?:(payload:any)=>void,trust:any='authoritative_native'){
 const binding={assignment_id:'assignment',run_id:'run',session_id:'session',generation:1,principal_id:'local:shared-token',document_fingerprint:'c'.repeat(64)};
 const source='public class Edit { public static string Execute(Autodesk.Revit.DB.Document d) { d.ProjectInformation.Author="Checked";return "not proof";} }';
 const sourceHash='sha256:'+sha(source),fingerprint='sha256:'+binding.document_fingerprint;
 const input={mode:'apply',source,target_revit_year:'2024',native_program:{entry_type:'Edit',effect_scope:'active_document',
  parameter_checks:[{element_id:42,parameter_name:'Author',expected_value:'Checked'}]}};
 const receipt={schema:'dynamic-revit-native-execution-receipt/v1',preparation_id:'preparation',source_hash:sourceHash,
  document_fingerprint:fingerprint,document_session_id:'native-session',success:true,verified:false,
  transaction:{status:'committed',committed:true,affected_element_ids:[42],modified_element_ids:[42],added_element_ids:[],deleted_element_ids:[]}};
 const prepared={Schema:'dynamic-revit-native-preparation/v1',SourceHash:sourceHash,PreparationId:'preparation',
  Document:{ProjectFingerprint:fingerprint,SessionId:'native-session'}};
 const payload:any={schema:'revit-operator.dynamic-revit-program-run.v1',execution_lane:'native',requested_mode:'apply',execution_status:'completed',execution_ok:true,
  iteration:{source_sha256:sourceHash},native_outcome:{persistent_effect:'applied',native_transaction_state:'committed',task_verified:false,verification_required:true},
  evidence:{schema:'dynamic-revit-native-program-evidence/v1',ok:true,nativeExecutionReceipt:JSON.stringify(receipt),snapshotReceipt:JSON.stringify(prepared)}};
 mutator?.(payload);
 const digest=payloadDigestV2(payload).digest;
 const ref=storeEvidence({scope:{...binding,attempt_id:'apply'},source:'assignment_kernel_v2:operator_run_dynamic_revit_program',
  media_type:'application/json',trust_level:trust,raw:payload}).ref;
 const request={capability_id:'operator_run_dynamic_revit_program',request_signature:sha(canonicalJsonV2({capability_id:'operator_run_dynamic_revit_program',input}))};
 const subject:any={operation_id:'apply',binding,capability_id:'operator_run_dynamic_revit_program',input,requested_effect:'apply',admission_state:'admitted',dispatch_state:'dispatched',persistent_effect:'applied',settlement_state:'settled',
  request_identity:request,observation_ids:['obs'],verification_operation_ids:[],opened_at:'2026-11-03T10:00:00.000Z',
  result:{operation_id:'apply',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'applied',native_transaction_state:'committed',
   result_schema_id:'operator-dynamic-runtime/mcp-program/v2',request_identity:request,receipt_id:'native-apply',native_correlation_id:'native-apply',raw_payload_hash:digest,affected_target_identities:['element_id:42'],completed_at:'2026-11-03T10:00:01.000Z'}};
 const body={elementIds:[42],names:['Author'],includeEmpty:true,limit:500};
 const readOp:any={operation_id:'read',binding,requested_effect:'read',purpose:'verification',fulfillment_role:'verification',verification_of_operation_id:'apply',
  dispatch_state:'dispatched',persistent_effect:'none',opened_at:'2026-11-03T10:00:02.000Z',input:{method:'POST',path:'/revit/get-parameters',body},
  request_identity:{method:'POST',path:'/revit/get-parameters',request_signature:'read-signature'}};
 const readPayload={items:[{id:42,uniqueId:'unique-42',parameters:{Author:'Checked'},parameterDetails:[{name:'Author',value:'Checked',storageType:'String',parameterId:-1}]}]};
 const read:any={operation_id:'read',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',
  request_identity:readOp.request_identity,receipt_id:'native-read',native_correlation_id:'native-read',raw_payload_hash:payloadDigestV2(readPayload).digest,completed_at:'2026-11-03T10:00:03.000Z'};
 const snapshot:any={current_binding:binding,outcome:'active',terminal:false,operations:{apply:subject,read:readOp},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],
  observations:{obs:{operation_id:'apply',binding,authority:'native-host',evidence_class:'task_result',raw_payload_hash:digest,raw_payload_ref:'evidence:'+ref.evidence_id}}};
 return {snapshot,subject,read,readPayload,readOp};
}
function workspace(fn:()=>void){const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-program-checks-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;try{fn();}finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}}

test('native CSharp requested text checks use one separate exact native read, not its return string',()=>workspace(()=>{
 const f=fixture();assert.deepEqual(checks(f.snapshot,f.subject),f.subject.input.native_program.parameter_checks);
 assert.deepEqual(plan(f.snapshot,f.subject),{method:'POST',path:'/revit/get-parameters',body:f.readOp.input.body});
 assert.equal(satisfied(f.snapshot,f.subject,f.read,f.readPayload),true);
 f.readOp.dispatch_state='dispatching';assert.equal(satisfied(f.snapshot,f.subject,f.read,f.readPayload),true,'host compares the returned native result before recording its dispatch event');
 f.readOp.dispatch_state='not_dispatched';assert.equal(satisfied(f.snapshot,f.subject,f.read,f.readPayload),false);f.readOp.dispatch_state='dispatched';
 const historical=fixture();delete historical.subject.input.native_program.parameter_checks;
 assert.equal(checks(historical.snapshot,historical.subject),null,'historical native call without original checks remains unverified');
 f.subject.verification_operation_ids=['read'];assert.equal(plan(f.snapshot,f.subject),null,'never repeat the check automatically');
}));

test('foreign, corrupt, substituted, unsupported or no-effect native commits cannot acquire text verification',()=>workspace(()=>{
 const mutations:Array<(p:any)=>void>=[p=>p.execution_lane='snapshot',p=>p.execution_ok=false,p=>p.iteration.source_sha256='sha256:'+'a'.repeat(64),p=>p.native_outcome.task_verified=true,
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.source_hash='sha256:'+'a'.repeat(64);p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.document_fingerprint='sha256:'+'a'.repeat(64);p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.modified_element_ids=[42,99];r.transaction.affected_element_ids=[42,99];p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.status='rolled_back';r.transaction.committed=false;p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.added_element_ids=[42];p.evidence.nativeExecutionReceipt=JSON.stringify(r);}];
 for(const mutate of mutations){const f=fixture(mutate);assert.equal(checks(f.snapshot,f.subject),null);}
 for(const trust of ['host_observed','trusted_projection','untrusted_caller']){const f=fixture(undefined,trust);assert.equal(checks(f.snapshot,f.subject),null);}
 for(const mutate of [(f:any)=>f.subject.input.native_program.parameter_checks[0].expected_value='Substituted',
  (f:any)=>f.snapshot.current_binding={...f.snapshot.current_binding,generation:2},(f:any)=>f.subject.result.raw_payload_hash='wrong',
  (f:any)=>f.subject.result.completed_at='invalid',(f:any)=>f.snapshot.input_invalidated_operation_ids=['apply']]){const f=fixture();mutate(f);assert.equal(checks(f.snapshot,f.subject),null);}
}));

test('a check rejects echoes, ambiguous fields, wrong text, stale/foreign reads, Pause and unknown effects',()=>workspace(()=>{
 const mutations:Array<(f:any)=>void>=[f=>f.readPayload={report:f.readPayload,verified:true},f=>f.readPayload.items[0].parameters.Author='Wrong',
  f=>f.readPayload.items[0].parameterDetails[0].storageType='Integer',f=>f.readPayload.items[0].parameterDetails.push({...f.readPayload.items[0].parameterDetails[0]}),
  f=>f.readPayload.items.push({...f.readPayload.items[0]}),f=>f.readPayload.items=[],f=>f.readPayload.truncated=true,
  f=>f.readOp.input.body.elementIds=[99],f=>f.readOp.input.body.names=['Other'],f=>f.readOp.purpose='discovery',
  f=>f.readOp.verification_of_operation_id='other',f=>f.readOp.opened_at='2026-11-03T09:59:00.000Z',
  f=>f.read.binding={...f.read.binding,generation:2},f=>f.read.request_identity={...f.read.request_identity,request_signature:'foreign'},
  f=>f.snapshot.execution_control={state:'paused'},f=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
  f=>f.snapshot.operations.later={...f.subject,operation_id:'later',opened_at:'2026-11-03T10:00:01.500Z'}];
 for(const mutate of mutations){const f=fixture();mutate(f);f.read.raw_payload_hash=payloadDigestV2(f.readPayload).digest;assert.equal(satisfied(f.snapshot,f.subject,f.read,f.readPayload),false);}
 const f=fixture();f.read.raw_payload_hash='wrong';assert.equal(satisfied(f.snapshot,f.subject,f.read,f.readPayload),false);
}));

function presentedFixture(mutate?:(p:any)=>void,trust:any='authoritative_native'){
 const f=fixture(),s=f.snapshot,b=s.current_binding;
 s.terminal=true;s.outcome='complete';s.assignment_version=20;s.criteria={};s.spec={requested_effect:'apply'};
 f.subject.verification_operation_ids=['read'];
 Object.assign(f.readOp,{admission_state:'admitted',settlement_state:'settled',result:f.read,observation_ids:['read-obs'],target:{target_id:'element_id:42'}});
 const readRef=storeEvidence({scope:{...b,attempt_id:'read'},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:f.readPayload}).ref;
 s.observations['read-obs']={operation_id:'read',binding:b,authority:'native-host',evidence_class:'verification',raw_payload_hash:f.read.raw_payload_hash,
  raw_payload_ref:'evidence:'+readRef.evidence_id,facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]};
 const input={mode:'read',source:'public class Read { }',target_revit_year:'2024',native_program:{entry_type:'Read'}},sourceHash='sha256:'+sha(input.source);
 const receipt={schema:'dynamic-revit-native-execution-receipt/v1',preparation_id:'read-prepared',source_hash:sourceHash,success:true,read_only:true,
  document_fingerprint:'sha256:'+b.document_fingerprint,document_session_id:'native-session',program_result:'Walls=56; Doors=16',
  transaction:{status:'not_started',committed:false,added_element_ids:[],modified_element_ids:[],deleted_element_ids:[],affected_element_ids:[]}};
 const prepared={Schema:'dynamic-revit-native-preparation/v1',PreparationId:'read-prepared',SourceHash:sourceHash,
  Document:{ProjectFingerprint:receipt.document_fingerprint,SessionId:'native-session',Title:'Sample'},References:[{Name:'RevitAPI',Version:'24.3.30.0'}]};
 const p:any={schema:'revit-operator.dynamic-revit-program-run.v1',execution_lane:'native',requested_mode:'read',execution_status:'completed',execution_ok:true,
  iteration:{source_sha256:sourceHash},evidence:{schema:'dynamic-revit-native-program-evidence/v1',ok:true,nativeExecutionReceipt:JSON.stringify(receipt),snapshotReceipt:JSON.stringify(prepared)}};
 mutate?.(p);
 const stored=storeEvidence({scope:{...b,attempt_id:'program-read'},source:'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:trust,raw:p}).ref;
 const request={request_signature:sha(canonicalJsonV2({capability_id:f.subject.capability_id,input}))};
 s.operations['program-read']={...f.subject,operation_id:'program-read',input,requested_effect:'read',persistent_effect:'none',request_identity:request,
  opened_at:'2026-11-03T10:00:04.000Z',observation_ids:['program-read-obs'],verification_operation_ids:[],
  result:{...f.subject.result,operation_id:'program-read',persistent_effect:'none',native_transaction_state:'not_started',request_identity:request,
   completed_at:'2026-11-03T10:00:05.000Z',raw_payload_hash:payloadDigestV2(p).digest}};
 s.observations['program-read-obs']={operation_id:'program-read',binding:b,authority:'native-host',evidence_class:'control',facts:[],
  raw_payload_hash:payloadDigestV2(p).digest,raw_payload_ref:'evidence:'+stored.evidence_id};
 return f;
}

test('native program terminal delivery includes independently checked fields and explicitly labelled actual read output',()=>workspace(()=>{
 const f=presentedFixture(),before=JSON.stringify(f.snapshot);
 const p=presentation(f.snapshot)!;assert.match(p.summary,/Verified native parameter.*Author: Checked/);
 assert.match(p.summary,/Revit 2024 \(API 24.3.30.0\)/);assert.match(p.summary,/Project: Sample/);
 assert.match(p.summary,/not an independent verification/);assert.match(p.summary,/Walls=56; Doors=16/);
 const terminal=deriveTerminalResultV2(f.snapshot);assert.match(terminal.result_summary,/Author: Checked/);
 assert.match(terminal.result_summary,/Walls=56/);assert.ok(terminal.supporting_observation_ids.includes('program-read-obs'));
 assert.equal(JSON.stringify(f.snapshot),before,'presentation never appends facts or changes criterion/terminal truth');
}));

test('program output cannot become verification and stale, foreign, failed, malformed or untrusted output is not delivered',()=>workspace(()=>{
 const bad:Array<(p:any)=>void>=[p=>p.execution_lane='snapshot',p=>p.execution_ok=false,p=>p.requested_mode='apply',p=>p.iteration.source_sha256='wrong',
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.read_only=false;p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.document_fingerprint='foreign';p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.transaction.modified_element_ids=[42];p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>{const r=JSON.parse(p.evidence.nativeExecutionReceipt);r.program_result='x'.repeat(4097);p.evidence.nativeExecutionReceipt=JSON.stringify(r);},
  p=>p.evidence.nativeExecutionReceipt='{malformed'];
 for(const mutate of bad){const f=presentedFixture(mutate);assert.doesNotMatch(presentation(f.snapshot)?.summary??'',/Walls=56/);}
 const untrusted=presentedFixture(undefined,'host_observed');assert.doesNotMatch(presentation(untrusted.snapshot)?.summary??'',/Walls=56/);
 for(const mutate of [(s:any)=>s.observations['program-read-obs'].binding={...s.current_binding,generation:2},
  (s:any)=>s.operations['program-read'].result.status='failed',
  (s:any)=>s.operations['program-read'].input.source+=' changed',
  (s:any)=>s.operations['program-read'].opened_at='2026-11-03T10:00:00.000Z',
  (s:any)=>s.observations['program-read-obs'].raw_payload_hash='corrupt']){
  const f=presentedFixture();mutate(f.snapshot);assert.doesNotMatch(presentation(f.snapshot)?.summary??'',/Walls=56/);
 }
 const f=presentedFixture();f.readPayload.items[0].parameters.Author='wrong';
 // A program return, including a claim of success, cannot replace the paired check.
 f.subject.verification_operation_ids=[];assert.doesNotMatch(presentation(f.snapshot)?.summary??'',/Verified native parameter/);
 for(const mutate of [(s:any)=>s.outcome='active',(s:any)=>s.execution_control={state:'paused'},(s:any)=>s.unresolved_unknown_operation_ids=['unknown']]){
  const x=presentedFixture();mutate(x.snapshot);assert.equal(presentation(x.snapshot),null);
 }
}));
