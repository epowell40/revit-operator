import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA,
  assignmentKernelControlEvidenceFactsV2,
  parseEvidenceRetrievalSelectorV1,
  selectExactEvidenceTargetsV1
} from "@revitoperator/assignment-kernel-v2-contracts";

test("MCP retained page facts survive transport without giving missing selections domain authority", () => {
  const result = { schema: "revit-operator.evidence-retrieval.v1", evidence_ref: { evidence_id: "ev1_page" },
    selection: [{ id: 201 }, { id: 202 }], pagination: { path: "payload.result", start: 1, requested_count: 2, returned_count: 2, total_items: 7 } };
  const facts = (value: unknown) => assignmentKernelControlEvidenceFactsV2("operator_retrieve_evidence", value)
    .filter(fact => fact.fact_id === "control.evidence_selection_available");
  const expected = facts({ ok: true, result });
  assert.deepEqual(expected.map(fact => fact.dimensions?.selection_path), ["payload.result[1]", "payload.result[2]"]);
  assert.ok(expected.every(fact => fact.fact_class === "control"));
  assert.deepEqual(facts(JSON.parse(JSON.stringify({ ok: true, result }))), expected);
  assert.deepEqual(facts({ ok: true, result: { ...result, pagination: { ...result.pagination, returned_count: 3 } } }), []);
  assert.deepEqual(facts({ ok: true, result: { ...result, selection: [] } }), []);
  assert.deepEqual(facts({ ok: false, result }), []);
  assert.deepEqual(facts({ ok: true, result: { ...result, selection: { "payload.absent": null }, missing_fields: ["payload.absent"] } }), []);
});

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
