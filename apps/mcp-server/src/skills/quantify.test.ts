import test from "node:test";
import assert from "node:assert/strict";

import { parseQuantifyQuery } from "./quantify.js";

test("parseQuantifyQuery does not emit empty keywords_include", () => {
  const q = parseQuantifyQuery("count plumbing fixtures on Level 1");
  assert.equal(q.intent, "count");
  assert.ok(q.categories.includes("OST_PlumbingFixtures"));
  assert.equal(Array.isArray(q.filters.keywords_include), false);
});

test("parseQuantifyQuery maps toilets to keywords_include", () => {
  const q = parseQuantifyQuery("how many toilets are there?");
  assert.equal(q.intent, "count");
  assert.ok(q.categories.includes("OST_PlumbingFixtures"));
  assert.ok(Array.isArray(q.filters.keywords_include));
  assert.ok((q.filters.keywords_include ?? []).length > 0);
});

test("parseQuantifyQuery detects link scope", () => {
  const q = parseQuantifyQuery("list doors in linked models");
  assert.equal(q.intent, "list");
  assert.equal(q.scope, "both");
});

