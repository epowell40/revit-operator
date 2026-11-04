import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput} from '../src/desktop_response_store.js';

const binding={session_id:'s',assignment_id:'a',run_id:'r',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'};
const image=(n:number)=>({type:'input_image',detail:'original',image_url:'data:image/png;base64,'+Buffer.from([n,1,2]).toString('base64')});
const pair=(id:string,name:string,images:any[])=>[
 {type:'function_call',call_id:id,name,arguments:JSON.stringify({page:1,scope:id})},
 {type:'function_call_output',call_id:id,output:[{type:'input_text',text:JSON.stringify({scope:id,source_hash:'a'.repeat(64),current:false})},...images]}
];
const response=(id:string,output:any[]=[])=>({id,status:'completed',output,
 model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},
 provider_response_usage:{disposition:'completed',session_id:'s',message_id:id,raw_response_ids:[id]}});
async function replay(history:any[],freshPairs:any[]=[],computer=true){
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'visual-history-'));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const calls=history.filter(x=>x.type==='function_call'),outputs=history.filter(x=>x.type==='function_call_output');
  const initial=history.filter(x=>!['function_call','function_call_output'].includes(x.type));
  await retainDesktopResponse(binding,'one',profile,async()=>{
   prepareDesktopProviderInput(binding,'one',{...profile,input:initial});return response('one',calls);
  },()=>({}),true);retainDesktopContext(binding,'one',outputs);
  // A second response makes the old tool outputs historical and the next pair fresh.
  const nextCalls=freshPairs.filter(x=>x.type==='function_call'),nextOutputs=freshPairs.filter(x=>x.type==='function_call_output');
  const second={...profile,previous_response_id:'one',input:outputs};
  await retainDesktopResponse(binding,'two',second,async()=>{
   prepareDesktopProviderInput(binding,'two',second);return response('two',nextCalls);
  },()=>({}),true);retainDesktopContext(binding,'two',nextOutputs);
  let sent:any;const request={...profile,tools:computer?[{type:'computer'}]:[],previous_response_id:'two',input:nextOutputs};
  await retainDesktopResponse(binding,'three',request,async()=>{
   sent=prepareDesktopProviderInput(binding,'three',request);return response('three');
  },()=>({}),true);
  return sent;
 }finally{
  if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
  assert(path.dirname(root)===path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});
 }
}
const pixels=(sent:any)=>sent.input.flatMap((x:any)=>Array.isArray(x.output)?x.output:[]).filter((p:any)=>p.type==='input_image');
const history=()=>[
 ...pair('reference-old','native__operator_read_attachment',[image(1)]),
 ...pair('model-old','review_current_work',[image(2)]),
 ...pair('reference-latest','native__operator_read_attachment',[image(3),image(4)]),
 ...pair('model-mid','review_current_work',[image(5)]),
 ...pair('model-latest','review_current_work',[image(6)])
];

test('420 live window bounds superseded reference/model groups while preserving original quality and whole latest pair',async()=>{
 const old=history(),before=structuredClone(old),sent=await replay(old);
 assert.deepEqual(pixels(sent),[image(3),image(4),image(6)],'Repeated distinct original-resolution frames must not grow with every observation');
 for(const row of old as any[]){
  const actual=sent.input.find((i:any)=>i.type===row.type&&i.call_id===row.call_id);
  assert(actual,'Closed tool pairs and historical scope remain present');
  if(row.type==='function_call')assert.deepEqual(actual,row);
  else assert.deepEqual(actual.output[0],row.output[0]);
 }
 const retired=sent.input.find((x:any)=>x.type==='function_call_output'&&x.call_id==='reference-old').output[1];
 assert.match(retired.text,/SHA256.*[a-f0-9]{64}/);
 assert.match(retired.text,/not.*(?:visual|verification)|no.*(?:visual|verification)/i);
 assert.match(retired.text,/re-read|retrieve/i);
 assert.deepEqual(old,before,'Raw stored evidence must not be rewritten');
});
test('all fresh model image parts remain exact, even when another historical model group is retained',async()=>{
 const fresh=pair('fresh','review_current_work',[image(7),image(8),image(9)]),sent=await replay(history(),fresh);
 assert.deepEqual(sent.input.find((x:any)=>x.call_id==='fresh'&&x.type==='function_call_output'),fresh[1]);
 assert.deepEqual(pixels(sent),[image(3),image(4),image(7),image(8),image(9)]);
});
test('non-computer replay preserves every unique historical image',async()=>{
 assert.equal(pixels(await replay(history(),[],false)).length,6);
});
test('unknown tool image kinds, inline user images and their metadata remain literal',async()=>{
 const unknown=pair('unknown','some_other_observation',[image(10)]);
 const user={role:'user',content:[image(11)]};
 const sent=await replay([user,...history(),...unknown]);
 assert.deepEqual(sent.input.find((x:any)=>x.role==='user'),user);
 assert.deepEqual(sent.input.find((x:any)=>x.call_id==='unknown'&&x.type==='function_call_output'),unknown[1]);
});
test('a latest source/model paired review retains every literal image in the group',async()=>{
 const last=pair('paired','review_current_work',[image(12),image(13)]),sent=await replay([...history(),...last]);
 assert.deepEqual(sent.input.find((x:any)=>x.type==='function_call_output'&&x.call_id==='paired'),last[1]);
 assert.deepEqual(pixels(sent),[image(3),image(4),image(12),image(13)]);
});
test('no-image model review does not retire the latest actual model pixels',async()=>{
 const sent=await replay([...history(),...pair('text-only','review_current_work',[])]);
 assert.deepEqual(pixels(sent),[image(3),image(4),image(6)]);
});
test('genuine opaque compaction and reasoning survive the live projection',async()=>{
 const opaque={type:'compaction',encrypted_content:'opaque-provider-state'},reasoning={type:'reasoning',id:'reason-1',summary:[],encrypted_content:'opaque-reasoning'};
 const sent=await replay([opaque,reasoning,...history()]);
 assert.deepEqual(sent.input[0],opaque);assert.deepEqual(sent.input[1],reasoning);
 assert.deepEqual(pixels(sent),[image(3),image(4),image(6)]);
});
test('remote, file and future image contracts cannot be hidden by known-tool retirement',async()=>{
 for(const part of [
  {type:'input_image',file_id:'provider-file'},
  {type:'input_image',image_url:'https://example.test/image.png'},
  {...image(20),new_metadata:'future-contract'},
  {...image(21),image_url:'data:image/png;base64,invalid!'}
 ]){
  // Source/model histories from older producers can have transport contracts
  // outside embedded pixels. Leave them to the existing strict relay guards.
  const early=pair('special','review_current_work',[part]);
  if('new_metadata' in part){
   const sent=await replay([...early,...history()]);
   assert.deepEqual(sent.input.find((x:any)=>x.type==='function_call_output'&&x.call_id==='special'),early[1]);
  }else await assert.rejects(()=>replay([...early,...history()]),/desktop_context_tool_output_mismatch/,
   'Existing output admission must still reject unsupported transport identities before any pruning');
 }
});
test('same-kind fresh source images supersede old source pixels without touching model or fresh metadata',async()=>{
 const fresh=pair('fresh-source','native__operator_read_attachment',[image(22),image(23)]),sent=await replay(history(),fresh);
 assert.deepEqual(pixels(sent),[image(6),image(22),image(23)]);
 assert.deepEqual(sent.input.find((x:any)=>x.type==='function_call_output'&&x.call_id==='fresh-source'),fresh[1]);
});
