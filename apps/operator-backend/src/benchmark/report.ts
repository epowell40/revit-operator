import fs from "node:fs";
import path from "node:path";
import { nowIso, recursiveFindRunJsonFiles, readJsonFile, writeJsonFile, writeTextFile } from "./files.js";
import type {
  BenchmarkConfigAggregate,
  BenchmarkConfigBundle,
  BenchmarkDemoReadinessGate,
  BenchmarkReport,
  BenchmarkRevitWorkflowSummary,
  BenchmarkRunRecord,
  BenchmarkTaskAggregate
} from "./types.js";

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function gradeOf(run: BenchmarkRunRecord): "success" | "partial" | "fail" | "invalid_run" {
  if (run.manual_grade_value) return run.manual_grade_value;
  if (run.success_label === "success") return "success";
  if (run.success_label === "partial") return "partial";
  return "fail";
}

function toConfigAggregate(
  configId: string,
  runs: BenchmarkRunRecord[],
  baselineRuns: BenchmarkRunRecord[]
): BenchmarkConfigAggregate {
  const grades = runs.map((run) => gradeOf(run));
  const successes = grades.filter((grade) => grade === "success").length;
  const partials = grades.filter((grade) => grade === "partial").length;
  const fails = grades.filter((grade) => grade === "fail").length;
  const invalids = grades.filter((grade) => grade === "invalid_run").length;
  const averageWall = mean(runs.map((run) => run.total_wall_clock_seconds));
  const averageCost = mean(runs.map((run) => run.estimated_total_cost_usd));
  const baselineAverageWall = baselineRuns.length > 0 ? mean(baselineRuns.map((run) => run.total_wall_clock_seconds)) : 0;
  const successRate = runs.length > 0 ? successes / runs.length : 0;

  return {
    config_id: configId,
    sample_size: runs.length,
    success_rate: successRate,
    partial_rate: runs.length > 0 ? partials / runs.length : 0,
    fail_rate: runs.length > 0 ? fails / runs.length : 0,
    invalid_rate: runs.length > 0 ? invalids / runs.length : 0,
    average_wall_clock_seconds: averageWall,
    average_model_latency_seconds: mean(runs.map((run) => run.total_model_latency_seconds)),
    average_tool_latency_seconds: mean(runs.map((run) => run.total_tool_latency_seconds)),
    average_cost_usd: averageCost,
    average_steps: mean(runs.map((run) => run.total_steps)),
    average_time_to_first_action_seconds:
      runs.some((run) => run.time_to_first_meaningful_action_seconds !== null)
        ? mean(
            runs
              .map((run) => run.time_to_first_meaningful_action_seconds)
              .filter((value): value is number => value !== null)
          )
        : null,
    average_replanning_seconds: mean(runs.map((run) => run.time_spent_in_replanning_seconds)),
    average_retry_seconds: mean(runs.map((run) => run.time_lost_to_retries_seconds)),
    steps_per_minute: mean(runs.map((run) => run.steps_per_minute)),
    successful_tasks_per_hour_equivalent: averageWall > 0 ? (successRate * 3600) / averageWall : 0,
    p50_latency_seconds: runs.length >= 2 ? percentile(runs.map((run) => run.total_wall_clock_seconds), 0.5) : null,
    p95_latency_seconds: runs.length >= 5 ? percentile(runs.map((run) => run.total_wall_clock_seconds), 0.95) : null,
    latency_normalized_success: averageWall > 0 ? successRate / averageWall : 0,
    cost_normalized_success: averageCost > 0 ? successRate / averageCost : 0,
    relative_speedup_vs_baseline:
      baselineAverageWall > 0 && averageWall > 0 ? baselineAverageWall / averageWall : null
  };
}

function toTaskAggregates(runs: BenchmarkRunRecord[]): BenchmarkTaskAggregate[] {
  const grouped = new Map<string, BenchmarkRunRecord[]>();
  for (const run of runs) {
    const key = `${run.task_id}::${run.config_id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return [...grouped.entries()]
    .map(([key, group]) => {
      const [taskId, configId] = key.split("::");
      const successRate = group.length > 0 ? group.filter((run) => gradeOf(run) === "success").length / group.length : 0;
      return {
        task_id: taskId ?? "",
        config_id: configId ?? "",
        sample_size: group.length,
        success_rate: successRate,
        average_wall_clock_seconds: mean(group.map((run) => run.total_wall_clock_seconds)),
        average_cost_usd: mean(group.map((run) => run.estimated_total_cost_usd))
      };
    })
    .sort((a, b) => `${a.task_id}|${a.config_id}`.localeCompare(`${b.task_id}|${b.config_id}`));
}

function markdownTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`
  ];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function n(value: number): string {
  return value.toFixed(2);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function executionSource(value: unknown): BenchmarkRevitWorkflowSummary["execution_source"] {
  return value === "live" || value === "mock" || value === "injected" ? value : "unknown";
}

function verificationName(entry: Record<string, unknown>): string | null {
  return typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
}

export function loadRunRecords(artifactsDir: string): BenchmarkRunRecord[] {
  return recursiveFindRunJsonFiles(artifactsDir).map((filePath) => readJsonFile<BenchmarkRunRecord>(filePath));
}

function loadRevitWorkflowSummaries(runs: BenchmarkRunRecord[]): BenchmarkRevitWorkflowSummary[] {
  const summaries: BenchmarkRevitWorkflowSummary[] = [];
  for (const run of runs) {
    const resultPath = path.join(run.artifact_dir, "revit_workflow_result.json");
    if (!fs.existsSync(resultPath)) continue;
    const result = asObject(readJsonFile<unknown>(resultPath));
    const verifications = Array.isArray(result.verification_results) ? result.verification_results.map(asObject) : [];
    const verificationNamesPassed = verifications
      .filter((entry) => entry.ok === true)
      .map(verificationName)
      .filter((name): name is string => name !== null);
    const verificationNamesFailed = verifications
      .filter((entry) => entry.ok !== true)
      .map(verificationName)
      .filter((name): name is string => name !== null);
    summaries.push({
      run_id: run.run_id,
      task_id: run.task_id,
      config_id: run.config_id,
      workflow: String(result.workflow ?? ""),
      execution_source: executionSource(result.execution_source),
      success: result.success === true,
      elapsed_seconds: Number(result.elapsed_seconds ?? 0),
      tool_calls: Number(result.tool_calls ?? 0),
      revit_transactions: Number(result.revit_transactions ?? 0),
      computer_use_actions: Number(result.computer_use_actions ?? 0),
      output_artifact_count: Array.isArray(result.output_artifacts) ? result.output_artifacts.length : 0,
      verification_passed: verifications.filter((entry) => entry.ok === true).length,
      verification_total: verifications.length,
      verification_names_passed: verificationNamesPassed,
      verification_names_failed: verificationNamesFailed,
      failure_reason: typeof result.failure_reason === "string" ? result.failure_reason : null,
      ...(typeof result.failure_classification === "string" ? { failure_classification: result.failure_classification } : {})
    });
  }
  return summaries.sort((a, b) => `${a.task_id}|${a.config_id}|${a.run_id}`.localeCompare(`${b.task_id}|${b.config_id}|${b.run_id}`));
}

const DEMO_READINESS_TARGETS: Record<string, { workflow: string; successRate: number; elapsedSeconds: number; minLiveSamples: number }> = {
  demo_sheet_export: { workflow: "sheet_export", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_takeoff_receptacles: { workflow: "takeoff_csv", successRate: 0.98, elapsedSeconds: 30, minLiveSamples: 5 },
  demo_parameter_edit: { workflow: "parameter_edit", successRate: 0.98, elapsedSeconds: 30, minLiveSamples: 5 },
  demo_redline_update_parameter: { workflow: "redline_update_parameter", successRate: 0.98, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_text_edit_mep_accessory: { workflow: "parameter_edit", successRate: 0.98, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_receptacles: { workflow: "redline_receptacles", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_add_tag: { workflow: "redline_add", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_add_family_instance: { workflow: "redline_add", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_add_receptacle: { workflow: "redline_add", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_add_light: { workflow: "redline_add", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_add_mep_accessory: { workflow: "redline_add", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_text: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_tag: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_family_instance: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_receptacle: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_light: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_delete_duct_route: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_delete_pipe_route: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_delete_mep_accessory: { workflow: "redline_delete", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_text: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_tag: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_family_instance: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_receptacle: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_light: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_mep_accessory: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_move_duct_route: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_move_pipe_route: { workflow: "redline_move", successRate: 0.95, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_rotate_text: { workflow: "redline_rotate", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_type_change_device: { workflow: "redline_type_change", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_type_change_duct: { workflow: "redline_type_change", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_type_change_mep_accessory: { workflow: "redline_type_change", successRate: 0.95, elapsedSeconds: 60, minLiveSamples: 5 },
  demo_redline_mep_route: { workflow: "redline_mep_route", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_pipe_route: { workflow: "redline_mep_route", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_duct_tap_branch: { workflow: "redline_mep_tap_branch", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_pipe_tap_branch: { workflow: "redline_mep_tap_branch", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_duct_reroute: { workflow: "redline_mep_reroute", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_pipe_reroute: { workflow: "redline_mep_reroute", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_duct_size_transition: { workflow: "redline_mep_size_transition", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_redline_mep_pipe_size_transition: { workflow: "redline_mep_size_transition", successRate: 0.8, elapsedSeconds: 180, minLiveSamples: 5 },
  demo_documentation_primitives: { workflow: "documentation_primitives", successRate: 0.9, elapsedSeconds: 120, minLiveSamples: 5 },
  demo_model_edit_primitives: { workflow: "model_edit_primitives", successRate: 0.9, elapsedSeconds: 300, minLiveSamples: 5 }
};

const REDLINE_REQUIRED_LIVE_VERIFICATIONS = [
  "create_similar_dry_run_placement_evidence",
  "created_expected_count",
  "audit_passed",
  "audit_contains_created_ids",
  "audit_host_evidence_ok",
  "created_room_matches_expected",
  "cleanup_completed_when_requested",
  "cleanup_dry_run_ok",
  "cleanup_deleted_ids_present"
];

const REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS = [
  "created_circuit_matches_expected",
  "created_circuit_matches_source_when_requested"
];

const REDLINE_DELETE_REQUIRED_LIVE_VERIFICATIONS = [
  "delete_redline_created_text_note_id_present",
  "delete_redline_target_visible_before",
  "delete_redline_dry_run_ok",
  "delete_redline_applied_ids_present",
  "delete_redline_target_absent_after",
  "delete_redline_visual_gate_passed",
  "delete_redline_summary_written"
];

const REDLINE_DELETE_TAG_REQUIRED_LIVE_VERIFICATIONS = [
  "delete_redline_created_tag_id_present",
  "delete_redline_target_visible_before",
  "delete_redline_dry_run_ok",
  "delete_redline_applied_ids_present",
  "delete_redline_target_absent_after",
  "delete_redline_visual_gate_passed",
  "delete_redline_summary_written"
];

const REDLINE_DELETE_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS = [
  "delete_redline_created_family_instance_id_present",
  "delete_redline_family_instance_type_matches_request",
  "delete_redline_target_visible_before",
  "delete_redline_dry_run_ok",
  "delete_redline_applied_ids_present",
  "delete_redline_target_absent_after",
  "delete_redline_visual_gate_passed",
  "delete_redline_summary_written"
];

const REDLINE_DELETE_MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS = [
  "delete_redline_created_mep_route_ids_present",
  "delete_redline_mep_route_kind_matches_request",
  "delete_redline_target_visible_before",
  "delete_redline_dry_run_ok",
  "delete_redline_applied_ids_present",
  "delete_redline_target_absent_after",
  "delete_redline_visual_gate_passed",
  "delete_redline_summary_written"
];

const REDLINE_ADD_TAG_REQUIRED_LIVE_VERIFICATIONS = [
  "add_redline_created_tag_id_present",
  "add_redline_tag_apply_matches_request",
  "add_redline_tag_readback_matches_request",
  "add_redline_target_visible_after",
  "add_redline_visual_gate_passed",
  "add_redline_cleanup_dry_run_ok",
  "add_redline_cleanup_applied_ids_present",
  "add_redline_summary_written"
];

const REDLINE_ADD_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS = [
  "add_redline_created_family_instance_id_present",
  "add_redline_family_instance_type_matches_request",
  "add_redline_target_visible_after",
  "add_redline_visual_gate_passed",
  "add_redline_cleanup_dry_run_ok",
  "add_redline_cleanup_applied_ids_present",
  "add_redline_summary_written"
];

const REDLINE_MOVE_REQUIRED_LIVE_VERIFICATIONS = [
  "move_redline_created_text_note_id_present",
  "move_redline_target_visible_before",
  "move_redline_dry_run_ok",
  "move_redline_applied_ids_present",
  "move_redline_target_visible_after",
  "move_redline_vector_matches_request",
  "move_redline_visual_gate_passed",
  "move_redline_cleanup_dry_run_ok",
  "move_redline_cleanup_applied_ids_present",
  "move_redline_summary_written"
];

const REDLINE_MOVE_TAG_REQUIRED_LIVE_VERIFICATIONS = [
  "move_redline_created_tag_id_present",
  "move_redline_target_visible_before",
  "move_redline_dry_run_ok",
  "move_redline_applied_ids_present",
  "move_redline_target_visible_after",
  "move_redline_vector_matches_request",
  "move_redline_visual_gate_passed",
  "move_redline_cleanup_dry_run_ok",
  "move_redline_cleanup_applied_ids_present",
  "move_redline_summary_written"
];

const REDLINE_MOVE_EXISTING_TAG_REQUIRED_LIVE_VERIFICATIONS = [
  "move_redline_existing_tag_present",
  "move_redline_existing_tag_identity_matches_request",
  "move_redline_target_visible_before",
  "move_redline_dry_run_ok",
  "move_redline_applied_ids_present",
  "move_redline_target_visible_after",
  "move_redline_vector_matches_request",
  "move_redline_visual_gate_passed",
  "move_redline_cleanup_dry_run_ok",
  "move_redline_cleanup_applied_ids_present",
  "move_redline_revert_matches_original",
  "move_redline_summary_written"
];

const REDLINE_MOVE_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS = [
  "move_redline_created_family_instance_id_present",
  "move_redline_family_instance_type_matches_request",
  "move_redline_target_visible_before",
  "move_redline_dry_run_ok",
  "move_redline_applied_ids_present",
  "move_redline_target_visible_after",
  "move_redline_vector_matches_request",
  "move_redline_visual_gate_passed",
  "move_redline_cleanup_dry_run_ok",
  "move_redline_cleanup_applied_ids_present",
  "move_redline_summary_written"
];

const REDLINE_MOVE_MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS = [
  "move_redline_created_mep_route_ids_present",
  "move_redline_mep_route_kind_matches_request",
  "move_redline_target_visible_before",
  "move_redline_dry_run_ok",
  "move_redline_applied_ids_present",
  "move_redline_target_visible_after",
  "move_redline_vector_matches_request",
  "move_redline_visual_gate_passed",
  "move_redline_cleanup_dry_run_ok",
  "move_redline_cleanup_applied_ids_present",
  "move_redline_summary_written"
];

const REDLINE_ROTATE_REQUIRED_LIVE_VERIFICATIONS = [
  "rotate_redline_created_text_note_id_present",
  "rotate_redline_target_visible_before",
  "rotate_redline_dry_run_ok",
  "rotate_redline_applied_ids_present",
  "rotate_redline_target_visible_after",
  "rotate_redline_visual_gate_passed",
  "rotate_redline_cleanup_dry_run_ok",
  "rotate_redline_cleanup_applied_ids_present",
  "rotate_redline_summary_written"
];

const REDLINE_TYPE_CHANGE_REQUIRED_LIVE_VERIFICATIONS = [
  "type_change_request_present",
  "type_change_dry_run_ok",
  "type_change_dry_run_target_matches_request",
  "type_change_source_type_grounding_ok",
  "type_change_source_family_grounding_ok",
  "type_change_dry_run_preflight_reviewed",
  "type_change_target_compatibility_reviewed",
  "type_change_apply_ids_present",
  "type_change_target_type_matches_request",
  "type_change_readback_matches_target",
  "type_change_post_change_capture_returned",
  "type_change_post_change_capture_view_id_matches_request",
  "type_change_revert_dry_run_ok",
  "type_change_revert_apply_ids_present",
  "type_change_revert_readback_matches_original",
  "type_change_summary_written"
];

const PARAMETER_EDIT_REQUIRED_LIVE_VERIFICATIONS = [
  "target_count",
  "target_count_matches_request",
  "dry_run_returned_diffs",
  "dry_run_all_changes_ok",
  "apply_all_changes_ok",
  "apply_changed_or_confirmed",
  "old_values_captured",
  "readback_matches_requested_value",
  "revert_dry_run_all_changes_ok",
  "revert_apply_all_changes_ok",
  "revert_readback_matches_original_value",
  "parameter_change_summary_written"
];

const PARAMETER_EDIT_ACCESSORY_REQUIRED_LIVE_VERIFICATIONS = [
  ...PARAMETER_EDIT_REQUIRED_LIVE_VERIFICATIONS,
  "parameter_target_identity_matches_request",
  "parameter_post_change_capture_returned",
  "parameter_post_change_capture_view_id_matches_request",
  "parameter_post_change_capture_quality_ok"
];

const MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS = [
  "mep_route_workflow_ready",
  "created_model_ids_present",
  "post_change_capture_returned",
  "mep_route_committed_readback_ok",
  "planned_points_match_request",
  "mep_route_summary_written",
  "redline_visual_gate_passed",
  "mep_route_cleanup_dry_run_ok",
  "mep_route_cleanup_applied_ids_present"
];

const MEP_TAP_BRANCH_REQUIRED_LIVE_VERIFICATIONS = [
  "mep_tap_branch_applied",
  "mep_tap_branch_model_write_ids_present",
  "mep_tap_branch_projected_point_reported",
  "mep_tap_branch_connection_attempt_verified",
  "mep_tap_branch_size_matches_request",
  "mep_tap_branch_connector_network_audit",
  "post_change_capture_returned",
  "mep_tap_branch_summary_written",
  "redline_visual_gate_passed",
  "mep_tap_branch_cleanup_dry_run_ok",
  "mep_tap_branch_cleanup_applied_ids_present"
];

const MEP_SIZE_TRANSITION_REQUIRED_LIVE_VERIFICATIONS = [
  "mep_size_transition_applied",
  "mep_size_transition_model_write_ids_present",
  "mep_size_transition_projected_point_reported",
  "mep_size_transition_fitting_or_connector_readback",
  "mep_size_transition_size_readback_matches",
  "mep_size_transition_scoped_sizing_readback",
  "post_change_capture_returned",
  "mep_size_transition_summary_written",
  "redline_visual_gate_passed",
  "mep_size_transition_cleanup_dry_run_ok",
  "mep_size_transition_cleanup_applied_ids_present"
];

const MEP_REROUTE_REQUIRED_LIVE_VERIFICATIONS = [
  "mep_reroute_applied",
  "mep_reroute_model_write_ids_present",
  "mep_reroute_split_points_reported",
  "mep_reroute_offset_drop_matches_request",
  "mep_reroute_connection_attempts_verified",
  "mep_reroute_connector_network_audit",
  "post_change_capture_returned",
  "mep_reroute_summary_written",
  "redline_visual_gate_passed",
  "mep_reroute_cleanup_dry_run_ok",
  "mep_reroute_cleanup_applied_ids_present"
];

const DOCUMENTATION_REQUIRED_LIVE_VERIFICATIONS = [
  "schedule_dry_run_ok",
  "schedule_created_id_present",
  "schedule_created_field_count_matches_request",
  "schedule_created_fields_match_request",
  "schedule_config_dry_run_ok",
  "schedule_config_applied_success",
  "schedule_config_target_matches_created_schedule",
  "schedule_config_applied_operations_match_request",
  "schedule_config_fields_match_request",
  "schedule_config_text_value_readback_matches_request",
  "sheet_created_id_present",
  "view_create_dry_run_ok",
  "view_created_id_present",
  "view_template_create_dry_run_ok",
  "view_template_created_id_present",
  "view_placed_on_sheet",
  "view_placed_targets_match_request",
  "detail_curves_dry_run_ok",
  "detail_curves_target_matches_request",
  "detail_curve_ids_created",
  "visibility_dry_run_ok",
  "visibility_applied_success",
  "visibility_target_matches_created_view",
  "visibility_applied_setting_matches_request",
  "category_visibility_dry_run_ok",
  "category_visibility_applied_success",
  "category_visibility_target_matches_request",
  "category_visibility_applied_override_matches_request",
  "category_visibility_revert_dry_run_ok",
  "category_visibility_revert_applied_success",
  "category_visibility_revert_target_matches_request",
  "category_visibility_revert_cleared_override",
  "linked_model_category_visibility_dry_run_ok",
  "linked_model_category_visibility_applied_success",
  "linked_model_category_visibility_target_matches_request",
  "linked_model_category_visibility_applied_override_matches_request",
  "linked_model_category_visibility_revert_dry_run_ok",
  "linked_model_category_visibility_revert_applied_success",
  "linked_model_category_visibility_revert_target_matches_request",
  "linked_model_category_visibility_revert_cleared_override",
  "phase_visibility_dry_run_ok",
  "phase_visibility_applied_success",
  "phase_visibility_target_matches_request",
  "phase_visibility_applied_setting_matches_request",
  "phase_filter_visibility_dry_run_ok",
  "phase_filter_visibility_applied_success",
  "phase_filter_visibility_target_matches_request",
  "phase_filter_visibility_applied_setting_matches_request",
  "phase_filter_visibility_revert_dry_run_ok",
  "phase_filter_visibility_revert_applied_success",
  "phase_filter_visibility_revert_target_matches_request",
  "phase_filter_visibility_revert_setting_matches_original",
  "phase_visibility_revert_dry_run_ok",
  "phase_visibility_revert_applied_success",
  "phase_visibility_revert_target_matches_request",
  "phase_visibility_revert_setting_matches_original",
  "filter_visibility_create_dry_run_ok",
  "filter_visibility_create_applied_success",
  "filter_visibility_create_target_matches_request",
  "filter_visibility_created_filter_id_present",
  "filter_visibility_dry_run_ok",
  "filter_visibility_applied_success",
  "filter_visibility_target_matches_request",
  "filter_visibility_applied_override_matches_request",
  "filter_visibility_revert_dry_run_ok",
  "filter_visibility_revert_applied_success",
  "filter_visibility_revert_target_matches_request",
  "filter_visibility_revert_cleared_override",
  "view_template_visibility_dry_run_ok",
  "view_template_visibility_applied_success",
  "view_template_visibility_target_matches_template",
  "view_template_visibility_applied_setting_matches_request",
  "view_template_category_visibility_dry_run_ok",
  "view_template_category_visibility_applied_success",
  "view_template_category_visibility_target_matches_template",
  "view_template_category_visibility_applied_override_matches_request",
  "view_template_assignment_dry_run_ok",
  "view_template_assignment_applied_success",
  "view_template_assignment_target_matches_created_view",
  "view_template_assignment_setting_matches_request",
  "text_note_created",
  "text_note_target_matches_request",
  "tag_request_present",
  "tag_dry_run_ok",
  "tag_dry_run_targets_match_request",
  "tag_applied_targets_match_request",
  "tag_readback_matches_request",
  "tag_created_count_matches_request",
  "tag_ids_created",
  "cad_link_request_present",
  "cad_link_dry_run_ok",
  "cad_link_applied_id_present",
  "cad_link_source_matches_request",
  "cad_link_sheet_matches_request",
  "cad_link_owner_view_reported",
  "cad_link_viewport_placed_on_sheet",
  "cad_link_viewport_box_sheet_sized",
  "cad_link_owner_view_bbox_reported",
  "cad_link_layer_categories_reported",
  "cad_graphics_override_layer_selected",
  "cad_graphics_override_dry_run_ok",
  "cad_graphics_override_applied_success",
  "cad_graphics_override_target_matches_owner_view",
  "cad_graphics_override_lineweight_matches_request",
  "documentation_post_change_capture_returned",
  "documentation_post_change_capture_targets_created_context",
  "documentation_post_change_capture_view_id_matches_request",
  "documentation_post_change_capture_quality_ok",
  "cad_link_post_change_capture_targets_sheet",
  "documentation_cleanup_dry_run_ok",
  "documentation_cleanup_applied_ids_present",
  "documentation_summary_written"
];

const DOCUMENTATION_TAG_VALUE_REQUIRED_LIVE_VERIFICATIONS = [
  "tag_value_existing_visible_readback_matches_original",
  "tag_value_parameter_original_matches_expected",
  "tag_value_parameter_dry_run_ok",
  "tag_value_parameter_apply_ok",
  "tag_value_parameter_readback_matches_request",
  "tag_value_visible_readback_matches_request",
  "documentation_post_change_capture_returned",
  "documentation_post_change_capture_targets_created_context",
  "documentation_post_change_capture_view_id_matches_request",
  "documentation_post_change_capture_quality_ok",
  "tag_value_revert_dry_run_ok",
  "tag_value_revert_apply_ok",
  "tag_value_revert_parameter_matches_original",
  "tag_value_revert_visible_readback_matches_original",
  "documentation_cleanup_dry_run_ok",
  "documentation_cleanup_applied_ids_present",
  "documentation_summary_written"
];

const DOCUMENTATION_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS = [
  "documentation_post_change_capture_returned",
  "documentation_post_change_capture_targets_created_context",
  "documentation_post_change_capture_view_id_matches_request",
  "documentation_post_change_capture_quality_ok",
  "documentation_final_capture_returned",
  "documentation_final_capture_view_id_matches_request",
  "documentation_final_capture_quality_ok",
  "documentation_cleanup_dry_run_ok",
  "documentation_cleanup_applied_ids_present",
  "documentation_summary_written"
];

const DOCUMENTATION_CATEGORY_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS = [
  "category_visibility_dry_run_ok",
  "category_visibility_applied_success",
  "category_visibility_target_matches_request",
  "category_visibility_applied_override_matches_request",
  "category_visibility_post_apply_capture_returned",
  "category_visibility_post_apply_capture_view_id_matches_request",
  "category_visibility_post_apply_capture_quality_ok",
  "category_visibility_revert_dry_run_ok",
  "category_visibility_revert_applied_success",
  "category_visibility_revert_target_matches_request",
  "category_visibility_revert_cleared_override"
];

const DOCUMENTATION_FILTER_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS = [
  "filter_visibility_dry_run_ok",
  "filter_visibility_applied_success",
  "filter_visibility_target_matches_request",
  "filter_visibility_applied_override_matches_request",
  "filter_visibility_post_apply_capture_returned",
  "filter_visibility_post_apply_capture_view_id_matches_request",
  "filter_visibility_post_apply_capture_quality_ok",
  "filter_visibility_revert_dry_run_ok",
  "filter_visibility_revert_applied_success",
  "filter_visibility_revert_target_matches_request",
  "filter_visibility_revert_cleared_override"
];

const MODEL_EDIT_REQUIRED_LIVE_VERIFICATIONS = [
  "family_instance_created_id_present",
  "family_instance_type_matches_request",
  "move_dry_run_ok",
  "move_applied_ids_present",
  "delete_dry_run_ok",
  "delete_applied_ids_present",
  "revit_link_request_present",
  "revit_link_dry_run_ok",
  "revit_link_instance_created_id_present",
  "revit_link_type_created_id_present",
  "revit_link_source_matches_request",
  "revit_link_pin_matches_request",
  "model_edit_post_change_capture_returned",
  "model_edit_post_change_capture_view_id_matches_request",
  "revit_link_cleanup_dry_run_ok",
  "revit_link_cleanup_applied_ids_present",
  "revit_link_type_cleanup_dry_run_ok",
  "revit_link_type_cleanup_applied_ids_present",
  "model_edit_summary_written"
];

function hasPassedVerification(entry: BenchmarkRevitWorkflowSummary, name: string): boolean {
  return entry.verification_names_passed.includes(name);
}

function missingRedlineEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  const missing = REDLINE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
  if (!REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS.some((name) => hasPassedVerification(entry, name))) {
    missing.push(`one of ${REDLINE_REQUIRED_CIRCUIT_VERIFICATIONS.join("|")}`);
  }
  return missing;
}

function missingMepRouteEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingMepTapBranchEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return MEP_TAP_BRANCH_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingMepSizeTransitionEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return MEP_SIZE_TRANSITION_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingMepRerouteEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return MEP_REROUTE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingRedlineAddEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  const required =
    entry.task_id === "demo_redline_add_family_instance" ||
    entry.task_id === "demo_redline_add_receptacle" ||
    entry.task_id === "demo_redline_add_light" ||
    entry.task_id === "demo_redline_add_mep_accessory"
      ? REDLINE_ADD_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS
      : REDLINE_ADD_TAG_REQUIRED_LIVE_VERIFICATIONS;
  return required.filter((name) => !hasPassedVerification(entry, name));
}

function missingRedlineDeleteEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  const required =
    entry.task_id === "demo_redline_delete_duct_route" ||
    entry.task_id === "demo_redline_delete_pipe_route"
      ? REDLINE_DELETE_MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS
      : entry.task_id === "demo_redline_delete_family_instance" ||
    entry.task_id === "demo_redline_delete_receptacle" ||
    entry.task_id === "demo_redline_delete_light" ||
    entry.task_id === "demo_redline_delete_mep_accessory"
      ? REDLINE_DELETE_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS
      : entry.task_id === "demo_redline_delete_tag"
      ? REDLINE_DELETE_TAG_REQUIRED_LIVE_VERIFICATIONS
      : REDLINE_DELETE_REQUIRED_LIVE_VERIFICATIONS;
  return required.filter((name) => !hasPassedVerification(entry, name));
}

function missingRedlineMoveEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  if (entry.task_id === "demo_redline_move_tag" && hasPassedVerification(entry, "move_redline_existing_tag_present")) {
    return REDLINE_MOVE_EXISTING_TAG_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
  }
  const required =
    entry.task_id === "demo_redline_move_duct_route" ||
    entry.task_id === "demo_redline_move_pipe_route"
      ? REDLINE_MOVE_MEP_ROUTE_REQUIRED_LIVE_VERIFICATIONS
      : entry.task_id === "demo_redline_move_family_instance" ||
    entry.task_id === "demo_redline_move_receptacle" ||
    entry.task_id === "demo_redline_move_light" ||
    entry.task_id === "demo_redline_move_mep_accessory"
      ? REDLINE_MOVE_FAMILY_INSTANCE_REQUIRED_LIVE_VERIFICATIONS
      : entry.task_id === "demo_redline_move_tag"
      ? REDLINE_MOVE_TAG_REQUIRED_LIVE_VERIFICATIONS
      : REDLINE_MOVE_REQUIRED_LIVE_VERIFICATIONS;
  return required.filter((name) => !hasPassedVerification(entry, name));
}

function missingRedlineRotateEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return REDLINE_ROTATE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingRedlineTypeChangeEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return REDLINE_TYPE_CHANGE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingParameterEditEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  const required = entry.task_id === "demo_redline_text_edit_mep_accessory" || entry.task_id === "demo_redline_update_parameter"
    ? PARAMETER_EDIT_ACCESSORY_REQUIRED_LIVE_VERIFICATIONS
    : PARAMETER_EDIT_REQUIRED_LIVE_VERIFICATIONS;
  return required.filter((name) => !hasPassedVerification(entry, name));
}

function missingDocumentationEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  if (hasPassedVerification(entry, "tag_value_parameter_apply_ok") || hasPassedVerification(entry, "tag_value_visible_readback_matches_request")) {
    return DOCUMENTATION_TAG_VALUE_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
  }
  if (hasPassedVerification(entry, "category_visibility_post_apply_capture_returned") || hasPassedVerification(entry, "filter_visibility_post_apply_capture_returned")) {
    const required = [...DOCUMENTATION_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS];
    if (hasPassedVerification(entry, "category_visibility_applied_success")) {
      required.push(...DOCUMENTATION_CATEGORY_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS);
    }
    if (hasPassedVerification(entry, "filter_visibility_applied_success")) {
      required.push(...DOCUMENTATION_FILTER_GRAPHICS_REQUIRED_LIVE_VERIFICATIONS);
    }
    return required.filter((name) => !hasPassedVerification(entry, name));
  }
  return DOCUMENTATION_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function missingModelEditEvidence(entry: BenchmarkRevitWorkflowSummary): string[] {
  return MODEL_EDIT_REQUIRED_LIVE_VERIFICATIONS.filter((name) => !hasPassedVerification(entry, name));
}

function buildDemoReadinessGates(summaries: BenchmarkRevitWorkflowSummary[]): BenchmarkDemoReadinessGate[] {
  return Object.entries(DEMO_READINESS_TARGETS).map(([taskId, target]) => {
    const group = summaries.filter((entry) => entry.task_id === taskId);
    const liveGroup = group.filter((entry) => entry.execution_source === "live");
    const strongEvidenceFailures =
      taskId === "demo_redline_receptacles"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const mepRouteEvidenceFailures =
      taskId === "demo_redline_mep_route" || taskId === "demo_redline_mep_pipe_route"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingMepRouteEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const mepTapBranchEvidenceFailures =
      taskId === "demo_redline_mep_duct_tap_branch" || taskId === "demo_redline_mep_pipe_tap_branch"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingMepTapBranchEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const mepSizeTransitionEvidenceFailures =
      taskId === "demo_redline_mep_duct_size_transition" || taskId === "demo_redline_mep_pipe_size_transition"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingMepSizeTransitionEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const mepRerouteEvidenceFailures =
      taskId === "demo_redline_mep_duct_reroute" || taskId === "demo_redline_mep_pipe_reroute"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingMepRerouteEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const redlineAddEvidenceFailures =
      taskId === "demo_redline_add_tag" ||
      taskId === "demo_redline_add_family_instance" ||
      taskId === "demo_redline_add_receptacle" ||
      taskId === "demo_redline_add_light" ||
      taskId === "demo_redline_add_mep_accessory"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineAddEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const redlineDeleteEvidenceFailures =
      taskId === "demo_redline_delete_text" ||
      taskId === "demo_redline_delete_tag" ||
      taskId === "demo_redline_delete_family_instance" ||
      taskId === "demo_redline_delete_receptacle" ||
      taskId === "demo_redline_delete_light" ||
      taskId === "demo_redline_delete_duct_route" ||
      taskId === "demo_redline_delete_pipe_route" ||
      taskId === "demo_redline_delete_mep_accessory"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineDeleteEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const redlineMoveEvidenceFailures =
      taskId === "demo_redline_move_text" ||
      taskId === "demo_redline_move_tag" ||
      taskId === "demo_redline_move_family_instance" ||
      taskId === "demo_redline_move_receptacle" ||
      taskId === "demo_redline_move_light" ||
      taskId === "demo_redline_move_mep_accessory" ||
      taskId === "demo_redline_move_duct_route" ||
      taskId === "demo_redline_move_pipe_route"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineMoveEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const redlineRotateEvidenceFailures =
      taskId === "demo_redline_rotate_text"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineRotateEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const redlineTypeChangeEvidenceFailures =
      taskId === "demo_redline_type_change_device" || taskId === "demo_redline_type_change_duct" || taskId === "demo_redline_type_change_mep_accessory"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingRedlineTypeChangeEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const parameterEditEvidenceFailures =
      taskId === "demo_parameter_edit" || taskId === "demo_redline_update_parameter" || taskId === "demo_redline_text_edit_mep_accessory"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingParameterEditEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const documentationEvidenceFailures =
      taskId === "demo_documentation_primitives"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingDocumentationEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const modelEditEvidenceFailures =
      taskId === "demo_model_edit_primitives"
        ? liveGroup
            .map((entry) => ({ entry, missing: missingModelEditEvidence(entry) }))
            .filter(({ missing }) => missing.length > 0)
        : [];
    const successes = liveGroup.filter((entry) => entry.success).length;
    const verificationTotal = liveGroup.reduce((sum, entry) => sum + entry.verification_total, 0);
    const verificationPassed = liveGroup.reduce((sum, entry) => sum + entry.verification_passed, 0);
    const successRate = liveGroup.length > 0 ? successes / liveGroup.length : 0;
    const averageElapsed = mean(liveGroup.map((entry) => entry.elapsed_seconds));
    const verificationPassRate = verificationTotal > 0 ? verificationPassed / verificationTotal : 0;
    const passed =
      liveGroup.length >= target.minLiveSamples &&
      successRate >= target.successRate &&
      averageElapsed <= target.elapsedSeconds &&
      verificationPassRate === 1 &&
      strongEvidenceFailures.length === 0 &&
      mepRouteEvidenceFailures.length === 0 &&
      mepTapBranchEvidenceFailures.length === 0 &&
      mepSizeTransitionEvidenceFailures.length === 0 &&
      mepRerouteEvidenceFailures.length === 0 &&
      redlineAddEvidenceFailures.length === 0 &&
      redlineDeleteEvidenceFailures.length === 0 &&
      redlineMoveEvidenceFailures.length === 0 &&
      redlineRotateEvidenceFailures.length === 0 &&
      redlineTypeChangeEvidenceFailures.length === 0 &&
      parameterEditEvidenceFailures.length === 0 &&
      documentationEvidenceFailures.length === 0 &&
      modelEditEvidenceFailures.length === 0;
    const reasons: string[] = [];
    if (group.length === 0) reasons.push("no runs");
    if (group.length > 0 && liveGroup.length === 0) reasons.push("no live Revit runs");
    if (liveGroup.length > 0 && liveGroup.length < target.minLiveSamples) {
      reasons.push(`live runs ${liveGroup.length} < minimum ${target.minLiveSamples}`);
    }
    if (liveGroup.length > 0 || group.length === 0) {
      if (successRate < target.successRate) reasons.push(`success ${pct(successRate)} < target ${pct(target.successRate)}`);
      if (averageElapsed > target.elapsedSeconds) reasons.push(`elapsed ${n(averageElapsed)}s > target ${target.elapsedSeconds}s`);
      if (verificationPassRate < 1) reasons.push(`verification ${pct(verificationPassRate)} < 100.0%`);
    }
    if (strongEvidenceFailures.length > 0) {
      const samples = strongEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline evidence incomplete (${samples.join("; ")})`);
    }
    if (mepRouteEvidenceFailures.length > 0) {
      const samples = mepRouteEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`MEP route evidence incomplete (${samples.join("; ")})`);
    }
    if (mepTapBranchEvidenceFailures.length > 0) {
      const samples = mepTapBranchEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`MEP tap/branch evidence incomplete (${samples.join("; ")})`);
    }
    if (mepSizeTransitionEvidenceFailures.length > 0) {
      const samples = mepSizeTransitionEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`MEP size-transition evidence incomplete (${samples.join("; ")})`);
    }
    if (mepRerouteEvidenceFailures.length > 0) {
      const samples = mepRerouteEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`MEP reroute evidence incomplete (${samples.join("; ")})`);
    }
    if (redlineAddEvidenceFailures.length > 0) {
      const samples = redlineAddEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline add evidence incomplete (${samples.join("; ")})`);
    }
    if (redlineDeleteEvidenceFailures.length > 0) {
      const samples = redlineDeleteEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline delete evidence incomplete (${samples.join("; ")})`);
    }
    if (redlineMoveEvidenceFailures.length > 0) {
      const samples = redlineMoveEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline move evidence incomplete (${samples.join("; ")})`);
    }
    if (redlineRotateEvidenceFailures.length > 0) {
      const samples = redlineRotateEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline rotate evidence incomplete (${samples.join("; ")})`);
    }
    if (redlineTypeChangeEvidenceFailures.length > 0) {
      const samples = redlineTypeChangeEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`redline type-change evidence incomplete (${samples.join("; ")})`);
    }
    if (parameterEditEvidenceFailures.length > 0) {
      const samples = parameterEditEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`parameter edit evidence incomplete (${samples.join("; ")})`);
    }
    if (documentationEvidenceFailures.length > 0) {
      const samples = documentationEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`documentation evidence incomplete (${samples.join("; ")})`);
    }
    if (modelEditEvidenceFailures.length > 0) {
      const samples = modelEditEvidenceFailures
        .slice(0, 3)
        .map(({ entry, missing }) => `${entry.run_id}: missing ${missing.join(", ")}`);
      reasons.push(`model edit evidence incomplete (${samples.join("; ")})`);
    }
    return {
      task_id: taskId,
      workflow: target.workflow,
      sample_size: group.length,
      live_sample_size: liveGroup.length,
      min_live_sample_size: target.minLiveSamples,
      success_rate: successRate,
      target_success_rate: target.successRate,
      average_elapsed_seconds: averageElapsed,
      target_elapsed_seconds: target.elapsedSeconds,
      verification_pass_rate: verificationPassRate,
      passed,
      reason: reasons.length > 0 ? reasons.join("; ") : "passed"
    };
  });
}

export function generateBenchmarkReport(artifactsDir: string, bundle: BenchmarkConfigBundle): BenchmarkReport {
  const runs = loadRunRecords(artifactsDir);
  const revitWorkflowSummaries = loadRevitWorkflowSummaries(runs);
  const demoReadinessGates = buildDemoReadinessGates(revitWorkflowSummaries);
  const baselineRuns = runs.filter((run) => run.config_id === bundle.baseline_config_id);
  const groupedByConfig = new Map<string, BenchmarkRunRecord[]>();
  for (const run of runs) groupedByConfig.set(run.config_id, [...(groupedByConfig.get(run.config_id) ?? []), run]);

  const configAggregates = [...groupedByConfig.entries()]
    .map(([configId, group]) => toConfigAggregate(configId, group, baselineRuns))
    .sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds);
  const taskAggregates = toTaskAggregates(runs);
  const acceptableConfigs = configAggregates.filter((entry) => entry.success_rate >= bundle.acceptable_success_rate_threshold);
  const fastest = configAggregates[0] ?? null;
  const bestTradeoff = [...configAggregates].sort((a, b) => b.latency_normalized_success - a.latency_normalized_success)[0] ?? null;
  const cheapestAcceptable = [...acceptableConfigs].sort((a, b) => a.average_cost_usd - b.average_cost_usd)[0] ?? null;
  const safestFallback = [...configAggregates].sort((a, b) => b.success_rate - a.success_rate)[0] ?? null;
  const fastestExperimental =
    [...configAggregates]
      .filter((entry) => entry.config_id !== bundle.baseline_config_id)
      .sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds)[0] ?? null;

  const lowReasoningTaskFailures = taskAggregates
    .filter((entry) => /mini_(?:low|none)|54mini_(?:low|none)/i.test(entry.config_id) && entry.success_rate < bundle.acceptable_success_rate_threshold)
    .map((entry) => `${entry.task_id} on ${entry.config_id}`);

  const conclusions: string[] = [];
  if (fastest) conclusions.push(`Fastest config overall: ${fastest.config_id}.`);
  if (bestTradeoff) conclusions.push(`Best success/latency tradeoff: ${bestTradeoff.config_id}.`);
  if (cheapestAcceptable) conclusions.push(`Cheapest acceptable config: ${cheapestAcceptable.config_id}.`);
  if (safestFallback) conclusions.push(`Safe fallback config: ${safestFallback.config_id}.`);
  if (lowReasoningTaskFailures.length > 0) {
    conclusions.push(`Tasks that degrade under low/none reasoning: ${lowReasoningTaskFailures.join("; ")}.`);
  }
  const bestSplit = configAggregates.filter((entry) => entry.config_id.includes("split_")).sort((a, b) => a.average_wall_clock_seconds - b.average_wall_clock_seconds)[0] ?? null;
  const baseline = configAggregates.find((entry) => entry.config_id === bundle.baseline_config_id) ?? null;
  if (bestSplit && baseline) {
    const verdict =
      bestSplit.average_wall_clock_seconds < baseline.average_wall_clock_seconds &&
      bestSplit.success_rate >= baseline.success_rate - 0.05
        ? "does"
        : "does not";
    conclusions.push(`Best split config ${verdict} beat the baseline single-loop setup on speed without materially worse success.`);
  }
  if (configAggregates.some((entry) => entry.sample_size < 5)) {
    conclusions.push("Sample sizes are small; treat p95 and recommendation confidence cautiously.");
  }

  return {
    generated_at: nowIso(),
    artifacts_dir: artifactsDir,
    baseline_config_id: bundle.baseline_config_id,
    runs_analyzed: runs.length,
    small_sample_warning: configAggregates.some((entry) => entry.sample_size < 5),
    config_aggregates: configAggregates,
    task_aggregates: taskAggregates,
    revit_workflow_summaries: revitWorkflowSummaries,
    demo_readiness_gates: demoReadinessGates,
    fastest_config_id: fastest?.config_id ?? null,
    best_tradeoff_config_id: bestTradeoff?.config_id ?? null,
    cheapest_acceptable_config_id: cheapestAcceptable?.config_id ?? null,
    safest_fallback_config_id: safestFallback?.config_id ?? null,
    fastest_experimental_config_id: fastestExperimental?.config_id ?? null,
    conclusions
  };
}

export function writeBenchmarkReportArtifacts(
  artifactsDir: string,
  bundle: BenchmarkConfigBundle,
  outputPath?: string
): { report: BenchmarkReport; json_path: string; markdown_path: string } {
  const report = generateBenchmarkReport(artifactsDir, bundle);
  const reportsDir = outputPath ? path.dirname(outputPath) : path.join(artifactsDir, "reports");
  const markdownPath = outputPath || path.join(reportsDir, "summary.md");
  const jsonPath = path.join(reportsDir, "summary.json");

  const latencyRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    String(entry.sample_size),
    n(entry.average_wall_clock_seconds),
    entry.p50_latency_seconds === null ? "n/a" : n(entry.p50_latency_seconds),
    entry.p95_latency_seconds === null ? "n/a" : n(entry.p95_latency_seconds),
    entry.relative_speedup_vs_baseline === null ? "n/a" : `${entry.relative_speedup_vs_baseline.toFixed(2)}x`
  ]);
  const successRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    pct(entry.success_rate),
    pct(entry.partial_rate),
    pct(entry.fail_rate),
    pct(entry.invalid_rate)
  ]);
  const costRows = report.config_aggregates.map((entry) => [
    entry.config_id,
    `$${entry.average_cost_usd.toFixed(4)}`,
    entry.cost_normalized_success.toFixed(4),
    entry.latency_normalized_success.toFixed(4)
  ]);
  const taskRows = report.task_aggregates.map((entry) => [
    entry.task_id,
    entry.config_id,
    String(entry.sample_size),
    pct(entry.success_rate),
    n(entry.average_wall_clock_seconds),
    `$${entry.average_cost_usd.toFixed(4)}`
  ]);
  const revitRows = report.revit_workflow_summaries.map((entry) => [
    entry.task_id,
    entry.config_id,
    entry.workflow,
    entry.execution_source,
    entry.success ? "yes" : "no",
    n(entry.elapsed_seconds),
    String(entry.tool_calls),
    String(entry.revit_transactions),
    String(entry.computer_use_actions),
    `${entry.verification_passed}/${entry.verification_total}`,
    String(entry.output_artifact_count),
    entry.failure_classification ?? "",
    entry.failure_reason ?? ""
  ]);
  const readinessRows = report.demo_readiness_gates.map((entry) => [
    entry.task_id,
    entry.workflow,
    String(entry.sample_size),
    String(entry.live_sample_size),
    String(entry.min_live_sample_size),
    pct(entry.success_rate),
    pct(entry.target_success_rate),
    n(entry.average_elapsed_seconds),
    String(entry.target_elapsed_seconds),
    pct(entry.verification_pass_rate),
    entry.passed ? "yes" : "no",
    entry.reason
  ]);

  const lines: string[] = [];
  lines.push("# Operator Benchmark Report");
  lines.push("");
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Artifacts: ${artifactsDir}`);
  lines.push(`- Runs analyzed: ${report.runs_analyzed}`);
  lines.push(`- Baseline config: ${report.baseline_config_id}`);
  lines.push(`- Small sample warning: ${report.small_sample_warning ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Leaderboards");
  lines.push("");
  lines.push("### Latency");
  lines.push(markdownTable(["Config", "N", "Avg wall (s)", "p50", "p95", "Speedup vs baseline"], latencyRows));
  lines.push("");
  lines.push("### Success");
  lines.push(markdownTable(["Config", "Success", "Partial", "Fail", "Invalid"], successRows));
  lines.push("");
  lines.push("### Cost");
  lines.push(markdownTable(["Config", "Avg cost", "Cost-normalized success", "Latency-normalized success"], costRows));
  lines.push("");
  lines.push("## Per-Task Comparison");
  lines.push(markdownTable(["Task", "Config", "N", "Success", "Avg wall (s)", "Avg cost"], taskRows));
  lines.push("");
  if (revitRows.length > 0) {
    lines.push("## Revit Workflow Evidence");
    lines.push(markdownTable(
      ["Task", "Config", "Workflow", "Source", "Success", "Elapsed (s)", "Tool calls", "Transactions", "Computer-use", "Verifications", "Artifacts", "Failure class", "Failure"],
      revitRows
    ));
    lines.push("");
  }
  lines.push("## Demo Readiness Gates");
  lines.push(markdownTable(
    ["Task", "Workflow", "N", "Live N", "Min live N", "Success", "Target success", "Avg elapsed (s)", "Target (s)", "Verification", "Passed", "Reason"],
    readinessRows
  ));
  lines.push("");
  lines.push("## Conclusions");
  if (report.conclusions.length === 0) lines.push("- No conclusions available.");
  for (const conclusion of report.conclusions) lines.push(`- ${conclusion}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("- Escalation frequency and retry counts are available in per-run `run.json` and `steps.jsonl`.");
  lines.push("- If sample sizes are below five runs per config, treat ranking differences as directional.");

  writeJsonFile(jsonPath, report);
  writeTextFile(markdownPath, `${lines.join("\n")}\n`);
  return { report, json_path: jsonPath, markdown_path: markdownPath };
}
