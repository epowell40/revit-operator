import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { checkedEditIsCurrentV2 } from './current_postcondition_v2.js';
import { sameAssignmentBindingV2 } from '../domain/assignment-kernel/identity.js';
import { visibilityExpectedValuesV2 } from './visibility_view_contract_v2.js';

function visibilityProperty(op:OperationV2):string|null {
  if(op.request_identity?.path!=='/revit/visibility' || !visibilityExpectedValuesV2(op.input).length)return null;
  const action=(op.input.body as Record<string,unknown>).action;
  // Category labels and enum selectors can resolve to the same native category.
  // Treat all category edits as overlapping rather than guessing equivalence.
  return ({set_phase:'phase',set_phase_filter:'phaseFilter',set_scale:'scale',
    set_detail_level:'detailLevel',set_discipline:'discipline',set_category_override:'category'} as Record<string,string>)[String(action)]??null;
}

/** Renew evidence after another explicit, disjoint property edit on this view.
 * A newer request for the same property supersedes the old expected value;
 * input-invalidated intent must never become a request to restore old work. */
export function visibilityCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  const property=visibilityProperty(op),body=op.input.body as Record<string,unknown>|undefined;
  if(!property || !body || snapshot.terminal || snapshot.outcome!=='active' || snapshot.completion_proposal
    || snapshot.execution_control?.state==='paused' || snapshot.unresolved_unknown_operation_ids.length
    || snapshot.in_flight_operation_ids.length || snapshot.input_invalidated_operation_ids?.includes(op.operation_id)
    || !sameAssignmentBindingV2(snapshot.current_binding,op.binding)
    || !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id) || checkedEditIsCurrentV2(snapshot,op.operation_id))return false;
  const later=Object.values(snapshot.operations).filter(other=>other.operation_id!==op.operation_id
    && other.requested_effect==='apply' && other.persistent_effect!=='none'
    && sameAssignmentBindingV2(snapshot.current_binding,other.binding)
    && (other.opened_at>op.opened_at || other.opened_at===op.opened_at
      && (other.settled_assignment_version??Infinity)>(op.settled_assignment_version??-Infinity))
    && ((other.input.body as Record<string,unknown>|undefined)?.viewId===body.viewId
      || other.result?.affected_target_identities?.includes('element_id:'+body.viewId)
      || other.target.target_id==='id:'+body.viewId));
  return later.length>0 && later.every(other=>{
    const next=visibilityProperty(other);
    return next!==null && next!==property && other.persistent_effect==='applied'
      && other.settlement_state==='settled' && !snapshot.input_invalidated_operation_ids?.includes(other.operation_id);
  });
}

export function committedCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return regularScheduleCheckNeedsRefreshV2(snapshot,op) || visibilityCheckNeedsRefreshV2(snapshot,op);
}

/** This is read scheduling only. The native comparator must independently
 * establish the full requested postcondition again; no prior fact is promoted. */
export function regularScheduleCheckNeedsRefreshV2(snapshot:AssignmentSnapshotV2, op:OperationV2):boolean {
  const b=op.input.body as Record<string,unknown>|undefined;
  return op.request_identity?.path==='/revit/configure-schedule'
    && Boolean(b && ['fieldOrder','columnWidths','appearance','combinedField','filters','sortGroup','filterBySheet','isItemized','showGrandTotals'].some(k=>Object.hasOwn(b,k)))
    && appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    && !checkedEditIsCurrentV2(snapshot,op.operation_id);
}

export function operationNeedsReadbackV2(snapshot:AssignmentSnapshotV2,op:OperationV2):boolean {
  return !appliedOperationHasVerifiedPostconditionV2(snapshot,op.operation_id)
    || committedCheckNeedsRefreshV2(snapshot,op);
}
