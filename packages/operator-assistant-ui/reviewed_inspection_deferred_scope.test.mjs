import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFocusedInspection,closeReviewedInspection,reviewedInspectionHasTerminalResult} from './reviewed_inspection_closeout.mjs';
import {CANONICAL_NATIVE_TASK_GUIDANCE} from './native_task_routing.mjs';

const binding={assignment_id:'transfer',session_id:'session',run_id:'run',generation:1};
const at='2026-10-27T14:02:40.000Z';
function fixture(){
 const items=[
  {item_id:'office-design',kind:'edit',operation_ids:[],deferrals:[{reason:'Approved design basis unresolved; sampled branch is not a complete system review.',deferred_at:'2026-10-27T13:58:53.696Z'}]},
  ...['space-comment','schedule-width','sheet-note','save-result'].map(item_id=>({item_id,kind:'edit',completed_at:'2026-10-27T14:02:38.265Z',operation_ids:['apply']})),
  {item_id:'native-inspection',kind:'inspection',completed_at:'2026-10-27T14:02:35.561Z',depends_on:['space-comment','schedule-width','sheet-note'],operation_ids:['read']},
  {item_id:'final-visual-review',kind:'inspection',depends_on:['sheet-note','schedule-width'],operation_ids:[]}
 ];
 const snapshot={current_binding:binding,assignment_version:400,outcome:'active',terminal:false,quiescent:true,spec:{work_plan_required:true},
  in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],
  work_plan:{items},operations:{apply:{requested_effect:'apply',result:{completed_at:'2026-10-27T14:01:55Z'}},read:{requested_effect:'read'}}};
 const status={ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'final-visual-review',required_target_ids:['element_id:1422218','element_id:1545903'],existing_element_read_candidates:['read'],paired_artifact_read_candidates:[],validation_required:true,coverage_only:true}}};
 const location={process_id:1,document_session_id:'doc',epoch:'epoch',through_sequence:3,view_id:1363610};
 const review={schema:'operator.visual_work_review.v1',authority:'supporting_visual_assessment',ok:true,state:'matched',native_postcondition_verified:false,whole_task_verified:false,owner:binding,location,
  request:{view_id:1363610,complete_inspection_item_id:'final-visual-review',checks:[{id:'note-clear',expected:'Readable clear note'}]},checks:[{id:'note-clear',status:'matched'}],reviewer_response_id:'response'};
 const evidenceRef={schema:'revit-operator.evidence-ref.v1',...binding,evidence_id:'ev1_review',source:'operator_desktop.function.review_current_work',content_hash:'sha256:'+'a'.repeat(64),byte_count:1000,created_at_utc:at};
 return{binding,snapshot,status,review,evidenceRef,currentScene:location,now:Date.parse(at)};
}
async function run(f){const calls=[],before=JSON.stringify(f.snapshot);const request=async(p,o)=>{const body=JSON.parse(o.body);calls.push(body);return body.action==='status'?f.status:{ok:true,outcome:'blocked'};};
 const prepared=await prepareFocusedInspection({binding,itemId:'final-visual-review',focusElementIds:[1422218,1545903],readSnapshot:async()=>f.snapshot,request});
 const closed=await closeReviewedInspection({...f,readSnapshot:async()=>f.snapshot,request});assert.equal(JSON.stringify(f.snapshot),before);
 return{prepared,closed,calls};}
test('independent deferred design does not prevent the requested inspection of completed edits',async()=>{
 const f=fixture(),r=await run(f);assert.equal(r.prepared.state,'prepared');assert.equal(r.closed.state,'submitted');
 assert.equal(r.closed.outcome,'blocked');assert.equal(r.closed.whole_task_verified,false);assert.equal(r.closed.native_postcondition_verified,false);
 assert.deepEqual(r.calls.filter(c=>c.action==='complete'),[{...binding,action:'complete',item_id:'final-visual-review',operation_ids:['read'],expected_assignment_version:400}]);
 assert.equal(f.snapshot.work_plan.items[0].completed_at,undefined);assert(f.snapshot.work_plan.items[0].deferrals.length);
});

test('unrelated placed-instance focus reports exact inspection IDs without granting native coverage',async()=>{
 const f=fixture(),before=JSON.stringify(f.snapshot);
 const result=await prepareFocusedInspection({binding,itemId:'final-visual-review',focusElementIds:[1488991,1545999],
  readSnapshot:async()=>f.snapshot,request:async()=>f.status});
 assert.equal(result.state,'not_submitted');assert.equal(result.reason,'focus_excludes_inspection_targets');
 assert.deepEqual(result.required_focus_element_ids,[1422218,1545903]);
 assert.equal(result.native_postcondition_verified,false);assert.equal(JSON.stringify(f.snapshot),before);
});
test('canonical omitted edit kind permits inspection without completing the deferred design',async()=>{
 const f=fixture();delete f.snapshot.work_plan.items[0].kind;
 const r=await run(f);assert.equal(r.prepared.state,'prepared');assert.equal(r.closed.state,'submitted');
 assert.equal(r.closed.outcome,'blocked');assert.equal(r.closed.whole_task_verified,false);
 assert.equal(r.calls.filter(c=>c.action==='complete').length,1);
 assert.equal(f.snapshot.work_plan.items[0].completed_at,undefined);
});
const negatives={
 'null kind is not canonical default':f=>f.snapshot.work_plan.items[0].kind=null,
 'unsupported kind':f=>f.snapshot.work_plan.items[0].kind='research',
 'direct deferred dependency':f=>f.snapshot.work_plan.items.at(-1).depends_on.push('office-design'),
 'transitive deferred dependency':f=>f.snapshot.work_plan.items.find(i=>i.item_id==='sheet-note').depends_on=['office-design'],
 'unsettled deferred partial':f=>f.snapshot.work_plan.items[0].operation_ids=['apply'],
 'deferred inspection':f=>f.snapshot.work_plan.items[0].kind='inspection',
 'resumed work':f=>f.snapshot.work_plan.items[0].deferrals[0].resumed_at=at,
 'missing reason':f=>delete f.snapshot.work_plan.items[0].deferrals[0].reason,
 'unknown dependency':f=>f.snapshot.work_plan.items.at(-1).depends_on=['absent'],
 'dependency cycle':f=>f.snapshot.work_plan.items.find(i=>i.item_id==='sheet-note').depends_on=['final-visual-review'],
 'Pause':f=>f.snapshot.execution_control={state:'paused'},
 'unknown':f=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
 'pending usage':f=>f.snapshot.provider_usage_hold=true,
 'pending provider':f=>f.snapshot.in_flight_provider_call_ids=['pending'],
 'foreign binding':f=>f.snapshot.current_binding={...binding,run_id:'foreign'},
 'unmatched review':f=>f.review.state='uncertain',
 'stale review':f=>f.now+=300001,
 'backend dependency refusal':f=>f.status.work_plan.next_native_inspection=null
};
for(const [name,mutate] of Object.entries(negatives))test('independent-deferral path preserves '+name+' refusal',async()=>{
 const f=fixture();mutate(f);const r=await run(f);assert.equal(r.closed.state,'not_submitted');assert.equal(r.calls.filter(c=>c.action==='complete').length,0);
});
test('owner guidance prioritizes delivery without erasing requested design or verification',()=>{
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/Before expanding an already deferred investigation/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/do not resume an unfinished design item merely to rewrite its question/);
 assert.match(CANONICAL_NATIVE_TASK_GUIDANCE,/explicit user research or review ordering/);
});

test('only a submitted canonical terminal result ends execution; partial stays a partial disposition',()=>{
 for(const outcome of ['complete','complete_with_issues','verified_noop']){
  const result={state:'submitted',outcome,native_postcondition_verified:false,whole_task_verified:false};
  assert.equal(reviewedInspectionHasTerminalResult(result),true);
  assert.equal(result.outcome,outcome);assert.equal(result.whole_task_verified,false);
  assert.equal(reviewedInspectionHasTerminalResult({...result,state:'not_submitted'}),false);
 }
 for(const outcome of ['active','blocked','failed','awaiting_user_input','awaiting_user_review',undefined])
  assert.equal(reviewedInspectionHasTerminalResult({state:'submitted',outcome}),false);
});


test('a relevant target with neighboring context prepares navigation without certifying full inspection coverage',async()=>{
 const f=fixture(),before=JSON.stringify(f.snapshot);
 const result=await prepareFocusedInspection({binding,itemId:'final-visual-review',focusElementIds:[1488991,1545903],readSnapshot:async()=>f.snapshot,request:async()=>f.status});
 assert.equal(result.state,'prepared');assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
 assert.equal(JSON.stringify(f.snapshot),before);
});
