import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {AssignmentJournalV2,canonicalJsonV2} from '../src/domain/assignment-kernel/index.js';
import {buildHostProgressEpochV2} from '../src/assignments/supporting_discovery_progress.js';
import {nativeProgramDiscoveryMembersV2,nativeProgramDiscoveryIdentitiesV2} from '../src/assignments/native_program_discovery_progress.js';
import {observationAdmissibilityForCriterionV2} from '../src/domain/assignment-kernel/semantic_admissibility.js';

const sha=(s:string)=>'sha256:'+createHash('sha256').update(s).digest('hex');
const packed=(a:string[])=>a.map(v=>`${v.length}:${v}\n`).join('');
const binding={assignment_id:'read-discovery',run_id:'run',session_id:'session',generation:1,principal_id:'local',document_fingerprint:'c'.repeat(64)};
const apiA='P:Autodesk.Revit.DB.Document.ProjectInformation',apiB='P:Autodesk.Revit.DB.View.ViewTemplateId',apiC='P:Autodesk.Revit.DB.IndependentTag.TagHeadPosition';
function workspace(fn:()=>void){const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'native-discovery-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;try{fn();}finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}}
function initial():any{
 const j=new AssignmentJournalV2();j.append({schema:'revit-operator.assignment-event/v2',event_id:'created',assignment_id:binding.assignment_id,assignment_version:1,binding,
  occurred_at:'2026-11-11T10:00:00Z',actor:'test',event_type:'assignment_created',spec:{schema:'revit-operator.assignment-spec/v2',binding,
   source_user_request:'Correct the marked sheets.',requested_effect:'apply',semantic_evidence_contract:'revit-operator.semantic-evidence-contract/v2',
   criteria:[{criterion_id:'work',requirement:'Marked content corrected.',required:true,semantic_fact_requirements:['requested_change_verified'],accepted_evaluator_authority_ids:['deterministic-controller'],accepted_observation_authority_ids:['native-host'],
    evidence_policy:{schema:'revit-operator.criterion-evidence-policy/v2',allowed_evidence_classes:['task_result'],allowed_fulfillment_roles:['delegated_task_execution'],allowed_fact_classes:['domain'],
     allowed_capability_ids:['operator_run_dynamic_revit_program'],allowed_result_schema_ids:['operator-dynamic-runtime/mcp-program/v2'],required_fact_ids:['requested_change_verified'],require_native_dispatch:true,require_current_generation:true}}],
   input_variables:[],work_units:[],authorization_policy_id:'policy',created_at:'2026-11-11T10:00:00Z'}} as any);return j.snapshot();
}
function read(before:any,id:string,members:string[],options:{source?:string;output?:string;mutate?:(p:any)=>void;trust?:any;sourceLabel?:string}={}){
 const b=before.current_binding,source=options.source??'public class Inspect { /* native read */ }',sourceHash=sha(source.replace(/\r\n?/g,'\n'));
 const input={mode:'read',source,target_revit_year:'2024',native_program:{entry_type:'Inspect'}};
 const a:any={schema:'dynamic-revit-native-compile-artifact/v1',revitYear:2024,mode:'read',entryType:'Inspect',sourceHash,assemblyHash:sha('assembly'),
  references:[{name:'RevitAPI',version:'24.3.0.0',sha256:sha('reference')}],directNativeMembers:members.map(v=>({id:v,declaringType:v.slice(2,v.lastIndexOf('.')),name:v.slice(v.lastIndexOf('.')+1),mutationHint:false}))};
 const scope={EffectScope:'listed_elements',DocumentFingerprint:'sha256:'+b.document_fingerprint,DocumentSessionId:'native-session',DocumentRevision:0,
  NativeScopeHash:sha('scope'),AllowCreate:false,MaxAffectedElements:0,AllowedExistingElementIds:[],DeadlineMs:5000};
 const sorted=[...a.directNativeMembers].sort((x,y)=>x.id<y.id?-1:x.id>y.id?1:0);
 const artifactHash=sha(packed([a.schema,'2024',a.mode,a.entryType,sourceHash,a.assemblyHash,'RevitAPI','24.3.0.0',sha('reference'),String(sorted.length),...sorted.flatMap(m=>[m.id,m.declaringType,m.name,'0'])]));
 const n={schema:'dynamic-revit-native-execution-receipt/v1',preparation_id:'prep-'+id,success:true,read_only:true,source_hash:sourceHash,assembly_hash:a.assemblyHash,
  native_binding_hash:sha(packed(['dynamic-revit-native-program-binding/v1',artifactHash,scope.DocumentFingerprint,scope.DocumentSessionId,'0',scope.NativeScopeHash,'0','0','5000'])),
  document_fingerprint:scope.DocumentFingerprint,document_session_id:scope.DocumentSessionId,document_revision_before:0,program_result:options.output??'Actual native program output',
  transaction:{status:'not_started',committed:false,added_element_ids:[],modified_element_ids:[],deleted_element_ids:[],affected_element_ids:[]}};
 const prep={Schema:'dynamic-revit-native-preparation/v1',PreparationId:n.preparation_id,SourceHash:sourceHash,Scope:scope,
  Document:{ProjectFingerprint:scope.DocumentFingerprint,SessionId:scope.DocumentSessionId},References:[{Name:'RevitAPI',Version:'24.3.0.0',Sha256:sha('reference')}]};
 const p:any={schema:'revit-operator.dynamic-revit-program-run.v1',execution_lane:'native',requested_mode:'read',execution_status:'completed',execution_ok:true,iteration:{source_sha256:sourceHash},
  evidence:{schema:'dynamic-revit-native-program-evidence/v1',ok:true,nativeExecutionReceipt:JSON.stringify(n),snapshotReceipt:JSON.stringify(prep),workerOutput:{nativeProgramArtifact:a}}};
 options.mutate?.(p);
 const ref=storeEvidence({scope:{...b,attempt_id:id},source:options.sourceLabel??'assignment_kernel_v2:operator_run_dynamic_revit_program',trust_level:options.trust??'authoritative_native',raw:p}).ref;
 const cap='operator_run_dynamic_revit_program',request={request_signature:sha(canonicalJsonV2({capability_id:cap,input})).slice(7)},digest=payloadDigestV2(p).digest;
 const op:any={operation_id:id,binding:b,capability_id:cap,input,requested_effect:'read',purpose:'discovery',fulfillment_role:'supporting_control',admission_state:'admitted',dispatch_state:'dispatched',
  settlement_state:'settled',persistent_effect:'none',request_identity:request,observation_ids:['obs-'+id],verification_operation_ids:[],advances_criterion_ids:[],eligible_criterion_ids:[],resolves_gap_ids:['criterion:work'],
  target:{document_fingerprint:b.document_fingerprint},opened_at:'2026-11-11T10:00:01Z',settled_assignment_version:Object.keys(before.operations).length+2,
  result:{operation_id:id,binding:b,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_started',
   request_identity:request,result_schema_id:'operator-dynamic-runtime/mcp-program/v2',receipt_id:'receipt-'+id,native_correlation_id:'native-'+id,raw_payload_hash:digest,completed_at:'2026-11-11T10:00:02Z'}};
 const obs:any={observation_id:'obs-'+id,operation_id:id,binding:b,capability_id:cap,authority:'native-host',evidence_class:'control',fulfillment_role:'supporting_control',
  eligible_criterion_ids:[],raw_payload_hash:digest,raw_payload_ref:'evidence:'+ref.evidence_id,facts:[{fact_id:'control.domain_succeeded',fact_class:'control',value:true}]};
 return {...before,operations:{...before.operations,[id]:op},observations:{...before.observations,[obs.observation_id]:obs}};
}
const epoch=(before:any,after:any)=>buildHostProgressEpochV2({before,after,stated_gap_ids:['criterion:work'],recorded_at:'2026-11-11T10:00:03Z'});

test('native C# distinct compiled read coverage reaches the existing controller without completing work',()=>workspace(()=>{
 const before=read(initial(),'first',[apiA]),after=read(before,'second',[apiA,apiB]);
 assert.deepEqual(epoch(before,after).progress_reasons,['controller_knowledge_added']);
 assert.equal(observationAdmissibilityForCriterionV2({snapshot:after,criterion:after.spec.criteria[0],observation:after.observations['obs-second']}).admissible,false);
 assert.deepEqual(after.criteria,before.criteria);assert.equal(after.terminal,false);
 assert.deepEqual(epoch(JSON.parse(JSON.stringify(before)),JSON.parse(JSON.stringify(after))),epoch(before,after));
}));
test('repeats, cosmetic sources, result text, subset reads and recombinations cannot renew discovery',()=>workspace(()=>{
 const one=read(initial(),'one',[apiA]),two=read(one,'two',[apiB]);
 for(const [name,members,opts] of [
  ['repeat',[apiB],{}],['comments',[apiB],{source:'// different comment\npublic class Inspect { }'}],
  ['output',[apiB],{output:'different timestamp or claimed progress'}],['combination',[apiA,apiB],{}],['reorder',[apiB,apiA],{}],
  ['different-selector',[apiB],{source:'public class Inspect { /* different target, same API: conservative */ }'}]
 ] as Array<[string,string[],any]>){const after=read(two,name,members,opts);assert.equal(epoch(two,after).genuine_progress,false,name);}
 const three=read(two,'three',[apiC]);assert.equal(epoch(two,three).genuine_progress,true);
 const resumed=structuredClone(three);resumed.current_binding={...resumed.current_binding,generation:2};
 const reread=read(resumed,'resumed',[apiC]);assert.equal(epoch(resumed,reread).genuine_progress,false,'resume does not forget prior coverage');
}));
test('native receipt, compilation metadata, source, binding and trust must agree',()=>workspace(()=>{
 const before=read(initial(),'seed',[apiA]);
 const native=(p:any,fn:(n:any)=>void)=>{const n=JSON.parse(p.evidence.nativeExecutionReceipt);fn(n);p.evidence.nativeExecutionReceipt=JSON.stringify(n);};
 const prep=(p:any,fn:(n:any)=>void)=>{const n=JSON.parse(p.evidence.snapshotReceipt);fn(n);p.evidence.snapshotReceipt=JSON.stringify(n);};
 const bad:Array<(p:any)=>void>=[p=>p.execution_ok=false,p=>p.execution_lane='snapshot',p=>p.iteration.source_sha256=sha('wrong'),
  p=>native(p,n=>n.source_hash=sha('wrong')),p=>native(p,n=>n.success=false),p=>native(p,n=>n.read_only=false),
  p=>native(p,n=>n.transaction.modified_element_ids=[1]),p=>native(p,n=>n.transaction.committed=true),p=>native(p,n=>n.document_fingerprint=sha('foreign')),
  p=>native(p,n=>n.preparation_id='foreign'),p=>native(p,n=>n.assembly_hash=sha('other')),p=>native(p,n=>n.native_binding_hash=sha('other')),
  p=>prep(p,n=>n.Scope.NativeScopeHash=sha('other')),p=>prep(p,n=>n.Scope.AllowCreate=true),p=>prep(p,n=>n.References=[]),
  p=>p.evidence.workerOutput.nativeProgramArtifact.directNativeMembers[0].id=apiC,
  p=>p.evidence.workerOutput.nativeProgramArtifact.directNativeMembers[0].mutationHint=true,
  p=>p.evidence.workerOutput.nativeProgramArtifact.directNativeMembers=[],p=>p.evidence.nativeExecutionReceipt='malformed'];
 for(const [i,mutate] of bad.entries()){const after=read(before,'bad-'+i,[apiB],{mutate});assert.equal(nativeProgramDiscoveryMembersV2(after,after.operations['bad-'+i]),null,String(i));assert.equal(epoch(before,after).genuine_progress,false,String(i));}
 for(const options of [{trust:'model_report'},{sourceLabel:'foreign-producer'}]){const after=read(before,'untrusted',[apiB],options);assert.equal(epoch(before,after).genuine_progress,false);}
}));
test('failed, stale, invalidated, detached and gapless observations cannot create progress',()=>workspace(()=>{
 const before=read(initial(),'seed',[apiA]),good=read(before,'next',[apiB]);
 for(const mutate of [
  (s:any)=>s.operations.next.result.status='failed_after_dispatch',(s:any)=>s.operations.next.dispatch_state='not_dispatched',
  (s:any)=>s.operations.next.result.raw_payload_hash='wrong',(s:any)=>s.operations.next.input.source+=' altered',
  (s:any)=>s.operations.next.binding={...binding,principal_id:'foreign'},(s:any)=>s.observations['obs-next'].binding={...binding,generation:0},
  (s:any)=>s.input_invalidated_operation_ids=['next'],(s:any)=>s.operations.next.observation_ids=[],
  (s:any)=>s.operations.next.resolves_gap_ids=[],(s:any)=>s.observations['obs-next'].facts[0].value=false
 ]){const after=structuredClone(good);mutate(after);assert.equal(epoch(before,after).genuine_progress,false,String(mutate));}
 assert.deepEqual(Object.keys(nativeProgramDiscoveryIdentitiesV2(good)),['seed','next']);
}));
