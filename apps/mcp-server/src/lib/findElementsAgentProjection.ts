type JsonObject = Record<string, unknown>;
type Xyz = { x: number; y: number; z: number };

type SpatialItem = {
  source: JsonObject;
  elementId: number;
  typeKey: string;
  typeId: number | null;
  levelId: number | null;
  hostId: number | null;
  location: Xyz | null;
  min: Xyz;
  max: Xyz;
  center: Xyz;
  size: Xyz;
  facing: Xyz | null;
};

type SpatialCandidate = JsonObject & {
  elementIds: number[];
  _semanticTier: number;
  _score: number;
  _distance: number;
};

const MAX_SOURCE_ITEMS = 2_000;
const MAX_RETURNED_CANDIDATES = 48;
const MAX_INLINE_ITEMS = 64;
const MAX_CANDIDATE_ITEMS = 48;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function xyz(value: unknown): Xyz | null {
  const point = asObject(value);
  if (!point) return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  const z = finiteNumber(point.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

function spatialItem(value: unknown): SpatialItem | null {
  const source = asObject(value);
  const geometry = asObject(source?.geometry);
  const box = asObject(geometry?.boundingBox);
  const elementId = safeInteger(source?.elementId ?? source?.id);
  const min = xyz(box?.min);
  const max = xyz(box?.max);
  const center = xyz(box?.center);
  const size = xyz(box?.size);
  if (!source || elementId === null || !min || !max || !center || !size) return null;
  if (max.x < min.x || max.y < min.y || max.z < min.z) return null;
  const typeId = safeInteger(source.typeId);
  const familyName = typeof source.familyName === "string" ? source.familyName.trim().toLowerCase() : "";
  const typeName = typeof source.typeName === "string" ? source.typeName.trim().toLowerCase() : "";
  const typeKey = typeId !== null ? `id:${typeId}` : familyName || typeName ? `name:${familyName}\u0000${typeName}` : "";
  if (!typeKey) return null;
  return {
    source,
    elementId,
    typeKey,
    typeId,
    levelId: safeInteger(source.levelId),
    hostId: safeInteger(source.hostId),
    location: xyz(geometry?.locationPoint),
    min,
    max,
    center,
    size,
    facing: xyz(geometry?.facingOrientation)
  };
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function roundedXyz(value: unknown): Xyz | null {
  const point = xyz(value);
  return point ? { x: rounded(point.x), y: rounded(point.y), z: rounded(point.z) } : null;
}

function routeCurveSummary(values: unknown[], complete: boolean): JsonObject {
  const candidates = values.flatMap(value => {
    const item = asObject(value);
    const geometry = asObject(item?.geometry);
    const curve = asObject(geometry?.locationCurve);
    const elementId = safeInteger(item?.elementId ?? item?.id);
    const builtInCategory = typeof item?.builtInCategory === "string" ? item.builtInCategory : "";
    const category = typeof item?.category === "string" ? item.category : "";
    const categoryKey = `${builtInCategory} ${category}`.toLowerCase();
    const routeKind = categoryKey.includes("ductcurve") || categoryKey === " ducts" || categoryKey.endsWith(" ducts")
      ? "duct"
      : categoryKey.includes("pipecurve") || categoryKey === " pipes" || categoryKey.endsWith(" pipes")
        ? "pipe"
        : null;
    const lengthFt = finiteNumber(curve?.lengthFt);
    const curveType = typeof curve?.curveType === "string" ? curve.curveType : null;
    const isStraight = curve?.isStraight === true || curveType === "Line";
    if (!item || elementId === null || !routeKind || !curve || lengthFt === null || lengthFt <= 0 || !isStraight) return [];
    return [{
      elementId,
      routeKind,
      category: item.category ?? null,
      builtInCategory: item.builtInCategory ?? null,
      typeId: item.typeId ?? null,
      familyName: item.familyName ?? null,
      typeName: item.typeName ?? null,
      name: item.name ?? null,
      levelId: item.levelId ?? null,
      hostId: item.hostId ?? null,
      curveType,
      isStraight: true,
      lengthFt: rounded(lengthFt),
      start: roundedXyz(curve.start),
      end: roundedXyz(curve.end),
      midpoint: roundedXyz(curve.midpoint)
    }];
  }).sort((a, b) => b.lengthFt - a.lengthFt || a.elementId - b.elementId);
  const returned = candidates.slice(0, MAX_RETURNED_CANDIDATES);
  return {
    schema: "revit-operator.route-curve-candidate-summary/v1",
    derivedFromReturnedItems: values.length,
    candidatesFound: candidates.length,
    candidatesReturned: returned.length,
    candidatesOmitted: Math.max(0, candidates.length - returned.length),
    complete,
    sizeTransitionMinimumHostLengthFt: 1,
    requiredConnectorTopology: "exactly_two_physical_end_connectors_no_side_taps",
    interpretation: "Length and straightness are prefilters only. Batch /revit/get-connectors for shortlisted ids, reject Curve/tap connectors, and verify branch/fitting adjacency before a reroute preview.",
    candidates: returned
  };
}

function distance(a: Xyz, b: Xyz): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function orientationDot(a: Xyz | null, b: Xyz | null): number | null {
  if (!a || !b) return null;
  const ma = Math.hypot(a.x, a.y, a.z);
  const mb = Math.hypot(b.x, b.y, b.z);
  if (ma <= 1e-9 || mb <= 1e-9) return null;
  return Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (ma * mb)));
}

function reviewGroup(intersects: boolean, orientation: string): { name: string; tier: number } {
  if (orientation === "same") return { name: intersects ? "same_facing_overlap" : "same_facing_near", tier: 0 };
  if (orientation === "unavailable") return { name: intersects ? "orientation_unknown_overlap" : "orientation_unknown_near", tier: 1 };
  if (orientation === "different") return { name: intersects ? "different_facing_overlap" : "different_facing_near", tier: 2 };
  // Opposite-facing intersecting boxes commonly represent intended terminals on
  // separate faces of one duct. Review near/non-intersecting peers first, but do
  // not discard either group without connector evidence.
  return { name: intersects ? "opposite_facing_overlap" : "opposite_facing_near", tier: intersects ? 4 : 3 };
}

function compareCandidates(a: SpatialCandidate, b: SpatialCandidate): number {
  return a._semanticTier - b._semanticTier
    || b._score - a._score
    || a._distance - b._distance
    || a.elementIds[0]! - b.elementIds[0]!
    || a.elementIds[1]! - b.elementIds[1]!;
}

function retainCandidate(candidates: SpatialCandidate[], candidate: SpatialCandidate): void {
  if (candidates.length === MAX_RETURNED_CANDIDATES
    && compareCandidates(candidate, candidates[MAX_RETURNED_CANDIDATES - 1]!) >= 0) return;
  let index = 0;
  while (index < candidates.length && compareCandidates(candidates[index]!, candidate) <= 0) index += 1;
  candidates.splice(index, 0, candidate);
  if (candidates.length > MAX_RETURNED_CANDIDATES) candidates.pop();
}

function buildSpatialSummary(values: unknown[], complete: boolean): JsonObject {
  const source = values.map(spatialItem).filter((item): item is SpatialItem => item !== null).slice(0, MAX_SOURCE_ITEMS);
  const candidates: SpatialCandidate[] = [];
  const groupCounts = new Map<string, number>();
  let pairCount = 0;

  for (let i = 0; i < source.length; i += 1) {
    const a = source[i]!;
    for (let j = i + 1; j < source.length; j += 1) {
      const b = source[j]!;
      if (a.typeKey !== b.typeKey) continue;
      if (a.levelId !== null && b.levelId !== null && a.levelId !== b.levelId) continue;
      const overlap = {
        x: Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x)),
        y: Math.max(0, Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y)),
        z: Math.max(0, Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z))
      };
      const overlapVolume = overlap.x * overlap.y * overlap.z;
      const centerDistance = distance(a.center, b.center);
      const insertionDistance = a.location && b.location ? distance(a.location, b.location) : null;
      const smallerDiagonal = Math.max(0.01, Math.min(
        Math.hypot(a.size.x, a.size.y, a.size.z),
        Math.hypot(b.size.x, b.size.y, b.size.z)
      ));
      const intersects = overlap.x > 1e-6 && overlap.y > 1e-6 && overlap.z > 1e-6;
      const comparisonDistance = insertionDistance ?? centerDistance;
      const closeRelativeToSize = comparisonDistance <= Math.max(1, smallerDiagonal * 0.75);
      if (!intersects && !closeRelativeToSize) continue;

      const volumeA = Math.max(1e-12, a.size.x * a.size.y * a.size.z);
      const volumeB = Math.max(1e-12, b.size.x * b.size.y * b.size.z);
      const overlapFractionOfSmaller = Math.min(1, overlapVolume / Math.min(volumeA, volumeB));
      const facingDot = orientationDot(a.facing, b.facing);
      const orientationRelation = facingDot === null ? "unavailable" : facingDot >= 0.95 ? "same" : facingDot <= -0.95 ? "opposite" : "different";
      const group = reviewGroup(intersects, orientationRelation);
      const sameLevel = a.levelId !== null && a.levelId === b.levelId;
      const sameHost = a.hostId !== null && a.hostId === b.hostId;
      // Revit element ids are allocated monotonically inside a document. For two
      // otherwise equivalent near-spatial peers, creation adjacency is useful
      // triage evidence that they may have come from the same copy/place action.
      // It is deliberately only a bounded ranking signal: topology, room/host,
      // and rollback impact still decide whether either instance is disposable.
      const elementIdGap = Math.abs(a.elementId - b.elementId);
      const creationAdjacencyScore = 40 / Math.max(1, elementIdGap);
      const score = (intersects ? 1000 : 0) + overlapFractionOfSmaller * 300
        + (sameLevel ? 100 : 0) + (sameHost ? 100 : 0)
        + (orientationRelation === "same" ? 80 : orientationRelation === "opposite" ? -250 : 0)
        + 100 / (1 + comparisonDistance) + creationAdjacencyScore;

      pairCount += 1;
      groupCounts.set(group.name, (groupCounts.get(group.name) ?? 0) + 1);
      retainCandidate(candidates, {
        _semanticTier: group.tier,
        _score: rounded(score),
        _distance: rounded(comparisonDistance),
        elementIds: [a.elementId, b.elementId],
        typeId: a.typeId,
        reviewGroup: group.name,
        centerDistanceFt: rounded(centerDistance),
        centerDistanceIn: rounded(centerDistance * 12, 3),
        insertionPointDistanceFt: insertionDistance === null ? null : rounded(insertionDistance),
        insertionPointDistanceIn: insertionDistance === null ? null : rounded(insertionDistance * 12, 3),
        boundingBoxesIntersect: intersects,
        overlapFt: { x: rounded(overlap.x), y: rounded(overlap.y), z: rounded(overlap.z) },
        overlapFractionOfSmaller: rounded(overlapFractionOfSmaller),
        sameLevel,
        levelIds: [a.levelId, b.levelId],
        sameHost,
        hostIds: [a.hostId, b.hostId],
        orientationDot: facingDot === null ? null : rounded(facingDot),
        orientationRelation,
        elementIdGap,
        creationAdjacencyScore: rounded(creationAdjacencyScore),
        reasons: [
          "same_type",
          ...(intersects ? ["bounding_boxes_intersect"] : ["insertion_points_close_relative_to_size"]),
          ...(sameLevel ? ["same_level"] : []),
          ...(sameHost ? ["same_host"] : []),
          ...(elementIdGap === 1 ? ["consecutive_creation_ids_triage_signal"] : []),
          ...(orientationRelation === "same" ? ["same_facing_orientation"] : []),
          ...(orientationRelation === "opposite" ? ["opposite_facing_orientation_requires_connector_review"] : [])
        ]
      });
    }
  }

  const returned = candidates.map(({ _semanticTier, _score, _distance, ...candidate }) => ({
    ...candidate,
    rankingScore: rounded(_score)
  }));
  return {
    schema: "revit-operator.spatial-duplicate-candidate-summary/v2",
    derivedFromReturnedItems: source.length,
    candidatePairsFound: pairCount,
    candidatePairsReturned: returned.length,
    candidatePairsOmitted: Math.max(0, pairCount - returned.length),
    complete: complete && source.length === values.length,
    reviewGroupCounts: Object.fromEntries([...groupCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    interpretation: "Candidates are same-type instances whose boxes intersect or whose insertion points are unusually close relative to element size. Review same-facing peers first. Opposite-facing peers can be intentional; compare every bounded candidate group with batched connector/network evidence before concluding none survive.",
    candidates: returned
  };
}

function compactCandidateItem(value: unknown): JsonObject | null {
  const item = asObject(value);
  if (!item) return null;
  const geometry = asObject(item.geometry);
  const curve = asObject(geometry?.locationCurve);
  const box = asObject(geometry?.boundingBox);
  return {
    elementId: item.elementId ?? item.id ?? null,
    category: item.category ?? null,
    builtInCategory: item.builtInCategory ?? null,
    typeId: item.typeId ?? null,
    familyName: item.familyName ?? null,
    typeName: item.typeName ?? null,
    name: item.name ?? null,
    mark: item.mark ?? null,
    levelId: item.levelId ?? null,
    hostId: item.hostId ?? null,
    geometry: geometry ? {
      units: geometry.units ?? null,
      coordinateSystem: geometry.coordinateSystem ?? null,
      locationPoint: roundedXyz(geometry.locationPoint),
      locationCurve: curve ? {
        start: roundedXyz(curve.start),
        end: roundedXyz(curve.end),
        midpoint: roundedXyz(curve.midpoint),
        lengthFt: finiteNumber(curve.lengthFt),
        curveType: typeof curve.curveType === "string" ? curve.curveType : null,
        isStraight: curve.isStraight === true
      } : null,
      boundingBox: box ? { min: roundedXyz(box.min), max: roundedXyz(box.max), center: roundedXyz(box.center), size: roundedXyz(box.size) } : null,
      facingOrientation: roundedXyz(geometry.facingOrientation),
      handOrientation: roundedXyz(geometry.handOrientation),
      rotationRadians: finiteNumber(geometry.rotationRadians)
    } : null
  };
}

export function projectFindElementsResultForAgent(value: unknown): unknown {
  const root = asObject(value);
  if (!root || root.geometryIncluded !== true || !Array.isArray(root.items) || !Array.isArray(root.elementIds)) return value;
  if (asObject(root.spatialDuplicateCandidates)?.schema === "revit-operator.spatial-duplicate-candidate-summary/v2") return value;

  const inheritedItemsOmitted = Number.isFinite(Number(root.itemsOmitted)) ? Math.max(0, Math.floor(Number(root.itemsOmitted))) : 0;
  const inheritedIdsOmitted = Number.isFinite(Number(root.elementIdsOmitted)) ? Math.max(0, Math.floor(Number(root.elementIdsOmitted))) : 0;
  const sourceComplete = root.itemsComplete !== false
    && root.truncated !== true
    && root.scanCapReached !== true
    && inheritedItemsOmitted === 0
    && inheritedIdsOmitted === 0;
  const summary = buildSpatialSummary(root.items, sourceComplete);
  const routeSummary = routeCurveSummary(root.items, sourceComplete);
  const candidates = Array.isArray(summary.candidates) ? summary.candidates : [];
  const candidateIds = [...new Set(candidates.flatMap(candidate => {
    const ids = asObject(candidate)?.elementIds;
    return Array.isArray(ids) ? ids.filter(id => Number.isSafeInteger(id)) as number[] : [];
  }))];
  const inlineCandidateIds = candidateIds.slice(0, MAX_CANDIDATE_ITEMS);
  const candidateSet = new Set(inlineCandidateIds);
  const candidateItems = root.items
    .filter(item => {
      const obj = asObject(item);
      return candidateSet.has(Number(obj?.elementId ?? obj?.id));
    })
    .map(compactCandidateItem)
    .filter((item): item is JsonObject => item !== null);

  if (root.items.length <= MAX_INLINE_ITEMS) {
    return {
      spatialDuplicateCandidates: summary,
      routeCurveCandidates: routeSummary,
      ...root,
      items: root.items.map(compactCandidateItem).filter((item): item is JsonObject => item !== null),
      warnings: [
        "Inspect spatialDuplicateCandidates before manually scanning items. Opposite-facing peers require connector/network review.",
        ...(Array.isArray(root.warnings) ? root.warnings : [])
      ]
    };
  }

  return {
    _agent_projection: true,
    projection: "find-elements-spatial-candidates",
    spatialDuplicateCandidates: summary,
    routeCurveCandidates: routeSummary,
    candidateElementIds: candidateIds,
    candidateItems,
    candidateItemsOmitted: Math.max(0, candidateIds.length - candidateItems.length),
    recommendedNextStep: candidateIds.length > 0
      ? "Call /revit/get-connectors once with candidateElementIds, includeAllRefs:true, then trace or rollback-preview only candidates whose topology remains suspicious. Do not stop after rejecting one pair while bounded candidates remain unreviewed."
      : "The complete bounded inventory produced no same-type spatial candidates under this summary; broaden only if the requested duplicate definition uses a different spatial threshold.",
    status: root.status ?? null,
    scope: root.scope ?? null,
    count: root.count ?? root.elementIds.length,
    elementIds: root.elementIds.slice(0, MAX_SOURCE_ITEMS),
    elementIdsOmitted: inheritedIdsOmitted + Math.max(0, root.elementIds.length - MAX_SOURCE_ITEMS),
    categoryFilterApplied: root.categoryFilterApplied === true,
    resolvedCategories: Array.isArray(root.resolvedCategories) ? root.resolvedCategories.slice(0, 100) : [],
    physicalElementsOnlyApplied: root.physicalElementsOnlyApplied === true,
    topLevelInstancesOnlyApplied: root.topLevelInstancesOnlyApplied === true,
    geometryIncluded: true,
    sourceItemsCount: root.items.length,
    sourceItemsComplete: sourceComplete,
    itemsReturned: candidateItems.length,
    itemsOmittedFromAgentProjection: Math.max(0, root.items.length - candidateItems.length),
    warnings: [
      "The raw geometry inventory was projected to a bounded candidate-first result for agent speed; sourceItemsComplete describes the authoritative source inventory.",
      "Unique Marks do not rule out duplicated instances. Opposite-facing peers require batched connector/network review.",
      ...(Array.isArray(root.warnings) ? root.warnings.slice(0, 20) : [])
    ]
  };
}
