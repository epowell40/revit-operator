import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput} from '../src/desktop_response_store.js';
import {prepareBoundedModelEvidenceInput as bounded} from '../src/evidence/model_context_budget.js';
import {batch} from './model_evidence_read_batch.fixtures.js';
import {retainedBatch} from './model_evidence_multi_output.fixtures.js';
import {relayBoundDesktopComputerResponse,desktopComputerErrorResponse} from '../src/desktop_computer.js';
import {createGoal,__testOnlyResetGoalListCache} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const outputs=()=>{const rows:any[]=batch();rows[0].output.push({type:'input_image',image_url:'data:image/png;base64,AQID'});return rows;};
const calls=(rows:any[])=>rows.map(row=>({type:'function_call',call_id:row.call_id,name:'native__invoke',arguments:'{}'}));
const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const response=(id:string,output:any[])=>({id,status:'completed',output,model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},provider_response_usage:{disposition:'completed',session_id:'s',message_id:id,raw_response_ids:[id]}});
async function isolated(run:()=>Promise<void>){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-window-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{await run();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}}

test('exact retained outputs survive the existing bounded presentation with literal images and compaction',()=>isolated(async()=>{
 const raw=outputs(),original=structuredClone(raw),wire=bounded(raw) as any[];assert.notDeepEqual(wire,raw);
 const compact={type:'compaction',encrypted_content:'literal-provider-state'};
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input:[{role:'user',content:'Draft both areas'}]});return response('one',[compact,...calls(raw)]);},()=>({}),true);
 retainDesktopContext(binding,'one',raw);
 const request={...profile,previous_response_id:'one',input:raw};
 await retainDesktopResponse(binding,'two',request,async()=>{
  const prepared=prepareDesktopProviderInput(binding,'two',{...request,input:wire});
  assert.equal(prepared.previous_response_id,undefined);assert.deepEqual(prepared.input,[compact,...calls(raw),...wire]);
  assert.deepEqual(prepared.input.find((r:any)=>r.call_id===raw[0].call_id&&r.type==='function_call_output').output[1],raw[0].output[1]);
  assert.deepEqual(raw,original,'Canonical retained outputs stay exact');return response('two',[]);
 },()=>({}),true);
}));

test('bounded presentation cannot hide invented raw outputs, profile/cursor changes or a second wire edit',()=>isolated(async()=>{
 const raw=outputs(),wire=bounded(raw) as any[];
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input:[]});return response('one',calls(raw));},()=>({}),true);retainDesktopContext(binding,'one',raw);
 const request={...profile,previous_response_id:'one',input:raw};
 await retainDesktopResponse(binding,'two',request,async()=>{
  for(const patch of [{model:'other'},{reasoning_effort:'high'},{previous_response_id:'foreign'},
   {input:wire.map((r,i)=>i?r:{...r,output:'forged after projection'})}])
   assert.throws(()=>prepareDesktopProviderInput(binding,'two',{...request,input:wire,...patch}),/predecessor_mismatch/);
  prepareDesktopProviderInput(binding,'two',{...request,input:wire});
  return response('two',calls(raw));
 },()=>({}),true);retainDesktopContext(binding,'two',raw);
 const forged={...profile,previous_response_id:'two',input:raw.map((r,i)=>i?r:{...r,output:'forged before projection'})};
 await assert.rejects(retainDesktopResponse(binding,'three',forged,async()=>{
  prepareDesktopProviderInput(binding,'three',{...forged,input:wire});return response('three',[]);
 },()=>({}),true),/predecessor_mismatch/);
}));

for(const [name,makeOutputs] of [['required sheet reads',outputs],['mixed native/review/save',()=>structuredClone(retainedBatch)]] as const)
test(`production relay continues an accounted compacted ${name} batch after legal request-wide evidence projection`,async()=>{
 const names=['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_API_KEY','OPERATOR_OPENAI_BASE_URL'],old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-relay-')),received:any[]=[],raw=makeOutputs(),original=structuredClone(raw);
 const compact={type:'compaction',encrypted_content:'literal-provider-state'};
 const server=http.createServer((req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{received.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'response-'+received.length,status:'completed',output:received.length===1?[compact,...calls(raw)]:[],usage:{input_tokens:100,output_tokens:10,total_tokens:110}}));});});
 try{process.env.OPERATOR_WORKSPACE_ROOT=root;process.env.OPERATOR_OPENAI_API_KEY='synthetic-local-test-key';await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(server.address() as any).port;
  __testOnlyResetGoalListCache();const goal=createGoal({title:'Draft',objective:'Draft and check both areas',acceptance_criteria:['Checked drawing'],status:'active',related_session_id:'s',created_by:'test',work_budget:{requested_effect:'read'}});
  const b={...createAssignmentKernelForGoalV2({goal,run_id:'r'}),kernelVersion:2 as const};
  const send=(id:string,body:any)=>retainDesktopResponse(b,id,{...profile,...body},()=>relayBoundDesktopComputerResponse({...profile,...body,message_id:id},b),desktopComputerErrorResponse,true);
  await send('one',{input:[{role:'user',content:'Draft both areas'}]});retainDesktopContext(b,'one',raw);
  const second=await send('two',{previous_response_id:'response-1',input:raw});assert.equal(received.length,2);assert.equal(received[1].previous_response_id,undefined);
  assert.deepEqual(received[1].input.filter((r:any)=>r.type==='function_call_output'),bounded(raw));assert.deepEqual(received[1].input[0],compact);assert.deepEqual(raw,original);
  const pixels=(rows:any[])=>rows.flatMap(r=>Array.isArray(r.output)?r.output.filter((b:any)=>b.type==='input_image'):[]);
  assert.deepEqual(pixels(received[1].input),pixels(original));
  assert.equal(second.model_context_package?.host_feedback_count,1,'Actual provider wire gets one current host snapshot');
  assert.equal(second.model_context_package?.input_utf8_bytes,Buffer.byteLength(JSON.stringify(received[1].input)));
  assert.equal(second.model_context_package?.instructions_utf8_bytes,Buffer.byteLength(received[1].instructions));
  retainDesktopContext(b,'two',[]);
  const third=await send('three',{previous_response_id:'response-2',input:[{role:'user',content:'Continue the next unfinished area'}]});
  assert.equal(third.model_context_package?.host_feedback_count,1);
  assert(received[2].input.some((r:any)=>r.role==='user'&&r.content==='Continue the next unfinished area'));
 }finally{await new Promise<void>(r=>server.close(()=>r()));for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;__testOnlyResetGoalListCache();assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
