import { CodexInstructionBindingError } from "../codex/instruction_binding.js";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";
import { ensureWorkspaceLayout } from "../workspace.js";
import { appendEvent, setCodexThreadId, hasCodexThreadStartedTurn } from "../memory/sqlite_store.js";
import { recoverAssignmentVisualAttachments } from "../attachments/assignment_visual_recovery.js";
import { recordProviderStartFailureDiagnostic } from "../assignments/chat_execution_failure_diagnostic.js";
import { CodexAppServer, type CodexNotificationEnvelope, type CodexServerRequest } from "../codex/app_server.js";
import { CodexTurnFailedError } from "../codex/turn_error.js";
import { readCodexWorkerIdentity } from "./codex_worker_identity.js";
import { recordCodexProviderUsageHoldV2 } from "../assignments/assignment_kernel_v2_usage_hold.js";
import type { UserInput } from "../codex/generated/app_server_0_157_0/v2/UserInput.js";
import { buildCodexTurnInput } from "./codex_turn_input.js";
import { withCodexCapabilityHandoff } from "./codex_tool_catalog.js";
import { ensureCodexHomeAuth, ensureCodexHomeConfig, prepareCertifiedCodexIsolation } from "../codex/config.js";
import { CodexMcpToolRuntime } from "../codex/mcp_tool_runtime.js";
import { resolveCodexTurnTimeoutMs } from "../codex/timeout_policy.js";
import { formatRevitToolContractMemoryForPrompt } from "../codex/revit_tool_contract_memory.js";
import { beginRevitCourierTurnContext, endRevitCourierTurnContext } from "../courier/revit_courier_context.js";
import { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
import { formatTaskMemoryContext } from "../memory/task_memory_context.js";
import { formatProjectProfileForPrompt } from "../memory/project_profile.js";
import {
  beginRequirementsPlanningLease,
  endRequirementsPlanningLease,
  formatRequirementsForPrompt,
  resolveRequirementsForChat,
  type RequirementsReceipt
} from "../memory/requirements_store.js";
import { getPinnedGoal } from "../session_store.js";
import { formatActiveGoalContext, getActiveGoalForSession, getGoal } from "../goals/service.js";
import { createAutoGoalTurnObserver } from "../goals/auto_goal_runtime.js";
import { isIndependentAssistantTurn } from "../goals/assistant_turn.js";
import { formatEnvironmentSummaryForPrompt } from "../environment_profile.js";
import { mayInjectUnscopedLegacyMemory } from "../revit_context_policy.js";
import { formatCodexRequestEnvelope, getThinReferenceCodexProfile, type CodexThreadStartProfile } from "./codex_turn_profile.js";
import { CodexProviderStartStopped, localThinReferenceLimits, runThinReferenceTurns, startCodexProviderTurnWhenActive, THIN_REFERENCE_NO_WORK_STOP, thinReferenceNoWorkStopNote } from "./thin_reference_execution.js";
import { advanceAssignmentKernelProgressV2 } from "../assignments/assignment_kernel_v2_progress.js";
import { formatCodexPermissionSummary } from "./codex_permission_summary.js";
import { assertCertifiedMcpServerStatus } from "../codex/certified_mcp_status.js";
import {
  beginTeammateLoopOwner,
  bindTeammateLoopOwnerTurn,
  endTeammateLoopOwner,
  reconcileTeammateReceiptWithAssistant,
  teammateLoopReceiptForLease
} from "../teammate_loop_runtime.js";
import { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";
import { enforceAuthoritativeWebEvidence, getAuthoritativeWebEvidenceRequirement } from "./authoritative_web_evidence.js";
import { FRESH_REVIT_EVIDENCE_FAILURE, getFreshRevitEvidenceRequirement } from "./revit_turn_evidence.js";
import { resolveAgentModelSettings } from "../speed_config.js";
import { conversationWorkProfile } from "./conversation_work_profile.js";
import { codexTelemetryThreadKey, createCodexTurnModelTelemetry } from "./codex_turn_model_telemetry.js";
import { assignmentModelReceiptObserver } from "../assignments/model_call_budget.js";
import { createAssignmentKernelV2ModelReceiptRecorder } from "../assignments/assignment_kernel_v2_provider_budget.js";
import {
  classifyAssignmentKernelExecutionFailureV2,
  settleAssignmentKernelExecutionFailureV2
} from "../assignments/assignment_kernel_v2_execution_failure.js";
import { getOrCreateCodexThread } from "./codex_thread_lifecycle.js";
import { awaitAssignmentQuiescence, cancelAssignmentInFlight, requestAssignmentTerminal } from "../assignments/settlement_barrier.js";
import { settleAssignmentTurn } from "../assignments/turn_settlement.js";
import { handleCodexDynamicToolCall } from "./codex_dynamic_tool_handler.js";
import { getRequestContext, runWithRequestContext, getRequestOperatorBackendAuth } from "../request_context.js";
import { assignmentDirections, observeSteeringDelivery } from "../assignments/task_steering.js";
import type { AssignmentKernelTurnLeaseV2, OperatorBackendAuthLease } from "../codex/mcp_tool_runtime.js";
import { canonicalAssignmentOutcomeForBinding } from "../assignments/outcome_handoff.js";
import { assignmentKernelV2ForBinding } from "../assignments/assignment_kernel_v2_factory.js";
import { recoverAssignmentKernelOperationsV2 } from "../assignments/assignment_kernel_v2_execution.js";
import { deriveTerminalResultV2 } from "../assignments/assignment_kernel_v2_terminal_result.js";
import {
  beginAssignmentKernelTerminalBarrierV2,
  endAssignmentKernelTerminalBarrierV2,
  type AssignmentKernelTerminalBarrierLeaseV2
} from "../assignments/assignment_kernel_v2_terminal_barrier.js";
import {
  checkpointCodexAssignmentProgressV2,
  codexAssignmentControllerStopMessage,
  currentCodexAssignmentSnapshotV2,
  finalCodexAssignmentMessageV2,
  prepareCodexAssignmentProgressV2,
  settleCodexAssignmentProgressV2
} from "./codex_assignment_progress.js";
import { formatToolResultsForCodex } from "./codex_tool_result_formatting.js";
import { createCodexTurnNotificationObserver } from "./codex_turn_notification_observer.js";
import { formatCertifiedCodexContinuation, getCodexThreadStartProfileForTest } from "./codex_brain_instructions.js";
export {
  getOperatorAgentBaseInstructions,
  getCodexThreadStartProfileForTest,
  getCodexBaseInstructionsForTest,
  formatToolResultsForCodexForTest,
  formatCertifiedCodexContinuationForTest
} from "./codex_brain_instructions.js";
export type { CodexThreadStartProfile } from "./codex_turn_profile.js";

export type StreamCallbacks = {
  onProgress?: (text: string) => void;
  onDelta?: (textDelta: string) => void;
  onDone?: (fullText: string) => void;
  abortSignal?: AbortSignal;
};

export { getFreshRevitEvidenceRequirement, isSuccessfulFreshRevitEvidence } from "./revit_turn_evidence.js";
import { registerActiveProviderTurn } from "../codex/active_turns.js";

const clientsByProfile = new Map<string, CodexAppServer>();
const mcpRuntimesByWorkspace = new Map<string, CodexMcpToolRuntime>();
const lastPermissionSignatureBySession = new Map<string, string>();
type ActiveCodexTurn = {
  abortController: AbortController;
  interruptRequested: boolean;
  interruptPromise: Promise<void> | null;
  interrupt: () => Promise<void>;
};
const activeCodexTurns = new Map<string, ActiveCodexTurn>();
const thinReferenceAborts = new Map<string, AbortController>();

export { revitCourierTargetFromContext } from "../courier/revit_courier_target.js";
export { formatCodexRequestEnvelope } from "./codex_turn_profile.js";
export { adaptDynamicToolCompletedItem, isMissingCodexThreadError } from "./codex_tool_observation.js";
export { adaptMcpToolCallResultToDynamicResponse } from "./codex_dynamic_result_adapter.js";
export { assertCertifiedMcpServerStatus };

function codexTurnAbortKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId.trim(), messageId.trim()]);
}

function requestActiveCodexTurnInterrupt(active: ActiveCodexTurn): Promise<void> {
  if (active.interruptPromise) return active.interruptPromise;
  active.interruptRequested = true;
  active.interruptPromise = active.interrupt().catch(error => {
    active.abortController.abort();
    throw error;
  });
  return active.interruptPromise;
}

export function cancelCodexBrainTurn(sessionId: string, messageId: string): boolean {
  const key = codexTurnAbortKey(sessionId, messageId);
  const experiment = thinReferenceAborts.get(key);
  experiment?.abort("request_interrupted");
  const active = activeCodexTurns.get(key);
  if (!active) return Boolean(experiment);
  void requestActiveCodexTurnInterrupt(active).catch(() => {});
  return true;
}

export function __testOnlyTrackCodexBrainTurnAbort(
  sessionId: string,
  messageId: string
): { signal: AbortSignal; interruptionRequested: () => boolean; waitForInterrupt: () => Promise<void>; cleanup: () => void } {
  const key = codexTurnAbortKey(sessionId, messageId);
  const abortController = new AbortController();
  const active: ActiveCodexTurn = {
    abortController,
    interruptRequested: false,
    interruptPromise: null,
    interrupt: async () => {}
  };
  activeCodexTurns.set(key, active);
  return {
    signal: abortController.signal,
    interruptionRequested: () => active.interruptRequested,
    waitForInterrupt: () => active.interruptPromise ?? Promise.resolve(),
    cleanup: () => {
      if (activeCodexTurns.get(key) === active) {
        activeCodexTurns.delete(key);
      }
    }
  };
}

function getWorkspaceRoot(): string {
  return ensureWorkspaceLayout().root;
}

function getCodexHome(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".codex");
}

function getCodexProfilePaths(workspaceRoot: string, profile: CodexThreadStartProfile): { codexHome: string; cwd: string } {
  if (profile.certified) return prepareCertifiedCodexIsolation({ workspaceRoot });
  const codexHome = getCodexHome(workspaceRoot);
  ensureCodexHomeAuth({ codexHome });
  ensureCodexHomeConfig({ codexHome });
  return { codexHome, cwd: workspaceRoot };
}

function buildCodexSpawnEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Do not leak OpenAI keys into child Codex processes; prefer login-backed auth.
  delete env.OPENAI_API_KEY;
  delete env.OPERATOR_OPENAI_API_KEY;
  env.OPERATOR_WORKSPACE_ROOT = workspaceRoot;
  return env;
}

function codexTurnTimeoutMs(): number {
  return resolveCodexTurnTimeoutMs(process.env.OPERATOR_CODEX_TURN_TIMEOUT_MS);
}

export async function handleCodexServerRequest(runtime: CodexMcpToolRuntime, request: CodexServerRequest): Promise<unknown> {
  if (request.method === "item/tool/call") return await handleCodexDynamicToolCall(runtime, request);
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported Codex server request: ${request.method}`);
}

export async function handleCertifiedCodexServerRequest(request: CodexServerRequest): Promise<unknown> {
  const method = request.method.toLowerCase();
  if (/(?:^|\/)(?:dynamic)?tool\/call$/.test(method) || (method.startsWith("mcp") && request.method !== "mcpServer/elicitation/request")) {
    return { contentItems: [{ type: "inputText", text: "Certified direct mode does not permit dynamic, MCP, or Revit tool execution." }], success: false };
  }
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (request.method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (request.method === "item/tool/requestUserInput") return { answers: {} };
  if (request.method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
  throw new Error(`Unsupported certified Codex server request: ${request.method}`);
}

function clientCacheKey(workspaceRoot: string, profile: CodexThreadStartProfile): string {
  return `${workspaceRoot}\u0000${profile.profileNamespace}`;
}

async function getClient(workspaceRoot: string, profile: CodexThreadStartProfile): Promise<CodexAppServer> {
  const cacheKey = clientCacheKey(workspaceRoot, profile);
  const existing = clientsByProfile.get(cacheKey);
  if (existing) return existing;
  const { codexHome, cwd } = getCodexProfilePaths(workspaceRoot, profile);
  const spawnEnv = buildCodexSpawnEnv(workspaceRoot);
  let mcpRuntime: CodexMcpToolRuntime | undefined;
  if (!profile.certified) {
    mcpRuntime = mcpRuntimesByWorkspace.get(workspaceRoot);
    if (!mcpRuntime) {
      mcpRuntime = new CodexMcpToolRuntime({
        backendCwd: process.cwd(),
        workspaceRoot,
        codexHome,
        spawnEnv
      });
      mcpRuntimesByWorkspace.set(workspaceRoot, mcpRuntime);
    }
  }

  const client = new CodexAppServer({
    cwd,
    codexHome,
    spawnEnv
  });
  client.setServerRequestHandler(async request => profile.certified
    ? await handleCertifiedCodexServerRequest(request)
    : await handleCodexServerRequest(mcpRuntime!, request));
  clientsByProfile.set(cacheKey, client);
  try {
    await client.ensureStarted();
    if (profile.certified) assertCertifiedMcpServerStatus(await client.request("mcpServerStatus/list", {
      cursor: null,
      limit: 100,
      detail: "toolsAndAuthOnly",
    }));
  } catch (error) {
    if (clientsByProfile.get(cacheKey) === client) clientsByProfile.delete(cacheKey);
    client.stop();
    throw error;
  }

  // Ensure MCP server config is reloaded at least once on startup.
  if (!profile.certified) {
    try {
      await client.request("config/mcpServer/reload", undefined);
    } catch {
      // best effort; some codex versions may not expose this method
    }
  }

  return client;
}

function isTransportClosedError(err: unknown): boolean {
  if (err instanceof CodexTurnFailedError) return false;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /transport closed/i.test(msg) || /app-server exited/i.test(msg) || /ECONNRESET/i.test(msg);
}

async function withTransportRetry<T>(workspaceRoot: string, profile: CodexThreadStartProfile, fn: (client: CodexAppServer) => Promise<T>): Promise<T> {
  const cacheKey = clientCacheKey(workspaceRoot, profile);
  let client = await getClient(workspaceRoot, profile);
  try {
    return await fn(client);
  } catch (err) {
    if (!isTransportClosedError(err)) throw err;
    // Best-effort: restart the app-server connection once and retry.
    if (clientsByProfile.get(cacheKey) === client) clientsByProfile.delete(cacheKey);
    client.stop();
    client = await getClient(workspaceRoot, profile);
    return await fn(client);
  }
}

export async function warmCodexAppServer(): Promise<void> {
  await getClient(getWorkspaceRoot(), getCodexThreadStartProfileForTest({ session_id: "warm", context: {} }));
}

export function getCodexAppServerCompatibility(): { version: ReturnType<CodexAppServer["getCompatibilityReceipt"]>["version"]; initialized: boolean } | null {
  const profile = getCodexThreadStartProfileForTest({ session_id: "compatibility", context: {} });
  const receipt = clientsByProfile.get(clientCacheKey(getWorkspaceRoot(), profile))?.getCompatibilityReceipt();
  return receipt ? { version: receipt.version, initialized: receipt.initialize_response !== null } : null;
}

async function getOrCreateThreadId(
  req: ChatRequest,
  client: CodexAppServer,
  workspaceRoot: string,
  agent: ReturnType<typeof resolveAgentModelSettings>,
  profile: CodexThreadStartProfile,
  monitoringOnly = false
): Promise<string> {
  const profilePaths = getCodexProfilePaths(workspaceRoot, profile);
  return getOrCreateCodexThread({
    sessionId: req.session_id,
    monitoringOnly,
    client,
    profile,
    cwd: profilePaths.cwd,
    settings: agent,
    getDynamicTools: async () => {
      if (profile.dynamicToolMode !== "revit_runtime") return [];
      const runtime = mcpRuntimesByWorkspace.get(workspaceRoot);
      if (!runtime) throw new Error("Revit Operator MCP runtime is not configured for this workspace.");
      return [await runtime.getDynamicToolNamespace()];
    }
  });
}

export async function decideCodex(req: ChatRequest): Promise<ChatResponse> {
  const chunks: string[] = [];
  const resp = await decideCodexStreaming(req, { onDelta: d => chunks.push(d) });
  return { ...resp, assistant_message: resp.assistant_message || chunks.join("") };
}

export async function decideCodexStreaming(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse> {
  const limits = localThinReferenceLimits(req);
  if (!limits) return decideCodexSingleTurn(req, cb);
  if (!req.assignment_id || !req.assignment_run_id || !req.assignment_generation) {
    throw new Error("Local thin-reference execution requires an existing V2 assignment.");
  }
  const assignment = assignmentKernelV2ForBinding({ session_id: req.session_id,
    assignment_id: req.assignment_id, run_id: req.assignment_run_id, generation: req.assignment_generation });
  if (!assignment) throw new Error("Local thin-reference execution requires the current V2 assignment binding.");
  const key = codexTurnAbortKey(req.session_id, req.message_id);
  if (thinReferenceAborts.has(key)) throw new Error("thin_reference_request_already_running");
  const controller = new AbortController();
  const workProfile = conversationWorkProfile(req);
  thinReferenceAborts.set(key, controller);
  const abort = () => controller.abort("request_interrupted");
  if (cb.abortSignal?.aborted) abort();
  else cb.abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort("experiment_wall_limit"), limits.max_wall_ms);
  timer.unref();
  try {
    const result = await runThinReferenceTurns({ request: req, binding: assignment.binding, limits, signal: controller.signal,
      inspect: () => advanceAssignmentKernelProgressV2({ binding: assignment.binding }),
      invoke: request => decideCodexSingleTurn(request, { onProgress: cb.onProgress, abortSignal: controller.signal }, true, workProfile),
      onContinue: () => cb.onProgress?.("Continuing the saved task.") });
    const snapshot = result.stop_reason === THIN_REFERENCE_NO_WORK_STOP
      ? currentCodexAssignmentSnapshotV2(assignment.binding) ?? undefined : result.response.assignment_snapshot_v2;
    let message = finalCodexAssignmentMessageV2(snapshot ?? null, result.response.assistant_message);
    if (!snapshot?.terminal && result.stop_reason.startsWith("experiment_")) {
      message += `\n\nThe local experiment reached its ${result.stop_reason === "experiment_turn_limit" ? "provider-turn" : "time"} limit. Completed work and remaining checks are saved.`;
    }
    const noWorkNote = thinReferenceNoWorkStopNote(result.stop_reason, assignment.binding, snapshot ?? null);
    if (noWorkNote) message += `\n\n${noWorkNote}`;
    const receipt = { schema: "revit-operator.local-execution-experiment/v1" as const,
      lane: "thin-reference" as const, turns: result.turns, stop_reason: result.stop_reason,
      duration_ms: result.duration_ms, provider_turns: result.provider_turns };
    appendEvent(req.session_id, "assistant", "codex.thin-reference.settled", receipt);
    cb.onDelta?.(message); cb.onDone?.(message);
    return { ...result.response, assignment_snapshot_v2: snapshot, assistant_message: message, local_execution_experiment: receipt,
      ...(snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(snapshot) } : {}) };
  } finally {
    clearTimeout(timer); cb.abortSignal?.removeEventListener("abort", abort);
    if (thinReferenceAborts.get(key) === controller) thinReferenceAborts.delete(key);
  }
}

async function decideCodexSingleTurn(req: ChatRequest, cb: StreamCallbacks, thinReference = false, fixedWorkProfile?: ReturnType<typeof conversationWorkProfile>): Promise<ChatResponse> {
  const assignmentKernelV2 = req.assignment_id && req.assignment_run_id
    && Number.isSafeInteger(req.assignment_generation) && Number(req.assignment_generation) > 0
    ? assignmentKernelV2ForBinding({
        session_id: req.session_id,
        assignment_id: req.assignment_id,
        run_id: req.assignment_run_id,
        generation: Number(req.assignment_generation)
      })
    : null;
  const threadProfile = Object.freeze(thinReference ? getThinReferenceCodexProfile(req.session_id, Boolean(assignmentKernelV2?.snapshot.spec.execution_policy)) : getCodexThreadStartProfileForTest(req));
  const workProfile = fixedWorkProfile ?? conversationWorkProfile(req);
  const agentSettings = workProfile.settings;
  const instructionBindingStop = (error: CodexInstructionBindingError): ChatResponse => {
    cb.onDone?.(error.message);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `[${error.code}] ${error.message}`,
      actions: [],
      provider_turn_usage: {
        schema: "revit-operator.provider-turn-usage/v1",
        session_id: req.session_id, message_id: req.message_id,
        thread_id: null, turn_id: null, disposition: "not_started", raw_response_ids: []
      },
      ...(assignmentKernelV2 ? { assignment_snapshot_v2: assignmentKernelV2.snapshot } : {})
    };
  };
  const stopBeforeProvider = (
    message: string,
    failureId: string,
    phase: "request_validation" | "runtime_setup" | "provider_start",
    errorClass: "provider" | "transport" | "runtime" | "canceled" | "resource_exhausted" = "runtime"
  ): ChatResponse => {
    const snapshot = assignmentKernelV2
      ? settleAssignmentKernelExecutionFailureV2({
          binding: assignmentKernelV2.binding,
          failure_id: failureId,
          error_class: errorClass,
          phase
        }).snapshot
      : null;
    const assistantMessage = snapshot
      && snapshot.terminal
      && ["complete", "complete_with_issues", "verified_noop"].includes(snapshot.outcome)
      ? finalCodexAssignmentMessageV2(snapshot, message)
      : message;
    cb.onDone?.(assistantMessage);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: assistantMessage,
      actions: [],
      // Every caller returns before startBoundTurn admits a model turn,
      // including failure to initialize the provider connection. Record the
      // exact no-start result so a later benchmark does not lose this turn.
      provider_turn_usage: {
        schema: "revit-operator.provider-turn-usage/v1" as const,
        session_id: req.session_id, message_id: req.message_id,
        thread_id: null, turn_id: null, disposition: "not_started" as const, raw_response_ids: []
      },
      ...(snapshot ? { assignment_snapshot_v2: snapshot } : {}),
      ...(snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(snapshot) } : {})
    };
  };
  const requestBackendAuth = getRequestOperatorBackendAuth();
  const certifiedDirect = threadProfile.certified;
  let courierTarget: ReturnType<typeof revitCourierTargetFromContext> | undefined;
  if (!certifiedDirect) {
    try {
      courierTarget = revitCourierTargetFromContext(req.context);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : String(error)} I stopped before planning or Revit tool actions.`;
      return stopBeforeProvider(message, `request-validation:${req.message_id}`, "request_validation");
    }
  }
  const workspaceRoot = getWorkspaceRoot();
  let c: CodexAppServer;
  let threadId: string;


  const text = (req.user_text ?? "").toString();
  const freshEvidenceRequirement = certifiedDirect ? { required: false, kind: "none" as const, prompt: "" } : getFreshRevitEvidenceRequirement(text);
  const webEvidenceRequirement = certifiedDirect ? { required: false, prompt: "" } : getAuthoritativeWebEvidenceRequirement(text);
  let memBlock = "";
  let projectProfileBlock = "";
  let requirementsBlock = "";
  let requirementsReceipt: RequirementsReceipt | null = null;
  let requirementsError = "";
  const allowUnscopedLegacyMemory = !certifiedDirect && mayInjectUnscopedLegacyMemory(req.context);
  try {
    projectProfileBlock = allowUnscopedLegacyMemory ? formatProjectProfileForPrompt() : "";
  } catch {
    projectProfileBlock = "";
  }
  if (!certifiedDirect) {
    try {
      requirementsReceipt = resolveRequirementsForChat(req);
      requirementsBlock = formatRequirementsForPrompt(requirementsReceipt);
    } catch (error) {
      requirementsReceipt = null;
      requirementsBlock = "";
      requirementsError = error instanceof Error ? error.message : String(error);
    }
  }
  if (requirementsError) {
    const message = `Durable requirements could not be read safely (${requirementsError}). I stopped before planning or tool actions.`;
    return stopBeforeProvider(message, `requirements-read:${req.message_id}`, "request_validation");
  }
  if (requirementsReceipt && requirementsReceipt.status !== "resolved") {
    const message = `Durable requirements are ${requirementsReceipt.status}. I stopped before planning or tool actions; resolve or narrow the attached receipt first.`;
    return {
      ...stopBeforeProvider(message, `requirements-unresolved:${req.message_id}`, "request_validation"),
      requirements_receipt: requirementsReceipt
    };
  }
  try {
    const query = text.trim() || (getPinnedGoal(req.session_id) ?? "") || "";
    memBlock = allowUnscopedLegacyMemory && !freshEvidenceRequirement.required && !webEvidenceRequirement.required && query
      ? formatTaskMemoryContext(req.session_id, query, 6)
      : "";
  } catch {
    memBlock = "";
  }
  let activeGoalBlock = "";
  try {
    activeGoalBlock = isIndependentAssistantTurn(req) ? ""
      : formatActiveGoalContext(assignmentKernelV2?.goal ?? getActiveGoalForSession(req.session_id));
  } catch {
    activeGoalBlock = "";
  }
  let input: UserInput[];
  let inputContextBlocks: string[] = [];
  try {
    input = certifiedDirect
      ? [{ type: "text", text: text.trim() ? [formatCodexRequestEnvelope(req), `USER:\n${text}`, formatToolResultsForCodex(req.tool_results)].filter(Boolean).join("\n\n") : formatCertifiedCodexContinuation(req), text_elements: [] }]
      : await buildCodexTurnInput(req, inputContextBlocks = (() => {
            const blocks: string[] = [];
            if (workProfile.instruction) blocks.push(workProfile.instruction);
            if (assignmentKernelV2) {
              const directions = assignmentDirections(assignmentKernelV2.binding).filter(direction => direction.state !== "rejected");
              if (directions.length) blocks.push("ADDITIONAL USER DIRECTIONS, in order:\n" + JSON.stringify(directions.map(direction => ({ text: direction.text, delivery: direction.state, delivery_updated_at: direction.updated_at })))
                + "\nThe delivery_updated_at timestamp is the latest delivery receipt update, not necessarily when the direction was first saved. Follow these saved directions even after resuming. Existing native effects remain evidence; inspect them before repeating work. Reconcile the plan and the requested result against the latest direction. A direction does not change this assignment's document or read/write authority. If it requires a different authority or incompatible scope, stop and explain what needs to change.");
            }
            if (!certifiedDirect && !thinReference && activeGoalBlock) blocks.push(activeGoalBlock);
            if (projectProfileBlock) blocks.push(projectProfileBlock);
            if (requirementsBlock) blocks.push(requirementsBlock);
            if (!certifiedDirect) {
              try {
                blocks.push(formatEnvironmentSummaryForPrompt());
              } catch {}
              try {
                const contractMemory = formatRevitToolContractMemoryForPrompt();
                if (contractMemory) blocks.push(contractMemory);
              } catch {}
            }
            if (freshEvidenceRequirement.prompt) blocks.push(freshEvidenceRequirement.prompt);
            if (webEvidenceRequirement.prompt) blocks.push(webEvidenceRequirement.prompt);
            if (memBlock) blocks.push(memBlock);
            if (!certifiedDirect) {
              try {
                const perms = formatCodexPermissionSummary(req.context);
                if (perms) {
                  const prev = lastPermissionSignatureBySession.get(req.session_id) || "";
                  lastPermissionSignatureBySession.set(req.session_id, perms.signature);
                  if (prev && prev !== perms.signature) blocks.push(`PERMISSION UPDATE (changed since last message):\n${perms.summary}`);
                  else blocks.push(perms.summary);
                }
              } catch {}
            }
            return blocks;
          })(), thinReference);
  } catch (error) {
    return stopBeforeProvider(
      `${error instanceof Error ? error.message : String(error)} I stopped before planning or Revit tool actions.`,
      `visual-input:${req.message_id}`, "request_validation"
    );
  }
  const initialInputLength = input.length;
  const inputForProviderThread = async (selectedThreadId: string): Promise<UserInput[]> => {
    if (certifiedDirect || !assignmentKernelV2 || hasCodexThreadStartedTurn(selectedThreadId)) return input;
    const recovered = recoverAssignmentVisualAttachments(req, {
      new_provider_thread: true,
      source_binding: assignmentKernelV2.snapshot.spec.binding,
      current_binding: assignmentKernelV2.snapshot.current_binding,
      source_message_id: String(assignmentKernelV2.goal.work_budget?.conversation_message_id ?? "")
    });
    if (recovered === req) return input;
    // Preserve progress/lease context added after the initial request input.
    return [...await buildCodexTurnInput(recovered, inputContextBlocks, thinReference), ...input.slice(initialInputLength)];
  };

  let requirementsLease: ReturnType<typeof beginRequirementsPlanningLease> | null = null;
  if (requirementsReceipt) {
    try {
      const plannedReceiptSha256 = requirementsReceipt.receipt_sha256;
      requirementsLease = beginRequirementsPlanningLease(plannedReceiptSha256, codexTurnTimeoutMs() + 60_000);
      const leasedReceipt = resolveRequirementsForChat(req);
      if (leasedReceipt.status !== "resolved" || leasedReceipt.receipt_sha256 !== plannedReceiptSha256) {
        endRequirementsPlanningLease(requirementsLease);
        requirementsLease = null;
        const message = leasedReceipt.status === "resolved"
          ? "Durable requirements changed while the planning lease was being acquired. I stopped before tool actions; re-run the request against the attached current receipt."
          : `Durable requirements became ${leasedReceipt.status} while the planning lease was being acquired. I stopped before tool actions; resolve or narrow the attached receipt first.`;
        return {
          ...stopBeforeProvider(message, `requirements-changed:${req.message_id}`, "request_validation"),
          requirements_receipt: leasedReceipt
        };
      }
      requirementsReceipt = leasedReceipt;
    } catch (error) {
      endRequirementsPlanningLease(requirementsLease);
      requirementsLease = null;
      const message = `Durable requirements could not be leased and revalidated safely (${error instanceof Error ? error.message : String(error)}). I stopped before planning or tool actions.`;
      return {
        ...stopBeforeProvider(message, `requirements-lease:${req.message_id}`, "request_validation"),
        requirements_receipt: requirementsReceipt
      };
    }
  }
  const mcpRuntime = threadProfile.startRevitTurnRuntime ? mcpRuntimesByWorkspace.get(workspaceRoot) : null;
  if (threadProfile.startRevitTurnRuntime && !mcpRuntime) {
    endRequirementsPlanningLease(requirementsLease);
    requirementsLease = null;
    return stopBeforeProvider(
      "Revit Operator MCP runtime is not configured for this workspace. I stopped before the provider or any Revit tool was called.",
      `runtime-missing:${req.message_id}`,
      "runtime_setup"
    );
  }
  const backendAuth = threadProfile.startRevitTurnRuntime ? requestBackendAuth : undefined;
  if (threadProfile.startRevitTurnRuntime && !backendAuth) {
    endRequirementsPlanningLease(requirementsLease);
    requirementsLease = null;
    const message = "Authenticated Operator backend transport is unavailable. I stopped before the provider or any Revit tool was called.";
    return stopBeforeProvider(message, `backend-transport-missing:${req.message_id}`, "runtime_setup", "transport");
  }
  let backendAuthLease: OperatorBackendAuthLease | null = null;
  let assignmentKernelV2Lease: AssignmentKernelTurnLeaseV2 | null = null;
  let teammateContext: ReturnType<typeof beginTeammateLoopOwner> | null = null;
  let teammateReceipt: ReturnType<typeof teammateLoopReceiptForLease> | undefined;
  let courierContext: ReturnType<typeof beginRevitCourierTurnContext> = null;
  let assignmentProgressTurnStart: ReturnType<typeof currentCodexAssignmentSnapshotV2> = null;
  let assignmentTerminalBarrier: AssignmentKernelTerminalBarrierLeaseV2 | null = null;
  let assignmentBudgetInterrupt: (() => void) | null = null;
  let assignmentControllerStopReason: string | null = null;
  let providerReceiptRecorder: ReturnType<typeof createAssignmentKernelV2ModelReceiptRecorder> | null = null;
  let reconcileStartedProviderTurn: (() => void) | null = null;
  const earlyTurnNotifications: CodexNotificationEnvelope[] = [];
  const turnRequestContext = getRequestContext();
  let providerControlTurnId = "";
  let liveTurnNotificationHandler: ((notification: CodexNotificationEnvelope) => void) | null = null;
  let notificationSource: CodexAppServer | null = null;
  let unsubscribeTurnNotifications: () => void = () => {};
  const bindTurnNotificationSource = (activeClient: CodexAppServer) => {
    if (notificationSource === activeClient) return;
    unsubscribeTurnNotifications();
    notificationSource = activeClient;
    unsubscribeTurnNotifications = activeClient.onNotification(notification => {
      if (providerControlTurnId) runWithRequestContext(turnRequestContext ?? {}, () =>
        observeSteeringDelivery(req.session_id, threadId, providerControlTurnId, notification));
      if (liveTurnNotificationHandler) liveTurnNotificationHandler(notification);
      else earlyTurnNotifications.push(notification);
    });
  };
  let start: Awaited<ReturnType<CodexAppServer["startTurn"]>>;
  const agentTurnStartedAt = new Date().toISOString();
  const agentTurnStartedMs = Date.now();
  try {
    if (threadProfile.startRevitTurnRuntime) {
      backendAuthLease = mcpRuntime!.beginBackendAuthLease(req.session_id, backendAuth!);
      if (assignmentKernelV2) assignmentKernelV2Lease = mcpRuntime!.beginAssignmentKernelV2Lease(assignmentKernelV2.binding);
      teammateContext = beginTeammateLoopOwner(mcpRuntime!, req, { canonicalSupervisionOnly: thinReference });
      courierContext = beginRevitCourierTurnContext({
        session_id: req.session_id,
        message_id: req.message_id,
        ttl_ms: codexTurnTimeoutMs() + 60_000,
        ...courierTarget!
      });
      if (assignmentKernelV2 && assignmentKernelV2.snapshot.in_flight_operation_ids.length > 0) {
        const recovered = await recoverAssignmentKernelOperationsV2({
          snapshot: assignmentKernelV2.snapshot,
          runtime: mcpRuntime!
        });
        if (recovered.assignment_version !== assignmentKernelV2.snapshot.assignment_version) {
          input.push({
            type: "text",
            text: `AUTHORITATIVE V2 RESTART RECOVERY:\n${formatActiveGoalContext(getGoal(recovered.spec.binding.assignment_id))}`,
            text_elements: [] as any[]
          });
        }
      }
      if (assignmentKernelV2) {
        const progression = prepareCodexAssignmentProgressV2(assignmentKernelV2.binding, thinReference);
        if (!progression.prompt) {
          const message = progression.message;
          const canonicalAssignmentOutcome = canonicalAssignmentOutcomeForBinding({
            session_id: assignmentKernelV2.binding.session_id,
            assignment_id: assignmentKernelV2.binding.assignment_id,
            assignment_run_id: assignmentKernelV2.binding.run_id,
            assignment_generation: assignmentKernelV2.binding.generation
          });
          mcpRuntime?.endBackendAuthLease(backendAuthLease);
          backendAuthLease = null;
          mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
          assignmentKernelV2Lease = null;
          endTeammateLoopOwner(teammateContext);
          teammateContext = null;
          endRevitCourierTurnContext(courierContext);
          courierContext = null;
          endRequirementsPlanningLease(requirementsLease);
          requirementsLease = null;
          cb.onDone?.(message);
          return {
            version: OPERATOR_BACKEND_CONTRACT_VERSION,
            assistant_message: message,
            actions: [],
            provider_turn_usage: {
              schema: "revit-operator.provider-turn-usage/v1",
              session_id: req.session_id, message_id: req.message_id,
              thread_id: null, turn_id: null, disposition: "not_started", raw_response_ids: []
            },
            assignment_snapshot_v2: progression.snapshot,
            ...(progression.snapshot.terminal ? { terminal_result_v2: deriveTerminalResultV2(progression.snapshot) } : {}),
            ...(canonicalAssignmentOutcome ? { canonical_assignment_outcome: canonicalAssignmentOutcome } : {})
          };
        }
        assignmentProgressTurnStart = progression.snapshot;
        input.push({ type: "text", text: progression.prompt, text_elements: [] as any[] });
      }
    }
    try {
      c = await getClient(workspaceRoot, threadProfile);
      threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings, threadProfile);
      });
    } catch (error) {
      mcpRuntime?.endBackendAuthLease(backendAuthLease);
      backendAuthLease = null;
      mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
      assignmentKernelV2Lease = null;
      endTeammateLoopOwner(teammateContext);
      teammateContext = null;
      endRevitCourierTurnContext(courierContext);
      courierContext = null;
      endRequirementsPlanningLease(requirementsLease);
      requirementsLease = null;
      if (error instanceof CodexInstructionBindingError) return instructionBindingStop(error);
      recordProviderStartFailureDiagnostic({
        session_id: req.session_id, message_id: req.message_id, error
      }, (sessionId, payload) => appendEvent(sessionId, "assistant", "codex.provider.start.error", payload));
      return stopBeforeProvider(
        "The provider connection could not be initialized. I stopped before planning or any Revit tool action.",
        `provider-start:${req.message_id}`,
        "provider_start",
        classifyAssignmentKernelExecutionFailureV2(error)
      );
    }
    providerReceiptRecorder = assignmentKernelV2
      ? createAssignmentKernelV2ModelReceiptRecorder({
          binding: assignmentKernelV2.binding,
          admission_snapshot: assignmentProgressTurnStart ?? assignmentKernelV2.snapshot,
          onStop: () => {
            assignmentControllerStopReason = assignmentControllerStopReason ?? "assignment_progress_controller_stop";
            assignmentBudgetInterrupt?.();
          }
        })
      : null;
    if (assignmentKernelV2) {
      assignmentTerminalBarrier = beginAssignmentKernelTerminalBarrierV2({
        binding: assignmentKernelV2.binding,
        barrier_id: `provider-request:${req.message_id}`
      });
    }
    try {
      start = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        bindTurnNotificationSource(activeClient);
        const providerInput = await inputForProviderThread(threadId);
        return await startCodexProviderTurnWhenActive({ signal: cb.abortSignal, binding: assignmentKernelV2?.binding,
          readSnapshot: () => assignmentKernelV2 ? currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding) : null }, () => activeClient.startBoundTurn({
          threadId,
          input: withCodexCapabilityHandoff(providerInput, threadId),
          model: agentSettings.model,
          effort: agentSettings.reasoning_effort
        }, threadProfile));
      });
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
      setCodexThreadId(codexTelemetryThreadKey(threadProfile), "");
      threadId = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
        c = activeClient;
        return await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings, threadProfile);
      });
      bindTurnNotificationSource(c);
      const providerInput = await inputForProviderThread(threadId);
      start = await startCodexProviderTurnWhenActive({ signal: cb.abortSignal, binding: assignmentKernelV2?.binding,
        readSnapshot: () => assignmentKernelV2 ? currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding) : null }, () => c.startBoundTurn({
        threadId,
        input: withCodexCapabilityHandoff(providerInput, threadId),
        model: agentSettings.model,
        effort: agentSettings.reasoning_effort
      }, threadProfile));
    }
  } catch (error) {
    endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier);
    assignmentTerminalBarrier = null;
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    mcpRuntime?.endBackendAuthLease(backendAuthLease);
    backendAuthLease = null;
    mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
    assignmentKernelV2Lease = null;
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    if (error instanceof CodexProviderStartStopped) {
      const message = finalCodexAssignmentMessageV2(error.snapshot, error.message);
      cb.onDone?.(message);
      return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [],
        provider_turn_usage: { schema: "revit-operator.provider-turn-usage/v1", session_id: req.session_id,
          message_id: req.message_id, thread_id: null, turn_id: null, disposition: "not_started", raw_response_ids: [] },
        ...(error.snapshot ? { assignment_snapshot_v2: error.snapshot } : {}),
        ...(error.snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(error.snapshot) } : {}) };
    }
    if (error instanceof CodexInstructionBindingError) return instructionBindingStop(error);
    throw error;
  }

  const turnId = typeof start?.turn?.id === "string" ? start.turn.id : "";
  providerControlTurnId = turnId;
  if (!turnId) {
    endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier);
    assignmentTerminalBarrier = null;
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    mcpRuntime?.endBackendAuthLease(backendAuthLease);
    backendAuthLease = null;
    mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease);
    assignmentKernelV2Lease = null;
    endTeammateLoopOwner(teammateContext);
    teammateContext = null;
    endRevitCourierTurnContext(courierContext);
    courierContext = null;
    endRequirementsPlanningLease(requirementsLease);
    throw new Error("Codex turn/start did not return a turn id.");
  }
  let providerTurnResourcesReleased = false;
  let releaseActiveTurnRegistration: (() => void) | null = null;
  const releaseStartedProviderTurn = async (interrupt: boolean): Promise<void> => {
    if (providerTurnResourcesReleased) return;
    const cleanupErrors: string[] = [];
    if (interrupt) {
      try {
        await c.interruptTurn({ threadId, turnId });
      } catch (error) {
        cleanupErrors.push(`interrupt: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await c.waitForTurnCompleted({
          threadId,
          turnId,
          timeoutMs: Math.min(codexTurnTimeoutMs(), 10_000)
        });
      } catch (error) {
        cleanupErrors.push(`interrupt drain: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const cleanup = (label: string, action: () => void) => {
      try {
        action();
      } catch (error) {
        cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    cleanup("provider receipt reconciliation", () => reconcileStartedProviderTurn?.());
    reconcileStartedProviderTurn = null;
    cleanup("notification subscription", () => unsubscribeTurnNotifications());
    unsubscribeTurnNotifications = () => {};
    liveTurnNotificationHandler = null;
    cleanup("active turn registration", () => releaseActiveTurnRegistration?.());
    releaseActiveTurnRegistration = null;
    cleanup("terminal barrier", () => endAssignmentKernelTerminalBarrierV2(assignmentTerminalBarrier));
    assignmentTerminalBarrier = null;
    cleanup("backend auth lease", () => mcpRuntime?.endBackendAuthLease(backendAuthLease));
    backendAuthLease = null;
    cleanup("Assignment Kernel lease", () => mcpRuntime?.endAssignmentKernelV2Lease(assignmentKernelV2Lease));
    assignmentKernelV2Lease = null;
    cleanup("requirements planning lease", () => endRequirementsPlanningLease(requirementsLease));
    requirementsLease = null;
    cleanup("teammate loop owner", () => endTeammateLoopOwner(teammateContext));
    teammateContext = null;
    cleanup("Revit courier context", () => endRevitCourierTurnContext(courierContext));
    courierContext = null;
    providerTurnResourcesReleased = true;
    if (cleanupErrors.length > 0) {
      throw new Error(`Started provider turn cleanup failed (${cleanupErrors.join("; ")}).`);
    }
  };

  try {
  const modelTelemetry = createCodexTurnModelTelemetry({
    sessionId: req.session_id,
    threadId,
    turnId,
    settings: agentSettings,
    startedAtUtc: agentTurnStartedAt,
    onReceipt: providerReceiptRecorder
      ? providerReceiptRecorder.observe
      : assignmentModelReceiptObserver(req.session_id, () => {
          assignmentControllerStopReason = "absolute_model_call_limit_reached";
          assignmentBudgetInterrupt?.();
        })
  });
  const workerIdentity = readCodexWorkerIdentity({ codexHome: c.getConfiguredCodexHome(), settings: agentSettings });
  reconcileStartedProviderTurn = () => {
    for (const notification of earlyTurnNotifications) modelTelemetry.observe(notification);
    providerReceiptRecorder?.reconcile(modelTelemetry.receipts);
  };
  if (backendAuthLease) mcpRuntime!.bindBackendAuthLeaseTurn(backendAuthLease, turnId);
  if (assignmentKernelV2Lease) mcpRuntime!.bindAssignmentKernelV2LeaseTurn(assignmentKernelV2Lease, turnId);
  if (teammateContext) bindTeammateLoopOwnerTurn(teammateContext, turnId);
  try {
    const persisted = appendEvent(req.session_id, "assistant", "codex.turn.start", { session_id: req.session_id,
      message_id: req.message_id, thread_id: threadId, turn_id: turnId,
      host_instruction_binding: c.getTurnInstructionBinding(threadId, turnId) ?? null });
    if (persisted) c.acknowledgePersistedTurnInstructionBinding(threadId, turnId);
  } catch {
    // ignore
  }

  const assignmentObserver = assignmentKernelV2 || isIndependentAssistantTurn(req)
    ? { observe: (_value: unknown) => {}, finish: (_turnId: string, _assistant: string, _receipt: unknown) => {} }
    : createAutoGoalTurnObserver(req.session_id);
  const turnNotificationObserver = createCodexTurnNotificationObserver({
    sessionId: req.session_id,
    threadId,
    turnId,
    modelTelemetry,
    assignmentObserver,
    freshEvidenceRequirement,
    webEvidenceRequirement,
    mcpRuntime: mcpRuntime ?? null,
    deferAssistantOutput: Boolean(assignmentKernelV2),
    onDelta: cb.onDelta,
    onProgress: cb.onProgress
  });
  liveTurnNotificationHandler = turnNotificationObserver.observe;
  for (const notification of earlyTurnNotifications.splice(0)) turnNotificationObserver.observe(notification);

  const activeTurnAbort = new AbortController();
  const activeTurnKey = codexTurnAbortKey(req.session_id, req.message_id);
  const activeTurn: ActiveCodexTurn = {
    abortController: activeTurnAbort,
    interruptRequested: false,
    interruptPromise: null,
    interrupt: async () => {
      await c.interruptTurn({ threadId, turnId });
    }
  };
  assignmentBudgetInterrupt = () => {
    void requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
  };
  if (assignmentKernelV2) {
    mcpRuntime?.bindAssignmentKernelV2TurnStop(turnId, reason => {
      assignmentControllerStopReason = assignmentControllerStopReason ?? reason;
      assignmentBudgetInterrupt?.();
    });
  }
  if (assignmentControllerStopReason) assignmentBudgetInterrupt();
  const priorActiveTurn = activeCodexTurns.get(activeTurnKey);
  if (priorActiveTurn) void requestActiveCodexTurnInterrupt(priorActiveTurn).catch(() => {});
  activeCodexTurns.set(activeTurnKey, activeTurn);
  const unregisterProviderControls = registerActiveProviderTurn({
    sessionId: req.session_id, messageId: req.message_id, threadId, turnId,
    binding: assignmentKernelV2?.binding ?? null,
    interrupt: () => requestActiveCodexTurnInterrupt(activeTurn),
    interruptionRequested: () => activeTurn.interruptRequested,
    steer: (text, commandId) => {
      if (activeTurn.interruptRequested) return Promise.reject(new Error("This task is pausing. Resume before sending another direction."));
      return c.steerTurn({ threadId, expectedTurnId: turnId, clientUserMessageId: commandId,
        input: [{ type: "text", text, text_elements: [] }] });
    }
  });
  const forwardExternalAbort = () => {
    void requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
  };
  if (cb.abortSignal?.aborted) forwardExternalAbort();
  else cb.abortSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  releaseActiveTurnRegistration = () => {
    unregisterProviderControls();
    cb.abortSignal?.removeEventListener("abort", forwardExternalAbort);
    if (activeCodexTurns.get(activeTurnKey) === activeTurn) {
      activeCodexTurns.delete(activeTurnKey);
    }
    assignmentBudgetInterrupt = null;
    mcpRuntime?.clearAssignmentKernelV2TurnStop(turnId);
  };
  let turnCancelled = false;
  let providerTurnDisposition: "completed" | "interrupted" | "failed" = "failed";
  let providerTurnUsage: ReturnType<typeof modelTelemetry.finish> | undefined;
  let providerReceiptReconciliationError: unknown = null;
  let usageHoldError: unknown = null;
  const assignmentIdForTurn = assignmentKernelV2?.binding.assignment_id
    ?? (isIndependentAssistantTurn(req) ? null : getActiveGoalForSession(req.session_id)?.id ?? null);
  try {
    const completion = await withTransportRetry(workspaceRoot, threadProfile, async activeClient => {
      c = activeClient;
      bindTurnNotificationSource(activeClient);
      if (!activeClient.hasLoadedThread(threadId)) {
        const resumedThreadId = await getOrCreateThreadId(req, activeClient, workspaceRoot, agentSettings, threadProfile, true);
        if (resumedThreadId !== threadId) throw new Error(`Codex active thread ${threadId} could not be resumed after reconnect.`);
      }
      return await activeClient.waitForTurnCompleted({
        threadId,
        turnId,
        timeoutMs: Math.min(codexTurnTimeoutMs(), 10 * 60_000),
        maxWallMs: codexTurnTimeoutMs(),
        abortSignal: activeTurnAbort.signal
      });
    });
    turnCancelled = completion.interrupted || activeTurn.interruptRequested;
    providerTurnDisposition = turnCancelled ? "interrupted" : "completed";
  } catch (error) {
    if (!activeTurnAbort.signal.aborted && assignmentKernelV2 && recordCodexProviderUsageHoldV2({
      binding: assignmentKernelV2.binding, attempt_id: req.message_id, thread_id: threadId, turn_id: turnId,
      error, is_current_failure: failure => c.isCurrentTurnFailure(failure),
      worker_identity: { ...workerIdentity, ...modelTelemetry.modelIdentity() }
    })) {
      usageHoldError = error;
    } else if (!activeTurnAbort.signal.aborted) {
      if (!assignmentKernelV2 && assignmentIdForTurn && /timed?\s*out|timeout|deadline/i.test(error instanceof Error ? error.message : String(error))) {
        await requestActiveCodexTurnInterrupt(activeTurn).catch(() => {});
        const drained = await awaitAssignmentQuiescence(assignmentIdForTurn);
        if (drained.terminal_state === "open") {
          const requested = `${getGoal(assignmentIdForTurn)?.work_budget?.requested_effect ?? "read"}`;
          const effect = requested === "apply" || requested === "preview" ? requested : "read";
          const settled = settleAssignmentTurn(req.session_id, effect, teammateContext ? teammateLoopReceiptForLease(teammateContext) : undefined);
          if (!settled.completed && settled.projection?.terminal_state === "open") {
            requestAssignmentTerminal(assignmentIdForTurn, "blocked", "provider_timeout_after_in_flight_settlement");
          }
        }
      }
      throw error;
    }
    if (!usageHoldError) { turnCancelled = true; providerTurnDisposition = "interrupted"; }
  } finally {
    unsubscribeTurnNotifications();
    unsubscribeTurnNotifications = () => {};
    liveTurnNotificationHandler = null;
    if (providerReceiptRecorder) {
      try {
        providerReceiptRecorder.reconcile(modelTelemetry.receipts);
      } catch (error) {
        providerReceiptReconciliationError = error;
      }
    }
    reconcileStartedProviderTurn = null;
    providerTurnUsage = modelTelemetry.finish(req.message_id, providerTurnDisposition);
    teammateReceipt = teammateContext && !thinReference ? teammateLoopReceiptForLease(teammateContext) : undefined;
    await releaseStartedProviderTurn(false);
  }

  if (providerReceiptReconciliationError) {
    throw new Error(
      `Canonical provider receipt reconciliation failed: ${providerReceiptReconciliationError instanceof Error
        ? providerReceiptReconciliationError.message
        : String(providerReceiptReconciliationError)}`
    );
  }

  if (usageHoldError && assignmentKernelV2) {
    if (!c.isCurrentTurnFailure(usageHoldError)) throw new Error("Provider failure changed while task state was settling.");
    const snapshot = currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding);
    const message = finalCodexAssignmentMessageV2(snapshot, "Provider usage limit reached; task state is retained.");
    cb.onDone?.(message);
    return { version: OPERATOR_BACKEND_CONTRACT_VERSION, assistant_message: message, actions: [],
      model_call_receipts: modelTelemetry.receipts, provider_turn_usage: providerTurnUsage,
      ...(snapshot ? { assignment_snapshot_v2: snapshot } : {}) };
  }

  if (turnCancelled) {
    if (!assignmentKernelV2 && assignmentIdForTurn) {
      cancelAssignmentInFlight(assignmentIdForTurn);
      const drained = await awaitAssignmentQuiescence(assignmentIdForTurn);
      if (drained.terminal_state === "open") requestAssignmentTerminal(assignmentIdForTurn, "canceled", "user_canceled_after_in_flight_settlement");
    }
    const snapshot = assignmentKernelV2
      ? assignmentControllerStopReason || currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding)?.execution_control?.state === "paused"
        ? settleCodexAssignmentProgressV2(assignmentKernelV2.binding)
        : settleAssignmentKernelExecutionFailureV2({
            binding: assignmentKernelV2.binding,
            failure_id: `canceled:${req.message_id}`,
            error_class: "canceled",
            phase: "provider_turn"
          }).snapshot
      : null;
    const budgetMessage = assignmentControllerStopReason
      ? codexAssignmentControllerStopMessage(snapshot, assignmentControllerStopReason)
      : finalCodexAssignmentMessageV2(snapshot, "");
    cb.onDone?.(budgetMessage);
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: budgetMessage,
      actions: [],
      model_call_receipts: modelTelemetry.receipts,
      provider_turn_usage: providerTurnUsage,
      ...(snapshot ? { assignment_snapshot_v2: snapshot } : {}),
      ...(snapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(snapshot) } : {}),
      ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {})
    };
  }

  let {
    assistantText,
    assistantDeltas,
    hasFreshRevitEvidence,
    hasAuthoritativeWebEvidence
  } = turnNotificationObserver.snapshot();
  assistantText = assistantText || assistantDeltas;
  if (assignmentKernelV2 && assignmentProgressTurnStart) {
    checkpointCodexAssignmentProgressV2({
      binding: assignmentKernelV2.binding,
      turn_start: assignmentProgressTurnStart,
      receipts: modelTelemetry.receipts
    });
  }
  teammateReceipt = reconcileTeammateReceiptWithAssistant(teammateReceipt, assistantText);
  const missingRequiredInputs = teammateReceipt?.missing_required_inputs ?? [];
  if (missingRequiredInputs.length > 0
      && (teammateReceipt?.apply_attempts ?? 0) === 0) {
    const question = missingRequiredInputs.length === 1 && missingRequiredInputs[0] === "replacement_text"
      ? "What exact replacement wording should I use?"
      : `What exact value should I use for ${missingRequiredInputs.join(", ")}?`;
    assistantText = `I did not preview or apply an opaque value that was not bound to your authenticated request.\n\n${question}`;
  }
  if (teammateReceipt?.blocked_reason === "requested_preview_operation_not_completed") {
    assistantText = `${assistantText}\n\nI cannot claim the requested Revit preview is complete because the host received only discovery or configuration evidence, not a matching noncommitting create/duplicate-view operation.`.trim();
  }
  if (teammateReceipt && teammateReceipt.apply_attempts > 0 && !teammateReceipt.verified) {
    teammateReceipt = {
      ...teammateReceipt,
      stage: "blocked",
      blocked_reason: teammateReceipt.blocked_reason || "post_apply_verification_required"
    };
    assistantText = `${assistantText}\n\nI cannot claim the Revit change is complete because the host did not receive a successful post-apply readback or focused capture. The apply was not retried.`.trim();
  }
  if (freshEvidenceRequirement.required && !hasFreshRevitEvidence) {
    assistantText = FRESH_REVIT_EVIDENCE_FAILURE;
    try {
      appendEvent(req.session_id, "assistant", "codex.fresh_revit_evidence.missing", {
        thread_id: threadId,
        turn_id: turnId,
        requirement: freshEvidenceRequirement.kind
      });
    } catch {
      // ignore
    }
  } else if (freshEvidenceRequirement.required) {
    try {
      appendEvent(req.session_id, "assistant", "codex.fresh_revit_evidence.satisfied", {
        thread_id: threadId,
        turn_id: turnId,
        requirement: freshEvidenceRequirement.kind
      });
    } catch {
      // ignore
    }
  }
  const webSettlement = await enforceAuthoritativeWebEvidence({
    required: webEvidenceRequirement.required, alreadySatisfied: hasAuthoritativeWebEvidence,
    runtime: mcpRuntime ?? null, assistantText, sessionId: req.session_id, threadId, turnId,
    observe: observation => assignmentObserver.observe(observation)
  });
  assistantText = webSettlement.assistantText;
  hasAuthoritativeWebEvidence = webSettlement.satisfied;
  assignmentObserver.finish(turnId, assistantText, teammateReceipt);
  if (assignmentKernelV2) settleCodexAssignmentProgressV2(assignmentKernelV2.binding);
  const terminalSnapshot = assignmentKernelV2
    ? currentCodexAssignmentSnapshotV2(assignmentKernelV2.binding) ?? assignmentKernelV2.snapshot
    : null;
  assistantText = finalCodexAssignmentMessageV2(terminalSnapshot, assistantText);
  if ((assignmentKernelV2 || freshEvidenceRequirement.required || webEvidenceRequirement.required) && assistantText) cb.onDelta?.(assistantText);
  const canonicalAssignmentOutcome = req.assignment_id && req.assignment_run_id
    && Number.isSafeInteger(req.assignment_generation) && Number(req.assignment_generation) > 0
    ? canonicalAssignmentOutcomeForBinding({
        session_id: req.session_id,
        assignment_id: req.assignment_id,
        assignment_run_id: req.assignment_run_id,
        assignment_generation: Number(req.assignment_generation)
      })
    : null;
  cb.onDone?.(assistantText);
  try {
    appendEvent(req.session_id, "assistant", "codex.turn.completed", {
      thread_id: threadId,
      turn_id: turnId,
      assistant_chars: (assistantText || "").length,
      agent_model: agentSettings.model,
      agent_reasoning_effort: agentSettings.reasoning_effort,
      agent_turn_duration_ms: Date.now() - agentTurnStartedMs,
      upstream_response_count: modelTelemetry.receipts.length || null,
      observed_raw_response_count: modelTelemetry.receipts.length,
      model_usage_status: modelTelemetry.receipts.length > 0 ? "raw_receipts_observed" : "raw_receipts_missing",
      thread_usage_snapshot: modelTelemetry.usageSnapshot(),
      context_compaction_count: modelTelemetry.compactions.length
    });
  } catch {
    // ignore
  }

  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: assistantText || "",
    actions: [],
    model_call_receipts: modelTelemetry.receipts,
    provider_turn_usage: providerTurnUsage,
    ...(terminalSnapshot ? { assignment_snapshot_v2: terminalSnapshot } : {}),
    ...(terminalSnapshot?.terminal ? { terminal_result_v2: deriveTerminalResultV2(terminalSnapshot) } : {}),
    ...(canonicalAssignmentOutcome ? { canonical_assignment_outcome: canonicalAssignmentOutcome } : {}),
    ...(teammateReceipt ? { teammate_loop_receipt: teammateReceipt } : {}),
    ...(requirementsReceipt && (requirementsReceipt.status !== "resolved" || requirementsReceipt.applied.length > 0) ? { requirements_receipt: requirementsReceipt } : {})
  };
  } catch (error) {
    try {
      await releaseStartedProviderTurn(true);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Started provider turn cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      );
    }
    throw error;
  }
}
