import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmarkConfigBundle } from "../src/benchmark/config.js";
import { writeJsonFile } from "../src/benchmark/files.js";
import { exportManualGradingSheet } from "../src/benchmark/grading.js";
import { generateBenchmarkReport } from "../src/benchmark/report.js";
import type { BenchmarkRunRecord } from "../src/benchmark/types.js";

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "benchmark-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleRun(overrides: Partial<BenchmarkRunRecord>): BenchmarkRunRecord {
  return {
    run_id: "run-a",
    batch_id: "batch-a",
    repeat_index: 1,
    timestamp: "2026-04-12T00:00:00.000Z",
    task_id: "placeholder_open_settings_panel",
    config_id: "single_54_medium",
    planner_model: "gpt-5.4",
    planner_reasoning: "medium",
    executor_model: "gpt-5.4",
    executor_reasoning: "medium",
    total_wall_clock_seconds: 10,
    total_model_latency_seconds: 7,
    total_tool_latency_seconds: 3,
    total_steps: 4,
    total_planner_calls: 1,
    total_executor_calls: 3,
    total_escalations: 0,
    success_label: "success",
    manual_grade_required: false,
    manual_grade_value: null,
    manual_grade_notes: "",
    estimated_input_tokens: 400,
    estimated_output_tokens: 200,
    estimated_total_cost_usd: 0.02,
    termination_reason: "task_complete",
    usage_source: "api",
    run_status: "completed",
    artifact_dir: "artifacts/dir",
    steps_artifact_path: "artifacts/dir/steps.jsonl",
    summary_artifact_path: "artifacts/dir/summary.md",
    observed_outcome_summary: "done",
    expected_outcome_summary: "done",
    time_to_first_meaningful_action_seconds: 1,
    time_spent_in_replanning_seconds: 0,
    time_lost_to_retries_seconds: 0,
    average_latency_per_model_call_seconds: 2,
    average_latency_per_executor_step_seconds: 3,
    steps_per_minute: 24,
    successful_tasks_per_hour_equivalent: 360,
    ...overrides
  };
}

test("report generation ranks faster configs and grading export writes CSV", () => {
  const dir = tempDir("report");
  const runAPath = path.join(dir, "single_54_medium", "task", "repeat-01", "run.json");
  const runBPath = path.join(dir, "split_54_medium__54mini_low", "task", "repeat-01", "run.json");
  writeJsonFile(runAPath, sampleRun({ run_id: "run-a", config_id: "single_54_medium", total_wall_clock_seconds: 12 }));
  writeJsonFile(runBPath, sampleRun({ run_id: "run-b", config_id: "split_54_medium__54mini_low", total_wall_clock_seconds: 8 }));

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  assert.equal(report.fastest_config_id, "split_54_medium__54mini_low");

  const csvPath = exportManualGradingSheet(dir);
  const csv = fs.readFileSync(csvPath, "utf8");
  assert.match(csv, /run_id,task_id,config_id/);
  assert.match(csv, /split_54_medium__54mini_low/);
});

test("report generation surfaces Revit workflow evidence", () => {
  const dir = tempDir("report-revit-workflow");
  const runDir = path.join(dir, "deterministic_skill_only", "demo_takeoff_receptacles", "repeat-01");
  writeJsonFile(path.join(runDir, "run.json"), sampleRun({
    run_id: "run-revit",
    task_id: "demo_takeoff_receptacles",
    config_id: "deterministic_skill_only",
    artifact_dir: runDir
  }));
  writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
    workflow: "takeoff_csv",
    success: true,
    elapsed_seconds: 2.5,
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [path.join(runDir, "artifacts", "takeoff_summary.csv")],
    verification_results: [
      { name: "raw_total_matches_grouped_total", ok: true },
      { name: "csv_written", ok: true }
    ],
    failure_reason: null
  });

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  assert.equal(report.revit_workflow_summaries.length, 1);
  assert.deepEqual(report.revit_workflow_summaries[0], {
    run_id: "run-revit",
    task_id: "demo_takeoff_receptacles",
    config_id: "deterministic_skill_only",
    workflow: "takeoff_csv",
    execution_source: "unknown",
    success: true,
    elapsed_seconds: 2.5,
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifact_count: 1,
    verification_passed: 2,
    verification_total: 2,
    verification_names_passed: ["raw_total_matches_grouped_total", "csv_written"],
    verification_names_failed: [],
    failure_reason: null
  });
  const takeoffGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_takeoff_receptacles");
  assert.equal(takeoffGate?.passed, false);
  assert.equal(takeoffGate?.live_sample_size, 0);
  assert.equal(takeoffGate?.min_live_sample_size, 5);
  assert.equal(takeoffGate?.target_success_rate, 0.98);
  assert.equal(takeoffGate?.target_elapsed_seconds, 30);
  assert.equal(takeoffGate?.reason, "no live Revit runs");

  const sheetGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_sheet_export");
  assert.equal(sheetGate?.passed, false);
  assert.equal(sheetGate?.reason, "no runs; success 0.0% < target 95.0%; verification 0.0% < 100.0%");
});

test("demo readiness gates require live Revit workflow evidence", () => {
  const dir = tempDir("report-live-readiness");
  const runDir = path.join(dir, "deterministic_skill_only", "demo_takeoff_receptacles", "repeat-01");
  writeJsonFile(path.join(runDir, "run.json"), sampleRun({
    run_id: "run-live-takeoff",
    task_id: "demo_takeoff_receptacles",
    config_id: "deterministic_skill_only",
    artifact_dir: runDir
  }));
  writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
    workflow: "takeoff_csv",
    execution_source: "live",
    success: true,
    elapsed_seconds: 2.5,
    tool_calls: 1,
    revit_transactions: 0,
    computer_use_actions: 0,
    output_artifacts: [path.join(runDir, "artifacts", "takeoff_summary.csv")],
    verification_results: [
      { name: "raw_total_matches_grouped_total", ok: true },
      { name: "csv_written", ok: true }
    ],
    failure_reason: null
  });

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const takeoffGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_takeoff_receptacles");
  assert.equal(takeoffGate?.passed, false);
  assert.equal(takeoffGate?.sample_size, 1);
  assert.equal(takeoffGate?.live_sample_size, 1);
  assert.equal(takeoffGate?.min_live_sample_size, 5);
  assert.equal(takeoffGate?.reason, "live runs 1 < minimum 5");
});

test("demo readiness gates pass after enough live Revit workflow evidence", () => {
  const dir = tempDir("report-live-readiness-minimum");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_takeoff_receptacles", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-takeoff-${repeat}`,
      task_id: "demo_takeoff_receptacles",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "takeoff_csv",
      execution_source: "live",
      success: true,
      elapsed_seconds: 2.5,
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "takeoff_summary.csv")],
      verification_results: [
        { name: "raw_total_matches_grouped_total", ok: true },
        { name: "csv_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const takeoffGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_takeoff_receptacles");
  assert.equal(takeoffGate?.passed, true);
  assert.equal(takeoffGate?.sample_size, 5);
  assert.equal(takeoffGate?.live_sample_size, 5);
  assert.equal(takeoffGate?.min_live_sample_size, 5);
  assert.equal(takeoffGate?.reason, "passed");
});

test("redline demo readiness requires strong live placement evidence", () => {
  const dir = tempDir("report-redline-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_receptacles", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-${repeat}`,
      task_id: "demo_redline_receptacles",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_receptacles",
      execution_source: "live",
      success: true,
      elapsed_seconds: 20,
      tool_calls: 12,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_receptacles_summary.json")],
      verification_results: [
        { name: "created_expected_count", ok: true },
        { name: "audit_passed", ok: true },
        { name: "after_capture_returned", ok: true },
        { name: "redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const redlineGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_receptacles");
  assert.equal(redlineGate?.passed, false);
  assert.match(redlineGate?.reason ?? "", /redline evidence incomplete/);
  assert.match(redlineGate?.reason ?? "", /audit_contains_created_ids/);
  assert.match(redlineGate?.reason ?? "", /created_room_matches_expected/);
  assert.match(redlineGate?.reason ?? "", /created_circuit_matches_expected\|created_circuit_matches_source_when_requested/);
});

test("redline demo readiness passes with strong live room host and circuit evidence", () => {
  const dir = tempDir("report-redline-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_receptacles", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-${repeat}`,
      task_id: "demo_redline_receptacles",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_receptacles",
      execution_source: "live",
      success: true,
      elapsed_seconds: 20,
      tool_calls: 12,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_receptacles_summary.json")],
      verification_results: [
        { name: "created_expected_count", ok: true },
        { name: "audit_passed", ok: true },
        { name: "audit_contains_created_ids", ok: true },
        { name: "audit_host_evidence_ok", ok: true },
        { name: "created_room_matches_expected", ok: true },
        { name: "created_circuit_matches_source_when_requested", ok: true },
        { name: "after_capture_returned", ok: true },
        { name: "after_visible_count_increased", ok: true },
        { name: "cleanup_completed_when_requested", ok: true },
        { name: "redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const redlineGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_receptacles");
  assert.equal(redlineGate?.passed, true);
  assert.equal(redlineGate?.reason, "passed");
});
