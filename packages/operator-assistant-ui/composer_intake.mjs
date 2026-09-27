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
export function selectChatSubmissionMode(state) {
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
    return "backend";
  }
  return state.computerUseAvailable ? (state.streaming ? "computer-interject" : "computer-run") : "backend";
}
