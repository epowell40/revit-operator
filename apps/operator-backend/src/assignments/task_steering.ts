import { createHash } from "node:crypto";
import { appendEvent, latestCommandEvent, recentCommandEvents } from "../memory/sqlite_store.js";
import { activeProviderTurnForBinding } from "../codex/active_turns.js";
import { assignmentKernelV2ForBinding } from "./assignment_kernel_v2_factory.js";
import { requestAssignmentInputV2, supplyAssignmentInputResultV2, type AssignmentKernelBindingInputV2 } from "./assignment_kernel_v2_lifecycle.js";

const KIND = "task.steering";
export type SteeringReceipt = {
  command_id: string; binding: AssignmentKernelBindingInputV2; text: string; thread_id: string | null; turn_id: string | null;
  state: "saved" | "sending" | "accepted" | "delivered" | "unconfirmed" | "rejected";
  updated_at: string; error?: string;
};
function save(receipt: SteeringReceipt): SteeringReceipt {
  if (!appendEvent(receipt.binding.session_id,"user",KIND,receipt)) throw new Error("The direction could not be saved. It was not sent again.");
  return receipt;
}
function latest(sessionId: string, id: string): SteeringReceipt | null {
  return latestCommandEvent(sessionId,KIND,id) as SteeringReceipt | null;
}
const same = (a: AssignmentKernelBindingInputV2,b: AssignmentKernelBindingInputV2) =>
  ["session_id","assignment_id","run_id","generation"].every(key => (a as any)[key] === (b as any)[key]);

/** The user input is journaled before dispatch; acknowledgements never mean delivery.
 * Existing operations remain retained, but their dependent results must be checked
 * against the new direction. The original document/effect authority stays fenced. */
export async function steerAssignment(input: {
  binding: AssignmentKernelBindingInputV2; command_id: string; text: string; expected_turn_id: string | null;
}): Promise<SteeringReceipt> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.command_id) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000)
    throw new Error("A direction and a valid command identity are required.");
  if (input.expected_turn_id !== null && (typeof input.expected_turn_id !== "string" || !input.expected_turn_id || input.expected_turn_id.length > 240))
    throw new Error("The current provider-turn fence is required.");
  const previous = latest(input.binding.session_id,input.command_id);
  if (previous) {
    if (!same(previous.binding,input.binding) || previous.text !== input.text || previous.turn_id !== input.expected_turn_id)
      throw new Error("This direction identity was already used for different content or a different turn.");
    return previous;
  }
  const resolved = assignmentKernelV2ForBinding(input.binding);
  if (!resolved || resolved.snapshot.terminal) throw new Error("This task is no longer active. Refresh its status.");
  const turn = activeProviderTurnForBinding(input.binding);
  if (turn?.turnId !== input.expected_turn_id && (turn || input.expected_turn_id)) throw new Error("The active turn changed. Your direction has not been sent.");
  if (turn?.interruptionRequested()) throw new Error("The task is pausing. Wait for it to pause before adding a direction.");
  let receipt = save({command_id:input.command_id,binding:{...input.binding},text:input.text,
    thread_id:turn?.threadId ?? null,turn_id:turn?.turnId ?? null,state:"saved",updated_at:new Date().toISOString()});
  const variableId = "user_direction_" + createHash("sha256").update(input.command_id).digest("hex").slice(0,32);
  try {
    requestAssignmentInputV2({binding:input.binding,clarification_id:input.command_id,variable_ids:[variableId],new_variable_ids:[variableId],question:"Additional direction from the user"});
    supplyAssignmentInputResultV2({binding:input.binding,clarification_id:input.command_id,external_values:{[variableId]:input.text}});
  } catch (error) {
    save({...receipt,state:"rejected",updated_at:new Date().toISOString(),error:"The task could not retain this direction as an input. No provider request was sent."});
    throw error;
  }
  if (!appendEvent(input.binding.session_id,"user","chat.message",{text:input.text,message_id:input.command_id,
    display:{source:"ui_context",message_id:input.command_id,text:input.text},steering:true})) throw new Error("The direction is saved with the task, but its conversation entry could not be saved.");
  if (!turn) return receipt;
  receipt = save({...receipt,state:"sending",updated_at:new Date().toISOString()});
  try {
    const accepted = await turn.steer(input.text,input.command_id);
    if (accepted.turnId !== turn.turnId) throw new Error("Provider acknowledged a different turn.");
    const observed = latest(input.binding.session_id,input.command_id);
    if (observed?.state === "delivered") return observed;
    return save({...receipt,state:"accepted",updated_at:new Date().toISOString()});
  } catch (error) {
    const observed = latest(input.binding.session_id,input.command_id);
    if (observed?.state === "delivered") return observed;
    return save({...receipt,state:"unconfirmed",updated_at:new Date().toISOString(),error:"The direction is saved, but delivery has not been confirmed. It will not be sent again automatically."});
  }
}

export function observeSteeringDelivery(sessionId: string, threadId: string, turnId: string, notification: any): void {
  if (notification?.method !== "item/completed" || notification.threadId !== threadId) return;
  const params = notification.params;
  const item = params?.item;
  if (params?.turnId !== turnId || item?.type !== "userMessage" || typeof item.clientId !== "string") return;
  const receipt = latest(sessionId,item.clientId);
  if (!receipt || receipt.thread_id !== threadId || receipt.turn_id !== turnId || ["delivered", "rejected"].includes(receipt.state)) return;
  // Receipt identity alone is insufficient if an upstream client mis-associates text.
  const text = Array.isArray(item.content) ? item.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
  if (text !== receipt.text) return;
  save({...receipt,state:"delivered",updated_at:new Date().toISOString()});
}

export function assignmentDirections(binding: AssignmentKernelBindingInputV2): SteeringReceipt[] {
  const unique = new Map<string,SteeringReceipt>();
  for (const receipt of recentCommandEvents(binding.session_id,KIND,256) as SteeringReceipt[]) {
    if (same(receipt.binding,binding) && !unique.has(receipt.command_id)) unique.set(receipt.command_id,receipt);
  }
  return [...unique.values()].reverse();
}
