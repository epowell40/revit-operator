/** A backend-owned intake decision; model action checks remain independent. */
export async function resolveInitialChatContext(body, { readPolicy, readModelContext, signal }) {
  signal?.throwIfAborted();
  let policy;
  try {
    policy = await readPolicy(body, signal);
  } catch (error) {
    signal?.throwIfAborted();
    if ([401, 403].includes(Number(error?.status))) throw error;
    // Older servers and unknown responses retain the existing model path.
  }
  signal?.throwIfAborted();
  if (policy?.schema === "revit-operator.chat-context-policy.v1"
      && policy.session_id === body?.session_id && policy.message_id === body?.message_id
      && policy.requires_revit_context === false
      && typeof body?.user_text === "string" && body.user_text.trim()
      && !body.assignment_id && !body.assignment_run_id && body.assignment_generation === undefined
      && !(body.tool_results?.length > 0)) {
    // No cached identity, selection, or write grant is represented as live proof.
    return { ui: { client: "operator-desktop", surface: "external-sidecar",
      authoritative_user_text: body.user_text, model_context_requested: false } };
  }
  return readModelContext();
}
