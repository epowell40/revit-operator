import test from "node:test";
import assert from "node:assert/strict";
import { projectEvidence } from "../src/evidence/evidence_projection.js";
import { adaptMcpToolCallResultToDynamicResponse } from "../src/brains/codex_dynamic_result_adapter.js";
import { viewOwnedDetailingSummaryV2 } from "../src/verification/view_owned_detailing_v2.js";
import type { EvidenceRefV1 } from "../src/evidence/evidence_ref.js";

const ref = { schema: "revit-operator.evidence-ref.v1", evidence_id: "ev1_test", content_hash: "sha256:" + "a".repeat(64),
  byte_count: 100000, media_type: "application/json", source: "assignment_kernel_v2:revit_call_tool",
  trust_level: "authoritative_native", assignment_id: "task", run_id: "run", attempt_id: "op", generation: 1,
  session_id: "session", target_scope: [], bounded_summary: "native", key_typed_facts: {}, artifact_location: "test",
  redaction_status: "not_needed", secret_screening_status: "passed", created_at_utc: "2026-01-01T00:00:00Z",
  verification_relevance: "required", relationships: [] } satisfies EvidenceRefV1;
function payload(): any {
  return { schema: "revit-operator.view-owned-detailing/v1", scope: "exact_owner_view", requestedViewIds: [1, 2], viewsComplete: true,
    views: [1, 2].map(id => ({ view: {id, name: id === 1 ? "Source" : "Copy", viewType: "FloorPlan"},
      totalOwnedCount: 100, returnedCount: 100, annotationCount: 100, itemsComplete: true, truncated: false,
      unreadableCount: 0, unclassifiedCount: 0, incompleteTextCount: 0, incompleteSignatureCount: 0,
      items: Array.from({length: 100}, (_, n) => ({elementId: id * 1000 + n, ownerViewId: id, isAnnotation: true,
        semanticSignature: "sha256:" + (n % 2 ? "a" : "b").repeat(64), semanticSignatureComplete: true})) })) };
}
test("complete native detailing survives V2 projection and dynamic adapter within budget", () => {
  const raw = payload();
  assert.ok(JSON.stringify(raw).length > 8192);
  const projection = projectEvidence(ref, raw);
  const response = adaptMcpToolCallResultToDynamicResponse({content:[{type:"text",text:"MCP presentation is replaced"}]},
    {tool:"revit_call_tool", projections:[projection], omitted:0});
  const envelope = JSON.parse((response.contentItems[0] as any).text);
  const delivered = envelope.evidence_projections[0].inline_payload;
  assert.equal(delivered.comparisons[0].semanticSignaturesEqual, true);
  assert.deepEqual(delivered.comparisons[0].comparedItemCounts, [100,100]);
  assert.equal(envelope.evidence_projections[0].content_hash, ref.content_hash);
  assert.ok(projection.projected_bytes <= 8192);
  assert.match(delivered.interpretation, /does not certify/);
});
test("malformed, partial, untrusted, and oversized evidence cannot gain a complete summary", () => {
  for (const alter of [(p:any)=>p.views[0].truncated=true, (p:any)=>p.views[0].items[0].ownerViewId=2,
    (p:any)=>p.views[0].items[1].elementId=p.views[0].items[0].elementId,
    (p:any)=>p.requestedViewIds=[1,1], (p:any)=>p.views[0].items[0].comparisonExcluded=true]) {
    const raw=payload(); alter(raw); assert.equal(viewOwnedDetailingSummaryV2(raw),null);
  }
  assert.equal(projectEvidence({...ref, trust_level:"untrusted_caller"},payload()).inline_payload,undefined);
  const oversized=payload(); oversized.views[0].view.name="x".repeat(10000);
  assert.equal(projectEvidence(ref,oversized).inline_payload,undefined);
});
test("comparison preserves multiplicity and stable same-view inventory identity", () => {
  const raw=payload(); const before:any=viewOwnedDetailingSummaryV2(raw);
  raw.views[0].items.reverse(); const reordered:any=viewOwnedDetailingSummaryV2(raw);
  assert.equal(before.views[0].ownedInventorySha256,reordered.views[0].ownedInventorySha256);
  raw.views[1].items[0].semanticSignature="sha256:"+"a".repeat(64);
  assert.equal((viewOwnedDetailingSummaryV2(raw) as any).comparisons[0].semanticSignaturesEqual,false);
});
