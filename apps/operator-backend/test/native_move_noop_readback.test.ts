import assert from 'node:assert/strict';import fs from 'node:fs';import test from 'node:test';
import {modelPointMoveReadbackMatchesV2} from '../src/verification/model_point_move_postcondition_v2.js';
test('retained114 unchanged native anchor does not satisfy a nonzero move even with a verified flag',()=>{
 const f=JSON.parse(fs.readFileSync('../revit-bridge-addin/RevitBridge.Common.Tests/Fixtures/move-no-displacement114.json','utf8').replace(/^\uFEFF/,''));
 const positive=JSON.parse(fs.readFileSync('test/fixtures/model-point-move-readback-59.json','utf8'));
 assert.equal(modelPointMoveReadbackMatchesV2(positive.input,positive.native_apply,positive.actual_read),true);
 for(const verified of [true,false]){
  const native={status:verified?'Moved':'Committed With Errors',success:verified,verified,applied:true,movedIds:f.request.ids,snapshots:f.snapshots,
   transaction:{status:'committed',committed:true,modified_element_ids:f.modifiedIds,added_element_ids:[],deleted_element_ids:[]},
   movePostcondition:{complete:true,satisfied:false}};
  const summary={result:[{id:1456396,found:true,className:'FamilyInstance',uniqueId:'bed11dae-78e0-4749-8f94-1323c272eae8-0016390c',location:{type:'point',x:f.snapshots[0].after.pointXyz[0],y:f.snapshots[0].after.pointXyz[1],z:f.snapshots[0].after.pointXyz[2],rotationRadians:f.snapshots[0].after.rotationRadians}}]};
  const request={...positive.input,body:f.request};
  assert.equal(modelPointMoveReadbackMatchesV2(request,native,summary),false);
  // Diagnostic clone isolates the no-displacement check, not authoritative collateral preservation.
  native.transaction.modified_element_ids=f.request.ids;
  assert.equal(modelPointMoveReadbackMatchesV2(request,native,summary),false);
 }
});
