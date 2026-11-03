import test from 'node:test';
import assert from 'node:assert/strict';
import { nonAllowlistedShellCommandMessage } from './shell_command_diagnostic.mjs';

test('non-allowlisted command stays a refusal with actionable literal-separator guidance', () => {
  const message = nonAllowlistedShellCommandMessage('beta');
  assert.ok(message.startsWith('Shell command contains a non-allowlisted command: beta.'));
  assert.match(message, /even inside quotes/);
  assert.match(message, /separate -match conditions joined by -or/);
  assert.match(message, /do not retry the same rejected syntax/);
});

test('unknown token retains its existing label and existing command limits', () => {
  const message = nonAllowlistedShellCommandMessage('');
  assert.match(message, /non-allowlisted command: unknown\./);
  assert.match(message, /existing permitted commands/);
});
