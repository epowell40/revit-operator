import assert from "node:assert/strict";
import test from "node:test";
import { summarizeNativeApiCatalog } from "../src/tools/audit_native_api_gateway.js";

test("native API audit separates signature support from reachable targets", () => {
  const summary = summarizeNativeApiCatalog([
    { signature_supported: true, target_reachable: true, allowed: true, is_static: true, kind: "method", type: "Autodesk.Revit.DB.UnitUtils", risk: "low", terminally_useful: true },
    { signature_supported: true, target_reachable: true, allowed: true, is_static: false, kind: "ctor", type: "Autodesk.Revit.DB.XYZ", risk: "low" },
    { signature_supported: true, target_reachable: true, chainable: true, allowed: true, is_static: false, kind: "method", type: "Autodesk.Revit.DB.Document", risk: "high", mutating_hint: true },
    { signature_supported: true, target_reachable: true, allowed: true, is_static: true, kind: "method", type: "Autodesk.Revit.DB.Document", risk: "low" },
    { signature_supported: true, target_reachable: false, chainable: true, allowed: false, is_static: false, kind: "method", type: "Autodesk.Revit.DB.FilteredElementCollector", risk: "low" },
    { signature_supported: false, target_reachable: false, chainable: false, allowed: false, is_static: false, kind: "method", type: "Autodesk.Revit.DB.Element", risk: "high", freeze_risk_hint: true }
  ]);
  assert.equal(summary.catalog_total, 6);
  assert.equal(summary.signature_supported, 5);
  assert.equal(summary.always_directly_invocable_signature_upper_bound, 4);
  assert.equal(summary.other_instance_signature_supported_but_target_unproven, 1);
  assert.equal(summary.policy_allowed, 4);
  assert.equal(summary.target_reachable, 4);
  assert.equal(summary.chainable, 2);
  assert.equal(summary.terminally_useful_verified, 1);
  assert.equal(summary.terminally_useful_unverified, 5);
  assert.equal(summary.legacy_callable_fallback, 0);
});

test("native API audit reads old DLL callable only as a signature fallback", () => {
  const summary = summarizeNativeApiCatalog([
    { callable: true, allowed: true, is_static: true, kind: "method", type: "Autodesk.Revit.DB.UnitUtils" },
    { callable: false, allowed: false, is_static: false, kind: "method", type: "Autodesk.Revit.DB.Element" }
  ]);
  assert.equal(summary.signature_supported, 1);
  assert.equal(summary.target_reachable, 0);
  assert.equal(summary.terminally_useful_verified, 0);
  assert.equal(summary.legacy_callable_fallback, 2);
});
