import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {executionFailureMessage} from '../target_resolution_failure.mjs';
import test from 'node:test';
import {AssignmentVerificationPending, computerCompletionPresentation} from '../computer_completion_presentation.mjs';
import {stoppedWorkReturnMessage} from '../stopped_work_return.mjs';
import {describeComputerRunFailure} from '../native_interactive_placement.mjs';
const source = readFileSync(process.env.OPERATOR_COMPLETION_TEST_SOURCE || new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const marker = source.indexOf('    let completionPersistenceError =');
const begin = marker >= 0 ? marker : source.indexOf('    if (computerState.sidecarAssignment)', source.indexOf('    const finalText = phase4CBPdfTransport'));
const end = source.indexOf('\n  } catch (error) {', begin);
assert.ok(begin > 0 && end > begin);
async function finish(failure, beforeSettlement, settlement = null, assignment = { goal_id: 'retained-pdf-assignment' }) {
  const state = { sidecarAssignment: assignment, running: true, error: '',
    activeAbortController: new AbortController(), pendingClarification: null };
  const messages = [], events = [], dispositions = [], progress = [];
  let attempts = 0;
  await runInNewContext('(async () => {' + source.slice(begin, end) + '})()', {
    computerState: state, finalText: 'Verified PDF: 1 page, 3678041 bytes.',
    settleSidecarComputerAssignment: async () => { attempts++; await beforeSettlement?.({ state, progress }); if (failure) throw failure; return settlement; },
    AssignmentVerificationPending, computerCompletionPresentation,
    computerRunTestHooks: {}, retainedOwnerWritingMessage:async()=>null, stoppedWorkReturnMessage, readBackendJson: () => { throw Error('must not replay work'); },
    trimToolText: value => value, addComputerEvent: text => events.push(text),
    updateComputerProgress: value => progress.push(value), addComputerMessage: (role, text) => messages.push({ role, text }),
    certifiedReadRun: { generation: 1, run: { dispatched: true, outcomeUnknown: false } },
    finishComputerRunCertifiedRead: (_, value) => dispositions.push(value)
  });
  return { state, messages, events, dispositions, progress, attempts };
}
test('retained active-V2 settlement failure keeps the answer but never displays completed', async () => {
  const result = await finish(Error('Assignment Kernel V2 has not established an authoritative outcome; Sidecar prose cannot settle it.'));
  assert.equal(result.state.running, false);
  assert.equal(result.attempts, 1, 'settlement failure must not replay work or retry blindly');
  assert.equal(result.progress.at(-1).phase, 'failed');
  assert.match(result.state.error, /task status could not be confirmed/);
  assert.equal(result.messages[0].text, 'Verified PDF: 1 page, 3678041 bytes.');
  assert.equal(result.messages[1].role, 'error');
  assert.equal(result.dispositions[0].kind, 'explicit_failure');
  assert.equal(result.dispositions[0].outcomeUnknown, false, 'persistence failure does not invent an unknown model effect');
});
test('successful authoritative persistence retains normal completed presentation', async () => {
  const result = await finish();
  assert.equal(result.progress.at(-1).phase, 'completed');
  assert.equal(result.state.error, '');
  assert.equal(result.messages.length, 1);
  assert.equal(result.dispositions[0].kind, 'success');
});

test('normal transport failure and explicit user stop retain actual bound saved followups',async()=>{
 const assignment={kernel_version:2,goal_id:'assignment',run_id:'run',generation:1},settlement={kernel_version:2,work_return:{assignment_id:'assignment',run_id:'run',generation:1,status:'blocked',deviations_or_open_items:['Q5: Confirm the intended service equipment; source absence is not established.']}};
 const result=await finish(null,null,settlement,assignment);
 assert.equal(result.progress.at(-1).phase,'blocked');assert.match(result.messages[0].text,/Q5: Confirm/);
 assert.match(result.messages[0].text,/Verified PDF/,'existing response is retained alongside the canonical failure qualification');
 const catchStart=end+'\n  } catch (error) {'.length,catchEnd=source.indexOf('\n  }\n  });\n});',catchStart),messages=[],progress=[];
 await runInNewContext('(async()=>{'+source.slice(catchStart,catchEnd)+'})()',{
  Error,error:new Error('Stopped by user.'),computerState:{sidecarAssignment:assignment,running:true,stopRequested:true,activeAbortController:new AbortController()},
  startupAbortController:new AbortController(),retainedDirection:null,assignmentExecutionStarted:true,describeComputerRunFailure,
  settleSidecarComputerAssignment:async()=>settlement,computerRunTestHooks:{},retainedOwnerWritingMessage:async()=>null,readBackendJson:()=>{throw Error('no new dispatch');},trimToolText:v=>v,
  addComputerEvent:()=>{},updateComputerProgress:v=>progress.push(v),addComputerMessage:(role,text)=>messages.push({role,text}),
  stoppedWorkReturnMessage,res:{headersSent:true},certifiedReadRun:{generation:1,run:{dispatched:true,outcomeUnknown:false}},finishComputerRunCertifiedRead:()=>{}
 });
 assert.equal(progress.at(-1).phase,'stopped');assert.match(messages[0].text,/Q5: Confirm/);assert.match(messages[0].text,/stopped before completion/);
});

test('a pending native readiness check remains verifying until settlement resolves', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { entered = resolve; });
  let pending;
  const run = finish(Error('desktop_handoff_native_readiness_unproven'), async value => {
    pending = value;
    entered();
    await gate;
  });
  await arrived;
  assert.equal(pending.state.running, true);
  assert.equal(pending.progress.at(-1).phase, 'verifying');
  assert.equal(pending.progress.at(-1).completedAt, '');
  assert.equal(pending.progress.some(p => p.phase === 'completed'), false);
  release();
  const result = await run;
  assert.equal(result.progress.at(-1).phase, 'failed');
  assert.equal(result.attempts, 1);
});

test('provider and bounded tool return paths cannot publish terminal progress', async () => {
  const start = source.indexOf('async function executeComputerLoop(');
  const end = source.indexOf('async function executeComputerLoopForTest(', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /phase:\s*["']completed["']/);
});

test('retained active work is pending verification, never a fabricated execution failure or completion', async () => {
  const workReturn = {status:'active',assignment_id:'retained-pdf-assignment',run_id:'run',generation:1};
  const result = await finish(new AssignmentVerificationPending(workReturn));
  assert.equal(result.progress.at(-1).phase, 'verification_pending');
  assert.equal(result.state.error, '');
  assert.equal(result.attempts, 1);
  assert.equal(result.state.sidecarAssignment.goal_id, workReturn.assignment_id);
  assert.equal(result.messages.length, 1);
  assert.equal(result.dispositions[0].kind, 'pending_verification');
  assert.match(result.progress.at(-1).currentAction, /verification is still pending/);
  assert.doesNotMatch(result.progress.at(-1).currentAction, /completion verified/);
});

for (const [status, phase, disposition] of [
  ['awaiting_user_review','awaiting_user_review','pending_verification'],
  ['awaiting_user_input','awaiting_user_input','pending_verification'],
  ['failed','failed','explicit_failure'],['blocked','blocked','explicit_failure'],
  ['complete','completed','success'],['verified_noop','completed','success'],
  ['complete_with_issues','complete_with_issues','success']
]) test(`the outer run displays the actual canonical ${status} outcome`, async()=>{
  const result=await finish(null,null,{kernel_version:2,work_return:{status}});
  assert.equal(result.progress.at(-1).phase,phase);
  assert.equal(result.dispositions[0].kind,disposition);
  assert.equal(Boolean(result.state.error),disposition==='explicit_failure');
  assert.equal(result.attempts,1);
});

test('an untyped exception with the same pending message stays an error',async()=>{
  const result=await finish(Error(new AssignmentVerificationPending({status:'active'}).message));
  assert.equal(result.progress.at(-1).phase,'failed');
  assert.equal(result.dispositions[0].kind,'explicit_failure');
});

test('unknown or malformed canonical states cannot become completed presentation',()=>{
  for(const status of [undefined,'unexpected','__proto__','constructor'])
    assert.throws(()=>computerCompletionPresentation({kernel_version:2,work_return:{status}}),/unknown canonical/);
});

test('actual outer catch retains bound saved follow-ups and truthful failed progress without replay',async()=>{
 const catchStart=end+'\n  } catch (error) {'.length,catchEnd=source.indexOf('\n  }\n  });\n});',catchStart);
 assert(catchEnd>catchStart);const block=source.slice(catchStart,catchEnd);
 for(const variant of ['bound','foreign','transport','unknown']){
  const assignment={kernel_version:2,goal_id:'assignment',run_id:'run',generation:1};
  const value={kernel_version:2,work_return:{assignment_id:variant==='foreign'?'other':'assignment',run_id:'run',generation:1,status:'blocked',
   deviations_or_open_items:['Q1 · M100: What approved stair heating design applies?']}};
  const state={sidecarAssignment:assignment,running:true,stopRequested:false,error:'',activeAbortController:new AbortController()};
  const messages=[],progress=[],dispositions=[];let calls=0;
  await runInNewContext('(async()=>{'+block+'})()',{
   Error,error:new Error('external_provider_admission_denied:blocked:token_budget_exhausted'),computerState:state,
   startupAbortController:new AbortController(),retainedDirection:null,assignmentExecutionStarted:true,describeComputerRunFailure,
   settleSidecarComputerAssignment:async()=>{calls++;if(variant==='transport')throw new Error('unavailable');return value;},
   computerRunTestHooks:{},retainedOwnerWritingMessage:async()=>null,readBackendJson:()=>{throw new Error('no extra dispatch');},trimToolText:v=>v,
   addComputerEvent:()=>{},updateComputerProgress:v=>progress.push(v),addComputerMessage:(role,text)=>messages.push({role,text}),
   stoppedWorkReturnMessage,executionFailureMessage,res:{headersSent:true},certifiedReadRun:{generation:1,run:{dispatched:true,outcomeUnknown:variant==='unknown'}},
   finishComputerRunCertifiedRead:(_,v)=>dispositions.push(v)
  });
  assert.equal(calls,1);assert.equal(state.running,false);assert.equal(progress.at(-1).phase,'failed');
  assert.match(state.error,/token_budget_exhausted/);assert.equal(dispositions[0].kind,'explicit_failure');
  assert.equal(dispositions[0].outcomeUnknown,variant==='unknown');
  if(['bound','unknown'].includes(variant))assert.match(messages[0].text,/Q1.*approved stair heating/);
  else {assert.match(messages[0].text,/Run failed/);assert.doesNotMatch(messages[0].text,/Q1/);}
 }
});
