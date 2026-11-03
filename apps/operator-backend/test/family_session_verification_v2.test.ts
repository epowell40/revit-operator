import test from 'node:test';import assert from 'node:assert/strict';
import {familySessionVerificationFixtureV2 as fixture} from './fixtures/family_session_verification_fixture.js';
import {familySessionReadbackMatchesV2, familySessionVerificationTargetsV2} from '../src/verification/family_session_verification_v2.js';
import {familySessionSavedV1} from '../src/verification/family_session_open_v1.js';
import {verificationCapabilityAdmissionForPathsV2,operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';

test('relative family save requires native full-path resolution, never a matching basename',()=>{
 const f:any=fixture('save');assert(familySessionSavedV1(f.input.path,f.input.body,f.apply));
 for(const change of [
  (f:any)=>delete f.apply.family_save_receipt.path_resolution,
  (f:any)=>f.apply.family_save_receipt.path_resolution.requested_path='other/Underlined.rfa',
  (f:any)=>f.apply.family_save_receipt.path_resolution.workspace_root='C:\\OtherWorkspace',
  (f:any)=>f.apply.family_save_receipt.path_resolution.workspace_root='relative',
  (f:any)=>f.apply.family_save_receipt.path_resolution.resolved_path='C:\\Other\\Underlined.rfa',
  (f:any)=>f.apply.family_save_receipt.path_resolution.inside_workspace=false,
  (f:any)=>f.input.body.filePath='../escape.rfa',
  (f:any)=>f.input.body.filePath='C:relative.rfa',
  (f:any)=>f.apply.family_save_receipt.sha256='invalid'
 ]){const c=structuredClone(f);change(c);assert.equal(familySessionSavedV1(c.input.path,c.input.body,c.apply),false,change.toString());}
 const absolute=structuredClone(f);absolute.input.body.filePath=f.apply.filePath;delete absolute.apply.family_save_receipt.path_resolution;
 assert(familySessionSavedV1(absolute.input.path,absolute.input.body,absolute.apply));
});

test('saved-family read independently matches exact native digest and clean owned child state',()=>{
 const f:any=fixture('save');assert(familySessionReadbackMatchesV2(f.input,f.apply,f.read,f.payload));
 for(const change of [
  (f:any)=>f.read.body.familyDocumentId='b'.repeat(32),(f:any)=>delete f.read.body.familyDocumentId,
  (f:any)=>f.read.body.paths=['C:\\Other\\Underlined.rfa'],(f:any)=>f.read.path='/revit/inspect-family-content',
  (f:any)=>f.payload.saved_document.family_session_id='b'.repeat(32),(f:any)=>f.payload.saved_document.is_modified=true,
  (f:any)=>f.payload.saved_document.is_modifiable=true,(f:any)=>f.payload.saved_document.is_family_document=false,
  (f:any)=>f.payload.saved_document.path='C:\\Other\\Underlined.rfa',(f:any)=>f.payload.itemsComplete=false,
  (f:any)=>f.payload.error='failed',(f:any)=>f.payload.isError=true,(f:any)=>f.payload.truncated=true,
  (f:any)=>f.payload.files[0].sha256='d'.repeat(64),(f:any)=>f.payload.files[0].size_bytes++,
  (f:any)=>f.payload.files[0].stable_read=false,(f:any)=>f.payload.files[0].exists=false,
  (f:any)=>f.payload.files[0].readable=false,(f:any)=>f.payload.files.push({...f.payload.files[0]}),
  (f:any)=>f.payload.requestedPaths=['C:\\Other\\Underlined.rfa'],(f:any)=>f.payload={request:f.payload},
  (f:any)=>f.apply.saved=false,(f:any)=>f.apply.familyDocumentId='b'.repeat(32)
 ]){const c=structuredClone(f);change(c);assert.equal(familySessionReadbackMatchesV2(c.input,c.apply,c.read,c.payload),false,change.toString());}
});

test('load proof is the exact newly loaded native Family identity, not a symbol or a name echo',()=>{
 const f:any=fixture('load');assert(familySessionReadbackMatchesV2(f.input,f.apply,f.read,f.payload));
 const withSymbol=structuredClone(f);withSymbol.read.body.elementIds=[101,100];
 withSymbol.payload.result.push({id:101,found:true,uniqueId:'loaded-symbol-uid',name:'Standard',className:'FamilySymbol',fullClassName:'Autodesk.Revit.DB.FamilySymbol'});
 assert(familySessionReadbackMatchesV2(withSymbol.input,withSymbol.apply,withSymbol.read,withSymbol.payload));
 const foreign=structuredClone(withSymbol);foreign.read.body.elementIds[0]=102;foreign.payload.result[1].id=102;
 assert.equal(familySessionReadbackMatchesV2(foreign.input,foreign.apply,foreign.read,foreign.payload),false);
 for(const change of [
  (f:any)=>f.read.body.elementIds=[101],(f:any)=>f.read.body.elementIds=[100,101],
  (f:any)=>f.payload.result[0].id=101,(f:any)=>f.payload.result[0].uniqueId='foreign-uid',
  (f:any)=>f.payload.result[0].found=false,(f:any)=>f.payload.result[0].className='FamilySymbol',
  (f:any)=>f.payload.result[0].fullClassName='Other',(f:any)=>f.payload.result[0].name='Other',
  (f:any)=>f.payload={request:f.payload},(f:any)=>f.apply.family_reload_receipt.project_readback_verified=false,
  (f:any)=>f.apply.familyDocumentId='b'.repeat(32),(f:any)=>f.read.path='/revit/inspect-family-label-styles'
 ]){const c=structuredClone(f);change(c);assert.equal(familySessionReadbackMatchesV2(c.input,c.apply,c.read,c.payload),false,change.toString());}
});

test('admission separates tracked saved-family, active saved-model and loaded-family semantics',()=>{
 const save:any=fixture('save'),load:any=fixture('load');
 assert(verificationCapabilityAdmissionForPathsV2(save.input.path,save.read.path,save.input.body,save.read.body).admissible);
 assert.equal(verificationCapabilityAdmissionForPathsV2(save.input.path,save.read.path,save.input.body,{paths:save.read.body.paths}).admissible,false);
 assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/save-as',save.read.path,{filePath:'x.rfa'},save.read.body).admissible,false);
 for(const familyDocumentId of [null,'','invalid']) assert.equal(verificationCapabilityAdmissionForPathsV2(save.input.path,save.read.path,save.input.body,{...save.read.body,familyDocumentId}).admissible,false);
 assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/save-as',save.read.path,{filePath:'x.rvt'},{...save.read.body,paths:['C:\\OperatorWorkspace\\x.rvt']}).admissible,false);
 assert(verificationCapabilityAdmissionForPathsV2(load.input.path,load.read.path,load.input.body,load.read.body).admissible);
 assert.equal(verificationCapabilityAdmissionForPathsV2(load.input.path,'/revit/inspect-family-label-styles',load.input.body,{familyDocumentId:'a'.repeat(32)}).admissible,false);
 const target='family_session:'+'a'.repeat(32);
 assert.deepEqual(familySessionVerificationTargetsV2(save.input),[target]);
 assert(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:save.read.path},value:save.read}).principal_target_tokens.includes(target));
});
