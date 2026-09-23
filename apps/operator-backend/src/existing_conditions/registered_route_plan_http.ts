import type http from "node:http";
import { requireProviderAssignmentBinding } from "../assignments/provider_binding.js";
import { readJson, writeJson } from "../http.js";
import type { RequestPrincipal } from "../request_context.js";
import { loadRegisteredRouteSourceEvidenceV1 } from "./registered_route_evidence.js";
import type { RegisteredStructuredExistingConditionsInterpretationV1 } from "./registered_structured_interpretation.js";
import { loadRegisteredRouteConnectorObservationV1 } from "./registered_route_connector_observation.js";
import {
  buildRegisteredRouteSnapStagedWorkflowV1,
  planRegisteredRouteConnectorSnapV1,
  type RegisteredRouteSnapCandidateV1
} from "./registered_route_connector_snap.js";
import { registerExistingConditionsStagedWorkflow } from "./staged_repair_ledger.js";

const PATH = "/tools/existing-conditions/plan-duct-continuation";
type SessionAccessGuard = (res: http.ServerResponse, sessionId: string, principal: RequestPrincipal | undefined) => boolean;

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function compileRegisteredDuctContinuationPlanV1(
  input: unknown,
  registered: RegisteredStructuredExistingConditionsInterpretationV1,
  registrationSha256: string,
  connectorReadback: unknown
) {
  const body = object(input);
  const evidenceId = String(body.registration_evidence_id ?? "").trim();
  const primitiveId = String(body.primitive_id ?? "").trim();
  const matches = registered.registered_primitives.filter(value => value.primitive_id === primitiveId);
  if (matches.length !== 1) throw new Error("registered_route_snap_source_primitive_missing_or_ambiguous");
  const primitive = matches[0]!;
  const mapping = object(body.native_mapping);
  const candidate: RegisteredRouteSnapCandidateV1 = {
    schema_version: 1,
    package_id: registered.package_id,
    primitive_id: primitiveId,
    source_interpretation_sha256: registered.registration.source_evidence_sha256,
    registration_receipt_sha256: registrationSha256,
    raster_evidence_receipt_sha256: primitive.source_artifact_sha256,
    kind: "duct",
    points: primitive.model_points,
    view_id: registered.native_view_id,
    level_name: mapping.level_name,
    elevation_z_ft: mapping.elevation_z_ft,
    system_type: mapping.system_type,
    route_type_name: mapping.route_type_name,
    route_type_id: mapping.route_type_id,
    shape: mapping.shape,
    size: mapping.size,
    required_existing_endpoint: body.required_existing_endpoint,
    registration_evidence_id: evidenceId,
    deferred_far_end_reason: body.deferred_far_end_reason,
    source_frame_id: registered.frame_observation_id,
    registration_context_id: evidenceId
  };
  const receipt = planRegisteredRouteConnectorSnapV1(candidate, {
    native_connector_readback: connectorReadback,
    registered_interpretation: registered,
    registered_interpretation_sha256: registrationSha256
  });
  const workflow = receipt.status === "ready"
    ? buildRegisteredRouteSnapStagedWorkflowV1(candidate, receipt)
    : null;
  return { candidate, receipt, workflow, source_mark_ids: primitive.source_mark_ids };
}

export async function handleRegisteredDuctContinuationPlanHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  principal: RequestPrincipal | undefined,
  sessionAccessAllowed: SessionAccessGuard
): Promise<boolean> {
  if (req.method !== "POST" || pathname !== PATH) return false;
  const body = object(await readJson(req));
  const bound = requireProviderAssignmentBinding(body, "existing_conditions_route_continuation");
  if (!sessionAccessAllowed(res, bound.sessionId, principal)) return true;
  try {
    const binding = {
      session_id: bound.sessionId, assignment_id: bound.assignmentId,
      run_id: bound.runId, generation: bound.generation
    };
    const evidenceId = String(body.registration_evidence_id ?? "").trim();
    const source = loadRegisteredRouteSourceEvidenceV1(binding, evidenceId);
    const registered = source.interpretation;
    const connectorReadback = loadRegisteredRouteConnectorObservationV1(
      binding, String(body.connector_observation_id ?? "").trim()
    );
    const { receipt, workflow, source_mark_ids } = compileRegisteredDuctContinuationPlanV1(
      body, registered, source.sha256, connectorReadback
    );
    if (receipt.status !== "ready") {
      writeJson(res, 200, { status: "deferred", blockers: receipt.blockers, snap_receipt: receipt });
      return true;
    }
    if (!workflow) throw new Error("registered_route_snap_workflow_missing");
    registerExistingConditionsStagedWorkflow({
      sessionId: binding.session_id,
      sourceFrameId: registered.frame_observation_id,
      sourceViewId: registered.native_view_id,
      registrationContextId: evidenceId,
      executionBoundary: "staged_execution",
      workflow
    });
    writeJson(res, 200, {
      status: "registered_for_staged_dry_run",
      revit_write_performed: false,
      registration_evidence_id: evidenceId,
      connector_observation_id: body.connector_observation_id,
      source_mark_ids,
      snap_receipt: receipt,
      workflow
    });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
