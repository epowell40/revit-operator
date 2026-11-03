import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {retainWorkPlanInspectionV2} from '../src/assignments/work_plan_inspection.js';
import {completeWorkPlanItemV2,inspectionIsCurrentV2} from '../src/domain/assignment-kernel/work_plan.js';

/** Generic native SaveAs/file-read shape from the installed checklist failure.
 * Synthetic paths and identities; no customer model or installed configuration. */
function fixture(route='/revit/save-as') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-artifact-inspection-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 const binding={assignment_id:'artifact-inspection',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'a'.repeat(64)};
 const output=route==='/revit/save-as'?'C:/fixture/result.rvt':'C:/fixture/result.pdf';
 const identity={path:output,project_fingerprint:binding.document_fingerprint,session_id:'after-save'};
 const file={path:output,size_bytes:4096,sha256:'b'.repeat(64),exists:true,readable:true,stable_read:true,fresh_output:true};
 const receipt:any={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:route,phase:'apply',status:'complete',
  expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[file]};
 if(route==='/revit/save-as')receipt.save_document={native_save_returned:true,same_document:true,project_binding_changed:false,document_session_changed:true,document_path_changed:true,
  before:{...identity,path:'C:/fixture/source.rvt',session_id:'before-save'},after:identity};
 const payload:any={schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,requestedPaths:[output],files:[{...file,fresh_output:false}]};
 if(route==='/revit/save-as')payload.saved_document={...identity,is_modified:false,is_modifiable:false,is_family_document:false};
 const applyInput={method:'POST',path:route,body:{filePath:output,overwrite:false,dryRun:false}},readInput={method:'POST',path:'/revit/inspect-exported-files',body:{paths:[output]}};
 const s:any={current_binding:binding,spec:{requested_effect:'apply'},operations:{},observations:{},criteria:{}};
 function retain(id:string,raw:any){const stored=storeEvidence({scope:{...binding,attempt_id:id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw});
  const hash=payloadDigestV2(raw).digest;
  s.observations[id]={operation_id:id,binding,authority:'native-host',evidence_class:id==='save'?'task_result':'verification',raw_payload_hash:hash,
   raw_payload_ref:'evidence:'+stored.ref.evidence_id,facts:id==='read'?[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]:[]};
  return hash;
 }
 const applyPayload={ok:true,artifact_receipt:receipt};
 s.operations.save={operation_id:'save',binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',input:applyInput,
  request_identity:{method:'POST',path:route},target:{target_id:'artifact_path:'+output.toLowerCase()},observation_ids:['save'],verification_operation_ids:['read'],
  result:{operation_id:'save',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',native_transaction_state:'not_applicable',
   completed_at:'2026-10-21T10:00:01Z',raw_payload_hash:retain('save',applyPayload),native_artifact_receipt:receipt}};
 s.operations.read={operation_id:'read',binding,requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',input:readInput,
  opened_at:'2026-10-21T10:00:02Z',request_identity:{method:'POST',path:readInput.path},target:{target_id:'artifact_path:'+output.toLowerCase()},
  observation_ids:['read'],verification_operation_ids:[],verification_of_operation_id:'save',result:{operation_id:'read',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',
   result_schema_id:'operator-native/POST:/revit/inspect-exported-files/v2',completed_at:'2026-10-21T10:00:03Z',raw_payload_hash:retain('read',payload)}};
 s.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[
  {item_id:'save',description:'Save requested output',source_basis:'User',declared_at:'2026-10-21T10:00:00Z',completed_at:'2026-10-21T10:00:04Z',operation_ids:['save']},
  {item_id:'inspect',kind:'inspection',description:'Inspect exact saved output',source_basis:'User',declared_at:'2026-10-21T10:00:00Z',depends_on:['save'],operation_ids:[]}]};
 return {s,payload,output,replaceRead:(raw:any)=>{s.operations.read.result.raw_payload_hash=retain('read',raw);},close:()=>{
  if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(root,{recursive:true,force:true});}};
}

for(const route of ['/revit/save-as','/revit/export-pdf'])test(`verified ${route} artifact read closes only its matching inspection`,()=>{
 const f=fixture(route);try{const before=structuredClone(f.s),proof=retainWorkPlanInspectionV2(f.s,['read']);
  assert.deepEqual(proof,{observation_ids:['read'],target_ids:['artifact_path:'+f.output.toLowerCase()]});
  const plan=completeWorkPlanItemV2(f.s,'inspect',['read'],'2026-10-21T10:00:05Z',proof);f.s.work_plan=plan;
  assert(inspectionIsCurrentV2(JSON.parse(JSON.stringify(f.s)),plan.items[1]!));
  assert.deepEqual(before.operations,f.s.operations,'No mutation replay or verification fact is manufactured');
  const other=structuredClone(before);other.operations.save.verification_operation_ids=['other-read'];
  assert.throws(()=>completeWorkPlanItemV2(other,'inspect',['read'],'2026-10-21T10:00:05Z',proof),{code:'work_plan_inspection_unverified'});
 }finally{f.close();}
});

for(const variant of ['unpaired','unverified','foreign-read','foreign-save','model-authority','wrong-schema','wrong-input-path','wrong-artifact','dirty-document','wrong-session','wrong-hash','partial','unstable','corrupt-read','corrupt-save','invalidated','unknown-save','stale','later-edit','wrong-dependency'] as const)
test(`saved artifact inspection refuses ${variant} proof`,()=>{
 const f=fixture(),s=f.s;try{
  if(variant==='unpaired')s.operations.read.verification_of_operation_id=null;
  if(variant==='unverified')s.observations.read.facts=[];
  if(variant==='foreign-read')s.operations.read.result.binding={...s.current_binding,run_id:'other'};
  if(variant==='foreign-save')s.operations.save.binding={...s.current_binding,run_id:'other'};
  if(variant==='model-authority')s.operations.read.result.authority='model';
  if(variant==='wrong-schema')s.operations.read.result.result_schema_id='operator-native/POST:/revit/other/v2';
  if(variant==='wrong-input-path')s.operations.read.input.body.paths=['C:/fixture/other.rvt'];
  if(variant==='wrong-artifact')f.payload.files[0].path='C:/fixture/other.rvt';
  if(variant==='dirty-document')f.payload.saved_document.is_modified=true;
  if(variant==='wrong-session')f.payload.saved_document.session_id='other-native-session';
  if(variant==='wrong-hash')f.payload.files[0].sha256='c'.repeat(64);
  if(variant==='partial')f.payload.itemsComplete=false;
  if(variant==='unstable')f.payload.files[0].stable_read=false;
  if(['wrong-artifact','dirty-document','wrong-session','wrong-hash','partial','unstable'].includes(variant))f.replaceRead(f.payload);
  if(variant==='corrupt-read')s.observations.read.raw_payload_hash='corrupt';
  if(variant==='corrupt-save')s.observations.save.raw_payload_hash='corrupt';
  if(variant==='invalidated')s.input_invalidated_operation_ids=['save'];
  if(variant==='unknown-save')s.operations.save.persistent_effect='unknown';
  if(variant==='stale')s.operations.read.opened_at='2026-10-21T09:59:59Z';
  if(variant==='later-edit')s.operations.later={persistent_effect:'applied',result:{completed_at:'2026-10-21T10:00:04Z'}};
  if(variant==='wrong-dependency')s.operations.save.result.native_artifact_receipt.outputs[0].path='C:/fixture/foreign.rvt';
  assert.throws(()=>{const proof=retainWorkPlanInspectionV2(s,['read']);completeWorkPlanItemV2(s,'inspect',['read'],'2026-10-21T10:00:05Z',proof);},
   (error:any)=>error.code==='work_plan_inspection_unverified'||error.message.startsWith('work_plan_inspection'));
 }finally{f.close();}
});
