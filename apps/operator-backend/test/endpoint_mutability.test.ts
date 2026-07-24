import test from "node:test";
import assert from "node:assert/strict";
import { __testOnlyPathLooksWrite } from "../src/brains/openai_brain.js";

test("scoped duct resize is classified as a write", () => {
  assert.equal(__testOnlyPathLooksWrite("/revit/resize-ductwork-by-scope"), true);
});

test("known read-only POST endpoints remain read-only", () => {
  assert.equal(__testOnlyPathLooksWrite("/revit/context"), false);
  assert.equal(__testOnlyPathLooksWrite("/revit/sheets"), false);
});
