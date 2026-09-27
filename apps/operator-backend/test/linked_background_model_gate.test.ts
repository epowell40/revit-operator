import assert from "node:assert/strict";
import test from "node:test";
import { auditLinkedBackgroundModelHealth, DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY } from "../src/existing_conditions/linked_background_model_gate.js";

const policy = {
  ...DEFAULT_LINKED_BACKGROUND_MODEL_GATE_POLICY,
  expected_document_path: "C:\\fixtures\\current\\Snowdon Towers Sample HVAC.rvt",
  expected_source_path: "C:\\fixtures\\current\\Snowdon Towers Sample Architectural.rvt"
};

function health(documentPath: string, linkPath: string) {
  return {
    status: "Ok",
    document: { title: "Snowdon Towers Sample HVAC", path: documentPath },
    links: { revit: { items: [{ name: "Snowdon Towers Sample Architectural.rvt", typeId: 31,
      instanceCount: 1, loaded: true, path: linkPath }] } }
  };
}

test("background gate rejects a loaded same-name link from an older fixture", () => {
  const receipt = auditLinkedBackgroundModelHealth(health(policy.expected_document_path,
    "C:\\fixtures\\old\\Snowdon Towers Sample Architectural.rvt"), policy);
  assert.equal(receipt.passed, false);
  assert.deepEqual(receipt.failure_classifications, ["background_link_source_path_mismatch"]);
  assert.equal(receipt.matches[0]?.loaded, true);
});

test("background gate rejects the wrong host and accepts the paired fixture case-insensitively", () => {
  const wrongHost = auditLinkedBackgroundModelHealth(health("C:\\fixtures\\old\\Snowdon Towers Sample HVAC.rvt",
    policy.expected_source_path), policy);
  assert.equal(wrongHost.passed, false);
  assert.deepEqual(wrongHost.failure_classifications, ["fixture_document_path_mismatch"]);

  const paired = auditLinkedBackgroundModelHealth(health("c:\\FIXTURES\\current\\Snowdon Towers Sample HVAC.rvt",
    "c:\\FIXTURES\\current\\Snowdon Towers Sample Architectural.rvt"), policy);
  assert.equal(paired.passed, true);
  assert.deepEqual(paired.failure_classifications, []);
});
