import fs from'node:fs';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';
import assert from'node:assert/strict';import test from'node:test';
import{bound}from'./view_name_schedule_projection.fixtures.js';
import * as currentScope from '../src/verification/parameter_schedule_preservation_v2.js';
import * as currentPlan from '../src/verification/committed_parameter_readback_plan_v2.js';
import * as currentInspection from '../src/assignments/work_plan_inspection.js';
const previous=process.env.VIEW_NAME_BEFORE==='1';
const{parameterScheduleReadScopeV2}=previous?await import(pathToFileURL(path.resolve('dist/src/verification/parameter_schedule_preservation_v2.js')).href):currentScope;
const{committedParameterReadbackPlanV2}=previous?await import(pathToFileURL(path.resolve('dist/src/verification/committed_parameter_readback_plan_v2.js')).href):currentPlan;
const inspection=previous?await import(pathToFileURL(path.resolve('dist/src/assignments/work_plan_inspection.js')).href):currentInspection;

function fixture(){
 const actual=JSON.parse(fs.readFileSync('test/fixtures/view-name-list-projection-59.json','utf8'));
 const targets=actual.targets,ids=actual.extraIds,all=[...targets,...ids].sort((a:number,b:number)=>a-b);
 // Synthetic transaction/flat-parameter wrappers around retained native cells.
 // Never a historical commit/settlement/readback for the unknown59 operation.
 const rows=(phase:'before'|'after')=>ids.map((id:number)=>({elementId:id,
  uniqueId:id===1521731?actual.scheduleBefore.identity.uniqueId:`synthetic-schedule-${id}`,complete:true,scope:'flat_definition_table_parameters',
  definition:id===1521731?actual[phase==='before'?'scheduleBefore':'scheduleAfter']:
   {schema:'operator.schedule_definition_snapshot.v1',complete:true,identity:{id,uniqueId:`synthetic-schedule-${id}`,kind:'regular'},definition:{fields:[],table:[],tableStyles:[]}},
  parameters:[{id:7001,name:'Synthetic preserved parameter',storageType:'String',value:'unchanged'}]}));
 const applied={status:'Applied and Verified',dryRun:false,requestedCount:19,effectiveCount:19,changedCount:19,
  transaction:{status:'committed',committed:true,added_element_ids:[],deleted_element_ids:[],modified_element_ids:all,affected_element_ids:all},
  changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,captureFailureCount:0,matchingEventCount:1,distinctWrapperMatchCount:1},
  viewNameChanges:actual.observations,schedulePreservation:{schema:'operator.annotation_schedule_preservation.v1',complete:true,scheduleIds:ids,before:rows('before'),after:rows('after')}};
 const read={items:actual.after,schedulePreservation:{schema:'operator.annotation_schedule_read.v1',complete:true,requestedElementIds:ids,items:rows('after')}};
 return{targets,ids,input:actual.input,applied,read,readInput:{method:'POST',path:'/revit/get-parameters',body:{elementIds:targets,names:['Family and Type','View Name'],preservationScheduleIds:ids}}};
}
function isolated(run:()=>void){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'view-name-projection-'));process.env.OPERATOR_WORKSPACE_ROOT=root;try{run();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}
const list=(f:any,part:'before'|'after'='after')=>f.applied.schedulePreservation[part].find((r:any)=>r.elementId===1521731);
const body=(r:any)=>r.definition.definition.table.find((t:any)=>t.section==='Body');

test('exact retained19 name-cell deltas produce a full independent read plan, not an unchanged-schedule refusal',()=>isolated(()=>{
 const f=fixture(),{s,apply}=bound(f),plan=committedParameterReadbackPlanV2(s,apply);
 assert.deepEqual(plan.body.preservationScheduleIds,f.ids);
 assert.deepEqual(plan.body.names,['Family and Type','View Name']);
}));
test('current native view identities and exact expected View List cover the whole25-owner read scope',()=>isolated(()=>{
 const f=fixture(),{s,apply,read}=bound(f);
 assert.deepEqual(parameterScheduleReadScopeV2(s,apply,read),{target_ids:[...f.targets].sort((a,b)=>a-b),preserved_schedule_ids:[...f.ids].sort((a,b)=>a-b)});
 const result=inspection.retainWorkPlanInspectionV2(s,[read.operation_id]);
 assert.deepEqual(result.target_ids,[...f.targets,...f.ids].map(id=>'element_id:'+id).sort());
}));
for(const[label,mutate]of[
 ['missing-new-observation',(f:any)=>delete f.applied.viewNameChanges],
 ['incomplete',(f:any)=>f.applied.viewNameChanges.complete=false],
 ['wrong-observed-target',(f:any)=>f.applied.viewNameChanges.after[0].elementId=99],
 ['wrong-uid',(f:any)=>f.applied.viewNameChanges.after[0].uniqueId='foreign-native-view'],
 ['duplicate-uid',(f:any)=>{f.applied.viewNameChanges.before[0].uniqueId=f.applied.viewNameChanges.before[1].uniqueId;f.applied.viewNameChanges.after[0].uniqueId=f.applied.viewNameChanges.after[1].uniqueId;}],
 ['wrong-builtin',(f:any)=>f.applied.viewNameChanges.before[0].parameterId=999],
 ['wrong-family',(f:any)=>f.applied.viewNameChanges.after[0].familyAndType='Different family'],
 ['wrong-actual-name',(f:any)=>f.applied.viewNameChanges.after[0].name='Wrong name'],
 ['wrong-expected-old-name',(f:any)=>f.input.body.changes[0].expectedOldValue='Different before name'],
 ['mixed-parameter-request',(f:any)=>f.input.body.changes[0].parameterName='Comments'],
 ['arbitrary-table-text',(f:any)=>body(list(f)).rows[2].cells[2].text='Unexpected other column'],
 ['wrong-type-row',(f:any)=>body(list(f)).rows[2].cells[0].text='Ceiling Plan: RCP'],
 ['swapped-floor-ceiling-name',(f:any)=>{const r=body(list(f)).rows;const first=r.find((x:any)=>x.cells[1].text==='Plan HVAC L2'),second=r.find((x:any)=>x.cells[1].text==='RCP HVAC L2');[first.cells[1].text,second.cells[1].text]=[second.cells[1].text,first.cells[1].text];}],
 ['wrong-row-height',(f:any)=>body(list(f)).rows[2].heightFeet+=0.1],
 ['wrong-style',(f:any)=>body(list(f)).rows[2].cells[1].styleIndex=0],
 ['wrong-header',(f:any)=>list(f).definition.definition.table[0].rows[0].cells[0].text='Different title'],
 ['sort-change',(f:any)=>list(f).definition.definition.sort.push({fieldIndex:1,order:'Ascending'})],
 ['filtered-scope',(f:any)=>{list(f,'before').definition.definition.filters.push({fieldIndex:1});list(f).definition.definition.filters.push({fieldIndex:1});}],
 ['nonitemized',(f:any)=>{list(f,'before').definition.definition.IsItemized=false;list(f).definition.definition.IsItemized=false;}],
 ['hidden-column',(f:any)=>{list(f,'before').definition.definition.fields[0].hidden=true;list(f).definition.definition.fields[0].hidden=true;}],
 ['wrong-column-builtin',(f:any)=>{list(f,'before').definition.definition.fields[1].parameterId=99;list(f).definition.definition.fields[1].parameterId=99;}],
 ['preexisting-sort',(f:any)=>{list(f,'before').definition.definition.sort=[{fieldIndex:1,order:'Ascending'}];list(f).definition.definition.sort=[{fieldIndex:1,order:'Ascending'}];}],
 ['linked-view-list',(f:any)=>{list(f,'before').definition.identity.includeLinkedFiles=true;list(f).definition.identity.includeLinkedFiles=true;}],
 ['unrelated-parameter',(f:any)=>list(f).parameters[0].value='Changed'],
 ['foreign-schedule',(f:any)=>list(f).uniqueId='different-native-schedule'],
 ['extra-physical-owner',(f:any)=>{f.applied.transaction.modified_element_ids.push(999);f.applied.transaction.affected_element_ids.push(999);}],
 ['wrong-current-source-family',(f:any)=>f.read.items[0].parameters['Family and Type']='Different family'],
 ['wrong-current-builtin',(f:any)=>f.read.items[0].parameterDetails.find((d:any)=>d.parameterId===-1139998).parameterId=-1],
 ['wrong-current-view-uid',(f:any)=>f.read.items[0].uniqueId='foreign-view-uid'],
 ['missing-family-read',(f:any)=>{delete f.read.items[0].parameters['Family and Type'];f.read.items[0].parameterDetails=f.read.items[0].parameterDetails.filter((d:any)=>d.parameterId!==-1139998);}],
 ['old-current-table',(f:any)=>f.read.schedulePreservation.items=f.applied.schedulePreservation.before],
 ['later-table-edit',(f:any)=>body(f.read.schedulePreservation.items.find((r:any)=>r.elementId===1521731)).rows[2].cells[1].text='Later name'],
 ['duplicate-row-identity',(f:any)=>{const b=body(list(f,'before'));b.rows[3].cells[0].text=b.rows[2].cells[0].text;b.rows[3].cells[1].text=b.rows[2].cells[1].text;}]
]as const)test('derived View List proof rejects '+label,()=>isolated(()=>{
 const f=fixture();mutate(f);const{s,apply,read}=bound(f);
 assert.equal(parameterScheduleReadScopeV2(s,apply,read),null);
 assert.throws(()=>inspection.retainWorkPlanInspectionV2(s,[read.operation_id]),/incomplete_native_read/);
}));
for(const[label,mutate]of[
 ['Pause',(s:any)=>s.execution_control={state:'paused'}],
 ['historical-unknown',(s:any)=>s.unresolved_unknown_operation_ids=['original59-unknown']],
 ['foreign-binding',(s:any)=>s.current_binding={...s.current_binding,document_fingerprint:'foreign'}],
 ['wrong-digest',(s:any)=>s.operations.apply.result.raw_payload_hash='sha256:'+'0'.repeat(64)],
 ['stale-read',(s:any)=>s.operations.read.opened_at='2026-10-25T00:00:00Z'],
 ['wrong-pair',(s:any)=>s.operations.read.verification_of_operation_id='foreign'],
 ['invalidated',(s:any)=>s.input_invalidated_operation_ids=['read']],
 ['intervening-write',(s:any)=>s.operations.later={...s.operations.apply,operation_id:'later',result:{...s.operations.apply.result,completed_at:'2026-10-26T12:00:00.500Z'}}]
]as const)test('derived View List does not relax '+label,()=>isolated(()=>{
 const f=fixture(),{s,apply,read}=bound(f);mutate(s);assert.equal(parameterScheduleReadScopeV2(s,apply,read),null);
}));
