import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {createComputerControlIndicator} from '../computer_control_indicator.mjs';
test('owned display starts without focus or execution-policy overrides, and closes on idle',()=>{
 const state={running:false,desktopCaptureSuppressed:false};let count=0,ended=false,executable,args,settings;
 const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};child.stdin.end=()=>{ended=true;};child.stdout=new EventEmitter();
 const display=createComputerControlIndicator(()=>state,{platform:'win32',spawn:(file,a,s)=>{count++;executable=file;args=a;settings=s;return child;}});
 try{display.update();assert.equal(count,0);state.running=true;display.update();display.update();assert.equal(count,1);
 assert.equal(settings.windowsHide,true);assert.match(executable,/OperatorControlIndicator\.exe$/);assert.match(args[0],/^Local\\OperatorInputStop_[a-f0-9]{32}$/);assert.equal(args.length,1);assert.equal(display.status(),'starting');
 child.stdout.emit('data','READY\n');assert.equal(display.status(),'visible');
 state.running=false;display.update();assert.equal(ended,true);assert.equal(display.status(),'idle');
 }finally{display.stop();}
});

test('split Escape stop message is latched once and stale children cannot stop a later owner',()=>{
 const state={running:true,desktopCaptureSuppressed:false};const children=[];let stops=0;
 const display=createComputerControlIndicator(()=>state,{platform:'win32',onStop:()=>stops++,spawn:()=>{
   const c=new EventEmitter();c.stdin=new EventEmitter();c.stdin.write=()=>{};c.stdin.end=()=>{};c.stdout=new EventEmitter();children.push(c);return c;
 }});
 try {
  display.update();const event=display.inputStopEvent();children[0].stdout.emit('data','REA');assert.equal(display.status(),'starting');
  children[0].stdout.emit('data','DY\nST');assert.equal(display.status(),'visible');assert.equal(stops,0);
  children[0].stdout.emit('data','OP\nSTOP\n');assert.equal(stops,1);assert.equal(display.status(),'stopped');
  state.running=false;display.update();state.running=true;display.update();assert.notEqual(display.inputStopEvent(),event);
  children[0].stdout.emit('data','STOP\n');assert.equal(stops,1);
  children[1].emit('exit',1);assert.equal(stops,2);assert.equal(display.status(),'unavailable');
 }finally{display.stop();}
});
test('failed indicator does not repeatedly launch or obstruct execution; native-only tasks never launch it',()=>{
 const state={running:true,desktopCaptureSuppressed:true};let calls=0;
 const display=createComputerControlIndicator(()=>state,{platform:'win32',spawn:()=>{calls++;throw Error('unavailable');}});
 display.update();assert.equal(calls,0);state.desktopCaptureSuppressed=false;
 display.update();display.update();assert.equal(calls,1);assert.equal(display.status(),'unavailable');
 state.running=false;display.update();assert.equal(display.status(),'idle');
});

test('manual Stop signals the same input event without waiting for the provider',()=>{
 const state={running:true,desktopCaptureSuppressed:false};const writes=[];
 const child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=s=>writes.push(s);child.stdin.end=()=>{};child.stdout=new EventEmitter();
 const display=createComputerControlIndicator(()=>state,{platform:'win32',spawn:()=>child});
 try{display.update();child.stdout.emit('data','READY\n');display.latchStop();assert.equal(display.status(),'stopped');assert(writes.includes('stop\n'));}finally{display.stop();}
});
