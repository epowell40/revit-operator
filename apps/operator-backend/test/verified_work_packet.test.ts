import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  assignmentActionSignature,
  type AssignmentAttemptEvent,
  type AssignmentControlPlaneLog,
  type AssignmentRequestedEffect
} from "../src/assignments/control_plane.js";
import type { GoalRecord } from "../src/goals/service.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { generateVerifiedWorkPacket, verifyVerifiedWorkPacketHash } from "../src/work_packets/generator.js";
import { listVerifiedWorkPackets, persistVerifiedWorkPacket, readLatestVerifiedWorkPacket } from "../src/work_packets/store.js";
import { renderVerifiedWorkPacketMarkdown } from "../src/work_packets/renderer.js";

const assignmentId = "assignment-packet-1";
const runId = "run-packet-1";
const createdAt = "2026-08-23T12:00:00.000Z";
let sequence = 0;

function event(kind: AssignmentAttemptEvent["kind"], attemptId: string | null, data: Record<string, unknown> = {}): AssignmentAttemptEvent {
  sequence += 1;
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: `packet-event-${sequence}`,
    assignment_id: assignmentId,
    run_id: runId,
    generation: 1,
    attempt_id: attemptId,
    kind,
    occurred_at: new Date(Date.parse(createdAt) + sequence * 1_000).toISOString(),
    actor: "packet-test",
    data
  };
}

function opened(attemptId: string, effect: AssignmentRequestedEffect, options: {
  purpose?: "action" | "verification" | "reconciliation" | "rollback";
  path?: string;
  target?: string;
  retryOf?: string;
  retryDelta?: string;
  reconciliationOf?: string;
} = {}): AssignmentAttemptEvent {
  const actionPath = options.path ?? (effect === "read" ? "/revit/get-element-summary" : "/revit/move-elements");
  return event("attempt_opened", attemptId, {
    purpose: options.purpose ?? "action",
    requested_effect: effect,
    action_path: actionPath,
    tool_identity: options.purpose === "verification" ? "canonical_bounded_verifier" : "revit_call_tool",
    action_signature: assignmentActionSignature({ requested_effect: effect, action_path: actionPath, tool_identity: "revit_call_tool", request: { ids: [101] } }),
    target_fingerprint: options.target ?? "sha256:target-101",
    target_identities: ["element:101"],
    expected_postconditions: ["element:101 matches the requested state"],
    retry_of_attempt_id: options.retryOf,
    retry_delta: options.retryDelta,
    reconciliation_of_attempt_id: options.reconciliationOf
  });
}

function run(): AssignmentAttemptEvent {
  return event("run_started", null);
}

function admitted(attemptId: string): AssignmentAttemptEvent {
  return event("admission_recorded", attemptId, { admission_state: "admitted", authority: "test_policy" });
}

function dispatched(attemptId: string, state: "acknowledged" | "dispatched" | "failed" = "acknowledged"): AssignmentAttemptEvent {
  return event("dispatch_recorded", attemptId, { dispatch_state: state, dispatch_id: `dispatch:${attemptId}` });
}

function effect(attemptId: string, state: "none" | "unknown" | "applied", authority: string, reason: string, evidenceRefs = [`ev:${attemptId}`]): AssignmentAttemptEvent {
  return event("effect_recorded", attemptId, {
    effect_state: state,
    effect_authority: authority,
    reason,
    authority_id: `authority:${attemptId}`,
    affected_target_identities: ["element:101"],
    receipt_refs: [`receipt:${attemptId}`],
    evidence_refs: evidenceRefs
  });
}

function terminal(state: "complete" | "blocked" | "failed", reason: string): AssignmentAttemptEvent {
  return event("assignment_terminal", null, { terminal_state: state, reason });
}

function successfulApplyEvents(): AssignmentAttemptEvent[] {
  const applyId = "apply-1";
  const verifyId = "verify-1";
  return [
    run(), opened(applyId, "apply"), admitted(applyId), dispatched(applyId), effect(applyId, "applied", "native_transaction", "transaction_committed"),
    opened(verifyId, "read", { purpose: "verification", reconciliationOf: applyId }), admitted(verifyId), dispatched(verifyId),
    event("verification_recorded", verifyId, {
      verification_state: "passed", applied_attempt_id: applyId, reason: "exact_postconditions_verified", evidence_refs: ["verification:apply-1"]
    })
  ];
}

function successfulReadEvents(): AssignmentAttemptEvent[] {
  return [
    run(), opened("read-1", "read"), admitted("read-1"), dispatched("read-1"),
    effect("read-1", "none", "native_host", "authoritative_read_completed"), terminal("complete", "authoritative_read_completed")
  ];
}

function completionAudit(pass = true): GoalRecord["completion_audit"] {
  return {
    id: "audit-1",
    requested_at: "2026-08-23T12:05:00.000Z",
    complete: pass,
    criteria_results: [{ criterion: "Requested result is correct", status: pass ? "pass" : "fail", evidence_refs: ["validation:validator-1"], notes: pass ? undefined : "readback mismatch" }],
    evidence_summary: "Trusted canonical validation.",
    remaining_work: pass ? [] : ["Requested result is correct"],
    blockers: [],
    recommendation: pass ? "Complete." : "Do not complete."
  };
}

function goal(events: AssignmentAttemptEvent[], options: {
  status?: GoalRecord["status"];
  auditPass?: boolean;
  workBudget?: Record<string, unknown>;
  blocker?: string | null;
  error?: string | null;
  evidenceRefs?: string[];
} = {}): GoalRecord {
  const status = options.status ?? "complete";
  return {
    id: assignmentId,
    revision: 1,
    title: "Packet test Assignment",
    objective: "Change element 101 and verify the requested result.",
    acceptance_criteria: ["Requested result is correct"],
    non_goals: ["Do not change unrelated elements"],
    created_at: createdAt,
    updated_at: "2026-08-23T12:10:00.000Z",
    status,
    priority: null,
    created_by: "test-user",
    current_phase: status,
    current_step: null,
    progress_summary: "Contradictory assistant prose: the work definitely failed.",
    token_budget: null,
    work_budget: {
      source_user_request: "Change element 101 and verify the requested result.",
      requested_effect: "apply",
      document_fingerprint: "sha256:document-1",
      scope: ["element:101"],
      constraints: ["Preserve unrelated elements"],
      authorization_envelope: { mode: "typed_apply", confirmed: true },
      ...options.workBudget
    },
    work_items: [],
    assumptions: [],
    evidence_log: [],
    action_log: [{ id: "assistant-prose", ts: createdAt, kind: "action", summary: "I am certain the opposite result happened." }],
    validation_log: [{
      id: "validator-1", ts: createdAt, kind: "validation", summary: "Canonical validator receipt", evidence: {
        kind: "validator", criterion: "Requested result is correct", validator: {
          identity: "canonical-target-verifier", method: "target-bound readback", status: options.auditPass === false ? "fail" : "pass", verified_at: createdAt,
          authority: { provider_id: "test-authority", receipt_id: "trusted-receipt-1", assertion: {}, issued_at: createdAt, expires_at: "2099-01-01T00:00:00.000Z" }
        }
      }
    }],
    completion_audit: completionAudit(options.auditPass !== false),
    related_thread_id: "thread-1",
    related_session_id: "session-1",
    related_model_id: "model-1",
    related_project_id: "project-1",
    artifacts: [],
    error: options.error ?? null,
    blocker: options.blocker ?? null,
    assignment_control_plane: {
      schema: "revit-operator.assignment-control-plane/v1",
      events: options.evidenceRefs?.length ? events.map((row, index) => index === events.length - 1 ? { ...row, data: { ...row.data, evidence_refs: options.evidenceRefs } } : row) : events,
      quarantined_events: []
    } satisfies AssignmentControlPlaneLog
  };
}

test("verified committed change is deterministic and assistant prose cannot override canonical truth", () => {
  sequence = 0;
  const packet = generateVerifiedWorkPacket(goal(successfulApplyEvents()));
  assert.equal(packet.status, "verified_complete");
  assert.equal(packet.actions.some(action => action.effect.state === "applied"), true);
  assert.equal(packet.trust_presentation.overall, "independently_verified");
  assert.equal(verifyVerifiedWorkPacketHash(packet), true);
  assert.equal(generateVerifiedWorkPacket(goal(successfulApplyEvents())).status, "verified_complete");
});

test("verified read-only result is complete without inventing a persistent effect", () => {
  sequence = 0;
  const packet = generateVerifiedWorkPacket(goal(successfulReadEvents(), { workBudget: { requested_effect: "read" } }));
  assert.equal(packet.status, "verified_complete");
  assert.equal(packet.actions.every(action => action.effect.state === "none"), true);
});

test("verified no-op requires and exposes two fresh observations", () => {
  sequence = 0;
  const events = [run()];
  for (const id of ["read-1", "read-2"]) events.push(opened(id, "read"), admitted(id), dispatched(id), effect(id, "none", "native_host", "authoritative_read_completed", [`observation:${id}`]));
  events.push(effect("read-2", "none", "target_readback", "verified_noop", ["observation:read-1", "observation:read-2"]), terminal("complete", "verified_noop_two_fresh_target_observations"));
  const packet = generateVerifiedWorkPacket(goal(events));
  assert.equal(packet.status, "verified_no_op");
  assert.equal(packet.actions.find(action => action.attempt_id === "read-2")?.evidence_references.length, 2);
});

test("native apply without complete independent verification remains complete with issues", () => {
  sequence = 0;
  const events = [run(), opened("apply-1", "apply"), admitted("apply-1"), dispatched("apply-1"), effect("apply-1", "applied", "native_transaction", "transaction_committed"), terminal("complete", "native_action_only")];
  const packet = generateVerifiedWorkPacket(goal(events, { auditPass: false }));
  assert.equal(packet.status, "complete_with_issues");
  assert.equal(packet.actions[0]?.effect.state, "applied");
});

test("truthful fixture blocker and ambiguity produce distinct customer statuses", () => {
  sequence = 0;
  const blocked = [run(), terminal("blocked", "fixture_not_applicable")];
  assert.equal(generateVerifiedWorkPacket(goal(blocked, { status: "blocked", auditPass: false, blocker: "Required fixture is missing.", workBudget: { blocker_kind: "fixture" } })).status, "blocked_truthfully");
  assert.equal(generateVerifiedWorkPacket(goal(blocked, { status: "blocked", auditPass: false, blocker: "Target is ambiguous.", workBudget: { blocker_kind: "ambiguity", requires_user_input: true } })).status, "awaiting_clarification");
});

test("failed no-effect action is failed while unknown effect remains visible pending reconciliation", () => {
  sequence = 0;
  const rejected = [run(), opened("apply-1", "apply"), event("admission_recorded", "apply-1", { admission_state: "rejected", authority: "schema_validator", reason: "schema_rejection" }), terminal("failed", "schema_rejection")];
  const failedPacket = generateVerifiedWorkPacket(goal(rejected, { status: "failed", auditPass: false, error: "Schema rejected before dispatch." }));
  assert.equal(failedPacket.status, "failed");
  assert.equal(failedPacket.actions[0]?.effect.state, "none");
  sequence = 0;
  const unknown = [run(), opened("apply-1", "apply"), admitted("apply-1"), dispatched("apply-1", "dispatched"), terminal("failed", "effect_reconciliation_required")];
  const unknownPacket = generateVerifiedWorkPacket(goal(unknown, { status: "failed", auditPass: false }));
  assert.equal(unknownPacket.status, "complete_with_issues");
  assert.equal(unknownPacket.actions[0]?.effect.state, "unknown");
  assert.match(unknownPacket.issues.map(issue => issue.summary).join("\n"), /reconciliation without replay/i);
});

test("applied effect survives failed verification and corrected retry retains original attempt", () => {
  sequence = 0;
  const applied = [run(), opened("apply-1", "apply"), admitted("apply-1"), dispatched("apply-1"), effect("apply-1", "applied", "native_transaction", "transaction_committed"), opened("verify-1", "read", { purpose: "verification", reconciliationOf: "apply-1" }), admitted("verify-1"), dispatched("verify-1"), event("verification_recorded", "verify-1", { verification_state: "failed", applied_attempt_id: "apply-1", reason: "postcondition_mismatch", evidence_refs: ["verification:failed"] })];
  const failedVerification = generateVerifiedWorkPacket(goal(applied, { status: "failed", auditPass: false }));
  assert.equal(failedVerification.status, "complete_with_issues");
  assert.equal(failedVerification.actions.find(action => action.attempt_id === "apply-1")?.effect.state, "applied");

  sequence = 0;
  const first = opened("apply-1", "apply");
  const corrected = [run(), first, event("admission_recorded", "apply-1", { admission_state: "rejected", authority: "admission_policy", reason: "missing_typed_confirmation" }), opened("apply-2", "apply", { retryOf: "apply-1", retryDelta: "corrected_confirmation" }), admitted("apply-2"), dispatched("apply-2"), effect("apply-2", "applied", "native_transaction", "transaction_committed"), opened("verify-2", "read", { purpose: "verification", reconciliationOf: "apply-2" }), admitted("verify-2"), dispatched("verify-2"), event("verification_recorded", "verify-2", { verification_state: "passed", applied_attempt_id: "apply-2", evidence_refs: ["verification:apply-2"] })];
  const retryPacket = generateVerifiedWorkPacket(goal(corrected));
  assert.equal(retryPacket.actions.length, 3);
  assert.equal(retryPacket.actions.find(action => action.attempt_id === "apply-1")?.effect.state, "none");
  assert.equal(retryPacket.actions.find(action => action.attempt_id === "apply-2")?.retry_delta, "corrected_confirmation");
});

test("collateral mutation blocks completion and native rollback is explicit", () => {
  sequence = 0;
  const collateralPacket = generateVerifiedWorkPacket(goal(successfulApplyEvents(), {
    workBudget: { collateral_checks: [{ invariant: "Unrelated elements unchanged", status: "fail", reason: "Element 202 changed unexpectedly." }] }
  }));
  assert.equal(collateralPacket.status, "failed");
  assert.equal(collateralPacket.issues.some(issue => issue.kind === "collateral_mutation"), true);

  sequence = 0;
  const events = [run(), opened("apply-1", "apply"), admitted("apply-1"), dispatched("apply-1"), effect("apply-1", "applied", "native_transaction", "transaction_committed"), opened("rollback-1", "apply", { purpose: "rollback", path: "/revit/rollback", target: "sha256:target-101" }), admitted("rollback-1"), dispatched("rollback-1"), effect("rollback-1", "none", "native_rollback", "rollback_completed"), terminal("complete", "rollback_completed")];
  const rollbackPacket = generateVerifiedWorkPacket(goal(events, { auditPass: false }));
  assert.equal(rollbackPacket.status, "rolled_back");
  assert.equal(rollbackPacket.rollback.completed, true);
});

test("stale evidence is excluded from trust and oversized evidence stays referenced", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "verified-work-packet-evidence-"));
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  try {
    sequence = 0;
    const raw = { items: Array.from({ length: 20_000 }, (_, index) => ({ element_id: index + 1, payload: "x".repeat(80) })) };
    const stored = storeEvidence({
      scope: { session_id: "session-1", assignment_id: assignmentId, run_id: runId, attempt_id: "apply-1", generation: 1 },
      source: "oversized-packet-test", trust_level: "authoritative_native", verification_relevance: "supporting", raw
    });
    const crossAssignment = storeEvidence({
      scope: { session_id: "session-1", assignment_id: "another-assignment", run_id: "another-run", attempt_id: "other-attempt", generation: 1 },
      source: "cross-assignment-packet-test", trust_level: "authoritative_readback", verification_relevance: "authoritative", raw: { element_id: 999, verified: true }
    });
    const events = successfulApplyEvents();
    const packet = generateVerifiedWorkPacket(goal(events, {
      evidenceRefs: [stored.ref.evidence_id, crossAssignment.ref.evidence_id, "ev1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
      workBudget: { authorization_envelope: { mode: "typed_apply", bearer_token: "must-not-survive", nested: { apiKey: "also-secret" } } }
    }));
    const serialized = JSON.stringify(packet);
    assert.ok(Buffer.byteLength(serialized) < 100_000);
    assert.equal(packet.artifacts.some(artifact => artifact.content_hash === stored.ref.content_hash && artifact.byte_count === stored.ref.byte_count), true);
    assert.equal(packet.issues.some(issue => issue.kind === "stale_evidence"), true);
    assert.doesNotMatch(JSON.stringify(packet.assignment.authorization_envelope), /must-not-survive|also-secret/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, stored.ref.artifact_location), "utf8")), raw);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("packet persistence is idempotent, hash-stable, rendered, and recoverable after restart", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "verified-work-packet-store-"));
  const priorWorkspace = process.env.OPERATOR_WORKSPACE_ROOT;
  const priorRelease = process.env.OPERATOR_RELEASE_ID;
  process.env.OPERATOR_WORKSPACE_ROOT = workspace;
  process.env.OPERATOR_RELEASE_ID = "release-test-1";
  try {
    sequence = 0;
    const settledGoal = goal(successfulApplyEvents());
    const first = persistVerifiedWorkPacket(settledGoal);
    const second = readLatestVerifiedWorkPacket(settledGoal);
    assert.equal(first.packet.packet_id, second.packet.packet_id);
    assert.equal(first.packet.packet_hash, second.packet.packet_hash);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(listVerifiedWorkPackets(settledGoal.id).length, 1);
    assert.equal(verifyVerifiedWorkPacketHash(JSON.parse(fs.readFileSync(path.join(workspace, first.json_path), "utf8"))), true);
    const markdown = fs.readFileSync(path.join(workspace, first.markdown_path), "utf8");
    assert.match(markdown, /Acceptance criteria/);
    assert.match(markdown, /independently verified/);
    assert.equal(markdown, renderVerifiedWorkPacketMarkdown(first.packet));

    process.env.OPERATOR_RELEASE_ID = "release-test-2";
    const regenerated = persistVerifiedWorkPacket(settledGoal);
    assert.equal(regenerated.packet.parent_packet_id, first.packet.packet_id);
    assert.equal(listVerifiedWorkPackets(settledGoal.id).length, 2);
  } finally {
    if (priorWorkspace === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = priorWorkspace;
    if (priorRelease === undefined) delete process.env.OPERATOR_RELEASE_ID; else process.env.OPERATOR_RELEASE_ID = priorRelease;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
