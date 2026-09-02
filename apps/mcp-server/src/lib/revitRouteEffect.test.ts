import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { revitRouteCertificationEffect, revitRouteEffect } from "./revitRouteEffect.js";

type EffectVector = {
  id: string;
  method: string;
  path: string;
  body: unknown;
  expected_effect: "read" | "preview" | "apply";
};

test("Candidate 18 schedule child remains a read operation", () => {
  assert.equal(revitRouteEffect("/revit/schedules", "POST", { action: "list", query: "", max: 200 }), "read");
  assert.equal(revitRouteEffect("/revit/list-schedules", "POST", { action: "list", query: "", max: 200 }), "read");
});

test("Candidate 40 create-text inspection is a read even when the containing task requests preview", () => {
  assert.equal(revitRouteEffect("/revit/create-text", "POST", {
    action: "inspect",
    textNoteId: 1421361,
    text: "",
    typeName: "",
    newTypeName: "",
    baseTypeName: "",
    fontName: "",
    dryRun: true
  }), "read");
});

test("Candidate 48 conditional TextNote preview has the same effect before and after JSON transport", () => {
  const previewBody = {
    elementId: 1421361,
    newText: "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX",
    expectedOldText: "***An Autodesk Revit sample project***\r",
    dryRun: true,
    apply: false
  };

  assert.equal(revitRouteEffect("/revit/replace-text-note", "POST", previewBody), "preview");
  assert.equal(revitRouteEffect("/revit/replace-text-note", "POST", JSON.stringify(previewBody)), "preview");
  assert.equal(revitRouteEffect("/revit/replace-text-note", "POST", {
    ...previewBody,
    dryRun: false,
    apply: true
  }), "apply");
});

test("generic conditional intent is fail closed without weakening read-only or handler-specific routes", () => {
  assert.equal(revitRouteEffect("/revit/get-parameters", "POST", { apply: false, dryRun: true }), "read");
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "POST", { apply: false, dryRun: true }), "preview");
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "POST", { apply: true, dryRun: true }), "apply");
  assert.equal(revitRouteEffect("/revit/fire-damper-audit", "POST", { command: "fix", dryRun: true }), "apply");
});

test("certification risk remains conservative until a conditional handler has an explicit reviewed rule", () => {
  const body = { rowKey: "AHU-1", targetField: "Supply Air", value: "20000 CFM", apply: false, dryRun: true };
  assert.equal(revitRouteEffect("/revit/update-schedule-cell", "POST", body), "preview");
  assert.equal(revitRouteCertificationEffect("/revit/update-schedule-cell", "POST", body), "apply");
  assert.equal(revitRouteCertificationEffect("/revit/move-elements", "POST", { ids: [42], dryRun: true }), "preview");
  assert.equal(revitRouteCertificationEffect("/revit/schedules", "POST", { action: "list" }), "read");
});

test("shared route-effect contract stays fail closed for unknown POST routes", () => {
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "POST", {}), "apply");
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "GET"), "read");
});

test("MCP process satisfies the cross-runtime Revit action-effect golden vectors", () => {
  const contractUrl = [
    new URL("../../../../packages/revit-action-effect-v1/golden-vectors.json", import.meta.url),
    new URL("../../../packages/revit-action-effect-v1/golden-vectors.json", import.meta.url)
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(contractUrl, "shared Revit action-effect golden vectors are missing");
  const contract = JSON.parse(fs.readFileSync(contractUrl, "utf8")) as {
    schema: string;
    vectors: EffectVector[];
  };
  assert.equal(contract.schema, "revit_action_effect_v1_golden_vectors");
  for (const vector of contract.vectors) {
    assert.equal(
      revitRouteEffect(vector.path, vector.method, vector.body),
      vector.expected_effect,
      vector.id
    );
  }
});
