/** Capture the exact click before recovery/freshness I/O can yield to another edit. */
export function beginComposerSend(state, prompt) {
  if (state.resetting || state.composerSubmissionPending || (state.streaming && state.activeRunKind === "backend")) return null;
  const text = String(prompt || "");
  const attachments = (state.pendingAttachments || []).map(attachment => ({ ...attachment }));
  if (!text.trim() && attachments.length === 0) return null;
  state.composerSubmissionPending = true;
  return { prompt: text, attachments };
}
