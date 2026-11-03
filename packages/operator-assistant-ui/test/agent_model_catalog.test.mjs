import test from 'node:test';
import assert from 'node:assert/strict';
import { agentModelIds, normalizeAgentModel } from '../agent_model_catalog.mjs';

test('explicit model choices preserve exact identities without guessed aliases', () => {
  for (const id of agentModelIds) assert.equal(normalizeAgentModel(` ${id} `, 'fallback'), id);
  for (const value of ['gpt-6.6-astra', 'gpt-6.1-luna', '', null, undefined, '__proto__']) {
    assert.equal(normalizeAgentModel(value, 'fallback'), 'fallback');
  }
  assert(Object.isFrozen(agentModelIds));
});
