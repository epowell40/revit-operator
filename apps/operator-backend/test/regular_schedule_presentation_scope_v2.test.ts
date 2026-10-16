import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { regularSchedulePresentationScopeMatchesV2, regularSchedulePresentationInventoryMatchesV2 } from '../src/verification/regular_schedule_presentation_scope_v2.js';
import { regularSchedulePresentationReadbackMatchesV2 } from '../src/verification/regular_schedule_presentation_v2.js';

function fixture() {
  const old = {schema:'operator.regular_schedule_presentation_scope.v1',complete:true,coverage:'configuration_cell_text_style_geometry_v1',targetId:41,targetUniqueId:'view:41',
    totalUnrequestedCells:400,unrequestedSchedules:[{scheduleId:42,uniqueId:'view:42',semanticHash:'a'.repeat(64)}],dependencies:[] as any[]};
  const after=structuredClone(old);after.dependencies.push({id:900,uniqueId:'generated:900',className:'Autodesk.Revit.DB.Element',ownerViewId:-1});
  const apply={transaction:{added_element_ids:[900],modified_element_ids:[41,42],deleted_element_ids:[] as number[]},presentationScopeBefore:old,presentationScopeAfter:after};
  return {apply,read:{scope:structuredClone(after)}};
}

test('reported dependent regeneration needs unchanged old schedule evidence and a fresh native logical dependency',()=>{
  const f=fixture();assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),true);
  assert.equal(regularSchedulePresentationInventoryMatchesV2(f.apply,['element_id:41','element_id:42','element_id:900']),true);
  assert.equal(regularSchedulePresentationInventoryMatchesV2(f.apply,['element_id:41','element_id:42']),false);
  assert.equal(regularSchedulePresentationInventoryMatchesV2(f.apply,['element_id:41','element_id:900','element_id:900']),false);
});

test('incomplete, changed, foreign or unexplained scope cannot verify the title/order edit',()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>f.apply.presentationScopeBefore.complete=false,f=>f.apply.presentationScopeAfter.complete=false,f=>f.read.scope.complete=false,
    f=>f.read.scope.targetId=99,f=>f.read.scope.targetUniqueId='foreign',f=>f.read.scope.coverage='names_only',
    f=>f.apply.presentationScopeAfter.unrequestedSchedules[0]!.semanticHash='b'.repeat(64),
    f=>f.read.scope.unrequestedSchedules[0]!.semanticHash='b'.repeat(64),f=>f.read.scope.unrequestedSchedules[0]!.uniqueId='foreign',
    f=>{f.apply.presentationScopeBefore.unrequestedSchedules=[];},f=>{f.read.scope.unrequestedSchedules=[];},
    f=>f.read.scope.unrequestedSchedules.push(structuredClone(f.read.scope.unrequestedSchedules[0]!)),
    f=>{f.apply.presentationScopeAfter.dependencies=[];},f=>{f.read.scope.dependencies=[];},
    f=>f.read.scope.dependencies[0]!.uniqueId='foreign',f=>f.read.scope.dependencies[0]!.ownerViewId=99,
    f=>f.read.scope.dependencies[0]!.className='Autodesk.Revit.DB.FamilyInstance',
    f=>{f.apply.presentationScopeAfter.dependencies[0]!.className=f.read.scope.dependencies[0]!.className='Autodesk.Revit.DB.FamilyInstance';},
    f=>f.apply.presentationScopeBefore.dependencies.push(structuredClone(f.read.scope.dependencies[0]!)),
    f=>f.apply.transaction.added_element_ids.push(901),f=>f.apply.transaction.modified_element_ids.push(43),
    f=>f.apply.transaction.deleted_element_ids.push(99),f=>f.read.scope.totalUnrequestedCells++,
    f=>{(f.read.scope.dependencies[0] as any)={id:900,name:'AIR DEVICE SCHEDULE'};},
  ];
  for(const change of mutations){const f=fixture();change(f);assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),false);}
});

test('existing generated children need the same native identity before, after and at the separate read',()=>{
  const f=fixture();f.apply.transaction.added_element_ids=[];f.apply.transaction.modified_element_ids.push(900);
  f.apply.presentationScopeBefore.dependencies.push(structuredClone(f.read.scope.dependencies[0]!));
  assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),true);
  f.apply.presentationScopeBefore.dependencies[0]!.uniqueId='old';assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),false);
});

test('the retained116 wider native inventory stays unverified without its missing native before/after proof',()=>{
  const f=JSON.parse(fs.readFileSync('test/fixtures/regular-schedule-wide-native-inventory.json','utf8'));
  const a=f.applied;
  const fresh={status:'Ok',action:'presentation',read_only:true,schedule:{...a.schedule,kind:'schedule'},presentation:a.presentationReadback};
  assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,a,fresh),false);
  assert.equal(regularSchedulePresentationScopeMatchesV2(a.schedule.id,a.schedule.uniqueId,a,fresh),false);
});


test('actual native GetDependentElements self entry is identity only, never a generated child',()=>{
  const native=JSON.parse(fs.readFileSync('test/fixtures/regular-schedule-native-self-dependency.json','utf8')).native_read;
  const target=native.schedule, old=native.scope.unrequestedSchedules[0].scheduleId;
  const apply={transaction:{added_element_ids:[],deleted_element_ids:[],modified_element_ids:[target.id,old]},presentationScopeBefore:structuredClone(native.scope),presentationScopeAfter:structuredClone(native.scope)};
  assert.equal(regularSchedulePresentationScopeMatchesV2(target.id,target.uniqueId,apply,native),true);
  for(const field of ['uniqueId','className'] as const){
    for(const where of ['before','after','fresh']){
      const a=structuredClone(apply),r=structuredClone(native);
      const scope=where==='before'?a.presentationScopeBefore:where==='after'?a.presentationScopeAfter:r.scope;
      scope.dependencies.find((d:any)=>d.id===target.id)[field]='foreign';
      assert.equal(regularSchedulePresentationScopeMatchesV2(target.id,target.uniqueId,a,r),false);
    }
  }
  for(const where of ['before','after','fresh']){
    const a=structuredClone(apply),r=structuredClone(native);
    const scope=where==='before'?a.presentationScopeBefore:where==='after'?a.presentationScopeAfter:r.scope;
    scope.dependencies.push(structuredClone(scope.dependencies.find((d:any)=>d.id===target.id)));
    assert.equal(regularSchedulePresentationScopeMatchesV2(target.id,target.uniqueId,a,r),false);
  }
  const forged=structuredClone(apply);forged.transaction.added_element_ids.push(target.id);
  assert.equal(regularSchedulePresentationScopeMatchesV2(target.id,target.uniqueId,forged,native),false);
  const missing=structuredClone(apply);missing.transaction.modified_element_ids.push(999999);
  assert.equal(regularSchedulePresentationScopeMatchesV2(target.id,target.uniqueId,missing,native),false);
});

test('self entries do not relax preserved schedules or generated dependency checks',()=>{
  const f=fixture(),self={id:41,uniqueId:'view:41',className:'Autodesk.Revit.DB.ViewSchedule',ownerViewId:-1};
  for(const s of [f.apply.presentationScopeBefore,f.apply.presentationScopeAfter,f.read.scope])s.dependencies.unshift({...self});
  assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),true);
  f.read.scope.dependencies.find(d=>d.id===900)!.className='Autodesk.Revit.DB.TextNote';
  assert.equal(regularSchedulePresentationScopeMatchesV2(41,'view:41',f.apply,f.read),false);
});
