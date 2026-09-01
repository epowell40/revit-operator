export const BENCHMARK_PROTOCOL_V2 = "revit-operator.benchmark-protocol/v2" as const;
export const BENCHMARK_RUN_ENVELOPE_V2_SCHEMA = "revit-operator.benchmark-run-envelope/v2" as const;
export const BENCHMARK_CASE_RESULT_V2_SCHEMA = "revit-operator.benchmark-case-result/v2" as const;
export const BENCHMARK_RAW_REPORT_V2_SCHEMA = "revit-operator.benchmark-raw-report/v2" as const;
export const BENCHMARK_RESCORE_V2_SCHEMA = "revit-operator.benchmark-rescore/v2" as const;
export const BENCHMARK_RUNNER_V2 = "revit-operator.benchmark-runner/v2" as const;
export const BENCHMARK_REPORT_V2 = "revit-operator.benchmark-report/v2" as const;
export const BENCHMARK_FINALIZATION_FAILURE_V2_SCHEMA = "revit-operator.benchmark-finalization-failure/v2" as const;
export const GENERAL_REVIT_EVALUATOR_V2 = "revit-operator.general-revit-evaluator/v2" as const;

export const BENCHMARK_LANES = [
  "controlled_capability",
  "ambient_context",
  "safe_readiness",
  "committed_apply"
] as const;
export type BenchmarkLaneV2 = (typeof BENCHMARK_LANES)[number];

export const BENCHMARK_STAGE_NAMES = [
  "fixture_valid",
  "intent_understood",
  "target_grounded",
  "plan_admissible",
  "authorization_admission_satisfied",
  "preview_correct_where_required",
  "action_dispatched",
  "effect_classified",
  "postcondition_read_back",
  "task_semantics_satisfied",
  "user_facing_result_accurate"
] as const;
export type BenchmarkStageNameV2 = (typeof BENCHMARK_STAGE_NAMES)[number];
export type BenchmarkStageStatusV2 = "pass" | "fail" | "uncertain" | "not_applicable";

export const BENCHMARK_FAILURE_CAUSES = [
  "fixture_applicability",
  "missing_or_ambiguous_user_context",
  "intent_misunderstanding",
  "target_grounding_failure",
  "planning_tool_selection_failure",
  "authorization_control_failure",
  "schema_admission_failure",
  "dispatch_transaction_failure",
  "unknown_effect_reconciliation_failure",
  "verification_failure",
  "lifecycle_evidence_projection_failure",
  "evaluator_oracle_failure",
  "presentation_only_failure",
  "infrastructure_harness_failure",
  "false_completion",
  "unauthorized_or_collateral_mutation"
] as const;
export type BenchmarkFailureCauseV2 = (typeof BENCHMARK_FAILURE_CAUSES)[number];

export const BENCHMARK_DELIVERY_VERDICTS = [
  "verified_committed_completion",
  "first_pass_verified",
  "recovered_verified",
  "verified_noop",
  "verified_read_completion",
  "verified_preview_completion",
  "awaiting_user_input",
  "awaiting_user_review",
  "complete_with_issues",
  "truthful_fixture_blocker",
  "truthful_ambiguity_blocker",
  "genuine_product_limitation_blocker",
  "avoidable_clarification",
  "execution_failure",
  "verification_evidence_failure",
  "infrastructure_harness_failure",
  "false_completion",
  "collateral_or_unauthorized_mutation",
  "safe_readiness_only",
  "not_run"
] as const;
export type BenchmarkDeliveryVerdictV2 = (typeof BENCHMARK_DELIVERY_VERDICTS)[number];

export type BenchmarkHashRefV2 = { algorithm: "sha256"; value: string };
export type BenchmarkEvidenceRefV2 = {
  kind: string;
  ref: string;
  sha256?: string;
  authority?: string;
};

export type BenchmarkRunEnvelopeDraftV2 = {
  schema: typeof BENCHMARK_RUN_ENVELOPE_V2_SCHEMA;
  protocol_version: typeof BENCHMARK_PROTOCOL_V2;
  corpus: {
    version: string;
    sha256: string;
    original_case_manifest_sha256: string;
    case_hashes: Record<string, string>;
  };
  evaluator_version: string;
  fixture_adapter: { version: string; fixtures: Array<{ identity: string; rvt_sha256: string }> };
  revit_version: string;
  installed_release_identity: string;
  source_revisions: { public: string; private: string };
  policy_hashes: {
    tool_registry_sha256: string;
    tool_exposure_sha256: string;
    certification_policy_sha256: string;
  };
  instruction_bundle_hashes: {
    prompt_sha256: string;
    skill_sha256: string;
    system_instruction_sha256: string;
  };
  requested_agent: { model: string; reasoning_effort: string };
  feature_flags: Record<string, boolean | number | string>;
  authorization_mode: string;
  identity: { run_id: string; session_id: string; generation: number };
  execution_lane: BenchmarkLaneV2;
  started_at: string;
  runner_schema_version: typeof BENCHMARK_RUNNER_V2;
  report_schema_version: typeof BENCHMARK_REPORT_V2;
};

export type BenchmarkRunEnvelopeV2 = BenchmarkRunEnvelopeDraftV2 & {
  observed_provider_routes: Array<{
    route: string;
    model: string;
    reasoning_effort: string;
    call_count: number;
  }>;
  completed_at: string;
  envelope_sha256: string;
};

export type BenchmarkStageV2 = {
  stage: BenchmarkStageNameV2;
  status: BenchmarkStageStatusV2;
  reason: string;
  evidence_refs: string[];
};

export type BenchmarkExecutionTruthV2 = {
  requested_effect: "read" | "preview" | "apply";
  effect_state: "none" | "unknown" | "applied";
  authority: string;
  dispatched: boolean;
  assignment_id: string | null;
  attempt_ids: string[];
  target_identities: string[];
  affected_target_identities: string[];
  evidence_refs: BenchmarkEvidenceRefV2[];
  collateral_or_unauthorized_mutation: boolean;
};

export type BenchmarkJudgmentV2 = {
  version: string;
  verdict: string;
  judged_at: string;
  reasons: string[];
};

export type BenchmarkCaseResultV2 = {
  schema: typeof BENCHMARK_CASE_RESULT_V2_SCHEMA;
  run_id: string;
  case_id: string;
  /** Immutable source-corpus case hash. `case_sha256` is retained as its V2 compatibility alias. */
  case_sha256: string;
  source_case_sha256: string;
  execution_case_sha256: string;
  transformation_id: string;
  transformation_version: string;
  conversation_sequence_sha256: string;
  candidate_visible_input_sha256: string;
  evaluator_oracle_sha256: string;
  turns: Array<{
    turn_id: string;
    sequence: number;
    role: "user" | "assistant" | "tool";
    candidate_visible_input_sha256: string | null;
    content_sha256: string;
    clarification_id: string | null;
    assignment_outcome: "active" | "awaiting_user_input" | "awaiting_user_review" | "complete" | "complete_with_issues" | "verified_noop" | "blocked" | "failed" | "unknown" | null;
  }>;
  assignment_outcome: "active" | "awaiting_user_input" | "awaiting_user_review" | "complete" | "complete_with_issues" | "verified_noop" | "blocked" | "failed" | "unknown";
  lane: BenchmarkLaneV2;
  execution_truth: BenchmarkExecutionTruthV2;
  original_runtime_verdict: BenchmarkJudgmentV2;
  original_evaluator_verdict: BenchmarkJudgmentV2;
  current_evaluator_verdict: BenchmarkJudgmentV2;
  presentation_verdict: BenchmarkJudgmentV2;
  delivery_verdict: BenchmarkDeliveryVerdictV2;
  stages: BenchmarkStageV2[];
  first_failed_or_uncertain_stage: BenchmarkStageNameV2 | null;
  primary_failure_cause: BenchmarkFailureCauseV2 | null;
  contributing_failure_causes: BenchmarkFailureCauseV2[];
  release_blocking: boolean;
  metrics: {
    completion_time_ms: number | null;
    model_calls: number;
    revit_calls: number;
    repeated_no_progress_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
    human_interventions: number | null;
  };
  raw_trace_ref: string;
  raw_trace_sha256: string;
};

export type BenchmarkRawReportV2 = {
  schema: typeof BENCHMARK_RAW_REPORT_V2_SCHEMA;
  envelope: BenchmarkRunEnvelopeV2;
  cases: BenchmarkCaseResultV2[];
  generated_at: string;
  report_sha256: string;
};

export type BenchmarkFinalizationFailureV2 = {
  schema: typeof BENCHMARK_FINALIZATION_FAILURE_V2_SCHEMA;
  finalization_status: "failed";
  promotion_eligible: false;
  failure_code: string;
  failing_stage: string;
  missing_receipt_classes: string[];
  conflicting_receipt_classes: string[];
  source_flight: { ref: string; sha256: string | null; run_id: string | null };
  envelope_draft: { ref: string; sha256: string | null };
  evaluator_version: string | null;
  case_stage_vectors: Array<{ case_id: string; stages: unknown[]; first_failed_or_uncertain_stage: string | null }>;
  work_packets: { generated_case_ids: string[]; missing_case_ids: string[] };
  telemetry_completeness: "complete" | "provider_contract_unobservable" | "collection_failed" | "missing" | "still_in_flight" | "timed_out" | "conflicting_or_quarantined";
  receipt_diagnostics: {
    status: "complete" | "still_in_flight" | "timed_out" | "collection_failed" | "conflicting_or_quarantined" | "truly_absent";
    in_flight_attempt_ids: string[];
    next_in_flight_deadline: string | null;
    late_receipt_count: number;
  };
  error: string;
  generated_at: string;
  artifact_sha256: string;
};

export type BenchmarkVerdictChangeV2 = {
  case_id: string;
  original_verdict: string;
  current_verdict: string;
  explanation: string;
};

export type BenchmarkRescoreArtifactV2 = {
  schema: typeof BENCHMARK_RESCORE_V2_SCHEMA;
  source_report_ref: string;
  source_report_sha256: string;
  source_run_id: string;
  evaluator_version: string;
  rescored_at: string;
  cases: BenchmarkCaseResultV2[];
  verdict_changes: BenchmarkVerdictChangeV2[];
  rescore_sha256: string;
};

export type BenchmarkLaneMetricsV2 = {
  lane: BenchmarkLaneV2;
  case_count: number;
  verified_committed_completion: number;
  first_pass_verified: number;
  recovered_verified: number;
  verified_noop: number;
  verified_read_completion: number;
  verified_preview_completion: number;
  awaiting_user_input: number;
  awaiting_user_review: number;
  complete_with_issues: number;
  truthful_fixture_blocker: number;
  truthful_ambiguity_blocker: number;
  genuine_product_limitation_blocker: number;
  avoidable_clarification: number;
  execution_failure: number;
  verification_evidence_failure: number;
  infrastructure_harness_failure: number;
  false_completion: number;
  collateral_or_unauthorized_mutation: number;
  median_completion_time_ms: number | null;
  p95_completion_time_ms: number | null;
  model_calls: number;
  revit_calls: number;
  repeated_no_progress_calls: number;
  tokens_per_verified_task: number | null;
  estimated_cost_per_verified_task_usd: number | null;
  human_interventions: number | null;
  primary_delivered_labor_rate: number;
  release_blocked: boolean;
};
