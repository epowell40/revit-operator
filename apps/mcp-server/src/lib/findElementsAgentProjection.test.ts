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
  assert.equal(projected.spatialDuplicateCandidates.candidates[1].reviewGroup, "opposite_facing_overlap");
  assert.deepEqual(projected.candidateElementIds, [1460066, 1460067, 1466896, 1466897]);
  assert.equal(projected.candidateItems.length, 4);
  assert.match(projected.recommendedNextStep, /get-connectors once/);
  assert.ok(JSON.stringify(projected).length < JSON.stringify(raw).length / 2);
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
