import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGoal, getGoal, __testOnlyResetGoalListCache } from '../src/goals/service.js';
import { __closeForTests } from '../src/memory/sqlite_store.js';
import { runWithRequestContext } from '../src/request_context.js';
import { createOperatorBackendAuth } from '../src/operator_backend_auth.js';
import { createAssignmentKernelForGoalV2 } from '../src/assignments/assignment_kernel_v2_factory.js';
import { getAssignmentKernelSnapshotV2 } from '../src/assignments/assignment_kernel_v2_store.js';
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2,
  settleAssignmentKernelOperationV2 } from '../src/assignments/assignment_kernel_v2_execution.js';
import { AssignmentJournalV2, canonicalJsonV2, type AssignmentEventV2 } from '../src/domain/assignment-kernel/index.js';
import { scheduleFilterRestorationV1 } from '../src/domain/assignment-kernel/schedule_filter_restoration.js';
import { checkedEditIsCurrentV2 } from '../src/verification/current_postcondition_v2.js';
import { operationNeedsReadbackV2 } from '../src/verification/regular_schedule_recheck_v2.js';

async function workspace(fn: () => unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-filter-restoration-'));
  const env = { OPERATOR_WORKSPACE_ROOT: root, REVIT_OPERATOR_MODE: 'development', OPERATOR_LOCAL_EXECUTOR_PROFILE: 'codex_v2_advisory_v1',
    OPERATOR_ASSIGNMENT_KERNEL_V2: '1', OPERATOR_BRAIN: 'codex', OPERATOR_TOOL_EXPOSURE_PROFILE: 'laboratory', OPERATOR_HOSTED_ENABLED: '0' };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env); __testOnlyResetGoalListCache();
  try { await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth('shared_token', 'test-only',
    { OPERATOR_API_BASE_URL: 'http://127.0.0.1:7007' }) }, fn); }
  finally {
    __testOnlyResetGoalListCache(); __closeForTests();
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function setup() {
  const goal = createGoal({ title: 'Adjust equipment schedule filters', objective: 'Adjust and restore schedule selection without editing equipment.',
    acceptance_criteria: ['Requested schedule filters are retained.'], status: 'active', related_session_id: 'filter-session', created_by: 'local-host',
    work_budget: { requested_effect: 'apply', document_fingerprint: 'a'.repeat(64) } });
  createAssignmentKernelForGoalV2({ goal, run_id: 'filter-run' });
  return { state: () => getAssignmentKernelSnapshotV2(goal.id)!, journal: () => new AssignmentJournalV2(getGoal(goal.id)!.assignment_kernel_v2!.events) };
}
type Fixture = ReturnType<typeof setup>;
type Lease = ReturnType<typeof openAssignmentKernelOperationV2>;
const base = [{ fieldId: 2, op: 'equals', value: 'COHORT' }];
const withPrefix = [...base, { fieldId: 0, op: 'begins_with', value: 'P' }];
function assign(f: Fixture, request: string, filters = withPrefix, extra = {}, target = 11) {
  return openAssignmentKernelOperationV2({ snapshot: f.state(), provider_turn_id: 'turn', controller_request_id: request,
    capability_id: 'revit_call_tool', classified_effect: 'apply', target_tokens: [`id:${target}`],
    arguments: { method: 'POST', path: '/revit/configure-schedule', body: { scheduleId: target, filters, replaceFilters: true, replaceSortGroup: false, dryRun: false, ...extra } } });
}
function settle(f: Fixture, lease: Lease, transform?: (result: any, payload: any) => void) {
  markAssignmentKernelOperationDispatchStartedV2(lease);
  const op = f.state().operations[lease.operation_id]!, body = op.input.body as any, id = body.scheduleId;
  const payload: any = { success: true, status: 'Success', dryRun: false, schedule: { id, uniqueId: `schedule-${id}-unique-identity` },
    transaction: { status: 'committed', committed: true, modified_element_ids: [id], affected_element_ids: [id], added_element_ids: [], deleted_element_ids: [] },
    changeTracking: { documentChangedObserved: true, exhaustiveChangeInventory: true, eventCount: 1, matchingEventCount: 1, distinctWrapperMatchCount: 1, captureFailureCount: 0 },
    filterReadback: body.filters.map((x: any) => ({ fieldId: x.fieldId, op: x.op === 'equals' ? 'Equal' : 'BeginsWith', value: x.value, valueType: 'string' })) };
  const result: any = { schema: 'revit-operator.operation-result/v2', result_id: `result:${lease.operation_id}`, operation_id: lease.operation_id,
    binding: lease.binding, status: 'succeeded', dispatch_state: 'dispatched', persistent_effect: 'applied', native_transaction_state: 'committed', authority: 'native-host',
    result_schema_id: 'operator-native/POST:/revit/configure-schedule/v2', observation_required: true, affected_target_identities: [`element_id:${id}`],
    receipt_id: `receipt:${lease.operation_id}`, native_correlation_id: `native:${lease.operation_id}`, request_identity: op.request_identity, completed_at: new Date().toISOString() };
  transform?.(result, payload);
  result.raw_payload_hash = createHash('sha256').update(canonicalJsonV2(payload)).digest('hex');
  return settleAssignmentKernelOperationV2(lease, { content: [], structuredContent: {
    schema: 'revit-operator.assignment-kernel-mcp-result/v2', operation_result_v2: result,
    observation: { raw_payload: payload, semantic_facts: [{ fact_id: 'task.result_available', fact_class: 'domain', value: true }], verification_relevance: ['task_result'] }
  } });
}
test('runtime restores a removed filter after an exact committed counter-state and preserves blind-write deduplication', () => workspace(() => {
  const f = setup(), first = assign(f, 'first'); settle(f, first);
  const removed = assign(f, 'remove', base); settle(f, removed);
  const restored = assign(f, 'restore');
  const op = f.state().operations[restored.operation_id]!;
  assert.equal(op.filter_restoration_of_operation_id, first.operation_id);
  assert.equal(op.filter_restoration_after_operation_id, removed.operation_id);
  settle(f, restored);
  assert.throws(() => assign(f, 'blind-repeat'), /equivalent_repeat|write_repeat/);
  assert.deepEqual(new AssignmentJournalV2(f.journal().events()).snapshot(), f.state());
}));

function counterFixture() {
  const f=setup(),first=assign(f,'first');settle(f,first);
  const counter=assign(f,'remove',base);settle(f,counter);
  const proposed=structuredClone(f.state().operations[first.operation_id]!);
  proposed.operation_id='restoration-proposal';delete proposed.native_schedule_filter_state;
  return {f,first,counter,proposed};
}
function restorationEvent(f:Fixture,first:Lease,counter:Lease):AssignmentEventV2 {
  const state=f.state(),prior=state.operations[first.operation_id]!;
  const operation={...prior,operation_id:'restore-event',delegation_authority_id:'delegation:restore-event',
    admission_state:'admitted' as const,dispatch_state:'not_dispatched' as const,settlement_state:'open' as const,persistent_effect:'none' as const,
    result:undefined,observation_ids:[],verification_operation_ids:[],settled_at:undefined,
    admitted_assignment_version:undefined,settled_assignment_version:undefined,native_schedule_filter_state:undefined,
    filter_restoration_of_operation_id:first.operation_id,filter_restoration_after_operation_id:counter.operation_id};
  return {schema:'revit-operator.assignment-event/v2',event_id:'restoration',assignment_id:state.current_binding.assignment_id,
    assignment_version:state.assignment_version+1,binding:state.current_binding,actor:'test',occurred_at:new Date().toISOString(),
    event_type:'operation_admitted',operation} as AssignmentEventV2;
}
test('journal rederives ordered restoration and rejects forged state, counter IDs and reuse',()=>workspace(()=>{
  const {f,first,counter}=counterFixture(),journal=f.journal(),event=restorationEvent(f,first,counter);
  if(event.event_type!=='operation_admitted')throw Error('fixture');
  event.operation.native_schedule_filter_state=f.state().operations[first.operation_id]!.native_schedule_filter_state;
  assert.throws(()=>journal.append(event),{code:'operation_native_filter_state_forbidden'});
  delete event.operation.native_schedule_filter_state;event.operation.filter_restoration_after_operation_id='invented';
  assert.throws(()=>journal.append(event),{code:'operation_filter_restoration_invalid'});
  event.operation.filter_restoration_after_operation_id=counter.operation_id;
  const state=journal.append(event);
  assert.equal(state.operations['restore-event']!.filter_restoration_after_operation_id,counter.operation_id);
  assert.deepEqual(new AssignmentJournalV2(journal.events()).snapshot(),state);
  assert.equal(scheduleFilterRestorationV1(state,{...event.operation,operation_id:'reuse'}),null);
}));
for(const scenario of ['document','generation','unknown','open','same_state','wrong_schedule','missing_state','hash','result_id',
  'missing_observation','non_native','uncommitted','ordering','used_counter','later_schedule_edit','later_incomplete_footprint','unversioned_later','wrong_requested_state'] as const) {
  test(`restoration rejects ${scenario} evidence`,()=>workspace(()=>{
    const {f,counter,proposed}=counterFixture(),snapshot=structuredClone(f.state()),op=snapshot.operations[counter.operation_id]!;
    if(scenario==='document')op.binding={...op.binding,document_fingerprint:'other'};
    if(scenario==='generation')op.binding={...op.binding,generation:op.binding.generation+1};
    if(scenario==='unknown')op.persistent_effect='unknown';
    if(scenario==='open')op.settlement_state='awaiting_result';
    if(scenario==='same_state')op.native_schedule_filter_state!.state_hash=snapshot.operations[Object.keys(snapshot.operations)[0]!]!.native_schedule_filter_state!.state_hash;
    if(scenario==='wrong_schedule')op.native_schedule_filter_state!.schedule_id=12;
    if(scenario==='missing_state')delete op.native_schedule_filter_state;
    if(scenario==='hash')op.native_schedule_filter_state!.raw_payload_hash='wrong';
    if(scenario==='result_id')op.native_schedule_filter_state!.result_id='wrong';
    if(scenario==='missing_observation')op.observation_ids=[];
    if(scenario==='non_native')op.result={...op.result!,authority:'backend'};
    if(scenario==='uncommitted')op.result={...op.result!,native_transaction_state:'unknown'};
    if(scenario==='ordering')op.admitted_assignment_version=1;
    if(scenario==='used_counter')snapshot.operations={...snapshot.operations,used:{...op,operation_id:'used',filter_restoration_after_operation_id:counter.operation_id}};
    if(scenario.startsWith('later_')||scenario==='unversioned_later') {
      const later:typeof op={...op,operation_id:'later',settled_assignment_version:op.settled_assignment_version!+1};
      if(scenario==='later_incomplete_footprint')later.result={...op.result!,affected_target_identities:['element_id:12']};
      if(scenario==='unversioned_later')delete later.settled_assignment_version;
      snapshot.operations={...snapshot.operations,later};
    }
    if(scenario==='wrong_requested_state')(proposed.input.body as any).filters[1].value='Q';
    assert.equal(scheduleFilterRestorationV1(snapshot,proposed),null);
  }));
}
test('unrelated schedule changes do not authorize a restoration',()=>workspace(()=>{
  const f=setup(),first=assign(f,'first');settle(f,first);
  const other=assign(f,'other',base,{},12);settle(f,other);
  assert.throws(()=>assign(f,'unsafe'),/equivalent_repeat|write_repeat/);
}));
test('counter state with mixed edits or incomplete native tracking never authorizes a restoration',()=>workspace(()=>{
  for(const mixed of [false,true]) {
    const f=setup(),first=assign(f,'first');settle(f,first);
    const counter=assign(f,'counter',base,mixed?{appearance:{showTitle:false}}:{});
    settle(f,counter,(_result,payload)=>{if(!mixed)payload.changeTracking.exhaustiveChangeInventory=false;});
    assert.throws(()=>assign(f,'unsafe'),/equivalent_repeat|write_repeat/);
  }
}));
test('repeated user iterations need a distinct later committed counter-state each time',()=>workspace(()=>{
  const f=setup(),first=assign(f,'first');settle(f,first);
  const counter=assign(f,'remove',base);settle(f,counter);
  const restored=assign(f,'restore');settle(f,restored);
  const removedAgain=assign(f,'remove-again',base);settle(f,removedAgain);
  const restoredAgain=assign(f,'restore-again');
  assert.equal(f.state().operations[restoredAgain.operation_id]!.filter_restoration_of_operation_id,restored.operation_id);
  assert.equal(f.state().operations[restoredAgain.operation_id]!.filter_restoration_after_operation_id,removedAgain.operation_id);
}));

for(const variant of ['exact','extra_rule','wrong_field','unreadable','backend','old_read'] as const){
  test(`ordinary runtime filter verification ${variant} survives journal replay without trusting a caller flag`,()=>workspace(()=>{
    const f=setup(),edit=assign(f,'change');settle(f,edit);
    const read=openAssignmentKernelOperationV2({snapshot:f.state(),provider_turn_id:'read-turn',controller_request_id:'read',
      capability_id:'revit_call_tool',classified_effect:'read',target_tokens:['id:11'],arguments:{method:'POST',path:'/revit/schedules',body:{action:'detail',scheduleId:11}}});
    assert.equal(f.state().operations[read.operation_id]!.verification_of_operation_id,edit.operation_id);
    markAssignmentKernelOperationDispatchStartedV2(read);
    const payload:any={status:'Ok',action:'detail',schedule:{id:11,fieldCount:2},fields:[{fieldId:0,name:'Mark'},{fieldId:2,name:'Comments'}],filterDefinitionsComplete:true,
      filterDefinitions:withPrefix.map((x,index)=>({...x,index,field:x.fieldId===0?'Mark':'Comments',readable:true}))};
    if(variant==='extra_rule')payload.filterDefinitions.push({...payload.filterDefinitions[0],index:2});
    if(variant==='wrong_field')payload.filterDefinitions[1].fieldId=7;
    if(variant==='unreadable')payload.filterDefinitions[1].readable=false;
    const result:any={schema:'revit-operator.operation-result/v2',result_id:`result:${read.operation_id}`,operation_id:read.operation_id,binding:read.binding,
      status:'succeeded',dispatch_state:'dispatched',persistent_effect:'none',native_transaction_state:'not_applicable',authority:variant==='backend'?'backend':'native-host',
      result_schema_id:'operator-native/POST:/revit/schedules/v2',observation_required:true,affected_target_identities:['element_id:11'],
      receipt_id:`receipt:${read.operation_id}`,native_correlation_id:`native:${read.operation_id}`,request_identity:read.request_identity,
      completed_at:variant==='old_read'?'2020-01-01T00:00:00Z':new Date().toISOString(),raw_payload_hash:createHash('sha256').update(canonicalJsonV2(payload)).digest('hex')};
    const finish=()=>settleAssignmentKernelOperationV2(read,{content:[],structuredContent:{schema:'revit-operator.assignment-kernel-mcp-result/v2',operation_result_v2:result,
      observation:{raw_payload:payload,semantic_facts:[{fact_id:'verification.result_available',fact_class:'verification',value:true}],verification_relevance:['task_result']}}});
    if(variant==='backend'){
      assert.throws(finish,/operation_result_affected_targets_invalid/,'non-native producer cannot supply native affected identities');
      assert.equal(checkedEditIsCurrentV2(f.state(),edit.operation_id),false);
      assert.deepEqual(new AssignmentJournalV2(f.journal().events()).snapshot(),f.state());return;
    }
    finish();
    const state=f.state(),op=state.operations[edit.operation_id]!;
    const admitted=state.operations[read.operation_id]!.observation_ids.some(id=>state.observations[id]!.facts.some(x=>x.fact_id==='verification.postcondition_satisfied'&&x.value===true));
    assert.equal(admitted,variant==='exact');
    assert.equal(checkedEditIsCurrentV2(state,edit.operation_id),variant==='exact');
    assert.deepEqual(new AssignmentJournalV2(f.journal().events()).snapshot(),state);
    if(variant==='exact'){
      assert.equal(operationNeedsReadbackV2(state,op),false);
      const counter=assign(f,'subsequent-change',base);settle(f,counter);
      assert.equal(checkedEditIsCurrentV2(f.state(),edit.operation_id),false);
      assert.equal(operationNeedsReadbackV2(f.state(),f.state().operations[edit.operation_id]!),true,'later changed filters require a fresh read');
    }
  }));
}
