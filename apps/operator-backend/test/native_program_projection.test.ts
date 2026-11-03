import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { assembleBoundedEvidenceContext, modelEvidenceEnvelope, assertBoundedModelEvidencePayload } from "../src/evidence/model_context_budget.js";

const scope = { session_id: "native-projection", assignment_id: "assignment", run_id: "run", attempt_id: "attempt", generation: 1 };
const source = "assignment_kernel_v2:operator_run_dynamic_revit_program";
const value = Array.from({ length: 10 }, (_, i) => `${i + 100}|unique-${i}|Dependent record ${i}|Schedules`).join("\r\n");
function payload(mode = "read", state = "not_started", effect = "none", success = true): any {
  return { schema: "revit-operator.dynamic-revit-program-run.v1", run_id: "dynamic-test", requested_mode: mode,
    execution_lane: "native", execution_status: success ? "completed" : "failed", execution_ok: success,
    native_outcome: { persistent_effect: effect, native_transaction_state: state, verification_required: true,
      task_verified: false, program_result: success ? value : null, error: success ? null : "Native effect scope rejected." },
    diagnostics: success ? [] : [{ code: "NATIVE_PROGRAM_FAILED", message: "Native effect scope rejected.", retryable: false }],
    evidence: { retainedCompilerDetails: "x".repeat(20_000) } };
}
function isolated(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-program-projection-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try { fn(); } finally {
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function save(raw: any, options: any = {}) {
  return storeEvidence({ scope, source, trust_level: "authoritative_native", raw, ...options }, 8192);
}
test("small native program return survives large compiler evidence through owner context exactly", () => isolated(() => {
  const raw = payload(), saved = save(raw), inline: any = saved.projection.inline_payload;
  assert.equal(inline?.native_outcome.program_result, value);
  assert.equal(inline.native_outcome.task_verified, false);
  assert.equal(inline.coverage.program_result_complete, true);
  assert.equal(inline.coverage.full_evidence_included, false);
  assert.equal(saved.projection.truncated, true);
  assert.equal(saved.projection.content_hash, saved.ref.content_hash);
  assert.equal(saved.projection.artifact_ref, saved.ref.evidence_id);
  assert.equal(saved.projection.assignment_id, scope.assignment_id);
  const context = assembleBoundedEvidenceContext({ projections: [saved.projection], ...scope });
  const envelope = modelEvidenceEnvelope(context.projections, context.omitted);
  assert.equal((envelope.evidence_projections[0]!.inline_payload as any).native_outcome.program_result, value);
  assertBoundedModelEvidencePayload([{ type: "function_call_output", output: JSON.stringify(envelope) }]);
}));
for (const [state, effect] of [["rolled_back", "none"], ["unknown", "unknown"], ["committed", "applied"]]) {
  test(`native failure presentation retains ${state}/${effect} without retry or verification`, () => isolated(() => {
    const raw = payload("apply", state, effect, false), saved = save(raw), inline: any = saved.projection.inline_payload;
    assert.deepEqual(inline?.native_outcome, raw.native_outcome);
    assert.deepEqual(inline.diagnostics, raw.diagnostics);
    assert.equal(inline.execution_ok, false);
    assert.equal(inline.retry_authorized, false);
    assert.equal(inline.native_outcome.program_result, null);
    assert.equal(inline.native_outcome.task_verified, false);
  }));
}
test("native compact projection refuses foreign source, untrusted, malformed and snapshot payloads", () => isolated(() => {
  for (const options of [{ source: "unrelated" }, { trust_level: "untrusted_caller" }, { trust_level: "host_observed" }])
    assert.equal(save(payload(), options).projection.inline_payload, undefined);
  const variants = [
    { ...payload(), execution_lane: "snapshot" },
    { ...payload(), schema: "unrelated" },
    { ...payload(), requested_mode: "preview" },
    { ...payload(), native_outcome: { ...payload().native_outcome, program_result: { claimed: true } } },
    { ...payload(), native_outcome: { ...payload().native_outcome, task_verified: true } },
    { ...payload(), native_outcome: { ...payload().native_outcome, persistent_effect: "invented" } },
    payload("read", "committed", "applied"),
    payload("apply", "unknown", "unknown")
  ];
  for (const raw of variants) assert.equal(save(raw).projection.inline_payload, undefined);
}));
test("native output preserves empty and Unicode returns and labels omitted diagnostics", () => isolated(() => {
  for (const result of ["", "\u6f22\u5b57 \u0394 value\r\nexact whitespace  "]) {
    const raw = payload(); raw.native_outcome.program_result = result;
    raw.diagnostics = Array.from({ length: 10 }, (_, i) => ({ code: `D${i}`, message: `Diagnostic ${i}` }));
    const inline: any = save(raw).projection.inline_payload;
    assert.equal(inline.native_outcome.program_result, result);
    assert.equal(inline.coverage.total_diagnostics, 10);
    assert.equal(inline.coverage.presented_diagnostics, 8);
    assert.equal(inline.coverage.full_evidence_included, false);
  }
}));
test("document-scope label is retained without turning program output into verification", () => isolated(() => {
  const raw = payload("apply", "committed", "applied"); raw.native_outcome.effect_scope = "active_document";
  const inline: any = save(raw).projection.inline_payload;
  assert.deepEqual(inline.native_outcome, raw.native_outcome);
  assert.equal(inline.retry_authorized, false);
  raw.native_outcome.effect_scope = "unrecognized";
  assert.equal(save(raw).projection.inline_payload, undefined);
}));
test("large native return is not sliced into an apparently complete value", () => isolated(() => {
  const raw = payload(); raw.native_outcome.program_result = "\u6f22".repeat(8000);
  const saved = save(raw);
  assert.equal(saved.projection.inline_payload, undefined);
  assert.equal(saved.projection.truncated, true);
  assert(saved.projection.projected_bytes <= 8192);
  assert.equal(saved.projection.artifact_ref, saved.ref.evidence_id);
}));
