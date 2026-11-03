import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {createFeedbackGitHubIssue} from '../src/feedback/github_issue.js';
import {buildDevHandoff} from '../src/feedback/dev_handoff.js';
import {__closeForTests} from '../src/memory/sqlite_store.js';
function fixture(t:test.TestContext){const root=fs.mkdtempSync(path.join(os.tmpdir(),'feedback-github-context-'));
 const env={OPERATOR_WORKSPACE_ROOT:root,OPERATOR_FEEDBACK_GITHUB_ISSUES_ENABLED:'1',OPERATOR_FEEDBACK_GITHUB_TOKEN:'fixture-not-a-secret',OPERATOR_FEEDBACK_GITHUB_REPO:'fixture/private-project'};
 const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),fetch=globalThis.fetch;Object.assign(process.env,env);
 const bodies:any[]=[];globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));const n=100+bodies.length;return new Response(JSON.stringify({number:n,html_url:`https://github.com/fixture/private-project/issues/${n}`}),{status:201});};
 t.after(()=>{__closeForTests();globalThis.fetch=fetch;for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('feedback-github-context-'));fs.rmSync(root,{recursive:true,force:true});});return {root,bodies};}
test('retained old empty report cannot suppress a new session, and duplicate reports return the real issue link',async t=>{
 const {root,bodies}=fixture(t);fs.mkdirSync(path.join(root,'feedback'),{recursive:true});fs.writeFileSync(path.join(root,'feedback/github_issues.jsonl'),JSON.stringify({repo:'fixture/private-project',fingerprint:'3c73e1d6d2c328e6abfd',issue_number:508,issue_url:'https://github.com/fixture/private-project/issues/508'})+'\n');
 const first=await createFeedbackGitHubIssue({session_id:'first',rating:'failed'}),second=await createFeedbackGitHubIssue({session_id:'second',rating:'failed'});
 assert(first.ok&&second.ok);assert.notEqual(first.fingerprint,second.fingerprint);assert.equal(bodies.length,2);
 const again=await createFeedbackGitHubIssue({session_id:'second',rating:'failed'});assert.equal(again.skipped,'duplicate');assert.equal(again.issue_number,second.issue_number);assert.equal(again.issue_url,second.issue_url);assert.equal(bodies.length,2);
 process.env.OPERATOR_FEEDBACK_GITHUB_REPO='fixture/another-project';assert((await createFeedbackGitHubIssue({session_id:'second',rating:'failed'})).ok);assert.equal(bodies.length,3);
});
test('GitHub report includes the actual failed follow-up and explicitly unverified relay error, not generic recommendations alone',async t=>{
 const {bodies}=fixture(t),runtime={schema:'operator.feedback-runtime-diagnostic.v1',source:'operator_desktop',session_id:'own',error:'Canonical Assignment run binding was not returned.',user_request:'Use the text computer use test.',phase:'failed'};
 const handoff=buildDevHandoff({session_id:'own',rating:'failed',runtime_diagnostic:runtime});
 assert((await createFeedbackGitHubIssue({session_id:'own',rating:'failed',dev_handoff:handoff})).ok);
 assert.match(bodies[0].title,/Use the text computer use test/);assert.match(bodies[0].body,/Canonical Assignment run binding/);assert.match(bodies[0].body,/reported, not proof of model outcome/);
});

test('a saved setup diagnostic includes its specific cause and binding without claiming earlier model effects',async t=>{
 const {bodies}=fixture(t),handoff=buildDevHandoff({session_id:'setup',rating:'failed'});
 handoff.setup_diagnostic={schema:'operator.execution-setup-diagnostic.v1',message_id:'request',phase:'runtime_setup',cause_code:'runtime-missing',
  message:'Revit tool runtime was unavailable before provider setup.',assignment_id:'task',run_id:'run',generation:1,provider_started:false,native_dispatch_this_request:false};
 assert((await createFeedbackGitHubIssue({session_id:'setup',rating:'failed',dev_handoff:handoff})).ok);
 assert.match(bodies[0].body,/cause: runtime-missing/);assert.match(bodies[0].body,/stage: runtime_setup/);
 assert.match(bodies[0].body,/not proof of earlier model effects/);assert.match(bodies[0].body,/task \/ run \/ 1/);
});
