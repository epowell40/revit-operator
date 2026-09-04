import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  compareToolSearchCandidatesV3,
  isToolSearchRankingVersionV3,
  scoreToolSearchCandidateV3,
  TOOL_SEARCH_RANKING_VERSION_V3,
  toolSearchTokensV3
} from "./toolSearchRanking.js";

const query = "project-wide element inventory by category grouped by family and type complete count air terminals";

test("Candidate 22 inventory intent ranks quantify above unrelated type and repair tools", () => {
  const quantify = scoreToolSearchCandidateV3({
    method: "POST", path: "/revit/quantify", group: "Query", title: "Quantify",
    description: "Count/list elements in category (supports grouping).", example: "count doors"
  }, query);
  const listTypes = scoreToolSearchCandidateV3({
    method: "POST", path: "/revit/list-element-types", group: "Query", title: "List Element Types",
    description: "List loaded element types for a category."
  }, query);
  const repair = scoreToolSearchCandidateV3({
    method: "POST", path: "/revit/repair-duct-continuity-by-scope", group: "MEP", title: "Repair Duct Continuity By Scope",
    description: "Repair continuity breaks in an exact duct element set."
  }, query);
  assert.ok(quantify > listTypes, `${quantify} must exceed ${listTypes}`);
  assert.ok(quantify > repair, `${quantify} must exceed ${repair}`);
});

test("search tokens use exact ordinal tokens rather than substring matches", () => {
  assert.equal(toolSearchTokensV3("repair").includes("air"), false);
  assert.deepEqual(toolSearchTokensV3("inventories grouped elements"), ["quantify", "group", "element"]);
  assert.deepEqual(
    toolSearchTokensV3("TextNote elementId dryRun"),
    ["text", "note", "element", "id", "dry", "run"]
  );
});

test("reflection schema size cannot buy tool-search relevance", () => {
  const candidate = {
    method: "POST",
    path: "/revit/replace-text-note",
    group: "Modeling",
    title: "Replace Text Note",
    description: "Replace a TextNote's text.",
    example: "replace text note"
  };
  const query = "update TextNote text by element id dry run apply";
  const baseline = scoreToolSearchCandidateV3(candidate, query);
  const schemaStuffed = scoreToolSearchCandidateV3({
    ...candidate,
    required_fields: ["update", "TextNote", "text", "element", "id", "dry", "run", "apply"],
    optional_fields: Array.from({ length: 100 }, (_, index) => `unrelatedField${index}`)
  }, query);
  assert.equal(schemaStuffed, baseline);
});

test("cold native search is trusted only at the exact ranking version", () => {
  assert.equal(isToolSearchRankingVersionV3("operator.tool_search_ranking.v3"), true);
  assert.equal(isToolSearchRankingVersionV3("operator.tool_search_ranking.v2"), false);
  assert.equal(isToolSearchRankingVersionV3(undefined), false);
});

test("MCP registry projection and search response use the versioned ranking contract", () => {
  const serverUrl = [
    new URL("../server.ts", import.meta.url),
    new URL("../../src/server.ts", import.meta.url)
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(serverUrl, "MCP server source is missing");
  const source = fs.readFileSync(serverUrl, "utf8");
  assert.match(source, /group:\s*typeof e\.group === "string"/);
  assert.match(source, /example:\s*typeof e\.example === "string"/);
  assert.match(source, /ranking_version:\s*TOOL_SEARCH_RANKING_VERSION_V3/);
  assert.match(source, /!isToolSearchRankingVersionV3\(\(direct as any\)\?\.ranking_version\)/);
  assert.match(source, /\.sort\(compareToolSearchCandidatesV3\)/);
});

type GoldenCandidate = {
  method: string;
  path: string;
  risk: string;
  group: string;
  title: string;
  description: string;
  example: string;
  required_fields: string[];
  optional_fields: string[];
};

type GoldenQuery = {
  id: string;
  query: string;
  expected_first: string;
  required_top_five: string[];
  expected_scores: Record<string, number>;
};

function sharedGoldenVectors(): { schema: string; ranking_version: string; candidates: GoldenCandidate[]; queries: GoldenQuery[] } {
  const url = [
    new URL("../../../../packages/revit-tool-search-ranking-v3/golden-vectors.json", import.meta.url),
    new URL("../../../packages/revit-tool-search-ranking-v3/golden-vectors.json", import.meta.url)
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(url, "shared tool-search ranking vectors are missing");
  return JSON.parse(fs.readFileSync(url, "utf8"));
}

test("MCP tool search satisfies shared cross-process ranking vectors", () => {
  const golden = sharedGoldenVectors();
  assert.equal(golden.schema, "revit_operator.tool_search_ranking_golden_vectors/v3");
  assert.equal(golden.ranking_version, TOOL_SEARCH_RANKING_VERSION_V3);
  for (const vector of golden.queries) {
    const ranked = golden.candidates
      .map(tool => ({ tool, score: scoreToolSearchCandidateV3(tool, vector.query) }))
      .filter(candidate => candidate.score > 0)
      .sort(compareToolSearchCandidatesV3);
    assert.equal(ranked[0]?.tool.path, vector.expected_first, vector.id);
    const topFive = ranked.slice(0, 5).map(candidate => candidate.tool.path);
    for (const required of vector.required_top_five) {
      assert.ok(topFive.includes(required), `${vector.id}: ${required} missing from ${topFive.join(", ")}`);
    }
    for (const [candidatePath, expectedScore] of Object.entries(vector.expected_scores)) {
      assert.equal(
        ranked.find(candidate => candidate.tool.path === candidatePath)?.score,
        expectedScore,
        `${vector.id}: ${candidatePath}`
      );
    }
  }
});
