import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeDirectRevitExecution } from '../src/capabilities/direct_revit_execution_authorization.js';
import { computeRequestHash } from '../src/capabilities/tool_certification.js';

const ready = { REVIT_OPERATOR_MODE: 'local', OPERATOR_TOOL_EXPOSURE_PROFILE: 'general',
  OPERATOR_AUTH_MODE: 'shared_token', OPERATOR_BRAIN: 'codex', OPERATOR_OPENAI_API_KEY: 'test-only' };
const request = (path: string, body: unknown) => ({
  schema: 'revit-operator.revit-direct-admission-request.v2', request_id: '0123456789abcdef0123456789abcdef',
  method: body === null ? 'GET' : 'POST', path, body_present: body !== null,
  body_json: body === null ? '' : JSON.stringify(body), channel: 'generic_call', alias: 'revit_call_tool', runtime_mode: 'local'
});

test('normal local General Agent admits the actual independent parameter read and tool discovery', () => {
  for (const mode of ['local', 'self_hosted']) for (const [path, body] of [
    ['/revit/get-parameters', { elementIds: [49504], names: ['Status'], includeEmpty: true }],
    ['/revit/tool-registry', null]
  ] as const) {
    const r = request(path, body), a = authorizeDirectRevitExecution(r, { ...ready, REVIT_OPERATOR_MODE: mode });
    assert.equal(a.policy_trust_source, 'deployment');
    assert.equal(a.exposure_profile, 'general');
    assert.equal(a.runtime_mode, 'local');
    assert.equal(a.request_hash, computeRequestHash(r.method, path, JSON.parse(JSON.stringify(body ?? {}))));
    assert.match(a.authorization_hash, /^sha256:[a-f0-9]{64}$/);
  }
});

test('local General Agent admission stays exact and retains request, transport and profile guards', () => {
  const r = request('/revit/get-parameters', { elementIds: [49504], names: ['Status'], includeEmpty: true });
  for (const env of [
    { ...ready, OPERATOR_AUTH_MODE: 'principal_jwt' }, { ...ready, OPERATOR_BRAIN: 'rule' },
    { ...ready, OPERATOR_OPENAI_API_KEY: '', OPENAI_API_KEY: '' },
    { ...ready, OPERATOR_TOOL_EXPOSURE_PROFILE: 'certified' },
    { ...ready, REVIT_OPERATOR_MODE: 'LOCAL' }, { ...ready, OPERATOR_HOSTED_ENABLED: 'true' }
  ]) assert.throws(() => authorizeDirectRevitExecution(r, env));
  for (const changes of [
    { runtime_mode: 'hosted' }, { path: '/revit/not-a-supported-route' }, { alias: 'foreign_alias' },
    { body_json: '{' }, { request_id: 'invalid' }
  ]) assert.throws(() => authorizeDirectRevitExecution({ ...r, ...changes }, ready));
});
