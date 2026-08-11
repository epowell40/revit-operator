import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import {
  createDefaultLocalGoalEvidenceAuthority,
  type GoalAuthorityContext,
  type GoalAuthorityEnvelope,
  type GoalEvidenceAuthorityProvider
} from "./authority.js";

type JsonMap = Record<string, unknown>;

export type GoalStatus = "draft" | "active" | "paused" | "blocked" | "complete" | "canceled" | "failed";
export type GoalLogKind = "action" | "evidence" | "validation";
export type GoalCriterionStatus = "pass" | "fail" | "unknown";
export type GoalWorkItemStatus = "pending" | "ready" | "in_progress" | "blocked" | "complete" | "failed" | "skipped";
export type GoalAssumptionStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type GoalValidatorStatus = "pass" | "fail" | "unknown";
export type GoalHumanApprovalStatus = "approved" | "rejected" | "unknown";

export type GoalEvidenceRecord =
  | {
      kind: "artifact";
      criterion: string;
      artifact: {
        path: string;
        sha256: string;
        size_bytes: number;
        scope: "workspace";
        verified_at: string;
      };
    }
  | {
      kind: "validator";
      criterion: string;
      validator: {
        identity: string;
        method: string;
        status: GoalValidatorStatus;
        verified_at: string;
        authority: {
          provider_id: string;
          receipt_id: string;
          assertion: unknown;
          issued_at: string;
          expires_at: string;
        };
      };
    }
  | {
      kind: "human_approval";
      criterion: string;
      approval: {
        approver_identity: string;
        method: string;
        status: GoalHumanApprovalStatus;
        recorded_at: string;
        approver_role: string;
        authority: {
          provider_id: string;
          receipt_id: string;
          assertion: unknown;
          issued_at: string;
          expires_at: string;
        };
      };
    };

let configuredGoalEvidenceAuthority: GoalEvidenceAuthorityProvider | null = null;

export function configureGoalEvidenceAuthorityProvider(provider: GoalEvidenceAuthorityProvider | null): void {
  configuredGoalEvidenceAuthority = provider;
}

function goalEvidenceAuthority(): GoalEvidenceAuthorityProvider {
  return configuredGoalEvidenceAuthority ?? createDefaultLocalGoalEvidenceAuthority();
}

export type GoalLogEntry = {
  id: string;
  ts: string;
  kind: GoalLogKind;
  summary: string;
  details?: JsonMap;
  actor?: string | null;
  artifact_paths?: string[];
  evidence?: GoalEvidenceRecord;
};

export type GoalCriterionResult = {
  criterion: string;
  status: GoalCriterionStatus;
  evidence_refs: string[];
  notes?: string;
};

export type GoalCompletionAudit = {
  id: string;
  requested_at: string;
  complete: boolean;
  criteria_results: GoalCriterionResult[];
  evidence_summary: string;
  remaining_work: string[];
  blockers: string[];
  recommendation: string;
};

export type GoalWorkItem = {
  id: string;
  title: string;
  status: GoalWorkItemStatus;
  scope: JsonMap | null;
  depends_on: string[];
  planned_actions: string[];
  evidence_refs: string[];
  blocker: string | null;
  result_summary: string | null;
  updated_at: string;
};

export type GoalAssumption = {
  id: string;
  statement: string;
  status: GoalAssumptionStatus;
  basis: string | null;
  evidence_refs: string[];
  updated_at: string;
};

export type GoalRecord = {
  id: string;
  revision?: number;
  title: string;
  objective: string;
  acceptance_criteria: string[];
  non_goals: string[];
  created_at: string;
  updated_at: string;
  status: GoalStatus;
  priority?: string | null;
  created_by?: string | null;
  current_phase?: string | null;
  current_step?: string | null;
  progress_summary: string;
  token_budget?: number | null;
  work_budget?: JsonMap | null;
  work_items: GoalWorkItem[];
  assumptions: GoalAssumption[];
  evidence_log: GoalLogEntry[];
  action_log: GoalLogEntry[];
  validation_log: GoalLogEntry[];
  completion_audit?: GoalCompletionAudit | null;
  related_thread_id?: string | null;
  related_session_id?: string | null;
  related_model_id?: string | null;
  related_project_id?: string | null;
  artifacts: string[];
  error?: string | null;
  blocker?: string | null;
};

export type GoalCreateInput = {
  title?: unknown;
  objective?: unknown;
  acceptance_criteria?: unknown;
  acceptanceCriteria?: unknown;
  non_goals?: unknown;
  nonGoals?: unknown;
  priority?: unknown;
  created_by?: unknown;
  createdBy?: unknown;
  current_phase?: unknown;
  currentPhase?: unknown;
  current_step?: unknown;
  currentStep?: unknown;
  progress_summary?: unknown;
  progressSummary?: unknown;
  token_budget?: unknown;
  tokenBudget?: unknown;
  work_budget?: unknown;
  workBudget?: unknown;
  work_items?: unknown;
  workItems?: unknown;
  assumptions?: unknown;
  related_thread_id?: unknown;
  relatedThreadId?: unknown;
  related_session_id?: unknown;
  relatedSessionId?: unknown;
  related_model_id?: unknown;
  relatedModelId?: unknown;
  related_project_id?: unknown;
  relatedProjectId?: unknown;
  artifacts?: unknown;
  status?: unknown;
};

export type GoalUpdateInput = Partial<GoalCreateInput> & {
  status?: unknown;
  error?: unknown;
  blocker?: unknown;
};

export type AgentGoalSetInput = GoalCreateInput & {
  session_id?: unknown;
  thread_id?: unknown;
  success_criteria?: unknown;
  successCriteria?: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function goalsRoot(): string {
  return ensureDir(path.join(ensureWorkspaceLayout().artifacts, "goals"));
}

function goalDir(goalId: string): string {
  return path.join(goalsRoot(), goalId);
}

function goalPath(goalId: string): string {
  return path.join(goalDir(goalId), "goal.json");
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const backupPath = `${filePath}.previous`;
  let handle: number | null = null;
  try {
    handle = fs.openSync(tempPath, "wx");
    fs.writeFileSync(handle, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (handle !== null) fs.closeSync(handle);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function readJson<T>(filePath: string): T | null {
  for (const candidate of [filePath, `${filePath}.previous`]) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8")) as T;
    } catch {
      // A torn/corrupt primary falls back to the last atomically replaced copy.
    }
  }
  return null;
}

function withGoalLock<T>(goalId: string, fn: () => T): T {
  const lockPath = path.join(ensureDir(goalDir(goalId)), "goal.lock");
  let handle: number;
  try {
    handle = fs.openSync(lockPath, "wx");
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs <= 60_000) throw new Error(`Goal ${goalId} is being updated; retry the operation.`);
    fs.unlinkSync(lockPath);
    handle = fs.openSync(lockPath, "wx");
  }
  try {
    return fn();
  } finally {
    fs.closeSync(handle);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }
}

function clip(value: unknown, max = 1000): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max).trim()}...`;
}

function asStringList(value: unknown, maxItems = 80, maxLength = 1000): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|;/g)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = clip(item, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function asJsonMap(value: unknown): JsonMap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as JsonMap) };
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeStatus(value: unknown): GoalStatus | null {
  const status = clip(value, 80).toLowerCase();
  if (
    status === "draft" ||
    status === "active" ||
    status === "paused" ||
    status === "blocked" ||
    status === "complete" ||
    status === "canceled" ||
    status === "failed"
  ) {
    return status;
  }
  if (status === "cancelled") return "canceled";
  return null;
}

function normalizeWorkItemStatus(value: unknown): GoalWorkItemStatus {
  const status = clip(value, 80).toLowerCase();
  if (["pending", "ready", "in_progress", "blocked", "complete", "failed", "skipped"].includes(status)) return status as GoalWorkItemStatus;
  return "pending";
}

function normalizeAssumptionStatus(value: unknown): GoalAssumptionStatus {
  const status = clip(value, 80).toLowerCase();
  if (["proposed", "accepted", "rejected", "superseded"].includes(status)) return status as GoalAssumptionStatus;
  return "proposed";
}

function normalizeWorkItems(value: unknown): GoalWorkItem[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("work_items must be an array.");
  if (value.length > 200) throw new Error("work_items supports at most 200 entries.");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const obj = item && typeof item === "object" && !Array.isArray(item) ? item as any : {};
    const id = clip(obj.id, 160) || randomUUID();
    if (seen.has(id)) throw new Error(`Duplicate work_items id '${id}'.`);
    seen.add(id);
    const title = clip(obj.title ?? obj.summary, 500);
    if (!title) throw new Error(`work_items[${index}].title is required.`);
    return {
      id,
      title,
      status: normalizeWorkItemStatus(obj.status),
      scope: asJsonMap(obj.scope),
      depends_on: asStringList(obj.depends_on ?? obj.dependsOn, 40, 160),
      planned_actions: asStringList(obj.planned_actions ?? obj.plannedActions, 40, 500),
      evidence_refs: asStringList(obj.evidence_refs ?? obj.evidenceRefs, 80, 500),
      blocker: clip(obj.blocker, 1000) || null,
      result_summary: clip(obj.result_summary ?? obj.resultSummary, 2000) || null,
      updated_at: clip(obj.updated_at ?? obj.updatedAt, 80) || nowIso()
    };
  });
}

function normalizeAssumptions(value: unknown): GoalAssumption[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("assumptions must be an array.");
  if (value.length > 100) throw new Error("assumptions supports at most 100 entries.");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const obj = item && typeof item === "object" && !Array.isArray(item) ? item as any : {};
    const id = clip(obj.id, 160) || randomUUID();
    if (seen.has(id)) throw new Error(`Duplicate assumptions id '${id}'.`);
    seen.add(id);
    const statement = clip(obj.statement ?? obj.summary, 1200);
    if (!statement) throw new Error(`assumptions[${index}].statement is required.`);
    return {
      id,
      statement,
      status: normalizeAssumptionStatus(obj.status),
      basis: clip(obj.basis ?? obj.source, 1000) || null,
      evidence_refs: asStringList(obj.evidence_refs ?? obj.evidenceRefs, 80, 500),
      updated_at: clip(obj.updated_at ?? obj.updatedAt, 80) || nowIso()
    };
  });
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[], max: number): T[] {
  const merged = new Map(existing.map(item => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].slice(-max);
}

function normalizeLogEntry(value: unknown, kind: GoalLogKind): GoalLogEntry {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as any) : {};
  const summary = clip(obj.summary ?? obj.text ?? obj.message ?? value, 2000);
  if (!summary) throw new Error(`${kind} summary is required.`);
  return {
    id: clip(obj.id, 120) || randomUUID(),
    ts: clip(obj.ts, 80) || nowIso(),
    kind,
    summary,
    ...(asJsonMap(obj.details) ? { details: asJsonMap(obj.details)! } : {}),
    actor: clip(obj.actor, 160) || null,
    artifact_paths: asStringList(obj.artifact_paths ?? obj.artifactPaths, 40, 600)
  };
}

function canonicalCriterion(value: unknown, criteria: string[]): string {
  const requested = clip(value, 1200);
  if (!requested) throw new Error("evidence.criterion is required.");
  const criterion = criteria.find(candidate => candidate.toLowerCase() === requested.toLowerCase());
  if (!criterion) throw new Error("evidence.criterion must exactly match a goal acceptance criterion.");
  return criterion;
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

function verifyArtifactEvidence(value: unknown, criteria: string[]): GoalEvidenceRecord {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? value as any : {};
  const criterion = canonicalCriterion(obj.criterion, criteria);
  const artifact = obj.artifact && typeof obj.artifact === "object" && !Array.isArray(obj.artifact) ? obj.artifact as any : {};
  const artifactPath = clip(artifact.path, 600);
  const expectedHash = clip(artifact.sha256, 128).toLowerCase();
  const scope = clip(artifact.scope, 40).toLowerCase();
  if (!artifactPath) throw new Error("artifact evidence requires artifact.path.");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("artifact evidence requires a SHA-256 hash.");
  if (scope !== "workspace") throw new Error("artifact evidence scope must be 'workspace'.");

  const workspaceRoot = path.resolve(ensureWorkspaceLayout().root);
  const candidate = path.resolve(path.isAbsolute(artifactPath) ? artifactPath : path.join(workspaceRoot, artifactPath));
  if (!isWithinRoot(workspaceRoot, candidate)) throw new Error("artifact evidence path must be under the workspace root.");
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`Artifact evidence file does not exist: ${artifactPath}`);
  const realRoot = fs.realpathSync(workspaceRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isWithinRoot(realRoot, realCandidate)) throw new Error("artifact evidence path resolves outside the workspace root.");
  const contents = fs.readFileSync(realCandidate);
  const actualHash = createHash("sha256").update(contents).digest("hex");
  if (actualHash !== expectedHash) throw new Error(`Artifact evidence SHA-256 mismatch for ${artifactPath}.`);
  const persistedPath = path.relative(workspaceRoot, candidate).split(path.sep).join("/");
  return {
    kind: "artifact",
    criterion,
    artifact: {
      path: persistedPath,
      sha256: actualHash,
      size_bytes: contents.byteLength,
      scope: "workspace",
      verified_at: nowIso()
    }
  };
}

function cloneAuthorityAssertion(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Goal authority assertion must be JSON-serializable.");
  }
  if (serialized === undefined || serialized.length > 32_768) throw new Error("Goal authority assertion is missing or too large.");
  return JSON.parse(serialized) as unknown;
}

function normalizeAuthorityEnvelope(value: unknown): GoalAuthorityEnvelope {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? value as any : {};
  const providerId = clip(obj.provider_id ?? obj.providerId, 120);
  if (!providerId) throw new Error("Trusted authority evidence requires authority.provider_id.");
  if (obj.assertion === undefined) throw new Error("Trusted authority evidence requires authority.assertion.");
  return { provider_id: providerId, assertion: cloneAuthorityAssertion(obj.assertion) };
}

function authorityContext(goal: GoalRecord, criterion: string): GoalAuthorityContext {
  return {
    goal_id: goal.id,
    session_id: goal.related_session_id ?? null,
    criterion,
    goal_owner_principal_id: goal.created_by ?? null
  };
}

function samePrincipalId(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function normalizeTypedEvidence(value: unknown, goal: GoalRecord): GoalEvidenceRecord | null {
  if (value === undefined || value === null) return null;
  const obj = value && typeof value === "object" && !Array.isArray(value) ? value as any : {};
  const kind = clip(obj.kind, 80).toLowerCase();
  if (kind === "artifact") return verifyArtifactEvidence(obj, goal.acceptance_criteria);
  const criterion = canonicalCriterion(obj.criterion, goal.acceptance_criteria);
  const context = authorityContext(goal, criterion);
  if (kind === "validator") {
    const validator = obj.validator && typeof obj.validator === "object" && !Array.isArray(obj.validator) ? obj.validator as any : {};
    if (validator.authority === undefined) {
      throw new Error("Validator evidence requires a trusted server-issued execution receipt; caller-provided identity or status is not accepted.");
    }
    const authority = normalizeAuthorityEnvelope(validator.authority);
    const verified = goalEvidenceAuthority().verifyValidatorExecutionReceipt(authority, context);
    if (verified.provider_id !== authority.provider_id) throw new Error("Validator authority provider verification mismatch.");
    if (!clip(verified.receipt_id, 160) || !clip(verified.validator_id, 240) || !clip(verified.method, 1000)) {
      throw new Error("Trusted validator execution receipt is incomplete.");
    }
    if (verified.status !== "pass" && verified.status !== "fail" && verified.status !== "unknown") {
      throw new Error("Trusted validator execution receipt has an invalid status.");
    }
    return {
      kind: "validator",
      criterion,
      validator: {
        identity: verified.validator_id,
        method: verified.method,
        status: verified.status,
        verified_at: nowIso(),
        authority: {
          provider_id: verified.provider_id,
          receipt_id: verified.receipt_id,
          assertion: authority.assertion,
          issued_at: verified.issued_at,
          expires_at: verified.expires_at
        }
      }
    };
  }
  if (kind === "human_approval") {
    const approval = obj.approval && typeof obj.approval === "object" && !Array.isArray(obj.approval) ? obj.approval as any : {};
    if (approval.authority === undefined) {
      throw new Error("Human approval evidence requires a trusted authenticated approval receipt; caller-provided identity or status is not accepted.");
    }
    const authority = normalizeAuthorityEnvelope(approval.authority);
    const verified = goalEvidenceAuthority().verifyHumanApproval(authority, context);
    if (verified.provider_id !== authority.provider_id) throw new Error("Human approval authority provider verification mismatch.");
    if (!clip(verified.receipt_id, 160) || !clip(verified.approver_principal_id, 240) || !clip(verified.approver_role, 120) || !clip(verified.method, 1000)) {
      throw new Error("Trusted human approval receipt is incomplete.");
    }
    if (samePrincipalId(verified.approver_principal_id, goal.created_by)) {
      throw new Error("Goal owners cannot approve their own goal completion.");
    }
    if (verified.status !== "approved" && verified.status !== "rejected" && verified.status !== "unknown") {
      throw new Error("Trusted human approval receipt has an invalid status.");
    }
    return {
      kind: "human_approval",
      criterion,
      approval: {
        approver_identity: verified.approver_principal_id,
        approver_role: verified.approver_role,
        method: verified.method,
        status: verified.status,
        recorded_at: nowIso(),
        authority: {
          provider_id: verified.provider_id,
          receipt_id: verified.receipt_id,
          assertion: authority.assertion,
          issued_at: verified.issued_at,
          expires_at: verified.expires_at
        }
      }
    };
  }
  throw new Error("evidence.kind must be artifact, validator, or human_approval.");
}

function authorityReceiptId(evidence: GoalEvidenceRecord): string | null {
  if (evidence.kind === "validator") return evidence.validator.authority?.receipt_id ?? null;
  if (evidence.kind === "human_approval") return evidence.approval.authority?.receipt_id ?? null;
  return null;
}

function assertReceiptNotReplayed(goal: GoalRecord, evidence: GoalEvidenceRecord): void {
  const receiptId = authorityReceiptId(evidence);
  if (!receiptId) return;
  const entries = [...goal.evidence_log, ...goal.validation_log];
  if (entries.some(entry => entry.evidence && authorityReceiptId(entry.evidence) === receiptId)) {
    throw new Error("Goal authority receipt replay was rejected.");
  }
}

function evaluatePersistedEvidence(evidence: GoalEvidenceRecord, goal: GoalRecord, replayed: boolean): GoalCriterionStatus {
  if (replayed) return "fail";
  if (evidence.kind === "validator") {
    try {
      const verified = goalEvidenceAuthority().verifyValidatorExecutionReceipt({
        provider_id: evidence.validator.authority.provider_id,
        assertion: evidence.validator.authority.assertion
      }, authorityContext(goal, evidence.criterion));
      if (
        verified.provider_id !== evidence.validator.authority.provider_id ||
        verified.receipt_id !== evidence.validator.authority.receipt_id
      ) return "fail";
      return verified.status;
    } catch {
      return "fail";
    }
  }
  if (evidence.kind === "human_approval") {
    try {
      const verified = goalEvidenceAuthority().verifyHumanApproval({
        provider_id: evidence.approval.authority.provider_id,
        assertion: evidence.approval.authority.assertion
      }, authorityContext(goal, evidence.criterion));
      if (
        verified.provider_id !== evidence.approval.authority.provider_id ||
        verified.receipt_id !== evidence.approval.authority.receipt_id ||
        samePrincipalId(verified.approver_principal_id, goal.created_by)
      ) return "fail";
      return verified.status === "approved" ? "pass" : verified.status === "rejected" ? "fail" : "unknown";
    } catch {
      return "fail";
    }
  }
  try {
    verifyArtifactEvidence(evidence, [evidence.criterion]);
    return "pass";
  } catch {
    return "fail";
  }
}

function normalizeCriterionResults(value: unknown, goal: GoalRecord): GoalCriterionResult[] {
  const entries = [...goal.evidence_log, ...goal.validation_log].filter(entry => entry.evidence);
  const receiptCounts = new Map<string, number>();
  for (const entry of entries) {
    const receiptId = entry.evidence ? authorityReceiptId(entry.evidence) : null;
    if (receiptId) receiptCounts.set(receiptId, (receiptCounts.get(receiptId) ?? 0) + 1);
  }
  const requested = Array.isArray(value) ? value : [];
  return goal.acceptance_criteria.map(criterion => {
    const exact = requested.find(item => {
      const obj = item && typeof item === "object" && !Array.isArray(item) ? (item as any) : {};
      return clip(obj.criterion, 1000).toLowerCase() === criterion.toLowerCase();
    });
    const obj = exact && typeof exact === "object" && !Array.isArray(exact) ? (exact as any) : {};
    const rawStatus = clip(obj.status, 80).toLowerCase();
    const requestedStatus: GoalCriterionStatus = rawStatus === "pass" || rawStatus === "passed" ? "pass" : rawStatus === "fail" || rawStatus === "failed" ? "fail" : "unknown";
    const requestedRefs = asStringList(obj.evidence_refs ?? obj.evidenceRefs, 40, 400);
    const resolved = requestedRefs.flatMap(ref => {
      const entry = entries.find(candidate => `${candidate.kind}:${candidate.id}` === ref);
      return entry?.evidence?.criterion === criterion ? [{ ref, evidence: entry.evidence }] : [];
    });
    const evidenceRefs = resolved.map(item => item.ref);
    const evidenceStatuses = resolved.map(item => {
      const receiptId = authorityReceiptId(item.evidence);
      return evaluatePersistedEvidence(item.evidence, goal, Boolean(receiptId && (receiptCounts.get(receiptId) ?? 0) > 1));
    });
    const status: GoalCriterionStatus = requestedStatus === "fail" || evidenceStatuses.includes("fail")
      ? "fail"
      : evidenceStatuses.includes("pass")
        ? "pass"
        : "unknown";
    const notes = clip(obj.notes, 1000) || (requestedStatus === "pass" && status !== "pass" ? "Passing status was not accepted because no valid typed persisted evidence resolved for this criterion." : "");
    return {
      criterion,
      status,
      evidence_refs: evidenceRefs,
      ...(notes ? { notes } : {})
    };
  });
}

const allowedTransitions: Record<GoalStatus, GoalStatus[]> = {
  draft: ["active", "canceled"],
  active: ["paused", "blocked", "canceled", "failed"],
  paused: ["active", "canceled"],
  blocked: ["active", "canceled"],
  complete: [],
  canceled: [],
  failed: []
};

function assertTransition(from: GoalStatus, to: GoalStatus): void {
  if (from === to) return;
  if (!allowedTransitions[from]?.includes(to)) {
    throw new Error(`Invalid goal status transition: ${from} -> ${to}.`);
  }
}

function saveGoal(goal: GoalRecord): GoalRecord {
  return withGoalLock(goal.id, () => {
    const persisted = readJson<GoalRecord>(goalPath(goal.id));
    const expectedRevision = Number.isInteger(goal.revision) ? goal.revision : 0;
    const persistedRevision = Number.isInteger(persisted?.revision) ? Number(persisted!.revision) : 0;
    if (persisted && persistedRevision !== expectedRevision) throw new Error(`Goal ${goal.id} changed concurrently; reload and retry.`);
    const next = { ...goal, revision: persistedRevision + 1, updated_at: nowIso() };
    writeJson(goalPath(next.id), next);
    return next;
  });
}

export function createGoal(input: GoalCreateInput): GoalRecord {
  const title = clip(input.title, 180);
  const objective = clip(input.objective, 5000);
  const acceptanceCriteria = asStringList(input.acceptance_criteria ?? input.acceptanceCriteria, 80, 1200);
  if (!title) throw new Error("title is required.");
  if (!objective) throw new Error("objective is required.");
  if (acceptanceCriteria.length === 0) throw new Error("acceptance_criteria is required.");

  const createdAt = nowIso();
  const requestedStatus = normalizeStatus(input.status);
  const status: GoalStatus = requestedStatus === "active" ? "active" : "draft";
  const goal: GoalRecord = {
    id: randomUUID(),
    revision: 1,
    title,
    objective,
    acceptance_criteria: acceptanceCriteria,
    non_goals: asStringList(input.non_goals ?? input.nonGoals, 40, 1200),
    created_at: createdAt,
    updated_at: createdAt,
    status,
    priority: clip(input.priority, 80) || null,
    created_by: clip(input.created_by ?? input.createdBy, 180) || null,
    current_phase: clip(input.current_phase ?? input.currentPhase, 180) || null,
    current_step: clip(input.current_step ?? input.currentStep, 240) || null,
    progress_summary: clip(input.progress_summary ?? input.progressSummary, 3000) || "Goal created.",
    token_budget: asNumberOrNull(input.token_budget ?? input.tokenBudget),
    work_budget: asJsonMap(input.work_budget ?? input.workBudget),
    work_items: normalizeWorkItems(input.work_items ?? input.workItems),
    assumptions: normalizeAssumptions(input.assumptions),
    evidence_log: [],
    action_log: [],
    validation_log: [],
    completion_audit: null,
    related_thread_id: clip(input.related_thread_id ?? input.relatedThreadId, 180) || null,
    related_session_id: clip(input.related_session_id ?? input.relatedSessionId, 180) || null,
    related_model_id: clip(input.related_model_id ?? input.relatedModelId, 180) || null,
    related_project_id: clip(input.related_project_id ?? input.relatedProjectId, 180) || null,
    artifacts: asStringList(input.artifacts, 80, 600),
    error: null,
    blocker: null
  };
  writeJson(goalPath(goal.id), goal);
  return goal;
}

export function getGoal(goalId: string): GoalRecord | null {
  const id = clip(goalId, 160);
  if (!id) return null;
  const goal = readJson<GoalRecord>(goalPath(id));
  if (!goal) return null;
  return {
    ...goal,
    revision: Number.isInteger(goal.revision) ? goal.revision : 0,
    work_items: Array.isArray(goal.work_items) ? normalizeWorkItems(goal.work_items) : [],
    assumptions: Array.isArray(goal.assumptions) ? normalizeAssumptions(goal.assumptions) : []
  };
}

function readAllGoals(): GoalRecord[] {
  const root = goalsRoot();
  const records: GoalRecord[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const goal = readJson<GoalRecord>(path.join(root, entry.name, "goal.json"));
    if (goal) records.push({
      ...goal,
      revision: Number.isInteger(goal.revision) ? goal.revision : 0,
      work_items: Array.isArray(goal.work_items) ? normalizeWorkItems(goal.work_items) : [],
      assumptions: Array.isArray(goal.assumptions) ? normalizeAssumptions(goal.assumptions) : []
    });
  }
  records.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return records;
}

export function listGoals(limit = 50): GoalRecord[] {
  return readAllGoals().slice(0, Math.max(1, Math.min(200, limit)));
}

export function updateGoal(goalId: string, input: GoalUpdateInput): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status === "complete" || goal.status === "canceled") {
    throw new Error(`Cannot edit a ${goal.status} goal.`);
  }

  const requestedStatus = normalizeStatus(input.status);
  if (requestedStatus && requestedStatus !== goal.status) assertTransition(goal.status, requestedStatus);

  const next: GoalRecord = {
    ...goal,
    title: clip(input.title, 180) || goal.title,
    objective: clip(input.objective, 5000) || goal.objective,
    acceptance_criteria: (input.acceptance_criteria ?? input.acceptanceCriteria) !== undefined
      ? asStringList(input.acceptance_criteria ?? input.acceptanceCriteria, 80, 1200)
      : goal.acceptance_criteria,
    non_goals: (input.non_goals ?? input.nonGoals) !== undefined ? asStringList(input.non_goals ?? input.nonGoals, 40, 1200) : goal.non_goals,
    status: requestedStatus ?? goal.status,
    priority: input.priority !== undefined ? clip(input.priority, 80) || null : goal.priority ?? null,
    current_phase: (input.current_phase ?? input.currentPhase) !== undefined ? clip(input.current_phase ?? input.currentPhase, 180) || null : goal.current_phase ?? null,
    current_step: (input.current_step ?? input.currentStep) !== undefined ? clip(input.current_step ?? input.currentStep, 240) || null : goal.current_step ?? null,
    progress_summary: (input.progress_summary ?? input.progressSummary) !== undefined ? clip(input.progress_summary ?? input.progressSummary, 3000) : goal.progress_summary,
    token_budget: (input.token_budget ?? input.tokenBudget) !== undefined ? asNumberOrNull(input.token_budget ?? input.tokenBudget) : goal.token_budget ?? null,
    work_budget: (input.work_budget ?? input.workBudget) !== undefined ? asJsonMap(input.work_budget ?? input.workBudget) : goal.work_budget ?? null,
    work_items: (input.work_items ?? input.workItems) !== undefined ? normalizeWorkItems(input.work_items ?? input.workItems) : goal.work_items,
    assumptions: input.assumptions !== undefined ? normalizeAssumptions(input.assumptions) : goal.assumptions,
    related_thread_id: (input.related_thread_id ?? input.relatedThreadId) !== undefined ? clip(input.related_thread_id ?? input.relatedThreadId, 180) || null : goal.related_thread_id ?? null,
    related_session_id: (input.related_session_id ?? input.relatedSessionId) !== undefined ? clip(input.related_session_id ?? input.relatedSessionId, 180) || null : goal.related_session_id ?? null,
    related_model_id: (input.related_model_id ?? input.relatedModelId) !== undefined ? clip(input.related_model_id ?? input.relatedModelId, 180) || null : goal.related_model_id ?? null,
    related_project_id: (input.related_project_id ?? input.relatedProjectId) !== undefined ? clip(input.related_project_id ?? input.relatedProjectId, 180) || null : goal.related_project_id ?? null,
    artifacts: input.artifacts !== undefined ? asStringList(input.artifacts, 80, 600) : goal.artifacts,
    error: input.error !== undefined ? clip(input.error, 2000) || null : goal.error ?? null,
    blocker: input.blocker !== undefined ? clip(input.blocker, 2000) || null : goal.blocker ?? null
  };
  if (next.acceptance_criteria.length === 0) throw new Error("acceptance_criteria cannot be empty.");
  return saveGoal(next);
}

export function transitionGoal(goalId: string, status: GoalStatus, reason?: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  assertTransition(goal.status, status);
  const reasonText = clip(reason, 2000);
  const next: GoalRecord = {
    ...goal,
    status,
    ...(status === "blocked" ? { blocker: reasonText || goal.blocker || "Blocked." } : {}),
    ...(status === "failed" ? { error: reasonText || goal.error || "Goal failed." } : {}),
    progress_summary:
      status === "active" && goal.status === "draft"
        ? "Goal activated."
        : status === "active" && (goal.status === "paused" || goal.status === "blocked")
          ? "Goal resumed."
          : status === "paused"
            ? "Goal paused."
            : status === "canceled"
              ? "Goal canceled."
              : goal.progress_summary
  };
  return saveGoal(next);
}

export function appendGoalAction(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append action while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "action");
  return saveGoal({ ...goal, action_log: [...goal.action_log, log].slice(-500), progress_summary: log.summary });
}

export function appendGoalEvidence(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append evidence while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "evidence");
  const entryObject = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as any : {};
  const evidence = normalizeTypedEvidence(entryObject.evidence, goal);
  if (evidence?.kind === "validator") throw new Error("validator evidence must be appended to the validation log.");
  if (evidence) {
    assertReceiptNotReplayed(goal, evidence);
    log.evidence = evidence;
    log.artifact_paths = evidence.kind === "artifact" ? [evidence.artifact.path] : [];
  }
  const artifacts = [...goal.artifacts];
  for (const p of log.artifact_paths ?? []) {
    if (!artifacts.includes(p)) artifacts.push(p);
  }
  return saveGoal({ ...goal, evidence_log: [...goal.evidence_log, log].slice(-500), artifacts: artifacts.slice(-200) });
}

export function appendGoalValidation(goalId: string, entry: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active" && goal.status !== "blocked") throw new Error(`Cannot append validation while goal is ${goal.status}.`);
  const log = normalizeLogEntry(entry, "validation");
  const entryObject = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as any : {};
  const evidence = normalizeTypedEvidence(entryObject.evidence, goal);
  if (evidence && evidence.kind !== "validator") throw new Error("validation log evidence must use kind 'validator'.");
  if (evidence) {
    assertReceiptNotReplayed(goal, evidence);
    log.evidence = evidence;
  }
  return saveGoal({ ...goal, validation_log: [...goal.validation_log, log].slice(-500) });
}

export function appendTrustedServerGoalValidation(
  goalId: string,
  input: { criterion: string; validator_id: string; method: string; status: GoalValidatorStatus }
): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  const criterion = canonicalCriterion(input.criterion, goal.acceptance_criteria);
  const authority = goalEvidenceAuthority();
  if (!("issueValidatorExecutionReceipt" in authority) || typeof authority.issueValidatorExecutionReceipt !== "function") {
    throw new Error("The configured goal evidence authority cannot issue local validator receipts.");
  }
  const envelope = authority.issueValidatorExecutionReceipt({
    ...authorityContext(goal, criterion),
    validator_id: clip(input.validator_id, 240),
    method: clip(input.method, 1000),
    status: input.status
  });
  return appendGoalValidation(goal.id, {
    summary: `${input.validator_id}: ${criterion}`,
    evidence: {
      kind: "validator",
      criterion,
      validator: { authority: envelope }
    }
  });
}

export function requestGoalCompletionAudit(goalId: string, input?: unknown): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active") throw new Error(`Completion audit requires an active goal, got ${goal.status}.`);
  const obj = input && typeof input === "object" && !Array.isArray(input) ? (input as any) : {};
  const criteriaResults = normalizeCriterionResults(obj.criteria_results ?? obj.criteriaResults, goal);
  const blockers = asStringList(obj.blockers, 40, 1200);
  if (goal.blocker) blockers.unshift(goal.blocker);
  const remainingWork = asStringList(obj.remaining_work ?? obj.remainingWork, 80, 1200);
  const incompleteWorkItems = (goal.work_items ?? []).filter(item => item.status !== "complete" && item.status !== "skipped");
  for (const item of incompleteWorkItems) if (!remainingWork.includes(item.title)) remainingWork.push(item.title);
  for (const item of incompleteWorkItems.filter(item => item.status === "blocked" && item.blocker)) blockers.push(`${item.title}: ${item.blocker}`);
  const complete = criteriaResults.length > 0 && criteriaResults.every(r => r.status === "pass") && blockers.length === 0 && incompleteWorkItems.length === 0;
  for (const r of criteriaResults) {
    if (r.status !== "pass" && !remainingWork.includes(r.criterion)) remainingWork.push(r.criterion);
  }
  const audit: GoalCompletionAudit = {
    id: randomUUID(),
    requested_at: nowIso(),
    complete,
    criteria_results: criteriaResults,
    evidence_summary:
      clip(obj.evidence_summary ?? obj.evidenceSummary, 3000) ||
      `Evidence entries: ${goal.evidence_log.length}; validation entries: ${goal.validation_log.length}; actions: ${goal.action_log.length}.`,
    remaining_work: remainingWork,
    blockers,
    recommendation:
      clip(obj.recommendation, 2000) ||
      (complete ? "All acceptance criteria have passing evidence. Goal can be completed." : "Do not complete yet; one or more criteria are failed or unknown.")
  };
  return saveGoal({ ...goal, completion_audit: audit });
}

export function completeGoalAfterAudit(goalId: string): GoalRecord {
  const goal = getGoal(goalId);
  if (!goal) throw new Error("Goal not found.");
  if (goal.status !== "active") throw new Error(`Cannot complete a ${goal.status} goal.`);
  if (!goal.completion_audit?.complete) throw new Error("Goal cannot be marked complete until completion audit passes.");
  const refreshed = requestGoalCompletionAudit(goal.id, { criteria_results: goal.completion_audit.criteria_results });
  if (!refreshed.completion_audit?.complete) throw new Error("Goal cannot be marked complete because its completion evidence no longer passes verification.");
  return saveGoal({ ...refreshed, status: "complete", progress_summary: "Goal completed after passing completion audit." });
}

export function getActiveGoalForSession(sessionId?: string | null): GoalRecord | null {
  const sid = clip(sessionId, 180);
  const goals = listGoals(100);
  const candidates = goals.filter(g => g.status === "active" && (!sid || g.related_session_id === sid));
  return candidates[0] ?? null;
}

export function getCurrentGoalForSession(sessionId?: string | null): GoalRecord | null {
  const sid = clip(sessionId, 180);
  if (!sid) return null;
  return readAllGoals().find(goal =>
    goal.related_session_id === sid && ["active", "paused", "blocked"].includes(goal.status)
  ) ?? null;
}

export function setAgentGoal(sessionId: string, input: AgentGoalSetInput): GoalRecord {
  const sid = clip(sessionId || input.session_id, 180);
  if (!sid) throw new Error("session_id is required.");
  const acceptance =
    input.acceptance_criteria ??
    input.acceptanceCriteria ??
    input.success_criteria ??
    input.successCriteria;
  const existing = getCurrentGoalForSession(sid);
  if (existing) {
    if (existing.status !== "active") {
      throw new Error(`Current goal is ${existing.status}; explicitly resume or clear it before starting another assignment.`);
    }
    return updateGoal(existing.id, {
      ...(input as GoalUpdateInput),
      acceptance_criteria: acceptance,
      related_session_id: sid,
      related_thread_id: input.related_thread_id ?? input.relatedThreadId ?? input.thread_id,
      status: "active"
    });
  }
  return createGoal({
    ...input,
    acceptance_criteria: acceptance,
    title: input.title ?? input.objective,
    related_session_id: sid,
    related_thread_id: input.related_thread_id ?? input.relatedThreadId ?? input.thread_id,
    status: "active"
  });
}

export function clearAgentGoal(sessionId: string, reason?: unknown): GoalRecord | null {
  const sid = clip(sessionId, 180);
  const goals = listGoals(100);
  const goal = goals.find(g =>
    (g.status === "active" || g.status === "blocked" || g.status === "paused") &&
    (!sid || g.related_session_id === sid)
  ) ?? null;
  if (!goal) return null;
  return transitionGoal(goal.id, "canceled", reason ?? "Goal cleared.");
}

export function appendGoalProgress(sessionId: string, entry: unknown): GoalRecord {
  let goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  const obj = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as any) : {};
  const workValue = obj.work_items ?? obj.workItems ?? (obj.work_item !== undefined ? [obj.work_item] : obj.workItem !== undefined ? [obj.workItem] : undefined);
  const assumptionValue = obj.assumptions ?? (obj.assumption !== undefined ? [obj.assumption] : undefined);
  if (workValue !== undefined || assumptionValue !== undefined) {
    const incomingWork = workValue === undefined ? [] : normalizeWorkItems(workValue);
    const incomingAssumptions = assumptionValue === undefined ? [] : normalizeAssumptions(assumptionValue);
    goal = saveGoal({
      ...goal,
      work_items: mergeById(goal.work_items ?? [], incomingWork, 200),
      assumptions: mergeById(goal.assumptions ?? [], incomingAssumptions, 100)
    });
  }
  const summary =
    clip(obj.summary, 2000) ||
    [
      clip(obj.observation, 700),
      clip(obj.action, 700),
      clip(obj.result, 700)
    ].filter(Boolean).join(" | ") ||
    "Goal progress recorded.";
  return appendGoalAction(goal.id, {
    summary,
    details: asJsonMap(obj) ?? { value: entry }
  });
}

export function markAgentGoalBlocked(sessionId: string, reason: unknown, evidence?: unknown): GoalRecord {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  if (evidence !== undefined) appendGoalEvidence(goal.id, { summary: "Blocker evidence recorded.", details: asJsonMap(evidence) ?? { evidence } });
  return transitionGoal(goal.id, "blocked", reason);
}

export function markAgentGoalComplete(sessionId: string, evidence?: unknown): GoalRecord {
  const goal = getActiveGoalForSession(sessionId);
  if (!goal) throw new Error("No active goal for session.");
  if (evidence !== undefined) appendGoalEvidence(goal.id, { summary: "Completion evidence recorded.", details: asJsonMap(evidence) ?? { evidence } });
  const audited = requestGoalCompletionAudit(goal.id, evidence);
  return completeGoalAfterAudit(audited.id);
}

export function formatActiveGoalContext(goal: GoalRecord | null): string {
  if (!goal || goal.status !== "active") return "";
  const recentActions = goal.action_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentEvidence = goal.evidence_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const recentValidations = goal.validation_log.slice(-5).map(e => `- ${e.ts}: ${e.summary}`);
  const workItems = (goal.work_items ?? []).filter(item => item.status !== "skipped").slice(-12).map(item => {
    const dependencies = item.depends_on.length ? ` depends_on=${item.depends_on.join(",")}` : "";
    const blocker = item.blocker ? ` blocker=${item.blocker}` : "";
    return `- ${item.id} [${item.status}] ${item.title}${dependencies}${blocker}`;
  });
  const assumptions = (goal.assumptions ?? []).filter(item => item.status === "proposed" || item.status === "accepted").slice(-12).map(item => `- ${item.id} [${item.status}] ${item.statement}${item.basis ? ` (basis: ${item.basis})` : ""}`);
  return [
    "ACTIVE GOAL CONTEXT (active_goal_context):",
    `id: ${goal.id}`,
    `title: ${goal.title}`,
    `status: ${goal.status}`,
    `objective: ${goal.objective}`,
    `acceptance_criteria:\n${goal.acceptance_criteria.map(c => `- ${c}`).join("\n")}`,
    goal.non_goals.length > 0 ? `non_goals:\n${goal.non_goals.map(c => `- ${c}`).join("\n")}` : "non_goals: (none)",
    `current_phase: ${goal.current_phase || "(unset)"}`,
    `current_step: ${goal.current_step || "(unset)"}`,
    `progress_summary: ${goal.progress_summary || "(empty)"}`,
    `blocker: ${goal.blocker || "(none)"}`,
    `work_items:\n${workItems.length ? workItems.join("\n") : "- (none)"}`,
    `assumptions:\n${assumptions.length ? assumptions.join("\n") : "- (none)"}`,
    `recent_action_log:\n${recentActions.length ? recentActions.join("\n") : "- (none)"}`,
    `recent_evidence_log:\n${recentEvidence.length ? recentEvidence.join("\n") : "- (none)"}`,
    `recent_validation_log:\n${recentValidations.length ? recentValidations.join("\n") : "- (none)"}`,
    "Assignment state is owned and automatically journaled by the Revit Operator backend. Do not call Codex create_goal, get_goal, or update_goal tools from this embedded turn.",
    "Goal Mode instructions: work toward the active goal, avoid repeating completed work, pick the next ready work item whose dependencies are complete, use live Revit evidence, and report completion or a concrete task blocker truthfully."
  ].join("\n");
}
