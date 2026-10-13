import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {checkCategoryGraphicsScopeV1} from '../src/verification/category_graphics_scope_v1.js';
import {validCategoryGraphicsScopeV1,validWorkPlanScopeV1,type CategoryGraphicsScopeV1} from '../src/domain/assignment-kernel/work_plan_scope.js';
import {checkWorkPlanScopeV1,selectWorkPlanScopeReadIdsV1} from '../src/assignments/work_plan_scope_check.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
import type {ScopeNativeReadV1} from '../src/verification/tag_scope_readback_v1.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
function fixture(){
  const scope={kind:'category_graphics_v1',category:'Plumbing Fixtures',disciplines:['Electrical'],view_types:['FloorPlan','Elevation','ThreeD'],halftone:true,hidden_policy:'exclude_hidden'} satisfies CategoryGraphicsScopeV1;
  const views=[{id:1,name:'Power',type:'FloorPlan',discipline:'Electrical',isTemplate:false},
    {id:2,name:'Enlarged',type:'FloorPlan',discipline:'Electrical',isTemplate:false},
    {id:3,name:'East',type:'Elevation',discipline:'Electrical',isTemplate:false},
    {id:4,name:'Cover',type:'ThreeD',discipline:'Electrical',isTemplate:false},
    {id:10,name:'Power template',type:'FloorPlan',discipline:'Electrical',isTemplate:true}];
  const reads:ScopeNativeReadV1[]=[{operation_id:'inventory',input:{method:'POST',path:'/revit/views',body:{action:'list',includeTemplates:true,disciplines:['Electrical'],limit:500}},payload:{status:'ok',action:'list',offset:0,count:5,returned:5,truncated:false,appliedFilters:['disciplines_exact'],views}}];
  for(const listed of views.filter(v=>!v.isTemplate)){
    const cat={categoryId:-2001160,categoryName:'Plumbing Fixtures',builtInCategory:'OST_PlumbingFixtures',hidden:listed.id===3,halftone:listed.id!==1};
    const view={id:listed.id,name:listed.name,viewType:listed.type,discipline:listed.discipline,isTemplate:false,
      viewTemplateId:listed.id===1?10:-1,viewTemplate:listed.id===1?'Power template':null,templateControlsModelGraphics:listed.id===1,
      categoryOverride:cat,categorySnapshot:{complete:true,targetCategoryId:cat.categoryId,target:{id:cat.categoryId,name:cat.categoryName,hidden:cat.hidden,graphics:{halftone:cat.halftone}}},
      templateCategoryOverride:listed.id===1?{...cat,halftone:true}:null};
    reads.push({operation_id:'read-'+listed.id,input:{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:listed.id,categoryName:scope.category,includeCategoryState:true}},payload:{status:'Ok',action:'get',dryRun:false,view}});
  }
  return {scope,reads};
}
test('whole declared model-view domain joins native template state and excludes hidden views explicitly',()=>{
  const f=fixture(),before=JSON.stringify(f),r=checkCategoryGraphicsScopeV1(f.scope,f.reads);
  assert(r.declared_scope_satisfied);assert.equal(r.candidate_count,4);assert.equal(r.matched_count,3);assert.equal(r.excluded_count,1);
  assert.deepEqual(r.excluded_target_ids,[3]);assert.equal(r.view_proofs[0]!.controlling_view_id,10);assert.equal(JSON.stringify(f),before);
  assert.match(r.notice,/Hidden views are excluded, not certified unchanged/);assert.match(r.notice,/Effective linked/);
});
test('wrong persisted controlling value produces a failed target instead of an unavailable read or pass',()=>{
  const f=fixture();f.reads[1]!.payload.view.templateCategoryOverride.halftone=false;
  const r=checkCategoryGraphicsScopeV1(f.scope,f.reads);assert(!r.declared_scope_satisfied);assert.deepEqual(r.failed_target_ids,[1]);
});
test('built-in selector and unfiltered whole-document view census are both supported',()=>{
  const f=fixture();f.scope.category='OST_PlumbingFixtures';delete f.reads[0]!.input.body.disciplines;f.reads[0]!.payload.appliedFilters=[];
  for(const r of f.reads.slice(1))r.input.body.categoryName=f.scope.category;
  assert(checkCategoryGraphicsScopeV1(f.scope,f.reads).declared_scope_satisfied);
});
for(const [name,change] of [
  ['truncated inventory',(f:any)=>f.reads[0].payload.truncated=true],
  ['omitted count',(f:any)=>delete f.reads[0].payload.returned],
  ['missing native view',(f:any)=>f.reads[0].payload.views.pop()],
  ['duplicate identity',(f:any)=>f.reads[0].payload.views[1].id=1],
  ['actor filtered IDs',(f:any)=>f.reads[0].input.body.viewIds=[1]],
  ['actor filtered types',(f:any)=>f.reads[0].input.body.viewTypes=['FloorPlan']],
  ['name filter',(f:any)=>f.reads[0].input.body.nameContains='Power'],
  ['mismatched native filter',(f:any)=>f.reads[0].payload.appliedFilters=[]],
  ['incomplete template census',(f:any)=>f.reads[0].input.body.includeTemplates=false],
  ['missing extra model-view read',(f:any)=>f.reads.pop()],
  ['incomplete category snapshot',(f:any)=>f.reads[1].payload.view.categorySnapshot.complete=false],
  ['wrong category identity',(f:any)=>f.reads[1].payload.view.categoryOverride.categoryId=-2001320],
  ['wrong native category name',(f:any)=>f.reads[1].payload.view.categoryOverride.categoryName='Pipes'],
  ['echoed read ID',(f:any)=>f.reads[1].payload.view.id=100],
  ['unknown template control',(f:any)=>f.reads[1].payload.view.templateControlsModelGraphics=null],
  ['template identity mismatch',(f:any)=>f.reads[1].payload.view.viewTemplate='Other'],
  ['missing template category',(f:any)=>f.reads[1].payload.view.templateCategoryOverride=null],
  ['wrong template category',(f:any)=>f.reads[1].payload.view.templateCategoryOverride.builtInCategory='OST_PipeCurves'],
  ['unknown hidden',(f:any)=>f.reads[2].payload.view.categoryOverride.hidden=null],
  ['coerced half',(f:any)=>f.reads[2].payload.view.categoryOverride.halftone='true'],
  ['preview',(f:any)=>f.reads[2].payload.dryRun=true],
  ['conflicting duplicate read',(f:any)=>{const r=structuredClone(f.reads[2]);r.operation_id='duplicate';r.payload.view.categoryOverride.halftone=false;r.payload.view.categorySnapshot.target.graphics.halftone=false;f.reads.push(r);}],
  ['worker pass flag',(f:any)=>f.scope.pass=true],
  ['explicit IDs narrowing',(f:any)=>f.scope.view_ids=[1]],
] as const)test('reject '+name,()=>{const f=fixture();change(f);assert.throws(()=>checkCategoryGraphicsScopeV1(f.scope,f.reads),/category_graphics_scope_/);});
test('scope validators retain legacy tags, reject unsupported/unbounded categories and never accept completion claims',()=>{
  const s=fixture().scope;assert(validWorkPlanScopeV1(s));assert(validWorkPlanScopeV1({category:'OST_ElectricalEquipmentTags',view_ids:[1],has_leader:false}));
  for(const x of [{...s,category:'OST_bad thing'},{...s,category:'bad\u0000name'},{...s,disciplines:['Electrical','Electrical']},{...s,view_types:['DrawingSheet']},{...s,hidden_policy:'verified_unchanged'},{...s,verified:true}])assert(!validCategoryGraphicsScopeV1(x));
});
test('integral checker reads authenticated immutable native bytes and invalidates after SaveAs or uncertain edits',()=>{
  const old=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-category-scope-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
  try{
    const f=fixture(),binding={assignment_id:'assignment',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'doc'};
    const s:any={current_binding:binding,operations:{},observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],work_plan_claims:[{item_id:'typical',verified:false}]};
    for(const r of f.reads){
      const stored=storeEvidence({scope:{...binding,attempt_id:r.operation_id},source:'native-category-read',trust_level:'authoritative_native',raw:r.payload}),hash=payloadDigestV2(r.payload).digest,oid='obs-'+r.operation_id;
      s.operations[r.operation_id]={binding,input:r.input,operation_id:r.operation_id,requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'settled',opened_at:'2026-10-13T15:00:00Z',observation_ids:[oid],result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',completed_at:'2026-10-13T15:00:01Z',raw_payload_hash:hash}};
      s.observations[oid]={binding,operation_id:r.operation_id,authority:'native-host',raw_payload_hash:hash,raw_payload_ref:'evidence:'+stored.ref.evidence_id};
    }
    const req={item_id:'typical',scope:f.scope,operation_ids:f.reads.map(r=>r.operation_id),requested_at:'2026-10-13T15:01:00Z'},before=JSON.stringify(s);
    assert.deepEqual(selectWorkPlanScopeReadIdsV1(s,f.scope),req.operation_ids);
    const result=checkWorkPlanScopeV1(s,req);assert(result.available,JSON.stringify(result));assert(result.declared_scope_satisfied);assert.equal(JSON.stringify(s),before);assert.equal(s.work_plan_claims[0].verified,false);
    const newer=structuredClone(s.operations['read-4']);newer.operation_id='newer-failed';newer.opened_at='2026-10-13T15:00:02Z';newer.result.status='failed_after_dispatch';
    const newerSnapshot={...s,operations:{...s.operations,[newer.operation_id]:newer}};
    const selected=selectWorkPlanScopeReadIdsV1(newerSnapshot,f.scope);assert(selected.includes('newer-failed'));assert(!selected.includes('read-4'));
    assert(!checkWorkPlanScopeV1(newerSnapshot,{...req,operation_ids:selected}).available,'newer failed evidence cannot be skipped for an older favorable read');
    const savedSnapshot=structuredClone(s);savedSnapshot.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-13T15:00:02Z'};
    assert.deepEqual(selectWorkPlanScopeReadIdsV1(savedSnapshot,f.scope),[]);
    const unavailable=checkWorkPlanScopeV1(savedSnapshot,{...req,operation_ids:[]});assert(!unavailable.available);assert.match(unavailable.reason!,/no_current_native_reads/);
    for(const change of [(x:any)=>x.unresolved_unknown_operation_ids=['unknown'],(x:any)=>x.in_flight_operation_ids=['edit'],
      (x:any)=>x.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-13T15:00:02Z'},
      (x:any)=>x.operations.inventory.binding={...binding,generation:2},(x:any)=>x.observations['obs-inventory'].raw_payload_hash='tampered',
      (x:any)=>x.operations.inventory.result.authority='assistant',(x:any)=>x.operations.inventory.result.completed_at='2026-10-13T15:02:00Z',
      (x:any)=>x.input_invalidated_operation_ids=['read-4']]){
      const copy=structuredClone(s);change(copy);assert(!checkWorkPlanScopeV1(copy,req).available);
    }
  }finally{__closeForTests();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});

test('automatic references retain the latest complete-domain census even when its bytes are truncated',()=>{
 const f=fixture(),binding:any={assignment_id:'a',run_id:'r',generation:1,session_id:'s',principal_id:'p',document_fingerprint:'d'};
 const s:any={current_binding:binding,operations:Object.fromEntries(f.reads.map((r,i)=>[r.operation_id,{operation_id:r.operation_id,binding,input:r.input,requested_effect:'read',opened_at:new Date(Date.UTC(2026,9,13,15,0,i)).toISOString()}]))};
 const later={...s.operations.inventory,operation_id:'later-inventory',opened_at:'2026-10-13T15:00:59Z',result:{status:'succeeded'},payload:{truncated:true}};
 s.operations[later.operation_id]=later;
 const ids=selectWorkPlanScopeReadIdsV1(s,f.scope);assert(ids.includes('later-inventory'));assert(!ids.includes('inventory'));
 const foreign={...s.operations['read-4'],binding:{...binding,generation:2},operation_id:'foreign'};s.operations.foreign=foreign;
 assert(!selectWorkPlanScopeReadIdsV1(s,f.scope).includes('foreign'));
});

test('automatic reference selection refuses excessive scope instead of silently dropping candidates',()=>{
 const f=fixture(),binding:any={assignment_id:'a',run_id:'r',generation:1,session_id:'s',principal_id:'p',document_fingerprint:'d'};
 const s:any={current_binding:binding,operations:{}};
 for(let i=1;i<=129;i++)s.operations['read-'+i]={operation_id:'read-'+i,binding,requested_effect:'read',opened_at:'2026-10-13T15:00:00Z',
  input:{method:'POST',path:'/revit/visibility',body:{action:'get',viewId:i,categoryName:f.scope.category,includeCategoryState:true}}};
 assert.throws(()=>selectWorkPlanScopeReadIdsV1(s,f.scope),/scope_check_read_reference_limit/);
 s.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'invalid-time'};
 assert.throws(()=>selectWorkPlanScopeReadIdsV1(s,f.scope),/scope_check_edit_time_invalid/);
});
