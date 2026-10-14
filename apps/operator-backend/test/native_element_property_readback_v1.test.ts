import test from 'node:test';import assert from 'node:assert/strict';
import {nativeElementBooleanReadbackV1,nativeElementBooleanReadTargetsV1} from '../src/verification/native_element_property_readback_v1.js';
import {postconditionSatisfiedByPayloadV2} from '../src/postcondition_verification_v2.js';
import {operationTargetSelectorV2} from '../src/verification/verification_capability_admission_v2.js';
const member='method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const type='Autodesk.Revit.DB.ViewSchedule';
function fixture(value=true){
 const input={method:'POST',path:'/revit/native-api-ops',body:{operations:[
  {id:'schedule',op:'call',target:'doc',memberId:member,args:[101]},
  {id:'striped',op:'get_property',target:'$schedule',property:'HasStripedRows'}],returns:['schedule','striped']}};
 const payload={version:'operator.native_api_ops.v2',ok:true,read_only:true,operation_count:2,operations:[
  {id:'schedule',op:'call',member_id:member,target_type:'Autodesk.Revit.DB.Document',result_preview:{id:101,unique_id:'native-schedule-uid'}},
  {id:'striped',op:'get_property',property:'HasStripedRows',target_type:type,result_preview:value}],results:{schedule:{id:101,unique_id:'native-schedule-uid'},striped:value}};
 return {input,payload};
}
test('real native getter shape binds returned true and false to the selected schedule',()=>{
 for(const expected of [true,false]){const f=fixture(expected);assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),expected);
  const apply={path:'/revit/configure-schedule',body:{scheduleId:101,appearance:{stripedRows:expected}}};
  assert.equal(postconditionSatisfiedByPayloadV2(apply,f.payload,{verification_input:f.input}),true);
  assert.equal(postconditionSatisfiedByPayloadV2({...apply,body:{...apply.body,scheduleId:102}},f.payload,{verification_input:f.input}),false);
  assert.equal(postconditionSatisfiedByPayloadV2(apply,f.payload,{verification_input:undefined}),false);
 }
});
test('normal target selection exposes only exact reviewed getter subjects',()=>{
 const f:any=fixture();assert.deepEqual(nativeElementBooleanReadTargetsV1(f.input),['id:101']);
 const operation={capability_id:'revit_call_tool',method:'POST',path:'/revit/native-api-ops',arguments:f.input};
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.input.body}).principal_target_tokens,['id:101']);
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.payload}).principal_target_tokens,['id:101']);
 assert.deepEqual(operationTargetSelectorV2({operation:{...operation,arguments:f.input.body},value:f.payload}).principal_target_tokens,['id:101'],"trusted route identity normalizes a typed body without caller path fields");
 f.payload.operations[0].result_preview.id=102;
 assert.deepEqual(operationTargetSelectorV2({operation,value:f.payload}).principal_target_tokens,[]);
 f.input.body.operations[1].target='$wrong';assert.deepEqual(nativeElementBooleanReadTargetsV1(f.input),[]);
});
test('native default returns and case-insensitive handles preserve actual gateway semantics',()=>{
 for(const returns of [undefined,null,[]]){const f:any=fixture(false);f.input.body.returns=returns;f.payload.results={striped:false};
  assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),false);}
 const f:any=fixture();f.input.body.operations[0].id=' Schedule ';f.input.body.operations[0].target=' DOCUMENT ';
 f.input.body.operations[1].target=' $SCHEDULE ';f.input.body.operations[1].property='hasstripedrows';
 f.input.body.returns=['SCHEDULE','$STRIPED'];f.payload.results={SCHEDULE:f.payload.results.schedule,STRIPED:true};
 assert.deepEqual(nativeElementBooleanReadTargetsV1(f.input),['id:101']);
 assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),true);
 f.payload.results.striped=false;assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),undefined);
});
test('malformed, wrong-owner, mismatched or missing scalar reads never become property proof',()=>{
 const changes=[
  (f:any)=>delete f.input.body.operations[0].memberId,
  (f:any)=>f.input.body.operations[0].args=[102],
  (f:any)=>f.input.body.operations[0].target='other_doc',
  (f:any)=>f.input.body.operations[1].target='$wrong',
  (f:any)=>f.payload.operations[0].result_preview.id=102,
  (f:any)=>delete f.payload.operations[0].result_preview.unique_id,
  (f:any)=>f.payload.operations[1].target_type='Autodesk.Revit.DB.Element',
  (f:any)=>f.payload.operations[1].property='ShowHeaders',
  (f:any)=>f.payload.operation_count=1,
  (f:any)=>f.payload.read_only=false,
  (f:any)=>f.payload.ok=false,
  (f:any)=>delete f.payload.results.striped,
  (f:any)=>f.payload.results.striped=false,
  (f:any)=>f.payload.operations[1].result_preview='true',
  (f:any)=>f.input.body.returns=['schedule'],
  (f:any)=>f.payload.operations[1].id='schedule',
  (f:any)=>f.input.path='/revit/native-api-mutation-ops'
 ];
 for(const change of changes){const f=fixture();change(f);assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),undefined);}
});
test('read of another schedule cannot be combined with the requested identity lookup',()=>{
 const f:any=fixture();f.input.body.operations.splice(1,0,{id:'other',op:'call',target:'doc',memberId:member,args:[102]});
 f.payload.operations.splice(1,0,{id:'other',op:'call',member_id:member,target_type:'Autodesk.Revit.DB.Document',result_preview:{id:102,unique_id:'other'}});
 f.input.body.operations[2].target='$other';f.payload.operation_count=3;
 assert.equal(nativeElementBooleanReadbackV1(f.input,f.payload,101,'HasStripedRows',type),undefined);
});
test('invented schedule-summary properties and request echoes cannot substitute for native getters',()=>{
 const f:any=fixture();delete f.payload.results.striped;delete f.payload.operations[1].result_preview;
 f.payload.results.schedule.HasStripedRows=true;f.payload.request={appearance:{stripedRows:true}};
 assert.equal(postconditionSatisfiedByPayloadV2({path:'/revit/configure-schedule',body:{scheduleId:101,appearance:{stripedRows:true}}},f.payload,{verification_input:f.input}),false);
});
