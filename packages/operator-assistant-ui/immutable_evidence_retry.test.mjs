import assert from 'node:assert/strict';
import test from 'node:test';
import { immutableEvidenceRetryReason } from './immutable_evidence_retry.mjs';

test('immutable-store transient failures expose bounded diagnostic reasons', () => {
  for (const status of [502, 503, 504]) {
    assert.equal(immutableEvidenceRetryReason(Object.assign(new Error('upstream'), { status })), `HTTP_${status}`);
  }
  assert.equal(immutableEvidenceRetryReason(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })), 'UND_ERR_SOCKET');
});

test('authorization, validation, cancellation and unclassified failures cannot request retry', () => {
  for (const status of [400, 401, 403, 404, 409, 413, 429, 500, '502']) {
    assert.equal(immutableEvidenceRetryReason({ status }), null);
  }
  for (const error of [null, undefined, {}, new Error('fetch failed'), { name: 'AbortError', status: 502 }]) {
    assert.equal(immutableEvidenceRetryReason(error), null);
  }
});
