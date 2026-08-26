import type { AssignmentKernelTurnBindingV2 } from "../assignments/assignment_kernel_v2_factory.js";

export type AssignmentKernelTurnLeaseV2 = Readonly<{
  lease_id: string;
  binding: AssignmentKernelTurnBindingV2;
  session_id: string;
}>;

/** Ephemeral waiter/index only. Durable truth remains in the Goal-backed V2 journal. */
export class AssignmentKernelTurnLeaseRegistryV2 {
  readonly #unbound = new Set<AssignmentKernelTurnLeaseV2>();
  readonly #byTurn = new Map<string, AssignmentKernelTurnLeaseV2>();
  #sequence = 0;

  begin(binding: AssignmentKernelTurnBindingV2): AssignmentKernelTurnLeaseV2 {
    const lease = Object.freeze({
      lease_id: `assignment-kernel-v2-lease:${++this.#sequence}`,
      binding: structuredClone(binding),
      session_id: binding.session_id
    });
    this.#unbound.add(lease);
    return lease;
  }

  bindTurn(lease: AssignmentKernelTurnLeaseV2, turnId: string): void {
    if (!this.#unbound.delete(lease)) throw new Error("assignment_kernel_v2_lease_not_current");
    const id = String(turnId || "").trim();
    if (!id || this.#byTurn.has(id)) throw new Error("assignment_kernel_v2_turn_binding_conflict");
    this.#byTurn.set(id, lease);
  }

  resolve(turnId: unknown, sessionId: unknown): AssignmentKernelTurnBindingV2 | null {
    const turn = typeof turnId === "string" ? turnId.trim() : "";
    if (turn) return this.#byTurn.get(turn)?.binding ?? null;
    const session = typeof sessionId === "string" ? sessionId.trim() : "";
    const matches = [...this.#unbound, ...this.#byTurn.values()].filter(lease => lease.session_id === session);
    return matches.length === 1 ? matches[0]!.binding : null;
  }

  end(lease: AssignmentKernelTurnLeaseV2 | null): void {
    if (!lease) return;
    this.#unbound.delete(lease);
    for (const [turnId, candidate] of this.#byTurn) if (candidate === lease) this.#byTurn.delete(turnId);
  }

  clear(): void {
    this.#unbound.clear();
    this.#byTurn.clear();
  }
}
