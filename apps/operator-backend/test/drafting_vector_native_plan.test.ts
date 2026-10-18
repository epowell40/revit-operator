import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {clipDraftingSegment,compileDraftingVectorNativePlan} from "../src/pdf/drafting_vector_native_plan.js";
import {inspectDraftingVectorSource,type PaperPoint} from "../src/pdf/drafting_vector_source.js";

function pdf(stream:string){
 const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let body="%PDF-1.4\n";const offsets=[0];for(const [i,obj]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${i+1} 0 obj\n${obj}\nendobj\n`;}
 const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,"0")+" 00000 n \n").join("")+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return new Uint8Array(Buffer.from(body));
}
async function source(stream:string,region:[number,number,number,number]=[0,0,200,200]){const bytes=pdf(stream);return inspectDraftingVectorSource(bytes,{expectedSourceSha256:crypto.createHash("sha256").update(bytes).digest("hex"),sourceLabel:"source.pdf",sourceSheet:"M101",page:1,region});}
const layout={paperWidthInches:200/72,viewScale:100,partSize:50};
const rect:PaperPoint[]=[[20,0],[80,0],[80,100],[20,100]];
function evaluate(p:PaperPoint[],t:number){return[0,1].map(k=>(1-t)**3*p[0][k]+3*t*(1-t)**2*p[1][k]+3*t*t*(1-t)*p[2][k]+t**3*p[3][k]);}

test("native plan has explicit paper units, target scale and source-bound cubic controls",async()=>{
 const s=await source("10 10 m 20 50 30 60 40 10 c S BT /F1 12 Tf 10 180 Td (NOTE) Tj ET");
 const p=compileDraftingVectorNativePlan(s,s.planSha256,layout);assert.equal(p.coordinateSpace,"paper inches, right/up, lower-left of selected source region");
 const c=p.entities.find(e=>e.kind==="cubic_bezier")!;assert.equal(c.points!.length,4);assert.deepEqual(c.points![0],[10/72,10/72]);assert.deepEqual(c.points![3],[40/72,10/72]);
 const note=p.entities.find(e=>e.kind==="text")!;assert.equal(note.text,"NOTE");assert.equal(note.font,"Arial");assert.equal(note.emPoints,12);assert.equal(note.widthScale,1);
 assert.equal(p.sourceSheet,"M101");assert.equal(p.layout.viewScale,100);assert.equal(p.nativeWriteAllowed,false);assert.equal(p.entities.length,2);
});
test("straight strokes clip to source ROI without importing off-region sibling geometry",async()=>{
 const s=await source("0 100 m 200 100 l 0 190 m 10 190 l S",[50,50,150,150]),p=compileDraftingVectorNativePlan(s,s.planSha256,{...layout,paperWidthInches:100/72});
 assert.equal(p.entities.length,1);assert.deepEqual(p.entities[0].points,[[0,50/72],[100/72,50/72]]);
});
test("Bezier clipping retains exact cubic pieces instead of replacing them with line samples",()=>{
 const points:PaperPoint[]=[[0,0],[0,100],[100,100],[100,0]];
 const pieces=clipDraftingSegment({kind:"cubic_bezier",start:points[0],controlPoints:[points[1],points[2]],end:points[3]},rect);
 assert.equal(pieces.length,1);assert.equal(pieces[0].kind,"cubic_bezier");const part=pieces[0];if(part.kind!=="cubic_bezier")throw Error("cubic required");
 assert(Math.abs(part.start[0]-20)<1e-8);assert(Math.abs(part.end[0]-80)<1e-8);
 const p=[part.start,...part.controlPoints,part.end];assert(Math.abs(evaluate(p,.5)[1]-75)<1e-8);
 for(let i=0;i<=100;i++){const v=evaluate(p,i/100);assert(v[0]>=20-1e-8&&v[0]<=80+1e-8&&v[1]>=0&&v[1]<=100);}
});
test("convex polygon source mask clips a filled rectangle before native conversion",async()=>{
 const s=await source("q 100 100 m 110 110 l 100 120 l 90 110 l h W n 85 95 30 30 re f Q");
 const p=compileDraftingVectorNativePlan(s,s.planSha256,layout),fill=p.entities[0];assert.equal(fill.kind,"fill");assert.equal(fill.loops!.length,1);assert.equal(fill.loops![0].length,4);
 const vertices=fill.loops![0].map(s=>s.start.map(x=>Math.round(x*72)));assert.deepEqual(new Set(vertices.map(v=>v.join(","))),new Set(["100,100","110,110","100,120","90,110"]));
});
test("explicit revision omission does not discard adjoining strokes or text",async()=>{
 const s=await source("10 10 m 20 10 l 40 10 m 60 10 l S BT /F1 10 Tf 40 20 Td (KEEP) Tj ET"),id=s.paths[0].contours[0].id;
 const p=compileDraftingVectorNativePlan(s,s.planSha256,layout,[{recordId:id,reason:"historical_revision",evidence:"Historical source cloud identified in the reference image."}]);
 assert.equal(p.entities.filter(e=>e.kind==="line").length,1);assert.equal(p.entities.filter(e=>e.kind==="text").length,1);assert.equal(p.omissions[0].recordId,id);
});
test("native parts are deterministic and zero-length source commands are counted explicitly",async()=>{
 const s=await source(Array.from({length:120},(_,i)=>`${i} 10 m ${i} 20 l S`).join("\n")+" 1 1 m 1 1 l S");
 const p=compileDraftingVectorNativePlan(s,s.planSha256,layout),again=compileDraftingVectorNativePlan(s,s.planSha256,layout);
 assert.equal(p.entities.length,120);assert.equal(p.zeroLengthSourceCommands,1);assert.equal(p.partCount,3);assert.equal(p.nativePlanSha256,again.nativePlanSha256);
 assert(new Set(p.entities.map(e=>e.id)).size===120);
});
test("unsupported source cases cannot be silently approximated into a native plan",async()=>{
 const dash=await source("[2 1] 1 d 10 10 m 20 20 l S");assert.throws(()=>compileDraftingVectorNativePlan(dash,dash.planSha256,layout),/dash phase/);
 const shear=await source("2 0 0 1 0 0 cm 10 10 m 20 20 l S");assert.throws(()=>compileDraftingVectorNativePlan(shear,shear.planSha256,layout),/Nonuniform/);
 const text=await source("BT /F1 12 Tf 10 180 Td (NOTE LONG) Tj ET",[10,0,20,100]);assert.throws(()=>compileDraftingVectorNativePlan(text,text.planSha256,{...layout,paperWidthInches:1}),/text crosses/);
 assert.throws(()=>clipDraftingSegment({kind:"line",start:[0,0],end:[10,10]},[[0,0],[10,10],[0,10],[10,0]]),/simple/);
});
test("concave source masks preserve notches and can split a crossing stroke into distinct pieces",async()=>{
 const mask:PaperPoint[]=[[0,0],[10,0],[10,10],[7,10],[7,3],[3,3],[3,10],[0,10]];
 const clipped=clipDraftingSegment({kind:"line",start:[-1,8],end:[11,8]},mask);
 assert.equal(clipped.length,2);assert.deepEqual(clipped.map(s=>s.start.map(n=>Math.round(n))),[[0,8],[7,8]]);assert.deepEqual(clipped.map(s=>s.end.map(n=>Math.round(n))),[[3,8],[10,8]]);
 const s=await source("0 0 m 10 0 l 10 10 l 7 10 l 7 3 l 3 3 l 3 10 l 0 10 l h W n 0 0 10 10 re f");
 const p=compileDraftingVectorNativePlan(s,s.planSha256,layout);assert.equal(p.entities[0].kind,"fill");assert.equal(p.entities[0].loops![0].length,8);
});
test("caller layout, source digest and native partition bounds fail closed",async()=>{
 const s=await source("10 10 m 20 20 l S");
 for(const options of [{...layout,viewScale:0},{...layout,paperWidthInches:Infinity},{...layout,partSize:1},{...layout,hiddenOverride:true},{...layout,lineWeightMap:{".24":17}}])assert.throws(()=>compileDraftingVectorNativePlan(s,s.planSha256,options));
 assert.throws(()=>compileDraftingVectorNativePlan(s,"0".repeat(64),layout),/hash/);
});

test("even-odd source fill keeps holes and separates disconnected components",async()=>{
 const nested=await source("10 10 100 100 re 30 30 20 20 re f*"),holes=compileDraftingVectorNativePlan(nested,nested.planSha256,layout).entities;
 assert.equal(holes.length,1);assert.equal(holes[0].loops!.length,2);
 const disconnected=await source("10 10 20 20 re 100 100 20 20 re f*"),parts=compileDraftingVectorNativePlan(disconnected,disconnected.planSha256,layout).entities;
 assert.equal(parts.length,2);assert(parts.every(p=>p.kind==="fill"&&p.loops!.length===1));
 const overlapping=await source("10 10 20 20 re 20 10 20 20 re f*"),xor=compileDraftingVectorNativePlan(overlapping,overlapping.planSha256,layout).entities;
 assert.equal(xor.length,2);
 const totalArea=xor.reduce((sum,e)=>sum+Math.abs(e.loops![0].reduce((a,s)=>a+s.start[0]*s.end[1]-s.end[0]*s.start[1],0)/2),0);
 assert(Math.abs(totalArea-400/(72*72))<1e-10);
});

test("concave clipping can split one source fill without drawing across the notch",async()=>{
 const s=await source("0 0 m 10 0 l 10 10 l 7 10 l 7 3 l 3 3 l 3 10 l 0 10 l h W n 0 7 10 2 re f");
 const fills=compileDraftingVectorNativePlan(s,s.planSha256,layout).entities;
 assert.equal(fills.length,2);assert(fills.every(e=>e.loops!.length===1&&e.loops![0].length===4));
 for(const fill of fills){const xs=fill.loops![0].map(e=>e.start[0]*72);assert(Math.max(...xs)<=3+1e-9||Math.min(...xs)>=7-1e-9);}
});

test("malformed native mapping values cannot masquerade as dictionaries",async()=>{
 const s=await source("10 10 m 20 20 l S");
 for(const value of [null,"Arial",[],true,42])for(const key of ["fontMap","lineWeightMap"])
  assert.throws(()=>compileDraftingVectorNativePlan(s,s.planSha256,{...layout,[key]:value} as never),/objects/);
});
