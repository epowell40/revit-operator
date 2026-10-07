import assert from "node:assert/strict";
import test from "node:test";
import { postconditionSatisfiedByPayloadV2 } from "../src/postcondition_verification_v2.js";

const apply = (name = "Description", value = "Supply grille", extra = {}) => ({
  path: "/revit/set-parameter", body: { changes: [{ elementId: 42, parameterName: name, value }], ...extra }
});
const receipt = (value: string, extra = {}) => ({ verification: [{
  elementId: 42, parameterName: "Description", status: "verified", actual: { storageType: "String", value }, ...extra
}] });

test("parameter verification binds native actual values and drafting normalization", () => {
  assert.equal(postconditionSatisfiedByPayloadV2(apply(), receipt("SUPPLY GRILLE")), true);
  assert.equal(postconditionSatisfiedByPayloadV2(apply(), { elements: [{ id: 42, parameters: { Description: "SUPPLY GRILLE" } }] }), true);
  for (const extra of [{ elementId: 43 }, { parameterName: "Comments" }, { status: "failed" }, { actual: undefined, expectedValue: "SUPPLY GRILLE" }])
    assert.equal(postconditionSatisfiedByPayloadV2(apply(), receipt("SUPPLY GRILLE", extra)), false);
  for (const value of ["Supply grille", "SUPPLY GRILLE ", "RETURN GRILLE"])
    assert.equal(postconditionSatisfiedByPayloadV2(apply(), receipt(value)), false);
  assert.equal(postconditionSatisfiedByPayloadV2(apply(), { request: receipt("SUPPLY GRILLE") }), false);
});

test("native preservation flags and protected values remain case-sensitive", () => {
  for (const extra of [{ preserveTextCase: true }, { changes: [{ elementId: 42, parameterName: "Description", value: "Supply grille", preserveTextCase: true }] }]) {
    assert.equal(postconditionSatisfiedByPayloadV2(apply("Description", "Supply grille", extra), receipt("Supply grille")), true);
    assert.equal(postconditionSatisfiedByPayloadV2(apply("Description", "Supply grille", extra), receipt("SUPPLY GRILLE")), false);
  }
  for (const [name, value] of [["Manufacturer", "Titus"], ["File Name", "Drawing"], ["Description", "https://Example.com"], ["Description", "A@B.com"], ["Description", "C:\\File"], ["Description", "/File"]]) {
    assert.equal(postconditionSatisfiedByPayloadV2(apply(name, value), receipt(value, { parameterName: name })), true);
    assert.equal(postconditionSatisfiedByPayloadV2(apply(name, value), receipt(value.toUpperCase(), { parameterName: name })), false);
  }
  assert.equal(postconditionSatisfiedByPayloadV2({ ...apply(), path: "/revit/other" }, receipt("SUPPLY GRILLE")), false);
});
