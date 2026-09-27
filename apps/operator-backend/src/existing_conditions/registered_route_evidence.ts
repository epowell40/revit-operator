import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";
import type { EvidenceRefV1 } from "../evidence/evidence_ref.js";
import type { RegisteredStructuredExistingConditionsInterpretationV1 } from "./registered_structured_interpretation.js";

type Binding = { session_id: string; assignment_id: string; run_id: string; generation: number };
type Dependencies = {
  read_ref?: (evidenceId: string) => EvidenceRefV1;
  read_payload?: (ref: EvidenceRefV1, scope: Binding & { attempt_id: string | null }) => Buffer;
};

export function loadRegisteredRouteSourceEvidenceV1(
  binding: Binding,
  evidenceId: string,
  dependencies: Dependencies = {}
): { interpretation: RegisteredStructuredExistingConditionsInterpretationV1; sha256: string } {
  if (!binding.session_id || !binding.assignment_id || !binding.run_id
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    throw new Error("registered_route_snap_assignment_binding_required");
  }
  if (!/^ev1_[A-Za-z0-9_-]{32}$/.test(evidenceId)) {
    throw new Error("registered_route_snap_registration_evidence_id_required");
  }
  const ref = (dependencies.read_ref ?? readEvidenceRef)(evidenceId);
  if (ref.evidence_id !== evidenceId
      || ref.source !== "existing_conditions_registered_interpretation"
      || ref.trust_level !== "host_observed"
      || ref.session_id !== binding.session_id
      || ref.assignment_id !== binding.assignment_id
      || ref.run_id !== binding.run_id
      || ref.generation !== binding.generation) {
    throw new Error("registered_route_snap_registration_evidence_scope_invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(ref.content_hash)) {
    throw new Error("registered_route_snap_registration_content_hash_invalid");
  }
  const payload = (dependencies.read_payload ?? readAuthoritativeEvidence)(ref, {
    ...binding, attempt_id: ref.attempt_id
  });
  return {
    interpretation: JSON.parse(payload.toString("utf8")) as RegisteredStructuredExistingConditionsInterpretationV1,
    sha256: ref.content_hash.slice("sha256:".length)
  };
}
