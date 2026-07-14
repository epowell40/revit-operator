import assert from "node:assert/strict";
import test from "node:test";
import { createExistingConditionsEvaluatorChangeReceipt } from "../src/existing_conditions/evaluator_diff.js";

const packageContract = {
  scope: { model_bounds_ft: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } } },
  allowed_categories: ["OST_DuctCurves"]
};

function visible(items: unknown[], truncated = false) {
  return { viewId: 42, count: items.length, truncated, items };
}

test("evaluator receipt accepts only in-scope native changes", () => {
  const unchanged = { id: 1, builtInCategory: "OST_Walls", point: { x: 20, y: 20, z: 0 }, typeName: "Wall" };
  const created = { id: 2, builtInCategory: "OST_DuctCurves", geometry: { start: { model: { x: 1, y: 1, z: 1 } }, end: { model: { x: 5, y: 1, z: 1 } } }, typeName: "Rectangular" };
  const receipt = createExistingConditionsEvaluatorChangeReceipt(visible([unchanged]), visible([unchanged, created]), packageContract);
  assert.deepEqual(receipt.changed_element_keys, ["2"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, []);
  assert.match(receipt.receipt_sha256, /^[a-f0-9]{64}$/);
});

test("evaluator receipt reports modifications outside allowed scope", () => {
  const before = { id: 1, builtInCategory: "OST_Walls", point: { x: 20, y: 20, z: 0 }, typeName: "Wall A" };
  const after = { ...before, typeName: "Wall B" };
  const receipt = createExistingConditionsEvaluatorChangeReceipt(visible([before]), visible([after]), packageContract);
  assert.deepEqual(receipt.changed_element_keys, ["1"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, ["1"]);
});

test("evaluator receipt rejects incomplete native inventories", () => {
  assert.throws(
    () => createExistingConditionsEvaluatorChangeReceipt(visible([], true), visible([]), packageContract),
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
  const receipt = createExistingConditionsEvaluatorChangeReceipt(visible([before]), visible([after]), {
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
  const receipt = createExistingConditionsEvaluatorChangeReceipt(
    visible([curveBefore, terminalBefore]),
    visible([curveAfter, terminalAfter]),
    { scope: packageContract.scope, allowed_categories: ["OST_DuctCurves", "OST_DuctTerminal"] }
  );
  assert.deepEqual(receipt.changed_element_keys, ["2"]);
  assert.deepEqual(receipt.out_of_scope_changed_element_keys, ["2"]);
});
