import assert from 'node:assert/strict';
import test from 'node:test';
import { familyLabelStyleRequestV2, familyLabelStyleSatisfiedV2, familyLabelStyleTargetTokensV2,
  committedFamilyLabelStyleReadbackPlanV2 } from '../src/verification/family_label_style_v2.js';
import { postconditionSatisfiedByPayloadV2 } from '../src/postcondition_verification_v2.js';
import { operationTargetSelectorV2, verificationCapabilityAdmissionForPathsV2 } from '../src/verification/verification_capability_admission_v2.js';

// IDs/typography mirror the retained E101 label discovery. This is a
// deterministic contract fixture, not evidence of a live applied change.
const handle = 'a'.repeat(32), typeId = 788388, uid = 'current-child-document-type';
const baseline = {font:'Arial',textSizeFeet:2.5/304.8,bold:false,italic:false,underline:false,widthFactor:1};
const input = () => ({method:'POST',path:'/revit/set-family-label-style',body:{familyDocumentId:handle,labelTypeId:typeId,
  expectedTypeUniqueId:uid,style:{underline:true},expectedStyle:{...baseline},dryRun:false}});
const read = () => ({method:'POST',path:'/revit/inspect-family-label-styles',body:{familyDocumentId:handle,labelTypeId:typeId,maxStyles:1}});
const payload = () => ({ok:true,observational:true,mutated:false,scope:'family_session',familyDocumentId:handle,
  loadedProjectStyleVerified:false,truncated:false,count:1,totalStyles:1,
  items:[{labelTypeId:typeId,uniqueId:uid,style:{...baseline,underline:true},labelsComplete:true,labelCount:1,labelIds:[788445]}]});
const affected = ['element_id:'+typeId];

test('fresh exact family-session read proves the patch and every supplied preservation value',()=>{
  const i=input(),r=read(),p=payload();
  assert(familyLabelStyleSatisfiedV2(i,r,p,affected));
  assert(postconditionSatisfiedByPayloadV2(i,p,{verification_input:r,affected_target_identities:affected}));
  for(const mutate of [
    (p:any)=>p.items[0].style.underline=false,(p:any)=>p.items[0].style.font='Other',
    (p:any)=>p.items[0].style.textSizeFeet=0.02,(p:any)=>p.items[0].style.bold=true,
    (p:any)=>p.items[0].style.italic=true,(p:any)=>p.items[0].style.widthFactor=0.8,
    (p:any)=>p.items[0].uniqueId='another-type',(p:any)=>p.items[0].labelTypeId++,
    (p:any)=>p.familyDocumentId='b'.repeat(32),(p:any)=>p.scope='project',
    (p:any)=>p.items[0].labelsComplete=false,(p:any)=>p.items[0].labelCount=2,
    (p:any)=>p.items[0].labelIds=[788445,788445],(p:any)=>p.items[0].labelIds=[0],
    (p:any)=>p.truncated=true,(p:any)=>p.count=2,(p:any)=>p.totalStyles=2,
    (p:any)=>p.observational=false,(p:any)=>p.mutated=true,(p:any)=>p.loadedProjectStyleVerified=true,
    (p:any)=>p.error='partial',(p:any)=>p.ok=false,(p:any)=>p.isError=true,
    (p:any)=>delete p.items[0].style.underline,(p:any)=>p.items[0].style.underline='true'
  ]) { const changed=structuredClone(p);mutate(changed);assert.equal(familyLabelStyleSatisfiedV2(i,r,changed,affected),false,mutate.toString()); }
  assert.equal(familyLabelStyleSatisfiedV2(i,r,{request:p},affected),false);
  assert.equal(familyLabelStyleSatisfiedV2(i,r,p,[]),false);
  assert.equal(familyLabelStyleSatisfiedV2(i,{...r,path:'/revit/inspect-family-content'},p,affected),false);
  assert.equal(familyLabelStyleSatisfiedV2(i,{...r,body:{...r.body,familyDocumentId:'b'.repeat(32)}},p,affected),false);
  assert.equal(familyLabelStyleSatisfiedV2(i,{...r,body:{...r.body,labelTypeId:typeId+1}},p,affected),false);
  assert.equal(familyLabelStyleSatisfiedV2(i,{...r,body:{familyDocumentId:handle}},p,affected),false);
});

test('all typography values and false booleans are compared; invalid or unknown writes get no fallback credit',()=>{
  const i=input() as any,p=payload();
  i.body.style={font:'Arial',textSizeFeet:0.01,bold:false,italic:false,underline:false,widthFactor:0.9};
  p.items[0].style={...i.body.style};
  assert(familyLabelStyleSatisfiedV2(i,read(),p,affected));
  for(const patch of [
    {dryRun:true},{labelTypeId:'788388'},{familyDocumentId:'untracked'}, {expectedTypeUniqueId:''},
    {style:{}},{style:{underline:true},expectedStyle:{bold:false}}, {style:{underline:'true'}},
    {style:{font:' Arial'}},{style:{textSizeFeet:0}},{style:{textSizeFeet:Infinity}},
    {style:{widthFactor:101}},{style:{color:'red'}},{extra:true}
  ]) {
    const bad={...input(),body:{...input().body,...patch}};
    assert.equal(familyLabelStyleRequestV2(bad),null,JSON.stringify(patch));
    assert.equal(postconditionSatisfiedByPayloadV2(bad,p,{verification_input:read(),affected_target_identities:affected}),false);
  }
});

test('read capability and principal targets remain bound to the child document, not project numeric IDs',()=>{
  assert(verificationCapabilityAdmissionForPathsV2('/revit/set-family-label-style','/revit/inspect-family-label-styles',input().body,read().body).admissible);
  for(const path of ['/revit/get-parameters','/revit/inspect-family-content','/revit/set-family-label-style'])
    assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/set-family-label-style',path,input().body,read().body).admissible,false);
  assert.equal(verificationCapabilityAdmissionForPathsV2('/revit/set-family-label-style','/revit/inspect-family-label-styles',input().body,{familyDocumentId:handle}).admissible,false);
  const tokens=familyLabelStyleTargetTokensV2(input());
  assert.deepEqual(tokens,[`family_label_type:${handle}:${typeId}`]);
  assert.deepEqual(familyLabelStyleTargetTokensV2(payload()),tokens);
  assert.notDeepEqual(familyLabelStyleTargetTokensV2({...input().body,familyDocumentId:'b'.repeat(32)}),tokens);
  assert.deepEqual(operationTargetSelectorV2({operation:{capability_id:'revit_call_tool',path:input().path},value:input()}).principal_target_tokens,tokens);
});

test('automatic separate read retains pause, unknown effect, binding, identity, result and later-write fences',()=>{
  const binding={assignment_id:'style',run_id:'run',generation:1,session_id:'session',principal_id:'local',document_fingerprint:'model'};
  const op:any={operation_id:'apply',binding,input:input(),request_identity:{path:input().path,request_signature:'sig'},
    admission_state:'admitted',dispatch_state:'dispatched',settlement_state:'settled',requested_effect:'apply',persistent_effect:'applied',
    verification_operation_ids:[],opened_at:'2026-10-19T22:00:00Z',result:{operation_id:'apply',binding,status:'succeeded',authority:'native-host',
      native_transaction_state:'committed',persistent_effect:'applied',completed_at:'2026-10-19T22:00:01Z',request_identity:{request_signature:'sig'},affected_target_identities:affected}};
  const s:any={terminal:false,outcome:'active',current_binding:binding,unresolved_unknown_operation_ids:[],operations:{apply:op},observations:{},in_flight_operation_ids:[]};
  assert.deepEqual(committedFamilyLabelStyleReadbackPlanV2(s,op),read());
  for(const mutate of [
    (s:any)=>s.terminal=true,(s:any)=>s.outcome='awaiting_user_review',(s:any)=>s.completion_proposal={},
    (s:any)=>s.unresolved_unknown_operation_ids=['old'],(s:any)=>s.execution_control={state:'paused'},
    (s:any)=>s.input_invalidated_operation_ids=['apply'],(s:any,o:any)=>o.binding={...o.binding,generation:2},
    (s:any,o:any)=>o.result.authority='model',(s:any,o:any)=>o.result.native_transaction_state='pending',
    (s:any,o:any)=>o.result.request_identity.request_signature='foreign',(s:any,o:any)=>o.result.completed_at='invalid',
    (s:any,o:any)=>o.result.affected_target_identities=[],(s:any,o:any)=>o.verification_operation_ids=['read'],
    (s:any,o:any)=>o.requested_effect='preview',(s:any,o:any)=>o.settlement_state='awaiting_result',
    (s:any,o:any)=>s.operations.later={...o,operation_id:'later',opened_at:'2026-10-19T22:00:02Z'},
    (s:any,o:any)=>s.operations.unknown={...o,operation_id:'unknown',persistent_effect:'unknown',opened_at:'2026-10-19T21:00:00Z'}
  ]) { const copy=structuredClone(s);mutate(copy,copy.operations.apply);assert.equal(committedFamilyLabelStyleReadbackPlanV2(copy,copy.operations.apply),null,mutate.toString()); }
});
