import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';
import { elementTypeRequestV2, elementTypeSatisfiedV2, committedElementTypeReadbackPlanV2 } from '../src/verification/element_type_postcondition_v2.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/element-type-readback-37.json','utf8'));
const readInput=(ids:number[])=>({method:'POST',path:'/revit/get-parameters',body:{elementIds:ids,names:['Type'],limit:100}});
test('retained E103 exact native type read passes, labels or incomplete/conflicting metadata cannot pass',()=>{
 const f=fixture(),affected=['element_id:1498153'],read=readInput([1498153]);
 assert(elementTypeSatisfiedV2(f.input,read,f.read,affected));
 assert(postconditionSatisfiedByPayloadV2(f.input,f.read,{verification_input:read,affected_target_identities:affected}));
 for(const mutate of [(p:any)=>p.items=[],(p:any)=>p.items.push(structuredClone(p.items[0])),
  (p:any)=>p.items[0].id=42,(p:any)=>p.items[0].uniqueId='',(p:any)=>p.items[0].found=false,
  (p:any)=>p.items[0].error='read failure',(p:any)=>delete p.items[0].parameterDetails,
  (p:any)=>p.items[0].parameterDetails[0].parameterId=42,(p:any)=>p.items[0].parameterDetails[0].storageType='String',
  (p:any)=>p.items[0].parameterDetails[0].value='1379884',(p:any)=>p.items[0].parameters.Type='1379884',
  (p:any)=>p.items[0].parameterDetails.push(structuredClone(p.items[0].parameterDetails[0]))]) {
   const p=structuredClone(f.read);mutate(p);assert.equal(elementTypeSatisfiedV2(f.input,read,p,affected),false,mutate.toString());
 }
 assert.equal(elementTypeSatisfiedV2(f.input,read,{request:f.read},affected),false);
 assert.equal(elementTypeSatisfiedV2(f.input,read,f.read,[]),false);
 assert.equal(elementTypeSatisfiedV2(f.input,readInput([42]),f.read,affected),false);
 assert.equal(elementTypeSatisfiedV2(f.input,{...read,path:'/revit/list-element-types'},f.read,affected),false);
 assert.equal(elementTypeSatisfiedV2(f.input,{...read,body:{elementIds:[1498153],names:['Name']}},f.read,affected),false);
});
test('every one of 100 selected instance types is checked, beyond generic scalar traversal bounds',()=>{
 const f=fixture(),ids=Array.from({length:100},(_,i)=>i+100),input={method:'POST',path:'/revit/change-element-type',body:{elementIds:ids,typeId:1735582,dryRun:false}};
 const items=ids.map(id=>({...structuredClone(f.read.items[0]),id,uniqueId:'native-'+id})),read=readInput(ids),affected=ids.map(id=>'element_id:'+id);
 assert(elementTypeSatisfiedV2(input,read,{items},affected));
 assert.equal(elementTypeSatisfiedV2(input,read,{items:items.slice(0,99)},affected),false);
 items[99].parameterDetails[0].value='1379884';assert.equal(elementTypeSatisfiedV2(input,read,{items},affected),false);
});
test('only unambiguous explicit native target/type IDs create a recipe',()=>{
 const f=fixture();assert.deepEqual(elementTypeRequestV2(f.input),{typeId:1735582,ids:[1498153]});
 for(const b of [{elementId:1,typeName:'Same name'}, {elementId:1,typeId:2,newTypeId:3},
  {elementId:1,elementIds:[1],typeId:2},{elementIds:[1,1],typeId:2},{elementIds:[],typeId:2},
  {elementIds:[0],typeId:2},{elementIds:Array.from({length:101},(_,i)=>i+1),typeId:2},
  {elementId:1,typeId:'2'}, {elementId:1,typeId:2,dryRun:true},{elementId:1,typeId:2,apply:false}]) assert.equal(elementTypeRequestV2({body:b}),null);
});
test('committed read recipe retains unknown, pause, binding, signature, chronology and later-write fences',()=>{
 const f=fixture(),binding={assignment_id:'type',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
 const op:any={operation_id:'apply',binding,input:f.input,request_identity:{path:'/revit/change-element-type',request_signature:'sig'},
  admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
  verification_operation_ids:[],opened_at:'2026-10-13T00:00:00Z',result:{operation_id:'apply',binding,status:'succeeded',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-13T00:00:01Z',request_identity:{request_signature:'sig'},affected_target_identities:['element_id:1498153']}};
 const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{apply:op},observations:{}};
 assert.deepEqual(committedElementTypeReadbackPlanV2(s,op),readInput([1498153]));
 for(const mutate of [(s:any)=>s.terminal=true,(s:any)=>s.outcome='awaiting_user_review',(s:any)=>s.completion_proposal={},
  (s:any)=>s.unresolved_unknown_operation_ids=['old'],(s:any)=>s.execution_control={state:'paused'},(s:any)=>s.input_invalidated_operation_ids=['apply'],
  (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any,o:any)=>o.result.authority='model',(s:any,o:any)=>o.result.native_transaction_state='pending',
  (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.completed_at='invalid',
  (s:any,o:any)=>o.result.affected_target_identities=[],(s:any,o:any)=>o.verification_operation_ids=['read'],
  (s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.settlement_state='awaiting_result',
  (s:any,o:any)=>s.operations.later={...o,operation_id:'later',opened_at:'2026-10-13T00:00:02Z'}]){
   const copy=structuredClone(s);mutate(copy,copy.operations.apply);assert.equal(committedElementTypeReadbackPlanV2(copy,copy.operations.apply),null,mutate.toString());
 }
});
