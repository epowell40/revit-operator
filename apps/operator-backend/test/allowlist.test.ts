import test from "node:test";
import assert from "node:assert/strict";
import { isAllowlisted, filterAllowlistedActions } from "../src/allowlist.js";

// Explicit expectations preserve the distinction between supported primitives
// and historical workflows; do not derive expected values from the allowlist.
const retainedPostPaths = [
  "/revit/state-snapshot",
  "/revit/update-schedule-cell",
  "/revit/get-placement-context",
  "/revit/find-elements",
  "/revit/get-connectors",
  "/revit/set-parameter",
  "/tools/redline/verify-visual",
  "/tools/mep/semantic-route-plan"
];

const excludedPaths = [
  "/ui/open",
  "/revit/replace-schedule-values",
  "/revit/plan-room-receptacles-from-analog",
  "/revit/apply-room-receptacles-from-analog",
  "/revit/locate-elements",
  "/revit/rank-similar-devices-on-wall",
  "/revit/project-point-to-host-frame",
  "/revit/audit-hosted-instance-placement",
  "/revit/resolve-redline-target",
  "/revit/propose-fix",
  "/revit/adjust-hosted-instance-on-host",
  "/revit/assign-electrical-circuit",
  "/revit/low-voltage-layout",
  "/revit/link-revit",
  "/revit/audit-electrical-circuit-loading",
  "/revit/connect-existing-mep-branch",
  "/revit/resize-ductwork-by-scope",
  "/revit/repair-duct-continuity-by-scope",
  "/revit/repair-mep-connectors"
];

for (const path of retainedPostPaths) {
  test(`retained primitive ${path} is admitted only as POST`, () => {
    assert.equal(isAllowlisted("POST", path), true);
    assert.equal(isAllowlisted("GET", path), false);
  });
}

for (const path of excludedPaths) {
  test(`excluded historical route ${path} stays denied despite caller allowlists`, () => {
    const callerAllowlist = { GET: new Set([path]), POST: new Set([path]) };
    for (const method of ["GET", "POST"] as const) {
      assert.equal(isAllowlisted(method, path), false);
      assert.equal(isAllowlisted(method, path, callerAllowlist), false);
    }
  });
}

test("action filtering retains supported work and drops excluded and unknown routes", () => {
  const paths = [...retainedPostPaths, ...excludedPaths, "/revit/not-real"];
  const actions = paths.map((path, index) => ({ action_id: String(index), method: "POST" as const, path, body: {} }));
  assert.deepEqual(filterAllowlistedActions(actions).map(action => action.path), retainedPostPaths);
});
