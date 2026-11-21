import test from 'node:test';
import assert from 'node:assert/strict';
import {providerTokenRunway} from '../src/assignments/provider_token_runway.js';
const binding={assignment_id:'task',run_id:'run',session_id:'session',generation:1,principal_id:'local',document_fingerprint:'doc'};
const now='2026-11-21T19:40:27Z';
const call=(n:number,tokens:number)=>({binding,completed_at:`2026-11-21T19:40:${String(n).padStart(2,'0')}Z`,usage:{total_tokens:tokens}});
test('recent cumulative token reserve translates to estimated calls, not nominal call allowance',()=>{
 const calls=[call(1,179962),call(2,204310),call(3,227767)];
 const before=structuredClone(calls);
 assert.deepEqual(providerTokenRunway(calls,binding,2_208_575,now),{
  basis:'largest_of_last_eight_completed_calls',sample_count:3,tokens_per_call:227767,estimated_calls_remaining:9,
  advisory_only:true
 });
 assert.equal(providerTokenRunway(calls,binding,455533,now)?.estimated_calls_remaining,1);
 assert.deepEqual(calls,before);
});
test('unknown usage, zero samples and stale or foreign samples do not invent available calls',()=>{
 assert.equal(providerTokenRunway([],binding,900000,now),null);
 assert.equal(providerTokenRunway([{...call(1,1),usage:undefined}],binding,900000,now),null);
 assert.equal(providerTokenRunway([call(1,0)],binding,900000,now),null);
 assert.equal(providerTokenRunway([call(1,20)],binding,-1,now),null);
 const foreign={...call(1,999999),binding:{...binding,run_id:'other'}};
 const future={...call(1,999999),completed_at:'2026-11-22T00:00:00Z'};
 assert.equal(providerTokenRunway([call(1,100),foreign,future],binding,450,now)?.estimated_calls_remaining,4);
});
test('last eight by completion time avoid lifetime maximum while keeping recent large calls',()=>{
 const calls=Array.from({length:9},(_,i)=>call(i+1,i===0?1_000_000:100+i));
 assert.equal(providerTokenRunway(calls.reverse(),binding,1080,now)?.tokens_per_call,108);
 assert.equal(providerTokenRunway(calls,binding,1080,now)?.sample_count,8);
});
