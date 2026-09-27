import type http from "node:http";
import { requireProviderAssignmentBinding } from "../assignments/provider_binding.js";
import { storeEvidence } from "../evidence/evidence_store.js";
import { readJson, writeJson } from "../http.js";
import type { RequestPrincipal } from "../request_context.js";
import {
  registerStructuredExistingConditionsInterpretationV1,
  summarizeRegisteredStructuredExistingConditionsInterpretationV1
} from "./registered_structured_interpretation.js";
import {
  summarizeExistingConditionsStructuredInterpretationV1,
  validateExistingConditionsStructuredInterpretationV1
} from "./structured_interpretation_tool.js";

type SessionAccessGuard = (
  res: http.ServerResponse,
  sessionId: string,
  principal: RequestPrincipal | undefined
) => boolean;

export async function handleStructuredExistingConditionsInterpretationHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  principal: RequestPrincipal | undefined,
  sessionAccessAllowed: SessionAccessGuard
): Promise<boolean> {
  const validation = pathname === "/tools/existing-conditions/validate-interpretation";
  const registration = pathname === "/tools/existing-conditions/register-interpretation";
  if (req.method !== "POST" || (!validation && !registration)) return false;
  const body = await readJson(req);
  const boundary = validation ? "existing_conditions_interpretation" : "existing_conditions_registration";
  const bound = requireProviderAssignmentBinding(body, boundary);
  if (!sessionAccessAllowed(res, bound.sessionId, principal)) return true;
  try {
    if (validation) {
      const result = await validateExistingConditionsStructuredInterpretationV1({
        ...(body as any), schema_version: 1, session_id: bound.sessionId
      });
      const stored = storeEvidence({
        scope: {
          session_id: bound.sessionId,
          assignment_id: bound.assignmentId,
          run_id: bound.runId,
          generation: bound.generation,
          attempt_id: `interpretation-${String((body as any)?.package_id ?? "package").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 180)}`
        },
        source: "existing_conditions_structured_interpretation",
        trust_level: "host_observed",
        verification_relevance: "supporting",
        target_scope: [`existing-conditions:${String((body as any)?.package_id ?? "package").slice(0, 120)}`],
        bounded_summary: `Validated source-bound existing-conditions interpretation for ${String((body as any)?.package_id ?? "package").slice(0, 120)}.`,
        raw: result
      });
      writeJson(res, 200, summarizeExistingConditionsStructuredInterpretationV1(result, {
        evidence_id: stored.ref.evidence_id,
        content_hash: stored.ref.content_hash,
        trust_level: stored.ref.trust_level,
        verification_relevance: stored.ref.verification_relevance
      }));
      return true;
    }
    const result = registerStructuredExistingConditionsInterpretationV1({
      ...(body as any),
      schema_version: 1,
      session_id: bound.sessionId,
      assignment_id: bound.assignmentId,
      run_id: bound.runId,
      generation: bound.generation
    });
    const stored = storeEvidence({
      scope: {
        session_id: bound.sessionId,
        assignment_id: bound.assignmentId,
        run_id: bound.runId,
        generation: bound.generation,
        attempt_id: `registration-${String((body as any)?.interpretation_evidence_id ?? "interpretation").replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 180)}`
      },
      source: "existing_conditions_registered_interpretation",
      trust_level: "host_observed",
      verification_relevance: "supporting",
      target_scope: [`existing-conditions-registration:${String((body as any)?.interpretation_evidence_id ?? "interpretation").slice(0, 120)}`],
      bounded_summary: "Registered source-bound existing-conditions geometry to an authoritative Revit view frame.",
      relationships: [
        { evidence_id: result.interpretation_evidence_id, relation: "derived_from" },
        { evidence_id: result.frame_evidence_id, relation: "derived_from" },
        { evidence_id: result.landmark_evidence_id, relation: "derived_from" }
      ],
      raw: result
    });
    writeJson(res, 200, summarizeRegisteredStructuredExistingConditionsInterpretationV1(result, {
      evidence_id: stored.ref.evidence_id,
      content_hash: stored.ref.content_hash,
      trust_level: stored.ref.trust_level,
      verification_relevance: stored.ref.verification_relevance
    }));
  } catch (error) {
    writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
