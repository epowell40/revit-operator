import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {storeEvidence} from '../src/evidence/evidence_store.js';
import {openDuctPostconditionSatisfiedV2,combinedReadFollowsSettledChanges} from '../src/verification/open_duct_postcondition_v2.js';

function scenario(){
 const f=JSON.parse(fs.readFileSync('test/fixtures/native-route-defaults-repaired-thin.json','utf8'));
 const c=f.cases[0],subject=f.operations[c.subject_id],read=f.operations[c.read_id];
 const output='C:/fixture/drafting-milestone.rvt',identity={session_id:'native-model',project_fingerprint:f.current_binding.document_fingerprint,path:output};
 const completed=new Date(Date.parse(read.opened_at)-1).toISOString();
 const save=structuredClone(subject);save.operation_id='saved-milestone';save.input={method:'POST',path:'/revit/save-as',body:{filePath:output,overwrite:true}};
 save.request_identity={...subject.request_identity,method:'POST',path:'/revit/save-as',request_signature:'a'.repeat(64)};
 save.opened_at=new Date(Date.parse(completed)-1000).toISOString();save.observation_ids=[];save.verification_operation_ids=[];
 save.result={...structuredClone(subject.result),operation_id:save.operation_id,request_identity:structuredClone(save.request_identity),
  native_transaction_state:'not_applicable',result_schema_id:'operator-native/POST:/revit/save-as/v2',observation_required:true,
  raw_payload_hash:'b'.repeat(64),completed_at:completed,affected_target_identities:['artifact_path:'+output],
  native_artifact_receipt:{schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
   expected_output_paths:[output],expected_export_calls:1,export_calls:[true],outputs:[{path:output,size_bytes:4096,sha256:'c'.repeat(64),fresh_output:true,stable_read:true}],
   save_document:{native_save_returned:true,same_document:true,document_session_changed:false,document_path_changed:false,project_binding_changed:false,before:identity,after:identity}}};
 f.operations[save.operation_id]=save;return{f,c,subject,read,save,payload:f.payloads[c.read_id]};
}
function isolated(fn:()=>void){const prior=process.env.OPERATOR_WORKSPACE_ROOT,dir=fs.mkdtempSync(path.join(os.tmpdir(),'checkpoint-route-'));process.env.OPERATOR_WORKSPACE_ROOT=dir;
 try{fn();}finally{if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;fs.rmSync(dir,{recursive:true,force:true});}}

test('a settled same-document native SaveAs permits a later complete route read without pretending to be a transaction',()=>isolated(()=>{
 const {f,c,subject,read,save,payload}=scenario();
 const retained=storeEvidence({scope:{...f.current_binding,attempt_id:subject.operation_id},source:'assignment_kernel_v2:revit_call_tool',trust_level:'authoritative_native',raw:f.payloads[c.subject_id]});
 for(const id of subject.observation_ids)f.observations[id].raw_payload_ref='evidence:'+retained.ref.evidence_id;
 assert.equal(save.result.native_transaction_state,'not_applicable');
 assert.equal(combinedReadFollowsSettledChanges(f,read.result),true,'Document saves are settled artifact checkpoints, not failed model transactions.');
 assert.equal(openDuctPostconditionSatisfiedV2(f,subject,read.result,payload),true,'The unchanged complete native geometry/parameter/physical graph proof still has to pass.');
 const wrong=structuredClone(payload);wrong.verificationParameters.items[0].parameters.Diameter='2';
 assert.equal(openDuctPostconditionSatisfiedV2(f,subject,read.result,wrong),false,'A valid save never certifies wrong route content.');
}));

test('checkpoint classification rejects foreign, failed, incomplete, unknown, future and disguised artifact results',()=>{
 const mutations:Record<string,(x:ReturnType<typeof scenario>)=>void>={
  foreignOperation:x=>{x.save.binding={...x.save.binding,run_id:'foreign'};},
  foreignResult:x=>{x.save.result.binding={...x.save.result.binding,generation:999};},
  failed:x=>{x.save.result.status='failed_after_dispatch';},
  pending:x=>{x.save.settlement_state='open';},
  unknown:x=>{x.save.persistent_effect=x.save.result.persistent_effect='unknown';},
  missingReceipt:x=>{delete x.save.result.native_artifact_receipt;},
  incompleteFile:x=>{x.save.result.native_artifact_receipt.outputs[0].stable_read=false;},
  differentDocument:x=>{x.save.result.native_artifact_receipt.save_document.same_document=false;},
  wrongResultSchema:x=>{x.save.result.result_schema_id='arbitrary';},
  wrongRequestPath:x=>{x.save.request_identity.path='/revit/export-pdf';},
  wrongInputPath:x=>{x.save.input.path='/revit/export-pdf';},
  futureSave:x=>{x.save.result.completed_at=x.read.result.completed_at;},
  missingTime:x=>{delete x.save.result.completed_at;},
  disguisedTransaction:x=>{x.save.result.native_transaction_state='committed';delete x.save.result.native_artifact_receipt;},
  nativeWrapper:x=>{x.save.result.authority='operator-mcp-transport';},
  unknownRegistry:x=>{x.f.unresolved_unknown_operation_ids=['unknown-write'];}
 };
 for(const [name,mutate]of Object.entries(mutations)){const x=scenario();mutate(x);assert.equal(combinedReadFollowsSettledChanges(x.f,x.read.result),false,name);}
});
