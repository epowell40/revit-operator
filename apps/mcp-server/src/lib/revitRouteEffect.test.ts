import assert from "node:assert/strict";
import test from "node:test";
import { revitRouteEffect } from "./revitRouteEffect.js";

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

test("shared route-effect contract stays fail closed for unknown POST routes", () => {
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "POST", {}), "apply");
  assert.equal(revitRouteEffect("/revit/unclassified-future-command", "GET"), "read");
});
