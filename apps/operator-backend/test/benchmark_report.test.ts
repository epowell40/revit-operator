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

test("demo readiness gates use live-only success when mock passes mask a live blocker", () => {
  const dir = tempDir("report-live-readiness-mock-mask");
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
      success: index < 5,
      elapsed_seconds: 2.5,
      tool_calls: 1,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: index < 5 ? [path.join(runDir, "artifacts", "takeoff_summary.csv")] : [],
      verification_results: index < 5
        ? [
            { name: "raw_total_matches_grouped_total", ok: true },
            { name: "csv_written", ok: true }
          ]
        : [],
      failure_classification: index < 5 ? undefined : "revit_host_crash",
      failure_reason: index < 5 ? null : "Revit host crashed before bridge readiness."
    });
  }
  for (let index = 1; index <= 20; index += 1) {
    const runDir = path.join(dir, "mock_config", "demo_takeoff_receptacles", `repeat-${String(index).padStart(2, "0")}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-mock-takeoff-${index}`,
      task_id: "demo_takeoff_receptacles",
      config_id: "mock_config",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "takeoff_csv",
      execution_source: "mock",
      success: true,
      elapsed_seconds: 0.1,
      tool_calls: 0,
      revit_transactions: 0,
      computer_use_actions: 0,
      output_artifacts: [],
      verification_results: [{ name: "mock_ok", ok: true }],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const takeoffGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_takeoff_receptacles");
  assert.equal(takeoffGate?.passed, false);
  assert.equal(takeoffGate?.sample_size, 25);
  assert.equal(takeoffGate?.live_sample_size, 5);
  assert.match(takeoffGate?.reason ?? "", /success 80\.0% < target 98\.0%/);
});

test("parameter edit demo readiness requires live revert evidence", () => {
  const dir = tempDir("report-parameter-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_parameter_edit", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-parameter-${repeat}`,
      task_id: "demo_parameter_edit",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "parameter_edit",
      execution_source: "live",
      success: true,
      elapsed_seconds: 4,
      tool_calls: 4,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "parameter_change_summary.md")],
      verification_results: [
        { name: "target_count", ok: true },
        { name: "dry_run_returned_diffs", ok: true },
        { name: "dry_run_all_changes_ok", ok: true },
        { name: "apply_all_changes_ok", ok: true },
        { name: "apply_changed_or_confirmed", ok: true },
        { name: "old_values_captured", ok: true },
        { name: "readback_matches_requested_value", ok: true },
        { name: "parameter_change_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_parameter_edit");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /parameter edit evidence incomplete/);
  assert.match(gate?.reason ?? "", /target_count_matches_request/);
  assert.match(gate?.reason ?? "", /revert_dry_run_all_changes_ok/);
  assert.match(gate?.reason ?? "", /revert_apply_all_changes_ok/);
  assert.match(gate?.reason ?? "", /revert_readback_matches_original_value/);
});

test("MEP accessory parameter text edit readiness requires identity and visual evidence", () => {
  const dir = tempDir("report-accessory-parameter-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_text_edit_mep_accessory", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-accessory-parameter-${repeat}`,
      task_id: "demo_redline_text_edit_mep_accessory",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "parameter_edit",
      execution_source: "live",
      success: true,
      elapsed_seconds: 5,
      tool_calls: 7,
      revit_transactions: 4,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "parameter_change_summary.md")],
      verification_results: [
        { name: "target_count", ok: true },
        { name: "target_count_matches_request", ok: true },
        { name: "dry_run_returned_diffs", ok: true },
        { name: "dry_run_all_changes_ok", ok: true },
        { name: "apply_all_changes_ok", ok: true },
        { name: "apply_changed_or_confirmed", ok: true },
        { name: "old_values_captured", ok: true },
        { name: "readback_matches_requested_value", ok: true },
        { name: "revert_dry_run_all_changes_ok", ok: true },
        { name: "revert_apply_all_changes_ok", ok: true },
        { name: "revert_readback_matches_original_value", ok: true },
        { name: "parameter_change_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_text_edit_mep_accessory");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /parameter edit evidence incomplete/);
  assert.match(gate?.reason ?? "", /parameter_target_identity_matches_request/);
  assert.match(gate?.reason ?? "", /parameter_post_change_capture_returned/);
  assert.match(gate?.reason ?? "", /parameter_post_change_capture_view_id_matches_request/);
  assert.match(gate?.reason ?? "", /parameter_post_change_capture_quality_ok/);
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
  assert.match(redlineGate?.reason ?? "", /create_similar_dry_run_placement_evidence/);
  assert.match(redlineGate?.reason ?? "", /audit_contains_created_ids/);
  assert.match(redlineGate?.reason ?? "", /created_room_matches_expected/);
  assert.match(redlineGate?.reason ?? "", /cleanup_deleted_ids_present/);
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
        { name: "create_similar_dry_run_placement_evidence", ok: true },
        { name: "created_expected_count", ok: true },
        { name: "audit_passed", ok: true },
        { name: "audit_contains_created_ids", ok: true },
        { name: "audit_host_evidence_ok", ok: true },
        { name: "created_room_matches_expected", ok: true },
        { name: "created_circuit_matches_source_when_requested", ok: true },
        { name: "after_capture_returned", ok: true },
        { name: "after_visible_count_increased", ok: true },
        { name: "cleanup_completed_when_requested", ok: true },
        { name: "cleanup_dry_run_ok", ok: true },
        { name: "cleanup_deleted_ids_present", ok: true },
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

test("delete-like redline demo readiness requires dry-run apply absence and visual evidence", () => {
  const dir = tempDir("report-redline-delete-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_delete_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-delete-${repeat}`,
      task_id: "demo_redline_delete_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_delete",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_delete_summary.json")],
      verification_results: [
        { name: "delete_redline_created_text_note_id_present", ok: true },
        { name: "delete_redline_target_visible_before", ok: true },
        { name: "delete_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_delete_text");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline delete evidence incomplete/);
  assert.match(gate?.reason ?? "", /delete_redline_dry_run_ok/);
  assert.match(gate?.reason ?? "", /delete_redline_applied_ids_present/);
  assert.match(gate?.reason ?? "", /delete_redline_target_absent_after/);
  assert.match(gate?.reason ?? "", /delete_redline_visual_gate_passed/);
});

test("add tag redline demo readiness requires visible tag and cleanup evidence", () => {
  const dir = tempDir("report-redline-add-tag-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_add_tag", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-add-tag-${repeat}`,
      task_id: "demo_redline_add_tag",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_add",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 4,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_add_summary.json")],
      verification_results: [
        { name: "add_redline_created_tag_id_present", ok: true },
        { name: "add_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_add_tag");
  assert.equal(gate?.workflow, "redline_add");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /add_redline_tag_apply_matches_request/);
  assert.match(gate?.reason ?? "", /add_redline_tag_readback_matches_request/);
  assert.match(gate?.reason ?? "", /add_redline_target_visible_after/);
  assert.match(gate?.reason ?? "", /add_redline_cleanup_dry_run_ok/);
  assert.match(gate?.reason ?? "", /add_redline_cleanup_applied_ids_present/);
});

test("add family instance redline demo readiness requires type visibility and cleanup evidence", () => {
  const dir = tempDir("report-redline-add-family-instance-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_add_family_instance", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-add-family-instance-${repeat}`,
      task_id: "demo_redline_add_family_instance",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_add",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 4,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_add_summary.json")],
      verification_results: [
        { name: "add_redline_created_family_instance_id_present", ok: true },
        { name: "add_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_add_family_instance");
  assert.equal(gate?.workflow, "redline_add");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline add evidence incomplete/);
  assert.match(gate?.reason ?? "", /add_redline_family_instance_type_matches_request/);
  assert.match(gate?.reason ?? "", /add_redline_target_visible_after/);
  assert.match(gate?.reason ?? "", /add_redline_visual_gate_passed/);
  assert.match(gate?.reason ?? "", /add_redline_cleanup_dry_run_ok/);
  assert.match(gate?.reason ?? "", /add_redline_cleanup_applied_ids_present/);
});

test("add MEP accessory redline demo readiness requires modeled accessory evidence", () => {
  const dir = tempDir("report-redline-add-mep-accessory-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_add_mep_accessory", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-add-mep-accessory-${repeat}`,
      task_id: "demo_redline_add_mep_accessory",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_add",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 4,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_add_summary.json")],
      verification_results: [
        { name: "add_redline_created_tag_id_present", ok: true },
        { name: "add_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_add_mep_accessory");
  assert.equal(gate?.workflow, "redline_add");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline add evidence incomplete/);
  assert.match(gate?.reason ?? "", /add_redline_created_family_instance_id_present/);
  assert.match(gate?.reason ?? "", /add_redline_family_instance_type_matches_request/);
});

test("receptacle and light redline readiness require modeled family-instance evidence", () => {
  const cases = [
    {
      taskId: "demo_redline_add_receptacle",
      workflow: "redline_add",
      weakVerificationName: "add_redline_created_tag_id_present",
      expectedMissing: "add_redline_created_family_instance_id_present"
    },
    {
      taskId: "demo_redline_add_light",
      workflow: "redline_add",
      weakVerificationName: "add_redline_created_tag_id_present",
      expectedMissing: "add_redline_family_instance_type_matches_request"
    },
    {
      taskId: "demo_redline_delete_receptacle",
      workflow: "redline_delete",
      weakVerificationName: "delete_redline_created_tag_id_present",
      expectedMissing: "delete_redline_created_family_instance_id_present"
    },
    {
      taskId: "demo_redline_delete_light",
      workflow: "redline_delete",
      weakVerificationName: "delete_redline_created_text_note_id_present",
      expectedMissing: "delete_redline_family_instance_type_matches_request"
    },
    {
      taskId: "demo_redline_move_receptacle",
      workflow: "redline_move",
      weakVerificationName: "move_redline_created_tag_id_present",
      expectedMissing: "move_redline_created_family_instance_id_present"
    },
    {
      taskId: "demo_redline_move_light",
      workflow: "redline_move",
      weakVerificationName: "move_redline_created_text_note_id_present",
      expectedMissing: "move_redline_family_instance_type_matches_request"
    }
  ];
  const dir = tempDir("report-redline-receptacle-light-weak-evidence");
  for (const scenario of cases) {
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", scenario.taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${scenario.taskId}-${repeat}`,
        task_id: scenario.taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: scenario.workflow,
        execution_source: "live",
        success: true,
        elapsed_seconds: 10,
        tool_calls: 5,
        revit_transactions: 2,
        computer_use_actions: 0,
        output_artifacts: [path.join(runDir, "artifacts", `${scenario.workflow}_summary.json`)],
        verification_results: [
          { name: scenario.weakVerificationName, ok: true },
          { name: `${scenario.workflow}_summary_written`, ok: true }
        ],
        failure_reason: null
      });
    }
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  for (const scenario of cases) {
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === scenario.taskId);
    assert.equal(gate?.workflow, scenario.workflow);
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", new RegExp(scenario.expectedMissing));
  }
});

test("duct and pipe route mutation readiness requires modeled route evidence", () => {
  const cases = [
    {
      taskId: "demo_redline_delete_duct_route",
      workflow: "redline_delete",
      weakVerificationName: "delete_redline_created_text_note_id_present",
      expectedMissing: "delete_redline_created_mep_route_ids_present"
    },
    {
      taskId: "demo_redline_delete_pipe_route",
      workflow: "redline_delete",
      weakVerificationName: "delete_redline_created_family_instance_id_present",
      expectedMissing: "delete_redline_mep_route_kind_matches_request"
    },
    {
      taskId: "demo_redline_move_duct_route",
      workflow: "redline_move",
      weakVerificationName: "move_redline_created_text_note_id_present",
      expectedMissing: "move_redline_created_mep_route_ids_present"
    },
    {
      taskId: "demo_redline_move_pipe_route",
      workflow: "redline_move",
      weakVerificationName: "move_redline_created_family_instance_id_present",
      expectedMissing: "move_redline_mep_route_kind_matches_request"
    }
  ];
  const dir = tempDir("report-redline-duct-pipe-route-weak-evidence");
  for (const scenario of cases) {
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", scenario.taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${scenario.taskId}-${repeat}`,
        task_id: scenario.taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: scenario.workflow,
        execution_source: "live",
        success: true,
        elapsed_seconds: 10,
        tool_calls: 5,
        revit_transactions: 2,
        computer_use_actions: 0,
        output_artifacts: [path.join(runDir, "artifacts", `${scenario.workflow}_summary.json`)],
        verification_results: [
          { name: scenario.weakVerificationName, ok: true },
          { name: `${scenario.workflow}_summary_written`, ok: true }
        ],
        failure_reason: null
      });
    }
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  for (const scenario of cases) {
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === scenario.taskId);
    assert.equal(gate?.workflow, scenario.workflow);
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", new RegExp(scenario.expectedMissing));
  }
});

test("delete-like redline demo readiness passes with strong live delete evidence", () => {
  const dir = tempDir("report-redline-delete-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_delete_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-delete-${repeat}`,
      task_id: "demo_redline_delete_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_delete",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_delete_summary.json"),
        path.join(runDir, "artifacts", "redline_delete_visual_gate.json")
      ],
      verification_results: [
        { name: "delete_redline_created_text_note_id_present", ok: true },
        { name: "delete_redline_target_visible_before", ok: true },
        { name: "delete_redline_dry_run_ok", ok: true },
        { name: "delete_redline_applied_ids_present", ok: true },
        { name: "delete_redline_target_absent_after", ok: true },
        { name: "delete_redline_visual_gate_passed", ok: true },
        { name: "delete_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_delete_text");
  assert.equal(gate?.workflow, "redline_delete");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("tag delete redline demo readiness requires tag creation evidence", () => {
  const dir = tempDir("report-redline-delete-tag-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_delete_tag", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-delete-tag-${repeat}`,
      task_id: "demo_redline_delete_tag",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_delete",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_delete_summary.json"),
        path.join(runDir, "artifacts", "redline_delete_visual_gate.json")
      ],
      verification_results: [
        { name: "delete_redline_created_text_note_id_present", ok: true },
        { name: "delete_redline_target_visible_before", ok: true },
        { name: "delete_redline_dry_run_ok", ok: true },
        { name: "delete_redline_applied_ids_present", ok: true },
        { name: "delete_redline_target_absent_after", ok: true },
        { name: "delete_redline_visual_gate_passed", ok: true },
        { name: "delete_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_delete_tag");
  assert.equal(gate?.workflow, "redline_delete");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /delete_redline_created_tag_id_present/);
});

test("family instance delete redline demo readiness requires model target type evidence", () => {
  const dir = tempDir("report-redline-delete-family-instance-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_delete_family_instance", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-delete-family-instance-${repeat}`,
      task_id: "demo_redline_delete_family_instance",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_delete",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_delete_summary.json"),
        path.join(runDir, "artifacts", "redline_delete_visual_gate.json")
      ],
      verification_results: [
        { name: "delete_redline_created_tag_id_present", ok: true },
        { name: "delete_redline_target_visible_before", ok: true },
        { name: "delete_redline_dry_run_ok", ok: true },
        { name: "delete_redline_applied_ids_present", ok: true },
        { name: "delete_redline_target_absent_after", ok: true },
        { name: "delete_redline_visual_gate_passed", ok: true },
        { name: "delete_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_delete_family_instance");
  assert.equal(gate?.workflow, "redline_delete");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline delete evidence incomplete/);
  assert.match(gate?.reason ?? "", /delete_redline_created_family_instance_id_present/);
  assert.match(gate?.reason ?? "", /delete_redline_family_instance_type_matches_request/);
});

test("delete MEP accessory redline demo readiness requires modeled accessory evidence", () => {
  const dir = tempDir("report-redline-delete-mep-accessory-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_delete_mep_accessory", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-delete-mep-accessory-${repeat}`,
      task_id: "demo_redline_delete_mep_accessory",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_delete",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_delete_summary.json"),
        path.join(runDir, "artifacts", "redline_delete_visual_gate.json")
      ],
      verification_results: [
        { name: "delete_redline_created_tag_id_present", ok: true },
        { name: "delete_redline_target_visible_before", ok: true },
        { name: "delete_redline_dry_run_ok", ok: true },
        { name: "delete_redline_applied_ids_present", ok: true },
        { name: "delete_redline_target_absent_after", ok: true },
        { name: "delete_redline_visual_gate_passed", ok: true },
        { name: "delete_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_delete_mep_accessory");
  assert.equal(gate?.workflow, "redline_delete");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline delete evidence incomplete/);
  assert.match(gate?.reason ?? "", /delete_redline_created_family_instance_id_present/);
  assert.match(gate?.reason ?? "", /delete_redline_family_instance_type_matches_request/);
});

test("move-like redline demo readiness requires move vector and cleanup evidence", () => {
  const dir = tempDir("report-redline-move-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_move_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-move-${repeat}`,
      task_id: "demo_redline_move_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_move",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_move_summary.json")],
      verification_results: [
        { name: "move_redline_created_text_note_id_present", ok: true },
        { name: "move_redline_target_visible_before", ok: true },
        { name: "move_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_move_text");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline move evidence incomplete/);
  assert.match(gate?.reason ?? "", /move_redline_dry_run_ok/);
  assert.match(gate?.reason ?? "", /move_redline_applied_ids_present/);
  assert.match(gate?.reason ?? "", /move_redline_vector_matches_request/);
  assert.match(gate?.reason ?? "", /move_redline_cleanup_applied_ids_present/);
});

test("move-like redline demo readiness passes with strong live move evidence", () => {
  const dir = tempDir("report-redline-move-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_move_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-move-${repeat}`,
      task_id: "demo_redline_move_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_move",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 3,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_move_summary.json"),
        path.join(runDir, "artifacts", "redline_move_visual_gate.json")
      ],
      verification_results: [
        { name: "move_redline_created_text_note_id_present", ok: true },
        { name: "move_redline_target_visible_before", ok: true },
        { name: "move_redline_dry_run_ok", ok: true },
        { name: "move_redline_applied_ids_present", ok: true },
        { name: "move_redline_target_visible_after", ok: true },
        { name: "move_redline_vector_matches_request", ok: true },
        { name: "move_redline_visual_gate_passed", ok: true },
        { name: "move_redline_cleanup_dry_run_ok", ok: true },
        { name: "move_redline_cleanup_applied_ids_present", ok: true },
        { name: "move_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_move_text");
  assert.equal(gate?.workflow, "redline_move");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("tag move redline demo readiness requires tag creation evidence", () => {
  const dir = tempDir("report-redline-move-tag-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_move_tag", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-move-tag-${repeat}`,
      task_id: "demo_redline_move_tag",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_move",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 3,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_move_summary.json"),
        path.join(runDir, "artifacts", "redline_move_visual_gate.json")
      ],
      verification_results: [
        { name: "move_redline_created_text_note_id_present", ok: true },
        { name: "move_redline_target_visible_before", ok: true },
        { name: "move_redline_dry_run_ok", ok: true },
        { name: "move_redline_applied_ids_present", ok: true },
        { name: "move_redline_target_visible_after", ok: true },
        { name: "move_redline_vector_matches_request", ok: true },
        { name: "move_redline_visual_gate_passed", ok: true },
        { name: "move_redline_cleanup_dry_run_ok", ok: true },
        { name: "move_redline_cleanup_applied_ids_present", ok: true },
        { name: "move_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_move_tag");
  assert.equal(gate?.workflow, "redline_move");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /move_redline_created_tag_id_present/);
});

test("tag move redline demo readiness accepts grounded existing tag move evidence", () => {
  const dir = tempDir("report-redline-move-existing-tag-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_move_tag", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-move-existing-tag-${repeat}`,
      task_id: "demo_redline_move_tag",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_move",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_move_summary.json"),
        path.join(runDir, "artifacts", "redline_move_visual_gate.json")
      ],
      verification_results: [
        { name: "move_redline_existing_tag_present", ok: true },
        { name: "move_redline_existing_tag_identity_matches_request", ok: true },
        { name: "move_redline_target_visible_before", ok: true },
        { name: "move_redline_dry_run_ok", ok: true },
        { name: "move_redline_applied_ids_present", ok: true },
        { name: "move_redline_target_visible_after", ok: true },
        { name: "move_redline_vector_matches_request", ok: true },
        { name: "move_redline_visual_gate_passed", ok: true },
        { name: "move_redline_cleanup_dry_run_ok", ok: true },
        { name: "move_redline_cleanup_applied_ids_present", ok: true },
        { name: "move_redline_revert_matches_original", ok: true },
        { name: "move_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_move_tag");
  assert.equal(gate?.workflow, "redline_move");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("family instance move redline demo readiness requires model target type evidence", () => {
  const dir = tempDir("report-redline-move-family-instance-evidence");
  const taskIds = ["demo_redline_move_family_instance", "demo_redline_move_mep_accessory"];
  for (const taskId of taskIds) {
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${taskId}-${repeat}`,
        task_id: taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: "redline_move",
        execution_source: "live",
        success: true,
        elapsed_seconds: 10,
        tool_calls: 7,
        revit_transactions: 3,
        computer_use_actions: 0,
        output_artifacts: [
          path.join(runDir, "artifacts", "redline_move_summary.json"),
          path.join(runDir, "artifacts", "redline_move_visual_gate.json")
        ],
        verification_results: [
          { name: "move_redline_created_tag_id_present", ok: true },
          { name: "move_redline_target_visible_before", ok: true },
          { name: "move_redline_dry_run_ok", ok: true },
          { name: "move_redline_applied_ids_present", ok: true },
          { name: "move_redline_target_visible_after", ok: true },
          { name: "move_redline_vector_matches_request", ok: true },
          { name: "move_redline_visual_gate_passed", ok: true },
          { name: "move_redline_cleanup_dry_run_ok", ok: true },
          { name: "move_redline_cleanup_applied_ids_present", ok: true },
          { name: "move_redline_summary_written", ok: true }
        ],
        failure_reason: null
      });
    }
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  for (const taskId of taskIds) {
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === taskId);
    assert.equal(gate?.workflow, "redline_move");
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", /redline move evidence incomplete/);
    assert.match(gate?.reason ?? "", /move_redline_created_family_instance_id_present/);
    assert.match(gate?.reason ?? "", /move_redline_family_instance_type_matches_request/);
  }
});

test("rotate-like redline demo readiness requires rotate and cleanup evidence", () => {
  const dir = tempDir("report-redline-rotate-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_rotate_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-rotate-${repeat}`,
      task_id: "demo_redline_rotate_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_rotate",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 5,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_rotate_summary.json")],
      verification_results: [
        { name: "rotate_redline_created_text_note_id_present", ok: true },
        { name: "rotate_redline_target_visible_before", ok: true },
        { name: "rotate_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_rotate_text");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /redline rotate evidence incomplete/);
  assert.match(gate?.reason ?? "", /rotate_redline_dry_run_ok/);
  assert.match(gate?.reason ?? "", /rotate_redline_applied_ids_present/);
  assert.match(gate?.reason ?? "", /rotate_redline_cleanup_applied_ids_present/);
});

test("rotate-like redline demo readiness passes with strong live rotate evidence", () => {
  const dir = tempDir("report-redline-rotate-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_rotate_text", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-rotate-${repeat}`,
      task_id: "demo_redline_rotate_text",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_rotate",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 3,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_rotate_summary.json"),
        path.join(runDir, "artifacts", "redline_rotate_visual_gate.json")
      ],
      verification_results: [
        { name: "rotate_redline_created_text_note_id_present", ok: true },
        { name: "rotate_redline_target_visible_before", ok: true },
        { name: "rotate_redline_dry_run_ok", ok: true },
        { name: "rotate_redline_applied_ids_present", ok: true },
        { name: "rotate_redline_target_visible_after", ok: true },
        { name: "rotate_redline_visual_gate_passed", ok: true },
        { name: "rotate_redline_cleanup_dry_run_ok", ok: true },
        { name: "rotate_redline_cleanup_applied_ids_present", ok: true },
        { name: "rotate_redline_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_rotate_text");
  assert.equal(gate?.workflow, "redline_rotate");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("type-change redline demo readiness requires apply readback capture and revert evidence", () => {
  const dir = tempDir("report-redline-type-change-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_type_change_device", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-type-change-${repeat}`,
      task_id: "demo_redline_type_change_device",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_type_change",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_type_change_summary.json")],
      verification_results: [
        { name: "type_change_request_present", ok: true },
        { name: "type_change_dry_run_ok", ok: true },
        { name: "type_change_apply_ids_present", ok: true },
        { name: "type_change_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_type_change_device");
  assert.equal(gate?.workflow, "redline_type_change");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /type_change_dry_run_target_matches_request/);
  assert.match(gate?.reason ?? "", /type_change_source_type_grounding_ok/);
  assert.match(gate?.reason ?? "", /type_change_source_family_grounding_ok/);
  assert.match(gate?.reason ?? "", /type_change_dry_run_preflight_reviewed/);
  assert.match(gate?.reason ?? "", /type_change_target_compatibility_reviewed/);
  assert.match(gate?.reason ?? "", /type_change_readback_matches_target/);
  assert.match(gate?.reason ?? "", /type_change_post_change_capture_returned/);
  assert.match(gate?.reason ?? "", /type_change_post_change_capture_view_id_matches_request/);
  assert.match(gate?.reason ?? "", /type_change_revert_readback_matches_original/);

  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_type_change_duct", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-redline-type-change-duct-${repeat}`,
      task_id: "demo_redline_type_change_duct",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_type_change",
      execution_source: "live",
      success: true,
      elapsed_seconds: 10,
      tool_calls: 7,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_type_change_summary.json")],
      verification_results: [
        { name: "type_change_request_present", ok: true },
        { name: "type_change_dry_run_ok", ok: true },
        { name: "type_change_apply_ids_present", ok: true },
        { name: "type_change_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const ductReport = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const ductGate = ductReport.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_type_change_duct");
  assert.equal(ductGate?.workflow, "redline_type_change");
  assert.equal(ductGate?.passed, false);
  assert.match(ductGate?.reason ?? "", /type_change_dry_run_target_matches_request/);
  assert.match(ductGate?.reason ?? "", /type_change_source_type_grounding_ok/);
  assert.match(ductGate?.reason ?? "", /type_change_source_family_grounding_ok/);
  assert.match(ductGate?.reason ?? "", /type_change_dry_run_preflight_reviewed/);
  assert.match(ductGate?.reason ?? "", /type_change_target_compatibility_reviewed/);
  assert.match(ductGate?.reason ?? "", /type_change_readback_matches_target/);
  assert.match(ductGate?.reason ?? "", /type_change_post_change_capture_returned/);
  assert.match(ductGate?.reason ?? "", /type_change_post_change_capture_view_id_matches_request/);
  assert.match(ductGate?.reason ?? "", /type_change_revert_readback_matches_original/);
});

test("MEP route demo readiness requires modeled route evidence and visual gate", () => {
  const dir = tempDir("report-mep-route-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_mep_route", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-mep-route-${repeat}`,
      task_id: "demo_redline_mep_route",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_mep_route",
      execution_source: "live",
      success: true,
      elapsed_seconds: 25,
      tool_calls: 1,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "redline_mep_route_summary.json")],
      verification_results: [
        { name: "mep_route_workflow_ready", ok: true },
        { name: "mep_route_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const mepGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_mep_route");
  assert.equal(mepGate?.passed, false);
  assert.match(mepGate?.reason ?? "", /MEP route evidence incomplete/);
  assert.match(mepGate?.reason ?? "", /created_model_ids_present/);
  assert.match(mepGate?.reason ?? "", /mep_route_committed_readback_ok/);
  assert.match(mepGate?.reason ?? "", /planned_points_match_request/);
  assert.match(mepGate?.reason ?? "", /redline_visual_gate_passed/);
  assert.match(mepGate?.reason ?? "", /mep_route_cleanup_dry_run_ok/);
  assert.match(mepGate?.reason ?? "", /mep_route_cleanup_applied_ids_present/);
});

test("MEP route demo readiness passes with strong live route and visual evidence", () => {
  const dir = tempDir("report-mep-route-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_mep_route", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-mep-route-${repeat}`,
      task_id: "demo_redline_mep_route",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_mep_route",
      execution_source: "live",
      success: true,
      elapsed_seconds: 25,
      tool_calls: 1,
      revit_transactions: 1,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_mep_route_summary.json"),
        path.join(runDir, "artifacts", "redline_visual_gate.json")
      ],
      verification_results: [
        { name: "mep_route_workflow_ready", ok: true },
        { name: "created_model_ids_present", ok: true },
        { name: "post_change_capture_returned", ok: true },
        { name: "mep_route_committed_readback_ok", ok: true },
        { name: "planned_points_match_request", ok: true },
        { name: "mep_route_summary_written", ok: true },
        { name: "redline_visual_gate_passed", ok: true },
        { name: "mep_route_cleanup_dry_run_ok", ok: true },
        { name: "mep_route_cleanup_applied_ids_present", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const mepGate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_mep_route");
  assert.equal(mepGate?.passed, true);
  assert.equal(mepGate?.reason, "passed");
});

test("MEP pipe route demo readiness requires modeled pipe write visual and cleanup evidence", () => {
  const dir = tempDir("report-mep-pipe-route-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_redline_mep_pipe_route", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-mep-pipe-route-${repeat}`,
      task_id: "demo_redline_mep_pipe_route",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "redline_mep_route",
      execution_source: "live",
      success: true,
      elapsed_seconds: 28,
      tool_calls: 3,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "redline_mep_route_summary.json"),
        path.join(runDir, "artifacts", "redline_visual_gate.json")
      ],
      verification_results: [
        { name: "mep_route_workflow_ready", ok: true },
        { name: "created_model_ids_present", ok: true },
        { name: "post_change_capture_returned", ok: true },
        { name: "mep_route_committed_readback_ok", ok: true },
        { name: "planned_points_match_request", ok: true },
        { name: "mep_route_summary_written", ok: true },
        { name: "redline_visual_gate_passed", ok: true },
        { name: "mep_route_cleanup_dry_run_ok", ok: true },
        { name: "mep_route_cleanup_applied_ids_present", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_redline_mep_pipe_route");
  assert.equal(gate?.workflow, "redline_mep_route");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("MEP tap branch demo readiness requires tap projection fitting visual and cleanup evidence", () => {
  for (const taskId of ["demo_redline_mep_duct_tap_branch", "demo_redline_mep_pipe_tap_branch"]) {
    const dir = tempDir(`report-${taskId}-weak-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${taskId}-${repeat}`,
        task_id: taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: "redline_mep_tap_branch",
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 1,
        revit_transactions: 1,
        computer_use_actions: 0,
        output_artifacts: [path.join(runDir, "artifacts", "redline_mep_tap_branch_summary.json")],
        verification_results: [
          { name: "mep_tap_branch_applied", ok: true },
          { name: "mep_tap_branch_summary_written", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === taskId);
    assert.equal(gate?.workflow, "redline_mep_tap_branch");
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", /MEP tap\/branch evidence incomplete/);
    assert.match(gate?.reason ?? "", /mep_tap_branch_model_write_ids_present/);
    assert.match(gate?.reason ?? "", /mep_tap_branch_projected_point_reported/);
    assert.match(gate?.reason ?? "", /mep_tap_branch_connection_attempt_verified/);
    assert.match(gate?.reason ?? "", /redline_visual_gate_passed/);
    assert.match(gate?.reason ?? "", /mep_tap_branch_cleanup_dry_run_ok/);
  }
});

test("MEP tap branch demo readiness passes with strong live tap evidence", () => {
  for (const taskId of ["demo_redline_mep_duct_tap_branch", "demo_redline_mep_pipe_tap_branch"]) {
    const dir = tempDir(`report-${taskId}-strong-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${taskId}-${repeat}`,
        task_id: taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: "redline_mep_tap_branch",
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 3,
        revit_transactions: 2,
        computer_use_actions: 0,
        output_artifacts: [
          path.join(runDir, "artifacts", "redline_mep_tap_branch_summary.json"),
          path.join(runDir, "artifacts", "redline_visual_gate.json")
        ],
        verification_results: [
          { name: "mep_tap_branch_applied", ok: true },
          { name: "mep_tap_branch_model_write_ids_present", ok: true },
          { name: "mep_tap_branch_projected_point_reported", ok: true },
          { name: "mep_tap_branch_connection_attempt_verified", ok: true },
          { name: "mep_tap_branch_size_matches_request", ok: true },
          { name: "mep_tap_branch_connector_network_audit", ok: true },
          { name: "post_change_capture_returned", ok: true },
          { name: "mep_tap_branch_summary_written", ok: true },
          { name: "redline_visual_gate_passed", ok: true },
          { name: "mep_tap_branch_cleanup_dry_run_ok", ok: true },
          { name: "mep_tap_branch_cleanup_applied_ids_present", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === taskId);
    assert.equal(gate?.workflow, "redline_mep_tap_branch");
    assert.equal(gate?.passed, true);
    assert.equal(gate?.reason, "passed");
  }
});

test("MEP reroute demo readiness requires split fitting network visual and cleanup evidence", () => {
  for (const taskId of ["demo_redline_mep_duct_reroute", "demo_redline_mep_pipe_reroute"]) {
    const dir = tempDir(`report-${taskId}-weak-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${taskId}-${repeat}`,
        task_id: taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: "redline_mep_reroute",
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 1,
        revit_transactions: 1,
        computer_use_actions: 0,
        output_artifacts: [path.join(runDir, "artifacts", "redline_mep_reroute_summary.json")],
        verification_results: [
          { name: "mep_reroute_applied", ok: true },
          { name: "mep_reroute_summary_written", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === taskId);
    assert.equal(gate?.workflow, "redline_mep_reroute");
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", /MEP reroute evidence incomplete/);
    assert.match(gate?.reason ?? "", /mep_reroute_model_write_ids_present/);
    assert.match(gate?.reason ?? "", /mep_reroute_split_points_reported/);
    assert.match(gate?.reason ?? "", /mep_reroute_connection_attempts_verified/);
    assert.match(gate?.reason ?? "", /mep_reroute_connector_network_audit/);
    assert.match(gate?.reason ?? "", /redline_visual_gate_passed/);
    assert.match(gate?.reason ?? "", /mep_reroute_cleanup_dry_run_ok/);
  }
});

test("MEP reroute demo readiness passes with strong live reroute evidence", () => {
  for (const taskId of ["demo_redline_mep_duct_reroute", "demo_redline_mep_pipe_reroute"]) {
    const dir = tempDir(`report-${taskId}-strong-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${taskId}-${repeat}`,
        task_id: taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: "redline_mep_reroute",
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 3,
        revit_transactions: 2,
        computer_use_actions: 0,
        output_artifacts: [
          path.join(runDir, "artifacts", "redline_mep_reroute_summary.json"),
          path.join(runDir, "artifacts", "redline_visual_gate.json")
        ],
        verification_results: [
          { name: "mep_reroute_applied", ok: true },
          { name: "mep_reroute_model_write_ids_present", ok: true },
          { name: "mep_reroute_split_points_reported", ok: true },
          { name: "mep_reroute_offset_drop_matches_request", ok: true },
          { name: "mep_reroute_connection_attempts_verified", ok: true },
          { name: "mep_reroute_connector_network_audit", ok: true },
          { name: "post_change_capture_returned", ok: true },
          { name: "mep_reroute_summary_written", ok: true },
          { name: "redline_visual_gate_passed", ok: true },
          { name: "mep_reroute_cleanup_dry_run_ok", ok: true },
          { name: "mep_reroute_cleanup_applied_ids_present", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === taskId);
    assert.equal(gate?.workflow, "redline_mep_reroute");
    assert.equal(gate?.passed, true);
    assert.equal(gate?.reason, "passed");
  }
});

test("MEP size-transition demo readiness requires model write size connector visual and cleanup evidence", () => {
  const scenarios = [
    { taskId: "demo_redline_mep_duct_size_transition", workflow: "redline_mep_size_transition" },
    { taskId: "demo_redline_mep_pipe_size_transition", workflow: "redline_mep_size_transition" }
  ];

  for (const scenario of scenarios) {
    const dir = tempDir(`report-${scenario.taskId}-weak-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", scenario.taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${scenario.taskId}-${repeat}`,
        task_id: scenario.taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: scenario.workflow,
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 1,
        revit_transactions: 1,
        computer_use_actions: 0,
        output_artifacts: [path.join(runDir, "artifacts", "redline_mep_size_transition_summary.json")],
        verification_results: [
          { name: "mep_size_transition_applied", ok: true },
          { name: "mep_size_transition_summary_written", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === scenario.taskId);
    assert.equal(gate?.workflow, "redline_mep_size_transition");
    assert.equal(gate?.passed, false);
    assert.match(gate?.reason ?? "", /MEP size-transition evidence incomplete/);
    assert.match(gate?.reason ?? "", /mep_size_transition_model_write_ids_present/);
    assert.match(gate?.reason ?? "", /mep_size_transition_projected_point_reported/);
    assert.match(gate?.reason ?? "", /mep_size_transition_fitting_or_connector_readback/);
    assert.match(gate?.reason ?? "", /mep_size_transition_size_readback_matches/);
    assert.match(gate?.reason ?? "", /mep_size_transition_scoped_sizing_readback/);
    assert.match(gate?.reason ?? "", /redline_visual_gate_passed/);
    assert.match(gate?.reason ?? "", /mep_size_transition_cleanup_dry_run_ok/);
  }
});

test("MEP size-transition demo readiness passes with strong live transition evidence", () => {
  const scenarios = [
    { taskId: "demo_redline_mep_duct_size_transition", workflow: "redline_mep_size_transition" },
    { taskId: "demo_redline_mep_pipe_size_transition", workflow: "redline_mep_size_transition" }
  ];

  for (const scenario of scenarios) {
    const dir = tempDir(`report-${scenario.taskId}-strong-evidence`);
    for (let index = 1; index <= 5; index += 1) {
      const repeat = String(index).padStart(2, "0");
      const runDir = path.join(dir, "deterministic_skill_only", scenario.taskId, `repeat-${repeat}`);
      writeJsonFile(path.join(runDir, "run.json"), sampleRun({
        run_id: `run-live-${scenario.taskId}-${repeat}`,
        task_id: scenario.taskId,
        config_id: "deterministic_skill_only",
        repeat_index: index,
        artifact_dir: runDir
      }));
      writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
        workflow: scenario.workflow,
        execution_source: "live",
        success: true,
        elapsed_seconds: 24,
        tool_calls: 3,
        revit_transactions: 2,
        computer_use_actions: 0,
        output_artifacts: [
          path.join(runDir, "artifacts", "redline_mep_size_transition_summary.json"),
          path.join(runDir, "artifacts", "redline_visual_gate.json")
        ],
        verification_results: [
          { name: "mep_size_transition_applied", ok: true },
          { name: "mep_size_transition_model_write_ids_present", ok: true },
          { name: "mep_size_transition_projected_point_reported", ok: true },
          { name: "mep_size_transition_fitting_or_connector_readback", ok: true },
          { name: "mep_size_transition_size_readback_matches", ok: true },
          { name: "mep_size_transition_scoped_sizing_readback", ok: true },
          { name: "post_change_capture_returned", ok: true },
          { name: "mep_size_transition_summary_written", ok: true },
          { name: "redline_visual_gate_passed", ok: true },
          { name: "mep_size_transition_cleanup_dry_run_ok", ok: true },
          { name: "mep_size_transition_cleanup_applied_ids_present", ok: true }
        ],
        failure_reason: null
      });
    }

    const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
    const gate = report.demo_readiness_gates.find((entry) => entry.task_id === scenario.taskId);
    assert.equal(gate?.workflow, "redline_mep_size_transition");
    assert.equal(gate?.passed, true);
    assert.equal(gate?.reason, "passed");
  }
});

test("documentation demo readiness requires schedule sheet visibility and annotation evidence", () => {
  const dir = tempDir("report-documentation-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_documentation_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-documentation-${repeat}`,
      task_id: "demo_documentation_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "documentation_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 35,
      tool_calls: 4,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "documentation_primitives_summary.json")],
      verification_results: [
        { name: "schedule_dry_run_ok", ok: true },
        { name: "sheet_created_id_present", ok: true },
        { name: "documentation_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_documentation_primitives");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /documentation evidence incomplete/);
  assert.match(gate?.reason ?? "", /schedule_created_id_present/);
  assert.match(gate?.reason ?? "", /schedule_created_field_count_matches_request/);
  assert.match(gate?.reason ?? "", /schedule_created_fields_match_request/);
  assert.match(gate?.reason ?? "", /schedule_config_applied_success/);
  assert.match(gate?.reason ?? "", /schedule_config_target_matches_created_schedule/);
  assert.match(gate?.reason ?? "", /schedule_config_applied_operations_match_request/);
  assert.match(gate?.reason ?? "", /schedule_config_fields_match_request/);
  assert.match(gate?.reason ?? "", /schedule_config_text_value_readback_matches_request/);
  assert.match(gate?.reason ?? "", /view_created_id_present/);
  assert.match(gate?.reason ?? "", /view_placed_targets_match_request/);
  assert.match(gate?.reason ?? "", /detail_curve_ids_created/);
  assert.match(gate?.reason ?? "", /detail_curves_target_matches_request/);
  assert.match(gate?.reason ?? "", /tag_ids_created/);
  assert.match(gate?.reason ?? "", /tag_dry_run_targets_match_request/);
  assert.match(gate?.reason ?? "", /tag_applied_targets_match_request/);
  assert.match(gate?.reason ?? "", /tag_readback_matches_request/);
  assert.match(gate?.reason ?? "", /tag_created_count_matches_request/);
  assert.match(gate?.reason ?? "", /cad_link_request_present/);
  assert.match(gate?.reason ?? "", /cad_link_dry_run_ok/);
  assert.match(gate?.reason ?? "", /cad_link_applied_id_present/);
  assert.match(gate?.reason ?? "", /cad_link_source_matches_request/);
  assert.match(gate?.reason ?? "", /cad_link_sheet_matches_request/);
  assert.match(gate?.reason ?? "", /cad_link_owner_view_reported/);
  assert.match(gate?.reason ?? "", /cad_link_viewport_placed_on_sheet/);
  assert.match(gate?.reason ?? "", /cad_link_viewport_box_sheet_sized/);
  assert.match(gate?.reason ?? "", /cad_link_owner_view_bbox_reported/);
  assert.match(gate?.reason ?? "", /cad_link_layer_categories_reported/);
  assert.match(gate?.reason ?? "", /cad_graphics_override_layer_selected/);
  assert.match(gate?.reason ?? "", /cad_graphics_override_dry_run_ok/);
  assert.match(gate?.reason ?? "", /cad_graphics_override_applied_success/);
  assert.match(gate?.reason ?? "", /cad_graphics_override_target_matches_owner_view/);
  assert.match(gate?.reason ?? "", /cad_graphics_override_lineweight_matches_request/);
  assert.match(gate?.reason ?? "", /view_template_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /view_template_visibility_target_matches_template/);
  assert.match(gate?.reason ?? "", /view_template_visibility_applied_setting_matches_request/);
  assert.match(gate?.reason ?? "", /view_template_category_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /view_template_category_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /view_template_category_visibility_target_matches_template/);
  assert.match(gate?.reason ?? "", /view_template_category_visibility_applied_override_matches_request/);
  assert.match(gate?.reason ?? "", /view_template_assignment_dry_run_ok/);
  assert.match(gate?.reason ?? "", /view_template_assignment_applied_success/);
  assert.match(gate?.reason ?? "", /view_template_assignment_target_matches_created_view/);
  assert.match(gate?.reason ?? "", /view_template_assignment_setting_matches_request/);
  assert.match(gate?.reason ?? "", /visibility_applied_success/);
  assert.match(gate?.reason ?? "", /visibility_target_matches_created_view/);
  assert.match(gate?.reason ?? "", /visibility_applied_setting_matches_request/);
  assert.match(gate?.reason ?? "", /category_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /category_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /category_visibility_target_matches_request/);
  assert.match(gate?.reason ?? "", /category_visibility_applied_override_matches_request/);
  assert.match(gate?.reason ?? "", /category_visibility_revert_dry_run_ok/);
  assert.match(gate?.reason ?? "", /category_visibility_revert_applied_success/);
  assert.match(gate?.reason ?? "", /category_visibility_revert_target_matches_request/);
  assert.match(gate?.reason ?? "", /category_visibility_revert_cleared_override/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_target_matches_request/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_applied_override_matches_request/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_revert_dry_run_ok/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_revert_applied_success/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_revert_target_matches_request/);
  assert.match(gate?.reason ?? "", /linked_model_category_visibility_revert_cleared_override/);
  assert.match(gate?.reason ?? "", /phase_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /phase_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /phase_visibility_target_matches_request/);
  assert.match(gate?.reason ?? "", /phase_visibility_applied_setting_matches_request/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_target_matches_request/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_applied_setting_matches_request/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_revert_dry_run_ok/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_revert_applied_success/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_revert_target_matches_request/);
  assert.match(gate?.reason ?? "", /phase_filter_visibility_revert_setting_matches_original/);
  assert.match(gate?.reason ?? "", /phase_visibility_revert_dry_run_ok/);
  assert.match(gate?.reason ?? "", /phase_visibility_revert_applied_success/);
  assert.match(gate?.reason ?? "", /phase_visibility_revert_target_matches_request/);
  assert.match(gate?.reason ?? "", /phase_visibility_revert_setting_matches_original/);
  assert.match(gate?.reason ?? "", /filter_visibility_create_dry_run_ok/);
  assert.match(gate?.reason ?? "", /filter_visibility_create_applied_success/);
  assert.match(gate?.reason ?? "", /filter_visibility_create_target_matches_request/);
  assert.match(gate?.reason ?? "", /filter_visibility_created_filter_id_present/);
  assert.match(gate?.reason ?? "", /filter_visibility_dry_run_ok/);
  assert.match(gate?.reason ?? "", /filter_visibility_applied_success/);
  assert.match(gate?.reason ?? "", /filter_visibility_target_matches_request/);
  assert.match(gate?.reason ?? "", /filter_visibility_applied_override_matches_request/);
  assert.match(gate?.reason ?? "", /filter_visibility_revert_dry_run_ok/);
  assert.match(gate?.reason ?? "", /filter_visibility_revert_applied_success/);
  assert.match(gate?.reason ?? "", /filter_visibility_revert_target_matches_request/);
  assert.match(gate?.reason ?? "", /filter_visibility_revert_cleared_override/);
  assert.match(gate?.reason ?? "", /text_note_created/);
  assert.match(gate?.reason ?? "", /text_note_target_matches_request/);
  assert.match(gate?.reason ?? "", /documentation_post_change_capture_returned/);
  assert.match(gate?.reason ?? "", /documentation_post_change_capture_targets_created_context/);
  assert.match(gate?.reason ?? "", /documentation_post_change_capture_view_id_matches_request/);
  assert.match(gate?.reason ?? "", /documentation_post_change_capture_quality_ok/);
  assert.match(gate?.reason ?? "", /cad_link_post_change_capture_targets_sheet/);
  assert.match(gate?.reason ?? "", /documentation_cleanup_dry_run_ok/);
  assert.match(gate?.reason ?? "", /documentation_cleanup_applied_ids_present/);
});

test("documentation demo readiness passes with strong live primitive evidence", () => {
  const dir = tempDir("report-documentation-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_documentation_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-documentation-${repeat}`,
      task_id: "demo_documentation_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "documentation_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 35,
      tool_calls: 8,
      revit_transactions: 5,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "documentation_primitives_summary.json"),
        path.join(runDir, "artifacts", "documentation_primitives_summary.md")
      ],
      verification_results: [
        { name: "schedule_dry_run_ok", ok: true },
        { name: "schedule_created_id_present", ok: true },
        { name: "schedule_created_field_count_matches_request", ok: true },
        { name: "schedule_created_fields_match_request", ok: true },
        { name: "schedule_config_dry_run_ok", ok: true },
        { name: "schedule_config_applied_success", ok: true },
        { name: "schedule_config_target_matches_created_schedule", ok: true },
        { name: "schedule_config_applied_operations_match_request", ok: true },
        { name: "schedule_config_fields_match_request", ok: true },
        { name: "schedule_config_text_value_readback_matches_request", ok: true },
        { name: "sheet_created_id_present", ok: true },
        { name: "view_create_dry_run_ok", ok: true },
        { name: "view_created_id_present", ok: true },
        { name: "view_template_create_dry_run_ok", ok: true },
        { name: "view_template_created_id_present", ok: true },
        { name: "view_placed_on_sheet", ok: true },
        { name: "view_placed_targets_match_request", ok: true },
        { name: "detail_curves_dry_run_ok", ok: true },
        { name: "detail_curves_target_matches_request", ok: true },
        { name: "detail_curve_ids_created", ok: true },
        { name: "visibility_dry_run_ok", ok: true },
        { name: "visibility_applied_success", ok: true },
        { name: "visibility_target_matches_created_view", ok: true },
        { name: "visibility_applied_setting_matches_request", ok: true },
        { name: "category_visibility_dry_run_ok", ok: true },
        { name: "category_visibility_applied_success", ok: true },
        { name: "category_visibility_target_matches_request", ok: true },
        { name: "category_visibility_applied_override_matches_request", ok: true },
        { name: "category_visibility_revert_dry_run_ok", ok: true },
        { name: "category_visibility_revert_applied_success", ok: true },
        { name: "category_visibility_revert_target_matches_request", ok: true },
        { name: "category_visibility_revert_cleared_override", ok: true },
        { name: "linked_model_category_visibility_dry_run_ok", ok: true },
        { name: "linked_model_category_visibility_applied_success", ok: true },
        { name: "linked_model_category_visibility_target_matches_request", ok: true },
        { name: "linked_model_category_visibility_applied_override_matches_request", ok: true },
        { name: "linked_model_category_visibility_revert_dry_run_ok", ok: true },
        { name: "linked_model_category_visibility_revert_applied_success", ok: true },
        { name: "linked_model_category_visibility_revert_target_matches_request", ok: true },
        { name: "linked_model_category_visibility_revert_cleared_override", ok: true },
        { name: "phase_visibility_dry_run_ok", ok: true },
        { name: "phase_visibility_applied_success", ok: true },
        { name: "phase_visibility_target_matches_request", ok: true },
        { name: "phase_visibility_applied_setting_matches_request", ok: true },
        { name: "phase_filter_visibility_dry_run_ok", ok: true },
        { name: "phase_filter_visibility_applied_success", ok: true },
        { name: "phase_filter_visibility_target_matches_request", ok: true },
        { name: "phase_filter_visibility_applied_setting_matches_request", ok: true },
        { name: "phase_filter_visibility_revert_dry_run_ok", ok: true },
        { name: "phase_filter_visibility_revert_applied_success", ok: true },
        { name: "phase_filter_visibility_revert_target_matches_request", ok: true },
        { name: "phase_filter_visibility_revert_setting_matches_original", ok: true },
        { name: "phase_visibility_revert_dry_run_ok", ok: true },
        { name: "phase_visibility_revert_applied_success", ok: true },
        { name: "phase_visibility_revert_target_matches_request", ok: true },
        { name: "phase_visibility_revert_setting_matches_original", ok: true },
        { name: "filter_visibility_create_dry_run_ok", ok: true },
        { name: "filter_visibility_create_applied_success", ok: true },
        { name: "filter_visibility_create_target_matches_request", ok: true },
        { name: "filter_visibility_created_filter_id_present", ok: true },
        { name: "filter_visibility_dry_run_ok", ok: true },
        { name: "filter_visibility_applied_success", ok: true },
        { name: "filter_visibility_target_matches_request", ok: true },
        { name: "filter_visibility_applied_override_matches_request", ok: true },
        { name: "filter_visibility_revert_dry_run_ok", ok: true },
        { name: "filter_visibility_revert_applied_success", ok: true },
        { name: "filter_visibility_revert_target_matches_request", ok: true },
        { name: "filter_visibility_revert_cleared_override", ok: true },
        { name: "view_template_visibility_dry_run_ok", ok: true },
        { name: "view_template_visibility_applied_success", ok: true },
        { name: "view_template_visibility_target_matches_template", ok: true },
        { name: "view_template_visibility_applied_setting_matches_request", ok: true },
        { name: "view_template_category_visibility_dry_run_ok", ok: true },
        { name: "view_template_category_visibility_applied_success", ok: true },
        { name: "view_template_category_visibility_target_matches_template", ok: true },
        { name: "view_template_category_visibility_applied_override_matches_request", ok: true },
        { name: "view_template_assignment_dry_run_ok", ok: true },
        { name: "view_template_assignment_applied_success", ok: true },
        { name: "view_template_assignment_target_matches_created_view", ok: true },
        { name: "view_template_assignment_setting_matches_request", ok: true },
        { name: "text_note_created", ok: true },
        { name: "text_note_target_matches_request", ok: true },
        { name: "tag_request_present", ok: true },
        { name: "tag_dry_run_ok", ok: true },
        { name: "tag_dry_run_targets_match_request", ok: true },
        { name: "tag_applied_targets_match_request", ok: true },
        { name: "tag_readback_matches_request", ok: true },
        { name: "tag_created_count_matches_request", ok: true },
        { name: "tag_ids_created", ok: true },
        { name: "cad_link_request_present", ok: true },
        { name: "cad_link_dry_run_ok", ok: true },
        { name: "cad_link_applied_id_present", ok: true },
        { name: "cad_link_source_matches_request", ok: true },
        { name: "cad_link_sheet_matches_request", ok: true },
        { name: "cad_link_owner_view_reported", ok: true },
        { name: "cad_link_viewport_placed_on_sheet", ok: true },
        { name: "cad_link_viewport_box_sheet_sized", ok: true },
        { name: "cad_link_owner_view_bbox_reported", ok: true },
        { name: "cad_link_layer_categories_reported", ok: true },
        { name: "cad_graphics_override_layer_selected", ok: true },
        { name: "cad_graphics_override_dry_run_ok", ok: true },
        { name: "cad_graphics_override_applied_success", ok: true },
        { name: "cad_graphics_override_target_matches_owner_view", ok: true },
        { name: "cad_graphics_override_lineweight_matches_request", ok: true },
        { name: "documentation_post_change_capture_returned", ok: true },
        { name: "documentation_post_change_capture_targets_created_context", ok: true },
        { name: "documentation_post_change_capture_view_id_matches_request", ok: true },
        { name: "documentation_post_change_capture_quality_ok", ok: true },
        { name: "cad_link_post_change_capture_targets_sheet", ok: true },
        { name: "documentation_cleanup_dry_run_ok", ok: true },
        { name: "documentation_cleanup_applied_ids_present", ok: true },
        { name: "documentation_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_documentation_primitives");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("documentation demo readiness passes scoped tag value source evidence", () => {
  const dir = tempDir("report-documentation-tag-value-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_documentation_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-documentation-tag-value-${repeat}`,
      task_id: "demo_documentation_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "documentation_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 25,
      tool_calls: 11,
      revit_transactions: 9,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "documentation_primitives_summary.json"),
        path.join(runDir, "artifacts", "documentation_primitives_summary.md")
      ],
      verification_results: [
        { name: "tag_value_existing_visible_readback_matches_original", ok: true },
        { name: "tag_value_parameter_original_matches_expected", ok: true },
        { name: "tag_value_parameter_dry_run_ok", ok: true },
        { name: "tag_value_parameter_apply_ok", ok: true },
        { name: "tag_value_parameter_readback_matches_request", ok: true },
        { name: "tag_value_visible_readback_matches_request", ok: true },
        { name: "documentation_post_change_capture_returned", ok: true },
        { name: "documentation_post_change_capture_targets_created_context", ok: true },
        { name: "documentation_post_change_capture_view_id_matches_request", ok: true },
        { name: "documentation_post_change_capture_quality_ok", ok: true },
        { name: "tag_value_revert_dry_run_ok", ok: true },
        { name: "tag_value_revert_apply_ok", ok: true },
        { name: "tag_value_revert_parameter_matches_original", ok: true },
        { name: "tag_value_revert_visible_readback_matches_original", ok: true },
        { name: "documentation_cleanup_dry_run_ok", ok: true },
        { name: "documentation_cleanup_applied_ids_present", ok: true },
        { name: "documentation_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_documentation_primitives");
  assert.equal(gate?.passed, true, gate?.reason);
  assert.equal(gate?.reason, "passed");
});

test("documentation demo readiness passes scoped graphics-only evidence", () => {
  const dir = tempDir("report-documentation-graphics-only-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_documentation_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-documentation-graphics-${repeat}`,
      task_id: "demo_documentation_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "documentation_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 12,
      tool_calls: 7,
      revit_transactions: 5,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "documentation_primitives_summary.json"),
        path.join(runDir, "artifacts", "documentation_primitives_summary.md")
      ],
      verification_results: [
        { name: "category_visibility_dry_run_ok", ok: true },
        { name: "category_visibility_applied_success", ok: true },
        { name: "category_visibility_target_matches_request", ok: true },
        { name: "category_visibility_applied_override_matches_request", ok: true },
        { name: "category_visibility_post_apply_capture_returned", ok: true },
        { name: "category_visibility_post_apply_capture_view_id_matches_request", ok: true },
        { name: "category_visibility_post_apply_capture_quality_ok", ok: true },
        { name: "category_visibility_revert_dry_run_ok", ok: true },
        { name: "category_visibility_revert_applied_success", ok: true },
        { name: "category_visibility_revert_target_matches_request", ok: true },
        { name: "category_visibility_revert_cleared_override", ok: true },
        { name: "documentation_post_change_capture_returned", ok: true },
        { name: "documentation_post_change_capture_targets_created_context", ok: true },
        { name: "documentation_post_change_capture_view_id_matches_request", ok: true },
        { name: "documentation_post_change_capture_quality_ok", ok: true },
        { name: "documentation_final_capture_returned", ok: true },
        { name: "documentation_final_capture_view_id_matches_request", ok: true },
        { name: "documentation_final_capture_quality_ok", ok: true },
        { name: "documentation_cleanup_dry_run_ok", ok: true },
        { name: "documentation_cleanup_applied_ids_present", ok: true },
        { name: "documentation_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_documentation_primitives");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});

test("documentation demo readiness flags incomplete scoped tag value source evidence", () => {
  const dir = tempDir("report-documentation-tag-value-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_documentation_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-documentation-tag-value-weak-${repeat}`,
      task_id: "demo_documentation_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "documentation_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 25,
      tool_calls: 6,
      revit_transactions: 3,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "documentation_primitives_summary.json")],
      verification_results: [
        { name: "tag_value_parameter_apply_ok", ok: true },
        { name: "tag_value_visible_readback_matches_request", ok: true },
        { name: "documentation_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_documentation_primitives");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /documentation evidence incomplete/);
  assert.match(gate?.reason ?? "", /tag_value_parameter_readback_matches_request/);
  assert.match(gate?.reason ?? "", /tag_value_revert_visible_readback_matches_original/);
  assert.doesNotMatch(gate?.reason ?? "", /schedule_created_id_present/);
  assert.doesNotMatch(gate?.reason ?? "", /cad_link_applied_id_present/);
});

test("model edit demo readiness requires add move delete evidence", () => {
  const dir = tempDir("report-model-edit-weak-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_model_edit_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-model-edit-${repeat}`,
      task_id: "demo_model_edit_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "model_edit_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 20,
      tool_calls: 3,
      revit_transactions: 2,
      computer_use_actions: 0,
      output_artifacts: [path.join(runDir, "artifacts", "model_edit_primitives_summary.json")],
      verification_results: [
        { name: "family_instance_created_id_present", ok: true },
        { name: "move_dry_run_ok", ok: true },
        { name: "model_edit_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_model_edit_primitives");
  assert.equal(gate?.passed, false);
  assert.match(gate?.reason ?? "", /model edit evidence incomplete/);
  assert.match(gate?.reason ?? "", /family_instance_type_matches_request/);
  assert.match(gate?.reason ?? "", /move_applied_ids_present/);
  assert.match(gate?.reason ?? "", /delete_applied_ids_present/);
  assert.match(gate?.reason ?? "", /revit_link_instance_created_id_present/);
  assert.match(gate?.reason ?? "", /revit_link_source_matches_request/);
  assert.match(gate?.reason ?? "", /revit_link_pin_matches_request/);
  assert.match(gate?.reason ?? "", /model_edit_post_change_capture_returned/);
  assert.match(gate?.reason ?? "", /model_edit_post_change_capture_view_id_matches_request/);
  assert.match(gate?.reason ?? "", /revit_link_cleanup_applied_ids_present/);
  assert.match(gate?.reason ?? "", /revit_link_type_cleanup_applied_ids_present/);
});

test("model edit demo readiness passes with strong live add move delete evidence", () => {
  const dir = tempDir("report-model-edit-strong-evidence");
  for (let index = 1; index <= 5; index += 1) {
    const repeat = String(index).padStart(2, "0");
    const runDir = path.join(dir, "deterministic_skill_only", "demo_model_edit_primitives", `repeat-${repeat}`);
    writeJsonFile(path.join(runDir, "run.json"), sampleRun({
      run_id: `run-live-model-edit-${repeat}`,
      task_id: "demo_model_edit_primitives",
      config_id: "deterministic_skill_only",
      repeat_index: index,
      artifact_dir: runDir
    }));
    writeJsonFile(path.join(runDir, "revit_workflow_result.json"), {
      workflow: "model_edit_primitives",
      execution_source: "live",
      success: true,
      elapsed_seconds: 20,
      tool_calls: 5,
      revit_transactions: 3,
      computer_use_actions: 0,
      output_artifacts: [
        path.join(runDir, "artifacts", "model_edit_primitives_summary.json"),
        path.join(runDir, "artifacts", "model_edit_primitives_summary.md")
      ],
      verification_results: [
        { name: "family_instance_created_id_present", ok: true },
        { name: "family_instance_type_matches_request", ok: true },
        { name: "move_dry_run_ok", ok: true },
        { name: "move_applied_ids_present", ok: true },
        { name: "delete_dry_run_ok", ok: true },
        { name: "delete_applied_ids_present", ok: true },
        { name: "revit_link_request_present", ok: true },
        { name: "revit_link_dry_run_ok", ok: true },
        { name: "revit_link_instance_created_id_present", ok: true },
        { name: "revit_link_type_created_id_present", ok: true },
        { name: "revit_link_source_matches_request", ok: true },
        { name: "revit_link_pin_matches_request", ok: true },
        { name: "model_edit_post_change_capture_returned", ok: true },
        { name: "model_edit_post_change_capture_view_id_matches_request", ok: true },
        { name: "revit_link_cleanup_dry_run_ok", ok: true },
        { name: "revit_link_cleanup_applied_ids_present", ok: true },
        { name: "revit_link_type_cleanup_dry_run_ok", ok: true },
        { name: "revit_link_type_cleanup_applied_ids_present", ok: true },
        { name: "model_edit_summary_written", ok: true }
      ],
      failure_reason: null
    });
  }

  const report = generateBenchmarkReport(dir, loadBenchmarkConfigBundle());
  const gate = report.demo_readiness_gates.find((entry) => entry.task_id === "demo_model_edit_primitives");
  assert.equal(gate?.passed, true);
  assert.equal(gate?.reason, "passed");
});
