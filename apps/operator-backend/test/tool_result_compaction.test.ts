import test from "node:test";
import assert from "node:assert/strict";
import { compactIncomingToolResult, compactParameterReadResultForPrompt, compactScheduleReadResultForPrompt, compactVisibleElementsResult, describeVisibleElementsInventory, getChatRequestLimitBytes } from "../src/tool_result_compaction.js";

test("compact parameter reads preserves late DESIG and shock-arrestor evidence", () => {
  const clutter = Array.from({ length: 120 }, (_, index) => ({
    name: `Parameter ${index}`,
    value: `ordinary-${index}`,
    storageType: "String",
    isReadOnly: false,
    parameterId: index
  }));
  const compacted = compactParameterReadResultForPrompt({
    selector: "allModelInstances",
    hostModelOnly: true,
    instanceOnly: true,
    valueContains: "-G-",
    writableOnly: true,
    totalScanned: 100000,
    totalMatched: 2,
    returnedCount: 2,
    hasMore: false,
    items: [
      { id: 42, name: "Shock Arrestor SA-1", category: "Pipe Accessories", parameterDetails: [...clutter, { name: "DESIG.", value: "B3-G-SA-01", storageType: "String", isReadOnly: false, parameterId: 700064 }] },
      { id: 43, name: "Sump Pump", category: "Mechanical Equipment", parameterDetails: [{ name: "DESIG.", value: "H-G-SP-03", storageType: "String", isReadOnly: false, parameterId: 700064 }] }
    ]
  }) as any;

  assert.deepEqual(compacted.matchingElementIds, [42, 43]);
  assert.equal(compacted.totalMatched, 2);
  assert.equal(compacted.parameterCounts[0]?.name, "DESIG.");
  assert.equal(compacted.parameterCounts[0]?.count, 2);
  assert.equal(compacted.evidenceSample[0]?.value, "B3-G-SA-01");
  assert.equal(compacted.evidenceSample[0]?.isReadOnly, false);
});

test("compact schedule reads preserves paging and bounded visible cells", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ rowIndex: index, cells: [`SA-${index}`, `B3-G-SA-${index}`] }));
  const compacted = compactScheduleReadResultForPrompt({
    action: "detail",
    status: "Ok",
    schedule: { id: 100, name: "Shock Arrestor Schedule" },
    fields: [{ name: "DESIG." }],
    table: { body: { totalRows: 100, totalColumns: 2, rowOffset: 0, returnedRows: 45, hasMoreRows: true, nextRowOffset: 45, rows } }
  }) as any;

  assert.equal(compacted.schedule.name, "Shock Arrestor Schedule");
  assert.equal(compacted.table.body.rows.length, 30);
  assert.equal(compacted.table.body.nextRowOffset, 45);
  assert.equal(compacted.table.body.rows[0].cells[1], "B3-G-SA-0");
});

test("compact visible-elements result preserves mapped inventory summary and samples items", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    elementId: 1000 + i,
    sourceScopedId: `host:${1000 + i}`,
    uniqueId: `uid-${i}`,
    name: `Device ${i}`,
    category: "Electrical Fixtures",
    builtInCategory: "OST_ElectricalFixtures",
    categoryToken: "OST_ElectricalFixtures",
    typeName: "Duplex",
    familyName: "Receptacle",
    hostId: 200 + (i % 2),
    hostScopedId: `host:${200 + (i % 2)}`,
    hostCategory: "Walls",
    hostBuiltInCategory: "OST_Walls",
    host: {
      id: 200 + (i % 2),
      scopedId: `host:${200 + (i % 2)}`,
      sourceScopedId: `host:${200 + (i % 2)}`,
      category: "Walls",
      builtInCategory: "OST_Walls",
      name: `Wall ${i % 2}`
    },
    room: { id: 300 + (i % 3), number: `${401 + (i % 3)}`, name: `Room ${i % 3}` },
    space: null,
    associatedSpatial: { id: 300 + (i % 3), number: `${401 + (i % 3)}`, name: `Space ${i % 3}`, type: "Space" },
    parameters: { panel: `P${401 + (i % 3)}`, circuitNumber: "1", Comments: "not needed in compact inventory" },
    parameterGroups: { electrical: { panel: `P${401 + (i % 3)}`, circuitNumber: "1" } },
    anchor: {
      model: { x: i, y: i + 1, z: 0 },
      image: { x: i * 10, y: i * 5, normalizedX: i / 30, normalizedY: i / 60, insideFrame: true }
    },
    bbox: {
      model: { center: { x: i, y: i + 1, z: 0 } },
      image: { minX: i, minY: i, maxX: i + 5, maxY: i + 5, intersectsFrame: true }
    },
    geometry: { kind: "point", point: { model: { x: i, y: i + 1, z: 0 }, image: { x: i * 10, y: i * 5, normalizedX: 0.1, normalizedY: 0.2, insideFrame: true } } },
    orientation: {
      facing: { x: 1, y: 0, z: 0 },
      rotationRadians: 0,
      planAzimuthRadians: 0,
      mirrored: false,
      transform: {
        origin: { x: i, y: i + 1, z: 0 },
        basisX: { x: 1, y: 0, z: 0 },
        basisY: { x: 0, y: 1, z: 0 },
        basisZ: { x: 0, y: 0, z: 1 }
      }
    }
  }));

  const compacted = compactVisibleElementsResult({
    frameId: "frame-1",
    viewId: 123,
    path: "artifacts/views/frame-1.png",
    widthPx: 2200,
    heightPx: 1400,
    count: items.length,
    scanned: 44,
    truncated: false,
    items,
    mapping: {
      mode: "2d_affine",
      topLeftXyz: [0, 10, 0],
      topRightXyz: [10, 10, 0],
      bottomLeftXyz: [0, 0, 0]
    }
  }, { maxItems: 10, maxCountEntries: 4 }) as any;

  assert.equal(compacted._compacted, true);
  assert.equal(compacted.frameId, "frame-1");
  assert.equal(compacted.count, 30);
  assert.equal(compacted.itemsSampled.length, 10);
  assert.equal(compacted.itemsOmitted, 20);
  assert.equal(compacted.summary.categoryCounts[0]?.key, "OST_ElectricalFixtures");
  assert.equal(compacted.summary.roomCounts[0]?.key, "401");
  assert.equal(compacted.itemsSampled[0]?.hostScopedId, "host:200");
  assert.equal(compacted.itemsSampled[0]?.sourceScopedId, "host:1000");
  assert.equal(compacted.itemsSampled[0]?.associatedSpatial?.number, "401");
  assert.equal(compacted.itemsSampled[0]?.parameters?.panel, "P401");
  assert.equal(compacted.itemsSampled[0]?.parameterGroups?.electrical?.circuitNumber, "1");
  assert.deepEqual(compacted.itemsSampled[0]?.orientation?.facing, { x: 1, y: 0, z: 0 });
  assert.equal(compacted.mapping?.frameBasis, null);
});

test("compact visible-elements result prioritizes actionable electrical samples after early view clutter", () => {
  const clutter = Array.from({ length: 24 }, (_, i) => ({
    elementId: 5000 + i,
    name: `Wall projection ${i}`,
    category: i % 2 === 0 ? "Walls" : "Generic Annotations",
    builtInCategory: i % 2 === 0 ? "OST_Walls" : "OST_GenericAnnotation",
    anchor: { image: { normalizedX: 0.1 + (i % 5) * 0.1, normalizedY: 0.2, insideFrame: true } }
  }));
  const items = [
    ...clutter,
    {
      elementId: 1002,
      name: "Duplex Receptacle",
      category: "Electrical Fixtures",
      builtInCategory: "OST_ElectricalFixtures",
      associatedSpatial: { id: 1390985, number: "405", name: "Live/Work Loft Unit", type: "Space" },
      parameters: { Panel: "P405", "Circuit Number": "1" },
      parameterGroups: { electrical: { panel: "P405", circuitNumber: "1" } },
      anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
      host: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
      orientation: { facing: { x: 1, y: 0, z: 0 }, planAzimuthRadians: 0 }
    },
    {
      elementId: 1003,
      name: "Duplex Receptacle",
      category: "Electrical Fixtures",
      builtInCategory: "OST_ElectricalFixtures",
      associatedSpatial: { id: 1390985, number: "405", name: "Live/Work Loft Unit", type: "Space" },
      electricalCircuit: { primaryLabel: "P405/1" },
      anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
      hostId: 2004
    },
    {
      elementId: 2001,
      name: "Duplex Receptacle",
      category: "Electrical Fixtures",
      builtInCategory: "OST_ElectricalFixtures",
      associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
      parameterGroups: { electrical: { panel: "P407", circuitNumber: "1" } },
      anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } }
    }
  ];

  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: items.length,
    items
  }, { maxItems: 3, maxCountEntries: 4 }) as any;

  assert.deepEqual(compacted.itemsSampled.map((item: any) => item.elementId), [1002, 1003, 2001]);
  assert.equal(compacted.itemsSampled[0]?.associatedSpatial?.number, "405");
  assert.equal(compacted.itemsSampled[0]?.parameters?.Panel, "P405");
  assert.equal(compacted.itemsSampled[0]?.parameterGroups?.electrical?.circuitNumber, "1");
  assert.equal(compacted.itemsSampled[1]?.associatedSpatial?.number, "405");
  assert.equal(compacted.itemsSampled[1]?.electricalCircuit?.primaryLabel, "P405/1");
  assert.equal(compacted.itemsSampled[1]?.anchor?.image?.insideFrame, true);
  assert.equal(compacted.itemsOmitted, 24);
});

test("compact visible-elements result preserves room tag text and tagged spatial evidence", () => {
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: 2,
    items: [
      {
        elementId: 9001,
        name: "Room Tag",
        category: "Room Tags",
        builtInCategory: "OST_RoomTags",
        visibleText: "405",
        taggedSpatial: { id: 1390985, number: "405", name: "Live/Work Loft Unit", type: "Room" },
        anchor: { image: { normalizedX: 0.5, normalizedY: 0.5, insideFrame: true } }
      },
      {
        elementId: 42,
        name: "Wall projection",
        category: "Walls",
        builtInCategory: "OST_Walls"
      }
    ]
  }, { maxItems: 2, maxCountEntries: 4 }) as any;

  assert.equal(compacted.itemsSampled[0]?.elementId, 9001);
  assert.equal(compacted.itemsSampled[0]?.visibleText, "405");
  assert.equal(compacted.itemsSampled[0]?.taggedSpatial?.number, "405");
  assert.deepEqual(compacted.summary.roomCounts, [{ key: "405", count: 1 }]);
});

test("compact visible-elements result preserves split generic unit label text payloads", () => {
  const clutter = Array.from({ length: 12 }, (_, i) => ({
    elementId: 5000 + i,
    name: `Wall projection ${i}`,
    category: "Walls",
    builtInCategory: "OST_Walls",
    anchor: { image: { normalizedX: 0.2 + i * 0.01, normalizedY: 0.2, insideFrame: true } }
  }));
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: clutter.length + 6,
    items: [
      ...clutter,
      {
        elementId: 7605,
        category: "Generic Annotations",
        builtInCategory: "OST_GenericAnnotation",
        parameters: { "Text String": "Live/Work Loft Unit" },
        anchor: { image: { normalizedX: 0.47, normalizedY: 0.49, insideFrame: true } }
      },
      {
        elementId: 7606,
        category: "Generic Annotations",
        builtInCategory: "OST_GenericAnnotation",
        textValue: "405",
        anchor: { image: { normalizedX: 0.47, normalizedY: 0.62, insideFrame: true } }
      },
      {
        elementId: 1002,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        parameters: { Panel: "P405", "Circuit Number": "1" },
        anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } }
      },
      {
        elementId: 1003,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        electricalCircuit: { primaryLabel: "P405/1" },
        anchor: { image: { normalizedX: 0.47, normalizedY: 0.84, insideFrame: true } }
      },
      {
        elementId: 2001,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
        parameters: { Panel: "P407", "Circuit Number": "1" },
        anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } }
      },
      {
        elementId: 2002,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        associatedSpatial: { number: "403", name: "Live/Work Unit", type: "Space" },
        parameters: { Panel: "P403", "Circuit Number": "1" },
        anchor: { image: { normalizedX: 0.48, normalizedY: 0.91, insideFrame: true } }
      }
    ]
  }, { maxItems: 6, maxCountEntries: 4 }) as any;

  const sampledById = new Map<number, any>(compacted.itemsSampled.map((item: any) => [item.elementId, item]));
  assert.equal(sampledById.get(7605)?.visibleText, "Live/Work Loft Unit");
  assert.equal(sampledById.get(7606)?.visibleText, "405");
  assert.equal(sampledById.get(1002)?.parameters?.Panel, "P405");
  assert.equal(sampledById.get(2001)?.associatedSpatial?.number, "407");
});

test("compact visible-elements result reserves split unit labels in crowded electrical inventory", () => {
  const crowdedDevices = Array.from({ length: 30 }, (_, i) => ({
    elementId: 10000 + i,
    name: `Duplex Receptacle ${i}`,
    category: "Electrical Fixtures",
    builtInCategory: "OST_ElectricalFixtures",
    associatedSpatial: { number: `${400 + (i % 10)}`, name: "Live/Work Unit", type: "Space" },
    parameters: { Panel: `P${400 + (i % 10)}`, "Circuit Number": "1" },
    anchor: { image: { normalizedX: 0.05 + (i % 10) * 0.08, normalizedY: 0.25 + Math.floor(i / 10) * 0.18, insideFrame: true } }
  }));
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: crowdedDevices.length + 2,
    items: [
      ...crowdedDevices,
      {
        elementId: 7605,
        category: "Generic Annotations",
        builtInCategory: "OST_GenericAnnotation",
        parameters: { "Text String": "Live/Work Loft Unit" },
        anchor: { image: { normalizedX: 0.47, normalizedY: 0.49, insideFrame: true } }
      },
      {
        elementId: 7606,
        category: "Generic Annotations",
        builtInCategory: "OST_GenericAnnotation",
        textValue: "405",
        anchor: { image: { normalizedX: 0.47, normalizedY: 0.62, insideFrame: true } }
      }
    ]
  }, { maxItems: 8, maxCountEntries: 4 }) as any;

  const sampledById = new Map<number, any>(compacted.itemsSampled.map((item: any) => [item.elementId, item]));
  assert.equal(sampledById.get(7605)?.visibleText, "Live/Work Loft Unit");
  assert.equal(sampledById.get(7606)?.visibleText, "405");
  assert.ok(compacted.itemsSampled.some((item: any) => item.builtInCategory === "OST_ElectricalFixtures"));
  assert.equal(compacted.itemsSampled.length, 8);
});

test("compact visible-elements result preserves normalized spatial bbox evidence", () => {
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: 2,
    items: [
      {
        elementId: 1411041,
        category: "Spaces",
        builtInCategory: "OST_MEPSpaces",
        categoryToken: "OST_MEPSpaces",
        name: "Live/Work Loft Unit 405",
        space: { id: 1411041, number: "405", name: "Live/Work Loft Unit" },
        associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.54, normalizedY: 0.71, insideFrame: true } },
        bbox: {
          image: {
            normalizedMinX: 0.47,
            normalizedMinY: 0.58,
            normalizedMaxX: 0.61,
            normalizedMaxY: 0.86,
            intersectsFrame: true
          }
        }
      },
      {
        elementId: 1002,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.48, normalizedY: 0.84, insideFrame: true } }
      }
    ]
  }, { maxItems: 2, maxCountEntries: 4 }) as any;

  const spatial = compacted.itemsSampled.find((item: any) => item.elementId === 1411041);
  assert.equal(spatial?.bbox?.image?.normalizedMinX, 0.47);
  assert.equal(spatial?.bbox?.image?.normalizedMinY, 0.58);
  assert.equal(spatial?.bbox?.image?.normalizedMaxX, 0.61);
  assert.equal(spatial?.bbox?.image?.normalizedMaxY, 0.86);
  assert.equal(spatial?.bbox?.image?.intersectsFrame, true);
  assert.deepEqual(compacted.summary.spaceCounts, [{ key: "405", count: 2 }]);
});

test("compact visible-elements result protects room and space anchors in crowded inventories", () => {
  const clutter = Array.from({ length: 80 }, (_, i) => ({
    elementId: 20000 + i,
    category: "Electrical Fixtures",
    builtInCategory: "OST_ElectricalFixtures",
    name: `Duplex Receptacle ${i}`,
    associatedSpatial: { number: `${400 + (i % 10)}`, name: "Live/Work Unit", type: "Space" },
    anchor: { image: { normalizedX: 0.05 + (i % 20) * 0.04, normalizedY: 0.2 + Math.floor(i / 20) * 0.12, insideFrame: true } },
    parameters: { Panel: `P${400 + (i % 10)}`, "Circuit Number": "1" }
  }));
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: clutter.length + 1,
    items: [
      ...clutter,
      {
        elementId: 1411041,
        category: "Spaces",
        builtInCategory: "OST_MEPSpaces",
        categoryToken: "OST_MEPSpaces",
        name: "Live/Work Loft Unit 405",
        space: { id: 1411041, number: "405", name: "Live/Work Loft Unit" },
        associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.523, normalizedY: 0.719, insideFrame: true } },
        bbox: { image: { normalizedMinX: 0.469, normalizedMinY: 0.584, normalizedMaxX: 0.577, normalizedMaxY: 0.853, intersectsFrame: true } }
      }
    ]
  }, { maxItems: 12, maxCountEntries: 6 }) as any;

  const spatial = compacted.itemsSampled.find((item: any) => item.elementId === 1411041);
  assert.equal(spatial?.associatedSpatial?.number, "405");
  assert.equal(spatial?.bbox?.image?.normalizedMinY, 0.584);
});

test("compact visible-elements result normalizes snake-case image coordinates", () => {
  const compacted = compactVisibleElementsResult({
    frameId: "frame-405",
    count: 1,
    items: [
      {
        elementId: 1002,
        name: "Duplex Receptacle",
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: {
          image: { x_px: 48, y_px: 84, normalized_x: 0.06, normalized_y: 0.54, inside_frame: true }
        },
        bbox: {
          image: {
            normalized_min_x: 0.04,
            normalized_min_y: 0.52,
            normalized_max_x: 0.08,
            normalized_max_y: 0.57,
            intersects_frame: true
          }
        }
      }
    ]
  }, { maxItems: 1, maxCountEntries: 4 }) as any;

  const sampled = compacted.itemsSampled[0];
  assert.equal(sampled?.anchor?.image?.x, 48);
  assert.equal(sampled?.anchor?.image?.y, 84);
  assert.equal(sampled?.anchor?.image?.normalizedX, 0.06);
  assert.equal(sampled?.anchor?.image?.normalizedY, 0.54);
  assert.equal(sampled?.anchor?.image?.insideFrame, true);
  assert.equal(sampled?.bbox?.image?.normalizedMinX, 0.04);
  assert.equal(sampled?.bbox?.image?.normalizedMinY, 0.52);
  assert.equal(sampled?.bbox?.image?.normalizedMaxX, 0.08);
  assert.equal(sampled?.bbox?.image?.normalizedMaxY, 0.57);
  assert.equal(sampled?.bbox?.image?.intersectsFrame, true);
});

test("compact incoming tool result preserves bounded image base64 payloads and summarizes export-visible-elements", () => {
  const result = compactIncomingToolResult({
    action_id: "a1",
    method: "POST",
    path: "/revit/export-visible-elements",
    status: "done",
    result_json: {
      count: 1,
      items: [
        {
          elementId: 42,
          sourceScopedId: "link:555:42",
          hostId: 777,
          hostScopedId: "link:555:777",
          hostCategory: "Walls",
          hostBuiltInCategory: "OST_Walls",
          hostProvenance: { source: "hostingSurface.linkedElement", linkedElementScopedId: "link:555:777" },
          categoryToken: "OST_ElectricalFixtures",
          associatedSpatial: { number: "403", name: "Space 403", type: "Space" },
          parameters: { panel: "P403", circuitNumber: "1" },
          parameterGroups: { electrical: { panel: "P403", circuitNumber: "1" } },
          host: { builtInCategory: "OST_Walls", id: 777, scopedId: "link:555:777" },
          orientation: { planAzimuthRadians: 1.57, sourceToHostTransform: { basisX: { x: 0, y: 1, z: 0 } } }
        }
      ]
    },
    attachments: [
      {
        kind: "image",
        mime: "image/png",
        filename: "preview.png",
        local_path: "artifacts/preview.png",
        data_base64: "abc123"
      }
    ]
  });

  assert.equal((result.attachments?.[0] as any)?.data_base64, "abc123");
  assert.equal((result.result_json as any)?._compacted, true);
  assert.equal((result.result_json as any)?.itemsSampled.length, 1);
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.hostId, 777);
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.hostScopedId, "link:555:777");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.associatedSpatial?.number, "403");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.parameters?.panel, "P403");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.parameterGroups?.electrical?.circuitNumber, "1");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.orientation?.planAzimuthRadians, 1.57);
});

test("compact visible-elements result preserves raster-consistent frame metadata", () => {
  const compacted = compactVisibleElementsResult({
    frameId: "frame-2",
    count: 1,
    items: [{ elementId: 1, sourceScopedId: "host:1" }],
    mapping: {
      mode: "2d_affine",
      topLeftXyz: [0, 10, 0],
      topRightXyz: [18, 10, 0],
      bottomLeftXyz: [0, 0, 0],
      modelUnits: "feet",
      frameBasis: "exported_raster",
      rasterWidthPx: 2200,
      rasterHeightPx: 1223,
      rasterAspect: 1.7995090016366613,
      frameAspect: 1.7995090016366613,
      cropBoxAspect: 1.7230115997291233,
      aspectMismatch: 0,
      aspectCorrectionApplied: true,
      aspectCorrectionAxis: "x",
      notes: "Per-element pixel/image coordinates are derived from the same exported-raster affine mapping used for the saved frame."
    }
  }) as any;

  assert.equal(compacted.mapping?.frameBasis, "exported_raster");
  assert.equal(compacted.mapping?.rasterAspect, 1.7995090016366613);
  assert.equal(compacted.mapping?.frameAspect, 1.7995090016366613);
  assert.equal(compacted.mapping?.aspectCorrectionApplied, true);
  assert.equal(compacted.mapping?.aspectCorrectionAxis, "x");
  assert.match(compacted.mapping?.notes ?? "", /exported-raster affine mapping/);
});

test("compact incoming tool result drops oversized image base64 payloads", () => {
  const prior = process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = "4";
  try {
    const result = compactIncomingToolResult({
      action_id: "a2",
      method: "POST",
      path: "/revit/context",
      status: "done",
      attachments: [
        {
          kind: "image",
          mime: "image/png",
          filename: "preview.png",
          local_path: "artifacts/preview.png",
          data_base64: "abc123"
        }
      ]
    });

    assert.equal((result.attachments?.[0] as any)?.data_base64, undefined);
    assert.equal((result.attachments?.[0] as any)?.local_path, "artifacts/preview.png");
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
    else process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = prior;
  }
});

test("compact incoming tool result preserves larger Revit visual evidence attachments by default", () => {
  const priorGeneral = process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  const priorVisual = process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  delete process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  delete process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  try {
    const payload = "x".repeat(650_000);
    const result = compactIncomingToolResult({
      action_id: "frame-large",
      method: "POST",
      path: "/revit/export-view-frame",
      status: "done",
      attachments: [
        {
          kind: "image",
          mime: "image/jpeg",
          filename: "view-frame.jpg",
          local_path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\view-frame.jpg",
          data_base64: payload
        }
      ]
    });

    assert.equal((result.attachments?.[0] as any)?.data_base64, payload);
  } finally {
    if (priorGeneral === undefined) delete process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
    else process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = priorGeneral;
    if (priorVisual === undefined) delete process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
    else process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = priorVisual;
  }
});

test("compact incoming tool result keeps the small default cap for non-visual tool attachments", () => {
  const priorGeneral = process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  const priorVisual = process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  delete process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  delete process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
  try {
    const result = compactIncomingToolResult({
      action_id: "other-large",
      method: "POST",
      path: "/revit/context",
      status: "done",
      attachments: [
        {
          kind: "image",
          mime: "image/jpeg",
          filename: "large.jpg",
          local_path: "C:\\Users\\User\\AppData\\Local\\RevitOperator\\large.jpg",
          data_base64: "x".repeat(650_000)
        }
      ]
    });

    assert.equal((result.attachments?.[0] as any)?.data_base64, undefined);
    assert.equal((result.attachments?.[0] as any)?.local_path, "C:\\Users\\User\\AppData\\Local\\RevitOperator\\large.jpg");
  } finally {
    if (priorGeneral === undefined) delete process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
    else process.env.OPERATOR_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = priorGeneral;
    if (priorVisual === undefined) delete process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS;
    else process.env.OPERATOR_VISUAL_TOOL_ATTACHMENT_INLINE_MAX_BASE64_CHARS = priorVisual;
  }
});

test("describe visible-elements inventory returns concise log stats", () => {
  const stats = describeVisibleElementsInventory({
    count: 3,
    items: [
      { categoryToken: "OST_ElectricalFixtures", associatedSpatial: { number: "403" } },
      { categoryToken: "OST_ElectricalFixtures", room: { number: "403" } },
      { categoryToken: "OST_ElectricalDevices", associatedSpatial: { number: "404" } }
    ]
  });

  assert.equal(stats?.count, 3);
  assert.deepEqual(stats?.topCategories, ["OST_ElectricalFixtures", "OST_ElectricalDevices"]);
  assert.deepEqual(stats?.topRooms, ["403", "404"]);
});

test("chat request limit uses env override within guardrails", () => {
  const prior = process.env.OPERATOR_CHAT_MAX_REQUEST_BYTES;
  process.env.OPERATOR_CHAT_MAX_REQUEST_BYTES = "5000000";
  try {
    assert.equal(getChatRequestLimitBytes(), 5_000_000);
  } finally {
    if (prior === undefined) delete process.env.OPERATOR_CHAT_MAX_REQUEST_BYTES;
    else process.env.OPERATOR_CHAT_MAX_REQUEST_BYTES = prior;
  }
});
