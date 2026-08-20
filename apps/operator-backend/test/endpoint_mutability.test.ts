import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { conditionalActionPathEffect, pathLooksWrite } from "../src/action_path_mutability.js";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";

test("scoped duct resize is classified as a write", () => {
  assert.equal(pathLooksWrite("/revit/resize-ductwork-by-scope"), true);
});

test("known read-only POST endpoints remain read-only", () => {
  assert.equal(pathLooksWrite("/revit/context"), false);
  assert.equal(pathLooksWrite("/revit/activate-view", { viewId: 9948 }), false);
  assert.equal(pathLooksWrite("/revit/sheets"), false);
  assert.equal(pathLooksWrite("/revit/find-text-notes"), false);
  assert.equal(pathLooksWrite("/revit/locate-elements"), false);
  assert.equal(pathLooksWrite("/revit/find-duplicate-marks"), false);
  assert.equal(pathLooksWrite("/revit/get-placement-context"), false);
  assert.equal(pathLooksWrite("/revit/model-health"), false);
  assert.equal(pathLooksWrite("/revit/plan-family-evolution"), false);
  assert.equal(pathLooksWrite("/revit/read-family-evolution"), false);
  assert.equal(pathLooksWrite("/revit/spatial-context"), false);
  assert.equal(pathLooksWrite("/revit/pick-at-pixel"), false);
  assert.equal(pathLooksWrite("/revit/resolve-room-plan-view"), false);
  assert.equal(pathLooksWrite("/revit/get-titleblock-info"), false);
  for (const route of [
    "/revit/regenerate",
    "/revit/plan-dwelling-receptacles",
    "/revit/plan-room-receptacles-from-analog",
    "/revit/room_mep_intersect",
    "/revit/audit-hosted-instance-placement",
    "/revit/audit-electrical-circuit-loading",
    "/revit/audit-plumbing-fixture-services",
    "/revit/resolve-redline-target",
    "/revit/propose-fix",
    "/revit/capture-screenshare",
    "/revit/set-selection",
    "/revit/get-family-file-path",
    "/revit/find-family-text-notes",
    "/revit/warnings",
    "/revit/qa-checks",
    "/revit/print-sets",
    "/revit/revisions"
  ]) assert.equal(pathLooksWrite(route), false, `${route} should remain observational`);
  assert.equal(pathLooksWrite("/revit/apply-family-evolution"), true);
});

test("backend read classification covers every low-risk Revit POST in the add-in manifest", () => {
  const root = findRepoRoot(process.cwd());
  const publicCandidate = path.join(root, "apps", "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs");
  const privateCandidate = path.join(root, "revit-bridge-addin", "RevitBridge", "Operator", "OperatorToolManifest.cs");
  const manifest = fs.readFileSync(fs.existsSync(publicCandidate) ? publicCandidate : privateCandidate, "utf8");
  const lowRiskPosts = [...manifest.matchAll(/new OperatorToolInfo\([^\r\n]*?"POST"\s*,\s*"([^"]+)"[^\r\n]*?OperatorActionRisk\.Low/g)]
    .map((match) => match[1]!)
    .filter((route) => route.startsWith("/revit/"));
  // These low-risk commands intentionally change durable job state or create
  // external files, so the teammate loop keeps treating them as effects.
  const externalOrControlEffects = new Set([
    "/revit/batch-control",
    "/revit/export-dwg",
    "/revit/export-elements-xlsx",
    "/revit/export-ifc",
    "/revit/export-pdf",
    "/revit/export-schedule-csv",
    "/revit/export-warnings-report",
    "/revit/print",
    "/revit/transaction-plan"
  ]);
  for (const route of lowRiskPosts) {
    if (externalOrControlEffects.has(route)) continue;
    assert.equal(pathLooksWrite(route), false, `${route} drifted from the add-in's low-risk read contract`);
  }
});

test("native API policy is read-only over GET but mutating over POST", () => {
  assert.equal(pathLooksWrite("/revit/native-api-policy", undefined, "GET"), false);
  assert.equal(pathLooksWrite("/revit/native-api-policy", { policy: "certified" }, "POST"), true);
  assert.equal(pathLooksWrite("/revit/native-api-ops", { operations: [{ op: "get_property" }] }, "POST"), false);
});

test("conditional audit and type-maintenance routes inspect the request body", () => {
  assert.equal(pathLooksWrite("/revit/visibility", { action: "get" }), false);
  assert.equal(conditionalActionPathEffect("/revit/visibility", { action: "hide_category", dryRun: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/visibility", { action: "hide_category" }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/duplicate-sheet", { sourceSheetNumber: "M000", dryRun: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/duplicate-sheet", { sourceSheetNumber: "M000" }), "apply");
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "audit" }), false);
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }), true);

  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "validate_ies" }), false);
  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "validate_ies", fix: true }), true);
  assert.equal(pathLooksWrite("/revit/lighting-audit", { command: "photometrics", visualize: true }), true);

  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "list" }), false);
  assert.equal(pathLooksWrite("/revit/list-element-types", {}), false);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "rename_types", dryRun: true }), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "purge_unused_in_family" }), true);

  assert.equal(conditionalActionPathEffect("/revit/create-text", { action: "list_types" }), "read");
  assert.equal(pathLooksWrite("/revit/create-text", { action: "list_types" }), false);
  assert.equal(conditionalActionPathEffect("/revit/create-text", { action: "create", dryRun: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/create-text", { action: "create" }), "apply");
});

test("conditional route bodies may be supplied as serialized JSON", () => {
  assert.equal(pathLooksWrite(" /REVIT/FIRE-DAMPER-AUDIT ", '{"command":"fix"}'), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", '{"action":"list"}'), false);
});

test("conditional effects follow handler semantics instead of generic preview flags", () => {
  assert.equal(conditionalActionPathEffect("/revit/fire-damper-audit", { command: "fix", dryRun: true }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/lighting-audit", { visualize: true, apply: false }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/list-element-types", { action: "rename_types", apply: false }), "apply");
  assert.equal(conditionalActionPathEffect("/revit/list-element-types", { action: "rename_types", dryRun: true }), "preview");
});

test("artifact publication routes distinguish executable preflight from real output", () => {
  for (const route of ["/revit/export-pdf", "/revit/export-dwg", "/revit/export-ifc", "/revit/export-elements-xlsx"]) {
    assert.equal(conditionalActionPathEffect(route, { dryRun: true }), "preview");
    assert.equal(conditionalActionPathEffect(route, { dryRun: false }), "apply");
    assert.equal(pathLooksWrite(route, { dryRun: true }), true);
    assert.equal(pathLooksWrite(route, { dryRun: false }), true);
  }
  assert.equal(conditionalActionPathEffect("/revit/export-pdf", { preflightOnly: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/export-pdf", { preflight: true }), "preview");
  assert.equal(conditionalActionPathEffect("/revit/export-pdf", {}), "apply");
  assert.equal(conditionalActionPathEffect("/revit/print", {}), "preview");
  assert.equal(conditionalActionPathEffect("/revit/print", { dryRun: false }), "apply");
});

test("read methods stay read-only without weakening body-aware POST effects", () => {
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }, "GET"), false);
  assert.equal(pathLooksWrite("/revit/fire-damper-audit", { command: "fix" }, "POST"), true);
  assert.equal(pathLooksWrite("/revit/list-element-types", { action: "rename_types", dryRun: true }, "POST"), true);
});
