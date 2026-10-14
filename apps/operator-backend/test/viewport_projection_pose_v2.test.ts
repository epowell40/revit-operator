import test from 'node:test';import assert from 'node:assert/strict';
import {sheetMoveReadbacksMatchV2} from '../src/verification/sheet_move_postcondition_v2.js';
import {viewportProjectionFixture} from './fixtures/viewport_projection_pose_fixture.js';

for(const kind of ['single','multi'] as const)test(`${kind} sheet translation compares native placement frame separately from evaluated drawing bounds`,()=>{
 const f=viewportProjectionFixture(kind);assert(sheetMoveReadbacksMatchV2(f.input,f.native_apply,f.actual_sheets));
 const rendered=structuredClone(f);rendered.actual_sheets[0].viewportGeometry[0].center.v+=.0480789896344884;
 assert(sheetMoveReadbacksMatchV2(rendered.input,rendered.native_apply,rendered.actual_sheets),'drawing envelope change is not a placement-translation claim or layout-quality pass');
 for(const [label,change] of [
  ['missing pose',(n:any)=>delete n.actual_sheets[0].viewportGeometry[0].placementAnchor],
  ['wrong origin',(n:any)=>n.actual_sheets[0].viewportGeometry[0].placementAnchor.pointXyz[1]+=.0480789896344884],
  ['wrong frame',(n:any)=>n.actual_sheets[0].viewportGeometry[0].placementAnchor.basisXXyz[1]=.01],
  ['changed scale during edit',(n:any)=>n.native_apply.snapshots[0].after.basisYXyz[1]=2],
  ['unknown axis',(n:any)=>delete n.native_apply.snapshots[0].before.basisZXyz],
  ['nonfinite axis',(n:any)=>n.actual_sheets[0].viewportGeometry[0].placementAnchor.basisZXyz[0]=NaN],
  ['foreign owner',(n:any)=>n.actual_sheets[0].viewportGeometry[0].placementAnchor.ownerViewId++],
  ['box center masquerading as placement',(n:any)=>n.actual_sheets[0].viewportGeometry[0].placementAnchor.kind='ViewportBoxCenter'],
 ] as Array<[string,(n:any)=>void]>){const n=structuredClone(f);change(n);assert.equal(sheetMoveReadbacksMatchV2(n.input,n.native_apply,n.actual_sheets),false,label);}
});
