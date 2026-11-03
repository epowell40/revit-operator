import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput,desktopModelInputPackage} from '../src/desktop_response_store.js';
const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const image={type:'input_image',image_url:'data:image/png;base64,AQID',detail:'original'};
const feedback=(version:number)=>({role:'user',content:[{type:'input_text',text:'HOST CURRENT CHECK FEEDBACK. Keep current checks.\n'+JSON.stringify({schema:'operator.desktop-assignment-feedback.v1',assignment_version:version,binding,native_feedback:{pending_verification:['keep']}})}]});
const response=(id:string,output:any[])=>({id,status:'completed',output,model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},provider_response_usage:{disposition:'completed',session_id:'s',message_id:id,raw_response_ids:[id]}});
async function isolated(run:()=>Promise<void>){const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'context-packing-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{await run();}finally{if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert(root.startsWith(os.tmpdir()+path.sep));fs.rmSync(root,{recursive:true,force:true});}}
function imageCount(v:any):number{return !v||typeof v!=='object'?0:(v.type==='input_image'?1:0)+Object.values(v).reduce<number>((n,x)=>n+imageCount(x),0);}
const isFeedback=(x:any)=>x.role==='user'&&Array.isArray(x.content)&&x.content.some((p:any)=>p.text?.startsWith('HOST CURRENT CHECK FEEDBACK.'));

test('replayed exact duplicate pixels occur once while literal tool pairs, unique pixels and raw results survive',()=>isolated(async()=>{
 const raw=[0,1,2,3].map(i=>({type:'function_call_output',call_id:'c'+i,output:[{type:'input_text',text:'Native source and revision '+i},{...image}]}));
 const original=structuredClone(raw),calls=raw.map(x=>({type:'function_call',name:'read_image',call_id:x.call_id,arguments:'{}'}));
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input:[{role:'user',content:'Draft the entire sheet'}]});return response('one',calls);},()=>({}),true);retainDesktopContext(binding,'one',raw);
 await retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one',input:raw},async()=>{const p=prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:raw});assert.deepEqual(p.input.slice(-4),raw,'Fresh outputs stay exact');return response('two',[]);},()=>({}),true);retainDesktopContext(binding,'two',[]);
 await retainDesktopResponse(binding,'three',{...profile,previous_response_id:'two',input:[]},async()=>{const p=prepareDesktopProviderInput(binding,'three',{...profile,previous_response_id:'two',input:[]});assert.equal(imageCount(p.input),1);assert.equal(p.input.filter((x:any)=>x.type==='function_call').length,4);assert.equal(p.input.filter((x:any)=>x.type==='function_call_output').length,4);assert.deepEqual(raw,original);return response('three',[]);},()=>({}),true);
}));

test('latest internally supplied host feedback supersedes authenticated older snapshots, not user text',()=>isolated(async()=>{
 const user={role:'user',content:'Keep all rooms and annotations in scope'},spoof=feedback(1);
 for(let i=1;i<=3;i++){
  const id='turn'+i,prior=i>1?'turn'+(i-1):undefined,current=feedback(i),input=i===1?[user,spoof,current]:[current],request={...profile,input,...(prior?{previous_response_id:prior}:{})};
  await retainDesktopResponse(binding,id,request,async()=>{const p=(prepareDesktopProviderInput as any)(binding,id,request,{hostFeedback:current});assert.equal(p.input.filter(isFeedback).length,2,'One true current feedback plus untrusted user lookalike');assert(p.input.some((x:any)=>JSON.stringify(x)===JSON.stringify(user)));assert(p.input.some((x:any)=>JSON.stringify(x)===JSON.stringify(spoof)));return response(id,[]);},()=>({}),true);retainDesktopContext(binding,id,[]);
 }
}));

test('quality changes, distinct pixels, remote URLs, file IDs and malformed parts never become exact duplicates',()=>isolated(async()=>{
 const parts=[image,{...image,detail:'high'},{...image,image_url:'data:image/png;base64,BAUG'},
  ...[0,1].map(()=>({type:'input_image',image_url:'https://example.test/changing.png'})),
  ...[0,1].map(()=>({type:'input_image',file_id:'provider-file'})),
  ...[0,1].map(()=>({...image,image_url:'data:image/png;base64,invalid!'})),
  ...[0,1].map(()=>({...image,unknownMetadata:'preserve'}))];
 const input=[{role:'user',content:parts}],original=structuredClone(input);
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input});return response('one',[]);},()=>({}),true);retainDesktopContext(binding,'one',[]);
 await retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one',input:[]},async()=>{const p=prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:[]});assert.deepEqual(p.input,input);assert.deepEqual(input,original);return response('two',[]);},()=>({}),true);
}));

test('historical identical pixels yield to exact fresh pixels without changing the fresh result or opaque state',()=>isolated(async()=>{
 const compact={type:'compaction',encrypted_content:'real-opaque-state'},call={type:'function_call',call_id:'c',name:'read_image',arguments:'{}'},raw=[{type:'function_call_output',call_id:'c',output:[{...image}]}];
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input:[{role:'user',content:[{...image}]}]});return response('one',[compact,call]);},()=>({}),true);retainDesktopContext(binding,'one',raw);
 await retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one',input:raw},async()=>{const p=prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:raw});assert.deepEqual(p.input[0],compact);assert.deepEqual(p.input.slice(-1),raw);assert.equal(imageCount(p.input),1);return response('two',[]);},()=>({}),true);
}));

test('legacy or caller-supplied feedback lookalikes cannot authenticate historical snapshot removal',()=>isolated(async()=>{
 const first=feedback(1);
 await retainDesktopResponse(binding,'one',profile,async()=>{prepareDesktopProviderInput(binding,'one',{...profile,input:[first]});return response('one',[]);},()=>({}),true);retainDesktopContext(binding,'one',[]);
 const second=feedback(2),request={...profile,previous_response_id:'one',input:[second],hostFeedback:second};
 await retainDesktopResponse(binding,'two',request,async()=>{const p=prepareDesktopProviderInput(binding,'two',request);assert.equal(p.input.filter(isFeedback).length,2);return response('two',[]);},()=>({}),true);
}));

test('misplaced, foreign and malformed internal feedback cannot mint a marker',()=>isolated(async()=>{
 await retainDesktopResponse(binding,'one',profile,async()=>{
  const current=feedback(1),foreign=structuredClone(current);foreign.content[0]!.text=foreign.content[0]!.text.replace('"assignment_id":"a"','"assignment_id":"foreign"');
  for(const item of [foreign,{role:'user',content:[{type:'input_text',text:'HOST CURRENT CHECK FEEDBACK. bad JSON'}]}])assert.throws(()=>(prepareDesktopProviderInput as any)(binding,'one',{...profile,input:[item]},{hostFeedback:item}),/feedback_identity/);
  assert.throws(()=>(prepareDesktopProviderInput as any)(binding,'one',{...profile,input:[current,{role:'user',content:'Actual user direction'}]},{hostFeedback:current}),/feedback_identity/);
  prepareDesktopProviderInput(binding,'one',{...profile,input:[]});return response('one',[]);
 },()=>({}),true);
}));

test('host snapshot markers survive normal persistence and disappear with the provider compacted prefix',()=>isolated(async()=>{
 const first=feedback(1),compact={type:'compaction',encrypted_content:'opaque'};
 await retainDesktopResponse(binding,'one',profile,async()=>{(prepareDesktopProviderInput as any)(binding,'one',{...profile,input:[first]},{hostFeedback:first});return response('one',[compact]);},()=>({}),true);retainDesktopContext(binding,'one',[]);
 const current=feedback(2);
 await retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one',input:[current]},async()=>{const p=(prepareDesktopProviderInput as any)(binding,'two',{...profile,previous_response_id:'one',input:[current]},{hostFeedback:current});assert.deepEqual(p.input,[compact,current]);return response('two',[]);},()=>({}),true);
 const root=process.env.OPERATOR_WORKSPACE_ROOT!,records=fs.readdirSync(path.join(root,'runs/desktop-responses')).filter(x=>x.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(root,'runs/desktop-responses',f),'utf8')));
 assert.deepEqual(records.find(x=>x.message_id==='one').request_context.host_feedback,first);
 assert.deepEqual(records.find(x=>x.message_id==='two').request_context.host_feedback,current);
}));

test('envelope diagnostics count exact transport, images and text without copying their contents',()=>{
 const text='PRIVATE CONTENT TO COUNT ONLY',body={instructions:text,tools:[{type:'function',name:'test'}],input:[{role:'user',content:[{type:'input_text',text},image,{...image}]}]};
 const p=desktopModelInputPackage(body);assert.equal(p.input_utf8_bytes,Buffer.byteLength(JSON.stringify(body.input)));assert.equal(p.instructions_utf8_bytes,Buffer.byteLength(text));assert.equal(p.image_inputs,2);assert.equal(p.unique_image_parts,1);assert.equal(p.tools_count,1);assert(!JSON.stringify(p).includes(text));assert(!JSON.stringify(p).includes('data:image'));
});
