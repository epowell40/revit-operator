import { appendEvent } from "../memory/sqlite_store.js";

export type RedlineFastPathPhase =
  | "request_accepted"
  | "preflight_start"
  | "preflight_end"
  | "vision_start"
  | "vision_end"
  | "planner_start"
  | "planner_end"
  | "first_revit_action_emitted"
  | "first_revit_action_completed"
  | "blocked";

export type RedlineFastPathState = {
  phases: Partial<Record<RedlineFastPathPhase, string>>;
  blocked_reason?: string;
  candidate_views_checked: Array<{ view_id: number; view_name: string; matched: boolean; confidence: number; analysis: string }>;
  updated_at_ms: number;
};

const redlineFastPathBySession = new Map<string, RedlineFastPathState>();
const REDLINE_FAST_PATH_TTL_MS = 12 * 60 * 60 * 1000;

export function getRedlineFastPathState(sessionId: string): RedlineFastPathState {
  const now = Date.now();
  for (const [key, state] of redlineFastPathBySession.entries()) {
    if (!key || now - (state.updated_at_ms || 0) > REDLINE_FAST_PATH_TTL_MS) {
      redlineFastPathBySession.delete(key);
    }
  }
  const current = redlineFastPathBySession.get(sessionId);
  if (current) return current;
  const created: RedlineFastPathState = { phases: {}, candidate_views_checked: [], updated_at_ms: now };
  redlineFastPathBySession.set(sessionId, created);
  return created;
}

export function noteRedlineFastPathPhase(
  sessionId: string,
  phase: RedlineFastPathPhase,
  data?: Record<string, unknown>
): void {
  if (!sessionId) return;
  const state = getRedlineFastPathState(sessionId);
  const ts = new Date().toISOString();
  state.phases[phase] = ts;
  if (phase === "blocked" && typeof data?.blocked_reason === "string" && data.blocked_reason.trim()) {
    state.blocked_reason = data.blocked_reason.trim();
  }
  state.updated_at_ms = Date.now();
  try {
    appendEvent(sessionId, "assistant", "redline.fast_path_phase", { phase, ts, ...(data ?? {}) });
  } catch {
    // Diagnostics must never break the model workflow.
  }
}

export function appendRedlineFastPathCandidateDiagnostic(
  sessionId: string,
  row: { view_id: number; view_name: string; matched: boolean; confidence: number; analysis: string }
): void {
  const state = getRedlineFastPathState(sessionId);
  state.candidate_views_checked = [
    ...state.candidate_views_checked.filter((it) => it.view_id !== row.view_id),
    row
  ].slice(-6);
  state.updated_at_ms = Date.now();
}

export function buildRedlineFastPathDiagnosticsText(sessionId: string): string {
  const state = getRedlineFastPathState(sessionId);
  const phaseOrder: RedlineFastPathPhase[] = [
    "request_accepted",
    "preflight_start",
    "preflight_end",
    "vision_start",
    "vision_end",
    "planner_start",
    "planner_end",
    "first_revit_action_emitted",
    "first_revit_action_completed",
    "blocked"
  ];
  const lines: string[] = [];
  const times = phaseOrder
    .map((phase) => {
      const ts = state.phases[phase];
      return ts ? `${phase}=${ts}` : null;
    })
    .filter((row): row is string => !!row);
  if (times.length > 0) lines.push(`phases: ${times.join(" | ")}`);
  if (state.blocked_reason) lines.push(`blocked_reason=${state.blocked_reason}`);
  if (state.candidate_views_checked.length > 0) {
    lines.push(
      `candidate_views=${state.candidate_views_checked
        .map((row) => `${row.view_name}#${row.view_id}:${row.matched ? "match" : "miss"}:${row.confidence.toFixed(2)}`)
        .join(" | ")}`
    );
  }
  return lines.join("\n");
}
