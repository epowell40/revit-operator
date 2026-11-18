import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createBrowserAssetFreshness } from '../browser_asset_freshness.js';
import { assertLoadedBrowserFresh } from '../public/browser_asset_freshness_ui.js';
import { beginComposerSend } from '../public/composer_intake.mjs';
async function assets(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'operator-browser-freshness-')); t.after(() => rm(root, { recursive: true, force: true })); await writeFile(path.join(root, 'app.js'), 'const application = 1;'); return root; }
function request(service, pathname, headers = {}, method = 'POST', body = {}) {
  let effects = 0; const response = { statusCode: 200, setHeader() {}, type() { return this; }, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; }, end(body) { this.body = body; }, json(body) { this.body = body; } };
  service.middleware({ method, path: pathname, body, get: name => headers[name] }, response, () => effects++);
  return { response, effects };
}
test('served entry carries its own identity; stale restart and changed assets cannot dispatch work', async t => {
  const root = await assets(t); const first = createBrowserAssetFreshness(root);
  const entry = request(first, '/app.js', {}, 'GET').response.body;
  const loaded = JSON.parse(entry.match(/LOADED_BROWSER_ASSET_IDENTITY = ("[a-f0-9]+")/)[1]);
  assert.equal(loaded, first.snapshot().identity);
  for (const route of ['/api/chat','/api/chat/stream','/api/computer/run','/api/computer/interject','/api/assignment-workspace/v2/steer']) {
    assert.equal(request(first, route, { origin: 'http://127.0.0.1', 'x-operator-browser-identity': loaded }).effects, 1);
    assert.equal(request(first, route, { origin: 'http://127.0.0.1' }).effects, 0, 'old browser missing identity rejected');
    const restarted = createBrowserAssetFreshness(root);
    const rejected = request(restarted, route, { origin: 'http://127.0.0.1', 'x-operator-browser-identity': loaded });
    assert.equal(rejected.effects, 0); assert.equal(rejected.response.statusCode, 409);
    assert.equal(rejected.response.body.request_dispatched, false);
  }
  await writeFile(path.join(root,'helper.mjs'),'export const changed = true;');
  assert.equal(request(first, '/api/computer/run', { origin: 'http://127.0.0.1', 'x-operator-browser-identity': loaded }).effects, 0);
  assert.equal(request(first, '/api/computer/run').effects, 1, 'native harness remains independently admitted');
});
test('browser preflight rejects stale identity and accepts a matching loaded entry', async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ identity: 'current' }) });
  await assert.rejects(assertLoadedBrowserFresh('old',fetcher), { code: 'SIDECAR_BROWSER_STALE', request_dispatched: false });
  await assertLoadedBrowserFresh('current',fetcher);
});
test('stale Send preserves draft, attachments and assignment before optimistic UI or network work', async () => {
  const source = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const start = source.indexOf('elements.chatForm.addEventListener("submit", async (event) => {');
  const end = source.indexOf('\n});',start);
  assert.ok(start > 0 && end > start);
  let handler, status; let effects=0;
  const state = { resetting:false, pendingAttachments:[{filename:'drawing.pdf',sizeBytes:134}],
    attachmentLimits:{maxTotalBytes:2048},activeGoalId:'assignment-kept' };
  const elements = { chatForm:{addEventListener(_event,work){handler=work;}}, promptInput:{value:'Do the next room'} };
  const directionStart=source.indexOf('function pausedTaskAcceptsDirection(');
  const directionPolicy=source.slice(directionStart,source.indexOf('\n}\n',directionStart)+2);
  const totalStart=source.indexOf('function assertAttachmentTotalSize(');
  assert.ok(totalStart >= 0);
  const totalCheck=source.slice(totalStart,source.indexOf('\n}\n',totalStart)+2);
  runInNewContext(totalCheck+'\n'+directionPolicy+'\n'+source.slice(start,end+4), { elements,state,beginComposerSend,selectedGoal:()=>null,updateControls(){},loadedBrowserIdentity:'old', assertLoadedBrowserFresh:async()=>{throw Object.assign(new Error('Refresh before sending'),{code:'SIDECAR_BROWSER_STALE'});}, persistComposerDraft:async()=>true,showStaleComposerNotice:async()=>{status='Refresh before sending';},setStatus: text=>{status=text;},createChatSubmission(){effects++;},clearChatComposerForSubmission(){effects++;},beginOptimisticChatSubmission(){effects++;},sendPrompt(){effects++;} });
  await handler({preventDefault(){}});
  assert.equal(effects,0); assert.equal(elements.promptInput.value,'Do the next room');
  assert.equal(state.pendingAttachments[0].filename,'drawing.pdf'); assert.equal(state.activeGoalId,'assignment-kept'); assert.match(status,/Refresh/);
});

test('a final admission stale response restores the draft without resubmission or assignment replacement', async () => {
  const source = await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const start = source.indexOf('function handleChatSubmissionFailure(error, submission) {');
  const end = source.indexOf('\n}\n',start);
  // Normalize CRLF before extracting the standalone production handler.
  const normalized = source.replace(/\r\n/g,'\n');
  const from = normalized.indexOf('function handleChatSubmissionFailure(error, submission) {');
  const until = normalized.indexOf('\n}\n',from);
  const state = { pendingComputerUserMessages:[{id:'send-1'}], activeGoalId:'keep-task' };
  let restored=0, status, streaming;
  const handle = runInNewContext(normalized.slice(from,until+2)+'; handleChatSubmissionFailure', {state,STALE_BROWSER_MESSAGE:'Refresh before sending',restoreChatSubmissionInput(){restored++;},showStaleComposerNotice:async()=>{status='Refresh before sending';},setStatus(text){status=text;},setStreaming(value){streaming=value;}});
  handle({code:'SIDECAR_BROWSER_STALE',request_dispatched:false},{id:'send-1',transportStarted:true,mode:'computer-run'});
  assert.equal(restored,1);assert.equal(state.activeGoalId,'keep-task');assert.equal(state.pendingComputerUserMessages.length,0);assert.equal(streaming,false);assert.match(status,/Refresh/);
});


test('stale pages can stop, pause, cancel and recover; only resume is freshness fenced', async t => {
  const service = createBrowserAssetFreshness(await assets(t));
  const stale = { origin: 'http://127.0.0.1', 'x-operator-browser-identity': 'old' };
  for (const route of ['/api/chat/stop','/api/computer/stop','/api/batch/jobs/job/cancel','/api/assignment-workspace/v2/recover-completions']) {
    assert.equal(request(service, route, stale).effects, 1, route);
  }
  for (const action of ['pause','cancel']) {
    assert.equal(request(service, '/api/assignment-workspace/v2/control', stale, 'POST', {action}).effects, 1, action);
  }
  assert.equal(request(service, '/api/assignment-workspace/v2/control', stale, 'POST', {action:'resume'}).effects, 0);
  const current = {...stale, 'x-operator-browser-identity':service.snapshot().identity};
  assert.equal(request(service, '/api/assignment-workspace/v2/control', current, 'POST', {action:'resume'}).effects, 1);
});

test('stale resume preflight leaves canonical control and assignment untouched', async () => {
  const source = (await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const start=source.indexOf('async function runCanonicalGoalControl(');
  const end=source.indexOf('\n}\n',start);
  assert.ok(start >= 0 && end > start, 'the actual control function must be extracted');
  let effects=0, notices=0;
  const state={sessionId:'session',streaming:false};
  const goal={_bindingV2:{session_id:'session'},_canResume:true};
  const control=runInNewContext(source.slice(start,end+2)+'; runCanonicalGoalControl', {state,crypto:webcrypto,loadedBrowserIdentity:'old',assertLoadedBrowserFresh:async()=>{throw Object.assign(new Error('Refresh'),{code:'SIDECAR_BROWSER_STALE'});},showStaleComposerNotice:async()=>{notices++;},fetchJson(){effects++;},syncGoals(){effects++;},resumeCanonicalAssignment(){effects++;}});
  await control(goal,'resume');
  assert.equal(notices,1);assert.equal(effects,0);assert.equal(state.sessionId,'session');assert.equal(goal._canResume,true);
  assert.equal(state.assignmentResumePending,false,'stale freshness rejection releases only its pending Resume ownership');
});

test('a resume rejected after freshness preflight shows recovery without losing a saved clarification', async () => {
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const start=source.indexOf('async function runCanonicalGoalControl('),end=source.indexOf('\n}\n',start);
  let notices=0, requests=0, resumed=0;
  const state={sessionId:'session',streaming:false};
  const goal={_bindingV2:{session_id:'session',assignment_id:'same-task',run_id:'same-run',generation:1},_canResume:true,
    savedAnswer:'450 supply, 450 return, 0 exhaust'};
  const control=runInNewContext(source.slice(start,end+2)+'; runCanonicalGoalControl',{
    state,crypto:{randomUUID:()=> 'test-command'},loadedBrowserIdentity:'once-current',assertLoadedBrowserFresh:async()=>{},showStaleComposerNotice:async()=>{notices++;},
    fetchJson:async()=>{requests++;throw Object.assign(new Error('Restarted before admission'),{code:'SIDECAR_BROWSER_STALE'});},
    syncGoals:async()=>{throw Error('must not project rejected control');},resumeCanonicalAssignment:async()=>{resumed++;}
  });
  await control(goal,'resume');
  assert.equal(notices,1);assert.equal(requests,1);assert.equal(resumed,0);
  assert.equal(goal._bindingV2.assignment_id,'same-task');assert.equal(goal.savedAnswer,'450 supply, 450 return, 0 exhaust');
});
