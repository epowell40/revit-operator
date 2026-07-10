export type ReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh";
export type BenchmarkMode = "single_loop" | "split_planner_executor" | "deterministic_skill";
export type StepPhase = "plan" | "execute" | "verify" | "escalate" | "finalize";
export type SuccessLabel = "unknown" | "success" | "partial" | "fail";
export type ManualGradeValue = "success" | "partial" | "fail" | "invalid_run";

export type BenchmarkTaskDefinition = {
  schema_version: number;
  task_id: string;
  name: string;
  description: string;
  environment: {
    adapter_id: string;
    app?: string | null;
    website?: string | null;
    metadata?: Record<string, unknown>;
  };
  setup_instructions: string[];
  success_criteria: string[];
  failure_criteria: string[];
  max_time_seconds: number;
  max_steps: number;
  requires_manual_grade: boolean;
  grader_notes: string[];
  tags: string[];
  optional_ground_truth_artifact?: string | null;
  optional_cleanup_steps?: string[];
  adapter_config?: Record<string, unknown>;
};

export type BenchmarkExperimentConfig = {
  id: string;
  planner_model: string;
  planner_reasoning: ReasoningLevel;
  executor_model: string;
  executor_reasoning: ReasoningLevel;
  mode: BenchmarkMode;
  description?: string;
};

export type BenchmarkConfigBundle = {
  schema_version: number;
  baseline_config_id: string;
  acceptable_success_rate_threshold: number;
  unacceptable_failure_rate_threshold: number;
  default_phase1_task_ids: string[];
  default_phase1_repeat_count: number;
  phase1_config_ids: string[];
  broader_config_ids: string[];
  configs: BenchmarkExperimentConfig[];
};

export type BenchmarkPricingConfig = {
  schema_version: number;
  captured_at: string;
  source_notes?: string;
  models: Record<
    string,
    {
      input_per_1m_tokens_usd: number;
      cached_input_per_1m_tokens_usd?: number;
      output_per_1m_tokens_usd: number;
      tool_call_fee_usd?: number;
    }
  >;
};

export type BenchmarkEscalationConfig = {
  executor_failures_before_escalation: number;
  confidence_threshold: number;
  high_impact_action_keywords: string[];
  high_impact_target_keywords: string[];
};

export type PlannerSubgoal = {
  id: string;
  title: string;
  success_signal: string;
};

export type PlannerPlan = {
  objective: string;
  preconditions: string[];
  ordered_subgoals: PlannerSubgoal[];
  expected_visible_state_changes: string[];
  escalation_rules: string[];
  done_criteria: string[];
};

export type ExecutorDecision = {
  current_subgoal: string;
  current_subgoal_id?: string | null;
  chosen_action: string;
  target: string;
  brief_reason: string;
  expected_result: string;
  expected_state?: string | null;
  confidence: number;
  recommend_escalation: boolean;
  escalation_reason?: string | null;
  done: boolean;
  subgoal_completed?: boolean;
  high_impact_action?: boolean;
};

export type SingleLoopDecision = ExecutorDecision & {
  plan_note?: string | null;
};

export type NormalizedTokenUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  source: "api" | "estimated";
};

export type BenchmarkModelRequest = {
  model: string;
  reasoning: ReasoningLevel;
  system_prompt: string;
  user_prompt: string;
  metadata?: Record<string, unknown>;
};

export type BenchmarkModelResponse = {
  model: string;
  output_text: string;
  raw_response: unknown;
  usage: NormalizedTokenUsage;
  response_id?: string | null;
};

export type BenchmarkObservation = {
  visible_state_summary: string;
  observed_state_details?: string[];
  ambiguous?: boolean;
  screenshot_artifact_path?: string | null;
  observation_artifact_path?: string | null;
};

export type BenchmarkAction = {
  action_type: string;
  target: string;
  brief_reason: string;
  expected_result: string;
  expected_state?: string | null;
  high_impact?: boolean;
};

export type BenchmarkActionResult = {
  success: boolean;
  tool_latency_seconds: number;
  observation: BenchmarkObservation;
  action_result_summary: string;
  material_deviation: boolean;
  high_impact: boolean;
  irreversible: boolean;
};

export type BenchmarkEnvironmentRunContext = {
  run_id: string;
  run_dir: string;
  observations_dir: string;
  screenshots_dir: string;
};

export type BenchmarkEnvironmentSession = {
  getInitialObservation(): Promise<BenchmarkObservation>;
  executeAction(action: BenchmarkAction): Promise<BenchmarkActionResult>;
  isTaskComplete(): boolean;
  getObservedOutcomeSummary(): string;
  cleanup?(): Promise<void>;
};

export interface BenchmarkEnvironmentAdapter {
  readonly id: string;
  createSession(
    task: BenchmarkTaskDefinition,
    runContext: BenchmarkEnvironmentRunContext
  ): Promise<BenchmarkEnvironmentSession>;
}

export interface BenchmarkModelClient {
  createResponse(request: BenchmarkModelRequest): Promise<BenchmarkModelResponse>;
}

export type BenchmarkStepRecord = {
  run_id: string;
  step_index: number;
  phase: StepPhase;
  model: string;
  reasoning: ReasoningLevel;
  api_start_ts: string;
  api_end_ts: string;
  model_latency_seconds: number;
  tool_latency_seconds: number;
  cumulative_wall_clock_seconds: number;
  action_type: string;
  action_target: string;
  expected_state: string;
  observed_state_summary: string;
  confidence: number;
  escalated: boolean;
  retry_count_for_subgoal: number;
  token_usage_in: number;
  token_usage_out: number;
  estimated_cost_usd: number;
  usage_source: "api" | "estimated";
  raw_response_artifact_path: string;
  screenshot_artifact_path?: string | null;
  observation_artifact_path?: string | null;
  notes?: string[];
};

export type BenchmarkRunRecord = {
  run_id: string;
  batch_id: string;
  repeat_index: number;
  timestamp: string;
  task_id: string;
  config_id: string;
  planner_model: string;
  planner_reasoning: ReasoningLevel;
  executor_model: string;
  executor_reasoning: ReasoningLevel;
  total_wall_clock_seconds: number;
  total_model_latency_seconds: number;
  total_tool_latency_seconds: number;
  total_steps: number;
  total_planner_calls: number;
  total_executor_calls: number;
  total_escalations: number;
  success_label: SuccessLabel;
  manual_grade_required: boolean;
  manual_grade_value: ManualGradeValue | null;
  manual_grade_notes: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_cost_usd: number;
  termination_reason: string;
  usage_source: "api" | "estimated";
  run_status: "completed" | "interrupted";
  artifact_dir: string;
  steps_artifact_path: string;
  summary_artifact_path: string;
  observed_outcome_summary: string;
  expected_outcome_summary: string;
  time_to_first_meaningful_action_seconds: number | null;
  time_spent_in_replanning_seconds: number;
  time_lost_to_retries_seconds: number;
  average_latency_per_model_call_seconds: number;
  average_latency_per_executor_step_seconds: number;
  steps_per_minute: number;
  successful_tasks_per_hour_equivalent: number;
};

export type BenchmarkBatchManifest = {
  batch_id: string;
  started_at: string;
  completed_at?: string;
  artifacts_dir: string;
  config_ids: string[];
  task_ids: string[];
  repeat_count: number;
  runs_planned: number;
  runs_completed: number;
  runs_skipped: number;
  run_ids: string[];
};

export type BenchmarkConfigAggregate = {
  config_id: string;
  sample_size: number;
  success_rate: number;
  partial_rate: number;
  fail_rate: number;
  invalid_rate: number;
  average_wall_clock_seconds: number;
  average_model_latency_seconds: number;
  average_tool_latency_seconds: number;
  average_cost_usd: number;
  average_steps: number;
  average_time_to_first_action_seconds: number | null;
  average_replanning_seconds: number;
  average_retry_seconds: number;
  steps_per_minute: number;
  successful_tasks_per_hour_equivalent: number;
  p50_latency_seconds: number | null;
  p95_latency_seconds: number | null;
  latency_normalized_success: number;
  cost_normalized_success: number;
  relative_speedup_vs_baseline: number | null;
};

export type BenchmarkTaskAggregate = {
  task_id: string;
  config_id: string;
  sample_size: number;
  success_rate: number;
  average_wall_clock_seconds: number;
  average_cost_usd: number;
};

export type BenchmarkRevitWorkflowSummary = {
  run_id: string;
  task_id: string;
  config_id: string;
  workflow: string;
  execution_source: "live" | "mock" | "injected" | "unknown";
  success: boolean;
  elapsed_seconds: number;
  tool_calls: number;
  revit_transactions: number;
  computer_use_actions: number;
  output_artifact_count: number;
  verification_passed: number;
  verification_total: number;
  verification_names_passed: string[];
  verification_names_failed: string[];
  failure_reason: string | null;
  failure_classification?: string;
};

export type BenchmarkDemoReadinessGate = {
  task_id: string;
  workflow: string;
  sample_size: number;
  live_sample_size: number;
  min_live_sample_size: number;
  success_rate: number;
  target_success_rate: number;
  average_elapsed_seconds: number;
  target_elapsed_seconds: number;
  verification_pass_rate: number;
  passed: boolean;
  reason: string;
};

export type BenchmarkReport = {
  generated_at: string;
  artifacts_dir: string;
  baseline_config_id: string;
  runs_analyzed: number;
  small_sample_warning: boolean;
  config_aggregates: BenchmarkConfigAggregate[];
  task_aggregates: BenchmarkTaskAggregate[];
  revit_workflow_summaries: BenchmarkRevitWorkflowSummary[];
  demo_readiness_gates: BenchmarkDemoReadinessGate[];
  fastest_config_id: string | null;
  best_tradeoff_config_id: string | null;
  cheapest_acceptable_config_id: string | null;
  safest_fallback_config_id: string | null;
  fastest_experimental_config_id: string | null;
  conclusions: string[];
};
