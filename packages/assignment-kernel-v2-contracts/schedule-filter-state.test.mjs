import test from 'node:test';import assert from 'node:assert/strict';
import { nativeScheduleFilterRequestV1, nativeScheduleFilterResultStateV1 } from './index.js';
const request={capability_id:'revit_call_tool',requested_effect:'apply',target:{target_id:'id:11'},
  request_identity:{capability_id:'revit_call_tool',method:'POST',path:'/revit/configure-schedule',request_signature:'exact'},
  input:{method:'POST',path:'/revit/configure-schedule',body:{scheduleId:11,filters:[{fieldId:2,op:'equals',value:'COHORT'},
    {fieldId:0,op:'begins_with',value:'P'}],replaceFilters:true,replaceSortGroup:false,dryRun:false}}};
const payload={success:true,status:'Success',dryRun:false,schedule:{id:11,uniqueId:'exact-schedule'},transaction:{status:'committed',committed:true},
  changeTracking:{documentChangedObserved:true,exhaustiveChangeInventory:true,captureFailureCount:0},
  filterReadback:[{fieldId:2,op:'Equal',value:'COHORT',valueType:'string'},{fieldId:0,op:'BeginsWith',value:'P',valueType:'string'}]};
test('filter-only replacement decodes exact ordered native field/operator/value state',()=>{
  assert.deepEqual(nativeScheduleFilterResultStateV1(request,payload),nativeScheduleFilterRequestV1(request));
  assert.match(nativeScheduleFilterRequestV1(request).state,/P/);
});
test('mixed edits, append, names, implicit dry-run and wrong native identity never qualify',()=>{
  for(const mutate of [o=>o.input.body.appearance={showTitle:false},o=>o.input.body.replaceFilters=false,
    o=>delete o.input.body.dryRun,o=>o.input.body.replaceSortGroup=true,o=>o.target.target_id='id:12',
    o=>o.input.path='/revit/set-parameter',o=>o.input.body.filters[1].field='Mark',o=>o.input.body.filters[1].extra='hidden',
    o=>o.input.body.filters[1].fieldId=-1,o=>o.input.body.filters[1].op='unsupported',o=>o.operation_role='child']){
    const o=structuredClone(request);mutate(o);assert.equal(nativeScheduleFilterRequestV1(o),undefined);
  }
});
test('counter-state proof rejects missing, truncated, contradictory or uncommitted readback',()=>{
  for(const mutate of [p=>delete p.filterReadback,p=>p.filterReadback.pop(),p=>p.filterReadback[1].fieldId=1,
    p=>p.filterReadback[1].value='p',p=>p.filterReadback[1].op='Contains',p=>p.schedule.id=12,
    p=>p.transaction.committed=false,p=>p.changeTracking.exhaustiveChangeInventory=false,
    p=>p.changeTracking.captureFailureCount=1,p=>p.truncated=true,p=>p.error='failed']){
    const p=structuredClone(payload);mutate(p);assert.equal(nativeScheduleFilterResultStateV1(request,p),undefined);
  }
});
test('empty, value-free and numeric rules retain distinct exact native states',()=>{
  for(const [filters,filterReadback]of [
    [[],[]],
    [[{fieldId:3,op:'has_value'}],[{fieldId:3,op:'HasValue'}]],
    [[{fieldId:3,op:'equals',value:100,valueType:'integer'}],[{fieldId:3,op:'Equal',value:100,valueType:'integer'}]]]){
    const o=structuredClone(request),p=structuredClone(payload);o.input.body.filters=filters;p.filterReadback=filterReadback;
    assert.deepEqual(nativeScheduleFilterResultStateV1(o,p),nativeScheduleFilterRequestV1(o));
  }
});
test('bounded rule parsing refuses excessive rule/value arrays and non-finite values',()=>{
  for(const filters of [Array.from({length:9},()=>({fieldId:0,op:'equals',value:'x'})),[{fieldId:0,op:'equals',value:Infinity}],
    [{fieldId:0,op:'equals',value:'x'.repeat(8193)}]]){
    const o=structuredClone(request);o.input.body.filters=filters;assert.equal(nativeScheduleFilterRequestV1(o),undefined);
  }
});
