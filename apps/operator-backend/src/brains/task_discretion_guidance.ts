import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import { projectWorkPlan, boundedWorkPlanPage } from '../assignments/work_plan_projection.js';
import { workPlanItemDeferredV2 } from '../domain/assignment-kernel/work_plan.js';

/** Worker strategy only. Questions and checklist claims grant no authority. */
export const TASK_DISCRETION_GUIDANCE = [
  'For a current structured native rejection proving a read-only request had no persistent effect and no unknown outcome, correct a rejected read-only request through the documented supported read path within the existing budget. Do not retry the unchanged invalid request. Such a request-construction error is not a reason to ask permission again for already authorized verification; report a genuine unresolved technical limit honestly. This does not apply to unknown effects, uncertain mutations, required-input stops or explicit user stops. Inspect relevant before-state and actual collateral through supported operation-specific evidence and independent readback; do not silently require a new exhaustive whole-model census for every local edit. Preserve all actual collateral and user-required preservation obligations; a diagnostic hint never verifies or completes them.',
  'Triage a compound task before broad investigation: distinguish supported edits, useful investigations, missing engineering/user decisions and internal capability faults. Link related comments using dependsOn; a broad design-completion comment is not a complete equipment selection or design basis. Prefer ready supported items and prerequisite work over a long investigation of the hardest comment.',
  'Determine the requested deliverable before deferring design. If the request is only to list missing inputs, write questions or record a follow-up, deliver that written result; do not turn the underlying unrequested design into an unfinished model-edit checklist item. In strict mode the native checklist tracks requested model edits and their dependent inspections, not prose-only reporting. Keep requested written findings in the task result alongside evidence-backed edit results; they do not themselves verify an edit, supply a design decision or complete requested engineering work. If the user actually requests design that cannot be completed, retain that real unfinished scope as a source-linked deferral and continue independent items. Do not remove existing items to evade a pending checklist or bypass required-input/unknown-effect stops.',
  'Stretch when a concrete next check can resolve a decision: consult available project data, related details, actual equipment/appliance information or applicable jurisdiction/code evidence. State what the check will resolve. Nearby layouts are precedents, not authority for missing design values. Stop investigating that item when the remaining alternatives require designer judgment or further searches/attempts add no decision-relevant evidence. Tool-call activity alone is not useful progress. Do not invent equipment, loads, airflow, sizing, compliance, routing or terminations.',
  'When a material missing decision prevents actual requested model work, retain it against the affected checklist item with operator_manage_work_plan action=defer, itemId and reason containing the supported findings, exact missing decision and a concise question. Do this before exploring another item; an assumption or final caveat alone is not a saved follow-up. Continue ready independent items. This item deferral does not supply an answer or pause the whole assignment. Reserve operator_request_assignment_input/operator_request_clarification for an execution-critical answer that must stop the assignment; those tools pause all work. Never bypass a required-input stop.',
  'At handoff, show the retained source-linked questions and distinguish completed work, useful findings, deferred design and capability failures. Internal tool faults are yours to diagnose or report, not engineering questions for the human. Revisit a deferred item only after an answer, prerequisite result or new evidence changes its decision; use resume_item with that reason and inspect prerequisites before editing. Preserve prior work, remaining questions, user restrictions, unknown effects and host budgets.'
].join('\n');

/** Refresh the actionable queue even when the first checklist page is deferred.
 * Exact questions remain pageable through status; never truncate their text. */
export function taskDecisionContext(snapshot: AssignmentSnapshotV2): string {
  const plan = snapshot.work_plan;
  if (!plan) return '';
  const queue = projectWorkPlan(plan, undefined, 0, snapshot)!;
  const questions = plan.items.flatMap((item, index) => workPlanItemDeferredV2(item)
    ? [{ question_ref: `Q${index + 1}`, item_id: item.item_id,
      reason: item.deferrals!.at(-1)!.reason, status_start: index }] : []);
  return 'SAVED WORK ORDER AND DECISIONS (assistant interpretations, not native proof or user answers):\n'
    + JSON.stringify({ ready_items: queue.ready_items, deferred_count: queue.deferred_count,
      questions: boundedWorkPlanPage(questions, 0, 2400),
      usage: 'Continue ready independent work. Keep deferred questions open until new information supports revisiting. Read full items/questions with operator_manage_work_plan action=status start=<status_start>. Native admission, required-input stops and unknown-effect reconciliation still govern.' });
}
