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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstPositiveId(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function mergedRevitWorkflowRequest(args: {
  taskId: string;
  allTasks: BenchmarkTaskDefinition[];
  requestOverridesByTaskId?: Record<string, Record<string, unknown>>;
}): { workflow: string; request: Record<string, unknown> } | null {
  const task = args.allTasks.find((entry) => entry.task_id === args.taskId);
  if (task?.environment.adapter_id !== "revit_workflow") return null;
  const adapterConfig = asRecord(task.adapter_config);
  const workflow = String(adapterConfig.workflow ?? task.environment.metadata?.workflow ?? "").trim();
  const override = asRecord(args.requestOverridesByTaskId?.[args.taskId]);
  const overrideRequest = asRecord(override.request);
  const replacesBaseRequest = parseBool(
    overrideRequest.replaceBaseRequest ??
    overrideRequest.replace_base_request ??
    overrideRequest.graphicsOnly ??
    overrideRequest.graphics_only ??
    overrideRequest.documentationGraphicsOnly ??
    overrideRequest.documentation_graphics_only
  ) === true;
  return {
    workflow,
    request: replacesBaseRequest ? overrideRequest : {
      ...asRecord(adapterConfig.request),
      ...overrideRequest
    }
  };
}

export function textNoteReplaceDryRunProbeRequest(args: {
  taskIds: string[];
  allTasks: BenchmarkTaskDefinition[];
  requestOverridesByTaskId?: Record<string, Record<string, unknown>>;
}): Record<string, unknown> | undefined {
  for (const taskId of args.taskIds) {
    const merged = mergedRevitWorkflowRequest({ taskId, allTasks: args.allTasks, requestOverridesByTaskId: args.requestOverridesByTaskId });
    if (!merged || merged.workflow !== "documentation_primitives") continue;
    const textNote = asRecord(merged.request.textNote ?? merged.request.text_note);
    const editExisting = parseBool(textNote.editExisting ?? textNote.edit_existing) === true;
    const elementId = firstPositiveId(textNote.textNoteId, textNote.text_note_id, textNote.elementId, textNote.element_id);
    const newText = firstNonEmptyString(textNote.newText, textNote.new_text, textNote.replacementText, textNote.replacement_text, textNote.text, merged.request.text);
    if (!editExisting || elementId === null || !newText) continue;
    return {
      elementId,
      newText,
      dryRun: true,
      apply: false
    };
  }
  return undefined;
}

export function requiredLiveRevitEndpointPaths(args: {
  taskIds: string[];
  allTasks: BenchmarkTaskDefinition[];
  requestOverridesByTaskId?: Record<string, Record<string, unknown>>;
}): string[] {
  const paths = new Set<string>(["/revit/context"]);
  for (const taskId of args.taskIds) {
    const merged = mergedRevitWorkflowRequest({ taskId, allTasks: args.allTasks, requestOverridesByTaskId: args.requestOverridesByTaskId });
    if (!merged) continue;
    const { workflow, request } = merged;

    if (workflow === "documentation_primitives") {
      if (parseBool(request.graphicsOnly ?? request.graphics_only ?? request.documentationGraphicsOnly ?? request.documentation_graphics_only) === true) {
        paths.add("/revit/export-image");
        paths.add("/revit/visibility");
        continue;
      }
      paths.add("/revit/export-image");
      if (Object.keys(asRecord(request.cadLink ?? request.cadImport ?? request.linkCad)).length > 0) {
        paths.add("/revit/link-cad");
      }
      if (Object.keys(asRecord(request.cadGraphicsOverride ?? request.cadLayerOverride ?? request.cadVisibility)).length > 0) {
        paths.add("/revit/visibility");
      }
      const schedule = asRecord(request.schedule);
      if (parseBool(schedule.editExistingValue ?? schedule.edit_existing_value ?? schedule.editExisting ?? schedule.edit_existing) === true) {
        paths.add("/revit/get-parameters");
        paths.add("/revit/set-parameter");
        paths.add("/revit/export-schedule-csv");
      }
      const tag = asRecord(request.tag);
      if (parseBool(tag.editExistingValue ?? tag.edit_existing_value ?? tag.editExisting ?? tag.edit_existing) === true) {
        paths.add("/revit/export-visible-elements");
        paths.add("/revit/get-parameters");
        paths.add("/revit/set-parameter");
      }
      const textNote = asRecord(request.textNote ?? request.text_note);
      const editsExistingTextNote = parseBool(textNote.editExisting ?? textNote.edit_existing) === true
        || firstPositiveId(textNote.textNoteId, textNote.text_note_id, textNote.elementId, textNote.element_id) !== null;
      if (editsExistingTextNote) {
        paths.add("/revit/find-text-notes");
        paths.add("/revit/replace-text-note");
      }
    }
    if (workflow === "parameter_edit" || workflow === "redline_update_parameter") {
      paths.add("/revit/get-parameters");
      paths.add("/revit/set-parameter");
      if (parseBool(request.visualVerify ?? request.visual_verify) === true) {
        paths.add("/revit/export-image");
      }
    }
    if (workflow === "redline_mep_size_transition") {
      paths.add("/revit/reroute-mep-route-segment");
      if (Object.keys(asRecord(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route)).length > 0) {
        paths.add("/revit/create-mep-route");
      }
      if (parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true) {
        paths.add("/revit/delete");
      }
    }
    if (workflow === "redline_mep_route") {
      paths.add("/revit/mep-route-workflow");
      if (parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true) {
        paths.add("/revit/delete");
      }
    }
    if (workflow === "redline_mep_reroute") {
      paths.add("/revit/reroute-mep-route-segment");
      if (Object.keys(asRecord(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route)).length > 0) {
        paths.add("/revit/create-mep-route");
      }
      if (parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true) {
        paths.add("/revit/delete");
      }
    }
    if (workflow === "redline_mep_tap_branch") {
      if (parseBool(request.branchNetworkWorkflow ?? request.branch_network_workflow ?? request.useBranchNetworkWorkflow) === true) {
        paths.add("/revit/mep-branch-network-workflow");
      } else {
        paths.add("/revit/connect-mep-branch");
      }
      if (parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true) {
        paths.add("/revit/delete");
      }
    }
    if (workflow === "redline_add") {
      const targetKind = String(request.targetKind ?? request.target_kind ?? "").trim().toLowerCase();
      if (targetKind === "tag" || Object.keys(asRecord(request.tag)).length > 0) {
        paths.add("/revit/tag-elements");
      }
      if (targetKind === "family_instance" || Object.keys(asRecord(request.familyInstance ?? request.family_instance)).length > 0) {
        paths.add("/revit/create-family-instance");
      }
      if (parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true) {
        paths.add("/revit/delete");
      }
    }
    if (workflow === "redline_delete") {
      const targetKind = String(request.targetKind ?? request.target_kind ?? "").trim().toLowerCase();
      const normalizedTargetKind = targetKind.replace(/[\s-]+/g, "_");
      if (targetKind === "tag" || Object.keys(asRecord(request.tag)).length > 0) {
        paths.add("/revit/tag-elements");
      }
      if (targetKind === "family_instance" || Object.keys(asRecord(request.familyInstance ?? request.family_instance)).length > 0) {
        paths.add("/revit/create-family-instance");
      }
      if (normalizedTargetKind === "duct_route" || normalizedTargetKind === "pipe_route" || normalizedTargetKind === "mep_route") {
        const existingTarget = asRecord(request.existingTarget ?? request.existing_target ?? request.targetElement ?? request.target_element);
        const existingIds = [
          existingTarget.elementIds,
          existingTarget.element_ids,
          existingTarget.ids,
          existingTarget.elementId,
          existingTarget.element_id,
          request.targetElementIds,
          request.target_element_ids
        ].flatMap((value) => Array.isArray(value) ? value : value === undefined ? [] : [value]);
        if (existingIds.length === 0) paths.add("/revit/mep-route-workflow");
      }
      paths.add("/revit/export-visible-elements");
      paths.add("/revit/delete");
    }
    if (workflow === "redline_move") {
      paths.add("/revit/export-visible-elements");
      paths.add("/revit/move-elements");
    }
    if (workflow === "redline_type_change") {
      paths.add("/revit/change-element-type");
      if (parseBool(request.visualVerify ?? request.visual_verify) === true) {
        paths.add("/revit/export-image");
      }
    }
  }
  return Array.from(paths).sort();
}

export function selectedTasksRequireWriteGrant(args: {
  taskIds: string[];
  allTasks: BenchmarkTaskDefinition[];
  requestOverridesByTaskId?: Record<string, Record<string, unknown>>;
}): boolean {
  const mutatingWorkflows = new Set([
    "documentation_primitives",
    "model_edit_primitives",
    "parameter_edit",
    "redline_update_parameter",
    "redline_add",
    "redline_delete",
    "redline_move",
    "redline_mep_route",
    "redline_mep_reroute",
    "redline_mep_size_transition",
    "redline_mep_tap_branch",
    "redline_receptacles",
    "redline_rotate",
    "redline_type_change"
  ]);

  return args.taskIds.some((taskId) => {
    const task = args.allTasks.find((entry) => entry.task_id === taskId);
    if (task?.environment.adapter_id !== "revit_workflow") return false;
    const adapterConfig = asRecord(task.adapter_config);
    const workflow = String(adapterConfig.workflow ?? task.environment.metadata?.workflow ?? "").trim();
    if (mutatingWorkflows.has(workflow)) return true;

    const override = asRecord(args.requestOverridesByTaskId?.[taskId]);
    const request = {
      ...asRecord(adapterConfig.request),
      ...asRecord(override.request)
    };
    return parseBool(request.apply) === true || parseBool(request.cleanupCreatedElements ?? request.cleanup_created_elements) === true;
  });
}

