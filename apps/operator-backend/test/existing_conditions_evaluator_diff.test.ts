import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createExistingConditionsEvaluatorChangeReceipt,
  validateExistingConditionsEvaluatorChangeReceipt
} from "../src/existing_conditions/evaluator_diff.js";

const KEY_ID = "existing-conditions-diff-test-key";
const SIGNING_KEY = "test-only-existing-conditions-diff-signing-key-0001";

const packageContract = {
  scope: { model_bounds_ft: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } } },
  allowed_categories: ["OST_DuctCurves"]
};

function visible(items: unknown[], truncated = false) {
  return { viewId: 42, count: items.length, truncated, items };
}

function authenticatedReceipt(before: unknown, after: unknown, agentPackage: unknown, candidateSnapshot: unknown = { native_readback: true, elements: [], connections: [], open_connector_count: 0 }) {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evaluator-diff-"));
  return createExistingConditionsEvaluatorChangeReceipt(before, after, agentPackage, {
    run: {
      fixture_id: "fixture-a",
      scope_id: "scope-a",
      workflow_fingerprint_sha256: "a".repeat(64),
      action_id: "apply-existing-conditions-stage",
      attempt_id: crypto.randomUUID(),
      capture_nonce: crypto.randomBytes(18).toString("base64url"),
      capture_name: "post.png",
      artifact_scope_root: artifactRoot
    },
    candidate_snapshot: candidateSnapshot,
    authority: { key_id: KEY_ID, signing_key: SIGNING_KEY }
  });
}

function expectedRun(receipt: ReturnType<typeof authenticatedReceipt>) {
  return {
    fixture_id: receipt.fixture_id,
    scope_id: receipt.scope_id,
    workflow_fingerprint_sha256: receipt.workflow_fingerprint_sha256,
    action_id: receipt.action_id,
    attempt_id: receipt.attempt_id,
    capture_nonce: receipt.capture_nonce,
    capture_name: receipt.capture_name,
    artifact_scope_root: receipt.artifact_scope_root,
    candidate_snapshot_sha256: receipt.candidate_snapshot_sha256,
    change_digest_sha256: receipt.change_digest_sha256
  };
}

test("evaluator receipt accepts only in-scope native changes", () => {
  const unchanged = { id: 1, builtInCategory: "OST_Walls", point: { x: 20, y: 20, z: 0 }, typeName: "Wall" };
  const created = { id: 2, builtInCategory: "OST_DuctCurves", geometry: { start: { model: { x: 1, y: 1, z: 1 } }, end: { model: { x: 5, y: 1, z: 1 } } }, typeName: "Rectangular" };
  const receipt = authenticatedReceipt(visible([unchanged]), visible([unchanged, created]), packageContract);
  assert.deepEqual(receipt.changed_element_keys, ["2"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, []);
  assert.match(receipt.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateExistingConditionsEvaluatorChangeReceipt(receipt, {
    trusted_key_resolver: keyId => keyId === KEY_ID ? SIGNING_KEY : null
  }), true);
});

test("authenticated diff rejects cross-run replay, forged digest, expiry, and missing authority", () => {
  const receipt = authenticatedReceipt(visible([]), visible([]), packageContract);
  const expected = expectedRun(receipt);
  const trusted = { trusted_key_resolver: (keyId: string) => keyId === KEY_ID ? SIGNING_KEY : null };
  for (const override of [
    { fixture_id: "fixture-b" },
    { workflow_fingerprint_sha256: "d".repeat(64) },
    { attempt_id: "different-attempt" }
  ]) {
    assert.equal(validateExistingConditionsEvaluatorChangeReceipt(receipt, {
      ...trusted,
      expected_run: { ...expected, ...override }
    }), false);
  }
  const forged = structuredClone(receipt);
  forged.change_digest_sha256 = "f".repeat(64);
  assert.equal(validateExistingConditionsEvaluatorChangeReceipt(forged, { ...trusted, expected_run: expected }), false);
  assert.equal(validateExistingConditionsEvaluatorChangeReceipt(receipt, { expected_run: expected }), false);
  assert.equal(validateExistingConditionsEvaluatorChangeReceipt(receipt, {
    ...trusted,
    expected_run: expected,
    now_ms: Date.parse(receipt.expires_at) + 6_000
  }), false);
});

test("evaluator receipt accepts the same multi-view discipline scope independent of view order", () => {
  const created = { id: 2, builtInCategory: "OST_DuctCurves", geometry: { start: { model: { x: 1, y: 1, z: 1 } }, end: { model: { x: 5, y: 1, z: 1 } } } };
  const before = { viewIds: [101, 202], count: 0, truncated: false, items: [] };
  const after = { viewIds: [202, 101], count: 1, truncated: false, items: [created] };
  const receipt = authenticatedReceipt(before, after, packageContract);
  assert.deepEqual(receipt.changed_element_keys, ["2"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, []);
});

test("evaluator receipt reports modifications outside allowed scope", () => {
  const before = { id: 1, builtInCategory: "OST_Walls", point: { x: 20, y: 20, z: 0 }, typeName: "Wall A" };
  const after = { ...before, typeName: "Wall B" };
  const receipt = authenticatedReceipt(visible([before]), visible([after]), packageContract);
  assert.deepEqual(receipt.changed_element_keys, ["1"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, ["1"]);
});

test("evaluator receipt rejects incomplete native inventories", () => {
  assert.throws(
    () => authenticatedReceipt(visible([], true), visible([]), packageContract),
    /before_visible_inventory_is_truncated/
  );
});

test("evaluator receipt ignores nondeterministic connector and circuit set ordering", () => {
  const before = {
    id: 1,
    builtInCategory: "OST_ElectricalFixtures",
    point: { x: 1, y: 1, z: 1 },
    electricalCircuit: { primaryLabel: "P1/3", labels: ["P1/3", "P1/1"], systemIds: [9, 7] },
    system: { connectedElementScopedIds: ["host:9", "host:7"], candidates: ["B", "A"] },
    connectorsSummary: {
      shapes: ["Round", "Invalid"],
      connectedElementScopedIds: ["host:9", "host:7"],
      sampleConnectors: [{ domain: "DomainElectrical", shape: "Invalid" }, { domain: "DomainElectrical", shape: "Round" }]
    }
  };
  const after = {
    ...before,
    electricalCircuit: { primaryLabel: "P1/1", labels: ["P1/1", "P1/3"], systemIds: [7, 9] },
    system: { connectedElementScopedIds: ["host:7", "host:9"], candidates: ["A", "B"] },
    connectorsSummary: {
      shapes: ["Invalid", "Round"],
      connectedElementScopedIds: ["host:7", "host:9"],
      sampleConnectors: [{ domain: "DomainElectrical", shape: "Invalid" }]
    }
  };
  const receipt = authenticatedReceipt(visible([before]), visible([after]), {
    scope: packageContract.scope,
    allowed_categories: ["OST_ElectricalFixtures"]
  });
  assert.deepEqual(receipt.changed_element_keys, []);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, []);
});

test("evaluator receipt ignores computed curve flow propagation but retains terminal design flow", () => {
  const curveBefore = {
    id: 1,
    builtInCategory: "OST_DuctCurves",
    point: { x: 20, y: 20, z: 1 },
    parameters: { cfm: "200 CFM", airflow: "200 CFM", diameter: "8\"" }
  };
  const curveAfter = {
    ...curveBefore,
    parameters: { cfm: "0 CFM", airflow: "0 CFM", diameter: "8\"" }
  };
  const terminalBefore = {
    id: 2,
    builtInCategory: "OST_DuctTerminal",
    point: { x: 20, y: 20, z: 1 },
    parameters: { cfm: "100 CFM", airflow: "100 CFM" }
  };
  const terminalAfter = {
    ...terminalBefore,
    parameters: { cfm: "125 CFM", airflow: "125 CFM" }
  };
  const receipt = authenticatedReceipt(
    visible([curveBefore, terminalBefore]),
    visible([curveAfter, terminalAfter]),
    { scope: packageContract.scope, allowed_categories: ["OST_DuctCurves", "OST_DuctTerminal"] }
  );
  assert.deepEqual(receipt.changed_element_keys, ["2"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, ["2"]);
});
