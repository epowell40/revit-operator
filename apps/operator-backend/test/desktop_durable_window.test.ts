import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/desktop_response_store.js';
const api=store as any;
const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const initial=[{role:'user',content:[{type:'input_text',text:'Draft both areas.'},{type:'input_image',image_url:'data:image/png;base64,AQID'}]}];
const output=[{type:'compaction',encrypted_content:'opaque-state'},{type:'reasoning',id:'reason',summary:[],encrypted_content:'opaque-reasoning'},
 {type:'function_call',call_id:'report',name:'report_work_for_review',arguments:'{}'}];
const completed=[{type:'function_call_output',call_id:'report',output:'{"partial":true}'}];

test('reopening replaces the prior startup screen with the fresh screen without losing literal reference tool images',()=>isolated(async()=>{
 const screen=(bytes:string)=>({role:'user',content:[{type:'input_text',text:'The final image in this message is the current computer screen across the full virtual desktop, potentially spanning multiple monitors. Use the computer tool for desktop interaction.'},{type:'input_image',image_url:'data:image/png;base64,'+bytes}]});
 const old=screen('AQID'),fresh=screen('BAUG'),reference={type:'function_call',call_id:'reference',name:'read_reference_page',arguments:'{}'};
 const referenceOutput={type:'function_call_output',call_id:'reference',output:[{type:'input_text',text:'Actual reference page'},{type:'input_image',image_url:'data:image/png;base64,BwgJ'}]};
 await store.retainDesktopResponse(binding,'one',profile,async()=>{
  api.prepareDesktopProviderInput(binding,'one',{...profile,tools:[{type:'computer'}],input:[old]});return response('one','one',[reference]);
 },()=>({}),true);
 store.retainDesktopContext(binding,'one',[referenceOutput]);
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'two',{...profile,tools:[{type:'computer'}],previous_response_id:'one',input:[referenceOutput,fresh]});
  const userImages=body.input.filter((i:any)=>i.role==='user').flatMap((i:any)=>i.content).filter((c:any)=>c.type==='input_image');
  assert.deepEqual(userImages,fresh.content.filter(c=>c.type==='input_image'));
  assert(body.input[0].content.some((c:any)=>c.type==='input_text'&&/historical desktop screenshot.*fresh screen/i.test(c.text)));
  assert.deepEqual(body.input.find((i:any)=>i.call_id==='reference'&&i.type==='function_call_output'),referenceOutput);
  assert.equal(old.content[1].type,'input_image','original request must not be mutated');
  return response('two');
 },()=>({}),true);
}));

for(const mode of ['no-computer','no-fresh-screen','reference-image'] as const)test(`cold screen replacement preserves ${mode} context`,()=>isolated(async()=>{
 const marker='The final image in this message is the current computer screen across the full virtual desktop, potentially spanning multiple monitors.';
 const old={role:'user',content:[{type:'input_text',text:mode==='reference-image'?'Original reference image':marker},{type:'input_image',image_url:'data:image/png;base64,AQID'}]};
 const fresh={role:'user',content:[{type:'input_text',text:mode==='no-fresh-screen'?'Continue drafting':marker},...(mode==='no-fresh-screen'?[]:[{type:'input_image',image_url:'data:image/png;base64,BAUG'}])]};
 await store.retainDesktopResponse(binding,'one',profile,async()=>{api.prepareDesktopProviderInput(binding,'one',{...profile,input:[old]});return response('one','one',[{type:'function_call',call_id:'report',name:'report_work_for_review',arguments:'{}'}]);},()=>({}),true);
 store.retainDesktopContext(binding,'one',completed);
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'two',{...profile,tools:mode==='no-computer'?[]:[{type:'computer'}],previous_response_id:'one',input:[...completed,fresh]});
  assert.deepEqual(body.input[0],old);return response('two');
 },()=>({}),true);
}));
function response(message:string,id=message,items:any[]=output):any{return {id,status:'completed',output:items,
 model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},provider_response_usage:{disposition:'completed',session_id:'s',message_id:message,raw_response_ids:[id]}};}
function state(id='one'):any{return {current_binding:binding,outcome:'active',terminal:false,quiescent:true,
 unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],in_flight_operation_ids:[],in_flight_provider_call_ids:[],
 provider_calls:{one:{upstream_receipt:{call_id:id},completed_at:'2026-11-01T00:00:00Z',success:true,usage:{total_tokens:123}}}};}
async function isolated(run:()=>Promise<void>){const previous=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'durable-window-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{await run();}finally{if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;
 assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}}
async function first(){await store.retainDesktopResponse(binding,'one',profile,async()=>{
 const body=api.prepareDesktopProviderInput(binding,'one',{...profile,input:initial});assert.deepEqual(body.input,initial);return response('one');},()=>({error:'failed'}),true);
 store.retainDesktopContext(binding,'one',completed);}

test('genuine compaction retains the latest actual image tool pairs for continued visual work',()=>isolated(async()=>{
 const image=(bytes:string)=>({type:'input_image',image_url:'data:image/png;base64,'+bytes});
 const sourceCall={type:'function_call',call_id:'source',name:'native__operator_read_attachment',arguments:'{"page":1}'};
 const sourceOutput={type:'function_call_output',call_id:'source',output:[{type:'input_text',text:'Actual source page 1'},image('AQID')]};
 const oldCall={type:'function_call',call_id:'old-observe',name:'review_current_work',arguments:'{"review_mode":"observe"}'};
 const oldOutput={type:'function_call_output',call_id:'old-observe',output:[{type:'input_text',text:'Historical model epoch 1'},image('BwgJ')]};
 const observedCall={...oldCall,call_id:'observe'};
 const observedOutput={type:'function_call_output',call_id:'observe',output:[{type:'input_text',text:'Actual model epoch 2 and source; observation only'},image('BAUG'),image('AQID')]};
 const compaction={type:'compaction',encrypted_content:'actual-opaque-provider-item'};
 const nextCall={type:'function_call',call_id:'next',name:'native__invoke',arguments:'{}'};
 const nextOutput={type:'function_call_output',call_id:'next',output:'actual read'};
 await store.retainDesktopResponse(binding,'images',profile,async()=>{
  api.prepareDesktopProviderInput(binding,'images',{...profile,input:[...initial,sourceCall,sourceOutput,oldCall,oldOutput,observedCall,observedOutput]});
  return response('images','images',[compaction,nextCall]);
 },()=>({}),true);
 store.retainDesktopContext(binding,'images',[nextOutput]);
 await store.retainDesktopResponse(binding,'continue-images',{...profile,previous_response_id:'images'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'continue-images',{...profile,previous_response_id:'images',input:[nextOutput]});
  assert.deepEqual(body.input[0],compaction); assert.deepEqual(body.input.slice(-2),[nextCall,nextOutput]);
  assert.deepEqual(body.input[1],sourceCall);assert.deepEqual(body.input[3],observedCall);assert.deepEqual(body.input[4],observedOutput);
  assert.equal(body.input[2].call_id,sourceOutput.call_id);assert.deepEqual(body.input[2].output[0],sourceOutput.output[0]);
  assert.equal(body.input[2].output[1].type,'input_text');assert(body.input[2].output[1].text.includes('Historical duplicate image'));
  assert.deepEqual(sourceOutput.output[1],image('AQID'),'Original retained source pixels stay unchanged; the exact same image is delivered in observedOutput');
  assert.equal(body.input.flatMap((x:any)=>Array.isArray(x.output)?x.output:[]).filter((p:any)=>p.type==='input_image').length,2);
  assert.equal(body.previous_response_id,undefined);
  assert(!JSON.stringify(body.input).includes('old-observe'));
  return response('continue-images','continue-images',[]);
 },()=>({}),true);
}));

test('compaction cannot grow a pinned image history without bound',()=>isolated(async()=>{
 const image=(n:number)=>({type:'input_image',image_url:'data:image/png;base64,'+Buffer.alloc(n,1).toString('base64')});
 const calls=[0,1,2].map(n=>({type:'function_call',call_id:'image-'+n,name:'image-tool-'+n,arguments:'{}'}));
 const outputs=calls.map((c,n)=>({type:'function_call_output',call_id:c.call_id,output:[image(n===2?10_000_000:3)]}));
 const items=calls.flatMap((c,n)=>[c,outputs[n]]),next={type:'function_call',call_id:'next',name:'native__invoke',arguments:'{}'};
 await store.retainDesktopResponse(binding,'bounded',profile,async()=>{
  api.prepareDesktopProviderInput(binding,'bounded',{...profile,input:items});return response('bounded','bounded',[{type:'compaction',encrypted_content:'opaque'},next]);
 },()=>({}),true);store.retainDesktopContext(binding,'bounded',[{type:'function_call_output',call_id:'next',output:'read'}]);
 await store.retainDesktopResponse(binding,'bounded-next',{...profile,previous_response_id:'bounded'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'bounded-next',{...profile,previous_response_id:'bounded',input:[{type:'function_call_output',call_id:'next',output:'read'}]});
  assert(!body.input.some((i:any)=>i.call_id==='image-0'),'Only the latest two image tools can be retained.');
  assert(!body.input.some((i:any)=>i.call_id==='image-2'),'Oversized pixels remain in raw history, not an unbounded live window.');
  assert(body.input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='image-1'));
  return response('bounded-next','bounded-next',[]);
 },()=>({}),true);
}));

test('independent visual/code review cannot replace the exact owner cursor (retained289 order)',()=>isolated(async()=>{
 await store.retainDesktopResponse(binding,'one',profile,async()=>response('one'),()=>({}),true);
 const reviewer={...profile,context_role:'independent_review'};
 assert.equal(api.desktopResponseOwnsContext(reviewer),false);
 await store.retainDesktopResponse(binding,'review',reviewer,async()=>response('review'),()=>({}),api.desktopResponseOwnsContext(reviewer));
 assert.doesNotThrow(()=>store.retainDesktopContext(binding,'one',completed));
 assert.equal((store.readDesktopContext(binding,state()) as any).previous_response_id,'one');
 assert.equal(api.desktopResponseOwnsContext(profile),true);
 assert.throws(()=>api.desktopResponseOwnsContext({...profile,context_role:'pretend-owner'}));
}));

test('cold continuation sends opaque compacted window, exact tool output and new images without remote cursor',()=>isolated(async()=>{
 await first();
 const direction={role:'user',content:[{type:'input_text',text:'Continue remaining work.'},{type:'input_image',image_url:'data:image/png;base64,BAUG'}]};
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:[...completed,direction]});
  assert.equal(body.previous_response_id,undefined);
  assert.deepEqual(body.input,[...output,...completed,direction]);
  return response('two','two',[{type:'function_call',call_id:'read',name:'native__invoke',arguments:'{}'}]);
 },()=>({}),true);
 store.retainDesktopContext(binding,'two',[{type:'function_call_output',call_id:'read',output:'checked actual result'}]);
 const saved=store.readDesktopContext(binding,state('two')) as any;
 assert.equal(saved.previous_response_id,'two');assert.equal(saved.continuation_transport,'durable_input_array');
}));

test('reviewer, foreign cursor/profile and missing/conflicting tool results cannot consume owner window',()=>isolated(async()=>{
 await first();
 const request={...profile,previous_response_id:'one',input:completed};
 assert.deepEqual(api.prepareDesktopProviderInput(binding,'review',{...request,context_role:'independent_review'}),{...request,context_role:'independent_review'});
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  for(const patch of [{previous_response_id:'foreign'},{model:'other'},{reasoning_effort:'high'},
   {input:[]},{input:[{...completed[0],output:'invented'}]}])
   assert.throws(()=>api.prepareDesktopProviderInput(binding,'two',{...request,...patch}));
  return response('two');
 },()=>({}),true);
}));

test('failed dispatch never restores old compacted actions; Pause/unknown/terminal controls still govern',()=>isolated(async()=>{
 await first();
 for(const patch of [{terminal:true},{execution_control:{state:'paused'}},{unresolved_unknown_operation_ids:['u']},{provider_usage_hold:{}},{pending_review_ids:['r']}])
  assert.throws(()=>store.readDesktopContext(binding,{...state(),...patch}));
 await assert.rejects(store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  api.prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:completed});throw Error('provider failure');
 },()=>({error:'failed'}),true));
 assert.deepEqual(store.readDesktopContext(binding,state()),{status:'unavailable'});
 assert.throws(()=>store.retainDesktopContext(binding,'one',completed),/not_latest/);
}));

test('legacy cursor-only checkpoint remains supported, without pretending it has durable images',()=>isolated(async()=>{
 await store.retainDesktopResponse(binding,'one',profile,async()=>response('one'),()=>({}),true);store.retainDesktopContext(binding,'one',completed);
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  const body={...profile,previous_response_id:'one',input:completed};assert.deepEqual(api.prepareDesktopProviderInput(binding,'two',body),body);return response('two');
 },()=>({}),true);
}));

test('literal image blocks, duplicate/orphan tool outputs and bounded window cannot be fabricated on recovery',()=>isolated(async()=>{
 const invalid=[
  [{role:'user',content:[{type:'input_image'}]}],
  [{role:'user',content:[{type:'input_image',file_id:'file',image_url:'pixels'}]}],
  [{type:'function_call_output',call_id:'orphan',output:'done'}],
  [{type:'computer_call',call_id:'pending'}],
  [{type:'function_call',call_id:'a'},{type:'function_call',call_id:'a'}]
 ];
 for(const [i,input]of invalid.entries()){
  await assert.rejects(store.retainDesktopResponse(binding,'bad'+i,profile,async()=>{
   api.prepareDesktopProviderInput(binding,'bad'+i,{...profile,input});return response('bad'+i);
  },()=>({}),true),/desktop_context_window/);
  assert.deepEqual(store.readDesktopContext(binding,state()),{status:'unavailable'});
 }
}));

test('uncompacted history preserves both source and model pixels; opaque compaction drops only earlier items',()=>isolated(async()=>{
 const model={role:'user',content:[{type:'input_image',image_url:'data:image/png;base64,BAUG'}]};
 const items=[{type:'reasoning',encrypted_content:'opaque'}, {type:'function_call',call_id:'report',name:'report_work_for_review',arguments:'{}'}];
 await store.retainDesktopResponse(binding,'one',profile,async()=>{
  api.prepareDesktopProviderInput(binding,'one',{...profile,input:[...initial,model]});return response('one','one',items);
 },()=>({}),true);store.retainDesktopContext(binding,'one',completed);
 await store.retainDesktopResponse(binding,'two',{...profile,previous_response_id:'one'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'two',{...profile,previous_response_id:'one',input:completed});
  assert.deepEqual(body.input,[...initial,model,...items,...completed]);return response('two','two',output);
 },()=>({}),true);store.retainDesktopContext(binding,'two',completed);
 await store.retainDesktopResponse(binding,'three',{...profile,previous_response_id:'two'},async()=>{
  const body=api.prepareDesktopProviderInput(binding,'three',{...profile,previous_response_id:'two',input:completed});
  assert.deepEqual(body.input,[...output,...completed]);return response('three');
 },()=>({}),true);
}));
