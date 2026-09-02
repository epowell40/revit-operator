import {
  sameAssignmentBindingV2,
  type AssignmentBindingV2
} from "../domain/assignment-kernel/index.js";

export const ASSIGNMENT_KERNEL_TERMINAL_BARRIER_V2_SCHEMA =
  "revit-operator.assignment-kernel-terminal-barrier/v2" as const;

export type AssignmentKernelTerminalBarrierLeaseV2 = Readonly<{
  schema: typeof ASSIGNMENT_KERNEL_TERMINAL_BARRIER_V2_SCHEMA;
  barrier_id: string;
  binding: AssignmentBindingV2;
}>;

const barriersByAssignment = new Map<string, Map<string, AssignmentKernelTerminalBarrierLeaseV2>>();

function normalizedBarrierId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(id)) {
    throw new Error("assignment_kernel_v2_terminal_barrier_identity_invalid");
  }
  return id;
}

/**
 * Holds the terminal event while an upstream provider turn can still emit
 * receipts. Domain state continues to reduce normally, so a terminal outcome
 * may be derivable, but the immutable terminal snapshot is committed only
 * after the turn boundary has reconciled every completed receipt.
 *
 * The lease is intentionally process-local. A process loss cannot discard
 * canonical domain events; restart recovery sees a nonterminal derived outcome
 * and may settle it after confirming there is no live provider transport.
 */
export function beginAssignmentKernelTerminalBarrierV2(input: Readonly<{
  binding: AssignmentBindingV2;
  barrier_id: string;
}>): AssignmentKernelTerminalBarrierLeaseV2 {
  const barrierId = normalizedBarrierId(input.barrier_id);
  const assignmentId = input.binding.assignment_id.trim();
  if (!assignmentId) throw new Error("assignment_kernel_v2_terminal_barrier_binding_invalid");
  const byId = barriersByAssignment.get(assignmentId) ?? new Map<string, AssignmentKernelTerminalBarrierLeaseV2>();
  const existing = byId.get(barrierId);
  if (existing) {
    if (!sameAssignmentBindingV2(existing.binding, input.binding)) {
      throw new Error("assignment_kernel_v2_terminal_barrier_binding_conflict");
    }
    throw new Error("assignment_kernel_v2_terminal_barrier_already_active");
  }
  const lease: AssignmentKernelTerminalBarrierLeaseV2 = Object.freeze({
    schema: ASSIGNMENT_KERNEL_TERMINAL_BARRIER_V2_SCHEMA,
    barrier_id: barrierId,
    binding: structuredClone(input.binding)
  });
  byId.set(barrierId, lease);
  barriersByAssignment.set(assignmentId, byId);
  return lease;
}

export function endAssignmentKernelTerminalBarrierV2(
  lease: AssignmentKernelTerminalBarrierLeaseV2 | null
): void {
  if (!lease) return;
  const byId = barriersByAssignment.get(lease.binding.assignment_id);
  const current = byId?.get(lease.barrier_id);
  if (!current) return;
  if (!sameAssignmentBindingV2(current.binding, lease.binding)) {
    throw new Error("assignment_kernel_v2_terminal_barrier_release_conflict");
  }
  byId!.delete(lease.barrier_id);
  if (byId!.size === 0) barriersByAssignment.delete(lease.binding.assignment_id);
}

export function assignmentKernelTerminalSettlementDeferredV2(binding: AssignmentBindingV2): boolean {
  const barriers = barriersByAssignment.get(binding.assignment_id);
  if (!barriers) return false;
  return [...barriers.values()].some((barrier) => sameAssignmentBindingV2(barrier.binding, binding));
}
