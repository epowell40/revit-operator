import test from 'node:test';import assert from 'node:assert/strict';
import {createdScheduleReadbackComparisonV2}from '../src/verification/created_schedule_postcondition_v2.js';
import {identity,signature}from './fixtures/created_schedule_native_shape.js';
function fixture(clone=false){return {
 input:{method:'POST',path:'/revit/create-schedule',body:clone?{name:'Equipment Review',kind:'clone',sourceScheduleId:41}:{name:'Equipment Review',category:'Test Category',fields:['Mark']}},
 apply:{status:'Success',success:true,applied:true,created:true,viewId:42,definitionIdentity:identity(),categoryResolution:{categoryId:-123,error:null},sourceDefinitionBefore:clone?signature(41,'Source Equipment'):null,transaction:{status:'committed',committed:true,added_element_ids:[42],deleted_element_ids:[]}},
 read:{method:'POST',path:'/revit/schedules',body:{action:'detail',scheduleId:42,includeFields:true,...(clone?{includeDefinitionSnapshot:true}:{})}},
 payload:{status:'Ok',action:'detail',schedule:{id:42,uniqueId:'schedule-42',name:'Equipment Review',isTemplate:false,viewType:'Schedule',fieldCount:1},definitionIdentity:identity(),definitionSnapshot:signature(),fields:[{index:0,fieldId:0,name:'Mark',isHidden:false}],filterDefinitionsComplete:true,filterDefinitions:[],sortGroupDefinitionsComplete:true,sortGroupDefinitions:[],settings:{filterBySheet:false}}
};}
const check=(f:ReturnType<typeof fixture>,targets=['element_id:42'])=>createdScheduleReadbackComparisonV2(f.input,f.apply,f.read,f.payload,targets);
test('new native definition and unchanged clone compare independently, not via a mutation verified flag',()=>{
 for(const clone of [false,true]){const f=fixture(clone);assert.equal(check(f).state,'matched');(f.apply as any).verified=false;assert.equal(check(f).state,'matched');}
});
test('a missing or hidden requested field returns a useful discrepancy rather than accepting a success flag',()=>{
 const missing=fixture();missing.payload.fields=[];missing.payload.schedule.fieldCount=0;
 const result=check(missing);assert.equal(result.state,'mismatch');assert.equal(result.differences[0]?.subject,'schedule.field:Mark');
 const hidden=fixture();hidden.payload.fields[0]!.isHidden=true;assert.equal(check(hidden).state,'mismatch');
});
test('unrelated schedules, reused objects and request echoes never prove creation',()=>{
 for(const change of [(f:any)=>f.read.body.scheduleId=41,(f:any)=>f.payload.definitionIdentity.id=41,(f:any)=>f.apply.created=false,
  (f:any)=>delete f.apply.definitionIdentity,(f:any)=>f.payload={status:'Success',requested:f.payload},(f:any)=>f.apply.transaction.added_element_ids=[]]){
  const f=fixture();change(f);assert.notEqual(check(f).state,'matched');
 }
 assert.notEqual(check(fixture(),['element_id:41']).state,'matched');
});
test('native names, unique identity and resolved category must all agree',()=>{
 for(const change of [(f:any)=>{f.payload.definitionIdentity.name='Other';f.payload.schedule.name='Other';},
  (f:any)=>{f.payload.definitionIdentity.uniqueId='replacement';f.payload.schedule.uniqueId='replacement';},
  (f:any)=>f.payload.definitionIdentity.categoryId=-456,(f:any)=>f.apply.categoryResolution.categoryId=-456]){
  const f=fixture();change(f);assert.equal(check(f).state,'mismatch');
 }
});
test('clone comparison detects changed filters, phasing, column width, default format, table geometry and cell styles',()=>{
 for(const change of [(d:any)=>d.filters.push({fieldIndex:0,op:'BeginsWith',value:'P'}),(d:any)=>d.phaseId=22,
  (d:any)=>d.fields[0].sheetWidth=2,(d:any)=>d.fields[0].format={useDefault:false,unit:'changed'},
  (d:any)=>d.table[0].rows[0].heightFeet=0.2,(d:any)=>d.tableStyles[0].values.FontName='Other',
  (d:any)=>d.tableStyles[0].overrides.Font=true]){
  const f=fixture(true);change(f.payload.definitionSnapshot.definition);const result=check(f);assert.equal(result.state,'mismatch');assert.match(result.differences[0]?.subject??'',/^schedule\.clone\./);
 }
});

test('combined field constituents are compared and the larger snapshot requires explicit opt-in',()=>{
 const f=fixture(true);
 const parts=[{parameterId:7,categoryId:-123,Prefix:'(',Separator:' / ',Suffix:')',SampleValue:'example'}];
 (f.apply.sourceDefinitionBefore!.definition.fields[0] as any).combined=structuredClone(parts);
 (f.payload.definitionSnapshot.definition.fields[0] as any).combined=structuredClone(parts);
 assert.equal(check(f).state,'matched');
 (f.payload.definitionSnapshot.definition.fields[0] as any).combined[0].Separator='-';
 const result=check(f);assert.equal(result.state,'mismatch');
 assert.match(result.differences[0]!.subject,/combined\.0\.Separator$/);
 assert.deepEqual(result.differences[0]!.expected,[' / ']);assert.deepEqual(result.differences[0]!.observed,['-']);
 (f.read.body as any).includeDefinitionSnapshot=false;assert.equal(check(f).state,'incomplete');
});

test('clone discrepancy output stays bounded and reports omitted details',()=>{
 const f=fixture(true),d=f.payload.definitionSnapshot.definition as any;
 for(let i=0;i<12;i++)d.tableStyles[0].values['Test'+i]='x'.repeat(300);
 const result=check(f);assert.equal(result.state,'mismatch');assert.equal(result.differences.length,8);
 assert.equal(result.omitted,4);assert.ok(result.differences.every(v=>v.values_clipped&&v.observed[0]!.length===256));
});
test('incomplete definitions and conflicting clone source identity fail closed',()=>{
 for(const change of [(f:any)=>f.apply.sourceDefinitionBefore.complete=false,(f:any)=>f.payload.definitionSnapshot.complete=false,
  (f:any)=>f.input.body.sourceScheduleId=7,(f:any)=>f.apply.sourceDefinitionBefore.identity.id=42,
  (f:any)=>f.payload.definitionSnapshot.definition.table[0].rows=[],(f:any)=>f.payload.fields[0].name='Other']){
  const f=fixture(true);change(f);assert.notEqual(check(f).state,'matched');
 }
});
test('placement and combined clone changes remain partial until their own complete checks exist',()=>{
 const placed=fixture();(placed.input.body as any).placeOnSheet={sheetId:11,x:1,y:1};assert.equal(check(placed).state,'incomplete');
 const expanded=fixture(true);(expanded.input.body as any).addFields=['Comments'];assert.equal(check(expanded).state,'incomplete');
});
test('linked and sheet filtering requests compare actual native settings',()=>{
 for(const field of ['includeLinkedFiles','filterBySheet']){const f=fixture();(f.input.body as any)[field]=true;assert.equal(check(f).state,'mismatch');
  if(field==='includeLinkedFiles')f.payload.definitionIdentity.includeLinkedFiles=true;else f.payload.settings.filterBySheet=true;
  assert.equal(check(f).state,'matched');}
});
