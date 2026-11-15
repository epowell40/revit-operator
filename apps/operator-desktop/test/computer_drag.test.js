import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computerDragArguments, normalizeComputerDrag, summarizeComputerDrag } from '../computer_drag.mjs';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const a=source.indexOf('async function executeComputerAction(action)'),z=source.indexOf('async function executeComputerActionSafely',a);
const retained=[
 [{x:872,y:766},{x:883,y:748},{x:901,y:718},{x:917,y:692}],
 [{x:872,y:766},{x:872,y:760},{x:878,y:749},{x:890,y:729},{x:903,y:709},{x:917,y:692}],
 [{x:839,y:782},{x:840,y:780},{x:845,y:770},{x:860,y:750},{x:880,y:710},{x:907,y:671}]
];
function harness({controlError,readinessError,inputError,stop=false}={}) {
 const calls=[],events=[],state={stopRequested:stop,desktopInputDispatched:false}; let control=0,readiness=0;
 const run=runInNewContext(source.slice(a,z)+';executeComputerAction',{
  computerState:state,computerDragArguments,normalizeComputerDrag,summarizeComputerDrag,Buffer,
  assertComputerActionControl:async()=>{control++;if(controlError)throw Error(controlError);},
  desktopReadinessObligation:()=>({beforeInput(){readiness++;if(readinessError)throw Error(readinessError);}}),
  toAbsoluteDesktopPoint:(x,y)=>({x:x-1920,y:y+40}),
  formatRelativeToDesktopPoint:(x,y)=>`(${x},${y})`,summarizeComputerAction:summarizeComputerDrag,
  addComputerEvent:e=>events.push(e),runDesktopScript:async args=>{calls.push(Array.from(args));if(inputError)throw Error(inputError);}
 });
 return {run,calls,events,state,counts:()=>({control,readiness})};
}
for(const [i,path]of retained.entries())test(`actual dispatcher retained355 drag${i+1} preserves every mapped vertex`,async()=>{
 const h=harness();await h.run({type:'drag',path});assert.equal(h.calls.length,1);
 const args=h.calls[0];assert(args.includes('-DragPathJsonBase64'),'Missing full path argument');
 const got=JSON.parse(Buffer.from(args[args.indexOf('-DragPathJsonBase64')+1],'base64').toString());
 assert.deepEqual(got,path.map(p=>({x:p.x-1920,y:p.y+40})));
 assert.deepEqual(h.counts(),{control:1,readiness:1});assert.equal(h.state.desktopInputDispatched,true);
});
test('actual dispatcher rejects malformed geometry before input/readiness obligation',async()=>{
 for(const action of [{type:'drag'},{type:'drag',path:[]},{type:'drag',path:[{x:1,y:2},{x:null,y:4}]}]){
  const h=harness();await assert.rejects(h.run(action),/drag/i);assert.equal(h.calls.length,0);
  assert.equal(h.state.desktopInputDispatched,false);assert.equal(h.counts().readiness,0);
 }
});
for(const [name,options,message]of [
 ['stop',{stop:true},'Stopped by user'],['control',{controlError:'pause control'},'pause control'],
 ['readiness persistence',{readinessError:'disk failure'},'disk failure']
])test(`actual drag ${name} refuses input`,async()=>{
 const h=harness(options);await assert.rejects(h.run({type:'drag',path:retained[0]}),new RegExp(message));
 assert.equal(h.calls.length,0);assert.equal(h.state.desktopInputDispatched,false);
});
test('unknown input outcome retains readiness obligation without retry',async()=>{
 const h=harness({inputError:'outcome unknown'});await assert.rejects(h.run({type:'drag',path:retained[0]}),/outcome unknown/);
 assert.equal(h.calls.length,1);assert.equal(h.state.desktopInputDispatched,true);assert.equal(h.counts().readiness,1);
});
test('manual desktop adapter uses the same full path contract',()=>{
 const start=source.indexOf('function normalizeDesktopAction('),end=source.indexOf('\nfunction ',start+20);
 const normalize=runInNewContext(source.slice(start,end)+';normalizeDesktopAction',{computerDragArguments,Buffer});
 assert.deepEqual(Array.from(normalize({action:'drag',path:retained[0]})),computerDragArguments({path:retained[0]}));
 assert.throws(()=>normalize({action:'drag'}),/drag/i);
});
test('actual production PowerShell branch dispatches full path and retains legacy endpoints',{skip:process.platform!=='win32'},()=>{
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../../../packages/operator-assistant-ui/computer_drag.test.ps1',import.meta.url)),'-DesktopScript',fileURLToPath(new URL('../scripts/desktop.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS 38 drag .*fake input only/);
});
