import assert from 'node:assert/strict';
import test from 'node:test';
import {retainedBatch} from './model_evidence_multi_output.fixtures.js';
import {assertBoundedModelEvidencePayload as validate, prepareBoundedModelEvidenceInput as prepare} from '../src/evidence/model_context_budget.js';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';

const decode = (b: any): any => {try {return b.type === 'input_text' ? JSON.parse(b.text) : null;} catch {return null;}};
const isEnvelope = (b: any) => decode(b)?.schema === 'revit-operator.model-evidence-envelope.v1';
const projections = (row: any): any[] => row.output.flatMap((b: any) => isEnvelope(b) ? decode(b).evidence_projections : []);
const opaque = (row: any) => row.output.filter((b: any) => !isEnvelope(b));

test('retained five-call mixed native/review/save batch fits without losing required facts or pixels', () => {
  const input = structuredClone(retainedBatch), original = structuredClone(input);
  input.forEach(row => validate(row));
  assert.throws(() => validate(input), /32768-byte model-request/);
  const out: any = prepare(input);
  assert(validate(out).projected_bytes <= 32768);
  assert.deepEqual(input, original);
  assert.deepEqual(out.map((r: any) => r.call_id), input.map(r => r.call_id));
  out.forEach((row: any, i: number) => {
    assert.deepEqual(opaque(row), opaque(input[i]), 'images and non-envelope controls remain ordered and exact');
    const before = projections(input[i]), after = projections(row);
    assert.equal(after.length, before.length);
    after.forEach((p, j) => {
      if (!p.source.startsWith('desktop_native_transport:')) assert.deepEqual(p, before[j]);
      else for (const key of Object.keys(before[j]).filter(k => !['key_counts','key_facts','diagnostics','truncated','additional_evidence'].includes(k)))
        assert.deepEqual(p[key], before[j][key], key);
    });
  });
});

test('a small successful response retains its original byte representation', () => {
  const input = structuredClone(retainedBatch.slice(0, 1));
  assert.strictEqual(prepare(input), input);
});

test('unknown guidance and omitted-source counts are not coalesced away', () => {
  for (const change of ['guidance','omitted']) {
    const input = structuredClone(retainedBatch);
    for (const row of input) for (const b of row.output) if (isEnvelope(b)) {
      const e = decode(b);
      if (change === 'guidance') e.retrieval = 'x'.repeat(e.retrieval.length);
      else e.omitted = 1;
      b.text = JSON.stringify(e);
    }
    assert.throws(() => prepare(input), /32768-byte model-request/, change);
  }
});

test('oversized raw data fails; unknown envelopes stay exact and irreducible data still fails closed', () => {
  const bad: any[] = structuredClone(retainedBatch);
  bad[0].output.push({type:'input_text',text:'x'.repeat(8193)});
  assert.throws(() => prepare(bad), /8192-byte evidence item/);
  const malformed: any[] = structuredClone(retainedBatch);
  const e = decode(malformed[0].output[0]); e.extra_control = {unknown_effect:true};
  malformed[0].output[0].text = JSON.stringify(e);
  // An unrecognized 4KB block is legal raw text under the unchanged item cap.
  // It must stay exact, rather than being recognized/sanitized as an envelope.
  const withUnknown: any = prepare(malformed);
  assert.deepEqual(withUnknown[0].output[0], malformed[0].output[0]);
  const irreducible: any[] = structuredClone(retainedBatch);
  for (const row of irreducible) for (const b of row.output) if (isEnvelope(b)) {
    const e = decode(b);
    e.evidence_projections.forEach((p: any) => {p.trust_level='authoritative_native';p.effect_state='unknown';p.source='foreign';});
    b.text = JSON.stringify(e);
  }
  assert.throws(() => prepare(irreducible), /32768-byte model-request/);
});

test('native output producer and model-visible batch consumer preserve native receipts and image blocks', () => {
  const scope = {session_id:'session',assignment_id:'assignment',run_id:'run',generation:1};
  const input = structuredClone(retainedBatch).map(row => {
    const bounded = boundDesktopNativeOutput({success:true,contentItems:row.output.map((b: any) => b.type==='input_text'
      ? {type:'inputText' as const,text:b.text} : {type:'inputImage' as const,imageUrl:b.image_url})},scope,row.call_id);
    return {...row,output:bounded.contentItems.map((b: any) => b.type==='inputText'
      ? {type:'input_text',text:b.text} : {type:'input_image',image_url:b.imageUrl})};
  });
  const out: any = prepare(input); validate(out);
  input.forEach((row,i) => assert.deepEqual(opaque(out[i]), opaque(row)));
});
