import { createHash } from "node:crypto";
import { nativeReadEvidence } from "./nativeReadEvidence.js";

type Row = Record<string, any>;
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** Presentation only, after callRevit retained the unmodified native evidence.
 * Completeness uses the same native contract as evidence ingestion. This does
 * not certify a mutation, its provenance, collateral, or a task outcome. */
export function projectViewOwnedDetailingForAgent(value: unknown, request: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Row;
  if (root.schema !== "revit-operator.view-owned-detailing/v1") return value;
  const complete = nativeReadEvidence("/revit/view-owned-detailing", request, value)
    .some(fact => fact.fact_id === "collection.complete" && fact.value === true);
  // Never make a malformed or truncated inventory look complete by projecting it.
  if (!complete) return value;
  const inventories = (root.views as Row[]).map(inventory => {
    const signatures = (inventory.items as Row[])
      .filter(item => item.comparisonExcluded !== true)
      .map(item => (item.semanticSignature as string).trim()).sort();
    return { inventory, signatures };
  });
  const comparisons = inventories.flatMap((left, index) => inventories.slice(index + 1).map(right => ({
    viewIds: [left.inventory.view.id, right.inventory.view.id],
    semanticSignaturesEqual: left.signatures.length > 0
      && left.inventory.view.viewType === right.inventory.view.viewType
      && left.inventory.annotationCount === right.inventory.annotationCount
      && left.signatures.length === right.signatures.length
      && left.signatures.every((signature, i) => signature === right.signatures[i]),
    comparedItemCounts: [left.signatures.length, right.signatures.length]
  })));
  return {
    _agent_projection: true,
    schema: "revit-operator.view-owned-detailing-agent-summary/v1",
    sourceSchema: root.schema,
    sourcePayloadSha256: hash(value),
    canonical_attempt_settlement: root.canonical_attempt_settlement,
    scope: root.scope,
    requestedViewIds: root.requestedViewIds,
    sourceViewsComplete: true,
    comparisons,
    views: inventories.map(({ inventory, signatures }) => ({
      view: inventory.view,
      totalOwnedCount: inventory.totalOwnedCount,
      annotationCount: inventory.annotationCount,
      comparedItemCount: signatures.length,
      excludedInfrastructureCount: inventory.items.length - signatures.length,
      semanticSignatureMultisetSha256: hash(signatures),
      // Order-independent, identity-sensitive before/after check for one view.
      ownedInventorySha256: hash([...inventory.items].sort((a: Row, b: Row) => a.elementId - b.elementId)),
      sourceItemsComplete: true
    })),
    interpretation: "Compared every native semantic signature, preserving duplicate multiplicities and excluding only validated infrastructure. The full native payload is retained separately. Match view IDs/name to the committed creation receipt. Equal semantic signatures establish detailing equivalence only; they do not verify collateral changes, placement quality, engineering suitability, or overall task completion. Compare ownedInventorySha256 only across reads of the same view to check that its inventoried items stayed unchanged. Empty signature inventories do not establish equivalence."
  };
}
