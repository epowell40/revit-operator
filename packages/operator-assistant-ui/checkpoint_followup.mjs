const bindingKeys = ["assignment_id", "session_id", "run_id", "generation"];

/** Read fences from the authenticated canonical publication, never a display badge.
 * This is a UI consistency check; the steering endpoint owns release eligibility. */
export function checkpointDirectionContext(publication, goal) {
  const snapshot = publication?.snapshot;
  const binding = goal?._bindingV2;
  const document = goal?._projection?.target?.document_fingerprint;
  if (publication?.schema !== "revit-operator.assignment-kernel-publication/v2"
      || publication.assignment_id !== binding?.assignment_id
      || !Number.isSafeInteger(publication.assignment_version)
      || !Number.isSafeInteger(goal?._assignmentVersion)
      || publication.assignment_version < goal._assignmentVersion
      || snapshot?.assignment_version !== publication.assignment_version
      || !bindingKeys.every(key => binding?.[key] != null
        && snapshot?.current_binding?.[key] === binding[key]
        && snapshot?.spec?.binding?.[key] === binding[key])
      || !document || snapshot.current_binding.document_fingerprint !== document
      || snapshot.spec.binding.document_fingerprint !== document
      || (snapshot.execution_control?.command_id ?? null) !== (goal._executionControl?.command_id ?? null)
      || (snapshot.execution_control?.state ?? "running") !== (goal._executionControl?.state ?? "running")) {
    throw new Error("The task or its controls changed. Refresh the task before sending this direction. Your draft is retained.");
  }
  const paused = snapshot.execution_control?.state === "paused";
  const proposal = snapshot.completion_proposal;
  if (!proposal) return { checkpoint: null, paused };
  if (snapshot.terminal || snapshot.spec.execution_policy?.mode !== "local_advisory_v1"
      || proposal.verified !== false || typeof proposal.review_id !== "string" || !proposal.review_id
      || snapshot.pending_review_ids?.length !== 1 || snapshot.pending_review_ids[0] !== proposal.review_id) {
    throw new Error("This checkpoint cannot accept a follow-up yet. Your draft is retained.");
  }
  return { paused, checkpoint: {
    review_id: proposal.review_id,
    expected_control_command_id: snapshot.execution_control?.command_id ?? null,
    document_fingerprint: document
  } };
}

/** A saved receipt alone can be an old idempotent retry. Read the current task
 * again before using its ordinary fenced Resume; an explicit Pause wins. */
export function checkpointResumeReady(publication, goal, command) {
  const context = checkpointDirectionContext(publication, goal);
  const snapshot = publication.snapshot;
  return !context.paused && !context.checkpoint && !snapshot.terminal
    && snapshot.outcome === "active" && snapshot.quiescent === true
    && snapshot.pending_review_ids?.length === 0
    && snapshot.pending_input_variable_ids?.length === 0
    && snapshot.unresolved_unknown_operation_ids?.length === 0
    && (snapshot.execution_control?.command_id ?? null) === command.checkpoint.expected_control_command_id
    && snapshot.current_binding.document_fingerprint === command.checkpoint.document_fingerprint
    && bindingKeys.every(key => snapshot.current_binding[key] === command[key]);
}
