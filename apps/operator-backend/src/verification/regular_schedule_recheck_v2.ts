import type { AssignmentSnapshotV2, OperationV2 } from '../domain/assignment-kernel/index.js';
import { appliedOperationHasVerifiedPostconditionV2 } from '../domain/assignment-kernel/outcome.js';
import { checkedEditIsCurrentV2 } from './current_postcondition_v2.js';

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
    || regularScheduleCheckNeedsRefreshV2(snapshot,op);
}
