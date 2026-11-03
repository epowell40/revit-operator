import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {projectWorkPlan} from '../src/assignments/work_plan_projection.js';
import {codexAssignmentEvidenceContextV2} from '../src/brains/codex_assignment_evidence.js';
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const fixtureFile=[path.join(here,'fixtures/postsave-note-inspection-516.json'),path.join(here,'../../test/fixtures/postsave-note-inspection-516.json')].find(fs.existsSync)!;
const fixture=()=>JSON.parse(fs.readFileSync(fixtureFile,'utf8')).snapshot;
const project=(s:any)=>(projectWorkPlan(s.work_plan,undefined,0,s) as any)?.next_native_inspection;
test('pending post-save inspection names exact verified model target and supported summary read without certifying content',()=>{
 const s=fixture(),before=JSON.stringify(s),p=project(s);
 assert.equal(p?.item_id,'m000-native-check');
 assert.deepEqual(p.element_summary_read,{method:'POST',path:'/revit/get-element-summary',body:{elementIds:[1545903]}});
 assert.equal(p.validation_required,true);assert.equal(p.coverage_only,true);
 assert.match(p.notice,/visual|preservation/);assert.equal(JSON.stringify(s),before);
});
test('existing worker evidence and desktop feedback carry actionable pending inspection without a new status roundtrip',()=>{
 const s=fixture(),index=JSON.parse(codexAssignmentEvidenceContextV2(s));
 assert.deepEqual(index.next_native_inspection?.element_summary_read?.body?.elementIds,[1545903]);
 assert.match(JSON.stringify(desktopAssignmentFeedbackInputV2([],s)),/next_native_inspection/);
});

test('closeout exposes the already-supported post-save typed note read, without another native query',()=>{
 const f=JSON.parse(fs.readFileSync(fixtureFile,'utf8')),s=f.snapshot,before=JSON.stringify(s),p=project(s);
 assert.deepEqual(p.existing_element_read_candidates,[f.read_id]);
 const worker=JSON.parse(codexAssignmentEvidenceContextV2(s));
 assert.deepEqual(worker.next_native_inspection.existing_element_read_candidates,[f.read_id]);
 assert(worker.inspection_read_candidates.some((r:any)=>r.read_operation_id===f.read_id));
 assert.match(JSON.stringify(desktopAssignmentFeedbackInputV2([],s)),new RegExp(f.read_id));
 assert.equal(p.validation_required,true);assert.equal(p.coverage_only,true);assert.equal(JSON.stringify(s),before);
});

for(const variant of ['stale','foreign','invalidated','failed','unsettled','external','singular','alias','missing_target'])test('typed closeout candidate excludes '+variant,()=>{
 const f=JSON.parse(fs.readFileSync(fixtureFile,'utf8')),s=f.snapshot,r=s.operations[f.read_id];
 if(variant==='stale')r.opened_at='2020-01-01T00:00:00Z';
 if(variant==='foreign')r.binding={...r.binding,generation:r.binding.generation+1};
 if(variant==='invalidated')s.input_invalidated_operation_ids=[f.read_id];
 if(variant==='failed')r.result.status='failed';
 if(variant==='unsettled')r.settlement_state='unsettled';
 if(variant==='external')r.input.body.docId='family-doc';
 if(variant==='singular'){r.input.body.elementId=r.input.body.elementIds[0];delete r.input.body.elementIds;}
 if(variant==='alias')r.input.body.ids=[42];
 if(variant==='missing_target')r.input.body.elementIds=[42];
 assert(!project(s).existing_element_read_candidates.includes(f.read_id));
});
for(const variant of ['unknown','paused','terminal','active_write','deferred','unverified_dependency','foreign_dependency','invalidated_dependency'])test('inspection suggestion remains fenced: '+variant,()=>{
 const s=fixture(),item=s.work_plan.items.find((i:any)=>i.item_id==='m000-note'),op=s.operations[item.operation_ids[0]];
 if(variant==='unknown')s.unresolved_unknown_operation_ids=['unknown'];
 if(variant==='paused')s.execution_control={state:'paused'};
 if(variant==='terminal'){s.terminal=true;s.outcome='blocked';}
 if(variant==='active_write'){s.in_flight_operation_ids=['active'];s.operations.active={requested_effect:'apply',persistent_effect:'none'};}
 if(variant==='deferred')for(const i of s.work_plan.items)if(i.kind==='inspection')i.deferrals=[{reason:'retained',deferred_at:'2026-10-25T04:00:00Z'}];
 if(variant==='unverified_dependency')item.completed_at=undefined;
 if(variant==='foreign_dependency')op.binding={...op.binding,document_fingerprint:'foreign'};
 if(variant==='invalidated_dependency')s.input_invalidated_operation_ids=[op.operation_id];
 assert.equal(project(s),null);
});
