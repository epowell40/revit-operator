import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { codexAssignmentTurnTimeLimits } from '../src/codex/assignment_timeout.js';
import { CodexTurnCompletions } from '../src/codex/turn_completions.js';

function fixture():any {
 const binding={assignment_id:'binder',run_id:'run',generation:1,session_id:'owner',principal_id:'local',document_fingerprint:'doc'};
 return {spec:{binding,created_at:'2026-10-12T04:40:00Z',requested_effect:'apply',execution_policy:{
  mode:'local_advisory_v1',selected_by:'trusted_local_host',session_id:'owner',document_fingerprint:'doc',max_turns:8,
  max_provider_calls:1088,max_operations:4352,max_total_tokens:136_000_000,max_wall_clock_ms:7_200_000,
  source_work_allowance:{mode:'marked_pdf_sheets_v1',units:17,sources:[{sha256:'a'.repeat(64),page_count:26,
    sheets:Array.from({length:13},(_,i)=>({page:i+1,comments:i<4?6:1,units:i<4?2:1}))}]}
 }},current_binding:binding,outcome:'active',terminal:false,unresolved_unknown_operation_ids:[],
 operations:{},provider_calls:{},observations:{}};
}

test('marked-sheet allowance reaches provider wait without a hidden thirty-minute ceiling',()=>{
 const snapshot=fixture(),before=JSON.stringify(snapshot);
 assert.deepEqual(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T04:40:00Z'}),{timeoutMs:600_000,maxWallMs:7_200_000});
 snapshot.provider_calls.first={admitted_at:'2026-10-12T04:40:00Z',completed_at:'2026-10-12T05:10:00Z'};
 assert.equal(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T05:10:00Z'}).maxWallMs,5_400_000);
 assert.equal(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T05:10:00Z',configuredTimeout:'60000'}).maxWallMs,60_000);
 delete snapshot.provider_calls.first;assert.equal(JSON.stringify(snapshot),before,'projection changes neither history nor policy');
 assert.equal(codexAssignmentTurnTimeLimits({now:'2026-10-12T04:40:00Z'}).maxWallMs,1_800_000,'unbound turns keep ordinary limit');
});

test('exact retained pre-timeout binder remains within its frozen host allowance',()=>{
 const vector=JSON.parse(fs.readFileSync('test/fixtures/marked-binder-provider-timeout-05.json','utf8'));
 const before=JSON.stringify(vector.snapshot);
 const limits=codexAssignmentTurnTimeLimits({snapshot:vector.snapshot,now:vector.at});
 assert.equal(vector.snapshot.spec.execution_policy.source_work_allowance.units,17);
 assert.equal(Object.keys(vector.snapshot.provider_calls).length,249);
 assert.equal(Object.keys(vector.snapshot.operations).length,232);
 assert(limits.maxWallMs>90*60_000 && limits.maxWallMs<120*60_000);
 assert.equal(limits.timeoutMs,600_000);
 assert.equal(JSON.stringify(vector.snapshot),before,'failed run remains immutable evidence');
});

test('continuation and overlapping provider/native receipts charge original history once',()=>{
 const snapshot=fixture();
 snapshot.provider_calls.old={admitted_at:'2026-10-12T04:40:00Z',completed_at:'2026-10-12T05:10:00Z'};
 snapshot.operations.edit={opened_at:'2026-10-12T04:50:00Z',settled_at:'2026-10-12T05:00:00Z'};
 snapshot.provider_calls.active={admitted_at:'2026-10-12T05:20:00Z'};
 assert.equal(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T05:25:00Z'}).maxWallMs,5_100_000);
 assert.equal(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T06:50:00Z'}).maxWallMs,0);
 assert.equal(codexAssignmentTurnTimeLimits({snapshot,now:'invalid'}).maxWallMs,0);
});

test('paused, unknown, foreign or malformed policy cannot gain a provider time allowance',()=>{
 for(const mutate of [
  (s:any)=>s.outcome='blocked', (s:any)=>s.terminal=true,
  (s:any)=>s.execution_control={state:'paused'},(s:any)=>s.unresolved_unknown_operation_ids.push('uncertain'),
  (s:any)=>s.current_binding={...s.current_binding,session_id:'foreign'},
  (s:any)=>s.spec.execution_policy.max_wall_clock_ms=7_200_001,
  (s:any)=>s.spec.execution_policy.source_work_allowance.units=18
 ]){const snapshot=fixture();mutate(snapshot);assert.deepEqual(codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T04:40:00Z'}),{timeoutMs:0,maxWallMs:0});}
});

test('provider activity still cannot escape remaining wall, and abort still stops the wait',async()=>{
 const turns=new CodexTurnCompletions();const snapshot=fixture();
 snapshot.spec.execution_policy.max_wall_clock_ms=50;
 const limits=codexAssignmentTurnTimeLimits({snapshot,now:'2026-10-12T04:40:00Z'});
 const pending=turns.wait({threadId:'binder',turnId:'work',...limits});
 const failed=assert.rejects(pending,/maximum duration|inactivity/);
 turns.observeProgress('binder','work');await failed;
 const abort=new AbortController();const waiting=turns.wait({threadId:'binder',turnId:'next',timeoutMs:600_000,maxWallMs:7_200_000,abortSignal:abort.signal});
 const cancelled=assert.rejects(waiting,/aborted/);abort.abort();await cancelled;
});

test('production caller anchors deadline once and does not reset it on transport retry',()=>{
 const source=fs.readFileSync('src/brains/codex_brain.ts','utf8');
 assert.match(source,/const turnDeadlineMs = Date\.parse\(timeStartedAt\) \+ turnTransportMaxWallMs/);
 assert.match(source,/maxWallMs: Math\.max\(0, turnDeadlineMs - Date\.now\(\)\)/);
 assert.doesNotMatch(source,/maxWallMs: codexTurnTimeoutMs\(\)/);
 assert.match(source,/plannedReceiptSha256, turnTransportMaxWallMs \+ 60_000/);
 assert.match(source,/ttl_ms: turnTransportMaxWallMs \+ 60_000/);
 assert.equal((source.match(/const remainingWorkMs=createCodexAssignmentProgressTimeMonitor/g)??[]).length,1);
 assert.match(source,/remainingWorkMs\?\{remainingWorkMs\}:\{\}/);
 assert.match(source,/releaseStartedProviderTurn\(workTimeExpired\)/,'expired work must interrupt and drain before releasing native/auth leases');
});
