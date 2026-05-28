import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ensureDir, writeJsonFile } from "./files.js";
import { runRevitDemoWorkflow } from "./revit_workflows.js";
import type {
  BenchmarkAction,
  BenchmarkActionResult,
  BenchmarkEnvironmentAdapter,
  BenchmarkEnvironmentRunContext,
  BenchmarkEnvironmentSession,
  BenchmarkObservation,
  BenchmarkTaskDefinition
} from "./types.js";

type ScriptedStepDefinition = {
  accepted_action_types: string[];
  target_contains?: string[];
  resulting_state_summary: string;
  action_result_summary: string;
  ambiguous?: boolean;
  material_deviation?: boolean;
  high_impact?: boolean;
  irreversible?: boolean;
};

type ScriptedAdapterConfig = {
  initial_state_summary: string;
  completion_state_summary?: string;
  mismatch_state_summary?: string;
  steps: ScriptedStepDefinition[];
};

function normalizeScriptedConfig(task: BenchmarkTaskDefinition): ScriptedAdapterConfig {
  const raw = task.adapter_config && typeof task.adapter_config === "object" ? task.adapter_config : {};
  const source = raw as Record<string, unknown>;
  const steps: ScriptedStepDefinition[] = [];
  if (Array.isArray(source.steps)) {
    for (const entry of source.steps as unknown[]) {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const resultingStateSummary = String(row.resulting_state_summary ?? "").trim();
      const actionResultSummary = String(row.action_result_summary ?? "").trim();
      if (!resultingStateSummary || !actionResultSummary) continue;
      steps.push({
        accepted_action_types: Array.isArray(row.accepted_action_types)
          ? row.accepted_action_types.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
          : [],
        target_contains: Array.isArray(row.target_contains)
          ? row.target_contains.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
          : undefined,
        resulting_state_summary: resultingStateSummary,
        action_result_summary: actionResultSummary,
        ambiguous: Boolean(row.ambiguous),
        material_deviation: Boolean(row.material_deviation),
        high_impact: Boolean(row.high_impact),
        irreversible: Boolean(row.irreversible)
      });
    }
  }

  return {
    initial_state_summary: String(source.initial_state_summary ?? "Application home screen is visible.").trim(),
    completion_state_summary: String(source.completion_state_summary ?? "Task goal is visibly complete.").trim(),
    mismatch_state_summary: String(
      source.mismatch_state_summary ??
        "The UI did not change as expected because the action did not match the scripted step."
    ).trim(),
    steps
  };
}

class ScriptedDemoSession implements BenchmarkEnvironmentSession {
  private currentState: string;
  private nextStepIndex = 0;
  private readonly observationsDir: string;
  private readonly config: ScriptedAdapterConfig;

  constructor(task: BenchmarkTaskDefinition, runContext: BenchmarkEnvironmentRunContext) {
    this.config = normalizeScriptedConfig(task);
    this.currentState = this.config.initial_state_summary;
    this.observationsDir = ensureDir(runContext.observations_dir);
  }

  private writeObservation(label: string, summary: string): string {
    const filePath = path.join(
      this.observationsDir,
      `${String(this.nextStepIndex).padStart(2, "0")}_${label}.json`
    );
    writeJsonFile(filePath, { visible_state_summary: summary });
    return filePath;
  }

  async getInitialObservation(): Promise<BenchmarkObservation> {
    return {
      visible_state_summary: this.currentState,
      observation_artifact_path: this.writeObservation("initial", this.currentState),
      screenshot_artifact_path: null
    };
  }

  isTaskComplete(): boolean {
    return this.nextStepIndex >= this.config.steps.length;
  }

  getObservedOutcomeSummary(): string {
    return this.isTaskComplete() ? this.config.completion_state_summary ?? this.currentState : this.currentState;
  }

  async executeAction(action: BenchmarkAction): Promise<BenchmarkActionResult> {
    const startedAt = performance.now();
    const expected = this.config.steps[this.nextStepIndex];
    if (!expected) {
      const observationPath = this.writeObservation("extra", this.getObservedOutcomeSummary());
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.getObservedOutcomeSummary(),
          observation_artifact_path: observationPath,
          screenshot_artifact_path: null
        },
        action_result_summary: "No scripted steps remained; the action was ignored.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const actionType = action.action_type.trim().toLowerCase();
    const target = action.target.trim().toLowerCase();
    const typeMatches =
      expected.accepted_action_types.length === 0 || expected.accepted_action_types.includes(actionType);
    const targetMatches =
      !expected.target_contains ||
      expected.target_contains.length === 0 ||
      expected.target_contains.some((needle) => target.includes(needle));

    if (typeMatches && targetMatches) {
      this.currentState = expected.resulting_state_summary;
      const observationPath = this.writeObservation(`step_${this.nextStepIndex + 1}`, this.currentState);
      this.nextStepIndex += 1;
      return {
        success: true,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.currentState,
          ambiguous: expected.ambiguous,
          observation_artifact_path: observationPath,
          screenshot_artifact_path: null
        },
        action_result_summary: expected.action_result_summary,
        material_deviation: Boolean(expected.material_deviation),
        high_impact: Boolean(expected.high_impact || action.high_impact),
        irreversible: Boolean(expected.irreversible)
      };
    }

    const mismatchSummary = this.config.mismatch_state_summary ?? this.currentState;
    const observationPath = this.writeObservation(`mismatch_${this.nextStepIndex + 1}`, mismatchSummary);
    return {
      success: false,
      tool_latency_seconds: (performance.now() - startedAt) / 1000,
      observation: {
        visible_state_summary: mismatchSummary,
        observation_artifact_path: observationPath,
        screenshot_artifact_path: null
      },
      action_result_summary: "The action did not match the scripted expectation for the current state.",
      material_deviation: true,
      high_impact: Boolean(action.high_impact),
      irreversible: false
    };
  }
}

class ScriptedDemoAdapter implements BenchmarkEnvironmentAdapter {
  readonly id = "scripted_demo";

  async createSession(
    task: BenchmarkTaskDefinition,
    runContext: BenchmarkEnvironmentRunContext
  ): Promise<BenchmarkEnvironmentSession> {
    return new ScriptedDemoSession(task, runContext);
  }
}

type RevitWorkflowAdapterConfig = {
  initial_state_summary?: string;
};

type JsonMap = Record<string, unknown>;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonMap) } : {};
}

function loadRevitWorkflowOverride(taskId: string): JsonMap {
  const filePath = (process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON || "").trim();
  if (!filePath) return {};
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Revit benchmark request override file not found: ${fullPath}`);
  const root = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  const rootObj = asObject(root);
  const tasksObj = asObject(rootObj.tasks);
  return asObject(tasksObj[taskId] ?? rootObj[taskId]);
}

function mergeWorkflowConfig(base: unknown, override: JsonMap): JsonMap {
  const baseObj = asObject(base);
  if (Object.keys(override).length === 0) return baseObj;
  return {
    ...baseObj,
    ...override,
    request: {
      ...asObject(baseObj.request),
      ...asObject(override.request)
    }
  };
}

class RevitWorkflowSession implements BenchmarkEnvironmentSession {
  private readonly task: BenchmarkTaskDefinition;
  private readonly runContext: BenchmarkEnvironmentRunContext;
  private readonly observationsDir: string;
  private currentState: string;
  private complete = false;
  private outcome = "Workflow has not run.";

  constructor(task: BenchmarkTaskDefinition, runContext: BenchmarkEnvironmentRunContext) {
    this.task = task;
    this.runContext = runContext;
    this.observationsDir = ensureDir(runContext.observations_dir);
    const config = (task.adapter_config && typeof task.adapter_config === "object" ? task.adapter_config : {}) as RevitWorkflowAdapterConfig;
    this.currentState = config.initial_state_summary || `Ready to run deterministic Revit workflow '${task.task_id}'.`;
  }

  private writeObservation(label: string, value: unknown): string {
    const filePath = path.join(this.observationsDir, `${label}.json`);
    writeJsonFile(filePath, value);
    return filePath;
  }

  async getInitialObservation(): Promise<BenchmarkObservation> {
    return {
      visible_state_summary: this.currentState,
      observation_artifact_path: this.writeObservation("initial", { visible_state_summary: this.currentState }),
      screenshot_artifact_path: null
    };
  }

  isTaskComplete(): boolean {
    return this.complete;
  }

  getObservedOutcomeSummary(): string {
    return this.outcome;
  }

  async executeAction(action: BenchmarkAction): Promise<BenchmarkActionResult> {
    const startedAt = performance.now();
    if (this.complete) {
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.outcome,
          observation_artifact_path: this.writeObservation("already_complete", { visible_state_summary: this.outcome }),
          screenshot_artifact_path: null
        },
        action_result_summary: "Workflow already completed.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const actionType = action.action_type.trim().toLowerCase();
    if (actionType && actionType !== "run_workflow" && actionType !== "run deterministic workflow") {
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.currentState,
          observation_artifact_path: this.writeObservation("ignored_action", { action, visible_state_summary: this.currentState }),
          screenshot_artifact_path: null
        },
        action_result_summary: "Revit workflow adapter only accepts run_workflow actions.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const workflowConfig = mergeWorkflowConfig(this.task.adapter_config, loadRevitWorkflowOverride(this.task.task_id));
    if (workflowConfig.timeout_ms === undefined) {
      workflowConfig.timeout_ms = Math.max(2_000, this.task.max_time_seconds * 1_000);
    }
    const result = await runRevitDemoWorkflow(workflowConfig, this.runContext.run_dir);
    this.complete = result.success;
    this.outcome = result.user_message;
    this.currentState = result.success ? `Verified: ${result.user_message}` : `Failed: ${result.failure_reason || result.user_message}`;
    const observationPath = this.writeObservation("workflow_result", result);
    return {
      success: result.success,
      tool_latency_seconds: (performance.now() - startedAt) / 1000,
      observation: {
        visible_state_summary: this.currentState,
        observation_artifact_path: observationPath,
        screenshot_artifact_path: null
      },
      action_result_summary: result.failure_reason || result.user_message,
      material_deviation: !result.success,
      high_impact: Boolean(action.high_impact),
      irreversible: false
    };
  }
}

class RevitWorkflowAdapter implements BenchmarkEnvironmentAdapter {
  readonly id = "revit_workflow";

  async createSession(
    task: BenchmarkTaskDefinition,
    runContext: BenchmarkEnvironmentRunContext
  ): Promise<BenchmarkEnvironmentSession> {
    return new RevitWorkflowSession(task, runContext);
  }
}

const registry = new Map<string, BenchmarkEnvironmentAdapter>([
  ["scripted_demo", new ScriptedDemoAdapter()],
  ["revit_workflow", new RevitWorkflowAdapter()]
]);

export function getEnvironmentAdapter(adapterId: string): BenchmarkEnvironmentAdapter {
  const adapter = registry.get(adapterId);
  if (!adapter) throw new Error(`Unknown benchmark environment adapter '${adapterId}'.`);
  return adapter;
}
