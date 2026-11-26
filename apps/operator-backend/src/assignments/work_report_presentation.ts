import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {checkedEditIsCurrentV2} from '../verification/current_postcondition_v2.js';

/** Presentation of retained work, not a completion/authorization transition.
 * A native check verifies an edit's postcondition, not every claim in prose. */
export function workReportPresentation(snapshot: AssignmentSnapshotV2) {
  const proposal = snapshot.completion_proposal;
  if (!proposal) return null;
  // File exports have persistent effects, but do not alter the Revit model.
  // Keep their receipts and qualifications in Details without inventing an
  // unchecked model edit. Unknown effects remain visible for every operation.
  const applied = Object.values(snapshot.operations).filter(op => op.requested_effect === 'apply' && op.persistent_effect === 'applied'
    && !['/revit/export-elements-xlsx', '/revit/export-pdf'].includes(op.request_identity?.path ?? ''));
  const checked = applied.filter(op => checkedEditIsCurrentV2(snapshot, op.operation_id));
  const unsettled = snapshot.unresolved_unknown_operation_ids.length > 0 || snapshot.in_flight_operation_ids.length > 0;
  const answer = proposal.user_facing_text?.trim();
  const normalize = (s:string) => s.replace(/[*_`]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const summarize = (items:readonly string[]) => items.join(' ').length <= 400 ? items.join(' ')
    : `${items.length} ${items.length === 1 ? 'item' : 'items'} retained in Details.`;
  const summary = [answer || summarize(proposal.claimed_completed) || 'No completed work was reported.'];
  if (unsettled) summary.push('An operation still needs reconciliation. Do not repeat the edit.');
  else if (applied.length > checked.length) summary.push('Some model changes still need checking.');
  // Keep unresolved work visible, including qualifications omitted by the owner.
  for (const [label, items] of [['Remaining work', proposal.remaining_work], ['Notes', proposal.uncertainties]] as const) {
    const omitted = items.filter(item => !normalize(summary.join(' ')).includes(normalize(item))
      && !(label === 'Notes' && /^the project has not been saved(?: to disk)?[.;]?(?: the change is in the open model\.)?$/i.test(item.trim())
        && /the project has not been saved[.]/i.test(answer ?? '')));
    if (omitted.length) summary.push(label === 'Notes' && answer
      ? `${omitted.length} additional ${omitted.length === 1 ? 'note' : 'notes'} in Details.`
      : `${label}: ${summarize(omitted)}`);
  }
  const evidence = checked.length ? `${checked.length} model change${checked.length === 1 ? '' : 's'} verified by current native readback.`
    : 'No current native model-change check is recorded for this report.';
  const details = [evidence, 'Native checks cover the referenced changes. Other report claims are agent-authored; this is not independent certification of the entire task.',
    ...[['Work reported', proposal.claimed_completed], ['Remaining work', proposal.remaining_work], ['Notes', proposal.uncertainties]]
      .filter(([,items]) => (items as readonly string[]).length)
      .map(([label,items]) => `### ${label}\n\n` + (items as readonly string[]).map(item => '- ' + item.replace(/\r?\n/g,'\n  ')).join('\n'))].join('\n\n');
  return {schema:'revit-operator.work-report-presentation/v1' as const, review_id:proposal.review_id,
    summary:summary.join('\n\n'), details, checked_edit_count:checked.length, applied_edit_count:applied.length};
}
