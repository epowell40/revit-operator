import test from 'node:test';import assert from 'node:assert/strict';
import {retainNativeInteractivePlacement,assertNativeInteractiveAction,assertNativeInteractiveFunction,cancelNativeInteractivePlacement,assertNativeInteractiveIdleRelease,describeComputerRunFailure} from './native_interactive_placement.mjs';
import {invokeDesktopNativeTool} from './desktop_native_tools.mjs';
const now=Date.parse('2026-10-29T20:00:00Z');
const assignment={kernel_version:2,goal_id:'a',session_id:'s',run_id:'r',generation:1,control_command_id:'start'};
const binding={assignment_id:'a',session_id:'s',run_id:'r',generation:1,document_fingerprint:'model'};
const response={schema:'operator.desktop-native-pending.v1',binding,operation_id:'op',deadline_at:new Date(now+60000).toISOString(),input_readiness:'unconfirmed',message:'Still pending; UI readiness is unconfirmed'};
const context={revit:{process_id:123,source:{live:true},document:{projectIdentity:{fingerprint:'model'}}}};
test('internal input refusal is not presented as user Stop; actual Stop and abort remain stopped',()=>{
 const state={stopRequested:true,controlFailureReason:'native_interactive_input_not_allowed'};
 const before=JSON.stringify(state);assert.deepEqual(describeComputerRunFailure(state,new Error('Stopped by user.')),
  {stopped:false,message:'native_interactive_input_not_allowed'});assert.equal(JSON.stringify(state),before);
 for(const s of [{stopRequested:true},{stopRequested:true,controlFailureReason:null}])
  assert.deepEqual(describeComputerRunFailure(s,new Error('other')),{stopped:true,message:'Stopped by user.'});
 assert.deepEqual(describeComputerRunFailure({},new Error('other'),true),{stopped:true,message:'Stopped by user.'});
 assert.deepEqual(describeComputerRunFailure({},new Error('native result unknown')),{stopped:false,message:'native result unknown'});
});
function fixture(){return {snapshot:{current_binding:binding,execution_control:{state:'running',command_id:'start'},outcome:'active',terminal:false,
  quiescent:false,in_flight_operation_ids:['op'],pending_review_ids:[],pending_input_variable_ids:[],unresolved_unknown_operation_ids:[],
  in_flight_provider_call_ids:[],operations:{op:{deadline_at:response.deadline_at,request_identity:{path:'/revit/place-mep-accessory-interactively'},settlement_state:'awaiting_result'}}}};}

test('idle UI cleanup requires an actual settled result and preserves unknown and accounting fences',()=>{
 const pending=retainNativeInteractivePlacement(response,assignment,context,now);
 const state={schema:'operator.desktop-native-interaction.v1',publication:fixture()},s=state.publication.snapshot;
 assert.throws(()=>assertNativeInteractiveIdleRelease(pending,state));
 s.in_flight_operation_ids=[];s.operations.op={...s.operations.op,settlement_state:'settled',settled_at:new Date(now).toISOString(),result:{persistent_effect:'applied'}};
 const before=JSON.stringify(s);assert.doesNotThrow(()=>assertNativeInteractiveIdleRelease(pending,state));assert.equal(JSON.stringify(s),before);
 for(const change of [s=>delete s.operations.op.result,s=>s.operations.op.settlement_state='retaining_observation',
   s=>s.unresolved_unknown_operation_ids=['op'],s=>s.provider_usage_hold={},s=>delete s.in_flight_provider_call_ids,
   s=>s.in_flight_provider_call_ids=['usage'],s=>s.current_binding={...binding,generation:2}]){
   const other=structuredClone(state);change(other.publication.snapshot);assert.throws(()=>assertNativeInteractiveIdleRelease(pending,other));
 }
});

test('a newly started assignment has no control command, while malformed or changed controls refuse',()=>{
  const pending=retainNativeInteractivePlacement(response,{...assignment,control_command_id:null},context,now),publication=fixture();
  delete publication.snapshot.execution_control;
  assert.deepEqual(assertNativeInteractiveAction(pending,publication,'op',{type:'click'},now),['-ExpectedRevitProcessId','123']);
  for(const control of [{},{state:'paused'},{state:'running',command_id:'resumed'}]){
    publication.snapshot.execution_control=control;
    assert.throws(()=>assertNativeInteractiveAction(pending,publication,'op',{type:'click'},now));
  }
});

test('pending native transport returns no invented success or commit and never repeats its call',async()=>{
  let calls=0;
  const output=await invokeDesktopNativeTool({assignment,messageId:'m',responseId:'r',call:{name:'native__revit_call_tool',call_id:'c'},context,
    request:async()=>{calls++;return response;}});
  assert.equal(calls,1);assert.equal(output.native_pending,response);
  const model=JSON.parse(output.output);assert.equal(model.success,undefined);assert.equal(model.persistent_effect,undefined);
  assert.equal(model.operation_id,'op');assert.equal(model.schema,'operator.desktop-native-pending.v1');
  assert.equal(model.input_readiness,'unconfirmed');assert.equal(model.message,response.message);
  // Presentation of uncertainty neither invents native readiness nor changes
  // the existing process/binding-bound continuity and cancellation checks.
  const pending=retainNativeInteractivePlacement(model,assignment,context,now);
  assert.equal(pending.operationId,'op');assert.equal(pending.processId,123);
  assert.equal(pending.inputReady,undefined);
});

test('only exact source process and binding can retain interactive continuity',()=>{
  assert.equal(retainNativeInteractivePlacement(response,assignment,context,now).processId,123);
  for(const patch of [{revit:{...context.revit,process_id:0}},{revit:{...context.revit,source:{live:false}}},
    {revit:{...context.revit,document:{projectIdentity:{fingerprint:'foreign'}}}}])
    assert.throws(()=>retainNativeInteractivePlacement(response,assignment,patch,now));
  assert.throws(()=>retainNativeInteractivePlacement(response,{...assignment,generation:2},context,now));
  assert.throws(()=>retainNativeInteractivePlacement(response,assignment,context,now+60000));
});

test('current owned placement allows only constrained UI input and result consumption',()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now),publication=fixture();
  for(const action of [{type:'click',button:'left'},{type:'move'},{type:'scroll'},{type:'keypress',keys:['ESC']},{type:'keypress',keys:['SPACE']}])
    assert.deepEqual(assertNativeInteractiveAction(pending,publication,'op',action,now),['-ExpectedRevitProcessId','123']);
  assert.deepEqual(assertNativeInteractiveAction(pending,publication,'op',{type:'screenshot'},now),[]);
  for(const action of [{type:'type',text:'save'},{type:'drag'},{type:'double_click'},{type:'click',button:'right'},
    {type:'keypress',keys:['CTRL','S']},{type:'keypress',keys:['ENTER']},{type:'keypress',keys:[]}])
    assert.throws(()=>assertNativeInteractiveAction(pending,publication,'op',action,now));
  for(const name of ['native__revit_call_tool','report_work_for_review','review_current_work','request_task_input','save'])
    assert.throws(()=>assertNativeInteractiveFunction(pending,{name}));
  assert.doesNotThrow(()=>assertNativeInteractiveFunction(pending,{name:'native__await_interactive_placement'}));
  assert.doesNotThrow(()=>assertNativeInteractiveFunction(null,{name:'native__revit_call_tool'}));
});

test('native completion racing a queued click requires result consumption, never ordinary UI fallback',()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now),publication=fixture();
  publication.snapshot.quiescent=true;publication.snapshot.in_flight_operation_ids=[];
  assert.throws(()=>assertNativeInteractiveAction(pending,publication,null,{type:'click'},now),/result_required/);
});

test('Pause, unknown, provider usage, deadline, source and extra-operation fences still reject input',()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now);
  const mutations=[s=>s.execution_control.state='paused',s=>s.execution_control.command_id='other',s=>s.outcome='blocked',s=>s.terminal=true,
    s=>s.provider_usage_hold={},s=>s.provider_budget_exhausted={},s=>s.completion_proposal={},s=>s.in_flight_provider_call_ids=['call'],
    s=>s.unresolved_unknown_operation_ids=['unknown'],s=>s.pending_input_variable_ids=['question'],s=>s.pending_review_ids=['review'],
    s=>s.in_flight_operation_ids.push('other'),s=>s.current_binding={...binding,generation:2},s=>s.operations.op.deadline_at=new Date(now+120000).toISOString(),
    s=>s.operations.op.settlement_state='settled',s=>s.operations.op.request_identity.path='/revit/move-elements'];
  for(const mutate of mutations){const publication=fixture();mutate(publication.snapshot);
    assert.throws(()=>assertNativeInteractiveAction(pending,publication,'op',{type:'click'},now));}
  assert.throws(()=>assertNativeInteractiveAction(pending,fixture(),'op',{type:'click'},now+60000));
});

test('host cancellation permits only bounded Escape to the exact pending process; Pause never becomes ordinary input',async()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now),publication=fixture();
  publication.snapshot.execution_control.state='paused';
  const sent=[],state={schema:'operator.desktop-native-interaction.v1',pending_result:true,publication};
  const result=await cancelNativeInteractivePlacement(pending,{readControl:async b=>{assert.deepEqual(b,pending.binding);return state;},sendEscape:async args=>sent.push(args)});
  assert.equal(sent.length,2);assert.deepEqual(sent[0],['-Action','cancel_native_placement','-ExpectedRevitProcessId','123']);
  assert.deepEqual(result,{escapeInputs:2,nativeResultRequired:true});assert.equal(publication.snapshot.quiescent,false);
  assert.throws(()=>assertNativeInteractiveAction(pending,publication,'op',{type:'keypress',keys:['ESC']},now),/control_not_current/);
});

test('cancellation does not send a second Escape after settlement or any input for foreign binding',async()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now),publication=fixture();let inputs=0;
  const state={schema:'operator.desktop-native-interaction.v1',pending_result:true,publication};
  const result=await cancelNativeInteractivePlacement(pending,{readControl:async()=>state,sendEscape:async()=>{
    inputs++;publication.snapshot.in_flight_operation_ids=[];publication.snapshot.quiescent=true;
  }});
  assert.equal(inputs,1);assert.equal(result.nativeResultRequired,true);
  publication.snapshot.current_binding={...binding,generation:2};
  await assert.rejects(cancelNativeInteractivePlacement(pending,{readControl:async()=>state,sendEscape:async()=>inputs++}));
  assert.equal(inputs,1);
});

test('failed cancellation is never retried or reported as native rollback',async()=>{
  const pending=retainNativeInteractivePlacement(response,assignment,context,now);let inputs=0;
  await assert.rejects(cancelNativeInteractivePlacement(pending,{readControl:async()=>({schema:'operator.desktop-native-interaction.v1',pending_result:true,publication:fixture()}),
    sendEscape:async()=>{inputs++;throw Error('window identity refused');}}),/window identity refused/);
  assert.equal(inputs,1);
});
