import {canonicalJsonV2,utf8TextSha256V2} from './canonical.js';
import {validBoundOperationScope} from './operation_scope.js';
import {defaultAssignmentWorkBudgetV2} from './effective_work_budget.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from './progress/contracts.js';
import {assignmentActiveExecutionTimeMsV2} from './progress/execution_time.js';
import {kernelAssertV2} from './errors.js';
import {validLocalAdvisoryPolicyV1} from './execution_policy.js';
import type {AssignmentSnapshotV2} from './snapshot.js';
import type {AssignmentSpecV2} from './assignment_spec.js';

export interface NewProjectContextV1 {
  process_id:number; title:string; path:''; session_id:string;
  fingerprint:string; created_at:string; is_family:false;
}
export interface NewDocumentHandoffV1 {
  command_id:string; observed_at:string; target:NewProjectContextV1; child_spec:AssignmentSpecV2;
}

/** Deliberate new-project creation only. Opening arbitrary existing files needs
 * its own exact path authority and is not inferred from a changed active tab. */
export function requestsNewProject(spec:AssignmentSpecV2):boolean {
  const text=spec.source_user_request;
  return validBoundOperationScope(spec)&&spec.requested_effect==='apply'
    &&spec.interpreted_scope?.scope.model_effect==='apply'
    &&!spec.interpreted_scope.scope.prerequisites.length
    &&!spec.target_binding && !spec.document_parent_binding
    &&! /\b(?:before I approve|after I approve|preview|explain|how to)\b/i.test(text)
    &&! /\b(?:do not|don't|never|without)\s+(?:\w+\s+){0,3}(?:make|making|create|creating|start|starting)\b/i.test(text)
    &&/(?:^|[.!?;,]\s*|\bthen\s+)(?:now\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:make|create|start)\s+(?:(?:a|an|the)\s+)?new\s+(?:revit\s+)?(?:architectural\s+)?(?:model|project)\b/i.test(text);
}

export function assertNewDocumentHandoffReady(s:AssignmentSnapshotV2):void {
  kernelAssertV2(requestsNewProject(s.spec),'new_document_not_requested','The saved user request must explicitly authorize a new project.');
  kernelAssertV2(!s.document_handoff&&!s.completion_proposal&&!s.terminal&&s.outcome==='active'&&s.quiescent
    &&s.execution_control?.state!=='paused'&&!s.provider_usage_hold&&!s.provider_budget_exhausted
    &&!s.progress_blocker&&!s.execution_failure_ids.length&&!s.pending_review_ids.length
    &&!s.pending_input_variable_ids.length&&!s.in_flight_operation_ids.length&&!s.in_flight_provider_call_ids.length
    &&!s.unresolved_unknown_operation_ids.length,'new_document_handoff_not_ready','Settle work and honor all task stops before changing documents.');
}

export function newDocumentPhaseSpec(s:AssignmentSnapshotV2,target:NewProjectContextV1,commandId:string,now:string):AssignmentSpecV2 {
  assertNewDocumentHandoffReady(s);
  const timestamp=Date.parse(now),created=Date.parse(target.created_at),started=Date.parse(s.spec.created_at);
  kernelAssertV2(Number.isSafeInteger(target.process_id)&&target.process_id>0&&target.is_family===false&&target.path===''
    &&typeof target.title==='string'&&target.title.trim().length>0&&target.title.length<=512
    &&/^[a-f0-9]{32}$/i.test(target.session_id)&&/^[a-f0-9]{64}$/.test(target.fingerprint)
    &&Number.isFinite(started)&&Number.isFinite(timestamp)&&created>=started&&created<=timestamp
    &&timestamp-created<=30*60_000,'new_document_identity_invalid','A newly created unsaved project in the same Revit process is required.');
  kernelAssertV2(/^[A-Za-z0-9._:-]{1,160}$/.test(commandId),'new_document_command_invalid','An exact host command is required.');
  const policy=s.spec.execution_policy;
  kernelAssertV2(!!policy,'new_document_policy_required','A bounded desktop execution policy is required.');
  const budget=defaultAssignmentWorkBudgetV2(s,DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2);
  const calls=Object.values(s.provider_calls);
  kernelAssertV2(calls.every(c=>Number.isSafeInteger(c.usage?.total_tokens)&&c.usage!.total_tokens!>=0),
    'new_document_usage_unknown','Provider usage must settle before the handoff.');
  const remaining={max_provider_calls:budget.max_provider_calls-calls.length,
    max_operations:budget.max_operations-Object.keys(s.operations).length,
    max_total_tokens:budget.max_total_tokens-calls.reduce((n,c)=>n+c.usage!.total_tokens!,0),
    max_wall_clock_ms:budget.max_wall_clock_ms-assignmentActiveExecutionTimeMsV2(s,now)};
  kernelAssertV2(Object.values(remaining).every(n=>Number.isSafeInteger(n)&&n>0),
    'new_document_budget_exhausted','A document handoff cannot renew task resources.');
  const hex=utf8TextSha256V2(s.current_binding.assignment_id+':'+commandId);
  const childId=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  const {progress_allowance: _progress,source_work_allowance:_source,native_scope_planning:_planning,...basePolicy}=policy!;
  const child:AssignmentSpecV2={...structuredClone(s.spec),binding:{...s.current_binding,assignment_id:childId,run_id:'document:'+childId,
    generation:1,document_fingerprint:target.fingerprint},created_at:now,
    document_parent_binding:structuredClone(s.current_binding),
    execution_policy:{...basePolicy,...remaining,document_fingerprint:target.fingerprint}};
  kernelAssertV2(validLocalAdvisoryPolicyV1(child),'new_document_policy_invalid','The remaining resources must fit the existing host policy.');
  return child;
}

export function validateNewDocumentHandoff(s:AssignmentSnapshotV2,h:NewDocumentHandoffV1,actor:string,now:string):void {
  kernelAssertV2(actor==='desktop-document-controller'&&h.observed_at===now,'new_document_handoff_authority_invalid','Only the host may retain a native document handoff.');
  kernelAssertV2(canonicalJsonV2(h.child_spec)===canonicalJsonV2(newDocumentPhaseSpec(s,h.target,h.command_id,now)),
    'new_document_handoff_spec_invalid','The child phase must retain scope and only the remaining budget.');
}
