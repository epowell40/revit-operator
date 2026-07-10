import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

export type AddFamilyInstanceTypeCandidate = {
  id: number;
  name: string;
  familyName?: string;
  category?: string;
};

export type AddFamilyInstanceTypeDiscovery = (category: string) => Promise<unknown[]>;

export type AddFamilyInstanceHydrationTaskResult = {
  task_id: string;
  hydrated: boolean;
  skipped: boolean;
  category_candidates: string[];
  selected_type?: AddFamilyInstanceTypeCandidate;
  filled_paths: string[];
  warnings: string[];
};

export type AddFamilyInstanceHydrationResult = {
  ok: boolean;
  input_path: string;
  output_path: string;
  hydrated_count: number;
  skipped_count: number;
  task_results: AddFamilyInstanceHydrationTaskResult[];
};

const ADD_FAMILY_INSTANCE_TASKS = new Set([
  "demo_redline_add_mep_accessory",
  "demo_redline_add_family_instance",
  "demo_redline_add_receptacle",
  "demo_redline_add_light"
]);

const PLACEHOLDER_PATTERN = /^__FILL_|^<.*>$|^TODO$/i;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function usableText(value: unknown): string {
  const valueText = text(value);
  return valueText && !PLACEHOLDER_PATTERN.test(valueText) ? valueText : "";
}

function normalized(value: unknown): string {
  return text(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalized(value).split(/\s+/).filter((token) => token.length > 2);
}

function normalizeCandidate(entry: unknown): AddFamilyInstanceTypeCandidate | null {
  const obj = asObject(entry);
  const id = positiveNumber(obj.id ?? obj.typeId ?? obj.type_id);
  const name = text(obj.name ?? obj.typeName ?? obj.type_name ?? obj.symbolName ?? obj.symbol_name);
  if (id === null || !name) return null;
  return {
    id,
    name,
    familyName: text(obj.familyName ?? obj.family_name ?? obj.family) || undefined,
    category: text(obj.category ?? obj.categoryName ?? obj.category_name) || undefined
  };
}

export function inferAddFamilyInstanceTypeCategories(taskId: string, request: JsonMap): string[] {
  const familyInstance = asObject(request.familyInstance ?? request.family_instance ?? request.createFamilyInstance ?? request.create);
  const haystack = [
    taskId,
    request.targetKind,
    request.target_kind,
    request.category,
    request.categoryName,
    familyInstance.familyName,
    familyInstance.family_name,
    familyInstance.symbolName,
    familyInstance.symbol_name,
    familyInstance.typeName,
    familyInstance.type_name,
    familyInstance.requestedAccessoryKind,
    familyInstance.requested_accessory_kind,
    familyInstance.placementBasis,
    familyInstance.placement_basis
  ].map(text).join(" ").toLowerCase();

  const categories: string[] = [];
  const push = (category: string) => {
    if (!categories.includes(category)) categories.push(category);
  };

  if (/\b(duct|damper|balancing|fire smoke|fire damper|air)\b/.test(haystack)) {
    push("OST_DuctAccessory");
  }
  if (/\b(pipe|valve|plumb|piping)\b/.test(haystack)) {
    push("OST_PipeAccessory");
  }
  if (/\b(accessory|mep accessory|damper|valve)\b/.test(haystack)) {
    push("OST_DuctAccessory");
    push("OST_PipeAccessory");
  }
  if (/\b(mechanical equipment|equipment|vav|hru|ahu|fan)\b/.test(haystack)) {
    push("OST_MechanicalEquipment");
    push("Mechanical Equipment");
  }
  if (/\b(receptacle|electrical fixture)\b/.test(haystack)) push("OST_ElectricalFixtures");
  if (/\b(light|lighting)\b/.test(haystack)) push("OST_LightingFixtures");
  if (/\b(generic annotation|annotation)\b/.test(haystack)) push("OST_GenericAnnotation");

  for (const fallback of [
    "OST_DuctAccessory",
    "OST_PipeAccessory",
    "OST_MechanicalEquipment",
    "OST_ElectricalFixtures",
    "OST_LightingFixtures",
    "OST_GenericAnnotation"
  ]) {
    push(fallback);
  }

  return categories;
}

function candidateScore(candidate: AddFamilyInstanceTypeCandidate, request: JsonMap): number {
  const familyInstance = asObject(request.familyInstance ?? request.family_instance ?? request.createFamilyInstance ?? request.create);
  const requested = [
    usableText(familyInstance.symbolName ?? familyInstance.symbol_name ?? familyInstance.typeName ?? familyInstance.type_name),
    usableText(familyInstance.familyName ?? familyInstance.family_name),
    usableText(familyInstance.requestedAccessoryKind ?? familyInstance.requested_accessory_kind),
    usableText(familyInstance.placementBasis ?? familyInstance.placement_basis)
  ].filter(Boolean).join(" ");
  const requestedNorm = normalized(requested);
  const candidateNorm = normalized(`${candidate.name} ${candidate.familyName ?? ""} ${candidate.category ?? ""}`);
  if (!requestedNorm) return 0;
  if (candidateNorm === requestedNorm) return 200;
  if (candidateNorm.includes(requestedNorm) || requestedNorm.includes(normalized(candidate.name))) return 120;
  return tokenize(requestedNorm).reduce((score, token) => score + (candidateNorm.includes(token) ? 15 : 0), 0);
}

export function chooseAddFamilyInstanceTypeCandidate(
  candidates: AddFamilyInstanceTypeCandidate[],
  request: JsonMap
): AddFamilyInstanceTypeCandidate | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((candidate, index) => ({ candidate, score: candidateScore(candidate, request), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.candidate ?? null;
}

async function hydrateTask(
  taskId: string,
  task: JsonMap,
  discoverTypes: AddFamilyInstanceTypeDiscovery
): Promise<AddFamilyInstanceHydrationTaskResult> {
  if (!ADD_FAMILY_INSTANCE_TASKS.has(taskId)) {
    return { task_id: taskId, hydrated: false, skipped: true, category_candidates: [], filled_paths: [], warnings: ["not an add family-instance task"] };
  }

  const request = asObject(task.request ?? task);
  const familyInstance = asObject(request.familyInstance ?? request.family_instance ?? request.createFamilyInstance ?? request.create);
  if (Object.keys(familyInstance).length === 0) {
    return { task_id: taskId, hydrated: false, skipped: true, category_candidates: [], filled_paths: [], warnings: ["request.familyInstance is missing"] };
  }

  const hasFamilyName = Boolean(usableText(familyInstance.familyName ?? familyInstance.family_name));
  const hasSymbolName = Boolean(usableText(familyInstance.symbolName ?? familyInstance.symbol_name ?? familyInstance.typeName ?? familyInstance.type_name));
  if (hasFamilyName && hasSymbolName) {
    return { task_id: taskId, hydrated: false, skipped: true, category_candidates: [], filled_paths: [], warnings: ["familyInstance already has usable familyName and symbolName"] };
  }

  const categoryCandidates = inferAddFamilyInstanceTypeCategories(taskId, request);
  const warnings: string[] = [];
  for (const category of categoryCandidates) {
    let candidates: AddFamilyInstanceTypeCandidate[] = [];
    try {
      candidates = (await discoverTypes(category)).map(normalizeCandidate).filter((entry): entry is AddFamilyInstanceTypeCandidate => entry !== null);
    } catch (error) {
      warnings.push(`${category}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const selected = chooseAddFamilyInstanceTypeCandidate(candidates, request);
    if (!selected) continue;

    const filledPaths: string[] = [];
    if (!hasFamilyName && selected.familyName) {
      familyInstance.familyName = selected.familyName;
      filledPaths.push("request.familyInstance.familyName");
    }
    if (!hasSymbolName) {
      familyInstance.symbolName = selected.name;
      filledPaths.push("request.familyInstance.symbolName");
    }
    if (filledPaths.length === 0) continue;

    request.familyInstance = familyInstance;
    if (Object.prototype.hasOwnProperty.call(task, "request")) task.request = request;
    const hydration = asObject(task.live_context_hydration);
    const existingFilled = Array.isArray(hydration.filled_paths) ? hydration.filled_paths.map(String) : [];
    task.live_context_hydration = {
      ...hydration,
      source: "/revit/list-element-types",
      filled_paths: Array.from(new Set([...existingFilled, ...filledPaths])),
      selected_family_instance_type: selected,
      category_candidates: categoryCandidates,
      warnings
    };

    return {
      task_id: taskId,
      hydrated: true,
      skipped: false,
      category_candidates: categoryCandidates,
      selected_type: selected,
      filled_paths: filledPaths,
      warnings
    };
  }

  return {
    task_id: taskId,
    hydrated: false,
    skipped: false,
    category_candidates: categoryCandidates,
    filled_paths: [],
    warnings: warnings.length > 0 ? warnings : ["no compatible family-instance type found"]
  };
}

export async function hydrateRedlineAddFamilyInstanceTypes(input: {
  inputPath: string;
  outputPath: string;
  discoverTypes: AddFamilyInstanceTypeDiscovery;
}): Promise<AddFamilyInstanceHydrationResult> {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  const root = JSON.parse(fs.readFileSync(inputPath, "utf8")) as JsonMap;
  const tasks = asObject(root.tasks);
  const taskResults: AddFamilyInstanceHydrationTaskResult[] = [];

  for (const [taskId, taskValue] of Object.entries(tasks)) {
    taskResults.push(await hydrateTask(taskId, asObject(taskValue), input.discoverTypes));
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
