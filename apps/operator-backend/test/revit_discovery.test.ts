import test from "node:test";
import assert from "node:assert/strict";
import { buildRevitDemoDiscoveryPayload } from "../src/benchmark/revit_discovery.js";

function taskRequest(payload: ReturnType<typeof buildRevitDemoDiscoveryPayload>, taskId: string): Record<string, unknown> {
  const task = (payload.tasks as Record<string, { request?: Record<string, unknown> }>)[taskId];
  return task?.request ?? {};
}

test("Revit demo discovery payload selects candidate demo inputs", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-05-14T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    userProfile: "C:\\Users\\User",
    context: { documentTitle: "Demo Model" },
    sheetsBody: {
      note: "sample",
      items: [
        { id: 101, viewId: 101, sheetNumber: "E101", name: "Power Plan" },
        { id: 102, viewId: 102, sheetNumber: "E102", name: "Lighting Plan" },
        { id: 103, viewId: 103, sheetNumber: "A101", name: "Floor Plan" }
      ]
    },
    viewsBody: [
      { id: 201, name: "Level 1 Floor Plan", type: "FloorPlan" },
      { id: 202, name: "Level 1 Power Plan", type: "FloorPlan" }
    ],
    receptacleFindBody: { elementIds: [301, 302] },
    receptacleQuantifyBody: {
      summary: { total: 2, groups: { "Duplex | Level 1 | 101 Office": 2 } },
      rows: [{ id: 301, type: "Duplex", level: "Level 1", room: "101 Office" }],
      warnings: ["Room resolution unresolved (unresolved:no_room_at_point:1)"]
    }
  });

  assert.deepEqual(taskRequest(payload, "demo_sheet_export").sheetNumbers, ["E101", "E102"]);
  assert.deepEqual(taskRequest(payload, "demo_takeoff_lighting").categories, ["OST_LightingFixtures"]);
  assert.deepEqual(taskRequest(payload, "demo_takeoff_mechanical_equipment").categories, ["OST_MechanicalEquipment"]);
  assert.equal(taskRequest(payload, "demo_redline_receptacles").viewId, 202);
  assert.deepEqual(taskRequest(payload, "demo_parameter_edit").elementIds, [301]);

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].exemplarElementId, 301);
  assert.deepEqual(placements[0].parameterOverrides, {
    Mark: "R-DEM-01",
    Comments: "DEMO REDLINE",
    Panel: "LP-1",
    "Circuit Number": "12"
  });
  assert.deepEqual((payload._discovery.candidateCounts as Record<string, unknown>).receptacleRows, 1);
});

test("Revit demo discovery payload leaves explicit gaps when candidates are missing", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-05-14T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [] },
    viewsBody: [],
    receptacleFindBody: { elementIds: [] },
    receptacleQuantifyBody: { rows: [] }
  });

  assert.deepEqual(taskRequest(payload, "demo_sheet_export").sheetNumbers, []);
  assert.deepEqual(taskRequest(payload, "demo_parameter_edit").elementIds, []);
  assert.equal(taskRequest(payload, "demo_redline_receptacles").viewId, null);

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].exemplarElementId, null);
});
