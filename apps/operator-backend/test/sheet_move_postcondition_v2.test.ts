import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { sheetMoveReadbackMatchesV2,sheetMoveReadbacksMatchV2 } from '../src/verification/sheet_move_postcondition_v2.js';
import {sheetMove79Fixture} from './fixtures/sheet_move_79_fixture.js';
import {panelMoveFixtureV2,selectedPanelV2} from './fixtures/panel_schedule_move_fixture.js';
const fixture=()=>JSON.parse(fs.readFileSync('test/fixtures/sheet-move-readback-05.json','utf8'));

for(const kind of ['single','multi'] as const)test(`retained79 ${kind} requires complete native XYZ and every owner sheet`,()=>{
 const retained=sheetMove79Fixture(kind);assert.equal(sheetMoveReadbacksMatchV2(retained.input,retained.native_apply,retained.actual_sheets),false,'old UV-only payload does not acquire retrospective proof');
 const f=sheetMove79Fixture(kind,true);assert.equal(sheetMoveReadbacksMatchV2(f.input,f.native_apply,f.actual_sheets),true);
 for(const [name,mutate] of [
  ['wrongZ',(n:any)=>n.actual_sheets[0].viewportGeometry[0].center.z+=.001],
  ['missingZ',(n:any)=>delete n.actual_sheets[0].viewportGeometry[0].center.z],
  ['nullZ',(n:any)=>n.actual_sheets[0].viewportGeometry[0].center.z=null],
  ['foreignOwner',(n:any)=>{n.actual_sheets[0].sheetId++;n.actual_sheets[0].sheetElementId++;}],
  ['duplicateSheet',(n:any)=>n.actual_sheets.push(structuredClone(n.actual_sheets[0]))],
  ['missingOwnerRead',(n:any)=>n.actual_sheets.pop()],
  ['changedFinalExtent',(n:any)=>n.actual_sheets[0].viewportGeometry[0].center.v+=.0480789896344884],
  ['missingAnchor',(n:any)=>{n.actual_sheets[0].viewportGeometry=[];n.actual_sheets[0].viewportCount=0;}],
  ['falseCommit',(n:any)=>n.native_apply.transaction.committed=false],
 ] as Array<[string,(n:any)=>void]>){const n=structuredClone(f);mutate(n);assert.equal(sheetMoveReadbacksMatchV2(n.input,n.native_apply,n.actual_sheets),false,name);}
 if(kind==='multi')for(const p of f.actual_sheets)assert.equal(sheetMoveReadbackMatchesV2(f.input,f.native_apply,p),false,'one matching sheet is incomplete batch proof');
});

test('retained native three-viewports plus schedule move needs separate exact anchor readback',()=>{
 const f=fixture();assert.equal(sheetMoveReadbackMatchesV2(f.input,f.native_apply,f.actual_sheet),true);
 for(const [name,change] of [
  ['wrong viewport',(n:any)=>n.actual_sheet.viewportGeometry[1].center.v+=.01],
  ['wrong schedule',(n:any)=>n.actual_sheet.placedSchedules[0].point.v+=.01],
  ['foreign sheet',(n:any)=>{n.actual_sheet.sheetId++;n.actual_sheet.sheetElementId++;}],
  ['missing schedule',(n:any)=>n.actual_sheet.placedSchedules=[]],
  ['duplicate anchor',(n:any)=>n.actual_sheet.viewportGeometry.push(n.actual_sheet.viewportGeometry[0])],
  ['unknown before anchor',(n:any)=>n.native_apply.snapshots[0].before.kind='Unknown'],
  ['missing snapshot',(n:any)=>n.native_apply.snapshots.pop()],
  ['repeated snapshot',(n:any)=>n.native_apply.snapshots[1]=n.native_apply.snapshots[0]],
  ['bad apply delta',(n:any)=>n.native_apply.snapshots[0].after.pointXyz[1]+=.1],
  ['truncated',(n:any)=>n.actual_sheet.truncated=true],
  ['nonfinite',(n:any)=>n.actual_sheet.placedSchedules[0].point.u=NaN],
  ['created collateral',(n:any)=>n.native_apply.transaction.added_element_ids=[99]],
  ['uncommitted',(n:any)=>n.native_apply.transaction.status='pending'],
  ['readback failure',(n:any)=>n.native_apply.success=false],
  ['preview',(n:any)=>n.input.body.dryRun=true],
  ['wrong vector',(n:any)=>n.input.body.vectorY=-1],
  ['request echo',(n:any)=>n.actual_sheet={request:n.actual_sheet}],
  ['verified flag only',(n:any)=>n.actual_sheet={verified:true,success:true}]
 ] as Array<[string,(n:any)=>void]>){const n=fixture();change(n);assert.equal(sheetMoveReadbackMatchesV2(n.input,n.native_apply,n.actual_sheet),false,name);}
});

test('sheet anchor comparison handles upward and horizontal vectors and a separate schedule-only batch',()=>{
 const f=fixture();f.input.body.ids=[1391409];f.native_apply.movedIds=[1391409];
 f.native_apply.snapshots=f.native_apply.snapshots.filter((x:any)=>x.id===1391409);
 Object.assign(f.input.body,{vectorX:.25,vectorY:.5});
 const v=f.native_apply.snapshots[0];v.after.pointXyz=[v.before.pointXyz[0]+.25,v.before.pointXyz[1]+.5,0];
 Object.assign(f.actual_sheet.placedSchedules[0].point,{u:v.after.pointXyz[0],v:v.after.pointXyz[1]});
 assert.equal(sheetMoveReadbackMatchesV2(f.input,f.native_apply,f.actual_sheet),true);
});

test('retained nine-panel movement uses panel Origin rather than ordinary schedule Point',()=>{
 assert.equal(sheetMoveReadbackMatchesV2(panelMoveFixtureV2(false).input,panelMoveFixtureV2(false).native_apply,panelMoveFixtureV2(false).actual_sheet),false,'retained old receipt lacks native sheet ownership');
 const f=panelMoveFixtureV2();
 assert.equal(sheetMoveReadbackMatchesV2(f.input,f.native_apply,f.actual_sheet),true);
 for(const [name,mutate] of [
  ['wrong panel origin',(n:any)=>selectedPanelV2(n).point.v+=.02],
  ['panel disguised as ordinary schedule',(n:any)=>selectedPanelV2(n).placementType='ScheduleSheetInstance'],
  ['unknown placement class',(n:any)=>n.actual_sheet.placedSchedules[0].placementType='Unknown'],
  ['missing panel',(n:any)=>{n.actual_sheet.placedSchedules.pop();n.actual_sheet.placedScheduleCount--;}],
  ['wrong owning sheet',(n:any)=>{n.actual_sheet.sheetId++;n.actual_sheet.sheetElementId++;}],
  ['owner removed',(n:any)=>{delete n.native_apply.snapshots[0].before.ownerViewId;delete n.native_apply.snapshots[0].after.ownerViewId;}],
  ['wrong native anchor',(n:any)=>n.native_apply.snapshots[0].before.kind='ScheduleInsertion'],
  ['after echo',(n:any)=>n.native_apply.snapshots[0].after.pointXyz[0]+=.02],
  ['duplicate panel',(n:any)=>{n.actual_sheet.placedSchedules[1]=structuredClone(n.actual_sheet.placedSchedules[0]);}],
  ['pending commit',(n:any)=>n.native_apply.transaction.status='pending'],
 ] as Array<[string,(n:any)=>void]>){const n=structuredClone(f);mutate(n);assert.equal(sheetMoveReadbackMatchesV2(n.input,n.native_apply,n.actual_sheet),false,name);}
});
