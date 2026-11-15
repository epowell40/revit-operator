/** Only the server, before attempting backend task dispatch, can declare this request unadmitted.
 * This describes the new submission, never the effects of an earlier task. */
export function rejectedChatSubmissionAdmission(body, error) {
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && value.trim() === value;
  if (!valid(body?.session_id) || !valid(body?.message_id) || error?.code === 'TASK_RUN_EXISTS') return null;
  return { schema: 'revit-operator.chat-submission-admission/v1', state: 'not_admitted',
    session_id: body.session_id, message_id: body.message_id, request_dispatched: false };
}

/** Preserve draft bytes for an explicit user retry, never automatically resend.
 * A lost connection alone cannot establish that a task was not accepted. */
export function mayRestoreRejectedChatSubmission(submission, error) {
  const admission = error?.submission_admission;
  return submission?.backendAccepted !== true && typeof submission?.sessionId === 'string' && submission.sessionId.length > 0
    && typeof submission?.id === 'string' && submission.id.length > 0
    && admission?.schema === 'revit-operator.chat-submission-admission/v1'
    && admission.state === 'not_admitted' && admission.request_dispatched === false
    && admission.session_id === submission.sessionId && admission.message_id === submission.id;
}
