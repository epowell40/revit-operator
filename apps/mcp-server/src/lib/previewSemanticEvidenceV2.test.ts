import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTextNoteTextV2, previewSemanticEvidenceV2 } from "./previewSemanticEvidenceV2.js";

const request = {
  elementId: 1421361,
  newText: "ISSUE 04\nVERIFY",
  dryRun: true,
  apply: false
};

function result(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    dryRun: true,
    textNoteId: 1421361,
    before: "OLD\r",
    after: "OLD\r",
    proposedText: "ISSUE 04\nVERIFY",
    changed: true,
    ...overrides
  };
}

test("text-note normalization matches the native CR, CRLF, and escaped-line contract", () => {
  for (const value of ["A\rB", "A\r\nB", "A\\rB", "A\\r\\nB", "A\\nB"]) {
    assert.equal(normalizeTextNoteTextV2(value), "A\nB");
  }
  assert.equal(normalizeTextNoteTextV2("  A  \n"), "  A  \n", "user content is never trimmed");
});

test("typed text-note adapter binds proposal, target, rollback state, and change truth", () => {
  const evidence = previewSemanticEvidenceV2({
    path: "/revit/replace-text-note",
    payload: result(),
    requestBody: request,
    requestedEffect: "preview",
    authoritativePreview: true
  });
  assert.equal(evidence.recognized, true);
  assert.equal(evidence.admitted, true);
  assert.ok(evidence.facts.some(fact => fact.fact_id === "text_note.proposed" && fact.value === request.newText));
  assert.ok(evidence.facts.some(fact => fact.fact_id === "task.preview_valid" && fact.value === true));
});

test("preview change truth uses the native one-terminal-paragraph round-trip contract", () => {
  const evidence = previewSemanticEvidenceV2({
    path: "/revit/replace-text-note",
    payload: result({ before: "SAME\r", after: "SAME\r", proposedText: "SAME", changed: false }),
    requestBody: { ...request, newText: "SAME" },
    requestedEffect: "preview",
    authoritativePreview: true
  });
  assert.equal(evidence.admitted, true);
  assert.ok(evidence.facts.some(fact => fact.fact_id === "control.preview_changed_consistent" && fact.value === true));
});

test("proposal mismatch, missing echo, target mismatch, changed contradiction, and changed persistent state fail closed", () => {
  const invalid = [
    result({ proposedText: "DIFFERENT" }),
    result({ proposedText: undefined }),
    result({ textNoteId: 99 }),
    result({ changed: false }),
    result({ after: "MUTATED" })
  ];
  for (const payload of invalid) {
    const evidence = previewSemanticEvidenceV2({
      path: "/revit/replace-text-note",
      payload,
      requestBody: request,
      requestedEffect: "preview",
      authoritativePreview: true
    });
    assert.equal(evidence.admitted, false);
    assert.equal(evidence.facts.some(fact => fact.fact_id === "task.preview_valid"), false);
  }
});

test("native status alone cannot admit an unknown preview route", () => {
  const evidence = previewSemanticEvidenceV2({
    path: "/revit/delete",
    payload: { ok: true, dryRun: true, proposed: { deleteIds: [1] } },
    requestBody: { elementIds: [1], dryRun: true },
    requestedEffect: "preview",
    authoritativePreview: true
  });
  assert.deepEqual(evidence, { recognized: false, admitted: false, facts: [] });
});
