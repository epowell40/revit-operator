import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { registeredStageDuctBranchInputV2, registeredStageDuctBranchReadbackMatchesV2 }
  from "../src/verification/registered_stage_duct_branch_readback_v2.js";

const fixture = (): any => JSON.parse(fs.readFileSync("test/fixtures/c128-registered-tee-verification.json", "utf8"));
const check = (f: any) => registeredStageDuctBranchReadbackMatchesV2(f.input, f.affected_target_identities,
  f.apply, f.connectors.verificationParameters, f.connectors);

test("C128 registered PDF tee proves the native split, three ducts, tee, two elbows and one open end", () => {
  const f = fixture();
  assert.equal(registeredStageDuctBranchInputV2(f.input), true);
  assert.equal(check(f), true);
  for (const [name, mutate] of [
    ["preview", (x: any) => { x.input.body.dryRun = true; }],
    ["wrong main", (x: any) => { x.input.body.operations[0].apply_body.mainElementId += 1; }],
    ["wrong source point", (x: any) => { x.input.body.operations[0].apply_body.branchPoints[1].x += 1; }],
    ["missing tee", (x: any) => { x.connectors.results = x.connectors.results.filter((r: any) => r.id !== 1543348); }],
    ["tee disconnected from original main", (x: any) => {
      const tee = x.connectors.results.find((r: any) => r.id === 1543348);
      tee.connectors[0].physicalConnectedTo = [];
    }],
    ["wrong service", (x: any) => { x.connectors.results.find((r: any) => r.id === 1543339).connectors[0].systemClassification = "SupplyAir"; }],
    ["wrong diameter", (x: any) => { x.connectors.verificationParameters.items.find((r: any) => r.id === 1543339).parameters.Diameter = "0.5"; }],
    ["unexpected open end", (x: any) => { x.connectors.results.find((r: any) => r.id === 1543342).connectors[0].physicalConnectedTo = []; }],
    ["wrong far end", (x: any) => {
      x.connectors.results.find((r: any) => r.id === 1543345).connectors.find((c: any) => c.physicalConnectedTo.length === 0).origin[1] += 2;
    }],
    ["wrong created IDs", (x: any) => { x.apply.createdElementIds.pop(); }]
  ] as Array<[string, (x: any) => void]>) {
    const changed = fixture(); mutate(changed);
    assert.equal(check(changed), false, name);
  }
});
