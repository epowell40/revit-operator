import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {checkCategoryVisibilityScopeV1} from '../src/verification/category_visibility_scope_v1.js';
import {validCategoryVisibilityScopeV1,validWorkPlanScopeV1,type CategoryVisibilityScopeV1} from '../src/domain/assignment-kernel/work_plan_scope.js';
import {checkWorkPlanScopeV1,selectWorkPlanScopeReadIdsV1} from '../src/assignments/work_plan_scope_check.js';
import {storeEvidence} from '../src/evidence/evidence_store.js';import {payloadDigestV2} from '@revitoperator/payload-digest-v2';import {__closeForTests} from '../src/memory/sqlite_store.js';
import {projectWorkReviewV2,renderWorkReviewHandoffV2} from '../src/assignments/work_review_handoff.js';
const retained=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/category-visibility-scope-69.json'),'utf8'));
const retained70=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/category-visibility-scope-70.json'),'utf8'));
const fixture=(variant='69')=>structuredClone(variant==='70'?retained70:retained) as {scope:CategoryVisibilityScopeV1,reads:any[]};
test('exact native70 default-list inventory verifies all ten placed views without actor-supplied counts',()=>{
 const f=fixture('70'),r=checkCategoryVisibilityScopeV1(f.scope,f.reads);
 assert(r.declared_scope_satisfied);assert.equal(r.inventory_count,200);assert.equal(r.satisfied_count,10);
 const inventory=f.reads.find(r=>r.input.path==='/revit/views');assert.equal(inventory.input.body.action,undefined);
 for(const action of [null,'delete','create',false,'LIST']){const changed=fixture('70');changed.reads.find(r=>r.input.path==='/revit/views').input.body.action=action;assert.throws(()=>checkCategoryVisibilityScopeV1(changed.scope,changed.reads),/view_inventory_incomplete/);}
 for(const badType of ['FloorPlan','Section','UnrecognizedView']){const changed=fixture('70');const views=changed.reads.find(r=>r.input.path==='/revit/views').payload.views;views.find((v:any)=>v.discipline===null).type=badType;assert.throws(()=>checkCategoryVisibilityScopeV1(changed.scope,changed.reads),/view_inventory_incomplete/);}
 const missing=fixture('70');delete missing.reads.find(r=>r.input.path==='/revit/views').payload.views.find((v:any)=>v.type==='FloorPlan').discipline;assert.throws(()=>checkCategoryVisibilityScopeV1(missing.scope,missing.reads),/view_inventory_incomplete/);
 inventory.payload.truncated=true;assert.throws(()=>checkCategoryVisibilityScopeV1(f.scope,f.reads),/view_inventory_incomplete/);
});
test('retained E010 scope derives all ten native placed views and verifies already-hidden controlling state without an edit',()=>{
 const f=fixture(),before=JSON.stringify(f),r=checkCategoryVisibilityScopeV1(f.scope,f.reads);
 assert(r.declared_scope_satisfied);assert.equal(r.matched_count,10);assert.equal(r.satisfied_count,10);assert.equal(r.excluded_count,0);
 assert(r.view_proofs.every((v:any)=>v.hidden&&v.controlling_view_id===1645236));assert.equal(JSON.stringify(f),before);
 assert.match(r.notice,/Source interpretation/);assert(validWorkPlanScopeV1(f.scope));
});
test('visible/hidden equivalence is exact and wrong stored values fail every matching target',()=>{
 const f=fixture();assert.equal(checkCategoryVisibilityScopeV1({...f.scope,hidden:false},f.reads).satisfied_count,0);
 for(const r of f.reads.filter(r=>r.input.path==='/revit/visibility'))r.payload.view.templateCategoryOverride.hidden=false;
 assert(checkCategoryVisibilityScopeV1({...f.scope,hidden:false},f.reads).declared_scope_satisfied);
 const wrong=checkCategoryVisibilityScopeV1(f.scope,f.reads);assert(!wrong.declared_scope_satisfied);assert.equal(wrong.failed_target_ids.length,10);
});
for(const [name,mutate] of [
 ['missing one candidate',(f:any)=>f.reads.pop()],
 ['missing native sheet',(f:any)=>f.reads=f.reads.filter((r:any)=>r.input.path!=='/revit/sheets')],
 ['filtered sheet placements',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').input.body.placementIds=[1661154]],
 ['truncated sheet',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.truncated=true],
 ['wrong sheet identity',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.sheetElementId=1],
 ['dropped placement',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.placedViews.pop()],
 ['dropped geometry',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.viewportGeometry.pop()],
 ['duplicate placement',(f:any)=>{const p=f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload;p.placedViews[1]=p.placedViews[0];}],
 ['wrong viewport association',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.placedViews[0].viewportIds=[1]],
 ['wrong native view name',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/sheets').payload.placedViews[0].name='Other'],
 ['incomplete view census',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/views').payload.truncated=true],
 ['actor name-filtered census',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/views').input.body.nameContainsAny=['Power Distribution']],
 ['unknown controlling template',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/visibility').payload.view.templateControlsModelGraphics=null],
 ['wrong category identity',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/visibility').payload.view.categoryOverride.builtInCategory='OST_TelephoneDevices'],
 ['coerced hidden',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/visibility').payload.view.templateCategoryOverride.hidden='true'],
 ['conflicting template state',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/visibility').payload.view.templateCategoryOverride.hidden=false],
 ['preview read',(f:any)=>f.reads.find((r:any)=>r.input.path==='/revit/visibility').payload.dryRun=true],
 ['worker pass claim',(f:any)=>f.scope.verified=true],
] as const)test('scope rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>checkCategoryVisibilityScopeV1(f.scope,f.reads),/category_visibility_scope_/);});
test('removing the sheet domain cannot turn an incomplete project-wide search into a pass',()=>{
 const f=fixture(),{sheet_ids,...scope}=f.scope;
 assert.throws(()=>checkCategoryVisibilityScopeV1(scope,f.reads.filter(r=>r.input.path!=='/revit/sheets')),/candidate_read_missing/);
 for(const s of [{...f.scope,sheet_ids:[]},{...f.scope,sheet_ids:[1,1]},{...f.scope,sheet_ids:[0]},{...f.scope,view_ids:[1]},
  {...f.scope,hidden:'true'},{...f.scope,category:'OST_bad token'},{...f.scope,view_types:['DrawingSheet']}])assert(!validCategoryVisibilityScopeV1(s));
});
for(const variant of ['69','70'])test('integral retained-byte boundary '+variant+' checks already-correct state and rejects stale, foreign, tampered and newer failed reads',()=>{
 const prior=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'operator-visibility-scope-'));process.env.OPERATOR_WORKSPACE_ROOT=root;
 try{
  const f=fixture(variant),binding={assignment_id:'scope',run_id:'run',generation:1,session_id:'session',principal_id:'principal',document_fingerprint:'doc'};
  const s:any={current_binding:binding,operations:{},observations:{},unresolved_unknown_operation_ids:[],in_flight_operation_ids:[],work_plan_claims:[{item_id:'data',verified:false}]};
  for(const r of f.reads){const stored=storeEvidence({scope:{...binding,attempt_id:r.operation_id},source:'native-visibility-read',trust_level:'authoritative_native',raw:r.payload}),hash=payloadDigestV2(r.payload).digest,oid='obs:'+r.operation_id;
   s.operations[r.operation_id]={operation_id:r.operation_id,binding,input:r.input,requested_effect:'read',persistent_effect:'none',dispatch_state:'dispatched',settlement_state:'settled',opened_at:'2026-10-14T03:40:00Z',observation_ids:[oid],result:{binding,authority:'native-host',status:'succeeded',dispatch_state:'dispatched',completed_at:'2026-10-14T03:41:00Z',raw_payload_hash:hash}};
   s.observations[oid]={binding,operation_id:r.operation_id,authority:'native-host',raw_payload_hash:hash,raw_payload_ref:'evidence:'+stored.ref.evidence_id};
  }
  const req={item_id:'data',scope:f.scope,operation_ids:selectWorkPlanScopeReadIdsV1(s,f.scope),requested_at:'2026-10-14T03:42:00Z'},before=JSON.stringify(s);
  const result=checkWorkPlanScopeV1(s,req);assert(result.available,JSON.stringify(result));assert(result.declared_scope_satisfied);assert.equal(result.satisfied_count,10);assert.equal(JSON.stringify(s),before);assert.equal(s.work_plan_claims[0].verified,false);
  const missingInventory={...req,operation_ids:req.operation_ids.filter(id=>s.operations[id].input.path!=='/revit/views')};
  const incomplete=checkWorkPlanScopeV1(s,missingInventory);assert(!incomplete.available);assert.match(incomplete.guidance??'',/Then rerun check_scope with the same item and scope/);
  const shown={...s,assignment_version:20,work_plan_scope_requests:[req],work_plan:{schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[{item_id:'data',description:'Hide data outlets, typical',source_basis:'Original E010 mark',kind:'edit',declared_at:'2026-10-14T03:39:00Z',operation_ids:[],location_history:[]}]},work_plan_claims:[{item_id:'data',verified:false,operation_ids:[],claimed_at:'2026-10-14T03:42:01Z'}],spec:{requested_effect:'apply'},in_flight_provider_call_ids:[],execution_failure_ids:[],pending_input_variable_ids:[]};
  const review=projectWorkReviewV2(shown);assert.equal(review.checked_scope_count,1);assert.equal(review.checked_edit_count,0);assert.equal(review.counts.checked,0);assert.equal(review.counts.reported_unverified,1);
  assert.match(renderWorkReviewHandoffV2(shown)!.summary,/1 declared native scope check satisfied/);
  const id=f.reads.find(r=>r.input.path==='/revit/sheets').operation_id;
  for(const change of [(x:any)=>x.unresolved_unknown_operation_ids=['old-unknown'],(x:any)=>x.in_flight_operation_ids=['active'],
   (x:any)=>x.operations.save={requested_effect:'apply',persistent_effect:'applied',opened_at:'2026-10-14T03:41:01Z'},
   (x:any)=>x.operations[id].binding={...binding,generation:2},(x:any)=>x.observations['obs:'+id].raw_payload_hash='tampered',
   (x:any)=>x.operations[id].result.authority='assistant',(x:any)=>x.input_invalidated_operation_ids=[id]]){
   const altered=structuredClone(s);change(altered);assert(!checkWorkPlanScopeV1(altered,req).available);
  }
  const newer=structuredClone(s.operations[id]);newer.operation_id='newer';newer.opened_at='2026-10-14T03:41:01Z';newer.result.status='failed_after_dispatch';
  const changed={...s,operations:{...s.operations,newer}};const selected=selectWorkPlanScopeReadIdsV1(changed,f.scope);assert(selected.includes('newer'));assert(!selected.includes(id));assert(!checkWorkPlanScopeV1(changed,{...req,operation_ids:selected}).available);
 }finally{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
