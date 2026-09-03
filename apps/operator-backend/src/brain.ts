import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "./contracts.js";
import { decideRule } from "./brains/rule_brain.js";
import {
  isExplicitReadOnlyRedlineAnalysisRequest,
  prepareExistingConditionsProviderDecision,
  prepareExistingConditionsSourcePreflight
} from "./brains/openai_brain.js";
import { decideCodex, decideCodexStreaming, type StreamCallbacks } from "./brains/codex_brain.js";
import {
  decideAnthropic,
  decideAnthropicStreaming,
  decideGemini,
  decideGeminiStreaming
} from "./brains/external_provider_brain.js";
import { maybeBuildZippyBimToolDecision } from "./brains/zippybim_intent.js";
import { enforceVerificationDisclaimer } from "./verification/titleblock_verify_guard.js";
import { enforceModeledRedlineGuard } from "./verification/model_redline_guard.js";
import { applyEnvironmentPolicyToActions } from "./environment_profile.js";
import { buildTeammateTurnContract, guardGenericTeammateDecision } from "./teammate_loop_runtime.js";
import { maybeRunDeterministicEnlargedPlanSheet } from "./deterministic/enlarged_plan_sheet.js";
import { maybeRunDeterministicMepRouteRedline } from "./deterministic/mep_route_redline.js";
import { maybeRunDeterministicRoomReceptacleAnalog } from "./deterministic/room_receptacle_analog.js";
import { maybeRunSemanticAecWorkflow } from "./deterministic/aec_workflow_registry.js";
import { maybeRunMepServiceAccessoryPreflight } from "./deterministic/mep_service_accessory_runtime.js";
import type { AecTaskIntentInterpreter } from "./aec_task_intent_interpreter.js";
import { maybeRunDeterministicScheduleCellUpdate } from "./deterministic/schedule_cell_update_runtime.js";
import { maybeRunDeterministicScheduleValueReplacement } from "./deterministic/schedule_value_replacement_runtime.js";
import { maybeRunDeterministicScheduleRead } from "./deterministic/schedule_read_runtime.js";
import {
  maybeBuildExistingConditionsSourceDispositionInspection,
  withLatestExistingConditionsSourceDispositionContext
} from "./existing_conditions/source_disposition_replay_context.js";
import { getRecentMessages } from "./memory/sqlite_store.js";
import {
  enforceExistingConditionsOneActionLoop,
  maybeBuildExplicitExistingConditionsAction,
  maybeContinueExistingConditionsOneActionLoop
} from "./existing_conditions/one_action_execution_ledger.js";
import { ensureWorkspaceLayout } from "./workspace.js";
import { buildCertifiedReadDisposition, filterCertifiedSidecarActions, isCertifiedSidecarRequest } from "./capabilities/certified_sidecar_capability.js";
import { assignmentKernelV2ForBinding } from "./assignments/assignment_kernel_v2_factory.js";

const EXISTING_CONDITIONS_SESSION_LIMIT = 256;
const existingConditionsReconstructionSessions = new Map<string, true>();

function contextDeclaresExistingConditionsReconstruction(value: unknown, depth = 0): boolean {
  if (depth > 4 || value == null) return false;
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "existing_conditions_reconstruction";
  }
  if (Array.isArray(value)) {
    return value.some(item => contextDeclaresExistingConditionsReconstruction(item, depth + 1));
  }
  if (typeof value !== "object") return false;

  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    const normalizedKey = key.trim().toLowerCase();
    if ((normalizedKey === "workflow_intent" || normalizedKey === "workflowintent")
      && typeof item === "string"
      && item.trim().toLowerCase() === "existing_conditions_reconstruction") {
      return true;
    }
    return contextDeclaresExistingConditionsReconstruction(item, depth + 1);
  });
}

function textDeclaresExistingConditionsReconstruction(userText: string): boolean {
  const text = userText.trim().toLowerCase();
  if (!text) return false;
  return [
    /\bexisting[-\s]+conditions?\s+reconstruction\b/,
    /\/revit\/existing-conditions-mep-draft-workflow\b/,
    /\bexisting[-\s]+conditions?\b.{0,180}\b(?:staged[-\s]+repair\s+harness|provisional\s+backbone\s+batch|one[-\s]+action\s+(?:repair\s+)?ledger)\b/,
    /\b(?:reconstruct|recreate|restore|redraft|re-draft|redraw|re-draw|draft|draw|model)\b.{0,100}\bexisting[-\s]+conditions?\b/,
    /^(?=[\s\S]*\b(?:register|registration|align|alignment)\b)(?=[\s\S]*\bexisting[-\s]+conditions?\b)(?=[\s\S]*\b(?:attached|attachment|pdf|drawing|plan|sheet|source|scan|image)\b)/,
    /\bexisting[-\s]+conditions?\b.{0,100}\b(?:from|using|based\s+on)\b.{0,60}\b(?:pdf|drawing|sheet|scan|image)\b/,
    /\b(?:register_existing_conditions_(?:route_frontier|route_snap|mep_repair)|compile_existing_conditions_sheet_interpretation|compile_registered_mep_reconstruction)\b/,
    /\bunmarked\s+(?:source\s+)?(?:pdf|drawing|sheet)\b/,
    /\bnot\s+(?:a\s+)?redline\b/
  ].some(pattern => pattern.test(text));
}

function rememberExistingConditionsReconstructionSession(sessionId: string): void {
  if (!sessionId) return;
  existingConditionsReconstructionSessions.delete(sessionId);
  existingConditionsReconstructionSessions.set(sessionId, true);
  while (existingConditionsReconstructionSessions.size > EXISTING_CONDITIONS_SESSION_LIMIT) {
    const oldest = existingConditionsReconstructionSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    existingConditionsReconstructionSessions.delete(oldest);
  }
}

function persistedRequestLogDeclaresExistingConditionsReconstruction(sessionId: string): boolean {
  const safeSessionId = (sessionId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
  if (!safeSessionId) return false;
  const filePath = path.join(
    ensureWorkspaceLayout().runsSessions,
    safeSessionId,
    "request_log.jsonl"
  );
  if (!fs.existsSync(filePath)) return false;
  try {
    const size = fs.statSync(filePath).size;
    const maximumBytes = 512 * 1024;
    const start = Math.max(0, size - maximumBytes);
    const handle = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (start > 0) lines.shift();
      return lines.slice(-300).some(line => {
        if (!line.trim()) return false;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          return typeof row.user_text === "string"
            && textDeclaresExistingConditionsReconstruction(row.user_text);
        } catch {
          return false;
        }
      });
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

export function __testOnlyIsExistingConditionsReconstructionRequest(req: ChatRequest): boolean {
  const declared = textDeclaresExistingConditionsReconstruction(req.user_text ?? "")
    || contextDeclaresExistingConditionsReconstruction(req.context);
  if (declared) rememberExistingConditionsReconstructionSession(req.session_id);
  if (declared || existingConditionsReconstructionSessions.has(req.session_id)) {
    return true;
  }

  if (persistedRequestLogDeclaresExistingConditionsReconstruction(req.session_id)) {
    rememberExistingConditionsReconstructionSession(req.session_id);
    return true;
  }

  const declaredInPersistedHistory = getRecentMessages(req.session_id, 80).some(
    message =>
      message.role === "user" &&
      textDeclaresExistingConditionsReconstruction(message.text)
  );
  if (declaredInPersistedHistory) {
    rememberExistingConditionsReconstructionSession(req.session_id);
  }
  return declaredInPersistedHistory;
}

function maybeBuildZippyBimToolOpenedAck(req: ChatRequest): ChatResponse | null {
  const text = (req.user_text ?? "").trim();
  if (text.length > 0) return null;
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : [];
  const opened = toolResults.some(result => {
    if (!result || result.status !== "done" || result.method !== "POST" || result.path !== "/ui/open") return false;
    const payload = result.result_json as Record<string, unknown> | undefined;
    const url = typeof payload?.url === "string" ? payload.url : "";
    return url.includes("/ui/zippybim-import");
  });
  if (!opened) return null;

  return {
    version: "operator.backend.v1",
    assistant_message: "The Floor Plan Import pane is open in Revit. Use that pane to review the attached PDF and start the prediction job.",
    actions: []
  };
}

export function __testOnlyIsBridgeStatusQuestion(userText: string): boolean {
  const text = (userText ?? "").trim().toLowerCase();
  if (!text || /\b(open|launch|start)\s+revit\b/.test(text)) return false;

  if (/\bbridge\b/.test(text)) {
    return /\b(is|are|was|check|status|open|running|up|available|connected|reachable|ping|see|alive|online|healthy|responding|responsive)\b/.test(text);
  }

  return [
    /\b(?:is|are|was)\s+(?:the\s+)?revit(?:\s+(?:operator|backend|server|api))?\s+(?:open|running|up|available|connected|reachable|alive|online|healthy|responding|responsive)\b/,
    /\b(?:check|verify|confirm|test|ping)\b.{0,48}\brevit(?:\s+(?:operator|backend|server|api))?\b/,
    /\b(?:can\s+you\s+)?(?:see|reach|ping)\s+(?:the\s+)?revit(?:\s+(?:operator|backend|server|api))?\b/,
    /\brevit\s+(?:connection|connectivity|status|health)\b/
  ].some(pattern => pattern.test(text));
}

function maybeBuildBridgeStatusDecision(req: ChatRequest): ChatResponse | null {
  if (!__testOnlyIsBridgeStatusQuestion(req.user_text ?? "")) return null;
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: "Checking whether the Revit bridge is reachable...",
    actions: [
      {
        action_id: "bridge-status-ping",
        method: "GET",
        path: "/revit/ping"
      }
    ]
  };
}

function maybeBuildPersistedExistingConditionsTerminal(
  req: ChatRequest
): ChatResponse | null {
  if (!__testOnlyIsExistingConditionsReconstructionRequest(req)) return null;
  if (Array.isArray(req.user_attachments) && req.user_attachments.length > 0) {
    return null;
  }
  const retryText = req.user_text ?? "";
  const explicitlyRequestsRetry =
    /\b(?:retry|rerun|run\s+again|try\s+again|recapture|new\s+frame|fresh\s+frame)\b/i.test(
      retryText
    ) &&
    !/\b(?:do\s+not|don't|without)\s+(?:retry|rerun|running\s+again|trying\s+again|recapturing|a\s+new\s+frame|a\s+fresh\s+frame)\b/i.test(
      retryText
    );
  if (explicitlyRequestsRetry) {
    return null;
  }

  const terminal = getRecentMessages(req.session_id, 500)
    .slice()
    .reverse()
    .find(
      message =>
        message.role === "assistant" &&
        message.text.startsWith(
          "The exact-frame native landmark inventory completed, but the current structured alignment failed "
        ) &&
        message.text.includes(
          "I stopped before source-local compilation instead of restarting generic discovery."
        )
    );
  if (!terminal) return null;
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: terminal.text,
    actions: []
  };
}

export function __testOnlyMaybeBuildPersistedExistingConditionsTerminal(
  req: ChatRequest
): ChatResponse | null {
  return maybeBuildPersistedExistingConditionsTerminal(req);
}

function finalizeDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  const assistantMessage = (decision.assistant_message ?? "").toString();
  const environmentActions = applyEnvironmentPolicyToActions(Array.isArray(decision.actions) ? decision.actions : []);
  const certified = isCertifiedSidecarRequest(req) ? filterCertifiedSidecarActions(environmentActions) : null;
  const actions = certified?.actions ?? environmentActions;
  if (certified?.controlPlaneFailure) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Certified sidecar control-plane failure (${certified.controlPlaneFailure}); no action was dispatched.`,
      actions: [], ok: false, request_dispatched: false, outcome_unknown: false, reconciliation_required: false
    };
  }
  const certifiedMessage = assistantMessage;
  const certifiedDisposition = buildCertifiedReadDisposition(req, certified?.state, certifiedMessage);
  if (certifiedMessage.trim().length > 0 || actions.length > 0) {
    const guarded = enforceVerificationDisclaimer(
      req,
      enforceModeledRedlineGuard(req, {
        ...decision,
        assistant_message: certifiedMessage,
        actions,
        ...(certified?.denied ? {
          certified_capability_limitations: [{
            code: "CERTIFIED_ACTION_DENIED" as const,
            action_ids: environmentActions.filter(action => !actions.includes(action)).map(action => action.action_id),
            actions: environmentActions.filter(action => !actions.includes(action)),
            message: "Unavailable certified actions were not dispatched."
          }]
        } : {}),
        ...(certified?.state ? { certified_capability_state: certified.state } : {}),
        ...(certifiedDisposition ? { certified_read_disposition: certifiedDisposition } : {})
      })
    );
    return __testOnlyIsExistingConditionsReconstructionRequest(req)
      ? enforceExistingConditionsOneActionLoop({ req, decision: guarded })
      : guarded;
  }

  const hasAttachment = Array.isArray(req.user_attachments) && req.user_attachments.length > 0;
  const fallbackMessage = hasAttachment
    ? "Answer: I paused because the backend produced no actions and no explanation for this attachment turn. This is an internal fallback response rather than a silent no-op."
    : "Answer: I paused because the backend produced no actions and no explanation for this turn. This is an internal fallback response rather than a silent no-op.";

  const guarded = enforceVerificationDisclaimer(req, enforceModeledRedlineGuard(req, {
    ...decision,
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: fallbackMessage,
    actions
  }));
  return __testOnlyIsExistingConditionsReconstructionRequest(req)
    ? enforceExistingConditionsOneActionLoop({ req, decision: guarded })
    : guarded;
}

function finalizeGenericDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  return finalizeDecision(req, guardGenericTeammateDecision(req, decision));
}

function genericStreamGate(req: ChatRequest, cb: StreamCallbacks): { buffered: boolean; callbacks: StreamCallbacks } {
  const buffered = buildTeammateTurnContract(req).turn_kind === "mutation";
  return { buffered, callbacks: buffered ? { abortSignal: cb.abortSignal } : cb };
}

function emitBufferedGenericDecision(cb: StreamCallbacks, decision: ChatResponse): void {
  const text = decision.assistant_message || "";
  if (text) cb.onDelta?.(text);
  cb.onDone?.(text);
}

async function maybeRunTopLevelMepRouteRedline(req: ChatRequest, resolver = maybeRunDeterministicMepRouteRedline): Promise<ChatResponse | null> {
  return isExplicitReadOnlyRedlineAnalysisRequest(req) || __testOnlyIsExistingConditionsReconstructionRequest(req)
    ? null
    : resolver(req);
}

async function maybeRunTopLevelSemanticAecWorkflow(req: ChatRequest, resolver = maybeRunSemanticAecWorkflow): Promise<ChatResponse | null> {
  return isExplicitReadOnlyRedlineAnalysisRequest(req) || __testOnlyIsExistingConditionsReconstructionRequest(req)
    ? null
    : resolver(req);
}

export async function __testOnlyMaybeRunTopLevelMepRouteRedline(req: ChatRequest, resolver: typeof maybeRunDeterministicMepRouteRedline): Promise<ChatResponse | null> { return maybeRunTopLevelMepRouteRedline(req, resolver); }
export async function __testOnlyMaybeRunTopLevelSemanticAecWorkflow(req: ChatRequest, resolver: typeof maybeRunSemanticAecWorkflow): Promise<ChatResponse | null> { return maybeRunTopLevelSemanticAecWorkflow(req, resolver); }
export async function __testOnlyMaybeRunSemanticAecWorkflow(req: ChatRequest, interpreter: AecTaskIntentInterpreter): Promise<ChatResponse | null> { return maybeRunSemanticAecWorkflow(req, interpreter); }

export function __testOnlyFinalizeDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  return finalizeDecision(req, decision);
}

export type BrainDecisionDependencies = {
  mepRouteRedline?: typeof maybeRunDeterministicMepRouteRedline;
  scheduleCellUpdate?: typeof maybeRunDeterministicScheduleCellUpdate;
  scheduleValueReplacement?: typeof maybeRunDeterministicScheduleValueReplacement;
  scheduleRead?: typeof maybeRunDeterministicScheduleRead;
  semanticAecWorkflow?: typeof maybeRunSemanticAecWorkflow;
  mepServiceAccessoryPreflight?: typeof maybeRunMepServiceAccessoryPreflight;
  ruleBrain?: typeof decideRule;
  codexBrain?: typeof decideCodex;
  codexStreamingBrain?: typeof decideCodexStreaming;
  geminiBrain?: typeof decideGemini;
  geminiStreamingBrain?: typeof decideGeminiStreaming;
  anthropicBrain?: typeof decideAnthropic;
  anthropicStreamingBrain?: typeof decideAnthropicStreaming;
  existingConditionsProviderDecision?: typeof prepareExistingConditionsProviderDecision;
  existingConditionsSourcePreflight?: typeof prepareExistingConditionsSourcePreflight;
};

export type OperatorBrainRoute = "rule" | "codex" | "gemini" | "anthropic";

export function isDirectBrainRouteRequest(req: Pick<ChatRequest, "context">): boolean {
  const context = req.context;
  return Boolean(
    context &&
    typeof context === "object" &&
    !Array.isArray(context) &&
    (context as Record<string, unknown>).operator_brain_route === "direct"
  );
}

export function resolveOperatorBrainRoute(): OperatorBrainRoute {
  const forced = (process.env.OPERATOR_BRAIN || "").toLowerCase().trim();
  if (forced === "rule") return "rule";
  if (forced === "openai") {
    throw new Error("OPERATOR_BRAIN=openai is retired; use the canonical OPERATOR_BRAIN=codex agent runtime.");
  }
  if (forced === "codex") return "codex";
  if (forced === "gemini") return "gemini";
  if (forced === "anthropic" || forced === "claude") return "anthropic";
  // Codex app-server is the canonical durable agent runtime. The retired
  // OpenAI module is not an executable route; remaining imports from it are
  // deterministic workflow helpers awaiting mechanical extraction.
  return "codex";
}

function requestHasExactAssignmentKernelV2Binding(req: ChatRequest): boolean {
  if (!req.assignment_id || !req.assignment_run_id || !Number.isSafeInteger(req.assignment_generation)) return false;
  return Boolean(assignmentKernelV2ForBinding({
    session_id: req.session_id,
    assignment_id: req.assignment_id,
    run_id: req.assignment_run_id,
    generation: req.assignment_generation!
  }));
}

function requireCanonicalV2BrainRoute(): "codex" {
  const route = resolveOperatorBrainRoute();
  if (route !== "codex") throw new Error(`assignment_kernel_v2_brain_route_unsupported:${route}`);
  return route;
}

async function decideWithSelectedBrain(
  route: OperatorBrainRoute,
  req: ChatRequest,
  dependencies: BrainDecisionDependencies
): Promise<ChatResponse> {
  if (route === "rule") return (dependencies.ruleBrain ?? decideRule)(req);
  if (route === "codex") return (dependencies.codexBrain ?? decideCodex)(req);
  if (route === "gemini") return (dependencies.geminiBrain ?? decideGemini)(req);
  return (dependencies.anthropicBrain ?? decideAnthropic)(req);
}

async function decideWithSelectedBrainStreaming(
  route: OperatorBrainRoute,
  req: ChatRequest,
  cb: StreamCallbacks,
  dependencies: BrainDecisionDependencies
): Promise<ChatResponse> {
  if (route === "codex") {
    return (dependencies.codexStreamingBrain ?? decideCodexStreaming)(req, cb);
  }
  if (route === "gemini") {
    return (dependencies.geminiStreamingBrain ?? decideGeminiStreaming)(req, cb);
  }
  if (route === "anthropic") {
    return (dependencies.anthropicStreamingBrain ?? decideAnthropicStreaming)(req, cb);
  }
  return (dependencies.ruleBrain ?? decideRule)(req);
}

export async function decide(req: ChatRequest, dependencies: BrainDecisionDependencies = {}): Promise<ChatResponse> {
  req = withLatestExistingConditionsSourceDispositionContext(req);
  if (requestHasExactAssignmentKernelV2Binding(req)) {
    requireCanonicalV2BrainRoute();
    const decision = await (dependencies.codexBrain ?? decideCodex)(req);
    return isCertifiedSidecarRequest(req)
      ? finalizeDecision(req, decision)
      : finalizeGenericDecision(req, decision);
  }
  const sourceDispositionInspection = maybeBuildExistingConditionsSourceDispositionInspection(req);
  if (sourceDispositionInspection) return finalizeDecision(req, sourceDispositionInspection);
  const explicitAction = maybeBuildExplicitExistingConditionsAction(req);
  if (explicitAction) return finalizeDecision(req, explicitAction);
  if (__testOnlyIsExistingConditionsReconstructionRequest(req)) {
    const continuation = maybeContinueExistingConditionsOneActionLoop(req);
    if (continuation) return finalizeDecision(req, continuation);
  }

  if (isDirectBrainRouteRequest(req)) {
    const serviceAccessoryDecision = isCertifiedSidecarRequest(req)
      ? null
      : (dependencies.mepServiceAccessoryPreflight ?? maybeRunMepServiceAccessoryPreflight)(req);
    if (serviceAccessoryDecision) return finalizeDecision(req, serviceAccessoryDecision);
    const route = resolveOperatorBrainRoute();
    if (__testOnlyIsExistingConditionsReconstructionRequest(req)) {
      const routedReq = await (
        dependencies.existingConditionsSourcePreflight ??
        prepareExistingConditionsSourcePreflight
      )(req);
      const providerDecision = await (
        dependencies.existingConditionsProviderDecision ??
        prepareExistingConditionsProviderDecision
      )(routedReq);
      if (providerDecision) return finalizeDecision(routedReq, providerDecision);
      return finalizeDecision(
        routedReq,
        await decideWithSelectedBrain(route, routedReq, dependencies)
      );
    }
    const decision = await decideWithSelectedBrain(route, req, dependencies);
    return isCertifiedSidecarRequest(req)
      ? finalizeDecision(req, decision)
      : finalizeGenericDecision(req, decision);
  }

  const roomReceptacleDecision = maybeRunDeterministicRoomReceptacleAnalog(req);
  if (roomReceptacleDecision) {
    return finalizeDecision(req, roomReceptacleDecision);
  }

  const bridgeStatusDecision = maybeBuildBridgeStatusDecision(req);
  if (bridgeStatusDecision) {
    return finalizeDecision(req, bridgeStatusDecision);
  }

  const zippyBimDecision = maybeBuildZippyBimToolDecision(req);
  if (zippyBimDecision) {
    return finalizeDecision(req, zippyBimDecision);
  }
  const zippyBimAck = maybeBuildZippyBimToolOpenedAck(req);
  if (zippyBimAck) {
    return finalizeDecision(req, zippyBimAck);
  }

  const enlargedPlanDecision = await maybeRunDeterministicEnlargedPlanSheet(req);
  if (enlargedPlanDecision) {
    return finalizeDecision(req, enlargedPlanDecision);
  }

  const scheduleValueReplacementDecision = await (dependencies.scheduleValueReplacement ?? maybeRunDeterministicScheduleValueReplacement)(req);
  if (scheduleValueReplacementDecision) {
    return finalizeDecision(req, scheduleValueReplacementDecision);
  }

  const scheduleReadDecision = (dependencies.scheduleRead ?? maybeRunDeterministicScheduleRead)(req);
  if (scheduleReadDecision) {
    return finalizeDecision(req, scheduleReadDecision);
  }

  const mepRouteRedlineDecision = await maybeRunTopLevelMepRouteRedline(req, dependencies.mepRouteRedline);
  if (mepRouteRedlineDecision) {
    return finalizeDecision(req, mepRouteRedlineDecision);
  }

  const scheduleCellUpdateDecision = await (dependencies.scheduleCellUpdate ?? maybeRunDeterministicScheduleCellUpdate)(req);
  if (scheduleCellUpdateDecision) {
    return finalizeDecision(req, scheduleCellUpdateDecision);
  }

  const semanticAecDecision = await maybeRunTopLevelSemanticAecWorkflow(req, dependencies.semanticAecWorkflow);
  if (semanticAecDecision) {
    return finalizeDecision(req, semanticAecDecision);
  }

  const persistedExistingConditionsTerminal =
    maybeBuildPersistedExistingConditionsTerminal(req);
  if (persistedExistingConditionsTerminal) {
    return finalizeDecision(req, persistedExistingConditionsTerminal);
  }

  const route = resolveOperatorBrainRoute();
  const routedReq = route !== "rule"
    ? await (dependencies.existingConditionsSourcePreflight ?? prepareExistingConditionsSourcePreflight)(req)
    : req;
  if (route !== "rule") {
    const providerDecision = await (
      dependencies.existingConditionsProviderDecision ??
      prepareExistingConditionsProviderDecision
    )(routedReq);
    if (providerDecision) return finalizeDecision(routedReq, providerDecision);
  }
  return finalizeGenericDecision(routedReq, await decideWithSelectedBrain(route, routedReq, dependencies));
}

export async function decideStreaming(req: ChatRequest, cb: StreamCallbacks, dependencies: BrainDecisionDependencies = {}): Promise<ChatResponse> {
  req = withLatestExistingConditionsSourceDispositionContext(req);
  if (requestHasExactAssignmentKernelV2Binding(req)) {
    requireCanonicalV2BrainRoute();
    if (isCertifiedSidecarRequest(req)) {
      return finalizeDecision(
        req,
        await (dependencies.codexStreamingBrain ?? decideCodexStreaming)(req, cb)
      );
    }
    const streamGate = genericStreamGate(req, cb);
    const decision = finalizeGenericDecision(
      req,
      await (dependencies.codexStreamingBrain ?? decideCodexStreaming)(req, streamGate.callbacks)
    );
    if (streamGate.buffered) emitBufferedGenericDecision(cb, decision);
    return decision;
  }
  const sourceDispositionInspection = maybeBuildExistingConditionsSourceDispositionInspection(req);
  if (sourceDispositionInspection) {
    const decision = finalizeDecision(req, sourceDispositionInspection);
    const text = decision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return decision;
  }
  const explicitAction = maybeBuildExplicitExistingConditionsAction(req);
  if (explicitAction) {
    const decision = finalizeDecision(req, explicitAction);
    const text = decision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return decision;
  }
  if (__testOnlyIsExistingConditionsReconstructionRequest(req)) {
    const continuation = maybeContinueExistingConditionsOneActionLoop(req);
    if (continuation) {
      const decision = finalizeDecision(req, continuation);
      const text = decision.assistant_message || "";
      cb.onDelta?.(text);
      cb.onDone?.(text);
      return decision;
    }
  }

  if (isDirectBrainRouteRequest(req)) {
    const serviceAccessoryDecision = isCertifiedSidecarRequest(req)
      ? null
      : (dependencies.mepServiceAccessoryPreflight ?? maybeRunMepServiceAccessoryPreflight)(req);
    if (serviceAccessoryDecision) {
      const text = serviceAccessoryDecision.assistant_message || "";
      cb.onDelta?.(text);
      cb.onDone?.(text);
      return finalizeDecision(req, serviceAccessoryDecision);
    }
    const route = resolveOperatorBrainRoute();
    if (__testOnlyIsExistingConditionsReconstructionRequest(req)) {
      const routedReq = await (
        dependencies.existingConditionsSourcePreflight ??
        prepareExistingConditionsSourcePreflight
      )(req);
      const providerDecision = await (
        dependencies.existingConditionsProviderDecision ??
        prepareExistingConditionsProviderDecision
      )(routedReq);
      if (providerDecision) {
        const text = providerDecision.assistant_message || "";
        cb.onDelta?.(text);
        cb.onDone?.(text);
        return finalizeDecision(routedReq, providerDecision);
      }
      return finalizeDecision(
        routedReq,
        await decideWithSelectedBrainStreaming(route, routedReq, cb, dependencies)
      );
    }
    if (isCertifiedSidecarRequest(req)) {
      const decision = finalizeDecision(
        req,
        await decideWithSelectedBrainStreaming(route, req, { abortSignal: cb.abortSignal }, dependencies)
      );
      const text = decision.assistant_message || "";
      cb.onDelta?.(text);
      cb.onDone?.(text);
      return decision;
    }
    const streamGate = genericStreamGate(req, cb);
    const decision = finalizeGenericDecision(
      req,
      await decideWithSelectedBrainStreaming(route, req, streamGate.callbacks, dependencies)
    );
    if (streamGate.buffered) emitBufferedGenericDecision(cb, decision);
    else if (route === "rule") {
      const text = decision.assistant_message || "";
      cb.onDelta?.(text);
      cb.onDone?.(text);
    }
    return decision;
  }

  const roomReceptacleDecision = maybeRunDeterministicRoomReceptacleAnalog(req);
  if (roomReceptacleDecision) {
    const text = roomReceptacleDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, roomReceptacleDecision);
  }

  const bridgeStatusDecision = maybeBuildBridgeStatusDecision(req);
  if (bridgeStatusDecision) {
    const text = bridgeStatusDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, bridgeStatusDecision);
  }

  const zippyBimDecision = maybeBuildZippyBimToolDecision(req);
  if (zippyBimDecision) {
    const text = zippyBimDecision.assistant_message || "";
    const chunkSize = 60;
    const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
    for (let i = 0; i < text.length; i += chunkSize) {
      cb.onDelta?.(text.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    cb.onDone?.(text);
    return finalizeDecision(req, zippyBimDecision);
  }
  const zippyBimAck = maybeBuildZippyBimToolOpenedAck(req);
  if (zippyBimAck) {
    const text = zippyBimAck.assistant_message || "";
    const chunkSize = 60;
    const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
    for (let i = 0; i < text.length; i += chunkSize) {
      cb.onDelta?.(text.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    cb.onDone?.(text);
    return finalizeDecision(req, zippyBimAck);
  }

  const enlargedPlanDecision = await maybeRunDeterministicEnlargedPlanSheet(req);
  if (enlargedPlanDecision) {
    const text = enlargedPlanDecision.assistant_message || "";
    const chunkSize = 60;
    const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
    for (let i = 0; i < text.length; i += chunkSize) {
      cb.onDelta?.(text.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    cb.onDone?.(text);
    return finalizeDecision(req, enlargedPlanDecision);
  }

  const scheduleValueReplacementDecision = await (dependencies.scheduleValueReplacement ?? maybeRunDeterministicScheduleValueReplacement)(req);
  if (scheduleValueReplacementDecision) {
    const text = scheduleValueReplacementDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, scheduleValueReplacementDecision);
  }


  const scheduleReadDecision = (dependencies.scheduleRead ?? maybeRunDeterministicScheduleRead)(req);
  if (scheduleReadDecision) {
    const text = scheduleReadDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, scheduleReadDecision);
  }

  const mepRouteRedlineDecision = await maybeRunTopLevelMepRouteRedline(req, dependencies.mepRouteRedline);
  if (mepRouteRedlineDecision) {
    const text = mepRouteRedlineDecision.assistant_message || "";
    const chunkSize = 60;
    const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
    for (let i = 0; i < text.length; i += chunkSize) {
      cb.onDelta?.(text.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    cb.onDone?.(text);
    return finalizeDecision(req, mepRouteRedlineDecision);
  }

  const scheduleCellUpdateDecision = await (dependencies.scheduleCellUpdate ?? maybeRunDeterministicScheduleCellUpdate)(req);
  if (scheduleCellUpdateDecision) {
    const text = scheduleCellUpdateDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, scheduleCellUpdateDecision);
  }

  const semanticAecDecision = await maybeRunTopLevelSemanticAecWorkflow(req, dependencies.semanticAecWorkflow);
  if (semanticAecDecision) {
    const text = semanticAecDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, semanticAecDecision);
  }

  const persistedExistingConditionsTerminal =
    maybeBuildPersistedExistingConditionsTerminal(req);
  if (persistedExistingConditionsTerminal) {
    const text = persistedExistingConditionsTerminal.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, persistedExistingConditionsTerminal);
  }

  const route = resolveOperatorBrainRoute();
  const routedReq = route !== "rule"
    ? await (dependencies.existingConditionsSourcePreflight ?? prepareExistingConditionsSourcePreflight)(req)
    : req;
  if (route !== "rule") {
    const providerDecision = await (
      dependencies.existingConditionsProviderDecision ??
      prepareExistingConditionsProviderDecision
    )(routedReq);
    if (providerDecision) {
      const text = providerDecision.assistant_message || "";
      cb.onDelta?.(text);
      cb.onDone?.(text);
      return finalizeDecision(routedReq, providerDecision);
    }
  }
  const streamGate = genericStreamGate(routedReq, cb);
  const decision = finalizeGenericDecision(
    routedReq,
    await decideWithSelectedBrainStreaming(route, routedReq, streamGate.callbacks, dependencies)
  );
  if (streamGate.buffered) emitBufferedGenericDecision(cb, decision);
  else if (route === "rule") {
    const text = decision.assistant_message || "";
    const chunkSize = 60;
    const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
    for (let i = 0; i < text.length; i += chunkSize) {
      cb.onDelta?.(text.slice(i, i + chunkSize));
      if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
    cb.onDone?.(text);
  }
  return decision;
}
