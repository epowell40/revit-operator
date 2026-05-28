import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";

export type DevHandoffRating = "worked" | "partial" | "failed";

export type DevHandoffIssue = {
  key: string;
  count: number;
  tools: string[];
  sample?: string;
};

export type DevHandoff = {
  generated_at: string;
  session_id: string;
  chat_id: string | null;
  rating: DevHandoffRating;
  note: string | null;
  run_bundle_rel: string | null;
  latest_user_request?: string;
  latest_assistant_response?: string;
  assistant_dev_summary?: string;
  issue_digest: DevHandoffIssue[];
  recommendations: string[];
  signals: string[];
};

type Rule = {
  key: string;
  pattern: RegExp;
  recommendation: string;
  signal: string;
};

type IssueAccumulator = {
  count: number;
  sample?: string;
  tools: Set<string>;
};

const RULES: Rule[] = [
  {
    key: "RepeatedToolLoop",
    pattern: /\bloop(?:ing)?\b|duplicate-call loop protection|max-repeat policy|tool pair|A<->B toggles/i,
    recommendation: "Add duplicate-call loop protection and cap repeated tool-pair toggles so the planner must pivot after equivalent results.",
    signal: "Assistant identified a repeated-tool loop in the planner."
  },
  {
    key: "NoNewInformation",
    pattern: /no new info(?:rmation)?|materially identical|stale-result|same geometry repeatedly|already tried/i,
    recommendation: "Track per-step progress tokens and require a tool-family pivot when consecutive steps yield no new information.",
    signal: "Assistant identified repeated steps with no new information."
  },
  {
    key: "WorkflowPhaseRegression",
    pattern: /phase\/state machine|disallow jumping backward|detect sheet -> orient regions -> map regions|target elements -> dry-run\/apply -> verify/i,
    recommendation: "Enforce workflow phase/state transitions so the planner cannot regress into repeated discovery once targeting has advanced.",
    signal: "Assistant identified workflow phase-regression risk."
  },
  {
    key: "NoWritableTypeSizeParameters",
    pattern: /NoWritableTypeSizeParameters/i,
    recommendation: "Expand fitting size-write strategy (instance radius, connector setters, type params, then duplicate/swap) with attempt-level logging.",
    signal: "Type-size path reports no writable parameters."
  },
  {
    key: "InstanceSizeParametersReadOnly",
    pattern: /InstanceSizeParametersReadOnly/i,
    recommendation: "Probe connector-driven and nested parameters before declaring fitting size paths read-only.",
    signal: "Instance size parameters reported read-only."
  },
  {
    key: "missingAfterElementIds",
    pattern: /missingAfterElementIds/i,
    recommendation: "Track old-to-new element remaps after regeneration/deletion and rebind follow-up passes automatically.",
    signal: "Elements were replaced/deleted during apply."
  },
  {
    key: "ElementNotFound",
    pattern: /Element not found/i,
    recommendation: "Add post-apply identity remap reconciliation so audits target successor elements.",
    signal: "Post-apply checks referenced missing elements."
  },
  {
    key: "SystemClassificationSupplyExcluded",
    pattern: /System classification 'Supply' excluded/i,
    recommendation: "Fix room/space + system-classification filtering and add regression tests for supply scope queries.",
    signal: "Supply filter excluded expected spatial candidates."
  },
  {
    key: "ScanLimitReached",
    pattern: /Scan limit reached/i,
    recommendation: "Raise or adapt scan limits for scoped discovery and report truncated candidate impact explicitly.",
    signal: "Scope scan truncated candidate set."
  },
  {
    key: "InvalidEnumValue",
    pattern: /Invalid enum value/i,
    recommendation: "Harden tool argument normalization so common alias values are mapped before validation.",
    signal: "A tool call failed input validation."
  },
  {
    key: "BackendReachabilityHealthProbe",
    pattern: /backend not reachable|health check failed/i,
    recommendation:
      "Harden backend reachability checks with retry/backoff and emit structured connectivity diagnostics (status, timeout, DNS/TLS/auth).",
    signal: "User reported backend reachability/health-check failures."
  }
];

function nowIso(): string {
  return new Date().toISOString();
}

function workspaceRel(fullPath: string): string {
  const root = path.resolve(ensureWorkspaceLayout().root);
  const full = path.resolve(fullPath);
  const rel = path.relative(root, full).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) return full;
  return rel;
}

function readJsonl(filePath: string, maxLines: number): unknown[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const start = Math.max(0, lines.length - Math.max(1, maxLines));
    const slice = lines.slice(start);
    const out: unknown[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function asRecord(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  return x as Record<string, unknown>;
}

function asString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

function asToolResultRecord(x: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(x)?.tool_result);
}

function clipText(text: string | undefined | null, max: number): string {
  const value = (text ?? "").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || out.length >= 80) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s.slice(0, 1200));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= 80) break;
      collectStrings(item, out, depth + 1);
    }
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;
  for (const v of Object.values(rec)) {
    if (out.length >= 80) break;
    collectStrings(v, out, depth + 1);
  }
}

function isBackendFeedbackRequest(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return /backend dev|backend developer|how to improve|more effective|more efficient|what went wrong|feedback to the backend|backend feedback/i.test(t);
}

function maybeAssistantDevSummary(userRequest: string | undefined, assistantText: string | undefined): string | undefined {
  const t = (assistantText ?? "").trim();
  if (!t) return undefined;
  if (
    /what went wrong/i.test(t) ||
    /recommendations to make this workflow/i.test(t) ||
    /likely backend gaps/i.test(t) ||
    /backend can fix/i.test(t) ||
    /backend improvements/i.test(t) ||
    /acceptance tests/i.test(t)
  ) {
    return t.slice(0, 14_000);
  }
  if (isBackendFeedbackRequest(userRequest) && /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+\S/.test(t)) return t.slice(0, 14_000);
  return undefined;
}

function extractRecommendationsFromSummary(text: string | undefined): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of t.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!match) continue;
    const candidate = clipText(match[1]?.replace(/\*\*(.*?)\*\*/g, "$1"), 260);
    if (!candidate) continue;
    if (/^(example|examples|test|tests|acceptance tests?|i used:|phases?:)\b/i.test(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= 12) break;
  }
  return out;
}

function noteIssue(args: {
  key: string;
  tool: string;
  sample?: string;
  issues: Map<string, IssueAccumulator>;
}): void {
  const acc = args.issues.get(args.key) ?? { count: 0, tools: new Set<string>() };
  acc.count += 1;
  acc.tools.add(args.tool);
  if (!acc.sample && args.sample) acc.sample = clipText(args.sample, 400);
  args.issues.set(args.key, acc);
}

function applyRulesToText(args: {
  text: string | undefined;
  tool: string;
  issues: Map<string, IssueAccumulator>;
  recommendations: Set<string>;
  signals: Set<string>;
}): void {
  const sample = (args.text ?? "").trim();
  if (!sample) return;
  for (const rule of RULES) {
    if (!rule.pattern.test(sample)) continue;
    args.recommendations.add(rule.recommendation);
    args.signals.add(rule.signal);
    noteIssue({
      key: rule.key,
      tool: args.tool,
      sample,
      issues: args.issues
    });
  }
}

function normalizeToolOutputRecord(rec: Record<string, unknown>): {
  tool: string;
  status: string;
  error?: string;
  failureCode?: string;
  failureKind?: string;
  failureHint?: string;
  result?: unknown;
} {
  const toolResult = asToolResultRecord(rec);
  if (toolResult) {
    const method = (asString(toolResult.method) ?? "").trim().toUpperCase();
    const path = (asString(toolResult.path) ?? "").trim();
    const tool = [method, path].filter(Boolean).join(" ").trim() || "unknown";
    return {
      tool,
      status: (asString(toolResult.status) ?? "").trim().toLowerCase(),
      ...(typeof toolResult.error === "string" && toolResult.error.trim() ? { error: toolResult.error.trim() } : {}),
      ...(typeof toolResult.failure_code === "string" && toolResult.failure_code.trim() ? { failureCode: toolResult.failure_code.trim() } : {}),
      ...(typeof toolResult.failure_kind === "string" && toolResult.failure_kind.trim() ? { failureKind: toolResult.failure_kind.trim() } : {}),
      ...(typeof toolResult.failure_hint === "string" && toolResult.failure_hint.trim() ? { failureHint: toolResult.failure_hint.trim() } : {}),
      ...(toolResult.result_json !== undefined ? { result: toolResult.result_json } : {})
    };
  }

  return {
    tool: asString(rec.tool)?.trim() || "unknown",
    status: (asString(rec.status) ?? "").trim().toLowerCase(),
    ...(typeof rec.error === "string" && rec.error.trim() ? { error: rec.error.trim() } : {}),
    ...(typeof rec.failure_code === "string" && rec.failure_code.trim() ? { failureCode: rec.failure_code.trim() } : {}),
    ...(typeof rec.failure_kind === "string" && rec.failure_kind.trim() ? { failureKind: rec.failure_kind.trim() } : {}),
    ...(typeof rec.failure_hint === "string" && rec.failure_hint.trim() ? { failureHint: rec.failure_hint.trim() } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : rec.result_json !== undefined ? { result: rec.result_json } : {})
  };
}

export function buildDevHandoff(args: {
  session_id: string;
  chat_id?: string | null;
  rating: DevHandoffRating;
  note?: string | null;
}): DevHandoff {
  const layout = ensureWorkspaceLayout();
  const sessionId = (args.session_id ?? "").trim();
  const runBundleDir = path.join(layout.runsSessions, sessionId);
  const runBundleExists = fs.existsSync(runBundleDir);

  const requestLog = runBundleExists ? readJsonl(path.join(runBundleDir, "request_log.jsonl"), 2000) : [];
  const agentLog = runBundleExists ? readJsonl(path.join(runBundleDir, "agent_log.jsonl"), 2000) : [];
  const toolOutputs = runBundleExists ? readJsonl(path.join(runBundleDir, "tool_outputs.jsonl"), 4000) : [];

  let latestUserRequest: string | undefined;
  for (let i = requestLog.length - 1; i >= 0; i--) {
    const rec = asRecord(requestLog[i]);
    if (!rec) continue;
    if (asString(rec.kind) !== "user.turn") continue;
    const userText = asString(rec.user_text)?.trim();
    if (userText) {
      latestUserRequest = userText;
      break;
    }
  }

  let latestAssistantResponse: string | undefined;
  let assistantDevSummary: string | undefined;
  let latestAssistantMessageId: string | undefined;
  for (let i = agentLog.length - 1; i >= 0; i--) {
    const rec = asRecord(agentLog[i]);
    if (!rec) continue;
    if (asString(rec.kind) !== "assistant.turn") continue;
    const text = asString(rec.text)?.trim();
    if (!text) continue;
    if (!latestAssistantResponse) {
      latestAssistantResponse = text.slice(0, 5000);
      latestAssistantMessageId = asString(rec.message_id)?.trim() || undefined;
    }
    if (!assistantDevSummary) {
      const s = maybeAssistantDevSummary(latestUserRequest, text);
      if (s) assistantDevSummary = s;
    }
    if (latestAssistantResponse && assistantDevSummary) break;
  }

  const issues = new Map<string, IssueAccumulator>();
  const recommendations = new Set<string>();
  const signals = new Set<string>();

  const turnScopedToolOutputs = latestAssistantMessageId
    ? toolOutputs.filter((row) => {
        const rec = asRecord(row);
        return rec && (asString(rec.message_id)?.trim() || "") === latestAssistantMessageId;
      })
    : toolOutputs;

  for (const row of turnScopedToolOutputs) {
    const rec = asRecord(row);
    if (!rec) continue;
    const normalized = normalizeToolOutputRecord(rec);
    const tool = normalized.tool;
    const status = normalized.status;

    if (status === "failed") {
      const key = normalized.failureCode ? `ToolFailed:${tool}:${normalized.failureCode}` : `ToolFailed:${tool}`;
      noteIssue({
        key,
        tool,
        sample: normalized.error || normalized.failureHint || `Tool reported failed status (${tool}).`,
        issues
      });
      recommendations.add("Add deterministic post-apply mismatch verification and explicit unresolved-element reporting by id.");
      signals.add(`Tool failure reported: ${tool}`);
    }

    const samples: string[] = [];
    if (normalized.error) samples.push(normalized.error);
    if (normalized.failureCode) samples.push(normalized.failureCode);
    if (normalized.failureKind) samples.push(normalized.failureKind);
    if (normalized.failureHint) samples.push(normalized.failureHint);
    collectStrings(normalized.result, samples);

    const seenInRecord = new Set<string>();
    for (const text of samples) {
      for (const rule of RULES) {
        if (!rule.pattern.test(text)) continue;
        seenInRecord.add(rule.key);
        recommendations.add(rule.recommendation);
        signals.add(rule.signal);
      }
    }

    for (const key of seenInRecord) {
      const sample = samples.find(s => RULES.find(r => r.key === key)?.pattern.test(s));
      noteIssue({
        key,
        tool,
        sample,
        issues
      });
    }
  }

  for (const item of [
    { text: latestUserRequest, tool: "context" },
    { text: args.note ?? "", tool: "context" },
    { text: assistantDevSummary, tool: "assistant" }
  ]) {
    applyRulesToText({
      text: item.text,
      tool: item.tool,
      issues,
      recommendations,
      signals
    });
  }

  const assistantRecommendations = extractRecommendationsFromSummary(assistantDevSummary);
  if (assistantRecommendations.length > 0) {
    for (const item of assistantRecommendations) recommendations.add(item);
    signals.add("Assistant provided concrete backend remediation guidance.");
  }

  if ((args.rating === "partial" || args.rating === "failed") && recommendations.size === 0) {
    recommendations.add("Capture structured failure events so backend fixes can be derived without manual log forensics.");
    recommendations.add("Persist normalized issue fingerprints across sessions so duplicate feedback reports collapse automatically.");
  }

  const issueDigest: DevHandoffIssue[] = Array.from(issues.entries())
    .map(([key, acc]) => ({
      key,
      count: acc.count,
      tools: Array.from(acc.tools).sort(),
      ...(acc.sample ? { sample: acc.sample } : {})
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    generated_at: nowIso(),
    session_id: sessionId,
    chat_id: (args.chat_id ?? "").trim() || null,
    rating: args.rating,
    note: (args.note ?? "").trim() || null,
    run_bundle_rel: runBundleExists ? workspaceRel(runBundleDir) : null,
    ...(latestUserRequest ? { latest_user_request: latestUserRequest } : {}),
    ...(latestAssistantResponse ? { latest_assistant_response: latestAssistantResponse } : {}),
    ...(assistantDevSummary ? { assistant_dev_summary: assistantDevSummary } : {}),
    issue_digest: issueDigest,
    recommendations: Array.from(recommendations).slice(0, 12),
    signals: Array.from(signals).slice(0, 20)
  };
}

