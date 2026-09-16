import type { TeammateTurnContract } from "./teammate_loop_runtime.js";

export function formatTeammateTurnContractValue(contract: TeammateTurnContract): string {
  if (!contract.intent_summary) return "";
  const compact = {
    schema: contract.schema,
    turn_kind: contract.turn_kind,
    ambiguity: contract.ambiguity,
    context_state: contract.context_state,
    stage: contract.stage,
    no_write: contract.no_write,
    write_authorized: contract.write_authorized,
    ...(contract.file_export_paths ? { file_export_paths: contract.file_export_paths } : {}),
    preview_required: contract.preview_required,
    max_apply_attempts: contract.max_apply_attempts,
    verification_required: contract.verification_required,
    ...(contract.required_user_inputs.length > 0 ? { required_user_inputs: contract.required_user_inputs } : {}),
    user_text_sha256: contract.user_text_sha256,
    document_signature: contract.document_signature
  };
  const rules = contract.file_export_paths
    ? "Read the exact model scope and representative parameter names, export the requested workbook in one bulk call, then verify its exact file digest with inspect-exported-files. Preserve all model-edit restrictions."
    : contract.turn_kind === "conversation"
    ? "Answer naturally; do not call Revit for a conceptual answer."
    : contract.required_user_inputs.length > 0
      ? `Use read-only Revit calls to ground the exact target and current state, then call operator_request_clarification with missingFields=${JSON.stringify(contract.required_user_inputs)} and one concise question. Do not preview or apply an opaque value that is not bound to authenticated user input.`
    : contract.ambiguity === "material"
      ? "Paraphrase the likely intent and ask one focused question; take no Revit action."
      : contract.preview_required && contract.no_write
        ? "Use live context; resolve the exact target and execute one real bounded, noncommitting Revit preview or dry-run, then independently read back any rollback-preview target before reporting success and stop before apply. A prose plan, table, proposed receipt, capture, cropped image, render, or temporary visual is not an executed mutation preview without a successful noncommitting Revit primitive receipt. If discovery proves no preview-capable target or primitive exists, report that exact blocker instead of claiming preview completion."
        : contract.preview_required
          ? "Use live context; resolve the exact target and execute a real bounded preview or dry-run before applying; bind the apply to that preview and verify by readback/capture before success. A prose plan, table, or proposed receipt is not an executed preview."
      : contract.turn_kind === "mutation"
        ? "Use live context; discover one exact contract if needed; perform the authorized work directly in a bounded edit and verify by readback/capture before success. When the user requests a first item for review, complete and verify that real item, then stop for review. A separate preview is needed only when explicitly requested or required by the primitive's execution contract."
        : "Use live context and the smallest read/navigation step; discover one exact contract if needed; never mutate the model.";
  const requestedOperation = requestedPreviewOperation(contract.intent_summary);
  const semanticPreviewRule = requestedOperation === "create"
    ? " A requested new, duplicated, dependent, or enlarged view is not previewed by resolving only its source, crop, rooms, or geometry. Complete one noncommitting create/duplicate-view primitive with the requested configuration (for example transaction-plan duplicateView/createDependentView plus crop, scale, template, or visibility actions) before reporting the preview."
    : requestedOperation === "delete"
      ? " A requested deletion, removal, or disconnection-impact preview is not completed by inventory, geometry, connector, or network inspection alone. Opposite orientations or shared-network membership are triage evidence, not proof that a candidate is intentional or erroneous. Execute one rollback/dry-run delete of the highest-ranked defensible candidate and report the exact affected/dependent elements before claiming the preview. Preserve the material comparison facts used to rank the candidate. Distinguish the exact elements and physical connections that would be affected if the preview were committed, including the predicted remaining connected-system state, from the later rollback-restoration state. After rollback, re-read the previewed member and any requested connection/system state; explicitly report whether the target still exists and whether its connections were restored. If no defensible candidate can be selected, report the assignment as incomplete; do not substitute a no-candidate conclusion for the requested executable discriminator."
      : "";
  return `CURRENT TURN CONTRACT (host-enforced):\n${JSON.stringify(compact)}\n${rules}${semanticPreviewRule}${contract.file_export_paths ? " The requested workbook export is authorized as a file effect and must be verified with inspect-exported-files; any model-preservation constraint still forbids Revit edits." : contract.no_write ? " No-write wording is authoritative: preview/read only." : ""}`;
}

export function requestedPreviewOperation(text: string): string | null {
  const explicitViewCreation = /\b(?:create|add|duplicate)\b[^.!?\n]{0,80}\b(?:view|plan)\b/i.test(text)
    || /\b(?:new|duplicated|dependent|enlarged)\b[^.!?\n]{0,80}\b(?:view|plan)\b/i.test(text)
    || /\bmake\s+(?:an?\s+|the\s+)?(?:new|duplicated|dependent|enlarged)\b[^.!?\n]{0,80}\b(?:view|plan)\b/i.test(text);
  if (explicitViewCreation) return "create";
  const explicitDeletionPreview = /\b(?:preview|preflight|dry[ -]?run|rollback)\b[^.!?\n]{0,120}\b(?:delet(?:e|ion)|remov(?:e|al)|disconnect(?:ion)?)\b/i.test(text)
    || /\b(?:delet(?:e|ion)|remov(?:e|al)|disconnect(?:ion)?)\b[^.!?\n]{0,120}\b(?:preview|preflight|dry[ -]?run|rollback|impact)\b/i.test(text);
  return explicitDeletionPreview ? "delete" : null;
}

