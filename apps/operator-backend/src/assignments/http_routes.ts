import type http from "node:http";
import { writeJson } from "../http.js";
import { handleVerifiedWorkPacketHttpRoute } from "../work_packets/http_routes.js";
import { ASSIGNMENT_PROJECTION_SCHEMA, getAssignmentProjection, listAssignmentProjections } from "./projection.js";

export function handleAssignmentHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): boolean {
  if (handleVerifiedWorkPacketHttpRoute(req, res, url, authorizeSession)) return true;
  if (req.method === "GET" && url.pathname === "/api/assignments") {
    const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const sessionId = (url.searchParams.get("session_id") || "").trim().slice(0, 160);
    const lifecycle = (url.searchParams.get("lifecycle") || "").trim().slice(0, 80);
    if (sessionId && !authorizeSession(sessionId)) return true;
    const assignments = listAssignmentProjections({ limit, session_id: sessionId || undefined, lifecycle: lifecycle || undefined });
    writeJson(res, 200, { ok: true, schema: ASSIGNMENT_PROJECTION_SCHEMA, assignments });
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/assignments/")) {
    const assignmentId = decodeURIComponent(url.pathname.slice("/api/assignments/".length)).trim().slice(0, 240);
    if (!assignmentId) {
      writeJson(res, 400, { error: "assignment id is required." });
      return true;
    }
    const assignment = getAssignmentProjection(assignmentId);
    if (!assignment) {
      writeJson(res, 404, { error: "Assignment not found." });
      return true;
    }
    if (assignment.target.session_id && !authorizeSession(assignment.target.session_id)) return true;
    writeJson(res, 200, { ok: true, schema: ASSIGNMENT_PROJECTION_SCHEMA, assignment });
    return true;
  }
  return false;
}
