import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { ensureWorkspaceLayout } from "../workspace.js";

export type ExistingConditionsStageStatus =
  | "provisional"
  | "accepted"
  | "rejected_plan"
  | "follow_up";

export type ExistingConditionsStageEvent =
  | "source_target_manifest_registered"
  | "source_disposition_recorded"
  | "workflow_registered"
  | "stage_registered"
  | "dry_run_accepted"
  | "stage_applied"
  | "stage_rejected"
  | "repair_registered"
  | "readback_accepted"
  | "continuation_accepted"
  | "visual_accepted"
  | "checkpoint_saved";

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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function safeSessionDirName(sessionId: string): string {
  const value = clean(sessionId);
  if (!value) throw new Error("existing_conditions_stage_session_id_required");
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function canonicalExistingConditionsLedgerJson(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("existing_conditions_stage_non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalExistingConditionsLedgerJson).join(",")}]`;
  }
  if (typeof value !== "object") return "null";
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .filter(key => row[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalExistingConditionsLedgerJson(row[key])}`)
    .join(",")}}`;
}

export function hashExistingConditionsLedgerValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalExistingConditionsLedgerJson(value))
    .digest("hex");
}

export function normalizeExistingConditionsLedgerSha256(
  value: unknown,
  field: string
): string {
  const normalized = clean(value).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`existing_conditions_stage_${field}_must_be_sha256`);
  }
  return normalized;
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

export function existingConditionsRepairLedgerSessionDir(sessionId: string): string {
  return ledgerPaths(sessionId).sessionDir;
}

export function existingConditionsRepairLedgerPath(sessionId: string): string {
  return ledgerPaths(sessionId).ledgerPath;
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
    const actualHash = hashExistingConditionsLedgerValue(withoutHash);
    if (claimedHash !== actualHash) {
      throw new Error(`existing_conditions_repair_ledger_hash_mismatch_line:${index + 1}`);
    }
    entries.push(parsed);
    previousHash = claimedHash;
  }
  return entries;
}

export function appendExistingConditionsRepairLedgerEntry(args: {
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
  const workflowFingerprintSha256 = normalizeExistingConditionsLedgerSha256(
    args.workflowFingerprintSha256,
    "workflow_fingerprint"
  );
  const workflowSha256 = normalizeExistingConditionsLedgerSha256(
    args.workflowSha256,
    "workflow"
  );
  const stageKey = clean(args.stageKey) || null;
  const actionKeys = Array.from(new Set((args.actionKeys ?? []).map(clean).filter(Boolean)));
  const payload = args.payload ?? {};
  const eventKey = hashExistingConditionsLedgerValue({
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
      entry_sha256: hashExistingConditionsLedgerValue(withoutHash)
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
