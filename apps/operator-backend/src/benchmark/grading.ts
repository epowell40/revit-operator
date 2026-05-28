import path from "node:path";
import { ensureDir, writeTextFile } from "./files.js";
import { loadRunRecords } from "./report.js";

function csvCell(value: string): string {
  const needsQuotes = value.includes(",") || value.includes("\"") || value.includes("\n");
  if (!needsQuotes) return value;
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export function exportManualGradingSheet(artifactsDir: string, outputPath?: string): string {
  const runs = loadRunRecords(artifactsDir).sort((a, b) => a.run_id.localeCompare(b.run_id));
  const rows = [
    [
      "run_id",
      "task_id",
      "config_id",
      "artifact_paths",
      "expected_outcome",
      "observed_outcome_summary",
      "manual_grade_value",
      "manual_grade_notes"
    ],
    ...runs.map((run) => [
      run.run_id,
      run.task_id,
      run.config_id,
      [run.summary_artifact_path, run.steps_artifact_path, run.artifact_dir].join(" | "),
      run.expected_outcome_summary,
      run.observed_outcome_summary,
      run.manual_grade_value ?? "",
      run.manual_grade_notes ?? ""
    ])
  ];
  const csv = rows.map((row) => row.map((value) => csvCell(String(value))).join(",")).join("\n") + "\n";
  const destination = outputPath || path.join(artifactsDir, "grading", "manual_grades.csv");
  ensureDir(path.dirname(destination));
  writeTextFile(destination, csv);
  return destination;
}
