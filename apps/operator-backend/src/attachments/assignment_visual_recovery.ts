import type { ChatRequest } from "../contracts.js";
import type { AssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { sameAssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import { getConversationTurn } from "../memory/sqlite_store.js";
import { findSessionUploadById } from "./upload_index.js";

/** Supplied only by the host after resolving the current durable assignment. */
export type AssignmentVisualRecovery = Readonly<{
  new_provider_thread: boolean;
  source_binding: AssignmentBindingV2;
  current_binding: AssignmentBindingV2;
  source_message_id: string;
}>;

export function recoverAssignmentVisualAttachments(req: ChatRequest, recovery?: AssignmentVisualRecovery): ChatRequest {
  if (!recovery?.new_provider_thread) return req;
  const binding = recovery.current_binding;
  if (!sameAssignmentBindingV2(recovery.source_binding, binding)
    || req.session_id !== binding.session_id || req.assignment_id !== binding.assignment_id
    || req.assignment_run_id !== binding.run_id || req.assignment_generation !== binding.generation) return req;
  const sourceMessage = recovery.source_message_id;
  if (!sourceMessage || (binding.run_id.startsWith("chat:") && binding.run_id !== `chat:${sourceMessage}`)) return req;
  const context = req.context as { revit?: { document?: { projectIdentity?: { fingerprint?: unknown } } } } | undefined;
  if (binding.document_fingerprint
    && context?.revit?.document?.projectIdentity?.fingerprint !== binding.document_fingerprint) return req;
  const original = getConversationTurn(binding.session_id, sourceMessage).find(turn => turn.role === "user" && turn.message_id === sourceMessage);
  if (!original?.attachments?.length) return req;
  if (original.attachments.length > 32) throw new Error("The saved task has too many source attachments to restore safely in one turn.");
  const attachments = [...(req.user_attachments ?? [])];
  const ids = new Set(attachments.map(attachment => attachment.id));
  for (const source of original.attachments) {
    if (ids.has(source.id)) continue; // Current explicit uploads take precedence.
    const registered = findSessionUploadById(binding.session_id, source.id);
    if (!registered?.relative_path || !registered.sha256)
      throw new Error(`The saved task attachment ${source.name || source.id} is unavailable in this conversation. Reattach the intended source before continuing.`);
    attachments.push({ id: source.id, relative_path: registered.relative_path, filename: registered.filename,
      bytes: registered.bytes, sha256: registered.sha256, mime: registered.mime, created_at: registered.created_at });
    ids.add(source.id);
  }
  return attachments.length === (req.user_attachments?.length ?? 0) ? req : { ...req, user_attachments: attachments };
}
