import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTextNoteTextV2, previewSemanticEvidenceV2 } from "./previewSemanticEvidenceV2.js";
import { ductPreviewFixture } from "./mepDuctPreviewEvidence.fixtures.js";

test("duct previews require exact native geometry, profile, size and empty committed identities", () => {
  for (const legacy of [false, true]) for (const round of [false, true]) {
    const f = ductPreviewFixture(legacy, round);
    const verify = (payload = f.payload, requestBody = f.body, authoritativePreview = true) => previewSemanticEvidenceV2({
      path: f.path, payload, requestBody, authoritativePreview, requestedEffect: "preview"
    });
    assert.equal(verify().admitted, true);
    assert.equal(verify(f.payload, f.body, false).admitted, false);
    for (const mutate of [
      (r: any) => { r.segments[0].nativeGeometryReadback.start = { x: 0, y: 0, z: 0 }; },
      (r: any) => { r.segments[0].nativeSizeReadback = { shape: "unknown" }; },
      (r: any) => { r.segments[0].nativeSizeReadback[round ? "diameterFt" : "widthFt"] = 5; },
      (r: any) => { r.selected.ductType.id = 999; },
      (r: any) => { r.createdElementIds = [1542920]; },
      (r: any) => { r.totalLengthFt = 39.5; },
      (r: any) => { r.plannedPoints = []; },
      (r: any) => { r.dryRunElementIds = [999]; },
      (r: any) => { r.internalConnectionsVerified = false; },
      (r: any) => { delete r.rolledBack; }
    ]) {
      const bad = structuredClone(f.payload); mutate(bad);
      assert.equal(verify(bad).admitted, false);
    }
    assert.equal(verify({ id: 1542920, status: "Dry Run", sizeApplied: { width: true, height: true } }).admitted, false,
      "the C33 legacy success-shaped payload never proves a requested preview");
    assert.equal(verify(f.payload, { ...f.body, ductSize: "unknown" }).admitted, false);
    assert.equal(verify(f.payload, { ...f.body, ductShape: round ? "rectangular" : "round" }).admitted, false);
  }
});

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

test("workbook preview binds the exact selected instances, parameters, and output without claiming a file exists", () => {
  const route = "/revit/export-elements-xlsx", output = "C:/fixture/rooms.xlsx";
  const requestBody = { elementIds: [42, 43], parameterNames: ["Area", "Number"], dryRun: true };
  const payload = { ok: true, dryRun: true, path: output, selectedCount: 2, selectedElementIds: [42, 43],
    parameterCount: 2, parameterNames: ["Area", "Number"], artifact_receipt: {
      schema: "revit-operator.native-artifact-receipt.v1", method: "POST", path: route, phase: "preview",
      status: "not_started", expected_output_paths: [output], expected_export_calls: 1, export_calls: [], outputs: [] } };
  const evaluate = (value: unknown, body: unknown = requestBody) => previewSemanticEvidenceV2({ path: route, payload: value,
    requestBody: body, requestedEffect: "preview", authoritativePreview: true });
  assert.equal(evaluate(payload).admitted, true);
  assert.deepEqual(evaluate(payload).facts.map(f => f.fact_id), ["task.preview_valid", "artifact.planned_output_count"]);
  for (const change of [{ selectedCount: 1 }, { selectedElementIds: [42, 99] }, { selectedElementIds: [42, 42] },
    { parameterCount: 1 }, { parameterNames: ["Area", "Name"] }, { path: "C:/fixture/other.xlsx" },
    { dryRun: false }, { ok: false }, { artifact_receipt: { ...payload.artifact_receipt, outputs: [{ path: output }] } }]) {
    assert.equal(evaluate({ ...payload, ...change }).admitted, false, JSON.stringify(change));
  }
  assert.equal(evaluate(payload, { ...requestBody, elementIds: [42, 42] }).admitted, false);
  assert.equal(evaluate(payload, { ...requestBody, parameterNames: ["Area", "area"] }).admitted, false);
});
