import assert from 'node:assert/strict';
import test from 'node:test';
import { selectChatSubmissionMode } from './composer_intake.mjs';
import { excludesComputerUse } from './composer_intake.mjs';
const capability = { schema: 'revit-operator.local-executor-capability/v1', source: 'backend_configuration',
  profile: 'codex_v2_advisory_v1', executor: 'codex', assignment_kernel: 2, execution_policy: 'local_advisory_v1' };
const state = { localExecutor: capability, backendLocal: true, backendAuthMode: 'shared_token',
  backendAvailable: true, backendConfigStatus: 'ready', computerUseAvailable: true };

test('fresh ordinary work gets the available computer-capable owner without UI keywords', () => {
  for (const prompt of ['Match this schedule to the attached example.', 'Inspect and fix the blank row; preserve text sizes. Save Schedule Correction.rvt.', 'Pick up these redlines.', 'Export this sheet to PDF']) {
    assert.equal(selectChatSubmissionMode(state, prompt), 'computer-run', prompt);
    for (const change of [{ sessionId: 'saved' }, { taskNavigationAssignmentId: 'retained' },
      { streaming: true, activeRunKind: 'backend' }, { computerUseAvailable: false }]) {
      assert.equal(selectChatSubmissionMode({ ...state, ...change }, prompt), 'backend');
    }
  }
});

test('fresh local work uses available computer capability and otherwise the configured backend', () => {
  for (const available of [true, false]) assert.equal(selectChatSubmissionMode({ ...state, computerUseAvailable: available }), available ? 'computer-run' : 'backend');
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


test('fresh printer request selects available computer lane while preserving existing owners and freshness', () => {
  const prompt = 'Print sheet M000 to the selected printer using the current project print settings.';
  assert.equal(selectChatSubmissionMode(state, prompt), 'computer-run');
  for (const change of [{ sessionId: 'saved' }, { taskNavigationAssignmentId: 'old' },
    { streaming: true, activeRunKind: 'backend' }, { computerUseAvailable: false }]) {
    assert.equal(selectChatSubmissionMode({ ...state, ...change }, prompt), 'backend');
  }
  assert.equal(selectChatSubmissionMode(state, 'Export M000 to PDF'), 'computer-run');
  assert.throws(() => selectChatSubmissionMode({ ...state, backendConfigStatus: 'timeout' }, prompt), /Reconnect/);
  assert.equal(selectChatSubmissionMode({ ...state, streaming: true, activeRunKind: 'computer' }, prompt), 'computer-interject');
});

import { startsFreshComputerConversation } from './composer_intake.mjs';
test('fresh computer conversation requires empty session, empty saved assignment and idle composer',()=>{
 assert.equal(startsFreshComputerConversation({}),true);
 for(const state of [{sessionId:'old'},{taskNavigationAssignmentId:'old'},{streaming:true}])assert.equal(startsFreshComputerConversation(state),false);
});

test('fresh work does not need UI keywords and explicit API-only restrictions remain effective',()=>{
 for(const prompt of ['Use Revit UI to adjust the schedule.', 'Remove the header gap using the Revit Appearance dialog.', 'Open the schedule Appearance dialog and inspect its grid settings.', 'Click the ribbon button.', 'Match the air-device schedule to this office example.']){
  assert.equal(excludesComputerUse(prompt),false);assert.equal(selectChatSubmissionMode(state,prompt),'computer-run');
  for(const change of [{sessionId:'saved'}, {taskNavigationAssignmentId:'retained'}, {streaming:true,activeRunKind:'backend'}, {computerUseAvailable:false}])assert.equal(selectChatSubmissionMode({...state,...change},prompt),'backend');
  assert.throws(()=>selectChatSubmissionMode({...state,backendConfigStatus:'timeout'},prompt),/Reconnect/);
 }
 for(const prompt of ['Use native API only; do not open the Appearance dialog.', 'Adjust widths without using Revit UI.', "Do not use computer-use; inspect the menu through native API only.", 'Only use the API to inspect the schedule.', 'Adjust it without opening the user interface.']){
  assert.equal(excludesComputerUse(prompt),true);assert.equal(selectChatSubmissionMode(state,prompt),'backend');
  assert.equal(selectChatSubmissionMode({computerUseAvailable:true},prompt),'backend');
  assert.equal(selectChatSubmissionMode({...state,streaming:true,activeRunKind:'computer'},prompt),'computer-interject');
 }
});
