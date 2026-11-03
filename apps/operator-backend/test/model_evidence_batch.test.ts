import assert from 'node:assert/strict';
import test from 'node:test';
import * as context from '../src/evidence/model_context_budget.js';
import {batch as requiredReadBatch} from './model_evidence_read_batch.fixtures.js';

const prepare = context.prepareBoundedModelEvidenceInput as (input: any, budget?: context.EvidenceContextBudget) => any;
const projection = (id: string, native = false): any => ({
  schema: 'revit-operator.evidence-projection.v1', evidence_id: `ev1_${id}`,
  content_hash: 'sha256:' + 'a'.repeat(64), byte_count: 20000,
  source: native ? 'assignment_kernel_v2:revit_call_tool' : `desktop_native_transport:${id}:1`,
  media_type: 'application/json', trust_level: native ? 'authoritative_native' : 'untrusted_caller',
  effect_state: null, assignment_id: 'assignment', run_id: 'run', attempt_id: null, generation: 1,
  target_scope: ['sheet'], key_counts: { 'pending_verification.length': 1 },
  key_facts: { 'observations[0].operation_id': 'operation-' + 'x'.repeat(5800) },
  before_hash: null, after_hash: null, diagnostics: [], artifact_ref: `ev1_${id}`,
  verification_relevance: native ? 'required' : 'supporting', additional_evidence: true,
  retrieval: { tool_name: 'operator_retrieve_evidence', max_bytes: 1048576 },
  projected_bytes: 7200, truncated: true
});
const envelope = (p: any) => JSON.stringify({schema: context.MODEL_EVIDENCE_ENVELOPE_SCHEMA,
  evidence_projections: [p], omitted: 0, retrieval: 'Retrieve missing fields by evidence ID; partial is not absence.'});
const batch = () => Array.from({length: 6}, (_, i) => ({type: 'function_call_output', call_id: `call${i}`,
  output: [{type: 'input_text', text: envelope(projection(`call${i}`, i === 5))}]}));

test('individually valid tool results share one unchanged request budget', () => {
  const input = batch(), original = JSON.stringify(input);
  for (const row of input) context.assertBoundedModelEvidencePayload(row);
  assert.throws(() => context.assertBoundedModelEvidencePayload(input), /32768-byte model-request/);
  const result = prepare(input);
  assert(context.assertBoundedModelEvidencePayload(result).projected_bytes <= 32768);
  assert.equal(JSON.stringify(input), original, 'durable source and input are not mutated');
  assert.deepEqual(result.map((r: any) => r.call_id), input.map(r => r.call_id));
  assert.deepEqual(result.at(-1), input.at(-1), 'required native projection remains exact');
});

test('under-budget text, image, feedback and steering are byte-exact', () => {
  const input = [batch()[0], {type: 'function_call_output', call_id: 'image', output: [
    {type: 'input_image', image_url: 'data:image/png;base64,AAAA'},
    {type: 'input_text', text: '{"stop_reason":"unknown_effect","success":false}'}]},
    {role: 'user', content: [{type: 'input_text', text: 'Pause; retain unfinished work.'}]}];
  assert.strictEqual(prepare(input), input);
});

test('compaction explicitly preserves source binding, controls and retrieval without absence claims', () => {
  const input = batch(), result = prepare(input);
  let compacted = 0;
  result.forEach((r: any, i: number) => {
    const before = JSON.parse(input[i].output[0].text).evidence_projections[0];
    const after = JSON.parse(r.output[0].text).evidence_projections[0];
    if (r.output[0].text === input[i].output[0].text) return;
    compacted++;
    for (const key of Object.keys(before).filter(k => !['key_counts', 'key_facts', 'diagnostics', 'truncated', 'additional_evidence'].includes(k)))
      assert.deepEqual(after[key], before[key], key);
    assert.equal(after.truncated, true); assert.equal(after.additional_evidence, true);
    assert.deepEqual(after.key_counts, {}); assert.deepEqual(after.key_facts, {});
    assert.match(after.diagnostics.at(-1), /summary_fields_omitted_for_batch_budget/);
    assert.match(after.diagnostics.at(-1), /not absence|not proof/);
  });
  assert(compacted > 0);
});

test('invalid raw/items/envelopes and irreducible native batches still fail closed', () => {
  for (const output of ['x'.repeat(8193), [{type: 'bogus', text: 'x'}],
    envelope({...projection('oversize'), extra: 'x'.repeat(9000)})])
    assert.throws(() => prepare([{type: 'function_call_output', output}]));
  const native = batch().map((r, i) => ({...r, output: [{type: 'input_text', text: envelope(projection(`native${i}`, true))}]}));
  assert.throws(() => prepare(native), /32768-byte model-request/);
});

test('unknown/applied effects and non-transport supporting sources are not compacted', () => {
  for (const change of [{effect_state: 'unknown'}, {effect_state: 'applied'},
    {source: 'other'}, {trust_level: 'authoritative_native'}, {verification_relevance: 'required'},
    {content_hash: 'bad'}, {retrieval: null}]) {
    const input = batch().map((r, i) => ({...r, output: [{type: 'input_text', text: envelope({...projection(`p${i}`), ...change})}]}));
    assert.throws(() => prepare(input), /32768-byte model-request/);
  }
});

test('Unicode bytes, stable choice, custom smaller budgets and idempotence are respected', () => {
  const input = batch().slice(0, 2).map((r, i) => ({...r, output: [{type: 'input_text',
    text: envelope({...projection(`unicode${i}`), key_facts: {label: '\u5b57'.repeat(1800)}})}]}));
  const budget = {item_bytes: 8192, request_bytes: 10000};
  assert.throws(() => context.assertBoundedModelEvidencePayload(input, budget));
  const result = prepare(input, budget);
  context.assertBoundedModelEvidencePayload(result, budget);
  assert.deepEqual(prepare(input, budget), result);
  assert.strictEqual(prepare(result, budget), result);
});

test('overflow preserves every image, raw failure/control, visual check and current feedback', () => {
  const input: any[] = batch();
  input[0].output.push({type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'original'});
  input[1].output.push({type: 'input_text', text: '{"success":false,"stop_reason":"unknown_effect","pending_usage":1}'});
  input.push({role: 'user', content: [{type: 'input_text', text: 'Current control: Pause. Unreviewed. No completion.'}]});
  const envelopeWithReview = JSON.parse(input[0].output[0].text);
  envelopeWithReview.evidence_projections[0].visual_work_review = {state: 'uncertain', checks: [{id: 'readable', status: 'failed'}]};
  input[0].output[0].text = JSON.stringify(envelopeWithReview);
  const result = prepare(input);
  assert.deepEqual(result[0].output[1], input[0].output[1]);
  assert.deepEqual(result[1].output[1], input[1].output[1]);
  assert.deepEqual(result.at(-1), input.at(-1));
  assert.deepEqual(JSON.parse(result[0].output[0].text).evidence_projections[0].visual_work_review,
    envelopeWithReview.evidence_projections[0].visual_work_review);
});

test('actual relay batches once, appends current canonical feedback, and retains usage without another provider turn', async () => {
  const {default: fs} = await import('node:fs'), {default: os} = await import('node:os');
  const {default: path} = await import('node:path'), {default: http} = await import('node:http');
  const {relayBoundDesktopComputerResponse} = await import('../src/desktop_computer.js');
  const {createGoal, __testOnlyResetGoalListCache} = await import('../src/goals/service.js');
  const {createAssignmentKernelForGoalV2} = await import('../src/assignments/assignment_kernel_v2_factory.js');
  const {getAssignmentKernelSnapshotV2} = await import('../src/assignments/assignment_kernel_v2_store.js');
  const keys = ['OPERATOR_WORKSPACE_ROOT', 'OPERATOR_OPENAI_API_KEY', 'OPERATOR_OPENAI_BASE_URL'];
  const prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-batch-'));
  const received: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({id: `response-batch-${received.length}`, status: 'completed', model: 'gpt-6.1-terra', output: [],
        usage: {input_tokens: 100, output_tokens: 2, total_tokens: 102}}));
    });
  });
  try {
    process.env.OPERATOR_WORKSPACE_ROOT = root; process.env.OPERATOR_OPENAI_API_KEY = 'synthetic-key';
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    process.env.OPERATOR_OPENAI_BASE_URL = 'http://127.0.0.1:' + (server.address() as any).port;
    __testOnlyResetGoalListCache();
    const goal = createGoal({title: 'Read current facts', objective: 'Inspect current model facts.',
      acceptance_criteria: ['Report facts.'], status: 'active', related_session_id: 'batch',
      created_by: 'test-principal', work_budget: {requested_effect: 'read'}});
    const binding = {...createAssignmentKernelForGoalV2({goal, run_id: 'batch-run'}), kernelVersion: 2 as const};
    const committedBatch=JSON.parse(fs.readFileSync(path.resolve('test/fixtures/committed-native-batch384.json'),'utf8'));
    for (const [index, input] of [batch(), requiredReadBatch(),committedBatch].entries()) {
      await relayBoundDesktopComputerResponse({model: 'gpt-6.1-terra', input, message_id: `batch-message-${index}`}, binding);
      assert.equal(received.length, index + 1);
      const sent = received[index].input;
      context.assertBoundedModelEvidencePayload(sent);
      assert.deepEqual(sent.filter((v: any) => v.type === 'function_call_output').map((v: any) => v.call_id), input.map((v:any) => v.call_id));
      assert.match(JSON.stringify(sent.at(-1)), /assignment_version/);
    }
    const snapshot = getAssignmentKernelSnapshotV2(goal.id)!;
    assert.equal(snapshot.outcome, 'active');
    assert.equal(snapshot.in_flight_provider_call_ids.length, 0);
    assert.deepEqual(Object.values(snapshot.provider_calls).map(c => c.usage?.total_tokens), [102, 102,102]);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    __testOnlyResetGoalListCache(); fs.rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  }
});
