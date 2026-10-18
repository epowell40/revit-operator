import test from 'node:test';import assert from 'node:assert/strict';
import {savedComputerBinding,savedAssignmentExecutor,assertComputerDispatchSnapshot,assertComputerResumeControl,savedComputerConversation} from './saved_computer_assignment.mjs';
const binding={assignment_id:'task',session_id:'session',run_id:'run',generation:1};
function fixture(){return {goal:{id:'task',related_session_id:'session',objective:'Match the schedule',work_budget:{mode:'sidecar_computer',source:'operator_desktop',execution_substrate:'operator_desktop_outer_agent',source_user_request:'Match the schedule',conversation_message_id:'message',attachment_ids:['reference']}},
 snapshot:{current_binding:{...binding,document_fingerprint:'model'},spec:{source_user_request:'Match the schedule',interpreted_scope:{source_message_id:'message'}},assignment_version:12,execution_control:{state:'running',command_id:'resume'},terminal:false,outcome:'active',quiescent:true,pending_review_ids:[],pending_input_variable_ids:[],unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],operations:{}}};}
test('authenticated source provenance restores an owner without run-name inference or new assignment',()=>{
 const {goal,snapshot}=fixture();assert.equal(savedAssignmentExecutor(goal,snapshot,binding),'computer');
 goal.work_budget.mode='normal';assert.equal(savedAssignmentExecutor(goal,snapshot,binding),'backend');
});
test('foreign or malformed identities and changed source metadata cannot restore desktop ownership',()=>{
 for(const alter of [f=>f.goal.related_session_id='other',f=>f.goal.work_budget.source='caller',f=>f.goal.work_budget.execution_substrate='backend',f=>f.goal.work_budget.source_user_request='other',f=>f.snapshot.spec.interpreted_scope.source_message_id='other',f=>f.snapshot.current_binding.generation++,f=>f.snapshot.current_binding.run_id='other']){
  const f=fixture();alter(f);assert.throws(()=>savedAssignmentExecutor(f.goal,f.snapshot,binding));
 }
 for(const b of [{...binding,session_id:''},{...binding,generation:0},{...binding,assignment_id:'bad/id'}])assert.throws(()=>savedComputerBinding(b));
});
test('each dispatch rejects paused, held, unsettled, uncertain or input-blocked work',()=>{
 assert.doesNotThrow(()=>assertComputerDispatchSnapshot(fixture().snapshot,binding));
 for(const patch of [{execution_control:{state:'paused'}},{terminal:true},{outcome:'awaiting_user_review'},{quiescent:false},{provider_usage_hold:{}},{provider_budget_exhausted:true},{completion_proposal:{}},...['pending_review_ids','pending_input_variable_ids','unresolved_unknown_operation_ids','in_flight_operation_ids','in_flight_provider_call_ids'].map(k=>({[k]:['one']}))]){
  assert.throws(()=>assertComputerDispatchSnapshot({...fixture().snapshot,...patch},binding));
 }
});
test('the exact Resume command must still be current after history/context retrieval',()=>{
 const {snapshot}=fixture();assert.doesNotThrow(()=>assertComputerResumeControl(snapshot,binding,{command_id:'resume',assignment_version:12}));
 for(const c of [null,{command_id:'old',assignment_version:12},{command_id:'resume',assignment_version:13}])assert.throws(()=>assertComputerResumeControl(snapshot,binding,c));
 snapshot.execution_control={state:'paused',command_id:'later'};assert.throws(()=>assertComputerResumeControl(snapshot,binding,{command_id:'resume',assignment_version:12}));
 snapshot.execution_control={state:'running',command_id:'later-resume'};assert.throws(()=>assertComputerDispatchSnapshot(snapshot,binding,'resume'),/control_changed/);
});
test('restart context retains exact source references, current direction and unfinished work, without treating reports as proof',()=>{
 const {goal,snapshot}=fixture();snapshot.input_values={direction:'Remove the gap, keep border settings'};snapshot.work_plan={items:[{id:'item',status:'partial'}]};
 const conversation=savedComputerConversation(goal,snapshot,{session_id:'session',messages:[{role:'assistant',text:'I changed the border'},{role:'user',text:'Keep working'}]});
 assert.match(conversation[0].text,/not current proof/);assert.match(conversation[0].text,/reference/);assert.match(conversation[0].text,/Remove the gap/);assert.match(conversation[0].text,/partial/);
 assert.equal(conversation.at(-1).text,'Keep working');assert.throws(()=>savedComputerConversation(goal,snapshot,{session_id:'other',messages:[]}));
 snapshot.work_plan={text:'x'.repeat(80001)};assert.throws(()=>savedComputerConversation(goal,snapshot,{session_id:'session',messages:[]}),/not restarted or clipped/);
});
