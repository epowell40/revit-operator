import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createGoal, __testOnlyResetGoalListCache } from '../src/goals/service.js';
import { createAssignmentKernelForGoalV2 } from '../src/assignments/assignment_kernel_v2_factory.js';
import { getAssignmentKernelSnapshotV2 } from '../src/assignments/assignment_kernel_v2_store.js';
import { beginTeammateLoopOwner, endTeammateLoopOwner } from '../src/teammate_loop_runtime.js';
import { handleCodexDynamicToolCall } from '../src/brains/codex_dynamic_tool_handler.js';
import { runWithRequestContext } from '../src/request_context.js';
import { createOperatorBackendAuth } from '../src/operator_backend_auth.js';
import { canonicalJsonV2, deriveProgressGapsV2 } from '../src/domain/assignment-kernel/index.js';
import { controlAssignmentExecutionV2 } from '../src/assignments/assignment_kernel_v2_controls.js';

for (const variant of ['exact', 'batch_exact', 'batch_missing_target', 'missing_target', 'wrong_type', 'read_failure', 'schema_rejected', 'paused', 'stale', 'foreign_authority'] as const)
test(`committed type change ${variant}: separate guarded native read cannot erase the committed edit`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-type-check-'));
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  __testOnlyResetGoalListCache();
  try {
    await runWithRequestContext({ operator_backend_auth: createOperatorBackendAuth('shared_token', 'test-only') }, async () => {
      const f = JSON.parse(fs.readFileSync('test/fixtures/element-type-readback-37.json', 'utf8'));
      const batch = variant.startsWith('batch_');
      const ids = batch ? Array.from({ length: 100 }, (_, index) => 100 + index) : [f.input.body.elementId];
      if (batch) {
        f.input.body = { elementIds: ids, newTypeId: 1735582, dryRun: false };
        f.read.items = ids.map(id => ({ ...structuredClone(f.read.items[0]), id, uniqueId: 'native-' + id }));
      }
      const goal = createGoal({ title: 'Use the selected GFCI type', objective: 'Use the selected GFCI type.',
        acceptance_criteria: ['Requested type established.'], status: 'active', related_session_id: 'type-session',
        created_by: 'type-principal', work_budget: { requested_effect: 'apply', document_fingerprint: 'type-model' } });
      createAssignmentKernelForGoalV2({ goal, run_id: 'type-run' });
      const binding = getAssignmentKernelSnapshotV2(goal.id)!.current_binding;
      const calls: any[] = [], validations: any[] = [];
      const runtime: any = {
        assignmentKernelV2Binding: () => binding,
        queueAssignmentKernelV2TurnStop() {},
        async validateToolArguments(_tool: string, args: any) {
          validations.push(args);
          if (variant === 'schema_rejected' && args.path === '/revit/get-parameters') throw Error('read_schema_rejected');
        },
        async callTool(_tool: string, args: any, context: any) {
          calls.push(args);
          const lease = context.assignmentKernelV2;
          context.onMcpAccepted();
          const read = args.path === '/revit/get-parameters';
          if (read && variant === 'read_failure') throw Error('native_read_failed');
          const payload = read ? structuredClone(f.read) : { changedElementIds: ids, newTypeId: 1735582 };
          if (read && variant === 'missing_target') payload.items = [];
          if (read && variant === 'batch_missing_target') payload.items.pop();
          if (read && variant === 'wrong_type') {
            payload.items[0].parameterDetails[0].value = '1379884';
            payload.items[0].parameters.Type = '1379884';
          }
          const op = getAssignmentKernelSnapshotV2(goal.id)!.operations[lease.operation_id]!;
          if (!read && variant === 'paused') controlAssignmentExecutionV2({ binding, command_id: 'user-pause',
            expected_command_id: null, action: 'pause' });
          return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: {
            schema: 'revit-operator.assignment-kernel-mcp-result/v2', operation_result_v2: {
              schema: 'revit-operator.operation-result/v2', result_id: 'result:' + lease.operation_id,
              operation_id: lease.operation_id, binding, status: 'succeeded', dispatch_state: 'dispatched',
              persistent_effect: read ? 'none' : 'applied', native_transaction_state: read ? 'not_applicable' : 'committed',
              authority: read && variant === 'foreign_authority' ? 'model' : 'native-host',
              affected_target_identities: ids.map(id => 'element_id:' + id), result_schema_id: `operator-native/POST:${args.path}/v2`,
              observation_required: true, raw_payload_hash: createHash('sha256').update(canonicalJsonV2(payload)).digest('hex'),
              receipt_id: 'receipt:' + lease.operation_id, native_correlation_id: 'native:' + lease.operation_id,
              request_identity: lease.request_identity,
              completed_at: read && variant === 'stale' ? '2026-01-01T00:00:00Z' : new Date().toISOString()
            }, observation: { raw_payload: payload,
              semantic_facts: [{ fact_id: op.fulfillment_role === 'verification' ? 'verification.result_available' : 'control.result_available',
                fact_class: op.fulfillment_role === 'verification' ? 'verification' : 'control', value: true }],
              verification_relevance: ['control'] }
          } };
        }
      };
      const owner = beginTeammateLoopOwner(runtime, { version: 'operator.backend.v1', session_id: binding.session_id,
        message_id: 'type-task', user_text: goal.objective, assignment_id: binding.assignment_id,
        assignment_run_id: binding.run_id, assignment_generation: binding.generation } as any, { canonicalSupervisionOnly: true });
      try {
        const response: any = await handleCodexDynamicToolCall(runtime, { id: 'user-type-edit', method: 'item/tool/call',
          params: { namespace: 'revit_operator', turnId: 'type-turn', tool: 'revit_call_tool', arguments: f.input } } as any);
        __testOnlyResetGoalListCache();
        const s = getAssignmentKernelSnapshotV2(goal.id)!;
        const apply = Object.values(s.operations).find(o => o.persistent_effect === 'applied')!;
        assert.equal(apply.result?.persistent_effect, 'applied');
        assert.equal(response.success, true);
        assert.equal(calls.filter(c => c.path === '/revit/change-element-type').length, 1);
        assert.equal(validations.filter(c => c.path === '/revit/get-parameters').length, variant === 'paused' ? 0 : 1);
        assert.equal(calls.filter(c => c.path === '/revit/get-parameters').length, ['schema_rejected', 'paused'].includes(variant) ? 0 : 1);
        if (!['schema_rejected', 'paused'].includes(variant)) {
          assert.deepEqual(calls.find(c => c.path === '/revit/get-parameters').body.elementIds, ids);
        }
        const verified = apply.verification_operation_ids.some(id => s.operations[id]!.observation_ids.some(oid =>
          s.observations[oid]!.facts.some(fact => fact.fact_id === 'verification.postcondition_satisfied' && fact.value === true)));
        const expectedPass = variant === 'exact' || variant === 'batch_exact';
        assert.equal(verified, expectedPass);
        assert.equal(deriveProgressGapsV2(s).some(g => g.gap_id === 'verification:' + apply.operation_id), !expectedPass);
        assert.equal(Object.values(s.operations).filter(o => o.persistent_effect === 'applied').length, 1);
      } finally { endTeammateLoopOwner(owner); }
    });
  } finally {
    __testOnlyResetGoalListCache();
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    // This exact directory was created by this test under the temporary root.
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
