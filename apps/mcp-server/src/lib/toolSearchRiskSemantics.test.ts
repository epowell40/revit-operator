import assert from "node:assert/strict";
import test from "node:test";
import {
  buildToolSearchRiskFilterAdvisory,
  partitionRiskFilteredCandidates,
  shouldExposeBroaderRiskCandidates,
  TOOL_SEARCH_RISK_FILTER_ADVISORY_V1
} from "./toolSearchRiskSemantics.js";

const candidate36Query = "TextNote find list identity conditional exact text replacement preview dry run duplicate prevention";

test("Candidate 36 mutation preview discovery exposes the typed route hidden by a low-risk filter", () => {
  assert.equal(shouldExposeBroaderRiskCandidates(candidate36Query, "low"), true);
  const candidates = [
    { path: "/revit/find-text-notes", risk: "low", score: 244 },
    { path: "/revit/replace-text-note", risk: "high", score: 238 },
    { path: "/revit/native-api-mutation-ops", risk: "high", score: 120 }
  ];
  const partitioned = partitionRiskFilteredCandidates(candidates, "low", 8);
  assert.deepEqual(partitioned.matches.map(item => item.path), ["/revit/find-text-notes"]);
  assert.deepEqual(partitioned.broaderRiskCandidates.map(item => item.path), [
    "/revit/replace-text-note",
    "/revit/native-api-mutation-ops"
  ]);
  const advisory = buildToolSearchRiskFilterAdvisory("low", partitioned.broaderRiskCandidates);
  assert.equal(advisory.schema, TOOL_SEARCH_RISK_FILTER_ADVISORY_V1);
  assert.equal(advisory.authorization_effect, "none");
  assert.match(advisory.meaning, /dry-run or rollback support does not reclassify/);
});

test("ordinary low-risk read discovery remains strictly filtered without mutation advisory", () => {
  assert.equal(shouldExposeBroaderRiskCandidates("inspect current document context", "low"), false);
  const partitioned = partitionRiskFilteredCandidates([
    { path: "/revit/context", risk: "low" },
    { path: "/revit/replace-text-note", risk: "high" }
  ], "low", 8);
  assert.deepEqual(partitioned.matches.map(item => item.path), ["/revit/context"]);
});
