import { randomUUID } from "node:crypto";
import { normalizeAecTaskIntentV1, type AecTaskIntentV1 } from "./aec_task_intent.js";

type CachedIntent = { intent: AecTaskIntentV1; user_text: string; expires_at: number };
const cache = new Map<string, CachedIntent>();
const TTL_MS = 60_000;
const MAX_ITEMS = 256;

function purge(now = Date.now()): void {
  for (const [token, item] of cache) if (item.expires_at <= now) cache.delete(token);
  while (cache.size >= MAX_ITEMS) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
}

export function issueAecTaskIntentToken(intent: AecTaskIntentV1): string {
  purge();
  const token = randomUUID();
  cache.set(token, { intent: normalizeAecTaskIntentV1(intent, intent.evidence.user_text), user_text: intent.evidence.user_text, expires_at: Date.now() + TTL_MS });
  return token;
}

export function consumeAecTaskIntentToken(context: unknown, authoritativeUserText: string): AecTaskIntentV1 | null {
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  const token = typeof (context as Record<string, unknown>).aec_task_intent_token === "string"
    ? (context as Record<string, unknown>).aec_task_intent_token as string
    : "";
  if (!token) return null;
  purge();
  const cached = cache.get(token);
  cache.delete(token);
  if (!cached || cached.user_text !== authoritativeUserText.trim()) return null;
  try { return normalizeAecTaskIntentV1(cached.intent, authoritativeUserText); } catch { return null; }
}

export function __testOnlyClearAecTaskIntentTokens(): void { cache.clear(); }
