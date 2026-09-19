import type http from "node:http";
import { activeProviderTurnForBinding, interruptActiveProviderForBinding } from "../codex/active_turns.js";
import { assignmentDirections, steerAssignment } from "./task_steering.js";
import { listTaskNavigationAsync } from "./task_navigation.js";
import { manageAssignmentWorkPlan } from "./assignment_work_plan.js";
import { controlAssignmentExecutionV2 } from "./assignment_kernel_v2_controls.js";
import { recoverRetainedAssignmentCompletionsV2 } from "./assignment_kernel_v2_completion_recovery.js";
import { assignmentKernelSessionIndexResponseV2 } from "@revitoperator/assignment-kernel-v2-contracts";
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
  supplyAssignmentInputResultV2,
  type AssignmentKernelBindingInputV2
} from "./assignment_kernel_v2_lifecycle.js";
import { getAssignmentKernelSnapshotV2 } from "./assignment_kernel_v2_store.js";
import {
  leaseFromOperation,
  markAssignmentKernelOperationDispatchStartedV2,
  openAssignmentKernelChildOperationV2,
  settleAssignmentKernelOperationV2
} from "./assignment_kernel_v2_execution.js";
import { sameAssignmentBindingV2, type AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";
import { getRequestAssignmentPrincipalId, requestMatchesAssignmentPrincipalId } from "../request_context.js";
import { getAssignmentKernelPublicationV2, listAssignmentKernelSessionIndexV2 } from "./assignment_kernel_v2_publication.js";

type JsonMap = Record<string, unknown>;

function v2Binding(body: JsonMap | null): AssignmentKernelBindingInputV2 {
  const session_id = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 180) : "";
  const assignment_id = typeof body?.assignment_id === "string" ? body.assignment_id.trim().slice(0, 240) : "";
  const run_id = typeof body?.run_id === "string" ? body.run_id.trim().slice(0, 240) : "";
  const generation = typeof body?.generation === "number" && Number.isInteger(body.generation) ? body.generation : 0;
  if (!session_id || !assignment_id || !run_id || generation < 1) throw new Error("assignment_kernel_v2_binding_required");
  return { session_id, assignment_id, run_id, generation };
}

function v2PrincipalAllowed(snapshot: Pick<AssignmentSnapshotV2, "current_binding"> | null | undefined): boolean {
  return Boolean(snapshot && requestMatchesAssignmentPrincipalId(
    snapshot.current_binding.principal_id,
    undefined,
    snapshot.current_binding.session_id
  ));
}

function requireV2Principal(snapshot: Pick<AssignmentSnapshotV2, "current_binding"> | null | undefined): void {
  if (!v2PrincipalAllowed(snapshot)) throw new Error("assignment_kernel_v2_foreign_principal");
}

export async function handleAssignmentHttpRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  authorizeSession: (sessionId: string) => boolean
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/task-navigation") {
    if (!getRequestAssignmentPrincipalId()) { writeJson(res, 403, { error: "Task navigation requires an authenticated principal." }); return true; }
    if (url.searchParams.get("stream") === "1") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
      try {
        let lastSentAt = 0;
        const result = await listTaskNavigationAsync(Number(url.searchParams.get("limit") ?? 100), page => {
          if (res.destroyed) return false;
          if (Date.now() - lastSentAt < 500) return true;
          lastSentAt = Date.now();
          res.write(JSON.stringify(page) + "\n"); return true;
        });
        if (!res.destroyed) res.end(JSON.stringify(result) + "\n");
      } catch { if (!res.destroyed) res.end(JSON.stringify({ error: "Task history is temporarily unavailable." }) + "\n"); }
      return true;
    }
    try { writeJson(res, 200, await listTaskNavigationAsync(Number(url.searchParams.get("limit") ?? 100))); }
    catch { writeJson(res, 503, { error: "Task history is temporarily unavailable." }); }
    return true;
  }
  if (handleVerifiedWorkPacketHttpRoute(req, res, url, authorizeSession)) return true;
  if (handleWorkReturnHttpRoute(req, res, url, authorizeSession)) return true;
  if (req.method === "POST" && ["/api/assignments/v2/turn-control", "/api/assignments/v2/steer"].includes(url.pathname)) {
    try {
      const body = await readJson(req, 24_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      if (url.pathname.endsWith("/steer")) {
        const receipt = await steerAssignment({ binding, command_id: body?.command_id as string,
          text: body?.text as string, expected_turn_id: body?.expected_turn_id as string | null });
        writeJson(res, 200, { ok: true, receipt });
      } else {
        const snapshot = getAssignmentKernelSnapshotV2(binding.assignment_id)!;
        if (snapshot.current_binding.run_id !== binding.run_id || snapshot.current_binding.generation !== binding.generation
          || snapshot.current_binding.session_id !== binding.session_id) throw new Error("The task binding changed.");
        const turn = activeProviderTurnForBinding(binding);
        writeJson(res, 200, { ok: true, active_turn: turn ? { turn_id: turn.turnId, message_id: turn.messageId,
          interruption_requested: turn.interruptionRequested() } : null, directions: assignmentDirections(binding) });
      }
    } catch (error) { writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/recover-completions") {
    try {
      const body = await readJson(req, 16_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      const recovered = recoverRetainedAssignmentCompletionsV2(binding);
      writeJson(res, 200, { ok: true, assignment_snapshot_v2: recovered.snapshot,
        recovered_operation_ids: recovered.recovered_operation_ids,
        unresolved_operation_ids: recovered.unresolved_operation_ids });
    } catch (error) {
      writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/execution-control") {
    try {
      const body = await readJson(req, 16_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      const snapshot = controlAssignmentExecutionV2({
        binding, command_id: body?.command_id as string,
        expected_command_id: body?.expected_command_id as string | null,
        action: body?.action as "pause" | "resume"
      });
      // Save the native admission fence first. Interrupting the model cannot
      // undo or erase any Revit call that has already been dispatched.
      let provider_interrupt: "not_requested" | "accepted" | "no_active_turn" | "unconfirmed" = "not_requested";
      if (body?.action === "pause") {
        try { provider_interrupt = await interruptActiveProviderForBinding(binding) ? "accepted" : "no_active_turn"; }
        catch { provider_interrupt = "unconfirmed"; }
      }
      writeJson(res, 200, { ok: true, assignment_snapshot_v2: getAssignmentKernelSnapshotV2(binding.assignment_id) ?? snapshot, provider_interrupt });
    } catch (error) {
      writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/assignments/v2") {
    const sessionId = (url.searchParams.get("session_id") ?? "").trim().slice(0, 180);
    if (!sessionId) {
      writeJson(res, 400, { error: "session_id is required." });
      return true;
    }
    if (!authorizeSession(sessionId)) return true;
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
    const index = listAssignmentKernelSessionIndexV2(sessionId, limit);
    writeJson(res, 200, assignmentKernelSessionIndexResponseV2({
      ...index,
      assignments: index.assignments.filter(entry => requestMatchesAssignmentPrincipalId(
        entry.binding.principal_id,
        undefined,
        entry.binding.session_id
      ))
    }));
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/assignments/v2/")
      && !url.pathname.startsWith("/api/assignments/v2/operations/")
      && !url.pathname.startsWith("/api/assignments/v2/criteria/")) {
    const assignmentId = decodeURIComponent(url.pathname.slice("/api/assignments/v2/".length)).trim().slice(0, 240);
    const publication = assignmentId ? getAssignmentKernelPublicationV2(assignmentId) : null;
    if (!publication) {
      writeJson(res, assignmentId ? 404 : 400, { error: assignmentId ? "Assignment not found." : "assignment id is required." });
      return true;
    }
    if (!authorizeSession(publication.snapshot.current_binding.session_id)) return true;
    if (!v2PrincipalAllowed(publication.snapshot)) {
      writeJson(res, 403, { error: "Forbidden (Assignment belongs to another principal)." });
      return true;
    }
    writeJson(res, 200, { ok: true, assignment_kernel_v2: publication });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/operations/children") {
    try {
      const body = await readJson(req, 512_000) as JsonMap | null;
      const requested = v2Binding(body);
      if (!authorizeSession(requested.session_id)) return true;
      const snapshot = getAssignmentKernelSnapshotV2(requested.assignment_id);
      if (!snapshot || !v2PrincipalAllowed(snapshot) || snapshot.current_binding.run_id !== requested.run_id
          || snapshot.current_binding.generation !== requested.generation
          || snapshot.current_binding.session_id !== requested.session_id) {
        throw new Error("assignment_kernel_v2_binding_stale_or_mismatched");
      }
      const role = body?.operation_role === "prerequisite" ? "prerequisite"
        : body?.operation_role === "child" ? "child" : null;
      if (!role) throw new Error("assignment_kernel_v2_child_role_invalid");
      const method = String(body?.method ?? "").trim().toUpperCase();
      const fulfillmentRole = String(body?.fulfillment_role ?? "supporting_control").trim();
      if (!["supporting_control", "prerequisite", "delegated_task_execution", "verification", "reconciliation", "telemetry"].includes(fulfillmentRole)) {
        throw new Error("assignment_kernel_v2_fulfillment_role_invalid");
      }
      const lease = openAssignmentKernelChildOperationV2({
        binding: snapshot.current_binding,
        parent_operation_id: String(body?.parent_operation_id ?? "").trim(),
        child_ordinal: Number(body?.child_ordinal),
        operation_role: role,
        capability_id: String(body?.capability_id ?? "").trim(),
        classified_effect: String(body?.classified_effect ?? "read").trim(),
        ...(method === "GET" || method === "POST" ? { method } : {}),
        ...(typeof body?.path === "string" ? { path: body.path } : {}),
        arguments: body?.arguments ?? {},
        blocks_parent_settlement: body?.blocks_parent_settlement !== false,
        fulfillment_role: fulfillmentRole as "supporting_control" | "prerequisite" | "delegated_task_execution" | "verification" | "reconciliation" | "telemetry",
        ...(typeof body?.delegation_authority_id === "string" ? { delegation_authority_id: body.delegation_authority_id } : {}),
        eligible_criterion_ids: Array.isArray(body?.eligible_criterion_ids) ? body.eligible_criterion_ids.map(String) : []
      });
      writeJson(res, 201, {
        ok: true,
        operation_lease_v2: lease,
        assignment_snapshot_v2: getAssignmentKernelSnapshotV2(requested.assignment_id)
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/operations/dispatch") {
    try {
      const body = await readJson(req, 128_000) as JsonMap | null;
      const requested = v2Binding(body);
      if (!authorizeSession(requested.session_id)) return true;
      const snapshot = getAssignmentKernelSnapshotV2(requested.assignment_id);
      const operation = snapshot?.operations[String(body?.operation_id ?? "").trim()];
      if (!snapshot || !v2PrincipalAllowed(snapshot) || !operation || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
          || snapshot.current_binding.run_id !== requested.run_id
          || snapshot.current_binding.generation !== requested.generation
          || snapshot.current_binding.session_id !== requested.session_id) {
        throw new Error("assignment_kernel_v2_operation_binding_mismatch");
      }
      markAssignmentKernelOperationDispatchStartedV2(leaseFromOperation(operation));
      writeJson(res, 202, { ok: true, assignment_snapshot_v2: getAssignmentKernelSnapshotV2(requested.assignment_id) });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/operations/results") {
    try {
      const body = await readJson(req, 8 * 1024 * 1024) as JsonMap | null;
      const requested = v2Binding(body);
      if (!authorizeSession(requested.session_id)) return true;
      const snapshot = getAssignmentKernelSnapshotV2(requested.assignment_id);
      const operation = snapshot?.operations[String(body?.operation_id ?? "").trim()];
      if (!snapshot || !v2PrincipalAllowed(snapshot) || !operation || !sameAssignmentBindingV2(snapshot.current_binding, operation.binding)
          || snapshot.current_binding.run_id !== requested.run_id
          || snapshot.current_binding.generation !== requested.generation
          || snapshot.current_binding.session_id !== requested.session_id) {
        throw new Error("assignment_kernel_v2_operation_binding_mismatch");
      }
      const settled = settleAssignmentKernelOperationV2(leaseFromOperation(operation), body?.mcp_result);
      writeJson(res, 200, {
        ok: true,
        operation_id: operation.operation_id,
        evidence_refs: settled.evidence_refs,
        assignment_snapshot_v2: settled.snapshot
      });
    } catch (error) {
      writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/work-plan") {
    try {
      const body = await readJson(req, 256_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      const result = manageAssignmentWorkPlan({ binding, action: String(body?.action), declaration: body?.declaration as any,
        item_id: body?.item_id as string, operation_ids: body?.operation_ids as string[], start: body?.start as number,
        operation_start: body?.operation_start as number, assumption_start: body?.assumption_start as number });
      writeJson(res, 200, result);
    } catch (error) { writeJson(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/assignments/v2/criteria/evaluate") {
    try {
      const body = await readJson(req, 128_000) as JsonMap | null;
      const binding = v2Binding(body);
      if (!authorizeSession(binding.session_id)) return true;
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      const claims = Array.isArray(body?.claims) ? body.claims.map(item => {
        const row = item && typeof item === "object" && !Array.isArray(item) ? item as JsonMap : {};
        return {
          criterion_id: String(row.criterion_id ?? "").trim(),
          observation_ids: Array.isArray(row.observation_ids) ? row.observation_ids.map(String) : [],
          ...(row.basis === "desired_state_equivalence" ? { basis: "desired_state_equivalence" as const } : {})
        };
      }) : [];
      const snapshot = evaluateAssignmentObservationCriteriaV2({ binding, claims,
        ...(body?.result_items !== undefined ? { result_items: body.result_items as any } : {}),
        ...(body?.assessment !== undefined ? { assessment: body.assessment as any } : {}) });
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
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
      const snapshot = requestAssignmentInputV2({
        binding,
        clarification_id: String(body?.clarification_id ?? "").trim(),
        variable_ids: Array.isArray(body?.variable_ids) ? body.variable_ids.map(String) : [],
        ...(Array.isArray(body?.new_variable_ids) ? { new_variable_ids: body.new_variable_ids.map(String) } : {}),
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
      requireV2Principal(getAssignmentKernelSnapshotV2(binding.assignment_id));
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
        requireV2Principal(kernelSnapshot);
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
        const pending = variableIds.filter(id => snapshot.pending_input_variable_ids.includes(id));
        writeJson(res, pending.length ? 202 : 200, {
          ok: true, clarification_id: pending.length ? clarificationId : null,
          assignment_id: binding.assignment_id, run_id: binding.run_id, generation: binding.generation,
          already_resolved: pending.length === 0, pending_input_variable_ids: pending,
          authenticated_input_values: Object.fromEntries(variableIds
            .filter(id => Object.prototype.hasOwnProperty.call(snapshot.input_values, id))
            .map(id => [id, snapshot.input_values[id]]))
        });
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
        requireV2Principal(getAssignmentKernelSnapshotV2(assignmentId));
        const binding = v2Binding(body as unknown as JsonMap);
        const supplied = supplyAssignmentInputResultV2({
          binding,
          clarification_id: String(body?.clarification_id ?? "").trim(),
          external_values: body?.supplied_values && typeof body.supplied_values === "object" && !Array.isArray(body.supplied_values)
            ? body.supplied_values as JsonMap : {}
        });
        writeJson(res, 200, { ok: true, idempotent: supplied.idempotent, assignment_snapshot_v2: supplied.snapshot });
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
