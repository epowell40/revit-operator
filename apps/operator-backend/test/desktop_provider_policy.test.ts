import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync}from'node:child_process';
import {retainDesktopResponse,retainDesktopContext,prepareDesktopProviderInput}from'../src/desktop_response_store.js';
const binding={session_id:'synthetic-session',assignment_id:'task',run_id:'run',generation:1,kernelVersion:2 as const};
const profile={model:'gpt-6.1-terra',reasoning_effort:'medium'},call={type:'function_call',call_id:'read',name:'read_model',arguments:'{}'},result={type:'function_call_output',call_id:'read',output:'{"checked":true}'};
const response=(id:string)=>({id,status:'completed',output:[{type:'compaction',encrypted_content:'synthetic-opaque'},call],model_call_receipt:{call_id:id,success:true,route:'desktop_computer'},provider_response_usage:{disposition:'completed',session_id:binding.session_id,message_id:id,raw_response_ids:[id]}} as any);
async function isolated(run:(root:string)=>Promise<void>){const names=['OPERATOR_WORKSPACE_ROOT','OPERATOR_OPENAI_RESPONSE_STORAGE','OPERATOR_OPENAI_ACCOUNT_ALIAS'],prior=Object.fromEntries(names.map(k=>[k,process.env[k]])),root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-policy-'));process.env.OPERATOR_WORKSPACE_ROOT=root;delete process.env.OPERATOR_OPENAI_RESPONSE_STORAGE;delete process.env.OPERATOR_OPENAI_ACCOUNT_ALIAS;
 try{await run(root);}finally{for(const k of names){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}}
async function first(){return retainDesktopResponse(binding,'first',profile,async()=>{prepareDesktopProviderInput(binding,'first',{...profile,input:[{role:'user',content:'Synthetic two-area task'}]});return response('first');},()=>({}),true);}
test('same owner recovers compacted context under immutable host storage with separate review',()=>isolated(async root=>{
 process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='host';await first();retainDesktopContext(binding,'first',[result]);
 await retainDesktopResponse(binding,'review',{context_role:'independent_review'},async()=>response('review'),()=>({}),false);
 await retainDesktopResponse(binding,'reopened',{...profile,previous_response_id:'first'},async()=>{
  const body=prepareDesktopProviderInput(binding,'reopened',{...profile,previous_response_id:'first',input:[result,{role:'user',content:'Fresh model evidence'}]});
  assert.equal(body.previous_response_id,undefined);assert.ok(body.input.some((i:any)=>i.type==='compaction'&&i.encrypted_content==='synthetic-opaque'));assert.ok(body.input.some((i:any)=>i.call_id==='read'));return response('reopened');
 },()=>({}),true);
 const policies=fs.readdirSync(path.join(root,'runs/desktop-responses')).filter(f=>f.endsWith('.policy'));assert.equal(policies.length,1);
 const text=fs.readFileSync(path.join(root,'runs/desktop-responses',policies[0]!), 'utf8');assert.equal(JSON.parse(text).policy.storage,'host');assert.ok(!text.includes('API_KEY'));
}));
for(const field of ['OPERATOR_OPENAI_RESPONSE_STORAGE','OPERATOR_OPENAI_ACCOUNT_ALIAS'])test('policy drift blocks owner/reviewer before invocation '+field,()=>isolated(async()=>{
 await first();retainDesktopContext(binding,'first',[result]);process.env[field]=field.endsWith('STORAGE')?'host':'changed-account';let invoked=0;
 for(const owner of [true,false])await assert.rejects(()=>retainDesktopResponse(binding,'changed-'+owner,profile,async()=>{invoked++;return response('changed');},()=>({}),owner),/provider_data_policy_changed/);
 assert.equal(invoked,0);
}));
test('legacy context cannot silently opt in to a new host-storage policy',()=>isolated(async root=>{
 await first();retainDesktopContext(binding,'first',[result]);const dir=path.join(root,'runs/desktop-responses');for(const f of fs.readdirSync(dir).filter(f=>f.endsWith('.policy')))fs.unlinkSync(path.join(dir,f));
 process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='host';let invoked=0;await assert.rejects(()=>retainDesktopResponse(binding,'legacy',profile,async()=>{invoked++;return response('legacy');},()=>({}),true),/legacy_context_requires_migration/);assert.equal(invoked,0);
}));
test('tampered binding in policy custody fails without invoking provider',()=>isolated(async root=>{
 await first();const dir=path.join(root,'runs/desktop-responses'),f=fs.readdirSync(dir).find(f=>f.endsWith('.policy'))!,file=path.join(dir,f),record=JSON.parse(fs.readFileSync(file,'utf8'));record.binding.assignment_id='foreign';fs.writeFileSync(file,JSON.stringify(record));
 await assert.rejects(()=>retainDesktopResponse(binding,'foreign',profile,async()=>{throw Error('must not invoke');},()=>({}),false),/provider_data_policy_changed/);
}));
test('a fresh process resumes the same pinned policy and exact compacted owner window',()=>isolated(async()=>{
 process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='host';await first();retainDesktopContext(binding,'first',[result]);
 const module=new URL('../src/desktop_response_store.js',import.meta.url).href;
 const code=`import assert from'node:assert/strict';import * as s from ${JSON.stringify(module)};const binding=${JSON.stringify(binding)},profile=${JSON.stringify(profile)},result=${JSON.stringify(result)};await s.retainDesktopResponse(binding,'fresh-process',{...profile,previous_response_id:'first'},async()=>{const body=s.prepareDesktopProviderInput(binding,'fresh-process',{...profile,previous_response_id:'first',input:[result,{role:'user',content:'Fresh model evidence after restart'}]});assert.equal(body.previous_response_id,undefined);assert.ok(body.input.some(i=>i.type==='compaction'&&i.encrypted_content==='synthetic-opaque'));return ${JSON.stringify(response('fresh-process'))};},()=>({}),true);s.retainDesktopContext(binding,'fresh-process',[result]);console.log('same-policy fresh-process continuation passed');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:process.env,encoding:'utf8',windowsHide:true,timeout:15_000});assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/same-policy fresh-process/);
}));
test('malformed policy custody remains blocked, never repaired by a model request',()=>isolated(async root=>{
 await first();const dir=path.join(root,'runs/desktop-responses'),file=path.join(dir,fs.readdirSync(dir).find(f=>f.endsWith('.policy'))!);fs.writeFileSync(file,'{incomplete');
 await assert.rejects(()=>retainDesktopResponse(binding,'malformed',profile,async()=>{throw Error('must not invoke');},()=>({}),false),/provider_data_policy/);assert.equal(fs.readFileSync(file,'utf8'),'{incomplete');
}));
