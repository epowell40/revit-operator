import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import test from 'node:test';
import {desktopAssignmentFeedbackInputV2} from '../src/desktop_assignment_feedback.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const files=[path.join(here,'fixtures/verified-annotation-feedback-516.json'),path.join(here,'../../test/fixtures/verified-annotation-feedback-516.json')];
function fixture(){
 const s=JSON.parse(fs.readFileSync(files.find(p=>fs.existsSync(p))!,'utf8'));
 const o=Object.values(s.observations).at(-1) as any;
 const time='2026-10-31T19:00:00.000Z';
 for(const row of Object.values(s.observations) as any[])row.observed_at='2026-10-31T18:00:00.000Z';
 s.observations.new={...structuredClone(o),observation_id:'new',observed_at:time};
 s.provider_calls={prior:{binding:structuredClone(s.current_binding),state:'completed',success:true,
  usage:{total_tokens:100},usage_received_at:time,admitted_at:time,completed_at:time,
  upstream_receipt:{call_id:'response-prior',route:'desktop_computer'}}};
 // This controlled producer fixture is between provider calls. The retained
 // annotation fixture was captured mid-call; pending-provider behavior has its
 // own negative below and must not be mistaken for a settled predecessor.
 s.in_flight_provider_call_ids=[];s.provider_call_ids=['prior'];
 return s;
}
function record(s:any,previous?:string){const items:any[]=desktopAssignmentFeedbackInputV2([],s,previous);return JSON.parse(items.at(-1).content[0].text.split('\n').at(-1));}
test('continued owner omits old discovery pointers, retains equal-time new pointers and every current check',()=>{
 const s=fixture(),before=JSON.stringify(s),full=record(s),recent=record(s,'response-prior');
 assert(full.native_feedback.observations.length>1);
 assert.deepEqual(recent.native_feedback.observations.map((o:any)=>o.observation_id),['new']);
 for(const key of ['verified_postconditions','inspection_read_candidates','pending_verification','usage'])
  assert.deepEqual(recent.native_feedback[key],full.native_feedback[key]);
 assert.deepEqual(recent.binding,full.binding);assert.equal(recent.assignment_version,full.assignment_version);
 assert.deepEqual(recent.native_feedback.host_budget.resources.total_tokens,full.native_feedback.host_budget.resources.total_tokens);
 assert.equal(recent.native_feedback.omitted,full.native_feedback.omitted+full.native_feedback.observations.length-1);
 assert.equal(recent.native_feedback.observation_index_window.complete,false);
 assert.match(recent.native_feedback.observation_index_window.usage,/neither absence, staleness nor completion/);
 assert.equal(JSON.stringify(s),before,'projection never edits canonical state');
});
for(const variant of ['missing','wrong_response','failed','unsettled','no_usage','bad_usage','no_usage_receipt','foreign_session','foreign_document','foreign_principal','foreign_generation','foreign_run','wrong_route','paused','unknown','inflight','pending_provider','usage_hold','bad_time','bad_observation_time','ambiguous'] as const)
test('full index fallback for '+variant,()=>{
 const s=fixture(),p=s.provider_calls.prior;let previous:string|undefined='response-prior';
 if(variant==='missing')previous=undefined;if(variant==='wrong_response')previous='wrong';
 if(variant==='failed')p.success=false;if(variant==='unsettled')p.state='dispatched';
 if(variant==='no_usage')delete p.usage;if(variant==='bad_usage')p.usage.total_tokens=NaN;
 if(variant==='no_usage_receipt')delete p.usage_received_at;
 if(variant==='foreign_session')p.binding.session_id='foreign';if(variant==='foreign_document')p.binding.document_fingerprint='foreign';
 if(variant==='foreign_principal')p.binding.principal_id='foreign';if(variant==='foreign_generation')p.binding.generation++;
 if(variant==='foreign_run')p.binding.run_id='foreign';if(variant==='wrong_route')p.upstream_receipt.route='other';
 if(variant==='paused')s.execution_control={state:'paused'};if(variant==='unknown')s.unresolved_unknown_operation_ids=['unknown'];
 if(variant==='inflight')s.in_flight_operation_ids=['pending'];if(variant==='pending_provider')s.in_flight_provider_call_ids=['pending'];
 if(variant==='usage_hold')s.provider_usage_hold=true;if(variant==='bad_time')p.completed_at='bad';
 if(variant==='bad_observation_time')s.observations.new.observed_at='bad';
 if(variant==='ambiguous')s.provider_calls.duplicate=structuredClone(p);
 const full=record(s),recent=record(s,previous);
 assert.deepEqual(recent.native_feedback.observations,full.native_feedback.observations);
 assert.equal(recent.native_feedback.observation_index_window,undefined);
});
test('actual relay passes only its normalized predecessor ID; input and static instructions remain intact',()=>{
 const sourceCandidates=[path.join(here,'../src/desktop_computer.ts'),path.join(here,'../../src/desktop_computer.ts')];
 const source=fs.readFileSync(sourceCandidates.find(p=>fs.existsSync(p))!,'utf8');
 assert.match(source,/desktopAssignmentFeedbackInputV2\(body\.input,resolved\.snapshot,body\.previous_response_id\)/);
 const original:any[]=[{type:'function_call_output',call_id:'c',output:'Exact native output'},{role:'user',content:'Continue the whole source'}];
 const before=JSON.stringify(original),result=desktopAssignmentFeedbackInputV2(original,fixture(),'response-prior');
 assert.deepEqual(result.slice(0,-1),original);assert.equal(JSON.stringify(original),before);
});
test('older observation pointers may be omitted while their current unresolved edit remains explicit',()=>{
 const s=fixture();const apply=Object.values(s.operations).find((o:any)=>o.requested_effect==='apply') as any;
 s.input_invalidated_operation_ids=[...apply.verification_operation_ids];
 const full=record(s),recent=record(s,'response-prior');
 assert(full.native_feedback.pending_verification.some((p:any)=>p.operation_id===apply.operation_id));
 assert.deepEqual(recent.native_feedback.pending_verification,full.native_feedback.pending_verification);
 assert.deepEqual(recent.native_feedback.verified_postconditions,full.native_feedback.verified_postconditions);
 assert.deepEqual(recent.native_feedback.observations.map((o:any)=>o.observation_id),['new']);
 assert(Object.keys(s.observations).length>1,'retained native observations remain available');
});
