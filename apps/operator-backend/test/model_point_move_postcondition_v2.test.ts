import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { modelPointMoveReadbackMatchesV2 } from '../src/verification/model_point_move_postcondition_v2.js';
const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/model-point-move-readback-59.json','utf8'));

test('exact retained native model move matches the separate point/circuit-summary read, not the commit verified flag',()=>{
 const f=fixture();assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,f.actual_read),true);
 for(const [name,change] of [
  ['wrong position',(n:any)=>n.actual_read.items[0].location.y+=.01],
  ['wrong height',(n:any)=>n.actual_read.items[0].location.z+=.01],
  ['wrong rotation',(n:any)=>n.actual_read.items[0].location.rotationRadians+=.01],
  ['missing moved target',(n:any)=>{n.actual_read.items.shift();n.actual_read.requestedElementIds.shift();}],
  ['duplicate read target',(n:any)=>n.actual_read.items[1]=structuredClone(n.actual_read.items[0])],
  ['missing native identity',(n:any)=>delete n.actual_read.items[0].uniqueId],
  ['not found',(n:any)=>n.actual_read.items[0].found=false],
  ['incomplete',(n:any)=>n.actual_read.complete=false],
  ['wrong requested identity',(n:any)=>n.actual_read.requestedElementIds[0]++],
  ['nonfinite',(n:any)=>n.actual_read.items[0].location.x=NaN],
  ['sheet anchor',(n:any)=>n.native_apply.snapshots[0].before.kind='ScheduleInsertion'],
  ['curve',(n:any)=>n.actual_read.items[0].location.type='curve'],
  ['wrong before kind',(n:any)=>n.native_apply.snapshots[0].before.kind='Unknown'],
  ['echoed wrong after',(n:any)=>n.native_apply.snapshots[0].after.pointXyz[1]+=.1],
  ['rotated commit',(n:any)=>n.native_apply.snapshots[0].after.rotationRadians+=.1],
  ['missing snapshot',(n:any)=>n.native_apply.snapshots=[]],
  ['added collateral',(n:any)=>n.native_apply.transaction.added_element_ids=[99]],
  ['deleted collateral',(n:any)=>n.native_apply.transaction.deleted_element_ids=[99]],
  ['missing native modified',(n:any)=>n.native_apply.transaction.modified_element_ids=[]],
  ['uncommitted',(n:any)=>n.native_apply.transaction.status='pending'],
  ['preview',(n:any)=>n.input.body.dryRun=true],
  ['wrong vector',(n:any)=>n.input.body.vectorY=1],
  ['no movement',(n:any)=>n.input.body.vectorY=0],
  ['request echo',(n:any)=>n.actual_read={request:n.actual_read}],
  ['verified flag only',(n:any)=>n.actual_read={verified:true,success:true}],
 ] as Array<[string,(n:any)=>void]>){const n=fixture();change(n);assert.equal(modelPointMoveReadbackMatchesV2(n.input,n.native_apply,n.actual_read),false,name);}
});

test('synthetic neighbors require every point in a batch and support horizontal/vertical translations with wrapped native reads',()=>{
 const f=fixture(),s=f.native_apply.snapshots[0],read=f.actual_read.items[0];
 f.input.body.ids.push(999);f.native_apply.movedIds.push(999);f.native_apply.transaction.modified_element_ids.push(999);
 const second=structuredClone(s);second.id=999;f.native_apply.snapshots.push(second);
 Object.assign(f.input.body,{vectorX:.25,vectorY:0,vectorZ:1.5});
 const items=[structuredClone(read),structuredClone(read)];items[1].id=999;items[1].uniqueId='synthetic-neighbor:999';
 for(let i=0;i<2;i++){const before=f.native_apply.snapshots[i].before.pointXyz;f.native_apply.snapshots[i].after.pointXyz=[before[0]+.25,before[1],before[2]+1.5];
  Object.assign(items[i].location,{x:before[0]+.25,y:before[1],z:before[2]+1.5});}
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,items),true);
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,{result:items}),true);
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,items.slice(0,1)),false);
 f.native_apply.snapshots[1]=structuredClone(f.native_apply.snapshots[0]);assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.native_apply,items),false);
});
