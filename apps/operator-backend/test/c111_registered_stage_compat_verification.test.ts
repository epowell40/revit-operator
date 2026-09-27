import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { beginTeammateLoopOwner, endTeammateLoopOwner, guardTeammateMcpCall,
  __testOnlyResetTeammateLoopState } from '../src/teammate_loop_runtime.js';
import { reconcileCanonicalToolVerification, reconcileCanonicalOutstandingVerification } from '../src/teammate_verification_state.js';
import type { AssignmentSnapshotV2 } from '../src/domain/assignment-kernel/snapshot.js';

const applyId = 'opv2_c111_supply_apply';
const readId = 'opv2_c111_supply_connectors';
const path = '/revit/existing-conditions-mep-draft-workflow';
const sentinel = { registered_stage_key: 'operation:registered-route:supply8', stage_phase: 'apply', dryRun: false };
const expanded = { inputFingerprintSha256: 'f'.repeat(64), stageKey: sentinel.registered_stage_key,
  operations: [{ action_key: 'registered-route:supply8', path: '/revit/create-mep-route', apply_body: { kind: 'duct' } }],
  dryRun: false, verify: true };

function scenario() {
  __testOnlyResetTeammateLoopState();
  const owner = {};
  const lease = beginTeammateLoopOwner(owner, {
    version: 'revit-operator.backend.v1', session_id: 'session-c111', message_id: 'message-c111',
    user_text: 'Reconstruct and connect the ducts in this room, then verify and continue to the next section.',
    context: { revit: { source: { live: true }, process_id: 1, courier_executor_id: 'executor-c111',
      document: { title: 'C111 disposable', path: 'C:\\fixtures\\c111.rvt', projectIdentity: { fingerprint: 'c111' } } } }
  } as any);
  const gate = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path, body: sentinel } });
  assert.equal(gate.allowed, true, gate.message);
  const state = gate.state!;
  assert.equal(state.apply_call?.raw_body && JSON.stringify(state.apply_call.raw_body), JSON.stringify(sentinel));
  state.apply_succeeded = true;
  const binding = { session_id: 'session-c111', assignment_id: 'assignment-c111', run_id: 'run-c111', generation: 1,
    principal_id: 'local:test', document_fingerprint: 'c111' };
  const snapshot = {
    current_binding: binding,
    operations: {
      [applyId]: { operation_id: applyId, binding, requested_effect: 'apply', persistent_effect: 'applied',
        settlement_state: 'settled', request_identity: { path }, input: { method: 'POST', path, body: expanded } },
      [readId]: { operation_id: readId, binding, requested_effect: 'read', persistent_effect: 'none',
        settlement_state: 'settled', purpose: 'verification', fulfillment_role: 'verification',
        verification_of_operation_id: applyId, observation_ids: ['observation-c111'],
        result: { status: 'succeeded', raw_payload_hash: 'a'.repeat(64) } }
    },
    observations: { 'observation-c111': { operation_id: readId, binding, authority: 'native-host',
      raw_payload_hash: 'a'.repeat(64), facts: [{ fact_id: 'verification.postcondition_satisfied',
        fact_class: 'verification', value: true }] } }
  } as unknown as AssignmentSnapshotV2;
  return { owner, lease, state, snapshot };
}

test('C111 compact registered-stage apply follows exact canonical operation and native proof', () => {
  const { owner, lease, state, snapshot } = scenario();
  try {
    reconcileCanonicalToolVerification(state, snapshot, applyId);
    assert.equal(state.apply_operation_id, applyId);
    reconcileCanonicalToolVerification(state, snapshot, readId);
    assert.equal(state.verified, true);
    assert.equal(state.verification_action_id, readId);
    const next = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path,
      body: { registered_stage_key: 'operation:registered-route:return8', stage_phase: 'dry_run', dryRun: true } } });
    assert.equal(next.allowed, true, next.message);
  } finally { endTeammateLoopOwner(lease); }
});

test('C111 rejects a verified read for another apply even on the same route', () => {
  const { owner, lease, state, snapshot } = scenario();
  try {
    reconcileCanonicalToolVerification(state, snapshot, applyId);
    (snapshot.operations[readId] as any).verification_of_operation_id = 'opv2_other_apply';
    reconcileCanonicalToolVerification(state, snapshot, readId);
    assert.equal(state.verified, false);
    const next = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path,
      body: { registered_stage_key: 'operation:registered-route:return8', stage_phase: 'dry_run', dryRun: true } } });
    assert.equal(next.allowed, false);
  } finally { endTeammateLoopOwner(lease); }
});

test('C111 rejects a same-operation read without native postcondition proof', () => {
  const { lease, state, snapshot } = scenario();
  try {
    reconcileCanonicalToolVerification(state, snapshot, applyId);
    (snapshot.observations['observation-c111'] as any).facts = [];
    reconcileCanonicalToolVerification(state, snapshot, readId);
    assert.equal(state.verified, false);
  } finally { endTeammateLoopOwner(lease); }
});

test('C150 repairs a stale compatibility guard from exact settled native proof before the next stage', () => {
  const { owner, lease, state, snapshot } = scenario();
  try {
    state.apply_succeeded = false; // A transport/parser disagreement cannot erase a native applied effect.
    (snapshot.operations[applyId] as any).result = { status: 'succeeded', authority: 'native-host' };
    (snapshot.operations[applyId] as any).input.body = { ...expanded, stageKey: sentinel.registered_stage_key };
    (snapshot.operations[applyId] as any).persistent_effect = 'applied';
    const next = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path,
      body: { registered_stage_key: 'operation:registered-route:west8', stage_phase: 'dry_run', dryRun: true } } }, snapshot);
    assert.equal(next.allowed, true, next.message);
  } finally { endTeammateLoopOwner(lease); }
});

test('C150 cannot repair the guard from a different stage or an unproved read', () => {
  const { owner, lease, state, snapshot } = scenario();
  try {
    state.apply_succeeded = false;
    (snapshot.operations[applyId] as any).result = { status: 'succeeded', authority: 'native-host' };
    (snapshot.operations[applyId] as any).input.body = { ...expanded, stageKey: 'operation:registered-route:other' };
    assert.equal(reconcileCanonicalOutstandingVerification(state, snapshot), false);
    assert.equal(state.verified, false);
    const denied = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path,
      body: { registered_stage_key: 'operation:registered-route:west8', stage_phase: 'dry_run', dryRun: true } } }, snapshot);
    assert.equal(denied.allowed, false);
    (snapshot.operations[applyId] as any).input.body.stageKey = sentinel.registered_stage_key;
    (snapshot.observations['observation-c111'] as any).facts = [];
    assert.equal(reconcileCanonicalOutstandingVerification(state, snapshot), false);
    assert.equal(state.verified, false);
  } finally { endTeammateLoopOwner(lease); }
});

test('C150 exact retained Unit 404 native graph reopens only its verified next-stage gate', () => {
  const retained = JSON.parse(readFileSync('test/fixtures/c150-verified-east-route-guard.json', 'utf8'));
  const { owner, lease, state } = scenario();
  try {
    state.key = `${retained.current_binding.session_id}::message-c150`;
    state.apply_call = { ...state.apply_call!, ...retained.apply_call };
    state.apply_succeeded = false;
    const graph = { current_binding: retained.current_binding, operations: retained.operations,
      observations: retained.observations } as AssignmentSnapshotV2;
    assert.equal(reconcileCanonicalOutstandingVerification(state, graph), true);
    assert.equal(state.apply_operation_id, retained.apply_id);
    assert.equal(state.verification_action_id, retained.read_id);
    const next = guardTeammateMcpCall(owner, { tool: 'revit_call_tool', arguments: { method: 'POST', path,
      body: { registered_stage_key: 'operation:registered-route:404-west-8', stage_phase: 'dry_run', dryRun: true } } }, graph);
    assert.equal(next.allowed, true, next.message);
  } finally { endTeammateLoopOwner(lease); }
});
