import test from 'node:test';
import assert from 'node:assert/strict';
import { postconditionSatisfiedByPayloadV2 as verify } from '../src/postcondition_verification_v2.js';

const input={path:'/revit/create-view',body:{action:'create_view_template',sourceViewId:1363433,name:'TEST HVAC COORDINATION TEMPLATE'}};
const contract={affected_target_identities:['id:1542917']};
const read={status:'Ok',action:'get',dryRun:false,view:{id:1542917,name:input.body.name,isTemplate:true,viewType:'FloorPlan',scale:96,discipline:'Mechanical',detailLevel:'Medium',viewTemplateId:-1}};

test('template creation cannot pass on matching name without actual template identity',()=>{
 assert.equal(verify(input,read,contract),true);
 for(const patch of [{isTemplate:false},{isTemplate:undefined},{id:1363433},{id:99},{name:'Other template'}])
  assert.equal(verify(input,{...read,view:{...read.view,...patch}},contract),false,JSON.stringify(patch));
 assert.equal(verify(input,read,{}),false,'requires exact created identity');
 assert.equal(verify(input,{status:'Success',action:'create_view_template',view:read.view},contract),false,'apply response is not independent readback');
});

test('template readback rejects failed preview and conflicting envelopes',()=>{
 for(const patch of [{status:'Failed'},{action:'create_view_template'},{dryRun:true},{ok:false},{isError:true}])
  assert.equal(verify(input,{...read,...patch},contract),false);
 assert.equal(verify(input,{content:[{type:'text',text:JSON.stringify(read)}]},contract),true);
 assert.equal(verify(input,{isError:true,content:[{type:'text',text:JSON.stringify(read)}]},contract),false);
});

test('complete template list binds one exact new template and never joins neighboring attributes',()=>{
 const payload={status:'ok',action:'list',truncated:false,returned:1,views:[read.view]};
 assert.equal(verify(input,payload,contract),true);
 for(const patch of [{truncated:true},{returned:0},{dryRun:true},{returned:2,views:[read.view,read.view]},{views:[{...read.view,isTemplate:false}]}])
  assert.equal(verify(input,{...payload,...patch},contract),false);
 assert.equal(verify(input,{...payload,returned:2,views:[{...read.view,isTemplate:false},{...read.view,id:99}]},contract),false);
 assert.equal(verify({...input,body:{...input.body,action:'view_template'}},payload,contract),true);
 for(const patch of [{status:'Failed'},{views:[]}])
  assert.equal(verify(input,{...patch,content:[{type:'text',text:JSON.stringify(read)}]},contract),false);
 assert.equal(verify({...input,body:{...input.body,scale:48}},read,contract),false);
});
