import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { beginComposerSend } from '../public/composer_intake.mjs';
import * as composerIntake from '../public/composer_intake.mjs';
import { rejectedChatSubmissionAdmission, mayRestoreRejectedChatSubmission } from '../public/chat_submission_admission.mjs';
const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const from = source.indexOf('elements.chatForm.addEventListener("submit", async (event) => {');
const until = source.indexOf('\n});', from);
const directionStart = source.indexOf('function pausedTaskAcceptsDirection(');
const directionPolicy = source.slice(directionStart, source.indexOf('\n}\n', directionStart) + 2);

const localExecutor = { schema: 'revit-operator.local-executor-capability/v1', source: 'backend_configuration',
  profile: 'codex_v2_advisory_v1', executor: 'codex', assignment_kernel: 2, execution_policy: 'local_advisory_v1' };
function appBody(name, isAsync = false) {
  const start = source.indexOf(`${isAsync ? 'async ' : ''}function ${name}(`);
  assert.ok(start >= 0); return source.slice(start, source.indexOf('\n}\n', start) + 2);
}
function routingHarness(overrides = {}) {
  const calls = [];
  const state = { computerUseAvailable: true, streaming: false, backendLocal: true, backendAuthMode: 'shared_token',
    backendAvailable: true, backendConfigStatus: 'ready', localExecutor, ...overrides };
  const context = { state, startsFreshComputerConversation: composerIntake.startsFreshComputerConversation, selectChatSubmissionMode: composerIntake.selectChatSubmissionMode, randomId: () => 'request-one',
    loadedBrowserIdentity: 'current', assertLoadedBrowserFresh: async () => {},
    beginOptimisticChatSubmission(submission) { submission.optimisticMessage = true; },
    sendComputerPrompt: async submission => calls.push({ owner: 'computer', submission }),
    sendBackendPrompt: async submission => calls.push({ owner: 'backend', submission }) };
  const create = runInNewContext(`${appBody('createChatSubmission')}; createChatSubmission`, context);
  context.createChatSubmission = create;
  const send = runInNewContext(`${appBody('sendPrompt', true)}; sendPrompt`, context);
  return { state, calls, create, send };
}

test('ordinary fresh local composer uses available computer owner and preserves PDF input', async () => {
  const h = routingHarness(); const attachment = { filename: 'record.pdf', dataBase64: 'source-pixels' };
  const submission = h.create('Draft the visible ductwork', [attachment]);
  assert.equal(submission.mode, 'computer-run'); attachment.filename = 'later.pdf';
  await h.send(submission);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].owner, 'computer');
  assert.equal(h.calls[0].submission.attachments[0].filename, 'record.pdf');
  assert.equal(h.calls[0].submission.attachments[0].dataBase64, 'source-pixels');
});

test('a file drop stages all references and keeps one submission and one task owner', async () => {
  const files = [{ name: 'Library example.pdf', type: 'application/pdf', size: 3 },
    { name: 'Hospital example.pdf', type: 'application/pdf', size: 3 }];
  const h = routingHarness();
  const handlers = new Map();
  const classes = new Set();
  const chatPane = {
    addEventListener: (type, listener) => handlers.set(type, listener),
    contains: () => false,
    classList: {
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: name => classes.delete(name)
    }
  };
  const elements = { chatPane, attachInput: { disabled: false } };
  const state = { ...h.state, sessionId: '', taskNavigationEpoch: 1,
    pendingAttachments: [], attachmentReadsPending: 0 };
  const firstHandlers = source.indexOf('elements.chatPane.addEventListener("dragover"');
  const lastHandlers = source.indexOf('elements.promptInput.addEventListener("paste"', firstHandlers);
  assert.ok(firstHandlers >= 0 && lastHandlers > firstHandlers);
  let reading;
  let persists = 0;
  const readGates = [Promise.resolve("data:application/pdf;base64,YWJj"), Promise.withResolvers()];
  let i = 0;
  const context = {
    state, elements, window: { addEventListener() {} }, composerDraftRevision: 0,
    renderAttachStrip() {}, updateControls() {}, setStatus() {}, renderMessages() {},
    persistComposerDraft: async () => { persists++; },
    readFileAsDataUrl: () => i++ === 0 ? readGates[0] : readGates[1].promise,
  };
  runInNewContext(`${appBody('addSelectedFiles', true)}
    ${appBody('isFileDrop')}
    function attachComposerFiles(files) { track(addSelectedFiles(files)); }
    ${source.slice(firstHandlers, lastHandlers)}`,
  { ...context, track: promise => { reading = promise; } });
  let prevented = 0;
  const event = { dataTransfer: { types: ['Files'], files }, preventDefault: () => { prevented++; } };
  handlers.get('dragover')(event);
  assert.equal(event.dataTransfer.dropEffect, 'copy');
  assert.ok(classes.has('fileDropActive'));
  handlers.get('drop')(event);
  assert.equal(prevented, 2);
  assert.ok(!classes.has('fileDropActive'));
  assert.equal(state.attachmentReadsPending, 1);
  assert.equal(state.pendingAttachments.length, 0);
  assert.equal(h.calls.length, 0, 'dropping files cannot dispatch work');
  readGates[1].resolve('data:application/pdf;base64,ZGVm');
  await reading;
  assert.equal(state.attachmentReadsPending, 0);
  assert.equal(persists, 1);
  await h.send(h.create('Copy the scheduling approach from these projects.', state.pendingAttachments));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].owner, 'computer');
  const attachments = h.calls[0].submission.attachments;
  assert.equal(JSON.stringify(attachments.map(a => a.name)), JSON.stringify(files.map(f => f.name)));
  assert.equal(JSON.stringify(attachments.map(a => a.dataBase64)), '["YWJj","ZGVm"]');
  assert.notEqual(attachments[0].id, attachments[1].id);
});

test('actual composer respects explicit API-only restriction before computer admission', async () => {
  for (const localExecutorChoice of [localExecutor, null]) {
    const h = routingHarness({ localExecutor: localExecutorChoice });
    const prompt = 'Use native API only to change the schedule widths.';
    await h.send(h.create(prompt, []));
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].owner, 'backend');
    assert.equal(h.calls[0].submission.text, prompt);
  }
});

test('actual fresh composer sends an explicit Appearance-dialog task to the available desktop owner without changing saved backend owners', async()=>{
 const prompt='Use the Revit Appearance dialog to remove the gap below the schedule headers.';
 const h=routingHarness();const submission=h.create(prompt,[]);assert.equal(submission.mode,'computer-run');await h.send(submission);assert.equal(h.calls[0].owner,'computer');
 for(const change of [{sessionId:'old-session'},{taskNavigationAssignmentId:'old-assignment'},{computerUseAvailable:false}]){
  const old=routingHarness(change);await old.send(old.create(prompt,[]));assert.equal(old.calls[0].owner,'backend');
 }
});

test('accepted backend submission keeps its owner if configuration changes before dispatch', async () => {
  const h = routingHarness({ localExecutor: null, computerUseAvailable: false });
  const submission = h.create('Continue the drawing', []); assert.equal(submission.mode, 'backend');
  h.state.computerUseAvailable = true;
  await h.send(submission); assert.equal(h.calls[0].owner, 'backend');
});

test('ordinary composer retains prior computer execution and read-only backend selection without local profile', async () => {
  for (const computerUseAvailable of [true, false]) {
    const h = routingHarness({ localExecutor: null, computerUseAvailable });
    const submission = h.create('Inspect the open drawing', []); await h.send(submission);
    assert.equal(h.calls[0].owner, computerUseAvailable ? 'computer' : 'backend');
  }
});

test('selected local executor with stale capabilities cannot silently fall back to a different agent', () => {
  const h = routingHarness({ backendConfigStatus: 'timeout', backendAvailable: false });
  assert.throws(() => h.create('Draft this PDF', [{ filename: 'record.pdf' }]), /reconnect|configuration/i);
  assert.equal(h.calls.length, 0);
});

function backendHarness({ ensure, stream } = {}) {
  const state = { backendMessages: [], pendingAttachments: [] }; let restored = 0, dispatched = 0;
  const context = { state, AbortController, localStorage: { removeItem() {} }, CONTRACT_VERSION: 'v1',
    clearCertifiedReadLifecycle() {}, setStreaming(value) { state.streaming = value; }, setStatus() {},
    beginOptimisticChatSubmission() {}, ensureSession: async () => ensure ? ensure(state) : 'session',
    getSpeedSettings: () => ({}), streamBackendChat: async (body, assistant, options) => { dispatched++; if (stream) await stream(body, options, state); },
    mayRestoreRejectedChatSubmission,
    restoreChatSubmissionInput() { restored++; }, renderMessages() {}, showStaleComposerNotice: async () => {},
    certifiedReadConnectionLossFixture() {}, renderNextCertifiedReadUi() {}, pushBackendMessage() {},
    syncGoals: async () => {}, refreshScreen: async () => {} };
  const send = runInNewContext(`${appBody('sendBackendPrompt', true)}; sendBackendPrompt`, context);
  return { send, state, restored: () => restored, dispatched: () => dispatched };
}

test('actual stream preserves exact rejection proof after local stream opens but before model task admission', async () => {
  const body={session_id:'session',message_id:'message'}, proof=rejectedChatSubmissionAdmission(body,{});
  const frames=[{event:'assistant.progress',data:['{"text":"Let me check."}']},
    {event:'error',data:[JSON.stringify({error:'Attachment upload unavailable',submission_admission:proof})]}];
  let accepted=0, dispatched=0;
  const stream=runInNewContext(`${appBody('streamBackendChat',true)};streamBackendChat`,{
    state:{sessionId:body.session_id,backendMessageId:body.message_id},loadedBrowserIdentity:'current',
    fetch:async()=>({ok:true,body:{getReader:()=>({})}}),
    consumeAuthoritativeBackendSse:async(_reader,onEvent)=>{for(const frame of frames)onEvent(frame);},
    dispatchBackendSseEvent:()=>{dispatched++;return false;}
  });
  await assert.rejects(stream(body,{}, {onAccepted:()=>accepted++}),error=>{
    assert.equal(error.message,'Attachment upload unavailable');
    assert.equal(mayRestoreRejectedChatSubmission({sessionId:body.session_id,id:body.message_id},error),true);
    return true;
  });
  assert.equal(accepted,0);assert.equal(dispatched,1);
});

test('backend submission restores the accepted PDF draft when session allocation fails before transport', async () => {
  const h = backendHarness({ ensure: async () => { throw new Error('Session unavailable'); } });
  const submission = { id: 'one', text: 'Draft this', rawPrompt: 'Draft this', attachments: [{ filename: 'record.pdf' }], transportStarted: false };
  await h.send(submission, { browserFreshnessChecked: true });
  assert.equal(h.restored(), 1); assert.equal(h.dispatched(), 0); assert.equal(submission.transportStarted, false);
  assert.equal(h.state.streaming, false);
});

test('cancellation while allocating a backend session restores input without dispatching after allocation returns', async () => {
  const h = backendHarness({ ensure: async state => { state.backendAbortController.abort(); return 'session'; } });
  const submission = { id: 'one', text: 'Draft this', rawPrompt: 'Draft this', attachments: [], transportStarted: false };
  await h.send(submission, { browserFreshnessChecked: true });
  assert.equal(h.restored(), 1); assert.equal(h.dispatched(), 0); assert.equal(submission.transportStarted, false);
});

test('conversation change during allocation cannot restore or send the old conversation draft', async () => {
  for (const rejects of [false, true]) {
    const h = backendHarness({ ensure: async state => {
      state.taskNavigationEpoch = 1;
      if (rejects) throw Object.assign(new Error('Conversation changed'), { name: 'AbortError' });
      return 'old-session';
    } });
    await h.send({ id: 'one', text: 'Old draft', attachments: [], transportStarted: false }, { browserFreshnessChecked: true });
    assert.equal(h.restored(), 0); assert.equal(h.dispatched(), 0);
  }
});

test('backend transport failure does not restore a draft that could duplicate an already accepted task', async () => {
  const h = backendHarness({ stream: async () => { throw new Error('Connection closed'); } });
  const submission = { id: 'one', text: 'Draft this', attachments: [], transportStarted: false };
  await h.send(submission, { browserFreshnessChecked: true });
  assert.equal(h.dispatched(), 1); assert.equal(submission.transportStarted, true); assert.equal(h.restored(), 0);
});

test('actual backend send restores original PDF bytes only on exact pre-admission rejection', async () => {
  for (const boundary of ['rejected', 'accepted', 'wrong-session', 'wrong-message', 'navigation']) {
    const h = backendHarness({ stream: async (body, options, state) => {
      const admission = rejectedChatSubmissionAdmission(body, Error('Ownership unavailable'));
      if (boundary === 'accepted') options.onAccepted();
      if (boundary === 'wrong-session') admission.session_id = 'other';
      if (boundary === 'wrong-message') admission.message_id = 'other';
      if (boundary === 'navigation') state.taskNavigationEpoch = 1;
      throw Object.assign(Error('Ownership unavailable'), { submission_admission: admission });
    } });
    const attachments = [{ filename: 'original.pdf', data_base64: 'original-pdf-bytes' }];
    const submission = { id: 'one', text: 'Draft this', rawPrompt: 'Draft this', attachments, transportStarted: false };
    await h.send(submission, { browserFreshnessChecked: true });
    assert.equal(h.restored(), boundary === 'rejected' ? 1 : 0);
    assert.equal(h.dispatched(), 1, 'no automatic resend');
    assert.equal(submission.attachments[0].data_base64, 'original-pdf-bytes');
  }
});

test('actual Send handler acknowledges synchronously, retains immutable click input and admits one send after delayed recovery and freshness', async () => {
  let handler, saveDone, freshDone, status; let checks = 0, acknowledged = 0; const sent = [];
  const attachment = { filename: 'redline.pdf', data_base64: 'retained-file-bytes' };
  const state = { resetting: false, pendingAttachments: [attachment] };
  const elements = { chatForm: { addEventListener(_event, fn) { handler = fn; } }, promptInput: { value: 'Review these marks' }, sendButton: {} };
  runInNewContext(directionPolicy + '\n' + source.slice(from, until + 4), { state, elements, beginComposerSend, loadedBrowserIdentity: 'current', selectedGoal: () => null,
    setStatus: text => { status = text; }, updateControls() { elements.sendButton.disabled = state.composerSubmissionPending; },
    persistComposerDraft: () => new Promise(resolve => { saveDone = resolve; }),
    assertLoadedBrowserFresh: () => { checks++; return new Promise(resolve => { freshDone = resolve; }); },
    createChatSubmission: (prompt, attachments) => ({ id: 'one', prompt, attachments }),
    clearChatComposerForSubmission() { elements.promptInput.value = ''; state.pendingAttachments = []; },
    beginOptimisticChatSubmission(submission) { submission.optimisticMessage = true; acknowledged++; },
    sendPrompt: async (submission, _attachments, options) => { sent.push({ submission, options }); },
    handleChatSubmissionFailure: error => { throw error; }, showStaleComposerNotice: async () => { throw new Error('unexpected stale state'); }
  });
  const pending = handler({ preventDefault() {} });
  assert.equal(status, 'Sending…'); assert.equal(elements.sendButton.disabled, true); assert.equal(sent.length, 0);
  await handler({ preventDefault() {} }); assert.equal(sent.length, 0);
  // Simulate an external event changing the draft while the persistence job is pending.
  elements.promptInput.value = 'Later text'; attachment.filename = 'changed.pdf';
  saveDone(true); await new Promise(setImmediate); assert.equal(checks, 1); assert.equal(sent.length, 0);
  await handler({ preventDefault() {} }); assert.equal(checks, 1);
  freshDone(); await new Promise(setImmediate); assert.equal(sent.length, 0, 'clear the original draft before allocating a session');
  assert.equal(acknowledged, 1, 'show the accepted message while draft clearing is pending');
  assert.equal(elements.promptInput.value, '');
  assert.equal(state.composerSubmissionPending, true, 'prevent conversation switches until the original key is cleared');
  saveDone(true); await pending;
  assert.equal(sent.length, 1); assert.equal(sent[0].submission.prompt, 'Review these marks');
  assert.equal(sent[0].submission.attachments[0].filename, 'redline.pdf');
  assert.equal(sent[0].submission.attachments[0].data_base64, 'retained-file-bytes');
  assert.equal(sent[0].options.browserFreshnessChecked, true); assert.equal(state.composerSubmissionPending, false);
});

test('reset during pending freshness prevents dispatch and releases intake controls', async () => {
  let handler, freshDone; let sends = 0;
  const state = { pendingAttachments: [] }; const elements = { chatForm: { addEventListener(_event, fn) { handler = fn; } }, promptInput: { value: 'Question' } };
  runInNewContext(directionPolicy + '\n' + source.slice(from, until + 4), { state, elements, beginComposerSend, loadedBrowserIdentity: 'current', selectedGoal: () => null, setStatus() {}, updateControls() {},
    persistComposerDraft: async () => true, assertLoadedBrowserFresh: () => new Promise(resolve => { freshDone = resolve; }),
    createChatSubmission() { sends++; }, clearChatComposerForSubmission() { sends++; }, beginOptimisticChatSubmission() { sends++; }, sendPrompt() { sends++; }
  });
  const pending = handler({ preventDefault() {} }); await new Promise(setImmediate); state.resetting = true; freshDone(); await pending;
  assert.equal(sends, 0); assert.equal(state.composerSubmissionPending, false); assert.equal(elements.promptInput.value, 'Question');
});


test('actual composer passes fresh print request to computer lane without rerouting saved chats', async () => {
  const prompt = 'Print sheet M000 to the selected printer using the current project print settings.';
  for (const [overrides, owner] of [[{}, 'computer'], [{ sessionId: 'saved' }, 'backend'], [{ computerUseAvailable: false }, 'backend']]) {
    const h = routingHarness(overrides);
    const submission = h.create(prompt, []);
    await h.send(submission);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].owner, owner);
    assert.equal(h.calls[0].submission.text, prompt);
  }
});


test('printer capability policy is identical in public core, browser and server runtime', async () => {
  const browser = await readFile(new URL('../public/print_execution_policy.mjs', import.meta.url), 'utf8');
  const server = await readFile(new URL('../print_execution_policy.mjs', import.meta.url), 'utf8');
  const core = await readFile(new URL('../../../packages/operator-assistant-ui/print_execution_policy.mjs', import.meta.url), 'utf8');
  assert.equal(browser, core);
  assert.equal(server, core);
});

test('New Chat intent is captured before a stale computer poll can repopulate session identity',()=>{
 const h=routingHarness();const fresh=h.create('Print current sheet',[]);
 h.state.sessionId='old-session';h.state.taskNavigationAssignmentId='old-task';
 assert.equal(fresh.newComputerConversation,true);
 assert.equal(h.create('Continue saved work',[]).newComputerConversation,false);
});
