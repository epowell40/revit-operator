import test from "node:test";
import assert from "node:assert/strict";
import { conditionalActionPathEffect, pathLooksWrite } from "../src/action_path_mutability.js";

test("scoped duct resize is classified as a write", () => {
  assert.equal(pathLooksWrite("/revit/resize-ductwork-by-scope"), true);
});

test("known read-only POST endpoints remain read-only", () => {
  assert.equal(pathLooksWrite("/revit/context"), false);
  assert.equal(pathLooksWrite("/revit/sheets"), false);
  assert.equal(pathLooksWrite("/revit/find-text-notes"), false);
  assert.equal(pathLooksWrite("/revit/locate-elements"), false);
  assert.equal(pathLooksWrite("/revit/plan-family-evolution"), false);
  assert.equal(pathLooksWrite("/revit/read-family-evolution"), false);
  assert.equal(pathLooksWrite("/revit/apply-family-evolution"), true);
});

test("native API policy is read-only over GET but mutating over POST", () => {
  assert.equal(pathLooksWrite("/revit/native-api-policy", undefined, "GET"), false);
  assert.equal(pathLooksWrite("/revit/native-api-policy", { policy: "certified" }, "POST"), true);
});

test("conditional audit and type-maintenance routes inspect the request body", () => {
  assert.equal(pathLooksWrite("/revit/visibility", { action: "get" }), false);
  assert.equal(conditionalActionPathEffect("/revit/visibility", { action: "hide_category", dryRun: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/visibility", { action: "hide_category" }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/duplicate-sheet", { sourceSheetNumber: "M000", dryRun: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/duplicate-sheet", { sourceSheetNumber: "M000" }), "apply");
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "audit" }), false);
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }), true);

  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "validate_ies" }), false);
  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "validate_ies", fix: true }), true);
  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "photometrics", visualize: true }), true);

  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "list" }), false);
  assert.equal(pathLooksWrite("/revit/list-element-types", {}), false);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "rename_types", dryRun: true }), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "purge_unused_in_family" }), true);
});

test("conditional route bodies may be supplied as serialized JSON", () => {
  assert.equal(pathLooksWrite(" /REVIT/FIRE-DAMPER-AUDIT ", '{"command":"fix"}'), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", '{"action":"list"}'), false);
});

test("conditional effects follow handler semantics instead of generic preview flags", () => {
  assert.equal(conditionalActionPathEffect("/revit/fire-damper-audit", { command: "fix", dryRun: true }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/lighting-audit", { visualize: true, apply: false }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/list-element-types", { action: "rename_types", apply: false }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/list-element-types", { action: "rename_types", dryRun: true }), "preview");
});

test("read methods stay read-only without weakening body-aware POST effects", () => {
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }, "GET"), false);
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }, "POST"), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "rename_types", dryRun: true }, "POST"), true);
});
