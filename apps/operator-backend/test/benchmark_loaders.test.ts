import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmarkConfigBundle } from "../src/benchmark/config.js";
import { loadBenchmarkTasks } from "../src/benchmark/tasks.js";

test("benchmark config bundle exposes the expected default configs", () => {
  const bundle = loadBenchmarkConfigBundle();
  const configIds = bundle.configs.map((config) => config.id);
  assert.equal(bundle.baseline_config_id, "single_55_medium");
  assert.deepEqual(bundle.phase1_config_ids, [
    "single_55_medium",
    "split_55_high__55_low",
    "split_55_medium__55_instant",
    "split_55_medium__54mini_low",
    "deterministic_skill_only"
  ]);
  assert.ok(configIds.includes("deterministic_skill_only"));
  assert.ok(configIds.includes("single_54mini_none"));
});

test("benchmark task loader discovers demo Revit workflow tasks", () => {
  const tasks = loadBenchmarkTasks();
  const taskIds = tasks.map((task) => task.task_id);
  assert.ok(taskIds.includes("demo_sheet_export"));
  assert.ok(taskIds.includes("demo_takeoff_receptacles"));
  assert.ok(taskIds.includes("demo_parameter_edit"));
  assert.ok(taskIds.includes("demo_redline_receptacles"));
  for (const id of ["demo_sheet_export", "demo_takeoff_receptacles", "demo_parameter_edit", "demo_redline_receptacles"]) {
    assert.equal(tasks.find((task) => task.task_id === id)?.environment.adapter_id, "revit_workflow");
  }
});
