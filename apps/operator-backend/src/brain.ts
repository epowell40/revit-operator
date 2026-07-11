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

function maybeBuildBridgeStatusDecision(req: ChatRequest): ChatResponse | null {
  const text = (req.user_text ?? "").trim().toLowerCase();
  if (!text) return null;
  const mentionsBridge = /\bbridge\b/.test(text);
  const mentionsRevitConnectivity = /\brevit\b/.test(text) && /\b(connected|reachable|ping|bridge|operator|backend|server|api)\b/.test(text);
  if (!mentionsBridge && !mentionsRevitConnectivity) return null;
  const asksStatus = /\b(is|are|was|check|status|open|running|up|available|connected|reachable|ping|see|alive|online|healthy|responding|responsive)\b/.test(text);
  if (!asksStatus) return null;
  if (/\b(open|launch|start)\s+revit\b/.test(text)) return null;
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
  return isExplicitReadOnlyRedlineAnalysisRequest(req) ? null : resolver(req);
}

export async function __testOnlyMaybeRunTopLevelMepRouteRedline(req: ChatRequest, resolver: typeof maybeRunDeterministicMepRouteRedline): Promise<ChatResponse | null> { return maybeRunTopLevelMepRouteRedline(req, resolver); }

export function __testOnlyFinalizeDecision(req: ChatRequest, decision: ChatResponse): ChatResponse {
  return finalizeDecision(req, decision);
}

export async function decide(req: ChatRequest): Promise<ChatResponse> {
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

  const mepRouteRedlineDecision = await maybeRunTopLevelMepRouteRedline(req);
  if (mepRouteRedlineDecision) {
    return finalizeDecision(req, mepRouteRedlineDecision);
  }

  const forced = (process.env.OPERATOR_BRAIN || "").toLowerCase().trim();
  const hasOpenAiKey = !!resolveOpenAiApiKey();

  let decision: ChatResponse;
  if (forced === "rule") decision = await decideRule(req);
  else if (forced === "openai") decision = await decideOpenAi(req);
  else if (forced === "codex") decision = await decideCodex(req);
  else if (hasOpenAiKey) decision = await decideOpenAi(req);
  else decision = await decideRule(req);

  return finalizeDecision(req, decision);
}

export async function decideStreaming(req: ChatRequest, cb: StreamCallbacks): Promise<ChatResponse> {
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

  const mepRouteRedlineDecision = await maybeRunTopLevelMepRouteRedline(req);
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

  const forced = (process.env.OPERATOR_BRAIN || "").toLowerCase().trim();
  const hasOpenAiKey = !!resolveOpenAiApiKey();
  if (forced === "codex") return decideCodexStreaming(req, cb);
  if (forced === "openai" || (forced !== "rule" && hasOpenAiKey)) {
    return finalizeDecision(req, await decideOpenAiStreaming(req, cb));
  }

  const decision = await decide(req);

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
