import test from 'node:test';
import assert from 'node:assert/strict';
import { readRuntimeProfileWithTransportRetry as read } from './runtime_profile_read.mjs';
import * as profileReads from './runtime_profile_read.mjs';
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

test('expired runtime access refreshes host custody rather than treating cache expiry as authorization denial',async()=>{
 assert.equal(typeof profileReads.runtimeProfileForAccess,'function');
 let profile={general_agent:false},calls=0;
 const result=await profileReads.runtimeProfileForAccess(()=>profile,async()=>{calls++;profile={general_agent:true};});
 assert.equal(result.general_agent,true);assert.equal(calls,1);
 await profileReads.runtimeProfileForAccess(()=>profile,async()=>{throw Error('fresh profile needs no extra GET');});
});
test('freshening never trusts a refresh return, grants access after denial, or hides transport failure',async()=>{
 assert.equal(typeof profileReads.runtimeProfileForAccess,'function');
 const denied={general_agent:false};assert.equal(await profileReads.runtimeProfileForAccess(()=>denied,async()=>({general_agent:true})),denied);
 await assert.rejects(profileReads.runtimeProfileForAccess(()=>denied,async()=>{throw Error('profile unavailable');}),/profile unavailable/);
});


test('normal local/self-host availability requires the exact backend and loopback handshake',()=>{
  for(const mode of ['local','self_hosted']) {
    const env={REVIT_OPERATOR_MODE:mode,OPERATOR_TOOL_EXPOSURE_PROFILE:'general',OPERATOR_AUTH_MODE:'shared_token'};
    const profile={schema:'revit-operator.sidecar-agent-profile.v1',source:'backend_environment',runtime_mode:mode,tool_exposure_profile:'general',capability_profile:'general_agent',general_agent_ready:true,reason_code:'GENERAL_AGENT_LOCAL_READY'};
    const input={env,backendProfile:profile,backendUrl:'http://127.0.0.1:7007'};
    assert.equal(profileReads.isLocalGeneralAgentHandshake(input),true);
    for(const [field,value] of Object.entries({schema:'foreign',source:'caller',runtime_mode:'production',tool_exposure_profile:'certified',capability_profile:'general_agent_laboratory',general_agent_ready:false,reason_code:'GENERAL_AGENT_HOSTED_PRODUCTION_READY'}))
      assert.equal(profileReads.isLocalGeneralAgentHandshake({...input,backendProfile:{...profile,[field]:value}}),false,field);
    for(const url of ['http://foreign.example','https://127.0.0.1:7007','http://127.0.0.1.evil.test','http://user@127.0.0.1:7007','http://127.0.0.1:7007/foreign','http://127.0.0.1:7007/?foreign=1'])
      assert.equal(profileReads.isLocalGeneralAgentHandshake({...input,backendUrl:url}),false,url);
    for(const extra of [{REVIT_OPERATOR_MODE:'LOCAL'},{OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory'},{OPERATOR_HOSTED_ENABLED:'true'},{OPERATOR_AUTH_MODE:'principal_jwt'}])
      assert.equal(profileReads.isLocalGeneralAgentHandshake({...input,env:{...env,...extra}}),false);
    assert.equal(profileReads.isLocalGeneralAgentHandshake({...input,backendProfile:null}),false);
  }
});
