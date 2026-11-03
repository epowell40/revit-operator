import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {relayBoundDesktopComputerResponse} from '../src/desktop_computer.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';
import {readImageInputDelivery} from '../src/desktop_image_delivery.js';

test('trusted owner relay enables API compaction while retaining opaque output and exact canonical usage',async()=>{
 const prior=Object.fromEntries(['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'].map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-compaction-'));
 const received:any[]=[];
 const compaction={id:'compact-one',type:'compaction',encrypted_content:'opaque-provider-state'};
 const server=http.createServer((req,res)=>{
  const chunks:Buffer[]=[];req.on('data',c=>chunks.push(Buffer.from(c)));req.on('end',()=>{
   received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({id:'compacted-response',status:'completed',model:'gpt-6.1-terra',output:[compaction,{type:'message',role:'assistant',content:[{type:'output_text',text:'Source remains partial.'}]}],usage:{input_tokens:100,output_tokens:23,total_tokens:123,input_tokens_details:{cached_tokens:80}}}));
  });
 });
 try{
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-test-key';
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;
  __testOnlyResetGoalListCache();
  const goal=createGoal({title:'Inspect a partial',objective:'Read current partial model and report remaining work.',acceptance_criteria:['Report facts.'],status:'active',related_session_id:'compaction-session',created_by:'test-principal',work_budget:{requested_effect:'read'}});
  const binding={...createAssignmentKernelForGoalV2({goal,run_id:'compaction-run'}),kernelVersion:2 as const};
  const pixels={type:'input_image',image_url:'data:image/png;base64,AQID'};
  const result=await relayBoundDesktopComputerResponse({model:'gpt-6.1-terra',reasoning_effort:'medium',input:[{role:'user',content:[{type:'input_text',text:'Continue the same partial.'},pixels]}],message_id:'next',context_management:[{type:'compaction',compact_threshold:1}]},binding);
  assert.equal(received.length,1,'Compaction runs in the existing provider call, not an extra agent request.');
  assert.deepEqual(received[0].context_management,[{type:'compaction',compact_threshold:250000}],
   'Terra needs room for its actual visual working set; caller cannot lower the host threshold.');
  assert.equal(received[0].model,'gpt-6.1-terra');assert.deepEqual(received[0].reasoning,{effort:'medium'});
  assert.deepEqual(result.output[0],compaction,'Opaque provider state is preserved, not reinterpreted as authority.');
  assert.equal(result.output_text,'Source remains partial.');
  const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;
  assert.equal(snapshot.in_flight_provider_call_ids.length,0);
  assert.equal(snapshot.outcome,'active');
  assert.equal(snapshot.terminal,false);
  assert.deepEqual(Object.values(snapshot.provider_calls).map(c=>c.usage?.total_tokens),[123]);
  assert.equal(result.model_call_receipt.tokens.input_tokens,100);
  assert.equal(result.model_call_receipt.tokens.cached_input_tokens,80);
  assert(received[0].input.some((i:any)=>i.content?.some((c:any)=>c.type==='input_image'&&c.image_url===pixels.image_url)), 'Pixels reach the actual Responses request body.');
  assert.equal(result.input_images?.length,1);
  const hash=result.input_images![0]!.sha256;
  assert.equal(readImageInputDelivery(binding,hash).response_id,result.id);
  assert.throws(()=>readImageInputDelivery({...binding,generation:binding.generation+1},hash),/not_delivered/);
  assert.throws(()=>readImageInputDelivery(binding,'f'.repeat(64)),/not_delivered/);
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));
  for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  __testOnlyResetGoalListCache();
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(root,{recursive:true,force:true});
 }
});
