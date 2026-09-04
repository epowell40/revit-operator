import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA,
  evidenceTargetIdentityValuesV1,
  isEvidenceTargetIdentityFieldV1,
  parseEvidenceRetrievalSelectorV1,
  selectExactEvidenceTargetsV1
} from "@revitoperator/assignment-kernel-v2-contracts";

type GoldenVectors = {
  selector_schema: string;
  valid_selectors: Array<{ id: string; input: unknown; expected: unknown }>;
  invalid_selectors: Array<{ id: string; input: unknown; error: string }>;
  target_selection_vectors: Array<{
    id: string;
    payload: unknown;
    target_subset: string[];
    expected_selection: unknown;
    expected_paths: string[];
  }>;
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

test("backend process enforces every shared evidence-retrieval selector vector", () => {
  const golden = sharedVectors();
  assert.equal(golden.selector_schema, EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA);
  for (const vector of golden.valid_selectors) {
    const parsed = parseEvidenceRetrievalSelectorV1(vector.input);
    assert.deepEqual(parsed, vector.expected, vector.id);
    assert.equal(Object.isFrozen(parsed), true, `${vector.id}: parsed selector must be immutable`);
    assert.deepEqual(parseEvidenceRetrievalSelectorV1(JSON.parse(JSON.stringify(vector.input))), parsed, `${vector.id}: JSON round trip`);
  }
  for (const vector of golden.invalid_selectors) {
    assert.throws(() => parseEvidenceRetrievalSelectorV1(vector.input), new RegExp(vector.error), vector.id);
  }
  assert.throws(() => parseEvidenceRetrievalSelectorV1({ fields: undefined }), /fields must contain 1\.\.64 paths/);
});

test("backend process selects exact target-bound evidence across every shared golden shape", () => {
  const golden = sharedVectors();
  for (const vector of golden.target_selection_vectors) {
    const selected = selectExactEvidenceTargetsV1(vector.payload, vector.target_subset);
    assert.equal(selected.schema, EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA, vector.id);
    assert.deepEqual(selected.selection, vector.expected_selection, vector.id);
    assert.deepEqual(selected.selection_paths, vector.expected_paths, `${vector.id}: paths`);
    assert.deepEqual(selected.matched_target_ids, [...new Set(vector.target_subset)], `${vector.id}: targets`);
    const transported = selectExactEvidenceTargetsV1(
      JSON.parse(JSON.stringify(vector.payload)),
      JSON.parse(JSON.stringify(vector.target_subset))
    );
    assert.deepEqual(transported, selected, `${vector.id}: JSON transport round trip`);
  }
  for (const vector of golden.rejected_target_vectors) {
    assert.throws(
      () => selectExactEvidenceTargetsV1(vector.payload, vector.target_subset),
      new RegExp(vector.error),
      vector.id
    );
  }
});

test("reviewed target identity fields reject control identities, arbitrary prose, and unsupported scalar types", () => {
  for (const field of ["unique_id", "element", "elementId", "element_id", "target-id", "sheetUniqueID", "ownerViewName", "room_ids", "level", "sourceScopedId", "connector_id"]) {
    assert.equal(isEvidenceTargetIdentityFieldV1(field), true, field);
  }
  for (const field of ["id", "ids", "operationId", "assignment_id", "request-id", "correlationId", "providerCallId", "message", "description", "text", "status", "value", "valid", "grid"]) {
    assert.equal(isEvidenceTargetIdentityFieldV1(field), false, field);
  }
  assert.deepEqual(evidenceTargetIdentityValuesV1([42, "  UID-α  ", 42, false, null, 1.5, { id: 9 }]), ["42", "UID-α"]);
  assert.throws(() => selectExactEvidenceTargetsV1({ metadata: { "target-7": { secret: "not a target map" } } }, ["target-7"]), /did not match exact target identities/);
});
