import type { ToolResult } from "../contracts.js";
import { appendDailyMemory } from "./jsonl_memory_store.js";

const savedTurnKeys = new Set<string>();

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").toString().trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function isEnabled(): boolean {
  return parseBool(process.env.OPERATOR_MEMORY_AUTO_TURN_NOTES, true);
}

function normalize(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trim();
}

function summarizeToolResults(results: ToolResult[]): string {
  const done = results.filter(r => r.status === "done").length;
  const failed = results.filter(r => r.status === "failed").length;
  const paths = Array.from(new Set(results.map(r => (r.path ?? "").trim()).filter(Boolean))).slice(0, 4);
  const firstError = normalize(String(results.find(r => r.status === "failed")?.error ?? ""));

  const parts: string[] = [];
  parts.push(`done=${done}`);
  parts.push(`failed=${failed}`);
  if (paths.length > 0) parts.push(`paths=${paths.join(",")}`);
  if (firstError) parts.push(`first_error=${truncate(firstError, 140)}`);
  return parts.join(" ");
}

export function isLikelyMetaCommand(userText: string): boolean {
  const t = normalize(userText).toLowerCase();
  if (!t) return false;
  const exact = new Set<string>([
    "skills",
    "list skills",
    "list staged skills",
    "list disabled skills",
    "cancel skill",
    "stop skill",
    "create skill draft"
  ]);
  if (exact.has(t)) return true;
  const prefixes = [
    "show skill ",
    "save skill ",
    "run skill ",
    "install skill ",
    "disable skill ",
    "enable skill ",
    "remember preference ",
    "remember workflow ",
    "remember note ",
    "search memory ",
    "recall memory ",
    "create proposal "
  ];
  return prefixes.some(p => t.startsWith(p));
}

export type AutoTurnMemoryInput = {
  sessionId: string;
  messageId: string;
  userText: string;
  assistantMessage: string;
  actionsCount: number;
  toolResults: ToolResult[];
  ts?: string;
};

export function buildAutoTurnMemoryNote(args: AutoTurnMemoryInput): string {
  const intent = normalize(args.userText);
  const outcome = normalize(args.assistantMessage);
  const parts: string[] = [];

  if (intent) parts.push(`intent: ${truncate(intent, 220)}`);
  if (Array.isArray(args.toolResults) && args.toolResults.length > 0) {
    parts.push(`tools: ${summarizeToolResults(args.toolResults)}`);
  }
  if (outcome) parts.push(`outcome: ${truncate(outcome, 360)}`);

  return truncate(parts.join(" | "), 800);
}

export function maybePersistAutoTurnMemory(args: AutoTurnMemoryInput): {
  saved: boolean;
  reason?: string;
  dailyPath?: string;
  text?: string;
} {
  if (!isEnabled()) return { saved: false, reason: "disabled" };

  const key = `${args.sessionId}:${args.messageId}`;
  if (savedTurnKeys.has(key)) return { saved: false, reason: "duplicate" };
  if ((args.actionsCount ?? 0) > 0) return { saved: false, reason: "pending_actions" };

  const userText = normalize(args.userText);
  const assistantText = normalize(args.assistantMessage);
  const hasTools = Array.isArray(args.toolResults) && args.toolResults.length > 0;

  if (!assistantText) return { saved: false, reason: "empty_assistant" };
  if (!userText && !hasTools) return { saved: false, reason: "empty_turn" };
  if (userText && isLikelyMetaCommand(userText)) return { saved: false, reason: "meta_command" };

  const text = buildAutoTurnMemoryNote(args);
  if (!text || text.length < 24) return { saved: false, reason: "too_short" };

  const failedTools = (args.toolResults ?? []).some(r => r.status === "failed");
  const tags = ["auto", "turn_summary", ...(hasTools ? ["tool_results"] : []), ...(failedTools ? ["failed_tool"] : [])];
  const dailyPath = appendDailyMemory({
    kind: "note",
    text,
    session_id: args.sessionId,
    source: "chat.auto",
    tags,
    ...(args.ts ? { ts: args.ts } : {})
  });

  savedTurnKeys.add(key);
  return { saved: true, dailyPath, text };
}

export function __resetAutoTurnMemoryForTests(): void {
  savedTurnKeys.clear();
}

