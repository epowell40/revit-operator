import test from 'node:test';import assert from 'node:assert/strict';
import {assignmentWorkAllowanceV2,defaultAssignmentWorkBudgetV2} from '../src/domain/assignment-kernel/effective_work_budget.js';
import {utf8TextSha256V2} from '../src/domain/assignment-kernel/canonical.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 as ordinary} from '../src/assignments/assignment_kernel_v2_progress.js';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/canonical.js';
import {deriveNativeInventoryWorkloadV1} from '../src/domain/assignment-kernel/native_inventory_workload.js';
import {validLocalAdvisoryPolicyV1} from '../src/domain/assignment-kernel/execution_policy.js';
import {assignmentWorkBudgetStatusV2} from '../src/assignments/assignment_work_allowance_v2.js';
import {assignmentProgressBudgetBlockerV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {codexAssignmentTurnTimeLimits} from '../src/codex/assignment_timeout.js';
import {nativeSourceInventoryWorkloadV1} from '@revitoperator/assignment-kernel-v2-contracts';
const at=(n:number)=>new Date(Date.UTC(2026,9,15)+n).toISOString();
function fixture():any {
 const binding={assignment_id:'inventory',run_id:'run',generation:1,session_id:'chat',principal_id:'owner',document_fingerprint:'model'};
 const source='Finish compact wiring throughout this project’s panel schedules.';
 const request={capability_id:'revit_call_tool',method:'POST',path:'/revit/schedules',request_signature:'inventory-signature'};
 const result={result_id:'result-census',operation_id:'census',binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',observation_required:true,result_schema_id:'operator-native/POST:/revit/schedules/v2',raw_payload_hash:'digest',receipt_id:'receipt',native_correlation_id:'correlation',request_identity:request,completed_at:at(200)};
 const state={schema:'revit-operator.native-inventory-workload/v1',operation_id:'census',result_id:result.result_id,raw_payload_hash:result.raw_payload_hash,receipt_id:result.receipt_id,native_correlation_id:result.native_correlation_id,request_signature:request.request_signature,inventory_kind:'panel',item_count:54};
 return {assignment_version:10,current_binding:binding,outcome:'active',quiescent:true,terminal:false,
 spec:{binding,source_user_request:source,created_at:at(0),requested_effect:'apply',criteria:[],work_units:[],input_variables:[],execution_policy:{mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'chat',document_fingerprint:'model',max_turns:8,max_provider_calls:64,max_operations:256,max_total_tokens:8_000_000,max_wall_clock_ms:20*60_000,
 native_scope_planning:{mode:'native_inventory_planning_v1',scope_kind:'schedules',source_request_sha256:utf8TextSha256V2(source),items_per_unit:5,max_units:4},
 progress_allowance:{mode:'verified_native_changes_v1',credit_unit:'distinct_verified_targets_v1',max_provider_calls:256,max_operations:1024,max_total_tokens:32_000_000,max_wall_clock_ms:120*60_000}}},
 operations:{census:{operation_id:'census',binding,requested_effect:'read',target:{document_fingerprint:'model'},input:{method:'POST',path:'/revit/schedules',body:{action:'list',kind:'panel',offset:0,max:100}},request_identity:request,dispatch_authority:'native',dispatch_state:'dispatched',persistent_effect:'none',settlement_state:'settled',opened_at:at(100),settled_at:at(300),admitted_assignment_version:2,settled_assignment_version:3,observation_ids:['observed'],result,native_inventory_workload:state}},
 observations:{observed:{operation_id:'census',authority:'native-host',binding,raw_payload_hash:result.raw_payload_hash,facts:[]}},provider_calls:{},progress_epochs:[],execution_failure_ids:[],execution_failures:{},pending_input_variable_ids:[],pending_review_ids:[],in_flight_provider_call_ids:[],in_flight_operation_ids:[],unresolved_unknown_operation_ids:[]};
}
test('complete native project inventory funds a bounded planning window before the first edit',()=>{
 const s=fixture(),before=JSON.stringify(s),b=defaultAssignmentWorkBudgetV2(s,ordinary);
 assert.equal(b.max_provider_calls,256);assert.equal(b.max_total_tokens,32_000_000);
 assert.equal(b.max_operations,1024);assert.equal(b.max_wall_clock_ms,80*60_000);
 assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0,'Inventory is not verified work');
 assert.equal(JSON.stringify(s),before,'No policy or usage rewrite');
});
test('the same retained native inventory cannot enlarge a historical policy',()=>{
 const s=fixture();delete s.spec.execution_policy.native_scope_planning;
 assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,64);
});
const uid=(id:number)=>'00000000-0000-0000-0000-000000000000-'+id.toString(16).padStart(8,'0');
function rawInventory(count=54):any{return {schema:'operator.schedule_inventory.v1',status:'Ok',action:'list',kind:'panel',offset:0,max:100,query:null,matched:count,returned:count,complete:true,hasMore:false,nextOffset:null,
 items:Array.from({length:count},(_,i)=>({id:i+1,uniqueId:uid(i+1),kind:'panel_schedule',isTemplate:false,panelElementId:i+1000,panelUniqueId:uid(i+1000)}))};}
function nativeRead():any {
 const op=structuredClone(fixture().operations.census),payload=rawInventory();
 delete op.native_inventory_workload;
 op.result.observation_required=true;op.result.raw_payload_hash=utf8TextSha256V2(canonicalJsonV2(payload));
 op.observation_commit={schema:'revit-operator.observation-commit-input/v2',result_id:op.result.result_id,raw_payload:payload,semantic_facts:[]};
 return op;
}
test('only full retained native bytes derive compact source workload; no raw state is caller trusted',()=>{
 const op=nativeRead(),state=deriveNativeInventoryWorkloadV1(op)!;
 assert.equal(state.item_count,54);assert.equal(state.inventory_kind,'panel');
 for(const change of [
  (o:any)=>o.observation_commit.raw_payload.complete=false,
  (o:any)=>o.observation_commit.raw_payload.items[1].uniqueId=o.observation_commit.raw_payload.items[0].uniqueId,
  (o:any)=>o.observation_commit.raw_payload.offset=1,
  (o:any)=>o.result.raw_payload_hash='wrong',
  (o:any)=>o.result.binding={...o.binding,generation:2},
  (o:any)=>o.target.document_fingerprint='foreign',
  (o:any)=>o.result.authority='model',
  (o:any)=>o.result.status='failed_after_dispatch',
  (o:any)=>delete o.result.receipt_id,
  (o:any)=>delete o.result.request_identity,
  (o:any)=>o.input.body.query='P1',
 ]){const n=structuredClone(op);change(n);assert.equal(deriveNativeInventoryWorkloadV1(n),undefined);}
});
test('wire decoders reject partial, filtered, duplicate or mismatched native census protocols',()=>{
 const op=nativeRead(),raw=rawInventory();assert.equal(nativeSourceInventoryWorkloadV1(op,raw)?.item_count,54);
 for(const change of [
  (p:any)=>p.hasMore=true,(p:any)=>p.nextOffset=54,(p:any)=>p.returned=53,(p:any)=>p.matched=55,
  (p:any)=>p.query='P1',(p:any)=>p.kind='regular',(p:any)=>p.items[1].id=p.items[0].id,
  (p:any)=>p.items[0].isTemplate=true,(p:any)=>p.items[0].panelUniqueId='',(p:any)=>p.items[0].kind='schedule'
 ]){const p=structuredClone(raw);change(p);assert.equal(nativeSourceInventoryWorkloadV1(op,p),undefined);}
 const defaulted=structuredClone(op);delete defaulted.input.body.action;defaulted.input.body.kind=' Panel ';defaulted.input.body.offset=null;
 assert.equal(nativeSourceInventoryWorkloadV1(defaulted,raw)?.item_count,54,'Native list defaults/normalization are preserved');
});
test('project power-circuit census distinguishes actual native circuit types without hardcoded IDs or engineering claims',()=>{
 const op=nativeRead();op.input.body={action:'circuits',max:500,offset:0};
 const raw={schema:'operator.electrical_circuit_inventory.v1',status:'Ok',scope:'project_power_circuits',read_only:true,offset:0,max:500,matched:3,returned:3,complete:true,hasMore:false,nextOffset:null,dataComplete:false,
 items:[{id:11,uniqueId:uid(11),circuitType:'Circuit',fieldErrors:[{field:'wireSize',message:'Unavailable'}]},{id:12,uniqueId:uid(12),circuitType:'Spare'},{id:13,uniqueId:uid(13),circuitType:'Space'}]};
 assert.deepEqual(nativeSourceInventoryWorkloadV1(op,raw),{inventory_kind:'power_circuits',item_count:1},'Field gaps still need planning; enumeration is not verification');
 for(const mutate of [(n:any)=>n.input.body.query='P1',(n:any)=>n.input.body.scheduleId=11,(n:any)=>n.input.body.kind='panel',(n:any)=>n.input.body.max=501]){
  const n=structuredClone(op);mutate(n);assert.equal(nativeSourceInventoryWorkloadV1(n,raw),undefined);
 }
 const invalid=structuredClone(raw);invalid.items[0]!.circuitType='Assumed circuit';assert.equal(nativeSourceInventoryWorkloadV1(op,invalid),undefined);
});
test('source census planning is nonadditive, bounded and separate from verified edit credit',()=>{
 for(const [count,calls] of [[1,64],[5,64],[6,128],[15,192],[21,256],[54,256]]){
  const s=fixture();s.operations.census.native_inventory_workload.item_count=count;
  const b=defaultAssignmentWorkBudgetV2(s,ordinary);assert.equal(b.max_provider_calls,calls);assert(b.max_total_tokens<=32_000_000);assert(b.max_operations<=1024);assert(b.max_wall_clock_ms<=120*60_000);
 }
 const s=fixture(),op=structuredClone(s.operations.census);op.operation_id='again';op.result.operation_id='again';op.native_inventory_workload.operation_id='again';op.observation_ids=['again'];
 s.operations.again=op;s.observations.again={...s.observations.observed,operation_id:'again'};
 assert.equal(assignmentWorkAllowanceV2(s).provider_calls,256);assert.equal(assignmentWorkAllowanceV2(s).verified_changes,0);
 assert.equal(assignmentWorkAllowanceV2(s).source_planning_items,54);
});
test('damaged state, cross-binding, incomplete settlement and missing retained observation earn no planning',()=>{
 for(const mutate of [
  (s:any)=>delete s.operations.census.native_inventory_workload,
  (s:any)=>s.operations.census.native_inventory_workload.raw_payload_hash='tampered',
  (s:any)=>s.operations.census.native_inventory_workload.item_count=101,
  (s:any)=>s.operations.census.native_inventory_workload.item_count=0,
  (s:any)=>s.operations.census.result.authority='model',
  (s:any)=>s.operations.census.binding={...s.current_binding,generation:2},
  (s:any)=>s.operations.census.result.binding={...s.current_binding,session_id:'foreign'},
  (s:any)=>s.operations.census.settlement_state='retaining_observation',
  (s:any)=>s.operations.census.observation_retention_error='pending',
  (s:any)=>s.operations.census.input.body.offset=1,
  (s:any)=>s.operations.census.input.body.query='P1',
  (s:any)=>s.operations.census.opened_at=at(-1),
  (s:any)=>s.operations.census.settled_assignment_version=99,
  (s:any)=>s.observations.observed.raw_payload_hash='foreign',
  (s:any)=>s.operations.census.operation_role='child',
 ]){const s=fixture();mutate(s);assert.equal(defaultAssignmentWorkBudgetV2(s,ordinary).max_provider_calls,64);}
});
test('frozen opt-in validates source identity and cannot stack on PDF allowance or enlarge constants',()=>{
 assert.equal(validLocalAdvisoryPolicyV1(fixture().spec),true);
 for(const mutate of [(s:any)=>s.spec.execution_policy.native_scope_planning.max_units=5,
  (s:any)=>s.spec.execution_policy.native_scope_planning.items_per_unit=1,
  (s:any)=>s.spec.execution_policy.native_scope_planning.source_request_sha256='forged',
  (s:any)=>s.spec.source_user_request='Different task',
  (s:any)=>s.spec.requested_effect='read',
  (s:any)=>s.spec.execution_policy.source_work_allowance={mode:'marked_pdf_sheets_v1',units:1,sources:[]}
 ]){const s=fixture();mutate(s);assert.equal(validLocalAdvisoryPolicyV1(s.spec),false);assert.equal(assignmentWorkAllowanceV2(s).source_planning_units,undefined);}
});
test('telemetry, provider budget and restart use the same source allowance without changing Pause or usage',()=>{
 const s=fixture();s.provider_calls=Object.fromEntries(Array.from({length:80},(_,i)=>['c'+i,{admitted_at:at(0),completed_at:at(1000),usage:{total_tokens:100,input_tokens:90,output_tokens:10}}]));
 const before=JSON.stringify(s),b=defaultAssignmentWorkBudgetV2(s,ordinary),status=assignmentWorkBudgetStatusV2(s,ordinary,at(1000));
 assert.equal(assignmentProgressBudgetBlockerV2(s,b,at(1000)),null);assert.equal(status.resources.provider_calls.limit,256);
 assert.equal(status.allocation.native_source_planning!.items,54);assert.equal(status.allocation.verified_distinct_changes,0);
 assert.equal(JSON.stringify(s),before);assert.deepEqual(defaultAssignmentWorkBudgetV2(JSON.parse(before),ordinary),b);
 s.execution_control={state:'paused'};assert.equal(codexAssignmentTurnTimeLimits({snapshot:s,now:at(1000)}).maxWallMs,0);
});
