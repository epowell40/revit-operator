import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ensureDir, writeJsonFile } from "./files.js";
import {
  filterParameterLooksElementId,
  filterRuleOperatorAllowedForStorageType,
  normalizedFilterRuleStorageType,
  positiveInteger
} from "./filter_rule_types.js";
import { runRevitDemoWorkflow } from "./revit_workflows.js";
import type {
  BenchmarkAction,
  BenchmarkActionResult,
  BenchmarkEnvironmentAdapter,
  BenchmarkEnvironmentRunContext,
  BenchmarkEnvironmentSession,
  BenchmarkObservation,
  BenchmarkTaskDefinition
} from "./types.js";

type ScriptedStepDefinition = {
  accepted_action_types: string[];
  target_contains?: string[];
  resulting_state_summary: string;
  action_result_summary: string;
  ambiguous?: boolean;
  material_deviation?: boolean;
  high_impact?: boolean;
  irreversible?: boolean;
};

type ScriptedAdapterConfig = {
  initial_state_summary: string;
  completion_state_summary?: string;
  mismatch_state_summary?: string;
  steps: ScriptedStepDefinition[];
};

function normalizeScriptedConfig(task: BenchmarkTaskDefinition): ScriptedAdapterConfig {
  const raw = task.adapter_config && typeof task.adapter_config === "object" ? task.adapter_config : {};
  const source = raw as Record<string, unknown>;
  const steps: ScriptedStepDefinition[] = [];
  if (Array.isArray(source.steps)) {
    for (const entry of source.steps as unknown[]) {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const resultingStateSummary = String(row.resulting_state_summary ?? "").trim();
      const actionResultSummary = String(row.action_result_summary ?? "").trim();
      if (!resultingStateSummary || !actionResultSummary) continue;
      steps.push({
        accepted_action_types: Array.isArray(row.accepted_action_types)
          ? row.accepted_action_types.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
          : [],
        target_contains: Array.isArray(row.target_contains)
          ? row.target_contains.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
          : undefined,
        resulting_state_summary: resultingStateSummary,
        action_result_summary: actionResultSummary,
        ambiguous: Boolean(row.ambiguous),
        material_deviation: Boolean(row.material_deviation),
        high_impact: Boolean(row.high_impact),
        irreversible: Boolean(row.irreversible)
      });
    }
  }

  return {
    initial_state_summary: String(source.initial_state_summary ?? "Application home screen is visible.").trim(),
    completion_state_summary: String(source.completion_state_summary ?? "Task goal is visibly complete.").trim(),
    mismatch_state_summary: String(
      source.mismatch_state_summary ??
        "The UI did not change as expected because the action did not match the scripted step."
    ).trim(),
    steps
  };
}

class ScriptedDemoSession implements BenchmarkEnvironmentSession {
  private currentState: string;
  private nextStepIndex = 0;
  private readonly observationsDir: string;
  private readonly config: ScriptedAdapterConfig;

  constructor(task: BenchmarkTaskDefinition, runContext: BenchmarkEnvironmentRunContext) {
    this.config = normalizeScriptedConfig(task);
    this.currentState = this.config.initial_state_summary;
    this.observationsDir = ensureDir(runContext.observations_dir);
  }

  private writeObservation(label: string, summary: string): string {
    const filePath = path.join(
      this.observationsDir,
      `${String(this.nextStepIndex).padStart(2, "0")}_${label}.json`
    );
    writeJsonFile(filePath, { visible_state_summary: summary });
    return filePath;
  }

  async getInitialObservation(): Promise<BenchmarkObservation> {
    return {
      visible_state_summary: this.currentState,
      observation_artifact_path: this.writeObservation("initial", this.currentState),
      screenshot_artifact_path: null
    };
  }

  isTaskComplete(): boolean {
    return this.nextStepIndex >= this.config.steps.length;
  }

  getObservedOutcomeSummary(): string {
    return this.isTaskComplete() ? this.config.completion_state_summary ?? this.currentState : this.currentState;
  }

  async executeAction(action: BenchmarkAction): Promise<BenchmarkActionResult> {
    const startedAt = performance.now();
    const expected = this.config.steps[this.nextStepIndex];
    if (!expected) {
      const observationPath = this.writeObservation("extra", this.getObservedOutcomeSummary());
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.getObservedOutcomeSummary(),
          observation_artifact_path: observationPath,
          screenshot_artifact_path: null
        },
        action_result_summary: "No scripted steps remained; the action was ignored.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const actionType = action.action_type.trim().toLowerCase();
    const target = action.target.trim().toLowerCase();
    const typeMatches =
      expected.accepted_action_types.length === 0 || expected.accepted_action_types.includes(actionType);
    const targetMatches =
      !expected.target_contains ||
      expected.target_contains.length === 0 ||
      expected.target_contains.some((needle) => target.includes(needle));

    if (typeMatches && targetMatches) {
      this.currentState = expected.resulting_state_summary;
      const observationPath = this.writeObservation(`step_${this.nextStepIndex + 1}`, this.currentState);
      this.nextStepIndex += 1;
      return {
        success: true,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.currentState,
          ambiguous: expected.ambiguous,
          observation_artifact_path: observationPath,
          screenshot_artifact_path: null
        },
        action_result_summary: expected.action_result_summary,
        material_deviation: Boolean(expected.material_deviation),
        high_impact: Boolean(expected.high_impact || action.high_impact),
        irreversible: Boolean(expected.irreversible)
      };
    }

    const mismatchSummary = this.config.mismatch_state_summary ?? this.currentState;
    const observationPath = this.writeObservation(`mismatch_${this.nextStepIndex + 1}`, mismatchSummary);
    return {
      success: false,
      tool_latency_seconds: (performance.now() - startedAt) / 1000,
      observation: {
        visible_state_summary: mismatchSummary,
        observation_artifact_path: observationPath,
        screenshot_artifact_path: null
      },
      action_result_summary: "The action did not match the scripted expectation for the current state.",
      material_deviation: true,
      high_impact: Boolean(action.high_impact),
      irreversible: false
    };
  }
}

class ScriptedDemoAdapter implements BenchmarkEnvironmentAdapter {
  readonly id = "scripted_demo";

  async createSession(
    task: BenchmarkTaskDefinition,
    runContext: BenchmarkEnvironmentRunContext
  ): Promise<BenchmarkEnvironmentSession> {
    return new ScriptedDemoSession(task, runContext);
  }
}

type RevitWorkflowAdapterConfig = {
  initial_state_summary?: string;
};

type JsonMap = Record<string, unknown>;

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonMap) } : {};
}

function objectRows(value: unknown): JsonMap[] {
  return Array.isArray(value) ? value.map(asObject).filter((entry) => Object.keys(entry).length > 0) : [];
}

function positiveIds(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0)
    : [];
}

function boolValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|1|yes)$/i.test(value.trim())) return true;
    if (/^(false|0|no)$/i.test(value.trim())) return false;
  }
  return null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hasFiniteXyPoint(value: unknown): boolean {
  const point = asObject(value);
  return finiteNumber(point.x) !== null && finiteNumber(point.y) !== null;
}

function validPointCount(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => hasFiniteXyPoint(entry)).length : 0;
}

function finitePointPairCount(request: JsonMap, pluralKey: string, snakePluralKey: string, firstKey: string, secondKey: string): number {
  const plural = request[pluralKey] ?? request[snakePluralKey];
  const fromArray = validPointCount(plural);
  if (fromArray >= 2) return fromArray;
  return [request[firstKey], request[secondKey]].filter((entry) => hasFiniteXyPoint(entry)).length;
}

function hasNonzeroVector(value: unknown): boolean {
  const vector = asObject(value);
  const x = finiteNumber(vector.x) ?? 0;
  const y = finiteNumber(vector.y) ?? 0;
  const z = finiteNumber(vector.z) ?? 0;
  return Math.abs(x) + Math.abs(y) + Math.abs(z) > 0;
}

function hasNonzeroOffsetIntent(request: JsonMap): boolean {
  const offsetVector = request.offsetVector ?? request.offset_vector;
  const numericOffset =
    finiteNumber(request.dropFt ?? request.drop_ft) ??
    finiteNumber(request.riseFt ?? request.rise_ft) ??
    finiteNumber(request.offsetFt ?? request.offset_ft) ??
    finiteNumber(request.offsetDistanceFt ?? request.offset_distance_ft);
  return hasNonzeroVector(offsetVector) || (numericOffset !== null && Math.abs(numericOffset) > 0);
}

export function findBenchmarkOverridePlaceholders(value: unknown, prefix = "$"): string[] {
  const paths: string[] = [];
  const placeholderPattern = /__FILL_[A-Z0-9_]+__/;
  const visit = (entry: unknown, currentPath: string): void => {
    if (typeof entry === "string") {
      if (placeholderPattern.test(entry)) paths.push(currentPath);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${currentPath}[${index}]`));
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      visit(child, `${currentPath}.${key}`);
    }
  };
  visit(value, prefix);
  return paths;
}

function requestForOverrideTask(entry: unknown): JsonMap {
  const obj = asObject(entry);
  return Object.prototype.hasOwnProperty.call(obj, "request") ? asObject(obj.request) : obj;
}

function collectOverrideTaskRequests(rootObj: JsonMap): Array<{ taskId: string; request: JsonMap }> {
  const rows: Array<{ taskId: string; request: JsonMap }> = [];
  const tasksObj = asObject(rootObj.tasks);
  for (const [taskId, entry] of Object.entries(tasksObj)) rows.push({ taskId, request: requestForOverrideTask(entry) });
  for (const [taskId, entry] of Object.entries(rootObj)) {
    if (taskId === "tasks") continue;
    if (!/^demo_/.test(taskId)) continue;
    rows.push({ taskId, request: requestForOverrideTask(entry) });
  }
  return rows;
}

function taskReadinessOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  const taskEntries: Array<[string, unknown]> = [
    ...Object.entries(asObject(rootObj.tasks)),
    ...Object.entries(rootObj).filter(([key]) => /^demo_/.test(key))
  ];
  for (const [taskId, entry] of taskEntries) {
    const task = asObject(entry);
    const status = String(task.status ?? "");
    if (task.ready_to_run === false) errors.push(`${taskId}: ready_to_run is false.`);
    if (status === "template_requires_verified_revit_ids" || status === "batch_template_requires_verified_revit_ids") {
      errors.push(`${taskId}: status=${status}.`);
    }
  }
  return errors;
}

function scopedSizingOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (!mepSizeTransitionKind(taskId)) continue;
    const sizingScope = asObject(request.sizingScope ?? request.sizing_scope);
    if (Object.keys(sizingScope).length === 0) continue;
    const elementIds = positiveIds(sizingScope.elementIds ?? sizingScope.element_ids ?? request.sizingScopeElementIds ?? request.sizing_scope_element_ids);
    const engineeringBasis = textValue(sizingScope.engineeringSizingBasis ?? sizingScope.engineering_sizing_basis ?? sizingScope.engineeringBasis ?? request.engineeringSizingBasis ?? request.sizingBasis);
    const readbackRequired = boolValue(sizingScope.perSegmentReadbackRequired ?? sizingScope.per_segment_readback_required);
    if (elementIds.length === 0) errors.push(`${taskId}: sizingScope.elementIds must contain verified positive Revit element ids.`);
    if (!engineeringBasis) errors.push(`${taskId}: sizingScope.engineeringSizingBasis is required for scoped sizing requests.`);
    if (readbackRequired !== true) errors.push(`${taskId}: sizingScope.perSegmentReadbackRequired must be true for scoped sizing requests.`);
  }
  return errors;
}

function mepSizeTransitionKind(taskId: string): "duct" | "pipe" | null {
  if (taskId === "demo_redline_mep_duct_size_transition") return "duct";
  if (taskId === "demo_redline_mep_pipe_size_transition") return "pipe";
  return null;
}

function sizeTransitionOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    const transitionKind = mepSizeTransitionKind(taskId);
    if (!transitionKind) continue;
    const isPipe = transitionKind === "pipe";
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id);
    const hostElementId = positiveNumber(request.hostElementId ?? request.host_element_id ?? request.mainElementId ?? request.main_element_id);
    const createHostRoute = asObject(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route);
    const createsDisposableHostRoute = Object.keys(createHostRoute).length > 0;
    const upstreamSize = textValue(isPipe
      ? request.upstreamPipeSize ?? request.upstream_pipe_size ?? request.upstreamSize
      : request.upstreamDuctSize ?? request.upstream_duct_size ?? request.upstreamSize);
    const downstreamSize = textValue(isPipe
      ? request.downstreamPipeSize ?? request.downstream_pipe_size ?? request.downstreamSize
      : request.downstreamDuctSize ?? request.downstream_duct_size ?? request.downstreamSize);
    const transitionNormalized = finiteNumber(request.transitionNormalized ?? request.transition_normalized);
    const transitionChainage = positiveNumber(request.transitionChainageFt ?? request.transition_chainage_ft);
    const transitionPoint = request.projectedTransitionPoint ?? request.projected_transition_point ?? request.transitionPoint ?? request.transition_point;
    const expectedFitting = textValue(request.expectedFitting ?? request.expected_fitting ?? request.expectedTransitionFitting ?? request.expected_transition_fitting);

    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id.`);
    if (visualViewId === null) errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
    if (hostElementId === null && !createsDisposableHostRoute) errors.push(`${taskId}: hostElementId must be a verified positive Revit duct/pipe element id, unless createHostRoute provides a disposable setup route.`);
    if (createsDisposableHostRoute) {
      const createSize = textValue(isPipe
        ? createHostRoute.pipeSize ?? createHostRoute.pipe_size
        : createHostRoute.ductSize ?? createHostRoute.duct_size);
      if (!createSize) errors.push(`${taskId}: createHostRoute.${isPipe ? "pipeSize" : "ductSize"} is required for disposable host setup.`);
      if (validPointCount(createHostRoute.points) < 2) {
        errors.push(`${taskId}: createHostRoute.points must contain at least two finite x/y route points.`);
      }
    }
    if (!upstreamSize) errors.push(`${taskId}: upstream${isPipe ? "Pipe" : "Duct"}Size is required for before/after size readback.`);
    if (!downstreamSize) errors.push(`${taskId}: downstream${isPipe ? "Pipe" : "Duct"}Size is required for requested size readback.`);
    if (
      (transitionNormalized === null || transitionNormalized < 0 || transitionNormalized > 1) &&
      transitionChainage === null &&
      !hasFiniteXyPoint(transitionPoint)
    ) {
      errors.push(`${taskId}: transitionNormalized, transitionChainageFt, or projectedTransitionPoint must identify the transition location.`);
    }
    if (!expectedFitting) errors.push(`${taskId}: expectedFitting is required for transition/reducer fitting readback.`);
    if (boolValue(request.apply) !== true) errors.push(`${taskId}: apply must be true for a live size-transition benchmark override.`);
    if (boolValue(request.verify) !== true && boolValue(request.verifyConnectorNetwork ?? request.verify_connector_network) !== true) {
      errors.push(`${taskId}: verify or verifyConnectorNetwork must be true for connector/readback evidence.`);
    }
    if (boolValue(request.visualVerify ?? request.visual_verify) !== true) errors.push(`${taskId}: visualVerify must be true for the visual gate.`);
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable transition/fitting cleanup.`);
    }
  }
  return errors;
}

function parameterEditOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (taskId !== "demo_parameter_edit" && taskId !== "demo_redline_update_parameter" && taskId !== "demo_redline_text_edit_mep_accessory") continue;
    const elementIds = positiveIds(request.elementIds ?? request.element_ids);
    const parameterName = textValue(request.parameterName ?? request.parameter_name);
    const hasValue = Object.prototype.hasOwnProperty.call(request, "value");
    const minTargetCount = positiveNumber(request.minTargetCount ?? request.min_target_count);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id ?? request.captureViewId ?? request.viewId ?? request.view_id);
    if (elementIds.length === 0) errors.push(`${taskId}: elementIds must contain verified positive Revit element ids.`);
    if (!parameterName) errors.push(`${taskId}: parameterName is required for bounded parameter readback.`);
    if (!hasValue) errors.push(`${taskId}: value must be provided explicitly, even when clearing a parameter.`);
    if (minTargetCount !== null && minTargetCount > elementIds.length) {
      errors.push(`${taskId}: minTargetCount cannot exceed the explicit verified elementIds count.`);
    }
    if (boolValue(request.readbackRequired ?? request.readback_required) !== true) {
      errors.push(`${taskId}: readbackRequired must be true for parameter readback evidence.`);
    }
    if (boolValue(request.revertAfterVerify ?? request.revert_after_verify) !== true) {
      errors.push(`${taskId}: revertAfterVerify must be true so live parameter edits are cleaned up.`);
    }
    if (taskId === "demo_redline_text_edit_mep_accessory") {
      const grounding = asObject(request.targetGrounding ?? request.target_grounding ?? request.existingTarget ?? request.existing_target);
      const expectedCategory = textValue(grounding.expectedCategory ?? grounding.expected_category ?? grounding.category ?? grounding.categoryName ?? grounding.builtInCategory ?? grounding.built_in_category);
      const expectedFamilyOrType = textValue(grounding.expectedFamilyName ?? grounding.expected_family_name ?? grounding.familyName ?? grounding.family_name) ||
        textValue(grounding.expectedTypeName ?? grounding.expected_type_name ?? grounding.typeName ?? grounding.type_name ?? grounding.symbolName ?? grounding.symbol_name);
      if (!expectedCategory || !/duct|pipe|accessor|damper|ost_/i.test(expectedCategory)) {
        errors.push(`${taskId}: targetGrounding.expectedCategory must identify a duct or pipe accessory category.`);
      }
      if (!expectedFamilyOrType) {
        errors.push(`${taskId}: targetGrounding.expectedFamilyName or expectedTypeName is required to ground the existing accessory target.`);
      }
      if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
        errors.push(`${taskId}: visualVerify must be true for focused post-change proof.`);
      }
      if (visualViewId === null) {
        errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
      }
    } else if (taskId === "demo_redline_update_parameter") {
      if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
        errors.push(`${taskId}: visualVerify must be true for focused post-change proof.`);
      }
      if (visualViewId === null) {
        errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
      }
    }
  }
  return errors;
}

function routeOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (taskId !== "demo_redline_mep_route" && taskId !== "demo_redline_mep_pipe_route") continue;
    const isPipe = taskId === "demo_redline_mep_pipe_route";
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id);
    const size = textValue(isPipe ? request.pipeSize ?? request.pipe_size : request.ductSize ?? request.duct_size);
    const levelName = textValue(request.levelName ?? request.level_name);
    const systemType = textValue(request.systemType ?? request.system_type);
    const endpointGrounding = asObject(request.endpointGrounding ?? request.endpoint_grounding);
    const endpointConnectorIds = positiveIds(endpointGrounding.connectorIds ?? endpointGrounding.connector_ids ?? request.endpointConnectorIds ?? request.endpoint_connector_ids);
    const endpointHostElementIds = positiveIds(endpointGrounding.hostElementIds ?? endpointGrounding.host_element_ids ?? request.endpointHostElementIds ?? request.endpoint_host_element_ids);
    const allowStandalone = boolValue(endpointGrounding.allowOpenEndsForDisposableBenchmark ?? endpointGrounding.allow_open_ends_for_disposable_benchmark ?? request.allowOpenEndsForDisposableBenchmark ?? request.allow_open_ends_for_disposable_benchmark);
    const openEndPolicy = textValue(endpointGrounding.openEndPolicy ?? endpointGrounding.open_end_policy ?? request.openEndPolicy ?? request.open_end_policy);
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id.`);
    if (visualViewId === null) errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
    if (!levelName) errors.push(`${taskId}: levelName is required for a bounded live route request.`);
    if (!systemType) errors.push(`${taskId}: systemType is required for a bounded live route request.`);
    if (!size) errors.push(`${taskId}: ${isPipe ? "pipeSize" : "ductSize"} is required for modeled route readback.`);
    if (validPointCount(request.points) < 2) {
      errors.push(`${taskId}: points must contain at least two finite x/y route points.`);
    }
    if (boolValue(request.apply) !== true) errors.push(`${taskId}: apply must be true for a live route benchmark override.`);
    if (boolValue(request.dryRunFirst ?? request.dry_run_first) !== true) errors.push(`${taskId}: dryRunFirst must be true so route projection is proven before apply.`);
    if (boolValue(request.dryRunPreviewReviewed ?? request.dry_run_preview_reviewed) !== true) errors.push(`${taskId}: dryRunPreviewReviewed must be true after reviewing no-write route projection and size preview.`);
    if (endpointConnectorIds.length < 2 && endpointHostElementIds.length < 1 && allowStandalone !== true) {
      errors.push(`${taskId}: endpointGrounding must provide endpoint connector ids, endpoint host ids, or allowOpenEndsForDisposableBenchmark=true for disposable standalone route tests.`);
    }
    if (allowStandalone === true && !openEndPolicy) {
      errors.push(`${taskId}: endpointGrounding.openEndPolicy must explain why open-ended route geometry is acceptable for this disposable benchmark.`);
    }
    if (boolValue(request.verify) !== true) errors.push(`${taskId}: verify must be true for route readback evidence.`);
    if (boolValue(request.visualVerify ?? request.visual_verify ?? request.routeVisualVerify ?? request.route_visual_verify) !== true) {
      errors.push(`${taskId}: visualVerify must be true for the visual gate.`);
    }
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable route cleanup.`);
    }
  }
  return errors;
}

function routeMutationOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  const routeMutationTaskIds = new Set([
    "demo_redline_delete_duct_route",
    "demo_redline_delete_pipe_route",
    "demo_redline_move_duct_route",
    "demo_redline_move_pipe_route"
  ]);
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (!routeMutationTaskIds.has(taskId)) continue;
    const isPipe = taskId.includes("_pipe_");
    const isMove = taskId.includes("_move_");
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const size = textValue(isPipe ? request.pipeSize ?? request.pipe_size : request.ductSize ?? request.duct_size);
    const levelName = textValue(request.levelName ?? request.level_name);
    const systemType = textValue(request.systemType ?? request.system_type);
    const existingTarget = asObject(request.existingTarget ?? request.existing_target ?? request.targetElement ?? request.target_element);
    const existingTargetIds = Array.from(new Set([
      ...positiveIds(existingTarget.elementIds ?? existingTarget.element_ids ?? existingTarget.ids ?? request.targetElementIds ?? request.target_element_ids),
      ...[existingTarget.elementId, existingTarget.element_id, request.targetElementId, request.target_element_id]
        .map((value) => positiveNumber(value))
        .filter((value): value is number => value !== null)
    ]));
    const deleteExistingRoute =
      !isMove &&
      (existingTargetIds.length > 0 ||
        boolValue(existingTarget.deleteExisting ?? existingTarget.delete_existing ?? request.deleteExistingTarget ?? request.delete_existing_target) === true);
    const moveExistingRoute =
      isMove &&
      (existingTargetIds.length > 0 ||
        boolValue(existingTarget.moveExisting ?? existingTarget.move_existing ?? request.moveExistingTarget ?? request.move_existing_target) === true);
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id.`);
    if (deleteExistingRoute || moveExistingRoute) {
      const expectedKind = textValue(existingTarget.expectedKind ?? existingTarget.expected_kind ?? existingTarget.kind ?? request.kind ?? request.routeKind ?? request.route_kind);
      const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
      const expectedSystemName = textValue(existingTarget.expectedSystemName ?? existingTarget.expected_system_name ?? existingTarget.systemName ?? existingTarget.system_name ?? request.systemType ?? request.system_type);
      if (existingTargetIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds must contain verified existing ${isPipe ? "pipe" : "duct"} route ids.`);
      if (!expectedKind) errors.push(`${taskId}: existingTarget.expectedKind is required to ground the ${isPipe ? "pipe" : "duct"} ${isMove ? "move" : "delete"} target.`);
      if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for route category readback.`);
      if (!expectedSystemName) errors.push(`${taskId}: existingTarget.expectedSystemName is required for route system readback.`);
      if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: existingTarget.readbackRequired must be true for route inventory/readback evidence.`);
      }
      if (boolValue(existingTarget.connectedNetworkAuditRequired ?? existingTarget.connected_network_audit_required ?? request.connectedNetworkAuditRequired ?? request.connected_network_audit_required) !== true) {
        errors.push(`${taskId}: existingTarget.connectedNetworkAuditRequired must be true before reviewing route ${isMove ? "move" : "delete"} impact.`);
      }
      if (deleteExistingRoute && boolValue(request.applyExistingDelete ?? request.apply_existing_delete ?? existingTarget.applyExistingDelete ?? existingTarget.apply_existing_delete) === true) {
        errors.push(`${taskId}: applyExistingDelete is not supported for existing duct/pipe route deletes until a restore-safe live harness is available.`);
      }
      if (moveExistingRoute) {
        if (boolValue(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed) !== true) {
          errors.push(`${taskId}: dryRunPreflightReviewed must be true after reviewing the no-write route move preview.`);
        }
        if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
          errors.push(`${taskId}: visualVerify must be true for post-move and post-revert focused capture evidence.`);
        }
        if (boolValue(request.revertAfterVerify ?? request.revert_after_verify) !== true) {
          errors.push(`${taskId}: revertAfterVerify must be true so existing route moves are restored after verification.`);
        }
      }
      continue;
    }
    if (!levelName) errors.push(`${taskId}: levelName is required for disposable route creation.`);
    if (!systemType) errors.push(`${taskId}: systemType is required for disposable route creation.`);
    if (!size) errors.push(`${taskId}: ${isPipe ? "pipeSize" : "ductSize"} is required for disposable route creation.`);
    if (validPointCount(request.points) < 2) {
      errors.push(`${taskId}: points must contain at least two finite x/y route points for the disposable route.`);
    }
    if (boolValue(request.verify) !== true) errors.push(`${taskId}: verify must be true for disposable route readback evidence.`);
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true so the disposable route is removed after verification.`);
    }
    if (isMove) {
      const move = asObject(request.move ?? request.move_vector);
      const vector = {
        x: finiteNumber(move.vectorX ?? move.vector_x ?? move.x ?? request.vectorX ?? request.vector_x),
        y: finiteNumber(move.vectorY ?? move.vector_y ?? move.y ?? request.vectorY ?? request.vector_y),
        z: finiteNumber(move.vectorZ ?? move.vector_z ?? move.z ?? request.vectorZ ?? request.vector_z)
      };
      if ((vector.x ?? 0) === 0 && (vector.y ?? 0) === 0 && (vector.z ?? 0) === 0) {
        errors.push(`${taskId}: move.vectorX/Y/Z must describe a nonzero model-space movement.`);
      }
    }
  }
  return errors;
}

function typeChangeOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  const typeChangeTaskIds = new Set([
    "demo_redline_type_change_duct",
    "demo_redline_type_change_device",
    "demo_redline_type_change_mep_accessory"
  ]);
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (!typeChangeTaskIds.has(taskId)) continue;
    const elementIds = positiveIds(request.elementIds ?? request.element_ids ?? request.ids);
    const category = textValue(request.category ?? request.builtInCategory ?? request.built_in_category);
    const targetTypeId = positiveNumber(request.targetTypeId ?? request.target_type_id ?? request.typeId ?? request.type_id ?? request.newTypeId ?? request.new_type_id);
    const targetTypeName = textValue(request.targetTypeName ?? request.target_type_name ?? request.typeName ?? request.type_name ?? request.newTypeName ?? request.new_type_name);
    const sourceTypeGrounding = asObject(request.sourceTypeGrounding ?? request.source_type_grounding);
    const sourceFamilyGrounding = asObject(request.sourceFamilyGrounding ?? request.source_family_grounding ?? request.existingTarget ?? request.existing_target);
    const expectedCurrentTypeId = positiveNumber(sourceTypeGrounding.expectedCurrentTypeId ?? sourceTypeGrounding.expected_current_type_id ?? request.expectedCurrentTypeId ?? request.expected_current_type_id ?? request.originalTypeId ?? request.original_type_id);
    const expectedCurrentTypeName = textValue(sourceTypeGrounding.expectedCurrentTypeName ?? sourceTypeGrounding.expected_current_type_name ?? request.expectedCurrentTypeName ?? request.expected_current_type_name ?? request.originalTypeName ?? request.original_type_name);
    const expectedSourceFamilyName = textValue(sourceFamilyGrounding.expectedFamilyName ?? sourceFamilyGrounding.expected_family_name ?? sourceFamilyGrounding.familyName ?? sourceFamilyGrounding.family_name);
    const expectedSourceTypeName = textValue(sourceFamilyGrounding.expectedTypeName ?? sourceFamilyGrounding.expected_type_name ?? sourceFamilyGrounding.typeName ?? sourceFamilyGrounding.type_name);
    const expectedSourceCategory = textValue(sourceFamilyGrounding.expectedCategory ?? sourceFamilyGrounding.expected_category ?? sourceFamilyGrounding.category ?? sourceFamilyGrounding.categoryName ?? sourceFamilyGrounding.builtInCategory ?? sourceFamilyGrounding.built_in_category);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id);
    if (elementIds.length === 0) errors.push(`${taskId}: elementIds must contain verified positive Revit element ids.`);
    if (!category) errors.push(`${taskId}: category is required for bounded type compatibility and readback.`);
    if (targetTypeId === null && !targetTypeName) {
      errors.push(`${taskId}: targetTypeId or targetTypeName must identify the compatible target family/type.`);
    }
    if (boolValue(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed) !== true) {
      errors.push(`${taskId}: dryRunPreflightReviewed must be true after reviewing no-write type compatibility preview.`);
    }
    if (boolValue(request.targetTypeCompatibilityReviewed ?? request.target_type_compatibility_reviewed) !== true) {
      errors.push(`${taskId}: targetTypeCompatibilityReviewed must be true after confirming the target type is compatible with the selected element(s).`);
    }
    if (expectedCurrentTypeId === null && !expectedCurrentTypeName) {
      errors.push(`${taskId}: sourceTypeGrounding must include expectedCurrentTypeId or expectedCurrentTypeName for original-type readback and revert proof.`);
    }
    if (taskId === "demo_redline_type_change_mep_accessory" && (!expectedSourceFamilyName || !expectedSourceTypeName || !expectedSourceCategory)) {
      errors.push(`${taskId}: sourceFamilyGrounding must include expectedFamilyName, expectedTypeName, and expectedCategory for accessory identity readback.`);
    }
    if (visualViewId === null) errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
    if (boolValue(request.visualVerify ?? request.visual_verify) !== true) errors.push(`${taskId}: visualVerify must be true for the visual gate.`);
    if (boolValue(request.revertAfterVerify ?? request.revert_after_verify) !== true) {
      errors.push(`${taskId}: revertAfterVerify must be true so live type-change evidence is cleaned up.`);
    }
  }
  return errors;
}

function redlineAddOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  const addTaskIds = new Set([
    "demo_redline_add_tag",
    "demo_redline_add_family_instance",
    "demo_redline_add_receptacle",
    "demo_redline_add_light",
    "demo_redline_add_mep_accessory"
  ]);
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (!addTaskIds.has(taskId)) continue;
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id for focused capture.`);
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable add-like redline cleanup.`);
    }
    if (taskId === "demo_redline_add_tag") {
      const tag = asObject(request.tag);
      const tagViewId = positiveNumber(tag.viewId ?? tag.view_id ?? request.tagViewId ?? request.tag_view_id);
      const elementIds = positiveIds(tag.elementIds ?? tag.element_ids ?? request.elementIds ?? request.element_ids);
      if (tagViewId === null) errors.push(`${taskId}: tag.viewId must be a verified positive Revit view id for tag creation.`);
      if (elementIds.length === 0) errors.push(`${taskId}: tag.elementIds must contain verified positive taggable Revit element ids.`);
      if (boolValue(tag.readbackRequired ?? tag.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: tag.readbackRequired must be true for tag target/type/value readback.`);
      }
      if (!hasTagTypeEvidence(tag)) {
        errors.push(`${taskId}: tag.tagTypeId or tag.tagTypeName is required from live tag-type discovery before tag creation; requestedTagValueHint/requestedTagKindHint are readback checks, not compatibility proof.`);
      }
      if (boolValue(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed ?? tag.dryRunPreflightReviewed ?? tag.dry_run_preflight_reviewed) !== true) {
        errors.push(`${taskId}: dryRunPreflightReviewed must be true after reviewing the no-write tag creation preview.`);
      }
      continue;
    }
    const familyInstance = asObject(request.familyInstance ?? request.family_instance ?? request.device ?? request.createFamilyInstance ?? request.create);
    const familyName = textValue(familyInstance.familyName ?? familyInstance.family_name ?? request.familyName ?? request.family_name);
    const symbolName = textValue(familyInstance.symbolName ?? familyInstance.symbol_name ?? familyInstance.typeName ?? familyInstance.type_name ?? request.symbolName ?? request.symbol_name);
    const levelName = textValue(familyInstance.levelName ?? familyInstance.level_name ?? request.levelName ?? request.level_name);
    const hostElementId = positiveNumber(familyInstance.hostElementId ?? familyInstance.host_element_id ?? familyInstance.hostId ?? familyInstance.host_id ?? request.hostElementId ?? request.host_element_id);
    const placementBasis = textValue(familyInstance.placementBasis ?? familyInstance.placement_basis ?? request.placementBasis ?? request.placement_basis);
    const allowUnhostedPointPlacement = boolValue(familyInstance.allowUnhostedPointPlacement ?? familyInstance.allow_unhosted_point_placement ?? request.allowUnhostedPointPlacement ?? request.allow_unhosted_point_placement) === true;
    const x = finiteNumber(familyInstance.x ?? familyInstance.X ?? request.x);
    const y = finiteNumber(familyInstance.y ?? familyInstance.Y ?? request.y);
    const z = finiteNumber(familyInstance.z ?? familyInstance.Z ?? request.z);
    if (!familyName) errors.push(`${taskId}: familyInstance.familyName is required for bounded family-instance creation.`);
    if (!symbolName) errors.push(`${taskId}: familyInstance.symbolName or typeName is required for requested type readback.`);
    if (!levelName) errors.push(`${taskId}: familyInstance.levelName is required for bounded placement.`);
    if (taskId === "demo_redline_add_mep_accessory") {
      if (hostElementId === null && !allowUnhostedPointPlacement) {
        errors.push(`${taskId}: familyInstance.hostElementId or allowUnhostedPointPlacement:true is required for accessory placement grounding.`);
      }
      if (!placementBasis) {
        errors.push(`${taskId}: familyInstance.placementBasis is required to document hosted vs verified unhosted accessory placement.`);
      }
    }
    if (x === null || y === null || z === null) {
      errors.push(`${taskId}: familyInstance.x/y/z must contain finite model-space placement coordinates.`);
    }
  }
  return errors;
}

function hasTagTypeEvidence(tag: JsonMap): boolean {
  return positiveNumber(tag.tagTypeId ?? tag.tag_type_id ?? tag.typeId ?? tag.type_id) !== null ||
    Boolean(textValue(tag.tagTypeName ?? tag.tag_type_name ?? tag.typeName ?? tag.type_name));
}

function redlineMutationOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  const textTaskIds = new Set([
    "demo_redline_delete_text",
    "demo_redline_move_text",
    "demo_redline_rotate_text"
  ]);
  const tagTaskIds = new Set([
    "demo_redline_delete_tag",
    "demo_redline_move_tag"
  ]);
  const familyTaskIds = new Set([
    "demo_redline_delete_family_instance",
    "demo_redline_delete_receptacle",
    "demo_redline_delete_light",
    "demo_redline_delete_mep_accessory",
    "demo_redline_move_family_instance",
    "demo_redline_move_receptacle",
    "demo_redline_move_light",
    "demo_redline_move_mep_accessory"
  ]);
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    const isText = textTaskIds.has(taskId);
    const isTag = tagTaskIds.has(taskId);
    const isFamily = familyTaskIds.has(taskId);
    if (!isText && !isTag && !isFamily) continue;
    const isMove = taskId.includes("_move_");
    const isDelete = taskId.includes("_delete_");
    const isRotate = taskId.includes("_rotate_");
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id for focused capture.`);
    const existingTarget = asObject(request.existingTarget ?? request.existing_target ?? request.targetElement ?? request.target_element);
    const existingTargetIds = Array.from(new Set([
      ...positiveIds(existingTarget.elementIds ?? existingTarget.element_ids ?? existingTarget.ids ?? request.targetElementIds ?? request.target_element_ids),
      ...[existingTarget.elementId, existingTarget.element_id, request.targetElementId, request.target_element_id]
        .map((value) => positiveNumber(value))
        .filter((value): value is number => value !== null)
    ]));
    const moveExistingTarget =
      isMove &&
      isFamily &&
      (existingTargetIds.length > 0 ||
        boolValue(existingTarget.moveExisting ?? existingTarget.move_existing ?? request.moveExistingTarget ?? request.move_existing_target) === true);
    const tag = asObject(request.tag);
    const tagIdsFromRequest = positiveIds(tag.existingTagIds ?? tag.existing_tag_ids ?? tag.tagIds ?? tag.tag_ids);
    const moveExistingTagTarget =
      isMove &&
      isTag &&
      (existingTargetIds.length > 0 ||
        tagIdsFromRequest.length > 0 ||
        boolValue(existingTarget.moveExisting ?? existingTarget.move_existing ?? tag.moveExisting ?? tag.move_existing ?? request.moveExistingTarget ?? request.move_existing_target) === true);
    const deleteExistingTarget =
      isDelete &&
      isFamily &&
      (existingTargetIds.length > 0 ||
        boolValue(existingTarget.deleteExisting ?? existingTarget.delete_existing ?? request.deleteExistingTarget ?? request.delete_existing_target) === true);
    const textNote = asObject(request.textNote ?? request.text_note);
    const deleteExistingTextTarget =
      isDelete &&
      isText &&
      (existingTargetIds.length > 0 ||
        positiveNumber(textNote.textNoteId ?? textNote.text_note_id ?? textNote.elementId ?? textNote.element_id ?? request.textNoteId ?? request.text_note_id) !== null ||
        boolValue(existingTarget.deleteExisting ?? existingTarget.delete_existing ?? textNote.deleteExisting ?? textNote.delete_existing ?? request.deleteExistingTarget ?? request.delete_existing_target) === true);
    const deleteExistingTagTarget =
      isDelete &&
      isTag &&
      (existingTargetIds.length > 0 ||
        tagIdsFromRequest.length > 0 ||
        boolValue(existingTarget.deleteExisting ?? existingTarget.delete_existing ?? tag.deleteExisting ?? tag.delete_existing ?? request.deleteExistingTarget ?? request.delete_existing_target) === true);
    if (deleteExistingTextTarget) {
      const textNoteId = positiveNumber(textNote.textNoteId ?? textNote.text_note_id ?? textNote.elementId ?? textNote.element_id ?? request.textNoteId ?? request.text_note_id);
      const textIds = Array.from(new Set([
        ...existingTargetIds,
        ...(textNoteId !== null ? [textNoteId] : [])
      ]));
      const expectedText = textValue(existingTarget.expectedText ?? existingTarget.expected_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? textNote.expectedExistingText ?? textNote.expected_existing_text ?? textNote.text);
      const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
      if (textIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds or textNote.textNoteId must contain verified existing visible TextNote ids.`);
      if (!expectedText) errors.push(`${taskId}: existingTarget.expectedText or textNote.expectedExistingText is required to ground the existing TextNote target.`);
      if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for existing TextNote category readback.`);
      if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? textNote.readbackRequired ?? textNote.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: existingTarget.readbackRequired must be true for existing TextNote inventory/readback evidence.`);
      }
      if (boolValue(request.applyExistingDelete ?? request.apply_existing_delete ?? existingTarget.applyExistingDelete ?? existingTarget.apply_existing_delete) === true) {
        errors.push(`${taskId}: applyExistingDelete is not supported for existing TextNote deletes until a restore-safe live harness is available.`);
      }
      continue;
    }
    if (moveExistingTagTarget) {
      const tagIds = Array.from(new Set([
        ...existingTargetIds,
        ...tagIdsFromRequest
      ]));
      const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
      const expectedText = textValue(existingTarget.expectedTagText ?? existingTarget.expected_tag_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? tag.expectedTagText ?? tag.expectedVisibleText);
      const taggedElementIds = positiveIds(existingTarget.taggedElementIds ?? existingTarget.tagged_element_ids ?? tag.elementIds ?? tag.element_ids ?? request.elementIds ?? request.element_ids);
      if (tagIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds or tag.existingTagIds must contain verified existing visible tag ids.`);
      if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for existing tag category readback.`);
      if (!expectedText && taggedElementIds.length === 0) {
        errors.push(`${taskId}: existingTarget.expectedTagText or tagged element ids are required to ground the existing tag target.`);
      }
      if (boolValue(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed) !== true) {
        errors.push(`${taskId}: dryRunPreflightReviewed must be true after reviewing the no-write move preview.`);
      }
      if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? tag.readbackRequired ?? tag.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: existingTarget.readbackRequired must be true for before/after/final tag inventory evidence.`);
      }
      if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
        errors.push(`${taskId}: visualVerify must be true for post-move and post-revert focused capture evidence.`);
      }
      if (boolValue(request.revertAfterVerify ?? request.revert_after_verify) !== true) {
        errors.push(`${taskId}: revertAfterVerify must be true so existing tag elements are restored after verification.`);
      }
      continue;
    }
    if (deleteExistingTagTarget) {
      const tagIds = Array.from(new Set([
        ...existingTargetIds,
        ...positiveIds(tag.existingTagIds ?? tag.existing_tag_ids ?? tag.tagIds ?? tag.tag_ids)
      ]));
      const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
      const expectedText = textValue(existingTarget.expectedTagText ?? existingTarget.expected_tag_text ?? existingTarget.expectedVisibleText ?? existingTarget.expected_visible_text ?? tag.expectedTagText ?? tag.expectedVisibleText);
      const taggedElementIds = positiveIds(existingTarget.taggedElementIds ?? existingTarget.tagged_element_ids ?? tag.elementIds ?? tag.element_ids ?? request.elementIds ?? request.element_ids);
      if (tagIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds or tag.existingTagIds must contain verified existing visible tag ids.`);
      if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for existing tag category readback.`);
      if (!expectedText && taggedElementIds.length === 0) {
        errors.push(`${taskId}: existingTarget.expectedTagText or tagged element ids are required to ground the existing tag target.`);
      }
      if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? tag.readbackRequired ?? tag.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: existingTarget.readbackRequired must be true for existing tag inventory/readback evidence.`);
      }
      if (boolValue(request.applyExistingDelete ?? request.apply_existing_delete ?? existingTarget.applyExistingDelete ?? existingTarget.apply_existing_delete) === true) {
        errors.push(`${taskId}: applyExistingDelete is not supported for existing tag deletes until a restore-safe live harness is available.`);
      }
      continue;
    }
    if (deleteExistingTarget) {
      const expectedFamilyName = textValue(existingTarget.expectedFamilyName ?? existingTarget.expected_family_name ?? existingTarget.familyName ?? existingTarget.family_name);
      const expectedTypeName = textValue(existingTarget.expectedTypeName ?? existingTarget.expected_type_name ?? existingTarget.typeName ?? existingTarget.type_name);
      const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
      if (existingTargetIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds must contain verified existing family-instance/accessory ids.`);
      if (!expectedFamilyName && !expectedTypeName) {
        errors.push(`${taskId}: existingTarget.expectedFamilyName or expectedTypeName is required to ground the deleted accessory target.`);
      }
      if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for target category readback.`);
      if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
        errors.push(`${taskId}: existingTarget.readbackRequired must be true for before/dry-run inventory evidence.`);
      }
      if (boolValue(request.applyExistingDelete ?? request.apply_existing_delete ?? existingTarget.applyExistingDelete ?? existingTarget.apply_existing_delete) === true) {
        errors.push(`${taskId}: applyExistingDelete is not supported for existing accessory deletes until a restore-safe live harness is available.`);
      }
    }
    if (isMove) {
      const move = asObject(request.move ?? request.move_vector);
      const vector = {
        x: finiteNumber(move.vectorX ?? move.vector_x ?? move.x ?? request.vectorX ?? request.vector_x),
        y: finiteNumber(move.vectorY ?? move.vector_y ?? move.y ?? request.vectorY ?? request.vector_y),
        z: finiteNumber(move.vectorZ ?? move.vector_z ?? move.z ?? request.vectorZ ?? request.vector_z)
      };
      if ((vector.x ?? 0) === 0 && (vector.y ?? 0) === 0 && (vector.z ?? 0) === 0) {
        errors.push(`${taskId}: move.vectorX/Y/Z must describe a nonzero model-space movement.`);
      }
      if (moveExistingTarget) {
        const expectedFamilyName = textValue(existingTarget.expectedFamilyName ?? existingTarget.expected_family_name ?? existingTarget.familyName ?? existingTarget.family_name);
        const expectedTypeName = textValue(existingTarget.expectedTypeName ?? existingTarget.expected_type_name ?? existingTarget.typeName ?? existingTarget.type_name);
        const expectedCategory = textValue(existingTarget.expectedCategory ?? existingTarget.expected_category ?? existingTarget.category ?? existingTarget.builtInCategory ?? existingTarget.built_in_category);
        if (existingTargetIds.length === 0) errors.push(`${taskId}: existingTarget.elementIds must contain verified existing family-instance/accessory ids.`);
        if (!expectedFamilyName && !expectedTypeName) {
          errors.push(`${taskId}: existingTarget.expectedFamilyName or expectedTypeName is required to ground the moved accessory target.`);
        }
        if (!expectedCategory) errors.push(`${taskId}: existingTarget.expectedCategory is required for target category readback.`);
        if (boolValue(request.dryRunPreflightReviewed ?? request.dry_run_preflight_reviewed) !== true) {
          errors.push(`${taskId}: dryRunPreflightReviewed must be true after reviewing the no-write move preview.`);
        }
        if (boolValue(existingTarget.readbackRequired ?? existingTarget.readback_required ?? request.readbackRequired ?? request.readback_required) !== true) {
          errors.push(`${taskId}: existingTarget.readbackRequired must be true for before/after/final inventory evidence.`);
        }
        if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
          errors.push(`${taskId}: visualVerify must be true for post-move and post-revert focused capture evidence.`);
        }
        if (boolValue(request.revertAfterVerify ?? request.revert_after_verify) !== true) {
          errors.push(`${taskId}: revertAfterVerify must be true so existing model elements are restored after verification.`);
        }
      }
    }
    if (isRotate) {
      const rotate = asObject(request.rotate);
      const axis = asObject(rotate.axis);
      const angleDegrees = finiteNumber(rotate.angleDegrees ?? rotate.angle_degrees ?? request.angleDegrees ?? request.angle_degrees);
      const pointX = finiteNumber(axis.pointX ?? axis.point_x ?? request.axisPointX ?? request.axis_point_x);
      const pointY = finiteNumber(axis.pointY ?? axis.point_y ?? request.axisPointY ?? request.axis_point_y);
      if (angleDegrees === null || angleDegrees === 0) errors.push(`${taskId}: rotate.angleDegrees must be a nonzero finite angle.`);
      if (pointX === null || pointY === null) errors.push(`${taskId}: rotate.axis.pointX/Y must contain finite model-space coordinates.`);
    }
    if (isText) {
      const textNote = asObject(request.textNote ?? request.text_note);
      const text = textValue(textNote.text ?? request.text);
      const x = finiteNumber(textNote.x ?? request.x);
      const y = finiteNumber(textNote.y ?? request.y);
      if (!text) errors.push(`${taskId}: textNote.text is required for disposable text-note evidence.`);
      if (x === null || y === null) errors.push(`${taskId}: textNote.x/y must contain finite model-space placement coordinates.`);
      continue;
    }
    if (isTag) {
      const tagViewId = positiveNumber(tag.viewId ?? tag.view_id ?? request.tagViewId ?? request.tag_view_id);
      const elementIds = positiveIds(tag.elementIds ?? tag.element_ids ?? request.elementIds ?? request.element_ids);
      if (tagViewId === null) errors.push(`${taskId}: tag.viewId must be a verified positive Revit view id for tag creation.`);
      if (elementIds.length === 0) errors.push(`${taskId}: tag.elementIds must contain verified positive taggable Revit element ids.`);
      continue;
    }
    if (moveExistingTarget || deleteExistingTarget) continue;
    const familyInstance = asObject(request.familyInstance ?? request.family_instance ?? request.device ?? request.createFamilyInstance ?? request.create);
    const familyName = textValue(familyInstance.familyName ?? familyInstance.family_name ?? request.familyName ?? request.family_name);
    const symbolName = textValue(familyInstance.symbolName ?? familyInstance.symbol_name ?? familyInstance.typeName ?? familyInstance.type_name ?? request.symbolName ?? request.symbol_name);
    const levelName = textValue(familyInstance.levelName ?? familyInstance.level_name ?? request.levelName ?? request.level_name);
    const x = finiteNumber(familyInstance.x ?? familyInstance.X ?? request.x);
    const y = finiteNumber(familyInstance.y ?? familyInstance.Y ?? request.y);
    const z = finiteNumber(familyInstance.z ?? familyInstance.Z ?? request.z);
    if (!familyName) errors.push(`${taskId}: familyInstance.familyName is required for bounded family-instance creation.`);
    if (!symbolName) errors.push(`${taskId}: familyInstance.symbolName or typeName is required for requested type readback.`);
    if (!levelName) errors.push(`${taskId}: familyInstance.levelName is required for bounded placement.`);
    if (x === null || y === null || z === null) {
      errors.push(`${taskId}: familyInstance.x/y/z must contain finite model-space placement coordinates.`);
    }
  }
  return errors;
}

function documentationOperationObject(request: JsonMap, ...keys: string[]): JsonMap {
  for (const key of keys) {
    const obj = asObject(request[key]);
    if (Object.keys(obj).length > 0) return obj;
  }
  return {};
}

function hasAnyDocumentationOperation(request: JsonMap): boolean {
  return [
    "schedule",
    "schedules",
    "scheduleBatch",
    "scheduleSheetLayout",
    "scheduleLayout",
    "configureSchedule",
    "sheet",
    "existingSheet",
    "targetSheet",
    "createView",
    "view",
    "viewTemplate",
    "createViewTemplate",
    "placeView",
    "visibility",
    "categoryVisibility",
    "categoryOverrideVisibility",
    "linkedModelCategoryVisibility",
    "linkedModelVisibility",
    "revitLinkCategoryVisibility",
    "phaseVisibility",
    "viewPhaseVisibility",
    "filterVisibility",
    "viewFilterVisibility",
    "templateVisibility",
    "viewTemplateVisibility",
    "templateCategoryVisibility",
    "viewTemplateCategoryVisibility",
    "templateCategoryOverrideVisibility",
    "applyViewTemplate",
    "viewTemplateAssignment",
    "detailCurves",
    "annotationCurves",
    "textNote",
    "tag",
    "cadLink",
    "cadImport",
    "linkCad",
    "cadReload",
    "reloadCad",
    "cadLinkReload",
    "cadGraphicsOverride",
    "cadLayerOverride",
    "cadVisibility"
  ].some((key) => Object.keys(asObject(request[key])).length > 0);
}

function documentationOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (taskId !== "demo_documentation_primitives") continue;
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const captureViewId = positiveNumber(request.visualViewId ?? request.visual_view_id ?? request.captureViewId ?? request.capture_view_id ?? request.afterCaptureViewId ?? request.after_capture_view_id ?? request.viewId ?? request.view_id);
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view or sheet id for documentation context.`);
    if (captureViewId === null) errors.push(`${taskId}: visualViewId/captureViewId must identify the focused post-change capture target.`);
    if (boolValue(request.visualVerify ?? request.visual_verify) !== true) {
      errors.push(`${taskId}: visualVerify must be true for documentation post-change capture evidence.`);
    }
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable documentation cleanup.`);
    }
    if (!hasAnyDocumentationOperation(request)) {
      errors.push(`${taskId}: at least one executable documentation operation block is required.`);
    }

    if (Object.keys(asObject(request.scaleSpecificGraphics)).length > 0) {
      errors.push(`${taskId}: scaleSpecificGraphics is not executed by documentation_primitives; translate it into categoryVisibility or filterVisibility with verified target/readback fields.`);
    }
    if (Object.keys(asObject(request.linkedModelGraphicsOverride)).length > 0) {
      errors.push(`${taskId}: linkedModelGraphicsOverride is not executed by documentation_primitives; use linkedModelCategoryVisibility with verified linked model, category, and readback fields.`);
    }
    if (Object.keys(asObject(request.phaseGraphics)).length > 0) {
      errors.push(`${taskId}: phaseGraphics is not executed by documentation_primitives; use phaseVisibility for supported phase/phase-filter readback or block linked phase-mapping requests.`);
    }

    const scheduleConfig = documentationOperationObject(request, "schedule");
    const scheduleBatch = asObject(request.scheduleBatch ?? request.schedule_batch);
    const scheduleLayout = asObject(request.scheduleSheetLayout ?? request.schedule_sheet_layout ?? request.scheduleLayout ?? request.schedule_layout);
    const scheduleRows = [
      ...objectRows(request.schedules),
      ...objectRows(scheduleBatch.schedules),
      ...objectRows(scheduleLayout.schedules)
    ];
    if (scheduleRows.length > 0) {
      const layoutSheetId = positiveNumber(scheduleLayout.sheetId ?? scheduleLayout.sheet_id ?? request.sheetId ?? request.sheet_id);
      const layoutSheetNumber = textValue(scheduleLayout.sheetNumber ?? scheduleLayout.sheet_number ?? request.sheetNumber ?? request.sheet_number);
      if (layoutSheetId === null && !layoutSheetNumber) {
        errors.push(`${taskId}: scheduleSheetLayout requires sheetId or sheetNumber for batch schedule placement.`);
      }
      const reflowExisting = boolValue(scheduleLayout.reflowExisting ?? scheduleLayout.reflow_existing ?? scheduleLayout.reflowAfterPlace ?? scheduleLayout.reflow_after_place) === true;
      const reflowRows = [
        ...objectRows(scheduleLayout.reflowPlacements),
        ...objectRows(scheduleLayout.reflow_placements)
      ];
      if (reflowExisting && reflowRows.length === 0 && scheduleRows.every((schedule) => Object.keys(asObject(schedule.reflowPlacement ?? schedule.reflow_placement)).length === 0)) {
        errors.push(`${taskId}: scheduleSheetLayout.reflowExisting requires reflowPlacements or per-schedule reflowPlacement.`);
      }
      scheduleRows.forEach((schedule, index) => {
        if (!textValue(schedule.name ?? schedule.scheduleName ?? schedule.schedule_name)) errors.push(`${taskId}: schedules[${index}].name is required for bounded schedule creation.`);
        if (!textValue(schedule.category ?? schedule.builtInCategory)) errors.push(`${taskId}: schedules[${index}].category is required for schedule category readback.`);
        if (positiveIds(schedule.fields).length === 0 && (!Array.isArray(schedule.fields) || schedule.fields.map(textValue).filter(Boolean).length === 0)) {
          errors.push(`${taskId}: schedules[${index}].fields must contain at least one requested schedule field.`);
        }
      });
    }
    if (Object.keys(scheduleConfig).length > 0) {
      const useExistingSchedule = boolValue(scheduleConfig.useExisting ?? scheduleConfig.existing ?? scheduleConfig.use_existing) === true;
      const editExistingScheduleValue = boolValue(scheduleConfig.editExistingValue ?? scheduleConfig.edit_existing_value ?? scheduleConfig.editExisting ?? scheduleConfig.edit_existing) === true;
      if ((useExistingSchedule || editExistingScheduleValue) && positiveNumber(scheduleConfig.scheduleId ?? scheduleConfig.viewId ?? scheduleConfig.existingScheduleId) === null && !textValue(scheduleConfig.scheduleName ?? scheduleConfig.schedule_name ?? scheduleConfig.name ?? request.scheduleName)) {
        errors.push(`${taskId}: schedule.scheduleId is required for existing schedule redline edits.`);
      }
      if (!editExistingScheduleValue) {
        if (!textValue(scheduleConfig.name ?? request.scheduleName)) errors.push(`${taskId}: schedule.name is required for bounded schedule creation.`);
        if (!textValue(scheduleConfig.category ?? scheduleConfig.builtInCategory)) errors.push(`${taskId}: schedule.category is required for schedule category readback.`);
        if (positiveIds(scheduleConfig.fields).length === 0 && (!Array.isArray(scheduleConfig.fields) || scheduleConfig.fields.map(textValue).filter(Boolean).length === 0)) {
          errors.push(`${taskId}: schedule.fields must contain at least one requested schedule field.`);
        }
      }
    }

    const configureSchedule = documentationOperationObject(request, "configureSchedule", "scheduleConfiguration");
    if (Object.keys(configureSchedule).length > 0 && boolValue(configureSchedule.requireExistingScheduleTarget ?? configureSchedule.require_existing_schedule_target) === true) {
      if (positiveNumber(scheduleConfig.scheduleId ?? scheduleConfig.viewId ?? scheduleConfig.existingScheduleId) === null) {
        errors.push(`${taskId}: configureSchedule existing schedule edits require schedule.scheduleId.`);
      }
      if (!textValue(configureSchedule.targetFieldName ?? configureSchedule.targetField ?? configureSchedule.columnName ?? configureSchedule.fieldName)) {
        errors.push(`${taskId}: configureSchedule.targetFieldName is required for schedule cell/readback targeting.`);
      }
      const hasRowScope = textValue(configureSchedule.targetRowKey ?? configureSchedule.rowKey ?? configureSchedule.elementUniqueId ?? configureSchedule.elementId) ||
        positiveNumber(configureSchedule.targetRowIndex ?? configureSchedule.rowIndex) !== null ||
        textValue(configureSchedule.targetCellId ?? configureSchedule.cellId);
      if (!hasRowScope) {
        errors.push(`${taskId}: configureSchedule targetRowKey, targetRowIndex, or targetCellId is required for schedule cell/readback targeting.`);
      }
      if (!textValue(configureSchedule.requestedTextOrValue ?? configureSchedule.requestedValue ?? configureSchedule.value)) {
        errors.push(`${taskId}: configureSchedule.requestedTextOrValue is required for schedule text/value edits.`);
      }
      if (boolValue(configureSchedule.readbackRequired ?? configureSchedule.readback_required) !== true) {
        errors.push(`${taskId}: configureSchedule.readbackRequired must be true for schedule text/value edit readback.`);
      }
    }

    const categoryVisibility = documentationOperationObject(request, "categoryVisibility", "categoryOverrideVisibility");
    if (Object.keys(categoryVisibility).length > 0) {
      if (!textValue(categoryVisibility.categoryName ?? categoryVisibility.category)) errors.push(`${taskId}: categoryVisibility.categoryName is required for category graphics readback.`);
      if (finiteNumber(categoryVisibility.lineWeight ?? categoryVisibility.line_weight) === null) errors.push(`${taskId}: categoryVisibility.lineWeight must be finite for graphics override readback.`);
      if (boolValue(categoryVisibility.readbackRequired ?? categoryVisibility.readback_required) !== true) errors.push(`${taskId}: categoryVisibility.readbackRequired must be true for category graphics API readback.`);
      if (boolValue(categoryVisibility.revertAfterVerify ?? categoryVisibility.revert_after_verify) !== true) errors.push(`${taskId}: categoryVisibility.revertAfterVerify must be true so category graphics overrides are cleared after visual/readback verification.`);
    }

    const linkedModelCategoryVisibility = documentationOperationObject(request, "linkedModelCategoryVisibility", "linkedModelVisibility", "revitLinkCategoryVisibility");
    if (Object.keys(linkedModelCategoryVisibility).length > 0) {
      const linkedModelId = positiveNumber(linkedModelCategoryVisibility.linkedModelInstanceOrTypeId ?? linkedModelCategoryVisibility.linkedModelId ?? linkedModelCategoryVisibility.revitLinkInstanceId);
      const linkedModelName = textValue(linkedModelCategoryVisibility.linkedModelName ?? linkedModelCategoryVisibility.revitLinkName);
      if (linkedModelId === null && !linkedModelName) errors.push(`${taskId}: linkedModelCategoryVisibility linked model id or name is required.`);
      if (!textValue(linkedModelCategoryVisibility.categoryName ?? linkedModelCategoryVisibility.categoryOrSubcategoryName)) {
        errors.push(`${taskId}: linkedModelCategoryVisibility.categoryName is required for linked category readback.`);
      }
      if (finiteNumber(linkedModelCategoryVisibility.lineWeight ?? linkedModelCategoryVisibility.line_weight) === null) {
        errors.push(`${taskId}: linkedModelCategoryVisibility.lineWeight must be finite for linked graphics readback.`);
      }
      if (boolValue(linkedModelCategoryVisibility.readbackRequired ?? linkedModelCategoryVisibility.readback_required) !== true) {
        errors.push(`${taskId}: linkedModelCategoryVisibility.readbackRequired must be true for linked graphics API readback.`);
      }
      if (boolValue(linkedModelCategoryVisibility.revertAfterVerify ?? linkedModelCategoryVisibility.revert_after_verify) !== true) {
        errors.push(`${taskId}: linkedModelCategoryVisibility.revertAfterVerify must be true so linked category graphics overrides are cleared after visual/readback verification.`);
      }
    }

    const phaseVisibility = documentationOperationObject(request, "phaseVisibility", "viewPhaseVisibility");
    if (Object.keys(phaseVisibility).length > 0) {
      const hasPhase = textValue(phaseVisibility.phaseName ?? phaseVisibility.phase) || positiveNumber(phaseVisibility.phaseId) !== null;
      const hasPhaseFilter = textValue(phaseVisibility.phaseFilterName ?? phaseVisibility.phaseFilter) || positiveNumber(phaseVisibility.phaseFilterId) !== null;
      if (!hasPhase && !hasPhaseFilter) errors.push(`${taskId}: phaseVisibility must specify phaseName/phaseId or phaseFilterName/phaseFilterId.`);
      if (boolValue(phaseVisibility.readbackRequired ?? phaseVisibility.readback_required) !== true) {
        errors.push(`${taskId}: phaseVisibility.readbackRequired must be true for phase/phase-filter readback.`);
      }
      if (boolValue(phaseVisibility.revertAfterVerify ?? phaseVisibility.revert_after_verify) !== true) {
        errors.push(`${taskId}: phaseVisibility.revertAfterVerify must be true so phase graphics changes are restored after visual/readback verification.`);
      }
      if (hasPhase && !textValue(phaseVisibility.originalPhaseName ?? phaseVisibility.originalPhase) && positiveNumber(phaseVisibility.originalPhaseId) === null) {
        errors.push(`${taskId}: phaseVisibility.originalPhaseName/originalPhaseId is required to revert phase changes.`);
      }
      if (hasPhaseFilter && !textValue(phaseVisibility.originalPhaseFilterName ?? phaseVisibility.originalPhaseFilter) && positiveNumber(phaseVisibility.originalPhaseFilterId) === null) {
        errors.push(`${taskId}: phaseVisibility.originalPhaseFilterName/originalPhaseFilterId is required to revert phase-filter changes.`);
      }
    }

    const filterVisibility = documentationOperationObject(request, "filterVisibility", "viewFilterVisibility");
    if (Object.keys(filterVisibility).length > 0) {
      const createFilter = asObject(filterVisibility.createFilter ?? filterVisibility.create_filter);
      if (!textValue(filterVisibility.filterName ?? createFilter.name)) errors.push(`${taskId}: filterVisibility.filterName is required for filter graphics readback.`);
      const existingFilterId = positiveNumber(filterVisibility.filterId ?? filterVisibility.existingFilterId ?? filterVisibility.viewFilterId);
      const createFilterRuleParameterName = createFilter.ruleParameterName ?? createFilter.parameterName ?? createFilter.parameter ?? filterVisibility.ruleParameterName;
      const createFilterRuleValue = createFilter.ruleValue ?? createFilter.value ?? createFilter.equals ?? filterVisibility.ruleValue;
      const createFilterRuleValueElementId = createFilter.ruleValueElementId ?? createFilter.rule_value_element_id ?? createFilter.ruleValueId ?? createFilter.valueElementId;
      const hasFilterCreationCriteria = textValue(createFilter.categoryName ?? createFilter.category ?? filterVisibility.categoryName ?? filterVisibility.category) &&
        textValue(createFilterRuleParameterName) &&
        textValue(createFilter.ruleOperator ?? createFilter.operator ?? createFilter.equals ?? filterVisibility.ruleOperator) &&
        (textValue(createFilterRuleValue) || positiveInteger(createFilterRuleValueElementId) !== null);
      if (existingFilterId === null && !hasFilterCreationCriteria) {
        errors.push(`${taskId}: filterVisibility must include existing filterId or createFilter category/ruleParameterName/ruleOperator/ruleValue before view-filter graphics writes.`);
      }
      if (existingFilterId === null && Object.keys(createFilter).length > 0) {
        const ruleParameterStorageType = normalizedFilterRuleStorageType(createFilter.ruleParameterStorageType ?? createFilter.storageType ?? createFilter.parameterStorageType ?? filterVisibility.ruleParameterStorageType);
        const ruleValueElementId = positiveInteger(createFilterRuleValueElementId);
        const ruleValueNumber = positiveInteger(createFilterRuleValue);
        if (filterParameterLooksElementId(createFilterRuleParameterName)) {
          if (ruleParameterStorageType !== "element_id") {
            errors.push(`${taskId}: filterVisibility.createFilter.ruleParameterStorageType must be element_id for ElementId filter parameter "${textValue(createFilterRuleParameterName)}".`);
          }
          if (ruleValueElementId === null && ruleValueNumber === null) {
            errors.push(`${taskId}: filterVisibility.createFilter.ruleValueElementId or numeric ruleValue is required for ElementId filter parameter "${textValue(createFilterRuleParameterName)}".`);
          }
          if (!filterRuleOperatorAllowedForStorageType("element_id", createFilter.ruleOperator ?? createFilter.operator ?? filterVisibility.ruleOperator)) {
            errors.push(`${taskId}: filterVisibility.createFilter.ruleOperator must be equals or not_equals for ElementId filter parameter "${textValue(createFilterRuleParameterName)}".`);
          }
        } else if ((createFilter.ruleParameterStorageType ?? createFilter.storageType ?? createFilter.parameterStorageType ?? filterVisibility.ruleParameterStorageType) !== undefined && ruleParameterStorageType === null) {
          errors.push(`${taskId}: filterVisibility.createFilter.ruleParameterStorageType must be string, integer, double, or element_id when provided.`);
        } else if (ruleParameterStorageType !== null && !filterRuleOperatorAllowedForStorageType(ruleParameterStorageType, createFilter.ruleOperator ?? createFilter.operator ?? filterVisibility.ruleOperator)) {
          errors.push(`${taskId}: filterVisibility.createFilter.ruleOperator is not supported for ${ruleParameterStorageType} filter parameters.`);
        }
      }
      if (finiteNumber(filterVisibility.lineWeight ?? filterVisibility.line_weight) === null) errors.push(`${taskId}: filterVisibility.lineWeight must be finite for graphics override readback.`);
      if (boolValue(filterVisibility.readbackRequired ?? filterVisibility.readback_required) !== true) errors.push(`${taskId}: filterVisibility.readbackRequired must be true for view-filter graphics API readback.`);
      if (boolValue(filterVisibility.revertAfterVerify ?? filterVisibility.revert_after_verify) !== true) errors.push(`${taskId}: filterVisibility.revertAfterVerify must be true so view-filter graphics overrides are cleared after visual/readback verification.`);
    }

    const templateCategoryVisibility = documentationOperationObject(request, "templateCategoryVisibility", "viewTemplateCategoryVisibility", "templateCategoryOverrideVisibility");
    if (Object.keys(templateCategoryVisibility).length > 0) {
      if (!textValue(templateCategoryVisibility.categoryName ?? templateCategoryVisibility.category)) errors.push(`${taskId}: templateCategoryVisibility.categoryName is required for template category readback.`);
      if (finiteNumber(templateCategoryVisibility.lineWeight ?? templateCategoryVisibility.line_weight) === null) errors.push(`${taskId}: templateCategoryVisibility.lineWeight must be finite for template graphics readback.`);
      if (boolValue(templateCategoryVisibility.requireExistingTemplateTarget ?? templateCategoryVisibility.require_existing_template_target) === true) {
        const existingTemplateId = positiveNumber(templateCategoryVisibility.existingTemplateId ?? templateCategoryVisibility.templateId ?? templateCategoryVisibility.viewTemplateId);
        if (existingTemplateId === null) {
          errors.push(`${taskId}: templateCategoryVisibility existingTemplateId is required for real view-template graphics edits.`);
        }
        if (positiveNumber(templateCategoryVisibility.controlledViewId ?? templateCategoryVisibility.templateControlledViewId) === null) {
          errors.push(`${taskId}: templateCategoryVisibility controlledViewId is required to prove the requested view is controlled by the template.`);
        }
        if (boolValue(templateCategoryVisibility.readbackRequired ?? templateCategoryVisibility.readback_required) !== true) {
          errors.push(`${taskId}: templateCategoryVisibility.readbackRequired must be true for existing view-template graphics readback.`);
        }
        if (boolValue(templateCategoryVisibility.revertAfterVerify ?? templateCategoryVisibility.revert_after_verify) !== true) {
          errors.push(`${taskId}: templateCategoryVisibility.revertAfterVerify must be true so existing view-template graphics changes are restored after verification.`);
        }
      }
    }

    const textNote = documentationOperationObject(request, "textNote");
    if (Object.keys(textNote).length > 0) {
      const editExisting = boolValue(textNote.editExisting ?? textNote.edit_existing) === true;
      if (editExisting) {
        if (positiveNumber(textNote.textNoteId ?? textNote.text_note_id ?? textNote.elementId ?? textNote.element_id) === null) {
          errors.push(`${taskId}: textNote.textNoteId is required for existing text-note edits.`);
        }
        if (positiveNumber(textNote.viewId ?? textNote.view_id ?? request.textViewId ?? request.viewId) === null) {
          errors.push(`${taskId}: textNote.viewId is required for existing text-note owner-view readback.`);
        }
        if (!textValue(textNote.expectedExistingText ?? textNote.expected_existing_text ?? textNote.originalText ?? textNote.original_text ?? textNote.textContains)) {
          errors.push(`${taskId}: textNote.expectedExistingText is required to prove the intended existing note before replacement.`);
        }
        if (!textValue(textNote.text ?? textNote.newText ?? textNote.replacementText ?? request.text)) {
          errors.push(`${taskId}: textNote.text is required for replacement text readback.`);
        }
        if (boolValue(textNote.readbackRequired ?? textNote.readback_required) !== true) {
          errors.push(`${taskId}: textNote.readbackRequired must be true for existing text-note replacement.`);
        }
        if (boolValue(textNote.revertAfterVerify ?? textNote.revert_after_verify) !== true) {
          errors.push(`${taskId}: textNote.revertAfterVerify must be true so existing text-note edits are restored after verification.`);
        }
        if (boolValue(textNote.compositeGroupEdit ?? textNote.composite_group_edit) === true) {
          const groupGrounding = asObject(textNote.groupGrounding ?? textNote.group_grounding);
          if (!textValue(groupGrounding.groupIndex ?? groupGrounding.group_index)) {
            errors.push(`${taskId}: textNote.groupGrounding.groupIndex is required for composite text-note replacement groups.`);
          }
          if (!textValue(groupGrounding.annotationIndices ?? groupGrounding.annotation_indices)) {
            errors.push(`${taskId}: textNote.groupGrounding.annotationIndices is required for composite text-note replacement groups.`);
          }
          const actionability = textValue(groupGrounding.reviewGroupActionability ?? groupGrounding.review_group_actionability);
          if (actionability !== "likely_single_action") {
            errors.push(`${taskId}: textNote.groupGrounding.reviewGroupActionability must be likely_single_action for composite text-note edits.`);
          }
          if (boolValue(textNote.groupVisualProofReviewed ?? textNote.group_visual_proof_reviewed) !== true) {
            errors.push(`${taskId}: textNote.groupVisualProofReviewed must be true after the grouped PDF annotations are verified as one existing TextNote edit.`);
          }
        }
      } else {
        const placeBelowSchedule = boolValue(textNote.placeBelowSchedule ?? textNote.place_below_schedule) === true;
        const schedulePlacement = asObject(scheduleConfig.placeOnSheet ?? scheduleConfig.place_on_sheet);
        const hasGroundedSchedulePlacement =
          Object.keys(schedulePlacement).length > 0 ||
          boolValue(scheduleConfig.placeOnActiveSheet ?? scheduleConfig.place_on_active_sheet) === true ||
          positiveNumber(scheduleConfig.placeOnSheetId ?? scheduleConfig.place_on_sheet_id ?? scheduleConfig.sheetId ?? scheduleConfig.sheet_id ?? request.sheetId ?? request.sheet_id) !== null ||
          !!textValue(scheduleConfig.sheetNumber ?? scheduleConfig.sheet_number ?? request.sheetNumber ?? request.sheet_number);
        if (!placeBelowSchedule && (finiteNumber(textNote.x ?? request.textX) === null || finiteNumber(textNote.y ?? request.textY) === null)) {
          errors.push(`${taskId}: textNote.x/y must contain finite placement coordinates.`);
        }
        if (placeBelowSchedule && !hasGroundedSchedulePlacement) {
          errors.push(`${taskId}: textNote.placeBelowSchedule requires grounded schedule sheet placement.`);
        }
        if (!textValue(textNote.text ?? request.text)) errors.push(`${taskId}: textNote.text is required for text-note readback.`);
      }
    }

    const scheduleEdit = documentationOperationObject(request, "schedule");
    if (Object.keys(scheduleEdit).length > 0) {
      const editExisting = boolValue(scheduleEdit.editExistingValue ?? scheduleEdit.edit_existing_value ?? scheduleEdit.editExisting ?? scheduleEdit.edit_existing) === true;
      if (editExisting) {
        if (positiveNumber(scheduleEdit.scheduleId ?? scheduleEdit.schedule_id ?? request.scheduleId) === null && !textValue(scheduleEdit.scheduleName ?? scheduleEdit.schedule_name ?? scheduleEdit.name ?? request.scheduleName)) {
          errors.push(`${taskId}: schedule.scheduleId or schedule.scheduleName is required for existing schedule edits.`);
        }
        if (positiveNumber(scheduleEdit.elementId ?? scheduleEdit.element_id ?? scheduleEdit.backingElementId ?? scheduleEdit.backing_element_id) === null) {
          errors.push(`${taskId}: schedule.elementId is required for parameter-backed schedule edits.`);
        }
        if (!textValue(scheduleEdit.parameterName ?? scheduleEdit.parameter_name ?? scheduleEdit.fieldName ?? scheduleEdit.field_name)) {
          errors.push(`${taskId}: schedule.parameterName or fieldName is required for parameter-backed schedule edits.`);
        }
        if (!textValue(scheduleEdit.rowKey ?? scheduleEdit.row_key ?? scheduleEdit.expectedRowKey ?? scheduleEdit.expected_row_key)) {
          errors.push(`${taskId}: schedule.rowKey is required for schedule CSV readback.`);
        }
        if (!textValue(scheduleEdit.expectedExistingValue ?? scheduleEdit.expected_existing_value ?? scheduleEdit.originalValue ?? scheduleEdit.original_value)) {
          errors.push(`${taskId}: schedule.expectedExistingValue is required to prove the intended existing schedule value before replacement.`);
        }
        if (!textValue(scheduleEdit.replacementValue ?? scheduleEdit.replacement_value ?? scheduleEdit.newValue ?? scheduleEdit.new_value ?? scheduleEdit.text ?? scheduleEdit.value)) {
          errors.push(`${taskId}: schedule.replacementValue is required for schedule value readback.`);
        }
        if (boolValue(scheduleEdit.readbackRequired ?? scheduleEdit.readback_required) !== true) {
          errors.push(`${taskId}: schedule.readbackRequired must be true for schedule CSV readback.`);
        }
        if (boolValue(scheduleEdit.revertAfterVerify ?? scheduleEdit.revert_after_verify) !== true) {
          errors.push(`${taskId}: schedule.revertAfterVerify must be true so existing schedule edits are restored after verification.`);
        }
      }
    }

    const tag = documentationOperationObject(request, "tag");
    if (Object.keys(tag).length > 0) {
      const editExistingValue = boolValue(tag.editExistingValue ?? tag.edit_existing_value ?? tag.editExisting ?? tag.edit_existing) === true;
      const tagViewId = positiveNumber(tag.viewId ?? tag.view_id ?? request.tagViewId ?? request.tag_view_id);
      if (tagViewId === null) errors.push(`${taskId}: tag.viewId must be a verified positive Revit view id for tag readback.`);
      if (positiveIds(tag.elementIds ?? tag.element_ids).length === 0) errors.push(`${taskId}: tag.elementIds must contain verified positive tagged/taggable Revit element ids.`);
      if (boolValue(tag.readbackRequired ?? tag.readback_required) !== true) {
        errors.push(`${taskId}: tag.readbackRequired must be true for tag target/type/value readback.`);
      }
      if (editExistingValue) {
        if (positiveIds(tag.existingTagIds ?? tag.existing_tag_ids ?? tag.tagIds ?? tag.tag_ids).length === 0) {
          errors.push(`${taskId}: tag.existingTagIds must identify the visible tag(s) whose displayed value will be verified.`);
        }
        if (!textValue(tag.valueSourceParameterName ?? tag.value_source_parameter_name ?? tag.parameterName ?? tag.parameter_name)) {
          errors.push(`${taskId}: tag.valueSourceParameterName is required so tag text edits write a verified tagged-element parameter, not TagText directly.`);
        }
        if (!textValue(tag.expectedExistingValue ?? tag.expected_existing_value ?? tag.originalValue ?? tag.original_value)) {
          errors.push(`${taskId}: tag.expectedExistingValue is required to prove the intended existing tag value before replacement.`);
        }
        if (!textValue(tag.requestedTagValueHint ?? tag.requested_tag_value_hint ?? tag.tagValue ?? tag.tag_value ?? tag.value ?? tag.text ?? tag.label)) {
          errors.push(`${taskId}: tag.requestedTagValueHint is required for existing tag value replacement readback.`);
        }
        if (boolValue(tag.revertAfterVerify ?? tag.revert_after_verify) !== true) {
          errors.push(`${taskId}: tag.revertAfterVerify must be true so existing tag value edits are restored after verification.`);
        }
      } else if (!hasTagTypeEvidence(tag)) {
        errors.push(`${taskId}: tag.tagTypeId or tag.tagTypeName is required from live tag-type discovery before tag creation; requestedTagValueHint/requestedTagKindHint are readback checks, not compatibility proof.`);
      }
    }

    const cadLink = documentationOperationObject(request, "cadLink", "cadImport", "linkCad");
    const cadReload = documentationOperationObject(request, "cadReload", "reloadCad", "cadLinkReload");
    const cadGraphics = documentationOperationObject(request, "cadGraphicsOverride", "cadLayerOverride", "cadVisibility");
    if (Object.keys(cadReload).length > 0) {
      if (positiveIds(cadReload.existingCadLinkIds ?? cadReload.existing_cad_link_ids ?? cadReload.elementIds ?? cadReload.element_ids).length === 0) {
        errors.push(`${taskId}: cadReload.existingCadLinkIds must contain verified existing CAD import/link ids for reload preflight.`);
      }
      if (!textValue(cadReload.expectedSourcePath ?? cadReload.expected_source_path ?? cadReload.expectedCadLinkName ?? cadReload.expected_cad_link_name ?? cadReload.name)) {
        errors.push(`${taskId}: cadReload.expectedSourcePath or expectedCadLinkName is required for existing CAD link readback.`);
      }
      if (positiveNumber(cadReload.ownerViewId ?? cadReload.owner_view_id) === null) {
        errors.push(`${taskId}: cadReload.ownerViewId is required to ground the CAD link in its owner view.`);
      }
      if (boolValue(cadReload.readbackRequired ?? cadReload.readback_required) !== true) {
        errors.push(`${taskId}: cadReload.readbackRequired must be true for existing CAD link/source readback.`);
      }
      if (boolValue(cadReload.applyReload ?? cadReload.apply_reload ?? cadReload.apply) === true) {
        errors.push(`${taskId}: cadReload.applyReload must remain false until a native reload-and-restore workflow exists.`);
      }
    }
    if (Object.keys(cadLink).length > 0) {
      if (!textValue(cadLink.sourcePath ?? cadLink.source_path)) {
        errors.push(`${taskId}: cadLink.sourcePath is required for CAD link/import evidence.`);
      }
      if (boolValue(cadLink.ownerViewBoundingBoxRequired ?? cadLink.owner_view_bounding_box_required ?? cadLink.elementBoundingBoxInOwnerViewRequired ?? cadLink.element_bounding_box_in_owner_view_required) !== true) {
        errors.push(`${taskId}: cadLink.ownerViewBoundingBoxRequired must be true so CAD placement requires elementBoundingBoxInOwnerView readback.`);
      }
    }
    if (Object.keys(cadGraphics).length > 0) {
      if (Object.keys(cadLink).length === 0) errors.push(`${taskId}: cadGraphicsOverride requires cadLink so layer/subcategory readback comes from the linked/imported CAD element.`);
      if (!textValue(cadGraphics.layerOrSubcategoryName ?? cadGraphics.categoryName)) errors.push(`${taskId}: cadGraphicsOverride.layerOrSubcategoryName is required for CAD layer readback.`);
      if (finiteNumber(cadGraphics.lineWeight ?? cadGraphics.line_weight) === null) errors.push(`${taskId}: cadGraphicsOverride.lineWeight must be finite for CAD graphics readback.`);
    }
  }
  return errors;
}

function tapBranchOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (taskId !== "demo_redline_mep_duct_tap_branch" && taskId !== "demo_redline_mep_pipe_tap_branch") continue;
    const isPipe = taskId === "demo_redline_mep_pipe_tap_branch";
    const mainElementId = positiveNumber(request.mainElementId ?? request.main_element_id ?? request.hostElementId ?? request.host_element_id);
    const branchNetworkWorkflow = boolValue(request.branchNetworkWorkflow ?? request.branch_network_workflow ?? request.useBranchNetworkWorkflow) === true;
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id);
    const size = textValue(request.branchSize ?? request.branch_size ?? (isPipe ? request.pipeSize ?? request.pipe_size : request.ductSize ?? request.duct_size));
    const branchPoints = branchNetworkWorkflow && Array.isArray(request.branches)
      ? asObject(request.branches[0]).points
      : request.branchPoints ?? request.branch_points;
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id.`);
    if (visualViewId === null) errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
    if (mainElementId === null && !branchNetworkWorkflow) errors.push(`${taskId}: mainElementId must be a verified positive Revit duct/pipe element id.`);
    if (branchNetworkWorkflow && validPointCount(request.mainPoints ?? request.main_points) < 2) {
      errors.push(`${taskId}: mainPoints must contain at least two finite x/y route points for branch-network setup.`);
    }
    if (!hasFiniteXyPoint(request.projectedTapPoint ?? request.projected_tap_point ?? request.tapPoint ?? request.tap_point)) {
      errors.push(`${taskId}: projectedTapPoint must contain finite x/y coordinates on the main route.`);
    }
    if (validPointCount(branchPoints) < 2) {
      errors.push(`${taskId}: branchPoints must contain at least two finite x/y points for the branch route.`);
    }
    if (!size) errors.push(`${taskId}: branchSize/${isPipe ? "pipeSize" : "ductSize"} is required for tap branch readback.`);
    if (boolValue(request.apply) !== true) errors.push(`${taskId}: apply must be true for a live tap branch benchmark override.`);
    if (boolValue(request.verify) !== true && boolValue(request.verifyConnectorNetwork ?? request.verify_connector_network) !== true) {
      errors.push(`${taskId}: verify or verifyConnectorNetwork must be true for connector/readback evidence.`);
    }
    if (boolValue(request.visualVerify ?? request.visual_verify) !== true) errors.push(`${taskId}: visualVerify must be true for the visual gate.`);
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable branch/fitting cleanup.`);
    }
  }
  return errors;
}

function rerouteOverrideErrors(rootObj: JsonMap): string[] {
  const errors: string[] = [];
  for (const { taskId, request } of collectOverrideTaskRequests(rootObj)) {
    if (taskId !== "demo_redline_mep_duct_reroute" && taskId !== "demo_redline_mep_pipe_reroute") continue;
    const isPipe = taskId === "demo_redline_mep_pipe_reroute";
    const hostElementId = positiveNumber(request.hostElementId ?? request.host_element_id ?? request.mainElementId ?? request.main_element_id);
    const createHostRoute = asObject(request.createHostRoute ?? request.create_host_route ?? request.setupRoute ?? request.setup_route);
    const createsDisposableHostRoute = Object.keys(createHostRoute).length > 0;
    const viewId = positiveNumber(request.viewId ?? request.view_id);
    const visualViewId = positiveNumber(request.visualViewId ?? request.visual_view_id);
    const splitPointCount = finitePointPairCount(request, "splitPoints", "split_points", "split1Point", "split2Point");
    const splitChainageCount = [
      positiveNumber(request.split1ChainageFt ?? request.split1_chainage_ft),
      positiveNumber(request.split2ChainageFt ?? request.split2_chainage_ft)
    ].filter((entry) => entry !== null).length;
    if (viewId === null) errors.push(`${taskId}: viewId must be a verified positive Revit view id.`);
    if (visualViewId === null) errors.push(`${taskId}: visualViewId must be a verified positive Revit view id for focused capture.`);
    if (hostElementId === null && !createsDisposableHostRoute) errors.push(`${taskId}: hostElementId must be a verified positive Revit duct/pipe element id, unless createHostRoute provides a disposable setup route.`);
    if (createsDisposableHostRoute) {
      const createSize = textValue(isPipe
        ? createHostRoute.pipeSize ?? createHostRoute.pipe_size
        : createHostRoute.ductSize ?? createHostRoute.duct_size);
      if (!createSize) errors.push(`${taskId}: createHostRoute.${isPipe ? "pipeSize" : "ductSize"} is required for disposable host setup.`);
      if (validPointCount(createHostRoute.points) < 2) {
        errors.push(`${taskId}: createHostRoute.points must contain at least two finite x/y route points.`);
      }
    }
    if (splitPointCount < 2 && splitChainageCount < 2) {
      errors.push(`${taskId}: splitPoints or split chainages must identify two reroute split locations.`);
    }
    if (!hasNonzeroOffsetIntent(request)) {
      errors.push(`${taskId}: dropFt/riseFt/offsetFt or offsetVector must describe a nonzero reroute offset.`);
    }
    if (boolValue(request.apply) !== true) errors.push(`${taskId}: apply must be true for a live reroute benchmark override.`);
    if (boolValue(request.verify) !== true && boolValue(request.verifyConnectorNetwork ?? request.verify_connector_network) !== true) {
      errors.push(`${taskId}: verify or verifyConnectorNetwork must be true for connector/readback evidence.`);
    }
    if (boolValue(request.visualVerify ?? request.visual_verify) !== true) errors.push(`${taskId}: visualVerify must be true for the visual gate.`);
    if (boolValue(request.cleanupCreatedElements ?? request.cleanup_created_elements) !== true) {
      errors.push(`${taskId}: cleanupCreatedElements must be true for disposable replacement segment/fitting cleanup.`);
    }
  }
  return errors;
}

export function assertRunnableRevitWorkflowOverride(root: unknown, sourcePath: string): void {
  const rootObj = asObject(root);
  const status = String(rootObj.status ?? "");
  const readyToRun = rootObj.ready_to_run;
  const placeholderCount = Number(rootObj.placeholder_count ?? 0);
  const placeholders = findBenchmarkOverridePlaceholders(root);
  const templateStatus = status === "template_requires_verified_revit_ids" || status === "batch_template_requires_verified_revit_ids";
  if (templateStatus || readyToRun === false || placeholderCount > 0 || placeholders.length > 0) {
    const listed = placeholders.slice(0, 12).join(", ");
    const suffix = placeholders.length > 12 ? `, ... ${placeholders.length - 12} more` : "";
    throw new Error(
      [
        `Revit benchmark request override is not runnable: ${sourcePath}`,
        "Fill the corpus live request template into a local override first; every __FILL_* placeholder must be replaced with verified Revit ids, points, types, levels, and paths.",
        templateStatus ? `status=${status}` : "",
        `placeholder_count=${Number.isFinite(placeholderCount) ? placeholderCount : 0}`,
        placeholders.length > 0 ? `placeholder_paths=${listed}${suffix}` : ""
      ].filter(Boolean).join(" ")
    );
  }
  const taskReadinessErrors = taskReadinessOverrideErrors(rootObj);
  if (taskReadinessErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override is not runnable: ${sourcePath}`,
        ...taskReadinessErrors
      ].join(" ")
    );
  }
  const scopedSizingErrors = scopedSizingOverrideErrors(rootObj);
  if (scopedSizingErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid scoped MEP sizing inputs: ${sourcePath}`,
        ...scopedSizingErrors
      ].join(" ")
    );
  }
  const sizeTransitionErrors = sizeTransitionOverrideErrors(rootObj);
  if (sizeTransitionErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid MEP size-transition inputs: ${sourcePath}`,
        ...sizeTransitionErrors
      ].join(" ")
    );
  }
  const parameterEditErrors = parameterEditOverrideErrors(rootObj);
  if (parameterEditErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid parameter edit inputs: ${sourcePath}`,
        ...parameterEditErrors
      ].join(" ")
    );
  }
  const routeErrors = routeOverrideErrors(rootObj);
  if (routeErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid MEP route inputs: ${sourcePath}`,
        ...routeErrors
      ].join(" ")
    );
  }
  const routeMutationErrors = routeMutationOverrideErrors(rootObj);
  if (routeMutationErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid MEP route mutation inputs: ${sourcePath}`,
        ...routeMutationErrors
      ].join(" ")
    );
  }
  const typeChangeErrors = typeChangeOverrideErrors(rootObj);
  if (typeChangeErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid type-change inputs: ${sourcePath}`,
        ...typeChangeErrors
      ].join(" ")
    );
  }
  const redlineAddErrors = redlineAddOverrideErrors(rootObj);
  if (redlineAddErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid redline add inputs: ${sourcePath}`,
        ...redlineAddErrors
      ].join(" ")
    );
  }
  const redlineMutationErrors = redlineMutationOverrideErrors(rootObj);
  if (redlineMutationErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid redline mutation inputs: ${sourcePath}`,
        ...redlineMutationErrors
      ].join(" ")
    );
  }
  const documentationErrors = documentationOverrideErrors(rootObj);
  if (documentationErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid documentation primitive inputs: ${sourcePath}`,
        ...documentationErrors
      ].join(" ")
    );
  }
  const tapBranchErrors = tapBranchOverrideErrors(rootObj);
  if (tapBranchErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid MEP tap/branch inputs: ${sourcePath}`,
        ...tapBranchErrors
      ].join(" ")
    );
  }
  const rerouteErrors = rerouteOverrideErrors(rootObj);
  if (rerouteErrors.length > 0) {
    throw new Error(
      [
        `Revit benchmark request override has invalid MEP reroute inputs: ${sourcePath}`,
        ...rerouteErrors
      ].join(" ")
    );
  }
}

function loadRevitWorkflowOverride(taskId: string): JsonMap {
  const filePath = (process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON || "").trim();
  if (!filePath) return {};
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Revit benchmark request override file not found: ${fullPath}`);
  const root = JSON.parse(fs.readFileSync(fullPath, "utf8")) as unknown;
  const rootObj = asObject(root);
  const status = String(rootObj.status ?? "");
  const readyToRun = rootObj.ready_to_run;
  const placeholderCount = Number(rootObj.placeholder_count ?? 0);
  const placeholders = findBenchmarkOverridePlaceholders(root);
  if (status === "template_requires_verified_revit_ids" || status === "batch_template_requires_verified_revit_ids" || readyToRun === false || placeholderCount > 0 || placeholders.length > 0) {
    assertRunnableRevitWorkflowOverride(root, fullPath);
  }
  const tasksObj = asObject(rootObj.tasks);
  const selectedOverride = asObject(tasksObj[taskId] ?? rootObj[taskId]);
  if (Object.keys(selectedOverride).length === 0) return {};
  assertRunnableRevitWorkflowOverride({ tasks: { [taskId]: selectedOverride }, ready_to_run: selectedOverride.ready_to_run, status: selectedOverride.status }, `${fullPath}#${taskId}`);
  return selectedOverride;
}

function mergeWorkflowConfig(base: unknown, override: JsonMap): JsonMap {
  const baseObj = asObject(base);
  if (Object.keys(override).length === 0) return baseObj;
  const overrideRequest = asObject(override.request);
  const replacesBaseRequest = boolValue(
    overrideRequest.replaceBaseRequest ??
    overrideRequest.replace_base_request ??
    overrideRequest.graphicsOnly ??
    overrideRequest.graphics_only ??
    overrideRequest.documentationGraphicsOnly ??
    overrideRequest.documentation_graphics_only
  ) === true;
  return {
    ...baseObj,
    ...override,
    request: replacesBaseRequest
      ? overrideRequest
      : {
        ...asObject(baseObj.request),
        ...overrideRequest
      }
  };
}

class RevitWorkflowSession implements BenchmarkEnvironmentSession {
  private readonly task: BenchmarkTaskDefinition;
  private readonly runContext: BenchmarkEnvironmentRunContext;
  private readonly observationsDir: string;
  private currentState: string;
  private complete = false;
  private outcome = "Workflow has not run.";

  constructor(task: BenchmarkTaskDefinition, runContext: BenchmarkEnvironmentRunContext) {
    this.task = task;
    this.runContext = runContext;
    this.observationsDir = ensureDir(runContext.observations_dir);
    const config = (task.adapter_config && typeof task.adapter_config === "object" ? task.adapter_config : {}) as RevitWorkflowAdapterConfig;
    this.currentState = config.initial_state_summary || `Ready to run deterministic Revit workflow '${task.task_id}'.`;
  }

  private writeObservation(label: string, value: unknown): string {
    const filePath = path.join(this.observationsDir, `${label}.json`);
    writeJsonFile(filePath, value);
    return filePath;
  }

  async getInitialObservation(): Promise<BenchmarkObservation> {
    return {
      visible_state_summary: this.currentState,
      observation_artifact_path: this.writeObservation("initial", { visible_state_summary: this.currentState }),
      screenshot_artifact_path: null
    };
  }

  isTaskComplete(): boolean {
    return this.complete;
  }

  getObservedOutcomeSummary(): string {
    return this.outcome;
  }

  async executeAction(action: BenchmarkAction): Promise<BenchmarkActionResult> {
    const startedAt = performance.now();
    if (this.complete) {
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.outcome,
          observation_artifact_path: this.writeObservation("already_complete", { visible_state_summary: this.outcome }),
          screenshot_artifact_path: null
        },
        action_result_summary: "Workflow already completed.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const actionType = action.action_type.trim().toLowerCase();
    if (actionType && actionType !== "run_workflow" && actionType !== "run deterministic workflow") {
      return {
        success: false,
        tool_latency_seconds: (performance.now() - startedAt) / 1000,
        observation: {
          visible_state_summary: this.currentState,
          observation_artifact_path: this.writeObservation("ignored_action", { action, visible_state_summary: this.currentState }),
          screenshot_artifact_path: null
        },
        action_result_summary: "Revit workflow adapter only accepts run_workflow actions.",
        material_deviation: true,
        high_impact: Boolean(action.high_impact),
        irreversible: false
      };
    }

    const override = loadRevitWorkflowOverride(this.task.task_id);
    if (process.env.OPERATOR_BENCHMARK_USE_MOCKS === "0" && this.task.task_id === "demo_redline_add_tag" && Object.keys(override).length === 0) {
      throw new Error("demo_redline_add_tag live runs require OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON with reviewed tag type, readback, and dry-run preflight evidence.");
    }
    const workflowConfig = mergeWorkflowConfig(this.task.adapter_config, override);
    if (process.env.OPERATOR_BENCHMARK_USE_MOCKS === "0") {
      assertRunnableRevitWorkflowOverride({ tasks: { [this.task.task_id]: workflowConfig } }, `${this.task.task_id} live request`);
    }
    if (workflowConfig.timeout_ms === undefined) {
      workflowConfig.timeout_ms = Math.max(2_000, this.task.max_time_seconds * 1_000);
    }
    const result = await runRevitDemoWorkflow(workflowConfig, this.runContext.run_dir);
    this.complete = result.success;
    this.outcome = result.user_message;
    this.currentState = result.success ? `Verified: ${result.user_message}` : `Failed: ${result.failure_reason || result.user_message}`;
    const observationPath = this.writeObservation("workflow_result", result);
    return {
      success: result.success,
      tool_latency_seconds: (performance.now() - startedAt) / 1000,
      observation: {
        visible_state_summary: this.currentState,
        observation_artifact_path: observationPath,
        screenshot_artifact_path: null
      },
      action_result_summary: result.failure_reason || result.user_message,
      material_deviation: !result.success,
      high_impact: Boolean(action.high_impact),
      irreversible: false
    };
  }
}

class RevitWorkflowAdapter implements BenchmarkEnvironmentAdapter {
  readonly id = "revit_workflow";

  async createSession(
    task: BenchmarkTaskDefinition,
    runContext: BenchmarkEnvironmentRunContext
  ): Promise<BenchmarkEnvironmentSession> {
    return new RevitWorkflowSession(task, runContext);
  }
}

const registry = new Map<string, BenchmarkEnvironmentAdapter>([
  ["scripted_demo", new ScriptedDemoAdapter()],
  ["revit_workflow", new RevitWorkflowAdapter()]
]);

export function getEnvironmentAdapter(adapterId: string): BenchmarkEnvironmentAdapter {
  const adapter = registry.get(adapterId);
  if (!adapter) throw new Error(`Unknown benchmark environment adapter '${adapterId}'.`);
  return adapter;
}
