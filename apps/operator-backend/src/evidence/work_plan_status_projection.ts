import type { EvidenceRefV1 } from './evidence_ref.js';

const record = (value: unknown): Record<string, any> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
const page = (value: unknown): boolean => {
  const p = record(value);
  return !!p && Array.isArray(p.items) && Number.isSafeInteger(p.start) && p.start >= 0
    && Number.isSafeInteger(p.total) && p.total >= p.start + p.items.length
    && (p.next_start === null || Number.isSafeInteger(p.next_start) && p.next_start === p.start + p.items.length);
};

/** Present the existing paged plan intact, rather than replacing its useful
 * locations and pending passes with generic counts. This is task bookkeeping,
 * not native evidence, a coverage certification, or execution permission. */
export function projectWorkPlanStatus(ref: EvidenceRefV1, raw: unknown, maxBytes: number): Record<string, unknown> | null {
  const value = record(raw), plan = record(value?.work_plan), continuation = record(value?.execution_continuation);
  const binding = record(continuation?.binding);
  if (!ref.source.startsWith('desktop_native_transport:') || value?.ok !== true
    || plan?.schema !== 'revit-operator.assignment-work-plan/v2'
    || plan.scope_is_assistant_interpretation !== true || plan.scheduling_is_advisory !== true
    || !page(plan.scope) || !page(plan.ready_items) || !page(plan.assumptions)
    || !['advisory', 'strict'].includes(value.verification_policy)
    || !binding || !['assignment_id', 'session_id', 'run_id', 'generation'].every(key => binding[key] === ref[key as keyof EvidenceRefV1])) return null;
  const result = {
    schema: 'operator.work_plan_status_projection.v1',
    source_evidence_id: ref.evidence_id,
    whole_task_verified: false,
    outcome: value.outcome,
    verification_policy: value.verification_policy,
    work_plan_required: value.work_plan_required,
    work_plan: plan,
    continuation: { state: continuation?.state, reason: continuation?.reason, next_items: continuation?.next_items },
    limitation: 'The returned plan is retained task bookkeeping. Preserve its page boundaries, source interpretations, unverified claims, blockers and pass-specific checks. It does not establish current model state or whole-drawing completion. Other status fields remain retrievable from this evidence ID.'
  };
  // Never silently cut an item, crop, ID, blocker, check state or page boundary.
  // An oversized/unrecognized page retains the normal retrievable projection.
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes ? result : null;
}
