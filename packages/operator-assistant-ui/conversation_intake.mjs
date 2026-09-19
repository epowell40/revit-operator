/** Fast conversational intake uses a model, not a text/keyword classifier.
 * Explicit task continuations and attachments keep their full agent lifecycle. */
export async function tryConversationIntake(body, { authorize, readContext, route, onHandoff, signal, observationTimeoutMs = 1000, progressDelayMs = 1500 }) {
  if (typeof body?.user_text !== "string" || !body.user_text.trim() || body.user_text.length > 16000
    || body.assignment_id || body.assignment_run_id || body.assignment_generation != null
    || [body.attachments, body.user_attachments, body.pending_attachments, body.tool_results].some(items => Array.isArray(items) && items.length)) return null;
  signal?.throwIfAborted();
  await authorize(body.session_id, signal);
  signal?.throwIfAborted();
  const unavailable=error=>Object.assign(new Error("I couldn’t finish understanding this request. Please try again; no model work has started."),{status:503,code:"conversation_classification_unavailable",cause:error});
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  let observation;
  const progressTimer=setTimeout(()=>onHandoff?.("Let me check."),progressDelayMs);
  try {
    observation = await Promise.race([
      readContext(controller.signal).catch(() => ({ ok: false })),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ ok: false }); }, observationTimeoutMs); })
    ]);
    clearTimeout(timer);signal?.removeEventListener("abort",abort);
    signal?.throwIfAborted();
    // Preserve the full original request. Never send a router summary as the
    // user's instruction, and never use caller-supplied model metadata.
    const response = await route({ ...body, context: undefined, ui_observation: observation }, signal);
    signal?.throwIfAborted();
    if(response?.routing_status!=="accepted" || !["answer","inspect","task"].includes(response?.route)) throw unavailable();
    if (response.route !== "answer") {
      onHandoff?.(response?.route === "inspect" ? "Let me check." : "I’ll work through that.");
      return null;
    }
    if(response.history_saved!==true || typeof response.assistant_message!=="string" || !response.assistant_message.trim() || response.assistant_message.length>3000)
      throw unavailable();
    return { text: response.assistant_message, historySaved: true };
  } catch (error) {
    if (signal?.aborted || [401, 403].includes(Number(error?.status))) throw error;
    throw unavailable(error);
  } finally {clearTimeout(progressTimer);clearTimeout(timer);signal?.removeEventListener("abort",abort);}
}
