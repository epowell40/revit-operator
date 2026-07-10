import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

export type TypeChangeTypeCandidate = {
  id: number;
  name: string;
  familyName?: string;
  category?: string;
};

export type TypeChangeVisibleElement = {
  id: number;
  typeId?: number;
  typeName?: string;
  category?: string;
};

export type TypeChangeTypeDiscovery = (category: string) => Promise<unknown[]>;
export type TypeChangeVisibleElementDiscovery = (viewId: number, elementIds: number[], category?: string) => Promise<unknown>;

export type TypeChangeHydrationTaskResult = {
  task_id: string;
  hydrated: boolean;
  skipped: boolean;
  filled_paths: string[];
  selected_target_type?: TypeChangeTypeCandidate;
  selected_source_element?: TypeChangeVisibleElement;
  warnings: string[];
};

export type TypeChangeHydrationResult = {
  ok: boolean;
  input_path: string;
  output_path: string;
  hydrated_count: number;
  skipped_count: number;
  task_results: TypeChangeHydrationTaskResult[];
};

const TYPE_CHANGE_TASKS = new Set([
  "demo_redline_type_change_duct",
  "demo_redline_type_change_mep_accessory",
  "demo_redline_type_change_device"
]);

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function positiveIds(value: unknown): number[] {
  return Array.isArray(value) ? value.map(positiveInteger).filter((entry): entry is number => entry !== null) : [];
}

function normalized(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTypeCandidate(entry: unknown): TypeChangeTypeCandidate | null {
  const obj = asObject(entry);
  const id = positiveInteger(obj.id ?? obj.typeId ?? obj.type_id);
  const name = text(obj.name ?? obj.typeName ?? obj.type_name);
  if (id === null || !name) return null;
  return {
    id,
    name,
    familyName: text(obj.familyName ?? obj.family_name) || undefined,
    category: text(obj.category) || undefined
  };
}

function visibleItems(body: unknown): unknown[] {
  const obj = asObject(body);
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.elements)) return obj.elements;
  if (Array.isArray(obj.visibleElements)) return obj.visibleElements;
  return [];
}

function normalizeVisibleElement(entry: unknown): TypeChangeVisibleElement | null {
  const obj = asObject(entry);
  const id = positiveInteger(obj.id ?? obj.elementId ?? obj.element_id);
  if (id === null) return null;
  const parameters = asObject(obj.parameters);
  const typeId = positiveInteger(
    obj.typeId ??
    obj.type_id ??
    parameters["Type"] ??
    parameters["Family and Type"] ??
    parameters["Family"]
  );
  return {
    id,
    ...(typeId !== null ? { typeId } : {}),
    typeName: text(obj.typeName ?? obj.type_name ?? obj.name) || undefined,
    category: text(obj.category ?? obj.categoryName ?? obj.category_name ?? obj.builtInCategory) || undefined
  };
}

function chooseTargetType(candidates: TypeChangeTypeCandidate[], requestedTypeName: string): TypeChangeTypeCandidate | null {
  const requested = normalized(requestedTypeName);
  if (!requested) return null;
  const exact = candidates.find((candidate) => normalized(candidate.name) === requested);
  if (exact) return exact;
  const contains = candidates.filter((candidate) => normalized(candidate.name).includes(requested) || requested.includes(normalized(candidate.name)));
  return contains.length === 1 ? contains[0] ?? null : null;
}

async function hydrateTask(
  taskId: string,
  task: JsonMap,
  discoverTypes: TypeChangeTypeDiscovery,
  discoverVisibleElements: TypeChangeVisibleElementDiscovery
): Promise<TypeChangeHydrationTaskResult> {
  if (!TYPE_CHANGE_TASKS.has(taskId)) {
    return { task_id: taskId, hydrated: false, skipped: true, filled_paths: [], warnings: ["not a redline type-change task"] };
  }

  const request = asObject(task.request ?? task);
  const sourceTypeGrounding = asObject(request.sourceTypeGrounding ?? request.source_type_grounding);
  const category = text(request.category);
  const targetTypeId = positiveInteger(request.targetTypeId ?? request.target_type_id ?? request.typeId ?? request.type_id);
  const targetTypeName = text(request.targetTypeName ?? request.target_type_name ?? request.typeName ?? request.type_name);
  const elementIds = positiveIds(request.elementIds ?? request.element_ids ?? request.ids);
  const visualViewId = positiveInteger(request.visualViewId ?? request.visual_view_id ?? request.viewId ?? request.view_id);
  const expectedCurrentTypeId = positiveInteger(sourceTypeGrounding.expectedCurrentTypeId ?? sourceTypeGrounding.expected_current_type_id);
  const expectedCurrentTypeName = text(sourceTypeGrounding.expectedCurrentTypeName ?? sourceTypeGrounding.expected_current_type_name);

  const filledPaths: string[] = [];
  const warnings: string[] = [];
  let selectedTargetType: TypeChangeTypeCandidate | undefined;
  let selectedSourceElement: TypeChangeVisibleElement | undefined;

  if (!category) warnings.push("request.category is required for type discovery");

  if (targetTypeId === null && targetTypeName && category) {
    try {
      const candidates = (await discoverTypes(category)).map(normalizeTypeCandidate).filter((entry): entry is TypeChangeTypeCandidate => entry !== null);
      const selected = chooseTargetType(candidates, targetTypeName);
      if (selected) {
        request.targetTypeId = selected.id;
        request.targetTypeName = selected.name;
        selectedTargetType = selected;
        filledPaths.push("request.targetTypeId");
        if (selected.name !== targetTypeName) filledPaths.push("request.targetTypeName");
      } else {
        warnings.push(`no unique target type match for "${targetTypeName}" in ${category}`);
      }
    } catch (error) {
      warnings.push(`target type discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (expectedCurrentTypeId === null && elementIds.length > 0 && visualViewId !== null) {
    try {
      const visible = visibleItems(await discoverVisibleElements(visualViewId, elementIds, category))
        .map(normalizeVisibleElement)
        .filter((entry): entry is TypeChangeVisibleElement => entry !== null);
      const selected = visible.find((entry) => elementIds.includes(entry.id));
      if (selected?.typeId) {
        if (!expectedCurrentTypeName || normalized(selected.typeName) === normalized(expectedCurrentTypeName)) {
          sourceTypeGrounding.expectedCurrentTypeId = selected.typeId;
          if (selected.typeName && !expectedCurrentTypeName) sourceTypeGrounding.expectedCurrentTypeName = selected.typeName;
          request.sourceTypeGrounding = sourceTypeGrounding;
          selectedSourceElement = selected;
          filledPaths.push("request.sourceTypeGrounding.expectedCurrentTypeId");
          if (selected.typeName && !expectedCurrentTypeName) filledPaths.push("request.sourceTypeGrounding.expectedCurrentTypeName");
        } else {
          warnings.push(`visible element ${selected.id} type "${selected.typeName ?? ""}" did not match expected current type "${expectedCurrentTypeName}"`);
        }
      } else {
        warnings.push(`no visible element type id found for requested ids ${elementIds.join(",")}`);
      }
    } catch (error) {
      warnings.push(`source type discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (elementIds.length <= 0) {
    warnings.push("request.elementIds is required for source type discovery");
  } else if (visualViewId === null) {
    warnings.push("request.visualViewId or request.viewId is required for source type discovery");
  }

  if (filledPaths.length > 0) {
    if (Object.prototype.hasOwnProperty.call(task, "request")) task.request = request;
    const hydration = asObject(task.live_context_hydration);
    const existingFilled = Array.isArray(hydration.filled_paths) ? hydration.filled_paths.map(String) : [];
    task.live_context_hydration = {
      ...hydration,
      source: "/revit/list-element-types + /revit/export-visible-elements + /revit/get-parameters",
      filled_paths: Array.from(new Set([...existingFilled, ...filledPaths])),
      ...(selectedTargetType ? { selected_target_type: selectedTargetType } : {}),
      ...(selectedSourceElement ? { selected_source_element: selectedSourceElement } : {}),
      warnings
    };
  }

  return {
    task_id: taskId,
    hydrated: filledPaths.length > 0,
    skipped: false,
    filled_paths: filledPaths,
    selected_target_type: selectedTargetType,
    selected_source_element: selectedSourceElement,
    warnings
  };
}

export async function hydrateRedlineTypeChangeTypes(input: {
  inputPath: string;
  outputPath: string;
  discoverTypes: TypeChangeTypeDiscovery;
  discoverVisibleElements: TypeChangeVisibleElementDiscovery;
}): Promise<TypeChangeHydrationResult> {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  const root = JSON.parse(fs.readFileSync(inputPath, "utf8")) as JsonMap;
  const tasks = asObject(root.tasks);
  const taskResults: TypeChangeHydrationTaskResult[] = [];

  for (const [taskId, taskValue] of Object.entries(tasks)) {
    taskResults.push(await hydrateTask(taskId, asObject(taskValue), input.discoverTypes, input.discoverVisibleElements));
  }

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
