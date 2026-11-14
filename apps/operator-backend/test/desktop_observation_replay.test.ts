import test from 'node:test';
import assert from 'node:assert/strict';
import { packHistoricalObservationFields } from '../src/desktop_observation_replay.js';

const check = { operation_id: 'apply-a', read_operation_id: 'read-a', check_state: 'verified_current',
  scope: 'Supported read only; not whole-model proof.', evidence_id: 'evidence-a',
  checked_preservation_ids: Array.from({ length: 50 }, (_, i) => 'element:' + i) };
const candidate = { read_operation_id: 'read-a', validation_required: true,
  requested_target_ids: Array.from({ length: 70 }, (_, i) => 'element:' + i) };
const index = (used: number, patch: any = {}) => ({ schema: 'revit-operator.model-observation-index/v2',
  host_budget: { used }, verified_postconditions: [check], inspection_read_candidates: [candidate],
  observations: [{ evidence_id: 'evidence-' + used }], pending_verification: [{ check_state: 'previous_check_stale' }],
  pending_verification_projection: { complete: false }, omitted: 5, usage: 'Never substitute operation IDs.', ...patch });
const pair = (id: string, value: any, name = 'native__revit_call_tool'): any[] => [
  { type: 'function_call', name, call_id: id, arguments: '{}' },
  { type: 'function_call_output', call_id: id, output: [{ type: 'input_text', text: JSON.stringify(value) }] }
];
const value = (rows: any[], i: number) => JSON.parse(rows[i].output[0].text);

test('exact repeated fields reference a literal later copy; unique evidence, pending checks and budgets remain', () => {
  const history = [...pair('old', index(1)), ...pair('new', index(2))], raw = structuredClone(history);
  const packed = packHistoricalObservationFields(history, []), old = value(packed.input, 1);
  assert.equal(packed.omittedFields, 2); assert(packed.bytesSaved > 700);
  assert.equal(old.verified_postconditions, undefined);
  assert.equal(old.inspection_read_candidates, undefined);
  for (const field of ['verified_postconditions', 'inspection_read_candidates']) {
    assert.equal(old.replay_exact_fields[field].call_id, 'new');
    assert.match(old.replay_exact_fields[field].field_sha256, /^[a-f0-9]{64}$/);
  }
  for (const key of ['host_budget', 'observations', 'pending_verification', 'pending_verification_projection', 'omitted', 'usage'])
    assert.deepEqual(old[key], index(1)[key as keyof ReturnType<typeof index>]);
  assert.deepEqual(packed.input.slice(-2), history.slice(-2)); assert.deepEqual(history, raw);
  assert.match(old.replay_notice, /neither a duplicate nor its hash grants freshness/);
});

test('fresh outputs are unchanged and subsequent replay points directly to the newest literal, not a chain', () => {
  const history = pair('old', index(1)), fresh = pair('middle', index(2)), raw = structuredClone(fresh);
  const first = packHistoricalObservationFields(history, fresh);
  assert.deepEqual(fresh, raw);
  const next = pair('latest', index(3));
  const second = packHistoricalObservationFields([...first.input, ...fresh], next);
  for (const n of [1, 3]) for (const field of ['verified_postconditions', 'inspection_read_candidates'])
    assert.equal(value(second.input, n).replay_exact_fields[field].call_id, 'latest');
  assert.deepEqual(next, pair('latest', index(3)));
});

test('changed, stale, invalidated and foreign evidence never aliases a different check', () => {
  for (const patch of [{ check_state: 'previous_check_stale' }, { evidence_id: 'foreign' },
    { operation_id: 'other' }, { invalidated: true }, { scope: 'Different scope' }]) {
    const old = index(1), fresh = index(2, { verified_postconditions: [{ ...check, ...patch }] });
    const packed = packHistoricalObservationFields(pair('old', old), pair('new', fresh));
    assert.deepEqual(value(packed.input, 1).verified_postconditions, old.verified_postconditions);
  }
});

test('opaque state, images, user lookalikes, unknown tools, malformed and future contracts stay exact', () => {
  const unknown = pair('x', index(1), 'arbitrary_tool');
  const items: any[] = [{ role: 'user', content: JSON.stringify(index(1)) },
    { type: 'compaction', encrypted_content: 'opaque' }, { type: 'reasoning', encrypted_content: 'opaque' },
    ...unknown, ...pair('y', index(1, { schema: 'future' })),
    ...pair('future-marker',index(1,{replay_exact_fields:'future metadata'}))];
  const image = { type: 'input_image', image_url: 'data:image/png;base64,AQID' };
  items.push(...pair('z', index(1))); items.at(-1).output = [image, { type: 'input_text', text: '{bad JSON' }];
  const raw = structuredClone(items);
  assert.deepEqual(packHistoricalObservationFields(items, pair('new', index(2))).input, raw);
});

test('empty, small, string, error and null fields are not rewritten or interpreted as absence', () => {
  for (const field of [[], null, 'unknown', { error: 'unavailable' }, [{ operation_id: 'tiny' }]]) {
    const old = index(1, { verified_postconditions: field, inspection_read_candidates: field });
    const items = pair('old', old);
    assert.deepEqual(packHistoricalObservationFields(items, pair('new', old)).input, items);
  }
});

test('one index can be followed by images and a failed result without removing either', () => {
  const items = pair('old', index(1));
  items[1].output.push({ type: 'input_text', text: JSON.stringify({ error: 'unknown_effect', pause: true }) },
    { type: 'input_image', image_url: 'data:image/png;base64,AQID' });
  const packed = packHistoricalObservationFields(items, pair('new', index(2)));
  assert.deepEqual(packed.input[1].output.slice(1), items[1].output.slice(1));
});

test('pending transitions stay distinct; identical repeated pending details remain literal later, never an empty list', () => {
  const pending={...check,check_state:'previous_check_stale',latest_check:{state:'unavailable',reason:'native_comparison_not_established'}};
  const first=pair('first',index(1,{pending_verification:[pending]}));
  const duplicate=pair('second',index(2,{pending_verification:[pending]}));
  const resolved=pair('resolved',index(3,{pending_verification:[]}));
  const packed=packHistoricalObservationFields([...first,...duplicate],resolved);
  assert.equal(value(packed.input,1).pending_verification,undefined);
  assert.equal(value(packed.input,1).replay_exact_fields.pending_verification.call_id,'second');
  assert.deepEqual(value(packed.input,3).pending_verification,[pending]);
  assert.deepEqual(resolved,pair('resolved',index(3,{pending_verification:[]})));
});
