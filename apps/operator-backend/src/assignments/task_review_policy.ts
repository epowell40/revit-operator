import {getRequestContext,getRequestAssignmentPrincipalId,isSessionIdBoundToPrincipal} from '../request_context.js';
import {localDesktopNativeTransportAvailable} from './desktop_native_transport_policy.js';
import {trustedLocalExperimentHost} from './local_advisory_policy.js';
import {DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2} from '../domain/assignment-kernel/progress/contracts.js';
import type {AssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
import type {AssignmentSpecV2} from '../domain/assignment-kernel/assignment_spec.js';
import type {SingleActorReviewExecutionPolicyV1} from '../domain/assignment-kernel/execution_policy.js';

export const TASK_REVIEW_PROFILE_V1='single_actor_review_v1' as const;

/** Reuse the authenticated General Agent/native transport host boundary. This
 * selects orchestration only; it is not a native grant, license or write right.
 * Reopening a saved policy does not require the new-task feature flag to stay on. */
function authenticatedReviewHost(binding:AssignmentBindingV2,env:NodeJS.ProcessEnv,context:ReturnType<typeof getRequestContext>):boolean {
 if(!binding.document_fingerprint||!binding.principal_id||!binding.session_id
   ||getRequestAssignmentPrincipalId(context)!==binding.principal_id
   ||!localDesktopNativeTransportAvailable(env,context))return false;
 return !context?.principal || isSessionIdBoundToPrincipal(binding.session_id,context.principal);
}

/** Only the trusted task factory calls this. Caller fields and old local flags
 * cannot enable a product policy; limits are the ordinary frozen product caps. */
export function selectTaskReviewPolicy(binding:AssignmentBindingV2,requestedEffect:string,
 env:NodeJS.ProcessEnv=process.env,context=getRequestContext()):SingleActorReviewExecutionPolicyV1|undefined {
 if(env.OPERATOR_TASK_EXECUTION_PROFILE!==TASK_REVIEW_PROFILE_V1||requestedEffect!=='apply'
   ||!authenticatedReviewHost(binding,env,context))return undefined;
 const budget=DEFAULT_ASSIGNMENT_PROGRESS_BUDGET_V2;
 return {mode:TASK_REVIEW_PROFILE_V1,selected_by:'trusted_runtime_host',principal_id:binding.principal_id,
  session_id:binding.session_id,document_fingerprint:binding.document_fingerprint!,max_turns:8,
  max_provider_calls:budget.max_provider_calls,max_operations:budget.max_operations,
  max_total_tokens:budget.max_total_tokens,max_wall_clock_ms:budget.max_wall_clock_ms,
  ready_work_handoff:'continue_ready_work_v1'};
}

/** Current authenticated custody, independent from a provider's proposal or
 * current feature enrollment. Historical local policy keeps its exact fence. */
export function trustedTaskExecutionHost(spec:AssignmentSpecV2,env:NodeJS.ProcessEnv=process.env,context=getRequestContext()):boolean {
 const policy=spec.execution_policy;
 if(!policy)return true;
 if(policy.mode==='local_advisory_v1')return trustedLocalExperimentHost(env,context);
 return policy.mode===TASK_REVIEW_PROFILE_V1 && policy.selected_by==='trusted_runtime_host'
  &&policy.principal_id===spec.binding.principal_id&&policy.session_id===spec.binding.session_id
  &&policy.document_fingerprint===spec.binding.document_fingerprint
  &&authenticatedReviewHost(spec.binding,env,context);
}

export function assertTaskExecutionHost(spec:AssignmentSpecV2,env:NodeJS.ProcessEnv=process.env,context=getRequestContext()):void {
 if(!trustedTaskExecutionHost(spec,env,context))throw new Error(spec.execution_policy?.mode==='local_advisory_v1'
  ?'advisory_execution_requires_local_host':'task_review_authenticated_host_mismatch');
}
