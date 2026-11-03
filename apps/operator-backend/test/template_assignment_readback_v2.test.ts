import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import test from 'node:test';
import {postconditionSatisfiedByPayloadV2,expectedPostconditionValuesV2}from '../src/postcondition_verification_v2.js';
import {nativePropertyComparisonV2}from '../src/verification/native_property_comparison_v2.js';
const retained=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/template-assignment162.json'),'utf8'));
const fixture=()=>structuredClone(retained);
const matches=(f:any)=>postconditionSatisfiedByPayloadV2(f.applyInput,f.payload,{path:'/revit/visibility',verification_input:f.readInput,affected_target_identities:f.affectedTargets});
test('exact162 committed template assignment has a typed independent native readback',()=>assert.equal(matches(fixture()),true));
test('exact162 model-visible comparison distinguishes assignment from unsupported property',()=>assert.equal(nativePropertyComparisonV2(retained.applyInput,retained.readInput,retained.payload).state,'matched'));
test('template selection uses native trim/case semantics, explicit detach uses null name and -1 ID',()=>{
 const f=fixture();f.applyInput.body.templateName='  '+f.applyInput.body.templateName.toUpperCase()+'  ';assert(matches(f));
 for(const name of ['', '  ']){const f=fixture();f.applyInput.body.templateName=name;f.payload.view.viewTemplate=null;f.payload.view.viewTemplateId=-1;assert(matches(f));}
});
const negatives:Record<string,(f:any)=>void>={
 'wrong view':f=>f.payload.view.id++, 'wrong template':f=>f.payload.view.viewTemplate='Different Template',
 'missing name':f=>delete f.payload.view.viewTemplate, 'missing ID':f=>delete f.payload.view.viewTemplateId,
 'string ID':f=>f.payload.view.viewTemplateId=String(f.payload.view.viewTemplateId),
 'invalid ID':f=>f.payload.view.viewTemplateId=-1,'unsafe ID':f=>f.payload.view.viewTemplateId=Number.MAX_SAFE_INTEGER+1,
 'self assignment':f=>f.payload.view.viewTemplateId=f.payload.view.id,'template instead of view':f=>f.payload.view.isTemplate=true,
 'missing isTemplate':f=>delete f.payload.view.isTemplate,
 'echoed request':f=>{f.payload.request={...f.applyInput.body};f.payload.view.viewTemplate='Other';},
 'commit response':f=>{f.payload.status='Success';f.payload.action='set_template';},
 'preview read':f=>f.payload.dryRun=true,'failed read':f=>f.payload.error='read failed',
 'truncation':f=>f.payload.truncated=true,
 'wrong read route':f=>f.readInput.path='/revit/views','wrong read method':f=>f.readInput.method='GET',
 'wrong read view':f=>f.readInput.body.viewId++,'mutation as read':f=>f.readInput.body.action='set_template',
 'preview request':f=>f.applyInput.body.dryRun=true,'read-only request':f=>f.applyInput.body.apply=false,
 'wrong apply route':f=>f.applyInput.path='/revit/create-view','foreign source':f=>f.applyInput.body.linkedModelInstanceId=2,
 'extra mutation field':f=>f.applyInput.body.scale=20,'unsupported ID selector':f=>f.applyInput.body.templateId=1546041,
 'missing requested name':f=>delete f.applyInput.body.templateName,'non-string requested name':f=>f.applyInput.body.templateName=null,
 'control character name':f=>f.applyInput.body.templateName+='\nOther',
 'uncovered affected owner':f=>f.affectedTargets.push('element_id:1521731'),
 'wrong affected owner':f=>f.affectedTargets=['element_id:1546041'],'missing affected owners':f=>f.affectedTargets=[],
 'foreign read scope':f=>f.readInput.body.linkedModelInstanceId=2,
 'detach missing value is not explicit none':f=>{f.applyInput.body.templateName='';delete f.payload.view.viewTemplate;f.payload.view.viewTemplateId=-1;},
 'detach retained positive ID':f=>{f.applyInput.body.templateName='';f.payload.view.viewTemplate=null;},
};
for(const [name,mutate]of Object.entries(negatives))test('template assignment refuses '+name,()=>{const f=fixture();mutate(f);assert.equal(matches(f),false);});
test('template assignment mismatch feedback stays separate from observed whole-view/detail settings',()=>{
 const f=fixture();f.payload.view.viewTemplate='Different Template';assert.equal(nativePropertyComparisonV2(f.applyInput,f.readInput,f.payload).state,'mismatch');
 delete f.payload.view.viewTemplateId;assert.equal(nativePropertyComparisonV2(f.applyInput,f.readInput,f.payload).state,'incomplete');
 assert.equal(expectedPostconditionValuesV2({...f.applyInput,body:{...f.applyInput.body,templateId:9}},true).length,0);
});
