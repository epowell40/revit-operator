import assert from 'node:assert/strict';
import test from 'node:test';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
import {nativePropertyComparisonV2} from '../src/verification/native_property_comparison_v2.js';
// Prospective category contract, motivated by diagnostic159's actual Medium/Fine
// display difference. This synthetic native projection is not a historical pass.
const input={method:'POST',path:'/revit/visibility',body:{action:'set_category_override',viewId:42,categoryName:'Duct Accessories',detailLevel:'Fine'}};
const check={method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42,categoryName:'Duct Accessories',includeCategoryState:true}};
const payload={status:'Ok',action:'get',dryRun:false,view:{id:42,detailLevel:'Medium',categoryOverride:{categoryId:-2008016,categoryName:'Duct Accessories',builtInCategory:'OST_DuctAccessory',detailLevel:'Fine',halftone:false},categorySnapshot:{complete:true,targetCategoryId:-2008016,target:{id:-2008016,name:'Duct Accessories',graphics:{detailLevel:'Fine'}}}}};
test('category-only detail verifies independently without requiring whole-view Fine',()=>{
 assert(postconditionSatisfiedByPayloadV2(input,payload));
 assert.equal(nativePropertyComparisonV2(input,check,payload).state,'matched');
 for(const value of ['Coarse','Medium','Fine','Undefined']){
  const p=structuredClone(payload);p.view.categoryOverride.detailLevel=value;p.view.categorySnapshot.target.graphics.detailLevel=value;
  assert(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,detailLevel:value}},p));
 }
});
test('whole-view detail, request echoes, missing or conflicting category state cannot prove category detail',()=>{
 for(const mutate of [
  (p:any)=>delete p.view.categoryOverride.detailLevel,
  (p:any)=>p.view.categoryOverride.detailLevel='Medium',
  (p:any)=>p.view.categoryOverride.detailLevel=3,
  (p:any)=>delete p.view.categorySnapshot,
  (p:any)=>p.view.categorySnapshot.complete=false,
  (p:any)=>p.view.categorySnapshot.target.graphics.detailLevel='Medium',
  (p:any)=>delete p.view.categorySnapshot.target.graphics.detailLevel,
  (p:any)=>p.view.categorySnapshot.target.id++,
  (p:any)=>p.view.categoryOverride.categoryName='Pipe Accessories',
  (p:any)=>p.view.id++, (p:any)=>p.status='Blocked', (p:any)=>p.truncated=true,
  (p:any)=>p.action='set_category_override', (p:any)=>p.dryRun=true,
 ]){const p:any=structuredClone(payload);mutate(p);p.view.detailLevel='Fine';p.request=payload;assert.equal(postconditionSatisfiedByPayloadV2(input,p),false);}
 for(const value of ['',null,3,'3','Finest','Coarse,Fine'])assert.equal(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,detailLevel:value}},payload),false);
 assert.equal(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,linkedModelInstanceId:9}},payload),false);
 assert.equal(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,categoryName:'OST_PipeAccessory'}},payload),false);
});
test('combined category graphics require every field and preserve legacy unrequested detail behavior',()=>{
 const mixed={...input,body:{...input.body,halftone:true}};
 assert.equal(postconditionSatisfiedByPayloadV2(mixed,payload),false);
 const p=structuredClone(payload);p.view.categoryOverride.halftone=true;assert(postconditionSatisfiedByPayloadV2(mixed,p));
 const legacy={...input,body:{action:'set_category_override',viewId:42,categoryName:'Duct Accessories',halftone:false}};
 assert(postconditionSatisfiedByPayloadV2(legacy,payload));
 const wrong=structuredClone(payload);wrong.view.categoryOverride.detailLevel='Medium';wrong.view.categorySnapshot.target.graphics.detailLevel='Medium';
 assert.equal(nativePropertyComparisonV2(input,check,wrong).state,'mismatch');
});
