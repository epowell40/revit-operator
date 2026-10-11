import { createHash } from "node:crypto";
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export const createdViewIdsFromIdentitiesV2 = (identities: readonly string[]): readonly number[] =>
  identities.flatMap(identity => {
    const match = /^(?:id|view_id|element_id):(\d+)$/.exec(identity.toLowerCase());
    const id = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
const positiveId = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

type Inventory = { id: number; name: string; viewType: string; signatures: readonly string[]; annotationCount: number };

function completeInventory(value: unknown): Inventory | null {
  const inventory = row(value);
  const view = row(inventory.view);
  const id = positiveId(view.id);
  const name = typeof view.name === "string" ? view.name : "";
  const viewType = typeof view.viewType === "string" ? view.viewType : "";
  const items = inventory.items;
  if (!id || !name || !viewType || !Array.isArray(items)
      || inventory.itemsComplete !== true || inventory.truncated !== false
      || inventory.unreadableCount !== 0 || inventory.unclassifiedCount !== 0
      || inventory.incompleteTextCount !== 0 || inventory.incompleteSignatureCount !== 0
      || inventory.totalOwnedCount !== items.length
      || inventory.returnedCount !== items.length
      || !Number.isSafeInteger(inventory.annotationCount)) return null;
  const signatures: string[] = [];
  const ids = new Set<number>();
  let annotationCount = 0;
  for (const value of items) {
    const item = row(value);
    const elementId = positiveId(item.elementId);
    const infrastructure = item.isAnnotation === false && (
      item.className === "SketchPlane" || item.className === "SunAndShadowSettings"
      || (item.className === "Element" && item.name === "ExtentElem")
      || item.builtInCategory === "OST_SunStudy");
    const signature = typeof item.semanticSignature === "string" ? item.semanticSignature.trim() : "";
    if (!elementId || ids.has(elementId) || positiveId(item.ownerViewId) !== id
        || (item.comparisonExcluded === true) !== infrastructure
        || (infrastructure && (item.semanticSignatureComplete !== false || item.semanticSignature !== null))
        || (!infrastructure && (item.semanticSignatureComplete !== true || !/^sha256:[a-f0-9]{64}$/.test(signature)))
        || (item.isAnnotation !== true && item.isAnnotation !== false)) return null;
    ids.add(elementId);
    if (item.isAnnotation) annotationCount++;
    if (!infrastructure) signatures.push(signature);
  }
  if (annotationCount !== inventory.annotationCount) return null;
  return { id, name, viewType, signatures: signatures.sort(), annotationCount };
}

/** Bounded presentation of complete native inventories, never a task verdict. */
export function viewOwnedDetailingSummaryV2(value: unknown): unknown | null {
  const root = row(value);
  if (root.schema !== "revit-operator.view-owned-detailing/v1" || root.scope !== "exact_owner_view"
      || root.viewsComplete !== true || !Array.isArray(root.views) || !root.views.length
      || root.views.length > 16 || !Array.isArray(root.requestedViewIds)
      || root.requestedViewIds.length !== root.views.length) return null;
  const rawViews = root.views;
  const inventories = rawViews.map(completeInventory);
  if (inventories.some(item => item === null)) return null;
  const valid = inventories as Inventory[];
  const ids = valid.map(item => item.id);
  if (new Set(ids).size !== ids.length || new Set(root.requestedViewIds).size !== ids.length
      || !ids.every(id => (root.requestedViewIds as unknown[]).includes(id))) return null;
  const hash = (input: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
  return {
    schema: "revit-operator.view-owned-detailing-agent-summary/v1",
    sourceSchema: root.schema, scope: root.scope, requestedViewIds: root.requestedViewIds,
    sourceViewsComplete: true,
    views: valid.map((item, index) => ({
      view: { id: item.id, name: item.name, viewType: item.viewType },
      annotationCount: item.annotationCount, comparedItemCount: item.signatures.length,
      semanticSignatureMultisetSha256: hash(item.signatures),
      ownedInventorySha256: hash([...(row(rawViews[index]).items as Row[])].sort((a, b) => Number(a.elementId) - Number(b.elementId))),
      sourceItemsComplete: true
    })),
    comparisons: valid.flatMap((left, index) => valid.slice(index + 1).map(right => ({
      viewIds: [left.id, right.id],
      semanticSignaturesEqual: left.signatures.length > 0 && left.viewType === right.viewType
        && left.annotationCount === right.annotationCount && left.signatures.length === right.signatures.length
        && left.signatures.every((signature, i) => signature === right.signatures[i]),
      comparedItemCounts: [left.signatures.length, right.signatures.length]
    }))),
    interpretation: "Complete native semantic-signature multiset comparison, preserving multiplicity and excluding only validated infrastructure. Compare ownedInventorySha256 only across reads of the same view. This does not certify creation provenance, collateral, engineering suitability, or whole-task completion. Full native evidence remains retained under the enclosing evidence identity."
  };
}

/**
 * A duplicate's create receipt is not proof that detailing survived. Compare
 * two complete, independent owner-view inventories by native semantic
 * signatures, excluding copied element IDs and view IDs.
 */
export function duplicatedViewDetailingSatisfiedV2(
  sourceViewId: number,
  targetName: string,
  verificationPayload: unknown,
  createdViewIds: readonly number[]
): boolean {
  let result = row(verificationPayload);
  if (result.schema !== "revit-operator.view-owned-detailing/v1"
      && result.isError !== true && Array.isArray(result.content) && result.content.length === 1) {
    const content = row(result.content[0]);
    if (content.type === "text" && typeof content.text === "string" && content.text.length <= 1_000_000) {
      try { result = row(JSON.parse(content.text)); } catch { return false; }
    }
  }
  if (result.schema !== "revit-operator.view-owned-detailing/v1"
      || result.scope !== "exact_owner_view" || result.viewsComplete !== true
      || !Array.isArray(result.views) || result.views.length !== 2) return false;
  const inventories = result.views.map(completeInventory);
  if (inventories.some(item => item === null)) return false;
  const source = inventories.find(item => item?.id === sourceViewId);
  const target = inventories.find(item => item?.id !== sourceViewId);
  if (!source || !target || source.id === target.id
      || !createdViewIds.includes(target.id)
      || !Array.isArray(result.requestedViewIds)
      || result.requestedViewIds.length !== 2
      || !result.requestedViewIds.includes(source.id)
      || !result.requestedViewIds.includes(target.id)
      || (targetName.trim() && target.name !== targetName.trim().slice(0, 120).trim())
      || source.viewType !== target.viewType
      || source.signatures.length < 1 || source.annotationCount !== target.annotationCount
      || source.signatures.length !== target.signatures.length) return false;
  return source.signatures.every((signature, index) => signature === target.signatures[index]);
}
