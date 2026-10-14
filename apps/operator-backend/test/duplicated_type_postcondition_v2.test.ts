import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { duplicatedTypeReadbackMatchesV2 } from '../src/verification/duplicated_type_postcondition_v2.js';
const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/duplicated-type-readback-40.json','utf8'));
const read={method:'POST',path:'/revit/get-parameters',body:{elementIds:[1521972,1735584],names:['Type','Type Name','Label','Description'],includeEmpty:true,limit:100}};
test('retained native duplicate plus separate native values checks type ownership, name and every requested parameter',()=>{
 const f=fixture();assert(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,f.read));
 for(const mutate of [
  (f:any)=>f.input.body.dryRun=true,(f:any)=>f.input.body.typeParamChanges.push(f.input.body.typeParamChanges[0]),
  (f:any)=>f.input.body.typeParamChanges[0].parameterName='Type Name',
  (f:any)=>f.applied.success=false,(f:any)=>f.applied.typeParameterChangesComplete=false,(f:any)=>f.applied.newTypeId=f.applied.sourceTypeId,
  (f:any)=>f.applied.swappedToTypeId=42,(f:any)=>f.applied.transaction.status='pending',
  (f:any)=>f.applied.transaction.added_element_ids=[],(f:any)=>f.applied.transaction.deleted_element_ids=[1521972],
  (f:any)=>f.applied.missingAfterElementIds=[1521972],(f:any)=>f.applied.typeParamDiffs.pop(),
  (f:any)=>f.applied.typeParamDiffs[0].ok=false,(f:any)=>f.applied.requestedTypeParamChanges=1,
  (f:any)=>f.read.items[0].id=42,(f:any)=>f.read.items[1].id=1521972,(f:any)=>f.read.items[0].uniqueId='',
  (f:any)=>f.read.items[0].parameterDetails[0].parameterId=42,(f:any)=>f.read.items[0].parameterDetails[0].storageType='String',
  (f:any)=>f.read.items[0].parameters.Type='1379884',(f:any)=>f.read.items[1].name='Standard',
  (f:any)=>f.read.items[1].parameterDetails.find((p:any)=>p.name==='Type Name').parameterId=42,
  (f:any)=>f.read.items[1].parameterDetails.find((p:any)=>p.name==='Label').value='WP',
  (f:any)=>f.read.items[1].parameters.Description='WP GFCI',
  (f:any)=>f.read.items[1].parameterDetails.find((p:any)=>p.name==='Description').storageType='Double',
  (f:any)=>delete f.read.items[1].parameterDetails,
 ]){const bad=structuredClone(f);mutate(bad);assert.equal(duplicatedTypeReadbackMatchesV2(bad.input,bad.applied,read,bad.read),false,mutate.toString());}
 for(const invalid of [{...read,path:'/revit/set-parameter'},{...read,body:{...read.body,elementIds:[1521972]}},
  {...read,body:{...read.body,names:['Type','Label']}},{...read,body:{...read.body,elementIds:[1521972,42]}}])
  assert.equal(duplicatedTypeReadbackMatchesV2(f.input,f.applied,invalid,f.read),false);
 assert.equal(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,{request:f.read}),false);
});
test('native ChangeTypeId replacement is accepted only with actual creation and deletion identities',()=>{
 const f=fixture();f.applied.resultingInstanceId=1735587;f.applied.transaction.added_element_ids.push(1735587);f.applied.transaction.deleted_element_ids.push(1521972);f.read.items[0].id=1735587;
 const r={...read,body:{...read.body,elementIds:[1735587,1735584]}};
 assert(duplicatedTypeReadbackMatchesV2(f.input,f.applied,r,f.read));
 f.applied.transaction.deleted_element_ids=[];assert.equal(duplicatedTypeReadbackMatchesV2(f.input,f.applied,r,f.read),false);
});
test('empty strings and numeric integer fields have explicit comparisons; converted dimensional values stay unchecked',()=>{
 const f=fixture(),field=f.read.items[1].parameterDetails.find((p:any)=>p.name==='Label');
 f.input.body.typeParamChanges[0].value='';field.value='';f.read.items[1].parameters.Label='';assert(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,f.read));
 f.input.body.typeParamChanges[0].value=' +03 ';field.storageType='Integer';field.value='3';f.read.items[1].parameters.Label='3';assert(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,f.read));
 f.input.body.typeParamChanges[0].value='3.0';assert.equal(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,f.read),false);
 f.input.body.typeParamChanges[0].value='3 in';field.storageType='Double';field.value='0.25';f.read.items[1].parameters.Label='0.25';assert.equal(duplicatedTypeReadbackMatchesV2(f.input,f.applied,read,f.read),false);
});
