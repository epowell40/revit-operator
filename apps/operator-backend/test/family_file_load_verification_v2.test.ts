import test from 'node:test';import assert from 'node:assert/strict';
import {familyFileLoadVerificationFixtureV2 as fixture} from './fixtures/family_file_load_verification_fixture.js';
import {familySessionReadbackMatchesV2,familySessionVerificationTargetsV2} from '../src/verification/family_session_verification_v2.js';
import {operationTargetSelectorV2,verificationCapabilityAdmissionForPathsV2,verificationCapabilityGuidanceV2} from '../src/verification/verification_capability_admission_v2.js';

test('ordinary new file load matches a separate native Family and complete symbol identity read, not label or tag proof',()=>{
 const f=fixture();assert(familySessionReadbackMatchesV2(f.input,f.apply,f.read,f.payload));
 const all:any=structuredClone(f);all.read.body.elementIds=[1545058,1545319];all.payload.result=all.payload.result.filter((x:any)=>all.read.body.elementIds.includes(x.id));
 assert(familySessionReadbackMatchesV2(all.input,all.apply,all.read,all.payload));
});

test('file-load identity refuses overwritten/reloaded, rolled-back, incomplete and foreign observations',()=>{
 const f:any=fixture();for(const change of [
  (x:any)=>x.input.body.overwriteParameterValues=true,(x:any)=>x.input.body.unknown=true,
  (x:any)=>delete x.input.body.filePath,(x:any)=>x.input.body.filePath='bad.rvt',
  (x:any)=>x.apply.loaded=false,(x:any)=>x.apply.status='AlreadyLoaded',(x:any)=>x.apply.success=false,
  (x:any)=>x.apply.ok=false,(x:any)=>x.apply.applied=false,(x:any)=>x.apply.verified=false,
  (x:any)=>x.apply.transaction.status='rolled_back',(x:any)=>x.apply.transaction.committed=false,
  (x:any)=>x.apply.transaction.added_element_ids=[1545319],(x:any)=>x.apply.transaction.deleted_element_ids=[23],
  (x:any)=>x.apply.transaction.modified_element_ids=[24],(x:any)=>x.apply.changeTracking.exhaustiveChangeInventory=false,
  (x:any)=>x.apply.changeTracking.captureFailureCount=1,(x:any)=>x.apply.familyId=20,
  (x:any)=>x.apply.symbols.push(x.apply.symbols[0]),(x:any)=>x.apply.symbols[0].id=1545058,
  (x:any)=>x.payload.error='failed',(x:any)=>x.payload.truncated=true,(x:any)=>x.payload.itemsComplete=false,
  (x:any)=>x.read.path='/revit/inspect-family-content',(x:any)=>x.read.body.elementIds=[1545058],
  (x:any)=>x.read.body.elementIds=[1545058,1545319,25],(x:any)=>x.read.body.elementIds=[1545058,1545319,1545319],
  (x:any)=>x.payload.result[0].found=false,(x:any)=>x.payload.result[0].id=25,
  (x:any)=>x.payload.result[0].name='Other',(x:any)=>x.payload.result[0].className='FamilySymbol',
  (x:any)=>x.payload.result[0].fullClassName='Other',(x:any)=>delete x.payload.result[0].uniqueId,
  (x:any)=>x.payload.result[1].name='Other',(x:any)=>x.payload.result[1].className='Element',
  (x:any)=>x.payload.result[1].category=null,(x:any)=>x.payload.result.push(x.payload.result[0]),
  (x:any)=>x.payload={echo:x.payload},(x:any)=>x.input.method='GET'
 ]){const c=structuredClone(f);change(c);assert.equal(familySessionReadbackMatchesV2(c.input,c.apply,c.read,c.payload),false,change.toString());}
});

test('file-load admission and identity target binding exclude catalog, label and file-byte evidence',()=>{
 const f=fixture();const a=verificationCapabilityAdmissionForPathsV2(f.input.path,f.read.path,f.input.body,f.read.body);
 assert(a.admissible);assert.deepEqual(a.required_semantic_outputs,['family.loaded_identity']);
 for(const route of ['/revit/inspect-family-content','/revit/inspect-exported-files','/revit/model-health'])
  assert.equal(verificationCapabilityAdmissionForPathsV2(f.input.path,route,f.input.body,{}).admissible,false,route);
 assert.deepEqual(familySessionVerificationTargetsV2(f.apply),['id:1545058','id:1545319']);
 const target=operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:f.input.path},value:f.apply});
 assert.equal(target.source,'reviewed_capability_contract');assert.deepEqual(target.principal_target_tokens,['id:1545058','id:1545319']);
 const guidance=verificationCapabilityGuidanceV2({capability_id:'revit_call_tool',path:f.input.path});assert(guidance);assert.match(guidance,/identity only/i);
});
