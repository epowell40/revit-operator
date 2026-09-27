import type http from "node:http";
import { requireProviderAssignmentBinding } from "../assignments/provider_binding.js";
import { readJson, writeJson } from "../http.js";
import type { RequestPrincipal } from "../request_context.js";
import { loadRegisteredRouteSourceEvidenceV1 } from "./registered_route_evidence.js";
import {
  buildNextExistingConditionsStagePlan,
  latestExistingConditionsStagedWorkflow,
  recordExistingConditionsStageResult
} from "./staged_repair_ledger.js";
import { canonicalExistingConditionsLedgerJson } from "./repair_ledger_store.js";

const AUTHORIZE_PATH = "/tools/existing-conditions/authorize-registered-stage";
const RECORD_PATH = "/tools/existing-conditions/record-registered-stage";
const RESOLVE_PATH = "/tools/existing-conditions/resolve-registered-stage";
type SessionAccessGuard = (res: http.ServerResponse, sessionId: string, principal: RequestPrincipal | undefined) => boolean;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function exactRegisteredStage(sessionId: string, binding: {
  session_id: string; assignment_id: string; run_id: string; generation: number;
}) {
  const registered = latestExistingConditionsStagedWorkflow(sessionId);
  if (!registered || registered.execution_boundary !== "staged_execution") {
    throw new Error("registered_existing_conditions_stage_missing");
  }
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(registered.registration_context_id)) {
    throw new Error("registered_existing_conditions_source_evidence_required");
  }
  const source = loadRegisteredRouteSourceEvidenceV1(binding, registered.registration_context_id);
  if (source.interpretation.frame_observation_id !== registered.source_frame_id
      || source.interpretation.native_view_id !== registered.source_view_id) {
    throw new Error("registered_existing_conditions_source_scope_changed");
  }
  return registered;
}

type StageBinding = { session_id: string; assignment_id: string; run_id: string; generation: number };

/** Resolve a compact model-selected stage before operation admission, so a
 * corrected registered plan has its own canonical operation identity. */
export function expandExactRegisteredStageToolArguments(
  value: Record<string, unknown>, binding: StageBinding,
  lookup: typeof exactRegisteredStage = exactRegisteredStage
): Record<string, unknown> {
  if (value.method !== "POST" || value.path !== "/revit/existing-conditions-mep-draft-workflow") return value;
  const body = object(value.body);
  if (!Object.hasOwn(body, "registered_stage_key")) return value;
  const phase = body.stage_phase;
  if (Object.keys(body).sort().join(",") !== "dryRun,registered_stage_key,stage_phase"
      || typeof body.registered_stage_key !== "string" || !body.registered_stage_key.trim()
      || (phase !== "dry_run" && phase !== "apply")
      || body.dryRun !== (phase === "dry_run")) {
    throw new Error("registered_existing_conditions_stage_reference_invalid");
  }
  const registered = lookup(binding.session_id, binding);
  const plan = resolveExactRegisteredStageReference(
    binding.session_id, registered.workflow, body.registered_stage_key, phase
  );
  return { ...value, body: plan.request };
}

export function authorizeExactRegisteredStageRequest(
  sessionId: string,
  workflow: NonNullable<ReturnType<typeof latestExistingConditionsStagedWorkflow>>["workflow"],
  proposedBody: unknown
) {
  const plan = buildNextExistingConditionsStagePlan({ sessionId, workflow });
  if (plan.state !== "dry_run" && plan.state !== "apply") {
    throw new Error(`registered_existing_conditions_stage_not_dispatchable:${plan.state}`);
  }
  if (canonicalExistingConditionsLedgerJson(plan.request)
      !== canonicalExistingConditionsLedgerJson(proposedBody)) {
    throw new Error("registered_existing_conditions_stage_body_mismatch");
  }
  return plan;
}

export function resolveExactRegisteredStageReference(
  sessionId: string,
  workflow: NonNullable<ReturnType<typeof latestExistingConditionsStagedWorkflow>>["workflow"],
  stageKey: string,
  phase: string
) {
  const plan = buildNextExistingConditionsStagePlan({ sessionId, workflow });
  if ((plan.state !== "dry_run" && plan.state !== "apply")
      || plan.stage_key !== stageKey || plan.state !== phase) {
    throw new Error("registered_existing_conditions_stage_reference_mismatch");
  }
  return plan;
}

export async function handleRegisteredStageHandoffHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  principal: RequestPrincipal | undefined,
  sessionAccessAllowed: SessionAccessGuard
): Promise<boolean> {
  if (req.method !== "POST" || (pathname !== AUTHORIZE_PATH && pathname !== RECORD_PATH && pathname !== RESOLVE_PATH)) return false;
  const body = object(await readJson(req));
  const bound = requireProviderAssignmentBinding(body, "registered_existing_conditions_stage");
  if (!sessionAccessAllowed(res, bound.sessionId, principal)) return true;
  try {
    if (bound.kernelVersion !== 2) throw new Error("registered_existing_conditions_stage_v2_binding_required");
    const binding = {
      session_id: bound.sessionId, assignment_id: bound.assignmentId,
      run_id: bound.runId, generation: bound.generation
    };
    const registered = exactRegisteredStage(bound.sessionId, binding);
    if (pathname === RESOLVE_PATH) {
      const plan = resolveExactRegisteredStageReference(
        bound.sessionId, registered.workflow,
        String(body.registered_stage_key ?? ""), String(body.stage_phase ?? "")
      );
      writeJson(res, 200, { stage_key: plan.stage_key, phase: plan.state, native_body: plan.request });
      return true;
    }
    const proposedBody = body.native_body;
    const plan = authorizeExactRegisteredStageRequest(bound.sessionId, registered.workflow, proposedBody);
    if (pathname === AUTHORIZE_PATH) {
      writeJson(res, 200, { authorized: true, stage_key: plan.stage_key, phase: plan.state });
      return true;
    }
    const result = object(body.native_result);
    if (result.stageKey !== plan.stage_key
        || result.inputFingerprintSha256 !== registered.workflow.inputFingerprintSha256
        || result.dryRun !== (plan.state === "dry_run")) {
      throw new Error("registered_existing_conditions_stage_result_mismatch");
    }
    const recorded = recordExistingConditionsStageResult({
      sessionId: bound.sessionId, workflow: registered.workflow, result
    });
    if (!recorded) throw new Error("registered_existing_conditions_stage_result_not_recorded");
    const next = buildNextExistingConditionsStagePlan({
      sessionId: bound.sessionId, workflow: registered.workflow
    });
    writeJson(res, 200, {
      recorded: true, event: recorded.event, status: recorded.status,
      stage_key: plan.stage_key,
      next_stage: next
    });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
