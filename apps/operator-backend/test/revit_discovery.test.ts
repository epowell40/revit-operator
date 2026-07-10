import test from "node:test";
import assert from "node:assert/strict";
import { buildRevitDemoDiscoveryPayload, enrichExistingTagMoveFromVisibleElements, enrichReceptacleRedlineFromPlacementContext } from "../src/benchmark/revit_discovery.js";

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
    },
    mechanicalEquipmentQuantifyBody: {
      rows: [
        { id: 401, source: "host", type: "VAV", level: "Level 2" },
        { id: 402, source: "host", type: "VAV", level: "Level 1 Power Plan" }
      ]
    }
  });

  assert.deepEqual(taskRequest(payload, "demo_sheet_export").sheetNumbers, ["E101", "E102"]);
  assert.deepEqual(taskRequest(payload, "demo_sheet_export").viewIds, [101, 102]);
  assert.deepEqual(taskRequest(payload, "demo_takeoff_lighting").categories, ["OST_LightingFixtures"]);
  assert.deepEqual(taskRequest(payload, "demo_takeoff_mechanical_equipment").categories, ["OST_MechanicalEquipment"]);
  assert.equal(taskRequest(payload, "demo_redline_receptacles").viewId, 202);
  assert.equal(taskRequest(payload, "demo_redline_receptacles").cleanupCreatedElements, true);
  assert.deepEqual(taskRequest(payload, "demo_parameter_edit").elementIds, [301]);
  assert.equal(taskRequest(payload, "demo_parameter_edit").readbackRequired, true);
  assert.equal(taskRequest(payload, "demo_parameter_edit").revertAfterVerify, true);
  assert.equal(taskRequest(payload, "demo_redline_mep_route").viewId, 202);
  assert.equal(taskRequest(payload, "demo_redline_mep_route").kind, "duct");
  assert.equal(taskRequest(payload, "demo_redline_mep_route").cleanupCreatedElements, true);
  assert.equal(taskRequest(payload, "demo_redline_mep_pipe_route").kind, "pipe");
  assert.equal(taskRequest(payload, "demo_redline_mep_pipe_route").visualViewId, 202);
  assert.deepEqual((taskRequest(payload, "demo_documentation_primitives").tag as Record<string, unknown>).elementIds, [301]);
  assert.equal((taskRequest(payload, "demo_documentation_primitives").tag as Record<string, unknown>).viewId, 202);
  assert.equal((taskRequest(payload, "demo_model_edit_primitives").createFamilyInstance as Record<string, unknown>).symbolName, "Generic Annotation");
  assert.equal(taskRequest(payload, "demo_model_edit_primitives").visualViewId, 202);

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].exemplarElementId, 301);
  assert.deepEqual(placements[0].parameterOverrides, {
    Mark: "R-DEM-01",
    Comments: "DEMO REDLINE",
    Panel: "LP-1",
    "Circuit Number": "12"
  });
  assert.deepEqual((payload._discovery.candidateCounts as Record<string, unknown>).receptacleRows, 1);
  assert.deepEqual((payload._discovery.candidateCounts as Record<string, unknown>).mechanicalEquipmentRows, 2);
  assert.equal(payload._discovery.fallbackEditableElementId, 301);
});

test("Revit demo discovery payload falls back to mechanical equipment ids for editable and taggable targets", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-05-14T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [] },
    viewsBody: [
      { id: 202, name: "L1 - Block 43", type: "FloorPlan" }
    ],
    receptacleFindBody: { elementIds: [] },
    receptacleQuantifyBody: { rows: [] },
    mechanicalEquipmentQuantifyBody: {
      rows: [
        { id: 401, source: "host", type: "Heat Recovery Unit (HRU)", level: "L2" },
        { id: 402, source: "host", type: "Heat Recovery Unit (HRU)", level: "L1 - Block 43" }
      ]
    }
  });

  assert.deepEqual(taskRequest(payload, "demo_parameter_edit").elementIds, [402]);
  assert.equal(taskRequest(payload, "demo_parameter_edit").readbackRequired, true);
  assert.deepEqual((taskRequest(payload, "demo_documentation_primitives").tag as Record<string, unknown>).elementIds, [402]);
  assert.equal(payload._discovery.fallbackEditableElementId, 402);

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].exemplarElementId, null);
});

test("Revit demo discovery promotes grounded existing tag move candidates from visible inventory", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-07-07T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [] },
    viewsBody: [
      { id: 1363433, name: "L4", type: "FloorPlan" }
    ],
    receptacleFindBody: { elementIds: [] },
    receptacleQuantifyBody: { rows: [] },
    mechanicalEquipmentQuantifyBody: { rows: [] }
  });

  enrichExistingTagMoveFromVisibleElements(payload, {
    elements: [
      {
        id: 1411064,
        ownerViewId: 1363433,
        category: "Space Tags",
        builtInCategory: "OST_MEPSpaceTags",
        visibleText: "Live/Work Loft Unit405",
        taggedSpatial: { id: 1411000, number: "405", name: "Live/Work Loft Unit", type: "Space" },
        point: { x: -8.33333333333317, y: -21.67187499999995, z: 36.16666666666667 }
      }
    ]
  });

  const request = taskRequest(payload, "demo_redline_move_tag");
  assert.equal(request.viewId, 1363433);
  assert.equal(request.targetKind, "tag");
  assert.deepEqual((request.tag as Record<string, unknown>).existingTagIds, [1411064]);
  assert.deepEqual((request.tag as Record<string, unknown>).elementIds, [1411000]);
  assert.equal((request.existingTarget as Record<string, unknown>).expectedCategory, "Space Tags");
  assert.equal((request.existingTarget as Record<string, unknown>).expectedTagText, "Live/Work Loft Unit405");
  assert.deepEqual((request.existingTarget as Record<string, unknown>).taggedElementIds, [1411000]);
  assert.equal(request.dryRunPreflightReviewed, undefined);
  assert.equal(request.visualVerify, true);
  assert.equal(request.revertAfterVerify, true);
  const liveReview = payload._discovery.candidateExistingTagMoveLiveReview as Record<string, unknown>;
  assert.equal(liveReview.status, "missing_live_inputs");
  assert.equal(liveReview.ready_for_live_dry_run, false);
  assert.equal(liveReview.ready_to_run, false);
  assert.equal(liveReview.benchmark_task_id, "demo_redline_move_tag");
  assert.deepEqual(liveReview.missing_live_inputs, [
    "move_dry_run_ids",
    "move_applied_ids",
    "revert_dry_run_ids",
    "revert_applied_ids",
    "before_annotation_inventory",
    "after_annotation_inventory",
    "final_annotation_inventory_after_revert",
    "before_visual_gate_artifact",
    "after_visual_gate_artifact",
    "final_visual_gate_artifact_after_revert",
    "leader_geometry_preservation_evidence"
  ]);
  assert.deepEqual(
    (liveReview.adapter_operations as Array<Record<string, unknown>>).map((entry) => `${entry.purpose}:${entry.path}`),
    [
      "before_annotation_inventory:/revit/export-visible-elements",
      "move_dry_run:/revit/move-elements",
      "move_apply:/revit/move-elements",
      "after_annotation_inventory:/revit/export-visible-elements",
      "revert_dry_run:/revit/move-elements",
      "revert_apply:/revit/move-elements",
      "final_annotation_inventory:/revit/export-visible-elements"
    ]
  );
  assert.equal(((liveReview.request_candidate as Record<string, unknown>).ready_to_run), false);
  assert.deepEqual(payload._discovery.candidateExistingTagMove, {
    status: "ready",
    tagId: 1411064,
    taggedElementId: 1411000,
    ownerViewId: 1363433,
    category: "Space Tags",
    visibleText: "Live/Work Loft Unit405",
    point: {
      x: -8.33333333333317,
      y: -21.67187499999995,
      z: 36.16666666666667
    }
  });
});

test("Revit demo discovery reports missing existing tag move candidates explicitly", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-07-07T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [] },
    viewsBody: [
      { id: 1363433, name: "L4", type: "FloorPlan" }
    ],
    receptacleFindBody: { elementIds: [] },
    receptacleQuantifyBody: { rows: [] },
    mechanicalEquipmentQuantifyBody: { rows: [] }
  });

  enrichExistingTagMoveFromVisibleElements(payload, {
    elements: [
      { id: 9001, category: "Ducts", name: "Duct", point: { x: 1, y: 2, z: 0 } }
    ]
  });

  assert.equal(taskRequest(payload, "demo_redline_move_tag").viewId, undefined);
  assert.deepEqual(payload._discovery.candidateExistingTagMove, {
    status: "missing",
    reason: "No visible tag candidate with id, category, visible text, owner view, and model point was found."
  });
});

test("Revit demo discovery payload leaves explicit gaps when candidates are missing", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-05-14T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [] },
    viewsBody: [],
    receptacleFindBody: { elementIds: [] },
    receptacleQuantifyBody: { rows: [] },
    mechanicalEquipmentQuantifyBody: { rows: [] }
  });

  assert.deepEqual(taskRequest(payload, "demo_sheet_export").sheetNumbers, []);
  assert.deepEqual(taskRequest(payload, "demo_sheet_export").viewIds, []);
  assert.deepEqual(taskRequest(payload, "demo_parameter_edit").elementIds, []);
  assert.equal(taskRequest(payload, "demo_redline_receptacles").viewId, null);
  assert.equal(taskRequest(payload, "demo_redline_mep_route").viewId, null);
  assert.equal(taskRequest(payload, "demo_redline_mep_pipe_route").visualViewId, null);
  assert.deepEqual((taskRequest(payload, "demo_documentation_primitives").tag as Record<string, unknown>).elementIds, []);
  assert.equal(taskRequest(payload, "demo_model_edit_primitives").visualViewId, null);

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].exemplarElementId, null);
});

test("Revit demo discovery enriches linked-host receptacle redline placement from placement context", () => {
  const payload = buildRevitDemoDiscoveryPayload({
    generatedAt: "2026-06-26T12:00:00.000Z",
    bridgeUrl: "http://localhost:5000",
    context: {},
    sheetsBody: { items: [{ id: 101, viewId: 101, sheetNumber: "E101", name: "Power Plan" }] },
    viewsBody: [{ id: 202, name: "Level 5 Lighting", type: "CeilingPlan" }],
    receptacleFindBody: { elementIds: [1403669] },
    receptacleQuantifyBody: { rows: [{ id: 1403669, type: "GFCI", room: "Unresolved" }] },
    mechanicalEquipmentQuantifyBody: { rows: [] }
  });

  enrichReceptacleRedlineFromPlacementContext(payload, {
    status: "Ok",
    elementId: 1403669,
    room: { number: "506", name: "Live/Work Unit 506", kind: "Space" },
    placementHost: { id: 1362762, category: "RVT Links", name: "Snowdon Towers Sample Architectural.rvt" },
    electricalCircuit: { primaryLabel: "P506/7", labels: ["P506/7"] },
    diagnostics: { hostPlacementSupport: { supported: true, reason: "source_link_host_supported" } }
  });

  const placements = taskRequest(payload, "demo_redline_receptacles").placements as Array<Record<string, unknown>>;
  assert.equal(placements[0].hostElementId, 1362762);
  assert.equal(placements[0].referenceElementId, 1403669);
  assert.equal(placements[0].roomNumber, "506");
  assert.equal(placements[0].roomSide, "right");
  assert.equal(placements[0].matchOrientationFromSource, true);
  assert.equal(placements[0].orientationSourceElementId, 1403669);
  assert.equal(placements[0].matchElectricalCircuitFromSource, true);
  assert.equal(placements[0].expectedCircuitLabel, "P506/7");
  assert.deepEqual(payload._discovery.redlineReceptaclePlacementContext, {
    source: "/revit/get-placement-context",
    elementId: 1403669,
    roomNumber: "506",
    hostElementId: 1362762,
    hostCategory: "RVT Links",
    roomSideDefaulted: true,
    expectedCircuitLabel: "P506/7",
    note: "Linked-host receptacle placement needs roomNumber + roomSide so create-similar can resolve a linked face reference instead of an unhosted XYZ point."
  });
});
