import test from "node:test";
import assert from "node:assert/strict";
import { pathLooksWrite } from "../src/action_path_mutability.js";

test("scoped duct resize is classified as a write", () => {
  assert.equal(pathLooksWrite("/revit/resize-ductwork-by-scope"), true);
});

test("known read-only POST endpoints remain read-only", () => {
  assert.equal(pathLooksWrite("/revit/context"), false);
  assert.equal(pathLooksWrite("/revit/sheets"), false);
});
