import assert from 'node:assert/strict';
import test from 'node:test';
import { selectChatSubmissionMode } from './composer_intake.mjs';
const capability = { schema: 'revit-operator.local-executor-capability/v1', source: 'backend_configuration',
  profile: 'codex_v2_advisory_v1', executor: 'codex', assignment_kernel: 2, execution_policy: 'local_advisory_v1' };
const state = { localExecutor: capability, backendLocal: true, backendAuthMode: 'shared_token',
  backendAvailable: true, backendConfigStatus: 'ready', computerUseAvailable: true };

test('trusted local capability selects backend independently of computer-use availability', () => {
  for (const available of [true, false]) assert.equal(selectChatSubmissionMode({ ...state, computerUseAvailable: available }), 'backend');
});
test('hosted, incomplete or unrelated capabilities do not select local executor', () => {
  for (const change of [{ backendLocal: false }, { backendAuthMode: 'principal_jwt' }, { localExecutor: null },
    ...Object.keys(capability).map(key => ({ localExecutor: { ...capability, [key]: 'other' } }))]) {
    assert.equal(selectChatSubmissionMode({ ...state, ...change }), 'computer-run');
  }
});
test('stale selected capability fails before submission instead of falling back', () => {
  for (const change of [{ backendAvailable: false }, { backendConfigStatus: 'timeout' }, { backendConfigStatus: 'partial' }]) {
    assert.throws(() => selectChatSubmissionMode({ ...state, ...change }), /Reconnect/);
  }
});
test('running computer turn retains interjection owner across capability refresh', () => {
  assert.equal(selectChatSubmissionMode({ ...state, streaming: true, activeRunKind: 'computer' }), 'computer-interject');
});
test('unselected installation retains existing transport choices', () => {
  assert.equal(selectChatSubmissionMode({ computerUseAvailable: false }), 'backend');
  assert.equal(selectChatSubmissionMode({ computerUseAvailable: true }), 'computer-run');
});
