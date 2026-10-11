import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureWorkspaceLayout } from "./workspace.js";
import { canonicalJsonV2, type AssignmentSnapshotV2 } from "./domain/assignment-kernel/index.js";
import type { AssignmentKernelBindingInputV2 } from "./assignments/assignment_kernel_v2_lifecycle.js";

function writeDurable(file: string, value: unknown): void {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

type Binding = AssignmentKernelBindingInputV2 & { kernelVersion: 1 | 2 };
type Stored = { binding: Binding; message_id: string; request_hash: string;
  status: "pending" | "complete" | "error"; response?: unknown; failure?: unknown };
function identity(binding: Binding, messageId: unknown) {
  if (typeof messageId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId))
    throw new Error("desktop_response_message_identity_required");
  const root = path.join(ensureWorkspaceLayout().runs, "desktop-responses");
  fs.mkdirSync(root, { recursive: true });
  const key = createHash("sha256").update(canonicalJsonV2([binding.session_id, messageId])).digest("hex");
  return { file: path.join(root, key + ".json"), messageId };
}
function load(file: string, binding: Binding, messageId: string): Stored | null {
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
  if (record.message_id !== messageId || canonicalJsonV2(record.binding) !== canonicalJsonV2(binding)
      || !["pending", "complete", "error"].includes(record.status))
    throw new Error("desktop_response_binding_mismatch");
  return record;
}
/** Only call after HTTP authentication, session access and current binding validation. */
export function readDesktopResponse(binding: Binding, messageId: unknown): Stored | null {
  const id = identity(binding, messageId);
  return load(id.file, binding, id.messageId);
}
/** Claim before dispatch. An interrupted pending claim never authorizes redispatch. */
export async function retainDesktopResponse<T>(binding: Binding, messageId: unknown, request: unknown,
  invoke: () => Promise<T>, errorPayload: (error: unknown) => unknown): Promise<T> {
  const id = identity(binding, messageId);
  const requestHash = createHash("sha256").update(canonicalJsonV2(request)).digest("hex");
  const prior = load(id.file, binding, id.messageId);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("desktop_response_request_identity_conflict");
    // Even completed responses must be recovered explicitly, never executed twice.
    throw new Error("desktop_response_already_dispatched_use_result");
  }
  const pending: Stored = { binding, message_id: id.messageId, request_hash: requestHash, status: "pending" };
  writeDurable(id.file, pending);
  const persist = (record: Stored) => {
    const temporary = id.file + "." + randomUUID() + ".tmp";
    writeDurable(temporary, record);
    fs.renameSync(temporary, id.file);
  };
  let response: T;
  try { response = await invoke(); }
  catch (error) { persist({ ...pending, status: "error", failure: errorPayload(error) }); throw error; }
  // A persistence failure must not turn a successful provider call into a retry.
  persist({ ...pending, status: "complete", response });
  return response;
}

export function desktopResponseContinuationAllowed(state: AssignmentSnapshotV2 | null | undefined): boolean {
  return !!state && !state.terminal && state.execution_control?.state !== "paused" && !state.provider_usage_hold
    && state.quiescent && state.unresolved_unknown_operation_ids.length === 0
    && state.pending_input_variable_ids.length === 0 && state.pending_review_ids.length === 0;
}
