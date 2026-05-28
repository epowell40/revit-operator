import type { BenchmarkTaskDefinition } from "./types.js";

function parseBool(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

export function selectedTasksNeedLiveRevitPreflight(args: {
  taskIds: string[];
  allTasks: BenchmarkTaskDefinition[];
  useMocksEnv?: string;
}): boolean {
  const envOverride = parseBool(args.useMocksEnv);
  return args.taskIds.some((taskId) => {
    const task = args.allTasks.find((entry) => entry.task_id === taskId);
    if (task?.environment.adapter_id !== "revit_workflow") return false;
    const adapterConfig = task.adapter_config && typeof task.adapter_config === "object" ? task.adapter_config as Record<string, unknown> : {};
    if (envOverride !== null) return envOverride === false;
    return !adapterConfig.mock;
  });
}

