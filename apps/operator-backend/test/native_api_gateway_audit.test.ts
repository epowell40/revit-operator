import assert from "node:assert/strict";
import test from "node:test";
import { summarizeNativeApiCatalog } from "../src/tools/audit_native_api_gateway.js";

test("native API audit separates signature support from reachable targets", () => {
  const summary = summarizeNativeApiCatalog([
    { callable: true, allowed: true, is_static: true, kind: "method", type: "Autodesk.Revit.DB.UnitUtils", risk: "low" },
    { callable: true, allowed: true, is_static: false, kind: "ctor", type: "Autodesk.Revit.DB.XYZ", risk: "low" },
    { callable: true, allowed: true, is_static: false, kind: "method", type: "Autodesk.Revit.DB.Document", risk: "high", mutating_hint: true },
    { callable: true, allowed: true, is_static: true, kind: "method", type: "Autodesk.Revit.DB.Document", risk: "low" },
    { callable: true, allowed: false, is_static: false, kind: "method", type: "Autodesk.Revit.DB.FilteredElementCollector", risk: "low" },
    { callable: false, allowed: false, is_static: false, kind: "method", type: "Autodesk.Revit.DB.Element", risk: "high", freeze_risk_hint: true }
  ]);
  assert.equal(summary.catalog_total, 6);
  assert.equal(summary.signature_supported, 5);
  assert.equal(summary.always_directly_invocable_signature_upper_bound, 4);
  assert.equal(summary.other_instance_signature_supported_but_target_unproven, 1);
  assert.equal(summary.policy_allowed, 4);
});
