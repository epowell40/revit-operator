import assert from 'node:assert/strict';
import test from 'node:test';
import { savedDocumentPostconditionV2 as nativeSavedDocumentPostconditionV2 } from '../src/verification/saved_document_postcondition_v2.js';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import { verificationCapabilityAdmissionV2 } from '../src/verification/verification_capability_admission_v2.js';

const exactRead={method:'POST',path:'/revit/inspect-exported-files',body:{paths:['C:/fixture/result.rvt']}};
const savedDocumentPostconditionV2=(input:unknown,receipt:unknown,read:unknown)=>nativeSavedDocumentPostconditionV2(input,receipt,read,exactRead);

function fixture(){
 const path='C:/fixture/result.rvt',identity={session_id:'native-document-1',project_fingerprint:'a'.repeat(64),path};
 const file={path,size_bytes:4096,sha256:'b'.repeat(64),exists:true,readable:true,stable_read:true,fresh_output:true};
 const receipt={schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/save-as',phase:'apply',status:'complete',
  expected_output_paths:[path],expected_export_calls:1,export_calls:[true],outputs:[file],
  save_document:{native_save_returned:true,same_document:true,document_session_changed:false,project_binding_changed:false,document_path_changed:true,
   before:{...identity,path:'C:/fixture/source.rvt'},after:identity}};
 const read={schema:'revit-operator.exported-file-inspection.v1',ok:true,itemsComplete:true,requestedPaths:[path],files:[{...file,fresh_output:false}],
  saved_document:{...identity,is_modified:false,is_modifiable:false,is_family_document:false}};
 return {input:{method:'POST',path:'/revit/save-as',body:{filePath:path,overwrite:false}},receipt,read};
}
test('saved output requires a separate exact native file and clean document readback',()=>{
 const {input,receipt,read}=fixture();assert(savedDocumentPostconditionV2(input,receipt,read));
 assert(postconditionSatisfiedByPayloadV2(input,read,{path:'/revit/save-as',native_artifact_receipt:receipt,
  verification_input:{method:'POST',path:'/revit/inspect-exported-files',body:{paths:read.requestedPaths}}}));
 assert(savedDocumentPostconditionV2({...input,body:{filePath:'result.rvt'}},receipt,read),'Native before path resolves relative save destination');
 assert(savedDocumentPostconditionV2({...input,body:{filePath:'c:\\fixture\\result.rvt'}},receipt,read));
});
test('same-document SaveAs path/session transition requires the exact fresh after identity',()=>{
 const {input,receipt,read}=fixture();
 receipt.save_document.document_session_changed=true;
 receipt.save_document.after.session_id='native-after-save';
 read.saved_document.session_id='native-after-save';
 assert(savedDocumentPostconditionV2(input,receipt,read));
 for(const session of [receipt.save_document.before.session_id,'unrelated-document']){
  const wrong=structuredClone(read);wrong.saved_document.session_id=session;
  assert.equal(savedDocumentPostconditionV2(input,receipt,wrong),false);
 }
 const inconsistent=structuredClone(receipt);inconsistent.save_document.document_session_changed=false;
 assert.equal(savedDocumentPostconditionV2(input,inconsistent,read),false,'Native transition flag must agree with identities');
 const reopened=structuredClone(receipt);reopened.save_document.same_document=false;
 assert.equal(savedDocumentPostconditionV2(input,reopened,read),false,'Different document never inherits save proof');
});
test('missing, dirty, foreign, unstable and changed saved output observations never satisfy a save',()=>{
 for(const mutate of [
  (r:any)=>{delete r.saved_document;},(r:any)=>{r.saved_document.is_modified=true;},(r:any)=>{delete r.saved_document.is_modified;},
  (r:any)=>{r.saved_document.is_modified='false';},(r:any)=>{r.saved_document.is_modifiable=true;},
  (r:any)=>{r.saved_document.path='C:/fixture/other.rvt';},(r:any)=>{r.saved_document.session_id='other';},
  (r:any)=>{r.saved_document.project_fingerprint='c'.repeat(64);},(r:any)=>{r.saved_document.is_family_document=true;},
  (r:any)=>{r.files[0].stable_read=false;},(r:any)=>{delete r.files[0].stable_read;},(r:any)=>{r.files[0].sha256='c'.repeat(64);},
  (r:any)=>{r.files[0].size_bytes++;},(r:any)=>{r.files[0].exists=false;},(r:any)=>{r.files[0].readable=false;},
  (r:any)=>{r.requestedPaths.push(r.requestedPaths[0]);},(r:any)=>{r.itemsComplete=false;},(r:any)=>{r.ok=false;}
 ]){const {input,receipt,read}=fixture();mutate(read);assert.equal(savedDocumentPostconditionV2(input,receipt,read),false);}
 const {input,receipt,read}=fixture();assert.equal(savedDocumentPostconditionV2({...input,body:{filePath:'C:/fixture/other.rvt'}},receipt,read),false);
 for(const mutate of [(r:any)=>{r.phase='preview';},(r:any)=>{r.save_document.native_save_returned=false;},
  (r:any)=>{r.save_document.document_session_changed=true;r.save_document.after.session_id='after';},
  (r:any)=>{r.save_document.project_binding_changed=true;r.save_document.after.project_fingerprint='c'.repeat(64);},
  (r:any)=>{r.outputs[0].fresh_output=false;}]){const invalid=structuredClone(receipt);mutate(invalid);assert.equal(savedDocumentPostconditionV2(input,invalid,read),false);}
 assert.equal(savedDocumentPostconditionV2(input,receipt,receipt),false,'Save response cannot verify itself');
 for(const request of [undefined,{...exactRead,method:'GET'},{...exactRead,path:'/revit/save-as'},
  {...exactRead,body:{paths:['C:/fixture/other.rvt']}},{...exactRead,body:{paths:[]}}])
  assert.equal(nativeSavedDocumentPostconditionV2(input,receipt,read,request),false,'Only the actual exact independent read can verify');
});
test('saved document semantic capability is unavailable for ordinary PDF inspection',()=>{
 const apply={capability_id:'revit_call_tool',method:'POST',path:'/revit/save-as',arguments:{body:{filePath:'C:/fixture/result.rvt'}}};
 const read=(paths:string[])=>({capability_id:'revit_call_tool',method:'POST',path:'/revit/inspect-exported-files',arguments:{body:{paths}}});
 assert(verificationCapabilityAdmissionV2({apply,verification:read(['C:/fixture/result.rvt'])}).admissible);
 for(const paths of [[],['C:/fixture/a.pdf'],['C:/fixture/result.rvt','C:/fixture/a.pdf']])
  assert.equal(verificationCapabilityAdmissionV2({apply,verification:read(paths)}).admissible,false);
});
