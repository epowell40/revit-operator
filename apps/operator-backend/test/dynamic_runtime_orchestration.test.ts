import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildApprovedDynamicContextBundle,
  DYNAMIC_LIFECYCLE_SCHEMA,
  DYNAMIC_REPAIR_FEEDBACK_SCHEMA,
  planDynamicPreviewRepair,
  transitionDynamicLifecycle,
  type DynamicLifecycleStateV1,
  type DynamicRepairFeedbackV1
} from "../src/dynamic_runtime/orchestration.js";
import { DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA, DynamicProgramReuseStore, type DynamicProgramReuseRecordV1 } from "../src/dynamic_runtime/reuse_store.js";

const h = (value: string) => `sha256:${value.padEnd(64, value[0] || "0").slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, "a")}`;

function feedback(overrides: Partial<DynamicRepairFeedbackV1> = {}): DynamicRepairFeedbackV1 {
  return {
    schema: DYNAMIC_REPAIR_FEEDBACK_SCHEMA, attempt_id: "attempt-1", attempt_number: 1, phase: "preview", failure_class: "compiler",
    program_hash: h("a"), admission_id: "admission-a", diagnostic_codes: ["CS1002"], failing_element_identity_hashes: [],
    structured_evidence_hash: h("b"), outcome_uncertain: false, ...overrides
  };
}

test("preview repair is bounded and always requires a new program and admission", () => {
  const plan = planDynamicPreviewRepair({ feedback: feedback(), revised_source_hash: h("c"), revised_program_hash: h("d"), maximum_attempts: 3 });
  assert.equal(plan.next_attempt_number, 2); assert.equal(plan.requires_new_admission, true); assert.equal(plan.apply_retry_authorized, false);
  assert.throws(() => planDynamicPreviewRepair({ feedback: feedback({ phase: "apply" }), revised_source_hash: h("c"), revised_program_hash: h("d") }));
  assert.throws(() => planDynamicPreviewRepair({ feedback: feedback({ outcome_uncertain: true }), revised_source_hash: h("c"), revised_program_hash: h("d") }));
  assert.throws(() => planDynamicPreviewRepair({ feedback: feedback({ attempt_number: 3 }), revised_source_hash: h("c"), revised_program_hash: h("d"), maximum_attempts: 3 }));
  assert.throws(() => planDynamicPreviewRepair({ feedback: feedback(), revised_source_hash: h("c"), revised_program_hash: h("a") }));
});

test("approved company/project/user context informs reasoning but never authorizes", () => {
  const bundle = buildApprovedDynamicContextBundle([
    { scope: "company", semantic_summary: "Use the office sheet-number convention.", content_hash: h("1"), provenance_hash: h("2"), approval_hash: h("3"), approved_for_model_context: true },
    { scope: "project", semantic_summary: "Use the issued project family type.", content_hash: h("4"), provenance_hash: h("5"), approval_hash: h("6"), approved_for_model_context: true },
    { scope: "user", semantic_summary: "Group preview summaries by sheet.", content_hash: h("7"), provenance_hash: h("8"), approval_hash: h("9"), approved_for_model_context: true }
  ]);
  assert.equal(bundle.entries.length, 3); assert.equal(bundle.informs_model_reasoning_only, true); assert.equal(bundle.authorization_granted, false);
  assert.match(bundle.bundle_hash, /^sha256:/);
});

test("Sidecar lifecycle exposes truthful phases and outcome uncertainty is terminal", () => {
  let state: DynamicLifecycleStateV1 = { schema: DYNAMIC_LIFECYCLE_SCHEMA, execution_id: "execution-1", phase: "understanding_task", revision: 0, evidence_hash: h("0") };
  state = transitionDynamicLifecycle(state, "inspecting_model", h("1"));
  const preparing = transitionDynamicLifecycle(state, "preparing_automation", h("2"));
  const previewing = transitionDynamicLifecycle(preparing, "previewing", h("3"));
  const ready = transitionDynamicLifecycle(previewing, "preview_ready", h("4"));
  const waiting = transitionDynamicLifecycle(ready, "waiting_for_approval", h("5"));
  const applying = transitionDynamicLifecycle(waiting, "applying", h("6"));
  const uncertain = transitionDynamicLifecycle(applying, "outcome_uncertain", h("7"));
  assert.throws(() => transitionDynamicLifecycle(uncertain, "applying", h("8")));
});

test("successful programs are retained only as readmission-required templates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-reuse-"));
  try {
    const store = new DynamicProgramReuseStore(path.join(root, "reuse.jsonl")); const record = reuseRecord(); store.append(record);
    const candidate = store.candidate(record.record_id)!;
    assert.equal(candidate.use_as, "example_or_starting_template");
    assert.equal(candidate.requires_current_compilation, true); assert.equal(candidate.requires_current_admission, true);
    assert.equal(candidate.historical_success_bypasses_authorization, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("applied reuse records require exact apply evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dynamic-reuse-invalid-"));
  try {
    const store = new DynamicProgramReuseStore(path.join(root, "reuse.jsonl"));
    assert.throws(() => store.append({ ...reuseRecord(), verification_outcome: "apply_verified", apply_evidence_hash: null }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function reuseRecord(): DynamicProgramReuseRecordV1 {
  return {
    schema: DYNAMIC_PROGRAM_REUSE_RECORD_SCHEMA, record_id: "reuse-1", normalized_source: "public sealed class Program {}", normalized_source_hash: h("a"),
    semantic_task_description: "Set approved parameters according to a bounded rule.", required_sdk_capabilities: ["parameters.set"],
    applicability: { company_hash: h("b"), project_hash: h("c"), user_hash: null }, input_schema_hash: h("d"), program_hash: h("e"),
    preview_evidence_hash: h("f"), apply_evidence_hash: null, verification_outcome: "preview_verified", failure_history_hash: h("1"),
    runtime_version: "runtime/v1", sdk_version: "sdk/v1", authoring_model_identity_hash: h("2"), recorded_at_utc: "2026-08-09T02:00:00.000Z"
  };
}
