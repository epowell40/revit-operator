import test from 'node:test';import assert from 'node:assert/strict';
import {waitForWorkflowUiStart,savedFileAfterProcessExit} from './workflow-harness.mjs';
test('monitor is armed before Send and binds only a new observed UI start',async()=>{
 let time=10000,calls=0;const initial={running:false,progress:{startedAt:new Date(1000).toISOString()}},fresh={running:true,progress:{startedAt:new Date(10250).toISOString()}};
 const result=await waitForWorkflowUiStart({initial,armedAt:time,readState:async()=>++calls===1?initial:fresh,now:()=>time,sleep:async ms=>time+=ms});
 assert.equal(result,fresh);assert.equal(calls,2);
});
test('pre-Send monitor never restarts stopped/stale tasks or waits indefinitely',async()=>{
 let time=10000;await assert.rejects(waitForWorkflowUiStart({initial:{running:true},armedAt:time,readState:()=>assert.fail('no read')}),/idle/);
 for(const state of [{running:false},{running:true,progress:{startedAt:new Date(1000).toISOString()}}]){
 time=10000;await assert.rejects(waitForWorkflowUiStart({initial:{running:false},armedAt:time,timeoutMs:500,readState:async()=>state,now:()=>time,sleep:async ms=>time+=ms}),/No new UI/);
 }
});
const expected={pid:22,exe:'C:\\Revit.exe',created_utc:'2026-10-26T12:00:00Z'};
test('saved result is hashed only after exact process normal exit is observed',async()=>{
 let time=0,reads=0,hashed=0;const result=await savedFileAfterProcessExit({expected,readProcess:async()=>++reads<3?{...expected}:null,readFile:()=>{hashed++;assert.equal(reads,3);return {hash:'actual'};},now:()=>time,sleep:async ms=>time+=ms});
 assert.equal(hashed,1);assert.equal(result.hash,'actual');
});
test('exit pending and PID replacement never hash a saved file',async()=>{
 for(const changed of [false,true]){let time=0;await assert.rejects(savedFileAfterProcessExit({expected,readProcess:async()=>({...expected,created_utc:changed?'2026-10-26T13:00:00Z':expected.created_utc}),
 readFile:()=>assert.fail('no hash'),timeoutMs:500,now:()=>time,sleep:async ms=>time+=ms}),changed?/identity changed/:/exit pending/);}
});
