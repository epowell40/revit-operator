import type { AssignmentSnapshotV2 } from "../domain/assignment-kernel/index.js";

/** Child settlements must precede their parent, regardless of operation-ID order. */
export function completionRecoveryOrderV2(snapshot: AssignmentSnapshotV2): string[] {
  const pending = new Set(snapshot.in_flight_operation_ids);
  const ordered: string[] = [];
  function visit(id: string) {
    if (!pending.delete(id)) return;
    for (const child of Object.values(snapshot.operations)) {
      if (child.parent_operation_id === id) visit(child.operation_id);
    }
    ordered.push(id);
  }
  for (const id of snapshot.in_flight_operation_ids) visit(id);
  return ordered;
}
