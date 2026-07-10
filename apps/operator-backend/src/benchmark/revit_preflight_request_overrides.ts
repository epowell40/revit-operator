import fs from "node:fs";
import path from "node:path";
import { assertRunnableRevitWorkflowOverride } from "./environment.js";

export type PreflightFlags = Record<string, string | boolean>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function loadPreflightRequestOverridesByTaskId(
  filePathRaw = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON || "",
  taskIds?: string[]
): Record<string, Record<string, unknown>> {
  const filePath = filePathRaw.trim();
  if (!filePath) return {};

  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Revit benchmark request override file not found: ${fullPath}`);
  const root = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;

  const rootObj = asRecord(root);
  const tasksObj = asRecord(rootObj.tasks);
  const overrides: Record<string, Record<string, unknown>> = {};
  const taskFilter = taskIds && taskIds.length > 0 ? new Set(taskIds) : null;
  const status = String(rootObj.status ?? "");
  if (status === "template_requires_verified_revit_ids" || status === "batch_template_requires_verified_revit_ids") {
    assertRunnableRevitWorkflowOverride(root, fullPath);
  }

  for (const [taskId, value] of Object.entries(tasksObj)) {
    if (taskFilter && !taskFilter.has(taskId)) continue;
    if (Object.keys(asRecord(value)).length > 0) overrides[taskId] = value as Record<string, unknown>;
  }
  for (const [taskId, value] of Object.entries(rootObj)) {
    if (taskId === "tasks") continue;
    if (taskFilter && !taskFilter.has(taskId)) continue;
    if (Object.keys(asRecord(value)).length > 0) overrides[taskId] = value as Record<string, unknown>;
  }

  if (taskFilter) {
    for (const [taskId, value] of Object.entries(overrides)) {
      assertRunnableRevitWorkflowOverride({ tasks: { [taskId]: value } }, `${fullPath}#${taskId}`);
    }
  } else {
    assertRunnableRevitWorkflowOverride(root, fullPath);
  }

  return overrides;
}

export function preflightTaskIdsFromFlags(flags: PreflightFlags, requestOverridesByTaskId: Record<string, Record<string, unknown>>): string[] {
  const tasksFlag = flags.tasks;
  if (typeof tasksFlag === "string" && tasksFlag.trim()) {
    return tasksFlag.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof flags.task === "string" && flags.task.trim()) return [flags.task.trim()];
  return Object.keys(requestOverridesByTaskId);
}

export function loadPreflightRequestOverridesForFlags(
  flags: PreflightFlags,
  filePathRaw = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON || ""
): {
  taskIds: string[];
  requestOverridesByTaskId: Record<string, Record<string, unknown>>;
} {
  const requestedTaskIds = preflightTaskIdsFromFlags(flags, {});
  const requestOverridesByTaskId = loadPreflightRequestOverridesByTaskId(
    filePathRaw,
    requestedTaskIds.length > 0 ? requestedTaskIds : undefined
  );
  return {
    taskIds: requestedTaskIds.length > 0
      ? requestedTaskIds
      : preflightTaskIdsFromFlags(flags, requestOverridesByTaskId),
    requestOverridesByTaskId
  };
}
