import assert from "node:assert/strict";
import test from "node:test";
import { scoreToolSearchCandidateV2, toolSearchTokensV2 } from "./toolSearchRanking.js";

const query = "project-wide element inventory by category grouped by family and type complete count air terminals";

test("Candidate 22 inventory intent ranks quantify above unrelated type and repair tools", () => {
  const quantify = scoreToolSearchCandidateV2({
    method: "POST", path: "/revit/quantify", group: "Query", title: "Quantify",
    description: "Count/list elements in category (supports grouping).", example: "count doors"
  }, query);
  const listTypes = scoreToolSearchCandidateV2({
    method: "POST", path: "/revit/list-element-types", group: "Query", title: "List Element Types",
    description: "List loaded element types for a category."
  }, query);
  const repair = scoreToolSearchCandidateV2({
    method: "POST", path: "/revit/repair-duct-continuity-by-scope", group: "MEP", title: "Repair Duct Continuity By Scope",
    description: "Repair continuity breaks in an exact duct element set."
  }, query);
  assert.ok(quantify > listTypes, `${quantify} must exceed ${listTypes}`);
  assert.ok(quantify > repair, `${quantify} must exceed ${repair}`);
});

test("search tokens use exact ordinal tokens rather than substring matches", () => {
  assert.equal(toolSearchTokensV2("repair").includes("air"), false);
  assert.deepEqual(toolSearchTokensV2("inventories grouped elements"), ["quantify", "group", "element"]);
});
