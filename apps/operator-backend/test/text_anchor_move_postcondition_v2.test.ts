import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {modelPointMoveReadbackMatchesV2} from '../src/verification/model_point_move_postcondition_v2.js';
export const textAnchorFixture=()=>JSON.parse(fs.readFileSync('test/fixtures/text-anchor-move-readback-original53.json','utf8'));

test('retained TextAnchor move requires a separate typed summary and stable native note/view identity',()=>{
 const f=textAnchorFixture();
 for(const read of f.actual_formal_reads)assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.actual_native_apply,read),false,'historical payloads are not backfilled');
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.future_native_apply,f.future_native_read),true);
 for(const [name,change] of [
  ['wrong coordinate',(n:any)=>n.future_native_read.result[0].location.x+=.01],
  ['wrong owner',(n:any)=>n.future_native_read.result[0].location.ownerViewId++],
  ['wrong owner UID',(n:any)=>n.future_native_read.result[0].location.ownerViewUniqueId='other'],
  ['wrong note UID',(n:any)=>n.future_native_read.result[0].uniqueId='other'],
  ['wrong class',(n:any)=>n.future_native_read.result[0].className='IndependentTag'],
  ['model point coercion',(n:any)=>n.future_native_read.result[0].location.type='point'],
  ['bbox coercion',(n:any)=>n.future_native_read.result[0].location.type='bboxCenter'],
  ['missing space',(n:any)=>delete n.future_native_read.result[0].location.coordinateSpace],
  ['wrong units',(n:any)=>n.future_native_read.result[0].location.coordinateSpace='paper_inches'],
  ['nonfinite',(n:any)=>n.future_native_read.result[0].location.x=Infinity],
  ['changed identity during move',(n:any)=>n.future_native_apply.snapshots[0].after.elementUniqueId='other'],
  ['missing before identity',(n:any)=>delete n.future_native_apply.snapshots[0].before.elementUniqueId],
  ['changed owner during move',(n:any)=>n.future_native_apply.snapshots[0].after.ownerViewId++],
  ['missing apply space',(n:any)=>delete n.future_native_apply.snapshots[0].before.coordinateSpace],
  ['wrong delta',(n:any)=>n.input.body.vectorX=1],
  ['modified collateral',(n:any)=>n.future_native_apply.transaction.modified_element_ids.push(1422218)],
  ['added collateral',(n:any)=>n.future_native_apply.transaction.added_element_ids.push(99)],
  ['deleted collateral',(n:any)=>n.future_native_apply.transaction.deleted_element_ids.push(99)],
  ['preview',(n:any)=>n.input.body.dryRun=true],
  ['uncommitted',(n:any)=>n.future_native_apply.transaction.committed=false],
  ['missing target',(n:any)=>n.future_native_read.result=[]],
  ['duplicate target',(n:any)=>n.future_native_read.result.push(n.future_native_read.result[0])],
  ['truncated',(n:any)=>n.future_native_read.truncated=true],
 ] as Array<[string,(n:any)=>void]>){const n=textAnchorFixture();change(n);assert.equal(modelPointMoveReadbackMatchesV2(n.input,n.future_native_apply,n.future_native_read),false,name);}
});

test('batch text anchors retain each note and owner rather than swapping equal coordinates',()=>{
 const f=textAnchorFixture(),s=structuredClone(f.future_native_apply.snapshots[0]),r=structuredClone(f.future_native_read.result[0]);
 s.id=999;for(const p of [s.before,s.after])Object.assign(p,{elementUniqueId:'second',ownerViewId:100,ownerViewUniqueId:'second-view'});
 r.id=999;r.uniqueId='second';Object.assign(r.location,{ownerViewId:100,ownerViewUniqueId:'second-view'});
 f.input.body.ids.push(999);f.future_native_apply.movedIds.push(999);f.future_native_apply.transaction.modified_element_ids.push(999);f.future_native_apply.snapshots.push(s);f.future_native_read.result.push(r);
 assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.future_native_apply,f.future_native_read),true);
 r.uniqueId=f.future_native_read.result[0].uniqueId;assert.equal(modelPointMoveReadbackMatchesV2(f.input,f.future_native_apply,f.future_native_read),false);
});
