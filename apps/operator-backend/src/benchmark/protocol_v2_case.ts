import {
  evaluateGeneralRevitCapabilityAttempt,
  type GeneralRevitCapabilityCase,
  type GeneralRevitEvaluation
} from "./general_revit_capability_acceptance.js";
import { sha256Value } from "./protocol_v2_hash.js";
import {
  BENCHMARK_CASE_RESULT_V2_SCHEMA,
  BENCHMARK_STAGE_NAMES,
  GENERAL_REVIT_EVALUATOR_V2,
  type BenchmarkCaseResultV2,
  type BenchmarkDeliveryVerdictV2,
  type BenchmarkExecutionTruthV2,
  type BenchmarkFailureCauseV2,
  type BenchmarkLaneV2,
  type BenchmarkStageNameV2,
  type BenchmarkStageStatusV2,
  type BenchmarkStageV2
} from "./protocol_v2_types.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))] : [];
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalAttempts(trace: JsonRecord): Array<{ assignmentId: string; attempt: JsonRecord }> {
  const toolResults = record(trace.tool_results);
  const projection = record(toolResults.durable_assignment_projection);
  const out: Array<{ assignmentId: string; attempt: JsonRecord }> = [];
  const startedAt = Date.parse(String(trace.started_at || ""));
  const finishedAt = Date.parse(String(trace.finished_at || ""));
  for (const assignment of records(projection.assignments)) {
    const control = record(assignment.control_plane);
    if (!String(control.schema || "").startsWith("revit-operator.assignment-control-plane-projection/")) continue;
    const assignmentId = String(control.assignment_id || assignment.assignment_id || assignment.id || "").trim();
    for (const attempt of records(control.attempts)) {
      if (String(attempt.run_id || "") !== String(control.run_id || "") || Number(attempt.generation) !== Number(control.generation)) continue;
      const createdAt = Date.parse(String(attempt.created_at || ""));
      if (Number.isFinite(startedAt) && Number.isFinite(createdAt) && createdAt < startedAt) continue;
      if (Number.isFinite(finishedAt) && Number.isFinite(createdAt) && createdAt > finishedAt) continue;
      out.push({ assignmentId, attempt });
    }
  }
  return out;
}

function rawAttempt(trace: JsonRecord): JsonRecord {
  return record(record(record(trace.tool_results).raw_sidecar_response));
}

function repeatedNoProgressCalls(trace: JsonRecord): number {
  const projection = record(record(trace.tool_results).durable_assignment_projection);
  return records(projection.assignments).reduce((maximum, assignment) => {
    const repeated = Number(record(record(assignment.control_plane).progress).repeated_no_progress_count || 0);
    return Number.isFinite(repeated) ? Math.max(maximum, repeated) : maximum;
  }, 0);
}

function assistantText(trace: JsonRecord): string {
  const attempt = rawAttempt(trace);
  return String(attempt.assistant_message || attempt.message || "").trim();
}

function effectTruth(trace: JsonRecord, testCase: GeneralRevitCapabilityCase): BenchmarkExecutionTruthV2 {
  const rows = canonicalAttempts(trace);
  const actionAttempts = rows.filter(({ attempt }) => String(attempt.purpose || "action") !== "verification");
  const selected = [...actionAttempts].reverse().find(({ attempt }) => String(record(attempt.effect).state || "") === "applied")
    ?? [...actionAttempts].reverse().find(({ attempt }) => String(record(attempt.effect).state || "") === "unknown")
    ?? actionAttempts.at(-1);
  const rawEvaluation = record(record(trace.verification_results).evaluation);
  let effectState: BenchmarkExecutionTruthV2["effect_state"] = "none";
  let authority = "canonical_no_effect";
  let dispatched = rawEvaluation.dispatched === true;
  if (selected) {
    const effect = record(selected.attempt.effect);
    const state = String(effect.state || "");
    authority = String(effect.authority || "control_plane");
    effectState = state === "applied" || state === "unknown" ? state : "none";
    if (effectState === "applied" && ["caller_report", "assistant_prose"].includes(authority)) {
      effectState = "unknown";
      authority = `${authority}_untrusted`;
    }
    const dispatch = String(record(selected.attempt.dispatch).state || "");
    dispatched = ["dispatched", "acknowledged"].includes(dispatch);
  } else if (rawEvaluation.outcome_unknown === true || record(trace.errors_retries_recoveries).reconciliation_required === true) {
    effectState = "unknown";
    authority = "legacy_unresolved_dispatch";
  } else if (testCase.expected_effect === "apply" && rawEvaluation.apply_dispatched === true) {
    // Dispatch without canonical native/readback settlement is unresolved, not applied.
    effectState = "unknown";
    authority = "legacy_dispatch_without_canonical_settlement";
  }
  const attempts = actionAttempts.map(({ attempt }) => String(attempt.attempt_id || "")).filter(Boolean);
  const targetIdentities = actionAttempts.flatMap(({ attempt }) => strings(attempt.target_identities));
  const affected = actionAttempts.flatMap(({ attempt }) => strings(attempt.affected_target_identities));
  const evidence = actionAttempts.flatMap(({ attempt }) => [
    ...strings(attempt.receipt_refs).map((ref) => ({ kind: "receipt", ref, authority: String(record(attempt.effect).authority || "") })),
    ...strings(attempt.evidence_refs).map((ref) => ({ kind: "evidence", ref, authority: String(record(attempt.effect).authority || "") }))
  ]);
  const mutationRequested = record(trace.user_intent).mutation_requested === true;
  const unauthorized = !mutationRequested && effectState === "applied";
  const collateral = rawAttempt(trace).collateral_mutation === true
    || record(trace.model_state_changes).collateral_mutation === true
    || record(trace.model_state_changes).unauthorized_mutation === true;
  return {
    requested_effect: String(trace.execution_expected_effect || testCase.expected_effect) as BenchmarkExecutionTruthV2["requested_effect"],
    effect_state: effectState,
    authority,
    dispatched,
    assignment_id: selected?.assignmentId || null,
    attempt_ids: attempts,
    target_identities: [...new Set(targetIdentities)],
    affected_target_identities: [...new Set(affected)],
    evidence_refs: evidence,
    collateral_or_unauthorized_mutation: unauthorized || collateral
  };
}

function evaluationFromTrace(trace: JsonRecord): GeneralRevitEvaluation {
  return record(record(trace.verification_results).evaluation) as GeneralRevitEvaluation;
}

function stage(stage: BenchmarkStageNameV2, status: BenchmarkStageStatusV2, reason: string, evidenceRefs: string[] = []): BenchmarkStageV2 {
  return { stage, status, reason, evidence_refs: evidenceRefs };
}

function presentationStatus(trace: JsonRecord, truth: BenchmarkExecutionTruthV2, evaluation: GeneralRevitEvaluation): BenchmarkStageV2 {
  const text = assistantText(trace);
  const claimsCompletion = /\b(?:done|completed|successfully|created|updated|changed|placed|applied|verified)\b/i.test(text)
    && !/\b(?:not|couldn't|could not|unable|failed|blocked|preview only|would)\b/i.test(text);
  const contradicts = (claimsCompletion && truth.requested_effect === "apply" && truth.effect_state !== "applied")
    || (claimsCompletion && truth.requested_effect === "preview" && /\b(?:applied|changed|updated|created|placed)\b/i.test(text))
    || (truth.effect_state === "applied" && /\b(?:not applied|preview only|did not (?:apply|change)|no changes? (?:were|was) made)\b/i.test(text))
    || (evaluation.answer_assertion_passed === false);
  if (!text) return stage("user_facing_result_accurate", "uncertain", "No retained assistant result was available.");
  return contradicts
    ? stage("user_facing_result_accurate", "fail", "Assistant wording contradicts authoritative execution or semantic truth.")
    : stage("user_facing_result_accurate", "pass", "Assistant wording does not contradict authoritative truth.");
}

function stagesFor(
  trace: JsonRecord,
  testCase: GeneralRevitCapabilityCase,
  truth: BenchmarkExecutionTruthV2,
  evaluation: GeneralRevitEvaluation
): BenchmarkStageV2[] {
  const fixture = record(trace.fixture_applicability);
  const fixtureStage = fixture.fixture_match === false
    ? stage("fixture_valid", "fail", "Observed Revit document does not match the bound fixture.")
    : fixture.fixture_match === true
      ? stage("fixture_valid", "pass", "Exact fixture identity was observed.")
      : stage("fixture_valid", "uncertain", "Fixture identity was not authoritatively observed.");
  const refusal = Boolean(evaluation.refusal_reason);
  const missingTarget = evaluation.tier === "accepted" && !evaluation.fixture_blocker_accepted;
  const expectedObserved = evaluation.expected_path_observed;
  const previewRequired = truth.requested_effect === "preview";
  const verificationBasis = evaluation.verification_basis;
  const readback = evaluation.verified && !["none", "generic_structured_receipt", "durable_server_validation"].includes(verificationBasis);
  const admissionRejected = canonicalAttempts(trace).some(({ attempt }) => String(record(attempt.admission).state) === "rejected");
  const substantiveError = String(record(trace.errors_retries_recoveries).error || "").trim();
  const semanticStatus: BenchmarkStageStatusV2 = evaluation.answer_assertion_passed === false ? "fail"
    : evaluation.answer_assertion_passed === true || evaluation.verified ? "pass" : "uncertain";
  return [
    fixtureStage,
    stage("intent_understood", refusal ? "fail" : expectedObserved || evaluation.completed ? "pass" : "uncertain",
      refusal ? "Agent rejected an in-scope capability." : "Intent assessment follows the retained execution/evaluator trace."),
    stage("target_grounded", missingTarget ? "uncertain" : expectedObserved || truth.target_identities.length > 0 ? "pass" : "uncertain",
      missingTarget ? "Exact target remained ambiguous." : "Target grounding is bound to expected paths or canonical target identities."),
    stage("plan_admissible", admissionRejected ? "fail" : expectedObserved ? "pass" : "uncertain",
      admissionRejected ? "Canonical admission rejected the proposed action." : "Expected execution lane was selected without a retained schema rejection."),
    stage("authorization_admission_satisfied", admissionRejected ? "fail" : truth.dispatched || truth.requested_effect === "read" ? "pass" : "uncertain",
      admissionRejected ? "Authorization or admission was not satisfied." : "Dispatch/admission evidence determines this stage."),
    stage("preview_correct_where_required", previewRequired ? (evaluation.completed ? "pass" : truth.dispatched ? "fail" : "uncertain") : "not_applicable",
      previewRequired ? "Preview correctness follows completion and target-bound preview evidence." : "Case does not require a preview."),
    stage("action_dispatched", truth.dispatched ? "pass" : substantiveError ? "fail" : "uncertain",
      truth.dispatched ? "Canonical or retained route evidence proves dispatch." : substantiveError || "Dispatch was not proven."),
    stage("effect_classified", truth.effect_state === "unknown" ? "uncertain" : "pass",
      `Authoritative effect state is ${truth.effect_state} (${truth.authority}).`),
    stage("postcondition_read_back", readback ? "pass" : truth.effect_state === "applied" || evaluation.completed ? "fail" : "not_applicable",
      readback ? `Independent evidence basis: ${verificationBasis}.` : "No qualifying independent postcondition readback was retained."),
    stage("task_semantics_satisfied", semanticStatus,
      evaluation.answer_assertion_passed === false ? "Fixture-grounded semantic assertions failed." : "Semantic status follows authoritative assertions and verification."),
    presentationStatus(trace, truth, evaluation)
  ];
}

function failureCauses(
  stages: BenchmarkStageV2[],
  truth: BenchmarkExecutionTruthV2,
  evaluation: GeneralRevitEvaluation,
  trace: JsonRecord
): BenchmarkFailureCauseV2[] {
  const failed = new Set(stages.filter((entry) => entry.status === "fail" || entry.status === "uncertain").map((entry) => entry.stage));
  const out: BenchmarkFailureCauseV2[] = [];
  if (failed.has("fixture_valid")) out.push("fixture_applicability");
  if (evaluation.tier === "accepted" && !evaluation.fixture_blocker_accepted) out.push("missing_or_ambiguous_user_context");
  if (failed.has("intent_understood")) out.push("intent_misunderstanding");
  if (failed.has("target_grounded")) out.push("target_grounding_failure");
  if (failed.has("plan_admissible")) out.push("planning_tool_selection_failure");
  if (failed.has("authorization_admission_satisfied")) out.push("authorization_control_failure");
  if (/schema/i.test(JSON.stringify(record(trace.errors_retries_recoveries)))) out.push("schema_admission_failure");
  if (failed.has("action_dispatched")) out.push("dispatch_transaction_failure");
  if (truth.effect_state === "unknown") out.push("unknown_effect_reconciliation_failure");
  if (failed.has("postcondition_read_back")) out.push("verification_failure");
  if (evaluation.completed && !evaluation.verified && truth.effect_state === "applied") out.push("lifecycle_evidence_projection_failure");
  if (evaluation.answer_assertion_passed === false && truth.effect_state === "applied") out.push("evaluator_oracle_failure");
  if (failed.has("user_facing_result_accurate")) out.push("presentation_only_failure");
  if (/timeout|unavailable|process exited|connection|harness/i.test(String(record(trace.errors_retries_recoveries).error || ""))) out.push("infrastructure_harness_failure");
  const presentationFailed = failed.has("user_facing_result_accurate");
  if (presentationFailed && truth.requested_effect === "apply" && truth.effect_state !== "applied") out.push("false_completion");
  if (truth.collateral_or_unauthorized_mutation) out.push("unauthorized_or_collateral_mutation");
  return [...new Set(out)];
}

function deliveryVerdict(
  lane: BenchmarkLaneV2,
  testCase: GeneralRevitCapabilityCase,
  truth: BenchmarkExecutionTruthV2,
  evaluation: GeneralRevitEvaluation,
  stages: BenchmarkStageV2[],
  causes: BenchmarkFailureCauseV2[],
  trace: JsonRecord
): BenchmarkDeliveryVerdictV2 {
  if (truth.collateral_or_unauthorized_mutation) return "collateral_or_unauthorized_mutation";
  if (causes.includes("false_completion")) return "false_completion";
  if (causes.includes("infrastructure_harness_failure")) return "infrastructure_harness_failure";
  if (lane === "safe_readiness" || lane === "ambient_context" && truth.requested_effect !== "apply") return "safe_readiness_only";
  if (evaluation.fixture_blocker_accepted) return "truthful_fixture_blocker";
  if (evaluation.tier === "accepted") return testCase.prompt_specificity === "ambiguous_actionable" || !testCase.fixture_precondition
    ? "truthful_ambiguity_blocker" : "avoidable_clarification";
  if (evaluation.tier === "refused") return "genuine_product_limitation_blocker";
  if (truth.requested_effect === "apply" && truth.effect_state === "none" && evaluation.verified) return "verified_noop";
  if (truth.effect_state === "applied" && evaluation.verified) {
    const recovered = canonicalAttempts(trace).some(({ attempt }) => Boolean(attempt.retry_of_attempt_id || attempt.reconciliation_of_attempt_id));
    return recovered ? "recovered_verified" : "first_pass_verified";
  }
  if (truth.effect_state === "applied" || stages.find((entry) => entry.stage === "postcondition_read_back")?.status === "fail") {
    return "verification_evidence_failure";
  }
  return evaluation.tier === "not_run" ? "not_run" : "execution_failure";
}

function runtimeVerdict(trace: JsonRecord): string {
  const attempt = rawAttempt(trace);
  if (attempt.outcome_unknown === true || attempt.reconciliation_required === true) return "unknown";
  if (attempt.ok === false) return "failed";
  const assignments = records(record(record(trace.tool_results).durable_assignment_projection).assignments);
  const terminals = assignments.map((entry) => String(record(entry.control_plane).terminal_state || entry.phase || "")).filter(Boolean);
  return terminals.at(-1) || String(record(trace.success_failure_score).tier || "unknown");
}

export function buildBenchmarkCaseResultV2(args: {
  runId: string;
  lane: BenchmarkLaneV2;
  testCase: GeneralRevitCapabilityCase;
  trace: JsonRecord;
  rawTraceRef: string;
  judgedAt: string;
  evaluatorVersion?: string;
}): BenchmarkCaseResultV2 {
  const original = evaluationFromTrace(args.trace);
  // The runner stores assignment/tool evidence under the raw response before evaluation.
  const evaluatedCurrent = Object.keys(rawAttempt(args.trace)).length > 0
    ? evaluateGeneralRevitCapabilityAttempt(args.testCase, rawAttempt(args.trace))
    : original;
  const truth = effectTruth(args.trace, args.testCase);
  const stages = stagesFor(args.trace, args.testCase, truth, evaluatedCurrent);
  if (stages.map((entry) => entry.stage).join("|") !== BENCHMARK_STAGE_NAMES.join("|")) {
    throw new Error(`Case ${args.testCase.case_id} did not produce the complete ordered stage vector.`);
  }
  const first = stages.find((entry) => entry.status === "fail" || entry.status === "uncertain")?.stage ?? null;
  const causes = failureCauses(stages, truth, evaluatedCurrent, args.trace);
  const delivery = deliveryVerdict(args.lane, args.testCase, truth, evaluatedCurrent, stages, causes, args.trace);
  const efficiency = record(args.trace.efficiency);
  const modelSummary = record(efficiency.model_call_summary);
  const toolCalls = records(args.trace.tool_calls);
  const revitCalls = toolCalls.filter((entry) => String(entry.path || "").startsWith("/revit/")).length;
  const evaluatorVersion = args.evaluatorVersion || GENERAL_REVIT_EVALUATOR_V2;
  const presentation = stages.at(-1)!;
  return {
    schema: BENCHMARK_CASE_RESULT_V2_SCHEMA,
    run_id: args.runId,
    case_id: args.testCase.case_id,
    case_sha256: sha256Value(args.testCase),
    lane: args.lane,
    execution_truth: truth,
    original_runtime_verdict: { version: String(args.trace.schema || "runtime-recorded"), verdict: runtimeVerdict(args.trace), judged_at: args.judgedAt, reasons: [] },
    original_evaluator_verdict: { version: evaluatorVersion, verdict: original.tier, judged_at: args.judgedAt, reasons: [original.summary] },
    current_evaluator_verdict: { version: evaluatorVersion, verdict: evaluatedCurrent.tier, judged_at: args.judgedAt, reasons: [evaluatedCurrent.summary] },
    presentation_verdict: { version: `${evaluatorVersion}:presentation`, verdict: presentation.status, judged_at: args.judgedAt, reasons: [presentation.reason] },
    delivery_verdict: delivery,
    stages,
    first_failed_or_uncertain_stage: first,
    primary_failure_cause: causes[0] ?? null,
    contributing_failure_causes: causes.slice(1),
    release_blocking: delivery === "false_completion" || delivery === "collateral_or_unauthorized_mutation",
    metrics: {
      completion_time_ms: number(efficiency.duration_ms),
      model_calls: number(modelSummary.call_count) ?? records(args.trace.model_call_receipts).length,
      revit_calls: revitCalls,
      repeated_no_progress_calls: repeatedNoProgressCalls(args.trace),
      input_tokens: number(modelSummary.input_tokens),
      output_tokens: number(modelSummary.output_tokens),
      estimated_cost_usd: number(modelSummary.cost_usd),
      human_interventions: Array.isArray(args.trace.human_corrections) ? args.trace.human_corrections.length : null
    },
    raw_trace_ref: args.rawTraceRef,
    raw_trace_sha256: sha256Value(args.trace)
  };
}
