import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { immutableEvidenceRetryReason } from '../immutable_evidence_retry.mjs';
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('async function storeSidecarEvidenceOnBackend(');
const fn = source.slice(start, source.indexOf('\n}\n', start) + 2);
const lostReply = () => new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
function harness(request, wait = async () => {}) {
  const calls = [], events = [], state = { stopRequested: false };
  const invoke = runInNewContext(fn + '; storeSidecarEvidenceOnBackend', {
    readBackendJson: async (route, options) => { calls.push({ route, ...options }); return request(calls.length); },
    computerState: state, addComputerEvent: value => events.push(value), sleepForBackoff: wait, immutableEvidenceRetryReason
  });
  return { invoke, calls, events, state };
}
test('lost immutable-store response retries identical bytes and scope without replaying an action', async () => {
  const input = { scope: { session_id: 's', assignment_id: 'a', run_id: 'r', generation: 1 }, raw_base64: 'YWJj' };
  const h = harness(n => { if (n === 1) throw lostReply(); return { ref: { evidence_id: 'same-ref' } }; }, async () => { input.scope.run_id = 'later-run'; });
  const result = await h.invoke(input);
  assert.equal(result.ref.evidence_id, 'same-ref');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body, h.calls[1].body);
  assert.equal(JSON.parse(h.calls[1].body).scope.run_id, 'r');
  assert.ok(h.calls.every(c => c.route === '/evidence/store' && c.method === 'POST'));
  assert.match(h.events[0], /UND_ERR_SOCKET/);
});
test('persistent transport failure stops after three retained attempts', async () => {
  const error = lostReply(); const h = harness(() => { throw error; });
  await assert.rejects(h.invoke({}), e => e === error);
  assert.equal(h.calls.length, 3); assert.equal(h.events.length, 3);
});

test('transient gateway rejection retries only the identical immutable evidence upload', async () => {
  for (const status of [502,503,504]) {
    const h = harness(n => { if(n===1) throw Object.assign(new Error('<html>Bad Gateway</html>'),{status}); return {ref:{evidence_id:'retained'}}; });
    await h.invoke({scope:{assignment_id:'a',run_id:'r',generation:1},raw_base64:'YWJj'});
    assert.equal(h.calls.length,2);
    assert.equal(h.calls[0].body,h.calls[1].body);
    assert.ok(h.calls.every(c=>c.route==='/evidence/store'));
  }
});
test('cancellation during backoff prevents another upload', async () => {
  const h = harness(() => { throw lostReply(); }, async () => { h.state.stopRequested = true; });
  await assert.rejects(h.invoke({}), /fetch failed/); assert.equal(h.calls.length, 1);
});

test('gateway failure keeps the three-attempt ceiling and cancellation boundary', async () => {
  const error = Object.assign(new Error('gateway'), { status: 502 });
  const exhausted = harness(() => { throw error; });
  await assert.rejects(exhausted.invoke({}), e => e === error);
  assert.equal(exhausted.calls.length, 3);
  const cancelled = harness(() => { throw error; }, async () => { cancelled.state.stopRequested = true; });
  await assert.rejects(cancelled.invoke({}), e => e === error);
  assert.equal(cancelled.calls.length, 1);
});
test('authorization, validation, abort and ordinary errors never retry', async () => {
  for (const error of [Object.assign(new Error('unauthorized'), { status: 401 }), Object.assign(new Error('forbidden'), { status: 403 }), Object.assign(new Error('invalid evidence'), { status: 400 }), Object.assign(new Error('too large'), { status: 413 }), Object.assign(new Error('invalid upstream'), { status: 500 }), Object.assign(new Error('aborted'), { name: 'AbortError',status:502 }), new Error('fetch failed')]) {
    const h = harness(() => { throw error; });
    await assert.rejects(h.invoke({}), e => e === error);
    assert.equal(h.calls.length, 1); assert.equal(h.events.length, 0);
  }
});
