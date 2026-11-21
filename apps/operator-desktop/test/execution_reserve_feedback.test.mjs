import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as reports from '../work_report.mjs';
const assignment={kernel_version:2,goal_id:'assignment',session_id:'session',run_id:'run',generation:1};
const receipt=(remaining=100606)=>({status:'retained',execution_continuation:{schema:'operator.execution-continuation.v1',
 binding:{assignment_id:'assignment',session_id:'session',run_id:'run',generation:1},state:'ready',checkpoint_recommended:true,
 remaining_resources:{provider_calls:{used:705,limit:720,remaining:15},active_execution_ms:{used:10337914-remaining,limit:10337914,remaining}}
}});
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('    const retainedContext = await retainComputerProviderContext(response,toolOutputs,nativeRequest);');
const end=source.indexOf('    updateComputerProgress({',start);
test('token reserve escalation reaches the next actor call even with many nominal calls and time left',()=>{
 const tracker={},r=receipt(5000000),c=r.execution_continuation;
 c.remaining_resources.total_tokens={used:25791425,limit:28000000,remaining:2208575};
 c.token_runway={basis:'largest_of_last_eight_completed_calls',sample_count:8,tokens_per_call:227767,estimated_calls_remaining:9,advisory_only:true};
 const early=reports.retainedExecutionReserveContinuation(assignment,r,tracker);
 assert.match(early.content[0].text,/9.*calls.*estimate/i);
 assert.equal(reports.retainedExecutionReserveContinuation(assignment,r,tracker),null);
 c.remaining_resources.total_tokens={used:27544466,limit:28000000,remaining:455534};
 c.token_runway.estimated_calls_remaining=2;
 const urgent=reports.retainedExecutionReserveContinuation(assignment,r,tracker);
 assert(urgent,'token reserve needs a second warning');
 assert.match(urgent.content[0].text,/Do not start another area or optional review/);
 assert.match(urgent.content[0].text,/not a guarantee/);
 assert.equal(reports.retainedExecutionReserveContinuation(assignment,r,tracker),null);
});
test('forged, inconsistent and unknown token runway cannot become trusted pacing advice',()=>{
 const r=receipt(),c=r.execution_continuation;
 c.remaining_resources.total_tokens={used:27000000,limit:28000000,remaining:1000000};
 c.token_runway={basis:'largest_of_last_eight_completed_calls',sample_count:8,tokens_per_call:200000,estimated_calls_remaining:5,advisory_only:true};
 for(const edit of [x=>x.basis='guessed',x=>x.sample_count=9,x=>x.estimated_calls_remaining=200,x=>x.advisory_only=false,x=>x.tokens_per_call=0]){
  const x=structuredClone(r);edit(x.execution_continuation.token_runway);
  assert.throws(()=>reports.retainedExecutionReserveContinuation(assignment,x,{}),/reserve_invalid/);
 }
 const unknown=structuredClone(r);unknown.execution_continuation.remaining_resources.total_tokens={used:null,limit:28000000,remaining:null};
 assert.throws(()=>reports.retainedExecutionReserveContinuation(assignment,unknown,{}),/reserve_invalid/);
});
test('actual tool-boundary loop sends the existing reserve to the next provider without another read or call',async()=>{
 const toolOutputs=[],events=[];let retains=0;
 await runInNewContext('(async()=>{'+source.slice(start,end)+'})()',{
  ...reports,computerState:{sidecarAssignment:assignment},response:{},toolOutputs,nativeRequest:{},
  draftingContinuationProgress:{},executionReserveProgress:{},outputs:[],
  retainComputerProviderContext:async()=>{retains++;return receipt();},addComputerEvent:v=>events.push(v)
 });
 assert.equal(retains,1);assert.equal(toolOutputs.length,1);
 assert.match(toolOutputs[0].content[0].text,/100606/);
 assert.match(toolOutputs[0].content[0].text,/save/i);
 assert.equal(events.length,1);
});
test('warning is bounded, updates near exhaustion, and is refreshed on recovery without changing resources',()=>{
 const tracker={},r=receipt(),before=structuredClone(r);
 assert(reports.retainedExecutionReserveContinuation(assignment,r,tracker));
 assert.equal(reports.retainedExecutionReserveContinuation(assignment,r,tracker),null);
 assert(reports.retainedExecutionReserveContinuation(assignment,receipt(29000),tracker));
 assert.equal(reports.retainedExecutionReserveContinuation(assignment,receipt(25000),tracker),null);
 assert(reports.retainedExecutionReserveContinuation(assignment,r,{}));
 assert.deepEqual(r,before);
});
test('no warnings invent zero from unknown usage, grant work on a hold, or accept a foreign binding',()=>{
 for(const reason of ['paused','pending_usage','unsettled_model_effect','budget_exhausted']){
  const r=receipt();Object.assign(r.execution_continuation,{state:'hold',reason});
  assert.equal(reports.retainedExecutionReserveContinuation(assignment,r,{}),null);
 }
 const foreign=receipt();foreign.execution_continuation.binding.run_id='foreign';
 assert.throws(()=>reports.retainedExecutionReserveContinuation(assignment,foreign,{}),/binding_mismatch/);
 const malformed=receipt();malformed.execution_continuation.remaining_resources.active_execution_ms.remaining=-1;
 assert.throws(()=>reports.retainedExecutionReserveContinuation(assignment,malformed,{}),/reserve_invalid/);
 const unknown=receipt();unknown.execution_continuation.remaining_resources.active_execution_ms={used:null,remaining:null,limit:10337914};
 assert.match(reports.retainedExecutionReserveContinuation(assignment,unknown,{}).content[0].text,/"active_execution_ms":null/);
 const notNear=receipt();notNear.execution_continuation.checkpoint_recommended=false;
 assert.equal(reports.retainedExecutionReserveContinuation(assignment,notNear,{}),null);
});
