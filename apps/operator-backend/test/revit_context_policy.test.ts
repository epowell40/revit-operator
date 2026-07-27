import test from "node:test";
import assert from "node:assert/strict";

import { hasRevitTurnContext, mayInjectUnscopedLegacyMemory } from "../src/revit_context_policy.js";

test("canonical and Sidecar compatibility envelopes both identify Revit turns", () => {
  assert.equal(hasRevitTurnContext({ revit: { schema: "revit-operator.context.v1" } }), true);
  assert.equal(hasRevitTurnContext({ ui: { revit_document: { path: "C:\\Models\\Duke B200.rvt" } } }), true);
  assert.equal(hasRevitTurnContext({ ui: { client: "operator-desktop" } }), false);
});

test("unscoped legacy memory is suppressed only for Revit turns", () => {
  assert.equal(mayInjectUnscopedLegacyMemory(undefined), true);
  assert.equal(mayInjectUnscopedLegacyMemory({ ui: { client: "web" } }), true);
  assert.equal(mayInjectUnscopedLegacyMemory({ revit: { document: { title: "Untitled" } } }), false);
  assert.equal(mayInjectUnscopedLegacyMemory({ ui: { revit_document: { title: "Untitled" } } }), false);
});
