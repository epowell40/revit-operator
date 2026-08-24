import type http from "node:http";
import { readJson, writeJson } from "../http.js";
import { handleVerifiedWorkPacketHttpRoute } from "../work_packets/http_routes.js";
import { submitReadCompletionClaim, type ReadCompletionClaimInput } from "./read_completion.js";
import { ASSIGNMENT_PROJECTION_SCHEMA, getAssignmentProjection, listAssignmentProjections } from "./projection.js";

export async function handleAssignmentHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): Promise<boolean> {
  if (handleVerifiedWorkPacketHttpRoute(req, res, url, authorizeSession)) return true;
  if (req.method === "POST" && url.pathname === "/api/assignments/read-completion-claims") {
    try {
      const body = await readJson(req, 128_000) as ReadCompletionClaimInput | null;
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
      if (!sessionId) {
        writeJson(res, 400, { error: "session_id is required." });
        return true;
      }
      if (!authorizeSession(sessionId)) return true;
      const submitted = submitReadCompletionClaim(body ?? {}, "operator_submit_read_completion");
      writeJson(res, 202, {
        ok: true,
        claim_id: submitted.claim.claim_id,
        result_digest: submitted.claim.result_digest,
        status: submitted.projection.read_completion.status,
        note: "The claim is pending canonical validation at the next quiescent Assignment boundary."
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
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
