import { committedReadRefreshV2,committedDocumentReadRefreshV2 } from '../domain/assignment-kernel/committed_read_refresh.js';
import type { OperationV2 } from '../domain/assignment-kernel/operation.js';
import type { AssignmentSnapshotV2 } from '../domain/assignment-kernel/snapshot.js';

/** Route selection belongs to the application adapter. The journal reducer
 * independently checks the retained native read, commit, binding and targets. */
export function nativeCommittedReadRefreshV2(snapshot: AssignmentSnapshotV2, operation: OperationV2) {
  if (!operation.request_identity?.path?.startsWith('/revit/')
      && !(operation.request_identity?.path===undefined&&operation.input.path===undefined
        &&operation.capability_id.startsWith('revit_')&&operation.capability_id!=='revit_call_tool')) return null;
  return committedReadRefreshV2(snapshot, operation)??committedDocumentReadRefreshV2(snapshot,operation);
}
