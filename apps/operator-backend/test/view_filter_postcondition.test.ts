import test from 'node:test';
import assert from 'node:assert/strict';
import {postconditionSatisfiedByPayloadV2 as verify} from '../src/postcondition_verification_v2.js';
const input={path:'/revit/visibility',body:{action:'create_view_filter',viewId:9948,filterName:'Supply Ducts',categoryName:'OST_DuctCurves',ruleParameterName:'Comments',ruleOperator:'contains',ruleValue:'Supply',r:255,g:0,b:0,filterVisible:true}};
const rule={kind:'rule',nativeType:'FilterStringRule',parameterId:-1010106,parameterName:'Comments',builtInParameter:'ALL_MODEL_INSTANCE_COMMENTS',evaluator:'FilterStringContains',valueType:'string',value:'Supply'};
const definition={complete:true,categoryIds:[-2008000],categories:[{id:-2008000,name:'Ducts',builtInCategory:'OST_DuctCurves'}],rules:{kind:'and',inverted:false,children:[rule]}};
const filter={id:1542917,name:'Supply Ducts',visible:true,override:{color:{r:255,g:0,b:0}},definition};
const payload={status:'Ok',action:'get',dryRun:false,view:{id:9948,viewFilters:[filter]}};
const check=(p:unknown)=>verify(input,p,{path:input.path});
test('stored category/rule and same-view graphics establish filter postcondition',()=>{
 assert(check(payload));
 for(const patch of [{id:1420963},{viewFilters:[]},{viewFilters:[filter,filter]}]) assert.equal(check({...payload,view:{...payload.view,...patch}}),false);
 for(const patch of [{visible:false},{definition:undefined},{definition:{...definition,complete:false}},{override:{color:{r:0,g:0,b:0}}}])assert.equal(check({...payload,view:{...payload.view,viewFilters:[{...filter,...patch}]}}),false);
});
test('a matching atom inside a compound rule cannot certify the requested single predicate',()=>{
 for(const rules of [{kind:'or',inverted:false,children:[rule]}, {kind:'and',inverted:false,children:[rule,rule]}, {kind:'and',inverted:true,children:[rule]}, {...rule,value:'Return'}, {...rule,parameterName:'Mark',builtInParameter:'ALL_MODEL_MARK'}])
  assert.equal(check({...payload,view:{...payload.view,viewFilters:[{...filter,definition:{...definition,rules}}]}}),false);
 const neg={...input,body:{...input.body,ruleOperator:'not_contains'}};
 assert(verify(neg,{...payload,view:{...payload.view,viewFilters:[{...filter,definition:{...definition,rules:{kind:'not',child:rule}}}]}},{path:input.path}));
});
test('unknown categories, failed native replies and mutation echoes never prove stored rules',()=>{
 for(const patch of [{status:'Success',action:'create_view_filter'},{dryRun:true},{error:'read failed'},{isError:true}]) assert.equal(check({...payload,...patch}),false);
 assert.equal(check({input:input.body}),false);
 for(const patch of [{categories:[]},{categoryIds:[]},{categories:[...definition.categories,{id:1,name:'Walls'}]},{categories:[{id:-2008000,name:'Walls',builtInCategory:'OST_Walls'}]}])
  assert.equal(check({...payload,view:{...payload.view,viewFilters:[{...filter,definition:{...definition,...patch}}]}}),false);
});

test('numeric verification follows supported creation storage types and operators',()=>{
 const numeric=(valueType:string,value:unknown,evaluator='FilterNumericEquals')=>({...payload,view:{...payload.view,viewFilters:[{...filter,definition:{...definition,rules:{...rule,valueType,value,evaluator}}}]}});
 const request=(value:string,op='equals')=>({...input,body:{...input.body,ruleValue:value,ruleOperator:op}});
 for(const type of ['integer','element_id']) {
  assert(verify(request('12'),numeric(type,12),{path:input.path}));
  assert.equal(verify(request('12'),numeric(type,13),{path:input.path}),false);
 }
 for(const [value,type,evaluator] of [['12','double_internal_units','FilterNumericEquals'],['1.2','integer','FilterNumericEquals'],['1e2','integer','FilterNumericEquals'],['2147483648','integer','FilterNumericEquals'],['0','element_id','FilterNumericEquals'],['12','integer','FilterStringEquals']] as const)
  assert.equal(verify(request(value),numeric(type,Number(value),evaluator),{path:input.path}),false);
 assert.equal(verify(request('12','greater'),numeric('element_id',12,'FilterNumericGreater'),{path:input.path}),false);
 assert(verify(request('-12','greater'),numeric('integer',-12,'FilterNumericGreater'),{path:input.path}));
 assert(verify(request('2147483648'),numeric('element_id',2147483648),{path:input.path}));
 assert.equal(verify(request('9007199254740992'),numeric('element_id',9007199254740992),{path:input.path}),false);
});
