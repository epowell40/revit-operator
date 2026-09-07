import type http from "node:http";
import { writeJson } from "../http.js";
import { readCodexInstructionTurns } from "../memory/sqlite_store.js";

export function respondWithInstructionBindings(url: URL, res: http.ServerResponse, authorizeSession: (sessionId: string) => boolean): void {
  const session_id = (url.searchParams.get("session_id") ?? "").trim();
  const started_at = (url.searchParams.get("started_at") ?? "").trim();
  if (!session_id || (started_at && (!Number.isFinite(Date.parse(started_at)) || new Date(started_at).toISOString() !== started_at))) {
    return writeJson(res, 400, { error: "session_id and an optional canonical ISO started_at are required." });
  }
  if (!authorizeSession(session_id)) return;
  res.setHeader("cache-control", "no-store");
  return writeJson(res, 200, { session_id, ...readCodexInstructionTurns(session_id, started_at) });
}
