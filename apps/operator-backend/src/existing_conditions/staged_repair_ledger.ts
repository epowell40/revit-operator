import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import type {
  AtomicMepDraftWorkflowRequest,
  MepDraftContinuationEndpointPlan
} from "./mep_draft_plan.js";
import {
  appendExistingConditionsRepairLedgerEntry as appendEntry,
  canonicalExistingConditionsLedgerJson as canonicalJson,
  existingConditionsRepairLedgerSessionDir,
  hashExistingConditionsLedgerValue as sha256,
  normalizeExistingConditionsLedgerSha256 as normalizedSha256,
  readExistingConditionsRepairLedger
} from "./repair_ledger_store.js";
export {
  existingConditionsRepairLedgerPath,
  readExistingConditionsRepairLedger
} from "./repair_ledger_store.js";
export type {
  ExistingConditionsRepairLedgerEntry,
  ExistingConditionsStageEvent,
  ExistingConditionsStageStatus
} from "./repair_ledger_store.js";
import type {
  ExistingConditionsRepairLedgerEntry,
  ExistingConditionsStageEvent
} from "./repair_ledger_store.js";

export type ExistingConditionsPriorActionOutput = {
  action_key: string;
  created_element_ids: number[];
  affected_element_ids?: number[];
  route_segment_element_ids?: number[];
  route_start_element_ids?: number[];
  route_end_element_ids?: number[];
  split_main_start_element_ids?: number[];
  split_main_end_element_ids?: number[];
  continuation_endpoints?: Array<MepDraftContinuationEndpointPlan & {
    element_id: number;
  }>;
};

type StagedOperation = AtomicMepDraftWorkflowRequest["operations"][number];

export type ExistingConditionsStagePlan =
  | {
      state: "dry_run" | "apply";
      stage_key: string;
      action_key: string;
      action_keys: string[];
      request: AtomicMepDraftWorkflowRequest;
      accepted_action_outputs: ExistingConditionsPriorActionOutput[];
    }
  | {
      state: "blocked";
      stage_key: string | null;
      action_key: string | null;
      reason: string;
      accepted_action_outputs: ExistingConditionsPriorActionOutput[];
    }
  | {
      state: "awaiting_readback";
      accepted_action_outputs: ExistingConditionsPriorActionOutput[];
    }
  | {
      state: "verify_readback" | "verify_continuation" | "verify_visual";
      stage_key: string;
      action_key: string;
      action_keys: string[];
      method: "GET" | "POST";
      path: string;
      body?: Record<string, unknown>;
      accepted_action_outputs: ExistingConditionsPriorActionOutput[];
    }
  | {
      state: "checkpoint";
      stage_key: string;
      action_key: string;
      action_keys: string[];
      method: "POST";
      path: "/revit/save-as";
      body: Record<string, unknown>;
      accepted_action_outputs: ExistingConditionsPriorActionOutput[];
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => Number(item))
      .filter(item => Number.isSafeInteger(item) && item > 0)
  )).sort((left, right) => left - right);
}

function normalizeContinuationEndpoints(
  value: unknown,
  output: ExistingConditionsPriorActionOutput
): NonNullable<ExistingConditionsPriorActionOutput["continuation_endpoints"]> {
  if (!Array.isArray(value)) return [];
  const idsByOutput = {
    route_start: output.route_start_element_ids ?? [],
    route_end: output.route_end_element_ids ?? []
  };
  const seen = new Set<string>();
  const result: NonNullable<ExistingConditionsPriorActionOutput["continuation_endpoints"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const endpointKey = clean(row.endpoint_key);
    const outputKind = clean(row.output) as "route_start" | "route_end";
    const outputIndex = Number(row.output_index ?? 0);
    const elementId = Number(row.element_id ?? idsByOutput[outputKind]?.[outputIndex]);
    const modelPoint = row.model_point;
    const direction = row.direction_xyz;
    if (
      !endpointKey || seen.has(endpointKey.toLowerCase()) ||
      (outputKind !== "route_start" && outputKind !== "route_end") ||
      !Number.isSafeInteger(outputIndex) || outputIndex < 0 ||
      !Number.isSafeInteger(elementId) || elementId <= 0 ||
      !modelPoint || typeof modelPoint !== "object" || Array.isArray(modelPoint) ||
      !Array.isArray(direction) || direction.length !== 3 ||
      !direction.every(value => typeof value === "number" && Number.isFinite(value))
    ) continue;
    seen.add(endpointKey.toLowerCase());
    result.push({
      endpoint_key: endpointKey,
      output: outputKind,
      ...(outputIndex > 0 ? { output_index: outputIndex } : {}),
      model_point: JSON.parse(JSON.stringify(modelPoint)) as MepDraftContinuationEndpointPlan["model_point"],
      direction_xyz: [...direction] as [number, number, number],
      source_observation_ids: Array.isArray(row.source_observation_ids)
        ? row.source_observation_ids.map(clean).filter(Boolean)
        : [],
      system_classification: clean(row.system_classification),
      size: clean(row.size),
      state: "unresolved_continuation",
      element_id: elementId
    });
  }
  return result;
}

function normalizeActionOutput(value: unknown): ExistingConditionsPriorActionOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const actionKey = clean(row.action_key ?? row.actionKey);
  if (!actionKey) return null;
  const output: ExistingConditionsPriorActionOutput = {
    action_key: actionKey,
    created_element_ids: normalizeIds(row.created_element_ids ?? row.createdElementIds),
    affected_element_ids: normalizeIds(row.affected_element_ids ?? row.affectedElementIds),
    route_segment_element_ids: normalizeIds(row.route_segment_element_ids ?? row.routeSegmentElementIds),
    route_start_element_ids: normalizeIds(row.route_start_element_ids ?? row.routeStartElementIds),
    route_end_element_ids: normalizeIds(row.route_end_element_ids ?? row.routeEndElementIds),
    split_main_start_element_ids: normalizeIds(
      row.split_main_start_element_ids ?? row.splitMainStartElementIds
    ),
    split_main_end_element_ids: normalizeIds(
      row.split_main_end_element_ids ?? row.splitMainEndElementIds
    )
  };
  const continuationEndpoints = normalizeContinuationEndpoints(
    row.continuation_endpoints ?? row.continuationEndpoints,
    output
  );
  if (continuationEndpoints.length > 0) output.continuation_endpoints = continuationEndpoints;
  return output;
}

function workflowForHash(workflow: AtomicMepDraftWorkflowRequest): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  cloned.dryRun = true;
  delete cloned.stageKey;
  delete cloned.priorActionOutputs;
  return cloned;
}

function validateWorkflow(workflow: AtomicMepDraftWorkflowRequest): void {
  normalizedSha256(workflow.inputFingerprintSha256, "workflow_fingerprint");
  if (!Array.isArray(workflow.operations) || workflow.operations.length === 0) {
    throw new Error("existing_conditions_stage_operations_required");
  }
  const keys = workflow.operations.map(operation => clean(operation.action_key));
  if (keys.some(key => !key) || new Set(keys.map(key => key.toLowerCase())).size !== keys.length) {
    throw new Error("existing_conditions_stage_action_keys_must_be_unique");
  }
  const known = new Set(keys.map(key => key.toLowerCase()));
  const endpointKeys = new Set<string>();
  for (const operation of workflow.operations) {
    for (const dependency of operation.depends_on ?? []) {
      if (!known.has(clean(dependency).toLowerCase())) {
        throw new Error(
          `existing_conditions_stage_unknown_dependency:${operation.action_key}:${dependency}`
        );
      }
    }
    if (operation.execution_mode === "provisional_backbone_batch") {
      if (!clean(operation.provisional_batch_key)) {
        throw new Error(`existing_conditions_stage_batch_key_required:${operation.action_key}`);
      }
      if (clean(operation.path).toLowerCase() !== "/revit/mep-route-workflow") {
        throw new Error(`existing_conditions_stage_batch_route_only:${operation.action_key}`);
      }
      if ((operation.depends_on ?? []).length > 0) {
        throw new Error(`existing_conditions_stage_batch_must_be_dependency_free:${operation.action_key}`);
      }
    } else if (clean(operation.provisional_batch_key)) {
      throw new Error(`existing_conditions_stage_batch_mode_required:${operation.action_key}`);
    }
    for (const endpoint of operation.continuation_endpoints ?? []) {
      const key = clean(endpoint.endpoint_key).toLowerCase();
      if (!key || endpointKeys.has(key)) {
        throw new Error(`existing_conditions_stage_continuation_key_invalid:${operation.action_key}`);
      }
      endpointKeys.add(key);
      if (endpoint.output !== "route_start" && endpoint.output !== "route_end") {
        throw new Error(`existing_conditions_stage_continuation_output_invalid:${operation.action_key}`);
      }
    }
  }
}

function withPlannedContinuationEndpoints(
  workflow: AtomicMepDraftWorkflowRequest,
  output: ExistingConditionsPriorActionOutput
): ExistingConditionsPriorActionOutput {
  const operation = workflow.operations.find(candidate =>
    clean(candidate.action_key).toLowerCase() === output.action_key.toLowerCase()
  );
  const continuationEndpoints = normalizeContinuationEndpoints(
    operation?.continuation_endpoints,
    output
  );
  return continuationEndpoints.length > 0
    ? { ...output, continuation_endpoints: continuationEndpoints }
    : output;
}

export function registerExistingConditionsStagedWorkflow(args: {
  sessionId: string;
  sourceFrameId: string;
  sourceViewId: number;
  registrationContextId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  executionBoundary?: "compile_only" | "staged_execution";
}): ExistingConditionsRepairLedgerEntry {
  validateWorkflow(args.workflow);
  const workflowSha256 = sha256(workflowForHash(args.workflow));
  return appendEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: args.workflow.inputFingerprintSha256,
    workflowSha256,
    event: "workflow_registered",
    status: "provisional",
    acceptedProgress: true,
    actionKeys: args.workflow.operations.map(operation => operation.action_key),
    payload: {
      source_frame_id: clean(args.sourceFrameId),
      source_view_id: args.sourceViewId,
      registration_context_id: clean(args.registrationContextId),
      execution_boundary: args.executionBoundary ?? "staged_execution",
      workflow: JSON.parse(JSON.stringify(args.workflow))
    },
    nextRepair: "Dry-run the next dependency-ready stage."
  });
}

export function latestExistingConditionsStagedWorkflow(sessionId: string): {
  source_frame_id: string;
  source_view_id: number;
  registration_context_id: string;
  execution_boundary: "compile_only" | "staged_execution";
  workflow: AtomicMepDraftWorkflowRequest;
  workflow_sha256: string;
  updated_at_ms: number;
} | null {
  const entry = readExistingConditionsRepairLedger(sessionId)
    .filter(item => item.event === "workflow_registered")
    .at(-1);
  if (!entry) return null;
  const workflow = entry.payload.workflow as AtomicMepDraftWorkflowRequest | undefined;
  if (!workflow) return null;
  validateWorkflow(workflow);
  return {
    source_frame_id: clean(entry.payload.source_frame_id),
    source_view_id: Number(entry.payload.source_view_id),
    registration_context_id: clean(entry.payload.registration_context_id),
    execution_boundary: entry.payload.execution_boundary === "compile_only"
      ? "compile_only"
      : "staged_execution",
    workflow: JSON.parse(JSON.stringify(workflow)) as AtomicMepDraftWorkflowRequest,
    workflow_sha256: entry.workflow_sha256,
    updated_at_ms: Date.parse(entry.ts) || Date.now()
  };
}

function entriesForWorkflow(
  sessionId: string,
  workflow: AtomicMepDraftWorkflowRequest
): {
  workflowSha256: string;
  entries: ExistingConditionsRepairLedgerEntry[];
} {
  validateWorkflow(workflow);
  const workflowSha256 = sha256(workflowForHash(workflow));
  const fingerprint = normalizedSha256(
    workflow.inputFingerprintSha256,
    "workflow_fingerprint"
  );
  return {
    workflowSha256,
    entries: readExistingConditionsRepairLedger(sessionId).filter(entry =>
      entry.workflow_fingerprint_sha256 === fingerprint &&
      entry.workflow_sha256 === workflowSha256
    )
  };
}

function acceptedOutputs(
  entries: ExistingConditionsRepairLedgerEntry[]
): ExistingConditionsPriorActionOutput[] {
  const byAction = new Map<string, ExistingConditionsPriorActionOutput>();
  for (const entry of entries) {
    if (
      entry.event !== "stage_applied" ||
      entry.status !== "provisional" ||
      !stageAccepted(entries, entry.stage_key ?? "")
    ) continue;
    const values = Array.isArray(entry.payload.action_outputs)
      ? entry.payload.action_outputs
      : [];
    for (const value of values) {
      const normalized = normalizeActionOutput(value);
      if (normalized) byAction.set(normalized.action_key.toLowerCase(), normalized);
    }
  }
  return Array.from(byAction.values());
}

function stageApplied(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "stage_applied" &&
    entry.status === "provisional" &&
    entry.stage_key === stageKey
  );
}

function stageReadbackAccepted(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "readback_accepted" &&
    entry.status === "accepted" &&
    entry.stage_key === stageKey
  );
}

function stageVisualAccepted(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "visual_accepted" &&
    entry.status === "accepted" &&
    entry.stage_key === stageKey &&
    recordedStageArtifactValid(entry, "visual")
  );
}

function stageContinuationAccepted(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "continuation_accepted" &&
    entry.status === "accepted" &&
    entry.stage_key === stageKey
  );
}

function stageContinuationEndpoints(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): NonNullable<ExistingConditionsPriorActionOutput["continuation_endpoints"]> {
  const applied = entries
    .filter(entry =>
      entry.event === "stage_applied" &&
      entry.status === "provisional" &&
      entry.stage_key === stageKey
    )
    .at(-1);
  if (!applied || !Array.isArray(applied.payload.action_outputs)) return [];
  return applied.payload.action_outputs.flatMap(value =>
    normalizeActionOutput(value)?.continuation_endpoints ?? []
  );
}

function stageCheckpointSaved(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "checkpoint_saved" &&
    entry.status === "accepted" &&
    entry.stage_key === stageKey &&
    recordedStageArtifactValid(entry, "checkpoint")
  );
}

function stageAccepted(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return stageApplied(entries, stageKey) &&
    stageReadbackAccepted(entries, stageKey) &&
    (stageContinuationEndpoints(entries, stageKey).length === 0 ||
      stageContinuationAccepted(entries, stageKey)) &&
    stageVisualAccepted(entries, stageKey) &&
    stageCheckpointSaved(entries, stageKey);
}

function appliedStageEntry(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): ExistingConditionsRepairLedgerEntry | null {
  return entries
    .filter(entry =>
      entry.event === "stage_applied" &&
      entry.status === "provisional" &&
      entry.stage_key === stageKey
    )
    .at(-1) ?? null;
}

function actionOutputIds(entry: ExistingConditionsRepairLedgerEntry): number[] {
  const outputs = Array.isArray(entry.payload.action_outputs)
    ? entry.payload.action_outputs
    : [];
  return normalizeIds([
    ...normalizeIds(entry.payload.created_element_ids),
    ...outputs.flatMap(value => {
      const normalized = normalizeActionOutput(value);
      return normalized
          ? [
            ...normalized.created_element_ids,
            ...(normalized.affected_element_ids ?? []),
            ...(normalized.route_segment_element_ids ?? []),
            ...(normalized.route_start_element_ids ?? []),
            ...(normalized.route_end_element_ids ?? []),
            ...(normalized.split_main_start_element_ids ?? []),
            ...(normalized.split_main_end_element_ids ?? []),
            ...(normalized.continuation_endpoints ?? []).map(endpoint => endpoint.element_id)
          ]
        : [];
    })
  ]);
}

function stageResolvedByAppliedRepair(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  const rejected = entries
    .filter(entry => entry.event === "stage_rejected" && entry.stage_key === stageKey)
    .at(-1);
  if (!rejected) return false;
  const requiredActionKeys = Array.from(new Set(
    rejected.action_keys.map(clean).filter(Boolean).map(value => value.toLowerCase())
  ));
  if (requiredActionKeys.length === 0) return false;
  const acceptedRepairActionKeys = new Set(
    entries
      .filter(entry =>
        entry.event === "repair_registered" &&
        clean(entry.payload.supersedes_stage_key) === stageKey &&
        entry.stage_key != null &&
        stageAccepted(entries, entry.stage_key)
      )
      .flatMap(entry => entry.action_keys.map(clean))
      .filter(Boolean)
      .map(value => value.toLowerCase())
  );
  return requiredActionKeys.every(actionKey => acceptedRepairActionKeys.has(actionKey));
}

function stageDryRunAccepted(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "dry_run_accepted" &&
    entry.status === "accepted" &&
    entry.stage_key === stageKey
  );
}

function unresolvedRejectedStage(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): ExistingConditionsRepairLedgerEntry | null {
  const rejected = entries
    .filter(entry => entry.event === "stage_rejected" && entry.stage_key === stageKey)
    .at(-1);
  if (!rejected) return null;
  const laterRepair = entries.some(entry =>
    entry.sequence > rejected.sequence &&
    entry.event === "repair_registered" &&
    clean(entry.payload.supersedes_stage_key) === stageKey
  );
  return laterRepair ? null : rejected;
}

function repairOperationFromEntry(
  entry: ExistingConditionsRepairLedgerEntry
): StagedOperation | null {
  const value = entry.payload.operation;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operation = JSON.parse(JSON.stringify(value)) as StagedOperation;
  if (!clean(operation.action_key) || !clean(operation.path)) return null;
  return operation;
}

function rejectedBatchOperations(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): StagedOperation[] {
  const registered = entries
    .filter(entry =>
      entry.event === "stage_registered" &&
      entry.stage_key === stageKey &&
      clean(entry.payload.execution_mode) === "provisional_backbone_batch"
    )
    .at(-1);
  if (!registered || !Array.isArray(registered.payload.operations)) return [];
  return registered.payload.operations
    .map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const operation = JSON.parse(JSON.stringify(value)) as StagedOperation;
      if (!clean(operation.action_key) || !clean(operation.path)) return null;
      delete operation.provisional_batch_key;
      operation.execution_mode = "single_action";
      return operation;
    })
    .filter((value): value is StagedOperation => value != null);
}

function registerAutomaticBatchScopeReduction(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  entries: ExistingConditionsRepairLedgerEntry[];
  rejected: ExistingConditionsRepairLedgerEntry;
}): boolean {
  if (
    args.rejected.payload.rollback_verified !== true ||
    normalizeIds(args.rejected.payload.residual_created_element_ids).length > 0
  ) {
    return false;
  }
  const stageKey = clean(args.rejected.stage_key);
  if (!stageKey) return false;
  const operations = rejectedBatchOperations(args.entries, stageKey);
  if (operations.length < 2) return false;
  let registeredAny = false;
  for (const operation of operations) {
    const alreadyRegistered = args.entries.some(entry =>
      entry.event === "repair_registered" &&
      clean(entry.payload.supersedes_stage_key) === stageKey &&
      entry.action_keys.some(actionKey =>
        clean(actionKey).toLowerCase() === clean(operation.action_key).toLowerCase()
      )
    );
    if (alreadyRegistered) continue;
    const repairStageKey = `repair:${sha256({
      supersedes_stage_key: stageKey,
      action_key: clean(operation.action_key).toLowerCase(),
      operation
    }).slice(0, 24)}`;
    registerExistingConditionsRepairAction({
      sessionId: args.sessionId,
      workflow: args.workflow,
      supersedesStageKey: stageKey,
      repairStageKey,
      operation,
      reason: "automatic_batch_scope_reduction_after_verified_clean_rollback",
      nextRepair: "Dry-run this single backbone action; preserve accepted siblings and continue through the remaining split stages."
    });
    registeredAny = true;
  }
  return registeredAny;
}

export function buildNextExistingConditionsStagePlan(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
}): ExistingConditionsStagePlan {
  const { entries, workflowSha256 } = entriesForWorkflow(
    args.sessionId,
    args.workflow
  );
  const outputs = acceptedOutputs(entries);
  const appliedActionKeys = new Set(
    outputs.map(output => output.action_key.toLowerCase())
  );
  const registration = entries.find(entry => entry.event === "workflow_registered");
  const sourceViewId = Number(registration?.payload.source_view_id);
  const pendingApplied = entries.find(entry =>
    entry.event === "stage_applied" &&
    entry.status === "provisional" &&
    entry.stage_key != null &&
    !stageAccepted(entries, entry.stage_key)
  );
  if (pendingApplied?.stage_key) {
    const stageKey = pendingApplied.stage_key;
    const actionKeys = pendingApplied.action_keys.map(clean).filter(Boolean);
    const actionKey = actionKeys[0] ?? "stage";
    const ids = actionOutputIds(pendingApplied);
    const priorIds = outputs.flatMap(output => [
      ...output.created_element_ids,
      ...(output.affected_element_ids ?? []),
      ...(output.route_segment_element_ids ?? []),
      ...(output.route_start_element_ids ?? []),
      ...(output.route_end_element_ids ?? []),
      ...(output.split_main_start_element_ids ?? []),
      ...(output.split_main_end_element_ids ?? []),
      ...(output.continuation_endpoints ?? []).map(endpoint => endpoint.element_id)
    ]);
    const verificationIds = normalizeIds([...ids, ...priorIds]);
    if (!stageReadbackAccepted(entries, stageKey)) {
      return {
        state: "verify_readback",
        stage_key: stageKey,
        action_key: actionKey,
        action_keys: actionKeys,
        method: "POST",
        path: ids.length > 0 ? "/revit/get-element-summary" : "/revit/get-connectors",
        body: { elementIds: ids.length > 0 ? ids : verificationIds },
        accepted_action_outputs: outputs
      };
    }
    const continuationEndpoints = stageContinuationEndpoints(entries, stageKey);
    if (continuationEndpoints.length > 0 && !stageContinuationAccepted(entries, stageKey)) {
      return {
        state: "verify_continuation",
        stage_key: stageKey,
        action_key: actionKey,
        action_keys: actionKeys,
        method: "POST",
        path: "/revit/get-connectors",
        body: {
          elementIds: normalizeIds(continuationEndpoints.map(endpoint => endpoint.element_id)),
          includeAllRefs: true,
          includeCoordinateSystem: true,
          maxConnectorsPerElement: 16
        },
        accepted_action_outputs: outputs
      };
    }
    if (!stageVisualAccepted(entries, stageKey)) {
      return {
        state: "verify_visual",
        stage_key: stageKey,
        action_key: actionKey,
        action_keys: actionKeys,
        method: "POST",
        path: "/revit/highlight-and-export",
        body: {
          ...(Number.isSafeInteger(sourceViewId) && sourceViewId > 0
            ? { viewId: sourceViewId }
            : {}),
          elementIds: verificationIds,
          focusElementIds: verificationIds,
          focusPaddingFt: 18,
          imageSize: 2200,
          overrideStyle: {
            lineWeight: 12,
            r: 255,
            g: 0,
            b: 255
          },
          fileName: `existing_conditions_${stageKey.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`
        },
        accepted_action_outputs: outputs
      };
    }
    const safeStageKey = stageKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    return {
      state: "checkpoint",
      stage_key: stageKey,
      action_key: actionKey,
      action_keys: actionKeys,
      method: "POST",
      path: "/revit/save-as",
      body: {
        filePath: path.join(
          existingConditionsRepairLedgerSessionDir(args.sessionId),
          "existing_conditions_checkpoints",
          `${safeStageKey}.rvt`
        ),
        overwrite: true,
        compact: false,
        maximumBackups: 1,
        dryRun: false
      },
      accepted_action_outputs: outputs
    };
  }
  const repairs = entries
    .filter(entry => entry.event === "repair_registered")
    .map(entry => ({ entry, operation: repairOperationFromEntry(entry) }))
    .filter((value): value is {
      entry: ExistingConditionsRepairLedgerEntry;
      operation: StagedOperation;
    } => value.operation != null)
    .filter(value => !stageAccepted(entries, value.entry.stage_key ?? ""));

  let operations: StagedOperation[] = [];
  let stageKey = "";
  if (repairs.length > 0) {
    const repair = repairs[0]!;
    operations = [repair.operation];
    stageKey = repair.entry.stage_key ?? "";
  } else {
    for (const candidate of args.workflow.operations) {
      const candidateActionKey = clean(candidate.action_key).toLowerCase();
      if (appliedActionKeys.has(candidateActionKey)) continue;
      const isBackboneBatch = candidate.execution_mode === "provisional_backbone_batch";
      const batchCandidates = isBackboneBatch
        ? args.workflow.operations.filter(operation =>
            operation.execution_mode === "provisional_backbone_batch" &&
            clean(operation.provisional_batch_key).toLowerCase() ===
              clean(candidate.provisional_batch_key).toLowerCase() &&
            !appliedActionKeys.has(clean(operation.action_key).toLowerCase())
          ).slice(0, 8)
        : [candidate];
      const batchIdentity = batchCandidates.map(operation => clean(operation.action_key).toLowerCase());
      const candidateStageKey = isBackboneBatch
        ? `backbone:${sha256({
            batch_key: clean(candidate.provisional_batch_key).toLowerCase(),
            action_keys: batchIdentity
          }).slice(0, 20)}`
        : `operation:${candidate.action_key}`;
      if (
        stageAccepted(entries, candidateStageKey) ||
        stageResolvedByAppliedRepair(entries, candidateStageKey)
      ) continue;
      const rejected = unresolvedRejectedStage(entries, candidateStageKey);
      if (rejected) {
        if (registerAutomaticBatchScopeReduction({
          sessionId: args.sessionId,
          workflow: args.workflow,
          entries,
          rejected
        })) {
          return buildNextExistingConditionsStagePlan(args);
        }
        return {
          state: "blocked",
          stage_key: candidateStageKey,
          action_key: candidate.action_key,
          reason: clean(rejected.payload.error) || "registered_stage_rejected",
          accepted_action_outputs: outputs
        };
      }
      const dependencies = (candidate.depends_on ?? []).map(value =>
        clean(value).toLowerCase()
      );
      if (!dependencies.every(dependency => appliedActionKeys.has(dependency))) {
        continue;
      }
      operations = batchCandidates;
      stageKey = candidateStageKey;
      break;
    }
  }

  if (operations.length === 0) {
    const remaining = args.workflow.operations.filter(candidate =>
      !appliedActionKeys.has(clean(candidate.action_key).toLowerCase()) &&
      !stageAccepted(entries, `operation:${candidate.action_key}`) &&
      !stageResolvedByAppliedRepair(entries, `operation:${candidate.action_key}`)
    );
    if (remaining.length > 0) {
      return {
        state: "blocked",
        stage_key: null,
        action_key: null,
        reason: "no_dependency_ready_stage",
        accepted_action_outputs: outputs
      };
    }
    return {
      state: "awaiting_readback",
      accepted_action_outputs: outputs
    };
  }

  appendEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: args.workflow.inputFingerprintSha256,
    workflowSha256,
    event: "stage_registered",
    status: "provisional",
    acceptedProgress: true,
    stageKey,
    actionKeys: operations.map(operation => operation.action_key),
    payload: {
      operation: operations.length === 1 ? operations[0] : null,
      operations,
      execution_mode: operations.length > 1 ? "provisional_backbone_batch" : "single_action",
      provisional_batch_key: operations.length > 1
        ? clean(operations[0]?.provisional_batch_key)
        : null,
      accepted_prior_action_keys: outputs.map(output => output.action_key)
    },
    nextRepair: operations.length > 1
      ? "Dry-run this bounded provisional backbone batch only."
      : "Dry-run this stage only."
  });

  const dryRunAccepted = stageDryRunAccepted(entries, stageKey);
  const expectedMaximum = operations.reduce(
    (sum, operation) => sum + Math.max(0, Number(operation.expected_created_max) || 0),
    0
  );
  const maximumCreatedElements = Math.max(
    1,
    Math.min(
      Number(args.workflow.maximumCreatedElements) || 500,
      Number.isFinite(expectedMaximum) && expectedMaximum > 0
        ? expectedMaximum
        : 1
    )
  );
  const request: AtomicMepDraftWorkflowRequest = {
    ...JSON.parse(JSON.stringify(args.workflow)),
    operations: JSON.parse(JSON.stringify(operations)) as StagedOperation[],
    stageKey,
    priorActionOutputs: outputs,
    dryRun: !dryRunAccepted,
    maximumCreatedElements
  };
  return {
    state: dryRunAccepted ? "apply" : "dry_run",
    stage_key: stageKey,
    action_key: operations[0]!.action_key,
    action_keys: operations.map(operation => operation.action_key),
    request,
    accepted_action_outputs: outputs
  };
}

export function recordExistingConditionsStageResult(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  result: Record<string, unknown>;
}): ExistingConditionsRepairLedgerEntry | null {
  const { entries, workflowSha256 } = entriesForWorkflow(args.sessionId, args.workflow);
  const fingerprint = normalizedSha256(
    args.workflow.inputFingerprintSha256,
    "workflow_fingerprint"
  );
  const resultFingerprint = clean(
    args.result.inputFingerprintSha256
  ).toLowerCase();
  if (resultFingerprint !== fingerprint) return null;
  const stageKey = clean(args.result.stageKey);
  if (!stageKey) return null;
  const status = clean(args.result.status).toLowerCase();
  const dryRun = args.result.dryRun === true;
  const operationOutputs = Array.isArray(args.result.operationOutputs)
    ? args.result.operationOutputs
    : [];
  const normalizedOutputs = operationOutputs
    .map(normalizeActionOutput)
    .filter((value): value is ExistingConditionsPriorActionOutput => value != null)
    .map(output => withPlannedContinuationEndpoints(args.workflow, output));
  const failedOperation = args.result.failedOperation &&
    typeof args.result.failedOperation === "object" &&
    !Array.isArray(args.result.failedOperation)
    ? args.result.failedOperation as Record<string, unknown>
    : null;
  const reportedOperationActionKeys = Array.isArray(args.result.operations)
    ? (args.result.operations as Array<Record<string, unknown>>)
      .map(value => clean(value.actionKey))
      .filter(Boolean)
    : [];
  const reportedActionKeys = normalizedOutputs.length > 0
    ? normalizedOutputs.map(output => output.action_key)
    : reportedOperationActionKeys.length > 0
      ? reportedOperationActionKeys
    : failedOperation && clean(failedOperation.actionKey)
      ? [clean(failedOperation.actionKey)]
      : [];
  const registeredStage = entries
    .filter(entry => entry.event === "stage_registered" && entry.stage_key === stageKey)
    .at(-1);
  const actionKeys = (
    (status === "blocked" || clean(args.result.error)) &&
    clean(registeredStage?.payload.execution_mode) === "provisional_backbone_batch"
  )
    ? registeredStage!.action_keys.map(clean).filter(Boolean)
    : reportedActionKeys;

  if (
    dryRun &&
    status === "dryrunready" &&
    args.result.rollbackVerified === true &&
    Array.isArray(args.result.residualCreatedElementIds) &&
    args.result.residualCreatedElementIds.length === 0 &&
    !clean(args.result.error)
  ) {
    return appendEntry({
      sessionId: args.sessionId,
      workflowFingerprintSha256: fingerprint,
      workflowSha256,
      event: "dry_run_accepted",
      status: "accepted",
      acceptedProgress: true,
      stageKey,
      actionKeys,
      payload: {
        rollback_verified: true,
        transient_created_element_ids: normalizeIds(
          args.result.transientCreatedElementIds
        ),
        action_outputs: normalizedOutputs
      },
      nextRepair: "Apply this exact stage once."
    });
  }

  if (
    !dryRun &&
    status === "applied" &&
    args.result.atomic === true &&
    !clean(args.result.error)
  ) {
    const fallbackOutput = normalizedOutputs.length === 0 && actionKeys.length === 1
      ? [withPlannedContinuationEndpoints(args.workflow, {
        action_key: actionKeys[0]!,
          created_element_ids: normalizeIds(args.result.createdElementIds),
          affected_element_ids: normalizeIds(args.result.affectedElementIds)
        })]
      : [];
    return appendEntry({
      sessionId: args.sessionId,
      workflowFingerprintSha256: fingerprint,
      workflowSha256,
      event: "stage_applied",
      status: "provisional",
      acceptedProgress: true,
      stageKey,
      actionKeys,
      payload: {
        created_element_ids: normalizeIds(args.result.createdElementIds),
        action_outputs: normalizedOutputs.length > 0
          ? normalizedOutputs
          : fallbackOutput
      },
      nextRepair: "Read back this provisional stage and capture focused visual evidence before advancing."
    });
  }

  if (status === "blocked" || clean(args.result.error)) {
    return appendEntry({
      sessionId: args.sessionId,
      workflowFingerprintSha256: fingerprint,
      workflowSha256,
      event: "stage_rejected",
      status: "rejected_plan",
      acceptedProgress: false,
      stageKey,
      actionKeys,
      payload: {
        error: clean(args.result.error) || "stage_blocked",
        failed_operation: args.result.failedOperation ?? null,
        rollback_verified: args.result.rollbackVerified === true,
        residual_created_element_ids: normalizeIds(
          args.result.residualCreatedElementIds
        )
      },
      nextRepair: "Preserve accepted prior stages and register the smallest source-grounded repair."
    });
  }
  return null;
}

type VerifiedStageArtifact = {
  path: string;
  sha256: string;
  byte_length: number;
  scope_root: string;
};

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function supportedVisualBytes(bytes: Buffer): boolean {
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  return png || jpeg;
}

function claimedArtifactHash(value: Record<string, unknown>): string {
  return clean(value.sha256 ?? value.file_sha256 ?? value.fileSha256).toLowerCase();
}

function verifiedStageArtifact(args: {
  result: Record<string, unknown>;
  sessionId: string;
  kind: "visual" | "checkpoint";
  expectedPath?: string;
  expectedFileName?: string;
}): VerifiedStageArtifact | null {
  const resultJson = args.result.result_json;
  const row = resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
    ? resultJson as Record<string, unknown>
    : {};
  const candidates: Array<{ path: string; metadata: Record<string, unknown> }> = [
    row.path,
    row.filePath,
    row.file_path,
    row.imagePath,
    row.image_path,
    row.screenshot_path
  ].map(value => ({ path: clean(value), metadata: row })).filter(value => value.path.length > 0);
  for (const value of Array.isArray(args.result.attachments) ? args.result.attachments : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const attachment = value as Record<string, unknown>;
    const localPath = clean(attachment.local_path);
    // Inline data is never an artifact authority. It may accompany a real file,
    // but cannot replace a scoped filesystem artifact.
    if (localPath) candidates.push({ path: localPath, metadata: attachment });
  }
  const workspaceRoot = fs.realpathSync(ensureWorkspaceLayout().root);
  const checkpointRoot = fs.realpathSync(existingConditionsRepairLedgerSessionDir(args.sessionId));
  const scopeRoot = args.kind === "checkpoint" ? checkpointRoot : workspaceRoot;
  for (const candidate of candidates) {
    try {
      const candidatePath = path.isAbsolute(candidate.path)
        ? candidate.path
        : path.resolve(workspaceRoot, candidate.path);
      const realPath = fs.realpathSync(candidatePath);
      if (!pathWithin(scopeRoot, realPath)) continue;
      if (args.expectedPath && realPath !== fs.realpathSync(path.resolve(args.expectedPath))) continue;
      if (args.expectedFileName && path.basename(realPath) !== args.expectedFileName) continue;
      const stat = fs.statSync(realPath);
      if (!stat.isFile() || stat.size <= 0) continue;
      const bytes = fs.readFileSync(realPath);
      if (args.kind === "visual" && !supportedVisualBytes(bytes)) continue;
      const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
      const claimedHash = claimedArtifactHash(candidate.metadata);
      if (claimedHash && (!/^[a-f0-9]{64}$/.test(claimedHash) || claimedHash !== actualHash)) continue;
      const inline = clean(candidate.metadata.data_base64);
      if (inline) {
        let decoded: Buffer;
        try {
          decoded = Buffer.from(inline, "base64");
        } catch {
          continue;
        }
        if (decoded.length !== bytes.length || !decoded.equals(bytes)) continue;
      }
      return {
        path: realPath,
        sha256: actualHash,
        byte_length: bytes.length,
        scope_root: scopeRoot
      };
    } catch {
      continue;
    }
  }
  return null;
}

function recordedStageArtifactValid(
  entry: ExistingConditionsRepairLedgerEntry,
  kind: "visual" | "checkpoint"
): boolean {
  const value = entry.payload[kind === "visual" ? "visual_artifact" : "checkpoint_artifact"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  try {
    const expectedRoot = fs.realpathSync(kind === "visual"
      ? ensureWorkspaceLayout().root
      : existingConditionsRepairLedgerSessionDir(entry.session_id));
    const scopeRoot = fs.realpathSync(clean(artifact.scope_root));
    const artifactPath = fs.realpathSync(clean(artifact.path));
    if (scopeRoot !== expectedRoot || !pathWithin(expectedRoot, artifactPath)) return false;
    const bytes = fs.readFileSync(artifactPath);
    if (bytes.length <= 0 || bytes.length !== Number(artifact.byte_length)) return false;
    if (kind === "visual" && !supportedVisualBytes(bytes)) return false;
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    return actualHash === clean(artifact.sha256).toLowerCase() &&
      (kind !== "checkpoint" || clean(entry.payload.checkpoint_path) === artifactPath);
  } catch {
    return false;
  }
}

function collectNativeElementIds(value: unknown): number[] {
  const ids = new Set<number>();
  const visit = (node: unknown, key = ""): void => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (Number.isSafeInteger(node) && Number(node) > 0) {
      if (normalizedKey === "id" || normalizedKey.endsWith("elementid")) {
        ids.add(Number(node));
      }
      return;
    }
    if (Array.isArray(node)) {
      if (normalizedKey === "elementids" || normalizedKey === "ids") {
        for (const item of node) {
          if (Number.isSafeInteger(item) && Number(item) > 0) ids.add(Number(item));
          else visit(item);
        }
      } else {
        for (const item of node) visit(item);
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  visit(value);
  return Array.from(ids).sort((left, right) => left - right);
}

function containsMissingNativeElement(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMissingNativeElement);
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if ((Number.isSafeInteger(row.id) || Number.isSafeInteger(row.elementId)) && row.found === false) {
    return true;
  }
  return Object.values(row).some(containsMissingNativeElement);
}

function continuationConnectorMatches(
  endpoint: NonNullable<ExistingConditionsPriorActionOutput["continuation_endpoints"]>[number],
  result: Record<string, unknown>,
  originToleranceFt = 1 / 8,
  directionDotTolerance = 0.9
): boolean {
  if (Number(result.id) !== endpoint.element_id || result.ok === false) return false;
  const connectors = Array.isArray(result.connectors)
    ? result.connectors as Array<Record<string, unknown>>
    : [];
  return connectors.some(connector => {
    const origin = Array.isArray(connector.origin) ? connector.origin.map(Number) : [];
    if (
      origin.length < 3 ||
      !origin.slice(0, 3).every(Number.isFinite) ||
      Math.hypot(
        origin[0]! - endpoint.model_point.x,
        origin[1]! - endpoint.model_point.y,
        origin[2]! - endpoint.model_point.z
      ) > originToleranceFt
    ) {
      return false;
    }
    const coordinateSystem = connector.coordinateSystem &&
      typeof connector.coordinateSystem === "object" &&
      !Array.isArray(connector.coordinateSystem)
      ? connector.coordinateSystem as Record<string, unknown>
      : null;
    const basisZ = Array.isArray(coordinateSystem?.basisZ)
      ? coordinateSystem.basisZ.map(Number)
      : [];
    if (basisZ.length < 3 || !basisZ.slice(0, 3).every(Number.isFinite)) {
      // Older Bridge readbacks did not expose a coordinate system. Exact
      // registered origin remains mandatory; direction is checked whenever
      // the native API supplies it.
      return true;
    }
    const basisLength = Math.hypot(basisZ[0]!, basisZ[1]!, basisZ[2]!);
    const expectedLength = Math.hypot(...endpoint.direction_xyz);
    if (basisLength <= 1e-9 || expectedLength <= 1e-9) return false;
    const dot = (
      basisZ[0]! * endpoint.direction_xyz[0] +
      basisZ[1]! * endpoint.direction_xyz[1] +
      basisZ[2]! * endpoint.direction_xyz[2]
    ) / (basisLength * expectedLength);
    return dot >= directionDotTolerance;
  });
}

export function recordExistingConditionsVerificationResult(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  result: Record<string, unknown>;
}): ExistingConditionsRepairLedgerEntry | null {
  if (clean(args.result.status).toLowerCase() !== "done" || clean(args.result.error)) {
    return null;
  }
  const plan = buildNextExistingConditionsStagePlan({
    sessionId: args.sessionId,
    workflow: args.workflow
  });
  if (
    plan.state !== "verify_readback" &&
    plan.state !== "verify_continuation" &&
    plan.state !== "verify_visual" &&
    plan.state !== "checkpoint"
  ) {
    return null;
  }
  if (clean(args.result.path).toLowerCase() !== plan.path.toLowerCase()) {
    return null;
  }
  const resultJson = args.result.result_json;
  if (!resultJson || typeof resultJson !== "object") {
    return null;
  }
  const row = Array.isArray(resultJson) ? {} : resultJson as Record<string, unknown>;
  const nativeStatus = clean(row.status).toLowerCase();
  if (
    nativeStatus === "failed" ||
    nativeStatus === "blocked" ||
    clean(row.error)
  ) {
    return null;
  }
  const verifiedArtifact = plan.state === "verify_visual"
    ? verifiedStageArtifact({
        result: args.result,
        sessionId: args.sessionId,
        kind: "visual",
        expectedFileName: clean(plan.body?.fileName)
      })
    : plan.state === "checkpoint"
      ? verifiedStageArtifact({
          result: args.result,
          sessionId: args.sessionId,
          kind: "checkpoint",
          expectedPath: clean(plan.body.filePath)
        })
      : null;
  if ((plan.state === "verify_visual" || plan.state === "checkpoint") && !verifiedArtifact) return null;
  if (plan.state === "verify_readback") {
    const expectedIds = normalizeIds(plan.body?.elementIds);
    const returnedIds = new Set(collectNativeElementIds(resultJson));
    if (
      containsMissingNativeElement(resultJson) ||
      expectedIds.some(id => !returnedIds.has(id))
    ) {
      return null;
    }
  }
  if (plan.state === "verify_continuation") {
    const expectedIds = normalizeIds(plan.body?.elementIds);
    const returnedIds = new Set(collectNativeElementIds(resultJson));
    const connectorResults = Array.isArray(row.results)
      ? row.results as Array<Record<string, unknown>>
      : [];
    if (
      expectedIds.some(id => !returnedIds.has(id)) ||
      connectorResults.length < expectedIds.length ||
      connectorResults.some(item => item.ok === false || !Array.isArray(item.connectors) || item.connectors.length === 0) ||
      stageContinuationEndpoints(
        readExistingConditionsRepairLedger(args.sessionId),
        plan.stage_key
      ).some(endpoint =>
        !connectorResults.some(result => continuationConnectorMatches(endpoint, result))
      )
    ) {
      return null;
    }
  }

  const event = plan.state === "verify_readback"
    ? "readback_accepted"
    : plan.state === "verify_continuation"
      ? "continuation_accepted"
    : plan.state === "verify_visual"
      ? "visual_accepted"
      : "checkpoint_saved";
  return appendExistingConditionsAcceptanceEvent({
    sessionId: args.sessionId,
    workflow: args.workflow,
    event,
    stageKey: plan.stage_key,
    actionKeys: plan.action_keys,
    payload: {
      tool_action_id: clean(args.result.action_id),
      tool_path: plan.path,
      result_sha256: sha256(resultJson),
      verification_element_ids: normalizeIds(plan.body?.elementIds),
      ...(plan.state === "verify_visual"
        ? {
            visual_artifact_present: true,
            visual_artifact: verifiedArtifact
          }
        : plan.state === "verify_continuation"
          ? {
              continuation_connector_readback_present: true,
              continuation_endpoints: stageContinuationEndpoints(
                readExistingConditionsRepairLedger(args.sessionId),
                plan.stage_key
              )
            }
        : plan.state === "verify_readback"
          ? { native_readback_present: true }
          : {
              checkpoint_path: verifiedArtifact!.path,
              checkpoint_artifact: verifiedArtifact
            })
    },
    nextRepair: plan.state === "verify_readback"
      ? (stageContinuationEndpoints(
          readExistingConditionsRepairLedger(args.sessionId),
          plan.stage_key
        ).length > 0
          ? "Read back the registered continuation connectors before visual acceptance."
          : "Capture focused visual evidence for this stage.")
      : plan.state === "verify_continuation"
        ? "Capture focused visual evidence for this stage."
      : plan.state === "verify_visual"
        ? "Save a reversible model checkpoint before advancing."
        : "Stage accepted and checkpointed; dry-run the next dependency-ready action."
  });
}

export function registerExistingConditionsRepairAction(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  supersedesStageKey: string;
  repairStageKey: string;
  operation: StagedOperation;
  reason: string;
  nextRepair?: string;
}): ExistingConditionsRepairLedgerEntry {
  const { workflowSha256, entries } = entriesForWorkflow(
    args.sessionId,
    args.workflow
  );
  const stageKey = clean(args.repairStageKey);
  if (!stageKey) throw new Error("existing_conditions_repair_stage_key_required");
  if (!clean(args.operation.action_key) || !clean(args.operation.path)) {
    throw new Error("existing_conditions_repair_operation_invalid");
  }
  const supersedesStageKey = clean(args.supersedesStageKey);
  const rejected = entries
    .filter(entry =>
      entry.event === "stage_rejected" &&
      entry.stage_key === supersedesStageKey
    )
    .at(-1);
  if (!rejected) {
    throw new Error("existing_conditions_repair_rejected_stage_not_found");
  }
  const rejectedActionKeys = new Set(
    rejected.action_keys.map(clean).filter(Boolean).map(value => value.toLowerCase())
  );
  if (
    rejectedActionKeys.size > 0 &&
    !rejectedActionKeys.has(clean(args.operation.action_key).toLowerCase())
  ) {
    throw new Error(
      `existing_conditions_repair_action_key_mismatch:${Array.from(rejectedActionKeys).join(",")}`
    );
  }
  const reusedStageKey = entries
    .filter(entry =>
      entry.event === "repair_registered" &&
      entry.stage_key === stageKey
    )
    .at(-1);
  if (
    reusedStageKey &&
    (
      clean(reusedStageKey.payload.supersedes_stage_key) !== supersedesStageKey ||
      canonicalJson(reusedStageKey.payload.operation) !== canonicalJson(args.operation) ||
      clean(reusedStageKey.payload.reason) !== clean(args.reason)
    )
  ) {
    throw new Error("existing_conditions_repair_stage_key_already_used");
  }
  return appendEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: args.workflow.inputFingerprintSha256,
    workflowSha256,
    event: "repair_registered",
    status: "provisional",
    acceptedProgress: true,
    stageKey,
    actionKeys: [args.operation.action_key],
    payload: {
      supersedes_stage_key: supersedesStageKey,
      reason: clean(args.reason),
      operation: JSON.parse(JSON.stringify(args.operation))
    },
    nextRepair: clean(args.nextRepair) || "Dry-run the registered repair stage."
  });
}

function appendExistingConditionsAcceptanceEvent(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  event: Extract<
    ExistingConditionsStageEvent,
    "readback_accepted" | "continuation_accepted" | "visual_accepted" | "checkpoint_saved"
  >;
  stageKey?: string | null;
  actionKeys?: string[];
  payload: Record<string, unknown>;
  nextRepair?: string | null;
}): ExistingConditionsRepairLedgerEntry {
  const { workflowSha256 } = entriesForWorkflow(args.sessionId, args.workflow);
  return appendEntry({
    sessionId: args.sessionId,
    workflowFingerprintSha256: args.workflow.inputFingerprintSha256,
    workflowSha256,
    event: args.event,
    status: "accepted",
    acceptedProgress: true,
    stageKey: args.stageKey,
    actionKeys: args.actionKeys,
    payload: args.payload,
    nextRepair: args.nextRepair
  });
}
