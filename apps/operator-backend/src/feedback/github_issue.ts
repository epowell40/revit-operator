import fs from "node:fs";
import path from "node:path";
import { ensureWorkspaceLayout } from "../workspace.js";
import { atomicAppendJsonlLine } from "../persistence/jsonl.js";
import { fingerprintFeedbackImprovementJob } from "../improvement/job_worker.js";
import type { DevHandoff } from "./dev_handoff.js";

export type FeedbackGitHubIssueArgs = {
  session_id: string;
  chat_id?: string | null;
  rating: string;
  note?: string | null;
  created_at?: string;
  dev_handoff?: DevHandoff | null;
};

export type FeedbackGitHubIssueStartResult = {
  started: boolean;
  repo?: string;
  fingerprint?: string;
  reason?: string;
};

export type FeedbackGitHubIssueFinishResult = {
  ok: boolean;
  repo?: string;
  fingerprint?: string;
  issue_number?: number;
  issue_url?: string;
  title?: string;
  skipped?: string;
  status?: number;
  error?: string;
};

export type FeedbackGitHubIssueHooks = {
  onStarted?: (x: { repo: string; fingerprint: string }) => void;
  onFinished?: (x: FeedbackGitHubIssueFinishResult) => void;
};

const DEFAULT_LABELS = ["operator-feedback"];

function nowIso(): string {
  return new Date().toISOString();
}

function isTruthy(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function enabledInEnv(): boolean {
  const raw = (process.env.OPERATOR_FEEDBACK_GITHUB_ISSUES_ENABLED ?? "").trim().toLowerCase();
  return isTruthy(raw);
}

function repoFromEnv(): string {
  return (process.env.OPERATOR_FEEDBACK_GITHUB_REPO ?? "").trim();
}

function tokenFromEnv(): string {
  return (process.env.OPERATOR_FEEDBACK_GITHUB_TOKEN ?? "").trim();
}

function timeoutMsFromEnv(): number {
  const raw = Number.parseInt((process.env.OPERATOR_FEEDBACK_GITHUB_TIMEOUT_MS ?? "").trim(), 10);
  if (!Number.isFinite(raw)) return 12_000;
  return Math.max(3_000, Math.min(60_000, raw));
}

function labelsFromEnv(rating: string): string[] {
  const raw = (process.env.OPERATOR_FEEDBACK_GITHUB_LABELS ?? "").trim();
  const base = raw
    ? raw
        .split(",")
        .map(x => x.trim())
        .filter(Boolean)
    : DEFAULT_LABELS;
  const byRating = rating === "failed" ? "feedback-failed" : rating === "partial" ? "feedback-partial" : "";
  const all = byRating ? [...base, byRating] : base;
  const dedup: string[] = [];
  const seen = new Set<string>();
  for (const x of all) {
    const key = x.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(x);
  }
  return dedup;
}

function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function normalizeRating(rating: string): "worked" | "partial" | "failed" | "" {
  const x = (rating ?? "").trim().toLowerCase();
  if (x === "worked" || x === "partial" || x === "failed") return x;
  return "";
}

function clip(text: string | undefined | null, max: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 14)) + " ...(truncated)";
}

function oneLine(text: string | undefined | null, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + "…";
}

function fingerprintFor(args: { rating: string; note: string; latest_user_request: string; issue_keys: string[] }): string {
  return fingerprintFeedbackImprovementJob({
    rating: args.rating,
    note: oneLine(args.note, 800),
    latest_user_request: oneLine(args.latest_user_request, 800),
    issue_keys: args.issue_keys
  });
}

function issueIndexPath(): string {
  return path.join(ensureWorkspaceLayout().feedback, "github_issues.jsonl");
}

function hasFingerprint(indexPath: string, fingerprint: string): boolean {
  try {
    if (!fs.existsSync(indexPath)) return false;
    const raw = fs.readFileSync(indexPath, "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as any;
        if (typeof rec?.fingerprint === "string" && rec.fingerprint === fingerprint) return true;
      } catch {
        // ignore malformed line
      }
    }
    return false;
  } catch {
    return false;
  }
}

function buildTitle(args: {
  rating: string;
  note: string;
  latest_user_request: string;
  session_id: string;
}): string {
  const base = oneLine(args.note, 96) || oneLine(args.latest_user_request, 96) || `Session ${args.session_id}`;
  const title = `[Operator][${args.rating}] ${base}`;
  return oneLine(title, 240);
}

function buildBody(args: {
  session_id: string;
  chat_id: string;
  rating: string;
  note: string;
  created_at: string;
  dev_handoff: DevHandoff | null;
  fingerprint: string;
}): string {
  const lines: string[] = [];
  lines.push("Automated issue created from in-app Operator feedback.");
  lines.push("");
  lines.push("Context:");
  lines.push(`- rating: \`${args.rating}\``);
  lines.push(`- session_id: \`${args.session_id}\``);
  lines.push(`- chat_id: \`${args.chat_id || "(none)"}\``);
  lines.push(`- created_at: \`${args.created_at}\``);
  lines.push("");
  if (args.note) {
    lines.push("Feedback note:");
    lines.push("");
    lines.push(clip(args.note, 4000));
    lines.push("");
  }
  const h = args.dev_handoff;
  if (h) {
    if (h.latest_user_request) {
      lines.push("Latest user request:");
      lines.push("");
      lines.push(clip(h.latest_user_request, 2000));
      lines.push("");
    }
    if (h.assistant_dev_summary) {
      lines.push("Assistant backend feedback:");
      lines.push("");
      lines.push(clip(h.assistant_dev_summary, 6000));
      lines.push("");
    }
    if (h.run_bundle_rel) {
      lines.push(`Run bundle: \`${h.run_bundle_rel}\``);
      lines.push("");
    }
    if (Array.isArray(h.issue_digest) && h.issue_digest.length > 0) {
      lines.push("Issue digest (latest turn):");
      for (const item of h.issue_digest.slice(0, 12)) {
        const tools = Array.isArray(item.tools) && item.tools.length > 0 ? ` tools=${item.tools.join(",")}` : "";
        lines.push(`- \`${item.key}\` x${item.count}${tools}`);
        if (item.sample) lines.push(`  - sample: ${clip(item.sample, 260)}`);
      }
      lines.push("");
    }
    if (Array.isArray(h.recommendations) && h.recommendations.length > 0) {
      lines.push("Recommendations:");
      for (const r of h.recommendations.slice(0, 12)) lines.push(`- ${clip(r, 260)}`);
      lines.push("");
    }
    if (Array.isArray(h.signals) && h.signals.length > 0) {
      lines.push("Signals:");
      for (const s of h.signals.slice(0, 20)) lines.push(`- ${clip(s, 260)}`);
      lines.push("");
    }
  }
  lines.push(`<!-- operator_feedback_fingerprint:${args.fingerprint} -->`);
  lines.push(`<!-- operator_feedback_session:${args.session_id} created_at:${args.created_at} -->`);
  return lines.join("\n").trim();
}

async function postIssue(args: {
  repo: string;
  token: string;
  title: string;
  body: string;
  labels: string[];
  timeoutMs: number;
}): Promise<{ ok: true; number: number; url: string } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const url = `https://api.github.com/repos/${args.repo}/issues`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${args.token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "revitoperator-feedback-bridge"
      },
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        labels: args.labels
      }),
      signal: controller.signal
    });
    const text = await resp.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!resp.ok) {
      const msg =
        (typeof parsed?.message === "string" && parsed.message.trim()) ||
        (text ? clip(text, 500) : `GitHub API request failed (${resp.status}).`);
      return { ok: false, status: resp.status, error: msg };
    }
    const number = typeof parsed?.number === "number" ? parsed.number : 0;
    const issueUrl = typeof parsed?.html_url === "string" ? parsed.html_url : "";
    if (!number || !issueUrl) {
      return { ok: false, status: resp.status, error: "GitHub API response missing issue number/url." };
    }
    return { ok: true, number, url: issueUrl };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(t);
  }
}

export async function createFeedbackGitHubIssue(args: FeedbackGitHubIssueArgs): Promise<FeedbackGitHubIssueFinishResult> {
  const rating = normalizeRating(args.rating);
  if (!rating) return { ok: false, skipped: "invalid_rating" };
  if (!(rating === "failed" || rating === "partial")) return { ok: false, skipped: "rating_not_eligible" };
  if (!enabledInEnv()) return { ok: false, skipped: "disabled" };

  const token = tokenFromEnv();
  if (!token) return { ok: false, skipped: "missing_token" };

  const repo = repoFromEnv();
  if (!validRepo(repo)) return { ok: false, skipped: "invalid_repo" };

  const sessionId = (args.session_id ?? "").trim();
  if (!sessionId) return { ok: false, skipped: "missing_session_id" };
  const chatId = (args.chat_id ?? "").trim();
  const createdAt = (args.created_at ?? nowIso()).trim() || nowIso();
  const note = (args.note ?? "").trim();
  const handoff = args.dev_handoff ?? null;
  const latestUserRequest = handoff?.latest_user_request ?? "";
  const issueKeys = Array.isArray(handoff?.issue_digest) ? handoff!.issue_digest.map(x => x.key) : [];
  const fingerprint = fingerprintFor({
    rating,
    note,
    latest_user_request: latestUserRequest,
    issue_keys: issueKeys
  });
  const indexPath = issueIndexPath();
  if (hasFingerprint(indexPath, fingerprint)) {
    return { ok: false, skipped: "duplicate", repo, fingerprint };
  }

  const title = buildTitle({
    rating,
    note,
    latest_user_request: latestUserRequest,
    session_id: sessionId
  });
  const body = buildBody({
    session_id: sessionId,
    chat_id: chatId,
    rating,
    note,
    created_at: createdAt,
    dev_handoff: handoff,
    fingerprint
  });
  const labels = labelsFromEnv(rating);
  const posted = await postIssue({
    repo,
    token,
    title,
    body,
    labels,
    timeoutMs: timeoutMsFromEnv()
  });
  if (!posted.ok) {
    return { ok: false, repo, fingerprint, status: posted.status, error: posted.error };
  }

  atomicAppendJsonlLine(indexPath, {
    ts: nowIso(),
    repo,
    issue_number: posted.number,
    issue_url: posted.url,
    title,
    labels,
    session_id: sessionId,
    chat_id: chatId || null,
    rating,
    note: note || null,
    created_at: createdAt,
    fingerprint
  });

  return {
    ok: true,
    repo,
    fingerprint,
    issue_number: posted.number,
    issue_url: posted.url,
    title
  };
}

export function startFeedbackGitHubIssue(args: FeedbackGitHubIssueArgs, hooks?: FeedbackGitHubIssueHooks): FeedbackGitHubIssueStartResult {
  const rating = normalizeRating(args.rating);
  if (!rating) return { started: false, reason: "invalid_rating" };
  if (!(rating === "failed" || rating === "partial")) return { started: false, reason: "rating_not_eligible" };
  if (!enabledInEnv()) return { started: false, reason: "disabled" };

  const token = tokenFromEnv();
  if (!token) return { started: false, reason: "missing_token" };

  const repo = repoFromEnv();
  if (!validRepo(repo)) return { started: false, reason: "invalid_repo" };

  const sessionId = (args.session_id ?? "").trim();
  if (!sessionId) return { started: false, reason: "missing_session_id" };

  const note = (args.note ?? "").trim();
  const latestUserRequest = args.dev_handoff?.latest_user_request ?? "";
  const issueKeys = Array.isArray(args.dev_handoff?.issue_digest) ? args.dev_handoff!.issue_digest.map(x => x.key) : [];
  const fingerprint = fingerprintFor({
    rating,
    note,
    latest_user_request: latestUserRequest,
    issue_keys: issueKeys
  });
  hooks?.onStarted?.({ repo, fingerprint });

  void (async () => {
    const result = await createFeedbackGitHubIssue(args);
    hooks?.onFinished?.(result);
  })();

  return { started: true, repo, fingerprint };
}
