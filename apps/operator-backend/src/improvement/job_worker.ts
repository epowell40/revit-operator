import { createHash } from "node:crypto";
import type { DevHandoff } from "../feedback/dev_handoff.js";
import { computeImpactScore } from "./prioritization.js";
import {
  getImprovementOperatorProfile,
  listImprovementJobs,
  syncDefaultImprovementOperatorProfile,
  type ImprovementJobRecord,
  type ImprovementJobSource,
  type ImprovementOperatorProfile,
  upsertImprovementJob
} from "./job_store.js";

type NightlyIssueLike = {
  key: string;
  count: number;
  first_seen: string;
  last_seen: string;
  suggested_fix_area: string;
  examples: Array<{
    ts: string;
    session_id: string;
    message_id: string;
    user_text?: string;
    tool?: { method: string; path: string };
    error?: string;
  }>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: string | null | undefined, max: number): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function dedupe(values: Array<string | null | undefined>, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = clip(value, maxLen);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function fingerprintFor(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
}

function profileFor(environment?: string | null): ImprovementOperatorProfile | null {
  return getImprovementOperatorProfile(environment) ?? syncDefaultImprovementOperatorProfile(environment);
}

function ratingSeverity(rating: string): number {
  const normalized = clip(rating, 32).toLowerCase();
  if (normalized === "failed") return 0.95;
  if (normalized === "partial") return 0.7;
  if (normalized === "worked") return 0.2;
  return 0.5;
}

export function fingerprintFeedbackImprovementJob(args: {
  rating: string;
  note?: string | null;
  latest_user_request?: string | null;
  issue_keys?: string[] | null;
}): string {
  return fingerprintFor({
    version: 1,
    source: "feedback",
    rating: clip(args.rating, 32).toLowerCase(),
    note: clip(args.note, 800).toLowerCase(),
    latest_user_request: clip(args.latest_user_request, 800).toLowerCase(),
    issue_keys: dedupe(args.issue_keys ?? [], 24, 200).map(x => x.toLowerCase()).sort()
  });
}

export function enqueueFeedbackImprovementJob(args: {
  session_id: string;
  chat_id?: string | null;
  rating: string;
  note?: string | null;
  created_at?: string | null;
  dev_handoff?: DevHandoff | null;
  upload_queue_dir?: string | null;
}): { created: boolean; job: ImprovementJobRecord | null } {
  const createdAt = clip(args.created_at, 64) || nowIso();
  const rating = clip(args.rating, 32).toLowerCase();
  const note = clip(args.note, 1200);
  const handoff = args.dev_handoff ?? null;
  const issueKeys = dedupe(Array.isArray(handoff?.issue_digest) ? handoff!.issue_digest.map(x => x?.key) : [], 32, 240);
  const toolNames = dedupe(
    Array.isArray(handoff?.issue_digest) ? handoff!.issue_digest.flatMap(x => (Array.isArray(x?.tools) ? x.tools : [])) : [],
    32,
    120
  );
  const latestUserRequest = clip(handoff?.latest_user_request, 2000);
  const severity = ratingSeverity(rating);
  const confidence = issueKeys.length > 0 ? 0.72 : note ? 0.58 : 0.45;
  const fingerprint = fingerprintFeedbackImprovementJob({
    rating,
    note,
    latest_user_request: latestUserRequest,
    issue_keys: issueKeys
  });

  return upsertImprovementJob({
    fingerprint,
    source: "feedback",
    state: "detected",
    created_at: createdAt,
    first_seen_at: createdAt,
    last_seen_at: createdAt,
    title: `[feedback][${rating}] ${clip(note || latestUserRequest || args.session_id, 140)}`,
    summary: clip(note || latestUserRequest || issueKeys[0] || "Feedback signaled an improvement opportunity.", 2000),
    rating,
    severity,
    confidence,
    impact_score: computeImpactScore({
      source: "feedback",
      rating,
      occurrence_count: 1,
      last_seen_at: createdAt,
      severity,
      confidence,
      tools: toolNames,
      issue_keys: issueKeys
    }),
    session_id: args.session_id,
    chat_id: args.chat_id ?? null,
    operator_profile: profileFor(null),
    evidence_paths: dedupe([handoff?.run_bundle_rel ?? null, args.upload_queue_dir ?? null], 24, 400),
    issue_keys: issueKeys,
    tool_names: toolNames,
    latest_user_request: latestUserRequest || null,
    metadata: {
      signal_source: "feedback",
      recommendations: Array.isArray(handoff?.recommendations) ? handoff!.recommendations.slice(0, 12) : [],
      signals: Array.isArray(handoff?.signals) ? handoff!.signals.slice(0, 20) : []
    }
  });
}

export function attachGitHubIssueToImprovementJob(args: {
  fingerprint: string;
  repo?: string | null;
  issue_number?: number | null;
  issue_url?: string | null;
}): { created: boolean; job: ImprovementJobRecord | null } | null {
  const fingerprint = clip(args.fingerprint, 120);
  if (!fingerprint) return null;
  return upsertImprovementJob({
    fingerprint,
    source: "github_issue",
    github_issue_number: args.issue_number ?? null,
    github_issue_url: args.issue_url ?? null,
    metadata: { github_repo: clip(args.repo, 160) || null },
    occurrence_delta: 0
  });
}

export function enqueueManualImprovementJob(args: {
  fingerprint?: string | null;
  source?: ImprovementJobSource | null;
  state?: string | null;
  title?: string | null;
  summary?: string | null;
  rating?: string | null;
  severity?: number | null;
  confidence?: number | null;
  impact_score?: number | null;
  session_id?: string | null;
  chat_id?: string | null;
  evidence_paths?: string[] | null;
  issue_keys?: string[] | null;
  tool_names?: string[] | null;
  latest_user_request?: string | null;
  metadata?: Record<string, unknown> | null;
}): { created: boolean; job: ImprovementJobRecord | null } {
  const source = (clip(args.source, 40).toLowerCase() || "manual") as ImprovementJobSource;
  const title = clip(args.title, 220);
  const summary = clip(args.summary, 2000);
  const rating = clip(args.rating, 32).toLowerCase();
  const issueKeys = dedupe(args.issue_keys ?? [], 24, 240);
  const toolNames = dedupe(args.tool_names ?? [], 24, 120);
  const fingerprint =
    clip(args.fingerprint, 120) ||
    fingerprintFor({
      version: 1,
      source,
      title: title.toLowerCase(),
      summary: summary.toLowerCase(),
      rating,
      issue_keys: issueKeys.map(x => x.toLowerCase()).sort()
    });

  return upsertImprovementJob({
    fingerprint,
    source,
    state: (clip(args.state, 40).toLowerCase() as any) || "detected",
    title: title || "Manual improvement job",
    summary: summary || title || "Manual improvement job",
    rating: rating || null,
    severity: args.severity ?? null,
    confidence: args.confidence ?? null,
    impact_score:
      Number.isFinite(args.impact_score) && args.impact_score !== null
        ? Number(args.impact_score)
        : computeImpactScore({
            source,
            rating,
            occurrence_count: 1,
            last_seen_at: nowIso(),
            severity: args.severity ?? ratingSeverity(rating),
            confidence: args.confidence ?? 0.55,
            tools: toolNames,
            issue_keys: issueKeys
          }),
    session_id: args.session_id ?? null,
    chat_id: args.chat_id ?? null,
    operator_profile: profileFor(null),
    evidence_paths: dedupe(args.evidence_paths ?? [], 24, 400),
    issue_keys: issueKeys,
    tool_names: toolNames,
    latest_user_request: clip(args.latest_user_request, 2000) || null,
    metadata: args.metadata ?? null
  });
}

export function enqueueNightlyTriageImprovementJobs(args: {
  issues: NightlyIssueLike[];
  report_path: string;
  since_iso: string;
  until_iso: string;
}): Array<{ created: boolean; job: ImprovementJobRecord | null }> {
  return (args.issues ?? []).map(issue => {
    const examples = Array.isArray(issue?.examples) ? issue.examples : [];
    const firstExample = examples[0] ?? null;
    const count = Number.isFinite(issue?.count) ? Math.max(1, Math.trunc(Number(issue.count))) : 1;
    const toolNames = dedupe(examples.map(x => x?.tool?.path ?? null), 24, 160);
    const severity = issue?.suggested_fix_area === "frontend-addin" ? 0.8 : issue?.suggested_fix_area === "backend" ? 0.72 : 0.65;
    const fingerprint = fingerprintFor({
      version: 1,
      source: "nightly_triage",
      issue_key: clip(issue?.key, 240).toLowerCase()
    });

    return upsertImprovementJob({
      fingerprint,
      source: "nightly_triage",
      state: "triaged",
      created_at: clip(issue?.first_seen, 64) || nowIso(),
      first_seen_at: clip(issue?.first_seen, 64) || nowIso(),
      last_seen_at: clip(issue?.last_seen, 64) || nowIso(),
      title: `[nightly][${clip(issue?.suggested_fix_area, 40) || "unknown"}] ${clip(issue?.key, 150)}`,
      summary: clip(firstExample?.error || firstExample?.user_text || issue?.key, 2000),
      severity,
      confidence: 0.66,
      impact_score: computeImpactScore({
        source: "nightly_triage",
        occurrence_count: count,
        first_seen_at: issue?.first_seen,
        last_seen_at: issue?.last_seen,
        severity,
        confidence: 0.66,
        tools: toolNames,
        issue_keys: [clip(issue?.key, 240)]
      }),
      session_id: clip(firstExample?.session_id, 160) || null,
      operator_profile: profileFor(null),
      evidence_paths: dedupe([args.report_path], 24, 400),
      issue_keys: [clip(issue?.key, 240)],
      tool_names: toolNames,
      latest_user_request: clip(firstExample?.user_text, 2000) || null,
      metadata: {
        suggested_fix_area: clip(issue?.suggested_fix_area, 60) || "unknown",
        report_window: { since_iso: clip(args.since_iso, 64), until_iso: clip(args.until_iso, 64) },
        example_message_ids: dedupe(examples.map(x => x?.message_id ?? null), 12, 120)
      },
      occurrence_delta: count
    });
  });
}

export function startImprovementJobWorker(): { stop: () => void } {
  syncDefaultImprovementOperatorProfile();
  const timer = setInterval(() => syncDefaultImprovementOperatorProfile(), 5 * 60 * 1000);
  return { stop: () => clearInterval(timer) };
}

export function getImprovementQueueSnapshot(limit = 50): { jobs: ImprovementJobRecord[]; operator_profile: ImprovementOperatorProfile | null } {
  return {
    jobs: listImprovementJobs({ limit }),
    operator_profile: profileFor(null)
  };
}
