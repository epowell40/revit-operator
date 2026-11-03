// Synthetic native contract fixtures, not retained live proof.
export function summaryInspectionFixture(id = 42) {
  return {
    input: { method: "POST", path: "/revit/get-element-summary", body: { elementIds: [id], includeTagReferences: true } },
    payload: { result: [{ id, found: true, uniqueId: `tag-uid-${id}`, className: "IndependentTag", typeId: 101,
      location: { type: "tagHead", x: 1, y: 2, z: 3, ownerViewId: 80, ownerViewUniqueId: "view-uid-80" },
      tagReferences: { schema: "operator.tag_references.v1", applicable: true, complete: true, orphaned: false,
        enumerationFailed: false, totalReferences: 1, returned: 1, unresolvedReferences: 0, truncated: false,
        ownerView: { elementId: 80, uniqueId: "view-uid-80" }, errors: [],
        items: [{ identityKey: "host:90", resolved: true, documentScope: "host", elementId: 90, uniqueId: "subject-uid-90" }] } }] }
  };
}

export function familyInspectionFixture(id = 42) {
  return {
    input: { method: "POST", path: "/revit/inspect-family-content", body: { elementId: id, maxElements: 2000 } },
    payload: { ok: true, observational: true, mutated: false, closedWithoutSaving: true,
      source: { elementId: id, uniqueId: `tag-uid-${id}`, familyId: 100, familyName: "Equipment Tag", typeId: 101 },
      query: null, familyParameters: [], staticText: [], nestedInstances: [], otherElements: [],
      labels: [{ elementId: 201, uniqueId: "child-label-uid", labelType: { elementId: 202, uniqueId: "child-type-uid",
        name: "Standard", font: "Arial", textSizeFeet: .0082, bold: false, italic: false, underline: true, widthFactor: 1 } }],
      inventory: { scannedElementCount: 100, returnedElementCount: 1, truncated: false, maxElements: 2000 } }
  };
}
