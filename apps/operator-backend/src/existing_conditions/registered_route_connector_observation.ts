import { getAssignmentKernelSnapshotV2 } from "../assignments/assignment_kernel_v2_store.js";
import { readAuthoritativeEvidence, readEvidenceRef } from "../evidence/evidence_store.js";

type Binding = { session_id: string; assignment_id: string; run_id: string; generation: number };
type Dependencies = {
  snapshot?: typeof getAssignmentKernelSnapshotV2;
  read_ref?: typeof readEvidenceRef;
  read_payload?: typeof readAuthoritativeEvidence;
};

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function connectorReadback(payload: unknown): unknown {
  const root = object(payload);
  const candidates = [root, root.raw_payload, root.payload, root.native_result, root.result, root.data]
    .map(object)
    .filter(value => Array.isArray(value.results));
  const unique = new Map(candidates.map(value => [JSON.stringify(value.results), value]));
  if (unique.size !== 1) throw new Error("registered_route_snap_native_connector_readback_missing_or_ambiguous");
  return [...unique.values()][0];
}

export function loadRegisteredRouteConnectorObservationV1(
  binding: Binding,
  observationId: string,
  dependencies: Dependencies = {}
): unknown {
  if (!/^obsv2_[a-f0-9]{64}$/.test(observationId)) {
    throw new Error("registered_route_snap_connector_observation_id_invalid");
  }
  const snapshot = (dependencies.snapshot ?? getAssignmentKernelSnapshotV2)(binding.assignment_id);
  const current = snapshot?.current_binding;
  if (!snapshot || !current || current.session_id !== binding.session_id
      || current.assignment_id !== binding.assignment_id || current.run_id !== binding.run_id
      || current.generation !== binding.generation) {
    throw new Error("registered_route_snap_connector_assignment_binding_invalid");
  }
  const observation = snapshot.observations[observationId];
  if (!observation || !observation.raw_payload_ref.startsWith("evidence:")) {
    throw new Error("registered_route_snap_connector_observation_missing");
  }
  const operations = Object.values(snapshot.operations).filter(candidate =>
    candidate.observation_ids.includes(observationId)
  );
  if (operations.length !== 1) throw new Error("registered_route_snap_connector_operation_ambiguous");
  const operation = operations[0]!;
  if (operation.result?.status !== "succeeded" || operation.result.persistent_effect !== "none"
      || operation.result.request_identity?.method !== "POST"
      || operation.result.request_identity?.path !== "/revit/get-connectors") {
    throw new Error("registered_route_snap_connector_operation_invalid");
  }
  const evidenceId = observation.raw_payload_ref.slice("evidence:".length);
  const ref = (dependencies.read_ref ?? readEvidenceRef)(evidenceId);
  if (ref.evidence_id !== evidenceId || ref.trust_level !== "authoritative_native" || ref.session_id !== binding.session_id
      || ref.assignment_id !== binding.assignment_id || ref.run_id !== binding.run_id
      || ref.generation !== binding.generation) {
    throw new Error("registered_route_snap_connector_evidence_scope_invalid");
  }
  const raw = (dependencies.read_payload ?? readAuthoritativeEvidence)(ref, {
    ...binding, attempt_id: operation.operation_id
  });
  return connectorReadback(JSON.parse(raw.toString("utf8")));
}
