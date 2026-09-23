import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTurnCompletions } from '../src/codex/turn_completions.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('same-turn provider progress extends inactivity wait without escaping the wall limit', async () => {
  const turns = new CodexTurnCompletions();
  const active = turns.wait({threadId:'thread',turnId:'active',timeoutMs:100,maxWallMs:300});
  await delay(70);
  turns.observeProgress('thread','active');
  await delay(70);
  turns.observe('thread','active','completed');
  assert.equal((await active).status,'completed');

  const bounded = turns.wait({threadId:'thread',turnId:'bounded',timeoutMs:100,maxWallMs:55});
  const rejected = assert.rejects(bounded, /maximum duration/);
  await delay(30);
  turns.observeProgress('thread','bounded');
  await rejected;
});

test('progress for another turn cannot extend an idle completion wait', async () => {
  const turns = new CodexTurnCompletions();
  const idle = turns.wait({threadId:'thread',turnId:'idle',timeoutMs:55,maxWallMs:200});
  const rejected = assert.rejects(idle, /inactivity/);
  await delay(30);
  turns.observeProgress('thread','other');
  await rejected;
});

test('fast interrupt completion before acknowledgement remains observable to later waiters', async () => {
  const turns = new CodexTurnCompletions();
  turns.observe('thread', 'turn', 'interrupted');
  assert.deepEqual(await turns.wait({threadId:'thread',turnId:'turn',timeoutMs:0}),{status:'interrupted',interrupted:true});
  assert.deepEqual(await turns.wait({threadId:'thread',turnId:'turn',timeoutMs:0}),{status:'interrupted',interrupted:true});
});

test('completion identities cannot collide, invalid status cannot complete, and transport reset clears observations', async () => {
  const turns = new CodexTurnCompletions();
  turns.observe('a:b', 'c', 'completed');
  turns.observe('a', 'b:c', 'inProgress');
  await assert.rejects(turns.wait({threadId:'a',turnId:'b:c',timeoutMs:5}), /Timed out/);
  assert.equal((await turns.wait({threadId:'a:b',turnId:'c',timeoutMs:0})).status,'completed');
  turns.reset(new Error('Transport changed'));
  await assert.rejects(turns.wait({threadId:'a:b',turnId:'c',timeoutMs:5}), /Timed out/);
});

test('waiting observers settle once and transport loss promptly rejects without polling or replay', async () => {
  const turns = new CodexTurnCompletions();
  const completed = turns.wait({threadId:'one',turnId:'turn',timeoutMs:5000});
  const lost = turns.wait({threadId:'two',turnId:'turn',timeoutMs:5000});
  const rejected = assert.rejects(lost, /Transport closed/);
  turns.observe('one','turn','completed');
  turns.reset(new Error('Transport closed'));
  assert.equal((await completed).status,'completed');
  await rejected;
});

test('abort, provider failure and conflicting observations do not become successful completion', async () => {
  const turns = new CodexTurnCompletions();
  const controller = new AbortController();
  const pending = turns.wait({threadId:'thread',turnId:'turn',timeoutMs:5000,abortSignal:controller.signal});
  const rejected = assert.rejects(pending, /aborted/);
  controller.abort();
  await rejected;
  turns.observe('thread','turn','failed','Original provider failure');
  await assert.rejects(turns.wait({threadId:'thread',turnId:'turn',timeoutMs:0}), /Original provider failure/);
  turns.observe('other','turn','completed');
  turns.observe('other','turn','interrupted');
  await assert.rejects(turns.wait({threadId:'other',turnId:'turn',timeoutMs:0}), /Conflicting/);
});
