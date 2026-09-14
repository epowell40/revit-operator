// Deliberately small: only questions answerable by native UI identity.
// A mixed request, attachment, or explicit task continuation belongs to the agent.
export function contextQuestionKind(body = {}) {
  if ([body.attachments, body.user_attachments, body.pending_attachments, body.tool_results].some(items => Array.isArray(items) && items.length)
      || body.assignment_id || body.assignment_run_id || body.assignment_generation) return null;
  const text = String(body.user_text || "").toLowerCase().replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim()
    .replace(/^please /, "");
  const model = "(?:(?:the|my|our|this) )?(?:(?:currently )?(?:open|active|current) )?(?:revit )?(?:model|project|document)";
  if (new RegExp(`^(?:can|could|do) you (?:see|access|read) ${model}(?: (?:in revit|i have open|that's open|that is open))?$`).test(text)
      || /^(?:are you (?:still )?connected to|can you connect to|can you see) revit$/.test(text)
      || /^is revit (?:connected|running|open|available|ready)$/.test(text)
      || /^are (?:you|we) (?:still )?connected(?: to revit)?$/.test(text)
      || /^do you (?:still )?have (?:a )?(?:live )?(?:connection|access) to revit$/.test(text)) return "connection";
  if (new RegExp(`^(?:what|which) ${model} (?:is (?:currently )?open|do (?:i|we) have open|am i (?:in|working in))(?: in revit)?$`).test(text)
      || /^(?:what(?:'s| is)|tell me) the (?:name of the )?(?:open|current|active) (?:revit )?(?:model|project|document)(?: name)?$/.test(text)) return "model";
  if (/^(?:(?:what|which) (?:revit )?view (?:is (?:open|active|current)|am i (?:in|looking at))|what(?:'s| is) (?:the |my )?(?:active|current|open) view)$/.test(text)) return "view";
  if (/^(?:what(?:'s| is) (?:currently )?selected|what (?:do i have|have i) selected|how many elements (?:are|do i have) selected)(?: in revit)?$/.test(text)) return "selection";
  return null;
}

const unavailable = "I couldn’t confirm the open model. Revit may be busy or disconnected. Try again when it’s ready.";
function safeLabel(value) {
  // Treat model metadata as text, never Markdown or instructions.
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/[\\`*_{}\[\]<>]/g, "").trim().slice(0, 240);
}

export function renderContextReply(kind, diagnostic) {
  if (!diagnostic?.ok || !diagnostic.data || diagnostic.data.ok === false) return unavailable;
  const data = diagnostic.data;
  const document = data.document;
  if (!document) return "Revit is connected, but no model is open.";
  const title = safeLabel(document.title || document.name);
  if (!title) return unavailable;
  const view = document.activeView || data.active_view || data.view;
  const viewName = safeLabel(view?.name);
  if (kind === "view") return viewName ? `The active view is **${viewName}** in **${title}**.` : `**${title}** is open, but Revit didn’t report an active view.`;
  if (kind === "selection") {
    const selection = document.selection || data.selection;
    const count = Array.isArray(selection) ? selection.length : selection?.count ?? selection?.elementIds?.length ?? selection?.ids?.length;
    return Number.isInteger(count) && count >= 0
      ? count === 0 ? "Nothing is selected in Revit." : `${count} element${count === 1 ? " is" : "s are"} selected in **${title}**.`
      : `**${title}** is open, but Revit didn’t report the selection.`;
  }
  return `${kind === "connection" ? "Yes — " : ""}**${title}** is open.${viewName ? ` The active view is **${viewName}**.` : ""}`;
}

export function contextSnapshotDiagnostic(ping) {
  if (!ping?.ok) return { ok: false, data: null };
  const snapshot = ping.data?.ui_context;
  if (snapshot === undefined) return null; // Older add-ins retain the ordinary context read.
  if (snapshot?.schema !== "revit-operator.ui-context/v1" || snapshot.state !== "available"
      || snapshot.authority !== "ui_identity_only" || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
      || !snapshot.context || !Object.hasOwn(snapshot.context, "document")) return { ok: false, data: null };
  return { ok: true, data: snapshot.context };
}

export async function tryContextReply(body, { verifySession, readContext, signal, timeoutMs = 5000 }) {
  const kind = contextQuestionKind(body);
  if (!kind) return null;
  if (body.version !== "operator.backend.v1" || typeof body.session_id !== "string" || !body.session_id.trim()
      || typeof body.message_id !== "string" || !body.message_id.trim()) throw new Error("A valid conversation and message are required.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(unavailable); }, timeoutMs); });
  const answer = (async () => {
    controller.signal.throwIfAborted();
    // Authorization must finish successfully before a native read is attempted.
    await verifySession(body.session_id, controller.signal);
    controller.signal.throwIfAborted();
    try {
      return renderContextReply(kind, await readContext(controller.signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      return unavailable;
    }
  })();
  try { return await Promise.race([answer, deadline]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
