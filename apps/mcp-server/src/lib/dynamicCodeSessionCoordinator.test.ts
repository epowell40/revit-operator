import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  coordinateDynamicCodeSession, createObservationDelta, evaluateTrustedTaskPostconditions, verifyObservationDelta,
  type DynamicExecutionRunReceipt, type DynamicMutationAuthorityReceipt, type TrustedTaskFactSet
} from "./dynamicCodeSessionCoordinator.js";

const finalize = async ({ task_id, final_checkpoint_sha256 }: { task_id: string; final_checkpoint_sha256: string | null }) => {
  const unsigned = { schema: "revit-operator.dynamic-task-finalization.v1" as const, task_id, final_checkpoint_sha256,
    disposition: "accepted_state" as const, evidence_sha256: hash("trusted-finalization"), authorization_granted: false as const };
  return { ...unsigned, receipt_sha256: hash(JSON.stringify(unsigned)) };
};

const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const runId = (index: number) => `dynamic-${index.toString(16).padStart(32, "0")}`;

function facts(evidence: string, changed = ["uid-a"]): TrustedTaskFactSet {
  const executionEvidence = /^sha256:[a-f0-9]{64}$/.test(evidence) ? evidence : hash(evidence);
  return { schema: "revit-operator.trusted-task-facts.v1", verifier_identity_sha256: hash("trusted-host-verifier"),
    execution_evidence_sha256: executionEvidence, evidence_sha256: hash(`verified:${evidence}`),
    document_fingerprint: hash("document"), document_session_id: "session-exact",
    document_revision: 7, fields: { "parameter:uid-a:Comments": hash("APPROVED") }, sets: { changed_ids: changed, created_ids: [] } };
}

test("trusted task postconditions derive pass/fail only from verifier-owned facts", () => {
  const conditions = [
    { id: "comments-updated", kind: "field_hash_equals" as const, field: "parameter:uid-a:Comments", expected_sha256: hash("APPROVED") },
    { id: "exact-blast-radius", kind: "set_equals" as const, field: "changed_ids", expected: ["uid-a"] },
    { id: "no-creation", kind: "count_between" as const, field: "created_ids", minimum: 0, maximum: 0 },
    { id: "no-foreign-delete", kind: "fact_absent" as const, field: "deleted_ids" }
  ];
  const accepted = evaluateTrustedTaskPostconditions(facts("accepted"), conditions);
  assert.equal(accepted.all_passed, true); assert.equal(accepted.authorization_granted, false);
  assert.match(accepted.receipt_sha256, /^sha256:[a-f0-9]{64}$/);
  const rejected = evaluateTrustedTaskPostconditions(facts("collateral", ["uid-a", "uid-foreign"]), conditions);
  assert.equal(rejected.all_passed, false); assert.equal(rejected.results.find(value => value.id === "exact-blast-radius")?.passed, false);
  assert.throws(() => evaluateTrustedTaskPostconditions(facts("duplicate"), [...conditions, conditions[0]!]), /duplicated/);
  assert.throws(() => evaluateTrustedTaskPostconditions(facts("extra"), [
    { ...conditions[0]!, provider_claimed_pass: true } as any
  ]), /exact shape/);
});

test("observation deltas preserve exact snapshot provenance and reject stale merges", () => {
  const base = { document_fingerprint: hash("document"), document_session_id: "session-exact", document_revision: 11,
    snapshot_sha256: hash("snapshot"), revision_sha256: hash("revision-a"), scope_sha256: hash("scope-a"), receipt_sha256: hash("receipt-a"),
    selector: { element_unique_ids: ["uid-a"], category_stable_ids: [], kinds: ["mep_curve"], parameter_names: ["Comments"], include_type_parameters: false } };
  const requested = { element_unique_ids: ["uid-a", "uid-b"], category_stable_ids: ["category:builtin:OST_DuctCurves"],
    kinds: ["mep_curve"], parameter_names: ["Comments", "Mark"], include_type_parameters: true };
  const delta = createObservationDelta(base, requested, hash("fact-request"));
  assert.deepEqual(delta.added.element_unique_ids, ["uid-b"]); assert.deepEqual(delta.added.parameter_names, ["Mark"]);
  assert.equal(delta.added.include_type_parameters, true); assert.equal(delta.authorization_granted, false);
  const observed = { ...base, revision_sha256: hash("revision-b"), scope_sha256: hash("scope-b"), receipt_sha256: hash("receipt-b"), selector: requested };
  assert.doesNotThrow(() => verifyObservationDelta(base, delta, observed));
  assert.throws(() => verifyObservationDelta(base, delta, { ...observed, document_revision: 12 }), /cannot merge/);
  assert.throws(() => verifyObservationDelta(base, { ...delta, base_receipt_sha256: hash("forged") }, observed), /invalid or stale/);
});

test("provider-neutral coordinator iterates, verifies, checkpoints, and continues a long task", async () => {
  let sequence = 0; const calls: Array<{ mode: string; checkpoint: unknown }> = [];
  const execute = async (input: any): Promise<DynamicExecutionRunReceipt> => {
    calls.push({ mode: input.mode, checkpoint: input.continue_from_checkpoint ?? null }); const index = ++sequence;
    return { run_id: runId(index), execution_status: "completed", requested_mode: input.mode,
      verification: { evidence_sha256: hash(`evidence-${index}`), deterministic_replay_verified: true }, diagnostics: [],
      iteration: { progress: { classification: "completed" }, iteration_sha256: hash(`iteration-${index}`) },
      checkpoint: input.mode === "apply" ? { run_id: runId(index), checkpoint_sha256: hash(`checkpoint-${index}`),
        evidence_sha256: hash(`evidence-${index}`), task_session_id: "task-session", checkpoint_index: Math.ceil(index / 2) } : null };
  };
  const authorize = async ({ task_id, step, source_sha256 }: any): Promise<DynamicMutationAuthorityReceipt> => {
    const unsigned = { schema: "revit-operator.dynamic-mutation-authority.v1" as const, task_id, step_id: step.step_id,
      source_sha256, authorization_granted: true as const, expires_unix_seconds: 2_000_000_100 };
    return { ...unsigned, receipt_sha256: hash(JSON.stringify(unsigned)) };
  };
  const steps = ["layout", "annotate"].map((step_id, index) => ({ step_id, source: `public class Step${index} {}`,
    input: {}, mutates: true, postconditions: [{ id: `${step_id}-exact`, kind: "set_equals" as const, field: "changed_ids", expected: ["uid-a"] }] }));
  const result = await coordinateDynamicCodeSession("task-long-design", steps, {
    execute, observe: async run => facts(run.verification.evidence_sha256), authorize,
    expandFacts: async () => { throw new Error("not expected"); }, repair: async () => ({ action: "stop", reason: "not expected" }), finalize
  }, () => 2_000_000_000);

  assert.equal(result.outcome, "completed_verified"); assert.equal(result.steps.length, 2); assert.match(result.session_sha256, /^sha256:/);
  assert.deepEqual(calls.map(value => value.mode), ["preview", "apply", "preview", "apply"]);
  assert.equal(calls[0]?.checkpoint, null); assert.equal(calls[1]?.checkpoint, null);
  assert.equal((calls[2]?.checkpoint as any).prior_checkpoint_sha256, hash("checkpoint-2"));
  assert.equal((calls[3]?.checkpoint as any).prior_checkpoint_sha256, hash("checkpoint-2"));
});

test("coordinator verifies an exact observation delta before facts continuation", async () => {
  const base = { document_fingerprint: hash("document"), document_session_id: "session-exact", document_revision: 11,
    snapshot_sha256: hash("snapshot"), revision_sha256: hash("revision-a"), scope_sha256: hash("scope-a"), receipt_sha256: hash("receipt-a"),
    selector: { element_unique_ids: ["uid-a"], category_stable_ids: [], kinds: ["mep_curve"], parameter_names: [], include_type_parameters: false } };
  const requested = { ...base.selector, element_unique_ids: ["uid-a", "uid-b"] };
  const delta = createObservationDelta(base, requested, hash("request"));
  const observed = { ...base, revision_sha256: hash("revision-b"), scope_sha256: hash("scope-b"), receipt_sha256: hash("receipt-b"), selector: requested };
  let call = 0;
  const execute = async (input: any): Promise<DynamicExecutionRunReceipt> => {
    const index = ++call;
    return { run_id: runId(index), execution_status: index === 1 ? "needs_facts" : "completed", requested_mode: "preview",
      verification: { evidence_sha256: hash(`facts-evidence-${index}`), deterministic_replay_verified: true }, diagnostics: [],
      continuation: index === 1 ? { fact_request: { requestHash: hash("request") } } : undefined,
      iteration: { progress: { classification: index === 1 ? "advanced_to_observation" : "completed" }, iteration_sha256: hash(`facts-iteration-${index}`) },
      checkpoint: null };
  };
  const result = await coordinateDynamicCodeSession("task-facts", [{ step_id: "observe-more", source: "source", input: {}, mutates: false,
    postconditions: [{ id: "none", kind: "count_between", field: "changed_ids", minimum: 0, maximum: 0 }] }], {
      execute, observe: async run => facts(run.verification.evidence_sha256, []),
      expandFacts: async ({ run, source }) => ({ base, delta, observed, input: { source, mode: "preview", resume: {
        prior_run_id: run.run_id, prior_evidence_sha256: run.verification.evidence_sha256, mode: "facts"
      } } }),
      repair: async () => ({ action: "stop", reason: "unused" }), authorize: async () => { throw new Error("unused"); }, finalize
    });
  assert.equal(result.outcome, "completed_verified"); assert.equal(call, 2);

  call = 0;
  await assert.rejects(() => coordinateDynamicCodeSession("task-facts-stale", [{ step_id: "observe-more", source: "source", input: {}, mutates: false,
    postconditions: [{ id: "none", kind: "count_between", field: "changed_ids", minimum: 0, maximum: 0 }] }], {
      execute, observe: async () => facts("unused", []),
      expandFacts: async ({ run, source }) => ({ base, delta, observed: { ...observed, document_revision: 12 }, input: { source, mode: "preview", resume: {
        prior_run_id: run.run_id, prior_evidence_sha256: run.verification.evidence_sha256, mode: "facts"
      } } }),
      repair: async () => ({ action: "stop", reason: "unused" }), authorize: async () => { throw new Error("unused"); }, finalize
    }), /cannot merge/);
});

test("coordinator rejects forged authority and stops deterministic no-progress loops", async () => {
  let calls = 0;
  const failed = (): DynamicExecutionRunReceipt => ({ run_id: runId(++calls), execution_status: "failed", requested_mode: "preview",
    verification: { evidence_sha256: hash(`failed-${calls}`), deterministic_replay_verified: false }, diagnostics: [{ code: "COMPILE", retryable: true }],
    iteration: { progress: { classification: calls > 1 ? "no_progress" : "root" }, iteration_sha256: hash(`failed-iteration-${calls}`) }, checkpoint: null });
  await assert.rejects(() => coordinateDynamicCodeSession("task-no-progress", [{ step_id: "one", source: "source", input: {}, mutates: false,
    postconditions: [{ id: "none", kind: "count_between", field: "changed_ids", minimum: 0, maximum: 0 }] }], {
      execute: async () => failed(), observe: async () => facts("unused", []), expandFacts: async () => { throw new Error("unused"); },
      repair: async () => ({ action: "retry" }), authorize: async () => { throw new Error("unused"); }, finalize
    }), /no progress/);

  const completed: DynamicExecutionRunReceipt = { run_id: runId(99), execution_status: "completed", requested_mode: "preview",
    verification: { evidence_sha256: hash("completed"), deterministic_replay_verified: true }, diagnostics: [],
    iteration: { progress: { classification: "completed" }, iteration_sha256: hash("completed-iteration") }, checkpoint: null };
  await assert.rejects(() => coordinateDynamicCodeSession("task-forged-authority", [{ step_id: "write", source: "source", input: {}, mutates: true,
    postconditions: [{ id: "exact", kind: "set_equals", field: "changed_ids", expected: ["uid-a"] }] }], {
      execute: async () => completed, observe: async () => facts("completed"), expandFacts: async () => { throw new Error("unused"); },
      repair: async () => ({ action: "stop", reason: "unused" }), authorize: async ({ task_id, step, source_sha256 }) => ({
        schema: "revit-operator.dynamic-mutation-authority.v1", task_id, step_id: step.step_id, source_sha256,
        authorization_granted: true, expires_unix_seconds: 2_000_000_100, receipt_sha256: hash("forged")
      }), finalize
    }, () => 2_000_000_000), /authority is invalid/);

  await assert.rejects(() => coordinateDynamicCodeSession("task-substituted-facts", [{ step_id: "read", source: "source", input: {}, mutates: false,
    postconditions: [{ id: "exact", kind: "set_equals", field: "changed_ids", expected: ["uid-a"] }] }], {
      execute: async () => completed, observe: async () => facts("different-execution"), expandFacts: async () => { throw new Error("unused"); },
      repair: async () => ({ action: "stop", reason: "unused" }), authorize: async () => { throw new Error("unused"); }, finalize
    }), /not bound to the exact execution evidence/);
});
