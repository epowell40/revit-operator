import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBoundedModelEvidencePayload as validate, prepareBoundedModelEvidenceInput as prepare,
  MODEL_EVIDENCE_ENVELOPE_SCHEMA } from '../src/evidence/model_context_budget.js';

import {sheet, projection, envelope, batch} from "./model_evidence_read_batch.fixtures.js";
const decoded = (row: any) => JSON.parse(row.output[0].text).evidence_projections[0];

test('required sheet inspection batch retains identities/facts and retrieves omitted acceleration data', () => {
  const input = batch(), original = structuredClone(input);
  for (const row of input) validate(row);
  assert.throws(() => validate(input), /32768-byte model-request/);
  const result: any = prepare(input);
  validate(result); assert.deepEqual(input, original);
  assert.deepEqual(result.map((r: any) => r.call_id), input.map(r => r.call_id));
  let omitted = 0;
  result.forEach((row: any, i: number) => {
    const before = decoded(input[i]), after = decoded(row);
    if (after.inline_payload) { assert.deepEqual(row, input[i]); return; }
    omitted++;
    for (const key of Object.keys(before).filter(k => !['inline_payload', 'diagnostics', 'truncated'].includes(k)))
      assert.deepEqual(after[key], before[key], key);
    assert.equal(after.truncated, true);
    assert.match(after.diagnostics.at(-1), /batch_budget.*retrieve.*not proof/i);
  });
  assert(omitted > 0); assert.strictEqual(prepare(result), result);
});

test('small native reads retain the complete original byte representation', () => {
  const input = batch().slice(0, 1); assert.strictEqual(prepare(input), input);
});

test('mutation, unknown, foreign, malformed and extra-control payloads are never elided', () => {
  for (const change of [
    {effect_state: 'unknown'}, {effect_state: 'applied'}, {before_hash: 'sha256:' + 'f'.repeat(64)},
    {trust_level: 'untrusted_caller'}, {source: 'foreign'}, {content_hash: 'bad'}, {artifact_ref: 'other'},
    {attempt_id: null}, {generation: 0}, {retrieval: null},
    {inline_payload: {...sheet(1), action: 'create'}},
    {inline_payload: {...sheet(1), pending_verification: ['unreviewed']}},
    {inline_payload: {...sheet(1), status: 'Failed'}},
    {inline_payload: {...sheet(1), viewportCount: 99}}
  ]) {
    const input = batch().map((row, i) => ({...row, output: [{type: 'input_text', text: envelope({...projection(i + 1), ...change})}]}));
    assert.throws(() => prepare(input), /32768-byte model-request/, JSON.stringify(change));
  }
});

test('compacted read batches preserve images, canonical controls and visual feedback exactly', () => {
  const input: any[] = batch();
  input[0].output.push({type: 'input_image', image_url: 'data:image/png;base64,AAAA'});
  input[1].output.push({type: 'input_text', text: '{"unknown_effect":true,"pending_usage":1}'});
  input.push({role: 'user', content: 'Pause; unreviewed work remains.'});
  const result: any = prepare(input);
  assert.deepEqual(result[0].output[1], input[0].output[1]);
  assert.deepEqual(result[1].output[1], input[1].output[1]);
  assert.deepEqual(result.at(-1), input.at(-1));
});

test('documentation overflow retains tool identity but never presents an omitted schema as usable', () => {
  const input = batch().slice(0, 10);
  const p = {...projection(20), source: 'assignment_kernel_v2:revit_tool_doc', trust_level: 'host_observed',
    tool_documentation: {kind: 'tool', completion_eligible: false, tools: [{method: 'POST', path: '/revit/sheet',
      request_schema: {description: 'x'.repeat(5000)}}], returned_tools: 1, total_tools: 1, omitted_paths: [], complete: true}};
  delete p.inline_payload;
  input.unshift({type: 'function_call_output', call_id: 'doc', output: [{type: 'input_text', text: envelope(p)}]});
  const result: any = prepare(input), after = decoded(result[0]);
  validate(result);
  assert.equal(after.tool_documentation.complete, false);
  assert.equal(after.tool_documentation.completion_eligible, false);
  assert.deepEqual(after.tool_documentation.tools, [{method: 'POST', path: '/revit/sheet'}]);
  assert.match(after.diagnostics.at(-1), /retrieve.*not proof/i);
});

test('real native producer and scoped retrieval retain full sheet data behind compacted presentation', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {storeEvidence, retrieveEvidence, readAuthoritativeEvidence} = await import('../src/evidence/evidence_store.js');
  const {modelEvidenceEnvelope} = await import('../src/evidence/model_context_budget.js');
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-batch-'));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const scope = {session_id: 'session', assignment_id: 'assignment', run_id: 'run', generation: 1,
      attempt_id: 'opv2_' + 'a'.repeat(64)};
    const saved = Array.from({length: 16}, (_, i) => storeEvidence({scope,
      source: 'assignment_kernel_v2:revit_call_tool', trust_level: 'authoritative_native',
      verification_relevance: 'required', raw: sheet(i + 1)}));
    const input = saved.map((s, i) => ({type: 'function_call_output', call_id: `native${i}`,
      output: [{type: 'input_text', text: JSON.stringify(modelEvidenceEnvelope([s.projection]))}]}));
    assert.throws(() => validate(input), /32768-byte model-request/);
    const result: any = prepare(input); validate(result);
    const omitted = result.findIndex((r: any) => !decoded(r).inline_payload);
    assert(omitted >= 0);
    const p = decoded(result[omitted]), source = saved[omitted];
    assert.equal(p.content_hash, source.ref.content_hash);
    assert.deepEqual(JSON.parse(readAuthoritativeEvidence(source.ref, scope).toString()), sheet(omitted + 1));
    const request = {scope, evidence_id: p.evidence_id, fields: ['placedViews'], max_bytes: 4096,
      purpose: 'Read the exact omitted placement facts'};
    const retrieved = retrieveEvidence(request);
    assert.deepEqual((retrieved.selection as any).placedViews, sheet(omitted + 1).placedViews);
    assert.throws(() => retrieveEvidence({...request, scope: {...scope, session_id: 'foreign'}}));
    assert.throws(() => retrieveEvidence({...request, scope: {...scope, generation: 2}}));
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 50});
  }
});
