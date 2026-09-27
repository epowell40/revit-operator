import type http from "node:http";
import { requireProviderAssignmentBinding } from "../assignments/provider_binding.js";
import { readJson, writeJson } from "../http.js";
import type { RequestPrincipal } from "../request_context.js";
import { loadRegisteredRouteSourceEvidenceV1 } from "./registered_route_evidence.js";
import { loadRegisteredRouteConnectorObservationV1 } from "./registered_route_connector_observation.js";
import { planRegisteredExistingDuctBranchV1 } from "./registered_duct_branch.js";
import { buildNextExistingConditionsStagePlan, registerExistingConditionsStagedWorkflow } from "./staged_repair_ledger.js";

const PATH = "/tools/existing-conditions/plan-duct-branch";
type SessionAccessGuard = (res: http.ServerResponse, sessionId: string, principal: RequestPrincipal | undefined) => boolean;
function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export async function handleRegisteredDuctBranchPlanHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  principal: RequestPrincipal | undefined,
  sessionAccessAllowed: SessionAccessGuard
): Promise<boolean> {
  if (req.method !== "POST" || pathname !== PATH) return false;
  const body = object(await readJson(req));
  const bound = requireProviderAssignmentBinding(body, "existing_conditions_duct_branch");
  if (!sessionAccessAllowed(res, bound.sessionId, principal)) return true;
  try {
    const binding = { session_id: bound.sessionId, assignment_id: bound.assignmentId,
      run_id: bound.runId, generation: bound.generation };
    const evidenceId = String(body.registration_evidence_id ?? "").trim();
    const source = loadRegisteredRouteSourceEvidenceV1(binding, evidenceId);
    const mainReadback = loadRegisteredRouteConnectorObservationV1(binding, String(body.main_connector_observation_id ?? "").trim());
    const planned = planRegisteredExistingDuctBranchV1({
      registered: source.interpretation,
      registration_sha256: source.sha256,
      registration_evidence_id: evidenceId,
      primitive_id: String(body.primitive_id ?? "").trim(),
      main_connector_readback: mainReadback as Parameters<typeof planRegisteredExistingDuctBranchV1>[0]["main_connector_readback"],
      mapping: object(body.native_mapping) as any
    });
    registerExistingConditionsStagedWorkflow({
      sessionId: binding.session_id,
      sourceFrameId: source.interpretation.frame_observation_id,
      sourceViewId: source.interpretation.native_view_id,
      registrationContextId: evidenceId,
      executionBoundary: "staged_execution",
      workflow: planned.workflow
    });
    const next = buildNextExistingConditionsStagePlan({ sessionId: binding.session_id, workflow: planned.workflow });
    if (next.state !== "dry_run") throw new Error("registered_branch_initial_stage_not_dry_run");
    writeJson(res, 200, {
      status: "registered_for_staged_dry_run", revit_write_performed: false,
      registration_evidence_id: evidenceId,
      main_connector_observation_id: body.main_connector_observation_id,
      main_readback_sha256: planned.main_readback_sha256,
      source_mark_ids: planned.source_mark_ids,
      workflow: planned.workflow,
      next_stage_request: next.request,
      next_stage_key: next.stage_key
    });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
