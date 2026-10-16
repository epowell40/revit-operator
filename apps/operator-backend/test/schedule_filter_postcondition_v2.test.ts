import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedPostconditionValuesV2, observedReadbackCallValuesV2, postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';

const filters = [{fieldId:2,op:'equals',value:'COHORT'}, {fieldId:0,op:'begins_with',value:'P'}];
const input = {scheduleId:11,filters,replaceFilters:true,dryRun:false};
const contract = {path:'/revit/configure-schedule',verification_input:{path:'/revit/schedules',body:{action:'detail',scheduleId:11}}};
function detail() { return {status:'Ok',action:'detail',schedule:{id:11,fieldCount:2},
  fields:[{fieldId:0,name:'Mark'},{fieldId:2,name:'Comments'}],
  filterDefinitionsComplete:true,filterDefinitions:filters.map((x,index)=>({...x,index,field:x.fieldId===0?'Mark':'Comments',readable:true}))}; }
const matches=(payload:unknown,request:unknown=input)=>postconditionSatisfiedByPayloadV2(request,payload,contract);

test('exact native numeric filter readback includes field zero and both AND rules',()=>{
  assert.equal(matches(detail()),true);
  const expected=expectedPostconditionValuesV2(input,true,contract);
  const observed=observedReadbackCallValuesV2(detail(),{path:contract.path,raw_body:input},{path:'/revit/schedules',raw_body:{action:'detail',scheduleId:11}});
  assert.ok(expected.length>0 && expected.every(x=>observed.has(x)), 'legacy controller uses the same target-bound contract');
  assert.equal(matches({content:[{type:'text',text:JSON.stringify(detail())}]}),true);
});

test('names resolve uniquely in the exact schedule field inventory, not table headings',()=>{
  const named={...input,filters:[{field:'Comments',op:'equals',value:'COHORT'},{field:'mark',op:'begins-with',value:'P'}]};
  assert.equal(matches(detail(),named),true);
  const ambiguous=detail(); ambiguous.fields.push({fieldId:3,name:'Mark'}); ambiguous.schedule.fieldCount++;
  assert.equal(matches(ambiguous,named),false);
  const missing=detail(); missing.fields=missing.fields.slice(1);
  assert.equal(matches(missing,named),false);
});

const invalidReads:Record<string,(x:any)=>unknown>={
  'wrong schedule':x=>({...x,schedule:{...x.schedule,id:12}}),
  'missing schedule':x=>({...x,schedule:undefined}),
  'missing rule':x=>({...x,filterDefinitions:x.filterDefinitions.slice(0,1)}),
  'extra rule':x=>({...x,filterDefinitions:[...x.filterDefinitions,{...x.filterDefinitions[1],index:2,value:'X'}]}),
  'duplicate rule':x=>({...x,filterDefinitions:[...x.filterDefinitions,{...x.filterDefinitions[1],index:2}]}),
  'wrong field zero':x=>({...x,filterDefinitions:x.filterDefinitions.map((f:any)=>f.fieldId===0?{...f,fieldId:1}:f)}),
  'wrong operator':x=>({...x,filterDefinitions:x.filterDefinitions.map((f:any)=>({...f,op:'contains'}))}),
  'case sensitive value':x=>({...x,filterDefinitions:x.filterDefinitions.map((f:any)=>f.fieldId===0?{...f,value:'p'}:f)}),
  'unreadable':x=>({...x,filterDefinitions:x.filterDefinitions.map((f:any)=>({...f,readable:false}))}),
  'incomplete':x=>({...x,filterDefinitionsComplete:false}),
  'truncated':x=>({...x,truncated:true}),
  'error envelope':x=>({isError:true,content:[{type:'text',text:JSON.stringify(x)}]}),
  'native failure':x=>({...x,status:'Error'}),
  'apply echo':x=>({...x,action:'configure'}),
  'request copy':x=>({metadata:{request:x}}),
  'unbound second payload':x=>({content:[{type:'text',text:JSON.stringify({...x,schedule:{id:12}})},{type:'text',text:JSON.stringify(x)}]}),
  'wrong ordinal':x=>({...x,filterDefinitions:x.filterDefinitions.map((f:any)=>({...f,index:0}))})
};
for(const [name,mutate] of Object.entries(invalidReads))test(`filter postcondition refuses ${name}`,()=>assert.equal(matches(mutate(detail())),false));

test('empty replacement needs explicit complete empty read, not absent filters',()=>{
  const empty={...input,filters:[]};
  assert.equal(matches({...detail(),filterDefinitions:[]},empty),true);
  assert.equal(matches({...detail(),filterDefinitions:[],filterDefinitionsComplete:false},empty),false);
  assert.equal(matches({...detail(),filterDefinitions:undefined},empty),false);
  assert.equal(matches(detail(),empty),false);
});

test('invalid requests and unsupported unit conversions never turn into empty-set proof',()=>{
  for(const filters of [[{fieldId:-1,op:'equals',value:'P'}],[{fieldId:0,op:'mystery',value:'P'}],
    [{fieldId:0,op:'equals',value:'P',valueType:'display'}], [{fieldId:0,op:'equals'}]])
    assert.equal(matches({...detail(),filterDefinitions:[]},{...input,filters}),false);
  assert.equal(postconditionSatisfiedByPayloadV2(input,detail(),{...contract,verification_input:{path:'/revit/schedules',body:{action:'detail',scheduleId:12}}}),false);
});

test('mixed filter and appearance edits require both postconditions',()=>{
  const mixed={...input,appearance:{stripedRows:true}};
  assert.equal(matches({...detail(),appearance:{stripedRows:true}},mixed),true);
  assert.equal(matches({...detail(),appearance:{stripedRows:false}},mixed),false);
  assert.equal(matches({...detail(),filterDefinitions:[],appearance:{stripedRows:true}},mixed),false);
});
