import assert from "node:assert/strict";
import test from "node:test";
import {nativeViewImageContent} from "./viewFrameImage.js";

// Retained C37 route/capture shape, with a portable capture path. Merely
// returning this metadata used to leave the provider without the image.
const result=()=>({status:"AppliedVisualVerificationReady",workflowMode:"apply",transaction:{status:"committed",committed:true},
  applyResult:{status:"CreatedAndConnected",transaction:{status:"committed",committed:true},createdElementIds:[1542945],createdFittingIds:[]},
  visualVerification:{status:"CaptureReadyForAIReview",createdElementIds:[1542945],createdFittingIds:[],
    capturePath:"artifacts/captures/selection/c37-highlight.jpg",
    capture:{path:"artifacts/captures/selection/c37-highlight.jpg",widthPx:1800,heightPx:662,focusCrop:{requested:true,applied:true},
      elementVisibility:{viewId:1363433,requestedElementIds:[1542945],visibleElementIds:[1542945],notVisibleElementIds:[],allRequestedElementsVisible:true}}}});

test("C37 workflow capture delivers pixels alongside unchanged committed native result",()=>{
  const native=result(),before=structuredClone(native);
  const delivered=nativeViewImageContent("POST","/revit/mep-route-workflow",native,(path,limit)=>{
    assert.equal(path,native.visualVerification.capture.path);assert.equal(limit,5*1024*1024);
    return {ok:true,data:"native-capture",mimeType:"image/jpeg"};
  });
  assert.ok(delivered);assert.equal(delivered.content.length,2);
  assert.deepEqual(delivered.content[1],{type:"image",data:"native-capture",mimeType:"image/jpeg"});
  const text=JSON.parse((delivered.content[0] as {text:string}).text);
  assert.deepEqual(text,{...before,image_delivery:{available:true}});assert.deepEqual(native,before);
});

test("workflow capture fails closed for unknown effects, mismatched targets, skipped visual work and malformed paths",()=>{
  for(const [name,change]of [
    ["preview",(r:any)=>r.workflowMode="dry-run"],
    ["unknown write",(r:any)=>r.transaction.status="unknown"],
    ["uncommitted",(r:any)=>r.applyResult.transaction.committed=false],
    ["capture failed",(r:any)=>r.visualVerification.status="CaptureFailed"],
    ["other target",(r:any)=>r.visualVerification.capture.elementVisibility.requestedElementIds=[1]],
    ["missing target",(r:any)=>r.visualVerification.capture.elementVisibility.visibleElementIds=[]],
    ["hidden",(r:any)=>r.visualVerification.capture.elementVisibility.allRequestedElementsVisible=false],
    ["wrong path",(r:any)=>r.visualVerification.capturePath="another.png"],
    ["empty path",(r:any)=>r.visualVerification.capture.path=""],
    ["missing size",(r:any)=>delete r.visualVerification.capture.heightPx],
    ["unknown native effect",(r:any)=>r.canonical_attempt_settlement={effect_state:"unknown",requested_effect:"apply",method:"POST",path:"/revit/mep-route-workflow"}]
  ]as Array<[string,(r:any)=>void]>){
    const native=result();change(native);
    const delivered=nativeViewImageContent("POST","/revit/mep-route-workflow",native,()=>{throw Error("Invalid capture read: "+name);});
    assert.ok(delivered);assert.equal(delivered.content.length,1,name);
    assert.equal(JSON.parse((delivered.content[0] as {text:string}).text).image_delivery.available,false,name);
  }
});

test("unavailable workflow capture never encourages repeating the committed route",()=>{
  const delivered=nativeViewImageContent("POST","/revit/mep-route-workflow",result(),()=>({ok:false,reason:"image exceeds limit"}));
  assert.ok(delivered);assert.equal(delivered.content.length,1);
  const text=JSON.parse((delivered.content[0] as {text:string}).text);
  assert.equal(text.applyResult.transaction.committed,true);assert.match(text.image_delivery.instruction,/Do not repeat/);
});

test("annotation crop outcome and warnings survive image delivery without asserting visual verification",()=>{
  for (const applied of [true,false]) {
    const native:any=result();
    native.visualVerification.capture.focusCrop.annotationCropApplied=applied;
    native.visualVerification.capture.warnings=applied?[]:["Could not bound annotations for the temporary export: native setting unavailable."];
    const delivered=nativeViewImageContent("POST","/revit/mep-route-workflow",native,()=>({ok:true,data:"capture",mimeType:"image/jpeg"}));
    assert.ok(delivered);assert.equal(delivered.content.length,2);
    const text=JSON.parse((delivered.content[0] as {text:string}).text);
    assert.deepEqual(text.visualVerification.capture,native.visualVerification.capture);
    assert.equal(text.visualVerification.status,"CaptureReadyForAIReview");
    assert.equal(text.image_delivery.available,true,"pixel delivery is not a claim that cropping or human visual review passed");
  }
});
