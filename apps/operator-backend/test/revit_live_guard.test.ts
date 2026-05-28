import test from "node:test";
import assert from "node:assert/strict";
import { selectedTasksNeedLiveRevitPreflight } from "../src/benchmark/revit_live_guard.js";
import type { BenchmarkTaskDefinition } from "../src/benchmark/types.js";

function task(taskId: string, adapterId: string, adapterConfig: Record<string, unknown> = {}): BenchmarkTaskDefinition {
  return {
    schema_version: 1,
    task_id: taskId,
    name: taskId,
    description: taskId,
    environment: { adapter_id: adapterId },
    setup_instructions: [],
    success_criteria: [],
    failure_criteria: [],
    max_time_seconds: 30,
    max_steps: 1,
    requires_manual_grade: false,
    grader_notes: [],
    tags: [],
    optional_cleanup_steps: [],
    adapter_config: adapterConfig
  };
}

test("live Revit guard skips mocked Revit workflow tasks by default", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow", { mock: { "/revit/quantify": {} } })]
    }),
    false
  );
});

test("live Revit guard runs when mocks are explicitly disabled", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow", { mock: { "/revit/quantify": {} } })],
      useMocksEnv: "0"
    }),
    true
  );
});

test("live Revit guard runs for Revit workflow tasks without mocks", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow")]
    }),
    true
  );
});

test("live Revit guard ignores non-Revit workflow tasks", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["scripted"],
      allTasks: [task("scripted", "scripted_demo")],
      useMocksEnv: "0"
    }),
    false
  );
});
