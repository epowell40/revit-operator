import assert from 'node:assert/strict';
import test from 'node:test';
import { rejectedChatSubmissionAdmission, mayRestoreRejectedChatSubmission } from './chat_submission_admission.mjs';
const body = { session_id: 'session', message_id: 'message' };
const submission = { sessionId: 'session', id: 'message' };
const rejected = { submission_admission: rejectedChatSubmissionAdmission(body, Error('Ownership unavailable')) };
test('exact unadmitted request can restore its input without declaring previous task effects', () => {
  assert.equal(mayRestoreRejectedChatSubmission(submission, rejected), true);
  assert.equal(rejected.submission_admission.effect, undefined);
  assert.equal(mayRestoreRejectedChatSubmission(submission, { submission_admission: rejectedChatSubmissionAdmission(body, { code: 'TASK_SESSION_BUSY' }) }), true);
});
test('duplicate accepted key and incomplete identity never establish rejection', () => {
  assert.equal(rejectedChatSubmissionAdmission(body, { code: 'TASK_RUN_EXISTS' }), null);
  for (const input of [null, {}, { ...body, session_id: ' ' }, { ...body, message_id: 'x'.repeat(241) }]) {
    assert.equal(rejectedChatSubmissionAdmission(input, {}), null);
  }
});
test('transport loss, mismatched identity, malformed proof and accepted submission never restore', () => {
  for (const error of [Error('fetch failed'), {}, { submission_admission: null },
    ...Object.entries({ schema: 'other', state: 'accepted', request_dispatched: true, session_id: 'other', message_id: 'other' })
      .map(([key, value]) => ({ submission_admission: { ...rejected.submission_admission, [key]: value } }))]) {
    assert.equal(mayRestoreRejectedChatSubmission(submission, error), false);
  }
  assert.equal(mayRestoreRejectedChatSubmission({ ...submission, backendAccepted: true }, rejected), false);
  assert.equal(mayRestoreRejectedChatSubmission({ id: 'message' }, rejected), false);
});
