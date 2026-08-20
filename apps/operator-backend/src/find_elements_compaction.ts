function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type Xyz = { x: number; y: number; z: number };

function compactXyz(value: unknown): Xyz | null {
  const point = asObject(value);
  if (!point) return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  const z = finiteNumber(point.z);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

function compactGeometry(value: unknown): Record<string, unknown> | null {
  const geometry = asObject(value);
  if (!geometry) return null;
  const curve = asObject(geometry.locationCurve);
  const box = asObject(geometry.boundingBox);
  return {
    units: geometry.units === "feet" ? "feet" : null,
    coordinateSystem: geometry.coordinateSystem === "revit_internal_world" ? "revit_internal_world" : null,
    locationPoint: compactXyz(geometry.locationPoint),
    locationCurve: curve ? {
      start: compactXyz(curve.start),
      end: compactXyz(curve.end),
      midpoint: compactXyz(curve.midpoint),
      lengthFt: finiteNumber(curve.lengthFt),
      curveType: typeof curve.curveType === "string" ? curve.curveType : null,
      isStraight: curve.isStraight === true
    } : null,
    boundingBox: box ? {
      min: compactXyz(box.min),
      max: compactXyz(box.max),
      center: compactXyz(box.center),
      size: compactXyz(box.size)
    } : null,
    facingOrientation: compactXyz(geometry.facingOrientation),
    handOrientation: compactXyz(geometry.handOrientation),
    rotationRadians: finiteNumber(geometry.rotationRadians)
  };
}

type SpatialItem = {
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

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function spatialItem(value: unknown): SpatialItem | null {
  const item = asObject(value);
  const geometry = asObject(item?.geometry);
  const box = asObject(geometry?.boundingBox);
  const elementId = safeInteger(item?.elementId ?? item?.id);
  const min = compactXyz(box?.min);
  const max = compactXyz(box?.max);
  const center = compactXyz(box?.center);
  const size = compactXyz(box?.size);
  if (elementId === null || !min || !max || !center || !size) return null;
  if (max.x < min.x || max.y < min.y || max.z < min.z) return null;
  const typeId = safeInteger(item?.typeId);
  const familyName = typeof item?.familyName === "string" ? item.familyName.trim().toLowerCase() : "";
  const typeName = typeof item?.typeName === "string" ? item.typeName.trim().toLowerCase() : "";
  const typeKey = typeId !== null ? `id:${typeId}` : familyName || typeName ? `name:${familyName}\u0000${typeName}` : "";
  if (!typeKey) return null;
  return {
    elementId,
    typeKey,
    typeId,
    levelId: safeInteger(item?.levelId),
    hostId: safeInteger(item?.hostId),
    location: compactXyz(geometry?.locationPoint),
    min,
    max,
    center,
    size,
    facing: compactXyz(geometry?.facingOrientation)
  };
}

function rounded(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function orientationDot(a: SpatialItem["facing"], b: SpatialItem["facing"]): number | null {
  if (!a || !b) return null;
  const ma = Math.hypot(a.x, a.y, a.z);
  const mb = Math.hypot(b.x, b.y, b.z);
  if (ma <= 1e-9 || mb <= 1e-9) return null;
  return Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (ma * mb)));
}

type SpatialCandidate = Record<string, unknown> & { _tier: number; _score: number; _distance: number; elementIds: number[] };

function compareSpatialCandidates(a: SpatialCandidate, b: SpatialCandidate): number {
  return a._tier - b._tier || b._score - a._score || a._distance - b._distance
    || a.elementIds[0]! - b.elementIds[0]!
    || a.elementIds[1]! - b.elementIds[1]!;
}

function retainRankedSpatialCandidate(candidates: SpatialCandidate[], candidate: SpatialCandidate, limit: number): void {
  if (candidates.length === limit && compareSpatialCandidates(candidate, candidates[limit - 1]!) >= 0) return;
  let index = 0;
  while (index < candidates.length && compareSpatialCandidates(candidates[index]!, candidate) <= 0) index += 1;
  candidates.splice(index, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

function spatialDuplicateSummary(values: unknown[], complete: boolean): Record<string, unknown> {
  const source = values.map(spatialItem).filter((item): item is SpatialItem => item !== null).slice(0, 1000);
  const candidates: SpatialCandidate[] = [];
  const returnedLimit = 48;
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
      const centerDistance = Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z);
      const insertionDistance = a.location && b.location
        ? Math.hypot(a.location.x - b.location.x, a.location.y - b.location.y, a.location.z - b.location.z)
        : null;
      const comparisonDistance = insertionDistance ?? centerDistance;
      const smallerDiagonal = Math.max(0.01, Math.min(
        Math.hypot(a.size.x, a.size.y, a.size.z),
        Math.hypot(b.size.x, b.size.y, b.size.z)
      ));
      const intersects = overlap.x > 1e-6 && overlap.y > 1e-6 && overlap.z > 1e-6;
      const closeRelativeToSize = comparisonDistance <= Math.max(1, smallerDiagonal * 0.75);
      if (!intersects && !closeRelativeToSize) continue;

      const volumeA = Math.max(1e-12, a.size.x * a.size.y * a.size.z);
      const volumeB = Math.max(1e-12, b.size.x * b.size.y * b.size.z);
      const overlapFractionOfSmaller = Math.min(1, overlapVolume / Math.min(volumeA, volumeB));
      const facingDot = orientationDot(a.facing, b.facing);
      const sameLevel = a.levelId !== null && a.levelId === b.levelId;
      const sameHost = a.hostId !== null && a.hostId === b.hostId;
      const orientationRelation = facingDot === null ? "unavailable" : facingDot >= 0.95 ? "same" : facingDot <= -0.95 ? "opposite" : "different";
      const reviewGroup = orientationRelation === "same"
        ? (intersects ? "same_facing_overlap" : "same_facing_near")
        : orientationRelation === "unavailable"
          ? (intersects ? "orientation_unknown_overlap" : "orientation_unknown_near")
          : orientationRelation === "different"
            ? (intersects ? "different_facing_overlap" : "different_facing_near")
            : (intersects ? "opposite_facing_overlap" : "opposite_facing_near");
      const semanticTier = orientationRelation === "same" ? 0
        : orientationRelation === "unavailable" ? 1
          : orientationRelation === "different" ? 2
            : intersects ? 4 : 3;
      const score = (intersects ? 1000 : 0) + overlapFractionOfSmaller * 300
        + (sameLevel ? 100 : 0) + (sameHost ? 100 : 0)
        + (orientationRelation === "same" ? 80 : orientationRelation === "opposite" ? -250 : 0)
        + 100 / (1 + comparisonDistance);
      pairCount += 1;
      retainRankedSpatialCandidate(candidates, {
        _tier: semanticTier,
        _score: rounded(score),
        _distance: rounded(comparisonDistance),
        elementIds: [a.elementId, b.elementId],
        typeId: a.typeId,
        reviewGroup,
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
        reasons: [
          "same_type",
          ...(intersects ? ["bounding_boxes_intersect"] : ["insertion_points_close_relative_to_size"]),
          ...(sameLevel ? ["same_level"] : []),
          ...(sameHost ? ["same_host"] : []),
          ...(orientationRelation === "same" ? ["same_facing_orientation"] : []),
          ...(orientationRelation === "opposite" ? ["opposite_facing_orientation_requires_connector_review"] : [])
        ]
      }, returnedLimit);
    }
  }
  const returned = candidates.map(({ _tier, _score, _distance, ...candidate }) => ({
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
    interpretation: "Candidates are same-type instances whose 3D bounding boxes intersect or whose insertion points are unusually close relative to element size. Unique Marks do not rule out duplicated instances. Review every bounded group with batched connector/network evidence; opposite-facing pairs can be intentional.",
    candidates: returned
  };
}

function routeCurveSummary(values: unknown[], complete: boolean): Record<string, unknown> {
  const candidates = values.flatMap(value => {
    const item = asObject(value);
    const geometry = asObject(item?.geometry);
    const curve = asObject(geometry?.locationCurve);
    const elementId = safeInteger(item?.elementId ?? item?.id);
    const builtInCategory = typeof item?.builtInCategory === "string" ? item.builtInCategory : "";
    const category = typeof item?.category === "string" ? item.category : "";
    const categoryKey = `${builtInCategory} ${category}`.toLowerCase();
    const routeKind = categoryKey.includes("ductcurve") || categoryKey.endsWith(" ducts")
      ? "duct"
      : categoryKey.includes("pipecurve") || categoryKey.endsWith(" pipes")
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
      start: compactXyz(curve.start),
      end: compactXyz(curve.end),
      midpoint: compactXyz(curve.midpoint)
    }];
  }).sort((a, b) => b.lengthFt - a.lengthFt || a.elementId - b.elementId);
  const returned = candidates.slice(0, 48);
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

export function compactFindElementsResultForPrompt(
  value: unknown,
  options: { maxItems?: number; maxElementIds?: number } = {}
): unknown {
  const root = asObject(value);
  if (!root || !Array.isArray(root.elementIds)) return value;
  const geometryIncluded = root.geometryIncluded === true;
  const defaultLimit = geometryIncluded ? 1000 : 500;
  const maxItems = Math.max(1, Math.min(2000, options.maxItems ?? defaultLimit));
  const maxElementIds = Math.max(1, Math.min(2000, options.maxElementIds ?? defaultLimit));
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items = rawItems.slice(0, maxItems).map(value => {
    const item = asObject(value) ?? {};
    const identityMatch = asObject(item.identityMatch);
    const identityParameterEvidence = asObject(item.identityParameterEvidence);
    return {
      elementId: item.elementId ?? item.id ?? null,
      typeId: item.typeId ?? null,
      levelId: item.levelId ?? null,
      hostId: item.hostId ?? null,
      category: item.category ?? null,
      builtInCategory: item.builtInCategory ?? null,
      name: item.name ?? null,
      familyName: item.familyName ?? null,
      typeName: item.typeName ?? null,
      mark: item.mark ?? null,
      superComponentId: item.superComponentId ?? null,
      isNested: item.isNested ?? false,
      identityMatch: identityMatch ? {
        score: identityMatch.score ?? null,
        matchedTerm: identityMatch.matchedTerm ?? null,
        matchedTokens: Array.isArray(identityMatch.matchedTokens) ? identityMatch.matchedTokens.slice(0, 16) : [],
        matchedFields: Array.isArray(identityMatch.matchedFields) ? identityMatch.matchedFields.slice(0, 8) : []
      } : null,
      identityParameterEvidence: identityParameterEvidence ? {
        text: identityParameterEvidence.text ?? null,
        textNormalized: identityParameterEvidence.textNormalized ?? null,
        source: identityParameterEvidence.source ?? null,
        parameterName: identityParameterEvidence.parameterName ?? null
      } : null,
      matchedText: item.matchedText ?? null,
      matchedTextSource: item.matchedTextSource ?? null,
      matchedParameterName: item.matchedParameterName ?? null,
      ownerViewId: item.ownerViewId ?? null,
      sourceViewId: item.sourceViewId ?? null,
      geometry: geometryIncluded ? compactGeometry(item.geometry) : null
    };
  });
  const elementIds = root.elementIds
    .filter(id => Number.isSafeInteger(id) && (id as number) > 0)
    .slice(0, maxElementIds);
  const inheritedItemsOmitted = Number.isFinite(Number(root.itemsOmitted)) ? Math.max(0, Math.floor(Number(root.itemsOmitted))) : 0;
  const inheritedIdsOmitted = Number.isFinite(Number(root.elementIdsOmitted)) ? Math.max(0, Math.floor(Number(root.elementIdsOmitted))) : 0;
  const itemsOmitted = inheritedItemsOmitted + Math.max(0, rawItems.length - items.length);
  const elementIdsOmitted = inheritedIdsOmitted + Math.max(0, root.elementIds.length - elementIds.length);
  const itemsComplete = root.itemsComplete !== false && root.truncated !== true && root.scanCapReached !== true && itemsOmitted === 0 && elementIdsOmitted === 0;
  const inheritedWarnings = Array.isArray(root.warnings) ? root.warnings.slice(0, 20) : [];
  const geometryWarning = "Unique instance Marks do not rule out duplicated elements; inspect spatialDuplicateCandidates and then verify host, level, orientation, parameters, and connector/network relationships.";
  const warnings = geometryIncluded
    ? [...new Set([...inheritedWarnings, geometryWarning])].slice(0, 20)
    : inheritedWarnings;
  return {
    _compacted: true,
    compaction: geometryIncluded ? "find-elements-identity-geometry" : "find-elements-identity",
    status: root.status ?? null,
    scope: root.scope ?? null,
    count: root.count ?? root.elementIds.length,
    elementIds,
    elementIdsOmitted,
    categoryFilterApplied: root.categoryFilterApplied === true,
    resolvedCategories: Array.isArray(root.resolvedCategories) ? root.resolvedCategories.slice(0, 100) : [],
    textFilterApplied: root.textFilterApplied === true,
    textSearch: root.textSearch ?? null,
    identityFilterApplied: root.identityFilterApplied === true,
    identityTerms: Array.isArray(root.identityTerms) ? root.identityTerms.slice(0, 8) : [],
    physicalElementsOnlyApplied: root.physicalElementsOnlyApplied === true,
    topLevelInstancesOnlyApplied: root.topLevelInstancesOnlyApplied === true,
    identityAcronymExpansionApplied: root.identityAcronymExpansionApplied === true,
    identityAcronyms: Array.isArray(root.identityAcronyms) ? root.identityAcronyms.slice(0, 8) : [],
    identitySeedCategoryIds: Array.isArray(root.identitySeedCategoryIds) ? root.identitySeedCategoryIds.slice(0, 100) : [],
    identityExpansionCount: root.identityExpansionCount ?? 0,
    identityExpansionScanCapReached: root.identityExpansionScanCapReached === true,
    geometryIncluded,
    spatialDuplicateCandidates: geometryIncluded ? spatialDuplicateSummary(items, itemsComplete) : null,
    routeCurveCandidates: geometryIncluded ? routeCurveSummary(items, itemsComplete) : null,
    items,
    itemsOmitted,
    truncated: root.truncated === true,
    scanCapReached: root.scanCapReached === true,
    itemsComplete,
    warnings
  };
}
