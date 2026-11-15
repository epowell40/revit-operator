import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {runInNewContext} from 'node:vm';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
for(const direction of ['in','out'])
test(`actual Sidecar zoom adapter preserves signed ${direction} wheel calls and desktop origin`,async()=>{
 const a=source.indexOf('async function revitZoomView(options = {}) {'),z=source.indexOf('async function revitZoomToFit(',a);assert(a>0&&z>a);
 const calls=[];const zoom=runInNewContext(source.slice(a,z)+';revitZoomView',{
  resolveRelativePoint:(x,y)=>({x,y}),toAbsoluteDesktopPoint:(x,y)=>({x:x-1920,y:y+20}),
  clampInteger:(v,f,lo,hi)=>Math.min(hi,Math.max(lo,Math.round(Number(v??f)))),
  addComputerEvent(){},formatRelativeToDesktopPoint:()=>'',runDesktopScript:async args=>calls.push([...args]),waitMs:async()=>{}
 });
 const result=await zoom({anchor_x:600,anchor_y:380,direction,steps:2});
 assert.equal(result.ok,true);assert.equal(calls.length,2);
 for(const args of calls)assert.deepEqual(args,['-Action','scroll','-X','-1320','-Y','400','-ScrollY',direction==='in'?'120':'-120']);
});
