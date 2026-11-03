import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import{relayBoundDesktopComputerResponse}from'../src/desktop_computer.js';
import{createGoal,__testOnlyResetGoalListCache}from'../src/goals/service.js';
import{createAssignmentKernelForGoalV2}from'../src/assignments/assignment_kernel_v2_factory.js';
import{getAssignmentKernelSnapshotV2}from'../src/assignments/assignment_kernel_v2_store.js';
import{controlAssignmentExecutionV2}from'../src/assignments/assignment_kernel_v2_controls.js';
async function fixture(run:(binding:any,received:any[])=>Promise<void>){
 const names=['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'],old=Object.fromEntries(names.map(k=>[k,process.env[k]])),root=fs.mkdtempSync(path.join(os.tmpdir(),'review-context-')),received:any[]=[];
 const server=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{received.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'review-'+received.length,status:'completed',output:[],usage:{input_tokens:50,output_tokens:5,total_tokens:55}}));});});
 try{process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-test-key';await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address()as any).port;__testOnlyResetGoalListCache();
  const goal=createGoal({title:'Draft and check',objective:'Draft the drawing and check results',status:'active',created_by:'test',related_session_id:'review-session',acceptance_criteria:['Checked results'],work_budget:{requested_effect:'read'}});
  await run({...createAssignmentKernelForGoalV2({goal,run_id:'review-run'}),kernelVersion:2},received);
 }finally{await new Promise<void>(r=>server.close(()=>r()));for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;__testOnlyResetGoalListCache();assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}
}
const pixels={type:'input_image',image_url:'data:image/png;base64,AQID',detail:'original'};
test('actual independent review wire preserves scoped text and literal images without parent task feedback',()=>fixture(async(b,wire)=>{
 const input=[{role:'user',content:[{type:'input_text',text:'Review this bounded result; do not infer task completion.'},pixels]}];
 const result=await relayBoundDesktopComputerResponse({context_role:'independent_review',model:'gpt-6.1-terra',reasoning_effort:'medium',message_id:'review1',input,tools:[]},b);
 assert.deepEqual(wire[0].input,input);assert.deepEqual(wire[0].tools,[]);assert.equal(result.model_context_package?.host_feedback_count,0);
 const state=getAssignmentKernelSnapshotV2(b.assignment_id)!;assert.equal(state.terminal,false);assert.equal(state.provider_call_ids.length,1);assert(Object.values(state.provider_calls).every(c=>c.usage));
}));
test('owner retains current host feedback; independent review cannot bypass Pause or unknown context roles',()=>fixture(async(b,wire)=>{
 const input=[{role:'user',content:'Continue the drawing'}];
 const result=await relayBoundDesktopComputerResponse({context_role:'owner',model:'gpt-6.1-terra',message_id:'owner1',input,tools:[]},b);
 assert.equal(result.model_context_package?.host_feedback_count,1);assert.match(JSON.stringify(wire[0].input),/operator.desktop-assignment-feedback.v1/);
 await assert.rejects(relayBoundDesktopComputerResponse({context_role:'unrecognized',model:'gpt-6.1-terra',message_id:'invalid',input,tools:[]},b),/context_role_invalid/);
 controlAssignmentExecutionV2({binding:b,action:'pause',command_id:'pause-review',expected_command_id:null});
 await assert.rejects(relayBoundDesktopComputerResponse({context_role:'independent_review',model:'gpt-6.1-terra',message_id:'paused',input,tools:[]},b));assert.equal(wire.length,1);
}));
