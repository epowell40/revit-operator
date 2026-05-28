import path from "node:path";
import { benchmarkDataRoot, listJsonFiles, readJsonFile } from "./files.js";
import type { BenchmarkTaskDefinition } from "./types.js";

function tasksDir(): string {
  return path.join(benchmarkDataRoot(), "tasks");
}

function validateTask(task: BenchmarkTaskDefinition): BenchmarkTaskDefinition {
  if (!task?.task_id?.trim()) throw new Error("Task is missing task_id.");
  if (!task?.name?.trim()) throw new Error(`Task '${task.task_id}' is missing name.`);
  if (!task?.environment?.adapter_id?.trim()) {
    throw new Error(`Task '${task.task_id}' is missing environment.adapter_id.`);
  }
  if (!Number.isFinite(task.max_time_seconds) || task.max_time_seconds <= 0) {
    throw new Error(`Task '${task.task_id}' is missing max_time_seconds.`);
  }
  if (!Number.isFinite(task.max_steps) || task.max_steps <= 0) {
    throw new Error(`Task '${task.task_id}' is missing max_steps.`);
  }
  return {
    ...task,
    setup_instructions: Array.isArray(task.setup_instructions) ? task.setup_instructions.map(String) : [],
    success_criteria: Array.isArray(task.success_criteria) ? task.success_criteria.map(String) : [],
    failure_criteria: Array.isArray(task.failure_criteria) ? task.failure_criteria.map(String) : [],
    grader_notes: Array.isArray(task.grader_notes) ? task.grader_notes.map(String) : [],
    tags: Array.isArray(task.tags) ? task.tags.map(String) : [],
    optional_cleanup_steps: Array.isArray(task.optional_cleanup_steps) ? task.optional_cleanup_steps.map(String) : []
  };
}

export function loadBenchmarkTasks(): BenchmarkTaskDefinition[] {
  return listJsonFiles(tasksDir()).map((filePath) => validateTask(readJsonFile<BenchmarkTaskDefinition>(filePath)));
}

export function getTaskById(taskId: string, tasks: BenchmarkTaskDefinition[]): BenchmarkTaskDefinition {
  const task = tasks.find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`Unknown benchmark task '${taskId}'.`);
  return task;
}
