import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { familyPlacementReadbackMatchesV2 } from "../src/verification/family_placement_postcondition_v2.js";

function fixture() {
  return {
    input: { path: "/revit/create-family-instance", body: { familyName: "HeatRecoveryUnit", symbolName: "Heat Recovery Unit (HRU)", levelName: "L4", x: -37.78, y: -5.05, z: 42.32152230971508, rotationDegrees: 0, dryRun: false } },
    applied: { status: "Placed", success: true, dryRun: false, count: 1, instances: [{ index: 0, id: 1542933, x: -37.78, y: -5.05, z: 42.32152230971508 }], transaction: { status: "committed", committed: true, added_element_ids: [1542933] } },
    summary: [{ id: 1542933, found: true, className: "FamilyInstance", familyName: "HeatRecoveryUnit", typeName: "Heat Recovery Unit (HRU)", levelName: "L4", location: { type: "point", x: -37.78, y: -5.05, z: 42.32152230971508, rotationRadians: 0 } }]
  };
}

test("whole-area HRU readback rejects the actual doubled level offset despite correct create-response coordinates", () => {
  const f = fixture();
  const retained = JSON.parse(fs.readFileSync("test/fixtures/c42-family-placement-readback.json", "utf8"));
  assert.equal(familyPlacementReadbackMatchesV2(f.input, retained.native_apply, retained.actual_summary), false);
  assert.equal(retained.actual_summary[0].location.z, 74.48818897638554);
  f.summary[0]!.location.z = 74.48818897638554;
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, f.summary), false);
  f.summary[0]!.location.z = f.input.body.z;
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, f.summary), true);
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, { result: f.summary }), true);
});

test("family placement rejects wrong identity, family, type, level, rotation, unknown location and request echoes", () => {
  for (const mutate of [
    (f: any) => f.summary[0].id++, (f: any) => f.summary[0].familyName = "Other",
    (f: any) => f.summary[0].typeName = "Other", (f: any) => f.summary[0].levelName = "L5",
    (f: any) => f.summary[0].location.rotationRadians = Math.PI,
    (f: any) => delete f.summary[0].location, (f: any) => f.summary[0].found = false,
    (f: any) => f.applied.transaction.added_element_ids = [],
    (f: any) => f.input.body.viewId = 1363433,
    (f: any) => f.summary = { request: { result: f.summary } },
    (f: any) => f.summary = { success: true, instances: f.applied.instances }
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, f.summary), false);
  }
});

test("family batch requires every unique created member at its requested spacing and cyclic rotation", () => {
  const f: any = fixture();
  Object.assign(f.input.body, { count: 2, spacingX: 12, spacingY: 3, spacingZ: -2, rotationDegrees: 360 });
  f.applied.count = 2;
  f.applied.instances.push({ index: 1, id: 1542934 });
  f.applied.transaction.added_element_ids.push(1542934);
  const second = structuredClone(f.summary[0]); second.id = 1542934;
  second.location.x += 12; second.location.y += 3; second.location.z -= 2;
  f.summary.unshift(second);
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, f.summary), true);
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, [second]), false);
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, [second, second]), false);
  f.summary[1].location.z += 1;
  assert.equal(familyPlacementReadbackMatchesV2(f.input, f.applied, f.summary), false);
});
