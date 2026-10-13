import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';
import { appliedOperationHasVerifiedPostconditionV2, verificationOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { inspectionIsCurrentV2, workPlanItemDeferredV2 } from '../domain/assignment-kernel/work_plan.js';
import { projectWorkPlanLocationV2 } from '../domain/assignment-kernel/work_plan_location.js';
import { boundedWorkPlanPage } from './work_plan_projection.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { operationTargetIdentityAliasesV2 } from '../domain/assignment-kernel/operation_target_identity.js';
import { legacyReviewAddress, reviewStatusLabel } from './work_review_presentation.js';
import { projectWorkPlanScopeChecksV1 } from './work_plan_scope_check.js';
import { hasCompleteNativeChangeInventoryV2 } from '../verification/native_change_inventory_v2.js';

function reviewedTargets(op: AssignmentSnapshotV2['operations'][string], read: AssignmentSnapshotV2['operations'][string]) {
  // These property verifiers check every exact requested owner. Incidental
  // panel/browser modifications are not subjects of a Type or parameter proof.
  // Relationship and geometry proofs keep their broader dependency footprint.
  const ids = (read.input?.body as Record<string, unknown> | undefined)?.elementIds;
  if (['/revit/change-element-type','/revit/set-parameter'].includes(op.request_identity?.path ?? '')
    && read.request_identity?.path === '/revit/get-parameters' && Array.isArray(ids) && ids.length > 0
    && ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0)) {
    return ids.map(id => `element_id:${id}`).flatMap(operationTargetIdentityAliasesV2);
  }
  return [op.target.target_id, ...Object.values(op.target.semantic_scope ?? {}),
    ...(op.result?.affected_target_identities ?? [])].flatMap(operationTargetIdentityAliasesV2);
}

function checkedEditIsCurrent(snapshot: AssignmentSnapshotV2, id: string): boolean {
  const op = snapshot.operations[id];
  if (!op || !sameAssignmentBindingV2(op.binding, snapshot.current_binding)
    || snapshot.input_invalidated_operation_ids?.includes(id)
    || snapshot.unresolved_unknown_operation_ids.includes(id)
    || !appliedOperationHasVerifiedPostconditionV2(snapshot, id)) return false;
  return op.verification_operation_ids.some(readId => {
    const read = snapshot.operations[readId];
    if (!read || !verificationOperationHasVerifiedPostconditionV2(snapshot, readId)
      || read.verification_of_operation_id !== id || snapshot.input_invalidated_operation_ids?.includes(readId)
      || !sameAssignmentBindingV2(read.binding, snapshot.current_binding)
      || read.result?.authority !== 'native-host' || !read.result.raw_payload_hash || !sameAssignmentBindingV2(read.result.binding, snapshot.current_binding)
      || !read.observation_ids.some(oid => {
        const observed = snapshot.observations[oid];
        return observed?.operation_id === readId && observed.authority === 'native-host'
          && sameAssignmentBindingV2(observed.binding, read.binding) && observed.raw_payload_hash === read.result?.raw_payload_hash
          && observed.facts.some(f => f.fact_id === 'verification.postcondition_satisfied' && f.fact_class === 'verification' && f.value === true);
      })) return false;
    const readAt = Date.parse(read.result.completed_at), targets = new Set(reviewedTargets(op,read));
    if (!targets.size || !Number.isFinite(readAt) || readAt < Date.parse(op.result?.completed_at ?? '')) return false;
    return !Object.values(snapshot.operations).some(later => {
      if (later.operation_id === id || later.requested_effect !== 'apply'
        || !(['applied','unknown'].includes(later.persistent_effect) || snapshot.in_flight_operation_ids.includes(later.operation_id))
        || !sameAssignmentBindingV2(later.binding, snapshot.current_binding)) return false;
      const laterAt = Date.parse(later.result?.completed_at ?? later.opened_at);
      const unsettled = later.persistent_effect === 'unknown' || snapshot.unresolved_unknown_operation_ids.includes(later.operation_id)
        || snapshot.in_flight_operation_ids.includes(later.operation_id);
      // An older opening timestamp does not settle a still-running/unknown
      // write. It may complete after the read and remains a freshness blocker.
      if (!unsettled && Number.isFinite(laterAt) && laterAt < readAt) return false;
      // Equal timestamps need retained ordering; without it, require recheck.
      if (!unsettled && laterAt === readAt && later.settled_assignment_version !== undefined && read.settled_assignment_version !== undefined
        && later.settled_assignment_version < read.settled_assignment_version) return false;
      const footprint = hasCompleteNativeChangeInventoryV2(snapshot,later)
        ? later.result!.affected_target_identities!.flatMap(operationTargetIdentityAliasesV2)
        : [later.target.target_id, ...Object.values(later.target.semantic_scope ?? {}), ...(later.result?.affected_target_identities ?? [])]
          .flatMap(operationTargetIdentityAliasesV2);
      return !footprint.length || footprint.some(target => targets.has(target));
    });
  });
}

/** Read-only presentation of retained work. A checked operation is not drawing
 * coverage; a worker claim and a question never confer completion authority. */
export function workReviewRowsV2(snapshot: AssignmentSnapshotV2) {
  const scopeChecks=new Map(projectWorkPlanScopeChecksV1(snapshot).map(check=>[check.item_id,check]));
  return (snapshot.work_plan?.items ?? []).map((item, index) => {
    const claims = (snapshot.work_plan_claims ?? []).filter(c => c.item_id === item.item_id);
    const ids = [...new Set([...item.operation_ids, ...claims.flatMap(c => [...c.operation_ids])])];
    const applied = ids.filter(id => {
      const op = snapshot.operations[id];
      return op?.persistent_effect === 'applied' && op.settlement_state === 'settled';
    });
    const checked = applied.filter(id => checkedEditIsCurrent(snapshot, id));
    const deferred = workPlanItemDeferredV2(item);
    const lastDeferral = item.deferrals?.at(-1);
    const currentClaim = !deferred && (lastDeferral?.prior_claim_count !== undefined
      ? claims.length > lastDeferral.prior_claim_count : !lastDeferral
        ? claims.length > 0 : claims.some(c => Date.parse(c.claimed_at) > Date.parse(lastDeferral.resumed_at ?? lastDeferral.deferred_at)));
    const unknown = ids.some(id => snapshot.operations[id]?.persistent_effect === 'unknown'
      || snapshot.unresolved_unknown_operation_ids.includes(id));
    const settling = ids.some(id => snapshot.in_flight_operation_ids.includes(id));
    const verified = Boolean(!unknown && !settling && !deferred && item.completed_at && (item.kind === 'inspection'
      ? inspectionIsCurrentV2(snapshot, item)
      : item.operation_ids.length && item.operation_ids.every(id => checkedEditIsCurrent(snapshot, id))));
    const status = unknown ? 'outcome_unknown' : settling ? 'settling' : verified ? 'checked' : deferred ? 'deferred' : currentClaim ? 'reported_unverified'
      : applied.length ? 'partial' : 'not_completed';
    const location = projectWorkPlanLocationV2(item, snapshot);
    const source = location?.source;
    // Use source labels, not a renamed model sheet, as the review address.
    const address = source ? [source.sheet_label, `page ${source.page}`, source.view_label].filter(Boolean).join(' · ')
      : location?.native ? [location.native.sheet_number, location.native.view_name].filter(Boolean).join(' · ')
        : legacyReviewAddress(item.source_basis, item.description) ?? 'Location not recorded';
    return { review_ref: `R${index + 1}`, item_id: item.item_id, status, address,
      description: item.description, source_basis: item.source_basis,
      location, applied_operation_count: applied.length, checked_operation_count: checked.length,
      declared_scope_check:scopeChecks.get(item.item_id)??null,
      ...(deferred ? { question_ref: `Q${index + 1}`, question: lastDeferral!.reason } : {}),
      waiting_on: [...(item.depends_on ?? [])],
      notice: verified ? 'Declared item has checked operations; source-comment coverage and engineering suitability are not certified.'
        : 'Unfinished or assistant-reported work; no independent completion inferred.' };
  });
}

export function projectWorkReviewV2(snapshot: AssignmentSnapshotV2, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('work_review_page_invalid');
  const rows = workReviewRowsV2(snapshot);
  const counts = Object.fromEntries(['checked','reported_unverified','partial','deferred','not_completed','outcome_unknown','settling']
    .map(status => [status, rows.filter(row => row.status === status).length]));
  // Checklist association is an assistant bookkeeping step, not native proof.
  // Do not hide valid individual checks when a partial item has no completed
  // claim. Keep item coverage separate and retain all freshness fences.
  const associated = new Set((snapshot.work_plan?.items ?? []).flatMap(item => [
    ...item.operation_ids, ...(snapshot.work_plan_claims ?? []).filter(c => c.item_id === item.item_id).flatMap(c => [...c.operation_ids])
  ]));
  const checkedIds = Object.keys(snapshot.operations).filter(id => checkedEditIsCurrent(snapshot, id));
  return { assignment_id: snapshot.current_binding.assignment_id, assignment_version: snapshot.assignment_version,
    counts, total: rows.length, scope_is_assistant_interpretation: true,
    checked_edit_count: checkedIds.length,
    checked_edits_without_checklist_item: checkedIds.filter(id => !associated.has(id)).length,
    page: boundedWorkPlanPage(rows, start, 16384),
    pagination: 'operator_manage_work_plan action=status start=<next_start>; restart at 0 if assignment_version changes.',
    reply_help: 'Reply with the question reference and your answer, for example Q3: keep the existing location. References stay tied to the retained item; answers still follow normal task authorization.',
    notice: 'Checked edits are not a full source-comment pass rate. Prior unresolved reports remain in Details.' };
}

/** Status already carries the source-addressed work-plan page. Do not repeat
 * descriptions, source crops and history in the agent's review projection. */
export function compactWorkReviewV2(snapshot: AssignmentSnapshotV2) {
  const {page, pagination, ...summary}=projectWorkReviewV2(snapshot);
  return summary;
}

const cell = (text: string) => text.replace(/\r?\n/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'");
const short = (text: string, max = 100) => text.length > max ? text.slice(0, max - 1) + '…' : text;
function table(rows: ReturnType<typeof workReviewRowsV2>) {
  return ['| Ref | Sheet / page | Work | Status |', '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.review_ref} | ${cell(short(row.address, 80))} | ${cell(short(row.description))} | ${reviewStatusLabel(row.status,row.checked_operation_count)}${row.declared_scope_check?.available?`; declared search ${row.declared_scope_check.satisfied_count}/${row.declared_scope_check.matched_count} checked`:''} |`)].join('\n');
}

/** Retained followups stay visible even when the worker forgot action=defer.
 * These are open reports, not proof or a newly inferred native location. */
function reviewQuestions(snapshot: AssignmentSnapshotV2, rows: ReturnType<typeof workReviewRowsV2>) {
  const questions=rows.filter(row=>row.question).map(row=>({ref:row.question_ref!,address:row.address,text:row.question!,related_ref:undefined as string|undefined}));
  const seen=new Set(questions.map(q=>q.text));
  for(const [index,item] of (snapshot.advisory_followups??[]).entries()) {
    if(!['open','deferred'].includes(item.state)||seen.has(item.text))continue;
    // Group only an explicit existing question reference. Similar wording is
    // insufficient, and all retained wording remains visible in Details.
    const reference=/^\s*(Q[1-9]\d*)\s*[:—-]/.exec(item.text)?.[1];
    const parent=questions.find(q=>q.ref===reference&&!q.related_ref);
    questions.push({ref:`QF${index+1}`,address:parent?.address??legacyReviewAddress(item.text,'')??'Sheet / page not recorded',text:item.text,related_ref:parent?.ref});seen.add(item.text);
  }
  return questions;
}

export function renderWorkReviewHandoffV2(snapshot: AssignmentSnapshotV2): { summary: string; details: string } | null {
  const rows = workReviewRowsV2(snapshot);
  if (!rows.length) return null;
  const report = projectWorkReviewV2(snapshot);
  // Show the first unfinished rows; every row remains available under Details.
  const unfinished = rows.filter(row => row.status !== 'checked');
  const preview = (unfinished.length ? unfinished : rows).slice(0, 6);
  const questions = reviewQuestions(snapshot,rows);
  const shownQuestions: typeof questions = [];
  let chars = 0;
  const primaryQuestions=questions.filter(row=>!row.related_ref);
  for (const row of primaryQuestions.slice(0, 3)) {
    // Do not cut off a qualification at the end of a question.
    if (chars + row.text.length > 600) break;
    shownQuestions.push(row); chars += row.text.length;
  }
  const questionText = (row: typeof questions[number]) => `${row.ref}${row.related_ref?` (also ${row.related_ref})`:''} · ${cell(row.address)}: ${cell(row.text)}`;
  return {
    summary: [
      `Review: ${report.counts.checked} checked · ${report.counts.partial} partial · ${report.counts.reported_unverified} reported, unchecked · ${report.counts.deferred} deferred · ${report.counts.not_completed} not completed${report.counts.outcome_unknown ? ` · ${report.counts.outcome_unknown} uncertain` : ''}${report.counts.settling ? ` · ${report.counts.settling} still settling` : ''}.`,
      'This is the saved work list; a checked edit may cover only part of a redline.',
      `${report.checked_edit_count} individual edit${report.checked_edit_count===1?'':'s'} checked by native readback; unfinished scope stays open.`,
      ...(report.checked_edits_without_checklist_item ? [`${report.checked_edits_without_checklist_item} checked edit${report.checked_edits_without_checklist_item===1?' is':'s are'} not linked to a checklist item; no comment coverage inferred.`] : []),
      ...(rows.some(row=>row.declared_scope_check?.available)?['Declared search checks cover the selected views and matching rule; drawing interpretation still needs review.']:[]),
      table(preview),
      ...(rows.length > preview.length ? [`All ${rows.length} checklist items and full wording are in Details.`] : []),
      ...(questions.length ? ['Questions and open items', ...shownQuestions.map(row => `- ${questionText(row)}`),
        ...(primaryQuestions.length > shownQuestions.length ? [`${primaryQuestions.length - shownQuestions.length} more questions in Details.`] : []),
        ...(questions.length > primaryQuestions.length ? ['Related saved reports are grouped under their question in Details.'] : []),
        'Reply using the question reference, for example “Q3: keep the existing location.”'] : [])
    ].join('\n\n'),
    details: ['### Sheet checklist', table(rows),
      ...rows.map(row => `- ${row.review_ref} · ${cell(row.address)} · ${reviewStatusLabel(row.status,row.checked_operation_count)}: ${cell(row.description)}\n  Source: ${cell(row.source_basis)}${row.location?.source ? '\n  Drawing: ' + cell(row.location.source.filename) + (row.location.source.region ? ' · area of interest retained' : '') : ''}`),
      ...(questions.length ? ['### Questions by sheet', ...questions.map(row => `- ${questionText(row)}`)] : [])
    ].join('\n\n')
  };
}
