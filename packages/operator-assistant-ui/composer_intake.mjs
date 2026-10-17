import { needsPrinterCapableLane } from "./print_execution_policy.mjs";

/** Capability selection, never authorization: UI work needs an owner that can see and operate the application. */
export function needsDesktopUiLane(userText) {
  const text = String(userText || "");
  if (/\b(?:native\s+)?api\s+only\b|\bonly\s+use\s+(?:the\s+)?(?:native\s+)?api\b/i.test(text)) return false;
  if (/\b(?:without|avoid|never|do\s+not|don't)\s+(?:using\s+|use\s+)?(?:the\s+)?(?:desktop\s+(?:input|control)|computer[\s-]?use|(?:revit\s+)?ui|user\s+interface)\b/i.test(text)) return false;
  return /\b(?:dialog|ribbon|toolbar|menu|user[\s-]+interface)\b/i.test(text)
    || /\b(?:use|using|via|through)\s+(?:(?:the|revit(?:'s)?)\s+)*(?:ui|desktop)\b/i.test(text);
}

/** Capture the exact click before recovery/freshness I/O can yield to another edit. */
export function beginComposerSend(state, prompt) {
  if (state.resetting || state.composerSubmissionPending || (state.streaming && state.activeRunKind === "backend")) return null;
  const text = String(prompt || "");
  const attachments = (state.pendingAttachments || []).map(attachment => ({ ...attachment }));
  if (!text.trim() && attachments.length === 0) return null;
  state.composerSubmissionPending = true;
  return { prompt: text, attachments };
}

/** Transport selection only: the backend still owns admission and authority. */
export function selectChatSubmissionMode(state, prompt = "") {
  // A configuration refresh must not move an interjection to another owner.
  if (state.streaming && state.activeRunKind === "computer") return "computer-interject";
  const local = state.localExecutor;
  const backendSelected = state.backendLocal === true && state.backendAuthMode === "shared_token"
    && local?.schema === "revit-operator.local-executor-capability/v1"
    && local.source === "backend_configuration" && local.profile === "codex_v2_advisory_v1"
    && local.executor === "codex" && local.assignment_kernel === 2 && local.execution_policy === "local_advisory_v1";
  if (backendSelected) {
    if (state.backendAvailable !== true || state.backendConfigStatus !== "ready") {
      throw new Error("Reconnect to Operator before sending; its execution configuration is unavailable.");
    }
    // Existing conversations retain their assignment owner and settlement fences.
    if (!state.sessionId && !state.taskNavigationAssignmentId && !state.streaming
      && state.computerUseAvailable === true && (needsPrinterCapableLane(prompt) || needsDesktopUiLane(prompt))) return "computer-run";
    return "backend";
  }
  return state.computerUseAvailable ? (state.streaming ? "computer-interject" : "computer-run") : "backend";
}

/** Freeze New Chat intent at submission; later polling must not select an old session. */
export function startsFreshComputerConversation(state) {
  return !state.sessionId && !state.taskNavigationAssignmentId && !state.streaming;
}
