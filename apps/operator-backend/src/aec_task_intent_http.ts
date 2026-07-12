import { randomUUID } from "node:crypto";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "./contracts.js";
import { interpretAecTaskIntent, type AecTaskIntentInterpreter } from "./aec_task_intent_interpreter.js";
import { resolveAecWorkflow } from "./deterministic/aec_workflow_registry.js";
import { issueAecTaskIntentToken } from "./aec_task_intent_cache.js";

export type AecTaskIntentHttpResult = {
  status: number;
  body: {
    ok: boolean;
    handled?: boolean;
    workflow_id?: string | null;
    intent_token?: string | null;
    intent?: unknown;
    error?: string;
  };
};

function safeId(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : fallback;
}

export async function resolveAecTaskIntentHttp(body: unknown, interpreter?: AecTaskIntentInterpreter): Promise<AecTaskIntentHttpResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { ok: false, error: "Invalid JSON body" } };
  const parsed = body as Record<string, unknown>;
  const userText = typeof parsed.user_text === "string" ? parsed.user_text : typeof parsed.userText === "string" ? parsed.userText : typeof parsed.request === "string" ? parsed.request : "";
  if (!userText.trim()) return { status: 400, body: { ok: false, error: "user_text is required" } };
  const request: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: safeId(parsed.session_id ?? parsed.sessionId, `semantic-preflight-${randomUUID()}`),
    message_id: safeId(parsed.message_id ?? parsed.messageId, `semantic-preflight-${randomUUID()}`),
    user_text: userText
  };
  const intent = await interpretAecTaskIntent(request, interpreter);
  const resolution = intent ? resolveAecWorkflow(intent) : null;
  const intentToken = resolution ? issueAecTaskIntentToken(resolution.intent) : null;
  return {
    status: 200,
    body: {
      ok: true,
      handled: !!resolution,
      workflow_id: resolution?.workflow_id ?? null,
      intent_token: intentToken,
      intent
    }
  };
}
