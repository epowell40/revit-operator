import type http from "node:http";
import { readJson, writeJson } from "../http.js";
import { handleVerifiedWorkPacketHttpRoute } from "../work_packets/http_routes.js";
import { handleWorkReturnHttpRoute } from "../work_returns/http_routes.js";
import { submitReadCompletionClaim, type ReadCompletionClaimInput } from "./read_completion.js";
import {
  requestAssignmentClarification,
  resolveAssignmentClarification,
  type AssignmentClarificationRequestInput,
  type AssignmentClarificationResponseInput
} from "./interaction.js";
import { submitNoopCompletionClaim, type NoopCompletionClaimInput } from "./noop_completion.js";
import { ASSIGNMENT_PROJECTION_SCHEMA, getAssignmentProjection, listAssignmentProjections } from "./projection.js";
import {
  evaluateAssignmentObservationCriteriaV2,
  requestAssignmentInputV2,
  supplyAssignmentInputV2,
  type AssignmentKernelBindingInputV2
} from "./assignment_kernel_v2_lifecycle.js";
import { getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";

type JsonMap = Record<string, unknown>;

function v2Binding(body: JsonMap | null): AssignmentKernelBindingInputV2 {
  const session_id = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
  const assignment_id = typeof body?.assignment_id === "string" ? body.assignment_id.trim().slice(0, 240) : "";
  const run_id = typeof body?.run_id === "string" ? body.run_id.trim().slice(0, 240) : "";
  const generation = typeof body?.generation === "number" && Number.isInteger(body.generation) ? body.generation : 0;
  if (!session_id || !assignment_id || !run_id || generation < 1) throw new Error("assignment_kernel_v2_binding_required");
  return { session_id, assignment_id, run_id, generation };
}

export async function handleAssignmentHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): Promise<boolean> {
  if (handleVerifiedWorkPacketHttpRoute(req, res, url, authorizeSession)) return true;
  if (handleWorkReturnHttpRoute(req, res, url, authorizeSession)) return true;
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/criteria/evaluate") {
    try {
      const body = await readJson(req, 128_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      const claims = Array.isArray(body?.claims) ? body.claims.map(item => {
        const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonMap : {};
        return {
          criterion_id: String(row.criterion_id ?? "").trim(),
          observation_ids: Array.isArray(row.observation_ids) ? row.observation_ids.map(String) : [],
          ...(row.basis === "desired_state_equivalence" ? { basis: "desired_state_equivalence" as const } : {})
        };
      }) : [];
      const snapshot = evaluateAssignmentObservationCriteriaV2({ binding, claims });
      writeJson(res, snapshot.terminal ? 200 : 202, { ok: true, assignment_snapshot_v2: snapshot });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/clarifications") {
    try {
      const body = await readJson(req, 128_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      const snapshot = requestAssignmentInputV2({
        binding,
        clarification_id: String(body?.clarification_id ?? "").trim(),
        variable_ids: Array.isArray(body?.variable_ids) ? body.variable_ids.map(String) : [],
        question: String(body?.question ?? "").trim()
      });
      writeJson(res, 202, { ok: true, assignment_snapshot_v2: snapshot });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/inputs") {
    try {
      const body = await readJson(req, 128_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      const externalValues = body?.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values as JsonMap : {};
      const snapshot = supplyAssignmentInputV2({
        binding,
        clarification_id: String(body?.clarification_id ?? "").trim(),
        external_values: externalValues
      });
      writeJson(res, 200, { ok: true, assignment_snapshot_v2: snapshot });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/clarifications") {
    try {
      const body = await readJson(req, 128_000) as AssignmentClarificationRequestInput | null;
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
      if (!sessionId) {
        writeJson(res, 400, { error: "session_id is required." });
        return true;
      }
      if (!authorizeSession(sessionId)) return true;
      const assignmentId = typeof body?.assignment_id === "string" ? body.assignment_id.trim() : "";
      const kernelSnapshot = assignmentId ? getAssignmentKernelSnapshotV2(assignmentId) : null;
      if (kernelSnapshot) {
        const binding = v2Binding(body as unknown as JsonMap);
        const variableIds = Array.isArray(body?.missing_fields) ? body.missing_fields.map(String) : [];
        const clarificationId = typeof body?.clarification_id === "string" && body.clarification_id.trim()
          ? body.clarification_id.trim()
          : `clarification:${kernelSnapshot.assignment_version + 1}:${variableIds.join(",")}`;
        const snapshot = requestAssignmentInputV2({
          binding,
          clarification_id: clarificationId,
          variable_ids: variableIds,
          question: String(body?.question ?? "").trim()
        });
        writeJson(res, 202, { ok: true, clarification_id: clarificationId, assignment_snapshot_v2: snapshot });
        return true;
      }
      const requested = requestAssignmentClarification(body!, "operator_request_clarification");
      writeJson(res, 202, {
        ok: true,
        clarification: requested.clarification,
        outcome_state: requested.projection.outcome_state,
        assignment_id: requested.projection.assignment_id,
        run_id: requested.projection.run_id,
        generation: requested.projection.generation
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/clarification-responses") {
    try {
      const body = await readJson(req, 128_000) as AssignmentClarificationResponseInput | null;
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
      if (!sessionId) {
        writeJson(res, 400, { error: "session_id is required." });
        return true;
      }
      if (!authorizeSession(sessionId)) return true;
      const assignmentId = typeof body?.assignment_id === "string" ? body.assignment_id.trim() : "";
      if (assignmentId && getAssignmentKernelSnapshotV2(assignmentId)) {
        const binding = v2Binding(body as unknown as JsonMap);
        const snapshot = supplyAssignmentInputV2({
          binding,
          clarification_id: String(body?.clarification_id ?? "").trim(),
          external_values: body?.supplied_values && typeof body.supplied_values === "object" && !Array.isArray(body.supplied_values)
            ? body.supplied_values as JsonMap : {}
        });
        writeJson(res, 200, { ok: true, idempotent: false, assignment_snapshot_v2: snapshot });
        return true;
      }
      const resolved = resolveAssignmentClarification(body!, "authenticated_user");
      writeJson(res, 200, {
        ok: true,
        clarification_id: resolved.clarification.clarification_id,
        response_digest: resolved.clarification.response_digest,
        idempotent: resolved.idempotent,
        outcome_state: resolved.projection.outcome_state,
        assignment_id: resolved.projection.assignment_id,
        run_id: resolved.projection.run_id,
        generation: resolved.projection.generation
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/read-completion-claims") {
    try {
      const body = await readJson(req, 128_000) as ReadCompletionClaimInput | null;
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
      if (!sessionId) {
        writeJson(res, 400, { error: "session_id is required." });
        return true;
      }
      if (!authorizeSession(sessionId)) return true;
      const assignmentId = typeof body?.assignment_id === "string" ? body.assignment_id.trim() : "";
      if (assignmentId && getAssignmentKernelSnapshotV2(assignmentId)) {
        writeJson(res, 409, { error: "assignment_kernel_v2_specialized_completion_forbidden", use: "operator_evaluate_assignment_criteria" });
        return true;
      }
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
  if (req.method === "POST" && url.pathname === "/api/assignments/noop-completion-claims") {
    try {
      const body = await readJson(req, 128_000) as NoopCompletionClaimInput | null;
      const sessionId = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
      if (!sessionId) {
        writeJson(res, 400, { error: "session_id is required." });
        return true;
      }
      if (!authorizeSession(sessionId)) return true;
      const assignmentId = typeof body?.assignment_id === "string" ? body.assignment_id.trim() : "";
      if (assignmentId && getAssignmentKernelSnapshotV2(assignmentId)) {
        writeJson(res, 409, { error: "assignment_kernel_v2_specialized_completion_forbidden", use: "operator_evaluate_assignment_criteria" });
        return true;
      }
      const submitted = submitNoopCompletionClaim(body!);
      writeJson(res, submitted.accepted ? 202 : 409, {
        ok: submitted.accepted,
        status: submitted.projection.noop_completion.status,
        reason: submitted.reason,
        assignment_id: submitted.projection.assignment_id,
        run_id: submitted.projection.run_id,
        generation: submitted.projection.generation
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
