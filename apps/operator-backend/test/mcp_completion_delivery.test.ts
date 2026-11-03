import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { completionOutboxKeyV2, deliverCompletionOutboxV2, hydrateCompletionDeliveryV2,
  readCompletionOutboxV2, COMPLETION_DELIVERY_BUDGET_V2 } from '@revitoperator/assignment-kernel-v2-contracts/completion-outbox';
import { canonicalJsonV2 } from '../src/domain/assignment-kernel/index.js';
import { CodexMcpToolRuntime } from '../src/codex/mcp_tool_runtime.js';
import { SUPPORTED_TOOL_INVENTORY_HASH } from '../src/capabilities/supported_tool_inventory.js';
import { createGoal, __testOnlyResetGoalListCache } from '../src/goals/service.js';
import { createAssignmentKernelForGoalV2 } from '../src/assignments/assignment_kernel_v2_factory.js';
import { getAssignmentKernelSnapshotV2 } from '../src/assignments/assignment_kernel_v2_store.js';
import { openAssignmentKernelOperationV2, markAssignmentKernelOperationDispatchStartedV2,
  settleAssignmentKernelOperationV2 } from '../src/assignments/assignment_kernel_v2_execution.js';

function makeEnvelope(lease: any, payload: any, unknown = false): any {
  return { content: [{ type: 'text', text: 'Scoped inspection presentation' }], structuredContent: {
    schema: 'revit-operator.assignment-kernel-mcp-result/v2', operation_result_v2: {
      schema: 'revit-operator.operation-result/v2', result_id: `result-${lease.operation_id}`,
      operation_id: lease.operation_id, binding: lease.binding, request_identity: lease.request_identity,
      status: unknown ? 'failed_after_dispatch' : 'succeeded', dispatch_state: 'dispatched',
      persistent_effect: unknown ? 'unknown' : 'none', native_transaction_state: unknown ? 'unknown' : 'not_applicable',
      authority: 'native-host', result_schema_id: 'operator-capability/inventory.read/v2',
      observation_required: true, raw_payload_hash: createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
      receipt_id: `receipt-${lease.operation_id}`, native_correlation_id: `native-${lease.operation_id}`,
      completed_at: new Date().toISOString()
    }, observation: { raw_payload: payload, semantic_facts: [], verification_relevance: ['execution'] }
  } };
}
const lease: any = { binding: { assignment_id: 'delivery-assignment', run_id: 'delivery-run', session_id: 'delivery-session',
  principal_id: 'delivery-principal', generation: 1 }, operation_id: 'delivery-operation', request_identity: { request_signature: 'delivery-request' } };

test('small and error envelopes retain their presentation and exact canonical metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-small-delivery-'));
  try {
    const key = completionOutboxKeyV2(root);
    const envelope = { ...makeEnvelope(lease, { message: 'native failure', values: ['diameter', '\u00d8', '\r\n'] }), isError: true };
    assert.strictEqual(deliverCompletionOutboxV2(root, key, lease, envelope), envelope);
    assert.strictEqual(hydrateCompletionDeliveryV2(root, key, lease, envelope), envelope);
    assert.deepEqual((readCompletionOutboxV2(root, key, lease) as any).structuredContent, envelope.structuredContent);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('oversized pixels are explicitly unavailable while canonical observation remains exact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-image-delivery-'));
  try {
    const key = completionOutboxKeyV2(root), envelope = makeEnvelope(lease, { complete: true, values: [1, 2, 3] });
    envelope.content = [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(11 * 1024 * 1024) }];
    const projected = deliverCompletionOutboxV2(root, key, lease, envelope);
    assert(Buffer.byteLength(JSON.stringify(projected)) < COMPLETION_DELIVERY_BUDGET_V2);
    assert.match(projected.content[0].text, /no image was delivered/);
    assert(!projected.content.some((item: any) => item.type === 'image'));
    assert.deepEqual(hydrateCompletionDeliveryV2(root, key, lease, projected).structuredContent, envelope.structuredContent);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing, forged, foreign and stale references cannot select or replace a retained result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bad-delivery-'));
  try {
    const key = completionOutboxKeyV2(root), envelope = makeEnvelope(lease, { data: 'x'.repeat(9 * 1024 * 1024) });
    const projected = deliverCompletionOutboxV2(root, key, lease, envelope);
    assert.throws(() => hydrateCompletionDeliveryV2(root, key, undefined, projected), /delivery_lease_missing/);
    for (const binding of [{ ...lease, operation_id: 'other' }, { ...lease, binding: { ...lease.binding, generation: 2 } },
      { ...lease, request_identity: { request_signature: 'other' } }]) {
      assert.throws(() => hydrateCompletionDeliveryV2(root, key, binding, projected), /delivery_identity_mismatch/);
    }
    const forged = structuredClone(projected);
    forged.structuredContent.structured_sha256 = '0'.repeat(64);
    assert.throws(() => hydrateCompletionDeliveryV2(root, key, lease, forged), /delivery_digest_mismatch/);
    forged.structuredContent.path = 'other.json';
    assert.throws(() => hydrateCompletionDeliveryV2(root, key, lease, forged), /delivery_reference_invalid/);
    assert.throws(() => hydrateCompletionDeliveryV2(root, '0'.repeat(64), lease, projected), /signature_invalid/);
    const records = path.join(root, 'runtime', 'assignment-completions-v2');
    const file = fs.readdirSync(records).find(name => name.endsWith('.json'))!;
    fs.unlinkSync(path.join(records, file));
    assert.throws(() => hydrateCompletionDeliveryV2(root, key, lease, projected), /delivery_record_missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Public-safe cardinality regression for a large native inspection plus bounded
// image presentation. Exact retained private incident is replayed separately.
for (const unknown of [false, true]) test(`real stdio adapter hydrates full ${unknown ? 'uncertain apply' : 'read'} result, settles honestly and remains connected`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-large-delivery-'));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root; __testOnlyResetGoalListCache();
  let runtime: CodexMcpToolRuntime | undefined;
  try {
    const goal = createGoal({ title: 'Inspect model', objective: 'Inspect the requested model area.', status: 'active',
      acceptance_criteria: ['Requested work independently established.'], related_session_id: 'delivery-session',
      created_by: 'delivery-principal', work_budget: { requested_effect: unknown ? 'apply' : 'read', document_fingerprint: 'delivery-model' } });
    createAssignmentKernelForGoalV2({ goal, run_id: 'delivery-run' });
    const operation = openAssignmentKernelOperationV2({ snapshot: getAssignmentKernelSnapshotV2(goal.id)!,
      controller_request_id: 'delivery-request', provider_turn_id: 'delivery-turn', capability_id: unknown ? 'element.update' : 'inventory.read',
      classified_effect: unknown ? 'apply' : 'read', arguments: {} });
    markAssignmentKernelOperationDispatchStartedV2(operation);
    const payload = { complete: true, count: 1, elements: [{ id: 42, nativeData: 'x'.repeat(10 * 1024 * 1024) }] };
    const envelope = makeEnvelope(operation, payload, unknown);
    envelope.content = [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(600_000) }];
    fs.mkdirSync(path.join(root, 'operator-backend'));
    fs.mkdirSync(path.join(root, 'mcp-server', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mcp-server', 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(root, 'input.json'), JSON.stringify({ operation, envelope }));
    fs.writeFileSync(path.join(root, 'mcp-server', 'dist', 'server.js'), `
      import fs from 'node:fs';
      import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
      import { deliverCompletionOutboxV2 } from ${JSON.stringify(import.meta.resolve('@revitoperator/assignment-kernel-v2-contracts/completion-outbox'))};
      const root = ${JSON.stringify(root)}, input = JSON.parse(fs.readFileSync(root + '/input.json', 'utf8'));
      const server = new McpServer({name:'bounded-delivery',version:'1'});
      server.tool('operator_runtime_probe','Probe',{},async()=>({content:[{type:'text',text:JSON.stringify({status:'ok',
        protocol:'operator.mcp.runtime.v1',supportedToolInventory:{hash:${JSON.stringify(SUPPORTED_TOOL_INVENTORY_HASH)}}})}]}));
      server.tool('revit_get_context','Fixture inspection',{},async()=>{
        fs.appendFileSync(root + '/dispatches', 'once\\n');
        return deliverCompletionOutboxV2(root, process.env.OPERATOR_ASSIGNMENT_COMPLETION_OUTBOX_KEY, input.operation, input.envelope);
      });
      await server.connect(new StdioServerTransport());
    `);
    runtime = new CodexMcpToolRuntime({ backendCwd: path.join(root, 'operator-backend'), workspaceRoot: root, codexHome: root,
      spawnEnv: { OPERATOR_MCP_TOOL_TIMEOUT_MS: '10000' } });
    const authLease = runtime.beginBackendAuthLease('delivery-session', { schema: 'revit-operator.operator-backend-auth/v1',
      mode: 'shared_token', credential: 'test-only-delivery', allowed_origin: 'http://127.0.0.1:7007' });
    runtime.bindBackendAuthLeaseTurn(authLease, 'delivery-turn');
    const binding = { turnId: 'delivery-turn', sessionId: 'delivery-session', assignmentKernelV2: operation };
    const hydrated = await runtime.callTool('revit_get_context', {}, binding);
    assert.deepEqual(hydrated.structuredContent, envelope.structuredContent);
    assert.deepEqual(hydrated.content, envelope.content);
    const settled = settleAssignmentKernelOperationV2(operation, hydrated);
    assert.equal(settled.result.persistent_effect, unknown ? 'unknown' : 'none');
    assert.notEqual(settled.snapshot.outcome, 'complete');
    assert.equal(Object.keys(settled.snapshot.observations).length, 1);
    assert.deepEqual(settleAssignmentKernelOperationV2(operation, hydrated).snapshot, settled.snapshot, 'duplicate delivery is idempotent');
    const next = await runtime.callTool('operator_runtime_probe', {}, binding);
    assert.match(next.content[0].text, /operator.mcp.runtime.v1/);
    assert.equal(fs.readFileSync(path.join(root, 'dispatches'), 'utf8'), 'once\n', 'no native replay');
  } finally {
    runtime?.stop(); __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
