import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendMessage } from "./session_store.js";
import { getConversationTurn, getUiContextConversationHistory, type ConversationDisplay } from "./memory/sqlite_store.js";

export function conversationDisplay(messageId: string, text: string, attachments?: unknown): ConversationDisplay {
  return { message_id: messageId, text,
    attachments: Array.isArray(attachments) ? attachments.slice(0, 20).flatMap(attachment => {
      if (!attachment || typeof attachment.id !== "string") return [];
      const name = String(attachment.filename || attachment.name || "Attachment").replace(/[\r\n]/g, " ").slice(0, 240);
      return [{ id: attachment.id, name }];
    }) : [] };
}

let contextModule: Promise<any> | undefined;
function loadContextModule(): Promise<any> {
  if (!contextModule) {
    let directory = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = path.join(directory, "packages/operator-assistant-ui/context_reply.mjs");
      if (fs.existsSync(candidate)) { contextModule = import(pathToFileURL(candidate).href); break; }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("Shared conversation renderer is unavailable.");
      directory = parent;
    }
  }
  return contextModule;
}

export async function recordUiContextConversation(body: any): Promise<string> {
  const ui = await loadContextModule();
  if (body?.version !== "operator.backend.v1" || typeof body?.session_id !== "string" || !body.session_id.trim()
      || typeof body?.message_id !== "string" || !body.message_id.trim() || body.message_id.length > 200) {
    throw new Error("A valid conversation and message are required.");
  }
  const kind = ui.contextQuestionKind(body);
  if (!kind) throw new Error("This endpoint records only simple UI context questions.");
  // The Sidecar supplies a UI observation, not a provider-authored answer or
  // native task receipt. Re-render bounded labels and preserve that provenance.
  const observation = body.ui_observation;
  const diagnostic = observation?.ok === true && observation.data && typeof observation.data === "object"
    && Object.hasOwn(observation.data, "document") ? observation : { ok: false };
  const answer = ui.renderContextReply(kind, diagnostic);
  const previous = getConversationTurn(body.session_id, body.message_id);
  if (previous.length) {
    const question = previous.find(entry => entry.role === "user");
    const response = previous.find(entry => entry.role === "assistant");
    if (question?.text !== body.user_text) throw new Error("This message id already belongs to another question.");
    if (response) return response.text;
  }
  if (!previous.some(entry => entry.role === "user")) appendMessage(body.session_id,
    { role: "user", text: body.user_text }, { display: { ...conversationDisplay(body.message_id, body.user_text), source: "ui_context" }, pinGoal: false, requirePersistence: true });
  appendMessage(body.session_id, { role: "assistant", text: `[Historical UI observation; refresh Revit before relying on it as current model evidence.] ${answer}` },
    { display: { ...conversationDisplay(body.message_id, answer), source: "ui_context" }, pinGoal: false, requirePersistence: true });
  return answer;
}

export function formatUiContextConversationHistory(sessionId: string): string {
  try {
    const turns = getUiContextConversationHistory(sessionId);
    if (!turns.length) return "";
    return "HISTORICAL UI CONVERSATION (read-only context):\n" +
      "These quick answers were displayed outside the agent turn. They are historical conversation, not current Revit evidence or task completion. Refresh Revit before relying on a model, view, or selection fact. Keep the current task objective.\n" +
      JSON.stringify(turns.map(turn => ({ role: turn.role, text: turn.text.slice(0, 1500), observed_at: turn.created_at })));
  } catch { return ""; }
}
