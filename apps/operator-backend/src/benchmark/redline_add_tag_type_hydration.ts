import fs from "node:fs";
import path from "node:path";
import { writeJsonFile } from "./files.js";

type JsonMap = Record<string, unknown>;

export type TagTypeCandidate = {
  id: number;
  name: string;
  familyName: string;
  category: string;
};

export type AddTagTypeDiscovery = (category: string) => Promise<unknown[]>;

export type AddTagHydrationTaskResult = {
  task_id: string;
  hydrated: boolean;
  skipped: boolean;
  category_candidates: string[];
  selected_type?: TagTypeCandidate;
  filled_paths: string[];
  warnings: string[];
};

export type AddTagHydrationResult = {
  ok: boolean;
  input_path: string;
  output_path: string;
  hydrated_count: number;
  skipped_count: number;
  task_results: AddTagHydrationTaskResult[];
};

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

function hasTagTypeEvidence(tag: JsonMap): boolean {
  return positiveNumber(tag.tagTypeId ?? tag.tag_type_id ?? tag.typeId ?? tag.type_id) !== null ||
    Boolean(text(tag.tagTypeName ?? tag.tag_type_name ?? tag.typeName ?? tag.type_name));
}

export function inferAddTagTypeCategories(tag: JsonMap): string[] {
  const haystack = [
    tag.requestedTagKindHint,
    tag.requested_tag_kind_hint,
    tag.tagKind,
    tag.tag_kind,
    tag.targetCategory,
    tag.target_category,
    tag.elementCategory,
    tag.element_category,
    tag.category,
    tag.tagTypeName,
    tag.tag_type_name
  ].map(text).join(" ").toLowerCase();

  const categories: string[] = [];
  const push = (category: string) => {
    if (!categories.includes(category)) categories.push(category);
  };

  if (/\b(space|mep space|spaces)\b/.test(haystack)) push("OST_MEPSpaceTags");
  if (/\b(room|rooms)\b/.test(haystack)) push("OST_RoomTags");
  if (/\b(duct|ducts|ductwork)\b/.test(haystack)) push("OST_DuctTags");
  if (/\b(pipe|pipes|piping|plumbing)\b/.test(haystack)) push("OST_PipeTags");
  if (/\b(mechanical equipment|equipment|vav|hru|ahu|fan)\b/.test(haystack)) push("OST_MechanicalEquipmentTags");

  for (const fallback of [
    "OST_MEPSpaceTags",
    "OST_RoomTags",
    "OST_DuctTags",
    "OST_PipeTags",
    "OST_MechanicalEquipmentTags"
  ]) {
    push(fallback);
  }

  return categories;
}

function scoreCandidate(candidate: TagTypeCandidate, tag: JsonMap): number {
  const requested = text(tag.requestedTagKindHint ?? tag.requested_tag_kind_hint ?? tag.tagKind ?? tag.tag_kind)
    .toLowerCase()
    .replace(/\btags\b/g, "tag")
    .replace(/\s+/g, " ")
    .trim();
  if (!requested) return 1;
  const candidateText = `${candidate.name} ${candidate.familyName} ${candidate.category}`.toLowerCase();
  if (candidateText.includes(requested)) return 100;
  const tokens = requested.split(/\s+/).filter((token) => token.length > 2);
  return tokens.reduce((score, token) => score + (candidateText.includes(token) ? 10 : 0), 0);
}

export function chooseTagTypeCandidate(candidates: TagTypeCandidate[], tag: JsonMap): TagTypeCandidate | null {
  if (candidates.length === 0) return null;
  const scored = candidates
    .map((candidate, index) => ({ candidate, score: scoreCandidate(candidate, tag), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0];
  if (!best) return null;
  if (best.score > 0 || candidates.length === 1) return best.candidate;
  return null;
}

function normalizeCandidate(entry: unknown): TagTypeCandidate | null {
  const obj = asObject(entry);
  const id = positiveNumber(obj.id ?? obj.typeId ?? obj.type_id);
  const name = text(obj.name ?? obj.typeName ?? obj.type_name);
  const familyName = text(obj.familyName ?? obj.family_name);
  const category = text(obj.category);
  if (id === null || !name) return null;
  return { id, name, familyName, category };
}

async function hydrateTask(taskId: string, task: JsonMap, discoverTypes: AddTagTypeDiscovery): Promise<AddTagHydrationTaskResult> {
  const request = asObject(task.request ?? task);
  if (taskId !== "demo_redline_add_tag") {
    return {
      task_id: taskId,
      hydrated: false,
      skipped: true,
      category_candidates: [],
      filled_paths: [],
      warnings: ["not a demo_redline_add_tag task"]
    };
  }

  const tag = asObject(request.tag);
  if (Object.keys(tag).length === 0) {
    return {
      task_id: taskId,
      hydrated: false,
      skipped: true,
      category_candidates: [],
      filled_paths: [],
      warnings: ["request.tag is missing"]
    };
  }

  if (hasTagTypeEvidence(tag)) {
    return {
      task_id: taskId,
      hydrated: false,
      skipped: true,
      category_candidates: [],
      filled_paths: [],
      warnings: ["tag already has tagTypeId or tagTypeName"]
    };
  }

  const categoryCandidates = inferAddTagTypeCategories(tag);
  const warnings: string[] = [];
  for (const category of categoryCandidates) {
    let candidates: TagTypeCandidate[] = [];
    try {
      candidates = (await discoverTypes(category)).map(normalizeCandidate).filter((entry): entry is TagTypeCandidate => entry !== null);
    } catch (error) {
      warnings.push(`${category}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const selected = chooseTagTypeCandidate(candidates, tag);
    if (!selected) continue;

    tag.tagTypeId = selected.id;
    tag.tagTypeName = selected.name;
    request.tag = tag;
    if (Object.prototype.hasOwnProperty.call(task, "request")) task.request = request;

    const hydration = asObject(task.live_context_hydration);
    const filledPaths = Array.isArray(hydration.filled_paths)
      ? hydration.filled_paths.map(String)
      : [];
    for (const filledPath of ["request.tag.tagTypeId", "request.tag.tagTypeName"]) {
      if (!filledPaths.includes(filledPath)) filledPaths.push(filledPath);
    }
    task.live_context_hydration = {
      ...hydration,
      source: "/revit/list-element-types",
      filled_paths: filledPaths,
      selected_tag_type: selected,
      category_candidates: categoryCandidates,
      warnings
    };

    return {
      task_id: taskId,
      hydrated: true,
      skipped: false,
      category_candidates: categoryCandidates,
      selected_type: selected,
      filled_paths: ["request.tag.tagTypeId", "request.tag.tagTypeName"],
      warnings
    };
  }

  return {
    task_id: taskId,
    hydrated: false,
    skipped: false,
    category_candidates: categoryCandidates,
    filled_paths: [],
    warnings: warnings.length > 0 ? warnings : ["no compatible tag type found"]
  };
}

export async function hydrateRedlineAddTagTypes(input: {
  inputPath: string;
  outputPath: string;
  discoverTypes: AddTagTypeDiscovery;
}): Promise<AddTagHydrationResult> {
  const inputPath = path.resolve(input.inputPath);
  const outputPath = path.resolve(input.outputPath);
  const root = JSON.parse(fs.readFileSync(inputPath, "utf8")) as JsonMap;
  const tasks = asObject(root.tasks);
  const taskResults: AddTagHydrationTaskResult[] = [];

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
