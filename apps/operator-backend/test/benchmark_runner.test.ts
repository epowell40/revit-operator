import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getConfigById, loadBenchmarkConfigBundle } from "../src/benchmark/config.js";
import { runSingleBenchmark } from "../src/benchmark/runner.js";
import { getTaskById, loadBenchmarkTasks } from "../src/benchmark/tasks.js";
import type { BenchmarkModelClient, BenchmarkModelRequest, BenchmarkModelResponse } from "../src/benchmark/types.js";

class FakeModelClient implements BenchmarkModelClient {
  private readonly responses: string[];
  private index = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async createResponse(request: BenchmarkModelRequest): Promise<BenchmarkModelResponse> {
    const output = this.responses[this.index++];
    assert.ok(output, `No fake response available for ${request.model}`);
    return {
      model: request.model,
      output_text: output,
      raw_response: {
        id: `fake-${this.index}`,
        output_text: output,
        usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180 }
      },
      usage: {
        input_tokens: 120,
        output_tokens: 60,
        total_tokens: 180,
        source: "api"
      },
      response_id: `fake-${this.index}`
    };
  }
}

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "benchmark-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("split planner/executor benchmark run writes artifacts and aggregates metrics", async () => {
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "split_54_medium__54mini_low");
  const task = getTaskById("placeholder_open_settings_panel", tasks);
  const fakeClient = new FakeModelClient([
    JSON.stringify({
      objective: task.description,
      preconditions: task.setup_instructions,
      ordered_subgoals: [
        { id: "open_profile", title: "Open the profile menu", success_signal: "profile menu is open" },
        { id: "open_settings", title: "Open settings", success_signal: "settings panel is open" },
        { id: "open_notifications", title: "Open notifications", success_signal: "notifications are visible" }
      ],
      expected_visible_state_changes: task.success_criteria,
      escalation_rules: task.failure_criteria,
      done_criteria: task.success_criteria
    }),
    JSON.stringify({
      current_subgoal: "Open the profile menu",
      current_subgoal_id: "open_profile",
      chosen_action: "click",
      target: "profile",
      brief_reason: "Need the menu to reach settings.",
      expected_result: "Profile menu opens.",
      expected_state: "The profile menu is open.",
      confidence: 0.9,
      recommend_escalation: false,
      done: false,
      subgoal_completed: true
    }),
    JSON.stringify({
      current_subgoal: "Open settings",
      current_subgoal_id: "open_settings",
      chosen_action: "click",
      target: "settings",
      brief_reason: "Next planned destination.",
      expected_result: "Settings panel opens.",
      expected_state: "The settings panel is open.",
      confidence: 0.88,
      recommend_escalation: false,
      done: false,
      subgoal_completed: true
    }),
    JSON.stringify({
      current_subgoal: "Open notifications",
      current_subgoal_id: "open_notifications",
      chosen_action: "click",
      target: "notifications",
      brief_reason: "Need the target section visible.",
      expected_result: "Notifications settings are visible.",
      expected_state: "Notifications settings are visible.",
      confidence: 0.92,
      recommend_escalation: false,
      done: true,
      subgoal_completed: true
    })
  ]);

  const batchDir = tempDir("runner");
  const run = await runSingleBenchmark(
    task,
    config,
    {
      batch_id: "test_batch",
      batch_dir: batchDir,
      repeat_index: 1
    },
    fakeClient
  );

  assert.equal(run.success_label, "success");
  assert.equal(run.total_planner_calls, 1);
  assert.equal(run.total_executor_calls, 3);
  assert.equal(run.total_escalations, 0);
  assert.ok(fs.existsSync(run.steps_artifact_path));
  assert.ok(fs.existsSync(run.summary_artifact_path));
});

test("deterministic Revit workflow benchmark run uses no model calls", async () => {
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_receptacles", tasks);
  const fakeClient = new FakeModelClient([]);

  const batchDir = tempDir("deterministic-revit-workflow");
  const run = await runSingleBenchmark(
    task,
    config,
    {
      batch_id: "test_batch",
      batch_dir: batchDir,
      repeat_index: 1
    },
    fakeClient
  );

  assert.equal(run.success_label, "success");
  assert.equal(run.total_planner_calls, 0);
  assert.equal(run.total_executor_calls, 0);
  assert.equal(run.estimated_total_cost_usd, 0);
  assert.ok(fs.existsSync(path.join(run.artifact_dir, "revit_workflow_result.json")));
});

test("deterministic Revit workflow run can use local request overrides", async () => {
  const original = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_receptacles", tasks);
  const batchDir = tempDir("deterministic-revit-overrides");
  const overridePath = path.join(batchDir, "overrides.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      tasks: {
        demo_takeoff_receptacles: {
          request: { filters: { keywords_include: ["override"] } },
          mock: {
            "/revit/quantify": {
              summary: { total: 1, groups: { "Override Group": 1 } },
              rows: [{ id: 9001, type: "Override" }]
            }
          }
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "success");
    assert.match(run.observed_outcome_summary, /Counted 1 element/);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = original;
  }
});
