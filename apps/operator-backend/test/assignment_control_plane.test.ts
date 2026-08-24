import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
  assignmentActionSignature,
  emptyAssignmentControlPlane,
  normalizeAssignmentControlPlane,
  reduceAssignmentControlPlane,
  type AssignmentAttemptEvent,
  type AssignmentRequestedEffect
} from "../src/assignments/control_plane.js";
import {
  createGoal,
  getGoal,
  transitionGoal,
  updateGoal
} from "../src/goals/service.js";
import { appendAssignmentEvent, beginAssignmentRun } from "../src/assignments/control_plane_store.js";

const assignmentId = "assignment-1";
const runId = "run-1";
let sequence = 0;

function event(
  kind: AssignmentAttemptEvent["kind"],
  data: Record<string, unknown> = {},
  overrides: Partial<AssignmentAttemptEvent> = {}
): AssignmentAttemptEvent {
  sequence += 1;
  return {
    schema: ASSIGNMENT_ATTEMPT_EVENT_SCHEMA,
    event_id: `event-${sequence}`,
    assignment_id: assignmentId,
    run_id: runId,
    generation: 1,
    attempt_id: null,
    kind,
    occurred_at: new Date(Date.UTC(2026, 7, 22, 12, 0, sequence)).toISOString(),
    actor: "test",
    data,
    ...overrides
  };
}

function runStarted(overrides: Partial<AssignmentAttemptEvent> = {}): AssignmentAttemptEvent {
  return event("run_started", {}, overrides);
}

function openAttempt(input: {
  attemptId?: string;
  effect?: AssignmentRequestedEffect;
  purpose?: string;
  signature?: string;
  target?: string;
  retryOf?: string;
  retryDelta?: string;
  reconciliationOf?: string;
  run?: string;
  generation?: number;
} = {}): AssignmentAttemptEvent {
  const requestedEffect = input.effect ?? "apply";
  const signature = input.signature ?? assignmentActionSignature({
    requested_effect: requestedEffect,
    action_path: "/revit/move-elements",
    tool_identity: "revit_call",
    request: { ids: [101], dx: 1 }
  });
  return event("attempt_opened", {
    purpose: input.purpose ?? "action",
    requested_effect: requestedEffect,
    action_path: input.purpose === "verification" ? "/revit/get-element-summary" : "/revit/move-elements",
    tool_identity: "revit_call",
    action_signature: signature,
    target_fingerprint: input.target ?? "sha256:target-101",
    target_identities: ["element:101"],
    expected_postconditions: ["element:101 location.x increased by 1"],
    retry_of_attempt_id: input.retryOf,
    retry_delta: input.retryDelta,
    reconciliation_of_attempt_id: input.reconciliationOf
  }, {
    attempt_id: input.attemptId ?? "attempt-1",
    ...(input.run ? { run_id: input.run } : {}),
    ...(input.generation ? { generation: input.generation } : {})
  });
}

function attemptEvent(kind: AssignmentAttemptEvent["kind"], attemptId: string, data: Record<string, unknown> = {}): AssignmentAttemptEvent {
  return event(kind, data, { attempt_id: attemptId });
}

function projection(events: AssignmentAttemptEvent[]) {
  return reduceAssignmentControlPlane(assignmentId, events);
}

function noEffectAdmission(authority: string, reason: string): AssignmentAttemptEvent[] {
  return [
    runStarted(),
    openAttempt(),
    attemptEvent("admission_recorded", "attempt-1", {
      admission_state: "rejected",
      authority,
      effect_authority: authority,
      reason
    })
  ];
}

test("missing typed confirmation is none and does not consume the apply opportunity", () => {
  const result = projection(noEffectAdmission("admission_policy", "missing_typed_confirmation"));
  assert.equal(result.projection.attempts[0]?.effect.state, "none");
  assert.equal(result.projection.apply_opportunity_consumed, false);
});

test("corrected confirmation records a material retry and may apply", () => {
  const base = noEffectAdmission("admission_policy", "missing_typed_confirmation");
  const retry = openAttempt({ attemptId: "attempt-2", retryOf: "attempt-1", retryDelta: "corrected_confirmation" });
  const result = projection([
    ...base,
    retry,
    attemptEvent("admission_recorded", "attempt-2", { admission_state: "admitted", authority: "typed_confirmation" }),
    attemptEvent("dispatch_recorded", "attempt-2", { dispatch_state: "dispatched", dispatch_id: "native-2" }),
    attemptEvent("effect_recorded", "attempt-2", {
      effect_state: "applied", effect_authority: "native_transaction", authority_id: "tx-2",
      reason: "transaction_committed", affected_target_identities: ["element:101"], receipt_refs: ["receipt:tx-2"]
    })
  ]);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.projection.attempts[1]?.effect.state, "applied");
  assert.equal(result.projection.phase, "verifying");
});

test("schema and write-grant rejection before dispatch are none", () => {
  for (const [authority, reason] of [["schema_validator", "invalid_schema"], ["write_grant", "missing_write_grant"]]) {
    const result = projection(noEffectAdmission(authority, reason));
    assert.equal(result.projection.attempts[0]?.effect.state, "none");
    assert.equal(result.projection.attempts[0]?.dispatch.state, "not_dispatched");
  }
});

test("successful rollback is none", () => {
  const result = projection([
    runStarted(), openAttempt({ effect: "preview" }),
    attemptEvent("admission_recorded", "attempt-1", { admission_state: "admitted", authority: "policy" }),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "preview-1" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_rollback", authority_id: "tx-preview-1",
      reason: "transaction_rolled_back", receipt_refs: ["receipt:preview-1"]
    })
  ]);
  assert.equal(result.projection.attempts[0]?.effect.state, "none");
});

test("timeout before dispatch is none and timeout after dispatch is unknown", () => {
  const before = projection([
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "failed", reason: "timeout_before_claim" })
  ]);
  assert.equal(before.projection.attempts[0]?.effect.state, "none");

  const after = projection([
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "job-1" }),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "failed", dispatch_id: "job-1", reason: "timeout_after_dispatch" })
  ]);
  assert.equal(after.projection.attempts[0]?.effect.state, "unknown");
  assert.deepEqual(after.projection.unresolved_unknown_attempt_ids, ["attempt-1"]);
});

test("unknown cannot automatically retry or open another action", () => {
  const events = [
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "job-1" }),
    openAttempt({ attemptId: "attempt-2", retryOf: "attempt-1", retryDelta: "resolved_host_state" })
  ];
  const result = projection(events);
  assert.match(result.rejected.at(-1)?.reason ?? "", /must be reconciled/);
  assert.equal(result.projection.attempts.length, 1);
});

function unresolvedWithReconciliation(): AssignmentAttemptEvent[] {
  return [
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "job-1" }),
    openAttempt({ attemptId: "reconcile-1", effect: "read", purpose: "reconciliation", reconciliationOf: "attempt-1" }),
    attemptEvent("reconciliation_started", "reconcile-1")
  ];
}

test("reconciliation discovers an already-applied result without replay", () => {
  const result = projection([
    ...unresolvedWithReconciliation(),
    attemptEvent("reconciliation_resolved", "reconcile-1", {
      effect_state: "applied", reason: "exact_target_matches_postcondition",
      authority_id: "readback-1", evidence_refs: ["observation:after"]
    })
  ]);
  assert.equal(result.projection.attempts[0]?.effect.state, "applied");
  assert.equal(result.projection.attempts.filter(item => item.requested_effect === "apply").length, 1);
  assert.equal(result.projection.phase, "verifying");
});

test("reconciliation proves no effect and permits one corrected retry", () => {
  const reconciled = [
    ...unresolvedWithReconciliation(),
    attemptEvent("reconciliation_resolved", "reconcile-1", {
      effect_state: "none", reason: "target_unchanged", authority_id: "readback-1",
      evidence_refs: ["observation:before", "observation:fresh-after"]
    })
  ];
  const result = projection([
    ...reconciled,
    openAttempt({ attemptId: "attempt-2", retryOf: "attempt-1", retryDelta: "reconciliation_none" })
  ]);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.projection.attempts.at(-1)?.attempt_id, "attempt-2");
  assert.equal(result.projection.apply_opportunity_consumed, false);
});

function appliedEvents(): AssignmentAttemptEvent[] {
  return [
    runStarted(), openAttempt(),
    attemptEvent("admission_recorded", "attempt-1", { admission_state: "admitted", authority: "policy" }),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "native-1" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "applied", effect_authority: "native_receipt", authority_id: "receipt-1",
      reason: "native_commit_receipt", affected_target_identities: ["element:101"], receipt_refs: ["receipt:1"]
    })
  ];
}

test("successful apply enters exact bounded verification and cannot return to discovery", () => {
  const verify = openAttempt({
    attemptId: "verify-1", effect: "read", purpose: "verification", reconciliationOf: "attempt-1",
    target: "sha256:target-101"
  });
  const discovery = openAttempt({ attemptId: "discover-2", effect: "read", purpose: "action", signature: "sha256:other" });
  const result = projection([...appliedEvents(), verify, discovery]);
  assert.equal(result.projection.phase, "verifying");
  assert.equal(result.projection.active_verification_attempt_id, "verify-1");
  assert.match(result.rejected.at(-1)?.reason ?? "", /cannot resume after a proven apply/);
});

test("verification failure preserves the applied receipt and closes truthfully", () => {
  const result = projection([
    ...appliedEvents(),
    openAttempt({ attemptId: "verify-1", effect: "read", purpose: "verification", reconciliationOf: "attempt-1" }),
    attemptEvent("verification_recorded", "verify-1", {
      applied_attempt_id: "attempt-1", verification_state: "failed", reason: "postcondition_mismatch",
      evidence_refs: ["observation:verify"]
    })
  ]);
  assert.equal(result.projection.attempts[0]?.effect.state, "applied");
  assert.deepEqual(result.projection.attempts[0]?.receipt_refs, ["receipt:1"]);
  assert.equal(result.projection.terminal_state, "failed");
});

test("stale callback from an older run cannot alter the active generation", () => {
  const newerRun = event("run_started", {}, { run_id: "run-2", generation: 2 });
  const stale = attemptEvent("effect_recorded", "attempt-1", {
    effect_state: "applied", effect_authority: "native_receipt", reason: "late_callback"
  });
  const result = projection([runStarted(), openAttempt(), newerRun, stale]);
  assert.equal(result.projection.run_id, "run-2");
  assert.equal(result.projection.attempts[0]?.effect.state, "none");
  assert.match(result.rejected.at(-1)?.reason ?? "", /stale or superseded/);
});

test("a terminal Assignment cannot be resurrected", () => {
  const terminal = event("assignment_terminal", { terminal_state: "canceled", reason: "user_canceled" });
  const restart = event("run_started", {}, { run_id: "run-2", generation: 2 });
  const result = projection([runStarted(), terminal, restart]);
  assert.equal(result.projection.terminal_state, "canceled");
  assert.equal(result.projection.generation, 1);
  assert.match(result.rejected.at(-1)?.reason ?? "", /terminal/);
});

test("deterministic fast path and delegated-agent execution reduce to equivalent history", () => {
  const deterministic = appliedEvents();
  const delegated = deterministic.map(item => ({ ...item, actor: "codex-general-agent" }));
  assert.deepEqual(projection(deterministic).projection.attempts, projection(delegated).projection.attempts);
});

test("restart and resume reconstruct exactly the same projection", () => {
  const events = appliedEvents();
  const first = projection(events).projection;
  const resumed = reduceAssignmentControlPlane(assignmentId, JSON.parse(JSON.stringify(events)) as AssignmentAttemptEvent[]).projection;
  assert.deepEqual(resumed, first);
});

test("assistant prose cannot override effect truth", () => {
  const prose = attemptEvent("effect_recorded", "attempt-1", {
    effect_state: "none", effect_authority: "assistant_prose", reason: "assistant_claimed_failure"
  });
  const result = projection([...appliedEvents(), prose]);
  assert.equal(result.projection.attempts[0]?.effect.state, "applied");
  assert.match(result.rejected.at(-1)?.reason ?? "", /not an effect authority/);
});

test("failing-before: lower-authority duplicate read settlement cannot erase native authority", () => {
  const result = projection([
    runStarted(),
    openAttempt({ attemptId: "attempt-read-authority", effect: "read", purpose: "action" }),
    attemptEvent("admission_recorded", "attempt-read-authority", {
      admission_state: "admitted",
      authority: "operator_backend_action_policy"
    }),
    attemptEvent("dispatch_recorded", "attempt-read-authority", {
      dispatch_state: "acknowledged",
      dispatch_id: "native-read",
      dispatch_may_have_occurred: true
    }),
    attemptEvent("effect_recorded", "attempt-read-authority", {
      effect_state: "none",
      effect_authority: "native_host",
      authority_id: "native-receipt-1",
      reason: "read_has_no_persistent_effect",
      receipt_refs: ["native:read-1"]
    }),
    attemptEvent("effect_recorded", "attempt-read-authority", {
      effect_state: "none",
      effect_authority: "admission_policy",
      reason: "read_contract_has_no_persistent_effect",
      receipt_refs: ["outer:read-1"]
    })
  ]);
  const attempt = result.projection.attempts[0]!;
  assert.equal(attempt.effect.authority, "native_host");
  assert.equal(attempt.effect.authority_id, "native-receipt-1");
  assert.deepEqual(attempt.receipt_refs, ["native:read-1"]);
  assert.match(result.rejected.at(-1)?.reason ?? "", /lower-authority admission_policy effect/);
});

test("lower-authority effect reports cannot cross states or contaminate authoritative facts", () => {
  const nativeAppliedThenCaller = projection([
    runStarted(), openAttempt(),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "applied", effect_authority: "native_transaction", authority_id: "tx-1",
      affected_target_identities: ["element:101"], receipt_refs: ["native:tx-1"]
    }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "applied", effect_authority: "caller_report", authority_id: "caller-1",
      affected_target_identities: ["element:forged"], receipt_refs: ["caller:forged"], evidence_refs: ["evidence:forged"]
    })
  ]);
  const applied = nativeAppliedThenCaller.projection.attempts[0]!;
  assert.equal(applied.effect.state, "applied");
  assert.equal(applied.effect.authority, "native_transaction");
  assert.deepEqual(applied.affected_target_identities, ["element:101"]);
  assert.deepEqual(applied.receipt_refs, ["native:tx-1"]);
  assert.deepEqual(applied.evidence_refs, []);
  assert.match(nativeAppliedThenCaller.rejected.at(-1)?.reason ?? "", /lower-authority caller_report effect/);

  const nativeNoneThenCallerUnknown = projection([
    runStarted(), openAttempt({ effect: "read" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_host", receipt_refs: ["native:read-1"]
    }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "unknown", effect_authority: "caller_report", receipt_refs: ["caller:unknown"]
    })
  ]);
  assert.equal(nativeNoneThenCallerUnknown.projection.attempts[0]?.effect.state, "none");
  assert.equal(nativeNoneThenCallerUnknown.projection.attempts[0]?.effect.authority, "native_host");
  assert.deepEqual(nativeNoneThenCallerUnknown.projection.attempts[0]?.receipt_refs, ["native:read-1"]);
  assert.match(nativeNoneThenCallerUnknown.rejected.at(-1)?.reason ?? "", /lower-authority caller_report effect/);
});

test("lower-authority duplicate cannot prematurely settle an attempt awaiting evidence", () => {
  const result = projection([
    runStarted(), openAttempt({ effect: "read" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_host", receipt_refs: ["native:read-1"],
      settlement_pending_evidence: true
    }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "caller_report", receipt_refs: ["caller:read-1"]
    })
  ]);
  assert.equal(result.projection.attempts[0]?.terminal_state, "active");
  assert.equal(result.projection.in_flight_count, 1);
  assert.deepEqual(result.projection.attempts[0]?.receipt_refs, ["native:read-1"]);
  assert.match(result.rejected.at(-1)?.reason ?? "", /lower-authority caller_report effect/);
});

test("terminal native settlement rejects late admission and dispatch callbacks without mutation", () => {
  const nativeApplied = projection([
    ...appliedEvents(),
    attemptEvent("admission_recorded", "attempt-1", {
      admission_state: "rejected", authority: "policy", reason: "late_rejection"
    }),
    attemptEvent("dispatch_recorded", "attempt-1", {
      dispatch_state: "failed", dispatch_may_have_occurred: false, reason: "late_transport_failure"
    })
  ]);
  const attempt = nativeApplied.projection.attempts[0]!;
  assert.equal(attempt.admission.state, "admitted");
  assert.equal(attempt.dispatch.state, "dispatched");
  assert.equal(attempt.effect.state, "applied");
  assert.equal(attempt.effect.authority, "native_receipt");
  assert.deepEqual(attempt.receipt_refs, ["receipt:1"]);
  assert.equal(nativeApplied.rejected.length, 2);
  assert.match(nativeApplied.rejected[0]!.reason, /terminal attempt/);
  assert.match(nativeApplied.rejected[1]!.reason, /terminal attempt/);
});

test("authoritative read settlement rejects a late dispatch callback", () => {
  const events = [
    runStarted(), openAttempt({ effect: "read" }),
    attemptEvent("admission_recorded", "attempt-1", { admission_state: "admitted", authority: "policy" }),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "acknowledged", dispatch_id: "native-read" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_host", receipt_refs: ["native:read"]
    }),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "failed", reason: "late_failure" })
  ];
  const result = projection(events);
  assert.equal(result.projection.attempts[0]!.dispatch.state, "acknowledged");
  assert.equal(result.projection.attempts[0]!.effect.authority, "native_host");
  assert.match(result.rejected.at(-1)!.reason, /terminal attempt/);
});

test("equal-rank and post-native contradictory effect reports are quarantined", () => {
  const equalRank = projection([
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "applied", effect_authority: "native_receipt", receipt_refs: ["native:applied"]
    }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_host", receipt_refs: ["native:none"]
    })
  ]);
  assert.equal(equalRank.projection.attempts[0]!.effect.state, "applied");
  assert.deepEqual(equalRank.projection.attempts[0]!.receipt_refs, ["native:applied"]);
  assert.match(equalRank.rejected.at(-1)!.reason, /cannot be downgraded|Conflicting/);

  const postNative = projection([
    runStarted(), openAttempt({ effect: "read" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "native_host", receipt_refs: ["native:read"]
    }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "unknown", effect_authority: "target_readback", evidence_refs: ["evidence:contradiction"]
    })
  ]);
  assert.equal(postNative.projection.attempts[0]!.effect.state, "none");
  assert.deepEqual(postNative.projection.attempts[0]!.evidence_refs, []);
  assert.match(postNative.rejected.at(-1)!.reason, /Conflicting/);
});

test("rejected events leave the canonical projection byte-for-byte unchanged", () => {
  const base = appliedEvents();
  const accepted = projection(base).projection;
  const rejected = projection([
    ...base,
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "none", effect_authority: "caller_report", evidence_refs: ["evidence:forged"]
    })
  ]).projection;
  assert.deepEqual(rejected, accepted);
});

test("caller-reported applied receipt remains unknown until independently verified", () => {
  const result = projection([
    runStarted(), openAttempt(),
    attemptEvent("dispatch_recorded", "attempt-1", { dispatch_state: "dispatched", dispatch_id: "sidecar-1" }),
    attemptEvent("effect_recorded", "attempt-1", {
      effect_state: "applied", effect_authority: "caller_report", reason: "caller_said_success",
      receipt_refs: ["caller:receipt"]
    })
  ]);
  assert.equal(result.projection.attempts[0]?.effect.state, "unknown");
  assert.deepEqual(result.projection.attempts[0]?.receipt_refs, []);
  assert.deepEqual(result.rejected.at(-1)?.event.data.receipt_refs, ["caller:receipt"]);
  assert.match(result.rejected.at(-1)?.reason ?? "", /lower-authority caller_report effect/);
});

test("a verified no-op requires a fresh second target observation", () => {
  const one = attemptEvent("effect_recorded", "attempt-1", {
    effect_state: "none", effect_authority: "target_readback", reason: "verified_noop", evidence_refs: ["observation:1"]
  });
  const two = attemptEvent("effect_recorded", "attempt-1", {
    effect_state: "none", effect_authority: "target_readback", reason: "verified_noop",
    evidence_refs: ["observation:1", "observation:2"]
  });
  const first = projection([runStarted(), openAttempt(), one]);
  assert.match(first.rejected.at(-1)?.reason ?? "", /two fresh/);
  const second = projection([runStarted(), openAttempt(), two]);
  assert.equal(second.rejected.length, 0);
  assert.equal(second.projection.attempts[0]?.effect.reason, "verified_noop");
});

test("repeated identical no-progress turns diagnose once then terminate within the bound", () => {
  const progress = {
    progress: {
      unresolved_acceptance_criteria: ["Element 101 is moved"], grounded_targets: ["element:101"],
      action_signature: "sha256:action", observation_refs: ["observation:same"], verified_facts: [],
      plan_signature: "sha256:plan", model_state_signature: "sha256:model", tool_family: "generic_revit",
      legitimate_alternative_tool_family: null, progress_markers: []
    }
  };
  const result = projection([runStarted(), event("progress_recorded", progress), event("progress_recorded", progress)]);
  assert.equal(result.projection.progress.diagnosis_used, true);
  assert.equal(result.projection.progress.decision, "terminate");
  assert.equal(result.projection.progress.reason, "repeated_identical_no_progress");
});

function withWorkspace<T>(fn: () => T): T {
  const previous = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-control-plane-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("legacy Goal records project safely and accepted events persist in the canonical store", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Canonical persistence", objective: "Persist attempt truth.",
      acceptance_criteria: ["Attempt truth is durable."], status: "active"
    });
    assert.deepEqual(normalizeAssignmentControlPlane(undefined), emptyAssignmentControlPlane());
    const begun = beginAssignmentRun(goal.id, "run-persisted", "test");
    assert.equal(begun.accepted, true);
    const opened = event("attempt_opened", {
      purpose: "action", requested_effect: "read", action_path: "/revit/context", tool_identity: "revit_call",
      action_signature: "sha256:read", target_fingerprint: "sha256:document", target_identities: ["document:active"]
    }, {
      assignment_id: goal.id, run_id: "run-persisted", generation: 1, attempt_id: "read-1"
    });
    assert.equal(appendAssignmentEvent(goal.id, opened).accepted, true);
    assert.equal(getGoal(goal.id)?.assignment_control_plane?.events.length, 2);
  });
});

test("terminal Goal callbacks are quarantined and failed Goals are immutable", () => {
  withWorkspace(() => {
    const goal = createGoal({
      title: "Terminal persistence", objective: "Fence terminal writes.",
      acceptance_criteria: ["Late writes are rejected."], status: "active"
    });
    beginAssignmentRun(goal.id, "run-terminal", "test");
    transitionGoal(goal.id, "failed", "terminal failure");
    const late = event("progress_recorded", { progress: {} }, {
      assignment_id: goal.id, run_id: "run-terminal", generation: 1
    });
    const appended = appendAssignmentEvent(goal.id, late);
    assert.equal(appended.accepted, false);
    assert.match(appended.quarantined_reason ?? "", /Goal is terminal/);
    assert.equal(appended.goal.assignment_control_plane?.events.length, 1);
    assert.equal(appended.goal.assignment_control_plane?.quarantined_events.length, 1);
    assert.throws(() => updateGoal(goal.id, { progress_summary: "resurrect" }), /Cannot edit a failed goal/);
  });
});
