import path from "node:path";
import { createRequire } from "node:module";
import { ensureWorkspaceLayout } from "../workspace.js";

type SqliteDb = {
  pragma: (s: string) => unknown;
  exec: (s: string) => unknown;
  prepare: (s: string) => { run: (...args: any[]) => any; get: (...args: any[]) => any; all: (...args: any[]) => any };
  close: () => void;
};

type DbState = { db: SqliteDb | null; initAttempted: boolean };

export type ImprovementJobState =
  | "detected"
  | "triaged"
  | "planned"
  | "candidate_generated"
  | "validated"
  | "pr_opened"
  | "merged"
  | "verified"
  | "rejected";

export type ImprovementJobSource = "feedback" | "github_issue" | "nightly_triage" | "upload_queue" | "manual";

export type ImprovementOperatorProfile = {
  environment: string;
  allow_autofix: boolean;
  allow_pr_open: boolean;
  require_human_approve: boolean;
  allowed_branches: string[];
  source: string;
  updated_at: string;
};

export type ImprovementJobRecord = {
  id: number;
  fingerprint: string;
  state: ImprovementJobState;
  source: ImprovementJobSource;
  signal_sources: ImprovementJobSource[];
  created_at: string;
  updated_at: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  title: string | null;
  summary: string | null;
  rating: string | null;
  severity: number | null;
  confidence: number | null;
  impact_score: number | null;
  session_id: string | null;
  chat_id: string | null;
  environment: string | null;
  operator_profile: ImprovementOperatorProfile | null;
  evidence_paths: string[];
  issue_keys: string[];
  tool_names: string[];
  latest_user_request: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  metadata: Record<string, unknown> | null;
};

export type UpsertImprovementJobArgs = {
  fingerprint: string;
  source: ImprovementJobSource;
  state?: ImprovementJobState | null;
  created_at?: string | null;
  first_seen_at?: string | null;
  last_seen_at?: string | null;
  title?: string | null;
  summary?: string | null;
  rating?: string | null;
  severity?: number | null;
  confidence?: number | null;
  impact_score?: number | null;
  session_id?: string | null;
  chat_id?: string | null;
  environment?: string | null;
  operator_profile?: ImprovementOperatorProfile | null;
  evidence_paths?: string[] | null;
  issue_keys?: string[] | null;
  tool_names?: string[] | null;
  latest_user_request?: string | null;
  github_issue_number?: number | null;
  github_issue_url?: string | null;
  metadata?: Record<string, unknown> | null;
  occurrence_delta?: number;
};

const dbStates = new Map<string, DbState>();
const VALID_STATES = new Set<ImprovementJobState>(["detected", "triaged", "planned", "candidate_generated", "validated", "pr_opened", "merged", "verified", "rejected"]);
const VALID_SOURCES = new Set<ImprovementJobSource>(["feedback", "github_issue", "nightly_triage", "upload_queue", "manual"]);

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: string | null | undefined, max: number): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

function dedupe(values: Array<string | null | undefined>, maxItems: number, maxLen: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = clip(value ?? "", maxLen);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? dedupe(parsed.map(x => (typeof x === "string" ? x : String(x ?? ""))), 64, 400) : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dbFilePath(): string {
  return path.join(ensureWorkspaceLayout().db, "operator.sqlite");
}

function openDb(): SqliteDb | null {
  const filePath = dbFilePath();
  const state = dbStates.get(filePath) ?? { db: null, initAttempted: false };
  if (!dbStates.has(filePath)) dbStates.set(filePath, state);
  if (state.db) return state.db;
  if (state.initAttempted) return null;
  state.initAttempted = true;

  try {
    const require = createRequire(import.meta.url);
    const mod: any = require("better-sqlite3");
    const Database = mod?.default ?? mod;
    const db: SqliteDb = new Database(filePath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS improvement_operator_profiles (
        environment TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        allow_autofix INTEGER NOT NULL,
        allow_pr_open INTEGER NOT NULL,
        require_human_approve INTEGER NOT NULL,
        allowed_branches_json TEXT,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS improvement_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        source TEXT NOT NULL,
        signal_sources_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL,
        title TEXT,
        summary TEXT,
        rating TEXT,
        severity REAL,
        confidence REAL,
        impact_score REAL,
        session_id TEXT,
        chat_id TEXT,
        environment TEXT,
        operator_profile_json TEXT,
        evidence_paths_json TEXT,
        issue_keys_json TEXT,
        tool_names_json TEXT,
        latest_user_request TEXT,
        github_issue_number INTEGER,
        github_issue_url TEXT,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_improvement_jobs_score ON improvement_jobs(impact_score DESC, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_improvement_jobs_state ON improvement_jobs(state, last_seen_at DESC);
    `);
    state.db = db;
    return db;
  } catch {
    state.db = null;
    return null;
  }
}

function normalizeState(value: string | null | undefined, fallback: ImprovementJobState): ImprovementJobState {
  const normalized = (value ?? "").trim().toLowerCase() as ImprovementJobState;
  return VALID_STATES.has(normalized) ? normalized : fallback;
}

function normalizeSource(value: string | null | undefined, fallback: ImprovementJobSource): ImprovementJobSource {
  const normalized = (value ?? "").trim().toLowerCase() as ImprovementJobSource;
  return VALID_SOURCES.has(normalized) ? normalized : fallback;
}

function parseProfile(raw: unknown): ImprovementOperatorProfile | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed: any = JSON.parse(raw);
    const environment = clip(parsed?.environment, 120);
    if (!environment) return null;
    return {
      environment,
      allow_autofix: !!parsed?.allow_autofix,
      allow_pr_open: !!parsed?.allow_pr_open,
      require_human_approve: parsed?.require_human_approve !== false,
      allowed_branches: dedupe(Array.isArray(parsed?.allowed_branches) ? parsed.allowed_branches : [], 24, 120),
      source: clip(parsed?.source, 120) ?? "runtime",
      updated_at: clip(parsed?.updated_at, 64) ?? nowIso()
    };
  } catch {
    return null;
  }
}

function parseJob(row: any): ImprovementJobRecord {
  return {
    id: typeof row?.id === "number" ? row.id : Number.parseInt(String(row?.id ?? "0"), 10) || 0,
    fingerprint: clip(row?.fingerprint, 120) ?? "",
    state: normalizeState(row?.state, "detected"),
    source: normalizeSource(row?.source, "manual"),
    signal_sources: dedupe(parseStringArray(row?.signal_sources_json), 12, 40) as ImprovementJobSource[],
    created_at: clip(row?.created_at, 64) ?? nowIso(),
    updated_at: clip(row?.updated_at, 64) ?? nowIso(),
    first_seen_at: clip(row?.first_seen_at, 64) ?? nowIso(),
    last_seen_at: clip(row?.last_seen_at, 64) ?? nowIso(),
    occurrence_count: typeof row?.occurrence_count === "number" ? row.occurrence_count : Number.parseInt(String(row?.occurrence_count ?? "1"), 10) || 1,
    title: clip(row?.title, 220),
    summary: clip(row?.summary, 2000),
    rating: clip(row?.rating, 32),
    severity: Number.isFinite(row?.severity) ? Number(row.severity) : null,
    confidence: Number.isFinite(row?.confidence) ? Number(row.confidence) : null,
    impact_score: Number.isFinite(row?.impact_score) ? Number(row.impact_score) : null,
    session_id: clip(row?.session_id, 160),
    chat_id: clip(row?.chat_id, 160),
    environment: clip(row?.environment, 120),
    operator_profile: parseProfile(row?.operator_profile_json),
    evidence_paths: parseStringArray(row?.evidence_paths_json),
    issue_keys: parseStringArray(row?.issue_keys_json),
    tool_names: parseStringArray(row?.tool_names_json),
    latest_user_request: clip(row?.latest_user_request, 2000),
    github_issue_number: Number.isFinite(row?.github_issue_number) ? Number(row.github_issue_number) : null,
    github_issue_url: clip(row?.github_issue_url, 400),
    metadata: parseMetadata(row?.metadata_json)
  };
}

function isTruthy(raw: string | undefined | null): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function deriveImprovementOperatorProfile(environmentOverride?: string | null): ImprovementOperatorProfile {
  const environment =
    clip(environmentOverride, 120) ??
    ((process.env.AWS_EXECUTION_ENV || process.env.EC2_HOME || process.env.OPERATOR_AUTH_MODE === "principal_jwt") ? "ec2_production" : "dev_workstation");
  const devMode = isTruthy(process.env.OPERATOR_DEV_MODE);
  const autofixRaw = (process.env.OPERATOR_FEEDBACK_DEV_AUTOFIX_ENABLED ?? "").trim();
  return {
    environment,
    allow_autofix: devMode && (!autofixRaw || isTruthy(autofixRaw)),
    allow_pr_open: isTruthy(process.env.OPERATOR_IMPROVEMENT_ALLOW_PR_OPEN),
    require_human_approve: !isTruthy(process.env.OPERATOR_IMPROVEMENT_ALLOW_UNAPPROVED_ACTIONS),
    allowed_branches: dedupe((((process.env.OPERATOR_IMPROVEMENT_ALLOWED_BRANCHES ?? "").trim() || (environment === "dev_workstation" ? "codex/*" : "")).split(",")), 24, 120),
    source: "runtime.env",
    updated_at: nowIso()
  };
}

export function upsertImprovementOperatorProfile(profile: ImprovementOperatorProfile): ImprovementOperatorProfile | null {
  const db = openDb();
  if (!db) return null;
  const normalized = { ...profile, environment: clip(profile.environment, 120) ?? "dev_workstation", source: clip(profile.source, 120) ?? "runtime", updated_at: clip(profile.updated_at, 64) ?? nowIso(), allowed_branches: dedupe(profile.allowed_branches, 24, 120) };
  db.prepare(
    `INSERT INTO improvement_operator_profiles(environment, updated_at, allow_autofix, allow_pr_open, require_human_approve, allowed_branches_json, source)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(environment) DO UPDATE SET updated_at=excluded.updated_at, allow_autofix=excluded.allow_autofix,
       allow_pr_open=excluded.allow_pr_open, require_human_approve=excluded.require_human_approve,
       allowed_branches_json=excluded.allowed_branches_json, source=excluded.source`
  ).run(normalized.environment, normalized.updated_at, normalized.allow_autofix ? 1 : 0, normalized.allow_pr_open ? 1 : 0, normalized.require_human_approve ? 1 : 0, toJson(normalized.allowed_branches), normalized.source);
  return normalized;
}

export function syncDefaultImprovementOperatorProfile(environmentOverride?: string | null): ImprovementOperatorProfile | null {
  return upsertImprovementOperatorProfile(deriveImprovementOperatorProfile(environmentOverride));
}

export function getImprovementOperatorProfile(environment?: string | null): ImprovementOperatorProfile | null {
  const db = openDb();
  if (!db) return null;
  const key = clip(environment, 120) ?? deriveImprovementOperatorProfile().environment;
  const row = db.prepare("SELECT * FROM improvement_operator_profiles WHERE environment=?").get(key);
  return row ? parseProfile(toJson({ ...row, allowed_branches: parseStringArray(row?.allowed_branches_json) })) ?? null : null;
}

export function getImprovementJobByFingerprint(fingerprint: string): ImprovementJobRecord | null {
  const db = openDb();
  const key = clip(fingerprint, 120);
  if (!db || !key) return null;
  const row = db.prepare("SELECT * FROM improvement_jobs WHERE fingerprint=?").get(key);
  return row ? parseJob(row) : null;
}

export function upsertImprovementJob(args: UpsertImprovementJobArgs): { created: boolean; job: ImprovementJobRecord | null } {
  const db = openDb();
  const fingerprint = clip(args.fingerprint, 120);
  if (!db || !fingerprint) throw new Error("fingerprint is required");
  const existing = getImprovementJobByFingerprint(fingerprint);
  const createdAt = clip(args.created_at, 64) ?? nowIso();
  const firstSeenAt = clip(args.first_seen_at, 64) ?? createdAt;
  const lastSeenAt = clip(args.last_seen_at, 64) ?? createdAt;
  const delta = Number.isFinite(args.occurrence_delta) ? Math.max(0, Math.trunc(Number(args.occurrence_delta))) : 1;
  const source = normalizeSource(args.source, "manual");
  const profile = args.operator_profile ?? getImprovementOperatorProfile(args.environment) ?? syncDefaultImprovementOperatorProfile(args.environment);

  const merged = {
    id: existing?.id ?? 0,
    fingerprint,
    state: normalizeState(args.state ?? existing?.state ?? null, "detected"),
    source: existing?.source ?? source,
    signal_sources: dedupe([...(existing?.signal_sources ?? []), source], 12, 40) as ImprovementJobSource[],
    created_at: existing?.created_at ?? createdAt,
    updated_at: nowIso(),
    first_seen_at: existing ? (existing.first_seen_at <= firstSeenAt ? existing.first_seen_at : firstSeenAt) : firstSeenAt,
    last_seen_at: existing ? (existing.last_seen_at >= lastSeenAt ? existing.last_seen_at : lastSeenAt) : lastSeenAt,
    occurrence_count: (existing?.occurrence_count ?? 0) + (existing ? delta : Math.max(1, delta || 1)),
    title: clip(args.title ?? existing?.title ?? null, 220),
    summary: clip(args.summary ?? existing?.summary ?? null, 2000),
    rating: clip(args.rating ?? existing?.rating ?? null, 32),
    severity: Math.max(existing?.severity ?? 0, Number.isFinite(args.severity) ? Number(args.severity) : 0) || null,
    confidence: Math.max(existing?.confidence ?? 0, Number.isFinite(args.confidence) ? Number(args.confidence) : 0) || null,
    impact_score: Math.max(existing?.impact_score ?? 0, Number.isFinite(args.impact_score) ? Number(args.impact_score) : 0) || null,
    session_id: clip(args.session_id ?? existing?.session_id ?? null, 160),
    chat_id: clip(args.chat_id ?? existing?.chat_id ?? null, 160),
    environment: clip(args.environment ?? existing?.environment ?? profile?.environment ?? null, 120),
    operator_profile: profile ?? existing?.operator_profile ?? null,
    evidence_paths: dedupe([...(existing?.evidence_paths ?? []), ...(args.evidence_paths ?? [])], 64, 400),
    issue_keys: dedupe([...(existing?.issue_keys ?? []), ...(args.issue_keys ?? [])], 64, 400),
    tool_names: dedupe([...(existing?.tool_names ?? []), ...(args.tool_names ?? [])], 64, 120),
    latest_user_request: clip(args.latest_user_request ?? existing?.latest_user_request ?? null, 2000),
    github_issue_number: Number.isFinite(args.github_issue_number) ? Number(args.github_issue_number) : existing?.github_issue_number ?? null,
    github_issue_url: clip(args.github_issue_url ?? existing?.github_issue_url ?? null, 400),
    metadata: { ...(existing?.metadata ?? {}), ...(args.metadata ?? {}) }
  };

  if (!existing) {
    db.prepare(
      `INSERT INTO improvement_jobs(
        fingerprint, state, source, signal_sources_json, created_at, updated_at, first_seen_at, last_seen_at, occurrence_count,
        title, summary, rating, severity, confidence, impact_score, session_id, chat_id, environment, operator_profile_json,
        evidence_paths_json, issue_keys_json, tool_names_json, latest_user_request, github_issue_number, github_issue_url, metadata_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(merged.fingerprint, merged.state, merged.source, toJson(merged.signal_sources), merged.created_at, merged.updated_at, merged.first_seen_at, merged.last_seen_at, merged.occurrence_count, merged.title, merged.summary, merged.rating, merged.severity, merged.confidence, merged.impact_score, merged.session_id, merged.chat_id, merged.environment, toJson(merged.operator_profile), toJson(merged.evidence_paths), toJson(merged.issue_keys), toJson(merged.tool_names), merged.latest_user_request, merged.github_issue_number, merged.github_issue_url, toJson(merged.metadata));
  } else {
    db.prepare(
      `UPDATE improvement_jobs SET
        state=?, source=?, signal_sources_json=?, updated_at=?, first_seen_at=?, last_seen_at=?, occurrence_count=?, title=?, summary=?,
        rating=?, severity=?, confidence=?, impact_score=?, session_id=?, chat_id=?, environment=?, operator_profile_json=?,
        evidence_paths_json=?, issue_keys_json=?, tool_names_json=?, latest_user_request=?, github_issue_number=?, github_issue_url=?, metadata_json=?
       WHERE fingerprint=?`
    ).run(merged.state, merged.source, toJson(merged.signal_sources), merged.updated_at, merged.first_seen_at, merged.last_seen_at, merged.occurrence_count, merged.title, merged.summary, merged.rating, merged.severity, merged.confidence, merged.impact_score, merged.session_id, merged.chat_id, merged.environment, toJson(merged.operator_profile), toJson(merged.evidence_paths), toJson(merged.issue_keys), toJson(merged.tool_names), merged.latest_user_request, merged.github_issue_number, merged.github_issue_url, toJson(merged.metadata), merged.fingerprint);
  }

  return { created: !existing, job: getImprovementJobByFingerprint(fingerprint) };
}

export function listImprovementJobs(args?: { state?: string | null; source?: string | null; fingerprint?: string | null; session_id?: string | null; limit?: number }): ImprovementJobRecord[] {
  const db = openDb();
  if (!db) return [];
  const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, Math.trunc(Number(args?.limit)))) : 50;
  const rows = db.prepare("SELECT * FROM improvement_jobs ORDER BY COALESCE(impact_score, 0) DESC, last_seen_at DESC LIMIT ?").all(limit) as any[];
  const state = clip(args?.state, 64)?.toLowerCase() ?? "";
  const source = clip(args?.source, 64)?.toLowerCase() ?? "";
  const fingerprint = clip(args?.fingerprint, 120)?.toLowerCase() ?? "";
  const sessionId = clip(args?.session_id, 160)?.toLowerCase() ?? "";
  return rows.map(parseJob).filter(job => {
    if (state && job.state.toLowerCase() !== state) return false;
    if (source && job.source.toLowerCase() !== source && !job.signal_sources.some(x => x.toLowerCase() === source)) return false;
    if (fingerprint && job.fingerprint.toLowerCase() !== fingerprint) return false;
    if (sessionId && (job.session_id ?? "").toLowerCase() !== sessionId) return false;
    return true;
  });
}

export function __closeForTests(): void {
  for (const state of dbStates.values()) {
    try {
      state.db?.close();
    } catch {
      // ignore
    }
    state.db = null;
    state.initAttempted = false;
  }
  dbStates.clear();
}
