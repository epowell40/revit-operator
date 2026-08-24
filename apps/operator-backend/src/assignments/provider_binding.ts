import { assignmentRunForBinding } from "./turn_journal.js";

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function requireProviderAssignmentBinding(
  value: unknown,
  boundary: string
): { sessionId: string; assignmentId: string; runId: string; generation: number } {
  const body = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const sessionId = boundedText(body.session_id ?? body.sessionId, 160);
  const assignmentId = boundedText(body.assignment_id ?? body.assignmentId, 240);
  const runId = boundedText(body.assignment_run_id ?? body.assignmentRunId, 240);
  const generation = body.assignment_generation ?? body.assignmentGeneration;
  if (!sessionId || !assignmentId || !runId || typeof generation !== "number"
      || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`${boundary}_assignment_binding_required`);
  }
  const bound = assignmentRunForBinding(sessionId, assignmentId, runId, generation);
  if (!bound) throw new Error(`${boundary}_assignment_binding_stale_or_mismatched`);
  return { sessionId, assignmentId, runId, generation };
}
