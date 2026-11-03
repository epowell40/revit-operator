import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {projectDraftingFrontier,DRAFTING_COVERAGE_SWEEP_ADVICE} from '../src/assignments/drafting_frontier.js';
import {desktopNativeInitialContext} from '../src/assignments/desktop_execution_guidance.js';
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';

const at=(n:number)=>new Date(Date.UTC(2026,0,1,0,n)).toISOString();
const fixtureFiles=[new URL('./fixtures/verified-annotation-feedback-516.json',import.meta.url),
 new URL('../../test/fixtures/verified-annotation-feedback-516.json',import.meta.url)];
function fixture(){
 const file=fixtureFiles.find(p=>fs.existsSync(p));assert(file,'Canonical annotation fixture is required in source and compiled test lanes');
 const s:any=JSON.parse(fs.readFileSync(file,'utf8'));
 s.spec.requested_effect='apply';s.spec.execution_policy={...s.spec.execution_policy,mode:'local_advisory_v1',
  ready_work_handoff:'continue_ready_work_v1',max_provider_calls:24,max_total_tokens:4000000,max_operations:256,max_wall_clock_ms:1200000,
  progress_allowance:{mode:'observed_native_work_v1',max_provider_calls:256,max_total_tokens:32000000,max_operations:1024,max_wall_clock_ms:7200000}};
 s.terminal=false;s.outcome='active';s.execution_control={state:'running'};s.quiescent=true;
 s.in_flight_operation_ids=[];s.unresolved_unknown_operation_ids=[];s.in_flight_provider_call_ids=[];
 s.pending_input_variable_ids=[];s.pending_review_ids=[];delete s.provider_usage_hold;delete s.completion_proposal;
 s.operations={};s.provider_calls={};s.provider_call_ids=[];s.work_plan={schema:'revit-operator.assignment-work-plan/v2',items:[],assumptions:[]};
 return s;
}
function row(s:any,id:string,time=1,stage='drafted',pass='geometry'){
 const r:any={status:'candidate',reason:'Source-linked work',recorded_at:at(time),binding:{...s.current_binding},verified:false,
  source:{attachment_id:'source',filename:'plan.pdf',sha256:'a'.repeat(64),page:1,page_count:1,
   region:{min_u:.1,min_v:.1,max_u:.2,max_v:.2}},
  native:{document_fingerprint:s.current_binding.document_fingerprint,view_id:100},
  drafting:{pass,stage,element_ids:[10],read_operation_ids:[],remaining:'Connections and annotation not checked',next_action:'Resolve a visible discrepancy'}};
 const item={item_id:id,description:id,source_basis:'Reference',kind:'edit',declared_at:at(0),operation_ids:[],location_history:[r]};
 s.work_plan.items.push(item);return r;
}
function calls(s:any,n=14){for(let i=0;i<n;i++){
 const id='call-'+i;s.provider_call_ids.push(id);s.provider_calls[id]={call_id:id,binding:{...s.current_binding},state:'completed',admitted_at:at(i+10),
  completed_at:at(i+10),usage_received_at:at(i+10),success:true,usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
}}
function record(s:any){return JSON.parse((desktopAssignmentFeedbackInputV2([],s).at(-1) as any).content[0].text.split('\n').at(-1));}

test('ongoing local edits cannot suppress whole-scope pacing or older source regions',()=>{
 const s=fixture();row(s,'older-area',1);row(s,'recent-area',2);row(s,'current-area',3);calls(s);
 // Even many successful native commits are not claimed as new checked coverage.
 s.operations.local={requested_effect:'apply',persistent_effect:'applied',opened_at:at(24),result:{completed_at:at(24),affected_target_identities:['element_id:10']}};
 const before=JSON.stringify(s),p=projectDraftingFrontier(s)!;
 assert.equal(p.state,'coverage_sweep_due');assert.equal(p.calls_since_new_checked_scope,14);
 assert.equal(p.recent_focus.item_id,'current-area');assert.equal(p.other_recorded_regions[0]!.item_id,'older-area');
 assert.equal(p.recent_focus.recorded_at,at(3));
 assert.equal(p.advisory_only,true);assert.equal(p.complete,false);assert.equal(p.checked_scope_count,0);
 assert.equal(JSON.stringify(s),before);assert(Buffer.byteLength(JSON.stringify(p))<=3072);
});
test('new checked scopes advance coverage advice; duplicate check images/read IDs do not',()=>{
 const s=fixture(),r=row(s,'area',1,'checked');calls(s);const duplicate=structuredClone(r);
 duplicate.recorded_at=at(24);duplicate.drafting.source_image_sha256='b'.repeat(64);duplicate.drafting.model_image_sha256='c'.repeat(64);
 duplicate.drafting.read_operation_ids=['another-read'];s.work_plan.items[0].location_history.push(duplicate);
 assert.equal(projectDraftingFrontier(s)!.state,'coverage_sweep_due');assert.equal(projectDraftingFrontier(s)!.checked_scope_count,1);
 const next=structuredClone(duplicate);next.drafting.pass='annotations';s.work_plan.items[0].location_history.push(next);
 assert.equal(projectDraftingFrontier(s)!.state,'working');assert.equal(projectDraftingFrontier(s)!.checked_scope_count,2);
 assert.match(projectDraftingFrontier(s)!.recent_focus.remaining,/not checked/,'No whole-area completion inferred');
});
test('actual model-visible feedback and recovery carry the same bounded frontier without changing native checks',()=>{
 const s=fixture();row(s,'older',1);row(s,'current',3);calls(s);const baseline=record({...s,work_plan:undefined}),r=record(s);
 assert.deepEqual(r.native_feedback,baseline.native_feedback);assert.equal(r.drafting_frontier.state,'coverage_sweep_due');
 const input=desktopAssignmentFeedbackInputV2([],s);assert.match(JSON.stringify(input),/Compare whole-page context/);
 assert.match(JSON.stringify(input),/do not reread or recapture merely to answer this reminder/);
 assert.match(desktopNativeInitialContext(s),/other_recorded_regions/);assert.match(desktopNativeInitialContext(s),/older/);
 assert.doesNotMatch(DRAFTING_COVERAGE_SWEEP_ADVICE,/M10[0-9]|elementId|75%|complete by/);
});
for(const state of ['paused','unknown','native_inflight','provider_inflight','usage_hold','input','review','proposal','terminal','failed','budget','progress_blocker'] as const)
test('coverage advice cannot override '+state,()=>{
 const s=fixture();row(s,'area');calls(s);
 if(state==='paused')s.execution_control.state='paused';if(state==='unknown')s.unresolved_unknown_operation_ids=['unknown'];
 if(state==='native_inflight')s.in_flight_operation_ids=['inflight'];if(state==='provider_inflight')s.in_flight_provider_call_ids=['provider'];
 if(state==='usage_hold')s.provider_usage_hold={hold_id:'hold'};if(state==='input')s.pending_input_variable_ids=['input'];
 if(state==='review')s.pending_review_ids=['review'];if(state==='proposal')s.completion_proposal={};
 if(state==='terminal')s.terminal=true;if(state==='failed')s.outcome='failed';
 if(state==='budget')s.provider_budget_exhausted=true;if(state==='progress_blocker')s.progress_blocker={code:'existing_blocker'};
 assert.equal(projectDraftingFrontier(s)!.state,'hold');
});
for(const change of ['foreign_binding','foreign_document','bad_region','missing_source','missing_drafting_ids'] as const)
test('unusable records do not gain a frontier '+change,()=>{
 const s=fixture(),r=row(s,'area');calls(s);
 if(change==='foreign_binding')r.binding.generation++;if(change==='foreign_document')r.native.document_fingerprint='foreign';
 if(change==='bad_region')r.source.region.max_u=NaN;if(change==='missing_source')delete r.source;
 if(change==='missing_drafting_ids')delete r.drafting.element_ids;
 assert.equal(projectDraftingFrontier(s),null);
});
test('ordinary reads/untracked work remain unchanged; unseen page coverage is never inferred',()=>{
 const s=fixture();assert.equal(projectDraftingFrontier(s),null);row(s,'area');s.spec.requested_effect='read';
 assert.equal(projectDraftingFrontier(s),null);s.spec.requested_effect='apply';delete s.spec.execution_policy.ready_work_handoff;
 assert.equal(projectDraftingFrontier(s),null);
});
test('large region histories remain a bounded partial index with truthful omission',()=>{
 const s=fixture();for(let n=0;n<80;n++){const r=row(s,'area'+n,n+1);r.drafting.remaining='x'.repeat(400);r.drafting.next_action='y'.repeat(240);}
 calls(s);const r=projectDraftingFrontier(s)!;
 assert.equal(r.recorded_region_count,80);assert(r.omitted_region_count>=77);assert.equal(r.complete,false);
 assert(Buffer.byteLength(JSON.stringify(r))<=3072);assert.match(r.notice,/Unmarked source remains undiscovered/);
});
test('foreign later history never replaces current pass metadata; Unicode prose stays bounded',()=>{
 const s=fixture(),r=row(s,'current',1,'drafted');r.drafting.remaining='漢'.repeat(130);r.drafting.next_action='漢'.repeat(80);
 const foreign=structuredClone(r);foreign.binding.generation++;foreign.recorded_at=at(24);foreign.drafting.stage='checked';
 s.work_plan.items[0].location_history.push(foreign);calls(s);
 const p=projectDraftingFrontier(s)!;assert.equal(p.recent_focus.stage,'drafted');assert.equal(p.recent_focus.passes[0]!.stage,'drafted');
 assert(Buffer.byteLength(p.recent_focus.remaining)<=112);assert(Buffer.byteLength(JSON.stringify(p))<=3072);
 assert.equal(p.recent_focus.text_truncated,true);
});
