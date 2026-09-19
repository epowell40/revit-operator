/** Intake may select observed labels, but it cannot turn them into model facts. */
export const IDENTITY_FIELDS = ["model_open_state", "document_title", "active_view_name", "active_view_type", "selected_count"] as const;
export type IdentityField = typeof IDENTITY_FIELDS[number];
export const QUESTION_KINDS = ["ui_identity", "general_explanation", "historical_conversation", "current_model", "research", "engineering", "action"] as const;

export function renderIdentityAnswer(observation: Record<string, unknown>, fields: readonly IdentityField[]): string | null {
  if (!fields.length || new Set(fields).size !== fields.length || fields.some(field => !IDENTITY_FIELDS.includes(field))) return null;
  if (observation.state === "no_open_model") return fields.every(field => field === "model_open_state") ? "Revit is open without a model." : null;
  if (observation.state !== "available") return null;
  const parts: string[] = [];
  for (const field of fields) {
    if (field === "model_open_state") { parts.push("A model is open in Revit."); continue; }
    const value = observation[field];
    if (field === "selected_count") {
      if (!Number.isSafeInteger(value) || (value as number) < 0) return null;
      parts.push(`${value} ${value === 1 ? "element is" : "elements are"} selected.`);
    } else {
      if (typeof value !== "string" || !value.trim()) return null;
      // Quoting an exact observed label is not an assertion about its meaning.
      const caption = field === "document_title" ? "Open model" : field === "active_view_name" ? "Active view" : "View type";
      parts.push(`${caption}: ${JSON.stringify(value)}.`);
    }
  }
  return parts.join(" ");
}
