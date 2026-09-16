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
import {once} from 'node:events';
import {CodexAppServer} from '../src/codex/app_server.js';
const base=path.dirname(fileURLToPath(import.meta.url));
function fixture(t: TestContext,env: Record<string,string>={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'operator-transport-case-'));
 const trace=path.join(dir,'trace.jsonl');
 const client: any=new CodexAppServer({cwd:dir,codexHome:path.join(dir,'.codex'),command:process.execPath,commandPrefixArgs:[fixturePath()],
  spawnEnv:{...process.env,CODEX_FIXTURE_STATE_PATH:path.join(dir,'state.json'),CODEX_FIXTURE_TRACE_PATH:trace,...env}});
 t.after(()=>client.stop());return {client,trace};
}
test('stop rejects pending request without waiting for old process exit',async t=>{
 const {client}=fixture(t);await client.ensureStarted();
 const proc=client.proc,kill=proc.kill.bind(proc);proc.kill=()=>true;t.after(()=>kill());
 const pending=client.request('test/hold',{});
 const rejected=assert.rejects(pending,/stopped/);client.stop();
 await Promise.race([rejected,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('stopped request remained unresolved')),500);timer.unref();})]);
});
test('late server-request result never writes to replacement transport',async t=>{
 const {client,trace}=fixture(t);await client.ensureStarted();
 let release!: (value: unknown)=>void,entered!: ()=>void;const ready=new Promise<void>(resolve=>entered=resolve);
 client.setServerRequestHandler(async()=>{entered();return await new Promise(resolve=>release=resolve);});
 await client.request('test/serverRequest',{});await ready;
 const oldExit=once(client.proc,'exit');client.stop();await oldExit;
 await client.ensureStarted();const replacement=client.proc.pid;
 release({from:'retired-process'});
 assert.deepEqual(await client.request('test/echo',{replacement:true}),{replacement:true});
 const responses=fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter((row: any)=>row.pid===replacement&&row.id==='fixture-server-request');
 assert.equal(responses.length,0,'retired request must not reply into a new process');
});
test('stop during version probe cannot resurrect cancelled startup or clear newer startup',async t=>{
 const {client,trace}=fixture(t,{CODEX_FIXTURE_VERSION_DELAY_MS:'80'});
 const cancelled=client.ensureStarted();const rejected=assert.rejects(cancelled,/startup was stopped/);
 client.stop();const replacement=client.ensureStarted();await rejected;await replacement;
 assert(client.proc);assert.deepEqual(await client.request('test/echo',{alive:true}),{alive:true});
 const initialized=fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter((row: any)=>row.method==='initialize');
 assert.equal(initialized.length,1);
});
test('raw receipt capability follows process-local start and is never inferred from cold resume',async t=>{
 const {client}=fixture(t);await client.ensureStarted();
 const profile={baseInstructions:'same',developerInstructions:'same'};
 const a=await client.startThread({...profile,experimentalRawEvents:true});
 const b=await client.startThread(profile);
 assert(client.hasRawEventThread(a.thread.id));assert(!client.hasRawEventThread(b.thread.id));
 await client.resumeThread({...profile,threadId:a.thread.id});assert(client.hasRawEventThread(a.thread.id));
 client.stop();await client.ensureStarted();
 await client.resumeThread({...profile,threadId:a.thread.id});assert(!client.hasRawEventThread(a.thread.id));
});

test('an old child exiting after replacement does not clear the live transport or its threads',async t=>{
 const {client}=fixture(t);await client.ensureStarted();
 const old=client.proc,kill=old.kill.bind(old);old.kill=()=>true;t.after(()=>kill());
 client.stop();await client.ensureStarted();
 const replacement=client.proc.pid;
 const started=await client.startThread({baseInstructions:'same',developerInstructions:'same',experimentalRawEvents:true});
 const exited=once(old,'exit');kill();await exited;
 assert.equal(client.proc.pid,replacement);
 assert(client.hasLoadedThread(started.thread.id));assert(client.hasRawEventThread(started.thread.id));
 assert.deepEqual(await client.request('test/echo',{still:'alive'}),{still:'alive'});
});
