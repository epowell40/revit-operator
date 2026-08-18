function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactXyz(value: unknown): Record<string, number> | null {
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
      lengthFt: finiteNumber(curve.lengthFt)
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
    items,
    itemsOmitted,
    truncated: root.truncated === true,
    scanCapReached: root.scanCapReached === true,
    itemsComplete: root.itemsComplete !== false && root.truncated !== true && root.scanCapReached !== true && itemsOmitted === 0 && elementIdsOmitted === 0,
    warnings: Array.isArray(root.warnings) ? root.warnings.slice(0, 20) : []
  };
}
