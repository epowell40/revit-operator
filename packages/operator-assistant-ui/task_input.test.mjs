import test from 'node:test';import assert from 'node:assert/strict';
import {TASK_INPUT_TOOL,requestTaskInput,retainedTaskInputMessage} from './task_input.mjs';
import {missingWorkReportContinuation} from './work_report.mjs';
const owner={kernel_version:2,goal_id:'task',session_id:'own',run_id:'run',generation:1},binding={assignment_id:'task',session_id:'own',run_id:'run',generation:1};
const args={question:'What should the test message say?',field:'message_body'};
test('task input adapter retains one canonical field/question under host binding without claiming completed work',async()=>{
 const calls=[],request=async(route,options)=>{calls.push({route,...options});if(options.method==='GET')return {assignment_kernel_v2:{snapshot:{current_binding:binding,spec:{input_variables:[]},input_values:{},discovered_inputs:{}}}};
  const body=JSON.parse(options.body);return {ok:true,assignment_snapshot_v2:{current_binding:binding,outcome:'awaiting_user_input',pending_input_variable_ids:['message_body'],clarifications:{[body.clarification_id]:{variable_id:'message_body',question:args.question}}}};};
 const r=await requestTaskInput(owner,args,request);assert.equal(r.verified,false);assert.equal(r.status,'awaiting_user_input');assert.equal(calls.length,2);
 const b=JSON.parse(calls[1].body);assert.deepEqual(b.new_variable_ids,['message_body']);assert.equal(b.assignment_id,'task');assert.equal(b.run_id,'run');
 assert.equal(retainedTaskInputMessage({name:'request_task_input'},{output:JSON.stringify(r)}),args.question);
 assert.equal(retainedTaskInputMessage({name:'local_shell'},{output:JSON.stringify(r)}),null);
});
test('a question about an existing required input does not redeclare it or allow a provider answer',async()=>{
 let post;await requestTaskInput(owner,args,async(_route,options)=>{if(options.method==='GET')return {assignment_kernel_v2:{snapshot:{current_binding:binding,spec:{input_variables:[{variable_id:'message_body'}]},input_values:{}}}};
 post=JSON.parse(options.body);return {ok:true,assignment_snapshot_v2:{current_binding:binding,outcome:'awaiting_user_input',pending_input_variable_ids:['message_body'],clarifications:{[post.clarification_id]:{variable_id:'message_body',question:args.question}}}};});
 assert(!('new_variable_ids'in post));assert(!('values'in post));assert(!('external_values'in post));
});
test('foreign or answered inputs and forged authority are rejected without creating a checkpoint',async()=>{
 for(const change of [{current_binding:{...binding,run_id:'foreign'}},{input_values:{message_body:'already supplied'}}]){
  let posts=0;await assert.rejects(requestTaskInput(owner,args,async(_route,options)=>{if(options.method==='POST')posts++;return {assignment_kernel_v2:{snapshot:{current_binding:binding,spec:{input_variables:[]},input_values:{},...change}}};}));assert.equal(posts,0);
 }
 await assert.rejects(requestTaskInput(owner,{...args,assignment_id:'foreign'},()=>assert.fail('no request')),/invalid/);
});
test('an interrupted question POST is not automatically replayed and a foreign checkpoint cannot end the turn',async()=>{
 for(const mode of ['interrupted','foreign']){
  let posts=0;await assert.rejects(requestTaskInput(owner,args,async(_route,options)=>{if(options.method==='GET')return {assignment_kernel_v2:{snapshot:{current_binding:binding,spec:{input_variables:[]},input_values:{}}}};
   posts++;if(mode==='interrupted')throw Error('reply interrupted');return {ok:true,assignment_snapshot_v2:{current_binding:{...binding,generation:2}}};}));assert.equal(posts,1);
 }
});
test('strict active prose gets a bounded correction opportunity without relaxing the evidence policy',async()=>{
 const read=async()=>({ok:true,verification_policy:'strict',outcome:'active'}),r=await missingWorkReportContinuation(owner,read,0);
 assert.equal(r.kind,'continue');assert.match(r.input.content[0].text,/request_task_input/);assert.match(r.input.content[0].text,/cannot use report_work_for_review/);
 await assert.rejects(missingWorkReportContinuation(owner,read,2),/task_outcome_required/);
 assert.equal(await missingWorkReportContinuation(owner,async()=>({ok:true,verification_policy:'strict',outcome:'awaiting_user_input'})),null);
});
