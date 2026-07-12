import assert from "node:assert/strict";
import test from "node:test";
import { canonicalLevelAlias, resolveLevelIdentities } from "../src/deterministic/aec_level_identity.js";

test("level aliases resolve only to one unique live identity without numeric coercion", () => {
  assert.equal(canonicalLevelAlias("Level 4"), "4");
  assert.equal(canonicalLevelAlias("L4"), "4");
  assert.equal(canonicalLevelAlias("Level 1 - Block 43"), "1|block 43");
  const live = [{ id: 1, name: "L3" }, { id: 2, name: "L4" }, { id: 3, name: "Level 04" }];
  assert.deepEqual(resolveLevelIdentities(["Level 4"], live), { status: "resolved", levels: [{ id: 2, name: "L4", requested: "Level 4", match: "canonical_alias" }], blockers: [] });
  assert.equal(resolveLevelIdentities(["Level 04"], live).status, "resolved");
});

test("missing, ambiguous, duplicate, malformed, and possibly truncated levels fail closed", () => {
  assert.equal(resolveLevelIdentities(["Level 9"], [{ id: 1, name: "L4" }]).status, "blocked");
  assert.equal(resolveLevelIdentities(["Level 4"], [{ id: 1, name: "L4" }, { id: 2, name: "Lvl 4" }]).status, "blocked");
  assert.equal(resolveLevelIdentities(["L4", "Level 4"], [{ id: 1, name: "L4" }]).status, "blocked");
  assert.equal(resolveLevelIdentities(["L4"], [{ id: 1, name: "L4" }, { id: 1, name: "Other" }]).status, "blocked");
  assert.equal(resolveLevelIdentities(["L4"], new Array(500).fill(0).map((_, index) => ({ id: index + 1, name: `L${index + 1}` }))).status, "blocked");
});
