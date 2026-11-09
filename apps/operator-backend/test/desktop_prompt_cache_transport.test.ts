import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {relayDesktopComputerResponse,relayBoundDesktopComputerResponse} from '../src/desktop_computer.js';
import {retainDesktopResponse,retainDesktopContext} from '../src/desktop_response_store.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {getAssignmentKernelSnapshotV2} from '../src/assignments/assignment_kernel_v2_store.js';

test('actual SDK transport marks retained tool history and accounts cache usage without altering checks or settings',async()=>{
 const keys=['OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const submitted:any[]=[];
 const server=http.createServer((req,res)=>{const parts:Buffer[]=[];req.on('data',c=>parts.push(Buffer.from(c)));req.on('end',()=>{
  submitted.push(JSON.parse(Buffer.concat(parts).toString('utf8')));res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({id:'resp_syntheticcache',model:'gpt-6.1-sol',status:'completed',output:[],usage:{input_tokens:1000,input_tokens_details:{cached_tokens:700,cache_write_tokens:200},output_tokens:10,total_tokens:1010},prompt_cache_diagnostics:{type:'cache_miss',reason:'input_changed',cache_missed_tokens:50,private_text:'do not retain'}}));
 });});
 try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-only';
  const tools=[{type:'function',name:'read_model',parameters:{type:'object',properties:{}}}],input=[{type:'function_call',call_id:'a',name:'read_model',arguments:'{}'},{type:'function_call_output',call_id:'a',output:'native mismatch still pending'},{role:'user',content:'Current host status: not complete'}];
  const body={model:'gpt-6.1-sol',reasoning_effort:'medium',tools,input},saved=structuredClone(body);
  const r=await (relayDesktopComputerResponse as any)(body,undefined,{cacheToolHistory:true,comparisonResponseId:'resp_previous'});
  assert.deepEqual(submitted[0].prompt_cache_options,{mode:'implicit',comparison_response_id:'resp_previous'});
  assert.deepEqual(submitted[0].input[1].output,[{type:'input_text',text:'native mismatch still pending',prompt_cache_breakpoint:{mode:'explicit'}}]);
  assert.deepEqual(submitted[0].input[2],input[2]);assert.deepEqual(submitted[0].tools,tools);assert.deepEqual(body,saved);
  assert.deepEqual(submitted[0].context_management,[{type:'compaction',compact_threshold:100000}]);assert.deepEqual(submitted[0].reasoning,{effort:'medium'});
  assert.equal(r.model_call_receipt.tokens.cached_input_tokens,700);assert.equal(r.model_call_receipt.tokens.cache_write_input_tokens,200);
  assert.deepEqual(r.prompt_cache_diagnostic,{type:'cache_miss',reason:'input_changed',cache_missed_tokens:50});
  assert.equal(r.model_context_package.prompt_cache.breakpoints.length,1);
  await relayDesktopComputerResponse({...body,cacheToolHistory:true,prompt_cache_options:{mode:'explicit'}} as any);
  assert.equal(submitted[1].prompt_cache_options,undefined,'Caller fields cannot select internal cache transport');
 }finally{for(const k of keys)prior[k]===undefined?delete process.env[k]:process.env[k]=prior[k];await new Promise<void>(r=>server.close(()=>r()));}
});

test('bound owner continuation sends cache hints only after persisted predecessor validation and remains unfinished',async()=>{
 const keys=['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-bound-')),submitted:any[]=[];
 const server=http.createServer((req,res)=>{const parts:Buffer[]=[];req.on('data',c=>parts.push(Buffer.from(c)));req.on('end',()=>{
  submitted.push(JSON.parse(Buffer.concat(parts).toString('utf8')));const n=submitted.length;res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({id:'resp_cache'+n,model:'gpt-6.1-sol',status:'completed',output:n===1?[{type:'function_call',name:'read_model',call_id:'read1',arguments:'{}'}]:[],usage:{input_tokens:1000,input_tokens_details:{cached_tokens:700,cache_write_tokens:200},output_tokens:10,total_tokens:1010}}));
 });});
 try{
  process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-only';
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;__testOnlyResetGoalListCache();
  const goal=createGoal({title:'Inspect partial',objective:'Read current model and keep remaining work.',acceptance_criteria:['Checked drawing'],status:'active',related_session_id:'cache-session',created_by:'test',work_budget:{requested_effect:'read'}});
  const binding={...createAssignmentKernelForGoalV2({goal,run_id:'cache-run'}),kernelVersion:2 as const};
  const common={model:'gpt-6.1-sol',reasoning_effort:'medium',tools:[{type:'function',name:'read_model',parameters:{type:'object',properties:{}}}]};
  const first={...common,message_id:'one',input:[{role:'user',content:'Inspect remaining work'}]};
  await retainDesktopResponse(binding,'one',first,()=>relayBoundDesktopComputerResponse(first,binding),e=>({error:String(e)}),true);
  const outputs=[{type:'function_call_output',call_id:'read1',output:'drafting incomplete'}];retainDesktopContext(binding,'one',outputs);
  const next={...common,message_id:'two',previous_response_id:'resp_cache1',input:outputs};
  await retainDesktopResponse(binding,'two',next,()=>relayBoundDesktopComputerResponse(next,binding),e=>({error:String(e)}),true);
  assert.equal(submitted.length,2);assert.equal(submitted[0].prompt_cache_options,undefined);
  assert.deepEqual(submitted[1].prompt_cache_options,{mode:'implicit',comparison_response_id:'resp_cache1'});
  assert.equal(submitted[1].input.find((x:any)=>x.type==='function_call_output').output[0].prompt_cache_breakpoint.mode,'explicit');
  const snapshot=getAssignmentKernelSnapshotV2(goal.id)!;assert.equal(snapshot.outcome,'active');assert.equal(snapshot.terminal,false);
  assert.equal(snapshot.in_flight_provider_call_ids.length,0);assert.equal(Object.keys(snapshot.provider_calls).length,2);
  assert.deepEqual(outputs,[{type:'function_call_output',call_id:'read1',output:'drafting incomplete'}]);
 }finally{await new Promise<void>(r=>server.close(()=>r()));for(const k of keys)prior[k]===undefined?delete process.env[k]:process.env[k]=prior[k];__testOnlyResetGoalListCache();assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
