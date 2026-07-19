import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import type { AtomicMepDraftWorkflowRequest } from "./mep_draft_plan.js";

export type ExistingConditionsStageStatus =
  | "provisional"
  | "accepted"
  | "rejected_plan"
  | "follow_up";

export type ExistingConditionsStageEvent =
  | "workflow_registered"
  | "stage_registered"
  | "dry_run_accepted"
  | "stage_applied"
  | "stage_rejected"
  | "repair_registered"
  | "readback_accepted"
  | "visual_accepted"
  | "checkpoint_saved";

export type ExistingConditionsPriorActionOutput = {
  action_key: string;
  created_element_ids: number[];
  route_segment_element_ids?: number[];
  route_start_element_ids?: number[];
  route_end_element_ids?: number[];
  split_main_start_element_ids?: number[];
  split_main_end_element_ids?: number[];
};

type StagedOperation = AtomicMepDraftWorkflowRequest["operations"][number];

export type ExistingConditionsRepairLedgerEntry = {
  schema_version: 1;
  sequence: number;
  ts: string;
  session_id: string;
  workflow_fingerprint_sha256: string;
  workflow_sha256: string;
  event: ExistingConditionsStageEvent;
  status: ExistingConditionsStageStatus;
  accepted_progress: boolean;
  stage_key: string | null;
  action_keys: string[];
  event_key: string;
  payload: Record<string, unknown>;
  next_repair: string | null;
  previous_entry_sha256: string | null;
  entry_sha256: string;
};

export type ExistingConditionsStagePlan =
  | {
      state: "dry_run" | "apply";
      stage_key: string;
      action_key: string;
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
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function safeSessionDirName(sessionId: string): string {
  const value = clean(sessionId);
  if (!value) throw new Error("existing_conditions_stage_session_id_required");
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function canonicalJson(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("existing_conditions_stage_non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") return "null";
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .filter(key => row[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizedSha256(value: unknown, field: string): string {
  const normalized = clean(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`existing_conditions_stage_${field}_must_be_sha256`);
  }
  return normalized;
}

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => Number(item))
      .filter(item => Number.isSafeInteger(item) && item > 0)
  )).sort((left, right) => left - right);
}

function normalizeActionOutput(value: unknown): ExistingConditionsPriorActionOutput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const actionKey = clean(row.action_key ?? row.actionKey);
  if (!actionKey) return null;
  return {
    action_key: actionKey,
    created_element_ids: normalizeIds(row.created_element_ids ?? row.createdElementIds),
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
  for (const operation of workflow.operations) {
    for (const dependency of operation.depends_on ?? []) {
      if (!known.has(clean(dependency).toLowerCase())) {
        throw new Error(
          `existing_conditions_stage_unknown_dependency:${operation.action_key}:${dependency}`
        );
      }
    }
  }
}

function ledgerPaths(sessionId: string): {
  sessionDir: string;
  ledgerPath: string;
  lockPath: string;
} {
  const sessionDir = path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionDirName(sessionId)
  );
  return {
    sessionDir,
    ledgerPath: path.join(sessionDir, "existing_conditions_repair_ledger.jsonl"),
    lockPath: path.join(sessionDir, "existing_conditions_repair_ledger.lock")
  };
}

function entryHashInput(
  entry: Omit<ExistingConditionsRepairLedgerEntry, "entry_sha256">
): Record<string, unknown> {
  return { ...entry };
}

export function readExistingConditionsRepairLedger(
  sessionId: string
): ExistingConditionsRepairLedgerEntry[] {
  const { ledgerPath } = ledgerPaths(sessionId);
  if (!fs.existsSync(ledgerPath)) return [];
  const text = fs.readFileSync(ledgerPath, "utf8");
  if (!text.trim()) return [];
  const entries: ExistingConditionsRepairLedgerEntry[] = [];
  let previousHash: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let parsed: ExistingConditionsRepairLedgerEntry;
    try {
      parsed = JSON.parse(line) as ExistingConditionsRepairLedgerEntry;
    } catch {
      throw new Error(`existing_conditions_repair_ledger_malformed_line:${index + 1}`);
    }
    if (
      parsed.schema_version !== 1 ||
      parsed.sequence !== entries.length + 1 ||
      clean(parsed.session_id) !== clean(sessionId) ||
      parsed.previous_entry_sha256 !== previousHash
    ) {
      throw new Error(`existing_conditions_repair_ledger_invalid_chain_line:${index + 1}`);
    }
    const { entry_sha256: claimedHash, ...withoutHash } = parsed;
    const actualHash = sha256(entryHashInput(withoutHash));
    if (claimedHash !== actualHash) {
      throw new Error(`existing_conditions_repair_ledger_hash_mismatch_line:${index + 1}`);
    }
    entries.push(parsed);
    previousHash = claimedHash;
  }
  return entries;
}

function appendEntry(args: {
  sessionId: string;
  workflowFingerprintSha256: string;
  workflowSha256: string;
  event: ExistingConditionsStageEvent;
  status: ExistingConditionsStageStatus;
  acceptedProgress: boolean;
  stageKey?: string | null;
  actionKeys?: string[];
  payload?: Record<string, unknown>;
  nextRepair?: string | null;
}): ExistingConditionsRepairLedgerEntry {
  const sessionId = clean(args.sessionId);
  const workflowFingerprintSha256 = normalizedSha256(
    args.workflowFingerprintSha256,
    "workflow_fingerprint"
  );
  const workflowSha256 = normalizedSha256(args.workflowSha256, "workflow");
  const stageKey = clean(args.stageKey) || null;
  const actionKeys = Array.from(new Set(
    (args.actionKeys ?? []).map(clean).filter(Boolean)
  ));
  const payload = args.payload ?? {};
  const eventKey = sha256({
    workflow_fingerprint_sha256: workflowFingerprintSha256,
    workflow_sha256: workflowSha256,
    event: args.event,
    stage_key: stageKey,
    action_keys: actionKeys,
    payload
  });
  const { sessionDir, ledgerPath, lockPath } = ledgerPaths(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  let lockHandle: number | null = null;
  try {
    lockHandle = fs.openSync(lockPath, "wx");
  } catch {
    throw new Error("existing_conditions_repair_ledger_is_locked");
  }
  try {
    const existing = readExistingConditionsRepairLedger(sessionId);
    const duplicate = existing.find(entry => entry.event_key === eventKey);
    if (duplicate) return duplicate;
    const previousHash = existing.at(-1)?.entry_sha256 ?? null;
    const withoutHash: Omit<ExistingConditionsRepairLedgerEntry, "entry_sha256"> = {
      schema_version: 1,
      sequence: existing.length + 1,
      ts: new Date().toISOString(),
      session_id: sessionId,
      workflow_fingerprint_sha256: workflowFingerprintSha256,
      workflow_sha256: workflowSha256,
      event: args.event,
      status: args.status,
      accepted_progress: args.acceptedProgress,
      stage_key: stageKey,
      action_keys: actionKeys,
      event_key: eventKey,
      payload,
      next_repair: clean(args.nextRepair) || null,
      previous_entry_sha256: previousHash
    };
    const entry: ExistingConditionsRepairLedgerEntry = {
      ...withoutHash,
      entry_sha256: sha256(entryHashInput(withoutHash))
    };
    atomicAppendJsonlLine(ledgerPath, entry);
    return entry;
  } finally {
    if (lockHandle != null) {
      try {
        fs.closeSync(lockHandle);
      } catch {
        // best effort
      }
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best effort
    }
  }
}

export function registerExistingConditionsStagedWorkflow(args: {
  sessionId: string;
  sourceFrameId: string;
  sourceViewId: number;
  registrationContextId: string;
  workflow: AtomicMepDraftWorkflowRequest;
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
      workflow: JSON.parse(JSON.stringify(args.workflow))
    },
    nextRepair: "Dry-run the next dependency-ready stage."
  });
}

export function latestExistingConditionsStagedWorkflow(sessionId: string): {
  source_frame_id: string;
  source_view_id: number;
  registration_context_id: string;
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
    if (entry.event !== "stage_applied" || entry.status !== "accepted") continue;
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
    entry.status === "accepted" &&
    entry.stage_key === stageKey
  );
}

function stageResolvedByAppliedRepair(
  entries: ExistingConditionsRepairLedgerEntry[],
  stageKey: string
): boolean {
  return entries.some(entry =>
    entry.event === "repair_registered" &&
    clean(entry.payload.supersedes_stage_key) === stageKey &&
    entry.stage_key != null &&
    stageApplied(entries, entry.stage_key)
  );
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
  const repairs = entries
    .filter(entry => entry.event === "repair_registered")
    .map(entry => ({ entry, operation: repairOperationFromEntry(entry) }))
    .filter((value): value is {
      entry: ExistingConditionsRepairLedgerEntry;
      operation: StagedOperation;
    } => value.operation != null)
    .filter(value => !stageApplied(entries, value.entry.stage_key ?? ""));

  let operation: StagedOperation | null = null;
  let stageKey = "";
  if (repairs.length > 0) {
    const repair = repairs[0]!;
    operation = repair.operation;
    stageKey = repair.entry.stage_key ?? "";
  } else {
    for (const candidate of args.workflow.operations) {
      const candidateStageKey = `operation:${candidate.action_key}`;
      if (
        stageApplied(entries, candidateStageKey) ||
        stageResolvedByAppliedRepair(entries, candidateStageKey)
      ) continue;
      const rejected = unresolvedRejectedStage(entries, candidateStageKey);
      if (rejected) {
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
      operation = candidate;
      stageKey = candidateStageKey;
      break;
    }
  }

  if (!operation) {
    const remaining = args.workflow.operations.filter(candidate =>
      !stageApplied(entries, `operation:${candidate.action_key}`) &&
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
    actionKeys: [operation.action_key],
    payload: {
      operation,
      accepted_prior_action_keys: outputs.map(output => output.action_key)
    },
    nextRepair: "Dry-run this stage only."
  });

  const dryRunAccepted = stageDryRunAccepted(entries, stageKey);
  const expectedMaximum = Number(operation.expected_created_max);
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
    operations: [JSON.parse(JSON.stringify(operation))],
    stageKey,
    priorActionOutputs: outputs,
    dryRun: !dryRunAccepted,
    maximumCreatedElements
  };
  return {
    state: dryRunAccepted ? "apply" : "dry_run",
    stage_key: stageKey,
    action_key: operation.action_key,
    request,
    accepted_action_outputs: outputs
  };
}

export function recordExistingConditionsStageResult(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  result: Record<string, unknown>;
}): ExistingConditionsRepairLedgerEntry | null {
  const { workflowSha256 } = entriesForWorkflow(args.sessionId, args.workflow);
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
    .filter((value): value is ExistingConditionsPriorActionOutput => value != null);
  const failedOperation = args.result.failedOperation &&
    typeof args.result.failedOperation === "object" &&
    !Array.isArray(args.result.failedOperation)
    ? args.result.failedOperation as Record<string, unknown>
    : null;
  const actionKeys = normalizedOutputs.length > 0
    ? normalizedOutputs.map(output => output.action_key)
    : failedOperation && clean(failedOperation.actionKey)
      ? [clean(failedOperation.actionKey)]
      : Array.isArray(args.result.operations)
        ? (args.result.operations as Array<Record<string, unknown>>)
          .map(value => clean(value.actionKey))
          .filter(Boolean)
        : [];

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
      ? [{
          action_key: actionKeys[0]!,
          created_element_ids: normalizeIds(args.result.createdElementIds)
        }]
      : [];
    return appendEntry({
      sessionId: args.sessionId,
      workflowFingerprintSha256: fingerprint,
      workflowSha256,
      event: "stage_applied",
      status: "accepted",
      acceptedProgress: true,
      stageKey,
      actionKeys,
      payload: {
        created_element_ids: normalizeIds(args.result.createdElementIds),
        action_outputs: normalizedOutputs.length > 0
          ? normalizedOutputs
          : fallbackOutput
      },
      nextRepair: "Read back this accepted stage, then dry-run the next dependency-ready stage."
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
  const rejectedActionKey = clean(rejected.action_keys[0]);
  if (
    rejectedActionKey &&
    rejectedActionKey.toLowerCase() !== clean(args.operation.action_key).toLowerCase()
  ) {
    throw new Error(
      `existing_conditions_repair_action_key_mismatch:${rejectedActionKey}`
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

export function appendExistingConditionsAcceptanceEvent(args: {
  sessionId: string;
  workflow: AtomicMepDraftWorkflowRequest;
  event: Extract<
    ExistingConditionsStageEvent,
    "readback_accepted" | "visual_accepted" | "checkpoint_saved"
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

export function existingConditionsRepairLedgerPath(sessionId: string): string {
  return ledgerPaths(sessionId).ledgerPath;
}
