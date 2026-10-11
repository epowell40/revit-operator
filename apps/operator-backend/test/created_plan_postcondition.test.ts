import test from 'node:test';
import assert from 'node:assert/strict';
import { postconditionSatisfiedByPayloadV2 as verify } from '../src/postcondition_verification_v2.js';
const input={path:'/revit/create-view',body:{action:'create_floor_plan',name:'M-LEVEL 2 COORDINATION',levelId:9946,scale:96,discipline:'Coordination'}};
const contract={affected_target_identities:['id:1542917']};
const read={status:'Ok',action:'get',dryRun:false,view:{id:1542917,name:'M-LEVEL 2 COORDINATION',isTemplate:false,viewType:'FloorPlan',levelId:9946,levelName:'L2',scale:96,discipline:'Coordination',detailLevel:'Medium',viewTemplateId:-1}};
test('created plan requires one complete independent native row on the created target',()=>{
 assert.equal(verify(input,read,contract),true);
 for(const patch of [{levelId:9947},{viewType:'CeilingPlan'},{isTemplate:true},{id:9948},{levelId:null},{discipline:'Mechanical'},{scale:48}])
  assert.equal(verify(input,{...read,view:{...read.view,...patch}},contract),false,JSON.stringify(patch));
 assert.equal(verify(input,read,{}),false,'created target identity is mandatory');
 assert.equal(verify(input,{name:read.view.name,scale:96,levelId:9946},contract),false);
 assert.equal(verify(input,{...read,view:{...read.view,levelId:9947},other:read},contract),false);
 for(const patch of [{status:'Failed'},{action:'create_floor_plan'},{dryRun:true},{ok:false},{isError:true}])assert.equal(verify(input,{...read,...patch},contract),false);
 assert.equal(verify(input,{content:[{type:'text',text:JSON.stringify(read)}]},contract),true);
 assert.equal(verify(input,{content:[{type:'text',text:JSON.stringify(read)},{type:'text',text:JSON.stringify(read)}]},contract),false);
});
test('plan defaults and explicitly requested level name, template and detail are checked',()=>{
 const body={name:read.view.name,levelName:'L2',templateId:183719,detailLevel:'Medium'};
 const good={...read,view:{...read.view,viewTemplateId:183719}};
 assert.equal(verify({path:input.path,body},good,contract),true);
 for(const patch of [{levelName:'L3'},{viewTemplateId:-1},{detailLevel:'Fine'}])assert.equal(verify({path:input.path,body},{...good,view:{...good.view,...patch}},contract),false);
 assert.equal(verify({...input,body:{...input.body,planType:'ceiling'}},read,contract),false);
});

test('complete view-list reader checks a single exact target without combining neighboring rows',()=>{
 const request={path:input.path,body:{action:'create_floor_plan',name:read.view.name,levelId:9946}};
 const view={...read.view,type:read.view.viewType};
 const payload={status:'ok',action:'list',truncated:false,returned:1,views:[view]};
 assert.equal(verify(request,payload,contract),true);
 assert.equal(verify(request,{...payload,views:[{...view,levelId:9947}]},contract),false);
 assert.equal(verify(request,{...payload,returned:2,views:[{...view,levelId:9947},{...view,id:99}]},contract),false);
 assert.equal(verify(request,{...payload,returned:2,views:[view,view]},contract),false);
 assert.equal(verify(request,{...payload,truncated:true},contract),false);
 assert.equal(verify(request,{...payload,returned:0},contract),false);
 const {scale,...withoutScale}=view;
 assert.equal(verify(input,{...payload,views:[withoutScale]},contract),false,'missing requested scale is not satisfied by a separate row');
});

test('failed or preview wrappers cannot be rescued by embedded successful reads',()=>{
 const content=[{type:'text',text:JSON.stringify(read)}];
 for(const patch of [{status:'Failed'},{status:'Success'},{views:[]},{isError:true}])assert.equal(verify(input,{...patch,content},contract),false);
 const list={status:'ok',action:'list',dryRun:true,truncated:false,returned:1,views:[{...read.view,type:'FloorPlan'}]};
 assert.equal(verify(input,list,contract),false);
});
