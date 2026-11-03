import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {afterNativeInteractiveReadback} from '../src/assignments/native_interactive_input.js';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('native placement completion waits for its original automatic read before invoking provider admission once',async()=>{
 let finish!:(v?:unknown)=>void,calls=0,readSettled=false;
 const native=new Promise(resolve=>{finish=resolve;});
 const output=afterNativeInteractiveReadback(native,async()=>{calls++;assert.equal(readSettled,true);return 'actual-provider-result';});
 await tick();assert.equal(calls,0,'194 successor must not enter admission during readback');
 readSettled=true;finish();assert.equal(await output,'actual-provider-result');assert.equal(calls,1);
 assert.equal(await native,undefined,'wait did not replace or consume original result');
});
test('while Revit still requires input, or without a live invocation, normal provider admission runs immediately',async()=>{
 let calls=0;const result=afterNativeInteractiveReadback(null,async()=>++calls);assert.equal(calls,1);assert.equal(await result,1);
});
for(const state of ['Pause','unknown','stale binding','pending usage','budget exhausted'])test('fresh '+state+' admission refusal remains authoritative after read settles',async()=>{
 let finish!:()=>void,calls=0;const native=new Promise<void>(r=>finish=r);
 const output=afterNativeInteractiveReadback(native,async()=>{calls++;throw Error(state);});
 await tick();assert.equal(calls,0);finish();await assert.rejects(output,new RegExp(state));assert.equal(calls,1);
});
test('abort stops only the waiter; original native work can still settle and is never redispatched',async()=>{
 let finish!:()=>void,calls=0;const native=new Promise<void>(r=>finish=r),controller=new AbortController();
 const output=afterNativeInteractiveReadback(native,async()=>++calls,controller.signal);controller.abort();
 await assert.rejects(output,/aborted/);finish();await native;await tick();assert.equal(calls,0);
 await assert.rejects(afterNativeInteractiveReadback(null,async()=>++calls,controller.signal),/aborted/);assert.equal(calls,0);
});
test('failed original invocation remains failed without a provider or repeat placement',async()=>{
 let fail!:(e:Error)=>void,calls=0;const native=new Promise<void>((_,r)=>fail=r);
 const output=afterNativeInteractiveReadback(native,async()=>++calls);fail(Error('native receipt unavailable'));
 await assert.rejects(output,/native receipt unavailable/);assert.equal(calls,0);
});
test('desktop relay waits inside its existing serial owner lane before fresh feedback and unchanged admission',()=>{
 const source=fs.readFileSync('src/desktop_computer.ts','utf8');
 const start=source.indexOf("sessionId:JSON.stringify([binding.session_id,binding.assignment_id]),signal:options.signal},()=>withDesktopNativeProviderReadiness");assert(start>0);
 const tail=source.slice(start);assert(tail.indexOf('assignmentKernelV2ForBinding(binding)')<tail.indexOf('executeExternalProviderCallV2('));
 assert.match(tail,/options\.signal\)\)/);
});
