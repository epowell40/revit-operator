import {stoppedWorkReturnMessage,canonicalWorkReturnResultMessage} from './stopped_work_return.mjs';
// Created only after the exact bound Work Return was fetched and validated.
// This is a pending check, never proof that the requested work succeeded.
export class AssignmentVerificationPending extends Error {
  constructor(workReturn) {
    super('Assignment Kernel V2 has not established an authoritative outcome; Sidecar prose cannot settle it.');
    this.name = 'AssignmentVerificationPending';
    this.workReturn = workReturn;
  }
}

export function computerCompletionPresentation(settlement, pendingClarification = null, assignment = null) {
  if (settlement?.kernel_version !== 2) return pendingClarification
    ? {phase: 'awaiting_user_input', message: pendingClarification.question, disposition: 'pending_verification'}
    : {phase: 'completed', message: 'Run finished', disposition: 'success'};
  const status = settlement.work_return?.status;
  const choices = {
    active: ['verification_pending', 'The response is saved; verification is still pending. Review the retained results before retrying changes.'],
    awaiting_user_review: ['awaiting_user_review', 'The response is saved and needs review. Task completion has not been verified.'],
    awaiting_user_input: ['awaiting_user_input', pendingClarification?.question || 'The task needs your input. Open Tasks to review the questions.'],
    complete_with_issues: ['complete_with_issues', 'The task finished with issues. Open Tasks to review the remaining items.'],
    complete: ['completed', 'Task completion verified.'],
    verified_noop: ['completed', 'The requested state was already satisfied and verified.'],
    blocked: ['blocked', 'The task is blocked. Open Tasks for the retained details.'],
    failed: ['failed', 'The requested work did not complete. Open Tasks for the retained failure details.']
  };
  const choice = Object.hasOwn(choices, status) ? choices[status] : null;
  if (!choice) throw new Error('Cannot present an unknown canonical task outcome.');
  const retained=stoppedWorkReturnMessage(settlement,assignment);
  const successful=['complete','verified_noop','complete_with_issues'].includes(status)?canonicalWorkReturnResultMessage(settlement,assignment):null;
  return {phase: choice[0], message: choice[1],...(retained?{retained_failure_message:retained}:{}),
    ...(successful?{retained_result_message:successful}:{}),
    disposition: ['failed', 'blocked'].includes(status) ? 'explicit_failure'
      : ['complete', 'verified_noop', 'complete_with_issues'].includes(status) ? 'success' : 'pending_verification'};
}
