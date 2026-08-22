type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** Benchmark-only interpretation of the generic production projection. */
export function canonicalAssignmentLifecycleTruth(assignment: JsonRecord): {
  canonical: boolean;
  outcome_unknown: boolean;
} {
  const truth = object(assignment.truth);
  const controlPlane = object(assignment.control_plane);
  return {
    canonical: String(controlPlane.schema || "").startsWith("revit-operator.assignment-control-plane-projection/"),
    outcome_unknown: truth.outcome_uncertain === true || truth.reconciliation_required === true
  };
}
