import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeInteractiveInputOwnership,withNativeInteractiveInvocation,captureNativeInteractiveDispatchObserver,requireNativeInteractiveInvocation } from '../src/assignments/native_interactive_input.js';
import {createHash} from 'node:crypto';
import {canonicalJsonV2} from '../src/domain/assignment-kernel/canonical.js';
import { decideAssignmentProgressV2 } from '../src/domain/assignment-kernel/progress/controller.js';
import { DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2 } from '../src/assignments/assignment_kernel_v2_progress.js';
import type { AssignmentSnapshotV2 } from '../src/domain/assignment-kernel/snapshot.js';

const at = Date.parse('2026-10-29T18:00:00Z');

test('interactive native admission requires the exact live desktop invocation, not a caller claim',async()=>{
 const snapshot=fixture(),args={method:'POST',path:'/revit/place-mep-accessory-interactively',body:{maximumPlacements:1}};
 const signature=createHash('sha256').update(canonicalJsonV2({capability_id:'revit_call_tool',...args})).digest('hex');
 assert.throws(()=>requireNativeInteractiveInvocation(snapshot,'revit_call_tool',args),/owned_desktop/);
 assert.doesNotThrow(()=>requireNativeInteractiveInvocation(snapshot,'revit_call_tool',{...args,path:'/revit/move-elements'}));
 let late!:()=>void;
 const call=withNativeInteractiveInvocation(snapshot.current_binding,signature,async()=>{
   assert.doesNotThrow(()=>requireNativeInteractiveInvocation(snapshot,'revit_call_tool',args));
   assert.throws(()=>requireNativeInteractiveInvocation(snapshot,'revit_call_tool',{...args,body:{maximumPlacements:2}}),/owned_desktop/);
   const foreign=structuredClone(snapshot);foreign.current_binding.document_fingerprint='foreign';
   assert.throws(()=>requireNativeInteractiveInvocation(foreign,'revit_call_tool',args),/owned_desktop/);
   // Capture the original asynchronous context; it loses authority when its invocation settles.
   const resource=new (await import('node:async_hooks')).AsyncResource('late-fixture');
   late=()=>resource.runInAsyncScope(()=>requireNativeInteractiveInvocation(snapshot,'revit_call_tool',args));
 });
 await call.result;await Promise.resolve();assert.throws(late,/owned_desktop/);
});
function fixture(): AssignmentSnapshotV2 {
  const binding = { assignment_id: 'assignment', session_id: 'session', run_id: 'run', generation: 1,
    principal_id: 'local:owner', document_fingerprint: 'current-open-document' };
  const route = '/revit/place-mep-accessory-interactively';
  return {
    current_binding: binding, assignment_version: 10, outcome: 'active', terminal: false, quiescent: false,
    spec: { created_at:new Date(at-5000).toISOString(),criteria:[] },provider_calls:{},provider_call_ids:[],progress_epochs:[],
    execution_control: { state: 'running', command_id: 'start', changed_at: new Date(at).toISOString() },
    in_flight_provider_call_ids: [], unresolved_unknown_operation_ids: [], pending_review_ids: [],
    pending_input_variable_ids: [], in_flight_operation_ids: ['op'],
    operations: { op: {
      operation_id: 'op', binding: structuredClone(binding), capability_id: 'revit_call_tool',
      requested_effect: 'apply', purpose: 'work', operation_role: 'root',
      admission_state: 'admitted', dispatch_state: 'dispatched', settlement_state: 'awaiting_result',
      admitted_assignment_version: 8, dispatch_started_at: new Date(at - 1000).toISOString(),
      opened_at:new Date(at-2000).toISOString(),
      deadline_at: new Date(at + 60000).toISOString(),
      target: { document_fingerprint: binding.document_fingerprint },
      input: { method: 'POST', path: route, body: { typeId: 10 } },
      request_identity: { capability_id: 'revit_call_tool', method: 'POST', path: route, request_signature: 'exact-request' }
    } }
  } as unknown as AssignmentSnapshotV2;
}
function owned(snapshot = fixture()) {
  const registry = new NativeInteractiveInputOwnership(() => at);
  let resolve!: () => void, reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  registry.register(snapshot, 'op', 'exact-request', pending);
  return { registry, snapshot, pending, resolve, reject };
}

test('only a live host-owned invocation can supply interactive input ownership', async () => {
  const { registry, snapshot, resolve } = owned();
  assert.equal(registry.operationAwaitingInput(snapshot)?.operation_id, 'op');
  assert.equal(new NativeInteractiveInputOwnership(() => at).operationAwaitingInput(snapshot), null);
  assert.throws(() => registry.register(snapshot, 'op', 'exact-request', new Promise(() => {})));
  resolve(); await Promise.resolve();
  assert.equal(registry.operationAwaitingInput(snapshot), null);
});

test('native failure removes input ownership without settling or clearing unknown effects', async () => {
  const { registry, snapshot, reject } = owned();
  const original = structuredClone(snapshot);
  reject(new Error('native transport lost')); await Promise.resolve();
  assert.equal(registry.operationAwaitingInput(snapshot), null);
  assert.deepEqual(snapshot, original);
});

const changes: [string, (s: any) => void][] = [
  ['Pause', s => s.execution_control.state = 'paused'],
  ['changed control command', s => s.execution_control.command_id = 'resume'],
  ['terminal', s => s.terminal = true],
  ['failed', s => s.outcome = 'failed'],
  ['completion proposal', s => s.completion_proposal = {}],
  ['provider usage pending', s => s.provider_usage_hold = {}],
  ['provider budget', s => s.provider_budget_exhausted = {}],
  ['provider call in flight', s => s.in_flight_provider_call_ids = ['provider']],
  ['unknown effect', s => s.unresolved_unknown_operation_ids = ['unknown']],
  ['user input pending', s => s.pending_input_variable_ids = ['question']],
  ['review pending', s => s.pending_review_ids = ['review']],
  ['second operation', s => s.in_flight_operation_ids.push('other')],
  ['quiescent', s => s.quiescent = true],
  ['foreign principal', s => s.current_binding.principal_id = 'other'],
  ['foreign document', s => s.current_binding.document_fingerprint = 'other'],
  ['new generation', s => s.current_binding.generation++],
  ['foreign operation binding', s => s.operations.op.binding.run_id = 'other'],
  ['changed target', s => s.operations.op.target.document_fingerprint = 'other'],
  ['different route', s => s.operations.op.request_identity.path = '/revit/move-elements'],
  ['request body route mismatch', s => s.operations.op.input.path = '/revit/move-elements'],
  ['changed request signature', s => s.operations.op.request_identity.request_signature = 'changed'],
  ['read request', s => s.operations.op.requested_effect = 'read'],
  ['not admitted', s => s.operations.op.admission_state = 'rejected'],
  ['not dispatched', s => s.operations.op.dispatch_state = 'not_dispatched'],
  ['changed admission', s => s.operations.op.admitted_assignment_version++],
  ['expired deadline', s => s.operations.op.deadline_at = new Date(at).toISOString()],
  ['extended deadline', s => s.operations.op.deadline_at = new Date(at + 120000).toISOString()],
  ['settled operation', s => s.operations.op.settlement_state = 'settled'],
  ['native result already received', s => s.operations.op.result = {}],
  ['observation committing', s => s.operations.op.observation_commit = {}],
  ['completion reconciliation', s => s.operations.op.native_completion_reconciliation = {}],
  ['child operation', s => s.operations.op.parent_operation_id = 'parent']
];
for (const [name, change] of changes) test(`interactive input refuses ${name}`, () => {
  const { registry, snapshot } = owned();
  change(snapshot);
  assert.equal(registry.operationAwaitingInput(snapshot), null);
});

test('ordinary routes, wrong signatures and serialized pseudo-promises cannot register', () => {
  const registry = new NativeInteractiveInputOwnership(() => at), snapshot = fixture();
  assert.throws(() => registry.register(snapshot, 'op', 'wrong', new Promise(() => {})));
  assert.throws(() => registry.register(snapshot, 'op', 'exact-request', {} as Promise<unknown>));
  (snapshot.operations.op.request_identity as any).path = '/revit/create-family-instance';
  assert.throws(() => registry.register(snapshot, 'op', 'exact-request', new Promise(() => {})));
});

test('ownership expires even if the pending transport never resolves', () => {
  let now = at;
  const registry = new NativeInteractiveInputOwnership(() => now), snapshot = fixture();
  registry.register(snapshot, 'op', 'exact-request', new Promise(() => {}));
  now += 60000;
  assert.equal(registry.operationAwaitingInput(snapshot), null);
});

test('captured MCP callback binds only the same pending invocation and never settles it',async()=>{
  const snapshot=fixture(), before=structuredClone(snapshot),registry=new NativeInteractiveInputOwnership(()=>at);
  let dispatch!:(s:AssignmentSnapshotV2,id:string)=>void,release!:(value:string)=>void;
  const native=new Promise<string>(resolve=>{release=resolve;});
  const call=withNativeInteractiveInvocation(snapshot.current_binding,'exact-request',async()=>{
    dispatch=captureNativeInteractiveDispatchObserver();return native;
  },registry);
  await Promise.resolve();
  captureNativeInteractiveDispatchObserver()(snapshot,'op');
  assert.equal(registry.operationAwaitingInput(snapshot),null,'an unrelated callback is not an invocation');
  dispatch(snapshot,'op');
  assert.equal((await call.ready).operation_id,'op');
  assert.equal(registry.operationAwaitingInput(snapshot)?.operation_id,'op');
  assert.deepEqual(snapshot,before,'readiness is not native settlement');
  release('original native receipt');assert.equal(await call.result,'original native receipt');
  await Promise.resolve();assert.equal(registry.operationAwaitingInput(snapshot),null);
  dispatch(snapshot,'op');assert.equal(registry.operationAwaitingInput(snapshot),null,'late duplicate callback cannot resurrect input');
});

test('Pause or changed request at native acceptance cannot turn acceptance into dispatch failure',async()=>{
  for(const modify of [(s:any)=>s.execution_control.state='paused',(s:any)=>s.operations.op.request_identity.request_signature='other',
    (s:any)=>s.current_binding.document_fingerprint='other']) {
    const snapshot=fixture(),registry=new NativeInteractiveInputOwnership(()=>at);
    let observed=false,release!:()=>void;
    const native=new Promise<void>(resolve=>{release=resolve;});
    const call=withNativeInteractiveInvocation(snapshot.current_binding,'exact-request',async()=>{
      const dispatch=captureNativeInteractiveDispatchObserver();modify(snapshot);dispatch(snapshot,'op');return native;
    },registry);
    void call.ready.then(()=>{observed=true;});await Promise.resolve();
    assert.equal(registry.operationAwaitingInput(snapshot),null);release();await call.result;
    assert.equal(observed,false);
  }
});

test('existing progress controller admits UI reasoning only with live owned input and unchanged budgets',()=>{
  const {registry,snapshot}=owned();
  const input={snapshot,budget:DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2,now:new Date(at).toISOString()};
  assert.equal(decideAssignmentProgressV2(input).decision,'await_operation');
  const ownedInput={...input,nativeInteractiveInput:(s:AssignmentSnapshotV2)=>registry.operationAwaitingInput(s)?.operation_id??null};
  const decision=decideAssignmentProgressV2(ownedInput);
  assert.equal(decision.decision,'admit_reasoning_turn');
  assert.equal(decision.reason,'owned_native_interaction_requires_ui_input');
  assert.equal(snapshot.quiescent,false);assert.deepEqual(snapshot.in_flight_operation_ids,['op']);
  for(const [name,change] of changes) {
    const original=structuredClone(snapshot);change(snapshot);
    assert.notEqual(decideAssignmentProgressV2(ownedInput).decision,'admit_reasoning_turn',name);
    for(const key of Object.keys(snapshot))delete (snapshot as any)[key];Object.assign(snapshot,original);
  }
  for(const budget of [{max_provider_calls:0},{max_reasoning_turns:0},{max_operations:1},{max_total_tokens:0},{max_wall_clock_ms:1}])
    assert.equal(decideAssignmentProgressV2({...ownedInput,budget:{...input.budget,...budget}}).decision,'blocked');
});
