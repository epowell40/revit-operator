import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA,
  parseEvidenceRetrievalSelectorV1,
  selectExactEvidenceTargetsV1
} from "@revitoperator/assignment-kernel-v2-contracts";

type GoldenVectors = {
  selector_schema: string;
  valid_selectors: Array<{ id: string; input: unknown; expected: unknown }>;
  invalid_selectors: Array<{ id: string; input: unknown; error: string }>;
  target_selection_vectors: Array<{ id: string; payload: unknown; target_subset: string[]; expected_selection: unknown; expected_paths: string[] }>;
  rejected_target_vectors: Array<{ id: string; payload: unknown; target_subset: string[]; error: string }>;
};

function sharedVectors(): GoldenVectors {
  const candidates = [
    path.resolve(process.cwd(), "node_modules", "@revitoperator", "assignment-kernel-v2-contracts", "evidence-retrieval-selector-golden-vectors.json"),
    path.resolve(process.cwd(), "..", "packages", "assignment-kernel-v2-contracts", "evidence-retrieval-selector-golden-vectors.json"),
    path.resolve(process.cwd(), "..", "public", "packages", "assignment-kernel-v2-contracts", "evidence-retrieval-selector-golden-vectors.json")
  ];
  const selected = candidates.find(candidate => existsSync(candidate));
  assert.ok(selected, "Missing shared evidence-retrieval selector golden vectors.");
  return JSON.parse(readFileSync(selected, "utf8")) as GoldenVectors;
}

test("MCP process matches the shared selector and exact-target golden vectors", () => {
  const golden = sharedVectors();
  assert.equal(golden.selector_schema, EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA);
  for (const vector of golden.valid_selectors) {
    assert.deepEqual(parseEvidenceRetrievalSelectorV1(vector.input), vector.expected, vector.id);
  }
  for (const vector of golden.invalid_selectors) {
    assert.throws(() => parseEvidenceRetrievalSelectorV1(vector.input), new RegExp(vector.error), vector.id);
  }
  for (const vector of golden.target_selection_vectors) {
    const selected = selectExactEvidenceTargetsV1(vector.payload, vector.target_subset);
    assert.deepEqual(selected.selection, vector.expected_selection, vector.id);
    assert.deepEqual(selected.selection_paths, vector.expected_paths, `${vector.id}: paths`);
  }
  for (const vector of golden.rejected_target_vectors) {
    assert.throws(() => selectExactEvidenceTargetsV1(vector.payload, vector.target_subset), new RegExp(vector.error), vector.id);
  }
});
