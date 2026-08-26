import type { AssignmentAttemptRecord } from "./control_plane.js";

type ScopedReadAssertion = {
  attempt_id: string;
  evidence_id: string;
  operation: "field_equals" | "array_count" | "group_count";
  path: string;
  group_by?: string[];
};

/**
 * Identifies the authoritative fact an assertion describes. Selector paths are
 * relative to one evidence object, so equal paths from different Revit target
 * scopes are not comparable. Repeated reads of the same target remain in the
 * same scope and incompatible expected values still fail closed.
 */
export function readCompletionAssertionComparisonKey(
  assertion: ScopedReadAssertion,
  attempts: AssignmentAttemptRecord[]
): string {
  const attempt = attempts.find(candidate => candidate.attempt_id === assertion.attempt_id);
  const sourceScope = attempt?.target_fingerprint
    ? `${attempt.action_path}:${attempt.tool_identity}:${attempt.target_fingerprint}`
    : `attempt:${assertion.attempt_id}:evidence:${assertion.evidence_id}`;
  const selector = assertion.operation === "group_count"
    ? `${assertion.path}:${JSON.stringify(assertion.group_by ?? [])}`
    : assertion.path;
  return `${sourceScope}:${assertion.operation}:${selector}`;
}
