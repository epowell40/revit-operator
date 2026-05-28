import { getWorkspaceRoot } from "./workspace.js";
import {
  appendEvent,
  ensureSessionOwnership,
  ensureSessionRow,
  getPinnedGoal as getPinnedGoalDb,
  getRecentMessages,
  getSessionOwner,
  setPinnedGoal as setPinnedGoalDb,
  type SessionOwner
} from "./memory/sqlite_store.js";

export type SessionMessage = { role: "user" | "assistant" | "tool"; text: string };

type SessionState = {
  createdAt: string;
  messages: SessionMessage[];
  owner?: SessionOwner;
  /**
   * Pinned user goal/instruction that should not be evicted when the rolling
   * message window truncates. Used to avoid "lost context" mid-tool-loop.
   */
  pinnedGoal?: string;
};

const sessions = new Map<string, SessionState>();
const sessionOwners = new Map<string, SessionOwner>();
const maxMessages = 80;

function sessionKey(sessionId: string): string {
  return `${getWorkspaceRoot()}::${sessionId}`;
}

function normalizeOwner(owner?: Partial<SessionOwner> | null): SessionOwner | null {
  const owner_user_id = typeof owner?.owner_user_id === "string" ? owner.owner_user_id.trim() : "";
  const owner_license_id = typeof owner?.owner_license_id === "string" ? owner.owner_license_id.trim() : "";
  if (!owner_user_id || !owner_license_id) return null;
  return { owner_user_id, owner_license_id };
}

function ownersMatch(a: SessionOwner | null | undefined, b: SessionOwner | null | undefined): boolean {
  if (!a || !b) return false;
  return a.owner_user_id === b.owner_user_id && a.owner_license_id === b.owner_license_id;
}

function shouldPinAsGoal(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 18) return false;
  const lower = t.toLowerCase();
  if (lower === "ok" || lower === "okay" || lower === "yes" || lower === "no" || lower === "thanks" || lower === "thank you") return false;
  // Avoid pinning obvious tool-loop continuations.
  if (lower.startsWith("continue") || lower.startsWith("go ahead")) return false;
  return true;
}

export function ensureSession(sessionId: string, owner?: Partial<SessionOwner> | null): SessionState {
  const key = sessionKey(sessionId);
  let state = sessions.get(key);
  if (!state) {
    state = { createdAt: new Date().toISOString(), messages: [] };
    sessions.set(key, state);
  }

  const normalizedOwner = normalizeOwner(owner);
  if (normalizedOwner) {
    const globalOwner = sessionOwners.get(sessionId);
    if (globalOwner && !ownersMatch(globalOwner, normalizedOwner)) {
      throw new Error("Session owner mismatch.");
    }
    if (!globalOwner) sessionOwners.set(sessionId, normalizedOwner);
    if (state.owner && !ownersMatch(state.owner, normalizedOwner)) {
      throw new Error("Session owner mismatch.");
    }
    state.owner = normalizedOwner;
  }

  try {
    ensureSessionRow(sessionId, state.owner);
  } catch {
    // ignore
  }

  if (!state.owner) {
    try {
      const dbOwner = getSessionOwner(sessionId);
      if (dbOwner) {
        state.owner = dbOwner;
        const globalOwner = sessionOwners.get(sessionId);
        if (!globalOwner) {
          sessionOwners.set(sessionId, dbOwner);
        } else if (!ownersMatch(globalOwner, dbOwner)) {
          throw new Error("Session owner mismatch.");
        }
      }
    } catch {
      // ignore
    }
  }

  return state;
}

export function assertSessionOwnership(
  sessionId: string,
  owner: Partial<SessionOwner> | null | undefined
): { ok: true } | { ok: false; owner?: SessionOwner } {
  const normalizedOwner = normalizeOwner(owner);
  if (!normalizedOwner) return { ok: true };

  const globalOwner = sessionOwners.get(sessionId);
  if (globalOwner && !ownersMatch(globalOwner, normalizedOwner)) {
    return { ok: false, owner: globalOwner };
  }

  const key = sessionKey(sessionId);
  const state = sessions.get(key);
  if (state?.owner && !ownersMatch(state.owner, normalizedOwner)) {
    return { ok: false, owner: state.owner };
  }

  try {
    const ensured = ensureSessionOwnership(sessionId, normalizedOwner);
    if (!ensured.ok) return { ok: false, owner: ensured.owner };
    const nextState = ensureSession(sessionId, normalizedOwner);
    nextState.owner = ensured.owner ?? normalizedOwner;
    sessionOwners.set(sessionId, nextState.owner);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function appendMessage(sessionId: string, msg: SessionMessage): void {
  const state = ensureSession(sessionId);
  state.messages.push(msg);
  if (msg.role === "user" && shouldPinAsGoal(msg.text)) {
    state.pinnedGoal = msg.text.trim();
    try {
      setPinnedGoalDb(sessionId, state.pinnedGoal);
    } catch {
      // ignore
    }
  }
  if (state.messages.length > maxMessages) {
    state.messages.splice(0, state.messages.length - maxMessages);
  }
  try {
    appendEvent(sessionId, msg.role, "chat.message", { text: msg.text });
  } catch {
    // ignore
  }
}

export function appendToolSummary(sessionId: string, summary: string): void {
  appendMessage(sessionId, { role: "tool", text: summary });
}

export function getHistory(sessionId: string): SessionMessage[] {
  const state = ensureSession(sessionId);
  if (state.messages.length === 0) {
    try {
      const fromDb = getRecentMessages(sessionId, maxMessages);
      if (fromDb.length > 0) state.messages = fromDb.slice(-maxMessages);
    } catch {
      // ignore
    }
  }
  return state.messages.slice();
}

export function getPinnedGoal(sessionId: string): string | null {
  const state = ensureSession(sessionId);
  const g = state.pinnedGoal;
  if (g && g.trim()) return g.trim();
  try {
    const fromDb = getPinnedGoalDb(sessionId);
    if (fromDb) state.pinnedGoal = fromDb;
    return fromDb;
  } catch {
    return null;
  }
}
