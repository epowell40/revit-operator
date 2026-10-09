import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeProfileWithTransportRetry as read } from './runtime_profile_read.mjs';
const lost = code => new TypeError('fetch failed', { cause: { code } });
test('exact connection reset retries identical profile GET and retains first failure', async () => {
 for (const code of ['ECONNRESET','UND_ERR_SOCKET']) {
  const calls=[], failures=[], profile={general_agent_ready:true};
  const result=await read(async (route, options)=>{ calls.push({route,...options}); if(calls.length===1)throw lost(code);return {sidecar_agent_profile:profile}; }, {onFailure:f=>failures.push(f)});
  assert.equal(result,profile);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
  assert.equal(calls[0].route,'/desktop/computer/config');assert.equal(calls[0].method,'GET');
  assert.deepEqual(failures,[{attempt:1,code,status:null,retry:true}]);
 }
});
test('repeat transport failure stays bounded and never becomes ready',async()=>{
 let calls=0;const failures=[];
 await assert.rejects(read(async()=>{calls++;throw lost('ECONNRESET');},{onFailure:f=>failures.push(f)}),/fetch failed/);
 assert.equal(calls,2);assert.equal(failures[1].retry,false);
});
test('authorization, malformed JSON, abort and other errors do not retry',async()=>{
 for(const error of [Object.assign(new Error('denied'),{status:401}),Object.assign(new Error('denied'),{status:403}),new SyntaxError('bad JSON'),Object.assign(new Error('aborted'),{name:'AbortError'}),lost('ECONNREFUSED'),new Error('fetch failed')]){
  let calls=0;await assert.rejects(read(async()=>{calls++;throw error;}),e=>e===error);assert.equal(calls,1);
 }
 assert.equal(await read(async()=>({})),null);
});
test('abort between attempts prevents second request',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(read(async()=>{calls++;throw lost('ECONNRESET');},{signal:controller.signal,onFailure:()=>controller.abort()}));assert.equal(calls,1);
});
