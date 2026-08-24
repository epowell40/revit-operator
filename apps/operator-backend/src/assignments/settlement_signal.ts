import type { AssignmentControlPlaneProjection } from "./control_plane.js";

type Listener = (projection: AssignmentControlPlaneProjection) => void;
const listeners = new Map<string, Set<Listener>>();

export function observeAssignmentSettlement(assignmentId: string, listener: Listener): () => void {
  const current = listeners.get(assignmentId) ?? new Set<Listener>();
  current.add(listener);
  listeners.set(assignmentId, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(assignmentId);
  };
}

export function notifyAssignmentSettlement(projection: AssignmentControlPlaneProjection): void {
  for (const listener of listeners.get(projection.assignment_id) ?? []) listener(projection);
}
