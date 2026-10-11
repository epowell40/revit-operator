import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicReceiptActions, sidecarFunctionReceiptActions, extractGeneralRevitToolCalls } from '../src/benchmark/general_revit_tool_call_projection.js';

test('projects delegated native route previews from durable operations when outer rounds are absent', () => {
  const calls = extractGeneralRevitToolCalls({
    rounds: [],
    assignment_kernel_v2: {
      assignments: [{ snapshot: { operations: {
        route: {
          operation_id: 'op-route', requested_effect: 'preview',
          input: { method: 'POST', path: '/revit/create-mep-route', body: { dryRun: true } },
          result: { status: 'failed_after_dispatch', dispatch_state: 'dispatched',
            native_transaction_state: 'rolled_back', error_code: 'native_domain_operation_failed' },
        },
        commentary: { operation_id: 'op-commentary', input: { text: 'thinking' } },
      } } }],
    },
  });
  assert.deepEqual(calls, [{
    action_id: 'op-route', method: 'POST', path: '/revit/create-mep-route',
    request_effect: 'preview', request_dispatched: true, status: 'failed',
    arguments: { dryRun: true }, source: 'durable_assignment_kernel_v2',
    native_transaction_state: 'rolled_back', error_code: 'native_domain_operation_failed',
  }]);
});

test('retains original outer action rows when they are present', () => {
  const outer = { action_id: 'outer', path: '/revit/find-elements', status: 'success' };
  assert.deepEqual(extractGeneralRevitToolCalls({
    rounds: [{ actions: [outer] }],
    assignment_kernel_v2: { assignments: [{ snapshot: { operations: {} } }] },
  }), [outer]);
});

test('projects independently loaded assignment operations from the enriched benchmark attempt', () => {
  const sidecarAttempt = { rounds: [] };
  const loadedAssignment = { assignments: [{ snapshot: { operations: {
    read: { operation_id: 'op-read', requested_effect: 'read',
      input: { method: 'GET', path: '/revit/get-connectors' },
      result: { status: 'completed', dispatch_state: 'dispatched' } },
    route: { operation_id: 'op-preview', requested_effect: 'preview',
      input: { method: 'POST', path: '/revit/create-mep-route', body: { dryRun: true } },
      result: { status: 'failed_after_dispatch', dispatch_state: 'dispatched',
        native_transaction_state: 'rolled_back' } },
  } } }] };
  assert.deepEqual(extractGeneralRevitToolCalls(sidecarAttempt), []);
  const projected = extractGeneralRevitToolCalls({
    ...sidecarAttempt, assignment_kernel_v2: loadedAssignment,
  });
  assert.equal(projected.length, 2);
  assert.equal(projected.find((call) => call.action_id === 'op-preview')?.request_effect, 'preview');
  assert.equal(projected.find((call) => call.action_id === 'op-preview')?.native_transaction_state, 'rolled_back');
});

test('receipt projection preserves failed and undispatched actions without inventing success', () => {
  const dynamic = { run_id: 'failed-apply', requested_mode: 'apply', execution_ok: false };
  assert.deepEqual(dynamicReceiptActions({ dynamicProgramReceipts: [dynamic] }), [{
    action_id: 'failed-apply', method: 'POST', path: '/revit/dynamic-runtime/apply',
    request_effect: 'apply', request_dispatched: false, status: 'failed', receipt: dynamic,
  }]);
  const native = { call_id: 'unknown', path: '/revit/place-view-on-sheet', request_effect: 'apply',
    request_dispatched: true, status: 'unknown' };
  assert.deepEqual(sidecarFunctionReceiptActions({ functionToolReceipts: [native] }), [{
    action_id: 'unknown', method: 'POST', path: native.path, request_effect: 'apply',
    request_dispatched: true, status: 'unknown', receipt: native,
  }]);
  assert.deepEqual(dynamicReceiptActions({}), []);
  assert.deepEqual(sidecarFunctionReceiptActions({ functionToolReceipts: {} }), []);
});
