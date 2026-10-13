import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';

test('parameter batches require every target beyond the generic 32-value traversal bound',()=>{
 const changes=Array.from({length:100},(_,i)=>({elementId:100+i,parameterName:'Comments',value:'REVIEWED'}));
 const input={path:'/revit/set-parameter',body:{changes,apply:true,dryRun:false}};
 const items=changes.map(c=>({id:c.elementId,parameters:{Comments:c.value}}));
 assert.equal(postconditionSatisfiedByPayloadV2(input,{items}),true);
 assert.equal(postconditionSatisfiedByPayloadV2(input,{items:items.slice(0,32)}),false);
 const wrong=structuredClone(items);wrong[99]!.parameters.Comments='WRONG';
 assert.equal(postconditionSatisfiedByPayloadV2(input,{items:wrong}),false);
 assert.equal(postconditionSatisfiedByPayloadV2({...input,body:{...input.body,changes:[...changes,{elementId:999,parameterName:'Comments',value:'REVIEWED'}]}},{items}),false);
});

test('retained seven and 24 target reads keep exact identities, values and complete coverage',()=>{
 const f=JSON.parse(fs.readFileSync('test/fixtures/parameter-batch-readback-29.json','utf8').replace(/^\uFEFF/,''));
 assert.equal(postconditionSatisfiedByPayloadV2(f.seven.input,f.seven.read),true);
 assert.equal(postconditionSatisfiedByPayloadV2(f.twentyFour.input,f.twentyFour.partialRead),false);
 assert.equal(postconditionSatisfiedByPayloadV2(f.twentyFour.input,f.twentyFour.secondRead),false);
 const assembled={items:[...f.twentyFour.partialRead.items,...f.twentyFour.secondRead.items]};
 assert.equal(postconditionSatisfiedByPayloadV2(f.twentyFour.input,assembled),true,'constructed comparator vector, not retroactive proof');
 for(const mutate of [(r:any)=>r.items.pop(),(r:any)=>r.items[0].id=999999,
  (r:any)=>r.items[0].parameters={'Leader Line':'1'},
  (r:any)=>r.items[0].parameters={'Wrong Field':'0'}]) {
   const r=structuredClone(assembled);r.items.forEach((i:any)=>delete i.parameterDetails);mutate(r);
   assert.equal(postconditionSatisfiedByPayloadV2(f.twentyFour.input,r),false);
 }
});
