import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createForegroundRevitWorkGate } from '../foreground_revit_work.js';
import { createTaskRunRegistry } from '../task_runs.mjs';
import { rejectedChatSubmissionAdmission } from '../public/chat_submission_admission.mjs';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const routes = ['/api/chat', '/api/chat/stream', '/api/computer/run', '/api/benchmark/revit-fixture/open', '/api/benchmark/revit-fixture/prepare-case'];
function fixture(overrides = {}) {
  const handlers = new Map();
  const gateStart = source.indexOf('const backendChatWorkGate =');
  const gateEnd = source.indexOf('\nconst computerState =', gateStart);
  const routeSources = routes.map(route => {
    const start = source.indexOf(`app.post("${route}", async (req, res) => {`);
    assert.ok(start > 0);
    const end = source.indexOf('\n});', start);
    assert.ok(end > start);
    return source.slice(start, end + 4);
  });
  let effects = 0;
  const taskRuns = createTaskRunRegistry();
  const context = {
    app: { post: (route, handler) => handlers.set(route, handler) },
    createForegroundRevitWorkGate,
    computerState: { running: false },
    taskRuns,
    rejectedChatSubmissionAdmission,
    normalizeUserFacingError: error => error instanceof Error ? error.message : String(error),
    sendJsonError: (res, error, status) => { res.statusCode = status; res.error = error; },
    answerConversationIntake: async () => null,
    refreshBackendRuntimeProfile: async () => {},
    assertGeneralAgentAvailable: () => {},
    normalizeChatProxyBody: async body => body,
    buildInitialChatContext: async () => ({}),
    runBackendChatActionLoop: async () => ({ ok: true }),
    prepareGeneralRevitBenchmarkCaseWithAuthorizationRecovery: async () => { effects++; return { ok: true, prepared: true }; },
    openGeneralRevitBenchmarkFixtureWithAuthorizationRecovery: async () => { effects++; return { ok: true, opened: true }; },
    ...overrides
  };
  runInNewContext(source.slice(gateStart, gateEnd).replace('export function', 'function') + '\n' + routeSources.join('\n'), context);
  return { effects: () => effects, taskRuns, request(route, body = {}) {
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
    return { res, work: handlers.get(route)({ body }, res) };
  } };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('benchmark fixture rejects backend chat during its first asynchronous read without model or export effects', async () => {
  const paused = deferred();
  const h = fixture({ refreshBackendRuntimeProfile: () => paused.promise });
  const chat = h.request('/api/chat');
  for (const route of routes.slice(3)) {
    const blocked = h.request(route); await blocked.work;
    assert.equal(blocked.res.statusCode, 409);
  }
  assert.equal(h.effects(), 0);
  paused.resolve(); await chat.work;
  for (const route of routes.slice(3)) {
    const allowed = h.request(route); await allowed.work;
    assert.equal(allowed.res.statusCode, 200);
  }
  assert.equal(h.effects(), 2, 'ordinary idle fixture behavior remains available after chat settles');
});

for (const fixtureRoute of routes.slice(3)) {
  test(`${fixtureRoute} owns preparation until settlement and prevents reverse admission races`, async () => {
    const paused = deferred(); let effects = 0;
    const hook = fixtureRoute.endsWith('/open') ? 'openGeneralRevitBenchmarkFixtureWithAuthorizationRecovery' : 'prepareGeneralRevitBenchmarkCaseWithAuthorizationRecovery';
    const h = fixture({ [hook]: () => { effects++; return paused.promise; } });
    const preparing = h.request(fixtureRoute);
    for (const route of routes) {
      const blocked = h.request(route); await blocked.work;
      assert.equal(blocked.res.statusCode, 409, route);
    }
    assert.equal(effects, 1);
    paused.reject(new Error('fixture failed'));
    await preparing.work;
    assert.equal(preparing.res.statusCode, 502);
    const chat = h.request('/api/chat'); await chat.work;
    assert.equal(chat.res.statusCode, 200, 'failure releases the real preparation lease');
  });
}

test('fixture preparation rejection restores only the exact new unadmitted submission, never an existing run', async () => {
  const paused = deferred();
  const h = fixture({ openGeneralRevitBenchmarkFixtureWithAuthorizationRecovery: () => paused.promise });
  const preparing = h.request('/api/benchmark/revit-fixture/open');
  const body = { session_id: 'conversation', message_id: 'new-request' };
  const rejected = h.request('/api/chat/stream', body); await rejected.work;
  assert.equal(rejected.res.statusCode, 409);
  assert.deepEqual(JSON.parse(JSON.stringify(rejected.res.body.submission_admission)), rejectedChatSubmissionAdmission(body, {}));
  assert.equal(h.taskRuns.get(body.session_id, body.message_id), null, 'rejected input never begins execution');
  const retained = h.taskRuns.begin({ sessionId: body.session_id, messageId: 'retained-request' });
  const duplicate = h.request('/api/chat/stream', { ...body, message_id: 'retained-request' }); await duplicate.work;
  assert.equal(duplicate.res.statusCode, 409);
  assert.equal(duplicate.res.body.submission_admission, undefined, 'known execution cannot be called unadmitted');
  assert.equal(retained.snapshot().state, 'running', 'rejection does not settle or clear earlier work');
  const unidentified = h.request('/api/chat/stream'); await unidentified.work;
  assert.equal(unidentified.res.statusCode, 409);
  assert.equal(unidentified.res.body.submission_admission, undefined);
  paused.resolve({ ok: true }); await preparing.work;
});
