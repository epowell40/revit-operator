import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { calculateCallCostUsd } from "./cost.js";
import { getConfigById, loadBenchmarkConfigBundle, loadBenchmarkEscalationConfig, loadBenchmarkPricingConfig } from "./config.js";
import { getEnvironmentAdapter } from "./environment.js";
import { appendJsonl, ensureDir, nowIso, prettyJson, safeSlug, todayStamp, writeJsonFile, writeTextFile } from "./files.js";
import { exportManualGradingSheet } from "./grading.js";
import { OpenAiResponsesBenchmarkClient } from "./model_client.js";
import {
  buildExecutorPrompts,
  buildPlannerPrompts,
  buildSingleLoopPrompts,
  parseExecutorDecision,
  parsePlannerPlan,
  parseSingleLoopDecision
} from "./prompts.js";
import { writeBenchmarkReportArtifacts } from "./report.js";
import { getTaskById, loadBenchmarkTasks } from "./tasks.js";
import type {
  BenchmarkAction,
  BenchmarkBatchManifest,
  BenchmarkConfigBundle,
  BenchmarkEnvironmentRunContext,
  BenchmarkExperimentConfig,
  BenchmarkModelClient,
  BenchmarkRunRecord,
  BenchmarkStepRecord,
  BenchmarkTaskDefinition,
  ExecutorDecision,
  PlannerPlan,
  SingleLoopDecision,
  StepPhase
} from "./types.js";

type ProgressEvent = {
  subgoal_id: string;
  subgoal_title: string;
  action_type: string;
  target: string;
  observed_state_summary: string;
  success: boolean;
  escalated: boolean;
};

type RunSingleOptions = {
  batch_id: string;
  batch_dir: string;
  repeat_index: number;
  resume?: boolean;
};

export type RunBatchOptions = {
  batch_id?: string;
  artifacts_root?: string;
  task_ids: string[];
  config_ids: string[];
  repeat_count: number;
  resume?: boolean;
  model_client?: BenchmarkModelClient;
};

function makeRunId(batchId: string, configId: string, taskId: string, repeatIndex: number): string {
  return `${batchId}__${configId}__${taskId}__r${String(repeatIndex).padStart(2, "0")}`;
}

function buildBatchId(prefix = "computer_use_benchmark"): string {
  return `${safeSlug(prefix)}_${nowIso().replace(/[:.]/g, "-")}`;
}

function resolveArtifactsRoot(explicitRoot?: string): string {
  return explicitRoot || path.join("artifacts", "benchmark_runs", todayStamp());
}

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readExistingRun(runJsonPath: string): BenchmarkRunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(runJsonPath, "utf8")) as BenchmarkRunRecord;
  } catch {
    return null;
  }
}

function summarizeExpectedOutcome(task: BenchmarkTaskDefinition): string {
  return task.success_criteria.join(" | ");
}

function summarizeProgress(events: ProgressEvent[]): string {
  if (events.length === 0) return "No prior progress recorded.";
  return events
    .slice(-8)
    .map((event, index) => {
      const status = event.escalated ? "escalated" : event.success ? "ok" : "retry";
      return `${index + 1}. ${event.subgoal_title || event.subgoal_id} | ${event.action_type} -> ${event.target} | ${status} | observed=${event.observed_state_summary}`;
    })
    .join("\n");
}

function defaultPlannerPlan(task: BenchmarkTaskDefinition): PlannerPlan {
  return {
    objective: task.description,
    preconditions: task.setup_instructions,
    ordered_subgoals: task.success_criteria.map((criterion, index) => ({
      id: `fallback_subgoal_${index + 1}`,
      title: criterion,
      success_signal: criterion
    })),
    expected_visible_state_changes: task.success_criteria,
    escalation_rules: task.failure_criteria,
    done_criteria: task.success_criteria
  };
}

function plannerSubgoalAt(plan: PlannerPlan, index: number): { id: string; title: string; success_signal: string } {
  return plan.ordered_subgoals[index] ?? plan.ordered_subgoals[plan.ordered_subgoals.length - 1] ?? {
    id: "subgoal_1",
    title: "Complete the task",
    success_signal: ""
  };
}

function isMeaningfulAction(actionType: string): boolean {
  const normalized = actionType.trim().toLowerCase();
  return !["", "noop", "observe", "wait", "finish", "complete"].includes(normalized);
}

function isHighImpactAction(
  actionType: string,
  target: string,
  escalation: ReturnType<typeof loadBenchmarkEscalationConfig>,
  explicitHighImpact?: boolean
): boolean {
  if (explicitHighImpact) return true;
  const normalizedAction = actionType.trim().toLowerCase();
  const normalizedTarget = target.trim().toLowerCase();
  return (
    escalation.high_impact_action_keywords.some((keyword) => normalizedAction.includes(keyword)) ||
    escalation.high_impact_target_keywords.some((keyword) => normalizedTarget.includes(keyword))
  );
}

function appendStepRecord(stepsPath: string, step: BenchmarkStepRecord): void {
  appendJsonl(stepsPath, step);
}

function writeRunSummaryMarkdown(run: BenchmarkRunRecord, steps: BenchmarkStepRecord[]): void {
  const lines: string[] = [];
  lines.push(`# Run Summary: ${run.run_id}`);
  lines.push("");
  lines.push(`- Task: ${run.task_id}`);
  lines.push(`- Config: ${run.config_id}`);
  lines.push(`- Success label: ${run.success_label}`);
  lines.push(`- Manual grade required: ${run.manual_grade_required ? "yes" : "no"}`);
  lines.push(`- Termination reason: ${run.termination_reason}`);
  lines.push(`- Wall clock: ${run.total_wall_clock_seconds.toFixed(2)}s`);
  lines.push(`- Model latency: ${run.total_model_latency_seconds.toFixed(2)}s`);
  lines.push(`- Tool latency: ${run.total_tool_latency_seconds.toFixed(2)}s`);
  lines.push(`- Total steps: ${run.total_steps}`);
  lines.push(`- Planner calls: ${run.total_planner_calls}`);
  lines.push(`- Executor calls: ${run.total_executor_calls}`);
  lines.push(`- Escalations: ${run.total_escalations}`);
  lines.push(`- Estimated cost: $${run.estimated_total_cost_usd.toFixed(4)}`);
  lines.push(`- Observed outcome: ${run.observed_outcome_summary}`);
  lines.push("");
  lines.push("## Step Log");
  for (const step of steps) {
    lines.push(
      `- [${step.phase}] #${step.step_index} ${step.action_type || "n/a"} ${step.action_target || ""} | observed=${step.observed_state_summary} | confidence=${step.confidence.toFixed(2)} | escalated=${step.escalated ? "yes" : "no"}`
    );
  }
  writeTextFile(run.summary_artifact_path, `${lines.join("\n")}\n`);
}

async function callPlannerModel(args: {
  modelClient: BenchmarkModelClient;
  config: BenchmarkExperimentConfig;
  task: BenchmarkTaskDefinition;
  stateSummary: string;
  progressSummary: string;
  escalationContext: string;
  rawOutputPath: string;
}): Promise<{ plan: PlannerPlan; latencySeconds: number; usageIn: number; usageOut: number; usageSource: "api" | "estimated"; costUsd: number }> {
  const pricing = loadBenchmarkPricingConfig();
  const { system, user } = buildPlannerPrompts({
    task: args.task,
    stateSummary: args.stateSummary,
    progressSummary: args.progressSummary,
    escalationContext: args.escalationContext
  });
  const startedAt = performance.now();
  const response = await args.modelClient.createResponse({
    model: args.config.planner_model,
    reasoning: args.config.planner_reasoning,
    system_prompt: system,
    user_prompt: user,
    metadata: { benchmark_phase: "planner", task_id: args.task.task_id, config_id: args.config.id }
  });
  const latencySeconds = (performance.now() - startedAt) / 1000;
  writeJsonFile(args.rawOutputPath, response.raw_response);
  return {
    plan: parsePlannerPlan(response.output_text),
    latencySeconds,
    usageIn: response.usage.input_tokens,
    usageOut: response.usage.output_tokens,
    usageSource: response.usage.source,
    costUsd: calculateCallCostUsd(args.config.planner_model, response.usage, pricing)
  };
}

async function callExecutorModel(args: {
  modelClient: BenchmarkModelClient;
  config: BenchmarkExperimentConfig;
  task: BenchmarkTaskDefinition;
  plan: PlannerPlan;
  currentSubgoalJson: string;
  stateSummary: string;
  progressSummary: string;
  rawOutputPath: string;
}): Promise<{ decision: ExecutorDecision; latencySeconds: number; usageIn: number; usageOut: number; usageSource: "api" | "estimated"; costUsd: number }> {
  const pricing = loadBenchmarkPricingConfig();
  const { system, user } = buildExecutorPrompts({
    task: args.task,
    plan: args.plan,
    currentSubgoalJson: args.currentSubgoalJson,
    stateSummary: args.stateSummary,
    progressSummary: args.progressSummary
  });
  const startedAt = performance.now();
  const response = await args.modelClient.createResponse({
    model: args.config.executor_model,
    reasoning: args.config.executor_reasoning,
    system_prompt: system,
    user_prompt: user,
    metadata: { benchmark_phase: "executor", task_id: args.task.task_id, config_id: args.config.id }
  });
  const latencySeconds = (performance.now() - startedAt) / 1000;
  writeJsonFile(args.rawOutputPath, response.raw_response);
  return {
    decision: parseExecutorDecision(response.output_text),
    latencySeconds,
    usageIn: response.usage.input_tokens,
    usageOut: response.usage.output_tokens,
    usageSource: response.usage.source,
    costUsd: calculateCallCostUsd(args.config.executor_model, response.usage, pricing)
  };
}

async function callSingleLoopModel(args: {
  modelClient: BenchmarkModelClient;
  config: BenchmarkExperimentConfig;
  task: BenchmarkTaskDefinition;
  stateSummary: string;
  progressSummary: string;
  rawOutputPath: string;
}): Promise<{ decision: SingleLoopDecision; latencySeconds: number; usageIn: number; usageOut: number; usageSource: "api" | "estimated"; costUsd: number }> {
  const pricing = loadBenchmarkPricingConfig();
  const { system, user } = buildSingleLoopPrompts({
    task: args.task,
    stateSummary: args.stateSummary,
    progressSummary: args.progressSummary
  });
  const startedAt = performance.now();
  const response = await args.modelClient.createResponse({
    model: args.config.executor_model,
    reasoning: args.config.executor_reasoning,
    system_prompt: system,
    user_prompt: user,
    metadata: { benchmark_phase: "single_loop", task_id: args.task.task_id, config_id: args.config.id }
  });
  const latencySeconds = (performance.now() - startedAt) / 1000;
  writeJsonFile(args.rawOutputPath, response.raw_response);
  return {
    decision: parseSingleLoopDecision(response.output_text),
    latencySeconds,
    usageIn: response.usage.input_tokens,
    usageOut: response.usage.output_tokens,
    usageSource: response.usage.source,
    costUsd: calculateCallCostUsd(args.config.executor_model, response.usage, pricing)
  };
}

export async function runSingleBenchmark(
  task: BenchmarkTaskDefinition,
  config: BenchmarkExperimentConfig,
  options: RunSingleOptions,
  modelClient: BenchmarkModelClient = new OpenAiResponsesBenchmarkClient()
): Promise<BenchmarkRunRecord> {
  const runId = makeRunId(options.batch_id, config.id, task.task_id, options.repeat_index);
  const runDir = path.join(options.batch_dir, config.id, task.task_id, `repeat-${String(options.repeat_index).padStart(2, "0")}`);
  const runJsonPath = path.join(runDir, "run.json");
  if (options.resume && pathExists(runJsonPath)) {
    const existing = readExistingRun(runJsonPath);
    if (existing?.run_status === "completed") return existing;
  }

  const stepsPath = path.join(runDir, "steps.jsonl");
  const summaryPath = path.join(runDir, "summary.md");
  const rawOutputsDir = ensureDir(path.join(runDir, "raw_model_outputs"));
  const screenshotsDir = ensureDir(path.join(runDir, "screenshots"));
  const observationsDir = ensureDir(path.join(runDir, "observations"));
  ensureDir(runDir);

  const runContext: BenchmarkEnvironmentRunContext = {
    run_id: runId,
    run_dir: runDir,
    observations_dir: observationsDir,
    screenshots_dir: screenshotsDir
  };
  const environment = await getEnvironmentAdapter(task.environment.adapter_id).createSession(task, runContext);
  const escalation = loadBenchmarkEscalationConfig();
  const startedAt = performance.now();
  const timestamp = nowIso();
  const progressEvents: ProgressEvent[] = [];
  const steps: BenchmarkStepRecord[] = [];
  let totalModelLatencySeconds = 0;
  let totalToolLatencySeconds = 0;
  let totalPlannerCalls = 0;
  let totalExecutorCalls = 0;
  let totalEscalations = 0;
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  let estimatedTotalCostUsd = 0;
  let usageSource: "api" | "estimated" = "api";
  let timeToFirstMeaningfulActionSeconds: number | null = null;
  let timeSpentInReplanningSeconds = 0;
  let timeLostToRetriesSeconds = 0;
  let currentObservation = await environment.getInitialObservation();
  let currentPlan: PlannerPlan | null = null;
  let currentSubgoalIndex = 0;
  let retryCountForSubgoal = 0;
  let lastEscalationReason = "";
  let terminationReason = "completed";
  let successLabel: BenchmarkRunRecord["success_label"] = task.requires_manual_grade ? "unknown" : "fail";
  let stepIndex = 0;

  try {
    if (config.mode === "deterministic_skill") {
      const action: BenchmarkAction = {
        action_type: "run_workflow",
        target: task.task_id,
        brief_reason: "Execute the deterministic Revit workflow without a model decision loop.",
        expected_result: summarizeExpectedOutcome(task),
        expected_state: summarizeExpectedOutcome(task),
        high_impact: false
      };
      const actionResult = await environment.executeAction(action);
      totalToolLatencySeconds += actionResult.tool_latency_seconds;
      usageSource = "estimated";
      currentObservation = actionResult.observation;
      successLabel = actionResult.success ? (task.requires_manual_grade ? "unknown" : "success") : "fail";
      terminationReason = actionResult.success ? "deterministic_workflow_complete" : actionResult.action_result_summary;
      timeToFirstMeaningfulActionSeconds = (performance.now() - startedAt) / 1000;
      stepIndex = 1;
      const stepRecord: BenchmarkStepRecord = {
        run_id: runId,
        step_index: stepIndex,
        phase: "execute",
        model: config.executor_model,
        reasoning: config.executor_reasoning,
        api_start_ts: timestamp,
        api_end_ts: nowIso(),
        model_latency_seconds: 0,
        tool_latency_seconds: actionResult.tool_latency_seconds,
        cumulative_wall_clock_seconds: (performance.now() - startedAt) / 1000,
        action_type: action.action_type,
        action_target: action.target,
        expected_state: action.expected_state ?? "",
        observed_state_summary: currentObservation.visible_state_summary,
        confidence: actionResult.success ? 1 : 0,
        escalated: false,
        retry_count_for_subgoal: 0,
        token_usage_in: 0,
        token_usage_out: 0,
        estimated_cost_usd: 0,
        usage_source: "estimated",
        raw_response_artifact_path: "",
        screenshot_artifact_path: currentObservation.screenshot_artifact_path ?? null,
        observation_artifact_path: currentObservation.observation_artifact_path ?? null,
        notes: [actionResult.action_result_summary]
      };
      steps.push(stepRecord);
      appendStepRecord(stepsPath, stepRecord);
    } else {
    if (config.mode === "split_planner_executor") {
      const plannerRawPath = path.join(rawOutputsDir, `step-${String(stepIndex + 1).padStart(3, "0")}_plan.json`);
      const plannerResult = await callPlannerModel({
        modelClient,
        config,
        task,
        stateSummary: currentObservation.visible_state_summary,
        progressSummary: summarizeProgress(progressEvents),
        escalationContext: "Initial planning pass.",
        rawOutputPath: plannerRawPath
      });
      currentPlan = plannerResult.plan;
      totalPlannerCalls += 1;
      totalModelLatencySeconds += plannerResult.latencySeconds;
      estimatedInputTokens += plannerResult.usageIn;
      estimatedOutputTokens += plannerResult.usageOut;
      estimatedTotalCostUsd += plannerResult.costUsd;
      usageSource = usageSource === "api" && plannerResult.usageSource === "api" ? "api" : "estimated";
      stepIndex += 1;
      const plannerStep: BenchmarkStepRecord = {
        run_id: runId,
        step_index: stepIndex,
        phase: "plan",
        model: config.planner_model,
        reasoning: config.planner_reasoning,
        api_start_ts: timestamp,
        api_end_ts: nowIso(),
        model_latency_seconds: plannerResult.latencySeconds,
        tool_latency_seconds: 0,
        cumulative_wall_clock_seconds: (performance.now() - startedAt) / 1000,
        action_type: "plan",
        action_target: currentPlan.objective,
        expected_state: currentPlan.done_criteria.join(" | "),
        observed_state_summary: currentObservation.visible_state_summary,
        confidence: 1,
        escalated: false,
        retry_count_for_subgoal: 0,
        token_usage_in: plannerResult.usageIn,
        token_usage_out: plannerResult.usageOut,
        estimated_cost_usd: plannerResult.costUsd,
        usage_source: plannerResult.usageSource,
        raw_response_artifact_path: plannerRawPath,
        screenshot_artifact_path: currentObservation.screenshot_artifact_path ?? null,
        observation_artifact_path: currentObservation.observation_artifact_path ?? null
      };
      steps.push(plannerStep);
      appendStepRecord(stepsPath, plannerStep);
    }

    while (stepIndex < task.max_steps) {
      if ((performance.now() - startedAt) / 1000 > task.max_time_seconds) {
        terminationReason = "max_time_seconds_exceeded";
        successLabel = progressEvents.length > 0 ? "partial" : "fail";
        break;
      }

      let decision: ExecutorDecision | SingleLoopDecision;
      let rawOutputPath = "";
      let modelLatencySeconds = 0;
      let usageIn = 0;
      let usageOut = 0;
      let callCostUsd = 0;
      let callUsageSource: "api" | "estimated" = "api";

      if (config.mode === "split_planner_executor") {
        const plan = currentPlan || defaultPlannerPlan(task);
        const currentSubgoal = plannerSubgoalAt(plan, currentSubgoalIndex);
        rawOutputPath = path.join(rawOutputsDir, `step-${String(stepIndex + 1).padStart(3, "0")}_execute.json`);
        const result = await callExecutorModel({
          modelClient,
          config,
          task,
          plan,
          currentSubgoalJson: prettyJson(currentSubgoal),
          stateSummary: currentObservation.visible_state_summary,
          progressSummary: summarizeProgress(progressEvents),
          rawOutputPath
        });
        decision = result.decision;
        modelLatencySeconds = result.latencySeconds;
        usageIn = result.usageIn;
        usageOut = result.usageOut;
        callCostUsd = result.costUsd;
        callUsageSource = result.usageSource;
      } else {
        rawOutputPath = path.join(rawOutputsDir, `step-${String(stepIndex + 1).padStart(3, "0")}_single.json`);
        const result = await callSingleLoopModel({
          modelClient,
          config,
          task,
          stateSummary: currentObservation.visible_state_summary,
          progressSummary: summarizeProgress(progressEvents),
          rawOutputPath
        });
        decision = result.decision;
        modelLatencySeconds = result.latencySeconds;
        usageIn = result.usageIn;
        usageOut = result.usageOut;
        callCostUsd = result.costUsd;
        callUsageSource = result.usageSource;
      }

      totalExecutorCalls += 1;
      totalModelLatencySeconds += modelLatencySeconds;
      estimatedInputTokens += usageIn;
      estimatedOutputTokens += usageOut;
      estimatedTotalCostUsd += callCostUsd;
      usageSource = usageSource === "api" && callUsageSource === "api" ? "api" : "estimated";

      const currentPlanForDecision = currentPlan || defaultPlannerPlan(task);
      const activeSubgoal = plannerSubgoalAt(currentPlanForDecision, currentSubgoalIndex);
      const highImpact = isHighImpactAction(decision.chosen_action, decision.target, escalation, decision.high_impact_action);
      const shouldEscalate =
        config.mode === "split_planner_executor" &&
        (decision.recommend_escalation ||
          currentObservation.ambiguous === true ||
          retryCountForSubgoal >= escalation.executor_failures_before_escalation ||
          highImpact ||
          decision.confidence < escalation.confidence_threshold);

      let phase: StepPhase = shouldEscalate ? "escalate" : "execute";
      let toolLatencySeconds = 0;
      let observedStateSummary = currentObservation.visible_state_summary;
      let screenshotArtifactPath = currentObservation.screenshot_artifact_path ?? null;
      let observationArtifactPath = currentObservation.observation_artifact_path ?? null;
      const stepNotes: string[] = [];

      if (shouldEscalate) {
        totalEscalations += 1;
        lastEscalationReason =
          decision.escalation_reason ||
          (highImpact
            ? "Executor flagged the next step as high-impact or irreversible."
            : retryCountForSubgoal >= escalation.executor_failures_before_escalation
              ? "Executor failed twice on the same subgoal."
              : currentObservation.ambiguous
                ? "Environment state is ambiguous."
                : "Executor confidence dropped below threshold.");
        stepNotes.push(lastEscalationReason);
        timeSpentInReplanningSeconds += modelLatencySeconds;
      } else if (decision.done && !isMeaningfulAction(decision.chosen_action)) {
        successLabel = task.requires_manual_grade ? "unknown" : "success";
        terminationReason = "done_without_additional_action";
      } else {
        const action: BenchmarkAction = {
          action_type: decision.chosen_action,
          target: decision.target,
          brief_reason: decision.brief_reason,
          expected_result: decision.expected_result,
          expected_state: decision.expected_state ?? activeSubgoal.success_signal ?? null,
          high_impact: highImpact
        };
        const actionResult = await environment.executeAction(action);
        toolLatencySeconds = actionResult.tool_latency_seconds;
        totalToolLatencySeconds += toolLatencySeconds;
        currentObservation = actionResult.observation;
        observedStateSummary = currentObservation.visible_state_summary;
        screenshotArtifactPath = currentObservation.screenshot_artifact_path ?? null;
        observationArtifactPath = currentObservation.observation_artifact_path ?? null;

        if (isMeaningfulAction(decision.chosen_action) && timeToFirstMeaningfulActionSeconds === null) {
          timeToFirstMeaningfulActionSeconds = (performance.now() - startedAt) / 1000;
        }

        if (retryCountForSubgoal > 0) timeLostToRetriesSeconds += modelLatencySeconds + toolLatencySeconds;

        if (actionResult.success) {
          retryCountForSubgoal = 0;
          progressEvents.push({
            subgoal_id: activeSubgoal.id,
            subgoal_title: activeSubgoal.title,
            action_type: decision.chosen_action,
            target: decision.target,
            observed_state_summary: observedStateSummary,
            success: true,
            escalated: false
          });
          if (config.mode === "split_planner_executor" && (decision.subgoal_completed ?? true)) {
            currentSubgoalIndex += 1;
          }
        } else {
          retryCountForSubgoal += 1;
          stepNotes.push(actionResult.action_result_summary);
          progressEvents.push({
            subgoal_id: activeSubgoal.id,
            subgoal_title: activeSubgoal.title,
            action_type: decision.chosen_action,
            target: decision.target,
            observed_state_summary: observedStateSummary,
            success: false,
            escalated: false
          });
        }

        if (actionResult.material_deviation) {
          stepNotes.push("Observed state deviated from the expected path.");
          if (config.mode === "split_planner_executor") {
            lastEscalationReason = "Environment deviated materially from the expected state.";
          }
        }

        if (environment.isTaskComplete() || decision.done) {
          successLabel = task.requires_manual_grade ? "unknown" : "success";
          terminationReason = "task_complete";
        }
      }

      stepIndex += 1;
      const stepRecord: BenchmarkStepRecord = {
        run_id: runId,
        step_index: stepIndex,
        phase,
        model: config.executor_model,
        reasoning: config.executor_reasoning,
        api_start_ts: timestamp,
        api_end_ts: nowIso(),
        model_latency_seconds: modelLatencySeconds,
        tool_latency_seconds: toolLatencySeconds,
        cumulative_wall_clock_seconds: (performance.now() - startedAt) / 1000,
        action_type: decision.chosen_action,
        action_target: decision.target,
        expected_state: decision.expected_state ?? "",
        observed_state_summary: observedStateSummary,
        confidence: decision.confidence,
        escalated: phase === "escalate",
        retry_count_for_subgoal: retryCountForSubgoal,
        token_usage_in: usageIn,
        token_usage_out: usageOut,
        estimated_cost_usd: callCostUsd,
        usage_source: callUsageSource,
        raw_response_artifact_path: rawOutputPath,
        screenshot_artifact_path: screenshotArtifactPath,
        observation_artifact_path: observationArtifactPath,
        notes: stepNotes.length > 0 ? stepNotes : undefined
      };
      steps.push(stepRecord);
      appendStepRecord(stepsPath, stepRecord);

      if (phase === "escalate" && config.mode === "split_planner_executor") {
        const replanRawPath = path.join(rawOutputsDir, `step-${String(stepIndex + 1).padStart(3, "0")}_replan.json`);
        const plannerResult = await callPlannerModel({
          modelClient,
          config,
          task,
          stateSummary: currentObservation.visible_state_summary,
          progressSummary: summarizeProgress(progressEvents),
          escalationContext: lastEscalationReason || "Executor requested replanning.",
          rawOutputPath: replanRawPath
        });
        currentPlan = plannerResult.plan;
        totalPlannerCalls += 1;
        totalModelLatencySeconds += plannerResult.latencySeconds;
        estimatedInputTokens += plannerResult.usageIn;
        estimatedOutputTokens += plannerResult.usageOut;
        estimatedTotalCostUsd += plannerResult.costUsd;
        usageSource = usageSource === "api" && plannerResult.usageSource === "api" ? "api" : "estimated";
        retryCountForSubgoal = 0;
        stepIndex += 1;
        const plannerStep: BenchmarkStepRecord = {
          run_id: runId,
          step_index: stepIndex,
          phase: "plan",
          model: config.planner_model,
          reasoning: config.planner_reasoning,
          api_start_ts: timestamp,
          api_end_ts: nowIso(),
          model_latency_seconds: plannerResult.latencySeconds,
          tool_latency_seconds: 0,
          cumulative_wall_clock_seconds: (performance.now() - startedAt) / 1000,
          action_type: "replan",
          action_target: currentPlan.objective,
          expected_state: currentPlan.done_criteria.join(" | "),
          observed_state_summary: currentObservation.visible_state_summary,
          confidence: 1,
          escalated: false,
          retry_count_for_subgoal: 0,
          token_usage_in: plannerResult.usageIn,
          token_usage_out: plannerResult.usageOut,
          estimated_cost_usd: plannerResult.costUsd,
          usage_source: plannerResult.usageSource,
          raw_response_artifact_path: replanRawPath,
          screenshot_artifact_path: currentObservation.screenshot_artifact_path ?? null,
          observation_artifact_path: currentObservation.observation_artifact_path ?? null,
          notes: lastEscalationReason ? [lastEscalationReason] : undefined
        };
        steps.push(plannerStep);
        appendStepRecord(stepsPath, plannerStep);
      }

      if (terminationReason === "task_complete" || terminationReason === "done_without_additional_action") break;
    }

    if (stepIndex >= task.max_steps && !terminationReason.startsWith("task_complete") && terminationReason !== "done_without_additional_action") {
      terminationReason = "max_steps_exceeded";
      successLabel = progressEvents.length > 0 ? "partial" : "fail";
    }
    }
  } catch (error) {
    terminationReason = error instanceof Error ? error.message : "unknown_error";
    successLabel = progressEvents.length > 0 ? "partial" : "fail";
  } finally {
    if (environment.cleanup) await environment.cleanup();
  }

  const totalWallClockSeconds = (performance.now() - startedAt) / 1000;
  const runRecord: BenchmarkRunRecord = {
    run_id: runId,
    batch_id: options.batch_id,
    repeat_index: options.repeat_index,
    timestamp,
    task_id: task.task_id,
    config_id: config.id,
    planner_model: config.planner_model,
    planner_reasoning: config.planner_reasoning,
    executor_model: config.executor_model,
    executor_reasoning: config.executor_reasoning,
    total_wall_clock_seconds: totalWallClockSeconds,
    total_model_latency_seconds: totalModelLatencySeconds,
    total_tool_latency_seconds: totalToolLatencySeconds,
    total_steps: steps.length,
    total_planner_calls: totalPlannerCalls,
    total_executor_calls: totalExecutorCalls,
    total_escalations: totalEscalations,
    success_label: successLabel,
    manual_grade_required: task.requires_manual_grade,
    manual_grade_value: null,
    manual_grade_notes: "",
    estimated_input_tokens: estimatedInputTokens,
    estimated_output_tokens: estimatedOutputTokens,
    estimated_total_cost_usd: estimatedTotalCostUsd,
    termination_reason: terminationReason,
    usage_source: usageSource,
    run_status: "completed",
    artifact_dir: runDir,
    steps_artifact_path: stepsPath,
    summary_artifact_path: summaryPath,
    observed_outcome_summary: environment.getObservedOutcomeSummary(),
    expected_outcome_summary: summarizeExpectedOutcome(task),
    time_to_first_meaningful_action_seconds: timeToFirstMeaningfulActionSeconds,
    time_spent_in_replanning_seconds: timeSpentInReplanningSeconds,
    time_lost_to_retries_seconds: timeLostToRetriesSeconds,
    average_latency_per_model_call_seconds: totalPlannerCalls + totalExecutorCalls > 0 ? totalModelLatencySeconds / (totalPlannerCalls + totalExecutorCalls) : 0,
    average_latency_per_executor_step_seconds: totalExecutorCalls > 0 ? totalWallClockSeconds / totalExecutorCalls : 0,
    steps_per_minute: totalWallClockSeconds > 0 ? (steps.length * 60) / totalWallClockSeconds : 0,
    successful_tasks_per_hour_equivalent: totalWallClockSeconds > 0 && successLabel === "success" ? 3600 / totalWallClockSeconds : 0
  };

  writeJsonFile(runJsonPath, runRecord);
  writeRunSummaryMarkdown(runRecord, steps);
  return runRecord;
}

function writeBatchManifest(filePath: string, manifest: BenchmarkBatchManifest): void {
  writeJsonFile(filePath, manifest);
}

export async function runBenchmarkBatch(options: RunBatchOptions): Promise<{
  batch_manifest_path: string;
  report_path: string;
  grading_sheet_path: string;
  runs: BenchmarkRunRecord[];
}> {
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const batchId = options.batch_id || buildBatchId();
  const batchDir = ensureDir(path.join(resolveArtifactsRoot(options.artifacts_root), batchId));
  const batchManifestPath = path.join(batchDir, "batch.json");
  const modelClient = options.model_client || new OpenAiResponsesBenchmarkClient();
  const manifest: BenchmarkBatchManifest = {
    batch_id: batchId,
    started_at: nowIso(),
    artifacts_dir: batchDir,
    config_ids: options.config_ids,
    task_ids: options.task_ids,
    repeat_count: options.repeat_count,
    runs_planned: options.config_ids.length * options.task_ids.length * options.repeat_count,
    runs_completed: 0,
    runs_skipped: 0,
    run_ids: []
  };
  writeBatchManifest(batchManifestPath, manifest);

  const runsJsonlPath = path.join(batchDir, "runs.jsonl");
  const completedRuns: BenchmarkRunRecord[] = [];
  for (const configId of options.config_ids) {
    const config = getConfigById(bundle, configId);
    for (const taskId of options.task_ids) {
      const task = getTaskById(taskId, tasks);
      for (let repeatIndex = 1; repeatIndex <= options.repeat_count; repeatIndex++) {
        const run = await runSingleBenchmark(
          task,
          config,
          {
            batch_id: batchId,
            batch_dir: batchDir,
            repeat_index: repeatIndex,
            resume: options.resume
          },
          modelClient
        );
        completedRuns.push(run);
        appendJsonl(runsJsonlPath, run);
        manifest.runs_completed += 1;
        manifest.run_ids.push(run.run_id);
        writeBatchManifest(batchManifestPath, manifest);
      }
    }
  }

  manifest.completed_at = nowIso();
  writeBatchManifest(batchManifestPath, manifest);
  const reportArtifacts = writeBenchmarkReportArtifacts(batchDir, bundle);
  const gradingSheetPath = exportManualGradingSheet(batchDir);
  return {
    batch_manifest_path: batchManifestPath,
    report_path: reportArtifacts.markdown_path,
    grading_sheet_path: gradingSheetPath,
    runs: completedRuns
  };
}

export async function runDefaultExperimentPlan(args: {
  artifacts_root?: string;
  batch_id?: string;
  include_broader_phase?: boolean;
  resume?: boolean;
  model_client?: BenchmarkModelClient;
}): Promise<{ phase1_batch: Awaited<ReturnType<typeof runBenchmarkBatch>>; phase2_batch?: Awaited<ReturnType<typeof runBenchmarkBatch>> }> {
  const bundle: BenchmarkConfigBundle = loadBenchmarkConfigBundle();
  const phase1Batch = await runBenchmarkBatch({
    batch_id: args.batch_id ? `${args.batch_id}_phase1` : undefined,
    artifacts_root: args.artifacts_root,
    task_ids: bundle.default_phase1_task_ids,
    config_ids: bundle.phase1_config_ids,
    repeat_count: bundle.default_phase1_repeat_count,
    resume: args.resume,
    model_client: args.model_client
  });

  if (!args.include_broader_phase) return { phase1_batch: phase1Batch };

  const phase1ArtifactsDir = path.dirname(phase1Batch.batch_manifest_path);
  const phase1Report = writeBenchmarkReportArtifacts(phase1ArtifactsDir, bundle).report;
  const configC = phase1Report.config_aggregates.find((entry) => entry.config_id === "split_54_medium__54mini_none");
  const phase2ConfigIds =
    configC && configC.fail_rate > bundle.unacceptable_failure_rate_threshold
      ? bundle.broader_config_ids.filter((id) => id !== "split_54_medium__54mini_none")
      : bundle.broader_config_ids;

  const phase2Batch = await runBenchmarkBatch({
    batch_id: args.batch_id ? `${args.batch_id}_phase2` : undefined,
    artifacts_root: args.artifacts_root,
    task_ids: bundle.default_phase1_task_ids,
    config_ids: phase2ConfigIds,
    repeat_count: 1,
    resume: args.resume,
    model_client: args.model_client
  });
  return { phase1_batch: phase1Batch, phase2_batch: phase2Batch };
}
