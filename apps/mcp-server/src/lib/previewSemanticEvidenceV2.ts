import { normalizeTextNoteTextV1, textNoteRoundTripMatchesV1 } from "@revitoperator/text-note-round-trip-v1";

type Scalar = string | number | boolean | null;

export type PreviewSemanticFactV2 = Readonly<{
  fact_id: string;
  fact_class: "control" | "domain";
  value: Scalar;
}>;

export type PreviewSemanticEvidenceV2 = Readonly<{
  recognized: boolean;
  admitted: boolean;
  facts: readonly PreviewSemanticFactV2[];
}>;

type Field = Readonly<{
  present: boolean;
  valid: boolean;
  value?: Scalar;
}>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedFieldName(value: string): string {
  return value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

function scalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function field(row: Record<string, unknown>, names: readonly string[]): Field {
  const accepted = new Set(names.map(normalizedFieldName));
  const matches = Object.entries(row).filter(([key]) => accepted.has(normalizedFieldName(key)));
  if (matches.length === 0) return { present: false, valid: false };
  if (matches.some(([, value]) => !scalar(value))) return { present: true, valid: false };
  const encoded = new Set(matches.map(([, value]) => JSON.stringify(value)));
  return encoded.size === 1
    ? { present: true, valid: true, value: matches[0]![1] as Scalar }
    : { present: true, valid: false };
}

/** Mirrors TextNoteTextCanonicalizer.Normalize without trimming user content. */
export function normalizeTextNoteTextV2(value: string): string {
  return normalizeTextNoteTextV1(value);
}

function text(fieldValue: Field): string | null {
  return fieldValue.valid && typeof fieldValue.value === "string" ? fieldValue.value : null;
}

function boolean(fieldValue: Field): boolean | null {
  return fieldValue.valid && typeof fieldValue.value === "boolean" ? fieldValue.value : null;
}

function sameIdentity(left: Field, right: Field): boolean {
  if (!left.valid || !right.valid || left.value === null || right.value === null) return false;
  return String(left.value) === String(right.value);
}

/**
 * Produces route-typed semantic evidence for a native rollback preview.
 * Unknown routes are denied by default: native success and rollback truth are
 * necessary effect evidence, but are not sufficient proof that the requested
 * domain proposal was actually evaluated.
 */
export function previewSemanticEvidenceV2(input: Readonly<{
  path: string;
  payload: unknown;
  requestBody: unknown;
  requestedEffect: "read" | "preview" | "apply" | undefined;
  authoritativePreview: boolean;
}>): PreviewSemanticEvidenceV2 {
  const path = input.path.toLowerCase();
  if (path !== "/revit/replace-text-note" && path !== "/revit/set-text-note-text") {
    return { recognized: false, admitted: false, facts: [] };
  }

  const result = object(input.payload);
  const request = object(input.requestBody);
  const resultTarget = field(result, ["text_note_id", "textNoteId", "element_id", "elementId"]);
  const requestTarget = field(request, ["text_note_id", "textNoteId", "element_id", "elementId"]);
  const before = text(field(result, ["before"]));
  const after = text(field(result, ["after"]));
  const proposed = text(field(result, ["proposed_text", "proposedText"]));
  const requested = text(field(request, ["new_text", "newText"]));
  const changed = boolean(field(result, ["changed"]));
  const dryRun = boolean(field(result, ["dry_run", "dryRun"]));

  const targetMatches = sameIdentity(resultTarget, requestTarget);
  const proposalMatches = proposed !== null && requested !== null
    && normalizeTextNoteTextV2(proposed) === normalizeTextNoteTextV2(requested);
  const stateUnchanged = before !== null && after !== null
    && normalizeTextNoteTextV2(before) === normalizeTextNoteTextV2(after);
  const changedConsistent = before !== null && proposed !== null && changed !== null
    && changed === !textNoteRoundTripMatchesV1(proposed, before);
  const admitted = input.requestedEffect === "preview"
    && input.authoritativePreview
    && dryRun === true
    && targetMatches
    && proposalMatches
    && stateUnchanged
    && changedConsistent;

  const facts: PreviewSemanticFactV2[] = [];
  if (resultTarget.valid && resultTarget.value !== undefined) {
    facts.push({ fact_id: "text_note.element_id", fact_class: "domain", value: resultTarget.value });
  }
  if (before !== null) facts.push({ fact_id: "text_note.before", fact_class: "domain", value: before });
  if (after !== null) facts.push({ fact_id: "text_note.after", fact_class: "domain", value: after });
  if (proposed !== null) facts.push({ fact_id: "text_note.proposed", fact_class: "domain", value: proposed });
  if (changed !== null) facts.push({ fact_id: "text_note.changed", fact_class: "domain", value: changed });
  if (input.requestedEffect === "preview") {
    facts.push(
      { fact_id: "control.preview_semantic_adapter_available", fact_class: "control", value: true },
      { fact_id: "control.preview_proposal_present", fact_class: "control", value: proposed !== null },
      { fact_id: "control.preview_proposal_matches_request", fact_class: "control", value: proposalMatches },
      { fact_id: "control.preview_target_matches_request", fact_class: "control", value: targetMatches },
      { fact_id: "control.preview_actual_state_unchanged", fact_class: "control", value: stateUnchanged },
      { fact_id: "control.preview_changed_consistent", fact_class: "control", value: changedConsistent }
    );
  }
  if (admitted) facts.push({ fact_id: "task.preview_valid", fact_class: "domain", value: true });
  return { recognized: true, admitted, facts };
}
