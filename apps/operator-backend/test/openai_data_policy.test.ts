import test from 'node:test';import assert from 'node:assert/strict';
import {createOpenAiClient} from '../src/openai_client.js';
import http from'node:http';
const realFetch=globalThis.fetch;
const names=['OPERATOR_OPENAI_RESPONSE_STORAGE','OPERATOR_OPENAI_ACCOUNT_ALIAS','OPERATOR_OPENAI_BASE_URL','OPENAI_BASE_URL','OPERATOR_OPENAI_ORG','OPENAI_ORG','OPENAI_ORG_ID','OPERATOR_OPENAI_PROJECT','OPENAI_PROJECT','OPENAI_PROJECT_ID'];
async function isolated(run:(sent:any[])=>Promise<void>){const prior=Object.fromEntries(names.map(k=>[k,process.env[k]])),previous=globalThis.fetch,sent:any[]=[];
 for(const k of names)delete process.env[k];process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:1/v1';process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='host';
 globalThis.fetch=async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'synthetic',object:'response',status:'completed',output:[]}),{headers:{'content-type':'application/json'}});};
 try{await run(sent);}finally{globalThis.fetch=previous;for(const k of names){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}}
}
test('host response storage sends explicit false with opaque reasoning continuity',()=>isolated(async sent=>{
 await createOpenAiClient('synthetic-fixture-key').responses.create({model:'gpt-6.1-terra',input:[{role:'user',content:'Synthetic data only'}],context_management:[{type:'compaction',compact_threshold:100_000}]} as any,{maxRetries:0});
 assert.equal(sent.length,1);assert.equal(sent[0].store,false);assert.ok(sent[0].include.includes('reasoning.encrypted_content'));assert.equal(sent[0].context_management[0].type,'compaction');
}));
test('host SDK streaming uses the checked create path',()=>isolated(async sent=>{
 globalThis.fetch=async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));const response={id:'synthetic',status:'completed',output:[]};return new Response(['response.created','response.completed'].map(type=>'event: '+type+'\ndata: '+JSON.stringify({type,response})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});};
 const stream=createOpenAiClient('synthetic').responses.stream({model:'gpt-6.1-terra',input:'Synthetic'});await stream.finalResponse();assert.equal(sent.length,1);assert.equal(sent[0].store,false);
}));
test('host rejects a project override before network transmission',()=>isolated(async sent=>{
 await assert.rejects(async()=>await createOpenAiClient('synthetic').responses.create({model:'gpt-6.1-terra',input:'Synthetic'},{maxRetries:0,headers:{'OpenAI-Project':'foreign-project'}}),
 (error:any)=>String(error.cause?.message).includes('provider_data_policy_destination_mismatch'));assert.equal(sent.length,0);
}));
test('host real loopback transport never follows a redirect with task content',()=>isolated(async()=>{
 let forwarded=0;const target=http.createServer((_req,res)=>{forwarded++;res.end('{}');}),source=http.createServer((_req,res)=>{res.writeHead(307,{location:'http://127.0.0.1:'+(target.address() as any).port+'/v1/responses'});res.end();});
 await new Promise<void>(resolve=>target.listen(0,'127.0.0.1',resolve));await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve));
 try{globalThis.fetch=realFetch;process.env.OPERATOR_OPENAI_BASE_URL='http://127.0.0.1:'+(source.address() as any).port+'/v1';
  await assert.rejects(async()=>await createOpenAiClient('synthetic-loopback-only').responses.create({model:'gpt-6.1-terra',input:'Synthetic redirect canary'},{maxRetries:0}));assert.equal(forwarded,0);
 }finally{source.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise<void>(resolve=>source.close(()=>resolve())),new Promise<void>(resolve=>target.close(()=>resolve()))]);}
}));
test('host response storage rejects a remote cursor before sending any content',()=>isolated(async sent=>{
 await assert.rejects(async()=>await createOpenAiClient('synthetic-fixture-key').responses.create({model:'gpt-6.1-terra',input:'Synthetic',previous_response_id:'previous-remote'} as any,{maxRetries:0}),/provider_data_policy/);
 assert.equal(sent.length,0);
}));
for(const extra of [{store:true},{conversation:'remote'},{background:true},{input:[{type:'item_reference',id:'remote-item'}]},{store:'false'}])test('host policy blocks unsupported state '+JSON.stringify(extra),()=>isolated(async sent=>{
 await assert.rejects(async()=>await createOpenAiClient('synthetic-fixture-key').responses.create({model:'gpt-6.1-terra',input:'Synthetic',...extra} as any,{maxRetries:0}),/provider_data_policy/);assert.equal(sent.length,0);
}));
test('default policy preserves stored Responses and explicit stateless intake; Chat keeps its nonstored default',()=>isolated(async sent=>{
 delete process.env.OPERATOR_OPENAI_RESPONSE_STORAGE;const client=createOpenAiClient('synthetic-fixture-key');
 await client.responses.create({model:'gpt-6.1-terra',input:'Synthetic'});await client.responses.create({model:'gpt-6.1-terra',input:'Synthetic',store:false});
 await client.chat.completions.create({model:'gpt-6.1-terra',messages:[{role:'user',content:'Synthetic'}]});
 assert.deepEqual(sent.map(b=>b.store),[true,false,false]);
}));
test('invalid policy and insecure host destination fail before content is sent',()=>isolated(async sent=>{
 process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='typo';assert.throws(()=>createOpenAiClient('synthetic'),/provider_data_policy/);
 process.env.OPERATOR_OPENAI_RESPONSE_STORAGE='host';process.env.OPERATOR_OPENAI_BASE_URL='http://external.invalid/v1';assert.throws(()=>createOpenAiClient('synthetic'),/provider_data_policy/);
 process.env.OPERATOR_OPENAI_BASE_URL='https://user:private@external.invalid/v1';assert.throws(()=>createOpenAiClient('synthetic'),/provider_data_policy/);assert.equal(sent.length,0);
}));
test('client rejects account policy drift and caller cannot change host Chat storage',()=>isolated(async sent=>{
 const client=createOpenAiClient('synthetic');process.env.OPERATOR_OPENAI_ACCOUNT_ALIAS='other-account';
 assert.throws(()=>client.responses.create({model:'gpt-6.1-terra',input:'Synthetic'}),/provider_data_policy_changed/);assert.equal(sent.length,0);
 delete process.env.OPERATOR_OPENAI_ACCOUNT_ALIAS;
 assert.throws(()=>client.chat.completions.create({model:'gpt-6.1-terra',messages:[],store:true}),/provider_data_policy/);
}));
test('host preserves opaque compacted input and SDK APIPromise helpers without mutating input',()=>isolated(async sent=>{
 const input=[{type:'compaction',encrypted_content:'synthetic-opaque-fixture'},{role:'user',content:'Continue'}];
 const body={model:'gpt-6.1-terra',input,include:['reasoning.encrypted_content']};const original=JSON.stringify(body);
 const promise=createOpenAiClient('synthetic').responses.create(body as any);assert.equal(typeof promise.withResponse,'function');await promise;
 assert.equal(JSON.stringify(body),original);assert.deepEqual(sent[0].input,input);assert.deepEqual(sent[0].include,['reasoning.encrypted_content']);
}));
