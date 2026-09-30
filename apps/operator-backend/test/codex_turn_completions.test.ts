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

test('typed provider failure reaches early and waiting completion consumers with exact identity', async () => {
  for (const observeFirst of [false, true]) {
    const turns = new CodexTurnCompletions();
    const observe = () => turns.observe('thread:a', 'turn:b', 'failed', {
      message: 'Provider diagnostic '.repeat(200), codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: 'must not propagate', misalignment: null
    });
    if (observeFirst) observe();
    const pending = turns.wait({threadId:'thread:a',turnId:'turn:b',timeoutMs:1000});
    const rejected = assert.rejects(pending, (error: any) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.name, 'CodexTurnFailedError');
      assert.equal(error.threadId, 'thread:a');
      assert.equal(error.turnId, 'turn:b');
      assert.equal(error.codexErrorInfo, 'usageLimitExceeded');
      assert.equal(error.message.length, 2048);
      assert.equal(error.additionalDetails, undefined);
      assert.equal(error.misalignment, undefined);
      return true;
    });
    if (!observeFirst) observe();
    await rejected;
    await assert.rejects(turns.wait({threadId:'thread',turnId:'a:turn:b',timeoutMs:0}), /Timed out/);
  }
});

test('typed neighboring provider failures remain distinct despite quota-like diagnostic prose', async () => {
  const codes = ['rateLimitExceeded', 'sessionBudgetExceeded', 'unauthorized', 'contextWindowExceeded',
    'serverOverloaded', 'cyberPolicy', 'misalignmentPolicyViolation', 'internalServerError', 'badRequest',
    'threadRollbackFailed', 'sandboxError', 'other'];
  for (const code of codes) {
    const turns = new CodexTurnCompletions();
    turns.observe('thread', code, 'failed', {message:'usage limit quota 429 exhausted',codexErrorInfo:code});
    await assert.rejects(turns.wait({threadId:'thread',turnId:code,timeoutMs:0}), (error: any) => {
      assert.equal(error.codexErrorInfo, code);
      assert.equal(error.message, 'usage limit quota 429 exhausted');
      return true;
    });
  }
});

test('untyped or malformed errors never acquire quota authority from prose', async () => {
  const values: unknown[] = [null, undefined, 'usage limit quota 429 exhausted', {},
    {message:'usage limit',codexErrorInfo:null}, {message:'usage limit'},
    {message:'usage limit',codexErrorInfo:'usage_limit_exceeded'},
    {message:'usage limit',codexErrorInfo:'futureCode'},
    {message:'usage limit',codexErrorInfo:{usageLimitExceeded:{}}},
    {message:12,codexErrorInfo:'usageLimitExceeded'},
    {message:'usage limit',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:'429'}}},
    {message:'usage limit',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:Infinity}}},
    {message:'usage limit',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429.5}}},
    {message:'usage limit',codexErrorInfo:{activeTurnNotSteerable:{turnKind:'unknown'}}},
    {message:'usage limit',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429},activeTurnNotSteerable:{turnKind:'compact'}}}];
  for (let index = 0; index < values.length; index++) {
    const turns = new CodexTurnCompletions();
    turns.observe('thread', String(index), 'failed', values[index]);
    await assert.rejects(turns.wait({threadId:'thread',turnId:String(index),timeoutMs:0}), (error: any) => {
      assert.equal(error.codexErrorInfo, null);
      return true;
    });
  }
});

test('object error variants retain safe immutable protocol fields without carrying arbitrary details', async () => {
  for (const kind of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
    for (const status of [null, 429]) {
      const details: any = {httpStatusCode:status,extra:'not retained'};
      const turns = new CodexTurnCompletions();
      turns.observe('thread', kind, 'failed', {message:'provider failure',codexErrorInfo:{[kind]:details}});
      details.httpStatusCode = 500;
      await assert.rejects(turns.wait({threadId:'thread',turnId:kind,timeoutMs:0}), (error: any) => {
        assert.deepEqual(error.codexErrorInfo, {[kind]:{httpStatusCode:status}});
        assert.equal(Object.isFrozen(error.codexErrorInfo), true);
        assert.equal(Object.isFrozen(error.codexErrorInfo[kind]), true);
        return true;
      });
    }
  }
  for (const turnKind of ['review', 'compact']) {
    const turns = new CodexTurnCompletions();
    turns.observe('thread',turnKind,'failed',{message:'not steerable',codexErrorInfo:{activeTurnNotSteerable:{turnKind}}});
    await assert.rejects(turns.wait({threadId:'thread',turnId:turnKind,timeoutMs:0}), (error: any) => {
      assert.deepEqual(error.codexErrorInfo, {activeTurnNotSteerable:{turnKind}});
      return true;
    });
  }
});

test('success, conflict, cancellation and transport loss do not become recoverable provider failures', async () => {
  const turns = new CodexTurnCompletions();
  const quota = {message:'limit reached',codexErrorInfo:'usageLimitExceeded'};
  for (const status of ['completed', 'interrupted']) {
    turns.observe('thread',status,status,quota);
    assert.deepEqual(await turns.wait({threadId:'thread',turnId:status,timeoutMs:0}), {status,interrupted:status === 'interrupted'});
  }
  turns.observe('thread','conflict','completed');
  turns.observe('thread','conflict','failed',quota);
  await assert.rejects(turns.wait({threadId:'thread',turnId:'conflict',timeoutMs:0}), (error: any) => {
    assert.match(error.message, /Conflicting/);
    assert.equal(error.codexErrorInfo, null);
    return true;
  });
  const abort = new AbortController();
  const aborted = turns.wait({threadId:'thread',turnId:'abort',timeoutMs:1000,abortSignal:abort.signal});
  const abortedCheck = assert.rejects(aborted, (error: any) => {
    assert.match(error.message,/aborted/); assert.equal(error.codexErrorInfo,undefined); return true;
  });
  abort.abort();
  turns.observe('thread','abort','failed',quota);
  await abortedCheck;
  const lost = turns.wait({threadId:'thread',turnId:'lost',timeoutMs:1000});
  const lostCheck = assert.rejects(lost, (error: any) => {
    assert.match(error.message,/transport lost/); assert.equal(error.codexErrorInfo,undefined); return true;
  });
  turns.reset(new Error('transport lost'));
  await lostCheck;
  await assert.rejects(turns.wait({threadId:'thread',turnId:'abort',timeoutMs:0}), /Timed out/);
});

test('conflicting same-turn failure codes stay non-authoritative through later duplicates', async () => {
  const conflicts = [
    [null, 'usageLimitExceeded'], ['rateLimitExceeded', 'usageLimitExceeded'],
    ['usageLimitExceeded', 'rateLimitExceeded'],
    [{httpConnectionFailed:{httpStatusCode:429}}, {httpConnectionFailed:{httpStatusCode:503}}]
  ];
  for (const [first, second] of conflicts) {
    const turns = new CodexTurnCompletions();
    const observe = (code: unknown) => turns.observe('thread','turn','failed',{message:'same diagnostic',codexErrorInfo:code});
    observe(first);
    observe(second);
    observe('usageLimitExceeded');
    await assert.rejects(turns.wait({threadId:'thread',turnId:'turn',timeoutMs:0}), (error: any) => {
      assert.match(error.message,/Conflicting/);
      assert.equal(error.codexErrorInfo,null);
      return true;
    });
  }
  const statuses = new CodexTurnCompletions();
  statuses.observe('thread','turn','completed');
  statuses.observe('thread','turn','failed',{message:'limit',codexErrorInfo:'usageLimitExceeded'});
  statuses.observe('thread','turn','failed',{message:'limit',codexErrorInfo:'usageLimitExceeded'});
  await assert.rejects(statuses.wait({threadId:'thread',turnId:'turn',timeoutMs:0}), /Conflicting/);
  const identical = new CodexTurnCompletions();
  identical.observe('thread','turn','failed',{message:'first diagnostic',codexErrorInfo:'usageLimitExceeded'});
  identical.observe('thread','turn','failed',{message:'new diagnostic',codexErrorInfo:'usageLimitExceeded'});
  await assert.rejects(identical.wait({threadId:'thread',turnId:'turn',timeoutMs:0}), (error: any) => {
    assert.equal(error.codexErrorInfo,'usageLimitExceeded');
    assert.equal(error.message,'new diagnostic');
    return true;
  });
});
