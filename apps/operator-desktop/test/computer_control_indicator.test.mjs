import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createComputerControlIndicator} from '../computer_control_indicator.mjs';
test('owned display starts without focus or execution-policy overrides, and closes on idle',()=>{
 const state={running:false,desktopCaptureSuppressed:false};let count=0,ended=false,executable,args,settings;
 const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};child.stdin.end=()=>{ended=true;};child.stdout=new EventEmitter();
 const display=createComputerControlIndicator(()=>state,{platform:'win32',spawn:(file,a,s)=>{count++;executable=file;args=a;settings=s;return child;}});
 try{display.update();assert.equal(count,0);state.running=true;display.update();display.update();assert.equal(count,1);
 assert.equal(settings.windowsHide,true);assert.match(executable,/OperatorControlIndicator\.exe$/);assert.deepEqual(args,[]);assert.equal(display.status(),'starting');
 child.stdout.emit('data','READY\n');assert.equal(display.status(),'visible');
 state.running=false;display.update();assert.equal(ended,true);assert.equal(display.status(),'idle');
 }finally{display.stop();}
});
test('failed indicator does not repeatedly launch or obstruct execution; native-only tasks never launch it',()=>{
 const state={running:true,desktopCaptureSuppressed:true};let calls=0;
 const display=createComputerControlIndicator(()=>state,{platform:'win32',spawn:()=>{calls++;throw Error('unavailable');}});
 display.update();assert.equal(calls,0);state.desktopCaptureSuppressed=false;
 display.update();display.update();assert.equal(calls,1);assert.equal(display.status(),'unavailable');
 state.running=false;display.update();assert.equal(display.status(),'idle');
});
