import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  REVIT_COURIER_V2_JOB_VERSION,
  RevitCourierCertificationError,
  assertCertifiedCourierExecutionResult,
  authorizeCertifiedCourierFinalExecution,
  isRevitCourierDevelopmentLaboratory,
  parseCertifiedCourierJobV2,
  type CertifiedCourierFinalAuthorization,
  type CertifiedCourierExecutionContext,
  type CertifiedCourierJobV2
} from "./revit_tool_job_certification.js";
import { ensureWorkspaceDirectory, ensureWorkspaceLayout } from "../workspace.js";
import {
  requireCourierLaboratoryEvidenceJobBinding,
  type LaboratoryEvidenceDispatch
} from "./laboratory_evidence.js";
import { verifyLaboratoryExecutionReceipt } from "./laboratory_execution_receipt.js";
import { getSidecarAgentProfileState } from "../capabilities/sidecar_agent_profile.js";
import { enumerateActiveJobs, observeIndexedJob, resetActiveJobIndexes } from "./active_job_index.js";

export const REVIT_COURIER_JOB_VERSION = "revit-operator.revit-tool-job.v1";
export const REVIT_COURIER_RESULT_VERSION = "revit-operator.revit-tool-result.v1";

export type RevitToolJobV1 = {
  version: typeof REVIT_COURIER_JOB_VERSION;
  id: string;
  session_id: string;
  message_id?: string | null;
  turn_token?: string | null;
  turn_token_sha256?: string | null;
  correlation_id: string;
  idempotency_key: string;
  method: "GET" | "POST";
  path: string;
  target_executor_id?: string | null;
  target_document_title?: string | null;
  target_document_path?: string | null;
  body?: unknown;
  laboratory_evidence?: LaboratoryEvidenceDispatch;
  general_agent_admission?: GeneralAgentCourierAdmission;
  created_at: string;
  expires_at: string;
  status: "pending" | "running" | "succeeded" | "failed";
  claim?: {
    executor_id: string;
    claimed_at: string;
    lease_expires_at: string;
  } | null;
  finished_at?: string | null;
  error?: string | null;
};

type GeneralAgentCourierAdmission = {
  schema: "revit-operator.general-agent-courier-admission.v1";
  source: "backend_general_agent";
  runtime_mode: "hosted" | "production";
  exposure_profile: "general";
  capability_profile: "general_agent";
  general_agent_ready: true;
  method: "GET" | "POST";
  path: string;
  channel: "search" | "generic_call" | "typed_mcp" | "deterministic_workflow";
  alias: string;
  request_hash: string;
  effect_hash: string;
};

export type RevitToolJob = RevitToolJobV1 | CertifiedCourierJobV2;

type RevitToolResult = {
  version: typeof REVIT_COURIER_RESULT_VERSION;
  id: string;
  correlation_id: string;
  status: "succeeded" | "failed";
  finished_at: string;
  result?: unknown;
  error?: string | null;
  code?: string | null;
  retryable?: boolean;
  phase?: string | null;
  outcome_unknown?: boolean;
  certified_execution_context?: CertifiedCourierExecutionContext | null;
};

type CourierCompletionChallengeState = Omit<CertifiedCourierExecutionContext, "schema"> & {
  schema: "revit-operator.courier-completion-challenge.v1";
  job_id: string;
  session_id: string;
  completion_challenge: string;
  policy_hash: string;
  document_session_id: string;
  request_instance_hash: string;
  issued_at_utc: string;
};

type CourierCompletionDecision = {
  schema: "revit-operator.courier-completion-terminal-decision.v1";
  kind: "success" | "failure";
  job_id: string;
  correlation_id: string;
  session_id: string;
  executor_id: string | null;
  certification_envelope_hash: string;
  request_instance_hash: string;
  completion_challenge_hash: string | null;
  terminal_result_sha256: string;
  terminal_result: RevitToolResult;
  decided_at_utc: string;
};

type CourierTerminalFence = {
  schema: "revit-operator.courier-completion-terminal-fence.v1";
  terminal_decision: CourierCompletionDecision;
};

type TerminalInput = {
  status: "succeeded" | "failed";
  result?: unknown;
  error?: string;
  retryable?: boolean;
  code?: string;
  phase?: string;
  outcome_unknown?: boolean;
  certified_execution_context?: CertifiedCourierExecutionContext;
};

type ClaimInput = {
  session_id?: string | null;
  executor_id: string;
  session_allowed?: (sessionId: string) => boolean;
  context_free_only?: boolean;
};
type FinishInput = { session_id: string; job_id: string; executor_id: string; result?: unknown; error?: string; retryable?: boolean };
type AuthorizeInput = { session_id: string; job_id: string; executor_id: string; authorization_stage?: "preflight" | "final" };

function jobsRoot(): string {
  const root = path.join(ensureWorkspaceLayout().artifacts, "revit-courier", "jobs");
  return ensureWorkspaceDirectory(root);
}

export function __testOnlyResetRevitCourierJobIndexCache(): void {
  resetActiveJobIndexes();
}

function safeId(value: unknown, field: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || !/^[a-zA-Z0-9._:-]+$/.test(text)) throw new Error(`${field} is invalid.`);
  return text;
}

/** Session/executor identities are producer-provided Unicode text, not ASCII ids. */
function safeContextIdentity(value: unknown, field: string, max = 200): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001F\u007F]/.test(text)) throw new Error(`${field} is invalid.`);
  return text;
}

function jobDir(jobId: string): string {
  return path.join(jobsRoot(), safeId(jobId, "job_id"));
}

function jobPath(jobId: string): string {
  return path.join(jobDir(jobId), "job.json");
}

function resultPath(jobId: string): string {
  return path.join(jobDir(jobId), "result.json");
}

function challengeIssuedPath(jobId: string): string {
  return path.join(jobDir(jobId), "completion-challenge-issued.v1.json");
}

function challengeConsumedPath(jobId: string): string {
  return path.join(jobDir(jobId), "completion-challenge-consumed.v1.json");
}

function completionDecisionPath(jobId: string): string {
  return path.join(jobDir(jobId), "completion-terminal-decision.v1.json");
}

function readJson<T>(filePath: string): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

/** Publishes a fully flushed file exactly once without an overwrite race. */
function writeJsonExclusiveAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.linkSync(temp, filePath);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temp); } catch { /* fail closed on the published path */ }
  }
}

function rawSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function requireGeneralAgentJobBinding(job: RevitToolJobV1): GeneralAgentCourierAdmission {
  const admission = job.general_agent_admission;
  const profile = getSidecarAgentProfileState();
  const keys = admission && typeof admission === "object" && !Array.isArray(admission)
    ? Object.keys(admission).sort()
    : [];
  const expectedKeys = [
    "alias", "capability_profile", "channel", "effect_hash", "exposure_profile", "general_agent_ready",
    "method", "path", "request_hash", "runtime_mode", "schema", "source"
  ].sort();
  if (!admission
    || keys.length !== expectedKeys.length
    || expectedKeys.some((key, index) => keys[index] !== key)
    || profile.general_agent_ready !== true
    || profile.capability_profile !== "general_agent"
    || profile.tool_exposure_profile !== "general"
    || admission.schema !== "revit-operator.general-agent-courier-admission.v1"
    || admission.source !== "backend_general_agent"
    || admission.runtime_mode !== profile.runtime_mode
    || (admission.runtime_mode !== "hosted" && admission.runtime_mode !== "production")
    || admission.exposure_profile !== "general"
    || admission.capability_profile !== "general_agent"
    || admission.general_agent_ready !== true
    || admission.method !== job.method
    || admission.path !== job.path
    || !/^[a-z][a-z0-9_]{0,127}$/.test(admission.alias)
    || !["search", "generic_call", "typed_mcp", "deterministic_workflow"].includes(admission.channel)
    || !/^sha256:[0-9a-f]{64}$/.test(admission.request_hash)
    || !/^sha256:[0-9a-f]{64}$/.test(admission.effect_hash)
    || Object.prototype.hasOwnProperty.call(job, "turn_token")
    || (job.turn_token_sha256 !== null && (typeof job.turn_token_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(job.turn_token_sha256)))) {
    throw new Error("General Agent courier admission is malformed or does not match the active authenticated backend profile and exact job route.");
  }
  return admission;
}

function executionContextFromState(state: CourierCompletionChallengeState): CertifiedCourierExecutionContext {
  return {
    schema: "revit-operator.certified-courier-execution-context.v1",
    transport_kind: "courier",
    dispatch_id: state.dispatch_id,
    correlation_id: state.correlation_id,
    execution_session_id: state.execution_session_id,
    executor_id: state.executor_id,
    certification_envelope_hash: state.certification_envelope_hash,
    completion_challenge_hash: state.completion_challenge_hash
  };
}

function validateChallengeState(value: unknown, job: CertifiedCourierJobV2, executorId: string): CourierCompletionChallengeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RevitCourierCertificationError("CERTIFICATION_COMPLETION_CHALLENGE_INVALID", "Courier completion challenge state is absent or malformed.");
  }
  const state = value as Record<string, unknown>;
  const admission = job.certification_envelope.request_family_admission;
  const required = [
    "schema", "transport_kind", "job_id", "dispatch_id", "correlation_id", "session_id", "execution_session_id", "executor_id",
    "certification_envelope_hash", "completion_challenge", "completion_challenge_hash", "policy_hash",
    "document_session_id", "request_instance_hash", "issued_at_utc"
  ];
  if (Object.keys(state).length !== required.length || required.some(key => !Object.prototype.hasOwnProperty.call(state, key))
    || state.schema !== "revit-operator.courier-completion-challenge.v1"
    || state.transport_kind !== "courier"
    || state.job_id !== job.id
    || state.dispatch_id !== job.id
    || state.correlation_id !== job.correlation_id
    || state.session_id !== job.session_id
    || state.execution_session_id !== job.session_id
    || state.executor_id !== executorId
    || state.certification_envelope_hash !== job.certification_envelope.envelope_hash
    || state.policy_hash !== job.certification_envelope.policy_hash
    || state.document_session_id !== admission?.document_session_id
    || state.request_instance_hash !== admission?.request_instance_hash
    || typeof state.completion_challenge !== "string"
    || !/^cmcc1_[A-Za-z0-9_-]{43}$/.test(state.completion_challenge)
    || state.completion_challenge_hash !== rawSha256(state.completion_challenge)
    || typeof state.issued_at_utc !== "string"
    || !Number.isFinite(Date.parse(state.issued_at_utc))
    || new Date(Date.parse(state.issued_at_utc)).toISOString() !== state.issued_at_utc) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_CHALLENGE_INVALID",
      "Courier completion challenge state does not match the exact durable job, executor, policy, document session, and request instance."
    );
  }
  return state as unknown as CourierCompletionChallengeState;
}

function recoverTerminalFence(job: CertifiedCourierJobV2, executorId: string | null): RevitToolJob | null {
  const raw = readJson<Record<string, unknown>>(challengeIssuedPath(job.id));
  if (!raw || raw.schema !== "revit-operator.courier-completion-terminal-fence.v1") return null;
  if (Object.keys(raw).length !== 2 || !Object.prototype.hasOwnProperty.call(raw, "terminal_decision")) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_FENCE_INVALID",
      "Courier terminal fence is malformed."
    );
  }
  const decision = validateCompletionDecision(raw.terminal_decision, job, executorId);
  if (decision.kind !== "failure" || decision.completion_challenge_hash !== null) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_FENCE_INVALID",
      "Courier pre-dispatch terminal fence must contain one exact failure decision."
    );
  }
  publishCompletionDecision(job, executorId, decision);
  return recoverFamilyCompletionDecision(job);
}

function issueCompletionChallenge(job: CertifiedCourierJobV2, executorId: string): CourierCompletionChallengeState {
  if (fs.existsSync(challengeIssuedPath(job.id)) || fs.existsSync(challengeConsumedPath(job.id))) {
    const recovered = recoverTerminalFence(job, executorId);
    if (recovered) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_TERMINAL_DECISION",
        "A durable terminal failure won before final dispatch authorization."
      );
    }
    throw new RevitCourierCertificationError(
      "CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED",
      "Certified request-family courier final authorization has already issued its one-use completion challenge."
    );
  }
  const admission = job.certification_envelope.request_family_admission;
  if (!admission) throw new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Completion challenges require a certified request-family admission.");
  const completionChallenge = `cmcc1_${randomBytes(32).toString("base64url")}`;
  const state: CourierCompletionChallengeState = {
    schema: "revit-operator.courier-completion-challenge.v1",
    transport_kind: "courier",
    job_id: job.id,
    dispatch_id: job.id,
    correlation_id: job.correlation_id,
    session_id: job.session_id,
    execution_session_id: job.session_id,
    executor_id: executorId,
    certification_envelope_hash: job.certification_envelope.envelope_hash,
    completion_challenge: completionChallenge,
    completion_challenge_hash: rawSha256(completionChallenge),
    policy_hash: job.certification_envelope.policy_hash,
    document_session_id: admission.document_session_id,
    request_instance_hash: admission.request_instance_hash,
    issued_at_utc: new Date().toISOString()
  };
  try {
    writeJsonExclusiveAtomic(challengeIssuedPath(job.id), state);
  } catch {
    const recovered = recoverTerminalFence(job, executorId);
    if (recovered) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_TERMINAL_DECISION",
        "A durable terminal failure won the final-dispatch race."
      );
    }
    throw new RevitCourierCertificationError(
      "CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED",
      "Certified request-family courier final authorization could not atomically issue a unique completion challenge."
    );
  }
  return state;
}

function consumeCompletionChallenge(job: CertifiedCourierJobV2, state: CourierCompletionChallengeState): void {
  const consumedPath = challengeConsumedPath(job.id);
  const matchesExactConsumption = (existing: Record<string, unknown> | null): boolean => !!existing
    && existing.job_id === job.id
    && existing.dispatch_id === job.id
    && existing.correlation_id === job.correlation_id
    && existing.session_id === job.session_id
    && existing.execution_session_id === job.session_id
    && existing.executor_id === state.executor_id
    && existing.certification_envelope_hash === job.certification_envelope.envelope_hash
    && existing.policy_hash === job.certification_envelope.policy_hash
    && existing.document_session_id === state.document_session_id
    && existing.request_instance_hash === state.request_instance_hash
    && existing.completion_challenge_hash === state.completion_challenge_hash;
  if (fs.existsSync(consumedPath)) {
    const existing = readJson<Record<string, unknown>>(consumedPath);
    if (matchesExactConsumption(existing)) return;
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_CHALLENGE_REPLAY_DENIED",
      "Courier completion challenge was consumed by a different terminal decision."
    );
  }
  try {
    writeJsonExclusiveAtomic(consumedPath, { ...state, consumed_at_utc: new Date().toISOString() });
  } catch {
    const existing = readJson<Record<string, unknown>>(consumedPath);
    if (matchesExactConsumption(existing)) return;
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_CHALLENGE_REPLAY_DENIED",
      "Courier completion challenge could not be atomically consumed exactly once."
    );
  }
}

function terminalResultSha256(value: RevitToolResult): string {
  return rawSha256(JSON.stringify(value));
}

function familyDecisionExecutor(job: CertifiedCourierJobV2): string | null {
  return job.claim?.executor_id ?? job.target_executor_id ?? null;
}

function validateCompletionDecision(
  value: unknown,
  job: CertifiedCourierJobV2,
  executorId: string | null
): CourierCompletionDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RevitCourierCertificationError("CERTIFICATION_COMPLETION_DECISION_INVALID", "Courier completion terminal decision is absent or malformed.");
  }
  const decision = value as Record<string, unknown>;
  const required = [
    "schema", "kind", "job_id", "correlation_id", "session_id", "executor_id", "certification_envelope_hash",
    "request_instance_hash", "completion_challenge_hash", "terminal_result_sha256", "terminal_result", "decided_at_utc"
  ];
  const admission = job.certification_envelope.request_family_admission;
  const terminal = decision.terminal_result && typeof decision.terminal_result === "object" && !Array.isArray(decision.terminal_result)
    ? decision.terminal_result as RevitToolResult
    : null;
  const terminalKeys = terminal?.certified_execution_context === undefined
    ? ["version", "id", "correlation_id", "status", "finished_at", "result", "error", "code", "retryable", "phase", "outcome_unknown"]
    : ["version", "id", "correlation_id", "status", "finished_at", "result", "error", "code", "retryable", "phase", "outcome_unknown", "certified_execution_context"];
  const terminalHasExactKeys = !!terminal
    && Object.keys(terminal).length === terminalKeys.length
    && terminalKeys.every(key => Object.prototype.hasOwnProperty.call(terminal, key));
  const successContext = terminal?.certified_execution_context;
  if (Object.keys(decision).length !== required.length || required.some(key => !Object.prototype.hasOwnProperty.call(decision, key))
    || decision.schema !== "revit-operator.courier-completion-terminal-decision.v1"
    || (decision.kind !== "success" && decision.kind !== "failure")
    || decision.job_id !== job.id
    || decision.correlation_id !== job.correlation_id
    || decision.session_id !== job.session_id
    || decision.executor_id !== executorId
    || decision.certification_envelope_hash !== job.certification_envelope.envelope_hash
    || decision.request_instance_hash !== admission?.request_instance_hash
    || (decision.completion_challenge_hash !== null && (typeof decision.completion_challenge_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(decision.completion_challenge_hash)))
    || !terminal
    || !terminalHasExactKeys
    || terminal.version !== REVIT_COURIER_RESULT_VERSION
    || terminal.id !== job.id
    || terminal.correlation_id !== job.correlation_id
    || (terminal.status !== "succeeded" && terminal.status !== "failed")
    || (decision.kind === "success") !== (terminal.status === "succeeded")
    || typeof terminal.finished_at !== "string"
    || !Number.isFinite(Date.parse(terminal.finished_at))
    || new Date(Date.parse(terminal.finished_at)).toISOString() !== terminal.finished_at
    || (decision.kind === "success" && (
      executorId === null
      || typeof decision.completion_challenge_hash !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(decision.completion_challenge_hash)
      || !successContext
      || successContext.schema !== "revit-operator.certified-courier-execution-context.v1"
      || successContext.transport_kind !== "courier"
      || successContext.dispatch_id !== job.id
      || successContext.correlation_id !== job.correlation_id
      || successContext.execution_session_id !== job.session_id
      || successContext.executor_id !== executorId
      || successContext.certification_envelope_hash !== job.certification_envelope.envelope_hash
      || successContext.completion_challenge_hash !== decision.completion_challenge_hash
    ))
    || (decision.kind === "failure" && successContext !== undefined)
    || typeof decision.terminal_result_sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(decision.terminal_result_sha256)
    || decision.terminal_result_sha256 !== terminalResultSha256(terminal)
    || typeof decision.decided_at_utc !== "string"
    || !Number.isFinite(Date.parse(decision.decided_at_utc))
    || new Date(Date.parse(decision.decided_at_utc)).toISOString() !== decision.decided_at_utc) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_DECISION_INVALID",
      "Courier completion terminal decision does not match the exact durable job, executor, envelope, and request instance."
    );
  }
  return decision as unknown as CourierCompletionDecision;
}

function validateCompletionDecisionCausality(
  decision: CourierCompletionDecision,
  job: CertifiedCourierJobV2,
  executorId: string | null
): CourierCompletionChallengeState | null {
  const issued = readJson<Record<string, unknown>>(challengeIssuedPath(job.id));
  if (decision.completion_challenge_hash === null) {
    if (!issued
      || issued.schema !== "revit-operator.courier-completion-terminal-fence.v1"
      || Object.keys(issued).length !== 2
      || !Object.prototype.hasOwnProperty.call(issued, "terminal_decision")
      || decision.kind !== "failure"
      || JSON.stringify(issued.terminal_decision) !== JSON.stringify(decision)) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_COMPLETION_DECISION_INVALID",
        "Courier pre-dispatch failure decision is not the exact atomic terminal-fence winner."
      );
    }
    return null;
  }
  if (executorId === null) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_DECISION_INVALID",
      "Courier dispatch-bound terminal decision has no exact executor identity."
    );
  }
  const challenge = validateChallengeState(issued, job, executorId);
  if (challenge.completion_challenge_hash !== decision.completion_challenge_hash
    || (decision.kind === "failure" && (
      decision.terminal_result.outcome_unknown !== true
      || decision.terminal_result.retryable !== false
    ))) {
    throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_DECISION_INVALID",
      "Courier dispatch-bound terminal decision does not match the exact issued challenge and nonretryable outcome truth."
    );
  }
  return challenge;
}

function claimCompletionDecision(
  job: CertifiedCourierJobV2,
  executorId: string | null,
  terminalResult: RevitToolResult,
  challengeHash: string | null
): { decision: CourierCompletionDecision; created: boolean } {
  const decision = createCompletionDecision(job, executorId, terminalResult, challengeHash);
  return publishCompletionDecision(job, executorId, decision);
}

function createCompletionDecision(
  job: CertifiedCourierJobV2,
  executorId: string | null,
  terminalResult: RevitToolResult,
  challengeHash: string | null
): CourierCompletionDecision {
  return {
    schema: "revit-operator.courier-completion-terminal-decision.v1",
    kind: terminalResult.status === "succeeded" ? "success" : "failure",
    job_id: job.id,
    correlation_id: job.correlation_id,
    session_id: job.session_id,
    executor_id: executorId,
    certification_envelope_hash: job.certification_envelope.envelope_hash,
    request_instance_hash: job.certification_envelope.request_family_admission!.request_instance_hash,
    completion_challenge_hash: challengeHash,
    terminal_result_sha256: terminalResultSha256(terminalResult),
    terminal_result: terminalResult,
    decided_at_utc: new Date().toISOString()
  };
}

function publishCompletionDecision(
  job: CertifiedCourierJobV2,
  executorId: string | null,
  decision: CourierCompletionDecision
): { decision: CourierCompletionDecision; created: boolean } {
  try {
    writeJsonExclusiveAtomic(completionDecisionPath(job.id), decision);
    return { decision, created: true };
  } catch {
    return {
      decision: validateCompletionDecision(readJson<unknown>(completionDecisionPath(job.id)), job, executorId),
      created: false
    };
  }
}

function readJob(jobId: string): RevitToolJob | null {
  const job = readJson<RevitToolJob>(jobPath(jobId));
  // Keep an unknown persisted version visible to the claimant so it can be
  // terminally quarantined. Silently ignoring it would leave an executable
  // durable record that might be accepted by a future worker.
  if (!job || job.id !== jobId) return null;
  return job;
}

function saveJob(job: RevitToolJob): RevitToolJob {
  writeJsonAtomic(jobPath(job.id), job);
  observeIndexedJob(jobsRoot(), job);
  return job;
}

function isCertifiedFamilyJob(job: RevitToolJob): job is CertifiedCourierJobV2 {
  return job.version === REVIT_COURIER_V2_JOB_VERSION
    && !!job.certification_envelope?.request_family_admission;
}

function readTerminalResult(job: RevitToolJob): RevitToolResult | null {
  const result = readJson<RevitToolResult>(resultPath(job.id));
  if (!result || result.version !== REVIT_COURIER_RESULT_VERSION || result.id !== job.id || result.correlation_id !== job.correlation_id) return null;
  if (result.status !== "succeeded" && result.status !== "failed") return null;
  if (isCertifiedFamilyJob(job)) {
    try {
      const executorId = familyDecisionExecutor(job);
      const decision = validateCompletionDecision(readJson<unknown>(completionDecisionPath(job.id)), job, executorId);
      if (terminalResultSha256(result) !== decision.terminal_result_sha256) return null;
      const challenge = validateCompletionDecisionCausality(decision, job, executorId);
      if (decision.kind === "success") {
        if (!challenge) return null;
        const executionContext = result.certified_execution_context!;
        assertCertifiedCourierExecutionResult(job, result.result, executionContext);
        consumeCompletionChallenge(job, challenge);
      }
    } catch {
      return null;
    }
  }
  return result;
}

/** Returns only terminal truth that passes the durable family decision checks. */
export function readRevitToolJobTerminalOutcome(jobId: string): Readonly<{
  status: "succeeded" | "failed";
  result: unknown;
  error: string | null;
}> | null {
  const job = readJob(safeId(jobId, "job_id"));
  if (!job) return null;
  const terminal = readTerminalResult(job);
  return terminal ? {
    status: terminal.status,
    result: terminal.result ?? null,
    error: terminal.error ?? null
  } : null;
}

function reconcileJobWithResult(job: RevitToolJob, result: RevitToolResult): RevitToolJob {
  if (job.status === result.status && job.finished_at === result.finished_at && (job.error ?? null) === (result.error ?? null)) return job;
  return saveJob({
    ...job,
    status: result.status,
    finished_at: result.finished_at,
    error: result.error ?? null
  });
}

function buildTerminalResult(job: RevitToolJob, terminal: TerminalInput): RevitToolResult {
  return {
    version: REVIT_COURIER_RESULT_VERSION,
    id: job.id,
    correlation_id: job.correlation_id,
    status: terminal.status,
    finished_at: new Date().toISOString(),
    result: terminal.result ?? null,
    error: terminal.error ?? null,
    code: terminal.code ?? null,
    retryable: terminal.retryable ?? false,
    phase: terminal.phase ?? null,
    outcome_unknown: terminal.outcome_unknown === true,
    ...(terminal.certified_execution_context === undefined ? {} : {
      certified_execution_context: terminal.certified_execution_context
    })
  };
}

function publishDurableTerminal(job: RevitToolJob, durableResult: RevitToolResult): RevitToolJob {
  // Terminal truth is first-writer-wins. Exclusive publication prevents a
  // replay/error loser from replacing a signed success (or vice versa).
  try {
    writeJsonExclusiveAtomic(resultPath(job.id), durableResult);
  } catch (error) {
    const winner = readTerminalResult(job);
    if (winner) return reconcileJobWithResult(job, winner);
    if (fs.existsSync(resultPath(job.id))) {
      return saveJob({
        ...job,
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "The durable Revit courier result receipt is invalid or mismatched; terminal publication was quarantined."
      });
    }
    throw error;
  }
  return saveJob({
    ...job,
    status: durableResult.status,
    finished_at: durableResult.finished_at,
    error: durableResult.error ?? null
  });
}

function recoverFamilyCompletionDecision(job: CertifiedCourierJobV2): RevitToolJob {
  const executorId = familyDecisionExecutor(job);
  const decision = validateCompletionDecision(readJson<unknown>(completionDecisionPath(job.id)), job, executorId);
  const challenge = validateCompletionDecisionCausality(decision, job, executorId);
  if (decision.kind === "success") {
    if (!challenge) throw new RevitCourierCertificationError(
      "CERTIFICATION_COMPLETION_DECISION_INVALID",
      "Courier success decision is missing its exact issued completion challenge."
    );
    const executionContext = decision.terminal_result.certified_execution_context!;
    assertCertifiedCourierExecutionResult(job, decision.terminal_result.result, executionContext);
    consumeCompletionChallenge(job, challenge);
  }
  return publishDurableTerminal(job, decision.terminal_result);
}

function recoverExistingFamilyDecision(job: RevitToolJob): RevitToolJob | null {
  return isCertifiedFamilyJob(job) && fs.existsSync(completionDecisionPath(job.id))
    ? recoverFamilyCompletionDecision(job)
    : null;
}

function writeTerminal(job: RevitToolJob, terminal: TerminalInput): RevitToolJob {
  let durableResult = buildTerminalResult(job, terminal);
  if (isCertifiedFamilyJob(job)) {
    const executorId = familyDecisionExecutor(job);
    if (terminal.status === "failed") {
      const existingFenceWinner = recoverTerminalFence(job, executorId);
      if (existingFenceWinner) return existingFenceWinner;
      if (!fs.existsSync(challengeIssuedPath(job.id))) {
        const decision = createCompletionDecision(job, executorId, durableResult, null);
        const fence: CourierTerminalFence = {
          schema: "revit-operator.courier-completion-terminal-fence.v1",
          terminal_decision: decision
        };
        try {
          writeJsonExclusiveAtomic(challengeIssuedPath(job.id), fence);
          publishCompletionDecision(job, executorId, decision);
          return recoverFamilyCompletionDecision(job);
        } catch {
          const terminalWinner = recoverTerminalFence(job, executorId);
          if (terminalWinner) return terminalWinner;
          // A final dispatch challenge won the same CAS. The later failure can
          // no longer prove pre-dispatch settlement.
        }
      }
      if (executorId === null) {
        throw new RevitCourierCertificationError(
          "CERTIFICATION_COMPLETION_FENCE_INVALID",
          "A dispatch-bound family failure is missing its exact executor identity."
        );
      }
      const challenge = validateChallengeState(readJson<unknown>(challengeIssuedPath(job.id)), job, executorId);
      durableResult = buildTerminalResult(job, {
        ...terminal,
        retryable: false,
        outcome_unknown: true
      });
      claimCompletionDecision(job, executorId, durableResult, challenge.completion_challenge_hash);
      return recoverFamilyCompletionDecision(job);
    }
    claimCompletionDecision(
      job,
      executorId,
      durableResult,
      terminal.certified_execution_context?.completion_challenge_hash ?? null
    );
    return recoverFamilyCompletionDecision(job);
  }
  return publishDurableTerminal(job, durableResult);
}

function writeCertificationTerminal(job: RevitToolJob, error: RevitCourierCertificationError, outcomeUnknown = false): RevitToolJob {
  const terminal = readTerminalResult(job);
  if (terminal) return reconcileJobWithResult(job, terminal);
  if (fs.existsSync(resultPath(job.id))) {
    return saveJob({
      ...job,
      status: "failed",
      finished_at: new Date().toISOString(),
      error: "The durable Revit courier result receipt is invalid or mismatched; the job was quarantined without replay."
    });
  }
  return writeTerminal(job, {
    status: "failed",
    error: error.message,
    code: error.code,
    retryable: false,
    phase: "certification_final_execution",
    outcome_unknown: outcomeUnknown,
    result: {
      code: error.code,
      phase: "certification_final_execution",
      retryable: false,
      outcome_unknown: outcomeUnknown
    }
  });
}

function validCertifiedJobForClaim(job: RevitToolJob): boolean {
  if (job.version === REVIT_COURIER_JOB_VERSION) {
    const legacyDenied = job.general_agent_admission === undefined && !isRevitCourierDevelopmentLaboratory();
    try {
      if (job.general_agent_admission !== undefined) {
        if (job.laboratory_evidence !== undefined) throw new Error("General Agent and laboratory courier admissions are mutually exclusive.");
        requireGeneralAgentJobBinding(job);
      } else {
        if (!isRevitCourierDevelopmentLaboratory()) throw new Error("Legacy v1 Revit courier jobs require an authenticated General Agent admission or the exact development laboratory profile.");
        requireCourierLaboratoryEvidenceJobBinding(job);
      }
      return true;
    } catch (error) {
      writeTerminal(job, {
        status: "failed",
        error: error instanceof Error ? error.message : "General Agent or laboratory job binding is invalid.",
        code: job.general_agent_admission !== undefined
          ? "GENERAL_AGENT_COURIER_ADMISSION_INVALID"
          : legacyDenied
            ? "CERTIFICATION_LEGACY_V1_DENIED"
            : "CERTIFICATION_LABORATORY_EVIDENCE_JOB_INVALID",
        retryable: false,
        outcome_unknown: false
      });
      return false;
    }
  }
  if (job.version !== REVIT_COURIER_V2_JOB_VERSION) {
    writeCertificationTerminal(job, new RevitCourierCertificationError(
      "CERTIFICATION_JOB_VERSION_UNSUPPORTED",
      "Revit courier job version is unsupported and was quarantined before workstation execution."
    ));
    return false;
  }
  try {
    parseCertifiedCourierJobV2(job);
    return true;
  } catch (error) {
    const certificationError = error instanceof RevitCourierCertificationError
      ? error
      : new RevitCourierCertificationError("CERTIFICATION_JOB_MALFORMED", "Certified courier job could not be validated.");
    writeCertificationTerminal(job, certificationError);
    return false;
  }
}

function leaseDurationMs(): number {
  const parsed = Number.parseInt(process.env.OPERATOR_REVIT_COURIER_LEASE_MS ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.min(10 * 60_000, parsed)) : 4 * 60_000;
}

function enumerateCandidateJobs(): RevitToolJob[] {
  const root = jobsRoot();
  return enumerateActiveJobs(root, readJob);
}

export function isRevitCourierContextFreeJob(job: Pick<RevitToolJob, "method" | "path">): boolean {
  const method = `${job?.method || ""}`.trim().toUpperCase();
  const jobPath = `${job?.path || ""}`.trim().toLowerCase();
  if (method === "POST" && jobPath === "/revit/open-model") return true;
  return method === "GET" && new Set([
    "/revit/ping",
    "/revit/context",
    "/revit/capabilities"
  ]).has(jobPath);
}

export function claimNextRevitToolJob(input: ClaimInput): { job: RevitToolJob | null } {
  const sessionId = input.session_id == null || `${input.session_id}`.trim() === ""
    ? null
    : safeContextIdentity(input.session_id, "session_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const now = Date.now();
  const candidates = enumerateCandidateJobs()
    .filter((job): job is RevitToolJob =>
      (sessionId === null || job.session_id === sessionId) &&
      (!job.target_executor_id || job.target_executor_id === executorId) &&
      (!input.context_free_only || isRevitCourierContextFreeJob(job)) &&
      (input.session_allowed?.(job.session_id) ?? true))
    .sort((a, b) => `${a.created_at}|${a.id}`.localeCompare(`${b.created_at}|${b.id}`));

  for (const job of candidates) {
    if (isCertifiedFamilyJob(job)) {
      try {
        const terminalFenceWinner = recoverTerminalFence(job, familyDecisionExecutor(job));
        if (terminalFenceWinner) continue;
      } catch (error) {
        saveJob({
          ...job,
          status: "failed",
          finished_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : "The family dispatch/terminal fence could not be recovered."
        });
        continue;
      }
    }
    if (isCertifiedFamilyJob(job) && fs.existsSync(completionDecisionPath(job.id))) {
      try { recoverFamilyCompletionDecision(job); }
      catch (error) {
        saveJob({
          ...job,
          status: "failed",
          finished_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : "The family terminal decision could not be recovered."
        });
      }
      continue;
    }
    const terminalResult = readTerminalResult(job);
    if (terminalResult) {
      reconcileJobWithResult(job, terminalResult);
      continue;
    }
    if (fs.existsSync(resultPath(job.id))) {
      saveJob({
        ...job,
        status: "failed",
        finished_at: new Date().toISOString(),
        error: "The durable Revit courier result receipt is invalid or mismatched; the job was quarantined without replay."
      });
      continue;
    }
    if (job.version === REVIT_COURIER_JOB_VERSION
      && job.general_agent_admission === undefined
      && !isRevitCourierDevelopmentLaboratory()) {
      writeCertificationTerminal(job, new RevitCourierCertificationError(
        "CERTIFICATION_LEGACY_V1_DENIED",
        "Legacy v1 Revit courier jobs require an authenticated General Agent admission or the exact development laboratory profile."
      ));
      continue;
    }
    if (!validCertifiedJobForClaim(job)) continue;
    if (job.status === "running") {
      const leaseExpires = Date.parse(job.claim?.lease_expires_at ?? "");
      if (Number.isFinite(leaseExpires) && leaseExpires <= now && !fs.existsSync(resultPath(job.id))) {
        writeTerminal(job, {
          status: "failed",
          error: "The workstation execution lease expired; outcome is unknown and the call was not retried automatically.",
          code: "execution_lease_expired_outcome_unknown",
          retryable: false,
          outcome_unknown: true
        });
      }
      continue;
    }
    if (job.status !== "pending") continue;
    const expiresAt = Date.parse(job.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      writeTerminal(job, {
        status: "failed",
        error: "The Revit courier job expired before a workstation claimed it.",
        code: "courier_job_expired_before_claim",
        retryable: true
      });
      continue;
    }

    const claimedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Math.min(expiresAt, now + leaseDurationMs())).toISOString();
    return {
      job: saveJob({
        ...job,
        status: "running",
        claim: { executor_id: executorId, claimed_at: claimedAt, lease_expires_at: leaseExpiresAt }
      })
    };
  }
  return { job: null };
}

function requireClaimedJob(input: FinishInput): RevitToolJob {
  const sessionId = safeContextIdentity(input.session_id, "session_id");
  const jobId = safeId(input.job_id, "job_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const job = readJob(jobId);
  if (!job) throw new Error("Revit courier job was not found.");
  if (job.session_id !== sessionId) throw new Error("Revit courier session mismatch.");
  if (job.claim?.executor_id !== executorId) throw new Error("Revit courier job is not claimed by this executor.");
  const recoveredDecision = recoverExistingFamilyDecision(job);
  if (recoveredDecision) return recoveredDecision;
  const terminalResult = readTerminalResult(job);
  if (terminalResult) return reconcileJobWithResult(job, terminalResult);
  if (fs.existsSync(resultPath(job.id))) throw new Error("Revit courier result receipt is invalid or mismatched; refusing to overwrite or replay it.");
  if (job.status === "succeeded" || job.status === "failed") return job;
  if (job.status !== "running") throw new Error("Revit courier job is not claimed by this executor.");
  return job;
}

export function completeRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "failed") throw new Error("Revit courier job is already terminally failed; refusing a contradictory completion.");
  if (job.status === "succeeded" && readTerminalResult(job)) return job;
  if (job.version === REVIT_COURIER_V2_JOB_VERSION && job.certification_envelope?.request_family_admission) {
    try {
      const challenge = validateChallengeState(readJson<unknown>(challengeIssuedPath(job.id)), job, input.executor_id);
      const executionContext = executionContextFromState(challenge);
      assertCertifiedCourierExecutionResult(job, input.result, executionContext);
      const durableResult = buildTerminalResult(job, {
        status: "succeeded",
        result: input.result,
        retryable: false,
        certified_execution_context: executionContext
      });
      claimCompletionDecision(
        job,
        input.executor_id,
        durableResult,
        challenge.completion_challenge_hash
      );
      return recoverFamilyCompletionDecision(job);
    } catch (error) {
      if (fs.existsSync(completionDecisionPath(job.id))) {
        return recoverFamilyCompletionDecision(job);
      }
      const message = error instanceof Error ? error.message : "Certified native execution receipt is invalid.";
      return writeTerminal(job, {
        status: "failed",
        result: input.result,
        error: message,
        code: error instanceof RevitCourierCertificationError ? error.code : "CERTIFICATION_EXECUTION_RECEIPT_INVALID",
        retryable: false,
        phase: "certification_execution_receipt",
        outcome_unknown: true
      });
    }
  }
  if (job.version === REVIT_COURIER_JOB_VERSION && job.laboratory_evidence) {
    try {
      const evidence = requireCourierLaboratoryEvidenceJobBinding(job);
      if (!evidence) throw new Error("Laboratory evidence dispatch is missing.");
      verifyLaboratoryExecutionReceipt(input.result, {
        expectedEvidence: evidence,
        method: job.method,
        path: job.path,
        ...(Object.prototype.hasOwnProperty.call(job, "body") ? { body: job.body } : {})
      });
      return writeTerminal(job, { status: "succeeded", result: input.result, retryable: false });
    } catch (error) {
      return writeTerminal(job, {
        status: "failed",
        result: input.result,
        error: error instanceof Error ? error.message : "Native laboratory execution receipt is invalid.",
        code: "CERTIFICATION_LABORATORY_EXECUTION_RECEIPT_INVALID",
        retryable: false,
        phase: "laboratory_execution_receipt",
        outcome_unknown: true
      });
    }
  }
  return writeTerminal(job, { status: "succeeded", result: input.result, retryable: false });
}

export function failRevitToolJob(input: FinishInput): RevitToolJob {
  const job = requireClaimedJob(input);
  if (job.status === "succeeded") {
    if (isCertifiedFamilyJob(job) && readTerminalResult(job)) return job;
    throw new Error("Revit courier job is already terminally succeeded; refusing a contradictory failure.");
  }
  if (job.status === "failed" && readTerminalResult(job)) return job;
  const error = typeof input.error === "string" && input.error.trim() ? input.error.trim().slice(0, 4000) : "Revit courier execution failed.";
  const resultRecord = input.result && typeof input.result === "object" && !Array.isArray(input.result)
    ? input.result as Record<string, unknown>
    : null;
  const rawCode = typeof resultRecord?.code === "string" ? resultRecord.code.trim() : "";
  const code = /^[a-z0-9._:-]{1,160}$/i.test(rawCode) ? rawCode : undefined;
  // The native add-in reports execution ambiguity on the bounded, top-level
  // result contract. Only the literal boolean can promote durable receipt
  // truth; nested metadata and truthy/malformed values must not do so.
  // Once family final authorization issued a challenge, a handler-shaped
  // failure cannot prove that dispatch did not occur. Only a signed success
  // receipt may settle known success; every competing failure is unknown and
  // nonretryable.
  const outcomeUnknown = (job.version === REVIT_COURIER_JOB_VERSION
      && (job.laboratory_evidence !== undefined || job.general_agent_admission !== undefined))
    || (isCertifiedFamilyJob(job) && fs.existsSync(challengeIssuedPath(job.id)))
    || resultRecord?.outcomeUnknown === true;
  return writeTerminal(job, {
    status: "failed",
    result: input.result,
    error,
    code,
    retryable: outcomeUnknown ? false : input.retryable === true,
    outcome_unknown: outcomeUnknown
  });
}

/**
 * Re-reads a claimed durable v2 job immediately before the workstation calls
 * Revit. Certification denial writes an authoritative, non-retryable terminal
 * receipt so a restart or another worker can never re-claim the operation.
 */
export function authorizeRevitToolJobExecution(input: AuthorizeInput): { job: RevitToolJob; authorization: CertifiedCourierFinalAuthorization } {
  const sessionId = safeContextIdentity(input.session_id, "session_id");
  const jobId = safeId(input.job_id, "job_id");
  const executorId = safeContextIdentity(input.executor_id, "executor_id");
  const job = readJob(jobId);
  if (!job) throw new Error("Revit courier job was not found.");
  if (job.session_id !== sessionId) throw new Error("Revit courier session mismatch.");
  const recoveredDecision = recoverExistingFamilyDecision(job);
  if (recoveredDecision) {
    const terminalError = new Error("Revit courier family terminal decision is already authoritative; execution authorization is denied.");
    (terminalError as Error & { job?: RevitToolJob }).job = recoveredDecision;
    throw terminalError;
  }
  const terminal = readTerminalResult(job);
  if (terminal) {
    reconcileJobWithResult(job, terminal);
    throw new Error("Revit courier job is already terminal and cannot be authorized for execution.");
  }
  if (fs.existsSync(resultPath(job.id))) throw new Error("Revit courier result receipt is invalid or mismatched; refusing execution authorization.");
  if (job.status !== "running") throw new Error("Revit courier job is not running under this executor.");
  if (job.version !== REVIT_COURIER_V2_JOB_VERSION) {
    throw new Error("Legacy Revit courier jobs do not have a certified final-execution authorization receipt.");
  }
  const terminalize = (error: unknown): never => {
    const certificationError = error instanceof RevitCourierCertificationError
      ? error
      : new RevitCourierCertificationError("CERTIFICATION_FINAL_EXECUTION_FAILED", "Certified courier final execution authorization failed.");
    const replayAfterFinal = input.authorization_stage === "final"
      && certificationError.code === "CERTIFICATION_REQUEST_FAMILY_REPLAY_DENIED";
    const terminalJob = writeCertificationTerminal(job, certificationError, replayAfterFinal);
    const terminalError = new Error(`${certificationError.code}: ${certificationError.message}`);
    (terminalError as Error & { job?: RevitToolJob }).job = terminalJob;
    throw terminalError;
  };
  try {
    // Validate durable v2 shape before consulting the claim. A malformed claim
    // is a quarantined job, never a generic authorization error that leaves it
    // eligible for a later workstation.
    parseCertifiedCourierJobV2(job);
  } catch (error) {
    return terminalize(error);
  }
  // Caller identity mismatches are not a certification decision. Do not let
  // an untrusted wrong-workstation request poison another worker's lease.
  if (job.claim?.executor_id !== executorId) throw new Error("Revit courier job is not claimed by this executor.");
  try {
    // This endpoint is called immediately before the workstation creates its
    // Revit action. These expiry failures are therefore known not to have
    // reached Revit and must not be mislabeled as outcome-unknown leases.
    const now = Date.now();
    const jobExpiresAt = Date.parse(job.expires_at);
    if (!Number.isFinite(jobExpiresAt) || jobExpiresAt <= now) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_JOB_EXPIRED",
        "Certified courier job expired before final execution authorization; no Revit call was made."
      );
    }
    const leaseExpiresAt = Date.parse(job.claim?.lease_expires_at ?? "");
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now) {
      throw new RevitCourierCertificationError(
        "CERTIFICATION_FINAL_CLAIM_LEASE_EXPIRED",
        "Certified courier claim lease expired before final execution authorization; no Revit call was made."
      );
    }
    const familyAdmission = job.certification_envelope.request_family_admission;
    const challenge = familyAdmission && input.authorization_stage === "final"
      ? issueCompletionChallenge(job, executorId)
      : null;
    const authorization = authorizeCertifiedCourierFinalExecution(
      job,
      executorId,
      input.authorization_stage,
      familyAdmission ? {
        completion_challenge: challenge?.completion_challenge ?? null,
        completion_challenge_hash: challenge?.completion_challenge_hash ?? null
      } : undefined
    );
    return { job, authorization };
  } catch (error) {
    return terminalize(error);
  }
}
