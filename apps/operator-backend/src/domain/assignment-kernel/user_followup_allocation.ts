import type { AssignmentSnapshotV2 } from './snapshot.js';
import type { AssignmentProgressBudgetV2 } from './progress/contracts.js';
import { assignmentActiveExecutionTimeMsV2 } from './progress/execution_time.js';
import { kernelAssertV2 } from './errors.js';

export const USER_FOLLOWUP_ALLOCATION_V1 = 'continue_advisory_checkpoint_with_work_allowance_v1';
const keys = ['max_provider_calls','max_operations','max_total_tokens','max_wall_clock_ms'] as const;
type Limits = Pick<AssignmentProgressBudgetV2, typeof keys[number]>;
export type UserFollowupAllocationV1 = Readonly<{
  command_id: string; allocated_at: string; earned_baseline: Limits; limits: Limits;
}>;

export function userFollowupLimitV1(snapshot: AssignmentSnapshotV2, key: typeof keys[number], earned: number): number {
  const allocation = snapshot.user_followup_allocation, hard = snapshot.spec.execution_policy?.progress_allowance?.[key];
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
  earned: AssignmentProgressBudgetV2, current: AssignmentProgressBudgetV2): AssignmentSnapshotV2 {
  const policy = snapshot.spec.execution_policy, ceiling = policy?.progress_allowance;
  if (!ceiling || snapshot.spec.requested_effect !== 'apply' || snapshot.execution_control?.state === 'paused') return snapshot;
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
    // Old policies without an explicit time ceiling never acquire more time.
    limits[key] = ceiling[key] === undefined ? current[key]
      : Math.min(ceiling[key]!, Math.max(current[key], consumed[key] + policy![key]));
  }
  return {...snapshot,user_followup_allocation:{command_id:commandId,allocated_at:now,earned_baseline:baseline,limits}};
}
