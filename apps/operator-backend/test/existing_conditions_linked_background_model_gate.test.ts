import assert from "node:assert/strict";
import test from "node:test";
import {
  auditLinkedBackgroundModelHealth,
  type LinkedBackgroundModelGatePolicy
} from "../src/existing_conditions/linked_background_model_gate.js";

function health(items: unknown[], status = "Ok"): unknown {
  return {
    status,
    document: { title: "discipline-redacted", path: "C:\\fixtures\\discipline-redacted.rvt" },
    links: { revit: { items } }
  };
}

const architecturalLink = {
  typeId: 1362428,
  name: "Snowdon Towers Sample Architectural.rvt",
  instanceCount: 1,
  loaded: true,
  path: "C:\\fixtures\\Snowdon Towers Sample Architectural.rvt"
};

test("linked background gate passes one loaded placed architectural link with a source path", () => {
  const receipt = auditLinkedBackgroundModelHealth(health([
    architecturalLink,
    { typeId: 22, name: "Snowdon Towers Sample Structural.rvt", instanceCount: 1, loaded: false, path: null }
  ]));
  assert.equal(receipt.passed, true);
  assert.equal(receipt.matched_link_type_count, 1);
  assert.equal(receipt.matches[0]?.type_id, 1362428);
  assert.deepEqual(receipt.failure_classifications, []);
});

test("linked background gate rejects the real failure mode: expected link exists but is unloaded", () => {
  const receipt = auditLinkedBackgroundModelHealth(health([{ ...architecturalLink, loaded: false, path: null }]));
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failure_classifications.includes("background_link_unloaded"));
  assert.ok(receipt.failure_classifications.includes("background_link_source_path_missing"));
});

test("linked background gate does not accept an unrelated loaded Revit link", () => {
  const receipt = auditLinkedBackgroundModelHealth(health([
    { typeId: 99, name: "Snowdon Towers Sample Structural.rvt", instanceCount: 1, loaded: true, path: "C:\\fixtures\\structural.rvt" }
  ]));
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failure_classifications.includes("expected_background_link_not_found"));
});

test("linked background gate rejects a loaded link type with no placed instance", () => {
  const receipt = auditLinkedBackgroundModelHealth(health([{ ...architecturalLink, instanceCount: 0 }]));
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failure_classifications.includes("background_link_has_no_placed_instance"));
});

test("linked background gate rejects ambiguous architectural matches by default", () => {
  const receipt = auditLinkedBackgroundModelHealth(health([
    architecturalLink,
    { ...architecturalLink, typeId: 2, name: "Existing Architectural Shell.rvt" }
  ]));
  assert.equal(receipt.passed, false);
  assert.ok(receipt.failure_classifications.includes("expected_background_link_ambiguous"));
});

test("linked background gate supports project-specific name tokens without weakening native checks", () => {
  const policy: LinkedBackgroundModelGatePolicy = {
    expected_name_tokens: ["client", "background"],
    require_exactly_one_match: true,
    minimum_instance_count: 1,
    require_loaded: true,
    require_source_path: true
  };
  const receipt = auditLinkedBackgroundModelHealth(health([
    { typeId: 7, name: "Client Existing Conditions Background.rvt", instanceCount: 1, loaded: true, path: "C:\\fixtures\\client-background.rvt" }
  ]), policy);
  assert.equal(receipt.passed, true);
});

test("linked background gate fails closed on malformed or non-ok model health", () => {
  const malformed = auditLinkedBackgroundModelHealth({ status: "Error", links: { revit: { items: "not-an-array" } } });
  assert.equal(malformed.passed, false);
  assert.ok(malformed.failure_classifications.includes("model_health_status_not_ok"));
  assert.ok(malformed.failure_classifications.includes("expected_background_link_not_found"));
});
