import assert from 'node:assert/strict';import test from 'node:test';
import {committedVisibilityReadbackPlanV2}from '../src/verification/committed_visibility_readback_plan_v2.js';
function fixture():any{
 const binding={assignment_id:'template',run_id:'run',generation:1,session_id:'session',principal_id:'local:test',document_fingerprint:'model'};
 const request={path:'/revit/visibility',request_signature:'template-request'};
 const op={operation_id:'apply',binding,requested_effect:'apply',persistent_effect:'applied',settlement_state:'settled',admission_state:'admitted',dispatch_state:'dispatched',
  input:{method:'POST',path:request.path,body:{action:'set_template',viewId:42,templateName:'Mechanical'}},request_identity:request,verification_operation_ids:[],observation_ids:[],opened_at:'2026-10-30T00:00:00Z',
  result:{operation_id:'apply',status:'succeeded',binding,authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',request_identity:request,completed_at:'2026-10-30T00:00:01Z',affected_target_identities:['element_id:42']}};
 return {current_binding:binding,outcome:'active',terminal:false,operations:{apply:op},observations:{},unresolved_unknown_operation_ids:[],input_invalidated_operation_ids:[]};
}
test('template assignment reuses one existing getter without issuing another mutation',()=>{
 const s=fixture(),before=structuredClone(s);assert.deepEqual(committedVisibilityReadbackPlanV2(s,s.operations.apply),{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42}});assert.deepEqual(s,before);
});
const faults:Record<string,(s:any)=>void>={
 paused:(s:any)=>s.execution_control={state:'paused'},terminal:(s:any)=>s.terminal=true,
 unknown:(s:any)=>s.unresolved_unknown_operation_ids=['other'],invalidated:(s:any)=>s.input_invalidated_operation_ids=['apply'],
 foreign:(s:any)=>s.operations.apply.binding={...s.current_binding,generation:2},failed:(s:any)=>s.operations.apply.result.status='failed',
 nonnative:(s:any)=>s.operations.apply.result.authority='model',rolledback:(s:any)=>s.operations.apply.result.native_transaction_state='rolled_back',
 checked:(s:any)=>s.operations.apply.verification_operation_ids=['read'],
 laterwrite:(s:any)=>{s.operations.next={...structuredClone(s.operations.apply),operation_id:'next',opened_at:'2026-10-30T00:00:02Z'};},
 wrongrequest:(s:any)=>s.operations.apply.result.request_identity={request_signature:'other'},
 missingtarget:(s:any)=>s.operations.apply.result.affected_target_identities=[],
 preview:(s:any)=>s.operations.apply.input.body.dryRun=true,
};
for(const [name,mutate]of Object.entries(faults)){test('template automatic read preserves '+name+' refusal',()=>{const s=fixture();mutate(s);const before=structuredClone(s);assert.equal(committedVisibilityReadbackPlanV2(s,s.operations.apply),null);assert.deepEqual(s,before);});}
