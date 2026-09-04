import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  conditionalActionPathEffect,
  pathLooksWrite,
  revitRouteEffect,
  revitRouteEffectWhenBodyUnavailable
} from "../src/action_path_mutability.js";
import { findRepoRoot } from "../src/tools/audit_tool_registry.js";

test("scoped duct resize is classified as a write", () => {
  assert.equal(pathLooksWrite("/revit/resize-ductwork-by-scope"), true);
});

test("known read-only POST endpoints remain read-only", () => {
  assert.equal(pathLooksWrite("/revit/context"), false);
  assert.equal(pathLooksWrite("/revit/activate-view", { viewId: 9948 }), false);
  assert.equal(pathLooksWrite("/revit/sheets"), false);
  assert.equal(pathLooksWrite("/revit/schedules"), false);
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
    "/revit/inspect-family-content",
    "/revit/warnings",
    "/revit/qa-checks",
    "/revit/print-sets",
    "/revit/revisions"
  ]) assert.equal(pathLooksWrite(route), false, `${route} should remain observational`);
  assert.equal(pathLooksWrite("/revit/apply-family-evolution"), true);
});

test("typed MCP and backend classify schedule reads through the same contract", () => {
  assert.equal(revitRouteEffect("/revit/schedules", "POST", { action: "list", max: 200 }), "read");
  assert.equal(revitRouteEffect("/revit/list-schedules", "POST", { action: "list", max: 200 }), "read");
  assert.equal(revitRouteEffect("/revit/unknown-future-route", "POST", {}), "apply");
});

test("Candidate 48 conditional native intent is shared across object and JSON request bodies", () => {
  const previewBody = {
    elementId: 1421361,
    newText: "ISSUE 04 - COORDINATION SET - 2026-08-09\nVERIFY AGAINST CURRENT SHEET INDEX",
    expectedOldText: "***An Autodesk Revit sample project***\r",
    dryRun: true,
    apply: false
  };
  const applyBody = { ...previewBody, dryRun: false, apply: true };

  for (const body of [previewBody, JSON.stringify(previewBody)]) {
    assert.equal(conditionalActionPathEffect("/revit/replace-text-note", body), "preview");
    assert.equal(revitRouteEffect("/revit/replace-text-note", "POST", body), "preview");
  }
  assert.equal(conditionalActionPathEffect("/revit/replace-text-note", applyBody), "apply");
  assert.equal(revitRouteEffect("/revit/replace-text-note", "POST", applyBody), "apply");
});

test("generic conditional intent remains deny-by-default and explicit handlers retain authority", () => {
  const conditionalRoutes = [
    "/revit/set-parameter",
    "/revit/update-parameter-by-query",
    "/revit/update-panel-parameter",
    "/revit/edit-mep-route-elements",
    "/revit/reroute-mep-route-segment"
  ];
  for (const route of conditionalRoutes) {
    assert.equal(revitRouteEffect(route, "POST", { dryRun: true, apply: false }), "preview", `${route} preview`);
    assert.equal(revitRouteEffect(route, "POST", { dryRun: false, apply: true }), "apply", `${route} apply`);
    assert.equal(revitRouteEffect(route, "POST", {}), "apply", `${route} unqualified request`);
  }
  assert.equal(revitRouteEffect("/revit/get-parameters", "POST", { dryRun: true, apply: false }), "read");
  assert.equal(revitRouteEffect("/revit/set-parameter", "POST", { dryRun: true, apply: true }), "apply");
  assert.equal(revitRouteEffect("/revit/lighting-audit", "POST", { visualize: true, apply: false }), "apply");
});

test("bodyless recovery is distinct from an authoritative empty request and fails closed", () => {
  assert.equal(revitRouteEffectWhenBodyUnavailable("/revit/fire-damper-audit", "POST"), "apply");
  assert.equal(revitRouteEffectWhenBodyUnavailable("/revit/visibility", "POST"), "apply");
  assert.equal(revitRouteEffectWhenBodyUnavailable("/revit/schedules", "POST"), "read");
  assert.equal(revitRouteEffectWhenBodyUnavailable("/revit/transaction-plan", "POST"), "preview");
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

test("backend process satisfies the cross-runtime Revit action-effect golden vectors", () => {
  const root = findRepoRoot(process.cwd());
  const contractRoot = fs.existsSync(path.join(root, "packages", "revit-action-effect-v1"))
    ? root
    : path.dirname(root);
  const contract = JSON.parse(fs.readFileSync(
    path.join(contractRoot, "packages", "revit-action-effect-v1", "golden-vectors.json"),
    "utf8"
  )) as {
    schema: string;
    vectors: Array<{
      id: string;
      method: string;
      path: string;
      body: unknown;
      expected_effect: "read" | "preview" | "apply";
    }>;
  };
  assert.equal(contract.schema, "revit_action_effect_v1_golden_vectors");
  for (const vector of contract.vectors) {
    assert.equal(
      revitRouteEffect(vector.path, vector.method, vector.body),
      vector.expected_effect,
      vector.id
    );
  }
});
