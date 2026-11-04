import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput} from '../src/desktop_response_store.js';

const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const image=(bytes:string)=>({type:'input_image',image_url:'data:image/png;base64,'+bytes});
const response=(id:string,output:any[]=[])=>({id,status:'completed',output,
 model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},
 provider_response_usage:{disposition:'completed',session_id:'s',message_id:id,raw_response_ids:[id]}});
async function replay(old:any[],fresh:any[],tools:any[]=[{type:'computer'}]){
 const previous=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'startup-images-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const calls=old.filter(x=>x.type==='function_call'),outputs=old.filter(x=>x.type==='function_call_output');
  const initial=old.filter(x=>!['function_call','function_call_output'].includes(x.type));
  await retainDesktopResponse(binding,'one',profile,async()=>{
   prepareDesktopProviderInput(binding,'one',{...profile,input:initial});return response('one',calls);
  },()=>({}),true);retainDesktopContext(binding,'one',outputs);
  let sent:any;
  const request={...profile,tools,previous_response_id:'one',input:[...outputs,...fresh]};
  await retainDesktopResponse(binding,'two',request,async()=>{
   sent=prepareDesktopProviderInput(binding,'two',request);return response('two');
  },()=>({}),true);
  return sent;
 }finally{
  if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});
 }
}
const userImages=(body:any)=>body.input.filter((x:any)=>x.role==='user').flatMap((x:any)=>Array.isArray(x.content)?x.content:[]).filter((x:any)=>x.type==='input_image');

test('418 cold replay retires historical inline reference pixels when a fresh desktop image is supplied',async()=>{
 const reference={role:'user',content:[{type:'input_text',text:'Draft the retained attached reference.'},image('AQID'),
  {type:'input_file',file_id:'retained-pdf'}]};
 const call={type:'function_call',call_id:'visual',name:'review_current_work',arguments:'{}'};
 const output={type:'function_call_output',call_id:'visual',output:[{type:'input_text',text:'Source and model pair'},image('BAUG'),image('BwgJ')]};
 const fresh={role:'user',content:[{type:'input_text',text:'The final image in this message is the current computer screen across the full virtual desktop,'},image('CgsM')]};
 const original=structuredClone({reference,output,fresh});
 const sent=await replay([reference,call,output],[fresh]);
 assert.deepEqual(userImages(sent),[fresh.content[1]],'The actual418 request failed with two top-level user images');
 assert.deepEqual(sent.input[0].content[0],reference.content[0]);
 assert.deepEqual(sent.input[0].content[2],reference.content[2]);
 assert.match(sent.input[0].content[1].text,/historical.*retained|historical.*replay/i);
 assert.match(sent.input[0].content[1].text,/SHA256.*[a-f0-9]{64}/);
 assert.match(sent.input[0].content[1].text,/retrieve|re-read/i);
 assert.deepEqual(sent.input.find((x:any)=>x.type==='function_call_output'),output);
 assert.deepEqual({reference,output,fresh},original,'Never mutate the raw retained messages or fresh pixels');
});

for(const mode of ['non-computer','no-new-image'] as const)test(`startup retirement leaves ${mode} requests unchanged`,async()=>{
 const reference={role:'user',content:[{type:'input_text',text:'Reference'},image('AQID')]};
 const fresh={role:'user',content:[{type:'input_text',text:'Continue'},...(mode==='non-computer'?[image('BAUG')]:[])]};
 const sent=await replay([reference],[fresh],mode==='non-computer'?[]:[{type:'computer'}]);
 assert.deepEqual(sent.input,[reference,fresh]);
});

test('all new images stay exact and non-user historical image inputs are not retired',async()=>{
 const old={role:'user',content:[image('AQID'),image('BAUG')]};
 const nonuser={role:'assistant',content:[image('BwgJ')]};
 const fresh={role:'user',content:[image('CgsM'),image('DQ4P')]};
 const sent=await replay([old,nonuser],[fresh]);
 assert.deepEqual(userImages(sent),fresh.content,'Do not hide invalid multiple fresh inputs by silently dropping any');
 assert.deepEqual(sent.input[1],nonuser);
});
