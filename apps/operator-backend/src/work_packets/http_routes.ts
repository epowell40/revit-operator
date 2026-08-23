import type http from "node:http";
import { getGoal } from "../goals/service.js";
import { writeJson } from "../http.js";
import { renderVerifiedWorkPacketMarkdown } from "./renderer.js";
import { readLatestVerifiedWorkPacket } from "./store.js";

export function handleVerifiedWorkPacketHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): boolean {
  const match = url.pathname.match(/^\/api\/assignments\/([^/]+)\/verified-work-packet$/);
  if (req.method !== "GET" || !match) return false;
  const assignmentId = decodeURIComponent(match[1] || "").trim().replace(/^goal:/, "").slice(0, 240);
  if (!assignmentId) {
    writeJson(res, 400, { error: "assignment id is required." });
    return true;
  }
  const goal = getGoal(assignmentId);
  if (!goal) {
    writeJson(res, 404, { error: "Assignment not found." });
    return true;
  }
  if (goal.related_session_id && !authorizeSession(goal.related_session_id)) return true;
  try {
    const persisted = readLatestVerifiedWorkPacket(goal);
    if (url.searchParams.get("format") === "markdown") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/markdown; charset=utf-8");
      res.setHeader("cache-control", "private, no-store");
      res.end(renderVerifiedWorkPacketMarkdown(persisted.packet));
      return true;
    }
    writeJson(res, 200, { ok: true, ...persisted });
  } catch (error) {
    writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
