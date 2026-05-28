import path from "node:path";
import { createRequire } from "node:module";
import { ensureWorkspaceLayout } from "../workspace.js";

type SqliteDb = {
  pragma: (s: string) => unknown;
  exec: (s: string) => unknown;
  prepare: (s: string) => { run: (...args: any[]) => any; get: (...args: any[]) => any; all: (...args: any[]) => any };
  close: () => void;
};

type DbState = {
  db: SqliteDb | null;
  initAttempted: boolean;
};

export type SessionOwner = {
  owner_user_id: string;
  owner_license_id: string;
};

const dbStates = new Map<string, DbState>();

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeOwner(owner: Partial<SessionOwner> | null | undefined): SessionOwner | null {
  const owner_user_id = typeof owner?.owner_user_id === "string" ? owner.owner_user_id.trim() : "";
  const owner_license_id = typeof owner?.owner_license_id === "string" ? owner.owner_license_id.trim() : "";
  if (!owner_user_id || !owner_license_id) return null;
  return { owner_user_id, owner_license_id };
}

function dbFilePath(): string {
  const layout = ensureWorkspaceLayout();
  return path.join(layout.db, "operator.sqlite");
}

function getDbState(filePath: string): DbState {
  let state = dbStates.get(filePath);
  if (!state) {
    state = { db: null, initAttempted: false };
    dbStates.set(filePath, state);
  }
  return state;
}

function ensureSessionOwnerColumns(d: SqliteDb): void {
  try {
    const rows = d.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: unknown }>;
    const names = new Set(rows.map(r => String(r?.name ?? "").toLowerCase()).filter(Boolean));
    if (!names.has("owner_user_id")) d.exec("ALTER TABLE sessions ADD COLUMN owner_user_id TEXT");
    if (!names.has("owner_license_id")) d.exec("ALTER TABLE sessions ADD COLUMN owner_license_id TEXT");
  } catch {
    // ignore
  }
}

function openDb(): SqliteDb | null {
  const filePath = dbFilePath();
  const state = getDbState(filePath);
  if (state.db) return state.db;
  if (state.initAttempted) return null;
  state.initAttempted = true;

  try {
    const require = createRequire(import.meta.url);
    const mod: any = require("better-sqlite3");
    const Database = mod?.default ?? mod;
    const instance: SqliteDb = new Database(filePath);
    instance.pragma("journal_mode = WAL");
    instance.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        pinned_goal TEXT,
        metadata_json TEXT,
        owner_user_id TEXT,
        owner_license_id TEXT
      );
      CREATE TABLE IF NOT EXISTS codex_threads (
        session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        root_message_id TEXT,
        message_id TEXT NOT NULL,
        step_index INTEGER,
        user_text TEXT,
        planned_actions_json TEXT,
        tool_results_json TEXT,
        verification_artifacts_json TEXT,
        stop_reason TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_session_message ON steps(session_id, message_id);
      CREATE TABLE IF NOT EXISTS action_map (
        action_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        confidence REAL,
        expires_at TEXT,
        source TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_facts_scope_key ON facts(scope, key);
    `);
    ensureSessionOwnerColumns(instance);

    state.db = instance;
    return state.db;
  } catch {
    state.db = null;
    return null;
  }
}

function readOwnerFromRow(row: any): SessionOwner | null {
  const owner = normalizeOwner({
    owner_user_id: typeof row?.owner_user_id === "string" ? row.owner_user_id : "",
    owner_license_id: typeof row?.owner_license_id === "string" ? row.owner_license_id : ""
  });
  return owner;
}

export function ensureSessionRow(sessionId: string, owner?: Partial<SessionOwner> | null): void {
  const d = openDb();
  if (!d) return;
  const ts = nowIso();
  const normalizedOwner = normalizeOwner(owner);
  d.prepare(
    `INSERT INTO sessions(session_id, created_at, last_active_at, owner_user_id, owner_license_id)
      VALUES(?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_active_at=excluded.last_active_at,
        owner_user_id=CASE WHEN sessions.owner_user_id IS NULL OR sessions.owner_user_id='' THEN excluded.owner_user_id ELSE sessions.owner_user_id END,
        owner_license_id=CASE WHEN sessions.owner_license_id IS NULL OR sessions.owner_license_id='' THEN excluded.owner_license_id ELSE sessions.owner_license_id END`
  ).run(sessionId, ts, ts, normalizedOwner?.owner_user_id ?? null, normalizedOwner?.owner_license_id ?? null);
}

export function getSessionOwner(sessionId: string): SessionOwner | null {
  const d = openDb();
  if (!d) return null;
  const row = d.prepare("SELECT owner_user_id, owner_license_id FROM sessions WHERE session_id=?").get(sessionId);
  return readOwnerFromRow(row);
}

export function setSessionOwner(sessionId: string, owner: Partial<SessionOwner> | null | undefined): void {
  const d = openDb();
  if (!d) return;
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) return;
  d.prepare("UPDATE sessions SET owner_user_id=?, owner_license_id=?, last_active_at=? WHERE session_id=?").run(
    normalizedOwner.owner_user_id,
    normalizedOwner.owner_license_id,
    nowIso(),
    sessionId
  );
}

export function ensureSessionOwnership(
  sessionId: string,
  owner: Partial<SessionOwner> | null | undefined
): { ok: true; owner?: SessionOwner } | { ok: false; owner?: SessionOwner } {
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) return { ok: true };

  ensureSessionRow(sessionId, normalizedOwner);
  const existing = getSessionOwner(sessionId);
  if (!existing) {
    setSessionOwner(sessionId, normalizedOwner);
    const afterSet = getSessionOwner(sessionId);
    if (!afterSet) return { ok: true, owner: normalizedOwner };
    return { ok: true, owner: afterSet };
  }

  if (existing.owner_user_id === normalizedOwner.owner_user_id && existing.owner_license_id === normalizedOwner.owner_license_id) {
    return { ok: true, owner: existing };
  }

  return { ok: false, owner: existing };
}

export function setPinnedGoal(sessionId: string, goal: string): void {
  const d = openDb();
  if (!d) return;
  d.prepare("UPDATE sessions SET pinned_goal=?, last_active_at=? WHERE session_id=?").run(goal, nowIso(), sessionId);
}

export function getPinnedGoal(sessionId: string): string | null {
  const d = openDb();
  if (!d) return null;
  const row = d.prepare("SELECT pinned_goal FROM sessions WHERE session_id=?").get(sessionId);
  const v = row?.pinned_goal;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

export function getCodexThreadId(sessionId: string): string | null {
  const d = openDb();
  if (!d) return null;
  const row = d.prepare("SELECT thread_id FROM codex_threads WHERE session_id=?").get(sessionId);
  const v = row?.thread_id;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function setCodexThreadId(sessionId: string, threadId: string): void {
  const d = openDb();
  if (!d) return;
  const ts = nowIso();
  d.prepare(
    "INSERT INTO codex_threads(session_id, thread_id, created_at, updated_at) VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET thread_id=excluded.thread_id, updated_at=excluded.updated_at"
  ).run(sessionId, threadId, ts, ts);
}

export function appendEvent(sessionId: string, role: string, kind: string, payload: unknown): void {
  const d = openDb();
  if (!d) return;
  const payload_json = payload === undefined ? null : JSON.stringify(payload);
  d.prepare("INSERT INTO events(ts, session_id, role, kind, payload_json) VALUES(?,?,?,?,?)").run(
    nowIso(),
    sessionId,
    role,
    kind,
    payload_json
  );
  d.prepare("UPDATE sessions SET last_active_at=? WHERE session_id=?").run(nowIso(), sessionId);
}

export type StoredMessage = { role: "user" | "assistant" | "tool"; text: string };

export type StoredNotification = {
  id: number;
  ts: string;
  type: string;
  text: string;
  payload?: unknown;
};

export function appendNotification(sessionId: string, type: string, text: string, payload?: unknown): void {
  const t = (type ?? "").trim();
  const msg = (text ?? "").trim();
  if (!t || !msg) return;
  appendEvent(sessionId, "assistant", "notification", { type: t, text: msg, payload });
}

export function getNotificationsAfter(sessionId: string, afterId: number, limit: number): StoredNotification[] {
  const d = openDb();
  if (!d) return [];
  const safeAfter = Number.isFinite(afterId) ? Math.max(0, Math.floor(afterId)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50;
  const rows = d
    .prepare("SELECT id, ts, payload_json FROM events WHERE session_id=? AND kind='notification' AND id>? ORDER BY id ASC LIMIT ?")
    .all(sessionId, safeAfter, safeLimit);

  const out: StoredNotification[] = [];
  for (const r of rows) {
    const id = typeof r?.id === "number" ? r.id : Number.parseInt(String(r?.id ?? ""), 10);
    const ts = typeof r?.ts === "string" ? r.ts : "";
    const payloadRaw = typeof r?.payload_json === "string" ? r.payload_json : "";
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!ts) continue;
    if (!payloadRaw) continue;
    try {
      const p = JSON.parse(payloadRaw) as any;
      const type = typeof p?.type === "string" ? p.type.trim() : "";
      const text = typeof p?.text === "string" ? p.text.trim() : "";
      if (!type || !text) continue;
      const payload = p?.payload;
      out.push({ id, ts, type, text, ...(payload !== undefined ? { payload } : {}) });
    } catch {
      continue;
    }
  }
  return out;
}

export function getRecentMessages(sessionId: string, limit: number): StoredMessage[] {
  const d = openDb();
  if (!d) return [];
  const rows = d
    .prepare("SELECT role, kind, payload_json FROM events WHERE session_id=? AND kind='chat.message' ORDER BY id DESC LIMIT ?")
    .all(sessionId, Math.max(1, Math.min(500, limit)));
  const out: StoredMessage[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const role = r?.role;
    const payloadRaw = typeof r?.payload_json === "string" ? r.payload_json : null;
    if (role !== "user" && role !== "assistant" && role !== "tool") continue;
    if (!payloadRaw) continue;
    try {
      const p = JSON.parse(payloadRaw) as any;
      const text = typeof p?.text === "string" ? p.text : "";
      if (!text) continue;
      out.push({ role, text });
    } catch {
      continue;
    }
  }
  return out;
}

export type StopReason = "NO_ACTIONS" | "AWAITING_APPROVAL" | "MAX_STEPS" | "ERROR" | "USER_CANCELLED";

function parseStepInfo(messageId: string): { root_message_id: string | null; step_index: number | null } {
  const m = (messageId || "").trim();
  const marker = ":assistant:";
  const idx = m.indexOf(marker);
  if (idx >= 0) {
    const root = m.slice(0, idx).trim();
    const tail = m.slice(idx + marker.length).trim();
    const n = Number.parseInt(tail, 10);
    return { root_message_id: root || null, step_index: Number.isFinite(n) ? n : null };
  }
  return { root_message_id: null, step_index: null };
}

function normalizeArtifactsFromToolResult(tr: any): string[] {
  try {
    const attachments = tr?.attachments;
    if (!Array.isArray(attachments)) return [];
    const out: string[] = [];
    for (const a of attachments) {
      const lp = a?.local_path;
      if (typeof lp === "string" && lp.trim()) out.push(lp.trim());
    }
    return out;
  } catch {
    return [];
  }
}

function appendJsonArray(existingJson: unknown, add: unknown[]): string {
  let arr: unknown[] = [];
  try {
    if (typeof existingJson === "string" && existingJson.trim()) {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) arr = parsed;
    }
  } catch {
    arr = [];
  }
  arr.push(...add);
  return JSON.stringify(arr);
}

export function upsertStepPlanned(sessionId: string, messageId: string, userText: string | null, plannedActions: unknown[]): void {
  const d = openDb();
  if (!d) return;
  const ts = nowIso();
  const info = parseStepInfo(messageId);

  const planned = plannedActions && plannedActions.length > 0 ? JSON.stringify(plannedActions) : "[]";

  d.prepare(
    `INSERT INTO steps(created_at, updated_at, session_id, root_message_id, message_id, step_index, user_text, planned_actions_json)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id, message_id) DO UPDATE SET
       updated_at=excluded.updated_at,
       user_text=COALESCE(excluded.user_text, steps.user_text),
       planned_actions_json=COALESCE(excluded.planned_actions_json, steps.planned_actions_json)`
  ).run(ts, ts, sessionId, info.root_message_id, messageId, info.step_index, userText, planned);

  for (const a of plannedActions ?? []) {
    const actionId = (a as any)?.action_id;
    if (typeof actionId !== "string" || !actionId.trim()) continue;
    d.prepare("INSERT OR REPLACE INTO action_map(action_id, session_id, message_id, created_at) VALUES(?,?,?,?)").run(
      actionId.trim(),
      sessionId,
      messageId,
      ts
    );
  }
}

export function attachToolResultToPlannedStep(sessionId: string, toolResult: unknown): void {
  const d = openDb();
  if (!d) return;
  if (!toolResult || typeof toolResult !== "object") return;
  const tr: any = toolResult;
  const actionIdRaw = typeof tr.action_id === "string" ? tr.action_id.trim() : "";
  if (!actionIdRaw) return;

  const autoSuffix = ":__auto_capture";
  const actionId = actionIdRaw.endsWith(autoSuffix) ? actionIdRaw.slice(0, -autoSuffix.length) : actionIdRaw;
  if (!actionId) return;

  const mapRow = d.prepare("SELECT message_id FROM action_map WHERE action_id=? AND session_id=?").get(actionId, sessionId);
  const msgId = typeof mapRow?.message_id === "string" ? mapRow.message_id : "";
  if (!msgId) return;

  const row = d.prepare("SELECT tool_results_json, verification_artifacts_json FROM steps WHERE session_id=? AND message_id=?").get(sessionId, msgId);
  const existingTool = row?.tool_results_json;
  const existingArt = row?.verification_artifacts_json;

  const nextTool = appendJsonArray(existingTool, [toolResult]);
  const artifacts = normalizeArtifactsFromToolResult(tr);
  const nextArt = artifacts.length > 0 ? appendJsonArray(existingArt, artifacts) : typeof existingArt === "string" ? existingArt : "[]";

  d.prepare("UPDATE steps SET tool_results_json=?, verification_artifacts_json=?, updated_at=? WHERE session_id=? AND message_id=?").run(
    nextTool,
    nextArt,
    nowIso(),
    sessionId,
    msgId
  );
}

export function setStepStopReason(sessionId: string, messageId: string, stopReason: StopReason): void {
  const d = openDb();
  if (!d) return;
  d.prepare("UPDATE steps SET stop_reason=?, updated_at=? WHERE session_id=? AND message_id=?").run(
    stopReason,
    nowIso(),
    sessionId,
    messageId
  );
}

export function getRecentStepToolResults(sessionId: string, limit = 40): unknown[] {
  const d = openDb();
  if (!d) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 40;
  const rows = d
    .prepare("SELECT tool_results_json FROM steps WHERE session_id=? AND tool_results_json IS NOT NULL ORDER BY id DESC LIMIT ?")
    .all(sessionId, safeLimit);

  const out: unknown[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const raw = typeof rows[i]?.tool_results_json === "string" ? rows[i].tool_results_json : "";
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // ignore malformed rows
    }
  }
  return out;
}

// Test helper (not used by runtime).
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
