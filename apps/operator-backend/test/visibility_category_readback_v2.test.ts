import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import { committedVisibilityReadbackPlanV2 } from '../src/verification/committed_visibility_readback_plan_v2.js';

const input = {method:'POST',path:'/revit/visibility',body:{action:'set_category_override',viewId:42,categoryName:'OST_PlumbingFixtures',halftone:true}};
const read = {status:'Ok',action:'get',dryRun:false,view:{id:42,categoryOverride:{categoryId:-2001160,builtInCategory:'OST_PlumbingFixtures',halftone:true,lineWeight:2,color:{r:10,g:20,b:30}}}};
test('direct category halftone requires independent exact native category/view read; false is a value',()=>{
  assert(postconditionSatisfiedByPayloadV2(input,read));
  assert(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,halftone:false}}, {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,halftone:false}}}));
  for(const bad of [
    {...read,status:'Success',action:'set_category_override'}, {...read,truncated:true}, {...read,dryRun:true},
    {...read,view:{...read.view,id:43}}, {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,halftone:false}}},
    {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,halftone:'true'}}},
    {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,halftone:null}}},
    {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,builtInCategory:'OST_PipeCurves'}}},
    {...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,categoryId:null}}},
    {request:read}, {view:{id:42},request:read}, {...read,success:false},
  ])assert.equal(postconditionSatisfiedByPayloadV2(input,bad),false);
  for(const body of [{...input.body,linkedModelInstanceId:9},{...input.body,halftone:'true'}, {...input.body,categoryName:'Plumbing Fixtures'}, {...input.body,dryRun:true}])
    assert.equal(postconditionSatisfiedByPayloadV2({...input,body},read),false);
});

test('retained native display-label failure verifies independently without label-to-enum guesses',()=>{
  const fixture=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/category-display-label-readback-47.json'),'utf8'));
  const {apply_input:apply,verification_payload:payload}=fixture;
  assert(postconditionSatisfiedByPayloadV2(apply,payload));
  assert(postconditionSatisfiedByPayloadV2({...apply,body:{...apply.body,categoryName:'  plumbing fixtures  '}},payload));
  const category=payload.view.categoryOverride,snapshot=payload.view.categorySnapshot;
  for(const bad of [
    {...payload,action:'set_category_override'}, {...payload,truncated:true}, {...payload,dryRun:true},
    {...payload,view:{...payload.view,id:42}},
    {...payload,view:{...payload.view,categoryOverride:{...category,halftone:false}}},
    {...payload,view:{...payload.view,categoryOverride:{...category,halftone:'true'}}},
    {...payload,view:{...payload.view,categoryOverride:{...category,categoryName:'Pipes'}}},
    {...payload,view:{...payload.view,categoryOverride:{...category,categoryId:-2001320}}},
    {...payload,view:{...payload.view,categoryOverride:{...category,categoryId:'-2001160'}}},
    {...payload,view:{...payload.view,categoryOverride:{...category,builtInCategory:null}}},
    {...payload,view:{...payload.view,categorySnapshot:null}},
    {...payload,view:{...payload.view,categorySnapshot:{...snapshot,complete:false}}},
    {...payload,view:{...payload.view,categorySnapshot:{...snapshot,targetCategoryId:-2001320}}},
    {...payload,view:{...payload.view,categorySnapshot:{...snapshot,target:{...snapshot.target,name:'Pipes'}}}},
    {request:payload}, {...payload,view:{id:payload.view.id},request:payload},
  ]) assert.equal(postconditionSatisfiedByPayloadV2(apply,bad),false);
  for(const categoryName of ['Pipes','',{},'Plumbing Fixtures\n','OST_???'])
    assert.equal(postconditionSatisfiedByPayloadV2({...apply,body:{...apply.body,categoryName}},payload),false);
  // Same native selector/readback contract applies to every accepted display
  // name, including localized text and separators; no plumbing-only branch.
  for(const name of ['Luminaires électriques','Lighting:Fixtures','Walls']) {
    const native={...payload,view:{...payload.view,categoryOverride:{...category,categoryName:name},categorySnapshot:{...snapshot,target:{...snapshot.target,name}}}};
    assert(postconditionSatisfiedByPayloadV2({...apply,body:{...apply.body,categoryName:name}},native));
  }
});
test('combined graphics must verify every requested field without supplemental echoes',()=>{
  const mixed={...input,body:{...input.body,lineWeight:2,r:10,g:20,b:30}};
  assert(postconditionSatisfiedByPayloadV2(mixed,read));
  for(const change of [{lineWeight:3},{color:{r:10,g:21,b:30}},{halftone:false}])
    assert.equal(postconditionSatisfiedByPayloadV2(mixed,{...read,view:{...read.view,categoryOverride:{...read.view.categoryOverride,...change}},request:read}),false);
  assert.equal(postconditionSatisfiedByPayloadV2({...mixed,body:{...mixed.body,b:undefined}},read),false);
});
test('committed category planner preserves binding, settlement, pause and freshness fences',()=>{
  const binding={assignment_id:'a',run_id:'r',generation:1,session_id:'s',principal_id:'p',document_fingerprint:'d'};
  const op:any={operation_id:'opv2_'+'a'.repeat(64),binding,input,request_identity:{path:input.path,request_signature:'b'.repeat(64)},
    admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',verification_operation_ids:[],opened_at:'2026-10-13T12:00:00Z'};
  op.result={operation_id:op.operation_id,binding,status:'succeeded',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-13T12:00:01Z',request_identity:op.request_identity,affected_target_identities:['element_id:42']};
  const snapshot:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{[op.operation_id]:op},observations:{}};
  assert.deepEqual(committedVisibilityReadbackPlanV2(snapshot,op),{method:'POST',path:input.path,body:{action:'get',viewId:42,categoryName:'OST_PlumbingFixtures',includeCategoryState:true,includeLinkedModels:true}});
  for(const mutate of [(s:any,o:any)=>o.result.authority='model',(s:any,o:any)=>o.result.native_transaction_state='pending',
    (s:any,o:any)=>o.result.request_identity={...o.request_identity,request_signature:'bad'},(s:any,o:any)=>o.result.affected_target_identities=[],
    (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.unresolved_unknown_operation_ids=['old'],
    (s:any,o:any)=>o.binding={...o.binding,generation:2},(s:any)=>s.input_invalidated_operation_ids=[op.operation_id],
    (s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.verification_operation_ids=['existing'],
    (s:any,o:any)=>s.operations.later={...o,operation_id:'later',opened_at:'2026-10-13T12:01:00Z'},
  ]) {const s=structuredClone(snapshot),o=s.operations[op.operation_id];mutate(s,o);assert.equal(committedVisibilityReadbackPlanV2(s,o),null);}
});
