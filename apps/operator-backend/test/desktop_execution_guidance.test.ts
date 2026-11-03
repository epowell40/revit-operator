import assert from 'node:assert/strict';import test from 'node:test';
import {DESKTOP_EXECUTION_EFFICIENCY_GUIDANCE as guidance,desktopNativeInitialContext} from '../src/assignments/desktop_execution_guidance.js';

test('authorized apply avoids routine rehearsal while explicit preview and native prerequisites remain',()=>{
 assert.match(guidance,/apply the supported change directly/);
 assert.match(guidance,/Do not add a preview\/dry-run merely to rehearse/);
 assert.match(guidance,/user-requested preview remains noncommitting/);
 assert.match(guidance,/native contract prerequisite/);assert.match(guidance,/independent readback/);
 assert.match(guidance,/Read-only tasks stay read-only/);
});
test('compact ledger retains scope and actual completion; batching never guesses dependencies',()=>{
 assert.match(guidance,/compact scope ledger/);assert.match(guidance,/saved output and final inspection\/preservation/);
 assert.match(guidance,/no separate items for discovery, documentation, reasoning/);
 assert.match(guidance,/Canonical native receipts already retain/);
 assert.match(guidance,/already-known arguments in the same response/);
 assert.match(guidance,/Never assume an earlier call succeeded/);assert.match(guidance,/Pause or terminal control/);
});
test('reuse existing narrow schema and composed review interfaces without solved targets or new tools',()=>{
 assert.match(guidance,/includeSchemas=true/);assert.match(guidance,/small max \(1–3\)/);
 assert.match(guidance,/review_current_work can combine/);assert.match(guidance,/complete_inspection_item_id/);
 assert.match(guidance,/parameter-only facts/);assert.doesNotMatch(guidance,/\b(?:M10[0-9]|opv2_|elementId:\s*\d|154\d{4})\b/);
});

test('verification policy distinguishes hidden values from displayed consequences without treating geometry as appearance',()=>{
 assert.match(guidance,/parameter-only facts that do not change appearance/);
 assert.match(guidance,/Displayed text, placement, clipping, overlap, leader association and layout require applicable actual pixels/);
 assert.match(guidance,/completed region or batch/);
 assert.match(guidance,/relevant change or uncovered requirement/);
 assert.match(guidance,/Existing evidence admission and currentness checks decide reuse/);
 assert.match(guidance,/do not assert that unseen content was preserved/);
 assert.match(guidance,/fresh host orientation/);assert.match(guidance,/not target geometry, evidence or authority/);
});

test('initial task context reuses canonical state without model targets, new reads, scope overwrite or authority',()=>{
 const snapshot:any={assignment_version:7,spec:{requested_effect:'apply',work_plan_required:true}};
 const before=JSON.stringify(snapshot),initial=desktopNativeInitialContext(snapshot);
 assert.match(initial,/"work_plan_declared":false/);assert.match(initial,/no separate status request/);
 assert.match(initial,/not native model data or write authority/);assert.equal(JSON.stringify(snapshot),before);
 snapshot.work_plan={items:[{item_id:'private-id',description:'Do not copy narrative'}]};
 const existing=desktopNativeInitialContext(snapshot);assert.match(existing,/"declared_items":1/);
 assert.match(existing,/Use the existing plan/);assert.doesNotMatch(existing,/Declare the compact|private-id|copy narrative/);
 snapshot.spec.work_plan_required=false;delete snapshot.work_plan;
 assert.doesNotMatch(desktopNativeInitialContext(snapshot),/Declare the compact/);
 snapshot.spec.work_plan_required=true;snapshot.spec.execution_policy={mode:'local_advisory_v1'};
 const advisory=desktopNativeInitialContext(snapshot);
 assert.match(advisory,/"work_plan_required":false/);assert.doesNotMatch(advisory,/Declare the compact/);
});
