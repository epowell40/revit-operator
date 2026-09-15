import assert from "node:assert/strict";
import test from "node:test";
import {viewFrameImageContent} from "./viewFrameImage.js";

const frame=()=>({frameId:"native-frame",viewId:42,path:"artifacts/captures/native-frame.jpg",widthPx:2000,heightPx:1112,
  mapping:{mode:"2d_affine",topLeftXyz:[-10,10,0],topRightXyz:[10,10,0],bottomLeftXyz:[-10,0,0]},
  canonical_attempt_settlement:{effect_state:"none",requested_effect:"read",method:"POST",path:"/revit/export-view-frame"}});

test("view frame delivers the bounded native image alongside unchanged mapping and settlement",()=>{
  const native=frame(),before=structuredClone(native);
  const result=viewFrameImageContent(native,(imagePath,limit)=>{
    assert.equal(imagePath,native.path);assert.equal(limit,5*1024*1024);
    return {ok:true,data:"native-jpeg-bytes",mimeType:"image/jpeg"};
  });
  assert.equal(result.content.length,2);
  const text=JSON.parse((result.content[0] as {text:string}).text);
  assert.deepEqual(text.mapping,before.mapping);assert.deepEqual(text.canonical_attempt_settlement,before.canonical_attempt_settlement);
  assert.deepEqual(text.image_delivery,{available:true});
  assert.deepEqual(result.content[1],{type:"image",data:"native-jpeg-bytes",mimeType:"image/jpeg"});
  assert.deepEqual(native,before);
});

test("unavailable or oversized image preserves native evidence and explicitly prevents a visual claim",()=>{
  for(const reason of ["image exceeds the MCP image limit","image resolves outside the workspace or native capture root","image could not be securely opened"]){
    const native=frame();const result=viewFrameImageContent(native,()=>({ok:false,reason}));
    assert.equal(result.content.length,1);
    const text=JSON.parse((result.content[0] as {text:string}).text);
    assert.deepEqual(text.mapping,native.mapping);assert.equal(text.image_delivery.available,false);
    assert.equal(text.image_delivery.reason,reason);assert.match(text.image_delivery.instruction,/not delivered/);
  }
});

test("view frame never opens paths from failed, unknown or malformed native responses",()=>{
  for(const native of [null,{path:"elsewhere.png"},{...frame(),ok:false},{...frame(),error:"capture failed"},{...frame(),status:"Blocked"},
    {...frame(),widthPx:0},{...frame(),heightPx:NaN},{...frame(),frameId:""},
    {...frame(),canonical_attempt_settlement:{...frame().canonical_attempt_settlement,effect_state:"unknown"}},
    {...frame(),canonical_attempt_settlement:{...frame().canonical_attempt_settlement,path:"/revit/find-elements"}}]){
    const result=viewFrameImageContent(native,()=>{throw Error("Invalid response must not cause file access");});
    assert.equal(result.content.length,1);assert.equal(JSON.parse((result.content[0] as {text:string}).text).image_delivery.available,false);
  }
});
