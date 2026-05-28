import test from "node:test";
import assert from "node:assert/strict";
import { isAllowlisted, filterAllowlistedActions } from "../src/allowlist.js";

test("state snapshot is allowlisted as POST", () => {
  assert.equal(isAllowlisted("POST", "/revit/state-snapshot"), true);
  assert.equal(isAllowlisted("GET", "/revit/state-snapshot"), false);
});

test("filterAllowlistedActions keeps state snapshot and drops unknown path", () => {
  const actions = [
    { action_id: "1", method: "POST" as const, path: "/revit/state-snapshot", body: {} },
    { action_id: "2", method: "POST" as const, path: "/revit/not-real", body: {} }
  ];
  const kept = filterAllowlistedActions(actions);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.path, "/revit/state-snapshot");
});

test("ui.open is allowlisted as POST", () => {
  assert.equal(isAllowlisted("POST", "/ui/open"), true);
  assert.equal(isAllowlisted("GET", "/ui/open"), false);
});


test("spatial EPIC-0138 endpoints are allowlisted as POST", () => {
  for (const path of [
    "/revit/locate-elements",
    "/revit/get-placement-context",
    "/revit/rank-similar-devices-on-wall",
    "/revit/project-point-to-host-frame",
    "/revit/audit-hosted-instance-placement",
    "/revit/resolve-redline-target",
    "/revit/propose-fix"
  ]) {
    assert.equal(isAllowlisted("POST", path), true);
    assert.equal(isAllowlisted("GET", path), false);
  }
});

test("hosted placement correction endpoint is allowlisted as POST", () => {
  assert.equal(isAllowlisted("POST", "/revit/adjust-hosted-instance-on-host"), true);
  assert.equal(isAllowlisted("GET", "/revit/adjust-hosted-instance-on-host"), false);
});

test("electrical circuit assignment endpoint is allowlisted as POST", () => {
  assert.equal(isAllowlisted("POST", "/revit/assign-electrical-circuit"), true);
  assert.equal(isAllowlisted("GET", "/revit/assign-electrical-circuit"), false);
});

test("low voltage layout endpoint is allowlisted as POST", () => {
  assert.equal(isAllowlisted("POST", "/revit/low-voltage-layout"), true);
  assert.equal(isAllowlisted("GET", "/revit/low-voltage-layout"), false);
});
