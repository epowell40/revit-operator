/** Respect an explicit tool restriction without requiring users to name UI capabilities for ordinary work. */
export function excludesComputerUse(userText) {
  const text = String(userText || "");
  return /\b(?:native\s+)?api\s+only\b|\bonly\s+use\s+(?:the\s+)?(?:native\s+)?api\b/i.test(text)
    || /\b(?:without|avoid|never|do\s+not|don't)\s+(?:using\s+|use\s+|opening\s+|open\s+)?(?:the\s+)?(?:desktop(?:\s+(?:input|control))?|computer[\s-]?use|(?:revit\s+)?ui|user\s+interface)\b/i.test(text);
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

/** Match the backend's semantic intake ceiling without dropping any instructions. */
export function exactComputerTaskSource(prompt) {
  const source = String(prompt || "").trim();
  if (source.length > 16_000) {
    throw new Error("This task brief exceeds 16,000 characters. Attach the full brief and summarize the requested work in the message.");
  }
  return source;
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
    // The working owner can use native tools and see/operate Revit as needed.
    // Availability selects capability, never a write grant or a new provider.
    if (startsFreshComputerConversation(state) && state.computerUseAvailable === true
      && !excludesComputerUse(prompt)) {
      exactComputerTaskSource(prompt);
      return "computer-run";
    }
    return "backend";
  }
  if (!state.computerUseAvailable || excludesComputerUse(prompt)) return "backend";
  if (state.streaming) return "computer-interject";
  exactComputerTaskSource(prompt);
  return "computer-run";
}

/** Freeze New Chat intent at submission; later polling must not select an old session. */
export function startsFreshComputerConversation(state) {
  return !state.sessionId && !state.taskNavigationAssignmentId && !state.streaming;
}

/** Presentation/transport only, after the host has confirmed the saved owner.
 * Resume never creates a fresh conversation or reuses an optimistic message
 * already sent through a different transport. Admission remains server-owned. */
export function routeSavedChatSubmission(submission, executor) {
  if (!submission || submission.transportStarted || submission.optimisticMessage
      || !["computer", "backend"].includes(executor)) {
    throw new Error("The saved submission cannot change transport after it has started.");
  }
  return { ...submission, mode: executor === "computer" ? "computer-run" : "backend",
    newComputerConversation: false };
}
