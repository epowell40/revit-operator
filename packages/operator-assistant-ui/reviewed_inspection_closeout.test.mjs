import test from 'node:test';
import assert from 'node:assert/strict';
import {VISUAL_WORK_REVIEW_TOOL,normalizeVisualReviewRequest,visualWorkReviewModelOutput} from './visual_work_review.mjs';
const load=()=>import('./reviewed_inspection_closeout.mjs');
const binding={assignment_id:'a',session_id:'s',run_id:'r',generation:1};
const location={process_id:12,document_session_id:'doc',epoch:'epoch',through_sequence:3,view_id:41};
const at='2026-10-25T20:06:07.000Z';
test('existing review tool exposes optional explicit final inspection intent and keeps strict argument validation',()=>{
 assert(VISUAL_WORK_REVIEW_TOOL.parameters.properties.complete_inspection_item_id);
 assert.equal(normalizeVisualReviewRequest({view_id:41,checks:[{id:'clear',expected:'Clear'}],complete_inspection_item_id:'inspect'}).complete_inspection_item_id,'inspect');
 assert.throws(()=>normalizeVisualReviewRequest({view_id:41,checks:[{id:'clear',expected:'Clear'}],complete_inspection_item_id:'bad id'}));
});
test('closeout feedback stays inside the existing bounded evidence envelope',()=>{
 const f=fixture(),output={type:'function_call_output',call_id:'c',output:JSON.stringify({schema:'revit-operator.model-evidence-envelope.v1',
  evidence_projections:[{schema:'revit-operator.evidence-projection.v1',evidence_id:'ev1_review',byte_count:500}],omitted:0,retrieval:'Read exact retained evidence.'})};
 const result=visualWorkReviewModelOutput(output,f.review,'ev1_review',{state:'not_submitted',reason:'existing_command_refused'}),envelope=JSON.parse(result.output);
 assert.deepEqual(Object.keys(envelope),['schema','evidence_projections','omitted','retrieval']);
 assert.equal(envelope.evidence_projections[0].visual_work_review.inspection_closeout.state,'not_submitted');
 assert(Buffer.byteLength(result.output)<=8192);
});
function fixture(){
 const snapshot={assignment_version:235,current_binding:binding,outcome:'active',terminal:false,quiescent:true,
  spec:{work_plan_required:true},in_flight_operation_ids:[],in_flight_provider_call_ids:[],unresolved_unknown_operation_ids:[],
  pending_input_variable_ids:[],pending_review_ids:[],execution_failure_ids:[],provider_calls:{},
  work_plan:{items:[{item_id:'edit',kind:'edit',completed_at:'2026-10-25T20:00:00Z',operation_ids:['apply']},
   {item_id:'inspect',kind:'inspection',depends_on:['edit'],operation_ids:[]}]},
  operations:{apply:{requested_effect:'apply',persistent_effect:'applied',result:{completed_at:'2026-10-25T20:00:00Z'}},
   read:{requested_effect:'read',persistent_effect:'none'}}};
 const review={schema:'operator.visual_work_review.v1',authority:'supporting_visual_assessment',ok:true,state:'matched',
  native_postcondition_verified:false,whole_task_verified:false,owner:binding,location,
  request:{view_id:41,complete_inspection_item_id:'inspect',checks:[{id:'clear',expected:'Clearance'}]},
  checks:[{id:'clear',status:'matched'}],reviewer_response_id:'resp_review'};
 const ref={schema:'revit-operator.evidence-ref.v1',...binding,evidence_id:'ev1_review',source:'operator_desktop.function.review_current_work',
  content_hash:'sha256:'+'a'.repeat(64),byte_count:500,created_at_utc:at};
 const status={ok:true,verification_policy:'strict',work_plan:{next_native_inspection:{item_id:'inspect',
  existing_element_read_candidates:['read'],paired_artifact_read_candidates:[],validation_required:true,coverage_only:true}}};
 return {binding,snapshot,review,evidenceRef:ref,currentScene:location,status,now:Date.parse(at)};
}
test('matched owner review closes explicit existing inspection through existing version-bound command only',async()=>{
 const {closeReviewedInspection}=await load(); const f=fixture(),calls=[];
 const result=await closeReviewedInspection({...f,readSnapshot:async()=>f.snapshot,request:async(path,opts)=>{
  calls.push({path,body:JSON.parse(opts.body)});return calls.length===1?f.status:{ok:true,outcome:'complete'};}});
 assert.equal(result.state,'submitted');assert.equal(calls.length,2);
 assert.deepEqual(calls[1],{path:'/api/assignments/v2/work-plan',body:{...binding,action:'complete',item_id:'inspect',operation_ids:['read'],expected_assignment_version:235}});
 assert.equal(result.native_postcondition_verified,false);assert.equal(result.whole_task_verified,false);
});
const negatives={
 'no explicit inspection':f=>delete f.review.request.complete_inspection_item_id,
 'unreviewed':f=>f.review=null,
 'mismatch':f=>f.review.state='mismatch',
 'uncertain':f=>f.review.checks[0].status='uncertain',
 'failed':f=>f.review.ok=false,
 'missing check':f=>f.review.checks=[],
 'duplicate check':f=>f.review.checks.push({...f.review.checks[0]}),
 'foreign review':f=>f.review.owner={...binding,run_id:'foreign'},
 'foreign retained source':f=>f.evidenceRef.source='operator_desktop.function.delegate_revit_task',
 'foreign retained binding':f=>f.evidenceRef={...f.evidenceRef,generation:2},
 'missing evidence hash':f=>delete f.evidenceRef.content_hash,
 'stale review':f=>f.now+=300001,
 'changed native sequence':f=>f.currentScene={...location,through_sequence:4},
 'changed native document':f=>f.currentScene={...location,document_session_id:'other'},
 'changed native process':f=>f.currentScene={...location,process_id:13},
 'changed native epoch':f=>f.currentScene={...location,epoch:'other'},
 'Pause':f=>f.snapshot.execution_control={state:'paused'},
 'unknown effect':f=>f.snapshot.unresolved_unknown_operation_ids=['unknown'],
 'pending usage':f=>f.snapshot.provider_usage_hold={reason:'pending'},
 'pending provider':f=>f.snapshot.in_flight_provider_call_ids=['call'],
 'inflight operation':f=>f.snapshot.in_flight_operation_ids=['operation'],
 'nonquiescent':f=>f.snapshot.quiescent=false,
 'blocked':f=>f.snapshot.outcome='blocked',
 'progress blocker':f=>f.snapshot.progress_blocker={code:'blocked'},
 'real input':f=>f.snapshot.pending_input_variable_ids=['answer'],
 'pending review':f=>f.snapshot.pending_review_ids=['review'],
 'budget exhausted':f=>f.snapshot.provider_budget_exhausted=true,
 'other unfinished work':f=>f.snapshot.work_plan.items.push({item_id:'other',kind:'edit',operation_ids:[]}),
 'deferred selected inspection':f=>f.snapshot.work_plan.items[1].deferrals=[{deferred_at:at,reason:'missing engineering basis'}],
 'intervening write':f=>f.snapshot.operations.apply.result.completed_at='2026-10-25T20:06:08Z',
 'advisory':f=>f.status.verification_policy='advisory',
 'different candidate item':f=>f.status.work_plan.next_native_inspection.item_id='other',
 'missing native candidate':f=>f.status.work_plan.next_native_inspection.existing_element_read_candidates=[]
};
for(const [name,change] of Object.entries(negatives))test('retain unfinished state for '+name,async()=>{
 const {closeReviewedInspection}=await load(),f=fixture();change(f);let writes=0;
 const result=await closeReviewedInspection({...f,readSnapshot:async()=>f.snapshot,request:async(_p,o)=>{
  if(JSON.parse(o.body).action!=='status')writes++;return f.status;}});
 assert.equal(writes,0);assert.equal(result.state,'not_submitted');
});
test('stale-version or native coverage refusal is returned without retry or completion claim',async()=>{
 const {closeReviewedInspection}=await load(),f=fixture();let writes=0;
 const result=await closeReviewedInspection({...f,readSnapshot:async()=>f.snapshot,request:async(_p,o)=>{
  if(JSON.parse(o.body).action==='status')return f.status;writes++;throw Error('work_plan_version_changed');}});
 assert.equal(writes,1);assert.equal(result.state,'not_submitted');assert.match(result.reason,/command_refused/);
});
test('explicit focused inspection prepares from the same ready snapshot and native candidate without completing anything',async()=>{
 const {prepareFocusedInspection}=await load(),f=fixture(),calls=[];f.status.work_plan.next_native_inspection.required_target_ids=['element_id:101'];
 const r=await prepareFocusedInspection({binding,itemId:'inspect',focusElementIds:[101,102],readSnapshot:async()=>f.snapshot,request:async(p,o)=>{calls.push(JSON.parse(o.body));return f.status;}});
 assert.equal(r.state,'prepared');assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);assert.deepEqual(calls,[{...binding,action:'status'}]);
});
for(const name of ['Pause','unknown effect','pending usage','pending provider','inflight operation','nonquiescent','blocked','progress blocker','real input','pending review','budget exhausted','other unfinished work','deferred selected inspection','advisory','different candidate item','missing native candidate'])test('focused preparation refuses '+name+' without mutation',async()=>{
 const {prepareFocusedInspection}=await load(),f=fixture();f.status.work_plan.next_native_inspection.required_target_ids=['element_id:101'];negatives[name](f);let writes=0;
 const r=await prepareFocusedInspection({binding,itemId:'inspect',focusElementIds:[101],readSnapshot:async()=>f.snapshot,request:async(p,o)=>{if(JSON.parse(o.body).action!=='status')writes++;return f.status;}});assert.equal(r.state,'not_submitted');assert.equal(writes,0);
});
test('focused preparation cannot replace all native targets with unrelated elements',async()=>{
 const {prepareFocusedInspection}=await load(),f=fixture();f.status.work_plan.next_native_inspection.required_target_ids=['element_id:101','element_id:102'];
 const r=await prepareFocusedInspection({binding,itemId:'inspect',focusElementIds:[103],readSnapshot:async()=>f.snapshot,request:async()=>f.status});assert.equal(r.reason,'focus_excludes_inspection_targets');
});

test('multi-region visual focus retains all native dependency targets without demanding one impossible view',async()=>{
 const {prepareFocusedInspection}=await load(),f=fixture(),calls=[];
 f.status.work_plan.next_native_inspection.required_target_ids=['element_id:101','element_id:102','element_id:103','file:result.rvt'];
 const before=JSON.stringify(f);
 for(const focusElementIds of [[101],[102,104],[101,102,103]]){
  const r=await prepareFocusedInspection({binding,itemId:'inspect',focusElementIds,readSnapshot:async()=>f.snapshot,request:async(p,o)=>{calls.push(JSON.parse(o.body));return f.status;}});
  assert.equal(r.state,'prepared');assert.equal(r.native_postcondition_verified,false);assert.equal(r.whole_task_verified,false);
 }
 assert.equal(JSON.stringify(f),before);assert(calls.every(c=>c.action==='status'));
});
