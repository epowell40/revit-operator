import type {AssignmentBindingV2} from '../domain/assignment-kernel/identity.js';
/** Pacing telemetry only. A recent call is an estimate of the next call's
 * context cost, never an admission promise or an extension of task resources. */
export function providerTokenRunway(calls: readonly {binding?:unknown;completed_at?:string;usage?:{total_tokens?:number|null}}[],
  binding: AssignmentBindingV2, remaining:number|null, now:string) {
 if(!Number.isSafeInteger(remaining)||remaining===null||remaining<0||!Number.isFinite(Date.parse(now)))return null;
 // Missing usage anywhere in the task means the cumulative reserve is unknown.
 if(calls.some(c=>!Number.isSafeInteger(c.usage?.total_tokens)||c.usage!.total_tokens!<0))return null;
 const keys=['assignment_id','session_id','run_id','generation','principal_id','document_fingerprint'] as const;
 const recent=calls.filter(c=>c.binding&&keys.every(k=>(c.binding as Record<string,unknown>)[k]===binding[k])
  &&Number.isFinite(Date.parse(c.completed_at??''))&&Date.parse(c.completed_at!)<=Date.parse(now))
  .sort((a,b)=>Date.parse(b.completed_at!)-Date.parse(a.completed_at!)).slice(0,8);
 const size=Math.max(0,...recent.map(c=>c.usage!.total_tokens!));
 if(!size)return null;
 return {basis:'largest_of_last_eight_completed_calls' as const,sample_count:recent.length,tokens_per_call:size,
  estimated_calls_remaining:Math.floor(remaining/size),advisory_only:true as const};
}
