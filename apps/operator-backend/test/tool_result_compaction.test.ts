import test from "node:test";
import assert from "node:assert/strict";
import {
  compactIncomingToolResult,
  compactFindElementsResultForPrompt,
  compactLocateElementsResultForPrompt,
  compactParameterReadResultForPrompt,
  compactScheduleReadResultForPrompt,
  compactViewsResult,
  compactVisibleElementsResult,
  describeVisibleElementsInventory,
  getChatRequestLimitBytes
} from "../src/tool_result_compaction.js";

test("compact find-elements preserves bounded identity evidence and explicit completeness", () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    elementId: 1000 + index,
    category: "Pipe Fittings",
    builtInCategory: "OST_PipeFitting",
    name: "Standard",
    familyName: "LW_Shock Absorber",
    typeName: "Standard",
    mark: `SA-${index + 1}`,
    isNested: false,
    identityMatch: { score: 0.5, matchedTerm: "shock arrestors", matchedTokens: ["shock"], matchedFields: ["familyName"] },
    matchedText: "coordination note",
    matchedParameterName: "Comments",
    identityParameterEvidence: { text: `SA-${index + 1}`, textNormalized: `sa ${index + 1}`, source: "identityParameterAcronym", parameterName: "DESIG." }
  }));

  const compacted = compactFindElementsResultForPrompt({
    status: "Ok",
    count: 25,
    elementIds: items.map(item => item.elementId),
    identityFilterApplied: true,
    identityTerms: ["shock arrestors"],
    physicalElementsOnlyApplied: true,
    topLevelInstancesOnlyApplied: true,
    identityAcronymExpansionApplied: true,
    identityAcronyms: ["sa"],
    identitySeedCategoryIds: [-2008049],
    identityExpansionCount: 41,
    items,
    truncated: false,
    scanCapReached: false,
    itemsComplete: true
  }) as any;

  assert.equal(compacted.items.length, 25);
  assert.equal(compacted.items[24].familyName, "LW_Shock Absorber");
  assert.equal(compacted.items[24].identityMatch.matchedTokens[0], "shock");
  assert.equal(compacted.items[24].matchedParameterName, "Comments");
  assert.equal(compacted.items[24].identityParameterEvidence.parameterName, "DESIG.");
  assert.equal(compacted.items[24].identityParameterEvidence.text, "SA-25");
  assert.equal(compacted.elementIds.length, 25);
  assert.deepEqual(compacted.identityAcronyms, ["sa"]);
  assert.equal(compacted.identityExpansionCount, 41);
  assert.equal(compacted.itemsComplete, true);
});

test("compact find-elements accumulates omissions and cannot restore completeness", () => {
  const items = Array.from({ length: 501 }, (_, index) => ({ elementId: index + 1, familyName: "Example" }));
  const first = compactFindElementsResultForPrompt({ status: "Ok", count: 501, elementIds: items.map(item => item.elementId), items, itemsComplete: true }) as any;
  const second = compactFindElementsResultForPrompt(first) as any;

  assert.equal(first.items.length, 500);
  assert.equal(first.itemsOmitted, 1);
  assert.equal(first.elementIdsOmitted, 1);
  assert.equal(first.itemsComplete, false);
  assert.equal(second.itemsOmitted, 1);
  assert.equal(second.elementIdsOmitted, 1);
  assert.equal(second.itemsComplete, false);
});

test("compact find-elements preserves bounded world geometry for a complete project inventory", () => {
  const items = Array.from({ length: 509 }, (_, index) => ({
    elementId: 1460000 + index,
    typeId: 222,
    levelId: 333,
    hostId: 444,
    familyName: "Supply Grille - Hosted",
    typeName: "16x4",
    geometry: {
      units: "feet",
      coordinateSystem: "revit_internal_world",
      locationPoint: { x: index / 12, y: 2, z: 9 },
      boundingBox: {
        min: { x: index / 12 - 2 / 3, y: 1.8, z: 8.9 },
        max: { x: index / 12 + 2 / 3, y: 2.2, z: 9.1 },
        center: { x: index / 12, y: 2, z: 9 },
        size: { x: 4 / 3, y: 0.4, z: 0.2 }
      },
      facingOrientation: { x: 0, y: 0, z: -1 },
      handOrientation: { x: 1, y: 0, z: 0 },
      rotationRadians: 0,
      arbitraryPayload: "must be dropped"
    }
  }));
  const compacted = compactFindElementsResultForPrompt({
    status: "Ok",
    count: 509,
    elementIds: items.map(item => item.elementId),
    geometryIncluded: true,
    items,
    itemsComplete: true
  }) as any;

  assert.equal(compacted.compaction, "find-elements-identity-geometry");
  assert.equal(compacted.geometryIncluded, true);
  assert.equal(compacted.items.length, 509);
  assert.equal(compacted.elementIds.length, 509);
  assert.equal(compacted.itemsComplete, true);
  assert.equal(compacted.items[508].typeId, 222);
  assert.equal(compacted.items[508].levelId, 333);
  assert.equal(compacted.items[508].hostId, 444);
  assert.equal(compacted.items[508].geometry.units, "feet");
  assert.equal(compacted.items[508].geometry.boundingBox.size.x, 4 / 3);
  assert.equal(compacted.items[508].geometry.arbitraryPayload, undefined);
  assert.equal(compacted.spatialDuplicateCandidates.schema, "revit-operator.spatial-duplicate-candidate-summary/v1");
  assert.equal(compacted.spatialDuplicateCandidates.complete, true);
  assert.ok(compacted.spatialDuplicateCandidates.candidatePairsFound > 24);
  assert.equal(compacted.spatialDuplicateCandidates.candidatePairsReturned, 24);
  assert.deepEqual(compacted.spatialDuplicateCandidates.candidates[0].elementIds, [1460000, 1460001]);
  assert.equal(compacted.spatialDuplicateCandidates.candidates[0].centerDistanceIn, 1);
  assert.equal(compacted.spatialDuplicateCandidates.candidates[0].orientationRelation, "same");
  assert.match(compacted.spatialDuplicateCandidates.interpretation, /Unique Marks do not rule out duplicated instances/);
  assert.match(compacted.warnings.join("\n"), /Unique instance Marks do not rule out duplicated elements/);
  assert.deepEqual(compactFindElementsResultForPrompt(compacted), compacted);
});

test("spatial duplicate candidates rank same-host same-facing overlap above intentional opposite-facing peers", () => {
  const geometry = (x: number, facingX: number) => ({
    units: "feet",
    coordinateSystem: "revit_internal_world",
    boundingBox: {
      min: { x: x - 2 / 3, y: 1.8, z: 8.9 },
      max: { x: x + 2 / 3, y: 2.2, z: 9.1 },
      center: { x, y: 2, z: 9 },
      size: { x: 4 / 3, y: 0.4, z: 0.2 }
    },
    facingOrientation: { x: facingX, y: 0, z: 0 }
  });
  const compacted = compactFindElementsResultForPrompt({
    status: "Ok",
    count: 7,
    elementIds: [1460066, 1460067, 1441077, 1441092, 1500001, 1500002, 1500003],
    geometryIncluded: true,
    itemsComplete: true,
    items: [
      { elementId: 1460066, typeId: 222, levelId: 333, hostId: 444, mark: "SD-1", geometry: geometry(0, 1) },
      { elementId: 1460067, typeId: 222, levelId: 333, hostId: 444, mark: "SD-2", geometry: geometry(8 / 12, 1) },
      { elementId: 1441077, typeId: 222, levelId: 333, hostId: 551, mark: "SD-3", geometry: geometry(20, 1) },
      { elementId: 1441092, typeId: 222, levelId: 333, hostId: 552, mark: "SD-4", geometry: geometry(20.1, -1) },
      { elementId: 1500001, typeId: 999, levelId: 333, hostId: 444, geometry: geometry(0.1, 1) },
      { elementId: 1500002, typeId: 222, levelId: 777, hostId: 444, geometry: geometry(0.2, 1) },
      { elementId: 1500003, typeId: 222, levelId: 333, hostId: 444, geometry: geometry(50, 1) }
    ]
  }) as any;

  const summary = compacted.spatialDuplicateCandidates;
  assert.deepEqual(summary.candidates[0].elementIds, [1460066, 1460067]);
  assert.equal(summary.candidates[0].centerDistanceIn, 8);
  assert.equal(summary.candidates[0].boundingBoxesIntersect, true);
  assert.equal(summary.candidates[0].sameHost, true);
  assert.equal(summary.candidates[0].orientationRelation, "same");
  assert.ok(summary.candidates.some((candidate: any) =>
    candidate.elementIds[0] === 1441077
    && candidate.elementIds[1] === 1441092
    && candidate.orientationRelation === "opposite"
    && candidate.reasons.includes("opposite_facing_orientation_requires_connector_review")));
  assert.ok(!summary.candidates.some((candidate: any) => candidate.elementIds.includes(1500001)));
  assert.ok(!summary.candidates.some((candidate: any) => candidate.elementIds.includes(1500002)));
});

test("compact locate-elements preserves every physical and nested spatial result plus unresolved provenance", () => {
  const items = Array.from({ length: 132 }, (_, index) => ({
    elementId: 1000 + index,
    category: index >= 66 ? "Center line" : "Pipe Fittings",
    builtInCategory: "OST_PipeFitting",
    familyName: "LW_Shock Absorber",
    typeName: "Standard",
    levelName: "LEVEL 02",
    superComponentId: index >= 66 ? 1000 + (index - 66) : null,
    topLevelParentId: index >= 66 ? 1000 + (index - 66) : null,
    isNested: index >= 66,
    spatialContext: index === 64
      ? {
          status: "unresolved",
          spatialVerticalScope: "same_level",
          method: "none",
          phaseFallbackUsed: true,
          selected: null,
          matches: [],
          nearestCandidates: [{
            spatialKind: "Room",
            number: "2911",
            name: "LOCKERS",
            sourceScope: "linked",
            sourceScopedId: "99:42",
            sourceDocumentTitle: "Architectural",
            method: "point_in_boundary",
            boundaryDistanceFt: 2.65
          }]
        }
      : {
          status: "resolved",
          method: "point_in_boundary",
          selected: {
            spatialKind: "Room",
            number: `R-${index % 66}`,
            sourceScope: "linked",
            sourceScopedId: `99:${index % 66}`,
            method: "point_in_boundary"
          },
          matches: [],
          nearestCandidates: []
        }
  }));

  const compacted = compactLocateElementsResultForPrompt({
    status: "Ok",
    count: 132,
    requestedElementCount: 133,
    requestedElementIdsMissing: [999999],
    requestedElementIdsMissingCount: 1,
    itemsComplete: false,
    spatialResolution: "geometry_with_nearest",
    spatialVerticalScope: "same_level",
    items,
    warnings: []
  }) as any;

  assert.equal(compacted.items.length, 132);
  assert.equal(compacted.items[64].spatialContext.status, "unresolved");
  assert.equal(compacted.items[64].spatialContext.spatialVerticalScope, "same_level");
  assert.equal(compacted.items[64].spatialContext.phaseFallbackUsed, true);
  assert.equal(compacted.spatialVerticalScope, "same_level");
  assert.equal(compacted.items[64].familyName, "LW_Shock Absorber");
  assert.equal(compacted.items[64].spatialContext.nearestCandidates[0].number, "2911");
  assert.equal(compacted.items[64].spatialContext.nearestCandidates[0].sourceScope, "linked");
  assert.equal(compacted.items[131].isNested, true);
  assert.equal(compacted.items[131].superComponentId, 1065);
  assert.equal(compacted.itemsOmitted, 0);
  assert.equal(compacted.requestedElementIdsMissing[0], 999999);
  assert.equal(compacted.requestedElementIdsMissingCount, 1);
  assert.equal(compacted.itemsComplete, false);
});

test("compact locate-elements retains row 201 and all twenty requested nearest candidates", () => {
  const nearestCandidates = Array.from({ length: 20 }, (_, index) => ({
    spatialKind: "Room",
    number: `N-${index + 1}`,
    spatialId: 9000 + index,
    sourceScope: "linked",
    sourceScopedId: `77:${9000 + index}`,
    boundaryDistanceFt: index + 0.25
  }));
  const items = Array.from({ length: 201 }, (_, index) => ({
    elementId: 3000 + index,
    spatialContext: {
      status: "unresolved",
      method: "none",
      matches: [],
      nearestCandidates
    }
  }));

  const compacted = compactLocateElementsResultForPrompt({
    status: "Ok",
    count: items.length,
    spatialResolution: "geometry_with_nearest",
    items
  }) as any;

  assert.equal(compacted.items.length, 201);
  assert.equal(compacted.items[200].elementId, 3200);
  assert.equal(compacted.items[200].spatialContext.nearestCandidates.length, 20);
  assert.equal(compacted.items[200].spatialContext.nearestCandidates[19].number, "N-20");
  assert.equal(compacted.items[200].spatialContext.nearestCandidatesOmitted, 0);
  assert.equal(compacted.itemsOmitted, 0);
  assert.equal(compacted.itemsComplete, true);
});

test("compact locate-elements preserves inherited row and candidate omissions across repeated compaction", () => {
  const items = Array.from({ length: 600 }, (_, index) => ({
    elementId: 4000 + index,
    spatialContext: index === 0 ? {
      status: "unresolved",
      selected: {
        spatialKind: "Room",
        number: "401",
        equivalentSourceIds: Array.from({ length: 21 }, (_, sourceIndex) => `source-${sourceIndex}`),
        equivalentPhaseNames: Array.from({ length: 21 }, (_, phaseIndex) => `phase-${phaseIndex}`)
      },
      matches: [],
      nearestCandidates: Array.from({ length: 21 }, (_, candidateIndex) => ({
        spatialKind: "Room",
        number: `N-${candidateIndex}`,
        equivalentSourceIds: Array.from({ length: 21 }, (_, sourceIndex) => `nearest-${candidateIndex}-${sourceIndex}`),
        equivalentPhaseNames: Array.from({ length: 21 }, (_, phaseIndex) => `nearest-phase-${candidateIndex}-${phaseIndex}`)
      }))
    } : null
  }));

  const first = compactLocateElementsResultForPrompt({
    status: "Ok",
    count: items.length,
    spatialResolution: "geometry_with_nearest",
    items
  }) as any;
  const second = compactLocateElementsResultForPrompt(first) as any;

  assert.equal(first.itemsOmitted, 100);
  assert.equal(second.itemsOmitted, 100);
  assert.equal(second.itemsComplete, false);
  assert.equal(second.items[0].spatialContext.nearestCandidatesOmitted, 1);
  assert.equal(second.items[0].spatialContext.selected.equivalentSourceIdsOmitted, 1);
  assert.equal(second.items[0].spatialContext.selected.equivalentPhaseNamesOmitted, 1);
  assert.equal(second.items[0].spatialContext.nearestCandidates[0].equivalentSourceIdsOmitted, 1);
  assert.equal(second.items[0].spatialContext.nearestCandidates[0].equivalentPhaseNamesOmitted, 1);
});

test("compact parameter reads preserves late project-identifier evidence", () => {
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
      { id: 42, name: "Accessory A", category: "Pipe Accessories", parameterDetails: [...clutter, { name: "DESIG.", value: "EQ-G-ALPHA-01", storageType: "String", isReadOnly: false, parameterId: 700064 }] },
      { id: 43, name: "Sump Pump", category: "Mechanical Equipment", parameterDetails: [{ name: "DESIG.", value: "H-G-SP-03", storageType: "String", isReadOnly: false, parameterId: 700064 }] }
    ]
  }) as any;

  assert.deepEqual(compacted.matchingElementIds, [42, 43]);
  assert.equal(compacted.totalMatched, 2);
  assert.equal(compacted.parameterCounts[0]?.name, "DESIG.");
  assert.equal(compacted.parameterCounts[0]?.count, 2);
  assert.equal(compacted.evidenceSample[0]?.value, "EQ-G-ALPHA-01");
  assert.equal(compacted.evidenceSample[0]?.isReadOnly, false);
});

test("compact exact parameter reads excludes substring neighbors", () => {
  const compacted = compactParameterReadResultForPrompt({
    selector: "allModelInstances",
    hostModelOnly: true,
    valueEquals: "1-2",
    totalScanned: 17450,
    totalMatched: 1,
    returnedCount: 2,
    hasMore: false,
    items: [
      { id: 386031, category: "Mechanical Equipment", parameterDetails: [{ name: "Mark", value: "1-2", storageType: "String", isReadOnly: false }] },
      { id: 732320, category: "Pipe Fittings", parameterDetails: [{ name: "Mark", value: "1-22", storageType: "String", isReadOnly: false }] }
    ]
  }) as any;

  assert.equal(compacted.valueEquals, "1-2");
  assert.equal(compacted.valueContains, null);
  assert.deepEqual(compacted.matchingElementIds, [386031]);
  assert.equal(compacted.evidenceSample.length, 1);
  assert.equal(compacted.evidenceSample[0]?.value, "1-2");
});

test("compact bounded multi-element reads preserves every explicitly requested value including blanks", () => {
  const elementIds = Array.from({ length: 17 }, (_, index) => 1400000 + index);
  const requestedNames = ["Sheet Number", "Sheet Group", "Discipline", "Drawn By", "Checked By"];
  const compacted = compactParameterReadResultForPrompt({
    selector: "elementIds",
    totalMatched: 17,
    returnedCount: 17,
    hasMore: false,
    items: elementIds.map((id, index) => ({
      id,
      name: `M${String(index).padStart(3, "0")}`,
      category: "Sheets",
      parameterDetails: [
        { name: "Unrequested", value: `noise-${index}`, storageType: "String", isReadOnly: false },
        ...requestedNames.map((name) => ({
          name,
          value: name === "Checked By" && index === 16 ? "" : `${name}-${index}`,
          storageType: "String",
          isReadOnly: false
        }))
      ]
    }))
  }, {
    maxEvidence: 85,
    maxElementIds: 64,
    preferredParameterNames: requestedNames
  }) as any;

  assert.deepEqual(compacted.requestedParameterNames, requestedNames);
  assert.equal(compacted.evidenceSample.length, 85);
  assert.equal(compacted.evidenceOmitted, 0);
  assert.equal(compacted.evidenceSample.some((entry: any) => entry.parameterName === "Unrequested"), false);
  assert.deepEqual(
    compacted.evidenceSample.find((entry: any) => entry.elementId === elementIds[16] && entry.parameterName === "Checked By"),
    {
      elementId: elementIds[16],
      elementName: "M016",
      category: "Sheets",
      parameterName: "Checked By",
      value: "",
      storageType: "String",
      isReadOnly: false,
      parameterId: null,
      literalMatch: false
    }
  );
});

test("compact schedule reads preserves all bridge-bounded rows and explicit paging incompleteness", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ rowIndex: index, cells: [`SA-${index}`, `B3-G-SA-${index}`] }));
  const compacted = compactScheduleReadResultForPrompt({
    action: "detail",
    status: "Ok",
    schedule: { id: 100, name: "Equipment Schedule" },
    fields: [{ name: "DESIG." }],
    table: {
      header: { totalRows: 2, totalColumns: 2, rowOffset: 0, returnedRows: 2, hasMoreRows: false, rows: [{ cells: ["Equipment Schedule", ""] }, { cells: ["DESIG.", "MODEL"] }] },
      body: { totalRows: 100, totalColumns: 4, rowOffset: 0, columnOffset: 0, returnedRows: 45, returnedColumns: 2, hasMoreRows: true, nextRowOffset: 45, hasMoreColumns: true, nextColumnOffset: 2, rows }
    }
  }) as any;

  assert.equal(compacted.schedule.name, "Equipment Schedule");
  assert.equal(compacted.table.header.rows.length, 2);
  assert.equal(compacted.table.body.rows.length, 45);
  assert.equal(compacted.table.body.rowsOmitted, 0);
  assert.equal(compacted.table.body.rowsComplete, false);
  assert.equal(compacted.table.body.nextRowOffset, 45);
  assert.equal(compacted.table.body.nextColumnOffset, 2);
  assert.equal(compacted.table.body.hasMoreColumns, true);
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

test("compact visible-elements result preserves category and spatial diversity for durable registration landmarks", () => {
  const walls = Array.from({ length: 40 }, (_, index) => ({
    elementId: 6000 + index,
    sourceScopedId: `link:1:${6000 + index}`,
    category: "Walls",
    builtInCategory: "OST_Walls",
    anchor: {
      model: { x: index, y: index, z: 0 },
      image: {
        normalizedX: (index % 4) / 3,
        normalizedY: (Math.floor(index / 4) % 4) / 3,
        insideFrame: true
      }
    }
  }));
  const compacted = compactVisibleElementsResult({
    frameId: "registration-frame",
    count: walls.length + 3,
    items: [
      ...walls,
      {
        elementId: 7001,
        sourceScopedId: "link:1:7001",
        category: "Stairs",
        builtInCategory: "OST_Stairs",
        anchor: { model: { x: 20, y: 20, z: 0 }, image: { normalizedX: 0.8, normalizedY: 0.2, insideFrame: true } }
      },
      {
        elementId: 7002,
        sourceScopedId: "link:1:7002",
        category: "Shaft Openings",
        builtInCategory: "OST_ShaftOpening",
        anchor: { model: { x: 25, y: 25, z: 0 }, image: { normalizedX: 0.2, normalizedY: 0.8, insideFrame: true } }
      },
      {
        elementId: 7003,
        sourceScopedId: "link:1:7003",
        category: "Grids",
        builtInCategory: "OST_Grids",
        anchor: { model: { x: 30, y: 30, z: 0 }, image: { normalizedX: 0.5, normalizedY: 0.5, insideFrame: true } }
      }
    ]
  }, { maxItems: 8, maxCountEntries: 8 }) as any;

  const sampledCategories = new Set(
    compacted.itemsSampled.map((item: any) => item.builtInCategory)
  );
  assert.ok(sampledCategories.has("OST_Walls"));
  assert.ok(sampledCategories.has("OST_Stairs"));
  assert.ok(sampledCategories.has("OST_ShaftOpening"));
  assert.ok(sampledCategories.has("OST_Grids"));
  const sampledWalls = compacted.itemsSampled.filter(
    (item: any) => item.builtInCategory === "OST_Walls"
  );
  assert.ok(sampledWalls.length >= 4);
  assert.ok(new Set(sampledWalls.map((item: any) =>
    `${Math.floor(item.anchor.image.normalizedX * 4)}:${Math.floor(item.anchor.image.normalizedY * 4)}`
  )).size >= 4);
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
      ok: true,
      count: 1,
      modelBoundsApplied: true,
      modelBoundsFt: {
        min: { x: 1, y: 2, z: 3 },
        max: { x: 4, y: 5, z: 6 }
      },
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
  assert.equal((result.result_json as any)?.ok, true);
  assert.equal((result.result_json as any)?.modelBoundsApplied, true);
  assert.deepEqual((result.result_json as any)?.modelBoundsFt, {
    min: { x: 1, y: 2, z: 3 },
    max: { x: 4, y: 5, z: 6 }
  });
  assert.equal((result.result_json as any)?.itemsSampled.length, 1);
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.hostId, 777);
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.hostScopedId, "link:555:777");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.associatedSpatial?.number, "403");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.parameters?.panel, "P403");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.parameterGroups?.electrical?.circuitNumber, "1");
  assert.equal((result.result_json as any)?.itemsSampled?.[0]?.orientation?.planAzimuthRadians, 1.57);
});

test("large view inventories become explicit incomplete receipts instead of silently clipped JSON", () => {
  const views = Array.from({ length: 40 }, (_, index) => ({
    id: 1000 + index,
    name: index === 35 ? "LEVEL 01 - BUILDING 200 - NEW WORK - PLUMBING" : `View ${index}`,
    type: index % 2 === 0 ? "FloorPlan" : "DrawingSheet"
  }));

  const compacted = compactViewsResult(views, { maxItems: 8, maxJsonChars: 1000 }) as any;
  assert.equal(compacted._compacted, true);
  assert.equal(compacted.compaction, "views-index-summary");
  assert.equal(compacted.count, 40);
  assert.equal(compacted.result_clipped, true);
  assert.equal(compacted.viewsSampled.length, 8);
  assert.equal(compacted.viewsOmitted, 32);
  assert.doesNotMatch(JSON.stringify(compacted.viewsSampled), /BUILDING 200/);
  assert.match(compacted.guidance, /Never infer that a view is absent/);
  assert.match(compacted.guidance, /POST \/revit\/views/);
});

test("bounded POST view query results remain complete", () => {
  const bounded = {
    status: "ok",
    count: 1,
    returned: 1,
    truncated: false,
    appliedFilters: ["view_names_exact"],
    views: [{ id: 3960410, name: "LEVEL 01 - BUILDING 200 - NEW WORK - PLUMBING", type: "FloorPlan" }]
  };

  const compacted = compactIncomingToolResult({
    action_id: "bounded-views",
    method: "POST",
    path: "/revit/views",
    status: "done",
    result_json: bounded
  });
  assert.deepEqual(compacted.result_json, bounded);
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
test("compaction preserves Spatial Observation v1 frame, mapping, and grounded evidence", () => {
  const compacted = compactVisibleElementsResult({
    schemaVersion: "spatial-observation/v1",
    frameId: "frame-7", path: "artifacts/frame-7.png", widthPx: 1600, heightPx: 900,
    mapping: { mode: "2d_affine", frameBasis: "exported_raster" }, count: 2, scanned: 3, truncated: false,
    items: [
      { elementId: 12, sourceScopedId: "host:12", anchor: { image: { normalizedX: 0.2, normalizedY: 0.3 } }, orientation: { planAzimuthRadians: 1.2 } },
      { elementId: 12, sourceScopedId: "link:9:12", source: { scope: "linked", linkInstanceId: 9 }, bbox: { image: { normalizedMinX: 0.4, normalizedMinY: 0.5, normalizedMaxX: 0.6, normalizedMaxY: 0.7 } } }
    ]
  }) as any;
  assert.equal(compacted.compactionSchemaVersion, "spatial-observation-summary/v1");
  assert.equal(compacted.sourceSchemaVersion, null);
  assert.equal(compacted.observationId, "frame-7");
  assert.equal(compacted.image?.path, "artifacts/frame-7.png");
  assert.equal(compacted.image?.widthPx, 1600);
  assert.equal(compacted.mapping?.frameBasis, "exported_raster");
  assert.deepEqual(compacted.coverage, { count: 2, scanned: 3, truncated: false, resultBounds: null });
  const samples = new Map<string, any>(compacted.itemsSampled.map((item: any) => [String(item.sourceScopedId), item] as [string, any]));
  assert.equal(samples.get("host:12")?.groundingStatus, "anchored");
  assert.equal(samples.get("host:12")?.anchor?.image?.normalizedX, 0.2);
  assert.equal(samples.get("host:12")?.orientation?.planAzimuthRadians, 1.2);
  assert.equal(samples.get("link:9:12")?.groundingStatus, "bbox");
  assert.equal(samples.get("link:9:12")?.bbox?.image?.normalizedMinX, 0.4);
  assert.deepEqual(compactVisibleElementsResult(compacted), compacted);
});

test("compaction does not manufacture a full observation schema or grounding from empty evidence", () => {
  const compacted = compactVisibleElementsResult({
    frameId: "frame-partial",
    count: 4,
    items: [
      { elementId: 1, sourceScopedId: "host:1", groundingStatus: "anchored", anchor: {} },
      { elementId: 2, sourceScopedId: "host:2", groundingStatus: "geometry", geometry: { kind: "none" } },
      { elementId: 3, sourceScopedId: "host:3", geometry: { kind: "point", point: { x: 1, y: 2, z: 3 } } },
      { elementId: 4, sourceScopedId: "host:4", bbox: { model: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } } }
    ]
  }) as any;
  assert.equal(compacted.compactionSchemaVersion, "spatial-observation-summary/v1");
  assert.equal(compacted.sourceSchemaVersion, null);
  assert.equal(compacted.schemaVersion, undefined);
  const samples = new Map<number, any>(compacted.itemsSampled.map((item: any) => [item.elementId, item]));
  assert.equal(samples.get(1)?.groundingStatus, "ungrounded");
  assert.equal(samples.get(2)?.groundingStatus, "ungrounded");
  assert.equal(samples.get(3)?.groundingStatus, "geometry");
  assert.equal(samples.get(4)?.groundingStatus, "bbox");
});

test("malicious pre-compacted observations cannot bypass schema or grounding validation", () => {
  const compacted = compactVisibleElementsResult({
    _compacted: true,
    compaction: "visible-elements-inventory-summary",
    compactionSchemaVersion: "spatial-observation-summary/v1",
    schemaVersion: "spatial-observation/v1",
    sourceSchemaVersion: "spatial-observation/v1",
    items: [{ elementId: 999, groundingStatus: "anchored", anchor: {} }],
    callerControlled: { groundingStatus: "anchored" },
    itemsOmitted: 0,
    summary: { categoryCounts: [] },
    itemsSampled: [
      { elementId: 1, sourceScopedId: "host:1", groundingStatus: "anchored", anchor: {}, geometry: { kind: "none" } }
    ]
  }) as any;
  assert.equal(compacted.schemaVersion, undefined);
  assert.equal(compacted.compaction, "visible-elements-inventory-summary");
  assert.equal(compacted.compactionSchemaVersion, "spatial-observation-summary/v1");
  assert.equal(compacted.sourceSchemaVersion, null);
  assert.equal(compacted.items, undefined);
  assert.equal(compacted.callerControlled, undefined);
  assert.equal(compacted.itemsSampled[0]?.groundingStatus, "ungrounded");
});

test("canonical coordinate evidence survives first compaction and recompaction", () => {
  const first = compactVisibleElementsResult({
    frameId: "frame-coordinate-forms",
    targetLevel: { id: 311, name: "Level 4", elevationFt: 42.5 },
    count: 7,
    items: [
      { elementId: 1, sourceScopedId: "host:1", anchor: { x: 1, y: 2, z: 3 } },
      { elementId: 2, sourceScopedId: "host:2", anchor: { point: { model: { x: 2, y: 3, z: 4 }, image: { normalizedX: 0.2, normalizedY: 0.3 } } } },
      { elementId: 3, sourceScopedId: "host:3", bbox: { model: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 6, z: 7 } } } },
      { elementId: 4, sourceScopedId: "host:4", bbox: { image: { normalizedMinX: 0.1, normalizedMinY: 0.2, normalizedMaxX: 0.3, normalizedMaxY: 0.4 } } },
      { elementId: 5, sourceScopedId: "host:5", geometry: { kind: "point", point: { x: 5, y: 6, z: 7 } } },
      { elementId: 6, sourceScopedId: "host:6", geometry: { kind: "point", point: { model: { x: 6, y: 7, z: 8 }, image: { x: 60, y: 70 } } } },
      { elementId: 7, sourceScopedId: "host:7", geometry: { kind: "curve", start: { x: 1, y: 1, z: 0 }, end: { model: { x: 9, y: 9, z: 0 } } } }
    ]
  }, { maxItems: 7 }) as any;
  const second = compactVisibleElementsResult(first, { maxItems: 7 }) as any;
  assert.deepEqual(second, first);
  assert.deepEqual(first.targetLevel, { id: 311, name: "Level 4", elevationFt: 42.5 });
  const samples = new Map<number, any>(first.itemsSampled.map((item: any) => [item.elementId, item]));
  assert.equal(samples.get(1)?.groundingStatus, "anchored");
  assert.equal(samples.get(1)?.anchor?.model?.x, 1);
  assert.equal(samples.get(1)?.anchor?.image, null);
  assert.equal(samples.get(2)?.anchor?.image?.normalizedY, 0.3);
  assert.equal(samples.get(3)?.groundingStatus, "bbox");
  assert.equal(samples.get(3)?.bbox?.model?.max?.z, 7);
  assert.equal(samples.get(4)?.bbox?.image?.normalizedMaxY, 0.4);
  assert.equal(samples.get(5)?.groundingStatus, "geometry");
  assert.equal(samples.get(5)?.geometry?.point?.model?.z, 7);
  assert.equal(samples.get(5)?.geometry?.point?.image, null);
  assert.equal(samples.get(6)?.geometry?.point?.image?.x, 60);
  assert.equal(samples.get(7)?.geometry?.end?.model?.x, 9);
});

test("forged clean-marker summaries cannot retain nested unknown or oversized values", () => {
  const huge = "x".repeat(5000);
  const compacted = compactVisibleElementsResult({
    _compacted: true,
    compaction: "visible-elements-inventory-summary",
    compactionSchemaVersion: "spatial-observation-summary/v1",
    sourceSchemaVersion: "spatial-observation/v1",
    image: { path: { forged: true }, widthPx: "wide", heightPx: -1 },
    coverage: { count: 1, scanned: 1, truncated: false, resultBounds: { forged: true } },
    mapping: { mode: "2d_affine", topLeftXyz: { forged: true }, notes: huge },
    warnings: [huge, { forged: true }, "bounded warning"],
    summary: { categoryCounts: [{ key: huge, count: 1 }, { key: "Walls", count: 2, forged: true }] },
    itemsSampled: [{
      elementId: 1,
      sourceScopedId: "host:1",
      name: huge,
      parameters: { Panel: { forged: true } },
      bbox: { image: { minX: { forged: true }, minY: 1, maxX: 2, maxY: 3 } },
      anchor: { image: { normalizedX: 0.2, normalizedY: 0.3 } }
    }],
    itemsOmitted: 0
  }) as any;
  assert.equal(compacted.sourceSchemaVersion, null);
  assert.equal(compacted.image.path, null);
  assert.equal(compacted.image.widthPx, null);
  assert.equal(compacted.coverage.resultBounds, null);
  assert.equal(compacted.mapping.topLeftXyz, null);
  assert.equal(compacted.mapping.notes, null);
  assert.deepEqual(compacted.warnings, ["bounded warning"]);
  assert.deepEqual(compacted.summary.categoryCounts, [{ key: "Walls", count: 2 }]);
  assert.equal(compacted.itemsSampled[0].name, null);
  assert.equal(compacted.itemsSampled[0].parameters, null);
  assert.equal(compacted.itemsSampled[0].bbox.image.minX, undefined);
  assert.deepEqual(compactVisibleElementsResult(compacted), compacted);
});

test("pre-compacted omitted counts saturate safely and remain idempotent", () => {
  const compacted = compactVisibleElementsResult({
    _compacted: true,
    compaction: "visible-elements-inventory-summary",
    compactionSchemaVersion: "spatial-observation-summary/v1",
    itemsOmitted: Number.MAX_SAFE_INTEGER,
    itemsSampled: [
      { elementId: 1, sourceScopedId: "host:1", anchor: { image: { normalizedX: 0.1, normalizedY: 0.2 } } },
      { elementId: 2, sourceScopedId: "host:2", anchor: { image: { normalizedX: 0.3, normalizedY: 0.4 } } }
    ]
  }, { maxItems: 1 }) as any;
  assert.equal(compacted.itemsOmitted, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(compactVisibleElementsResult(compacted, { maxItems: 1 }), compacted);
});
