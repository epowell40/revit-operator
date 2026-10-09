import assert from "node:assert/strict";
import test from "node:test";
import { projectViewOwnedDetailingForAgent as project } from "./viewOwnedDetailingAgentProjection.js";

const request = { viewIds: [11, 12] };
function fixture(): any {
  return { schema: "revit-operator.view-owned-detailing/v1", scope: "exact_owner_view", requestedViewIds: [11,12], viewsComplete: true,
    views: [11,12].map(id => ({ view: { id, uniqueId: `view-${id}`, name: `View ${id}`, viewType: "FloorPlan" },
      limit: 1000, totalOwnedCount: 3, returnedCount: 3, annotationCount: 2, truncated: false, itemsComplete: true,
      unreadableCount: 0, unclassifiedCount: 0, incompleteTextCount: 0, incompleteSignatureCount: 0,
      items: [0,1,2].map(i => ({ elementId: id*10+i, uniqueId: `item-${id}-${i}`, ownerViewId: id,
        className: i===2 ? "SketchPlane" : "TextNote", isAnnotation: i!==2, comparisonExcluded: i===2,
        semanticSignatureComplete: i!==2, semanticSignature: i===2 ? null : `sha256:${"a".repeat(64)}` })) })) };
}
test("complete comparison is compact, retains multiplicities and leaves raw evidence untouched", () => {
  const raw=fixture(), before=JSON.stringify(raw), out=project(raw,request) as any;
  assert.equal(out.comparisons[0].semanticSignaturesEqual,true);
  assert.equal(out.views[0].comparedItemCount,2);
  assert.equal(out.views[0].excludedInfrastructureCount,1);
  assert.equal(out.views[0].semanticSignatureMultisetSha256,out.views[1].semanticSignatureMultisetSha256);
  assert.notEqual(out.views[0].ownedInventorySha256,out.views[1].ownedInventorySha256);
  assert.equal(JSON.stringify(raw),before);
  assert.equal(out.views[0].items,undefined);
  assert.notEqual(out.schema,raw.schema);
});
test("same counts cannot conceal a changed signature or view type", () => {
  for(const mutate of [(r:any)=>r.views[1].items[0].semanticSignature=`sha256:${"b".repeat(64)}`,
    (r:any)=>r.views[1].view.viewType="CeilingPlan"]){
    const raw=fixture(); mutate(raw);
    assert.equal((project(raw,request) as any).comparisons[0].semanticSignaturesEqual,false);
  }
});
test("malformed, incomplete, wrong-owner and falsely excluded inventories never gain a comparison", () => {
  for(const mutate of [(r:any)=>r.viewsComplete=false,(r:any)=>r.views[1].truncated=true,
    (r:any)=>r.views[1].items[0].ownerViewId=11,(r:any)=>r.views[1].items[0].comparisonExcluded=true,
    (r:any)=>r.views[1].items[0].semanticSignatureComplete=false,(r:any)=>r.views[1].annotationCount=1,
    (r:any)=>r.views[1].items[1].elementId=r.views[1].items[0].elementId,
    (r:any)=>r.requestedViewIds.reverse()]){
    const raw=fixture();mutate(raw);assert.equal(project(raw,request),raw);
  }
});
test("identity-sensitive inventory digest is stable under item ordering and changes on edits", () => {
  const raw=fixture(), before=project(raw,request) as any;
  raw.views[0].items.reverse();
  assert.equal((project(raw,request) as any).views[0].ownedInventorySha256,before.views[0].ownedInventorySha256);
  raw.views[0].items[1].text="changed";
  assert.notEqual((project(raw,request) as any).views[0].ownedInventorySha256,before.views[0].ownedInventorySha256);
});
test("equal unique signature sets with different multiplicities are not equivalent", () => {
  const raw=fixture();
  for(const [index,inventory] of raw.views.entries()) {
    inventory.items.pop();
    inventory.items.push({...inventory.items[0], elementId: inventory.view.id*10+5, uniqueId:`extra-${index}`});
    inventory.annotationCount=3;
    inventory.items[index].semanticSignature=`sha256:${"b".repeat(64)}`;
  }
  raw.views[1].items[2].semanticSignature=`sha256:${"b".repeat(64)}`;
  assert.equal((project(raw,request) as any).comparisons[0].semanticSignaturesEqual,false);
});
test("empty signature inventories do not certify equivalence", () => {
  const raw=fixture();
  for(const inventory of raw.views){
    inventory.items=[];inventory.totalOwnedCount=0;inventory.returnedCount=0;inventory.annotationCount=0;
  }
  assert.equal((project(raw,request) as any).comparisons[0].semanticSignaturesEqual,false);
});
