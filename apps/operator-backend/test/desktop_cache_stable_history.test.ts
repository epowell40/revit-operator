import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput} from '../src/desktop_response_store.js';
import {desktopToolHistoryCache} from '../src/desktop_prompt_cache.js';

const binding={session_id:'cache-s',assignment_id:'cache-a',run_id:'cache-r',generation:1,kernelVersion:2 as const};
const field=[{operation_id:'apply',check_state:'verified_current',scope:'Not visual or whole-task proof',checked_preservation_ids:Array.from({length:80},(_,i)=>'element:'+i)}];
const output=(id:string)=>[{type:'function_call_output',call_id:id,output:[{type:'input_text',text:JSON.stringify({schema:'revit-operator.model-observation-index/v2',verified_postconditions:field,pending_verification:[{check_state:'previous_check_stale'}],host_budget:{used:id}})}]}];
const call=(id:string)=>({type:'function_call',name:'native__revit_call_tool',call_id:id,arguments:'{}'});
const response=(id:string,output:any[])=>({id,status:'completed',output,model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},provider_response_usage:{disposition:'completed',session_id:binding.session_id,message_id:id,raw_response_ids:[id]}});
async function exercise(model:string,enabled:boolean,compact=false){
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'cache-stable-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 const prepared:any[]=[],boundaries:any[]=[];
 try{
  for(let n=1;n<=4;n++){
   const id='r'+n,input=n===1?[{role:'user',content:'Draft'}]:output('c'+(n-1));
   // A caller-owned lookalike cannot enable the internal transport policy.
   const request={model,reasoning_effort:'medium',input,cacheStableHistory:true,...(n>1?{previous_response_id:'r'+(n-1)}:{})};
   await retainDesktopResponse(binding,id,request,async()=>{
    const p=prepareDesktopProviderInput(binding,id,request,{cacheStableHistory:enabled} as any);
    prepared.push(structuredClone(p.input));boundaries.push(desktopToolHistoryCache(p.input,model,true).diagnostic.breakpoints);
    return response(id,[...(compact&&n===3?[{type:'compaction',encrypted_content:'opaque-current'}]:[]),call('c'+n)]);
   },()=>({}),true);
   retainDesktopContext(binding,id,output('c'+n));
  }
  return {prepared,boundaries};
 }finally{
  if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
  assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});
 }
}
test('bound cache-enabled Sol and Terra preserve earlier observation bytes and reusable prefixes across repeated results',async()=>{
 for(const model of ['gpt-6.1-sol','gpt-6.1-terra']){
  const {prepared,boundaries}=await exercise(model,true);
  for(const n of [2,3]){
   const old=prepared[n].find((x:any)=>x.type==='function_call_output'&&x.call_id==='c1');
   assert.deepEqual(old,output('c1')[0]);
   assert.equal(boundaries[n].find((x:any)=>x.index===boundaries[1][0].index)?.prefix_sha256,boundaries[1][0].prefix_sha256);
   assert.deepEqual(prepared[n].at(-1),output('c'+n)[0]);
  }
 }
});
test('unqualified models and calls without internal cache opt-in retain established packing',async()=>{
 for(const [model,enabled] of [['gpt-6.1-sol',false],['future-model',true]] as const){
  const {prepared}=await exercise(model,enabled);
  const old=prepared[2].find((x:any)=>x.type==='function_call_output'&&x.call_id==='c1');
  assert.equal(JSON.parse(old.output[0].text).replay_exact_fields.verified_postconditions.call_id,'c2');
 }
});
test('cache-stable history does not preserve a superseded prefix across genuine compaction',async()=>{
 const {prepared}=await exercise('gpt-6.1-sol',true,true);
 assert.deepEqual(prepared[3][0],{type:'compaction',encrypted_content:'opaque-current'});
 assert(!prepared[3].some((x:any)=>x.call_id==='c1'));
 assert.deepEqual(prepared[3].at(-1),output('c3')[0]);
});
