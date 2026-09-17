import type { AssignmentKernelBindingInputV2 } from "../assignments/assignment_kernel_v2_lifecycle.js";

export type ActiveProviderTurn = {
  sessionId: string; messageId: string; threadId: string; turnId: string;
  binding: AssignmentKernelBindingInputV2 | null;
  interrupt: () => Promise<void>;
  steer: (text: string, commandId: string) => Promise<{ turnId: string }>;
  interruptionRequested: () => boolean;
};
const active = new Map<string, ActiveProviderTurn>();
const key = (sessionId: string, messageId: string) => JSON.stringify([sessionId, messageId]);
const sameBinding = (a: AssignmentKernelBindingInputV2 | null, b: AssignmentKernelBindingInputV2) => Boolean(a
  && a.session_id === b.session_id && a.assignment_id === b.assignment_id && a.run_id === b.run_id && a.generation === b.generation);

/** Callers authorize the session and canonical binding before reading controls. */
export function activeProviderTurnForBinding(binding: AssignmentKernelBindingInputV2): ActiveProviderTurn | null {
  const found = [...active.values()].filter(turn => sameBinding(turn.binding, binding));
  if (found.length > 1) throw new Error("Multiple provider turns match this task. Pause and check its status.");
  return found[0] ?? null;
}
export function registerActiveProviderTurn(turn: ActiveProviderTurn): () => void {
  const id = key(turn.sessionId, turn.messageId);
  if (active.has(id)) throw new Error("This task turn is already registered.");
  active.set(id, turn);
  return () => { if (active.get(id) === turn) active.delete(id); };
}
export async function interruptActiveProviderForBinding(binding: AssignmentKernelBindingInputV2): Promise<boolean> {
  const turn = activeProviderTurnForBinding(binding);
  if (!turn) return false;
  await turn.interrupt();
  return true;
}
