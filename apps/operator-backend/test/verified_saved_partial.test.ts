import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {evaluateCriterionV2} from '../src/domain/assignment-kernel/criterion_evaluator.js';
import {criteriaPendingEvaluationV2} from '../src/domain/assignment-kernel/progress/controller.js';
import {deriveAssignmentOutcomeV2} from '../src/domain/assignment-kernel/outcome.js';
import {inspectionIsCurrentV2,workPlanPendingV2} from '../src/domain/assignment-kernel/work_plan.js';
import {verifiedNativeWorkTargetIdentitiesV2} from '../src/domain/assignment-kernel/verified_work_targets.js';
import {deriveTerminalResultV2} from '../src/assignments/assignment_kernel_v2_terminal_result.js';
import {verifiedSavedPartialV2} from '../src/domain/assignment-kernel/verified_saved_partial.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const file=[path.join(here,'fixtures/postsave-note-inspection-516.json'),path.join(here,'../../test/fixtures/postsave-note-inspection-516.json')].find(fs.existsSync)!;
// Existing public native-contract fixture; the new plan is synthetic. No live
// history is changed, and its explicit deferred design never becomes completed.
function fixture(){
 const f=JSON.parse(fs.readFileSync(file,'utf8')),s=f.snapshot;
 const edits=Object.values(s.operations).filter((o:any)=>o.requested_effect==='apply') as any[];
 const save=edits.find(o=>o.request_identity.path==='/revit/save-as')!,note=edits.find(o=>o!==save)!;
 const fileRead=s.operations[save.verification_operation_ids[0]],noteRead=s.operations[f.read_id];
 const now=new Date(Math.max(Date.parse(fileRead.result.completed_at),Date.parse(noteRead.result.completed_at))+1000).toISOString();
 const declared=note.opened_at;
 s.work_plan={schema:'revit-operator.assignment-work-plan/v2',assumptions:[],items:[
  {item_id:'design',description:'Unfinished design',source_basis:'User conditional request',declared_at:declared,operation_ids:[],deferrals:[{reason:'Approved design inputs remain unavailable.',deferred_at:now}]},
  ...edits.map(o=>({item_id:o===save?'save':'note',description:o===save?'Save requested model':'Create requested note',source_basis:'User',declared_at:declared,operation_ids:[o.operation_id],completed_at:now})),
  {item_id:'inspect',kind:'inspection',description:'Inspect completed changes and saved file',source_basis:'User',declared_at:declared,depends_on:['note','save'],operation_ids:[fileRead.operation_id,noteRead.operation_id],completed_at:now,
   inspection:{target_ids:edits.flatMap(o=>verifiedNativeWorkTargetIdentitiesV2(s,o.operation_id)),observation_ids:[...fileRead.observation_ids,...noteRead.observation_ids]}}
 ]};
 s.criteria={};s.criterion_evaluation_versions={};s.terminal=false;s.outcome='active';s.quiescent=true;
 delete s.progress_blocker;delete s.terminal_reason;delete s.finished_at;
 assert(inspectionIsCurrentV2(s,s.work_plan.items.at(-1)),'fixture uses real current inspection rules');
 const criterion=s.spec.criteria[0],observations=edits.flatMap(o=>o.observation_ids);
 const evaluate=()=>evaluateCriterionV2({snapshot:s,criterion_id:criterion.criterion_id,observation_ids:observations,evaluator_authority:'operator-runtime',evaluated_at:now});
 return{s,save,note,fileRead,noteRead,now,criterion,evaluate};
}

test('verified saved subset becomes eligible for partial criterion evaluation, not whole-scope completion',()=>{
 const {s,criterion}=fixture(),before=JSON.stringify(s);
 assert(criteriaPendingEvaluationV2(s)[criterion.criterion_id]?.length);
 assert(workPlanPendingV2(s),'deferred work stays pending');assert.equal(JSON.stringify(s),before);
});
test('admitted native result facts yield partial, then explicit remaining-scope terminal presentation',()=>{
 const {s,criterion,evaluate}=fixture(),e=evaluate();assert.equal(e.status,'partial');
 assert(e.supporting_facts.length);assert.match(e.reason,/unfinished|deferred/);
 s.criteria[criterion.criterion_id]=e;
 assert.equal(deriveAssignmentOutcomeV2(s),'complete_with_issues');
 s.outcome='complete_with_issues';s.terminal=true;
 const result=deriveTerminalResultV2(s);
 assert(e.supporting_facts.every(f=>result.supporting_observation_ids.includes(f.observation_id)));
 assert.match(result.result_summary,/unfinished/i);assert.match(result.result_summary,/Approved design inputs/);
 assert.doesNotMatch(result.result_summary,/requested work completed from authoritative/i);
 assert.equal(s.work_plan.items[0].completed_at,undefined);assert(workPlanPendingV2(s));
});

for(const variant of ['unreviewed','stale','foreign-inspection','bad-inspection-hash','unverified','unknown','inflight','provider-pending','paused','usage-hold','failed','unattempted','deferred-inspection','unsaved','later-write','missing-file-read','invalidated','invalidated-read','required-delivery-missing'] as const)
test('saved subset cannot be dispositioned with '+variant,()=>{
 const {s,save,note,fileRead,noteRead,criterion,evaluate}=fixture();
 if(variant==='unreviewed')delete s.work_plan.items.at(-1).completed_at;
 if(variant==='stale')noteRead.opened_at=save.opened_at;
 if(variant==='foreign-inspection')noteRead.result.binding={...s.current_binding,generation:999};
 if(variant==='bad-inspection-hash')s.observations[noteRead.observation_ids[0]].raw_payload_hash='0'.repeat(64);
 if(variant==='unverified')s.observations[s.operations[note.verification_operation_ids[0]].observation_ids[0]].facts=[];
 if(variant==='unknown'){s.unresolved_unknown_operation_ids=['unknown'];s.quiescent=false;}
 if(variant==='inflight'){s.in_flight_operation_ids=['write'];s.quiescent=false;}
 if(variant==='provider-pending'){s.in_flight_provider_call_ids=['provider'];s.quiescent=false;}
 if(variant==='paused')s.execution_control={state:'paused'};
 if(variant==='usage-hold')s.provider_usage_hold={reason:'pending'};
 if(variant==='failed'){s.execution_failure_ids=['failed'];s.execution_failures={failed:{error_class:'internal_error'}};}
 if(variant==='unattempted')delete s.work_plan.items[0].deferrals;
 if(variant==='deferred-inspection'){delete s.work_plan.items.at(-1).completed_at;s.work_plan.items.at(-1).deferrals=[{reason:'No image review',deferred_at:save.result.completed_at}];}
 if(variant==='unsaved'){delete s.operations[save.operation_id];}
 if(variant==='later-write'){const o=structuredClone(note);o.operation_id='later';o.result.completed_at='2099-01-01T00:00:00Z';s.operations.later=o;}
 if(variant==='missing-file-read'){delete s.operations[fileRead.operation_id];}
 if(variant==='invalidated')s.input_invalidated_operation_ids=[note.operation_id];
 if(variant==='invalidated-read')s.input_invalidated_operation_ids=[noteRead.operation_id];
 if(variant==='required-delivery-missing')s.spec.result_delivery_required=true;
 assert.equal(criteriaPendingEvaluationV2(s)[criterion.criterion_id],undefined);
 const e=evaluate();assert.notEqual(e.status,'partial');s.criteria[criterion.criterion_id]=e;
 assert.notEqual(deriveAssignmentOutcomeV2(s),'complete_with_issues');
});

test('full completed plan retains pass; special criteria and contradictory evidence never get a partial shortcut',()=>{
 const {s,criterion,evaluate,note}=fixture();s.work_plan.items.shift();assert.equal(evaluate().status,'pass');
 const f=fixture();f.criterion.semantic_fact_requirements.push('extra.required');assert.notEqual(f.evaluate().status,'partial');
 const g=fixture(),o=g.s.observations[g.note.observation_ids[0]],fact=o.facts.find((f:any)=>f.fact_id==='task.result_available');
 o.facts.push({...fact,value:false});assert.equal(g.evaluate().status,'uncertain');
});

for(const variant of ['request','receipt','correlation','dispatch','semantic-gap','apply-hash','apply-source','apply-generation','read-request','read-effect','read-schema','unknown-kind','null-kind','deferred-write','pending-review','pending-input','budget','blocker'] as const)
test('partial eligibility retains native trust and control boundary: '+variant,()=>{
 const {s,note,noteRead}=fixture();
 if(variant==='request')note.result.request_identity.request_signature='0'.repeat(64);
 if(variant==='receipt')delete note.result.receipt_id;
 if(variant==='correlation')delete note.result.native_correlation_id;
 if(variant==='dispatch')note.dispatch_state='not_dispatched';
 if(variant==='semantic-gap')note.result.result_semantic_gap='missing';
 if(variant==='apply-hash')s.observations[note.observation_ids[0]].raw_payload_hash='0'.repeat(64);
 if(variant==='apply-source')note.result.authority='operator-runtime';
 if(variant==='apply-generation')note.result.binding={...s.current_binding,generation:999};
 if(variant==='read-request')noteRead.result.request_identity.path='/unrelated';
 if(variant==='read-effect')noteRead.result.persistent_effect='applied';
 if(variant==='read-schema')s.observations[noteRead.observation_ids[0]].result_schema_id='foreign-schema';
 if(variant==='unknown-kind')s.work_plan.items[1].kind='unsupported';
 if(variant==='null-kind')s.work_plan.items[0].kind=null;
 if(variant==='deferred-write')s.work_plan.items[0].operation_ids=[note.operation_id];
 if(variant==='pending-review')s.pending_review_ids=['review'];
 if(variant==='pending-input')s.pending_input_variable_ids=['input'];
 if(variant==='budget')s.provider_budget_exhausted={reason:'exhausted'};
 if(variant==='blocker')s.progress_blocker={code:'blocked'};
 assert.equal(verifiedSavedPartialV2(s),false);
});
