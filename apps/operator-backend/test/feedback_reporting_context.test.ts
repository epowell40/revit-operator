import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {appendMessage} from '../src/session_store.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
import {buildDevHandoff} from '../src/feedback/dev_handoff.js';
import {appendFeedbackAndMaybePromote} from '../src/feedback/feedback_store.js';
import {feedbackRuntimeDiagnostic} from '../src/feedback/runtime_diagnostic.js';
import {fingerprintFeedbackImprovementJob} from '../src/improvement/job_worker.js';
import {appendEvent} from '../src/memory/sqlite_store.js';
import {createGoal} from '../src/goals/service.js';
import {createAssignmentKernelForGoalV2} from '../src/assignments/assignment_kernel_v2_factory.js';
import {runWithRequestContext} from '../src/request_context.js';
import {createOperatorBackendAuth} from '../src/operator_backend_auth.js';
import {feedbackSetupDiagnostic} from '../src/feedback/setup_diagnostic.js';

function fixture(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-context-')),prior=process.env.OPERATOR_WORKSPACE_ROOT;process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{__closeForTests();if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('feedback-context-'));fs.rmSync(root,{recursive:true,force:true});});return root;}
const diagnostic={schema:'operator.feedback-runtime-diagnostic.v1',source:'operator_desktop',session_id:'own',error:'Canonical Assignment run binding was not returned by the backend; refusing unbound outer execution.',phase:'failed',user_request:'Use the text computer use test.',assignment_id:'task',run_id:'run',generation:1};

test('cold setup failure feedback retains the original human request, stage and bound cause before a provider starts',async t=>{
 fixture(t);await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth('shared_token','fixture-only')},async()=>{
  const source='Underline the new equipment tags on E101.';
  appendMessage('own',{role:'user',text:source},{display:{message_id:'human',text:source},pinGoal:false});
  appendMessage('own',{role:'user',text:'Internal helper instruction: inspect phase, family and tag scope.'},{pinGoal:false});
  const goal=createGoal({title:source,objective:source,acceptance_criteria:['Requested tag appearance checked.'],status:'active',related_session_id:'own',created_by:'fixture',work_budget:{source_user_request:source,requested_effect:'apply',document_fingerprint:'fixture-model'}});
  const binding=createAssignmentKernelForGoalV2({goal,run_id:'cold-run'});
  const d={schema:'operator.execution-setup-diagnostic.v1',message_id:'helper',phase:'runtime_setup',cause_code:'runtime-missing',message:'Revit tool runtime is not configured for this workspace.',
   provider_started:false,native_dispatch_this_request:false,assignment_id:goal.id,run_id:binding.run_id,generation:binding.generation};
  appendEvent('own','assistant','codex.execution.setup.error',d);
  const report=buildDevHandoff({session_id:'own',rating:'failed'});
  assert.equal(report.latest_user_request,source);assert.equal(report.setup_diagnostic?.cause_code,'runtime-missing');
  assert.equal(report.setup_diagnostic?.phase,'runtime_setup');assert.match(report.issue_digest[0].key,/SetupFailure:runtime_setup:runtime-missing/);
  assert(!JSON.stringify(report).includes('Internal helper instruction'));
  for(const change of [{run_id:'foreign'},{generation:2},{phase:'made_up'},{message:'x'.repeat(2001)},{provider_started:true}])
   assert.equal(feedbackSetupDiagnostic({...d,...change},'own',source),null);
  assert.equal(feedbackSetupDiagnostic(d,'foreign-session',source),null);assert.equal(feedbackSetupDiagnostic(d,'own','Another human request'),null);
 });
});
test('Sidecar failure feedback retains actual conversation and startup error without legacy turn logs',t=>{
 const root=fixture(t);
 appendMessage('own',{role:'user',text:'Draft a test message.'},{display:{message_id:'user-1',text:'Draft a test message.'},pinGoal:false});
 appendMessage('own',{role:'assistant',text:'What should the message say?'},{display:{message_id:'answer-1',text:'What should the message say?'},pinGoal:false});
 appendMessage('own',{role:'user',text:'INTERNAL HELPER INSTRUCTION'},{pinGoal:false});
 appendMessage('foreign',{role:'user',text:'UNRELATED CONVERSATION'},{display:{message_id:'foreign',text:'UNRELATED CONVERSATION'},pinGoal:false});
 const saved=appendFeedbackAndMaybePromote({session_id:'own',rating:'failed',runtime_diagnostic:diagnostic});
 assert.equal(saved.dev_handoff.latest_user_request,diagnostic.user_request);assert.equal(saved.dev_handoff.latest_assistant_response,'What should the message say?');
 assert.equal(saved.dev_handoff.runtime_diagnostic?.error,diagnostic.error);assert.match(saved.dev_handoff.issue_digest[0].key,/SidecarRuntimeFailure:/);
 assert.equal(saved.dev_handoff.issue_digest[0].sample,diagnostic.error);assert(!JSON.stringify(saved.dev_handoff).includes('INTERNAL HELPER'));assert(!JSON.stringify(saved.dev_handoff).includes('UNRELATED'));
 const stored=JSON.parse(fs.readFileSync(path.join(root,'feedback/events.jsonl'),'utf8').trim());assert.equal(stored.runtime_diagnostic.error,diagnostic.error);
 assert(!('verified'in stored.runtime_diagnostic));
});
test('integral feedback uses same-session visible history rather than a helper prompt',t=>{
 const root=fixture(t),run=path.join(root,'runs/sessions/own');fs.mkdirSync(run,{recursive:true});fs.writeFileSync(path.join(run,'request_log.jsonl'),JSON.stringify({kind:'user.turn',user_text:'Internal delegated subtask'})+'\n');
 appendMessage('own',{role:'user',text:'The actual human request.'},{display:{message_id:'human',text:'The actual human request.'},pinGoal:false});
 const report=buildDevHandoff({session_id:'own',rating:'failed'});assert.equal(report.latest_user_request,'The actual human request.');assert(!JSON.stringify(report).includes('delegated subtask'));
});
test('foreign-session and forged authority diagnostics cannot enter the saved feedback',t=>{
 fixture(t);appendMessage('own',{role:'user',text:'Own request.'},{display:{message_id:'own',text:'Own request.'},pinGoal:false});
 for(const bad of [{...diagnostic,session_id:'foreign'}, {...diagnostic,verified:true},{...diagnostic,generation:0},{...diagnostic,error:'x'.repeat(2001)}]){
  assert.equal(feedbackRuntimeDiagnostic(bad,'own'),null);const report=buildDevHandoff({session_id:'own',rating:'failed',runtime_diagnostic:bad});
  assert.equal(report.runtime_diagnostic,undefined);assert.equal(report.latest_user_request,'Own request.');
 }
});
test('older native clients still retain the legacy run-bundle conversation',t=>{
 const root=fixture(t),run=path.join(root,'runs/sessions/old');fs.mkdirSync(run,{recursive:true});
 fs.writeFileSync(path.join(run,'request_log.jsonl'),JSON.stringify({kind:'user.turn',user_text:'Fix the schedule.'})+'\n');
 fs.writeFileSync(path.join(run,'agent_log.jsonl'),JSON.stringify({kind:'assistant.turn',text:'The native write failed.',message_id:'reply'})+'\n');
 const r=buildDevHandoff({session_id:'old',rating:'failed'});assert.equal(r.latest_user_request,'Fix the schedule.');assert.equal(r.latest_assistant_response,'The native write failed.');
});
test('empty feedback only deduplicates within its own conversation; meaningful reports keep their prior fingerprint',()=>{
 const base={rating:'failed',note:'',latest_user_request:'',issue_keys:[]};
 const a=fingerprintFeedbackImprovementJob({...base,session_id:'a'}),b=fingerprintFeedbackImprovementJob({...base,session_id:'b'});
 assert.notEqual(a,b);assert.notEqual(a,'3c73e1d6d2c328e6abfd');assert.equal(a,fingerprintFeedbackImprovementJob({...base,session_id:'a'}));
 assert.throws(()=>fingerprintFeedbackImprovementJob(base),/session identity/);
 assert.equal(fingerprintFeedbackImprovementJob({...base,session_id:'a',note:'Same failure'}),fingerprintFeedbackImprovementJob({...base,session_id:'b',note:'Same failure'}));
});
