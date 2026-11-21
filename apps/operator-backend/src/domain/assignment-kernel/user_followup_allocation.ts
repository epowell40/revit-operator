import type { AssignmentSnapshotV2 } from './snapshot.js';
import type { AssignmentProgressBudgetV2 } from './progress/contracts.js';
import { assignmentActiveExecutionTimeMsV2 } from './progress/execution_time.js';
import { kernelAssertV2 } from './errors.js';
import { validLocalAdvisoryPolicyV1 } from './execution_policy.js';
import { sameAssignmentBindingV2 } from './identity.js';

export const USER_FOLLOWUP_ALLOCATION_V1 = 'continue_advisory_checkpoint_with_work_allowance_v1';
const keys = ['max_provider_calls','max_operations','max_total_tokens','max_wall_clock_ms'] as const;
type Limits = Pick<AssignmentProgressBudgetV2, typeof keys[number]>;
export type UserResourceRenewalRequestV1 = Readonly<{ provider_calls: number; total_tokens: number; active_execution_ms?: number }>;
type RenewalAuthorization = Readonly<{ command_id: string; authorized_at: string;
  request: UserResourceRenewalRequestV1; ceilings: Pick<Limits,'max_provider_calls'|'max_total_tokens'> & Partial<Pick<Limits,'max_wall_clock_ms'>> }>;
export type UserFollowupAllocationV1 = Readonly<{
  command_id: string; allocated_at: string; earned_baseline: Limits; limits: Limits;
  resource_renewal?: RenewalAuthorization;
}>;

export function userFollowupLimitV1(snapshot: AssignmentSnapshotV2, key: typeof keys[number], earned: number): number {
  const allocation = snapshot.user_followup_allocation;
  const hard = (key==='max_provider_calls'||key==='max_total_tokens'||key==='max_wall_clock_ms')
    ? allocation?.resource_renewal?.ceilings[key] ?? snapshot.spec.execution_policy?.progress_allowance?.[key]
    : snapshot.spec.execution_policy?.progress_allowance?.[key];
  return !allocation || hard === undefined ? earned : Math.min(hard, Math.max(earned,
    allocation.limits[key] + Math.max(0, earned - allocation.earned_baseline[key])));
}

/** A user allocation is not verified progress. Later genuine progress earns only
 * its delta since this allocation; idle directions cannot stockpile allowance. */
export function applyUserFollowupAllocationV1(snapshot: AssignmentSnapshotV2, earned: AssignmentProgressBudgetV2): AssignmentProgressBudgetV2 {
  const result = {...earned};
  for (const key of keys) result[key] = userFollowupLimitV1(snapshot,key,earned[key]);
  result.max_reasoning_turns = result.max_provider_calls;
  return result;
}

/** Called only at the authenticated, saved checkpoint-resolution seam. The
 * reducer rechecks all execution fences before accepting this derived state. */
export function allocateUserFollowupV1(snapshot: AssignmentSnapshotV2, commandId: string, now: string,
  earned: AssignmentProgressBudgetV2, current: AssignmentProgressBudgetV2, renewal?: UserResourceRenewalRequestV1): AssignmentSnapshotV2 {
  const policy = snapshot.spec.execution_policy, ceiling = policy?.progress_allowance;
  // Explicit user renewal is separate from automatic earned credit. Product
  // tasks keep their frozen initial policy and all non-renewed resource caps.
  const product = policy?.mode === 'single_actor_review_v1'
    && validLocalAdvisoryPolicyV1(snapshot.spec)
    && sameAssignmentBindingV2(snapshot.spec.binding,snapshot.current_binding);
  if (renewal !== undefined) {
    kernelAssertV2(Boolean(renewal) && typeof renewal==='object' && !Array.isArray(renewal)
      && Object.keys(renewal).length>=2 && Object.keys(renewal).length<=3
      && Object.keys(renewal).every(k=>['provider_calls','total_tokens','active_execution_ms'].includes(k))
      && Number.isSafeInteger(renewal.provider_calls) && renewal.provider_calls>0 && renewal.provider_calls<=64
      && Number.isSafeInteger(renewal.total_tokens) && renewal.total_tokens>0 && renewal.total_tokens<=16_000_000
      && (!Object.hasOwn(renewal,'active_execution_ms') || Number.isSafeInteger(renewal.active_execution_ms)
        && renewal.active_execution_ms!>0 && renewal.active_execution_ms!<=1_800_000),
      'advisory_resource_renewal_invalid','Explicit renewal is bounded to64 additional provider calls,16M total tokens and optionally30 active minutes.');
    kernelAssertV2((policy?.mode==='local_advisory_v1' && Boolean(ceiling) || product) && snapshot.spec.requested_effect==='apply'
      && snapshot.execution_control?.state!=='paused', 'advisory_resource_renewal_not_enabled',
      'Only an open, unpaused advisory apply checkpoint accepts explicit resource renewal.');
  }
  if ((!ceiling && !(product && renewal)) || snapshot.spec.requested_effect !== 'apply' || snapshot.execution_control?.state === 'paused') return snapshot;
  const calls = Object.values(snapshot.provider_calls);
  kernelAssertV2(calls.every(call => Number.isSafeInteger(call.usage?.total_tokens) && call.usage!.total_tokens! >= 0),
    'advisory_continuation_usage_unconfirmed', 'Settled provider usage must be known before allocating follow-up work.');
  const consumed: Limits = {max_provider_calls:calls.length, max_operations:Object.keys(snapshot.operations).length,
    max_total_tokens:calls.reduce((sum,call)=>sum+call.usage!.total_tokens!,0),
    max_wall_clock_ms:assignmentActiveExecutionTimeMsV2(snapshot,now)};
  kernelAssertV2(keys.every(key => Number.isSafeInteger(consumed[key]) && consumed[key] >= 0),
    'advisory_continuation_usage_unconfirmed', 'Cumulative resource usage must be known.');
  const limits = {} as Limits, baseline = {} as Limits;
  for (const key of keys) {
    baseline[key] = earned[key];
    if (renewal) { limits[key]=current[key]; continue; }
    // Old policies without an explicit time ceiling never acquire more time.
    const authorized=(key==='max_provider_calls'||key==='max_total_tokens'||key==='max_wall_clock_ms')
      ? snapshot.user_followup_allocation?.resource_renewal?.ceilings[key]??ceiling?.[key] : ceiling?.[key];
    limits[key] = authorized === undefined ? current[key]
      : Math.min(authorized, Math.max(current[key], consumed[key] + policy![key]));
  }
  let authorization=snapshot.user_followup_allocation?.resource_renewal;
  if (renewal) {
    const calls=consumed.max_provider_calls+renewal.provider_calls,tokens=consumed.max_total_tokens+renewal.total_tokens;
    kernelAssertV2(calls<=2048&&tokens<=256_000_000,'advisory_resource_renewal_ceiling',
      'Renewal exceeds the bounded cumulative advisory resource ceiling.');
    limits.max_provider_calls=Math.max(current.max_provider_calls,calls);
    limits.max_total_tokens=Math.max(current.max_total_tokens,tokens);
    const priorTimeCeiling=authorization?.ceilings.max_wall_clock_ms;
    if(renewal.active_execution_ms!==undefined){
      const time=consumed.max_wall_clock_ms+renewal.active_execution_ms;
      kernelAssertV2(time<=28_800_000,'advisory_resource_renewal_ceiling',
        'Renewal exceeds the bounded eight-hour cumulative active-execution ceiling.');
      limits.max_wall_clock_ms=Math.max(current.max_wall_clock_ms,time);
    }
    authorization={command_id:commandId,authorized_at:now,request:{...renewal},ceilings:{
      max_provider_calls:Math.max(ceiling?.max_provider_calls??policy!.max_provider_calls,limits.max_provider_calls),
      max_total_tokens:Math.max(ceiling?.max_total_tokens??policy!.max_total_tokens,limits.max_total_tokens),
      ...((renewal.active_execution_ms!==undefined||priorTimeCeiling!==undefined)
        ?{max_wall_clock_ms:Math.max(priorTimeCeiling??0,ceiling?.max_wall_clock_ms??policy!.max_wall_clock_ms,limits.max_wall_clock_ms)}:{})}};
  }
  return {...snapshot,user_followup_allocation:{command_id:commandId,allocated_at:now,earned_baseline:baseline,limits,
    ...(authorization?{resource_renewal:authorization}:{})}};
}
