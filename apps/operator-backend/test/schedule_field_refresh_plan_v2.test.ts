import test from 'node:test';import assert from 'node:assert/strict';
import type {AssignmentSnapshotV2}from '../src/domain/assignment-kernel/index.js';
import {checkedEditIsCurrentV2}from '../src/verification/current_postcondition_v2.js';
import {regularScheduleCheckNeedsRefreshV2,operationNeedsReadbackV2}from '../src/verification/regular_schedule_recheck_v2.js';
import {committedRegularSchedulePresentationReadbackPlanV2}from '../src/verification/regular_schedule_presentation_v2.js';
function fixture():AssignmentSnapshotV2{
 const binding={assignment_id:'schedule-refresh',run_id:'run',generation:1,session_id:'session',principal_id:'local:test',document_fingerprint:'model'};
 const request={method:'POST',path:'/revit/configure-schedule',request_signature:'format-request'};
 const op={operation_id:'formats',binding,requested_effect:'apply',purpose:'work',persistent_effect:'applied',settlement_state:'settled',admission_state:'admitted',dispatch_state:'dispatched',
  input:{method:'POST',path:request.path,body:{scheduleId:41,fieldFormats:[{field:'Description',widthFeet:.3}],dryRun:false}},request_identity:request,target:{target_id:'id:41'},
  verification_operation_ids:['read'],observation_ids:[],opened_at:'2026-10-17T01:00:00Z',settled_assignment_version:2,
  result:{operation_id:'formats',binding,status:'succeeded',dispatch_state:'dispatched',authority:'native-host',native_transaction_state:'committed',persistent_effect:'applied',
   completed_at:'2026-10-17T01:00:01Z',request_identity:request,affected_target_identities:['element_id:41'],receipt_id:'receipt:formats',native_correlation_id:'native:formats'}};
 const read={operation_id:'read',binding,requested_effect:'read',purpose:'verification',persistent_effect:'none',settlement_state:'settled',verification_of_operation_id:'formats',
  verification_operation_ids:[],observation_ids:['observed'],input:{method:'POST',path:'/revit/schedules',body:{action:'presentation',scheduleId:41}},request_identity:{path:'/revit/schedules'},
  target:{target_id:'id:41'},opened_at:'2026-10-17T01:00:02Z',settled_assignment_version:3,
  result:{status:'succeeded',binding,authority:'native-host',raw_payload_hash:'native-read-hash',completed_at:'2026-10-17T01:00:02Z'}};
 const later:any=structuredClone(op);later.operation_id='order';later.verification_operation_ids=[];later.opened_at='2026-10-17T01:00:03Z';later.settled_assignment_version=4;
 later.input.body={scheduleId:41,fieldOrder:[3,2,1],appearance:{showTitle:true},dryRun:false};later.result={...later.result,operation_id:'order',completed_at:'2026-10-17T01:00:04Z'};
 return {current_binding:binding,operations:{formats:op,read,order:later},observations:{observed:{operation_id:'read',binding,authority:'native-host',raw_payload_hash:'native-read-hash',
  facts:[{fact_id:'verification.postcondition_satisfied',fact_class:'verification',value:true}]}},terminal:false,outcome:'active',quiescent:true,
  unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],input_invalidated_operation_ids:[]}as unknown as AssignmentSnapshotV2;
}
const plan=(s:AssignmentSnapshotV2)=>committedRegularSchedulePresentationReadbackPlanV2(s,s.operations.formats!);
test('checked scalar formats get a new ordinary native read after a disjoint order/style edit, never a new apply',()=>{
 const s=fixture(),before=structuredClone(s);assert.equal(checkedEditIsCurrentV2(s,'formats'),false);
 assert(regularScheduleCheckNeedsRefreshV2(s,s.operations.formats!));assert(operationNeedsReadbackV2(s,s.operations.formats!));
 assert.deepEqual(plan(s),{method:'POST',path:'/revit/schedules',body:{action:'presentation',scheduleId:41}});assert.deepEqual(s,before);
});
test('bounded explicit nonbody row height can request fresh scalar formatting evidence',()=>{
 const s:any=fixture();s.operations.order!.input.body={scheduleId:41,rowHeights:[{section:'Header',rowNumber:0,heightFeet:.048}],dryRun:false};
 assert(regularScheduleCheckNeedsRefreshV2(s,s.operations.formats!));assert(plan(s));
 for(const rowHeights of [[{section:'Body',rowNumber:1,heightFeet:.1}],[{section:'Header',heightFeet:.1}],[{section:'Header',rowNumber:0,heightFeet:0}]]){
  s.operations.order!.input.body={scheduleId:41,rowHeights};assert.equal(plan(s),null);
 }
});
const faults:Record<string,(s:any)=>void>={
 'already current':s=>{delete s.operations.order;},
 'new field intent':s=>{s.operations.order.input.body={scheduleId:41,fieldFormats:[{field:'Description',widthFeet:.4}]};},
 'other field intent not covered by this comparator':s=>{s.operations.order.input.body={scheduleId:41,fieldFormats:[{field:'Remarks',hidden:true}]};},
 'structural edit':s=>{s.operations.order.input.body={scheduleId:41,fieldOrder:[3,2,1],addFields:['Count']};},
 'unsupported style':s=>{s.operations.order.input.body.appearance={unknown:true};},
 'different schedule with incidental native event':s=>{s.operations.order.input.body.scheduleId=42;},
 'unsupported operation':s=>{s.operations.order.input.path='/revit/set-parameter';},
 'unknown later effect':s=>{s.operations.order.persistent_effect='unknown';},
 'pending later edit':s=>{s.operations.order.settlement_state='pending';},
 'non-native later result':s=>{s.operations.order.result.authority='provider';},
 'foreign later receipt':s=>{s.operations.order.result.binding={...s.current_binding,run_id:'other'};},
 'no later correlation':s=>{s.operations.order.result.native_correlation_id='';},
 'different later request':s=>{s.operations.order.result.request_identity={request_signature:'different'};},
 'missing later request':s=>{s.operations.order.request_identity={};s.operations.order.result.request_identity={};},
 'missing native timestamp':s=>{delete s.operations.order.result.completed_at;},
 'invalidated original':s=>{s.input_invalidated_operation_ids=['formats'];},
 'invalidated later':s=>{s.input_invalidated_operation_ids=['order'];},
 'paused':s=>{s.execution_control={state:'paused'};},
 'terminal':s=>{s.terminal=true;},
 'review proposed':s=>{s.completion_proposal={};},
 'awaiting review':s=>{s.outcome='awaiting_user_review';},
 'unknown effect':s=>{s.unresolved_unknown_operation_ids=['other'];},
 'in-flight operation':s=>{s.in_flight_operation_ids=['other'];},
 'foreign current binding':s=>{s.current_binding={...s.current_binding,generation:2};},
 'no historical check':s=>{s.observations.observed.facts=[];}
};
for(const [name,mutate]of Object.entries(faults))test('field refresh refuses '+name,()=>{const s=fixture();mutate(s);assert.equal(regularScheduleCheckNeedsRefreshV2(s,s.operations.formats!),false);assert.equal(plan(s),null);});
