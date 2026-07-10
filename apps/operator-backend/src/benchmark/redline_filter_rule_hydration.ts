import fs from "node:fs";
import path from "node:path";
import { inferFilterRuleStorageType, normalizedFilterRuleStorageType, positiveInteger } from "./filter_rule_types.js";
import { writeJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

export type FilterRuleHydrationTaskResult = {
  task_id: string;
  hydrated: boolean;
  skipped: boolean;
  filled_paths: string[];
  warnings: string[];
};

export type FilterRuleHydrationResult = {
  ok: boolean;
  input_path: string;
  output_path: string;
  hydrated_count: number;
  skipped_count: number;
  task_results: FilterRuleHydrationTaskResult[];
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hydrateTask(taskId: string, task: JsonMap): FilterRuleHydrationTaskResult {
  const request = asObject(task.request ?? task);
  const filterVisibility = asObject(request.filterVisibility ?? request.viewFilterVisibility);
  const createFilter = asObject(filterVisibility.createFilter ?? filterVisibility.create_filter);
  const filledPaths: string[] = [];
  const warnings: string[] = [];
  if (taskId !== "demo_documentation_primitives") {
    return { task_id: taskId, hydrated: false, skipped: true, filled_paths: [], warnings: ["not a demo_documentation_primitives task"] };
  }
  if (Object.keys(createFilter).length === 0) {
    return { task_id: taskId, hydrated: false, skipped: true, filled_paths: [], warnings: ["request.filterVisibility.createFilter is missing"] };
  }
  const parameterName = createFilter.ruleParameterName ?? createFilter.parameterName ?? createFilter.parameter ?? filterVisibility.ruleParameterName;
  const existingStorageType = text(createFilter.ruleParameterStorageType ?? createFilter.storageType ?? createFilter.parameterStorageType);
  const inferredStorageType = normalizedFilterRuleStorageType(existingStorageType) ?? inferFilterRuleStorageType(parameterName);
  if (!inferredStorageType) {
    warnings.push(`could not infer storage type for filter parameter "${text(parameterName) || "<missing>"}"`);
  } else if (!existingStorageType) {
    createFilter.ruleParameterStorageType = inferredStorageType;
    filledPaths.push("request.filterVisibility.createFilter.ruleParameterStorageType");
  }

  if (inferredStorageType === "element_id") {
    const valueElementId = positiveInteger(createFilter.ruleValueElementId ?? createFilter.rule_value_element_id ?? createFilter.ruleValueId ?? createFilter.valueElementId);
    const numericRuleValue = positiveInteger(createFilter.ruleValue ?? createFilter.value ?? createFilter.equals ?? filterVisibility.ruleValue);
    if (valueElementId !== null && numericRuleValue === null) {
      createFilter.ruleValue = String(valueElementId);
      filledPaths.push("request.filterVisibility.createFilter.ruleValue");
    } else if (valueElementId === null && numericRuleValue === null) {
      warnings.push(`filter parameter "${text(parameterName)}" is ElementId-backed; provide ruleValueElementId from live parameter/value discovery before running`);
    }
  }

  if (filledPaths.length > 0) {
    filterVisibility.createFilter = createFilter;
    request.filterVisibility = filterVisibility;
    if (Object.prototype.hasOwnProperty.call(task, "request")) task.request = request;
    const hydration = asObject(task.live_context_hydration);
    const existingFilled = Array.isArray(hydration.filled_paths) ? hydration.filled_paths.map(String) : [];
    task.live_context_hydration = {
      ...hydration,
      source: "redline-filter-rule-hydration",
      filled_paths: Array.from(new Set([...existingFilled, ...filledPaths])),
      warnings
    };
  }

  return {
    task_id: taskId,
    hydrated: filledPaths.length > 0,
    skipped: false,
    filled_paths: filledPaths,
    warnings
  };
}

export function hydrateRedlineFilterRuleTypes(input: {
  inputPath: string;
  outputPath: string;
}): FilterRuleHydrationResult {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  const root = JSON.parse(fs.readFileSync(inputPath, "utf8")) as JsonMap;
  const tasks = asObject(root.tasks);
  const taskResults = Object.entries(tasks).map(([taskId, taskValue]) => hydrateTask(taskId, asObject(taskValue)));
  writeJsonFile(outputPath, root);
  const hydratedCount = taskResults.filter((result) => result.hydrated).length;
  return {
    ok: hydratedCount > 0,
    input_path: inputPath,
    output_path: outputPath,
    hydrated_count: hydratedCount,
    skipped_count: taskResults.filter((result) => result.skipped).length,
    task_results: taskResults
  };
}
