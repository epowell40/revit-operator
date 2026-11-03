import test from 'node:test';import assert from 'node:assert/strict';
import {stoppedWorkReturnMessage} from './stopped_work_return.mjs';
const binding={kernel_version:2,goal_id:'assignment',run_id:'run',generation:1};
const settlement={kernel_version:2,work_return:{assignment_id:'assignment',run_id:'run',generation:1,status:'blocked',
 deviations_or_open_items:['Q1 · M100 · Stairs: Which approved heating design applies?','Q2 · M202: Internal proof fault, not a missing human answer.']}};

test('canonical native stopped summary and saved path survive the actual shared failure presenter',()=>{
 const b={...binding,session_id:'session'},s=structuredClone(settlement);s.work_return.work_return_id='wr1_test';s.work_return.work_return_hash='sha256:'+'a'.repeat(64);
 s.terminal_result_presentation={binding:{assignment_id:'assignment',run_id:'run',generation:1,session_id:'session'},work_return_id:s.work_return.work_return_id,work_return_hash:s.work_return.work_return_hash,
  terminal_result_v2:{schema:'revit-operator.terminal-result/v2',assignment_id:'assignment',terminal_snapshot_version:24,outcome:'blocked',requested_effect:'apply',result_summary:'The requested work did not complete.\nVerified in Revit: 1 text note.\nSaved file: C:\\workspace\\Result.rvt\nFinal content verification is pending.',supporting_observation_ids:['native-read'],evidence_refs:['evidence:native-read'],warnings:[]}};
 const before=JSON.stringify(s),text=stoppedWorkReturnMessage(s,b);assert.match(text,/Verified in Revit: 1 text note/);assert.match(text,/C:\\workspace\\Result\.rvt/);assert.match(text,/verification is pending/);assert.match(text,/Q1.*Which approved heating design/);assert.equal(JSON.stringify(s),before);
 for(const patch of ['run','generation','session','id','hash','outcome','schema','long']){const bad=structuredClone(s),p=bad.terminal_result_presentation;
  if(patch==='run')p.binding.run_id='foreign';if(patch==='generation')p.binding.generation=2;if(patch==='session')p.binding.session_id='foreign';if(patch==='id')p.work_return_id='old';if(patch==='hash')p.work_return_hash='sha256:'+'b'.repeat(64);
  if(patch==='outcome')p.terminal_result_v2.outcome='complete';if(patch==='schema')p.terminal_result_v2.schema='other';if(patch==='long')p.terminal_result_v2.result_summary='Unverified claim '.repeat(10000);
  assert(!stoppedWorkReturnMessage(bad,b)?.includes('C:\\workspace\\Result.rvt'),patch+' must not expose a foreign/stale/unbounded result');
 }
});
test('bound blocked/failed work returns keep whole follow-ups while preserving failure meaning',()=>{
 for(const status of ['blocked','failed']){
  const s=structuredClone(settlement);s.work_return.status=status;const before=JSON.stringify(s),text=stoppedWorkReturnMessage(s,binding);
  assert.match(text,/stopped before completion/);assert.match(text,/Q1.*Which approved heating design/);
  assert.match(text,/Q2.*not a missing human answer/);assert.match(text,/not verified results or supplied answers/);
  assert.match(text,/Internal tool follow-ups remain Operator work; only actual engineering decisions need your answer/);
  assert.match(text,/Saved follow-ups and open work/);assert.doesNotMatch(text,/Saved questions and open work/);
  assert.equal(JSON.stringify(s),before);assert.equal(stoppedWorkReturnMessage(JSON.parse(before),binding),text);
 }
});
test('foreign, stale, nonterminal and malformed returns cannot expose another task follow-up',()=>{
 for(const patch of [{assignment_id:'other'},{run_id:'old'},{generation:2},{generation:0},{status:'active'},
  {status:'awaiting_user_input'},{status:'complete'},{status:'constructor'},{deviations_or_open_items:[]}])
  assert.equal(stoppedWorkReturnMessage({...settlement,work_return:{...settlement.work_return,...patch}},binding),null);
 assert.equal(stoppedWorkReturnMessage(null,binding),null);assert.equal(stoppedWorkReturnMessage(settlement,{...binding,kernel_version:1}),null);
});
test('bounded presentation never cuts a question qualification or silently drops remaining follow-ups',()=>{
 const text='Question with its important final qualification. '.repeat(20);
 const s={...settlement,work_return:{...settlement.work_return,deviations_or_open_items:Array.from({length:30},(_,i)=>i+': '+text)}};
 const shown=stoppedWorkReturnMessage(s,binding);assert.match(shown,/18 more open items remain in Tasks/);
 assert(shown.includes('11: '+text));assert(!shown.includes('12: '+text));assert(shown.length<24000);
});
