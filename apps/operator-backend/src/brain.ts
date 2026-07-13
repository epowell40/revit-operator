import "./env.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "./contracts.js";
import { decideRule } from "./brains/rule_brain.js";
import { decideOpenAi, decideOpenAiStreaming, isExplicitReadOnlyRedlineAnalysisRequest } from "./brains/openai_brain.js";
import { decideCodex, decideCodexStreaming, type StreamCallbacks } from "./brains/codex_brain.js";
import { maybeBuildZippyBimToolDecision } from "./brains/zippybim_intent.js";
import { enforceVerificationDisclaimer } from "./verification/titleblock_verify_guard.js";
import { enforceModeledRedlineGuard } from "./verification/model_redline_guard.js";
import { resolveOpenAiApiKey } from "./openai_client.js";
import { applyEnvironmentPolicyToActions } from "./environment_profile.js";
import { maybeRunDeterministicEnlargedPlanSheet } from "./deterministic/enlarged_plan_sheet.js";
import { maybeRunDeterministicMepRouteRedline } from "./deterministic/mep_route_redline.js";
import { maybeRunDeterministicRoomReceptacleAnalog } from "./deterministic/room_receptacle_analog.js";
import { maybeRunSemanticAecWorkflow } from "./deterministic/aec_workflow_registry.js";
import type { AecTaskIntentInterpreter } from "./aec_task_intent_interpreter.js";

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
    /\b(?:reconstruct|restore|redraft|re-draft|model)\b.{0,60}\bexisting[-\s]+conditions?\b/,
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

export function __testOnlyIsExistingConditionsReconstructionRequest(req: ChatRequest): boolean {
  const declared = textDeclaresExistingConditionsReconstruction(req.user_text ?? "")
    || contextDeclaresExistingConditionsReconstruction(req.context);
  if (declared) rememberExistingConditionsReconstructionSession(req.session_id);
  return declared || existingConditionsReconstructionSessions.has(req.session_id);
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

function finalizeDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  const assistantMessage = (decision.assistant_message ?? "").toString();
  const actions = applyEnvironmentPolicyToActions(Array.isArray(decision.actions) ? decision.actions : []);
  if (assistantMessage.trim().length > 0 || actions.length > 0) {
    return enforceVerificationDisclaimer(req, enforceModeledRedlineGuard(req, { ...decision, actions }));
  }

  const hasAttachment = Array.isArray(req.user_attachments) && req.user_attachments.length > 0;
  const fallbackMessage = hasAttachment
    ? "Answer: I paused because the backend produced no actions and no explanation for this attachment turn. This is an internal fallback response rather than a silent no-op."
    : "Answer: I paused because the backend produced no actions and no explanation for this turn. This is an internal fallback response rather than a silent no-op.";

  return enforceVerificationDisclaimer(req, enforceModeledRedlineGuard(req, {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: fallbackMessage,
    actions
  }));
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
  semanticAecWorkflow?: typeof maybeRunSemanticAecWorkflow;
  openAiBrain?: typeof decideOpenAi;
  openAiStreamingBrain?: typeof decideOpenAiStreaming;
};

export async function decide(req: ChatRequest, dependencies: BrainDecisionDependencies = {}): Promise<ChatResponse> {
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

  const mepRouteRedlineDecision = await maybeRunTopLevelMepRouteRedline(req, dependencies.mepRouteRedline);
  if (mepRouteRedlineDecision) {
    return finalizeDecision(req, mepRouteRedlineDecision);
  }

  const semanticAecDecision = await maybeRunTopLevelSemanticAecWorkflow(req, dependencies.semanticAecWorkflow);
  if (semanticAecDecision) {
    return finalizeDecision(req, semanticAecDecision);
  }

  const forced = (process.env.OPERATOR_BRAIN || "").toLowerCase().trim();
  const hasOpenAiKey = !!resolveOpenAiApiKey();

  let decision: ChatResponse;
  if (forced === "rule") decision = await decideRule(req);
  else if (forced === "openai") decision = await (dependencies.openAiBrain ?? decideOpenAi)(req);
  else if (forced === "codex") decision = await decideCodex(req);
  else if (hasOpenAiKey) decision = await decideOpenAi(req);
  else decision = await decideRule(req);

  return finalizeDecision(req, decision);
}

export async function decideStreaming(req: ChatRequest, cb: StreamCallbacks, dependencies: BrainDecisionDependencies = {}): Promise<ChatResponse> {
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

  const semanticAecDecision = await maybeRunTopLevelSemanticAecWorkflow(req, dependencies.semanticAecWorkflow);
  if (semanticAecDecision) {
    const text = semanticAecDecision.assistant_message || "";
    cb.onDelta?.(text);
    cb.onDone?.(text);
    return finalizeDecision(req, semanticAecDecision);
  }

  const forced = (process.env.OPERATOR_BRAIN || "").toLowerCase().trim();
  const hasOpenAiKey = !!resolveOpenAiApiKey();
  if (forced === "codex") return decideCodexStreaming(req, cb);
  if (forced === "openai" || (forced !== "rule" && hasOpenAiKey)) {
    return finalizeDecision(req, await (dependencies.openAiStreamingBrain ?? decideOpenAiStreaming)(req, cb));
  }

  const decision = await decide(req, dependencies);

  const text = decision.assistant_message || "";
  const chunkSize = 60;
  const delayMs = Math.max(0, Number.parseInt(process.env.OPERATOR_STREAM_DELAY_MS ?? "0", 10) || 0);
  for (let i = 0; i < text.length; i += chunkSize) {
    cb.onDelta?.(text.slice(i, i + chunkSize));
    if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs));
  }
  cb.onDone?.(text);
  return decision;
}
