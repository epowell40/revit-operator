import test from "node:test";
import assert from "node:assert/strict";
import { projectFindElementsResultForAgent } from "./findElementsAgentProjection.js";

function geometry(
  locationX: number,
  centerX: number,
  sizeX: number,
  facingZ: number
) {
  return {
    units: "feet",
    coordinateSystem: "revit_internal_world",
    locationPoint: { x: locationX, y: 2, z: 9 },
    boundingBox: {
      min: { x: centerX - sizeX / 2, y: 1.25, z: 8.75 },
      max: { x: centerX + sizeX / 2, y: 2.75, z: 9.25 },
      center: { x: centerX, y: 2, z: 9 },
      size: { x: sizeX, y: 1.5, z: 0.5 }
    },
    facingOrientation: { x: 0, y: 0, z: facingZ },
    handOrientation: { x: 1, y: 0, z: 0 },
    rotationRadians: 0
  };
}

function routeGeometry(lengthFt: number, isStraight = true) {
  return {
    units: "feet",
    coordinateSystem: "revit_internal_world",
    locationCurve: {
      start: { x: 0, y: 0, z: 10 },
      end: { x: lengthFt, y: 0, z: 10 },
      midpoint: { x: lengthFt / 2, y: 0, z: 10 },
      lengthFt,
      curveType: isStraight ? "Line" : "Arc",
      isStraight
    },
    boundingBox: {
      min: { x: 0, y: -0.5, z: 9.5 },
      max: { x: lengthFt, y: 0.5, z: 10.5 },
      center: { x: lengthFt / 2, y: 0, z: 10 },
      size: { x: lengthFt, y: 1, z: 1 }
    }
  };
}

function annotationGeometry(minX: number, minY: number, maxX: number, maxY: number) {
  return {
    units: "feet",
    coordinateSystem: "revit_internal_world",
    boundingBox: {
      min: { x: minX, y: minY, z: 0 },
      max: { x: maxX, y: maxY, z: 0 },
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: 0 },
      size: { x: maxX - minX, y: maxY - minY, z: 0 }
    }
  };
}

test("large geometry inventory becomes a bounded candidate-first projection", () => {
  const filler = Array.from({ length: 70 }, (_, index) => ({
    elementId: 2_000_000 + index,
    typeId: 999,
    levelId: 333,
    familyName: "Supply Grille",
    typeName: "16x4",
    mark: `F-${index}`,
    geometry: geometry(100 + index * 10, 100 + index * 10, 0.2, 1)
  }));
  const items = [
    ...filler,
    // This older pair is geometrically equivalent to the genuine candidate,
    // but its creation ids are far apart. Lowest-id tie breaking used to rank
    // it first and sent the agent down the wrong network.
    { elementId: 1427829, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "102", geometry: geometry(40, 39.921875, 0.197916, 1) },
    { elementId: 1427901, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "103", geometry: geometry(40 + 8 / 12, 40.432292, 0.197916, -1) },
    // Near but non-intersecting opposite-facing peers require connector review
    // before the common paired-face overlap pattern.
    { elementId: 1460066, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "226", geometry: geometry(0, -0.078125, 0.197916, -1) },
    { elementId: 1460067, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "227", geometry: geometry(8 / 12, 0.432292, 0.197916, 1) },
    // Opposite-facing overlapping boxes are a common intentional paired-face pattern.
    { elementId: 1466896, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "402", geometry: geometry(20, 19.9289, 0.7935, 1) },
    { elementId: 1466897, typeId: 222, levelId: 333, familyName: "Supply Grille", typeName: "16x4", mark: "403", geometry: geometry(20 + 8 / 12, 20.3934, 0.7935, -1) }
  ];
  const raw = {
    status: "Ok",
    count: items.length,
    elementIds: items.map(item => item.elementId),
    geometryIncluded: true,
    physicalElementsOnlyApplied: true,
    topLevelInstancesOnlyApplied: true,
    itemsComplete: true,
    truncated: false,
    scanCapReached: false,
    items
  };

  const projected = projectFindElementsResultForAgent(raw) as any;
  assert.equal(projected._agent_projection, true);
  assert.equal(projected.projection, "find-elements-spatial-candidates");
  assert.equal(projected.sourceItemsComplete, true);
  assert.equal(projected.sourceItemsCount, items.length);
  assert.deepEqual(projected.spatialDuplicateCandidates.candidates[0].elementIds, [1460066, 1460067]);
  assert.equal(projected.spatialDuplicateCandidates.candidates[0].reviewGroup, "opposite_facing_near");
  assert.equal(projected.spatialDuplicateCandidates.candidates[0].insertionPointDistanceIn, 8);
  assert.equal(projected.spatialDuplicateCandidates.candidates[0].elementIdGap, 1);
  assert.equal(projected.spatialDuplicateCandidates.candidates[0].reasons.includes("consecutive_creation_ids_triage_signal"), true);
  assert.deepEqual(projected.spatialDuplicateCandidates.candidates[1].elementIds, [1427829, 1427901]);
  assert.equal(projected.spatialDuplicateCandidates.candidates[2].reviewGroup, "opposite_facing_overlap");
  assert.deepEqual(projected.candidateElementIds, [1460066, 1460067, 1427829, 1427901, 1466896, 1466897]);
  assert.equal(projected.candidateItems.length, 6);
  assert.match(projected.recommendedNextStep, /get-connectors once/);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(raw).length / 2);
});

test("large geometry projection preserves straight route candidates outside duplicate ranking", () => {
  const filler = Array.from({ length: 70 }, (_, index) => ({
    elementId: 2_100_000 + index,
    typeId: 999,
    builtInCategory: "OST_DuctTerminal",
    geometry: geometry(100 + index * 10, 100 + index * 10, 0.2, 1)
  }));
  const longDuct = {
    elementId: 1_396_164,
    typeId: 139_186,
    category: "Ducts",
    builtInCategory: "OST_DuctCurves",
    familyName: "Round Duct",
    typeName: "Tees",
    levelId: 9_946,
    geometry: routeGeometry(22.04)
  };
  const shortDuct = {
    ...longDuct,
    elementId: 1_397_653,
    typeId: 139_187,
    geometry: routeGeometry(0.399)
  };
  const curvedDuct = {
    ...longDuct,
    elementId: 1_399_999,
    typeId: 139_188,
    geometry: routeGeometry(30, false)
  };
  const items = [...filler, longDuct, shortDuct, curvedDuct];
  const projected = projectFindElementsResultForAgent({
    status: "Ok",
    count: items.length,
    elementIds: items.map(item => item.elementId),
    geometryIncluded: true,
    itemsComplete: true,
    items
  }) as any;

  assert.equal(projected.routeCurveCandidates.schema, "revit-operator.route-curve-candidate-summary/v1");
  assert.equal(projected.routeCurveCandidates.candidatesFound, 2);
  assert.deepEqual(projected.routeCurveCandidates.candidates.map((candidate: any) => candidate.elementId), [1_396_164, 1_397_653]);
  assert.equal(projected.routeCurveCandidates.candidates[0].lengthFt, 22.04);
  assert.equal(projected.routeCurveCandidates.candidates[0].isStraight, true);
  assert.equal(projected.routeCurveCandidates.sizeTransitionMinimumHostLengthFt, 1);
  assert.equal(projected.routeCurveCandidates.requiredConnectorTopology, "exactly_two_physical_end_connectors_no_side_taps");
  assert.ok(!projected.candidateElementIds.includes(1_396_164));
});

test("large annotation inventory preserves and ranks overlapping tag identities in the view plane", () => {
  const filler = Array.from({ length: 70 }, (_, index) => ({
    elementId: 3_000_000 + index,
    category: "Duct Tags",
    builtInCategory: "OST_DuctTags",
    ownerViewId: 1_363_423,
    geometry: annotationGeometry(100 + index * 10, 100, 102 + index * 10, 101)
  }));
  const overlappingTags = [
    {
      elementId: 1_491_500,
      category: "Duct Tags",
      builtInCategory: "OST_DuctTags",
      ownerViewId: 1_363_423,
      visibleText: "18x12",
      tagHeadPosition: { x: 7.885, y: -20.0335, z: 0 },
      hasLeader: false,
      geometry: annotationGeometry(6.552, -20.846, 9.217, -19.221)
    },
    {
      elementId: 1_491_501,
      category: "Duct Tags",
      builtInCategory: "OST_DuctTags",
      ownerViewId: 1_363_423,
      visibleText: "14x10",
      tagHeadPosition: { x: 6.6555, y: -18.5945, z: 0 },
      hasLeader: true,
      geometry: annotationGeometry(5.323, -19.407, 7.988, -17.782)
    }
  ];
  const items = [...filler, ...overlappingTags];
  const raw = {
    status: "Ok",
    count: items.length,
    elementIds: items.map(item => item.elementId),
    geometryIncluded: true,
    physicalElementsOnlyApplied: false,
    topLevelInstancesOnlyApplied: false,
    itemsComplete: true,
    truncated: false,
    scanCapReached: false,
    items
  };

  const projected = projectFindElementsResultForAgent(raw) as any;
  assert.equal(projected._agent_projection, true);
  assert.equal(projected.spatialDuplicateCandidates.derivedFromReturnedItems, 0);
  assert.equal(projected.annotationLayoutCandidates.schema, "revit-operator.annotation-layout-candidate-summary/v1");
  assert.equal(projected.annotationLayoutCandidates.annotationItemsFound, 72);
  assert.deepEqual(projected.annotationLayoutCandidates.candidates[0].elementIds, [1_491_500, 1_491_501]);
  assert.equal(projected.annotationLayoutCandidates.candidates[0].boundingBoxesOverlapInViewPlane, true);
  assert.equal(projected.annotationLayoutCandidates.candidates[0].overlapFt.x, 1.436);
  assert.equal(projected.annotationLayoutCandidates.candidates[0].overlapFt.y, 0.186);
  assert.deepEqual(projected.candidateElementIds, [1_491_500, 1_491_501]);
  assert.deepEqual(projected.candidateItems.map((item: any) => item.elementId), [1_491_500, 1_491_501]);
  assert.equal(projected.candidateItems[0].ownerViewId, 1_363_423);
  assert.equal(projected.candidateItems[0].visibleText, "18x12");
  assert.equal(projected.candidateItems[1].hasLeader, true);
  assert.match(projected.recommendedNextStep, /annotationLayoutCandidates/);
  assert.ok(!projected.candidateElementIds.includes(3_000_000));
});

test("annotation projection does not fabricate a collision from invalid or zero-area boxes", () => {
  const items = Array.from({ length: 65 }, (_, index) => ({
    elementId: 4_000_000 + index,
    category: "Mechanical Equipment Tags",
    builtInCategory: "OST_MechanicalEquipmentTags",
    geometry: annotationGeometry(index, 0, index, 1)
  }));
  const projected = projectFindElementsResultForAgent({
    status: "Ok",
    count: items.length,
    elementIds: items.map(item => item.elementId),
    geometryIncluded: true,
    itemsComplete: true,
    items
  }) as any;

  assert.equal(projected.annotationLayoutCandidates.annotationItemsFound, 0);
  assert.deepEqual(projected.annotationLayoutCandidates.candidates, []);
  assert.deepEqual(projected.candidateElementIds, []);
});

test("small geometry inventory keeps all bounded items while putting the summary first", () => {
  const raw = {
    status: "Ok",
    count: 2,
    elementIds: [11, 12],
    geometryIncluded: true,
    itemsComplete: true,
    items: [
      { elementId: 11, typeId: 22, levelId: 33, geometry: geometry(0, 0, 0.2, 1) },
      { elementId: 12, typeId: 22, levelId: 33, geometry: geometry(0.5, 0.5, 0.2, 1) }
    ]
  };
  const projected = projectFindElementsResultForAgent(raw) as any;
  assert.equal(Object.keys(projected)[0], "spatialDuplicateCandidates");
  assert.equal(projected.items.length, 2);
  assert.equal(projected.spatialDuplicateCandidates.complete, true);
});

test("non-geometry find-elements results remain byte-for-byte caller objects", () => {
  const raw = { status: "Ok", count: 1, elementIds: [1], items: [{ elementId: 1 }] };
  assert.equal(projectFindElementsResultForAgent(raw), raw);
});
