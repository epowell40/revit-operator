type JsonMap = Record<string, unknown>;

export type CanonicalAssignmentToolBinding = {
  session_id: string;
  assignment_id: string;
  run_id: string;
  generation: number;
};

export type BoundAssignmentToolArguments = {
  arguments: JsonMap;
  corrected_fields: string[];
};

const ASSIGNMENT_SCOPED_TOOLS = new Set([
  "operator_request_clarification",
  "operator_submit_noop_completion",
  "operator_submit_read_completion",
  "operator_retrieve_evidence"
]);

function object(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

/**
 * Lifecycle identity is host-owned. The model selects the operation and its
 * task arguments, but it cannot select, infer, or carry Assignment scope.
 * Injecting the captured canonical binding before lease creation keeps the
 * action signature, authorization check, evidence scope, and eventual result
 * on one immutable Assignment/run/generation.
 */
export function bindCanonicalAssignmentToolArguments(
  tool: string,
  value: unknown,
  binding: CanonicalAssignmentToolBinding
): BoundAssignmentToolArguments {
  const original = object(value);
  if (!ASSIGNMENT_SCOPED_TOOLS.has(tool)) return { arguments: original, corrected_fields: [] };
  const canonical: JsonMap = {
    assignmentId: binding.assignment_id,
    runId: binding.run_id,
    generation: binding.generation,
    sessionId: binding.session_id
  };
  const correctedFields = Object.entries(canonical).flatMap(([field, expected]) => (
    Object.hasOwn(original, field) && original[field] !== expected ? [field] : []
  ));
  return {
    arguments: { ...original, ...canonical },
    corrected_fields: correctedFields
  };
}
