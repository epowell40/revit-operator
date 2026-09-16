import os from 'node:os';
import type { TestContext } from 'node:test';
function fixturePath(): string {
 const here=path.dirname(fileURLToPath(import.meta.url));
 const found=[path.join(here,'fixtures/codex_recovery_fixture.js'),path.join(here,'../../test/fixtures/codex_recovery_fixture.js')].find(fs.existsSync);
 assert.ok(found,'Recovery process fixture must be present');return found;
}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexAppServer} from '../src/codex/app_server.js';
import {getOrCreateCodexThread} from '../src/brains/codex_thread_lifecycle.js';
import {withCodexCapabilityHandoff} from '../src/brains/codex_tool_catalog.js';
import {getCodexThreadStartProfile} from '../src/brains/codex_turn_profile.js';
import {codexTelemetryThreadKey} from '../src/brains/codex_turn_model_telemetry.js';
import {appendEvent,getCodexThreadId,setCodexThreadId,__closeForTests} from '../src/memory/sqlite_store.js';
function setup(t: TestContext){
 const previous=process.env.OPERATOR_WORKSPACE_ROOT,clients:CodexAppServer[]=[];
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-thread-case-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{for(const client of clients)client.stop();__closeForTests();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 const status=path.join(root,'status');fs.writeFileSync(status,'idle');
 const trace=path.join(root,'trace.jsonl');
 const make=()=>{const client=new CodexAppServer({cwd:root,codexHome:path.join(root,'.codex'),command:process.execPath,
   commandPrefixArgs:[fixturePath()],spawnEnv:{...process.env,CODEX_FIXTURE_STATE_PATH:path.join(root,'state.json'),
     CODEX_FIXTURE_TRACE_PATH:trace,CODEX_FIXTURE_RESUME_STATUS_PATH:status}});clients.push(client);return client;};
 const profile=getCodexThreadStartProfile({session_id:'same-session',context:{}},{baseInstructions:'policy',developerInstructions:'same user'});
 const args: Omit<Parameters<typeof getOrCreateCodexThread>[0], "client">={sessionId:'same-session',profile,cwd:root,settings:{model:'fixture',reasoning_effort:'medium'},getDynamicTools:async()=>[]};
 return {make,args,status,trace};
}
test('cold active thread is monitored in place and cannot be replaced by a new-work request',async t=>{
 const {make,args,status,trace}=setup(t);const first=make();await first.ensureStarted();
 const original=await getOrCreateCodexThread({...args,client:first});first.stop();
 fs.writeFileSync(status,'active');const second=make();await second.ensureStarted();
 assert.equal(await getOrCreateCodexThread({...args,client:second,monitoringOnly:true}),original);
 await assert.rejects(getOrCreateCodexThread({...args,client:second}),/prior thread is active/);
 assert.equal(getCodexThreadId(codexTelemetryThreadKey(args.profile)),original);
 const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(x=>x.direction==='in');
 assert.equal(calls.filter(x=>x.method==='thread/start').length,1);
 assert.equal(calls.filter(x=>x.method==='turn/interrupt').length,0);
});
test('unaccepted clarification handoff survives a second restart and is consumed only by acknowledged turn start',async t=>{
 const {make,args,trace}=setup(t);const a=make();await a.ensureStarted();
 const first=await getOrCreateCodexThread({...args,client:a});
 appendEvent(args.sessionId,'user','chat.message',{display:{message_id:'request',text:'Assess the twelve spaces, but ask me for airflow before exporting.'}});
 appendEvent(args.sessionId,'user','chat.message',{display:{message_id:'clarification',text:'450 CFM supply, 450 return, no exhaust in offices.'}});
 appendEvent('other-session','user','chat.message',{display:{message_id:'excluded',text:'Private other assignment.'}});
 a.stop();const b=make();await b.ensureStarted();const second=await getOrCreateCodexThread({...args,client:b});
 assert.notEqual(second,first);b.stop();const c=make();await c.ensureStarted();
 const third=await getOrCreateCodexThread({...args,client:c});assert.notEqual(third,second);
 const input: Parameters<typeof withCodexCapabilityHandoff>[0]=[{type:'text',text:'Continue',text_elements:[]}];const handoff=withCodexCapabilityHandoff(input,third);
 assert.match(JSON.stringify(handoff),/450 CFM/);assert.match(JSON.stringify(handoff),/twelve spaces/);
 assert.doesNotMatch(JSON.stringify(handoff),/Private other assignment|tool catalog changed/);
 assert.match(JSON.stringify(handoff),/cannot emit per-call response receipts/);
 const turn=await c.startBoundTurn({threadId:third,input:handoff},args.profile);
 assert.notDeepEqual(withCodexCapabilityHandoff(input,third),input,'provider response alone must not clear durable handoff');
 appendEvent(args.sessionId,'assistant','codex.turn.start',{thread_id:third,turn_id:turn.turn.id});
 c.acknowledgePersistedTurnInstructionBinding(third,turn.turn.id);
 assert.deepEqual(withCodexCapabilityHandoff(input,third),input);
 assert.equal(await getOrCreateCodexThread({...args,client:c}),third,'warm raw-capable thread should be reused');
 const calls=fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(x=>x.direction==='in');
 assert.equal(calls.filter(x=>x.method==='thread/start').length,3);assert.equal(calls.filter(x=>x.method==='turn/start').length,1);
 assert(calls.filter(x=>x.method==='thread/start').every(x=>x.params.experimentalRawEvents===true));
});
test('monitoring a missing provider cannot create work, while explicit recovery preserves user history',async t=>{
 const {make,args,trace}=setup(t);const client=make();await client.ensureStarted();
 const key=codexTelemetryThreadKey(args.profile);setCodexThreadId(key,'missing-provider-history');
 appendEvent(args.sessionId,'user','chat.message',{display:{message_id:'original',text:'Keep the accepted thermal zoning criteria.'}});
 await assert.rejects(getOrCreateCodexThread({...args,client,monitoringOnly:true}),/thread not found/);
 assert.equal(getCodexThreadId(key),'missing-provider-history');
 const observed=fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(observed.filter(x=>x.method==='thread/start').length,0);
 const next=await getOrCreateCodexThread({...args,client});assert.notEqual(next,'missing-provider-history');
 const handoff=withCodexCapabilityHandoff([{type:'text',text:'Continue',text_elements:[]}],next);
 assert.match(JSON.stringify(handoff),/accepted thermal zoning criteria/);
 assert.match(JSON.stringify(handoff),/previous provider thread is unavailable/);
});

test('a failed replacement start preserves the missing provider identity and handoff across retry',async t=>{
 const {make,args}=setup(t);const client=make();await client.ensureStarted();
 const key=codexTelemetryThreadKey(args.profile);setCodexThreadId(key,'missing-prior-provider');
 appendEvent(args.sessionId,'user','chat.message',{display:{message_id:'criteria',text:'Each corner office is its own thermal zone.'}});
 const start=client.startThread.bind(client);client.startThread=async()=>{throw new Error('fixture replacement unavailable');};
 await assert.rejects(getOrCreateCodexThread({...args,client}),/replacement unavailable/);
 assert.equal(getCodexThreadId(key),'missing-prior-provider','failed replacement cannot clear the durable predecessor');
 client.startThread=start;client.stop();const nextClient=make();await nextClient.ensureStarted();
 const replacement=await getOrCreateCodexThread({...args,client:nextClient});
 const handoff=withCodexCapabilityHandoff([{type:'text',text:'Continue',text_elements:[]}],replacement);
 assert.match(JSON.stringify(handoff),/corner office is its own thermal zone/);
 assert.match(JSON.stringify(handoff),/missing-prior-provider/);
});
