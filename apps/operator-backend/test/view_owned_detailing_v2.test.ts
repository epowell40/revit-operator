import assert from "node:assert/strict";
import test from "node:test";
import { duplicatedViewDetailingSatisfiedV2 } from "../src/verification/view_owned_detailing_v2.js";

const item = (ownerViewId: number, elementId: number, semanticSignature: string) => ({
  elementId, ownerViewId, isAnnotation: true, semanticSignature: `sha256:${semanticSignature.repeat(64)}`, semanticSignatureComplete: true
});
const view = (id: number, name: string, items: unknown[]) => ({
  view: { id, name, viewType: "FloorPlan" }, limit: 1000,
  totalOwnedCount: items.length, returnedCount: items.length,
  annotationCount: items.length, truncated: false, unreadableCount: 0,
  unclassifiedCount: 0, incompleteTextCount: 0, incompleteSignatureCount: 0, itemsComplete: true, items
});
const source = view(1363433, "L4", [item(1363433, 11, "a"), item(1363433, 12, "b")]);
const copy = view(1542917, "M-COORDINATION COPY", [item(1542917, 21, "b"), item(1542917, 22, "a")]);
const payload = (sourceView: unknown = source, copyView: unknown = copy) => ({
  schema: "revit-operator.view-owned-detailing/v1", scope: "exact_owner_view",
  requestedViewIds: [1363433, 1542917], viewsComplete: true, views: [sourceView, copyView]
});

test("detailed duplicate requires two complete owner-view inventories with the same semantic multiset", () => {
  assert.equal(duplicatedViewDetailingSatisfiedV2(1363433, "M-COORDINATION COPY", payload(), [1542917]), true);
  for (const bad of [
    payload(source, view(1542917, "M-COORDINATION COPY", [item(1542917, 21, "a")])),
    payload(source, view(1542917, "M-COORDINATION COPY", [item(1363433, 21, "a"), item(1542917, 22, "b")])),
    payload(source, view(1542917, "WRONG COPY", [item(1542917, 21, "a"), item(1542917, 22, "b")])),
    { ...payload(), viewsComplete: false },
    payload({ ...source, truncated: true }, copy),
    payload({ ...source, itemsComplete: false }, copy),
    payload({ ...source, totalOwnedCount: 3 }, copy),
    payload({ ...source, annotationCount: 0 }, copy),
    payload(view(1363433, "L4", []), view(1542917, "M-COORDINATION COPY", [])),
    { ...payload(), views: [copy] },
    { ...payload(), schema: "unreviewed" },
    { ...payload(), requestedViewIds: [1363433, 9999999] },
  ]) assert.equal(duplicatedViewDetailingSatisfiedV2(1363433, "M-COORDINATION COPY", bad, [1542917]), false);
  assert.equal(duplicatedViewDetailingSatisfiedV2(1363433, "M-COORDINATION COPY", payload(), [9999999]), false);
  const nonannotation = (ownerViewId: number, elementId: number, value: string) => ({
    ...item(ownerViewId, elementId, value), isAnnotation: false
  });
  const sourceWithLine = { ...view(1363433, "L4", [item(1363433, 11, "a"), nonannotation(1363433, 13, "c")]), annotationCount: 1 };
  const copyWithoutLine = view(1542917, "M-COORDINATION COPY", [item(1542917, 21, "a")]);
  assert.equal(duplicatedViewDetailingSatisfiedV2(1363433, "M-COORDINATION COPY",
    payload(sourceWithLine, copyWithoutLine), [1542917]), false);
});
