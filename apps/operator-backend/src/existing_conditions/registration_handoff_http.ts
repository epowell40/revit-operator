import type http from "node:http";
import { requireProviderAssignmentBinding } from "../assignments/provider_binding.js";
import { readJson, writeJson } from "../http.js";
import type { RequestPrincipal } from "../request_context.js";
import { handoffExistingConditionsRegistrationV1 } from "./registration_handoff.js";

export const EXISTING_CONDITIONS_REGISTRATION_HANDOFF_PATH = "/tools/existing-conditions/resume-registration";
type SessionAccessGuard = (res: http.ServerResponse, sessionId: string, principal: RequestPrincipal | undefined) => boolean;

export async function handleExistingConditionsRegistrationHandoffHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  principal: RequestPrincipal | undefined,
  sessionAccessAllowed: SessionAccessGuard
): Promise<boolean> {
  if (req.method !== "POST" || pathname !== EXISTING_CONDITIONS_REGISTRATION_HANDOFF_PATH) return false;
  const body = await readJson(req) as Record<string, unknown>;
  const bound = requireProviderAssignmentBinding(body, "existing_conditions_registration_handoff");
  if (!sessionAccessAllowed(res, bound.sessionId, principal)) return true;
  try {
    const result = handoffExistingConditionsRegistrationV1(
      { session_id: bound.sessionId, assignment_id: bound.assignmentId, run_id: bound.runId, generation: bound.generation },
      String(body.origin_registration_evidence_id ?? ""),
      String(body.current_landmark_observation_id ?? "")
    );
    writeJson(res, 200, { status: "registered_for_current_assignment", ...result });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
