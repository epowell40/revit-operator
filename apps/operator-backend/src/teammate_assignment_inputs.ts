import type { ChatRequest } from "./contracts.js";
import { assignmentKernelV2ForBinding } from "./assignments/assignment_kernel_v2_factory.js";

export type TeammateTaskRequest = Pick<ChatRequest, "user_text" | "context"> & Partial<Pick<ChatRequest,
  "session_id" | "assignment_id" | "assignment_run_id" | "assignment_generation">>;

export function normalizedTeammateUserText(req: Pick<ChatRequest, "user_text" | "context">): string {
  const context = req.context && typeof req.context === "object" ? req.context as Record<string, unknown> : {};
  const ui = context.ui && typeof context.ui === "object" ? context.ui as Record<string, unknown> : {};
  const authoritative = typeof ui.authoritative_user_text === "string" && ui.authoritative_user_text.length <= 20_000
    ? ui.authoritative_user_text.trim() : "";
  return (authoritative || `${req.user_text || ""}`).replace(/\s+/g, " ").trim();
}

// Resolve answers from the authenticated journal. Caller context and prose
// cannot manufacture an answer or replace its exact value.
export function canonicalTeammateInputs(req: TeammateTaskRequest): Readonly<Record<string, unknown>> {
  if (!req.session_id || !req.assignment_id || !req.assignment_run_id || !Number.isSafeInteger(req.assignment_generation)) return {};
  const resolved = assignmentKernelV2ForBinding({ session_id: req.session_id, assignment_id: req.assignment_id,
    run_id: req.assignment_run_id, generation: Number(req.assignment_generation) });
  return resolved?.snapshot.input_values ?? {};
}
