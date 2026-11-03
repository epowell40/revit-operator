import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {relayBoundDesktopComputerResponse,desktopComputerErrorResponse} from '../src/desktop_computer.js';
import {retainDesktopResponse,retainDesktopContext,readDesktopContext,desktopResponseOwnsContext} from '../src/desktop_response_store.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';

test('production relay keeps owner compacted context across accounted independent review and next tool turn',async()=>{
 const env=Object.fromEntries(['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'].map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-relay-')),received:any[]=[];
 const compact={type:'compaction',id:'compact',encrypted_content:'literal-provider-compaction'};
 const call={type:'function_call',id:'fc',call_id:'native-read',name:'native__invoke',arguments:'{}'};
 const server=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
  const body=JSON.parse(Buffer.concat(chunks).toString());received.push(body);const id='response-'+received.length;
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,status:'completed',output:received.length===1?[compact,call]:
   [{type:'message',role:'assistant',content:[{type:'output_text',text:'Still partial; continue the next region.'}]}],usage:{input_tokens:100,output_tokens:10,total_tokens:110}}));
 });});
 try{
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-test-key';
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as any).port;
  __testOnlyResetGoalListCache();const goal=createGoal({title:'Continue drawing',objective:'Draft both regions from reference; check each useful batch.',acceptance_criteria:['Checked drawing.'],status:'active',related_session_id:'window-session',created_by:'test',work_budget:{requested_effect:'read'}});
  const binding={...createAssignmentKernelForGoalV2({goal,run_id:'window-run'}),kernelVersion:2 as const};
  const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
  const send=(message:string,body:any)=>retainDesktopResponse(binding,message,{...profile,...body},
   ()=>relayBoundDesktopComputerResponse({...profile,...body,message_id:message},binding),desktopComputerErrorResponse,desktopResponseOwnsContext(body));
  const first=await send('one',{input:[{role:'user',content:'Begin the same drawing.'}]});
  await send('review',{context_role:'independent_review',tools:[],input:[{role:'user',content:'Independently review this completed batch.'}]});
  const outputs=[{type:'function_call_output',call_id:call.call_id,output:'Read actual current model; remaining area unfinished.'}];
  retainDesktopContext(binding,'one',outputs);
  const saved=readDesktopContext(binding,getAssignmentKernelSnapshotV2(goal.id)!) as any;
  assert.equal(saved.previous_response_id,first.id);assert.equal(saved.continuation_transport,'durable_input_array');
  const pixels=[{type:'input_image',image_url:'data:image/png;base64,AQID'},{type:'input_image',image_url:'data:image/png;base64,BAUG'}];
  await send('next',{previous_response_id:saved.previous_response_id,input:[...saved.input,{role:'user',content:[{type:'input_text',text:'Fresh corresponding reference/model.'},...pixels]}]});
  assert.equal(received.length,3);assert.equal(received[2].previous_response_id,undefined);
  assert.deepEqual(received[2].input.slice(0,3),[compact,call,...outputs]);
  assert(received[2].input.some((i:any)=>i.content?.filter((c:any)=>c.type==='input_image').length===2));
  assert(!JSON.stringify(received[2].input).includes('Independently review this completed batch.'));
  assert.deepEqual(received[2].include,['reasoning.encrypted_content']);
  const state=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(state.terminal,false);assert.equal(state.outcome,'active');assert.equal(Object.keys(state.provider_calls).length,3);
  assert.deepEqual(Object.values(state.provider_calls).map(c=>c.usage?.total_tokens),[110,110,110]);
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));for(const[k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;
  __testOnlyResetGoalListCache();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
 }
});
